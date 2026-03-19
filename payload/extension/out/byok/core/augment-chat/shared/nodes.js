"use strict";

const { normalizeString } = require("../../../infra/util");
const {
  REQUEST_NODE_TEXT,
  REQUEST_NODE_TOOL_RESULT,
  REQUEST_NODE_IMAGE,
  REQUEST_NODE_IMAGE_ID,
  REQUEST_NODE_IDE_STATE,
  REQUEST_NODE_EDIT_EVENTS,
  REQUEST_NODE_CHECKPOINT_REF,
  REQUEST_NODE_CHANGE_PERSONALITY,
  REQUEST_NODE_FILE,
  REQUEST_NODE_FILE_ID,
  REQUEST_NODE_HISTORY_SUMMARY,
  RESPONSE_NODE_RAW_RESPONSE,
  RESPONSE_NODE_MAIN_TEXT_FINISHED,
  RESPONSE_NODE_TOOL_USE,
  RESPONSE_NODE_TOOL_USE_START,
  TOOL_RESULT_CONTENT_TEXT,
  TOOL_RESULT_CONTENT_IMAGE,
  IMAGE_FORMAT_JPEG,
  IMAGE_FORMAT_GIF,
  IMAGE_FORMAT_WEBP
} = require("../../augment-protocol");
const { asRecord, asArray, asString, pick, normalizeNodeType } = require("../../augment-struct");
const {
  formatIdeStateForPrompt,
  formatEditEventsForPrompt,
  formatCheckpointRefForPrompt,
  formatChangePersonalityForPrompt,
  formatImageIdForPrompt,
  formatFileIdForPrompt,
  formatFileNodeForPrompt,
  formatHistorySummaryForPrompt
} = require("../../augment-node-format");

const TOOL_RESULT_SYSTEM_HINT_SEPARATORS = [
  "\n\n✔️请记住",
  "\n\n❌请记住",
  "✔️请记住",
  "❌请记住"
];

function splitToolResultSystemHint(text) {
  const raw = String(text ?? "");
  const normalized = raw.replace(/\s+$/u, "");
  for (const sep of TOOL_RESULT_SYSTEM_HINT_SEPARATORS) {
    const idx = sep.startsWith("\n\n") ? normalized.lastIndexOf(sep) : normalized.startsWith(sep) ? 0 : -1;
    if (idx === -1) continue;
    return {
      userText: normalized.slice(0, idx).trim(),
      systemHint: normalized.slice(idx).trim(),
      separator: sep
    };
  }
  return { userText: normalized.trim(), systemHint: "", separator: "" };
}

function stripToolResultSystemHint(text) {
  return splitToolResultSystemHint(text).userText;
}

function isPlaceholderMessage(message) {
  const s = String(message || "").trim();
  if (!s) return false;
  if (s.length > 16) return false;
  for (const ch of s) if (ch !== "-") return false;
  return true;
}

function mapImageFormatToMimeType(format) {
  const f = Number(format);
  if (f === IMAGE_FORMAT_JPEG) return "image/jpeg";
  if (f === IMAGE_FORMAT_GIF) return "image/gif";
  if (f === IMAGE_FORMAT_WEBP) return "image/webp";
  return "image/png";
}

