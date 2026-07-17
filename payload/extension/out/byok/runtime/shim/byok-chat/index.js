"use strict";

const { filterOfficialContextToolDefinitions } = require("../../official/common");
const { withTiming } = require("../../../infra/trace");
const { makeBackChatResult } = require("../../../core/protocol");
const { completeAugmentChatTextByProviderType } = require("../../../core/provider-augment-chat");
const {
  buildByokAugmentChatContext
} = require("../augment-chat");

async function byokChat({ cfg, provider, model, requestedModel, body, timeoutMs, abortSignal, upstreamCompletionURL, upstreamApiToken, requestId }) {
  const ctx = await buildByokAugmentChatContext({
    kind: "chat",
    endpoint: "/chat",
    cfg,
    provider,
    model,
    requestedModel,
    body,
    timeoutMs,
    abortSignal,
    upstreamCompletionURL,
    upstreamApiToken,
    requestId
  });
  if (ctx.empty) return makeBackChatResult("", { nodes: [], meta: ctx.responseMeta });

  // Apply config-level kill switch: remove official context tool definitions.
  if (Array.isArray(ctx.req.tool_definitions)) {
    ctx.req.tool_definitions = filterOfficialContextToolDefinitions(ctx.req.tool_definitions);
  }

  const text = await withTiming(ctx.traceLabel, async () =>
    await completeAugmentChatTextByProviderType({
      type: ctx.type,
      baseUrl: ctx.baseUrl,
      apiKey: ctx.apiKey,
      model: ctx.model,
      req: ctx.req,
      timeoutMs,
      abortSignal,
      extraHeaders: ctx.extraHeaders,
      requestDefaults: ctx.requestDefaults
    })
  );

  return makeBackChatResult(text, { nodes: [], meta: ctx.responseMeta });
}

module.exports = { byokChat };
