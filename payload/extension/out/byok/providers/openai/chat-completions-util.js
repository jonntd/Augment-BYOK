"use strict";

const { joinBaseUrl } = require("../http");
const { normalizeString, requireString, normalizeRawToken, stripByokInternalKeys } = require("../../infra/util");
const { truncateText, truncateTextMiddle } = require("../../infra/text");
const { withJsonContentType, openAiAuthHeaders } = require("../headers");
const { isCompatibilityFallbackError } = require("../provider-util");
const { fetchOkWithRetry } = require("../request-util");
const { pickPositiveIntFromRecord, deleteKeysFromRecord } = require("../request-defaults-util");

function buildMinimalRetryRequestDefaults(requestDefaults) {
  const raw = requestDefaults && typeof requestDefaults === "object" && !Array.isArray(requestDefaults) ? requestDefaults : {};
  const rd = sanitizeRequestDefaults(raw, { allowStreamOptions: false });

  const out = {};
  const temp = rd.temperature ?? rd.temp;
  const topP = rd.top_p ?? rd.topP;
  const maxTokens = rd.max_tokens ?? rd.maxTokens;
  const maxCompletionTokens = rd.max_completion_tokens ?? rd.maxCompletionTokens;
  const stop = rd.stop ?? rd.stop_sequences ?? rd.stopSequences;

  if (typeof temp === "number" && Number.isFinite(temp)) out.temperature = temp;
  if (typeof topP === "number" && Number.isFinite(topP)) out.top_p = topP;
  if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) out.max_tokens = Math.floor(maxTokens);
  if (typeof maxCompletionTokens === "number" && Number.isFinite(maxCompletionTokens) && maxCompletionTokens > 0) out.max_completion_tokens = Math.floor(maxCompletionTokens);
  if (typeof stop === "string" && stop.trim()) out.stop = stop.trim();
  if (Array.isArray(stop) && stop.length) out.stop = stop.slice(0, 20).map((s) => String(s ?? "").trim()).filter(Boolean);

  return out;
}

function sanitizeRequestDefaults(requestDefaults, { allowStreamOptions } = {}) {
  const raw = requestDefaults && typeof requestDefaults === "object" && !Array.isArray(requestDefaults) ? requestDefaults : {};
  const rd = stripByokInternalKeys(raw);
  const base = rd && typeof rd === "object" && !Array.isArray(rd) ? rd : {};
  const out = { ...base };

  if (allowStreamOptions !== true) {
    if ("stream_options" in out) delete out.stream_options;
    if ("streamOptions" in out) delete out.streamOptions;
  }

  // 兼容：用户可能写 camelCase；OpenAI 实际使用 snake_case。
  if ("parallelToolCalls" in out) {
    if (!("parallel_tool_calls" in out)) out.parallel_tool_calls = out.parallelToolCalls;
    delete out.parallelToolCalls;
  }

  // 兼容：用户从 /responses 或其它网关迁移时，可能写 max_output_tokens/maxOutputTokens。
  // chat/completions 仍以 max_tokens/max_completion_tokens 为准；这里仅在未显式提供时映射。
  const hasMaxTokens = Number.isFinite(Number(out.max_tokens ?? out.maxTokens)) && Number(out.max_tokens ?? out.maxTokens) > 0;
  const hasMaxCompletionTokens =
    Number.isFinite(Number(out.max_completion_tokens ?? out.maxCompletionTokens)) && Number(out.max_completion_tokens ?? out.maxCompletionTokens) > 0;
  const maxOutput = pickPositiveIntFromRecord(out, ["max_output_tokens", "maxOutputTokens"]);
  if (maxOutput != null && !hasMaxTokens && !hasMaxCompletionTokens) out.max_tokens = maxOutput;
  deleteKeysFromRecord(out, ["max_output_tokens", "maxOutputTokens"]);

  return out;
}

function buildOpenAiRequest({ baseUrl, apiKey, model, messages, tools, extraHeaders, requestDefaults, stream, includeUsage, includeToolChoice }) {
  const url = joinBaseUrl(requireString(baseUrl, "OpenAI baseUrl"), "chat/completions");
  const key = normalizeRawToken(apiKey);
  const extra = extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {};
  if (!key && Object.keys(extra).length === 0) throw new Error("OpenAI apiKey 未配置（且 headers 为空）");
  const m = requireString(model, "OpenAI model");
  if (!Array.isArray(messages) || !messages.length) throw new Error("OpenAI messages 为空");

  const rd = sanitizeRequestDefaults(requestDefaults, { allowStreamOptions: stream && includeUsage });
  const body = { ...rd, model: m, messages, stream: Boolean(stream) };
  if (stream && includeUsage) body.stream_options = { include_usage: true };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    if (includeToolChoice !== false) body.tool_choice = "auto";
  }

  const headers = withJsonContentType(openAiAuthHeaders(key, extraHeaders));
  if (stream) headers.accept = "text/event-stream";
  return { url, headers, body };
}

