"use strict";
const { asRecord, asArray, asString, pick, normalizeNodeType } = require("../../augment-struct");
const {
  formatIdeStateForPrompt,
  formatEditEventsForPrompt,
  formatCheckpointRefForPrompt,
  formatChangePersonalityForPrompt,
  formatImageIdForPrompt,
  formatFileIdForPrompt,
  formatFileNodeForPrompt,
  formatHistorySummaryForPrompt
} = require("../../augment-node-format");

const nodes = require("./nodes");
const tools = require("./tools");
const req = require("./request");

module.exports = {
  asRecord,
  asArray,
  asString,
  pick,
  normalizeNodeType,
  isPlaceholderMessage: nodes.isPlaceholderMessage,
  mapImageFormatToMimeType: nodes.mapImageFormatToMimeType,
  buildUserSegmentsFromRequest: nodes.buildUserSegmentsFromRequest,
  collectExchangeRequestNodes: nodes.collectExchangeRequestNodes,
  collectExchangeOutputNodes: nodes.collectExchangeOutputNodes,
  buildTextOrPartsFromSegments: nodes.buildTextOrPartsFromSegments,
  extractToolResultTextsFromRequestNodes: nodes.extractToolResultTextsFromRequestNodes,
  buildUserSegmentsWithExtraText: req.buildUserSegmentsWithExtraText,
  splitToolResultSystemHint: nodes.splitToolResultSystemHint,
  stripToolResultSystemHint: nodes.stripToolResultSystemHint,
  summarizeToolResultText: nodes.summarizeToolResultText,
  normalizeToolDefinitions: tools.normalizeToolDefinitions,
  resolveToolSchema: tools.resolveToolSchema,
  coerceOpenAiStrictJsonSchema: tools.coerceOpenAiStrictJsonSchema,
  convertOpenAiTools: tools.convertOpenAiTools,
  convertAnthropicTools: tools.convertAnthropicTools,
  convertGeminiTools: tools.convertGeminiTools,
  convertOpenAiResponsesTools: tools.convertOpenAiResponsesTools,
  buildToolMetaByName: tools.buildToolMetaByName,
  normalizeAugmentChatRequest: req.normalizeAugmentChatRequest,
  coerceRulesText: req.coerceRulesText,
  buildInlineCodeContextText: req.buildInlineCodeContextText,
  buildUserExtraTextParts: req.buildUserExtraTextParts,
  detectUnderlyingModelType: req.detectUnderlyingModelType,
  UNDERLYING_MODEL_NONE: req.UNDERLYING_MODEL_NONE,
  UNDERLYING_MODEL_TITLE_GENERATION: req.UNDERLYING_MODEL_TITLE_GENERATION,
  UNDERLYING_MODEL_SUMMARY: req.UNDERLYING_MODEL_SUMMARY,
  formatIdeStateForPrompt,
  formatEditEventsForPrompt,
  formatCheckpointRefForPrompt,
  formatChangePersonalityForPrompt,
  formatImageIdForPrompt,
  formatFileIdForPrompt,
  formatFileNodeForPrompt,
  formatHistorySummaryForPrompt,
  buildSystemPrompt: req.buildSystemPrompt,
  extractAssistantTextFromOutputNodes: nodes.extractAssistantTextFromOutputNodes,
  extractToolCallsFromOutputNodes: nodes.extractToolCallsFromOutputNodes,
  parseJsonObjectOrEmpty: req.parseJsonObjectOrEmpty
};
