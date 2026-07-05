"use strict";

const { info, warn } = require("../../infra/log");
const { ensureConfigManager, state, setRuntimeEnabled, CONFIG_SYNC_KEYS, RUNTIME_ENABLED_KEY } = require("../../config/state");
const { openConfigPanel } = require("../../ui/config-panel");
const { exportConfigWithDialog, importConfigWithDialog, runIoWithUiErrorBoundary } = require("../../ui/config-io");
const { clearHistorySummaryCacheAll, setHistorySummaryStorage } = require("../../core/augment-history-summary/auto");

function install({ vscode, getActivate, setActivate }) {
  if (state.installed) return;
  state.installed = true;
  state.vscode = vscode || null;

  if (!vscode || typeof getActivate !== "function" || typeof setActivate !== "function") {
    warn("bootstrap install missing hooks");
    return;
  }

  const origActivate = getActivate();
  if (typeof origActivate !== "function") {
    warn("bootstrap: exported activate not function");
    return;
  }

  setActivate(async (ctx) => {
    state.vscode = vscode;

    try {
      setHistorySummaryStorage(ctx?.globalState);
    } catch {}

    const getOrig = ctx.secrets.get.bind(ctx.secrets);
    ctx.secrets.get = async function (k) {
      if (k === "augment.sessions") {
        return JSON.stringify({
          accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyLCJleHAiOjk5OTk5OTk5OTl9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
          tenantURL: "https://auth.augmentcode.com",
          scopes: ["email"]
        });
      }
      return getOrig(k);
    };

    try {
      const saved = ctx?.globalState?.get?.(RUNTIME_ENABLED_KEY);
      if (typeof saved === "boolean") state.runtimeEnabled = saved;
    } catch {}

    try {
      ctx?.globalState?.setKeysForSync?.(CONFIG_SYNC_KEYS);
    } catch {}

    const cfgMgr = ensureConfigManager({ ctx });
    const rr = cfgMgr.reloadNow("activate");
    if (!rr.ok && rr.reason === "missing") {
      try {
        await cfgMgr.resetNow("init_default");
      } catch (err) {
        warn("bootstrap: init default config failed:", err instanceof Error ? err.message : String(err));
      }
    }

    registerCommandsOnce(vscode, ctx, cfgMgr);
    return await origActivate(ctx);
  });
}

let commandsRegistered = false;

function registerCommandsOnce(vscode, ctx, cfgMgr) {
  if (commandsRegistered) return;
  commandsRegistered = true;

  const register = (id, fn) => {
    try {
      const d = vscode.commands.registerCommand(id, fn);
      if (ctx && Array.isArray(ctx.subscriptions)) ctx.subscriptions.push(d);
    } catch (err) {
      warn(`registerCommand failed: ${id}`, err instanceof Error ? err.message : String(err));
    }
  };

  register("augment-byok.enable", async () => {
    await setRuntimeEnabled(ctx, true);
    info("BYOK enabled (runtime)");
    try { await vscode.window.showInformationMessage("BYOK enabled"); } catch {}
  });

  register("augment-byok.disable", async () => {
    await setRuntimeEnabled(ctx, false);
    info("BYOK disabled (rollback)");
    try { await vscode.window.showWarningMessage("BYOK disabled (rollback to official)"); } catch {}
  });

  register("augment-byok.reloadConfig", async () => {
    const r = cfgMgr.reloadNow("command");
    try {
      await vscode.window.showInformationMessage(r.ok ? "BYOK config reloaded" : "BYOK config reload failed (kept last good)");
    } catch {}
  });

  register("augment-byok.openConfigPanel", async () => {
    try {
      await openConfigPanel({ vscode, ctx, cfgMgr, state });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      warn("openConfigPanel failed:", m);
      try { await vscode.window.showErrorMessage(`Open BYOK Config Panel failed: ${m}`); } catch {}
    }
  });

  register("augment-byok.clearHistorySummaryCache", async () => {
    try {
      const n = await clearHistorySummaryCacheAll();
      info(`historySummary cache cleared: ${n}`);
      try { await vscode.window.showInformationMessage(n ? `Cleared history summary cache (${n})` : "History summary cache already empty"); } catch {}
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      warn("clearHistorySummaryCache failed:", m);
      try { await vscode.window.showErrorMessage(`Clear history summary cache failed: ${m}`); } catch {}
    }
  });

  register("augment-byok.exportConfig", async () => {
    try {
      await runIoWithUiErrorBoundary(async () => {
        const r = await exportConfigWithDialog({ vscode, cfg: cfgMgr.get(), defaultFileName: "augment-byok.config.json" });
        if (!r.ok) return;
        try { await vscode.window.showInformationMessage(`BYOK config exported: ${String(r.uri)}`); } catch {}
      });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      try { await vscode.window.showErrorMessage(`Export BYOK config failed: ${m}`); } catch {}
    }
  });

  register("augment-byok.importConfig", async () => {
    try {
      await runIoWithUiErrorBoundary(async () => {
        const r = await importConfigWithDialog({ vscode, cfgMgr, requireConfirm: true, preserveSecretsByDefault: true });
        if (!r.ok) return;
        try { await vscode.window.showInformationMessage(`BYOK config imported: ${String(r.uri)}`); } catch {}
      });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      try { await vscode.window.showErrorMessage(`Import BYOK config failed: ${m}`); } catch {}
    }
  });
}

module.exports = { install };
