#!/usr/bin/env node
"use strict";

const path = require("path");

const { replaceOnceRegex } = require("../lib/patch");
const { loadPatchText, savePatchText } = require("./patch-target");
const { requireCapture, buildTasklistNoopGuardSnippet } = require("./tasklist-common");

const MARKER = "__augment_byok_tasklist_reorganize_noop_errors_patched_v1";

function buildReplacement(m) {
  const label = "tasklist reorganize noop errors";
  const prefixBlock = requireCapture(m, 1, `${label} prefixBlock`);
  const errFnVar = requireCapture(m, 3, `${label} errFnVar`);
  const planVar = requireCapture(m, 5, `${label} planVar`);
  const textVar = requireCapture(m, 7, `${label} textVar`);
  const formatterVar = requireCapture(m, 8, `${label} formatterVar`);
  const diffFnVar = requireCapture(m, 9, `${label} diffFnVar`);
  const beforeVar = requireCapture(m, 10, `${label} beforeVar`);
  const afterVar = requireCapture(m, 11, `${label} afterVar`);
  const returnPrefix = String(m[12] || "");
  const okFnVar = requireCapture(m, 13, `${label} okFnVar`);
  return prefixBlock +
    buildTasklistNoopGuardSnippet({
      diffVar: "__byok_reorg_diff",
      diffFnVar,
      beforeVar,
      afterVar,
      errorFnVar: errFnVar,
      planVar,
      textVar,
      formatterVar,
      okFnVar,
      returnPrefix
    });
}

function patchTasklistReorganizeNoopErrors(filePath) {
  const { original, alreadyPatched } = loadPatchText(filePath, { marker: MARKER });
  if (alreadyPatched) return { changed: false, reason: "already_patched" };

  let next = original;

  next = replaceOnceRegex(
    next,
    /(const\s+([A-Za-z_$][\w$]*)=e\.markdown;if\(!\2\)return\s+([A-Za-z_$][\w$]*)\("No markdown provided\."\);[\s\S]*?)(const\s+([A-Za-z_$][\w$]*)=await this\._taskManager\.getHydratedTask\(([A-Za-z_$][\w$]*)\);if\(!\5\)return\s+\3\("Failed to retrieve updated task tree after reorganization\."\);const\s+([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.formatBulkUpdateResponse\(([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\);return\s*((?:[A-Za-z_$][\w$]*&&[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\.uuid\),)?)\{\.\.\.([A-Za-z_$][\w$]*)\(\7\),plan:\5\})/g,
    buildReplacement,
    "tasklist reorganize noop errors: tail flow"
  );

  savePatchText(filePath, next, { marker: MARKER });
  return { changed: true, reason: "patched" };
}

module.exports = { patchTasklistReorganizeNoopErrors };

if (require.main === module) {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error(`usage: ${path.basename(process.argv[1])} <extension/out/extension.js>`);
    process.exit(2);
  }
  patchTasklistReorganizeNoopErrors(filePath);
}
