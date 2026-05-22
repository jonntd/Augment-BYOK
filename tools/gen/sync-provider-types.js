#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const { KNOWN_PROVIDER_TYPES } = require("../../payload/extension/out/byok/core/provider-types");

function die(msg) {
  console.error(`[sync-provider-types] ERROR: ${String(msg || "unknown error")}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`[sync-provider-types] ${String(msg || "")}`);
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function writeText(filePath, txt) {
  fs.writeFileSync(filePath, txt, "utf8");
}

function parseArgs(argv) {
  const out = { write: false, check: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") out.write = true;
    else if (a === "--check") out.check = true;
  }
  if (!out.write && !out.check) out.check = true;
  if (out.write && out.check) die("use either --write or --check");
  return out;
}

function assert(cond, msg) {
  if (!cond) die(msg);
}

function replaceBetweenMarkers(src, startMarker, endMarker, newInner) {
  const s = String(src ?? "");
  const start = s.indexOf(startMarker);
  const end = s.indexOf(endMarker);
  assert(start >= 0, `start marker not found: ${startMarker}`);
  assert(end >= 0, `end marker not found: ${endMarker}`);
  assert(end > start, `markers out of order: ${startMarker}`);

  const before = s.slice(0, start + startMarker.length);
  const endLineStart = s.lastIndexOf("\n", end);
  const afterStart = endLineStart >= 0 ? endLineStart + 1 : end;
  const after = s.slice(afterStart);

  const inner = String(newInner ?? "").replace(/\s+$/g, "");
  return `${before}\n${inner}\n${after}`;
}

function indentOfMarkerLine(src, marker) {
  const s = String(src ?? "");
  const idx = s.indexOf(marker);
  assert(idx >= 0, `marker not found for indent: ${marker}`);
  const lineStart = s.lastIndexOf("\n", idx);
  const prefix = s.slice(lineStart + 1, idx);
  const m = prefix.match(/^[\t ]*/);
  return m ? m[0] : "";
}

function validateProviderTypes(types) {
  const list = Array.isArray(types) ? types : [];
  assert(list.length > 0, "KNOWN_PROVIDER_TYPES empty");
  const seen = new Set();
  for (const t of list) {
    assert(typeof t === "string" && t.trim(), `invalid provider type: ${String(t)}`);
    assert(!seen.has(t), `duplicate provider type: ${t}`);
    seen.add(t);
  }
  return list;
}

function generateJsStringArrayLines(types, indent) {
  return types
    .map((t, idx) => {
      const comma = idx === types.length - 1 ? "" : ",";
      return `${indent}${JSON.stringify(t)}${comma}`;
    })
    .join("\n");
}

function main() {
  const args = parseArgs(process.argv);
  const repoRoot = path.resolve(__dirname, "../..");

  const types = validateProviderTypes(KNOWN_PROVIDER_TYPES);

  const utilPath = path.join(repoRoot, "payload", "extension", "out", "byok", "ui", "config-panel", "webview", "util.js");

  let util = readText(utilPath);
  const utilIndent = indentOfMarkerLine(util, "/* BEGIN GENERATED: KNOWN_PROVIDER_TYPES */");
  util = replaceBetweenMarkers(
    util,
    "/* BEGIN GENERATED: KNOWN_PROVIDER_TYPES */",
    "/* END GENERATED: KNOWN_PROVIDER_TYPES */",
    generateJsStringArrayLines(types, utilIndent)
  );

  if (args.check) {
    const utilNow = readText(utilPath);
    const bad = [];
    if (utilNow !== util) bad.push(path.relative(repoRoot, utilPath));
    if (bad.length) {
      console.error(`[sync-provider-types] OUTDATED (run: node tools/gen/sync-provider-types.js --write)`);
      for (const p of bad) console.error(`- ${p}`);
      process.exit(2);
    }
    ok("OK");
    return;
  }

  if (args.write) {
    const utilBefore = readText(utilPath);
    if (utilBefore !== util) writeText(utilPath, util);
    ok("wrote updated files");
    return;
  }

  die("unreachable");
}

main();
