"use strict";

const { joinBaseUrl } = require("../http");
const { normalizeString, requireString, normalizeRawToken } = require("../../infra/util");
const { truncateText } = require("../../infra/text");
const { debug } = require("../../infra/log");
const { withJsonContentType, anthropicAuthHeaders } = require("../headers");
const { isCompatibilityFallbackError } = require("../provider-util");
const { fetchWithRetry, readHttpErrorDetail } = require("../request-util");
const { repairAnthropicToolUsePairs } = require("../../core/tool-pairing");
const { MAX_TOKENS_ALIAS_KEYS_PREFER_MAX_TOKENS, pickPositiveIntFromRecord } = require("../request-defaults-util");

function pickMaxTokens(requestDefaults) {
  return pickPositiveIntFromRecord(requestDefaults, MAX_TOKENS_ALIAS_KEYS_PREFER_MAX_TOKENS) ?? 1024;
}

function normalizeStopSequences(v) {
  if (Array.isArray(v)) {
    const out = [];
    for (const it of v) {
      const s = String(it ?? "").trim();
      if (!s) continue;
      out.push(s);
      if (out.length >= 20) break;
    }
    return out;
  }
  if (typeof v === "string") {
    const s = v.trim();
    return s ? [s] : [];
  }
  return [];
}

const ANTHROPIC_REQUEST_DEFAULTS_OMIT_KEYS = new Set([
  "model",
  "messages",
  "system",
  "stream",
  "tools",
  "tool_choice",
  "toolChoice",
  "maxTokens",
  "max_tokens",
  "stop",
  "stopSequences",
  "stop_sequences",
  "topP",
  "topK"
]);

const ANTHROPIC_REQUEST_DEFAULTS_DROP_KEYS = new Set([
  "max_completion_tokens",
  "maxOutputTokens",
  "max_output_tokens",
  "presence_penalty",
  "presencePenalty",
  "frequency_penalty",
  "frequencyPenalty",
  "logit_bias",
  "logitBias",
  "logprobs",
  "top_logprobs",
  "topLogprobs",
  "response_format",
  "responseFormat",
  "seed",
  "n",
  "user",
  "parallel_tool_calls",
  "parallelToolCalls",
  "stream_options",
  "streamOptions",
  "functions",
  "function_call",
  "functionCall"
]);

function sanitizeAnthropicRequestDefaults(requestDefaults) {
  const raw = requestDefaults && typeof requestDefaults === "object" && !Array.isArray(requestDefaults) ? requestDefaults : {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k || typeof k !== "string") continue;
    if (k.startsWith("__byok")) continue;
    if (ANTHROPIC_REQUEST_DEFAULTS_OMIT_KEYS.has(k)) continue;
    if (ANTHROPIC_REQUEST_DEFAULTS_DROP_KEYS.has(k)) continue;
    out[k] = v;
  }

  const stopSeq = normalizeStopSequences(raw.stop_sequences ?? raw.stopSequences ?? raw.stop);
  if (stopSeq.length) out.stop_sequences = stopSeq;

  if (!("top_p" in out) && "topP" in raw) {
    const n = Number(raw.topP);
    if (Number.isFinite(n)) out.top_p = n;
  }
  if (!("top_k" in out) && "topK" in raw) {
    const n = Number(raw.topK);
    if (Number.isFinite(n)) out.top_k = n;
  }

  return out;
}

function normalizeAnthropicMessagesForRequest(messages, opts) {
  const forceTextBlocks = opts && typeof opts === "object" ? opts.forceTextBlocks === true : false;
  const input = Array.isArray(messages) ? messages : [];
  const normalized = [];
  for (const m of input) {
    if (!m || typeof m !== "object") continue;
    const role = normalizeString(m.role);
    if (role !== "user" && role !== "assistant") continue;
    const content = m.content;
    if (typeof content === "string") {
      if (!content.trim()) continue;
      normalized.push({ role, content: forceTextBlocks ? buildAnthropicTextBlocks(content) : content });
      continue;
    }
    if (Array.isArray(content)) {
      const blocks = content.filter((b) => b && typeof b === "object");
      if (!blocks.length) continue;
      normalized.push({ role, content: blocks });
      continue;
    }
  }

  const repaired = repairAnthropicToolUsePairs(normalized);
  if (repaired?.report?.injected_missing_tool_results || repaired?.report?.converted_orphan_tool_results) {
    debug(
      `anthropic tool pairing repaired: injected_missing=${Number(repaired.report.injected_missing_tool_results) || 0} converted_orphan=${Number(repaired.report.converted_orphan_tool_results) || 0}`
    );
  }

  let out = repaired && Array.isArray(repaired.messages) ? repaired.messages : normalized;

  if (out.length && out[0].role !== "user") {
    out = [{ role: "user", content: "-" }, ...out];
    debug(`Anthropic request normalized: prepended dummy user message to satisfy messages[0].role=user`);
  }
  return out;
}

