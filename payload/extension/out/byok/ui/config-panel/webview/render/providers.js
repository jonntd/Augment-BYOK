(function () {
  "use strict";

  const ns = (window.__byokCfgPanel = window.__byokCfgPanel || {});
  const { normalizeStr, uniq, escapeHtml, optionHtml, validateProviderDraft, pickIssueByKey, defaultBaseUrlForProviderType, hasVisibleSecretValue } = ns;

  const KNOWN_PROVIDER_TYPES = Array.isArray(ns.KNOWN_PROVIDER_TYPES) ? ns.KNOWN_PROVIDER_TYPES : [];

  function issueUi(issue) {
    const it = issue && typeof issue === "object" ? issue : null;
    if (!it || !it.level) return { cls: "field-msg hidden", inputCls: "", text: "" };
    const lvl = it.level === "error" ? "error" : "warning";
    return {
      cls: `field-msg field-msg--${lvl}`,
      inputCls: lvl === "error" ? "input--error" : "input--warning",
      text: String(it.message || "")
    };
  }

  function computeThinkingUi({ type, requestDefaults }) {
    const rd = requestDefaults && typeof requestDefaults === "object" && !Array.isArray(requestDefaults) ? requestDefaults : {};

    if (type === "openai_responses") {
      const reasoning = rd.reasoning && typeof rd.reasoning === "object" && !Array.isArray(rd.reasoning) ? rd.reasoning : {};
      const raw = normalizeStr(reasoning.effort);
      const rawNorm = raw.replace(/[\s-]+/g, "_");
      const v =
        rawNorm === "xhigh"
          ? "xhigh"
          : rawNorm === "low" || rawNorm === "medium" || rawNorm === "high"
            ? rawNorm
            : rawNorm
              ? "custom"
              : "";
      const hint =
        v === "xhigh" ? "OpenAI Responses：reasoning.effort=xhigh" : "OpenAI Responses：reasoning.effort=low|medium|high|xhigh";
      return { supported: true, value: v, hint };
    }

    if (type === "anthropic") {
      const thinking = rd.thinking && typeof rd.thinking === "object" && !Array.isArray(rd.thinking) ? rd.thinking : null;
      const tType = normalizeStr(thinking && thinking.type);
      const btRaw = thinking ? (thinking.budget_tokens ?? thinking.budgetTokens) : undefined;
      const bt = Number(btRaw);
      let v = "";
      if (thinking) {
        if (tType !== "enabled") v = "custom";
        else if (bt === 1024) v = "low";
        else if (bt === 2048) v = "medium";
        else if (bt === 4096) v = "high";
        else if (bt === 8192) v = "xhigh";
        else v = "custom";
      }
      return { supported: true, value: v, hint: "Anthropic：写入 requestDefaults.thinking.budget_tokens（Low/Medium/High/xhigh）" };
    }

    return { supported: false, value: "", hint: "该类型不支持（可用 Defaults JSON 自定义）" };
  }

  ns.renderProvidersPanel = function renderProvidersPanel({ providers, providerExpanded } = {}) {
    const listProviders = Array.isArray(providers) ? providers : [];
    const expanded = providerExpanded && typeof providerExpanded === "object" && !Array.isArray(providerExpanded) ? providerExpanded : {};

    const list = listProviders
      .map((p, idx) => {
        const pid = normalizeStr(p?.id);
        const pKey = pid || `idx:${idx}`;
        const type = normalizeStr(p?.type);
        const baseUrl = normalizeStr(p?.baseUrl);
        const baseUrlPlaceholder = normalizeStr(typeof defaultBaseUrlForProviderType === "function" ? defaultBaseUrlForProviderType(type) : "") || "https://api.openai.com/v1";
        const apiKeySet = typeof hasVisibleSecretValue === "function" ? hasVisibleSecretValue(p?.apiKey) : Boolean(normalizeStr(p?.apiKey));
        const dm = normalizeStr(p?.defaultModel);
        const rawModels = Array.isArray(p?.models) ? p.models : [];
        const models = uniq(rawModels.filter((m) => normalizeStr(m)));
        const modelOptions = uniq(models.concat(dm ? [dm] : []));
        const requestDefaults = p?.requestDefaults && typeof p.requestDefaults === "object" && !Array.isArray(p.requestDefaults) ? p.requestDefaults : {};
        const thinkingUi = computeThinkingUi({ type, requestDefaults });

        const issues =
          typeof validateProviderDraft === "function" ? validateProviderDraft({ id: pid, type, baseUrl, models, defaultModel: dm }) : [];
        const idIssue = issueUi(typeof pickIssueByKey === "function" ? pickIssueByKey(issues, "id") : null);
        const typeIssue = issueUi(typeof pickIssueByKey === "function" ? pickIssueByKey(issues, "type") : null);
        const baseUrlIssue = issueUi(typeof pickIssueByKey === "function" ? pickIssueByKey(issues, "baseUrl") : null);
        const modelsIssue = issueUi(typeof pickIssueByKey === "function" ? pickIssueByKey(issues, "models") : null);

        const providerTitle = pid || `provider_${idx + 1}`;
        const isExpanded = pKey in expanded ? expanded[pKey] === true : idx === 0;
        const headerBadges = [
          idx === 0 ? `<span class="status-badge status-badge--success">default</span>` : "",
          type ? `<span class="status-badge${typeIssue.inputCls === "input--error" ? " status-badge--error" : typeIssue.inputCls === "input--warning" ? " status-badge--warning" : ""}">${escapeHtml(type)}</span>` : "",
          models.length ? `<span class="status-badge">models: ${escapeHtml(String(models.length))}</span>` : `<span class="status-badge status-badge--warning">models: 0</span>`,
          baseUrlIssue.inputCls === "input--error"
            ? `<span class="status-badge status-badge--error">baseUrl: invalid</span>`
            : baseUrlIssue.inputCls === "input--warning"
              ? `<span class="status-badge status-badge--warning">baseUrl: check</span>`
              : baseUrl
                ? `<span class="status-badge status-badge--success">baseUrl: ok</span>`
                : `<span class="status-badge status-badge--warning">baseUrl: empty</span>`,
          apiKeySet ? `<span class="status-badge status-badge--success">key: set</span>` : `<span class="status-badge status-badge--warning">key: empty</span>`
        ]
          .filter(Boolean)
          .join("");

        return `
            <div class="provider-card${isExpanded ? " is-expanded" : ""}" data-provider-card data-provider-idx="${idx}" data-provider-key="${escapeHtml(pKey)}">
              <div class="provider-card__header" data-action="toggleProviderCard" data-idx="${idx}">
                <div class="flex-row flex-wrap">
                  <span class="icon-chevron">▶</span>
                  <strong class="text-mono">${escapeHtml(providerTitle)}</strong>
                  ${headerBadges}
                  ${baseUrl ? `<span class="text-muted text-xs text-mono">${escapeHtml(baseUrl)}</span>` : `<span class="text-muted text-xs">baseUrl: (empty)</span>`}
                </div>
                <div class="flex-row flex-wrap">
                  <button class="btn btn--small" data-action="makeProviderDefault" data-idx="${idx}" ${idx === 0 ? "disabled" : ""}>设为默认</button>
                  <button class="btn btn--small btn--danger" data-action="removeProvider" data-idx="${idx}">删除</button>
                </div>
              </div>
              <div class="provider-card__content-wrapper">
                <div class="provider-card__body">
                  <div class="provider-card__inner">
                    <div class="form-grid">
                      <div class="form-group">
                        <label class="form-label">ID</label>
                        <input type="text" class="${idIssue.inputCls}" data-p-idx="${idx}" data-p-key="id" value="${escapeHtml(pid)}" placeholder="openai" />
                        <div class="${idIssue.cls}" data-provider-idx="${idx}" data-provider-issue-for="id">${escapeHtml(idIssue.text)}</div>
                      </div>
                      <div class="form-group">
                        <label class="form-label">Type</label>
                        <select class="${typeIssue.inputCls}" data-p-idx="${idx}" data-p-key="type">
                          ${type && !KNOWN_PROVIDER_TYPES.includes(type) ? optionHtml({ value: type, label: `${type} (unknown)`, selected: true }) : ""}
                          ${KNOWN_PROVIDER_TYPES.map((t) => optionHtml({ value: t, label: t, selected: type === t })).join("")}
                        </select>
                        <div class="${typeIssue.cls}" data-provider-idx="${idx}" data-provider-issue-for="type">${escapeHtml(typeIssue.text)}</div>
                      </div>
                      <div class="form-group form-grid--full">
                        <div class="flex-between flex-row">
                          <label class="form-label">Base URL</label>
                          <button class="btn btn--small" data-action="setProviderBaseUrlDefault" data-idx="${idx}" title="使用该 Type 的默认 Base URL">默认</button>
                        </div>
                        <input type="url" class="${baseUrlIssue.inputCls}" data-p-idx="${idx}" data-p-key="baseUrl" value="${escapeHtml(baseUrl)}" placeholder="${escapeHtml(baseUrlPlaceholder)}" />
                        <div class="${baseUrlIssue.cls}" data-provider-idx="${idx}" data-provider-issue-for="baseUrl">${escapeHtml(baseUrlIssue.text)}</div>
                        <div class="text-muted text-xs">必须是 http(s) URL。示例：<span class="text-mono">${escapeHtml(baseUrlPlaceholder)}</span></div>
                      </div>
                      <div class="form-group form-grid--full">
                        <div class="flex-between flex-row">
                          <label class="form-label">API Key</label>
                          ${apiKeySet ? `<span class="status-badge status-badge--success">set</span>` : `<span class="status-badge status-badge--warning">empty</span>`}
                        </div>
                        <div class="flex-row">
                          <input type="password" data-p-idx="${idx}" data-p-key="apiKeyInput" value="" placeholder="${apiKeySet ? "(set)" : "(empty)"}" />
                          <button class="btn btn--icon btn--danger" data-action="clearProviderKey" data-idx="${idx}" title="清空 API Key">✕</button>
                        </div>
                      </div>
                      <div class="form-group">
                        <label class="form-label">Models</label>
                        <div class="flex-row flex-wrap">
                          <span class="status-badge">${escapeHtml(String(models.length))}</span>
                          <button class="btn btn--small" data-action="fetchProviderModels" data-idx="${idx}">拉取</button>
                          <button class="btn btn--small" data-action="editProviderModels" data-idx="${idx}">编辑</button>
                        </div>
                        <div class="${modelsIssue.cls}" data-provider-idx="${idx}" data-provider-issue-for="models">${escapeHtml(modelsIssue.text)}</div>
                      </div>
                      <div class="form-group">
                        <label class="form-label">Default Model</label>
                        <select data-p-idx="${idx}" data-p-key="defaultModel">
                          ${optionHtml({ value: "", label: "(auto)", selected: !dm })}
                          ${modelOptions.map((m) => optionHtml({ value: m, label: m, selected: dm === m })).join("")}
                        </select>
                      </div>
                      <div class="form-group">
                        <label class="form-label">思考等级</label>
                        <select data-p-idx="${idx}" data-p-key="thinkingLevel" ${thinkingUi.supported ? "" : "disabled"}>
                          ${optionHtml({ value: "", label: "(Default)", selected: thinkingUi.value === "" })}
                          ${optionHtml({ value: "low", label: "Low", selected: thinkingUi.value === "low" })}
                          ${optionHtml({ value: "medium", label: "Medium", selected: thinkingUi.value === "medium" })}
                          ${optionHtml({ value: "high", label: "High", selected: thinkingUi.value === "high" })}
                          ${optionHtml({ value: "xhigh", label: "xhigh", selected: thinkingUi.value === "xhigh" })}
                          ${thinkingUi.value === "custom" ? optionHtml({ value: "custom", label: "(Custom / keep)", selected: true }) : ""}
                        </select>
                        <div class="text-muted text-xs">${escapeHtml(thinkingUi.hint)}</div>
                      </div>
                      <div class="form-group form-grid--full">
                        <label class="form-label">Advanced</label>
                        <div class="flex-row flex-wrap">
                          <button class="btn btn--small" data-action="editProviderHeaders" data-idx="${idx}">Headers</button>
                          <button class="btn btn--small" data-action="editProviderRequestDefaults" data-idx="${idx}">Defaults</button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          `;
      })
      .join("");

    return `
        <section class="settings-panel">
          <header class="settings-panel__header">
            <span>Providers</span>
            <div class="flex-row flex-wrap">
              <button class="btn btn--small btn--primary" data-action="addProvider">+ 新增 Provider</button>
            </div>
          </header>
          <div class="settings-panel__body">
            <div class="text-muted text-xs">约定：列表第 1 个（<span class="text-mono">providers[0]</span>）为默认 BYOK provider。</div>
            <div style="height:8px;"></div>
            <div class="provider-list">
              ${list || `<div class="text-muted" style="text-align:center;padding:20px;">暂无 Provider，请点击右上角新增。</div>`}
            </div>
          </div>
        </section>
      `;
  };
})();