function buildOpenAiFunctionsRequest({ baseUrl, apiKey, model, messages, functions, extraHeaders, requestDefaults, stream }) {
  const url = joinBaseUrl(requireString(baseUrl, "OpenAI baseUrl"), "chat/completions");
  const key = normalizeRawToken(apiKey);
  const extra = extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {};
  if (!key && Object.keys(extra).length === 0) throw new Error("OpenAI apiKey 未配置（且 headers 为空）");
  const m = requireString(model, "OpenAI model");
  if (!Array.isArray(messages) || !messages.length) throw new Error("OpenAI messages 为空");

  const rd = sanitizeRequestDefaults(requestDefaults, { allowStreamOptions: false });
  const body = { ...rd, model: m, messages, stream: Boolean(stream) };
  const fs = Array.isArray(functions) ? functions.filter((f) => f && typeof f === "object") : [];
  if (fs.length) {
    body.functions = fs;
    body.function_call = "auto";
  }

  const headers = withJsonContentType(openAiAuthHeaders(key, extraHeaders));
  if (stream) headers.accept = "text/event-stream";
  return { url, headers, body };
}

function convertOpenAiToolsToFunctions(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const out = [];
  const seen = new Set();
  for (const t of list) {
    const fn = t && typeof t === "object" && t.function && typeof t.function === "object" ? t.function : null;
    const name = normalizeString(fn?.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, ...(normalizeString(fn?.description) ? { description: fn.description } : {}), parameters: fn?.parameters && typeof fn.parameters === "object" ? fn.parameters : {} });
  }
  return out;
}

function stripVisionFromMessages(messages) {
  const input = Array.isArray(messages) ? messages : [];
  const out = [];
  let changed = false;

  for (const msg of input) {
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    const content = msg.content;
    if (!Array.isArray(content)) {
      out.push(msg);
      continue;
    }

    const textParts = [];
    let sawNonText = false;
    for (const p of content) {
      if (!p || typeof p !== "object") continue;
      const t = normalizeString(p.type);
      if (t === "text" && typeof p.text === "string" && p.text.trim()) textParts.push(p.text.trim());
      else sawNonText = true;
    }

    // 对不支持多模态/多段 content 的网关：把 parts 压平成纯文本（并提示省略了非文本部分）。
    const base = textParts.join("\n\n").trim();
    const suffix = sawNonText ? "[non-text content omitted]" : "";
    const asText = base && suffix ? `${base}\n\n${suffix}` : base || suffix;
    if (!asText) {
      out.push(msg);
      continue;
    }

    out.push({ ...msg, content: asText });
    changed = true;
  }

  return { messages: changed ? out : input, changed };
}

function buildOrphanToolResultAsUserContent(msg, { maxLen = 8000 } = {}) {
  const id = normalizeString(msg?.tool_call_id);
  const raw = typeof msg?.content === "string" ? msg.content : String(msg?.content ?? "");
  const content = truncateTextMiddle(raw, maxLen).trim();
  const header = id ? `[orphan_tool_result tool_call_id=${id}]` : "[orphan_tool_result]";
  return content ? `${header}\n${content}` : header;
}

function convertMessagesToFunctionCalling(messages) {
  const input = Array.isArray(messages) ? messages : [];
  const idToName = new Map();
  for (const msg of input) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role !== "assistant") continue;
    const tcs = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const tc = tcs.length ? tcs[0] : null;
    if (!tc || typeof tc !== "object") continue;
    const id = normalizeString(tc.id);
    const fn = tc.function && typeof tc.function === "object" ? tc.function : null;
    const name = normalizeString(fn?.name);
    if (!id || !name) continue;
    if (!idToName.has(id)) idToName.set(id, name);
  }

  const out = [];
  for (const msg of input) {
    if (!msg || typeof msg !== "object") continue;
    const role = normalizeString(msg.role);
    if (role === "tool") {
      const toolCallId = normalizeString(msg.tool_call_id);
      const name = toolCallId ? normalizeString(idToName.get(toolCallId)) : "";
      const content = typeof msg.content === "string" ? msg.content : String(msg.content ?? "");
      if (name) out.push({ role: "function", name, content });
      else out.push({ role: "user", content: buildOrphanToolResultAsUserContent(msg) });
      continue;
    }

    if (role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length >= 1 && msg.function_call == null) {
      const tc = msg.tool_calls[0];
      const fn = tc && typeof tc === "object" && tc.function && typeof tc.function === "object" ? tc.function : null;
      const name = normalizeString(fn?.name);
      const args = typeof fn?.arguments === "string" ? fn.arguments : "";
      const next = { role: "assistant", content: typeof msg.content === "string" ? msg.content : "", ...(name ? { function_call: { name, arguments: args || "{}" } } : {}) };
      out.push(next);
      continue;
    }

    out.push(msg);
  }
  return out;
}

async function fetchOpenAiChatStreamResponse({ baseUrl, apiKey, model, messages, tools, timeoutMs, abortSignal, extraHeaders, requestDefaults, includeUsage, includeToolChoice }) {
  const { url, headers, body } = buildOpenAiRequest({
    baseUrl,
    apiKey,
    model,
    messages,
    tools,
    extraHeaders,
    requestDefaults,
    stream: true,
    includeUsage,
    includeToolChoice
  });
  return await fetchOkWithRetry(url, { method: "POST", headers, body: JSON.stringify(body) }, { timeoutMs, abortSignal, label: "OpenAI(chat-stream)" });
}

