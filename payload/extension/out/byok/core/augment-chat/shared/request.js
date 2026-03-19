"use strict";

const { normalizeString } = require("../../../infra/util");
const { personaTypeToLabel } = require("../../augment-node-format");
const { asRecord, asArray, asString, pick, normalizeNodeType } = require("../../augment-struct");
const { REQUEST_NODE_TOOL_RESULT } = require("../../augment-protocol");
const nodes = require("./nodes");

const CONTEXT_HISTORY_RULE = `## Context History Tags
Messages may contain <context-history> tags with orphaned tool calls or results from truncated conversation history. These are historical tool interaction records, NOT user messages. Do NOT respond to them as if the user said them. Simply use them as background context if relevant, or ignore them entirely.`;

const TITLE_GENERATION_KEYWORD = "Please provide a clear and concise summary of our conversation so far.";
const SUMMARY_KEYWORD = "IN THIS MODE YOU ONLY ANALYZE THE MESSAGE AND DECIDE IF IT HAS INFORMATION WORTH REMEMBERING";
const UNDERLYING_MODEL_NONE = "";
const UNDERLYING_MODEL_TITLE_GENERATION = "title_generation";
const UNDERLYING_MODEL_SUMMARY = "summary";

function parseJsonObjectOrEmpty(json) {
  const raw = normalizeString(json) || "{}";
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {}
  return {};
}

function normalizeChatHistoryItem(raw) {
  const r = asRecord(raw);
  const request_id = asString(pick(r, ["request_id", "requestId", "requestID", "id"]));
  const request_message = asString(pick(r, ["request_message", "requestMessage", "message"]));
  const response_text = asString(pick(r, ["response_text", "responseText", "response", "text"]));
  const request_nodes = asArray(pick(r, ["request_nodes", "requestNodes"]));
  const structured_request_nodes = asArray(pick(r, ["structured_request_nodes", "structuredRequestNodes"]));
  const nodesList = asArray(pick(r, ["nodes"]));
  const response_nodes = asArray(pick(r, ["response_nodes", "responseNodes"]));
  const structured_output_nodes = asArray(pick(r, ["structured_output_nodes", "structuredOutputNodes"]));
  return { request_id, request_message, response_text, request_nodes, structured_request_nodes, nodes: nodesList, response_nodes, structured_output_nodes };
}

function normalizeAugmentChatRequest(body) {
  const b = asRecord(body);
  const rawMessage = asString(pick(b, ["message"]));
  const rawPrompt = asString(pick(b, ["prompt"]));
  const rawInstruction = asString(pick(b, ["instruction"]));
  const useMessage = normalizeString(rawMessage) && !nodes.isPlaceholderMessage(rawMessage);
  const usePrompt = !useMessage && normalizeString(rawPrompt);
  const message = useMessage ? rawMessage : usePrompt ? rawPrompt : rawInstruction;
  const message_source = useMessage ? "message" : usePrompt ? "prompt" : normalizeString(rawInstruction) ? "instruction" : "";
  const conversation_id = asString(pick(b, ["conversation_id", "conversationId", "conversationID"]));
  const chat_history = asArray(pick(b, ["chat_history", "chatHistory"])).map(normalizeChatHistoryItem);
  const blobs = asRecord(pick(b, ["blobs"]));
  const external_source_ids = asArray(pick(b, ["external_source_ids", "externalSourceIds"]));
  const user_guided_blobs = asArray(pick(b, ["user_guided_blobs", "userGuidedBlobs", "user_specified_files", "userSpecifiedFiles"]));
  const disable_auto_external_sources = Boolean(pick(b, ["disable_auto_external_sources", "disableAutoExternalSources"]));
  const disable_retrieval = Boolean(pick(b, ["disable_retrieval", "disableRetrieval"]));
  const context_code_exchange_request_id = asString(pick(b, ["context_code_exchange_request_id", "contextCodeExchangeRequestId"]));
  const tool_definitions = asArray(pick(b, ["tool_definitions", "toolDefinitions"]));
  const nodesList = asArray(pick(b, ["nodes"]));
  const structured_request_nodes = asArray(pick(b, ["structured_request_nodes", "structuredRequestNodes"]));
  const request_nodes = asArray(pick(b, ["request_nodes", "requestNodes"]));
  let agent_memories = asString(pick(b, ["agent_memories", "agentMemories"]));
  if (!normalizeString(agent_memories)) {
    const mi = pick(b, ["memories_info", "memoriesInfo"]);
    if (typeof mi === "string") agent_memories = mi;
    else {
      const r = asRecord(mi);
      const direct = asString(pick(r, ["agent_memories", "agentMemories", "memories", "memory", "text", "content"]));
      if (normalizeString(direct)) agent_memories = direct;
      else {
        const arr = asArray(pick(r, ["items", "memories", "memory"]));
        const joined = arr.map((x) => normalizeString(String(x))).filter(Boolean).join("\n");
        if (normalizeString(joined)) agent_memories = joined;
      }
    }
  }
  const mode = asString(pick(b, ["mode"]));
  const prefix = asString(pick(b, ["prefix"]));
  const selected_code = asString(pick(b, ["selected_code", "selectedCode", "selected_text", "selectedText", "selected_code_snippet", "selectedCodeSnippet"]));
  const disable_selected_code_details = Boolean(pick(b, ["disable_selected_code_details", "disableSelectedCodeDetails"]));
  const suffix = asString(pick(b, ["suffix"]));
  const diff = asString(pick(b, ["diff"]));
  const lang = asString(pick(b, ["lang", "language"]));
  const path = asString(pick(b, ["path"]));
  const user_guidelines = asString(pick(b, ["user_guidelines", "userGuidelines"]));
  const workspace_guidelines = asString(pick(b, ["workspace_guidelines", "workspaceGuidelines"]));
  const persona_type = Number(pick(b, ["persona_type", "personaType"]));
  const silent = Boolean(pick(b, ["silent"]));
  const canvas_id = asString(pick(b, ["canvas_id", "canvasId"]));
  const request_id_override = asString(pick(b, ["request_id_override", "requestIdOverride"]));
  const rules = pick(b, ["rules"]);
  const feature_detection_flags = asRecord(pick(b, ["feature_detection_flags", "featureDetectionFlags"]));
  return { message, message_source, conversation_id, chat_history, blobs, external_source_ids, user_guided_blobs, disable_auto_external_sources, disable_retrieval, context_code_exchange_request_id, tool_definitions, nodes: nodesList, structured_request_nodes, request_nodes, agent_memories, mode, prefix, selected_code, disable_selected_code_details, suffix, diff, lang, path, user_guidelines, workspace_guidelines, persona_type, silent, canvas_id, request_id_override, rules, feature_detection_flags };
}

