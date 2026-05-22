const test = require("node:test");
const assert = require("node:assert/strict");

const { defaultConfig } = require("../payload/extension/out/byok/config/default-config");
const {
  maybeSummarizeAndCompactAugmentChatRequest,
  setHistorySummaryStorage
} = require("../payload/extension/out/byok/core/augment-history-summary/auto");
const { buildOpenAiMessages } = require("../payload/extension/out/byok/core/augment-chat/openai");
const { REQUEST_NODE_HISTORY_SUMMARY } = require("../payload/extension/out/byok/core/augment-protocol");
const { makeBaseAugmentChatRequest } = require("../payload/extension/out/byok/core/self-test/builders");

function ex({ id, msg, resp, requestNodes } = {}) {
  return {
    request_id: typeof id === "string" ? id : "",
    request_message: typeof msg === "string" ? msg : "",
    response_text: typeof resp === "string" ? resp : "",
    request_nodes: Array.isArray(requestNodes) ? requestNodes : [],
    structured_request_nodes: [],
    nodes: [],
    response_nodes: [],
    structured_output_nodes: []
  };
}

function makeExistingSummaryNode() {
  return {
    type: REQUEST_NODE_HISTORY_SUMMARY,
    history_summary_node: {
      summary_text: "old summary",
      summarization_request_id: "old_sid",
      history_beginning_dropped_num_exchanges: 1,
      history_middle_abridged_text: "",
      history_end: [],
      message_template: "{summary}\n{middle_part_abridged}\n{end_part_full}"
    }
  };
}

function jsonClone(v) {
  return JSON.parse(JSON.stringify(v));
}

async function withFetchStub(handler, fn) {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body || "{}"));
    calls.push({ url: String(url), init, body });
    return await handler({ url: String(url), init, body, calls });
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = previous;
  }
}

test("historySummary: still injects when trigger comes from current message bytes", async () => {
  const cfg = defaultConfig();
  cfg.historySummary.enabled = true;
  cfg.historySummary.triggerStrategy = "chars";
  cfg.historySummary.triggerOnHistorySizeChars = 120;
  cfg.historySummary.historyTailSizeCharsToExclude = 0;
  cfg.historySummary.minTailExchanges = 2;
  cfg.historySummary.providerId = "";
  cfg.historySummary.model = "";

  const history = [
    ex({ id: "r1", msg: "u1", resp: "a1" }),
    ex({ id: "r2", msg: "u2", resp: "a2" }),
    ex({ id: "r3", msg: "u3", resp: "a3" })
  ];
  const req = makeBaseAugmentChatRequest({
    message: "m".repeat(200),
    conversationId: "conv-trigger-by-message",
    chatHistory: history
  });

  const injected = await maybeSummarizeAndCompactAugmentChatRequest({
    cfg,
    req,
    requestedModel: "byok:openai:gpt-4o-mini",
    fallbackProvider: null,
    fallbackModel: "",
    timeoutMs: 1000,
    abortSignal: null
  });

  assert.equal(injected, true);
  assert.ok(req.request_nodes.some((n) => n && n.type === REQUEST_NODE_HISTORY_SUMMARY));
});

test("historySummary: auto strategy uses dialogue fallbackModel window when requestedModel is empty", async () => {
  const cfg = defaultConfig();
  cfg.historySummary.enabled = true;
  cfg.historySummary.triggerStrategy = "auto";
  cfg.historySummary.triggerOnHistorySizeChars = 9999999;
  cfg.historySummary.triggerOnContextRatio = 0.7;
  cfg.historySummary.targetContextRatio = 0.55;
  cfg.historySummary.contextWindowTokensOverrides = { "gpt-4o": 100 };
  cfg.historySummary.historyTailSizeCharsToExclude = 0;
  cfg.historySummary.minTailExchanges = 2;
  cfg.historySummary.providerId = "";
  cfg.historySummary.model = "";

  const long = "x".repeat(200);
  const history = [
    ex({ id: "r1", msg: long, resp: long }),
    ex({ id: "r2", msg: long, resp: long }),
    ex({ id: "r3", msg: long, resp: long }),
    ex({ id: "r4", msg: long, resp: long })
  ];
  const req = makeBaseAugmentChatRequest({
    message: "continue",
    conversationId: "conv-auto-fallback-model",
    chatHistory: history
  });

  const injected = await maybeSummarizeAndCompactAugmentChatRequest({
    cfg,
    req,
    requestedModel: "",
    fallbackProvider: null,
    fallbackModel: "gpt-4o-mini",
    timeoutMs: 1000,
    abortSignal: null
  });

  assert.equal(injected, true);
  assert.ok(req.request_nodes.some((n) => n && n.type === REQUEST_NODE_HISTORY_SUMMARY));
});

