"use strict";

const { warn } = require("../../../infra/log");
const { withTiming } = require("../../../infra/trace");
const { normalizeString, normalizeRawToken, safeTransform, stripUpstreamProviderOverrideKeys } = require("../../../infra/util");
const { getOfficialConnection } = require("../../../config/official");
const { fetchOfficialGetModels } = require("../../official/get-models");
const { normalizeUpstreamCompletionURL } = require("../../official/common");
const { ensureModelRegistryFeatureFlags } = require("../../../core/model-registry");
const {
  makeBackCompletionResult,
  buildByokModelsFromConfig,
  makeBackGetModelsResult,
  makeModelInfo
} = require("../../../core/protocol");
const { byokCompleteText } = require("../byok-text");
const { byokChat } = require("../byok-chat");
const { resolveByokRouteContext } = require("../route");
const { resolveByokTextPromptContext } = require("../text-assembly");
const { providerLabel } = require("../common");
const { rememberUpstreamCallHost } = require("../../upstream/discovery");

const GET_MODELS_OFFICIAL_SKIP_WARNED = new Set();

function buildLocalGetModelsResult({ defaultModel, byokModels }) {
  return makeBackGetModelsResult({ defaultModel, models: byokModels.map(makeModelInfo) });
}

function warnGetModelsOfficialSkippedOnce({ requestId, missing }) {
  const list = Array.isArray(missing) ? missing.filter(Boolean) : [];
  const key = list.join(",") || "unknown";
  if (GET_MODELS_OFFICIAL_SKIP_WARNED.has(key)) return;
  GET_MODELS_OFFICIAL_SKIP_WARNED.add(key);
  warn(
    "get-models official fetch skipped: degraded=true network=skipped; using local BYOK model registry only. Configure official.apiToken after registering at https://acemcp.heroman.wtf/login.",
    { requestId, missing: list.length ? list : ["unknown"] }
  );
}

async function handleGetModels({ cfg, ep, transform, abortSignal, timeoutMs, upstreamApiToken, upstreamCompletionURL, requestId }) {
  const byokModels = buildByokModelsFromConfig(cfg);
  const defaultModel = byokModels.length ? byokModels[0] : "";

  try {
    const off = getOfficialConnection();
    const completionURL = normalizeUpstreamCompletionURL(upstreamCompletionURL) || off.completionURL;
    const apiToken = normalizeRawToken(upstreamApiToken) || off.apiToken;
    if (!completionURL || !apiToken) {
      const missing = [];
      if (!completionURL) missing.push("official.completionUrl");
      if (!apiToken) missing.push("official.apiToken");
      warnGetModelsOfficialSkippedOnce({ requestId, missing });
      return safeTransform(transform, buildLocalGetModelsResult({ defaultModel, byokModels }), ep);
    }

    const upstream = await withTiming(`[callApi ${ep}] rid=${requestId} official/get-models`, async () =>
      await fetchOfficialGetModels({ completionURL, apiToken, timeoutMs: Math.min(12000, timeoutMs), abortSignal })
    );
    const base = upstream && typeof upstream === "object" ? upstream : {};
    const baseFlags = base.feature_flags && typeof base.feature_flags === "object" && !Array.isArray(base.feature_flags) ? base.feature_flags : {};
    const scrubbedFlags = { ...baseFlags };
    delete scrubbedFlags.additional_chat_models;
    delete scrubbedFlags.additionalChatModels;
    delete scrubbedFlags.model_registry;
    delete scrubbedFlags.modelRegistry;
    delete scrubbedFlags.model_info_registry;
    delete scrubbedFlags.modelInfoRegistry;

    const flags = ensureModelRegistryFeatureFlags(scrubbedFlags, { byokModelIds: byokModels, defaultModel, agentChatModel: defaultModel });
    const models = byokModels.map(makeModelInfo);

    return safeTransform(transform, { ...base, default_model: defaultModel, models, feature_flags: flags }, ep);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn("get-models fallback to local", { requestId, error: msg });
    return safeTransform(transform, buildLocalGetModelsResult({ defaultModel, byokModels }), ep);
  }
}

async function completeTextForEndpoint({ cfg, route, ep, body, timeoutMs, abortSignal, requestId, kind }) {
  const { system, messages, delegatedSource } = await resolveByokTextPromptContext({
    cfg,
    route,
    endpoint: ep,
    body
  });
  const suffix = normalizeString(kind) || "complete";
  const label = `[callApi ${ep}] rid=${requestId} ${suffix} provider=${providerLabel(route.provider)} model=${normalizeString(route.model) || "unknown"}${delegatedSource ? ` delegate=${delegatedSource}` : ""}`;
  return await withTiming(label, async () =>
    await byokCompleteText({ provider: route.provider, model: route.model, system, messages, timeoutMs, abortSignal })
  );
}

async function handleCompletion({ cfg, route, ep, body, transform, timeoutMs, abortSignal, requestId }) {
  const text = await completeTextForEndpoint({ cfg, route, ep, body, timeoutMs, abortSignal, requestId, kind: "complete" });
  return safeTransform(transform, makeBackCompletionResult(text), ep);
}

async function handleChat({ cfg, route, ep, body, transform, timeoutMs, abortSignal, upstreamApiToken, upstreamCompletionURL, requestId }) {
  const out = await byokChat({
    cfg,
    provider: route.provider,
    model: route.model,
    requestedModel: route.requestedModel,
    body,
    timeoutMs,
    abortSignal,
    upstreamCompletionURL,
    upstreamApiToken,
    requestId
  });
  return safeTransform(transform, out, ep);
}

const CALL_API_HANDLERS = {
  "/get-models": handleGetModels,
  "/chat": handleChat,
  "/completion": handleCompletion,
  "/chat-input-completion": handleCompletion
};

const SUPPORTED_CALL_API_ENDPOINTS = Object.freeze(Object.keys(CALL_API_HANDLERS).sort());

async function maybeHandleCallApi({ endpoint, body, transform, timeoutMs, abortSignal, upstreamApiToken, upstreamCompletionURL, upstreamCallHost }) {
  const requestBody = stripUpstreamProviderOverrideKeys(body);
  const { requestId, ep, timeoutMs: t, cfg, route, runtimeEnabled } = await resolveByokRouteContext({
    endpoint,
    body: requestBody,
    timeoutMs,
    logPrefix: "callApi",
    supportedEndpoints: SUPPORTED_CALL_API_ENDPOINTS
  });
  if (!ep) return undefined;
  if (!runtimeEnabled) return undefined;
  rememberUpstreamCallHost(upstreamCallHost, { stream: false });
  if (route.mode === "official") return undefined;
  if (route.mode === "disabled") {
    try {
      return safeTransform(transform, {}, `disabled:${ep}`);
    } catch {
      return {};
    }
  }
  if (route.mode !== "byok") return undefined;

  const handler = CALL_API_HANDLERS[ep];
  if (!handler) return undefined;
  return await handler({ cfg, route, ep, body: requestBody, transform, timeoutMs: t, abortSignal, upstreamApiToken, upstreamCompletionURL, requestId });
}

module.exports = { maybeHandleCallApi, SUPPORTED_CALL_API_ENDPOINTS };
