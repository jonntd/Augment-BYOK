"use strict";

const { normalizeString } = require("../infra/util");
const { readHttpErrorDetail } = require("./request-util");

const INVALID_REQUEST_FALLBACK_STATUSES = new Set([400, 422]);
const AUTH_ERROR_MARKER_RE =
  /(^|[^a-z0-9])(unauthorized|unauthenticated|forbidden|authori[sz]ation|authentication|permission[_ -]?denied|access[_ -]?denied|not[_ -]?authorized)(?=$|[^a-z0-9])/;
const CREDENTIAL_MARKER_RE =
  /(^|[^a-z0-9])(api[-_ ]?key|apikey|x[-_ ]?api[-_ ]?key|auth(entication)?[-_ ]?token|access[-_ ]?token|bearer|credentials?|client[-_ ]?secret|secret|password|passwd)(?=$|[^a-z0-9])/;
const ACCOUNT_OR_QUOTA_MARKER_RE =
  /(^|[^a-z0-9])(insufficient[_ -]?quota|quota[_ -]?(exceeded|exhausted)|resource[_ -]?exhausted|too[_ -]?many[_ -]?requests|rate[_ -]?limit(ed)?[_ -]?(exceeded|reached)|billing|payment[_ -]?required|credit(s)?|balance|spending[_ -]?limit|hard[_ -]?limit|subscription)(?=$|[^a-z0-9])/;
const MODEL_AVAILABILITY_MARKER_RE =
  /(^|[^a-z0-9])((unknown|invalid|unsupported|unrecognized)[_ -]?model|model[_ -]?(not[_ -]?(found|available|enabled|allowed)|unavailable|does[_ -]?not[_ -]?exist|deprecated|decommissioned)|model[^.\n]{0,80}(not found|does not exist|not available|unavailable|unknown|invalid|is not enabled|is not allowed|has been deprecated|decommissioned|no such model))(?=$|[^a-z0-9])/;
const MODEL_CAPABILITY_COMPATIBILITY_MARKER_RE =
  /(^|[^a-z0-9])((unknown|unsupported|unrecognized|invalid)[_ -]?model[_ -]?(feature|features|parameter|parameters|capability|capabilities|option|options|setting|settings))(?=$|[^a-z0-9])/;
