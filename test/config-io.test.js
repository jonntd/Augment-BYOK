const test = require("node:test");
const assert = require("node:assert/strict");

const { REDACTED, redactConfigSecrets, mergeConfigPreservingSecrets } = require("../payload/extension/out/byok/ui/config-io");

function makeCfg({ officialToken, providerKey, headers } = {}) {
  return {
    version: 1,
    official: { completionUrl: "https://acemcp.heroman.wtf/relay/", apiToken: officialToken || "" },
    providers: [
      {
        id: "p1",
        type: "openai_compatible",
        baseUrl: "https://example.com/v1",
        apiKey: providerKey || "",
        headers: headers || {},
        models: ["m1"],
        defaultModel: "m1",
        requestDefaults: {}
      }
    ],
    routing: { rules: {} },
    prompts: { endpointSystem: {} },
    historySummary: { enabled: false, providerId: "", model: "" }
  };
}

test("config-io: redactConfigSecrets redacts official/apiKey/auth headers", () => {
  const cfg = makeCfg({
    officialToken: "ace_secret",
    providerKey: "sk-secret",
    headers: {
      Authorization: "Bearer X",
      "x-api-key": "Y",
      "x-auth-token": "token",
      "helicone-auth": "Bearer HELI",
      "x-auth-mode": "basic",
      "x-secret-sauce": "abc",
      "client-secret": "secret",
      password: "pw",
      cookie: "sid=secret",
      other: "Z"
    }
  });
  const redacted = redactConfigSecrets(cfg);

  assert.equal(redacted.official.apiToken, REDACTED);
  assert.equal(redacted.providers[0].apiKey, REDACTED);
  assert.equal(redacted.providers[0].headers.Authorization, REDACTED);
  assert.equal(redacted.providers[0].headers["x-api-key"], REDACTED);
  assert.equal(redacted.providers[0].headers["x-auth-token"], REDACTED);
  assert.equal(redacted.providers[0].headers["helicone-auth"], REDACTED);
  assert.equal(redacted.providers[0].headers["x-auth-mode"], "basic");
  assert.equal(redacted.providers[0].headers["x-secret-sauce"], "abc");
  assert.equal(redacted.providers[0].headers["client-secret"], REDACTED);
  assert.equal(redacted.providers[0].headers.password, REDACTED);
  assert.equal(redacted.providers[0].headers.cookie, REDACTED);
  assert.equal(redacted.providers[0].headers.other, "Z");
});

test("config-io: mergeConfigPreservingSecrets keeps current secrets when incoming is <redacted>/missing", () => {
  const current = makeCfg({
    officialToken: "ace_current",
    providerKey: "sk-current",
    headers: { Authorization: "Bearer CUR", "x-api-key": "CUR2" }
  });
  const incoming = makeCfg({
    officialToken: REDACTED,
    providerKey: REDACTED,
    headers: { Authorization: "Bearer <redacted>" }
  });

  const merged = mergeConfigPreservingSecrets(current, incoming);

  assert.equal(merged.official.apiToken, "ace_current");
  assert.equal(merged.providers[0].apiKey, "sk-current");
  assert.equal(merged.providers[0].headers.Authorization, "Bearer CUR");
  assert.equal(merged.providers[0].headers["x-api-key"], "CUR2");
});

test("config-io: mergeConfigPreservingSecrets overwrites when incoming provides real secrets", () => {
  const current = makeCfg({
    officialToken: "ace_current",
    providerKey: "sk-current",
    headers: { Authorization: "Bearer CUR" }
  });
  const incoming = makeCfg({
    officialToken: "ace_new",
    providerKey: "sk-new",
    headers: { Authorization: "Bearer NEW" }
  });

  const merged = mergeConfigPreservingSecrets(current, incoming);
  assert.equal(merged.official.apiToken, "ace_new");
  assert.equal(merged.providers[0].apiKey, "sk-new");
  assert.equal(merged.providers[0].headers.Authorization, "Bearer NEW");
});

test("config-io: mergeConfigPreservingSecrets treats auth header keys case-insensitively", () => {
  const current = makeCfg({ headers: { Authorization: "Bearer CUR" } });
  const incoming = makeCfg({ headers: { authorization: REDACTED } });

  const merged = mergeConfigPreservingSecrets(current, incoming);
  assert.equal(merged.providers[0].headers.authorization, "Bearer CUR");
});


test("config-io: mergeConfigPreservingSecrets keeps newly supported auth headers", () => {
  const current = makeCfg({
    headers: {
      "x-auth-token": "CUR_TOKEN",
      "client-secret": "CUR_SECRET",
      cookie: "sid=current"
    }
  });
  const incoming = makeCfg({
    headers: {
      "X-Auth-Token": REDACTED,
      "client-secret": "",
      other: "kept"
    }
  });

  const merged = mergeConfigPreservingSecrets(current, incoming);
  assert.equal(merged.providers[0].headers["X-Auth-Token"], "CUR_TOKEN");
  assert.equal(merged.providers[0].headers["client-secret"], "CUR_SECRET");
  assert.equal(merged.providers[0].headers.cookie, "sid=current");
  assert.equal(merged.providers[0].headers.other, "kept");
});
