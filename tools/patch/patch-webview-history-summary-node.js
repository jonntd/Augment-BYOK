#!/usr/bin/env node
"use strict";

const path = require("path");

const { replaceOnceRegex } = require("../lib/patch");
const { loadPatchText, savePatchText } = require("./patch-target");
const { HISTORY_SUMMARY_NODE_PATCH_MARKER, listExtensionClientContextAssets } = require("./webview-assets");

const MARKER = HISTORY_SUMMARY_NODE_PATCH_MARKER;
const PATCH_LABEL = "extension-client-context HISTORY_SUMMARY node slimming";

function resolveHistorySummaryFormatter(src) {
  const s = String(src || "");
  const formatterRe = /function ([A-Za-z_$][0-9A-Za-z_$]*)\(e\)\{const t=e\.history_end\.map\(/g;
  const matches = Array.from(s.matchAll(formatterRe));
  if (matches.length === 0) throw new Error("extension-client-context history summary formatter not found (upstream may have changed)");
  if (matches.length > 1) {
    throw new Error(
      `extension-client-context history summary formatter matched multiple times (refuse to patch): matched=${matches.length}`
    );
  }
  return String(matches[0][1] || "");
}

function assertSlimmedHistorySummaryAsset(src, filePath) {
  const s = String(src || "");
  const label = `${PATCH_LABEL}: ${filePath}`;
  if (!s.includes(MARKER)) throw new Error(`${label}: marker missing after patch`);
  if (!/type:[A-Za-z_$][0-9A-Za-z_$]*\.TEXT,text_node:\{content:/.test(s)) {
    throw new Error(`${label}: HISTORY_SUMMARY node not rewritten to TEXT/text_node`);
  }
  if (/type:[^,}]*HISTORY_SUMMARY,history_summary_node:/.test(s)) {
    throw new Error(`${label}: still carries upstream HISTORY_SUMMARY payload`);
  }
}

function patchExtensionClientContextAsset(filePath) {
  const { original, alreadyPatched } = loadPatchText(filePath, { marker: MARKER });
  if (alreadyPatched) {
    assertSlimmedHistorySummaryAsset(original, filePath);
    return { changed: false, reason: "already_patched" };
  }

  // 上游 useHistorySummaryNew 会把 {history_end: tail exchanges(with nodes)} 存进 request_nodes 的 HISTORY_SUMMARY 节点。
  // 该节点体积巨大，后续“Editable History / 编辑历史对话”等路径可能对 request_nodes 做 JSON.stringify/clone，导致内存爆炸→VSIX 崩溃。
  //
  // 修复策略：仍然生成同样的 summary payload（C），但存入 state 的节点改为 TEXT，并把 message_template 填充后的字符串写入 text_node.content。
  // 这样：语义保持（模型仍拿到同样的 supervisor prompt），同时避免把 history_end 的巨型结构长期挂在 state 上。
  let out = original;
  const formatter = resolveHistorySummaryFormatter(out);

  // latest-only：直接改 buildHistorySummaryNode 的返回值。
  const summaryNodeRe = /return\{id:([^,{}]+),type:([A-Za-z_$][0-9A-Za-z_$]*)\.HISTORY_SUMMARY,history_summary_node:([A-Za-z_$][0-9A-Za-z_$]*)\}/g;
  out = replaceOnceRegex(
    out,
    summaryNodeRe,
    (m) => {
      const idExpr = String(m[1] || "0");
      const enumAlias = String(m[2] || "");
      const payloadVar = String(m[3] || "");
      return `return{id:${idExpr},type:${enumAlias}.TEXT,text_node:{content:${formatter}(${payloadVar})}}`;
    },
    PATCH_LABEL
  );

  const saved = savePatchText(filePath, out, { marker: MARKER });
  assertSlimmedHistorySummaryAsset(saved, filePath);
  return { changed: true, reason: "patched" };
}

function patchWebviewHistorySummaryNode(extensionDir) {
  const candidates = listExtensionClientContextAssets(extensionDir, "patchWebviewHistorySummaryNode");
  const results = [];
  for (const filePath of candidates) results.push({ filePath, ...patchExtensionClientContextAsset(filePath) });
  return { changed: results.some((r) => r.changed), results };
}

module.exports = { patchWebviewHistorySummaryNode };

if (require.main === module) {
  const extensionDir = process.argv[2];
  if (!extensionDir) {
    console.error(`usage: ${path.basename(process.argv[1])} <extensionDir>`);
    process.exit(2);
  }
  patchWebviewHistorySummaryNode(extensionDir);
}
