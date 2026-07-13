"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { ensureModelRegistryFeatureFlags } = require("../payload/extension/out/byok/core/model-registry");
const { makeBackGetModelsResult, makeModelInfo } = require("../payload/extension/out/byok/core/protocol");

test("ensureModelRegistryFeatureFlags enables agent auto mode for BYOK", () => {
  const flags = ensureModelRegistryFeatureFlags(
    { some_flag: true },
    { byokModelIds: ["byok:openai:gpt-5.2"], defaultModel: "byok:openai:gpt-5.2" }
  );

  assert.equal(flags.some_flag, true);
  assert.equal(flags.enableAgentAutoMode, true);
  assert.equal(flags.enable_agent_auto_mode, true);
  assert.equal(flags.agentChatModel, "byok:openai:gpt-5.2");
});

test("local get-models result includes enableAgentAutoMode", () => {
  const out = makeBackGetModelsResult({
    defaultModel: "byok:openai:gpt-5.2",
    models: [makeModelInfo("byok:openai:gpt-5.2")]
  });

  assert.equal(out.feature_flags.enableAgentAutoMode, true);
  assert.equal(out.feature_flags.enable_agent_auto_mode, true);
});
