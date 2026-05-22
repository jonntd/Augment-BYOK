const test = require("node:test");
const assert = require("node:assert/strict");

const { state } = require("../payload/extension/out/byok/config/state");
const { maybeAugmentBodyWithWorkspaceBlob } = require("../payload/extension/out/byok/runtime/shim/next-edit");

function makeFileUri(fsPath) {
  return { scheme: "file", fsPath, path: fsPath, toString: () => `file://${fsPath}` };
}

test("next-edit: does not read files outside workspace", async (t) => {
  const prevVscode = state.vscode;
  t.after(() => { state.vscode = prevVscode; });

  state.vscode = {
    Uri: { file: makeFileUri, parse: (s) => ({ scheme: "file", fsPath: s, path: s, toString: () => s }) },
    workspace: {
      getWorkspaceFolder: () => null,
      fs: { readFile: async () => new Uint8Array(Buffer.from("SHOULD_NOT_LEAK")) }
    }
  };

  const body = { blobs: {} };
  const out = await maybeAugmentBodyWithWorkspaceBlob(body, { pathHint: "/etc/passwd" });
  assert.equal(out, body);
});

test("next-edit: reads workspace files only (adds blob when allowed)", async (t) => {
  const prevVscode = state.vscode;
  t.after(() => { state.vscode = prevVscode; });

  state.vscode = {
    Uri: { file: makeFileUri, parse: (s) => ({ scheme: "file", fsPath: s, path: s, toString: () => s }) },
    workspace: {
      getWorkspaceFolder: (uri) => (String(uri?.fsPath || "").startsWith("/ws/") ? { uri: makeFileUri("/ws") } : null),
      fs: { readFile: async () => new Uint8Array(Buffer.from("hello")) }
    }
  };

  const body = {};
  const out = await maybeAugmentBodyWithWorkspaceBlob(body, { pathHint: "/ws/a.txt" });
  assert.notEqual(out, body);
  assert.equal(out?.blobs?.["/ws/a.txt"], "hello");
});

test("next-edit: preserves empty workspace files instead of skipping them", async (t) => {
  const prevVscode = state.vscode;
  t.after(() => { state.vscode = prevVscode; });

  state.vscode = {
    Uri: { file: makeFileUri, parse: (s) => ({ scheme: "file", fsPath: s, path: s, toString: () => s }) },
    workspace: {
      workspaceFolders: [{ uri: makeFileUri("/ws") }],
      getWorkspaceFolder: (uri) => (String(uri?.fsPath || "").startsWith("/ws/") ? { uri: makeFileUri("/ws") } : null),
      fs: { readFile: async () => new Uint8Array() }
    }
  };

  const body = {};
  const out = await maybeAugmentBodyWithWorkspaceBlob(body, { pathHint: "/ws/empty.txt" });
  assert.notEqual(out, body);
  assert.equal(Object.prototype.hasOwnProperty.call(out?.blobs || {}, "/ws/empty.txt"), true);
  assert.equal(out?.blobs?.["/ws/empty.txt"], "");
});

