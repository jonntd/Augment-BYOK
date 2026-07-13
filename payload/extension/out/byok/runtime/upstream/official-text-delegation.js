"use strict";

const { normalizeEndpoint, normalizeString } = require("../../infra/util");
const { isOfficialExecutionDelegationEndpoint, isOfficialDelegationEndpoint } = require("../../core/official-delegation");
const { normalizeRole, toText } = require("./text-assembly/prompt-utils");
const {
  isObject,
  normalizeDelegationSource,
  auditDelegationHit,
  auditDelegationMiss
} = require("./official-delegation-shared");

function tryFromMessages(rawBody) {
  const candidates = [rawBody?.messages, rawBody?.chat_messages, rawBody?.chatMessages];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate) || candidate.length === 0) continue;

    const systemParts = [];
    const messages = [];
    for (const item of candidate) {
      const r = isObject(item) ? item : {};
      const role = normalizeRole(r.role ?? r.author ?? r.type ?? r.sender);
      if (!role) continue;
      const content = toText(r.content ?? r.text ?? r.message);
      if (!normalizeString(content)) continue;

      if (role === "system") {
        systemParts.push(content);
      } else {
        messages.push({ role, content });
      }
    }

    if (messages.length > 0) {
      return {
        ok: true,
        system: systemParts.join("\n\n").trim(),
        messages,
        source: "upstream.callApiBody.messages"
      };
    }
  }

  return null;
}

function tryFromResponsesInput(rawBody) {
  const input = rawBody?.input;
  if (!Array.isArray(input) || input.length === 0) return null;

  const systemParts = [];
  const instructions = normalizeString(rawBody?.instructions);
  if (instructions) systemParts.push(instructions);

  const messages = [];
  for (const item of input) {
    const r = isObject(item) ? item : {};
    const type = normalizeString(r.type).toLowerCase();
    if (type && type !== "message") continue;

    const role = normalizeRole(r.role ?? r.author ?? r.sender);
    if (!role) continue;
    const content = toText(r.content ?? r.text ?? r.message);
    if (!normalizeString(content)) continue;

    if (role === "system") {
      systemParts.push(content);
    } else {
      messages.push({ role, content });
    }
  }

  if (messages.length > 0) {
    return {
      ok: true,
      system: systemParts.join("\n\n").trim(),
      messages,
      source: "upstream.callApiBody.input"
    };
  }

  return null;
}

function tryFromDeepSearch(rawBody) {
  if (!rawBody || typeof rawBody !== "object") return null;

  const MAX_NODES = 2000;
  const MAX_DEPTH = 6;
  const SKIP_KEYS = new Set([
    "blobs",
    "diff",
    "code_block",
    "target_file_content",
    "targetFileContent",
    "diagnostics",
    "recent_changes",
    "recentChanges",
    "edit_events",
    "editEvents"
  ]);

  const seen = new WeakSet();
  const stack = [{ v: rawBody, depth: 0 }];
  let nodes = 0;

  while (stack.length && nodes < MAX_NODES) {
    const { v, depth } = stack.pop();
    nodes += 1;
    if (!v || typeof v !== "object") continue;

    if (Array.isArray(v)) {
      if (depth >= MAX_DEPTH) continue;
      for (const item of v) stack.push({ v: item, depth: depth + 1 });
      continue;
    }

    if (seen.has(v)) continue;
    seen.add(v);

    const hit = tryFromMessages(v) || tryFromResponsesInput(v);
    if (hit) return hit;

    if (depth >= MAX_DEPTH) continue;
    for (const [k, child] of Object.entries(v)) {
      if (SKIP_KEYS.has(k)) continue;
      if (depth === 0 && isEndpointFieldKey(k)) continue;
      stack.push({ v: child, depth: depth + 1 });
    }
  }

  return null;
}

function isEndpointFieldKey(key) {
  const k = normalizeString(key).toLowerCase();
  return (
    k === "message" ||
    k === "prompt" ||
    k === "instruction" ||
    k === "diff" ||
    k === "prefix" ||
    k === "suffix" ||
    k === "selected_text" ||
    k === "selectedtext" ||
    k === "selected_code" ||
    k === "selectedcode"
  );
}

/**
 * Official inline / chat-input completion bodies are field-shaped:
 *   { prompt, suffix?, path?, lang?, ... }
 * not chat messages[]. Without this path, /completion always throws and the
 * status bar sticks on "Failed to generate completion".
 */
function tryFromPromptFields(rawBody) {
  const b = isObject(rawBody) ? rawBody : {};
  const prompt = normalizeString(b.prompt);
  const message = normalizeString(b.message);
  const instruction = normalizeString(b.instruction);
  const text = prompt || message || instruction;
  if (!text) return null;

  const suffix = typeof b.suffix === "string" ? b.suffix : "";
  const path = normalizeString(b.path);
  const lang = normalizeString(b.lang ?? b.language);

  // FIM-style editor completion (prompt = prefix at cursor).
  if (prompt) {
    const systemParts = [
      "You are a code completion engine.",
      "Continue the code at the cursor.",
      "Return only the text to insert at the cursor.",
      "Do not wrap the answer in markdown fences or explanations."
    ];
    if (path) systemParts.push(`File path: ${path}`);
    if (lang) systemParts.push(`Language: ${lang}`);
    if (suffix) {
      systemParts.push("Code after the cursor is provided as SUFFIX; the completion must fit between PREFIX and SUFFIX.");
    }

    const userContent = suffix
      ? `PREFIX:\n${prompt}\n\nSUFFIX:\n${suffix}\n\nInsert completion between PREFIX and SUFFIX.`
      : `PREFIX:\n${prompt}\n\nInsert completion after PREFIX.`;

    return {
      ok: true,
      system: systemParts.join("\n").trim(),
      messages: [{ role: "user", content: userContent }],
      source: "upstream.callApiBody.prompt_fields"
    };
  }

  // prompt-enhancer / generic field-only bodies use message/instruction.
  return {
    ok: true,
    system: "",
    messages: [{ role: "user", content: text }],
    source: "upstream.callApiBody.prompt_fields"
  };
}

async function maybeBuildDelegatedTextPrompt({
  endpoint,
  body
} = {}) {
  const ep = normalizeEndpoint(endpoint);
  if (!isOfficialExecutionDelegationEndpoint(ep)) return { ok: false, reason: "unsupported_endpoint" };
  if (isOfficialDelegationEndpoint(ep)) return { ok: false, reason: "chat_endpoint_use_chat_delegation" };

  const rawBody = isObject(body) ? body : {};
  const delegated =
    tryFromMessages(rawBody) ||
    tryFromResponsesInput(rawBody) ||
    tryFromPromptFields(rawBody) ||
    tryFromDeepSearch(rawBody);

  if (!delegated) {
    auditDelegationMiss(`official text assembler delegated miss: ep=${ep}`, "invalid_request_body");
    return { ok: false, reason: "invalid_request_body" };
  }

  const source = normalizeDelegationSource(delegated.source);
  auditDelegationHit(`official text assembler delegated: ep=${ep}`, source);
  return {
    ok: true,
    system: typeof delegated.system === "string" ? delegated.system : "",
    messages: Array.isArray(delegated.messages) ? delegated.messages : [],
    source
  };
}

module.exports = {
  maybeBuildDelegatedTextPrompt
};
