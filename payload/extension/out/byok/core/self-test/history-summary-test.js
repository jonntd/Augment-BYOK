"use strict";

const { randomId } = require("../../infra/util");
const shared = require("../augment-chat/shared");
const { REQUEST_NODE_HISTORY_SUMMARY } = require("../augment-protocol");
const { maybeSummarizeAndCompactAugmentChatRequest, deleteHistorySummaryCache } = require("../augment-history-summary/auto");
const { makeBaseAugmentChatRequest } = require("./builders");
const { withTimed } = require("./util");

async function selfTestHistorySummary({ cfg, fallbackProvider, fallbackModel, timeoutMs, abortSignal, log }) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const hs = c.historySummary && typeof c.historySummary === "object" && !Array.isArray(c.historySummary) ? c.historySummary : {};

  const convId = `byok-selftest-history-${randomId()}`;
  const mkEx = (i) => ({
    request_id: `selftest_h_${i}`,
    request_message: `User message ${i}: ` + "x".repeat(2000),
    response_text: `Assistant response ${i}: ` + "y".repeat(2000),
    request_nodes: [],
    structured_request_nodes: [],
    nodes: [],
    response_nodes: [],
    structured_output_nodes: []
  });
  const history = Array.from({ length: 6 }, (_, i) => mkEx(i + 1));

  // 只在内存中强制开启，避免用户必须手动启用 historySummary 才能自检
  const cfg2 = JSON.parse(JSON.stringify(c));
  cfg2.historySummary = {
    ...(hs && typeof hs === "object" ? hs : {}),
    enabled: true,
    triggerOnHistorySizeChars: 2000,
    historyTailSizeCharsToExclude: 0,
    minTailExchanges: 2,
    maxTokens: 256,
    timeoutSeconds: Math.max(5, Math.floor((Number(timeoutMs) || 30000) / 1000)),
    cacheTtlMs: 5 * 60 * 1000
  };

  const req1 = makeBaseAugmentChatRequest({ message: "continue", conversationId: convId, chatHistory: history });
  const req2 = makeBaseAugmentChatRequest({ message: "continue", conversationId: convId, chatHistory: history });

  const run1 = await withTimed(async () => {
    return await maybeSummarizeAndCompactAugmentChatRequest({
      cfg: cfg2,
      req: req1,
      requestedModel: fallbackModel,
      fallbackProvider,
      fallbackModel,
      timeoutMs,
      abortSignal
    });
  });

  const run2 = await withTimed(async () => {
    return await maybeSummarizeAndCompactAugmentChatRequest({
      cfg: cfg2,
      req: req2,
      requestedModel: fallbackModel,
      fallbackProvider,
      fallbackModel,
      timeoutMs,
      abortSignal
    });
  });

  try {
    await deleteHistorySummaryCache(convId);
  } catch {}

  const ok1 = run1.ok && run1.res === true;
  const ok2 = run2.ok && run2.res === true;
  const injected1 = Array.isArray(req1.request_nodes) && req1.request_nodes.some((n) => shared.normalizeNodeType(n) === REQUEST_NODE_HISTORY_SUMMARY);
  const injected2 = Array.isArray(req2.request_nodes) && req2.request_nodes.some((n) => shared.normalizeNodeType(n) === REQUEST_NODE_HISTORY_SUMMARY);

  if (ok1 && ok2 && injected1 && injected2) {
    log(`[historySummary] ok (run1=${run1.ms}ms injected=${injected1} run2=${run2.ms}ms injected=${injected2})`);
    // run2 应该命中 cache（一般更快），但不同环境也可能依旧触发网络；这里只做观察信息
    return { ok: true, ms: run1.ms + run2.ms, detail: `run1=${run1.ms}ms run2=${run2.ms}ms` };
  }

  const detail =
    `run1=${run1.ok ? String(run1.res) : run1.error} injected1=${injected1} ` +
    `run2=${run2.ok ? String(run2.res) : run2.error} injected2=${injected2}`;
  return { ok: false, ms: run1.ms + run2.ms, detail };
}

module.exports = { selfTestHistorySummary };