test("historySummary: can refresh even when chat_history already contains summary exchange", async () => {
  const cfg = defaultConfig();
  cfg.historySummary.enabled = true;
  cfg.historySummary.triggerStrategy = "chars";
  cfg.historySummary.triggerOnHistorySizeChars = 1;
  cfg.historySummary.historyTailSizeCharsToExclude = 0;
  cfg.historySummary.minTailExchanges = 2;
  cfg.historySummary.providerId = "";
  cfg.historySummary.model = "";

  const history = [
    ex({ id: "r0", msg: "summary exchange", resp: "", requestNodes: [makeExistingSummaryNode()] }),
    ex({ id: "r1", msg: "u1", resp: "a1" }),
    ex({ id: "r2", msg: "u2", resp: "a2" }),
    ex({ id: "r3", msg: "u3", resp: "a3" })
  ];
  const req = makeBaseAugmentChatRequest({
    message: "continue",
    conversationId: "conv-refresh-existing-summary",
    chatHistory: history
  });

  const injected = await maybeSummarizeAndCompactAugmentChatRequest({
    cfg,
    req,
    requestedModel: "byok:openai:gpt-4o-mini",
    fallbackProvider: null,
    fallbackModel: "",
    timeoutMs: 1000,
    abortSignal: null
  });

  assert.equal(injected, true);
  const addedSummaryNodes = req.request_nodes.filter((n) => n && n.type === REQUEST_NODE_HISTORY_SUMMARY);
  assert.equal(addedSummaryNodes.length, 1);
});

test("historySummary: provider request is smaller after compaction and excludes dropped raw head", async () => {
  const cfg = defaultConfig();
  cfg.historySummary.enabled = true;
  cfg.historySummary.triggerStrategy = "chars";
  cfg.historySummary.triggerOnHistorySizeChars = 1;
  cfg.historySummary.historyTailSizeCharsToExclude = 200;
  cfg.historySummary.minTailExchanges = 2;
  cfg.historySummary.providerId = "";
  cfg.historySummary.model = "";
  cfg.historySummary.abridgedHistoryParams = {
    ...cfg.historySummary.abridgedHistoryParams,
    totalCharsLimit: 1200,
    userMessageCharsLimit: 80,
    agentResponseCharsLimit: 80
  };

  const huge = "x".repeat(5000);
  const history = Array.from({ length: 10 }, (_, i) =>
    ex({
      id: `r${i}`,
      msg: i === 0 ? `EARLY_RAW_HEAD_ONLY ${huge}` : `u${i} ${huge}`,
      resp: i === 9 ? `LATEST_TAIL_ONLY a${i} ${huge}` : `a${i} ${huge}`
    })
  );
  const req = makeBaseAugmentChatRequest({
    message: "continue from compacted context",
    conversationId: "conv-provider-compact",
    chatHistory: jsonClone(history)
  });
  const beforeReq = makeBaseAugmentChatRequest({
    message: req.message,
    conversationId: req.conversation_id,
    chatHistory: jsonClone(history)
  });
  const beforePayload = JSON.stringify(buildOpenAiMessages(beforeReq));

  const injected = await maybeSummarizeAndCompactAugmentChatRequest({
    cfg,
    req,
    requestedModel: "byok:openai:gpt-5.2",
    fallbackProvider: null,
    fallbackModel: "",
    timeoutMs: 1000,
    abortSignal: null
  });

  assert.equal(injected, true);
  assert.ok(req.request_nodes.some((n) => n && n.type === REQUEST_NODE_HISTORY_SUMMARY));

  const afterPayload = JSON.stringify(buildOpenAiMessages(req));
  assert.ok(afterPayload.length < beforePayload.length / 4, `expected compaction: before=${beforePayload.length} after=${afterPayload.length}`);
  assert.match(afterPayload, /Context was compacted without an LLM summary/);
  assert.match(afterPayload, /Prefer the latest full tail exchanges/);
  assert.match(afterPayload, /LATEST_TAIL_ONLY/);
  assert.match(afterPayload, /continue from compacted context/);
  assert.doesNotMatch(afterPayload, /EARLY_RAW_HEAD_ONLY/);
});

