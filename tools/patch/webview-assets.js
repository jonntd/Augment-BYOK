"use strict";

const fs = require("fs");
const path = require("path");

const HISTORY_SUMMARY_NODE_PATCH_MARKER = "__augment_byok_webview_history_summary_node_slim_v1";

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
    .sort()
    .map((name) => path.join(assetsDir, name))
    .filter((filePath) => {
      const src = fs.readFileSync(filePath, "utf8");
      if (src.includes(HISTORY_SUMMARY_NODE_PATCH_MARKER)) return true;
      return src.includes("history_summary_node") && src.includes("HISTORY_SUMMARY") && src.includes("history_end");
    });

  if (!candidates.length) throw new Error("extension-client-context asset not found (upstream may have changed)");
  return candidates;
}

module.exports = { HISTORY_SUMMARY_NODE_PATCH_MARKER, listExtensionClientContextAssets, resolveWebviewAssetsDir };
