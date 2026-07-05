const test = require("node:test");
const assert = require("node:assert/strict");

const { defaultConfig } = require("../payload/extension/out/byok/config/config");
const { decideRoute } = require("../payload/extension/out/byok/core/router");

function enableOpenAi(cfg) {
  const provider = cfg.providers.find((p) => p && p.id === "openai");
  provider.apiKey = "sk-test-openai";
  return cfg;
}

test("decideRoute: empty endpoint => official", () => {
  const cfg = defaultConfig();
  const r = decideRoute({ cfg, endpoint: "", body: {}, runtimeEnabled: true });
  assert.equal(r.mode, "official");
  assert.equal(r.reason, "empty_endpoint");
});

test("decideRoute: runtime disabled => rollback to official", () => {
  const cfg = defaultConfig();
  const r = decideRoute({ cfg, endpoint: "/chat", body: { model: "byok:openai:gpt-4o-mini" }, runtimeEnabled: false });
  assert.equal(r.mode, "official");
  assert.equal(r.endpoint, "/chat");
  assert.equal(r.reason, "rollback_disabled");
});

test("decideRoute: byok (default rule) picks provider/model from byok:model", () => {
  const cfg = enableOpenAi(defaultConfig());
  const r = decideRoute({ cfg, endpoint: "/chat-stream", body: { model: "byok:openai:gpt-4o-mini" }, runtimeEnabled: true });
  assert.equal(r.mode, "byok");
  assert.equal(r.endpoint, "/chat-stream");
  assert.equal(r.reason, "byok");
  assert.equal(r.provider.id, "openai");
  assert.equal(r.model, "gpt-4o-mini");
});

test("decideRoute: accepts model_id (snake_case) from request body", () => {
  const cfg = enableOpenAi(defaultConfig());
  const r = decideRoute({ cfg, endpoint: "/chat-stream", body: { model_id: "byok:openai:gpt-4o" }, runtimeEnabled: true });
  assert.equal(r.mode, "byok");
  assert.equal(r.endpoint, "/chat-stream");
  assert.equal(r.provider.id, "openai");
  assert.equal(r.model, "gpt-4o");
});

test("decideRoute: model picker overrides endpoint rule model", () => {
  const cfg = enableOpenAi(defaultConfig());
  cfg.routing.rules["/chat-stream"] = { mode: "byok", providerId: "openai", model: "gpt-4o-mini" };
  const r = decideRoute({ cfg, endpoint: "/chat-stream", body: { model: "byok:openai:gpt-4o" }, runtimeEnabled: true });
  assert.equal(r.mode, "byok");
  assert.equal(r.endpoint, "/chat-stream");
  assert.equal(r.provider.id, "openai");
  assert.equal(r.model, "gpt-4o");
});

test("decideRoute: model picker overrides endpoint rule providerId", () => {
  const cfg = enableOpenAi(defaultConfig());
  cfg.providers.find((p) => p && p.id === "anthropic").apiKey = "sk-ant-test-anthropic";
  cfg.routing.rules["/chat-stream"] = { mode: "byok", providerId: "openai", model: "gpt-4o-mini" };
  const r = decideRoute({
    cfg,
    endpoint: "/chat-stream",
    body: { model: "byok:anthropic:claude-3-5-sonnet-20241022" },
    runtimeEnabled: true
  });
  assert.equal(r.mode, "byok");
  assert.equal(r.endpoint, "/chat-stream");
  assert.equal(r.provider.id, "anthropic");
  assert.equal(r.model, "claude-3-5-sonnet-20241022");
});

test("decideRoute: disabled rule => disabled", () => {
  const cfg = defaultConfig();
  const r = decideRoute({ cfg, endpoint: "/client-metrics", body: { model: "byok:openai:gpt-4o-mini" }, runtimeEnabled: true });
  assert.equal(r.mode, "disabled");
  assert.equal(r.endpoint, "/client-metrics");
  assert.equal(r.reason, "rule");
});

test("decideRoute: disabled get-models rule beats model override", () => {
  const cfg = defaultConfig();
  cfg.routing.rules["/get-models"] = { mode: "disabled" };
  const r = decideRoute({ cfg, endpoint: "/get-models", body: { model: "byok:openai:gpt-4o-mini" }, runtimeEnabled: true });
  assert.equal(r.mode, "disabled");
  assert.equal(r.endpoint, "/get-models");
  assert.equal(r.reason, "rule");
});

