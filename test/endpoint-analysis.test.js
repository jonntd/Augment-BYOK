const test = require("node:test");
const assert = require("node:assert/strict");

const { endpointDetailsFromSource } = require("../tools/lib/endpoint-analysis");

test("endpoint-analysis: extracts static callApi endpoints across quote styles", () => {
  const src = [
    `client.callApi(a, b, "/get-models", {})`,
    `client.callApi(a, b, '/chat', {})`,
    "client.callApiStream(a, b, `/chat-stream`, {})"
  ].join(";\n");

  assert.deepEqual(endpointDetailsFromSource(src), {
    "/get-models": { callApi: 1, callApiStream: 0 },
    "/chat": { callApi: 1, callApiStream: 0 },
    "/chat-stream": { callApi: 0, callApiStream: 1 }
  });
});

test("endpoint-analysis: handles nested commas before endpoint argument", () => {
  const src = [
    `client.callApi(ctx, build({ prompt: "a,b", nested: [fn(1, 2)] }), "/completion", body)`,
    `client.callApiStream(ctx, choose("x,y", { n: 1 }), "prompt-enhancer", body)`
  ].join(";\n");

  assert.deepEqual(endpointDetailsFromSource(src), {
    "/completion": { callApi: 1, callApiStream: 0 },
    "/prompt-enhancer": { callApi: 0, callApiStream: 1 }
  });
});

test("endpoint-analysis: ignores dynamic endpoint expressions", () => {
  const src = [
    "client.callApi(a, b, endpointName, {})",
    "client.callApiStream(a, b, `/dynamic-${suffix}`, {})",
    "client.callApi(a, b)"
  ].join(";\n");

  assert.deepEqual(endpointDetailsFromSource(src), {});
});

test("endpoint-analysis: ignores callApi mentions inside comments and strings", () => {
  const src = [
    `// client.callApi(a, b, "/comment-json", {})`,
    `/* client.callApiStream(a, b, "/comment-stream", {}) */`,
    `const sample = "client.callApi(a, b, '/string-json', {})";`,
    "const tpl = `client.callApiStream(a, b, '/template-stream', {})`;",
    `client.callApi(a, b, "/real-json", {})`,
    `client.callApiStream(a, b, "/real-stream", {})`
  ].join("\n");

  assert.deepEqual(endpointDetailsFromSource(src), {
    "/real-json": { callApi: 1, callApiStream: 0 },
    "/real-stream": { callApi: 0, callApiStream: 1 }
  });
});
