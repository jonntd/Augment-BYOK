const test = require("node:test");
const assert = require("node:assert/strict");

const { defaultConfig } = require("../payload/extension/out/byok/config/config");
const { state } = require("../payload/extension/out/byok/config/state");
const { cacheGetFreshState, cachePut, setHistorySummaryStorage } = require("../payload/extension/out/byok/core/augment-history-summary/cache");
const { maybeHandleCallApi, SUPPORTED_CALL_API_ENDPOINTS } = require("../payload/extension/out/byok/runtime/shim/call-api");
const {
  maybeHandleCallApiStream,
  SUPPORTED_CALL_API_STREAM_ENDPOINTS
} = require("../payload/extension/out/byok/runtime/shim/call-api-stream");

function makeStorage() {
  const store = new Map();
  return {
    get: (k) => store.get(k),
    update: async (k, v) => store.set(k, v)
  };
}

function makeUsableConfig() {
  const cfg = defaultConfig();
  const provider = cfg.providers.find((p) => p && p.id === "openai");
  provider.apiKey = "sk-test-openai";
  return cfg;
}

async function withRuntimeState({ runtimeEnabled = true, cfg = defaultConfig(), configManager } = {}, fn) {
  const prevEnabled = state.runtimeEnabled;
  const prevConfigManager = state.configManager;
  const prevUpstream = globalThis.__augment_byok_upstream;
  state.runtimeEnabled = runtimeEnabled;
  state.configManager = configManager || { get: () => cfg };
  try {
    return await fn();
  } finally {
    state.runtimeEnabled = prevEnabled;
    state.configManager = prevConfigManager;
    if (prevUpstream === undefined) delete globalThis.__augment_byok_upstream;
    else globalThis.__augment_byok_upstream = prevUpstream;
    setHistorySummaryStorage(null);
  }
}

function makeThrowingVscodeFs(onRead) {
  return {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
      getWorkspaceFolder: () => ({ uri: { fsPath: "/workspace" } }),
      fs: {
        readFile: async () => {
          onRead();
          throw new Error("workspace fs should not be touched when runtime is disabled");
        }
      }
    },
    Uri: {
      file: (fsPath) => ({ fsPath }),
      parse: (raw) => ({ fsPath: raw }),
      joinPath: (base, rel) => ({ fsPath: `${base.fsPath}/${rel}` })
    }
  };
}

async function captureAudit(fn) {
  const previous = console.log;
  const calls = [];
  console.log = (...args) => calls.push(args.map((x) => String(x)).join(" "));
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    console.log = previous;
  }
}

test("runtime disabled: callApi rollback has no BYOK cache side effect", async () => {
  await withRuntimeState({ runtimeEnabled: false }, async () => {
    setHistorySummaryStorage(makeStorage());
    await cachePut("conv1", "r2", "SUMMARY", "sid1", Date.now(), {});
    assert.ok(cacheGetFreshState("conv1", Date.now(), 0));

    const { result, calls } = await captureAudit(() =>
      maybeHandleCallApi({ endpoint: "/conversations/conv1/delete", body: {}, timeoutMs: 1000 })
    );

    assert.equal(result, undefined);
    assert.deepEqual(calls, []);
    assert.ok(cacheGetFreshState("conv1", Date.now(), 0));
  });
});

test("unsupported official endpoint has no BYOK cache side effect", async () => {
  await withRuntimeState({ runtimeEnabled: true, cfg: makeUsableConfig() }, async () => {
    setHistorySummaryStorage(makeStorage());
    await cachePut("conv1", "r2", "SUMMARY", "sid1", Date.now(), {});
    assert.ok(cacheGetFreshState("conv1", Date.now(), 0));

    const { result, calls } = await captureAudit(() =>
      maybeHandleCallApi({
        endpoint: "/conversations/conv1/delete",
        body: { model: "byok:openai:gpt-5.2" },
        timeoutMs: 1000
      })
    );

    assert.equal(result, undefined);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /mode=official/);
    assert.match(calls[0], /reason=unsupported_byok_endpoint/);
    assert.ok(cacheGetFreshState("conv1", Date.now(), 0));
  });
});

test("runtime disabled: shims do not capture upstream call host", async () => {
  await withRuntimeState({ runtimeEnabled: false }, async () => {
    delete globalThis.__augment_byok_upstream;
    const callApiHost = { callApi() {} };
    const callApiStreamHost = { callApiStream() {} };

    const api = await maybeHandleCallApi({ endpoint: "/chat", body: {}, timeoutMs: 1000, upstreamCallHost: callApiHost });
    const stream = await maybeHandleCallApiStream({ endpoint: "/chat-stream", body: {}, timeoutMs: 1000, upstreamCallHost: callApiStreamHost });

    assert.equal(api, undefined);
    assert.equal(stream, undefined);
    assert.equal(globalThis.__augment_byok_upstream, undefined);
  });
});

