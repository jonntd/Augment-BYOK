"use strict";

const { warn } = require("../infra/log");
const { normalizeString, normalizeSecretValue, isAuthHeaderName } = require("../infra/util");
const { normalizeConfig } = require("../config/config");

const REDACTED = "<redacted>";

function asObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

function shouldPreserveSecret(currentValue, incomingValue) {
  return Boolean(normalizeSecretValue(currentValue)) && !normalizeSecretValue(incomingValue);
}

function redactHeaders(headers) {
  const h = asObject(headers);
  const out = { ...h };
  for (const k of Object.keys(out)) {
    const key = String(k || "").trim().toLowerCase();
    if (!key) continue;
    if (!isAuthHeaderName(key)) continue;
    const v = out[k];
    if (normalizeString(v)) out[k] = REDACTED;
  }
  return out;
}

function redactConfigSecrets(cfg) {
  const c = normalizeConfig(cfg);
  const out = JSON.parse(JSON.stringify(c));

  out.official = asObject(out.official);
  if (normalizeString(out.official.apiToken)) out.official.apiToken = REDACTED;

  const providers = Array.isArray(out.providers) ? out.providers : [];
  for (const p of providers) {
    if (!p || typeof p !== "object") continue;
    if (normalizeString(p.apiKey)) p.apiKey = REDACTED;
    p.headers = redactHeaders(p.headers);
  }

  return out;
}

function findHeaderEntry(headers, keyLower) {
  const h = asObject(headers);
  const target = normalizeString(keyLower).toLowerCase();
  if (!target) return null;
  for (const [k, v] of Object.entries(h)) {
    const kk = String(k || "").trim().toLowerCase();
    if (kk === target) return { key: k, value: v };
  }
  return null;
}

function authHeaderNames(headers) {
  return Object.keys(asObject(headers))
    .map((k) => String(k || "").trim().toLowerCase())
    .filter((k) => k && isAuthHeaderName(k));
}

function mergePreserveSecretsHeaders(currentHeaders, incomingHeaders) {
  const curr = asObject(currentHeaders);
  const inc = asObject(incomingHeaders);
  const out = { ...inc };
  const keys = new Set([...authHeaderNames(curr), ...authHeaderNames(inc)]);

  for (const key of keys) {
    const currEntry = findHeaderEntry(curr, key);
    const incEntry = findHeaderEntry(inc, key);
    const currVal = currEntry ? currEntry.value : undefined;
    const incVal = incEntry ? incEntry.value : undefined;
    if (!shouldPreserveSecret(currVal, incVal)) continue;

    const outKey = incEntry ? incEntry.key : currEntry ? currEntry.key : key;
    out[outKey] = currVal;
  }
  return out;
}

function mergeConfigPreservingSecrets(currentCfg, incomingCfg) {
  const current = normalizeConfig(currentCfg);
  const incoming = normalizeConfig(incomingCfg);

  const out = JSON.parse(JSON.stringify(incoming));

  const currOfficial = asObject(current.official);
  out.official = asObject(out.official);
  if (shouldPreserveSecret(currOfficial.apiToken, out.official.apiToken)) {
    out.official.apiToken = currOfficial.apiToken;
  }

  const currProviders = Array.isArray(current.providers) ? current.providers : [];
  const currById = new Map(currProviders.map((p) => [normalizeString(p?.id), p]).filter((x) => x[0]));

  const nextProviders = Array.isArray(out.providers) ? out.providers : [];
  for (const p of nextProviders) {
    const pid = normalizeString(p?.id);
    if (!pid) continue;
    const curr = currById.get(pid);
    if (!curr) continue;

    if (shouldPreserveSecret(curr.apiKey, p.apiKey)) {
      p.apiKey = curr.apiKey;
    }
    p.headers = mergePreserveSecretsHeaders(curr.headers, p.headers);
  }
  out.providers = nextProviders;

  return out;
}

function safeStringifyJson(obj) {
  try {
    return JSON.stringify(obj, null, 2) + "\n";
  } catch {
    return JSON.stringify(normalizeConfig(obj), null, 2) + "\n";
  }
}

async function readTextFromUri(vscode, uri) {
  const ws = vscode && vscode.workspace ? vscode.workspace : null;
  if (!ws || !ws.fs || typeof ws.fs.readFile !== "function") throw new Error("vscode.workspace.fs.readFile not available");
  const bytes = await ws.fs.readFile(uri);
  return Buffer.from(bytes).toString("utf8");
}

