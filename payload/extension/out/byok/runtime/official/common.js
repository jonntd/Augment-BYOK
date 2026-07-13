"use strict";

const { warn } = require("../../infra/log");
const { getOfficialConnection } = require("../../config/official");
const { normalizeString, normalizeRawToken } = require("../../infra/util");
const augmentChatShared = require("../../core/augment-chat/shared");
const { REQUEST_NODE_TEXT, REQUEST_NODE_TOOL_RESULT } = require("../../core/augment-protocol");

const OFFICIAL_CONTEXT_SKIP_WARNED = new Set();

function makeTextRequestNode({ id, text }) {
  return { id: Number(id) || 0, type: REQUEST_NODE_TEXT, content: "", text_node: { content: String(text || "") } };
}

function countNonToolRequestNodes(req) {
  const nodes = [
    ...(Array.isArray(req?.nodes) ? req.nodes : []),
    ...(Array.isArray(req?.structured_request_nodes) ? req.structured_request_nodes : []),
    ...(Array.isArray(req?.request_nodes) ? req.request_nodes : [])
  ];
  let n = 0;
  for (const node of nodes) if (augmentChatShared.normalizeNodeType(node) !== REQUEST_NODE_TOOL_RESULT) n += 1;
  return n;
}

function maybeInjectUserExtraTextParts({ req, target, startId }) {
  if (!req || typeof req !== "object") return false;
  if (!Array.isArray(target)) return false;
  if (countNonToolRequestNodes(req) > 0) return false;
  let id = Number.isFinite(Number(startId)) ? Number(startId) : -30;
  for (const part of augmentChatShared.buildUserExtraTextParts(req, { hasNodes: false })) {
    const s = normalizeString(part);
    if (!s) continue;
    target.push(makeTextRequestNode({ id, text: s.trim() }));
    id -= 1;
  }
  return true;
}

function pickInjectionTargetArray(req) {
  if (Array.isArray(req?.request_nodes) && req.request_nodes.length) return req.request_nodes;
  if (Array.isArray(req?.structured_request_nodes) && req.structured_request_nodes.length) return req.structured_request_nodes;
  if (Array.isArray(req?.nodes) && req.nodes.length) return req.nodes;
  if (Array.isArray(req?.nodes)) return req.nodes;
  return null;
}

function warnOfficialContextSkippedOnce(feature, missing) {
  const f = normalizeString(feature) || "official-context";
  const m = Array.isArray(missing) ? missing.filter(Boolean).join(",") : "";
  const key = `${f}:${m}`;
  if (OFFICIAL_CONTEXT_SKIP_WARNED.has(key)) return;
  OFFICIAL_CONTEXT_SKIP_WARNED.add(key);
  warn(
    `official context injection skipped: degraded=true feature=${f} missing=${m || "unknown"} network=skipped; BYOK chat continues without this official context. Configure official.completionUrl and official.apiToken (register: https://acemcp.heroman.wtf/login), or set disable_retrieval=true if this is intentional.`
  );
}

function isOfficialContextDisabled(req) {
  if (req && typeof req === "object" && (req.disable_retrieval === true || req.disableRetrieval === true)) return true;
  // Config-level kill switch for Context Engine auto-injection (keeps official token usable for /get-models).
  try {
    return getOfficialConnection().disableContextInjection === true;
  } catch {
    return false;
  }
}

function normalizeUpstreamCompletionURL(value) {
  const direct = normalizeString(value);
  if (direct) return direct;
  if (!value || typeof value !== "object") return "";

  // The upstream shim may pass a WHATWG URL object. Coerce it here, after the
  // runtime-enabled gate, so disabled/rollback paths still have no BYOK side effects.
  return normalizeString(value.href);
}

function resolveOfficialContextConnection({ feature, upstreamCompletionURL, upstreamApiToken } = {}) {
  const off = getOfficialConnection();
  const completionURL = normalizeUpstreamCompletionURL(upstreamCompletionURL) || off.completionURL;
  const apiToken = normalizeRawToken(upstreamApiToken) || off.apiToken;
  if (completionURL && apiToken) return { completionURL, apiToken };

  const missing = [];
  if (!completionURL) missing.push("official.completionUrl");
  if (!apiToken) missing.push("official.apiToken");
  warnOfficialContextSkippedOnce(feature, missing);
  return null;
}

module.exports = {
  makeTextRequestNode,
  pickInjectionTargetArray,
  maybeInjectUserExtraTextParts,
  isOfficialContextDisabled,
  normalizeUpstreamCompletionURL,
  resolveOfficialContextConnection
};
