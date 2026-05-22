"use strict";

const { normalizeRawToken, normalizeSecretValue, isAuthHeaderName } = require("../infra/util");

function withJsonContentType(headers) {
  return { "content-type": "application/json", ...(headers && typeof headers === "object" ? headers : {}) };
}

function stripPlaceholderAuthHeaders(headers) {
  const out = { ...(headers && typeof headers === "object" ? headers : {}) };
  for (const key of Object.keys(out)) {
    if (!isAuthHeaderName(key)) continue;
    if (normalizeSecretValue(out[key])) continue;
    delete out[key];
  }
  return out;
}

function openAiAuthHeaders(apiKey, extraHeaders) {
  const key = normalizeRawToken(apiKey);
  const headers = stripPlaceholderAuthHeaders(extraHeaders);
  const hasAuthHeader = Object.keys(headers).some((k) => String(k || "").trim().toLowerCase() === "authorization");
  if (!hasAuthHeader && key) headers.authorization = `Bearer ${key}`;
  return headers;
}

function anthropicAuthHeaders(apiKey, extraHeaders, opts) {
  const key = normalizeRawToken(apiKey);
  const forceBearer = opts && typeof opts === "object" ? Boolean(opts.forceBearer) : false;
  const headers = stripPlaceholderAuthHeaders(extraHeaders);
  const lowerKeys = new Set(Object.keys(headers).map((k) => String(k || "").trim().toLowerCase()));
  if (!lowerKeys.has("x-api-key") && key) headers["x-api-key"] = key;
  if (!lowerKeys.has("anthropic-version")) headers["anthropic-version"] = "2023-06-01";
  if (forceBearer && !lowerKeys.has("authorization") && key) headers.authorization = `Bearer ${key}`;
  return headers;
}


module.exports = { withJsonContentType, openAiAuthHeaders, anthropicAuthHeaders };
