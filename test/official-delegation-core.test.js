const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isOfficialDelegationEndpoint,
  isOfficialExecutionDelegationEndpoint
} = require("../payload/extension/out/byok/core/official-delegation");

test("official-delegation-core: endpoint matcher only accepts chat/chat-stream", () => {
  assert.equal(isOfficialDelegationEndpoint("/chat"), true);
  assert.equal(isOfficialDelegationEndpoint("/chat-stream"), true);
  assert.equal(isOfficialDelegationEndpoint("/completion"), false);
});

test("official-delegation-core: execution delegation endpoint matcher accepts current non-chat endpoints only", () => {
  assert.equal(isOfficialExecutionDelegationEndpoint("/chat"), true);
  assert.equal(isOfficialExecutionDelegationEndpoint("/completion"), true);
  assert.equal(isOfficialExecutionDelegationEndpoint("/prompt-enhancer"), true);
  assert.equal(isOfficialExecutionDelegationEndpoint("/next-edit-stream"), true);
  assert.equal(isOfficialExecutionDelegationEndpoint("/generate-commit-message-stream"), true);
  assert.equal(isOfficialExecutionDelegationEndpoint("/instruction-stream"), false);
  assert.equal(isOfficialExecutionDelegationEndpoint("/smart-paste-stream"), false);
  assert.equal(isOfficialExecutionDelegationEndpoint("/next_edit_loc"), false);
  assert.equal(isOfficialExecutionDelegationEndpoint("/unknown"), false);
});