async function fetchOpenAiChatStreamResponseWithFunctions({ baseUrl, apiKey, model, messages, functions, timeoutMs, abortSignal, extraHeaders, requestDefaults }) {
  const { url, headers, body } = buildOpenAiFunctionsRequest({
    baseUrl,
    apiKey,
    model,
    messages,
    functions,
    extraHeaders,
    requestDefaults,
    stream: true
  });
  return await fetchOkWithRetry(url, { method: "POST", headers, body: JSON.stringify(body) }, { timeoutMs, abortSignal, label: "OpenAI(chat-stream)" });
}

async function fetchOpenAiChatCompletionResponseWithFallbackDefaults({
  baseUrl,
  apiKey,
  model,
  messages,
  tools,
  timeoutMs,
  abortSignal,
  extraHeaders,
  requestDefaults,
  stream,
  includeUsage,
  includeToolChoice,
  label
} = {}) {
  const baseLabel = normalizeString(label) || "OpenAI";
  const minimalDefaults = buildMinimalRetryRequestDefaults(requestDefaults);

  const fetchOnce = async (rd, labelSuffix) => {
    const { url, headers, body } = buildOpenAiRequest({
      baseUrl,
      apiKey,
      model,
      messages,
      tools: Array.isArray(tools) ? tools : [],
      extraHeaders,
      requestDefaults: rd,
      stream: Boolean(stream),
      includeUsage: includeUsage === true,
      includeToolChoice
    });
    const lab = normalizeString(labelSuffix) ? `${baseLabel}${labelSuffix}` : baseLabel;
    return await fetchOkWithRetry(url, { method: "POST", headers, body: JSON.stringify(body) }, { timeoutMs, abortSignal, label: lab });
  };

  try {
    return await fetchOnce(requestDefaults, "");
  } catch (err) {
    const canFallback = isCompatibilityFallbackError(err);
    if (!canFallback) throw err;
    return await fetchOnce(minimalDefaults, ":minimal-defaults");
  }
}

async function postOpenAiChatStreamWithFallbacks({ baseUrl, apiKey, model, messages, tools, timeoutMs, abortSignal, extraHeaders, requestDefaults }) {
  const minimalDefaults = buildMinimalRetryRequestDefaults(requestDefaults);
  const visionStripped = stripVisionFromMessages(messages);
  const functions = convertOpenAiToolsToFunctions(tools);

  const attempts = [
    { mode: "tools", includeUsage: true, includeToolChoice: true, tools, requestDefaults },
    { mode: "tools", includeUsage: false, includeToolChoice: true, tools, requestDefaults },
    { mode: "tools", includeUsage: false, includeToolChoice: false, tools, requestDefaults },
    { mode: "tools", includeUsage: false, includeToolChoice: false, tools, requestDefaults: minimalDefaults }
  ];
  if (visionStripped.changed) {
    attempts.push({ mode: "tools", includeUsage: false, includeToolChoice: false, tools, requestDefaults: minimalDefaults, messages: visionStripped.messages });
  }
  attempts.push(
    {
      mode: "functions",
      functions,
      requestDefaults: minimalDefaults,
      messages: visionStripped.changed ? visionStripped.messages : null
    },
    { mode: "tools", includeUsage: false, includeToolChoice: false, tools: [], requestDefaults: minimalDefaults }
  );
  if (visionStripped.changed) {
    attempts.push({ mode: "tools", includeUsage: false, includeToolChoice: false, tools: [], requestDefaults: minimalDefaults, messages: visionStripped.messages });
  }

  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    const attemptMessages = Array.isArray(a.messages) ? a.messages : messages;
    try {
      if (a.mode === "functions") {
        return await fetchOpenAiChatStreamResponseWithFunctions({
          baseUrl,
          apiKey,
          model,
          messages: convertMessagesToFunctionCalling(attemptMessages),
          functions: a.functions,
          timeoutMs,
          abortSignal,
          extraHeaders,
          requestDefaults: a.requestDefaults
        });
      }
      return await fetchOpenAiChatStreamResponse({
        baseUrl,
        apiKey,
        model,
        messages: attemptMessages,
        tools: a.tools,
        timeoutMs,
        abortSignal,
        extraHeaders,
        requestDefaults: a.requestDefaults,
        includeUsage: a.includeUsage,
        includeToolChoice: a.includeToolChoice
      });
    } catch (err) {
      lastErr = err;
      const canFallback = isCompatibilityFallbackError(err);
      if (!canFallback) throw err;
    }
  }
  throw lastErr || new Error("OpenAI(chat-stream) failed");
}

module.exports = {
  buildMinimalRetryRequestDefaults,
  fetchOpenAiChatCompletionResponseWithFallbackDefaults,
  postOpenAiChatStreamWithFallbacks
};
