"use strict";

const shared = require("./shared");
const openai = require("./openai");
const openaiResponses = require("./openai-responses");
const anthropic = require("./anthropic");
const gemini = require("./gemini");

module.exports = {
  normalizeAugmentChatRequest: shared.normalizeAugmentChatRequest,
  buildSystemPrompt: shared.buildSystemPrompt,
  detectUnderlyingModelType: shared.detectUnderlyingModelType,
  UNDERLYING_MODEL_NONE: shared.UNDERLYING_MODEL_NONE,
  UNDERLYING_MODEL_TITLE_GENERATION: shared.UNDERLYING_MODEL_TITLE_GENERATION,
  UNDERLYING_MODEL_SUMMARY: shared.UNDERLYING_MODEL_SUMMARY,
  convertOpenAiTools: shared.convertOpenAiTools,
  convertOpenAiResponsesTools: shared.convertOpenAiResponsesTools,
  convertAnthropicTools: shared.convertAnthropicTools,
  convertGeminiTools: shared.convertGeminiTools,
  buildToolMetaByName: shared.buildToolMetaByName,
  buildOpenAiMessages: openai.buildOpenAiMessages,
  buildOpenAiResponsesInput: openaiResponses.buildOpenAiResponsesInput,
  buildAnthropicMessages: anthropic.buildAnthropicMessages,
  buildGeminiContents: gemini.buildGeminiContents
};
