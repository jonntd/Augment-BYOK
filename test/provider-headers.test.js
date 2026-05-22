const test = require("node:test");
const assert = require("node:assert/strict");

const { openAiAuthHeaders, anthropicAuthHeaders } = require("../payload/extension/out/byok/providers/headers");

test("provider headers: placeholder auth headers do not block apiKey injection", () => {
  const out = openAiAuthHeaders("sk-test", {
    authorization: "<redacted>",
    "x-trace-id": "trace-1"
  });

  assert.deepEqual(out, {
    authorization: "Bearer sk-test",
    "x-trace-id": "trace-1"
  });
});

test("provider headers: real auth headers are preserved", () => {
  const out = openAiAuthHeaders("sk-test", {
    authorization: "Bearer downstream-token",
    "x-trace-id": "trace-1"
  });

  assert.deepEqual(out, {
    authorization: "Bearer downstream-token",
    "x-trace-id": "trace-1"
  });
});

test("provider headers: anthropic auth placeholders are stripped before filling apiKey", () => {
  const out = anthropicAuthHeaders("sk-test", {
    authorization: "(redacted)",
    "x-api-key": "<redacted>",
    "anthropic-version": "2024-10-01",
    "x-trace-id": "trace-1"
  }, { forceBearer: true });

  assert.deepEqual(out, {
    authorization: "Bearer sk-test",
    "x-api-key": "sk-test",
    "anthropic-version": "2024-10-01",
    "x-trace-id": "trace-1"
  });
});
