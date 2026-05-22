"use strict";

const { joinBaseUrl } = require("../http");
const { normalizeString, requireString, normalizeRawToken, stripByokInternalKeys } = require("../../infra/util");
const { truncateText, truncateTextMiddle } = require("../../infra/text");
const { debug } = require("../../infra/log");
const { withJsonContentType } = require("../headers");
const { isCompatibilityFallbackError } = require("../provider-util");
const { fetchOkWithRetry } = require("../request-util");
const { MAX_TOKENS_ALIAS_KEYS, pickPositiveIntFromRecord, deleteKeysFromRecord } = require("../request-defaults-util");

function normalizeGeminiModel(model) {
  const m = requireString(model, "Gemini model");
  if (m.includes("/")) return m;
  return `models/${m}`;
}

function normalizeGeminiRequestDefaults(requestDefaults) {
  const raw = requestDefaults && typeof requestDefaults === "object" && !Array.isArray(requestDefaults) ? requestDefaults : {};
  const rd = stripByokInternalKeys(raw);
  const out = { ...rd };

  // 兼容：用户常写 max_tokens/maxTokens/max_output_tokens；Gemini 使用 generationConfig.maxOutputTokens。
  // 仅在 generationConfig.maxOutputTokens 未显式提供时做映射，避免覆盖用户意图。
  const gc = out.generationConfig && typeof out.generationConfig === "object" && !Array.isArray(out.generationConfig) ? out.generationConfig : null;
  const hasGcMax = gc && Number.isFinite(Number(gc.maxOutputTokens)) && Number(gc.maxOutputTokens) > 0;
  if (!hasGcMax) {
    const maxOutput = pickPositiveIntFromRecord(out, MAX_TOKENS_ALIAS_KEYS);
    if (maxOutput != null) {
      const nextGc = gc ? { ...gc } : {};
      nextGc.maxOutputTokens = maxOutput;
      out.generationConfig = nextGc;
    }
  }

  deleteKeysFromRecord(out, MAX_TOKENS_ALIAS_KEYS);

  return out;
}

function buildGeminiRequest({ baseUrl, apiKey, model, systemInstruction, contents, tools, extraHeaders, requestDefaults, stream }) {
  const b = requireString(baseUrl, "Gemini baseUrl");
  const key = normalizeRawToken(apiKey);
  const extra = extraHeaders && typeof extraHeaders === "object" ? extraHeaders : {};
  if (!key && Object.keys(extra).length === 0) throw new Error("Gemini apiKey 未配置（且 headers 为空）");

  const m = normalizeGeminiModel(model);
  const endpoint = stream ? `${m}:streamGenerateContent` : `${m}:generateContent`;
  const url0 = joinBaseUrl(b, b.includes("/v1beta") ? endpoint : `v1beta/${endpoint}`);
  if (!url0) throw new Error("Gemini URL 构造失败（请检查 baseUrl/model）");

  const u = new URL(url0);
  if (key) u.searchParams.set("key", key);
  if (stream) u.searchParams.set("alt", "sse");

  const rd = normalizeGeminiRequestDefaults(requestDefaults);
  const body = { ...rd, contents: Array.isArray(contents) ? contents : [] };
  const sys = normalizeString(systemInstruction);
  if (sys && !body.systemInstruction) body.systemInstruction = { parts: [{ text: sys.trim() }] };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    if (!body.toolConfig) body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  }

  const headers = withJsonContentType(extraHeaders);
  if (stream) headers.accept = "text/event-stream";
  return { url: u.toString(), headers, body };
}

function stripGeminiInlineDataFromContents(contents, opts) {
  const placeholder =
    typeof opts?.placeholderText === "string" && opts.placeholderText.trim() ? opts.placeholderText.trim() : "[image omitted]";
  const input = Array.isArray(contents) ? contents : [];
  const out = [];
  let changed = false;

  for (const c of input) {
    if (!c || typeof c !== "object") {
      out.push(c);
      continue;
    }
    const parts = Array.isArray(c.parts) ? c.parts : [];
    if (!parts.length) {
      out.push(c);
      continue;
    }

    let localChanged = false;
    const rewritten = [];
    for (const p of parts) {
      if (!p || typeof p !== "object") continue;
      const inlineData =
        (p.inlineData && typeof p.inlineData === "object" ? p.inlineData : null) ||
        (p.inline_data && typeof p.inline_data === "object" ? p.inline_data : null);
      if (inlineData) {
        rewritten.push({ text: placeholder });
        localChanged = true;
      } else rewritten.push(p);
    }
    if (localChanged) {
      out.push({ ...c, parts: rewritten });
      changed = true;
    } else out.push(c);
  }

  return { contents: changed ? out : input, changed };
}

function stringifyGeminiToolPayload(value, { maxLen, middle } = {}) {
  if (typeof value === "string") return middle ? truncateTextMiddle(value, maxLen) : truncateText(value, maxLen);
  try {
    return middle ? truncateTextMiddle(JSON.stringify(value ?? {}), maxLen) : truncateText(JSON.stringify(value ?? {}), maxLen);
  } catch {
    return "";
  }
}

