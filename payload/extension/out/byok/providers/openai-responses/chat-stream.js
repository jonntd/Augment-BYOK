"use strict";

const { makeSseJsonIterator } = require("../sse-json");
const { normalizeString } = require("../../infra/util");
const { normalizeUsageInt, applyParallelToolCallsPolicy, makeToolMetaGetter, assertSseResponse } = require("../provider-util");
const { buildToolUseChunks, buildTokenUsageChunk, buildFinalChatChunk } = require("../chat-chunks-util");
const { createOutputTextTracker } = require("./output-text-tracker");
const {
  extractOpenAiResponsesJsonError,
  extractToolCallsFromResponseOutput,
  extractReasoningSummaryFromResponseOutput,
  extractStopReasonFromResponsesObject,
  extractTextPartsFromResponsesJson,
  extractTextFromResponsesJson,
  throwIfOpenAiResponsesJsonError,
  emitOpenAiResponsesJsonAsAugmentChunks
} = require("./json-util");
const { fetchOpenAiResponsesWithFallbacks } = require("./fetch");
const { rawResponseNode, thinkingNode, makeBackChatChunk } = require("../../core/augment-protocol");

async function* openAiResponsesChatStreamChunks({
  baseUrl,
  apiKey,
  model,
  instructions,
  input,
  tools,
  timeoutMs,
  abortSignal,
  extraHeaders,
  requestDefaults,
  toolMetaByName,
  supportToolUseStart,
  supportParallelToolUse,
  nodeIdStart
}) {
  const getToolMeta = makeToolMetaGetter(toolMetaByName);

  const hasTools = Array.isArray(tools) && tools.length > 0;
  const rd = applyParallelToolCallsPolicy(requestDefaults, { hasTools, supportParallelToolUse });

  const resp = await fetchOpenAiResponsesWithFallbacks({
    baseUrl,
    apiKey,
    model,
    instructions,
    input,
    tools,
    extraHeaders,
    requestDefaults: rd,
    stream: true,
    timeoutMs,
    abortSignal,
    label: "OpenAI(responses-chat-stream)"
  });
  const contentType = normalizeString(resp?.headers?.get?.("content-type")).toLowerCase();
  if (contentType.includes("json")) {
    const json = await resp.json().catch(() => null);
    yield* emitOpenAiResponsesJsonAsAugmentChunks(json, { toolMetaByName, supportToolUseStart });
    return;
  }
  await assertSseResponse(resp, { label: "OpenAI(responses-chat-stream)", expectedHint: "请确认 baseUrl 指向 OpenAI /responses SSE" });

  let nodeId = Number(nodeIdStart);
  if (!Number.isFinite(nodeId) || nodeId < 0) nodeId = 0;
  let sawToolUse = false;
  let stopReason = null;
  let stopReasonSeen = false;
  let usageInputTokens = null;
  let usageOutputTokens = null;
  let usageCacheReadInputTokens = null;
  let thinkingBuf = "";
  let emittedChunks = 0;
  let finalResponse = null;
  const toolCallsByOutputIndex = new Map(); // output_index -> {call_id,name,arguments}
  const textTracker = createOutputTextTracker();

  function ensureToolCallRecord(outputIndex) {
    const idx = Number(outputIndex);
    const k = Number.isFinite(idx) && idx >= 0 ? Math.floor(idx) : 0;
    if (!toolCallsByOutputIndex.has(k)) toolCallsByOutputIndex.set(k, { call_id: "", name: "", arguments: "" });
    return toolCallsByOutputIndex.get(k);
  }

  const sse = makeSseJsonIterator(resp, { doneData: "[DONE]" });
  for await (const { json, eventType } of sse.events) {
    if (!eventType) continue;
    throwIfOpenAiResponsesJsonError(json?.response && typeof json.response === "object" ? json.response : json, "OpenAI(responses-chat-stream)");

    if (eventType === "response.output_item.added") {
      const item = json?.item && typeof json.item === "object" ? json.item : null;
      const outputIndex = Number(json?.output_index);
      if (item && item.type === "function_call" && Number.isFinite(outputIndex) && outputIndex >= 0) {
        const rec = ensureToolCallRecord(outputIndex);
        const call_id = normalizeString(item.call_id);
        const name = normalizeString(item.name);
        const args = typeof item.arguments === "string" ? item.arguments : "";
        if (call_id) rec.call_id = call_id;
        if (name) rec.name = name;
        if (args) rec.arguments = normalizeString(args) || rec.arguments || "";
      }
      continue;
    }

    if (eventType === "response.output_item.done") {
      const item = json?.item && typeof json.item === "object" ? json.item : null;
      const outputIndex = Number(json?.output_index);
      if (item && item.type === "function_call" && Number.isFinite(outputIndex) && outputIndex >= 0) {
        const rec = ensureToolCallRecord(outputIndex);
        const call_id = normalizeString(item.call_id);
        const name = normalizeString(item.name);
        const args = typeof item.arguments === "string" ? item.arguments : "";
        if (call_id) rec.call_id = call_id;
        if (name) rec.name = name;
        if (args) rec.arguments = normalizeString(args) || rec.arguments || "";
      }
      if (item && item.type === "reasoning" && !thinkingBuf) {
        const summary = Array.isArray(item.summary) ? item.summary : [];
        const parts = [];
        for (const s of summary) {
          if (!s || typeof s !== "object") continue;
          if (s.type !== "summary_text") continue;
          const t = normalizeString(s.text);
          if (t) parts.push(t);
        }
        if (parts.length) thinkingBuf = parts.join("\n").trim();
      }
      continue;
    }

    if (eventType === "response.function_call_arguments.delta") {
      const outputIndex = Number(json?.output_index);
      const delta = typeof json?.delta === "string" ? json.delta : "";
      const call_id = normalizeString(json?.call_id ?? json?.callId ?? json?.callID);
      const name = normalizeString(json?.name);
      if (Number.isFinite(outputIndex) && (delta || call_id || name)) {
        const rec = ensureToolCallRecord(outputIndex);
        if (call_id) rec.call_id = call_id;
        if (name) rec.name = name;
        if (delta) rec.arguments += delta;
      }
      continue;
    }

    if (eventType === "response.function_call_arguments.done") {
      const outputIndex = Number(json?.output_index);
      const args = typeof json?.arguments === "string" ? json.arguments : "";
      const call_id = normalizeString(json?.call_id ?? json?.callId ?? json?.callID);
      const name = normalizeString(json?.name);
      if (Number.isFinite(outputIndex) && (args || call_id || name)) {
        const rec = ensureToolCallRecord(outputIndex);
        if (call_id) rec.call_id = call_id;
        if (name) rec.name = name;
        if (args) rec.arguments = args;
      }
      continue;
    }

    if (eventType === "response.output_text.delta" && typeof json?.delta === "string" && json.delta) {
      const idx = json?.output_index ?? json?.outputIndex ?? json?.index;
      const t = json.delta;
      textTracker.pushDelta(idx, t);
      nodeId += 1;
      emittedChunks += 1;
      yield makeBackChatChunk({ text: t, nodes: [rawResponseNode({ id: nodeId, content: t })] });
      continue;
    }

    if (eventType === "response.output_text.done") {
      const idx = json?.output_index ?? json?.outputIndex ?? json?.index;
      const full = typeof json?.text === "string" ? json.text : "";
      const rest = textTracker.applyFinalText(idx, full).rest;
      if (rest) {
        nodeId += 1;
        emittedChunks += 1;
        yield makeBackChatChunk({ text: rest, nodes: [rawResponseNode({ id: nodeId, content: rest })] });
      }
      continue;
    }

    if (eventType === "response.reasoning_summary_text.delta" && typeof json?.delta === "string" && json.delta) {
      thinkingBuf += json.delta;
      continue;
    }

    if (eventType === "response.reasoning_summary_text.done") {
      const full = normalizeString(json?.text);
      if (full) {
        if (!thinkingBuf) thinkingBuf = full;
        else if (full.startsWith(thinkingBuf)) thinkingBuf = full;
        else if (!thinkingBuf.includes(full)) thinkingBuf += (thinkingBuf ? "\n" : "") + full;
      }
      continue;
    }

    if (eventType === "response.reasoning_text.delta" && typeof json?.delta === "string" && json.delta) {
      thinkingBuf += json.delta;
      continue;
    }

    if (eventType === "response.incomplete") {
      const r = json?.response && typeof json.response === "object" ? json.response : null;
      if (r) finalResponse = r;
      const stop = extractStopReasonFromResponsesObject(r || json);
      if (stop.stopReasonSeen) {
        stopReasonSeen = true;
        stopReason = stop.stopReason;
      }
      continue;
    }

    if (eventType === "response.completed" && json?.response && typeof json.response === "object") {
      finalResponse = json.response;
      const stop = extractStopReasonFromResponsesObject(json.response);
      if (stop.stopReasonSeen) {
        stopReasonSeen = true;
        stopReason = stop.stopReason;
      }
      for (const part of extractTextPartsFromResponsesJson(json.response)) {
        const rest = textTracker.applyFinalText(part.outputIndex, part.text).rest;
        if (rest) {
          nodeId += 1;
          emittedChunks += 1;
          yield makeBackChatChunk({ text: rest, nodes: [rawResponseNode({ id: nodeId, content: rest })] });
        }
      }
      const usage = json.response?.usage && typeof json.response.usage === "object" ? json.response.usage : null;
      if (usage) {
        const inputTokens = normalizeUsageInt(usage.input_tokens);
        const outputTokens = normalizeUsageInt(usage.output_tokens);
        const cached = normalizeUsageInt(usage?.input_tokens_details?.cached_tokens);
        if (inputTokens != null) usageInputTokens = inputTokens;
        if (outputTokens != null) usageOutputTokens = outputTokens;
        if (cached != null) usageCacheReadInputTokens = cached;
      }
      continue;
    }

    if (eventType === "response.failed") {
      const msg = extractOpenAiResponsesJsonError(json) || "upstream failed";
      throw new Error(`OpenAI(responses-chat-stream) upstream failed: ${msg}`.trim());
    }

    if (eventType === "response.error" || eventType === "error") {
      const msg = extractOpenAiResponsesJsonError(json) || "upstream error event";
      throw new Error(`OpenAI(responses-chat-stream) upstream error event: ${msg}`.trim());
    }
  }

  let toolCalls = [];
  let reasoningSummary = "";
  let finalText = "";
  if (finalResponse && typeof finalResponse === "object") {
    const out = Array.isArray(finalResponse.output) ? finalResponse.output : [];
    toolCalls = extractToolCallsFromResponseOutput(out);
    reasoningSummary = extractReasoningSummaryFromResponseOutput(out);
    const u = finalResponse?.usage && typeof finalResponse.usage === "object" ? finalResponse.usage : null;
    if (u) {
      const inputTokens = normalizeUsageInt(u.input_tokens);
      const outputTokens = normalizeUsageInt(u.output_tokens);
      const cached = normalizeUsageInt(u?.input_tokens_details?.cached_tokens);
      if (inputTokens != null) usageInputTokens = inputTokens;
      if (outputTokens != null) usageOutputTokens = outputTokens;
      if (cached != null) usageCacheReadInputTokens = cached;
    }
    finalText = extractTextFromResponsesJson(finalResponse);
  } else {
    toolCalls = Array.from(toolCallsByOutputIndex.entries())
      .sort((a, b) => a[0] - b[0])
      .map((x) => x[1])
      .filter((tc) => tc && typeof tc === "object");
  }

  if (reasoningSummary) thinkingBuf = reasoningSummary;

  if (finalText) {
    for (const part of extractTextPartsFromResponsesJson(finalResponse)) {
      const rest = textTracker.applyFinalText(part.outputIndex, part.text).rest;
      if (rest) {
        nodeId += 1;
        emittedChunks += 1;
        yield makeBackChatChunk({ text: rest, nodes: [rawResponseNode({ id: nodeId, content: rest })] });
      }
    }
  }

  if (thinkingBuf) {
    nodeId += 1;
    yield makeBackChatChunk({ text: "", nodes: [thinkingNode({ id: nodeId, summary: thinkingBuf })] });
  }

  for (const tc of toolCalls) {
    const toolName = normalizeString(tc?.name);
    if (!toolName) continue;
    let toolUseId = normalizeString(tc?.call_id);
    if (!toolUseId) toolUseId = `call_${nodeId + 1}`;
    const inputJson = normalizeString(tc?.arguments) || "{}";
    const built = buildToolUseChunks({ nodeId, toolUseId, toolName, inputJson, meta: getToolMeta(toolName), supportToolUseStart });
    nodeId = built.nodeId;
    if (built.chunks.length) sawToolUse = true;
    for (const c of built.chunks) yield c;
  }

  const usageBuilt = buildTokenUsageChunk({
    nodeId,
    inputTokens: usageInputTokens,
    outputTokens: usageOutputTokens,
    cacheReadInputTokens: usageCacheReadInputTokens
  });
  nodeId = usageBuilt.nodeId;
  const hasUsage = usageBuilt.chunk != null;
  if (usageBuilt.chunk) yield usageBuilt.chunk;

  const endedCleanly = Boolean(sse.stats.doneSeen) || stopReasonSeen === true || Boolean(finalResponse);
  const final = buildFinalChatChunk({
    nodeId,
    stopReasonSeen,
    stopReason,
    sawToolUse,
    endedCleanly
  });
  yield final.chunk;

  const emittedAny = emittedChunks > 0 || hasUsage || toolCalls.length > 0 || Boolean(thinkingBuf);
  if (!emittedAny) {
    throw new Error(
      `OpenAI(responses-chat-stream) 未解析到任何上游 SSE 内容（data_events=${sse.stats.dataEvents}, parsed_chunks=${sse.stats.parsedChunks}）；请检查 baseUrl 是否为 OpenAI /responses SSE`
    );
  }
}

module.exports = { openAiResponsesChatStreamChunks };
