"use strict";

const MAX_LOG_STRING_BYTES = 4000;
const MAX_LOG_DEPTH = 6;
const MAX_LOG_ARRAY = 40;
const SENSITIVE_URL_PARAM_VALUE_RE =
  /([?&#;](?:key|api[-_]?key|x[-_]?api[-_]?key|x[-_]?goog[-_]?api[-_]?key|api[-_]?token|auth(?:entication)?[-_]?token|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret|password|passwd|auth|authorization|proxy[-_]?authorization|credential)=)[^&#;\s]+/gi;
const SENSITIVE_INLINE_PARAM_VALUE_RE =
  /([ \t](?:api[-_]?key|x[-_]?api[-_]?key|x[-_]?goog[-_]?api[-_]?key|api[-_]?token|auth(?:entication)?[-_]?token|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret|password|passwd|auth|authorization|proxy[-_]?authorization|credential)=)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^&#;\s]+)/gi;

function truncateForLog(s, maxBytes) {
  const raw = typeof s === "string" ? s : String(s ?? "");
  const m = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0 ? Number(maxBytes) : MAX_LOG_STRING_BYTES;
  if (raw.length <= m) return raw;
  return `${raw.slice(0, m)}…<truncated>`;
}

function redactSensitiveAssignmentValue(value) {
  const raw = String(value ?? "").trim();
  const scheme = raw.match(/^(Bearer|Basic)\s+/i);
  return scheme ? `${scheme[1]} ***` : "***";
}

function omittedAssignmentValue(key) {
  const k = String(key || "").trim().toLowerCase();
  return `[omitted ${k || "value"}]`;
}

function redactUrlUserInfo(s) {
  return String(s || "").replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\/\s:@]+(?::[^\/\s@]*)?@)/gi, "$1***@");
}

function redactOmittedLineAssignments(s) {
  return String(s || "").replace(
    /(^|[\r\n])(\s*)([A-Za-z0-9_.-]{1,100})(\s*:\s*)([^\r\n]+)/g,
    (m, lineStart, indent, key, sep) => {
      const keyLower = String(key || "").trim().toLowerCase();
      if (!shouldOmitKey(keyLower)) return m;
      return `${lineStart}${indent}${key}${sep}${omittedAssignmentValue(keyLower)}`;
    }
  );
}

function redactSensitiveLineAssignments(s) {
  return String(s || "").replace(
    /(^|[\r\n])(\s*)([A-Za-z0-9_.-]{1,100})(\s*:\s*)([^\r\n]+)/g,
    (m, lineStart, indent, key, sep, value) => {
      if (!shouldRedactKey(String(key || "").toLowerCase())) return m;
      return `${lineStart}${indent}${key}${sep}${redactSensitiveAssignmentValue(value)}`;
    }
  );
}

function findInlineAssignmentValueEnd(raw, start) {
  const ch = raw[start];
  if (ch === "\"" || ch === "'") return skipQuotedValue(raw, start);
  if (ch === "{" || ch === "[") {
    const end = findJsonLikeEnd(raw, start);
    return end > start ? end : findLineEnd(raw, start);
  }
  let i = start;
  while (i < raw.length && !/[\s;&]/.test(raw[i])) i += 1;
  return i;
}

function skipQuotedValue(raw, start) {
  const quote = raw[start];
  let escaped = false;
  for (let i = start + 1; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === quote) return i + 1;
    if (ch === "\r" || ch === "\n") return i;
  }
  return raw.length;
}

function findLineEnd(raw, start) {
  let i = start;
  while (i < raw.length && raw[i] !== "\r" && raw[i] !== "\n") i += 1;
  return i;
}

function redactOmittedInlineAssignments(s) {
  const raw = String(s || "");
  const re = /(^|[\s;&])([A-Za-z0-9_.-]{1,100})(\s*=\s*)/gi;
  let out = "";
  let pos = 0;
  let m = null;

  while ((m = re.exec(raw))) {
    const keyLower = String(m[2] || "").trim().toLowerCase();
    if (!shouldOmitKey(keyLower)) continue;

    const valueStart = re.lastIndex;
    const valueEnd = findInlineAssignmentValueEnd(raw, valueStart);
    out += raw.slice(pos, m.index) + m[1] + m[2] + m[3] + omittedAssignmentValue(keyLower);
    pos = valueEnd;
    re.lastIndex = valueEnd;
  }

  return out ? out + raw.slice(pos) : raw;
}