function buildGeminiToolPartText(part, opts) {
  const maxLen = Number.isFinite(Number(opts?.maxToolTextLen)) ? Math.floor(Number(opts.maxToolTextLen)) : 8000;
  const fc = part?.functionCall && typeof part.functionCall === "object" ? part.functionCall : null;
  if (fc) {
    const name = normalizeString(fc.name);
    const id = normalizeString(fc.id ?? fc.call_id ?? fc.callId ?? fc.tool_use_id ?? fc.toolUseId);
    const argsText = stringifyGeminiToolPayload(fc.args ?? fc.arguments, { maxLen });
    const header = `[tool_call${name ? ` name=${name}` : ""}${id ? ` id=${id}` : ""}]`;
    return argsText ? `${header}\n${argsText}` : header;
  }

  const fr = part?.functionResponse && typeof part.functionResponse === "object" ? part.functionResponse : null;
  if (!fr) return "";
  const name = normalizeString(fr.name);
  const id = normalizeString(fr.id ?? fr.call_id ?? fr.callId ?? fr.tool_use_id ?? fr.toolUseId);
  const responseText = stringifyGeminiToolPayload(fr.response, { maxLen, middle: true }).trim();
  const header = `[tool_result${name ? ` name=${name}` : ""}${id ? ` id=${id}` : ""}]`;
  return responseText ? `${header}\n${responseText}` : header;
}

function stripGeminiToolPartsFromContents(contents, opts) {
  const input = Array.isArray(contents) ? contents : [];
  const out = [];
  let changed = false;

  for (const c of input) {
    if (!c || typeof c !== "object") {
      out.push(c);
      continue;
    }
    const parts = Array.isArray(c.parts) ? c.parts : [];
    if (!parts.length) {
      out.push(c);
      continue;
    }

    let localChanged = false;
    const rewritten = [];
    for (const p of parts) {
      if (!p || typeof p !== "object") continue;
      const text = buildGeminiToolPartText(p, opts);
      if (text) {
        rewritten.push({ text });
        localChanged = true;
      } else rewritten.push(p);
    }
    if (localChanged) {
      out.push({ ...c, parts: rewritten });
      changed = true;
    } else out.push(c);
  }

  return { contents: changed ? out : input, changed };
}

async function fetchGeminiWithFallbacks({
  baseUrl,
  apiKey,
  model,
  systemInstruction,
  contents,
  tools,
  extraHeaders,
  requestDefaults,
  stream,
  timeoutMs,
  abortSignal,
  label
} = {}) {
  const hasTools = Array.isArray(tools) && tools.length > 0;
  const toolStripped = stripGeminiToolPartsFromContents(contents);
  const hasToolParts = toolStripped.changed;
  const noImages = stripGeminiInlineDataFromContents(contents);
  const noTools = hasTools || hasToolParts ? toolStripped : { contents, changed: false };
  const noToolsNoImages = (hasTools || hasToolParts) && noImages.changed ? stripGeminiInlineDataFromContents(noTools.contents) : null;

  const attempts = [
    { labelSuffix: "", tools, requestDefaults, contents },
    { labelSuffix: ":no-defaults", tools, requestDefaults: {}, contents }
  ];
  if (noImages.changed) attempts.push({ labelSuffix: ":no-images", tools, requestDefaults: {}, contents: noImages.contents });
  if (hasTools || hasToolParts) {
    attempts.push({ labelSuffix: ":no-tools", tools: [], requestDefaults: {}, contents: noTools.contents });
    if (noImages.changed) {
      attempts.push({ labelSuffix: ":no-tools-no-images", tools: [], requestDefaults: {}, contents: noToolsNoImages.contents });
    }
  }

  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    const { url, headers, body } = buildGeminiRequest({
      baseUrl,
      apiKey,
      model,
      systemInstruction,
      contents: a.contents ?? contents,
      tools: a.tools,
      extraHeaders,
      requestDefaults: a.requestDefaults,
      stream: Boolean(stream)
    });
    const lab = `${normalizeString(label) || "Gemini"}${a.labelSuffix || ""}`;

    try {
      return await fetchOkWithRetry(url, { method: "POST", headers, body: JSON.stringify(body) }, { timeoutMs, abortSignal, label: lab });
    } catch (err) {
      lastErr = err;
      const status = err && typeof err === "object" ? Number(err.status) : NaN;
      const canFallback = isCompatibilityFallbackError(err);
      const hasNext = i + 1 < attempts.length;
      if (!canFallback || !hasNext) throw err;
      debug(`${lab} fallback: retry (status=${Number.isFinite(status) ? status : "unknown"})`);
    }
  }

  throw lastErr || new Error("Gemini request failed");
}

module.exports = { normalizeGeminiRequestDefaults, fetchGeminiWithFallbacks };
