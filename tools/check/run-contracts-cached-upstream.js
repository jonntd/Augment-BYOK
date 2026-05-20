#!/usr/bin/env node
"use strict";

const path = require("path");

const { applyByokPatches, runByokContractChecks } = require("../lib/byok-workflow");
const { DEFAULT_UPSTREAM_VSIX_URL, DEFAULT_UPSTREAM_VSIX_REL_PATH, ensureUpstreamVsix, unpackVsixToWorkDir } = require("../lib/upstream-vsix");

async function main() {
  const repoRoot = path.resolve(__dirname, "../..");
  const cacheDir = path.join(repoRoot, ".cache");
  const upstreamVsixPath = path.resolve(repoRoot, DEFAULT_UPSTREAM_VSIX_REL_PATH);
  const workDir = path.join(cacheDir, "work", "contracts-check");

  await ensureUpstreamVsix({ upstreamUrl: DEFAULT_UPSTREAM_VSIX_URL, vsixPath: upstreamVsixPath, skipDownload: true });

  console.log(`[contracts-check] unpack cached upstream VSIX -> ${path.relative(repoRoot, workDir)}`);
  const { extensionDir, pkgPath, extJsPath } = unpackVsixToWorkDir({ repoRoot, vsixPath: upstreamVsixPath, workDir, clean: true });

  applyByokPatches({
    repoRoot,
    extensionDir,
    pkgPath,
    extJsPath,
    logPrefix: "contracts-check"
  });
  runByokContractChecks({ repoRoot, extensionDir, extJsPath, pkgPath, logPrefix: "contracts-check" });

  console.log(`[contracts-check] OK`);
}

main().catch((err) => {
  console.error(`[contracts-check] ERROR:`, err && err.stack ? err.stack : String(err));
  process.exit(1);
});
