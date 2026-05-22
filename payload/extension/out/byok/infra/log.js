"use strict";

const { redactText, redactAny } = require("./log-redact");

const PREFIX = "[Augment-BYOK]";
const DEBUG = process.env.AUGMENT_BYOK_DEBUG === "1";

function sanitizeArgs(args) {
  return args.map((a) => {
    if (typeof a === "string") return redactText(a);
    if (a instanceof Error) {
      const e = new Error(redactText(a.message));
      e.name = a.name;
      return e;
    }
    if (a && typeof a === "object") return redactAny(a, { depth: 0, seen: new WeakSet() });
    return a;
  });
}

function debug(...args) {
  if (!DEBUG) return;
  console.log(PREFIX, ...sanitizeArgs(args));
}

function audit(...args) {
  console.log(PREFIX, ...sanitizeArgs(args));
}

function info(...args) {
  console.log(PREFIX, ...sanitizeArgs(args));
}

function warn(...args) {
  console.warn(PREFIX, ...sanitizeArgs(args));
}

function error(...args) {
  console.error(PREFIX, ...sanitizeArgs(args));
}

module.exports = { debug, audit, info, warn, error, redactText };