test("decideRoute: model override forces byok when rule is official", () => {
  const cfg = enableOpenAi(defaultConfig());
  const r = decideRoute({ cfg, endpoint: "/unknown-future-endpoint", body: { model: "byok:openai:gpt-4o-mini" }, runtimeEnabled: true });
  assert.equal(r.mode, "byok");
  assert.equal(r.endpoint, "/unknown-future-endpoint");
  assert.equal(r.reason, "model_override");
  assert.equal(r.provider.id, "openai");
  assert.equal(r.model, "gpt-4o-mini");
});

test("decideRoute: empty routing.rules falls back to built-in defaults", () => {
  const cfg = enableOpenAi(defaultConfig());
  cfg.routing.rules = {};
  const r = decideRoute({ cfg, endpoint: "/get-models", body: {}, runtimeEnabled: true });
  assert.equal(r.mode, "byok");
  assert.equal(r.endpoint, "/get-models");
});

test("decideRoute: non-chat endpoint uses byok when rule is byok", () => {
  const cfg = enableOpenAi(defaultConfig());
  const r = decideRoute({ cfg, endpoint: "/completion", body: {}, runtimeEnabled: true });
  assert.equal(r.mode, "byok");
  assert.equal(r.endpoint, "/completion");
});

test("decideRoute: route object no longer carries delegation meta", () => {
  const cfg = enableOpenAi(defaultConfig());
  const r = decideRoute({ cfg, endpoint: "/chat-stream", body: {}, runtimeEnabled: true });
  assert.equal(r.mode, "byok");
  assert.equal(Object.prototype.hasOwnProperty.call(r, "delegateOfficialAssembler"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(r, "delegateExecutionOwner"), false);
});

test("decideRoute: missing configured provider falls back to official", () => {
  const cfg = defaultConfig();
  cfg.routing.rules["/completion"] = { mode: "byok", providerId: "missing-provider", model: "m1" };
  const r = decideRoute({ cfg, endpoint: "/completion", body: {}, runtimeEnabled: true });
  assert.equal(r.mode, "official");
  assert.equal(r.reason, "provider_missing");
  assert.equal(r.providerId, "missing-provider");
});



test("decideRoute: explicit missing model provider does not fall back to another provider", () => {
  const cfg = defaultConfig();
  cfg.providers.find((p) => p && p.id === "anthropic").apiKey = "sk-ant-test-anthropic";

  const r = decideRoute({ cfg, endpoint: "/chat-stream", body: { model: "byok:removed:gpt-4o-mini" }, runtimeEnabled: true });
  assert.equal(r.mode, "official");
  assert.equal(r.reason, "provider_missing");
  assert.equal(r.providerId, "removed");
});

test("decideRoute: unconfigured provider falls back to official", () => {
  const cfg = defaultConfig();
  const r = decideRoute({ cfg, endpoint: "/chat-stream", body: { model: "byok:openai:gpt-4o-mini" }, runtimeEnabled: true });
  assert.equal(r.mode, "official");
  assert.equal(r.reason, "provider_unavailable");
  assert.equal(r.providerId, "openai");
});

test("decideRoute: metadata-only headers do not make provider selectable", () => {
  const cfg = defaultConfig();
  const provider = cfg.providers.find((p) => p && p.id === "openai");
  provider.baseUrl = "https://api.openai.com/v1";
  provider.apiKey = "";
  provider.headers = {
    "content-type": "application/json",
    "HTTP-Referer": "https://app.example",
    "x-title": "Augment BYOK"
  };

  const r = decideRoute({ cfg, endpoint: "/chat-stream", body: { model: "byok:openai:gpt-4o-mini" }, runtimeEnabled: true });
  assert.equal(r.mode, "official");
  assert.equal(r.reason, "provider_unavailable");
  assert.equal(r.providerId, "openai");
});

test("decideRoute: auth-looking non-secret headers do not make provider selectable", () => {
  const cfg = defaultConfig();
  const provider = cfg.providers.find((p) => p && p.id === "openai");
  provider.baseUrl = "https://api.openai.com/v1";
  provider.apiKey = "";
  provider.headers = {
    "x-auth-mode": "basic",
    "x-secret-sauce": "abc"
  };

  const r = decideRoute({ cfg, endpoint: "/chat-stream", body: { model: "byok:openai:gpt-4o-mini" }, runtimeEnabled: true });
  assert.equal(r.mode, "official");
  assert.equal(r.reason, "provider_unavailable");
  assert.equal(r.providerId, "openai");
});

test("decideRoute: redacted placeholders do not make provider selectable", () => {
  const cfg = defaultConfig();
  const provider = cfg.providers.find((p) => p && p.id === "openai");
  provider.baseUrl = "https://api.openai.com/v1";
  provider.apiKey = "<redacted>";
  provider.headers = {
    authorization: "Bearer <redacted>",
    "x-api-key": "(set)",
    "x-auth-token": "(redacted)"
  };

  const r = decideRoute({ cfg, endpoint: "/chat-stream", body: { model: "byok:openai:gpt-4o-mini" }, runtimeEnabled: true });
  assert.equal(r.mode, "official");
  assert.equal(r.reason, "provider_unavailable");
  assert.equal(r.providerId, "openai");
});

test("decideRoute: get-models remains BYOK so it can return an empty BYOK registry", () => {
  const cfg = defaultConfig();
  const r = decideRoute({ cfg, endpoint: "/get-models", body: {}, runtimeEnabled: true });
  assert.equal(r.mode, "byok");
  assert.equal(r.reason, "byok");
  assert.equal(Object.prototype.hasOwnProperty.call(r, "provider"), false);
});

test("decideRoute: default route picks first executable provider", () => {
  const cfg = defaultConfig();
  cfg.providers.find((p) => p && p.id === "anthropic").apiKey = "sk-ant-test-anthropic";
  const r = decideRoute({ cfg, endpoint: "/chat-stream", body: {}, runtimeEnabled: true });
  assert.equal(r.mode, "byok");
  assert.equal(r.provider.id, "anthropic");
  assert.equal(r.model, "claude-4.6-sonnet");
});

test("decideRoute: default route skips authenticated providers with no configured model", () => {
  const cfg = defaultConfig();
  const openai = cfg.providers.find((p) => p && p.id === "openai");
  openai.apiKey = "sk-test-openai";
  openai.defaultModel = "";
  openai.models = [];
  const anthropic = cfg.providers.find((p) => p && p.id === "anthropic");
  anthropic.apiKey = "sk-ant-test-anthropic";

  const r = decideRoute({ cfg, endpoint: "/chat-stream", body: {}, runtimeEnabled: true });
  assert.equal(r.mode, "byok");
  assert.equal(r.provider.id, "anthropic");
  assert.equal(r.model, "claude-4.6-sonnet");
});

test("decideRoute: provider models[0] is usable when defaultModel is empty", () => {
  const cfg = defaultConfig();
  const openai = cfg.providers.find((p) => p && p.id === "openai");
  openai.apiKey = "sk-test-openai";
  openai.defaultModel = "";
  openai.models = ["gpt-only-models-list"];

  const r = decideRoute({ cfg, endpoint: "/chat-stream", body: {}, runtimeEnabled: true });
  assert.equal(r.mode, "byok");
  assert.equal(r.provider.id, "openai");
  assert.equal(r.model, "gpt-only-models-list");
});

test("decideRoute: normalizes accidental byok-prefixed rule/default models", () => {
  const cfg = defaultConfig();
  const openai = cfg.providers.find((p) => p && p.id === "openai");
  openai.apiKey = "sk-test-openai";
  openai.defaultModel = "byok:openai:gpt-default";
  openai.models = ["byok:openai:gpt-list"];
  cfg.routing.rules["/completion"] = { mode: "byok", providerId: "openai", model: "byok:openai:gpt-rule" };

  const fromRule = decideRoute({ cfg, endpoint: "/completion", body: {}, runtimeEnabled: true });
  assert.equal(fromRule.mode, "byok");
  assert.equal(fromRule.provider.id, "openai");
  assert.equal(fromRule.model, "gpt-rule");

  cfg.routing.rules["/chat-stream"] = { mode: "byok", providerId: "openai" };
  const fromDefault = decideRoute({ cfg, endpoint: "/chat-stream", body: {}, runtimeEnabled: true });
  assert.equal(fromDefault.mode, "byok");
  assert.equal(fromDefault.provider.id, "openai");
  assert.equal(fromDefault.model, "gpt-default");
});

test("decideRoute: authenticated provider without any model falls back to official", () => {
  const cfg = defaultConfig();
  const provider = cfg.providers.find((p) => p && p.id === "openai");
  provider.apiKey = "sk-test-openai";
  provider.defaultModel = "";
  provider.models = [];
  cfg.providers = [provider];

  const r = decideRoute({ cfg, endpoint: "/chat-stream", body: {}, runtimeEnabled: true });
  assert.equal(r.mode, "official");
  assert.equal(r.reason, "model_missing");
  assert.equal(r.providerId, "openai");
});