test("runtime disabled: all BYOK-supported endpoints skip config/audit/upstream/workspace side effects", async () => {
  let configReads = 0;
  let workspaceReads = 0;
  const prevVscode = state.vscode;
  const throwingConfigManager = {
    get() {
      configReads += 1;
      throw new Error("config should not be read when runtime is disabled");
    }
  };

  state.vscode = makeThrowingVscodeFs(() => {
    workspaceReads += 1;
  });

  try {
    await withRuntimeState({ runtimeEnabled: false, configManager: throwingConfigManager }, async () => {
      delete globalThis.__augment_byok_upstream;
      const callApiHost = { callApi() {} };
      const callApiStreamHost = { callApiStream() {} };
      const byokBody = { model: "byok:openai:gpt-5.2" };
      assert.ok(SUPPORTED_CALL_API_ENDPOINTS.length > 0);
      assert.ok(SUPPORTED_CALL_API_STREAM_ENDPOINTS.length > 0);

      for (const endpoint of SUPPORTED_CALL_API_ENDPOINTS) {
        const { result, calls } = await captureAudit(() =>
          maybeHandleCallApi({ endpoint, body: byokBody, timeoutMs: 1000, upstreamCallHost: callApiHost })
        );
        assert.equal(result, undefined, endpoint);
        assert.deepEqual(calls, [], endpoint);
      }

      for (const endpoint of SUPPORTED_CALL_API_STREAM_ENDPOINTS) {
        const { result, calls } = await captureAudit(() =>
          maybeHandleCallApiStream({ endpoint, body: byokBody, timeoutMs: 1000, upstreamCallHost: callApiStreamHost })
        );
        assert.equal(result, undefined, endpoint);
        assert.deepEqual(calls, [], endpoint);
      }

      assert.equal(configReads, 0);
      assert.equal(workspaceReads, 0);
      assert.equal(globalThis.__augment_byok_upstream, undefined);
    });
  } finally {
    state.vscode = prevVscode;
  }
});

test("runtime disabled: default disabled/official endpoints still fall through to upstream without no-op", async () => {
  let configReads = 0;
  const throwingConfigManager = {
    get() {
      configReads += 1;
      throw new Error("config should not be read when runtime is disabled");
    }
  };

  await withRuntimeState({ runtimeEnabled: false, configManager: throwingConfigManager }, async () => {
    delete globalThis.__augment_byok_upstream;
    const callApiHost = { callApi() {} };
    const callApiStreamHost = { callApiStream() {} };

    for (const endpoint of [
      "/client-metrics",
      "/client-completion-timelines",
      "/record-session-events",
      "/record-user-events",
      "/resolve-completions",
      "/resolve-edit",
      "/record-request-events",
      "/report-error",
      "/new-upstream-json"
    ]) {
      const { result, calls } = await captureAudit(() =>
        maybeHandleCallApi({ endpoint, body: { model: "byok:openai:gpt-5.2" }, timeoutMs: 1000, upstreamCallHost: callApiHost })
      );
      assert.equal(result, undefined, endpoint);
      assert.deepEqual(calls, [], endpoint);
    }

    for (const endpoint of ["/new-upstream-stream", "/instruction-stream", "/smart-paste-stream"]) {
      const { result, calls } = await captureAudit(() =>
        maybeHandleCallApiStream({ endpoint, body: { model: "byok:openai:gpt-5.2" }, timeoutMs: 1000, upstreamCallHost: callApiStreamHost })
      );
      assert.equal(result, undefined, endpoint);
      assert.deepEqual(calls, [], endpoint);
    }

    assert.equal(configReads, 0);
    assert.equal(globalThis.__augment_byok_upstream, undefined);
  });
});

test("callApi boundary: third_party_override is stripped before delegated text assembly", async () => {
  const cfg = makeUsableConfig();

  await withRuntimeState({ runtimeEnabled: true, cfg }, async () => {
    const body = {
      model: "byok:openai:gpt-5.2",
      third_party_override: {
        messages: [{ role: "user", content: "SHOULD NOT BECOME BYOK PROMPT" }]
      },
      thirdPartyOverride: {
        messages: [{ role: "user", content: "SHOULD NOT BECOME BYOK PROMPT CAMEL" }]
      }
    };

    await assert.rejects(
      async () => await maybeHandleCallApi({ endpoint: "/completion", body, timeoutMs: 1000 }),
      /official text assembler delegation failed: invalid_request_body/
    );
    assert.equal(Object.prototype.hasOwnProperty.call(body, "third_party_override"), true);
    assert.equal(Object.prototype.hasOwnProperty.call(body, "thirdPartyOverride"), true);
  });
});

test("callApiStream boundary: third_party_override is stripped before delegated text assembly", async () => {
  const cfg = makeUsableConfig();

  await withRuntimeState({ runtimeEnabled: true, cfg }, async () => {
    const body = {
      model: "byok:openai:gpt-5.2",
      third_party_override: {
        messages: [{ role: "user", content: "SHOULD NOT BECOME BYOK STREAM PROMPT" }]
      },
      thirdPartyOverride: {
        input: [{ type: "message", role: "user", content: "SHOULD NOT BECOME BYOK STREAM PROMPT CAMEL" }]
      }
    };

    await assert.rejects(
      async () => await maybeHandleCallApiStream({ endpoint: "/prompt-enhancer", body, timeoutMs: 1000 }),
      /official text assembler delegation failed: invalid_request_body/
    );
    assert.equal(Object.prototype.hasOwnProperty.call(body, "third_party_override"), true);
    assert.equal(Object.prototype.hasOwnProperty.call(body, "thirdPartyOverride"), true);
  });
});