async function writeTextToUri(vscode, uri, text) {
  const ws = vscode && vscode.workspace ? vscode.workspace : null;
  if (!ws || !ws.fs || typeof ws.fs.writeFile !== "function") throw new Error("vscode.workspace.fs.writeFile not available");
  await ws.fs.writeFile(uri, Buffer.from(String(text ?? ""), "utf8"));
}

function guessDefaultConfigUri(vscode, filename) {
  const ws = vscode && vscode.workspace ? vscode.workspace : null;
  const Uri = vscode && vscode.Uri ? vscode.Uri : null;
  if (!ws || !Uri || typeof Uri.joinPath !== "function") return null;
  const folders = Array.isArray(ws.workspaceFolders) ? ws.workspaceFolders : [];
  const base = folders[0] && folders[0].uri ? folders[0].uri : null;
  if (!base) return null;
  return Uri.joinPath(base, String(filename || "augment-byok.config.json"));
}

async function exportConfigWithDialog({ vscode, cfg, defaultFileName } = {}) {
  if (!vscode) throw new Error("vscode not available");
  const cfgObj = cfg && typeof cfg === "object" ? cfg : normalizeConfig(cfg);

  const pick = await vscode.window.showQuickPick(
    [
      { label: "Export (include secrets)", detail: "包含 apiToken/apiKey/authorization 等敏感字段；用于备份/迁移" },
      { label: "Export (redact secrets)", detail: "将敏感字段替换为 <redacted>；用于分享配置模板" }
    ],
    { placeHolder: "选择导出方式" }
  );
  const mode = normalizeString(pick?.label);
  if (!mode) return { ok: false, reason: "canceled" };

  const toWrite = mode.includes("redact") ? redactConfigSecrets(cfgObj) : normalizeConfig(cfgObj);
  const json = safeStringifyJson(toWrite);

  const Uri = vscode.Uri;
  const uri = await vscode.window.showSaveDialog({
    filters: { JSON: ["json"] },
    saveLabel: "Export",
    defaultUri: guessDefaultConfigUri(vscode, defaultFileName || "augment-byok.config.json") || undefined
  });
  if (!uri || !Uri) return { ok: false, reason: "canceled" };

  await writeTextToUri(vscode, uri, json);
  return { ok: true, uri };
}

async function importConfigWithDialog({ vscode, cfgMgr, requireConfirm, preserveSecretsByDefault } = {}) {
  if (!vscode) throw new Error("vscode not available");
  if (!cfgMgr || typeof cfgMgr.get !== "function" || typeof cfgMgr.saveNow !== "function") throw new Error("cfgMgr missing");

  if (requireConfirm) {
    const pick = await vscode.window.showWarningMessage(
      "导入会覆盖当前 BYOK 配置（建议先导出备份）。",
      { modal: true },
      preserveSecretsByDefault ? "继续导入" : "继续",
      "取消"
    );
    if (pick !== (preserveSecretsByDefault ? "继续导入" : "继续")) return { ok: false, reason: "canceled" };
  }

  const Uri = vscode.Uri;
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { JSON: ["json"] },
    openLabel: "Import"
  });
  const uri = Array.isArray(picked) ? picked[0] : null;
  if (!uri || !Uri) return { ok: false, reason: "canceled" };

  const rawText = await readTextFromUri(vscode, uri);
  let parsed;
  try {
    parsed = JSON.parse(String(rawText || ""));
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    throw new Error(`配置文件不是有效 JSON: ${m}`.trim());
  }

  const imported = normalizeConfig(parsed);
  const current = cfgMgr.get();

  const pick = await vscode.window.showQuickPick(
    [
      { label: "Merge (preserve existing secrets)", detail: "推荐：导入配置但保留当前已存储的 token/key（当导入文件为空或 <redacted>）" },
      { label: "Replace (overwrite everything)", detail: "完全用导入文件覆盖（token/key 也会被覆盖/清空）" }
    ],
    { placeHolder: "选择导入方式" }
  );
  const mode = normalizeString(pick?.label);
  if (!mode) return { ok: false, reason: "canceled" };

  const toSave = mode.includes("Merge") ? mergeConfigPreservingSecrets(current, imported) : imported;
  await cfgMgr.saveNow(toSave, "import_config");
  return { ok: true, uri, config: cfgMgr.get() };
}

async function runIoWithUiErrorBoundary(fn) {
  try {
    return await fn();
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    warn("config io failed", m);
    throw err;
  }
}

module.exports = {
  REDACTED,
  redactConfigSecrets,
  mergeConfigPreservingSecrets,
  exportConfigWithDialog,
  importConfigWithDialog,
  runIoWithUiErrorBoundary
};