function dedupeAnthropicTools(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const out = [];
  const seen = new Set();
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    const name = normalizeString(t.name);
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(t);
  }
  return out;
}

function buildAnthropicTextBlocks(text) {
  const s = typeof text === "string" ? text.trim() : "";
  if (!s) return [];
  return [{ type: "text", text: s }];
}

function buildAnthropicSystemBlocks(system) {
  return buildAnthropicTextBlocks(system);
}

function buildAnthropicRequest({ baseUrl, apiKey, model, system, messages, tools, extraHeaders, requestDefaults, stream, includeToolChoice, systemAsBlocks, messagesAsBlocks }) {
  const url = joinBaseUrl(requireString(baseUrl, "Anthropic baseUrl"), "messages");
  const key = normalizeRawToken(apiKey);
  const extra = extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {};
  if (!key && Object.keys(extra).length === 0) throw new Error("Anthropic apiKey 未配置（且 headers 为空）");
  const m = requireString(model, "Anthropic model");
  const maxTokens = pickMaxTokens(requestDefaults);
  const rd = sanitizeAnthropicRequestDefaults(requestDefaults);
  const ms = normalizeAnthropicMessagesForRequest(messages, { forceTextBlocks: messagesAsBlocks === true });
  if (!Array.isArray(ms) || !ms.length) throw new Error("Anthropic messages 为空");

  const body = {
    ...rd,
    model: m,
    max_tokens: maxTokens,
    messages: ms,
    stream: Boolean(stream)
  };
  if (typeof system === "string" && system.trim()) {
    body.system = systemAsBlocks === true ? buildAnthropicSystemBlocks(system) : system.trim();
  }
  const ts = dedupeAnthropicTools(tools);
  if (ts.length) {
    body.tools = ts;
    if (includeToolChoice !== false) body.tool_choice = { type: "auto" };
  }
  const headers = withJsonContentType(anthropicAuthHeaders(key, extraHeaders));
  if (stream) headers.accept = "text/event-stream";
  return { url, headers, body };
}

function buildMinimalRetryRequestDefaults(requestDefaults) {
  return { max_tokens: pickMaxTokens(requestDefaults) };
}

function formatAttemptLabel(i, labelSuffix) {
  if (!i) return "first";
  const s = String(labelSuffix || "").replace(/^:/, "").trim();
  return s ? `retry${i}(${s})` : `retry${i}`;
}

function isSystemInvalidTypeStringError(errorText) {
  const t = normalizeString(errorText).toLowerCase();
  if (!t) return false;
  return t.includes("system") && t.includes("invalid type") && t.includes("string");
}

function isMessagesContentInvalidTypeStringError(errorText) {
  const t = normalizeString(errorText).toLowerCase();
  if (!t) return false;
  if (!t.includes("invalid type") || !t.includes("string")) return false;
  // 常见形态：messages[0].content: invalid type: string
  // 也可能：messages: ... invalid type: string（内容结构不匹配）
  return t.includes("messages") && t.includes("content");
}

