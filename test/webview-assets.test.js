const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  HISTORY_SUMMARY_NODE_PATCH_MARKER,
  listExtensionClientContextAssets,
  resolveWebviewAssetsDir
} = require("../tools/patch/webview-assets");

function withTempDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeUtf8(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

test("webview-assets: resolves assets dir and finds history-summary bundle by content", () => {
  withTempDir("augment-byok-webview-assets-", (dir) => {
    const extDir = path.join(dir, "extension");
    const assetsDir = path.join(extDir, "common-webviews", "assets");
    const targetA = path.join(assetsDir, "Store-bbb.js");
    const targetB = path.join(assetsDir, "Store-aaa.js");
    const ignored = path.join(assetsDir, "index-abc.js");
    writeUtf8(targetA, "const x='HISTORY_SUMMARY'; const y='history_summary_node'; const z='history_end';\n");
    writeUtf8(targetB, "const x='HISTORY_SUMMARY'; const y='history_summary_node'; const z='history_end';\n");
    writeUtf8(ignored, "const x='HISTORY_SUMMARY';\n");

    assert.equal(resolveWebviewAssetsDir(extDir, "testCaller"), assetsDir);
    assert.deepEqual(listExtensionClientContextAssets(extDir, "testCaller"), [targetB, targetA]);
  });
});

test("webview-assets: finds already patched history-summary bundle by marker", () => {
  withTempDir("augment-byok-webview-assets-", (dir) => {
    const extDir = path.join(dir, "extension");
    const assetsDir = path.join(extDir, "common-webviews", "assets");
    const patched = path.join(assetsDir, "Store-patched.js");
    const ignored = path.join(assetsDir, "Store-original-markerless.js");
    writeUtf8(
      patched,
      `const marker="${HISTORY_SUMMARY_NODE_PATCH_MARKER}";return{id:1,type:x.TEXT,text_node:{content:"summary"}};\n`
    );
    writeUtf8(ignored, "const x='TEXT'; const y='text_node';\n");

    assert.deepEqual(listExtensionClientContextAssets(extDir, "testCaller"), [patched]);
  });
});

test("webview-assets: fails fast when target bundle is missing", () => {
  withTempDir("augment-byok-webview-assets-", (dir) => {
    const extDir = path.join(dir, "extension");
    const assetsDir = path.join(extDir, "common-webviews", "assets");
    writeUtf8(path.join(assetsDir, "index-abc.js"), "console.log('ignore');\n");

    assert.throws(
      () => listExtensionClientContextAssets(extDir, "testCaller"),
      /extension-client-context asset not found/
    );
  });
});
