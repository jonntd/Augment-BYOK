(function () {
  "use strict";

  const ns = (window.__byokCfgPanel = window.__byokCfgPanel || {});

  const KNOWN_PROVIDER_TYPES = [
    /* BEGIN GENERATED: KNOWN_PROVIDER_TYPES */
    "openai_compatible",
    "openai_responses",
    "anthropic",
    "gemini_ai_studio"
    /* END GENERATED: KNOWN_PROVIDER_TYPES */
  ];
  ns.KNOWN_PROVIDER_TYPES = Object.freeze(KNOWN_PROVIDER_TYPES.slice());

  const DEFAULT_BASE_URL_BY_PROVIDER_TYPE = {
    openai_compatible: "https://api.openai.com/v1",
    openai_responses: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com/v1",
    gemini_ai_studio: "https://generativelanguage.googleapis.com/v1beta"
  };
  ns.DEFAULT_BASE_URL_BY_PROVIDER_TYPE = Object.freeze({ ...DEFAULT_BASE_URL_BY_PROVIDER_TYPE });

  ns.defaultBaseUrlForProviderType = function defaultBaseUrlForProviderType(type) {
    const t = ns.normalizeStr(type);
    return t && Object.prototype.hasOwnProperty.call(DEFAULT_BASE_URL_BY_PROVIDER_TYPE, t) ? DEFAULT_BASE_URL_BY_PROVIDER_TYPE[t] : "";
  };

  ns.qs = function qs(sel, root) {
    return (root || document).querySelector(sel);
  };

  ns.normalizeStr = function normalizeStr(v) {
    return String(v ?? "").trim();
  };

  ns.isPlaceholderSecretValue = function isPlaceholderSecretValue(v) {
    const s = ns.normalizeStr(v);
    if (!s) return true;
    if (/^(Bearer|Basic)$/i.test(s) || s === "Token") return true;
    const lower = s.toLowerCase();
    return lower === "<redacted>" || lower === "(redacted)" || lower === "(set)";
  };

  ns.hasVisibleSecretValue = function hasVisibleSecretValue(v) {
    return Boolean(ns.normalizeStr(v)) && !ns.isPlaceholderSecretValue(v);
  };

  ns.uniq = function uniq(xs) {
    return Array.from(new Set((Array.isArray(xs) ? xs : []).map((x) => ns.normalizeStr(x)).filter(Boolean)));
  };

  ns.parseJsonOrEmptyObject = function parseJsonOrEmptyObject(s) {
    const t = ns.normalizeStr(s);
    if (!t) return {};
    return JSON.parse(t);
  };

  ns.parseModelsTextarea = function parseModelsTextarea(s) {
    const lines = String(s ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    return ns.uniq(lines);
  };

  ns.parseByokModelId = function parseByokModelId(raw) {
    const s = ns.normalizeStr(raw);
    if (!s.startsWith("byok:")) return null;
    const rest = s.slice("byok:".length);
    const idx = rest.indexOf(":");
    if (idx <= 0) return null;
    const providerId = ns.normalizeStr(rest.slice(0, idx));
    const modelId = ns.normalizeStr(rest.slice(idx + 1));
    if (!providerId || !modelId) return null;
    return { providerId, modelId };
  };

  ns.validateHttpUrl = function validateHttpUrl(raw) {
    const s = ns.normalizeStr(raw);
    if (!s) return { ok: true, empty: true, href: "" };
    let u;
    try {
      u = new URL(s);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      return { ok: false, empty: false, href: "", error: `URL 解析失败：${m}` };
    }
    const protocol = String(u.protocol || "").toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") return { ok: false, empty: false, href: "", error: `只支持 http/https（当前: ${u.protocol || "unknown"}）` };
    return { ok: true, empty: false, href: String(u.href || s) };
  };

  ns.pickIssueByKey = function pickIssueByKey(issues, key) {
    const k = ns.normalizeStr(key);
    const list = Array.isArray(issues) ? issues : [];
    if (!k) return null;
    const err = list.find((x) => x && x.key === k && x.level === "error");
    if (err) return err;
    const warn = list.find((x) => x && x.key === k && x.level === "warning");
    if (warn) return warn;
    return null;
  };

  ns.validateProviderDraft = function validateProviderDraft(provider) {
    const p = provider && typeof provider === "object" ? provider : {};
    const id = ns.normalizeStr(p.id);
    const type = ns.normalizeStr(p.type);
    const baseUrl = ns.normalizeStr(p.baseUrl);
    const models = Array.isArray(p.models) ? ns.uniq(p.models) : [];
    const defaultModel = ns.normalizeStr(p.defaultModel);

    const issues = [];
    const push = (level, key, message) => issues.push({ level, key, message: String(message || "") });

    if (!id) push("warning", "id", "ID 为空：保存后该 Provider 会被丢弃（normalizeConfig 要求 id/type 都非空）。");

    if (!type) push("error", "type", "Type 不能为空。");
    else if (!KNOWN_PROVIDER_TYPES.includes(type)) push("warning", "type", `未知 Type：${type}（可能不受支持）。建议使用：${KNOWN_PROVIDER_TYPES.join(", ")}`);

    const baseCheck = ns.validateHttpUrl(baseUrl);
    if (baseCheck.ok && baseCheck.empty) {
      push("warning", "baseUrl", "Base URL 为空：该 Provider 将无法发起请求（建议填写 http(s) 地址）。");
    } else if (!baseCheck.ok) {
      push("error", "baseUrl", `Base URL 无效：${baseCheck.error || "invalid url"}`);
    } else if (type === "openai_compatible" || type === "openai_responses" || type === "anthropic") {
      // 轻量提示：不少 OpenAI/Anthropic 兼容端点以 /v1 结尾（但不作为硬错误）。
      let pathname = "";
      try {
        pathname = new URL(baseUrl).pathname || "";
      } catch {}
      if (pathname && !pathname.includes("/v1")) push("warning", "baseUrl", "Base URL 通常包含 /v1（若你的服务不需要可忽略）。");
    }

    if (!models.length && !defaultModel) {
      push("warning", "models", "Models 为空：建议点击“拉取”或“编辑”，至少设置一个模型/默认模型。");
    } else if (defaultModel && models.length && !models.includes(defaultModel)) {
      push("warning", "models", "Default Model 不在 Models 列表中（保存/归一化时可能被重写）。");
    }

    return issues;
  };

  ns.updateProviderFieldValidationFromDom = function updateProviderFieldValidationFromDom(idx, key) {
    const i = Number(idx);
    const k = ns.normalizeStr(key);
    if (!Number.isFinite(i) || i < 0 || !k) return;

    const core = ns && typeof ns === "object" ? ns.__byokCfgPanelCore : null;
    if (!core || typeof core.getUiState !== "function") return;
    if (typeof ns.validateProviderDraft !== "function" || typeof ns.pickIssueByKey !== "function" || typeof ns.qs !== "function") return;

    const st = core.getUiState();
    const providers = Array.isArray(st?.cfg?.providers) ? st.cfg.providers : [];
    const base = providers[i] && typeof providers[i] === "object" ? providers[i] : {};

    const idDom = ns.normalizeStr(ns.qs(`[data-p-idx="${i}"][data-p-key="id"]`)?.value);
    const typeDom = ns.normalizeStr(ns.qs(`[data-p-idx="${i}"][data-p-key="type"]`)?.value);
    const baseUrlDom = ns.normalizeStr(ns.qs(`[data-p-idx="${i}"][data-p-key="baseUrl"]`)?.value);

    const draft = {
      id: idDom || ns.normalizeStr(base?.id),
      type: typeDom || ns.normalizeStr(base?.type),
      baseUrl: baseUrlDom || ns.normalizeStr(base?.baseUrl),
      models: Array.isArray(base?.models) ? base.models : [],
      defaultModel: ns.normalizeStr(base?.defaultModel)
    };

    const issues = ns.validateProviderDraft(draft);
    const issue = ns.pickIssueByKey(issues, k);

    const msgEl = ns.qs(`[data-provider-idx="${i}"][data-provider-issue-for="${k}"]`);
    if (msgEl && msgEl.classList) {
      msgEl.classList.remove("hidden", "field-msg--warning", "field-msg--error");
      msgEl.classList.add("field-msg");
      if (!issue) {
        msgEl.textContent = "";
        msgEl.classList.add("hidden");
      } else {
        const lvl = issue.level === "error" ? "error" : "warning";
        msgEl.textContent = String(issue.message || "");
        msgEl.classList.add(`field-msg--${lvl}`);
      }
    }

    const inputEl = ns.qs(`[data-p-idx="${i}"][data-p-key="${k}"]`);
    if (inputEl && inputEl.classList) {
      inputEl.classList.remove("input--warning", "input--error");
      if (issue) inputEl.classList.add(issue.level === "error" ? "input--error" : "input--warning");
    }
  };

  ns.escapeHtml = function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };

  ns.optionHtml = function optionHtml({ value, label, selected, disabled }) {
    return `<option value="${ns.escapeHtml(value)}"${selected ? " selected" : ""}${disabled ? " disabled" : ""}>${ns.escapeHtml(label)}</option>`;
  };

  ns.computeProviderIndexById = function computeProviderIndexById(cfg) {
    const out = {};
    const list = Array.isArray(cfg?.providers) ? cfg.providers : [];
    for (const p of list) {
      const id = ns.normalizeStr(p?.id);
      if (id) out[id] = p;
    }
    return out;
  };

  ns.getEndpointCatalogV1 = function getEndpointCatalogV1() {
    const groups = Array.isArray(ns.ENDPOINT_GROUPS_V1) ? ns.ENDPOINT_GROUPS_V1 : [];
    const meanings = ns.ENDPOINT_MEANINGS_V1 && typeof ns.ENDPOINT_MEANINGS_V1 === "object" ? ns.ENDPOINT_MEANINGS_V1 : {};
    const llmGroup = groups.find((g) => g && g.id === "llm_data_plane");
    const llmEndpoints = Array.isArray(llmGroup?.endpoints) ? llmGroup.endpoints : [];
    return { groups, meanings, llmEndpoints };
  };

  ns.nowMs = function nowMs() {
    try {
      if (typeof performance !== "undefined" && typeof performance.now === "function") return performance.now();
    } catch {}
    return Date.now();
  };

  ns.debugLog = function debugLog(message, meta) {
    try {
      const prefix = "[byok.webview]";
      if (meta && typeof meta === "object") console.log(prefix, String(message || ""), meta);
      else console.log(prefix, String(message || ""), meta ?? "");
    } catch {}
  };

  ns.withTiming = function withTiming(label, fn, opts) {
    const o = opts && typeof opts === "object" ? opts : {};
    const thresholdMs = Number.isFinite(Number(o.thresholdMs)) ? Number(o.thresholdMs) : 0;
    const startedAt = ns.nowMs();
    try {
      const out = fn();
      if (out && typeof out.then === "function") {
        return out.then(
          (res) => {
            const ms = ns.nowMs() - startedAt;
            if (ms >= thresholdMs) ns.debugLog(label, { ms: Math.round(ms) });
            return res;
          },
          (err) => {
            const ms = ns.nowMs() - startedAt;
            ns.debugLog(`${label} FAIL`, { ms: Math.round(ms), err: err instanceof Error ? err.message : String(err) });
            throw err;
          }
        );
      }
      const ms = ns.nowMs() - startedAt;
      if (ms >= thresholdMs) ns.debugLog(label, { ms: Math.round(ms) });
      return out;
    } catch (err) {
      const ms = ns.nowMs() - startedAt;
      ns.debugLog(`${label} FAIL`, { ms: Math.round(ms), err: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  };

  let __reqSeq = 0;
  ns.newRequestId = function newRequestId(prefix) {
    __reqSeq += 1;
    const p = ns.normalizeStr(prefix) || "req";
    return `${p}_${Date.now().toString(36)}_${__reqSeq.toString(36)}`;
  };
})();