async function postAnthropicWithFallbacks({ baseLabel, timeoutMs, abortSignal, attempts }) {
  const list = Array.isArray(attempts) ? attempts : [];
  if (!list.length) throw new Error("Anthropic post attempts 为空");

  const errors = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i] && typeof list[i] === "object" ? list[i] : {};
    const labelSuffix = normalizeString(a.labelSuffix);
    const req0 = a.request && typeof a.request === "object" ? a.request : {};

    const run = async (req, { labelSuffixExtra } = {}) => {
      const { url, headers, body } = buildAnthropicRequest(req);
      const resp = await fetchWithRetry(
        url,
        { method: "POST", headers, body: JSON.stringify(body) },
        { timeoutMs, abortSignal, label: `${baseLabel}${labelSuffix}${normalizeString(labelSuffixExtra)}` }
      );
      if (resp.ok) return { ok: true, resp };

      const text = await readHttpErrorDetail(resp, { maxChars: 500 });
      errors.push({ status: resp.status, text, labelSuffix: `${labelSuffix}${normalizeString(labelSuffixExtra)}` });
      return { ok: false, resp, text };
    };

    const r0 = await run(req0);
    if (r0.ok) return r0.resp;

    const retryable0 = isCompatibilityFallbackError({ status: r0.resp.status, message: r0.text });
    const hasNext = i + 1 < list.length;
    const hasSystem = typeof req0.system === "string" && req0.system.trim();
    const alreadySystemBlocks = req0.systemAsBlocks === true;
    const alreadyMessageBlocks = req0.messagesAsBlocks === true;

    const shouldTrySystemBlocks = retryable0 && hasSystem && !alreadySystemBlocks && isSystemInvalidTypeStringError(r0.text);
    const shouldTryMessageBlocks = retryable0 && !alreadyMessageBlocks && isMessagesContentInvalidTypeStringError(r0.text);

    if (shouldTrySystemBlocks || shouldTryMessageBlocks) {
      const parts = [];
      const patched0 = { ...req0 };
      if (shouldTrySystemBlocks) {
        patched0.systemAsBlocks = true;
        parts.push("system-blocks");
      }
      if (shouldTryMessageBlocks) {
        patched0.messagesAsBlocks = true;
        parts.push("message-blocks");
      }

      debug(
        `${baseLabel} fallback: retry with ${parts.join("+")} (status=${r0.resp.status}, body=${truncateText(r0.text, 200)})`
      );
      const r1 = await run(patched0, { labelSuffixExtra: `:${parts.join("+")}` });
      if (r1.ok) return r1.resp;

      const retryable1 = isCompatibilityFallbackError({ status: r1.resp.status, message: r1.text });
      if (retryable1) {
        const patched1 = { ...patched0 };
        const parts2 = parts.slice();

        const needSystemBlocks2 =
          hasSystem && patched1.systemAsBlocks !== true && isSystemInvalidTypeStringError(r1.text);
        const needMessageBlocks2 =
          patched1.messagesAsBlocks !== true && isMessagesContentInvalidTypeStringError(r1.text);

        if (needSystemBlocks2 || needMessageBlocks2) {
          if (needSystemBlocks2) {
            patched1.systemAsBlocks = true;
            if (!parts2.includes("system-blocks")) parts2.push("system-blocks");
          }
          if (needMessageBlocks2) {
            patched1.messagesAsBlocks = true;
            if (!parts2.includes("message-blocks")) parts2.push("message-blocks");
          }

          debug(
            `${baseLabel} fallback: retry with ${parts2.join("+")} (status=${r1.resp.status}, body=${truncateText(r1.text, 200)})`
          );
          const r2 = await run(patched1, { labelSuffixExtra: `:${parts2.join("+")}` });
          if (r2.ok) return r2.resp;
          const retryable2 = isCompatibilityFallbackError({ status: r2.resp.status, message: r2.text });
          if (retryable2 && hasNext) continue;
          break;
        }
      }

      if (retryable1 && hasNext) continue;
      break;
    }

    if (retryable0 && hasNext) {
      const hint = normalizeString(a.retryHint);
      debug(`${baseLabel} fallback: ${hint || "retry"} (status=${r0.resp.status}, body=${truncateText(r0.text, 200)})`);
      continue;
    }
    break;
  }

  const last = errors[errors.length - 1];
  const parts = errors.map((e, idx) => `${formatAttemptLabel(idx, e.labelSuffix)}: ${e.text}`);
  throw new Error(`${baseLabel} ${last?.status ?? ""}: ${parts.join(" | ")}`.trim());
}

module.exports = { buildMinimalRetryRequestDefaults, postAnthropicWithFallbacks };