function coerceRulesText(rules) {
  if (Array.isArray(rules)) return rules.map((x) => normalizeString(String(x))).filter(Boolean).join("\n");
  return normalizeString(rules);
}

function buildInlineCodeContextText(req) {
  if (req && typeof req === "object" && req.disable_selected_code_details === true) return "";
  const prefix = typeof req?.prefix === "string" ? req.prefix : "";
  const selected = typeof req?.selected_code === "string" ? req.selected_code : "";
  const suffix = typeof req?.suffix === "string" ? req.suffix : "";
  return `${prefix}${selected}${suffix}`.trim();
}

function buildUserExtraTextParts(req, { hasNodes } = {}) {
  if (hasNodes) return [];
  if (req && typeof req === "object" && req.message_source === "prompt") return [];
  if (req && typeof req === "object" && req.disable_selected_code_details === true) return [];
  const main = typeof req?.message === "string" ? req.message.trim() : "";
  const out = [];
  const code = buildInlineCodeContextText(req);
  if (normalizeString(code) && code.trim() !== main) out.push(code);
  const diff = typeof req?.diff === "string" ? req.diff.trim() : "";
  if (normalizeString(diff) && diff !== code && diff !== main) out.push(diff);
  return out;
}

function buildUserSegmentsWithExtraText(req, nodesAll) {
  const nodesAllArr = asArray(nodesAll);
  const nonToolNodes = nodesAllArr.filter((n) => normalizeNodeType(n) !== REQUEST_NODE_TOOL_RESULT);
  const extraTextParts = buildUserExtraTextParts(req, { hasNodes: nonToolNodes.length > 0 });
  const segments = nodes.buildUserSegmentsFromRequest(req && typeof req === "object" ? req.message : "", nonToolNodes);
  for (const t of asArray(extraTextParts)) segments.push({ kind: "text", text: String(t ?? "") });
  return segments;
}

function detectUnderlyingModelType(req) {
  const r = req && typeof req === "object" ? req : {};
  if (r.silent !== true) return UNDERLYING_MODEL_NONE;
  const message = normalizeString(r.message);
  if (!message) return UNDERLYING_MODEL_NONE;
  if (message.includes(TITLE_GENERATION_KEYWORD)) return UNDERLYING_MODEL_TITLE_GENERATION;
  if (message.includes(SUMMARY_KEYWORD)) return UNDERLYING_MODEL_SUMMARY;
  return UNDERLYING_MODEL_NONE;
}

function buildSystemPrompt(req) {
  const parts = [];
  const persona = personaTypeToLabel(req && typeof req === "object" ? req.persona_type : 0);
  if (persona && persona !== "DEFAULT") parts.push(`Persona: ${persona}`);

  const userGuidelines = normalizeString(req?.user_guidelines) ? req.user_guidelines.trim() : "";
  if (userGuidelines) parts.push(`${CONTEXT_HISTORY_RULE}\n\n${userGuidelines}`);
  else parts.push(CONTEXT_HISTORY_RULE);

  if (normalizeString(req.workspace_guidelines)) parts.push(req.workspace_guidelines.trim());
  const rulesText = coerceRulesText(req.rules);
  if (rulesText) parts.push(rulesText);
  if (normalizeString(req.agent_memories)) parts.push(req.agent_memories.trim());
  const byokSystem = normalizeString(req.byok_system_prompt ?? req.byokSystemPrompt ?? req.byok_system ?? req.byokSystem);
  if (byokSystem) parts.push(byokSystem.trim());
  if (normalizeString(req.mode).toUpperCase() === "AGENT") parts.push("You are an AI coding assistant with access to tools. Use tools when needed to complete tasks.");
  if (normalizeString(req.lang)) parts.push(`The user is working with ${req.lang.trim()} code.`);
  if (normalizeString(req.path)) parts.push(`Current file path: ${req.path.trim()}`);
  return parts.join("\n\n").trim();
}

module.exports = {
  parseJsonObjectOrEmpty,
  normalizeAugmentChatRequest,
  coerceRulesText,
  buildInlineCodeContextText,
  buildUserExtraTextParts,
  buildUserSegmentsWithExtraText,
  buildSystemPrompt,
  CONTEXT_HISTORY_RULE,
  TITLE_GENERATION_KEYWORD,
  SUMMARY_KEYWORD,
  UNDERLYING_MODEL_NONE,
  UNDERLYING_MODEL_TITLE_GENERATION,
  UNDERLYING_MODEL_SUMMARY,
  detectUnderlyingModelType
};
