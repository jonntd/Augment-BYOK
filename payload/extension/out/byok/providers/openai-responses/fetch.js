"use strict";

const { normalizeString } = require("../../infra/util");
const { debug } = require("../../infra/log");
const { isCompatibilityFallbackError } = require("../provider-util");
const { fetchOkWithRetry } = require("../request-util");
const { buildOpenAiResponsesRequest, buildMinimalRetryRequestDefaults } = require("./request");

async function fetchOpenAiResponsesWithFallbacks({
  baseUrl,
  apiKey,
  model,
  instructions,
  input,
  tools,
  extraHeaders,
  requestDefaults,
  stream,
  timeoutMs,
  abortSignal,
  label
}) {
  const baseLabel = normalizeString(label) || "OpenAI(responses)";
  const attempts = [
    { labelSuffix: "", requestDefaults },
    { labelSuffix: ":minimal-defaults", requestDefaults: buildMinimalRetryRequestDefaults(requestDefaults) }
  ];

  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    const { url, headers, body } = buildOpenAiResponsesRequest({
      baseUrl,
      apiKey,
      model,
      instructions,
      input,
      tools,
      extraHeaders,
      requestDefaults: a.requestDefaults,
      stream: Boolean(stream)
    });
    const lab = `${baseLabel}${a.labelSuffix || ""}`;

    try {
      return await fetchOkWithRetry(url, { method: "POST", headers, body: JSON.stringify(body) }, { timeoutMs, abortSignal, label: lab });
    } catch (err) {
      lastErr = err;
      const canFallback = isCompatibilityFallbackError(err);
      const hasNext = i + 1 < attempts.length;
      if (!canFallback || !hasNext) throw err;
      debug(`${lab} fallback: retry (status=${Number(err?.status) || "unknown"})`);
    }
  }
  throw lastErr || new Error(`${baseLabel} failed`);
}

module.exports = { fetchOpenAiResponsesWithFallbacks };