function buildUserSegmentsFromRequest(message, nodes) {
  const segments = [];
  let lastText = null;
  const pushText = (text) => {
    const trimmed = String(text || "").trim();
    if (!trimmed || isPlaceholderMessage(trimmed)) return;
    if (lastText === trimmed) return;
    segments.push({ kind: "text", text: String(text) });
    lastText = trimmed;
  };
  pushText(message);
  for (const node of asArray(nodes)) {
    const r = asRecord(node);
    const t = normalizeNodeType(r);
    if (t === REQUEST_NODE_TEXT) {
      const tn = asRecord(pick(r, ["text_node", "textNode"]));
      pushText(pick(tn, ["content"]));
    } else if (t === REQUEST_NODE_TOOL_RESULT) {
      continue;
    } else if (t === REQUEST_NODE_IMAGE) {
      const img = asRecord(pick(r, ["image_node", "imageNode"]));
      const data = normalizeString(pick(img, ["image_data", "imageData"]));
      if (!data) continue;
      segments.push({ kind: "image", media_type: mapImageFormatToMimeType(pick(img, ["format"])), data });
      lastText = null;
    } else if (t === REQUEST_NODE_IMAGE_ID) pushText(formatImageIdForPrompt(pick(r, ["image_id_node", "imageIdNode"])));
    else if (t === REQUEST_NODE_IDE_STATE) pushText(formatIdeStateForPrompt(pick(r, ["ide_state_node", "ideStateNode"])));
    else if (t === REQUEST_NODE_EDIT_EVENTS) pushText(formatEditEventsForPrompt(pick(r, ["edit_events_node", "editEventsNode"])));
    else if (t === REQUEST_NODE_CHECKPOINT_REF) pushText(formatCheckpointRefForPrompt(pick(r, ["checkpoint_ref_node", "checkpointRefNode"])));
    else if (t === REQUEST_NODE_CHANGE_PERSONALITY) pushText(formatChangePersonalityForPrompt(pick(r, ["change_personality_node", "changePersonalityNode"])));
    else if (t === REQUEST_NODE_FILE) pushText(formatFileNodeForPrompt(pick(r, ["file_node", "fileNode"])));
    else if (t === REQUEST_NODE_FILE_ID) pushText(formatFileIdForPrompt(pick(r, ["file_id_node", "fileIdNode"])));
    else if (t === REQUEST_NODE_HISTORY_SUMMARY) pushText(formatHistorySummaryForPrompt(pick(r, ["history_summary_node", "historySummaryNode"])));
  }
  return segments;
}

function collectExchangeRequestNodes(exchange) {
  const ex = asRecord(exchange);
  return [...asArray(pick(ex, ["request_nodes", "requestNodes"])), ...asArray(pick(ex, ["structured_request_nodes", "structuredRequestNodes"])), ...asArray(pick(ex, ["nodes"]))];
}

function collectExchangeOutputNodes(exchange) {
  const ex = asRecord(exchange);
  return [...asArray(pick(ex, ["response_nodes", "responseNodes"])), ...asArray(pick(ex, ["structured_output_nodes", "structuredOutputNodes"]))];
}

function buildTextOrPartsFromSegments(segments, opts) {
  const segs = asArray(segments);
  if (!segs.length) return null;
  const hasImage = segs.some((s) => s && typeof s === "object" && s.kind === "image");
  if (!hasImage) {
    const parts = segs
      .filter((s) => s && typeof s === "object" && s.kind === "text")
      .map((s) => String(s.text || "").trim())
      .filter(Boolean);
    const text = parts.join("\n\n").trim();
    return text ? text : null;
  }

  const makeTextPart = typeof opts?.makeTextPart === "function" ? opts.makeTextPart : (text) => ({ type: "text", text });
  const makeImagePart =
    typeof opts?.makeImagePart === "function"
      ? opts.makeImagePart
      : ({ data, media_type }) => ({ type: "image_url", image_url: { url: `data:${media_type};base64,${data}` } });

  const out = [];
  let textBuf = "";
  const flushText = () => {
    const t = textBuf.trim();
    if (t) out.push(makeTextPart(t));
    textBuf = "";
  };

  for (const s of segs) {
    if (!s || typeof s !== "object") continue;
    if (s.kind === "text") {
      const t = String(s.text || "").trim();
      if (!t) continue;
      if (textBuf) textBuf += "\n\n";
      textBuf += t;
    } else if (s.kind === "image") {
      flushText();
      const data = normalizeString(s.data);
      if (!data) continue;
      const media_type = normalizeString(s.media_type) || "image/png";
      out.push(makeImagePart({ data, media_type, segment: s }));
    }
  }
  flushText();
  return out.length ? out : null;
}

