const test = require("node:test");
const assert = require("node:assert/strict");

const { hasAuthHeader, normalizeRawToken, normalizeStringList, stripUpstreamProviderOverrideKeys } = require("../payload/extension/out/byok/infra/util");

test("normalizeStringList: ignores non-string entries and trims/dedups", () => {
  const out = normalizeStringList([" a ", 1, null, undefined, { a: 1 }, "b", "a", "", "  "], { maxItems: 50 });
  assert.deepEqual(out, ["a", "b"]);
});

test("normalizeStringList: respects maxItems cap", () => {
  const out = normalizeStringList(["a", "b", "c", "d"], { maxItems: 2 });
  assert.deepEqual(out, ["a", "b"]);
});

test("hasAuthHeader: requires non-empty auth-like header value", () => {
  assert.equal(hasAuthHeader({ authorization: "   " }), false);
  assert.equal(hasAuthHeader({ authorization: "<redacted>" }), false);
  assert.equal(hasAuthHeader({ authorization: "Bearer <redacted>" }), false);
  assert.equal(hasAuthHeader({ "x-api-key": "(set)" }), false);
  assert.equal(hasAuthHeader({ "x-auth-token": "(redacted)" }), false);
  assert.equal(hasAuthHeader({ "content-type": "application/json", accept: "application/json" }), false);
  assert.equal(hasAuthHeader({ "HTTP-Referer": "https://app.example", "x-title": "Augment BYOK" }), false);
  assert.equal(hasAuthHeader({ "x-author": "alice", author: "bob" }), false);
  assert.equal(hasAuthHeader({ "x-auth-mode": "basic" }), false);
  assert.equal(hasAuthHeader({ "x-secret-sauce": "abc" }), false);
  assert.equal(hasAuthHeader({ authorization: "Bearer" }), false);
  assert.equal(hasAuthHeader({ authorization: "Basic" }), false);
  assert.equal(hasAuthHeader({ authorization: "Token" }), false);
  assert.equal(hasAuthHeader({ authorization: "Bearer token" }), true);
  assert.equal(hasAuthHeader({ "x-api-key": "key" }), true);
  assert.equal(hasAuthHeader({ "x-auth-token": "token" }), true);
  assert.equal(hasAuthHeader({ "helicone-auth": "Bearer token" }), true);
  assert.equal(hasAuthHeader({ "x-client-secret": "secret" }), true);
  assert.equal(hasAuthHeader({ password: "secret" }), true);
  assert.equal(hasAuthHeader({ passwd: "secret" }), true);
});

test("normalizeRawToken: treats redacted placeholders as missing secrets", () => {
  assert.equal(normalizeRawToken("<redacted>"), "");
  assert.equal(normalizeRawToken("(set)"), "");
  assert.equal(normalizeRawToken("(redacted)"), "");
  assert.equal(normalizeRawToken("Bearer"), "");
  assert.equal(normalizeRawToken("Basic"), "");
  assert.equal(normalizeRawToken("Token"), "");
  assert.equal(normalizeRawToken("Bearer <redacted>"), "");
  assert.equal(normalizeRawToken("OPENAI_API_KEY=<redacted>"), "");
  assert.equal(normalizeRawToken("Bearer real-token"), "real-token");
  assert.equal(normalizeRawToken("Bearer\treal-token"), "real-token");
});

test("stripUpstreamProviderOverrideKeys: removes third-party override aliases without mutating input", () => {
  const input = {
    model: "byok:openai:gpt-5.2",
    prompt: "hello",
    third_party_override: { provider: "official-shadow" },
    thirdPartyOverride: { provider: "official-shadow-camel" }
  };
  const out = stripUpstreamProviderOverrideKeys(input);

  assert.deepEqual(out, { model: "byok:openai:gpt-5.2", prompt: "hello" });
  assert.equal(Object.prototype.hasOwnProperty.call(input, "third_party_override"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(input, "thirdPartyOverride"), true);
});

test("stripUpstreamProviderOverrideKeys: keeps object identity when no override exists", () => {
  const input = { prompt: "hello" };
  assert.equal(stripUpstreamProviderOverrideKeys(input), input);
});