test("historySummary: repeated long conversation reuses cached LLM summary", async () => {
  setHistorySummaryStorage(null);

  const cfg = defaultConfig();
  cfg.historySummary.enabled = true;
  cfg.historySummary.triggerStrategy = "chars";
  cfg.historySummary.triggerOnHistorySizeChars = 1;
  cfg.historySummary.historyTailSizeCharsToExclude = 0;
  cfg.historySummary.minTailExchanges = 2;
  cfg.historySummary.providerId = "";
  cfg.historySummary.model = "";
  cfg.historySummary.cacheTtlMs = 5 * 60 * 1000;
  cfg.historySummary.abridgedHistoryParams = {
    ...cfg.historySummary.abridgedHistoryParams,
    totalCharsLimit: 1000,
    userMessageCharsLimit: 80,
    agentResponseCharsLimit: 80
  };

  const huge = "x".repeat(2000);
  const history = Array.from({ length: 6 }, (_, i) =>
    ex({ id: `r${i}`, msg: `user-${i} ${huge}`, resp: i === 5 ? `LATEST_TAIL_MARKER ${huge}` : `assistant-${i} ${huge}` })
  );
  const fallbackProvider = {
    id: "summary-openai",
    type: "openai_compatible",
    baseUrl: "https://summary.example/v1",
    apiKey: "sk-summary-test",
    headers: {},
    requestDefaults: {}
  };

  try {
    await withFetchStub(
      async ({ body }) => {
        assert.equal(body.stream, false);
        assert.equal(body.model, "gpt-summary");
        assert.ok(Array.isArray(body.messages));
        return new Response(JSON.stringify({ choices: [{ message: { content: "LLM SUMMARY STABLE" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      },
      async (calls) => {
        const makeReq = () =>
          makeBaseAugmentChatRequest({
            message: "continue from cached summary",
            conversationId: "conv-history-summary-cache-hit",
            chatHistory: jsonClone(history)
          });

        const req1 = makeReq();
        const injected1 = await maybeSummarizeAndCompactAugmentChatRequest({
          cfg,
          req: req1,
          requestedModel: "byok:openai:gpt-5.2",
          fallbackProvider,
          fallbackModel: "gpt-summary",
          timeoutMs: 1000,
          abortSignal: null
        });

        const node1 = req1.request_nodes.find((n) => n && n.type === REQUEST_NODE_HISTORY_SUMMARY);
        assert.equal(injected1, true);
        assert.ok(node1);
        assert.equal(node1.history_summary_node.summary_text, "LLM SUMMARY STABLE");
        assert.match(node1.history_summary_node.summarization_request_id, /^byok_history_summary_/);
        assert.equal(calls.length, 1);

        const req2 = makeReq();
        const injected2 = await maybeSummarizeAndCompactAugmentChatRequest({
          cfg,
          req: req2,
          requestedModel: "byok:openai:gpt-5.2",
          fallbackProvider,
          fallbackModel: "gpt-summary",
          timeoutMs: 1000,
          abortSignal: null
        });

        const node2 = req2.request_nodes.find((n) => n && n.type === REQUEST_NODE_HISTORY_SUMMARY);
        assert.equal(injected2, true);
        assert.ok(node2);
        assert.equal(calls.length, 1, "second identical compaction should use cached summary instead of another provider call");
        assert.equal(node2.history_summary_node.summary_text, node1.history_summary_node.summary_text);
        assert.equal(node2.history_summary_node.summarization_request_id, node1.history_summary_node.summarization_request_id);

        const afterPayload = JSON.stringify(buildOpenAiMessages(req2));
        assert.match(afterPayload, /LLM SUMMARY STABLE/);
        assert.match(afterPayload, /LATEST_TAIL_MARKER/);
        assert.match(afterPayload, /continue from cached summary/);
      }
    );
  } finally {
    setHistorySummaryStorage(null);
  }
});
