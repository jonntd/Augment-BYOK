"use strict";

const { normalizeString } = require("../infra/util");

function createAbortError(message) {
  const DomExceptionCtor = globalThis.DOMException;
  if (typeof DomExceptionCtor === "function") return new DomExceptionCtor(message || "Aborted", "AbortError");
  const err = new Error(message || "Aborted");
  err.name = "AbortError";
  return err;
}

function buildAbortSignal(timeoutMs, abortSignal) {
  const controller = new AbortController();
  let timedOut = false;

  const timeout = Number(timeoutMs);
  const hasTimeout = Number.isFinite(timeout) && timeout > 0;

  const onAbort = () => {
    if (controller.signal.aborted) return;
    const reason = abortSignal && "reason" in abortSignal ? abortSignal.reason : undefined;
    const msg = typeof reason === "string" && reason.trim() ? reason.trim() : "Aborted";
    controller.abort(createAbortError(msg));
  };

  if (abortSignal) {
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  const timer = hasTimeout
    ? setTimeout(() => {
        timedOut = true;
        if (!controller.signal.aborted) controller.abort(createAbortError(`Timeout after ${timeout}ms`));
      }, timeout)
    : null;

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (abortSignal) {
      try { abortSignal.removeEventListener("abort", onAbort); } catch {}
    }
  };

  return { signal: controller.signal, cleanup, timedOut: () => timedOut };
}

function joinBaseUrl(baseUrl, pathname) {
  const b = normalizeString(baseUrl);
  const p = normalizeString(pathname);
  if (!b || !p) return "";
  try {
    return new URL(p.replace(/^\//, ""), b.endsWith("/") ? b : b + "/").toString();
  } catch {
    return "";
  }
}

let cachedProxyUrl = undefined;
let cachedDispatcher = undefined;

function getProxyDispatcher() {
  try {
    let proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    
    try {
      const vscode = require("vscode");
      const vp = vscode.workspace.getConfiguration("http").get("proxy");
      if (typeof vp === "string" && vp.trim()) {
        proxyUrl = vp.trim();
      }
    } catch {}

    if (!proxyUrl) {
      cachedProxyUrl = undefined;
      cachedDispatcher = undefined;
      return undefined;
    }

    if (proxyUrl === cachedProxyUrl && cachedDispatcher) {
      return cachedDispatcher;
    }

    const { ProxyAgent } = require("undici");
    cachedDispatcher = new ProxyAgent(proxyUrl);
    cachedProxyUrl = proxyUrl;
    return cachedDispatcher;
  } catch (err) {
    return undefined;
  }
}

async function safeFetch(url, init, { timeoutMs, abortSignal, label } = {}) {
  if (typeof fetch !== "function") throw new Error("global fetch 不可用（需要 Node >= 18）");
  const { signal, cleanup, timedOut } = buildAbortSignal(timeoutMs, abortSignal);
  
  const options = { ...(init || {}), signal };
  
  if (!options.dispatcher) {
    const dispatcher = getProxyDispatcher();
    if (dispatcher) {
      options.dispatcher = dispatcher;
    }
  }

  try {
    return await fetch(url, options);
  } catch (err) {
    if (err && typeof err === "object" && err.name === "AbortError") throw err;
    if (timedOut()) throw createAbortError(`Timeout while fetching ${label || url}`);
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${label || "fetch"} failed: ${msg}`);
  } finally {
    cleanup();
  }
}

module.exports = { createAbortError, joinBaseUrl, safeFetch };
