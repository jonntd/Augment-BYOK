const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { defaultConfig } = require("../payload/extension/out/byok/config/default-config");
const { state } = require("../payload/extension/out/byok/config/state");
const { buildByokModelsFromConfig, hasUsableProviderAuth } = require("../payload/extension/out/byok/core/protocol");
const { maybeHandleCallApi } = require("../payload/extension/out/byok/runtime/shim/call-api");

function startGetModelsServer(responseJson, { status = 200 } = {}) {
  return new Promise((resolve) => {
    let count = 0;
    const requests = [];
    const server = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/get-models") {
        count += 1;
        requests.push({ authorization: req.headers.authorization || "" });
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(responseJson));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}/`, getCount: () => count, requests });
    });
  });
}

function parseFlagJson(flags, snakeKey, camelKey) {
  const raw = flags?.[snakeKey] ?? flags?.[camelKey];
  assert.equal(typeof raw, "string");
  return JSON.parse(raw);
}

async function withConfig(cfg, fn) {
  const previous = state.configManager;
  state.configManager = { get: () => cfg };
  try {
    return await fn();
  } finally {
    state.configManager = previous;
  }
}

async function captureWarn(fn) {
  const previous = console.warn;
  const calls = [];
  console.warn = (...args) => calls.push(args);
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    console.warn = previous;
  }
}

function warnText(args) {
  return args
    .map((x) => {
      if (typeof x === "string") return x;
      try {
        return JSON.stringify(x);
      } catch {
        return String(x);
      }
    })
    .join(" ");
}

test("handleGetModels: disabled route stays no-op even with BYOK model override", async () => {
  const cfg = defaultConfig();
  cfg.routing.rules["/get-models"] = { mode: "disabled" };

  await withConfig(cfg, async () => {
    const out = await maybeHandleCallApi({
      endpoint: "/get-models",
      body: { model: "byok:openai:gpt-5.2" },
      timeoutMs: 2000,
      upstreamCompletionURL: "http://127.0.0.1:1/",
      upstreamApiToken: "ace-test"
    });
    assert.deepEqual(out, { tools: [], agents: [], items: [], data: [], results: [] });
  });
});

test("handleGetModels: filters upstream official models when BYOK models exist", async () => {
  const cfg = defaultConfig();
  cfg.providers[0].apiKey = "sk-test-openai";
  cfg.providers[0].baseUrl = "https://api.openai.com/v1";
  cfg.providers[1].apiKey = "sk-test-anthropic";
  cfg.providers[1].baseUrl = "https://api.anthropic.com/v1";

  const { server, baseUrl } = await startGetModelsServer({
    default_model: "official-default",
    models: [{ name: "official-a" }, { name: "official-b" }],
    feature_flags: {
      some_flag: true,
      agent_chat_model: "official-a",
      model_registry: JSON.stringify({ "Official A": "official-a" }),
      model_info_registry: JSON.stringify({ "official-a": { displayName: "Official A" } })
    }
  });

  try {
    await withConfig(cfg, async () => {
      const out = await maybeHandleCallApi({
        endpoint: "/get-models",
        body: {},
        timeoutMs: 2000,
        upstreamCompletionURL: baseUrl,
        upstreamApiToken: "ace-test"
      });
      assert.ok(out && typeof out === "object");
      assert.equal(out.default_model, "byok:openai:gpt-5.2");
      assert.ok(Array.isArray(out.models));
      assert.ok(out.models.length > 0);
      for (const m of out.models) {
        assert.equal(typeof m.name, "string");
        assert.ok(m.name.startsWith("byok:"), `unexpected model leaked into picker: ${m.name}`);
      }

      const flags = out.feature_flags;
      assert.ok(flags && typeof flags === "object");
      assert.equal(flags.some_flag, true);

      assert.equal(flags.agent_chat_model, "byok:openai:gpt-5.2");
      assert.equal(flags.agentChatModel, "byok:openai:gpt-5.2");

      const registry = parseFlagJson(flags, "model_registry", "modelRegistry");
      assert.ok(registry && typeof registry === "object");
      for (const v of Object.values(registry)) {
        assert.equal(typeof v, "string");
        assert.ok(v.startsWith("byok:"), `unexpected registry entry leaked into picker: ${v}`);
      }
      assert.ok(!Object.values(registry).includes("official-a"));

      const infoRegistry = parseFlagJson(flags, "model_info_registry", "modelInfoRegistry");
      assert.ok(!Object.prototype.hasOwnProperty.call(infoRegistry, "official-a"));
      for (const k of Object.keys(infoRegistry)) assert.ok(k.startsWith("byok:"), `unexpected info registry key leaked: ${k}`);
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("handleGetModels: accepts upstream completion URL object", async () => {
  const cfg = defaultConfig();
  cfg.official.completionUrl = "http://127.0.0.1:1/";
  cfg.official.apiToken = "configured-token";
  cfg.providers[0].apiKey = "sk-test-openai";
  cfg.providers[0].baseUrl = "https://api.openai.com/v1";

  const { server, baseUrl, getCount, requests } = await startGetModelsServer({
    default_model: "official-default",
    models: [{ name: "official-a" }],
    feature_flags: {}
  });

  try {
    await withConfig(cfg, async () => {
      const out = await maybeHandleCallApi({
        endpoint: "/get-models",
        body: {},
        timeoutMs: 2000,
        upstreamCompletionURL: new URL(baseUrl),
        upstreamApiToken: "ace-url-object"
      });

      assert.equal(getCount(), 1);
      assert.equal(requests[0]?.authorization, "Bearer ace-url-object");
      assert.equal(out.default_model, "byok:openai:gpt-5.2");
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("handleGetModels: omits unconfigured providers instead of leaking official models", async () => {
  const cfg = defaultConfig();

  const { server, baseUrl } = await startGetModelsServer({
    default_model: "official-default",
    models: [{ name: "official-a" }, { name: "official-b" }],
    feature_flags: {
      some_flag: true,
      agent_chat_model: "official-a",
      agentChatModel: "official-b",
      model_registry: JSON.stringify({ "Official A": "official-a" }),
      model_info_registry: JSON.stringify({ "official-a": { displayName: "Official A" } })
    }
  });

  try {
    await withConfig(cfg, async () => {
      const out = await maybeHandleCallApi({
        endpoint: "/get-models",
        body: {},
        timeoutMs: 2000,
        upstreamCompletionURL: baseUrl,
        upstreamApiToken: "ace-test"
      });
      assert.ok(out && typeof out === "object");
      assert.equal(out.default_model, "byok:unconfigured:setup-needed");
      assert.ok(Array.isArray(out.models));
      assert.equal(out.models.length, 1);

      const flags = out.feature_flags;
      assert.ok(flags && typeof flags === "object");
      assert.equal(flags.agent_chat_model, "byok:unconfigured:setup-needed");
      assert.equal(flags.agentChatModel, "byok:unconfigured:setup-needed");

      const registry = parseFlagJson(flags, "model_registry", "modelRegistry");
      assert.equal(Object.keys(registry).length, 1);
      const infoRegistry = parseFlagJson(flags, "model_info_registry", "modelInfoRegistry");
      assert.equal(Object.keys(infoRegistry).length, 1);
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("handleGetModels: local fallback with no selectable provider has empty BYOK registry", async () => {
  const cfg = defaultConfig();
  const { server, baseUrl } = await startGetModelsServer({ error: "official failed" }, { status: 500 });

  try {
    await withConfig(cfg, async () => {
      const out = await maybeHandleCallApi({
        endpoint: "/get-models",
        body: {},
        timeoutMs: 2000,
        upstreamCompletionURL: baseUrl,
        upstreamApiToken: "ace-test"
      });
      assert.ok(out && typeof out === "object");
      assert.equal(out.default_model, "byok:unconfigured:setup-needed");
      assert.ok(out.models.length === 1 && out.models[0].name === "byok:unconfigured:setup-needed");
      assert.equal(out.feature_flags.agent_chat_model, "byok:unconfigured:setup-needed");
      assert.equal(out.feature_flags.agentChatModel, "byok:unconfigured:setup-needed");
      assert.ok(Object.keys(parseFlagJson(out.feature_flags, "model_registry", "modelRegistry")).length === 1);
      assert.ok(Object.keys(parseFlagJson(out.feature_flags, "model_info_registry", "modelInfoRegistry")).length === 1);
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("handleGetModels: missing official token skips network and uses local BYOK registry", async () => {
  const cfg = defaultConfig();
  cfg.official.apiToken = "";
  cfg.providers[0].apiKey = "sk-test-openai";
  cfg.providers[0].baseUrl = "https://api.openai.com/v1";

  const { server, baseUrl, getCount } = await startGetModelsServer({
    default_model: "official-default",
    models: [{ name: "official-a" }],
    feature_flags: {
      model_registry: JSON.stringify({ "Official A": "official-a" }),
      model_info_registry: JSON.stringify({ "official-a": { displayName: "Official A" } })
    }
  });

  try {
    await withConfig(cfg, async () => {
      const { result: out, calls } = await captureWarn(() =>
        maybeHandleCallApi({ endpoint: "/get-models", body: {}, timeoutMs: 2000, upstreamCompletionURL: baseUrl })
      );

      assert.equal(getCount(), 0);
      assert.ok(out && typeof out === "object");
      assert.equal(out.default_model, "byok:openai:gpt-5.2");
      assert.ok(out.models.every((m) => typeof m.name === "string" && m.name.startsWith("byok:")));
      const registry = parseFlagJson(out.feature_flags, "model_registry", "modelRegistry");
      assert.deepEqual(Object.values(registry), ["byok:openai:gpt-5.2"]);

      assert.equal(calls.length, 1);
      const text = warnText(calls[0]);
      assert.match(text, /get-models official fetch skipped/);
      assert.match(text, /network=skipped/);
      assert.match(text, /local BYOK model registry/);
      assert.match(text, /official\.apiToken/);
      assert.doesNotMatch(text, /ace-test|sk-test-openai|Bearer/);
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("buildByokModelsFromConfig: blank auth headers are not selectable", () => {
  const cfg = defaultConfig();
  cfg.providers[0].apiKey = "";
  cfg.providers[0].headers = { authorization: "   " };
  cfg.providers[1].apiKey = "";
  cfg.providers[1].headers = {};

  assert.equal(hasUsableProviderAuth(cfg.providers[0]), false);
  assert.deepEqual(buildByokModelsFromConfig(cfg), ["byok:unconfigured:setup-needed"]);

  cfg.providers[0].headers = { authorization: "Bearer proxy-token" };
  assert.equal(hasUsableProviderAuth(cfg.providers[0]), true);
  assert.deepEqual(buildByokModelsFromConfig(cfg), ["byok:openai:gpt-5.2"]);
});

test("buildByokModelsFromConfig: metadata-only headers are not selectable", () => {
  const cfg = defaultConfig();
  cfg.providers[0].apiKey = "";
  cfg.providers[0].headers = {
    "content-type": "application/json",
    accept: "application/json",
    "HTTP-Referer": "https://app.example",
    "x-title": "Augment BYOK"
  };

  assert.equal(hasUsableProviderAuth(cfg.providers[0]), false);
  assert.deepEqual(buildByokModelsFromConfig(cfg), ["byok:unconfigured:setup-needed"]);

  cfg.providers[0].headers = { "x-auth-token": "proxy-token" };
  assert.equal(hasUsableProviderAuth(cfg.providers[0]), true);
  assert.deepEqual(buildByokModelsFromConfig(cfg), ["byok:openai:gpt-5.2"]);
});

test("buildByokModelsFromConfig: redacted placeholders are not selectable", () => {
  const cfg = defaultConfig();
  const openai = cfg.providers[0];
  openai.apiKey = "<redacted>";
  openai.headers = {
    authorization: "Bearer <redacted>",
    "x-api-key": "(set)",
    "x-auth-token": "(redacted)"
  };
  cfg.providers[1].apiKey = "";
  cfg.providers[1].headers = {};

  assert.equal(hasUsableProviderAuth(openai), false);
  assert.deepEqual(buildByokModelsFromConfig(cfg), ["byok:unconfigured:setup-needed"]);

  openai.headers.authorization = "Bearer proxy-token";
  assert.equal(hasUsableProviderAuth(openai), true);
  assert.deepEqual(buildByokModelsFromConfig(cfg), ["byok:openai:gpt-5.2"]);
});

test("buildByokModelsFromConfig: normalizes accidental byok-prefixed configured models", () => {
  const cfg = defaultConfig();
  const openai = cfg.providers.find((p) => p && p.id === "openai");
  openai.apiKey = "sk-test-openai";
  openai.defaultModel = "byok:openai:gpt-default";
  openai.models = ["byok:openai:gpt-default", "gpt-list", "byok:anthropic:claude-cross-provider", "byok:bad"];
  cfg.routing.rules["/chat-stream"] = { mode: "byok", providerId: "openai", model: "byok:openai:gpt-rule" };

  assert.deepEqual(buildByokModelsFromConfig(cfg), ["byok:openai:gpt-default", "byok:openai:gpt-list", "byok:openai:gpt-rule"]);
});
