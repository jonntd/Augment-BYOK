"use strict";

const fs = require("fs");
const path = require("path");
const { replaceOnce } = require("../lib/patch");
const { resolveWebviewAssetsDir } = require("./webview-assets");

function patchWebviewMuteAgentError(extensionDir) {
  const assetsDir = resolveWebviewAssetsDir(extensionDir, "patchWebviewMuteAgentError");
  const candidates = fs
    .readdirSync(assetsDir)
    .filter((name) => typeof name === "string" && name.endsWith(".js") && !name.endsWith(".js.map"))
    .map((name) => path.join(assetsDir, name));

  let changed = false;
  for (const filePath of candidates) {
    let src = fs.readFileSync(filePath, "utf8");
    if (src.includes('"Failed to load agent configurations"')) {
      // Find the yield*q(qo.failure,function*(){yield*A(qe({message:"Failed to load agent configurations",type:"error"}))})
      // and mute the error notification. We just replace the message payload with an empty string or remove the yield entirely.
      // Easiest is to change the message to be empty and type to be "none" if we don't want to break AST, but qe might still popup.
      // Better: replace the whole yield statement with an empty block.
      src = src.replace(
        /\{yield\*([A-Za-z_$][0-9A-Za-z_$]*)\(([A-Za-z_$][0-9A-Za-z_$]*)\(\{message:"Failed to load agent configurations",type:"error"\}\)\)\}/g,
        "{/* BYOK MUTE AGENT CONFIG ERROR */}"
      );
      fs.writeFileSync(filePath, src);
      changed = true;
    }
  }

  return { changed };
}

module.exports = { patchWebviewMuteAgentError };
