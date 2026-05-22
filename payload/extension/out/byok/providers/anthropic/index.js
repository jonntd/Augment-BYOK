"use strict";

const { makeSseJsonIterator } = require("../sse-json");
const { normalizeString } = require("../../infra/util");
const { normalizeUsageInt, makeToolMetaGetter, assertSseResponse } = require("../provider-util");
const { extractErrorMessageFromJson } = require("../request-util");
const { buildToolUseChunks, buildTokenUsageChunk, buildFinalChatChunk } = require("../chat-chunks-util");
const { buildMinimalRetryRequestDefaults, postAnthropicWithFallbacks } = require("./request");
const { stripAnthropicToolBlocksFromMessages, stripAnthropicImageBlocksFromMessages } = require("../../core/anthropic-blocks");
const { extractTextFromAnthropicJson, emitAnthropicJsonAsAugmentChunks } = require("./json-util");
const {
  mapAnthropicStopReasonToAugment,
  rawResponseNode,
  thinkingNode,
  makeBackChatChunk
} = require("../../core/augment-protocol");

function hasAnthropicImageBlocks(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (const msg of list) {
    const blocks = Array.isArray(msg?.content) ? msg.content : [];
    if (blocks.some((b) => b && typeof b === "object" && normalizeString(b.type) === "image")) return true;
  }
  return false;
}

async function anthropicCompleteText({ baseUrl, apiKey, model, system, messages, timeoutMs, abortSignal, extraHeaders, requestDefaults }) {
  const minimalDefaults = buildMinimalRetryRequestDefaults(requestDefaults);
  const resp = await postAnthropicWithFallbacks({
    baseLabel: "Anthropic",
    timeoutMs,
    abortSignal,
    attempts: [
      { labelSuffix: "", request: { baseUrl, apiKey, model, system, messages, tools: [], extraHeaders, requestDefaults, stream: false }, retryHint: "retry with minimal requestDefaults" },
      { labelSuffix: ":minimal-defaults", request: { baseUrl, apiKey, model, system, messages, tools: [], extraHeaders, requestDefaults: minimalDefaults, stream: false } }
    ]
  });

  const json = await resp.json().catch(() => null);
  const out = extractTextFromAnthropicJson(json);
  if (out) return out;

  const types = Array.isArray(json?.content)
    ? json.content
        .map((b) => normalizeString(b?.type) || "unknown")
        .filter(Boolean)
        .slice(0, 10)
        .join(",")
    : "";
  throw new Error(`Anthropic 响应缺少可解析文本（content_types=${types || "n/a"}）`.trim());
}

async function* anthropicStreamTextDeltas({ baseUrl, apiKey, model, system, messages, timeoutMs, abortSignal, extraHeaders, requestDefaults }) {
  const minimalDefaults = buildMinimalRetryRequestDefaults(requestDefaults);
  const resp = await postAnthropicWithFallbacks({
    baseLabel: "Anthropic(stream)",
    timeoutMs,
    abortSignal,
    attempts: [
      { labelSuffix: "", request: { baseUrl, apiKey, model, system, messages, tools: [], extraHeaders, requestDefaults, stream: true }, retryHint: "retry with minimal requestDefaults" },
      { labelSuffix: ":minimal-defaults", request: { baseUrl, apiKey, model, system, messages, tools: [], extraHeaders, requestDefaults: minimalDefaults, stream: true } }
    ]
  });

  const contentType = normalizeString(resp?.headers?.get?.("content-type")).toLowerCase();
  if (contentType.includes("json")) {
    const json = await resp.json().catch(() => null);
    const text = extractTextFromAnthropicJson(json);
    if (text) {
      yield text;
      return;
    }
    throw new Error(`Anthropic(stream) JSON 响应缺少可解析文本（content-type=${contentType || "unknown"}）`.trim());
  }

  await assertSseResponse(resp, { label: "Anthropic(stream)", expectedHint: "请确认 baseUrl 指向 Anthropic /messages SSE" });
  const sse = makeSseJsonIterator(resp);
  let emitted = 0;
  for await (const { json, eventType } of sse.events) {
    if (json && typeof json === "object" && (eventType === "error" || json.error)) {
      const msg = normalizeString(extractErrorMessageFromJson(json)) || "upstream error";
      throw new Error(`Anthropic(stream) upstream error: ${msg}`.trim());
    }
    if (eventType === "message_stop") break;
    if (eventType === "content_block_delta" && json.delta && json.delta.type === "text_delta" && typeof json.delta.text === "string") {
      const t = json.delta.text;
      if (t) { emitted += 1; yield t; }
    }
  }
  if (emitted === 0) {
    throw new Error(
      `Anthropic(stream) 未解析到任何 SSE delta（data_events=${sse.stats.dataEvents}, parsed_chunks=${sse.stats.parsedChunks}）；请检查 baseUrl 是否为 Anthropic SSE`.trim()
    );
  }
}

