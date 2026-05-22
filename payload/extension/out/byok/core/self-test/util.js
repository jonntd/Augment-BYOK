"use strict";

const { debug } = require("../../infra/log");
const { nowMs, formatMs } = require("../../infra/trace");
const { normalizeString, hasAuthHeader } = require("../../infra/util");

function providerLabel(provider) {
  const id = normalizeString(provider?.id);
  const type = normalizeString(provider?.type);
  return id ? `${id} (${type || "unknown"})` : `(${type || "unknown"})`;
}

function formatMaybeInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.floor(n)) : "";
}

async function withTimed(labelOrFn, maybeFn) {
  const label = typeof labelOrFn === "string" ? labelOrFn : "";
  const fn = typeof labelOrFn === "function" ? labelOrFn : maybeFn;
  if (typeof fn !== "function") throw new Error("withTimed: fn missing");
  const t0 = nowMs();
  try {
    const res = await fn();
    const ms = nowMs() - t0;
    if (label) debug(`[self-test] ${label} ok (${formatMs(ms)})`);
    return { ok: true, ms, res };
  } catch (err) {
    const isAbort = Boolean(err && typeof err === "object" && (err.name === "AbortError" || err.code === "ABORT_ERR"));
    if (isAbort) throw err;
    const m = err instanceof Error ? err.message : String(err);
    const ms = nowMs() - t0;
    if (label) debug(`[self-test] ${label} FAIL (${formatMs(ms)}): ${m}`);
    return { ok: false, ms, error: m };
  }
}

module.exports = { hasAuthHeader, providerLabel, formatMs, formatMaybeInt, withTimed };
