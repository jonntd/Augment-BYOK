"use strict";

function normalizeString(v) {
  if (typeof v !== "string") return "";
  const s = v.trim();
  return s ? s : "";
}

function isPlaceholderSecretValue(v) {
  const s = normalizeString(v);
  if (!s) return true;
  if (/^(Bearer|Basic)$/i.test(s) || s === "Token") return true;
  let lower = s.toLowerCase();
  if (lower === "<redacted>" || lower === "(redacted)" || lower === "(set)") return true;
  lower = s.replace(/^(Bearer|Basic)\s+/i, "").trim().toLowerCase();
  return !lower || lower === "<redacted>" || lower === "(redacted)" || lower === "(set)";
}

function normalizeSecretValue(v) {
  const s = normalizeString(v);
  if (!s || isPlaceholderSecretValue(s)) return "";
  return s;
}

function normalizeStringList(raw, { maxItems } = {}) {
  const lim = Number.isFinite(Number(maxItems)) && Number(maxItems) > 0 ? Math.floor(Number(maxItems)) : 200;
  const out = [];
  const seen = new Set();
  const list = Array.isArray(raw) ? raw : [];
  for (const v of list) {
    const s = typeof v === "string" ? normalizeString(v) : "";
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= lim) break;
  }
  return out;
}

const AUTH_HEADER_NAME_PATTERNS = [
  /^authorization$/,
  /^proxy-authorization$/,
  /^x-goog-api-key$/,
  /^(?:x-)?api[-_]?key$/,
  /^(?:x-)?api[-_]?token$/,
  /(?:^|[-_])auth$/,
  /(?:^|[-_])authentication$/,
  /(?:^|[-_])auth[-_]?token$/,
  /(?:^|[-_])auth[-_]?key$/,
  /(?:^|[-_])access[-_]?token$/,
  /(?:^|[-_])refresh[-_]?token$/,
  /(?:^|[-_])client[-_]?secret$/,
  /(?:^|[-_])credential$/,
  /(?:^|[-_])secret$/,
  /(?:^|[-_])password$/,
  /^passwd$/,
  /^cookie$/,
  /^set-cookie$/
];

function isAuthHeaderName(rawKey) {
  const key = normalizeString(rawKey).toLowerCase();
  if (!key) return false;
  return AUTH_HEADER_NAME_PATTERNS.some((re) => re.test(key));
}

function hasAuthHeader(headers) {
  const h = headers && typeof headers === "object" && !Array.isArray(headers) ? headers : {};
  for (const [rawKey, rawValue] of Object.entries(h)) {
    if (isAuthHeaderName(rawKey) && normalizeSecretValue(rawValue)) return true;
  }
  return false;
}

function requireString(v, label) {
  const s = normalizeString(v);
  if (!s) throw new Error(`${label} 未配置`);
  return s;
}

function normalizeEndpoint(endpoint) {
  const raw = normalizeString(endpoint);
  if (!raw) return "";

  try {
    const u = new URL(raw);
    return normalizeEndpoint(u.pathname);
  } catch {}

  let p = raw;
  const q = p.indexOf("?");
  if (q >= 0) p = p.slice(0, q);
  if (!p.startsWith("/")) p = "/" + p;
  return p;
}

function normalizeRawToken(token) {
  let t = normalizeSecretValue(token);
  if (!t) return "";
  t = t.replace(/^(Bearer|Basic)\s+/i, "").trim();
  const eq = t.indexOf("=");
  if (eq > 0 && eq < t.length - 1) {
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    const looksLikeEnv =
      k &&
      v &&
      /^[A-Z0-9_]+$/.test(k) &&
      (k.endsWith("_TOKEN") || k.endsWith("_API_TOKEN") || k.endsWith("_KEY") || k.endsWith("_API_KEY"));
    if (looksLikeEnv) t = v;
  }
  if (isPlaceholderSecretValue(t)) return "";
  return t;
}

function parseByokModelId(modelId, opts) {
  const raw = normalizeString(modelId);
  if (!raw.startsWith("byok:")) return null;
  const strict = opts && typeof opts === "object" ? Boolean(opts.strict) : false;
  const rest = raw.slice("byok:".length);
  const idx = rest.indexOf(":");
  if (idx <= 0 || idx >= rest.length - 1) {
    if (strict) throw new Error(`BYOK model 格式错误: ${raw}`);
    return null;
  }
  const providerId = normalizeString(rest.slice(0, idx));
  const innerModelId = normalizeString(rest.slice(idx + 1));
  if (!providerId || !innerModelId) {
    if (strict) throw new Error(`BYOK model 格式错误: ${raw}`);
    return null;
  }
  return { providerId, modelId: innerModelId };
}

function utf8ByteLen(value) {
  const s = typeof value === "string" ? value : String(value ?? "");
  try {
    // eslint-disable-next-line node/no-unsupported-features/node-builtins
    if (typeof Buffer !== "undefined" && Buffer && typeof Buffer.byteLength === "function") return Buffer.byteLength(s, "utf8");
  } catch {}
  return s.length;
}

function safeTransform(transform, raw, label) {
  if (typeof transform !== "function") return raw;
  try {
    return transform(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const e = new Error(`transform failed${label ? ` (${label})` : ""}: ${msg}`.trim());
    e.cause = err;
    throw e;
  }
}

function stripByokInternalKeys(obj) {
  const raw = obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  const keys = Object.keys(raw);
  const hasInternal = keys.some((k) => k && typeof k === "string" && k.startsWith("__byok"));
  if (!hasInternal) return raw;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k && typeof k === "string" && k.startsWith("__byok")) continue;
    out[k] = v;
  }
  return out;
}

function stripUpstreamProviderOverrideKeys(obj) {
  const raw = obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  const hasOverride =
    Object.prototype.hasOwnProperty.call(raw, "third_party_override") ||
    Object.prototype.hasOwnProperty.call(raw, "thirdPartyOverride");
  if (!hasOverride) return raw;

  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "third_party_override" || k === "thirdPartyOverride") continue;
    out[k] = v;
  }
  return out;
}

async function* emptyAsyncGenerator() {}

function randomId() {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  try {
    // eslint-disable-next-line node/no-unsupported-features/node-builtins
    const nodeCrypto = require("crypto");
    if (typeof nodeCrypto.randomUUID === "function") return nodeCrypto.randomUUID();
  } catch {}
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

module.exports = {
  normalizeString,
  normalizeSecretValue,
  isAuthHeaderName,
  normalizeStringList,
  hasAuthHeader,
  requireString,
  normalizeEndpoint,
  normalizeRawToken,
  parseByokModelId,
  utf8ByteLen,
  safeTransform,
  stripByokInternalKeys,
  stripUpstreamProviderOverrideKeys,
  emptyAsyncGenerator,
  randomId
};
