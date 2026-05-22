const test = require("node:test");
const assert = require("node:assert/strict");

const { withTimed } = require("../payload/extension/out/byok/core/self-test/util");
const { toolsModelCallTool } = require("../payload/extension/out/byok/core/self-test/tools-model/exec-call-tool");

test("withTimed: rethrows AbortError so cancellation can propagate", async () => {
  const err = new Error("aborted");
  err.name = "AbortError";

  await assert.rejects(
    withTimed(async () => {
      throw err;
    }),
    (e) => e === err || (e && typeof e === "object" && e.name === "AbortError")
  );
});

test("withTimed: captures ordinary failures as result objects", async () => {
  const res = await withTimed(async () => {
    throw new Error("boom");
  });

  assert.equal(res.ok, false);
  assert.equal(res.error, "boom");
  assert.ok(Number.isFinite(res.ms));
});

test("toolsModelCallTool: propagates AbortError from callTool", async () => {
  const abortErr = new Error("aborted");
  abortErr.name = "AbortError";
  const toolsModel = {
    async getToolDefinitions() {
      return [];
    },
    async callTool() {
      throw abortErr;
    }
  };

  await assert.rejects(
    toolsModelCallTool({ toolsModel, toolName: "echo", input: {}, conversationId: "conv-1", abortSignal: { aborted: false } }),
    (e) => e === abortErr || (e && typeof e === "object" && e.name === "AbortError")
  );
});

test("toolsModelCallTool: abortSignal pre-check throws AbortError", async () => {
  const toolsModel = {
    async getToolDefinitions() {
      return [];
    },
    async callTool() {
      throw new Error("should not be called");
    }
  };

  await assert.rejects(
    toolsModelCallTool({ toolsModel, toolName: "echo", input: {}, conversationId: "conv-1", abortSignal: { aborted: true } }),
    (e) => e && typeof e === "object" && e.name === "AbortError"
  );
});
