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
      "你是一个代码补全引擎。",
      "请继续补全光标处的代码。",
      "只返回要插入光标处的文本。",
      "不要用 markdown 代码块或解释性文字包裹答案。"
    ];
    if (path) systemParts.push(`文件路径：${path}`);
    if (lang) systemParts.push(`语言：${lang}`);
    if (suffix) {
      systemParts.push("光标之后的代码作为 SUFFIX 提供；补全内容必须位于 PREFIX 与 SUFFIX 之间。");
    }

    const userContent = suffix
      ? `PREFIX:\n${prompt}\n\nSUFFIX:\n${suffix}\n\n请在 PREFIX 与 SUFFIX 之间插入补全内容。`
      : `PREFIX:\n${prompt}\n\n请在 PREFIX 之后补全代码。`;

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

/**
 * /generate-commit-message-stream bodies are field-shaped:
 *   { diff, changed_file_stats?, relevant_commit_messages?, example_commit_messages? }
 * not chat messages[]. Without this path, commit-message delegation always
 * throws "invalid_request_body" and the status bar shows
 * "Server error: failed to generate commit message."
 */
function tryFromCommitMessageBody(rawBody) {
  const b = isObject(rawBody) ? rawBody : {};
  const diff = typeof b.diff === "string" ? b.diff : "";
  if (!normalizeString(diff)) return null;

  const systemParts = [
    "你是一个软件项目的提交信息生成器。",
    "给定一段 git diff，请生成一条清晰、简洁且准确描述本次改动的提交信息（使用中文）。",
    "规则：",
    "  - 使用约定式提交格式：<type>(<可选 scope>): <描述>",
    "  - 允许的类型：feat, fix, refactor, docs, style, test, chore, perf, build, ci, revert",
    "  - 使用祈使语气（用\"新增\"而非\"新增了\"，用\"修复\"而非\"修复了\"）",
    "  - 第一行控制在 72 个字符以内",
    "  - 复杂改动可在空行后补充正文",
    "  - 只返回提交信息本身，不要包裹 markdown 代码块或附加解释"
  ];

  const stats = isObject(b.changed_file_stats) ? b.changed_file_stats : {};
  const added = stats.added_file_stats?.changed_file_count || 0;
  const modified = stats.modified_file_stats?.changed_file_count || 0;
  const deleted = stats.deleted_file_stats?.changed_file_count || 0;
  const total = added + modified + deleted;
  if (total > 0) {
    const parts = [];
    if (added) parts.push(`新增 ${added} 个`);
    if (modified) parts.push(`修改 ${modified} 个`);
    if (deleted) parts.push(`删除 ${deleted} 个`);
    systemParts.push(`改动文件共 ${total} 个（${parts.join("，")}）`);
  }

  const userParts = [`DIFF:\n${diff}`];

  const relevant = Array.isArray(b.relevant_commit_messages) ? b.relevant_commit_messages : [];
  if (relevant.length > 0) {
    const lines = relevant.filter((m) => normalizeString(typeof m === "string" ? m : "")).slice(0, 10);
    if (lines.length > 0) {
      userParts.push(`历史提交参考:\n${lines.join("\n")}`);
    }
  }

  const examples = Array.isArray(b.example_commit_messages) ? b.example_commit_messages : [];
  if (examples.length > 0) {
    const lines = examples.filter((m) => normalizeString(typeof m === "string" ? m : "")).slice(0, 10);
    if (lines.length > 0) {
      userParts.push(`提交信息示例:\n${lines.join("\n")}`);
    }
  }

  return {
    ok: true,
    system: systemParts.join("\n").trim(),
    messages: [{ role: "user", content: userParts.join("\n\n").trim() }],
    source: "upstream.callApiBody.commit_message_fields"
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
    tryFromCommitMessageBody(rawBody) ||
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