function summarizeToolResultText(fallbackText, contentNodes) {
  const nodes = asArray(contentNodes);
  const parts = [];
  let lastText = "";
  for (const n of nodes) {
    const r = asRecord(n);
    const t = Number(pick(r, ["type", "node_type", "nodeType"]));
    if (t === TOOL_RESULT_CONTENT_TEXT) {
      const text = normalizeString(pick(r, ["text_content", "textContent"]));
      if (!text || isPlaceholderMessage(text)) continue;
      const userText = stripToolResultSystemHint(text);
      if (!userText) continue;
      if (lastText && lastText === userText) continue;
      parts.push(userText);
      lastText = userText;
    } else if (t === TOOL_RESULT_CONTENT_IMAGE) {
      const img = asRecord(pick(r, ["image_content", "imageContent"]));
      const data = normalizeString(pick(img, ["image_data", "imageData"]));
      if (!data) continue;
      parts.push(`[image omitted: format=${Number(pick(img, ["format"])) || 0} bytes≈${Math.floor((data.length * 3) / 4)}]`);
      lastText = "";
    }
  }
  if (parts.length) return parts.join("\n\n").trim();
  return stripToolResultSystemHint(String(fallbackText || "").trim());
}

function extractToolResultTextsFromRequestNodes(nodes) {
  const out = [];
  for (const node of asArray(nodes)) {
    const r = asRecord(node);
    if (normalizeNodeType(r) !== REQUEST_NODE_TOOL_RESULT) continue;
    const tr = asRecord(pick(r, ["tool_result_node", "toolResultNode"]));
    const toolUseId = normalizeString(pick(tr, ["tool_use_id", "toolUseId"]));
    if (!toolUseId) continue;
    const text = summarizeToolResultText(pick(tr, ["content"]), pick(tr, ["content_nodes", "contentNodes"]));
    out.push({ toolUseId, text: normalizeString(text) ? text : "" });
  }
  return out;
}

function extractAssistantTextFromOutputNodes(nodes) {
  const list = asArray(nodes);
  let finished = "";
  let raw = "";
  for (const n of list) {
    const r = asRecord(n);
    const t = normalizeNodeType(r);
    const content = asString(pick(r, ["content"]));
    if (t === RESPONSE_NODE_MAIN_TEXT_FINISHED && normalizeString(content)) finished = content;
    else if (t === RESPONSE_NODE_RAW_RESPONSE && content) raw += content;
  }
  return normalizeString(finished) ? finished.trim() : raw.trim();
}

function extractToolCallsFromOutputNodes(nodes) {
  const list = asArray(nodes);
  const toolUse = [];
  const toolUseStart = [];
  for (const n of list) {
    const r = asRecord(n);
    const t = normalizeNodeType(r);
    if (t === RESPONSE_NODE_TOOL_USE) toolUse.push(r);
    else if (t === RESPONSE_NODE_TOOL_USE_START) toolUseStart.push(r);
  }
  const chosen = toolUse.length ? toolUse : toolUseStart;
  const seen = new Set();
  const out = [];
  for (const n of chosen) {
    const tu = asRecord(pick(n, ["tool_use", "toolUse"]));
    const toolName = normalizeString(pick(tu, ["tool_name", "toolName"]));
    if (!toolName) continue;
    let id = normalizeString(pick(tu, ["tool_use_id", "toolUseId"]));
    if (!id) {
      const nodeId = Number(pick(n, ["id"]));
      const hint = toolName.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 48) || "tool";
      const suffix = Number.isFinite(nodeId) && nodeId > 0 ? String(Math.floor(nodeId)) : String(out.length + 1);
      id = `tool-${hint}-${suffix}`;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    const args = normalizeString(pick(tu, ["input_json", "inputJson"])) || "{}";
    out.push({ id, type: "function", function: { name: toolName, arguments: args } });
  }
  return out;
}

module.exports = {
  isPlaceholderMessage,
  mapImageFormatToMimeType,
  buildUserSegmentsFromRequest,
  collectExchangeRequestNodes,
  collectExchangeOutputNodes,
  buildTextOrPartsFromSegments,
  splitToolResultSystemHint,
  stripToolResultSystemHint,
  summarizeToolResultText,
  extractToolResultTextsFromRequestNodes,
  extractAssistantTextFromOutputNodes,
  extractToolCallsFromOutputNodes
};
