const test = require("node:test");
const assert = require("node:assert/strict");

function loadFresh(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

const { maybeBuildDelegatedTextPrompt } = require("../payload/extension/out/byok/runtime/upstream/official-text-delegation");

test("official-text-delegation: builds from messages[] and keeps system as system text", async () => {
  const res = await maybeBuildDelegatedTextPrompt({
    endpoint: "/prompt-enhancer",
    body: {
      messages: [
        { role: "system", content: "SYSTEM_RULES" },
        { role: "user", content: "DO_IT" }
      ]
    }
  });

  assert.equal(res.ok, true);
  assert.equal(res.source, "upstream.callApiBody.messages");
  assert.equal(res.system, "SYSTEM_RULES");
  assert.deepEqual(res.messages, [{ role: "user", content: "DO_IT" }]);
});

test("official-text-delegation: builds from responses input[]", async () => {
  const res = await maybeBuildDelegatedTextPrompt({
    endpoint: "/completion",
    body: {
      instructions: "SYSTEM_RULES",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "COMPLETE_ME" }] }]
    }
  });

  assert.equal(res.ok, true);
  assert.equal(res.source, "upstream.callApiBody.input");
  assert.equal(res.system, "SYSTEM_RULES");
  assert.deepEqual(res.messages, [{ role: "user", content: "COMPLETE_ME" }]);
});

test("official-text-delegation: finds nested upstream body messages", async () => {
  const res = await maybeBuildDelegatedTextPrompt({
    endpoint: "/generate-commit-message-stream",
    body: {
      wrapper: {
        request: {
          messages: [{ role: "user", content: "SUMMARIZE_DIFF" }]
        }
      }
    }
  });

  assert.equal(res.ok, true);
  assert.equal(res.source, "upstream.callApiBody.messages");
  assert.deepEqual(res.messages, [{ role: "user", content: "SUMMARIZE_DIFF" }]);
});

test("official-text-delegation: completion prompt/suffix field bodies succeed", async () => {
  const withSuffix = await maybeBuildDelegatedTextPrompt({
    endpoint: "/completion",
    body: { prompt: "hello completion", suffix: "SUFFIX", path: "a.ts", lang: "typescript" }
  });
  assert.equal(withSuffix.ok, true);
  assert.equal(withSuffix.source, "upstream.callApiBody.prompt_fields");
  assert.equal(withSuffix.messages.length, 1);
  assert.equal(withSuffix.messages[0].role, "user");
  assert.match(withSuffix.messages[0].content, /PREFIX:[\s\S]*hello completion/);
  assert.match(withSuffix.messages[0].content, /SUFFIX:[\s\S]*SUFFIX/);
  assert.match(withSuffix.system, /code completion/i);
  assert.match(withSuffix.system, /a\.ts/);

  const inputOnly = await maybeBuildDelegatedTextPrompt({
    endpoint: "/chat-input-completion",
    body: { prompt: "hello input" }
  });
  assert.equal(inputOnly.ok, true);
  assert.equal(inputOnly.source, "upstream.callApiBody.prompt_fields");
  assert.match(inputOnly.messages[0].content, /hello input/);
});

test("official-text-delegation: prompt-enhancer message field succeeds", async () => {
  const res = await maybeBuildDelegatedTextPrompt({
    endpoint: "/prompt-enhancer",
    body: { message: "improve me" }
  });
  assert.equal(res.ok, true);
  assert.equal(res.source, "upstream.callApiBody.prompt_fields");
  assert.deepEqual(res.messages, [{ role: "user", content: "improve me" }]);
});

test("official-text-delegation: field-only bodies without prompt/message still fail", async () => {
  const res = await maybeBuildDelegatedTextPrompt({
    endpoint: "/generate-commit-message-stream",
    body: { diff: "diff --git a/a b/a" }
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "invalid_request_body");
});

test("official-text-delegation: chat endpoint is rejected (chat delegation handled elsewhere)", async () => {
  const res = await maybeBuildDelegatedTextPrompt({
    endpoint: "/chat",
    body: { message: "hello" }
  });

  assert.equal(res.ok, false);
  assert.equal(res.reason, "chat_endpoint_use_chat_delegation");
});

test("official-text-delegation: unsupported endpoint returns miss", async () => {
  for (const endpoint of ["/unknown", "/edit", "/generate-conversation-title"]) {
    const res = await maybeBuildDelegatedTextPrompt({
      endpoint,
      body: { message: "hello" }
    });

    assert.equal(res.ok, false);
    assert.equal(res.reason, "unsupported_endpoint");
  }
});

test("official-text-delegation: invalid non-chat body returns miss", async () => {
  const res = await maybeBuildDelegatedTextPrompt({
    endpoint: "/completion",
    body: { not_prompt: true }
  });

  assert.equal(res.ok, false);
  assert.equal(res.reason, "invalid_request_body");
});

test("official-text-delegation: audit logs emit without debug mode", async () => {
  const prev = process.env.AUGMENT_BYOK_DEBUG;
  const origLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    delete process.env.AUGMENT_BYOK_DEBUG;
    loadFresh("../payload/extension/out/byok/infra/log");
    const fresh = loadFresh("../payload/extension/out/byok/runtime/upstream/official-text-delegation");
    await fresh.maybeBuildDelegatedTextPrompt({
      endpoint: "/completion",
      body: { messages: [{ role: "user", content: "hello completion" }] }
    });
    await fresh.maybeBuildDelegatedTextPrompt({
      endpoint: "/completion",
      body: { prompt: "field-only prompt" }
    });
  } finally {
    console.log = origLog;
    if (prev === undefined) delete process.env.AUGMENT_BYOK_DEBUG;
    else process.env.AUGMENT_BYOK_DEBUG = prev;
    loadFresh("../payload/extension/out/byok/infra/log");
    loadFresh("../payload/extension/out/byok/runtime/upstream/official-text-delegation");
  }

  assert.equal(lines.some((line) => line.includes("official text assembler delegated: ep=/completion source=upstream.callApiBody.messages")), true);
  assert.equal(lines.some((line) => line.includes("official text assembler delegated: ep=/completion source=upstream.callApiBody.prompt_fields")), true);
});
