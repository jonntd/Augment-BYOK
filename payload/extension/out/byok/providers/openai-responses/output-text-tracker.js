"use strict";

function normalizeOutputIndex(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function hasExplicitOutputIndex(v) {
  if (v === undefined || v === null || v === "") return false;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0;
}

function createOutputTextTracker() {
  const fullTextByOutputIndex = new Map();
  const implicitTextByOutputIndex = new Map();
  let emittedText = "";

  const append = (map, idx, delta) => {
    map.set(idx, (map.get(idx) || "") + delta);
  };

  const rememberRest = (idx, rest) => {
    if (rest) emittedText += rest;
    return { idx, rest };
  };

  const findImplicitPrefixMatch = (full) => {
    let best = null;
    for (const [idx, prev] of implicitTextByOutputIndex.entries()) {
      if (!prev || !full.startsWith(prev)) continue;
      if (!best || prev.length > best.prev.length) best = { idx, prev };
    }
    return best;
  };

  const findAnyPrefixMatch = (full) => {
    let best = null;
    for (const [idx, prev] of fullTextByOutputIndex.entries()) {
      if (!prev || !full.startsWith(prev)) continue;
      if (!best || prev.length > best.prev.length) best = { idx, prev };
    }
    return best;
  };

  const buildAggregateText = () =>
    Array.from(fullTextByOutputIndex.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([, text]) => (typeof text === "string" ? text : ""))
      .join("");

  const pushDelta = (outputIndex, deltaRaw) => {
    const idx = normalizeOutputIndex(outputIndex);
    const explicit = hasExplicitOutputIndex(outputIndex);
    const delta = typeof deltaRaw === "string" ? deltaRaw : "";
    if (!delta) return { idx, delta: "" };
    append(fullTextByOutputIndex, idx, delta);
    if (!explicit) append(implicitTextByOutputIndex, idx, delta);
    emittedText += delta;
    return { idx, delta };
  };

  const applyFinalText = (outputIndex, fullTextRaw) => {
    const idx = normalizeOutputIndex(outputIndex);
    const explicit = hasExplicitOutputIndex(outputIndex);
    const full = typeof fullTextRaw === "string" ? fullTextRaw : "";
    if (!full) return { idx, rest: "" };

    if (!explicit) {
      if (emittedText) {
        if (full.startsWith(emittedText)) {
          const rest = full.slice(emittedText.length);
          emittedText = full;
          return { idx, rest };
        }
        if (emittedText.startsWith(full)) return { idx, rest: "" };
      }

      const aggregate = buildAggregateText();
      if (aggregate) {
        if (full.startsWith(aggregate)) {
          const rest = full.slice(aggregate.length);
          emittedText = full;
          return { idx, rest };
        }
        if (aggregate.startsWith(full)) {
          emittedText = aggregate;
          return { idx, rest: "" };
        }
      }
    }

    const prev = fullTextByOutputIndex.get(idx) || "";
    if (!prev) {
      if (!explicit) {
        const matched = findAnyPrefixMatch(full);
        if (matched) {
          fullTextByOutputIndex.set(matched.idx, full);
          if (implicitTextByOutputIndex.get(matched.idx) === matched.prev) implicitTextByOutputIndex.set(matched.idx, full);
          return rememberRest(matched.idx, full.slice(matched.prev.length));
        }
      }

      if (explicit) {
        const implicit = findImplicitPrefixMatch(full);
        if (implicit) {
          fullTextByOutputIndex.set(idx, full);
          implicitTextByOutputIndex.delete(implicit.idx);
          if (implicit.idx !== idx && fullTextByOutputIndex.get(implicit.idx) === implicit.prev) {
            fullTextByOutputIndex.delete(implicit.idx);
          }
          return rememberRest(idx, full.slice(implicit.prev.length));
        }
      }

      fullTextByOutputIndex.set(idx, full);
      if (!explicit) implicitTextByOutputIndex.set(idx, full);
      return rememberRest(idx, full);
    }

    const prevIsImplicit = implicitTextByOutputIndex.get(idx) === prev;
    if (full.startsWith(prev)) {
      fullTextByOutputIndex.set(idx, full);
      if (!explicit) implicitTextByOutputIndex.set(idx, full);
      else if (prevIsImplicit) implicitTextByOutputIndex.delete(idx);
      return rememberRest(idx, full.slice(prev.length));
    }

    if (explicit && prevIsImplicit) {
      const implicit = findImplicitPrefixMatch(full);
      if (implicit) {
        fullTextByOutputIndex.set(idx, full);
        implicitTextByOutputIndex.delete(implicit.idx);
        return rememberRest(idx, full.slice(implicit.prev.length));
      }

      fullTextByOutputIndex.set(idx, full);
      return rememberRest(idx, full);
    }

    return { idx, rest: "" };
  };

  return { pushDelta, applyFinalText };
}

module.exports = { normalizeOutputIndex, createOutputTextTracker };