function redactSensitiveInlineAssignments(s) {
  return String(s || "").replace(
    /(^|[\s;&])([A-Za-z0-9_.-]{1,100})(\s*=\s*)(?!(?:Bearer|Basic)\s+\*\*\*(?=$|[\s;&\r\n]))(?:"((?:\\.|[^"\\\r\n])*)"|'((?:\\.|[^'\\\r\n])*)'|([^"'\s;&]+))/gi,
    (m, prefix, key, sep, doubleQuotedValue, singleQuotedValue, bareValue) => {
      if (!shouldRedactKey(String(key || "").toLowerCase())) return m;
      const hasDoubleQuote = doubleQuotedValue !== undefined;
      const hasSingleQuote = singleQuotedValue !== undefined;
      const quote = hasDoubleQuote ? "\"" : hasSingleQuote ? "'" : "";
      const value = hasDoubleQuote ? doubleQuotedValue : hasSingleQuote ? singleQuotedValue : bareValue;
      return `${prefix}${key}${sep}${quote}${redactSensitiveAssignmentValue(value)}${quote}`;
    }
  );
}

function containsRedactableJsonKey(s) {
  const raw = String(s || "");
  const keyRe = /["']([A-Za-z0-9_.-]{1,100})["']\s*:/g;
  let m = null;
  while ((m = keyRe.exec(raw))) {
    const keyLower = String(m[1] || "").trim().toLowerCase();
    if (shouldOmitKey(keyLower) || shouldRedactKey(keyLower)) return true;
  }
  return false;
}

function redactWholeJsonStringWithRedactableKeys(s) {
  const raw = String(s || "");
  const trimmed = raw.trim();
  if (!trimmed || !containsRedactableJsonKey(trimmed)) return "";
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return "";
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") return "";
    return JSON.stringify(redactAny(parsed, { depth: 0, seen: new WeakSet() }));
  } catch {
    return "";
  }
}

function findJsonLikeEnd(s, start) {
  const first = s[start];
  const closeFor = first === "{" ? "}" : first === "[" ? "]" : "";
  if (!closeFor) return -1;

  const stack = [closeFor];
  let quote = "";
  let escaped = false;

  for (let i = start + 1; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }

    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "{") {
      stack.push("}");
      continue;
    }
    if (ch === "[") {
      stack.push("]");
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (stack[stack.length - 1] !== ch) return -1;
      stack.pop();
      if (!stack.length) return i + 1;
    }
  }
  return -1;
}

function redactEmbeddedJsonStringsWithRedactableKeys(s) {
  const raw = String(s || "");
  let out = "";
  let i = 0;

  while (i < raw.length) {
    const ch = raw[i];
    if (ch !== "{" && ch !== "[") {
      out += ch;
      i += 1;
      continue;
    }

    const end = findJsonLikeEnd(raw, i);
    if (end <= i) {
      out += ch;
      i += 1;
      continue;
    }

    const fragment = raw.slice(i, end);
    if (containsRedactableJsonKey(fragment)) {
      try {
        const parsed = JSON.parse(fragment);
        if (parsed && typeof parsed === "object") {
          out += JSON.stringify(redactAny(parsed, { depth: 0, seen: new WeakSet() }));
          i = end;
          continue;
        }
      } catch {
        // Not a strict JSON fragment; keep scanning so other redact passes can run.
      }
    }

    out += ch;
    i += 1;
  }

  return out;
}

