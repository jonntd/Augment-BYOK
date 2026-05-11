"use strict";

const fs = require("fs");
const path = require("path");

function resolveWebviewAssetsDir(extensionDir, callerName) {
  const caller = String(callerName || "webview-assets");
  const extDir = path.resolve(String(extensionDir || ""));
  if (!extDir || extDir === path.parse(extDir).root) throw new Error(`${caller}: invalid extensionDir`);

  const assetsDir = path.join(extDir, "common-webviews", "assets");
  if (!fs.existsSync(assetsDir)) throw new Error(`webview assets dir missing: ${assetsDir}`);
  return assetsDir;
}

function listExtensionClientContextAssets(extensionDir, callerName) {
  const assetsDir = resolveWebviewAssetsDir(extensionDir, callerName);
  // Use content rather than Vite chunk names; upstream filenames are volatile.
  const candidates = fs
    .readdirSync(assetsDir)
    .filter((name) => typeof name === "string" && name.endsWith(".js") && !name.endsWith(".js.map"))
    .map((name) => path.join(assetsDir, name))
    .filter((filePath) => {
      const src = fs.readFileSync(filePath, "utf8");
      return src.includes("history_summary_node") && src.includes("HISTORY_SUMMARY") && src.includes("history_end");
    });

  if (!candidates.length) throw new Error("extension-client-context asset not found (upstream may have changed)");
  return candidates;
}

module.exports = { listExtensionClientContextAssets, resolveWebviewAssetsDir };