test("callApi boundary: byok model on unsupported endpoint stays official", async () => {
  await withRuntimeState({ runtimeEnabled: true, cfg: makeUsableConfig() }, async () => {
    const { result, calls } = await captureAudit(() =>
      maybeHandleCallApi({ endpoint: "/unknown-future-endpoint", body: { model: "byok:openai:gpt-5.2" }, timeoutMs: 1000 })
    );

    assert.equal(result, undefined);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\[callApi\]/);
    assert.match(calls[0], /ep=\/unknown-future-endpoint/);
    assert.match(calls[0], /mode=official/);
    assert.match(calls[0], /reason=unsupported_byok_endpoint/);
    assert.doesNotMatch(calls[0], /mode=byok/);
  });
});

test("callApi boundary: unsupported endpoint rule=byok stays official", async () => {
  const cfg = makeUsableConfig();
  cfg.routing.rules["/new-upstream-json"] = { mode: "byok", providerId: "openai", model: "gpt-5.2" };

  await withRuntimeState({ runtimeEnabled: true, cfg }, async () => {
    const { result, calls } = await captureAudit(() =>
      maybeHandleCallApi({ endpoint: "/new-upstream-json", body: {}, timeoutMs: 1000 })
    );

    assert.equal(result, undefined);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\[callApi\]/);
    assert.match(calls[0], /ep=\/new-upstream-json/);
    assert.match(calls[0], /mode=official/);
    assert.match(calls[0], /reason=unsupported_byok_endpoint/);
    assert.doesNotMatch(calls[0], /mode=byok/);
  });
});

test("callApi boundary: removed upstream endpoint stays official", async () => {
  await withRuntimeState({ runtimeEnabled: true, cfg: makeUsableConfig() }, async () => {
    const { result, calls } = await captureAudit(() =>
      maybeHandleCallApi({ endpoint: "/next_edit_loc", body: { model: "byok:openai:gpt-5.2" }, timeoutMs: 1000 })
    );

    assert.equal(result, undefined);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\[callApi\]/);
    assert.match(calls[0], /ep=\/next_edit_loc/);
    assert.match(calls[0], /mode=official/);
    assert.match(calls[0], /reason=unsupported_byok_endpoint/);
  });
});

test("callApiStream boundary: byok model on unsupported endpoint stays official", async () => {
  await withRuntimeState({ runtimeEnabled: true, cfg: makeUsableConfig() }, async () => {
    const { result, calls } = await captureAudit(() =>
      maybeHandleCallApiStream({ endpoint: "/new-upstream-stream", body: { model: "byok:openai:gpt-5.2" }, timeoutMs: 1000 })
    );

    assert.equal(result, undefined);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\[callApiStream\]/);
    assert.match(calls[0], /ep=\/new-upstream-stream/);
    assert.match(calls[0], /mode=official/);
    assert.match(calls[0], /reason=unsupported_byok_endpoint/);
    assert.doesNotMatch(calls[0], /mode=byok/);
  });
});

test("callApiStream boundary: removed upstream endpoints stay official", async () => {
  await withRuntimeState({ runtimeEnabled: true, cfg: makeUsableConfig() }, async () => {
    for (const endpoint of ["/instruction-stream", "/smart-paste-stream"]) {
      const { result, calls } = await captureAudit(() =>
        maybeHandleCallApiStream({ endpoint, body: { model: "byok:openai:gpt-5.2" }, timeoutMs: 1000 })
      );

      assert.equal(result, undefined);
      assert.equal(calls.length, 1);
      assert.match(calls[0], /\[callApiStream\]/);
      assert.match(calls[0], new RegExp(`ep=${endpoint.replace("/", "\\/")}`));
      assert.match(calls[0], /mode=official/);
      assert.match(calls[0], /reason=unsupported_byok_endpoint/);
    }
  });
});

test("callApiStream boundary: unsupported endpoint rule=byok stays official", async () => {
  const cfg = makeUsableConfig();
  cfg.routing.rules["/new-upstream-stream"] = { mode: "byok", providerId: "openai", model: "gpt-5.2" };

  await withRuntimeState({ runtimeEnabled: true, cfg }, async () => {
    const { result, calls } = await captureAudit(() =>
      maybeHandleCallApiStream({ endpoint: "/new-upstream-stream", body: {}, timeoutMs: 1000 })
    );

    assert.equal(result, undefined);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\[callApiStream\]/);
    assert.match(calls[0], /ep=\/new-upstream-stream/);
    assert.match(calls[0], /mode=official/);
    assert.match(calls[0], /reason=unsupported_byok_endpoint/);
    assert.doesNotMatch(calls[0], /mode=byok/);
  });
});