function redactJsonLikeOmittedStringValues(s) {
  return String(s || "").replace(
    /(["'])([A-Za-z0-9_.-]{1,100})\1(\s*:\s*)(["'])((?:\\.|[^\\\r\n])*?)\4/g,
    (m, keyQuote, key, sep, valueQuote, value) => {
      const keyLower = String(key || "").trim().toLowerCase();
      if (!shouldOmitKey(keyLower)) return m;
      if (String(value || "").startsWith(`[omitted ${keyLower}`)) return m;
      return `${keyQuote}${key}${keyQuote}${sep}${valueQuote}[omitted ${keyLower}]${valueQuote}`;
    }
  );
}

function redactText(v) {
  if (typeof v !== "string") return v;
  const jsonRedacted = redactWholeJsonStringWithRedactableKeys(v);
  if (jsonRedacted) return truncateForLog(jsonRedacted, MAX_LOG_STRING_BYTES);
  let s = v;
  s = redactEmbeddedJsonStringsWithRedactableKeys(s);
  s = redactUrlUserInfo(s);
  s = s.replace(/(["'](?:authorization|proxy-authorization)["']\s*:\s*["'])(Bearer|Basic)\s+[^"'\r\n]*(['"])/gi, "$1$2 ***$3");
  s = s.replace(/(["'](?:authorization|proxy-authorization)["']\s*:\s*["'])(?!\s*(?:Bearer|Basic)\s+\*\*\*(?=['"]))[^"'\r\n]*(['"])/gi, "$1***$2");
  s = s.replace(
    /(["'](?:cookie|set-cookie|x-api-key|api[-_]?key|apikey|x-goog-api-key|x-auth-token|[a-z0-9_-]*token|api[-_]?token|access_token|refresh_token|client[-_]?secret|secret|password|passwd|(?:[a-z0-9_-]*[-_])?auth(?:[-_][a-z0-9_-]+)?|[a-z0-9_-]*authentication[a-z0-9_-]*|[a-z0-9_-]*credential[a-z0-9_-]*)["']\s*:\s*["'])[^"'\r\n]*(['"])/gi,
    "$1***$2"
  );
  s = redactJsonLikeOmittedStringValues(s);
  s = redactOmittedLineAssignments(s);
  s = redactOmittedInlineAssignments(s);
  s = s.replace(/((?:^|[\r\n])\s*(?:authorization|proxy-authorization)\s*[:=]\s*)(Bearer|Basic)\s+[^\r\n]+/gi, "$1$2 ***");
  s = s.replace(/([ \t](?:authorization|proxy-authorization)\s*=\s*)(Bearer|Basic)\s+[^\r\n]+/gi, "$1$2 ***");
  s = s.replace(/((?:^|[\r\n])\s*(?:authorization|proxy-authorization)\s*[:=]\s*)(?!\s*(?:Bearer|Basic)\s+\*\*\*(?=$|[\r\n]))[^\r\n]+/gi, "$1***");
  s = s.replace(
    /((?:^|[\r\n])\s*(?:cookie|set-cookie|x-api-key|api[-_]?key|apikey|x-goog-api-key|x-auth-token|api[-_]?token|access_token|refresh_token|client[-_]?secret|secret|password|passwd|(?:[a-z0-9_-]*[-_])?auth(?:[-_][a-z0-9_-]+)?|[a-z0-9_-]*authentication[a-z0-9_-]*|[a-z0-9_-]*credential[a-z0-9_-]*)\s*[:=]\s*)[^\r\n]+/gi,
    "$1***"
  );
  s = s.replace(/\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi, "Bearer ***");
  s = s.replace(SENSITIVE_URL_PARAM_VALUE_RE, "$1***");
  s = s.replace(SENSITIVE_INLINE_PARAM_VALUE_RE, "$1***");
  s = redactSensitiveLineAssignments(s);
  s = redactSensitiveInlineAssignments(s);
  s = s.replace(/\bace_[A-Za-z0-9]{16,}\b/g, "ace_***");
  s = s.replace(/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, "sk-ant-***");
  s = s.replace(/\bsk-proj-[A-Za-z0-9_-]{16,}\b/g, "sk-proj-***");
  s = s.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "sk-***");
  s = s.replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "AIza***");
  return truncateForLog(s, MAX_LOG_STRING_BYTES);
}

function omitMeta(key, value) {
  if (typeof value === "string") return `[omitted ${key} len=${value.length}]`;
  if (Array.isArray(value)) return `[omitted ${key} len=${value.length}]`;
  if (value && typeof value === "object") return `[omitted ${key} keys=${Object.keys(value).length}]`;
  return `[omitted ${key}]`;
}

function omitBinaryMeta(value) {
  const name = normalizeConstructorName(value);
  const len = Number(value?.byteLength ?? value?.length ?? 0);
  return `[omitted binary ${name} len=${Number.isFinite(len) && len >= 0 ? len : 0}]`;
}

function normalizeConstructorName(value) {
  const raw = typeof value?.constructor?.name === "string" ? value.constructor.name.trim() : "";
  return raw && /^[A-Za-z0-9_$]{1,80}$/.test(raw) ? raw : "data";
}

const OMIT_KEYS = new Set(["prefix","suffix","selected_code","selectedcode","blobs","chat_history","chathistory","nodes","request_nodes","requestnodes","response_nodes","responsenodes","structured_request_nodes","structuredrequestnodes","structured_output_nodes","structuredoutputnodes","rules","tool_definitions","tooldefinitions","arguments","arguments_json","argumentsjson","args","args_json","argsjson","input","input_json","inputjson","partial_json","partialjson","tool_arguments","toolarguments","tool_arguments_json","toolargumentsjson","tool_input","toolinput","tool_input_json","toolinputjson","function_arguments","functionarguments","function_arguments_json","functionargumentsjson"]);

function shouldOmitKey(keyLower) {
  return OMIT_KEYS.has(String(keyLower || "").trim().toLowerCase());
}

function shouldRedactKey(keyLower) {
  const k = String(keyLower || "").trim().toLowerCase();
  const compact = k.replace(/[^a-z0-9]/g, "");
  if (k === "authorization" || compact === "authorization" || compact === "proxyauthorization") return true;
  if (k === "x-api-key" || k === "api-key" || k === "x-goog-api-key") return true;
  if (compact.includes("apikey")) return true;
  if (compact.includes("apitoken")) return true;
  if (compact.endsWith("token")) return true;
  if (compact.includes("authentication")) return true;
  if (/(^|[^a-z0-9])auth($|[^a-z0-9])/.test(k)) return true;
  if (compact.includes("credential")) return true;
  if (compact.includes("secret")) return true;
  if (compact.includes("password")) return true;
  if (compact === "passwd") return true;
  if (compact === "cookie" || compact === "setcookie") return true;
  if (k === "encrypted_data" || k === "encrypteddata") return true;
  if (k === "iv") return true;
  return false;
}

function redactAny(value, ctx) {
  const depth = ctx && typeof ctx === "object" ? Number(ctx.depth) : 0;
  const seen = ctx && typeof ctx === "object" && ctx.seen instanceof WeakSet ? ctx.seen : new WeakSet();
  if (typeof value === "string") return redactText(value);
  if (value == null || typeof value !== "object") return value;
  if (typeof ArrayBuffer !== "undefined" && (value instanceof ArrayBuffer || ArrayBuffer.isView(value))) return omitBinaryMeta(value);
  if (depth >= MAX_LOG_DEPTH) return "[omitted depth]";
  if (seen.has(value)) return "[omitted circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const out = [];
    const limit = Math.min(value.length, MAX_LOG_ARRAY);
    for (let i = 0; i < limit; i++) out.push(redactAny(value[i], { depth: depth + 1, seen }));
    if (value.length > limit) out.push(`[... ${value.length - limit} more]`);
    return out;
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const keyLower = String(k || "").trim().toLowerCase();
    if (shouldOmitKey(keyLower)) { out[k] = omitMeta(keyLower, v); continue; }
    if (shouldRedactKey(keyLower)) {
      if (keyLower === "encrypted_data" || keyLower === "encrypteddata") out[k] = `[redacted encrypted_data len=${typeof v === "string" ? v.length : 0}]`;
      else if (keyLower === "iv") out[k] = `[redacted iv len=${typeof v === "string" ? v.length : 0}]`;
      else out[k] = "[redacted]";
      continue;
    }
    out[k] = redactAny(v, { depth: depth + 1, seen });
  }
  return out;
}


module.exports = { redactText, redactAny };