async function* anthropicChatStreamChunks({ baseUrl, apiKey, model, system, messages, tools, timeoutMs, abortSignal, extraHeaders, requestDefaults, toolMetaByName, supportToolUseStart, nodeIdStart }) {
  const minimalDefaults = buildMinimalRetryRequestDefaults(requestDefaults);
  const hasImageBlocks = hasAnthropicImageBlocks(messages);
  const noImageMessages = stripAnthropicImageBlocksFromMessages(messages);
  const strippedMessages = stripAnthropicToolBlocksFromMessages(messages, { maxToolTextLen: 8000 });
  const strippedNoImageMessages = stripAnthropicImageBlocksFromMessages(strippedMessages);
  const attempts = [
    {
      labelSuffix: "",
      request: { baseUrl, apiKey, model, system, messages, tools, extraHeaders, requestDefaults, stream: true, includeToolChoice: true },
      retryHint: "retry without tool_choice"
    },
    {
      labelSuffix: ":no-tool-choice",
      request: { baseUrl, apiKey, model, system, messages, tools, extraHeaders, requestDefaults, stream: true, includeToolChoice: false },
      retryHint: hasImageBlocks ? "retry without image blocks" : "retry without tools + strip tool blocks"
    }
  ];
  if (hasImageBlocks) {
    attempts.push({
      labelSuffix: ":no-images",
      request: { baseUrl, apiKey, model, system, messages: noImageMessages, tools, extraHeaders, requestDefaults, stream: true, includeToolChoice: false },
      retryHint: "retry without tools + strip tool blocks"
    });
  }
  attempts.push({
    labelSuffix: ":no-tools",
    request: { baseUrl, apiKey, model, system, messages: strippedNoImageMessages, tools: [], extraHeaders, requestDefaults: minimalDefaults, stream: true }
  });

  const resp = await postAnthropicWithFallbacks({
    baseLabel: "Anthropic(chat-stream)",
    timeoutMs,
    abortSignal,
    attempts
  });

  const contentType = normalizeString(resp?.headers?.get?.("content-type")).toLowerCase();
  if (contentType.includes("json")) {
    const json = await resp.json().catch(() => null);
    yield* emitAnthropicJsonAsAugmentChunks(json, { toolMetaByName, supportToolUseStart });
    return;
  }

  await assertSseResponse(resp, { label: "Anthropic(chat-stream)", expectedHint: "请确认 baseUrl 指向 Anthropic /messages SSE" });

  const getToolMeta = makeToolMetaGetter(toolMetaByName);

  let nodeId = Number(nodeIdStart);
  if (!Number.isFinite(nodeId) || nodeId < 0) nodeId = 0;
  let stopReason = null;
  let stopReasonSeen = false;
  let sawToolUse = false;
  let usageInputTokens = null;
  let usageOutputTokens = null;
  let usageCacheReadInputTokens = null;
  let usageCacheCreationInputTokens = null;
  let currentBlockType = "";
  let toolUseId = "";
  let toolName = "";
  let toolInputJson = "";
  let thinkingBuf = "";
  let emittedChunks = 0;
  let sawMessageStop = false;

  const sse = makeSseJsonIterator(resp);
  for await (const { json, eventType } of sse.events) {

    const usage = (json?.message && typeof json.message === "object" ? json.message.usage : null) || json?.usage;
    if (usage && typeof usage === "object") {
      const inputTokens = normalizeUsageInt(usage.input_tokens);
      const outputTokens = normalizeUsageInt(usage.output_tokens);
      const cacheReadInputTokens = normalizeUsageInt(usage.cache_read_input_tokens);
      const cacheCreationInputTokens = normalizeUsageInt(usage.cache_creation_input_tokens);
      if (inputTokens != null) usageInputTokens = inputTokens;
      if (outputTokens != null) usageOutputTokens = outputTokens;
      if (cacheReadInputTokens != null) usageCacheReadInputTokens = cacheReadInputTokens;
      if (cacheCreationInputTokens != null) usageCacheCreationInputTokens = cacheCreationInputTokens;
    }

    if (eventType === "content_block_start") {
      const block = json?.content_block && typeof json.content_block === "object" ? json.content_block : null;
      currentBlockType = normalizeString(block?.type);
      if (currentBlockType === "tool_use") {
        toolUseId = normalizeString(block?.id);
        toolName = normalizeString(block?.name);
        toolInputJson = "";
      } else if (currentBlockType === "thinking") {
        thinkingBuf = "";
      }
      continue;
    }

    if (eventType === "content_block_delta") {
      const delta = json?.delta && typeof json.delta === "object" ? json.delta : null;
      const dt = normalizeString(delta?.type);
      if (dt === "text_delta" && typeof delta?.text === "string" && delta.text) {
        const t = delta.text;
        nodeId += 1;
        emittedChunks += 1;
        yield makeBackChatChunk({ text: t, nodes: [rawResponseNode({ id: nodeId, content: t })] });
      } else if (dt === "input_json_delta" && typeof delta?.partial_json === "string" && delta.partial_json) {
        toolInputJson += delta.partial_json;
      } else if (dt === "thinking_delta" && typeof delta?.thinking === "string" && delta.thinking) {
        thinkingBuf += delta.thinking;
      }
      continue;
    }

    if (eventType === "content_block_stop") {
      if (currentBlockType === "thinking") {
        const summary = normalizeString(thinkingBuf);
        if (summary) {
          nodeId += 1;
          emittedChunks += 1;
          yield makeBackChatChunk({ text: "", nodes: [thinkingNode({ id: nodeId, summary })] });
        }
        thinkingBuf = "";
      }
      if (currentBlockType === "tool_use") {
        const name = normalizeString(toolName);
        if (name) {
          const inputJson = normalizeString(toolInputJson) || "{}";
          const built = buildToolUseChunks({
            nodeId,
            toolUseId: normalizeString(toolUseId),
            toolName: name,
            inputJson,
            meta: getToolMeta(name),
            supportToolUseStart
          });
          nodeId = built.nodeId;
          emittedChunks += built.chunks.length;
          if (built.chunks.length) sawToolUse = true;
          for (const c of built.chunks) yield c;
        }
        toolUseId = "";
        toolName = "";
        toolInputJson = "";
      }
      currentBlockType = "";
      continue;
    }

    if (eventType === "message_delta") {
      const delta = json?.delta && typeof json.delta === "object" ? json.delta : null;
      const sr = normalizeString(delta?.stop_reason);
      if (sr) {
        stopReasonSeen = true;
        stopReason = mapAnthropicStopReasonToAugment(sr);
      }
      continue;
    }

    if (eventType === "message_stop") { sawMessageStop = true; break; }
    if (eventType === "error") {
      const msg = normalizeString(extractErrorMessageFromJson(json)) || "upstream error event";
      throw new Error(`Anthropic(chat-stream) upstream error event: ${msg}`.trim());
    }
  }

  if (currentBlockType === "thinking") {
    const summary = normalizeString(thinkingBuf);
    if (summary) {
      nodeId += 1;
      emittedChunks += 1;
      yield makeBackChatChunk({ text: "", nodes: [thinkingNode({ id: nodeId, summary })] });
    }
  }

  const hasUsage = usageInputTokens != null || usageOutputTokens != null || usageCacheReadInputTokens != null || usageCacheCreationInputTokens != null;
  if (emittedChunks === 0 && !hasUsage && !sawToolUse) {
    throw new Error(
      `Anthropic(chat-stream) 未解析到任何上游 SSE 内容（data_events=${sse.stats.dataEvents}, parsed_chunks=${sse.stats.parsedChunks}）；请检查 baseUrl 是否为 Anthropic /messages SSE`
    );
  }

  const usageBuilt = buildTokenUsageChunk({
    nodeId,
    inputTokens: usageInputTokens,
    outputTokens: usageOutputTokens,
    cacheReadInputTokens: usageCacheReadInputTokens,
    cacheCreationInputTokens: usageCacheCreationInputTokens
  });
  nodeId = usageBuilt.nodeId;
  if (usageBuilt.chunk) yield usageBuilt.chunk;

  const final = buildFinalChatChunk({ nodeId, stopReasonSeen, stopReason, sawToolUse, endedCleanly: sawMessageStop });
  yield final.chunk;
}

module.exports = { anthropicCompleteText, anthropicStreamTextDeltas, anthropicChatStreamChunks };
