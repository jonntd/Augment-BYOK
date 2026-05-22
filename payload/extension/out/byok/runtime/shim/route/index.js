"use strict";

const { audit } = require("../../../infra/log");
const { ensureConfigManager, state } = require("../../../config/state");
const { decideRoute } = require("../../../core/router");
const { normalizeEndpoint, normalizeString, randomId } = require("../../../infra/util");
const { normalizeTimeoutMs, formatRouteForLog } = require("../common");

function normalizeSupportedEndpoints(supportedEndpoints) {
  const list = Array.isArray(supportedEndpoints) ? supportedEndpoints : [];
  const out = new Set();
  for (const it of list) {
    const ep = normalizeEndpoint(it);
    if (ep) out.add(ep);
  }
  return out;
}

function constrainByokRouteToSupportedEndpoint(route, supportedEndpoints) {
  const r = route && typeof route === "object" ? route : null;
  if (!r || r.mode !== "byok") return r;

  const supported = normalizeSupportedEndpoints(supportedEndpoints);
  if (!supported.size || supported.has(normalizeEndpoint(r.endpoint))) return r;

  return {
    mode: "official",
    endpoint: normalizeEndpoint(r.endpoint),
    reason: "unsupported_byok_endpoint",
    providerId: normalizeString(r.providerId),
    requestedModel: normalizeString(r.requestedModel)
  };
}

async function resolveByokRouteContext({ endpoint, body, timeoutMs, logPrefix, supportedEndpoints }) {
  const requestId = randomId();
  const ep = normalizeEndpoint(endpoint);
  if (!ep) return { requestId, ep: "", timeoutMs: 0, cfg: null, route: null, runtimeEnabled: false };

  const t = normalizeTimeoutMs(timeoutMs);

  if (!state.runtimeEnabled) return { requestId, ep, timeoutMs: t, cfg: null, route: null, runtimeEnabled: false };

  const cfgMgr = ensureConfigManager();
  const cfg = cfgMgr.get();

  const rawRoute = decideRoute({ cfg, endpoint: ep, body, runtimeEnabled: state.runtimeEnabled });
  const route = constrainByokRouteToSupportedEndpoint(rawRoute, supportedEndpoints);
  audit(`[${String(logPrefix || "callApi")}] ${formatRouteForLog(route, { requestId })}`);
  return { requestId, ep, timeoutMs: t, cfg, route, runtimeEnabled: true };
}

module.exports = { resolveByokRouteContext };
