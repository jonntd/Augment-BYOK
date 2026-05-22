"use strict";

const { normalizeString } = require("../../infra/util");
const { normalizeUsageInt, makeToolMetaGetter } = require("../provider-util");
const { extractErrorMessageFromJson } = require("../request-util");
const { buildToolUseChunks, buildTokenUsageChunk, buildFinalChatChunk } = require("../chat-chunks-util");
const {
  STOP_REASON_UNSPECIFIED,
  STOP_REASON_MAX_TOKENS,
  STOP_REASON_SAFETY,
  rawResponseNode,
  thinkingNode,
  makeBackChatChunk
} = require("../../core/augment-protocol");

function extractToolCallsFromResponseOutput(output) {
  const list = Array.isArray(output) ? output : [];
  const out = [];
  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    if (it.type !== "function_call") continue;
    const call_id = normalizeString(it.call_id);
    const name = normalizeString(it.name);
    const args = typeof it.arguments === "string" ? it.arguments : "";
    if (!call_id || !name) continue;
    out.push({ call_id, name, arguments: normalizeString(args) || "{}" });
  }
  return out;
}

function extractReasoningSummaryFromResponseOutput(output) {
  const list = Array.isArray(output) ? output : [];
  const parts = [];
  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    if (it.type !== "reasoning") continue;
    const summary = Array.isArray(it.summary) ? it.summary : [];
    for (const s of summary) {
      if (!s || typeof s !== "object") continue;
      if (s.type !== "summary_text") continue;
      const text = normalizeString(s.text);
      if (text) parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

function pickResponseObject(json) {
  const obj = json && typeof json === "object" ? json : null;
  const resp = obj?.response && typeof obj.response === "object" ? obj.response : null;
  return resp || obj;
}

function extractOpenAiResponsesJsonError(json) {
  const obj = pickResponseObject(json);
  if (!obj || typeof obj !== "object") return "";
  const status = normalizeString(obj.status).toLowerCase();
  const hasErrorShape = Boolean(obj.error) || normalizeString(obj.type).toLowerCase() === "error";
  if (!hasErrorShape && status !== "failed" && status !== "error") return "";
  return normalizeString(extractErrorMessageFromJson(obj)) || status || "upstream error";
}

function throwIfOpenAiResponsesJsonError(json, label) {
  const msg = extractOpenAiResponsesJsonError(json);
  if (!msg) return;
  throw new Error(`${normalizeString(label) || "OpenAI(responses)"} upstream error: ${msg}`.trim());
}

function mapResponsesIncompleteReasonToAugment(reason) {
  const r = normalizeString(reason).toLowerCase();
  if (r === "max_output_tokens" || r === "max_tokens" || r === "length") return STOP_REASON_MAX_TOKENS;
  if (r === "content_filter" || r === "contentfilter" || r === "safety") return STOP_REASON_SAFETY;
  return STOP_REASON_UNSPECIFIED;
}

function extractStopReasonFromResponsesObject(obj) {
  const resp = obj && typeof obj === "object" ? obj : null;
  if (!resp) return { stopReasonSeen: false, stopReason: null };

  const status = normalizeString(resp.status).toLowerCase();
  const details =
    (resp.incomplete_details && typeof resp.incomplete_details === "object" ? resp.incomplete_details : null) ||
    (resp.incompleteDetails && typeof resp.incompleteDetails === "object" ? resp.incompleteDetails : null);
  const reason = normalizeString(details?.reason);

  if (status !== "incomplete" && !reason) return { stopReasonSeen: false, stopReason: null };
  return { stopReasonSeen: true, stopReason: mapResponsesIncompleteReasonToAugment(reason) };
}

function extractTextPartsFromResponsesJson(json) {
  const obj = pickResponseObject(json);
  const output = Array.isArray(obj?.output) ? obj.output : [];
  const out = [];
  for (let i = 0; i < output.length; i++) {
    const it = output[i];
    if (!it || typeof it !== "object") continue;
    const parts = [];
    if (it.type === "message" && it.role === "assistant") {
      const content = it.content;
      if (typeof content === "string" && content.trim()) {
        parts.push(content);
      } else {
        const blocks = Array.isArray(content) ? content : [];
        for (const b of blocks) {
          if (!b || typeof b !== "object") continue;
          if ((b.type === "output_text" || b.type === "text") && typeof b.text === "string" && b.text) parts.push(b.text);
        }
      }
    } else if ((it.type === "output_text" || it.type === "text") && typeof it.text === "string" && it.text) {
      parts.push(it.text);
    }
    const text = parts.join("");
    if (normalizeString(text)) out.push({ outputIndex: i, text });
  }
  if (out.length) return out;

  const direct = normalizeString(obj?.output_text ?? obj?.outputText ?? obj?.text);
  if (direct) return [{ text: direct }];
  return out;
}

function extractTextFromResponsesJson(json) {
  return extractTextPartsFromResponsesJson(json).map((p) => p.text).join("").trim();
}

async function* emitOpenAiResponsesJsonAsAugmentChunks(json, { toolMetaByName, supportToolUseStart } = {}) {
  const obj = pickResponseObject(json);
  if (!obj || typeof obj !== "object") throw new Error("OpenAI(responses-chat-stream) 响应不是有效 JSON");
  throwIfOpenAiResponsesJsonError(obj, "OpenAI(responses-chat-stream)");

  const getToolMeta = makeToolMetaGetter(toolMetaByName);
  let nodeId = 0;

  const text = extractTextFromResponsesJson(obj);
  if (text) {
    nodeId += 1;
    yield makeBackChatChunk({ text, nodes: [rawResponseNode({ id: nodeId, content: text })] });
  }

  const output = Array.isArray(obj.output) ? obj.output : [];
  const reasoningSummary = extractReasoningSummaryFromResponseOutput(output);
  if (reasoningSummary) {
    nodeId += 1;
    yield makeBackChatChunk({ text: "", nodes: [thinkingNode({ id: nodeId, summary: reasoningSummary })] });
  }

  const toolCalls = extractToolCallsFromResponseOutput(output);
  let sawToolUse = false;
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

  const usage = obj.usage && typeof obj.usage === "object" ? obj.usage : null;
  const usageInputTokens = usage ? normalizeUsageInt(usage.input_tokens) : null;
  const usageOutputTokens = usage ? normalizeUsageInt(usage.output_tokens) : null;
  const usageCacheReadInputTokens = usage ? normalizeUsageInt(usage?.input_tokens_details?.cached_tokens) : null;
  const usageBuilt = buildTokenUsageChunk({
    nodeId,
    inputTokens: usageInputTokens,
    outputTokens: usageOutputTokens,
    cacheReadInputTokens: usageCacheReadInputTokens
  });
  nodeId = usageBuilt.nodeId;
  if (usageBuilt.chunk) yield usageBuilt.chunk;

  const stop = extractStopReasonFromResponsesObject(obj);
  const final = buildFinalChatChunk({ nodeId, stopReasonSeen: stop.stopReasonSeen, stopReason: stop.stopReason, sawToolUse });
  yield final.chunk;
}

module.exports = {
  extractOpenAiResponsesJsonError,
  extractToolCallsFromResponseOutput,
  extractReasoningSummaryFromResponseOutput,
  extractStopReasonFromResponsesObject,
  extractTextPartsFromResponsesJson,
  extractTextFromResponsesJson,
  throwIfOpenAiResponsesJsonError,
  emitOpenAiResponsesJsonAsAugmentChunks
};
