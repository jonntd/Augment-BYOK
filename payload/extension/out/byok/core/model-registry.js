"use strict";

const { normalizeString, parseByokModelId } = require("../infra/util");

function safeParseJsonObject(raw) {
  try {
    const v = JSON.parse(typeof raw === "string" ? raw : "");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function pickFirstString(obj, keys) {
  const o = obj && typeof obj === "object" ? obj : {};
  for (const k of Array.isArray(keys) ? keys : []) {
    const v = o[k];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

function normalizeByokModelIds(byokModelIds) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(byokModelIds) ? byokModelIds : []) {
    const id = normalizeString(raw);
    if (!id || seen.has(id) || !parseByokModelId(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function filterRegistryByokOnly(registry) {
  const src = registry && typeof registry === "object" && !Array.isArray(registry) ? registry : {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    const id = normalizeString(v);
    if (!parseByokModelId(id)) continue;
    out[k] = id;
  }
  return out;
}

function filterInfoRegistryByokOnly(infoRegistry) {
  const src = infoRegistry && typeof infoRegistry === "object" && !Array.isArray(infoRegistry) ? infoRegistry : {};
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    const id = normalizeString(k);
    if (!parseByokModelId(id)) continue;
    out[id] = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  }
  return out;
}

function pickByokAgentChatModel({ agentChatModel, defaultModel, existingAgent, ids } = {}) {
  const candidates = [agentChatModel, defaultModel, existingAgent, ...(Array.isArray(ids) ? ids : [])];
  for (const raw of candidates) {
    const id = normalizeString(raw);
    if (parseByokModelId(id)) return id;
  }
  return "";
}

function pickFraudSignEndpointsFlag(flags) {
  if (typeof flags?.fraud_sign_endpoints === "boolean") return flags.fraud_sign_endpoints;
  if (typeof flags?.fraudSignEndpoints === "boolean") return flags.fraudSignEndpoints;
  return false;
}

function ensureModelRegistryFeatureFlags(existingFlags, { byokModelIds, defaultModel, agentChatModel } = {}) {
  const flags =
    existingFlags && typeof existingFlags === "object" && !Array.isArray(existingFlags) ? { ...existingFlags } : {};

  const ids = normalizeByokModelIds(byokModelIds);
  const dm = normalizeString(defaultModel) || ids[0] || "";
  const registry = filterRegistryByokOnly(safeParseJsonObject(pickFirstString(flags, ["model_registry", "modelRegistry"])));
  const infoRegistry = filterInfoRegistryByokOnly(safeParseJsonObject(pickFirstString(flags, ["model_info_registry", "modelInfoRegistry"])));

  for (const raw of ids) {
    const parsed = parseByokModelId(raw);
    const displayName = `${parsed.providerId}: ${parsed.modelId}`;
    if (!registry[displayName]) registry[displayName] = raw;
    if (!infoRegistry[raw]) infoRegistry[raw] = { description: "", disabled: false, displayName, shortName: displayName };
  }

  const registryJson = JSON.stringify(registry);
  const infoRegistryJson = JSON.stringify(infoRegistry);
  const existingAgent = pickFirstString(flags, ["agent_chat_model", "agentChatModel"]);
  const acm = pickByokAgentChatModel({ agentChatModel, defaultModel: dm, existingAgent, ids });

  flags.additional_chat_models = registryJson;
  flags.additionalChatModels = registryJson;
  flags.agent_chat_model = acm;
  flags.agentChatModel = acm;
  flags.enable_model_registry = true;
  flags.enableModelRegistry = true;
  flags.model_registry = registryJson;
  flags.modelRegistry = registryJson;
  flags.model_info_registry = infoRegistryJson;
  flags.modelInfoRegistry = infoRegistryJson;
  flags.show_thinking_summary = true;
  flags.showThinkingSummary = true;

  // Restore official Agent Auto toggle in chat (webview: isAgentic && enableAgentAutoMode).
  // Without this, BYOK/local defaults leave the flag undefined → ?? false → Auto button hidden.
  flags.enable_agent_auto_mode = true;
  flags.enableAgentAutoMode = true;

  const fraudSign = pickFraudSignEndpointsFlag(flags);
  flags.fraud_sign_endpoints = fraudSign;
  flags.fraudSignEndpoints = fraudSign;

  return flags;
}

module.exports = { ensureModelRegistryFeatureFlags };
