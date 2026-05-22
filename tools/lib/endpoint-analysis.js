"use strict";

function skipQuoted(src, start) {
  const quote = src[start];
  let i = start + 1;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === quote) return i + 1;
  }
  return src.length;
}

function skipComment(src, start) {
  if (src[start] !== "/") return start;
  const next = src[start + 1];
  if (next === "/") {
    const end = src.indexOf("\n", start + 2);
    return end >= 0 ? end + 1 : src.length;
  }
  if (next === "*") {
    const end = src.indexOf("*/", start + 2);
    return end >= 0 ? end + 2 : src.length;
  }
  return start;
}

function findCallEndOrThirdComma(src, start) {
  let depth = 0;
  let commas = 0;
  for (let i = start; i < src.length; i++) {
    const skippedComment = skipComment(src, i);
    if (skippedComment !== i) {
      i = skippedComment - 1;
      continue;
    }

    const ch = src[i];
    if (ch === "\"" || ch === "'" || ch === "`") {
      i = skipQuoted(src, i) - 1;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") {
      depth += 1;
      continue;
    }
    if (ch === ")" || ch === "}" || ch === "]") {
      if (ch === ")" && depth === 0) return { end: i, closed: true };
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (ch === "," && depth === 0) {
      commas += 1;
      if (commas >= 3) return { end: i, closed: false };
    }
  }
  return { end: src.length, closed: false };
}

function pickThirdArg(src, argsStart) {
  let depth = 0;
  let commas = 0;
  let thirdStart = -1;
  const endInfo = findCallEndOrThirdComma(src, argsStart);
  for (let i = argsStart; i < endInfo.end; i++) {
    const skippedComment = skipComment(src, i);
    if (skippedComment !== i) {
      i = skippedComment - 1;
      continue;
    }

    const ch = src[i];
    if (ch === "\"" || ch === "'" || ch === "`") {
      i = skipQuoted(src, i) - 1;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") {
      depth += 1;
      continue;
    }
    if (ch === ")" || ch === "}" || ch === "]") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (ch === "," && depth === 0) {
      commas += 1;
      if (commas === 2) thirdStart = i + 1;
      continue;
    }
  }
  if (thirdStart < 0) return "";
  return src.slice(thirdStart, endInfo.end).trim();
}

function parseStaticStringLiteral(raw) {
  const s = String(raw || "").trim();
  const quote = s[0];
  if (quote !== "\"" && quote !== "'" && quote !== "`") return "";

  let out = "";
  for (let i = 1; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\") {
      if (i + 1 < s.length) out += s[++i];
      continue;
    }
    if (quote === "`" && ch === "$" && s[i + 1] === "{") return "";
    if (ch === quote) return out;
    out += ch;
  }
  return "";
}

function isIdentifierChar(ch) {
  return /[A-Za-z0-9_$]/.test(String(ch || ""));
}

function findOpenParenAfterName(src, index, name) {
  const end = index + name.length;
  if (isIdentifierChar(src[index - 1]) || isIdentifierChar(src[end])) return -1;

  let i = end;
  while (i < src.length && /\s/.test(src[i])) i += 1;
  return src[i] === "(" ? i : -1;
}

function* findCallApiCallSites(src) {
  const text = String(src || "");
  for (let i = 0; i < text.length; i++) {
    const skippedComment = skipComment(text, i);
    if (skippedComment !== i) {
      i = skippedComment - 1;
      continue;
    }

    const ch = text[i];
    if (ch === "\"" || ch === "'" || ch === "`") {
      i = skipQuoted(text, i) - 1;
      continue;
    }

    if (text.startsWith("callApiStream", i)) {
      const paren = findOpenParenAfterName(text, i, "callApiStream");
      if (paren >= 0) {
        yield { kind: "callApiStream", argsStart: paren + 1 };
        i = paren;
      }
      continue;
    }

    if (text.startsWith("callApi", i)) {
      const paren = findOpenParenAfterName(text, i, "callApi");
      if (paren >= 0) {
        yield { kind: "callApi", argsStart: paren + 1 };
        i = paren;
      }
    }
  }
}

function extractCallApiEndpoints(src) {
  const endpoints = new Map();
  for (const site of findCallApiCallSites(src)) {
    const kind = site.kind;
    const argsStart = site.argsStart;
    const text = String(src || "");
    const epRaw = parseStaticStringLiteral(pickThirdArg(text, argsStart));
    if (!epRaw) continue;
    const ep = epRaw.startsWith("/") ? epRaw : "/" + epRaw;
    const v = endpoints.get(ep) || { callApi: 0, callApiStream: 0 };
    v[kind] += 1;
    endpoints.set(ep, v);
  }
  return endpoints;
}

function endpointDetailsFromSource(src) {
  return Object.fromEntries(Array.from(extractCallApiEndpoints(src).entries()).map(([k, v]) => [k, v]));
}

function sortedEndpointList(endpointDetails) {
  const details = endpointDetails && typeof endpointDetails === "object" ? endpointDetails : {};
  return Object.keys(details).sort();
}

module.exports = {
  extractCallApiEndpoints,
  endpointDetailsFromSource,
  sortedEndpointList
};
