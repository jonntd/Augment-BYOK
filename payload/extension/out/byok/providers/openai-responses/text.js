"use strict";

const { makeSseJsonIterator } = require("../sse-json");
const { normalizeString } = require("../../infra/util");
const { assertSseResponse } = require("../provider-util");
const { createOutputTextTracker } = require("./output-text-tracker");
const {
  extractOpenAiResponsesJsonError,
  extractTextPartsFromResponsesJson,
  extractTextFromResponsesJson,
  throwIfOpenAiResponsesJsonError
} = require("./json-util");
const { fetchOpenAiResponsesWithFallbacks } = require("./fetch");

async function openAiResponsesCompleteText({ baseUrl, apiKey, model, instructions, input, timeoutMs, abortSignal, extraHeaders, requestDefaults }) {
  const resp = await fetchOpenAiResponsesWithFallbacks({
    baseUrl,
    apiKey,
    model,
    instructions,
    input,
    tools: [],
    extraHeaders,
    requestDefaults,
    stream: false,
    timeoutMs,
    abortSignal,
    label: "OpenAI(responses)"
  });

  const json = await resp.json().catch(() => null);
  throwIfOpenAiResponsesJsonError(json, "OpenAI(responses)");
  const output = Array.isArray(json?.output) ? json.output : [];
  const direct = extractTextFromResponsesJson(json);
  if (direct) return direct;

  const hasToolCall = output.some((it) => it && typeof it === "object" && it.type === "function_call");
  if (hasToolCall) throw new Error("OpenAI(responses) 返回 function_call（当前调用不执行工具；请改用 /chat-stream）");

  // 兼容：部分 /responses 网关只支持 SSE（即使 stream=false 也可能返回非 JSON/空 JSON）。
  // 这里做一次“流式兜底”以提升 openai_responses provider 的鲁棒性。
  try {
    let out = "";
    for await (const d of openAiResponsesStreamTextDeltas({ baseUrl, apiKey, model, instructions, input, timeoutMs, abortSignal, extraHeaders, requestDefaults })) {
      if (typeof d === "string") out += d;
    }
    const s = normalizeString(out);
    if (s) return s;
  } catch (err) {
    const fallbackMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`OpenAI(responses) 响应缺少可解析文本（且 stream fallback 失败: ${fallbackMsg}）`.trim());
  }

  const types = output
    .map((it) => (it && typeof it === "object" ? normalizeString(it.type) || "unknown" : "unknown"))
    .filter(Boolean)
    .slice(0, 12)
    .join(",");
  throw new Error(`OpenAI(responses) 响应缺少可解析文本（output_types=${types || "n/a"}）`.trim());
}

async function* openAiResponsesStreamTextDeltas({ baseUrl, apiKey, model, instructions, input, timeoutMs, abortSignal, extraHeaders, requestDefaults }) {
  const resp = await fetchOpenAiResponsesWithFallbacks({
    baseUrl,
    apiKey,
    model,
    instructions,
    input,
    tools: [],
    extraHeaders,
    requestDefaults,
    stream: true,
    timeoutMs,
    abortSignal,
    label: "OpenAI(responses-stream)"
  });
  const contentType = normalizeString(resp?.headers?.get?.("content-type")).toLowerCase();
  if (contentType.includes("json")) {
    const json = await resp.json().catch(() => null);
    throwIfOpenAiResponsesJsonError(json, "OpenAI(responses-stream)");
    const text = extractTextFromResponsesJson(json);
    if (text) {
      yield text;
      return;
    }
    throw new Error(`OpenAI(responses-stream) JSON 响应缺少可解析文本（content-type=${contentType || "unknown"}）`.trim());
  }
  await assertSseResponse(resp, { label: "OpenAI(responses-stream)", expectedHint: "请确认 baseUrl 指向 OpenAI /responses SSE" });

  const sse = makeSseJsonIterator(resp, { doneData: "[DONE]" });
  let emitted = 0;
  const textTracker = createOutputTextTracker();

  for await (const { json, eventType } of sse.events) {
    throwIfOpenAiResponsesJsonError(json?.response && typeof json.response === "object" ? json.response : json, "OpenAI(responses-stream)");
    if (eventType === "response.output_text.delta" && typeof json?.delta === "string" && json.delta) {
      const idx = json?.output_index ?? json?.outputIndex ?? json?.index;
      emitted += 1;
      textTracker.pushDelta(idx, json.delta);
      yield json.delta;
    } else if (eventType === "response.output_text.done") {
      const idx = json?.output_index ?? json?.outputIndex ?? json?.index;
      const full = typeof json?.text === "string" ? json.text : "";
      const rest = textTracker.applyFinalText(idx, full).rest;
      if (rest) {
        emitted += 1;
        yield rest;
      }
    } else if ((eventType === "response.completed" || eventType === "response.incomplete") && json?.response && typeof json.response === "object") {
      // 兼容：部分网关不发 done，只在 completed/incomplete 里给 output_text 或 output[]。
      for (const part of extractTextPartsFromResponsesJson(json.response)) {
        const rest = textTracker.applyFinalText(part.outputIndex, part.text).rest;
        if (rest) {
          emitted += 1;
          yield rest;
        }
      }
    } else if (eventType === "response.failed" || eventType === "response.error" || eventType === "error") {
      const msg = extractOpenAiResponsesJsonError(json) || "upstream error event";
      throw new Error(`OpenAI(responses-stream) upstream error event: ${msg}`.trim());
    }
  }
  if (emitted === 0) {
    throw new Error(
      `OpenAI(responses-stream) 未解析到任何 SSE delta（data_events=${sse.stats.dataEvents}, parsed_chunks=${sse.stats.parsedChunks}）；请检查 baseUrl 是否为 OpenAI SSE`.trim()
    );
  }
}

module.exports = { openAiResponsesCompleteText, openAiResponsesStreamTextDeltas };
