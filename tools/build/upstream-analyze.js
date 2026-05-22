#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const { getArgValue, hasFlag } = require("../lib/cli-args");
const { ensureDir, rmDir, readJson, writeJson } = require("../lib/fs");
const { DEFAULT_UPSTREAM_VSIX_URL, DEFAULT_UPSTREAM_VSIX_REL_PATH, ensureUpstreamVsix, unpackVsixToWorkDir } = require("../lib/upstream-vsix");
const { extractCallApiEndpoints } = require("../lib/endpoint-analysis");

async function main() {
  const repoRoot = path.resolve(__dirname, "../..");
  const cacheDir = path.join(repoRoot, ".cache");
  const reportsDir = path.join(cacheDir, "reports");
  ensureDir(reportsDir);

  const upstreamUrl = DEFAULT_UPSTREAM_VSIX_URL;
  const upstreamVsixPath = path.resolve(repoRoot, getArgValue(process.argv, "--upstream-vsix") || DEFAULT_UPSTREAM_VSIX_REL_PATH);
  const skipDownload = hasFlag(process.argv, "--skip-download") || process.env.AUGMENT_BYOK_SKIP_UPSTREAM_DOWNLOAD === "1";

  if (skipDownload) {
    console.log(`[analyze] reuse cached upstream VSIX: ${path.relative(repoRoot, upstreamVsixPath)}`);
  } else {
    console.log(`[analyze] download upstream VSIX`);
  }
  await ensureUpstreamVsix({ upstreamUrl, vsixPath: upstreamVsixPath, skipDownload });

  const workDir = path.join(cacheDir, "work", "upstream-analysis");
  console.log(`[analyze] unpack VSIX`);
  const { pkgPath, extJsPath } = unpackVsixToWorkDir({ repoRoot, vsixPath: upstreamVsixPath, workDir, clean: true });
  const pkg = readJson(pkgPath);
  const upstreamVersion = typeof pkg?.version === "string" ? pkg.version : "unknown";

  console.log(`[analyze] read out/extension.js`);
  const src = fs.readFileSync(extJsPath, "utf8");
  const details = extractCallApiEndpoints(src);
  const endpoints = Array.from(details.keys()).sort();

  const report = {
    generatedAt: new Date().toISOString(),
    upstream: { publisher: "augment", extension: "vscode-augment", version: upstreamVersion },
    endpoints,
    endpointDetails: Object.fromEntries(Array.from(details.entries()).map(([k, v]) => [k, v]))
  };

  const outPath = path.join(reportsDir, "upstream-analysis.json");
  writeJson(outPath, report);
  console.log(`[analyze] wrote ${path.relative(repoRoot, outPath)} (endpoints=${endpoints.length})`);

  const keepWorkDir = process.env.AUGMENT_BYOK_KEEP_WORKDIR === "1";
  if (!keepWorkDir) rmDir(workDir);
}

main().catch((err) => {
  console.error(`[analyze] ERROR:`, err && err.stack ? err.stack : String(err));
  process.exit(1);
});
