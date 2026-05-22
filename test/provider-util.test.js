const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyParallelToolCallsPolicy,
  isAccountOrQuotaLikeErrorMessage,
  isCompatibilityFallbackError,
  isInvalidRequestStatusForFallback,
  isModelAvailabilityLikeErrorMessage
} = require("../payload/extension/out/byok/providers/provider-util");

test("isInvalidRequestStatusForFallback: supports 400/422 only", () => {
  assert.equal(isInvalidRequestStatusForFallback(400), true);
  assert.equal(isInvalidRequestStatusForFallback("400"), true);
  assert.equal(isInvalidRequestStatusForFallback(422), true);
  assert.equal(isInvalidRequestStatusForFallback(401), false);
  assert.equal(isInvalidRequestStatusForFallback(null), false);
  assert.equal(isInvalidRequestStatusForFallback(undefined), false);
});

test("isCompatibilityFallbackError: rejects auth-like 400/422 bodies", () => {
  assert.equal(isCompatibilityFallbackError({ status: 400, message: "invalid_request_error: unsupported field stream_options" }), true);
  assert.equal(isCompatibilityFallbackError({ status: 422, message: "messages[0].content invalid type string" }), true);
  assert.equal(isCompatibilityFallbackError({ status: 400, message: "authentication_error: invalid API key" }), false);
  assert.equal(isCompatibilityFallbackError({ status: 422, message: "PERMISSION_DENIED: bad api key" }), false);
  assert.equal(isCompatibilityFallbackError({ status: 400, message: "invalid_api_key" }), false);
  assert.equal(isCompatibilityFallbackError({ status: 400, message: "UNAUTHENTICATED" }), false);
  assert.equal(isCompatibilityFallbackError({ status: 400, message: "Authorization header is malformed" }), false);
  assert.equal(isCompatibilityFallbackError({ status: 422, message: "ACCESS_DENIED: client_secret rejected" }), false);
  assert.equal(isCompatibilityFallbackError({ status: 400, message: "password authentication failed" }), false);
});

test("isCompatibilityFallbackError: rejects account/quota 400/422 bodies", () => {
  assert.equal(isAccountOrQuotaLikeErrorMessage("RESOURCE_EXHAUSTED: quota exceeded"), true);
  assert.equal(isCompatibilityFallbackError({ status: 400, message: "insufficient_quota: exceeded your current quota" }), false);
  assert.equal(isCompatibilityFallbackError({ status: 422, message: "RESOURCE_EXHAUSTED: quota exceeded" }), false);
  assert.equal(isCompatibilityFallbackError({ status: 400, message: "billing_not_active: billing account disabled" }), false);
  assert.equal(isCompatibilityFallbackError({ status: 400, message: "payment_required: add credits to continue" }), false);
  assert.equal(isCompatibilityFallbackError({ status: 400, message: "rate limit exceeded for this project" }), false);
  assert.equal(isCompatibilityFallbackError({ status: 400, message: "unsupported field rate_limit" }), true);
});

test("isCompatibilityFallbackError: rejects model availability 400/422 bodies", () => {
  assert.equal(isModelAvailabilityLikeErrorMessage("model_not_found: The model 'missing-model' does not exist"), true);
  assert.equal(isCompatibilityFallbackError({ status: 400, message: "model_not_found: The model 'missing-model' does not exist" }), false);
  assert.equal(isCompatibilityFallbackError({ status: 422, message: "Unknown model claude-missing" }), false);
  assert.equal(isCompatibilityFallbackError({ status: 400, message: "The selected model is not available for your account" }), false);
  assert.equal(isCompatibilityFallbackError({ status: 400, message: "unsupported model: gpt-missing" }), false);
  assert.equal(isCompatibilityFallbackError({ status: 400, message: "You do not have access to the model gpt-4.1" }), false);
  assert.equal(isCompatibilityFallbackError({ status: 422, message: "Project must be verified to use this model" }), false);
  assert.equal(isCompatibilityFallbackError({ status: 400, message: "model gpt-4.1 access denied for organization" }), false);
  assert.equal(isCompatibilityFallbackError({ status: 400, message: "This model does not support tools" }), true);
  assert.equal(isCompatibilityFallbackError({ status: 400, message: "Unknown model parameter: reasoning" }), true);
  assert.equal(isCompatibilityFallbackError({ status: 422, message: "unknown model capability: image_url" }), true);
  assert.equal(isCompatibilityFallbackError({ status: 400, message: "unsupported model feature: tools" }), true);
  assert.equal(isCompatibilityFallbackError({ status: 422, message: "unsupported model parameter: image_url" }), true);
  assert.equal(isCompatibilityFallbackError({ status: 400, message: "unsupported field model" }), true);
});

test("isCompatibilityFallbackError: rejects unknown business/safety/context errors", () => {
  assert.equal(isCompatibilityFallbackError({ status: 400, message: "context length exceeded" }), false);
  assert.equal(isCompatibilityFallbackError({ status: 400, message: "prompt is too long" }), false);
  assert.equal(isCompatibilityFallbackError({ status: 400, message: "content policy violation" }), false);
  assert.equal(isCompatibilityFallbackError({ status: 422, message: "safety blocked" }), false);
  assert.equal(isCompatibilityFallbackError({ status: 400, message: "bad request" }), false);
});

test("applyParallelToolCallsPolicy: injects parallel_tool_calls=false when tools exist and supportParallelToolUse is false", () => {
  const out = applyParallelToolCallsPolicy({}, { hasTools: true, supportParallelToolUse: false });
  assert.equal(out.parallel_tool_calls, false);
});

test("applyParallelToolCallsPolicy: canonicalizes parallelToolCalls to parallel_tool_calls", () => {
  const out = applyParallelToolCallsPolicy({ parallelToolCalls: true, temperature: 0.1 }, { hasTools: true, supportParallelToolUse: false });
  assert.equal(out.parallel_tool_calls, true);
  assert.equal(Object.prototype.hasOwnProperty.call(out, "parallelToolCalls"), false);
  assert.equal(out.temperature, 0.1);
});
