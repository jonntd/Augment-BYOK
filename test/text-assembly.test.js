const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveByokTextPromptContext } = require("../payload/extension/out/byok/runtime/shim/text-assembly");

test("text-assembly: delegated hit uses upstream body and skips endpoint extra system", async () => {
  const res = await resolveByokTextPromptContext({
    endpoint: "/completion",
    body: {
      messages: [
        { role: "system", content: "SYSTEM_RULES" },
        { role: "user", content: "hello from upstream body" }
      ]
    }
  });

  assert.equal(res.delegatedSource, "upstream.callApiBody.messages");
  assert.equal(res.system, "SYSTEM_RULES");
  assert.deepEqual(res.messages, [{ role: "user", content: "hello from upstream body" }]);
});

test("text-assembly: delegated miss with fail_open throws (no manual fallback builder)", async () => {
  await assert.rejects(
    async () =>
      await resolveByokTextPromptContext({
        endpoint: "/completion",
        body: { not_prompt: true }
      }),
    /official text assembler delegation failed: invalid_request_body/
  );
});

test("text-assembly: unsupported endpoint throws", async () => {
  await assert.rejects(
    async () =>
      await resolveByokTextPromptContext({
        endpoint: "/unknown",
        body: { message: "hello" }
      }),
    /official text assembler delegation failed: unsupported_endpoint/
  );
});

test("text-assembly: removed endpoints (including next-edit-stream) are rejected", async () => {
  for (const endpoint of ["/next-edit-stream", "/edit", "/generate-conversation-title", "/next_edit_loc", "/instruction-stream", "/smart-paste-stream"]) {
    await assert.rejects(
      async () =>
        await resolveByokTextPromptContext({
          endpoint,
          body: {
            instruction: "insert debug call",
            path: "src/a.js",
            lang: "javascript",
            prefix: "const a = 1;\n",
            selected_text: "",
            suffix: "return a;\n",
            chat_history: [{ role: "user", content: "name this chat" }]
          }
        }),
      /official text assembler delegation failed: unsupported_endpoint/
    );
  }
});
