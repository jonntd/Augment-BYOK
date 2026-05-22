"use strict";

const { normalizeString, randomId } = require("../../../infra/util");

const { isToolsModelCandidate } = require("./globals");
const { summarizeToolResult } = require("./exec-extract");

function maybeAugmentAgentsApiHint(errorMessage) {
  const s = normalizeString(errorMessage).toLowerCase();
  if (!s) return "";
  const is404 = s.includes(" 404") || s.includes("404:") || s.includes("not found") || s.includes("route not found");
  if (!is404) return "";
  if (s.includes("agents/check-tool-safety") || s.includes("agents/run-remote-tool") || s.includes("/relay/agents/")) {
    return "（提示：当前 completion_url 指向的服务可能不支持 Augment Agents API（/agents/*）。web-search 等 remote tool 会失败；completion_url 应为 https://<tenant>.augmentcode.com/ 或你的代理需完整实现 Agents 路由。）";
  }
  return "";
}

async function toolsModelCallTool({ toolsModel, toolName, input, conversationId, log, abortSignal } = {}) {
  const emit = (line) => {
    try {
      if (typeof log === "function") log(String(line || ""));
    } catch {}
  };

  const tm = isToolsModelCandidate(toolsModel) ? toolsModel : null;
  const name = normalizeString(toolName);
  if (!tm) return { ok: false, detail: "toolsModel missing" };
  if (!name) return { ok: false, detail: "toolName empty" };

  if (abortSignal && abortSignal.aborted) {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  }

  // 1) 尽可能走上游 safety gating（真实环境一致）
  if (typeof tm.checkToolCallSafe === "function") {
    try {
      const safe = await tm.checkToolCallSafe({ toolName: name, input, agentMode: "auto" });
      if (!safe) return { ok: false, detail: "blocked_by_policy", blocked: true };
    } catch (err) {
      if (err && typeof err === "object" && (err.name === "AbortError" || err.code === "ABORT_ERR")) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, detail: `checkToolCallSafe failed: ${msg}${maybeAugmentAgentsApiHint(msg)}`.trim() };
    }
  }

  // 2) 执行
  const requestId = `byok_selftest_tool_${randomId()}`;
  const toolUseId = `tooluse_${randomId()}`;
  try {
    const res = await tm.callTool(requestId, toolUseId, name, input && typeof input === "object" ? input : {}, [], String(conversationId ?? ""));
    const sum = summarizeToolResult(res, { maxLen: 220 });
    if (sum.isError) {
      emit(`[tool ${name}] FAIL isError=true ${sum.preview ? `preview=${sum.preview}` : ""}`.trim());
      return { ok: false, detail: sum.preview || "isError=true", res };
    }
    emit(`[tool ${name}] ok ${sum.preview ? `preview=${sum.preview}` : ""}`.trim());
    return { ok: true, detail: sum.preview, res };
  } catch (err) {
    if (err && typeof err === "object" && (err.name === "AbortError" || err.code === "ABORT_ERR")) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    emit(`[tool ${name}] FAIL exception=${msg}`);
    return { ok: false, detail: `${msg}${maybeAugmentAgentsApiHint(msg)}`.trim() };
  }
}

module.exports = { toolsModelCallTool };