const MODEL_ACCESS_DIRECT_MARKER_RE =
  /(^|[^a-z0-9])((do not|don't|does not|doesn't|did not|didn't)\s+have\s+access\s+to\s+(the\s+)?model|no\s+access\s+to\s+(the\s+)?model)(?=$|[^a-z0-9])/;
const MODEL_ACCESS_ACTION_MARKER_RE =
  /(^|[^a-z0-9])not\s+(allowed|permitted|authorized)\s+to\s+(use|access)\s+(the\s+)?model(?=$|[^a-z0-9])/;
const MODEL_ACCESS_MODEL_MARKER_RE =
  /(^|[^a-z0-9])model[^.\n]{0,80}(not accessible|access denied|not permitted|not authorized)(?=$|[^a-z0-9])/;
const MODEL_VERIFICATION_MARKER_RE =
  /(^|[^a-z0-9])((account|organization|project)[^.\n]{0,80}(must\s+be\s+)?(verified|verification)[^.\n]{0,80}(use|access)[^.\n]{0,80}model|model[^.\n]{0,80}(requires?|needs)[^.\n]{0,80}(account|organization|project)[^.\n]{0,80}(verified|verification))(?=$|[^a-z0-9])/;
const COMPAT_FIELD_MARKER =
  "(field|fields|parameter|parameters|argument|arguments|option|options|property|properties|key|keys|setting|settings|feature|features|capability|capabilities|schema|type|format|content|block|blocks|part|parts)";
const COMPAT_FEATURE_MARKER =
  "(tool_choice|tools?|functions?|function_call|stream_options|image_url|images?|image|inline[_ -]?data|generationconfig|system|messages?\\[\\d+\\]\\.content|content[_ -]?blocks?)";
const COMPAT_UNKNOWN_FIELD_RE = new RegExp(
  `(^|[^a-z0-9])(unsupported|unrecognized|unknown|invalid|unexpected|extraneous|additional|extra)[^.\n]{0,80}${COMPAT_FIELD_MARKER}(?=$|[^a-z0-9])`
);
const COMPAT_FIELD_PROBLEM_RE = new RegExp(
  `(^|[^a-z0-9])${COMPAT_FIELD_MARKER}[^.\n]{0,80}(unsupported|not supported|unrecognized|unknown|invalid|not allowed|not permitted|extra|additional|extraneous|unexpected)(?=$|[^a-z0-9])`
);
const COMPAT_FEATURE_PROBLEM_RE = new RegExp(
  `(^|[^a-z0-9])(${COMPAT_FEATURE_MARKER})[^.\n]{0,80}(not supported|does not support|doesn't support|unsupported|invalid type|invalid|must be|expected)(?=$|[^a-z0-9])`
);
const COMPAT_UNSUPPORTED_FEATURE_RE = new RegExp(
  `(^|[^a-z0-9])(not supported|does not support|doesn't support|unsupported)[^.\n]{0,80}(${COMPAT_FEATURE_MARKER})(?=$|[^a-z0-9])`
);
const COMPAT_ADDITIONAL_PROPERTIES_RE =
  /(^|[^a-z0-9])(additional properties? (are )?not allowed|extra fields? not permitted|unrecognized request argument supplied)(?=$|[^a-z0-9])/;
const COMPAT_INVALID_BLOCK_TYPE_RE =
  /(^|[^a-z0-9])((messages?\[\d+\]\.content|system|content)[^.\n]{0,80}invalid type|invalid type[^.\n]{0,80}(messages?\[\d+\]\.content|system|content))(?=$|[^a-z0-9])/;

function normalizeUsageInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function applyParallelToolCallsPolicy(requestDefaults, { hasTools, supportParallelToolUse } = {}) {
  const rd = requestDefaults && typeof requestDefaults === "object" && !Array.isArray(requestDefaults) ? requestDefaults : {};
  const hasSnake = Object.prototype.hasOwnProperty.call(rd, "parallel_tool_calls");
  const hasCamel = Object.prototype.hasOwnProperty.call(rd, "parallelToolCalls");

  // 兼容：用户可能写 camelCase；OpenAI 实际使用 snake_case。
  if (!hasSnake && hasCamel) {
    const out = { ...rd, parallel_tool_calls: rd.parallelToolCalls };
    delete out.parallelToolCalls;
    return out;
  }

  const tools = hasTools === true;
  if (!tools || supportParallelToolUse === true) return rd;
  if (hasSnake || hasCamel) return rd;
  return { ...rd, parallel_tool_calls: false };
}

function isInvalidRequestStatusForFallback(status) {
  const s = Number(status);
  return Number.isFinite(s) && INVALID_REQUEST_FALLBACK_STATUSES.has(s);
}

function isAuthenticationLikeErrorMessage(message) {
  const t = normalizeString(message).toLowerCase();
  if (!t) return false;
  return AUTH_ERROR_MARKER_RE.test(t) || CREDENTIAL_MARKER_RE.test(t);
}

function isAccountOrQuotaLikeErrorMessage(message) {
  const t = normalizeString(message).toLowerCase();
  if (!t) return false;
  return ACCOUNT_OR_QUOTA_MARKER_RE.test(t);
}

function isModelAvailabilityLikeErrorMessage(message) {
  const t = normalizeString(message).toLowerCase();
  if (!t) return false;
  if (MODEL_CAPABILITY_COMPATIBILITY_MARKER_RE.test(t)) return false;
  return (
    MODEL_AVAILABILITY_MARKER_RE.test(t) ||
    MODEL_ACCESS_DIRECT_MARKER_RE.test(t) ||
    MODEL_ACCESS_ACTION_MARKER_RE.test(t) ||
    MODEL_ACCESS_MODEL_MARKER_RE.test(t) ||
    MODEL_VERIFICATION_MARKER_RE.test(t)
  );
}

function isKnownCompatibilityFallbackMessage(message) {
  const t = normalizeString(message).toLowerCase();
  if (!t) return false;
  return (
    MODEL_CAPABILITY_COMPATIBILITY_MARKER_RE.test(t) ||
    COMPAT_UNKNOWN_FIELD_RE.test(t) ||
    COMPAT_FIELD_PROBLEM_RE.test(t) ||
    COMPAT_FEATURE_PROBLEM_RE.test(t) ||
    COMPAT_UNSUPPORTED_FEATURE_RE.test(t) ||
    COMPAT_ADDITIONAL_PROPERTIES_RE.test(t) ||
    COMPAT_INVALID_BLOCK_TYPE_RE.test(t)
  );
}

function isCompatibilityFallbackError(errOrStatus, detail) {
  const rawStatus = errOrStatus && typeof errOrStatus === "object" ? errOrStatus.status : errOrStatus;
  if (!isInvalidRequestStatusForFallback(rawStatus)) return false;
  const text = normalizeString(detail) || (errOrStatus instanceof Error ? errOrStatus.message : normalizeString(errOrStatus?.message));
  if (isAuthenticationLikeErrorMessage(text) || isAccountOrQuotaLikeErrorMessage(text) || isModelAvailabilityLikeErrorMessage(text)) return false;
  return isKnownCompatibilityFallbackMessage(text);
}

function makeToolMetaGetter(toolMetaByName) {
  const map = toolMetaByName instanceof Map ? toolMetaByName : null;
  return (toolName) => {
    if (!map) return { mcpServerName: undefined, mcpToolName: undefined };
    const meta = map.get(toolName);
    return meta && typeof meta === "object" ? meta : { mcpServerName: undefined, mcpToolName: undefined };
  };
}

async function assertSseResponse(resp, { label, expectedHint, previewChars } = {}) {
  const contentType = normalizeString(resp?.headers?.get?.("content-type")).toLowerCase();
  if (contentType.includes("text/event-stream")) return;
  const lim = Number.isFinite(Number(previewChars)) && Number(previewChars) > 0 ? Number(previewChars) : 500;
  const detail = await readHttpErrorDetail(resp, { maxChars: lim });
  const hint = normalizeString(expectedHint) ? `；${String(expectedHint).trim()}` : "";
  throw new Error(`${normalizeString(label) || "SSE"} 响应不是 SSE（content-type=${contentType || "unknown"}）${hint}；detail: ${detail}`.trim());
}

module.exports = {
  normalizeUsageInt,
  applyParallelToolCallsPolicy,
  isInvalidRequestStatusForFallback,
  isAuthenticationLikeErrorMessage,
  isAccountOrQuotaLikeErrorMessage,
  isModelAvailabilityLikeErrorMessage,
  isKnownCompatibilityFallbackMessage,
  isCompatibilityFallbackError,
  makeToolMetaGetter,
  assertSseResponse
};
