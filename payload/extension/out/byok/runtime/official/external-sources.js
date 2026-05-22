"use strict";

const { debug, warn } = require("../../infra/log");
const { normalizeString, normalizeStringList } = require("../../infra/util");
const { truncateTextForPrompt: truncateText } = require("../../infra/text");
const { joinBaseUrl, safeFetch } = require("../../providers/http");
const { readHttpErrorDetail } = require("../../providers/request-util");
const { makeTextRequestNode, pickInjectionTargetArray, maybeInjectUserExtraTextParts, isOfficialContextDisabled, resolveOfficialContextConnection } = require("./common");

async function fetchOfficialSearchExternalSources({ completionURL, apiToken, query, sourceTypes, timeoutMs, abortSignal }) {
  const url = joinBaseUrl(normalizeString(completionURL), "search-external-sources");
  if (!url) throw new Error("completionURL 无效（无法请求官方 search-external-sources）");
  const headers = { "content-type": "application/json" };
  if (apiToken) headers.authorization = `Bearer ${apiToken}`;
  const payload = { query: String(query || ""), source_types: Array.isArray(sourceTypes) ? sourceTypes : [] };
  const resp = await safeFetch(
    url,
    { method: "POST", headers, body: JSON.stringify(payload) },
    { timeoutMs, abortSignal, label: "augment/search-external-sources" }
  );
  if (!resp.ok) throw new Error(`search-external-sources ${resp.status}: ${await readHttpErrorDetail(resp, { maxChars: 300 })}`.trim());
  return await resp.json().catch(() => null);
}

function normalizeOfficialExternalSourcesSearchResults(raw) {
  const src = raw && typeof raw === "object" ? raw : null;
  const list = [];
  if (Array.isArray(raw)) list.push(...raw);
  else if (src) {
    const candidates =
      (Array.isArray(src.sources) && src.sources) ||
      (Array.isArray(src.external_sources) && src.external_sources) ||
      (Array.isArray(src.externalSources) && src.externalSources) ||
      (Array.isArray(src.items) && src.items) ||
      (Array.isArray(src.results) && src.results) ||
      [];
    list.push(...candidates);
  }

  const out = [];
  for (const it of list) {
    if (typeof it === "string") {
      const snippet = truncateText(it, 2000);
      if (snippet) out.push({ id: "", title: "", url: "", sourceType: "", snippet });
      continue;
    }
    if (!it || typeof it !== "object") continue;
    const r = it;
    const id = normalizeString(r.id ?? r.source_id ?? r.sourceId ?? r.external_source_id ?? r.externalSourceId ?? r.externalSourceID ?? "");
    const title = normalizeString(r.title ?? r.name ?? r.display_name ?? r.displayName ?? r.source_title ?? r.sourceTitle ?? "");
    const url = normalizeString(r.url ?? r.href ?? r.link ?? r.source_url ?? r.sourceUrl ?? "");
    const sourceType = normalizeString(r.source_type ?? r.sourceType ?? r.type ?? r.kind ?? "");
    const snippet = truncateText(r.snippet ?? r.summary ?? r.excerpt ?? r.text ?? r.content ?? r.body ?? "", 4000);
    if (!id && !title && !url && !snippet) continue;
    out.push({ id, title, url, sourceType, snippet });
  }
  return out;
}

function formatExternalSourcesForPrompt(results, { selectedExternalSourceIds } = {}) {
  const items = Array.isArray(results) ? results : [];
  const selected = Array.isArray(selectedExternalSourceIds) ? selectedExternalSourceIds : [];
  const lines = ["[EXTERNAL_SOURCES]"];
  if (selected.length) lines.push(`selected_external_source_ids=${selected.join(",")}`);
  for (const r of items) {
    if (!r || typeof r !== "object") continue;
    const title = normalizeString(r.title);
    const url = normalizeString(r.url);
    const id = normalizeString(r.id);
    const sourceType = normalizeString(r.sourceType);
    const snippet = truncateText(r.snippet, 4000);
    const headerParts = [];
    if (title) headerParts.push(title);
    if (sourceType) headerParts.push(`type=${sourceType}`);
    if (url) headerParts.push(url);
    else if (id) headerParts.push(`id=${id}`);
    if (!headerParts.length && !snippet) continue;
    lines.push(`- ${headerParts.join(" | ") || "(source)"}`);
    if (snippet) lines.push(snippet);
  }
  if (lines.length === 1) return "";
  lines.push("[/EXTERNAL_SOURCES]");
  return lines.join("\n").trim();
}

async function maybeInjectOfficialExternalSources({ req, timeoutMs, abortSignal, upstreamCompletionURL, upstreamApiToken }) {
  if (!req || typeof req !== "object") return false;
  if (isOfficialContextDisabled(req)) return false;

  const msg = normalizeString(req?.message);
  if (!msg) return false;

  const explicitExternalSourceIds = normalizeStringList(req.external_source_ids, { maxItems: 200 });
  const shouldAuto = req.disable_auto_external_sources !== true;
  if (!explicitExternalSourceIds.length && !shouldAuto) return false;

  const conn = resolveOfficialContextConnection({ feature: "external-sources", upstreamCompletionURL, upstreamApiToken });
  if (!conn) return false;
  const { completionURL, apiToken } = conn;

  const hardTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 120000;
  const t = Math.max(1500, Math.min(8000, Math.floor(hardTimeout * 0.25)));
  const wantedIds = explicitExternalSourceIds;

  try {
    const raw = await fetchOfficialSearchExternalSources({ completionURL, apiToken, query: msg, sourceTypes: [], timeoutMs: t, abortSignal });
    const results = normalizeOfficialExternalSourcesSearchResults(raw);
    if (!results.length) return false;

    const wantedSet = wantedIds.length ? new Set(wantedIds) : null;
    const filtered = wantedSet ? results.filter((r) => r && typeof r === "object" && normalizeString(r.id) && wantedSet.has(String(r.id))) : [];
    const chosen = (filtered.length ? filtered : results).slice(0, 6);
    const text = formatExternalSourcesForPrompt(chosen, { selectedExternalSourceIds: wantedIds });
    if (!normalizeString(text)) return false;

    const target = pickInjectionTargetArray(req);
    if (!target) return false;
    maybeInjectUserExtraTextParts({ req, target, startId: -30 });

    const node = makeTextRequestNode({ id: -21, text });
    const idx = target.findIndex((n) => Number(n?.id) === -20);
    if (idx >= 0) target.splice(idx, 0, node);
    else target.push(node);
    debug(`officialExternalSources injected: chars=${text.length} target_len=${target.length}`);
    return true;
  } catch (err) {
    warn(`officialExternalSources failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

module.exports = { maybeInjectOfficialExternalSources };
