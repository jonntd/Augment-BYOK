const test = require("node:test");
const assert = require("node:assert/strict");

const { anthropicChatStreamChunks } = require("../payload/extension/out/byok/providers/anthropic");
const { postAnthropicWithFallbacks } = require("../payload/extension/out/byok/providers/anthropic/request");

async function withFetchStub(handler, fn) {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body || "{}"));
    calls.push({ url: String(url), body });
    return await handler({ url: String(url), init, body, calls });
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = previous;
  }
}

function anthropicError(message) {
  return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), {
    status: 422,
    headers: { "content-type": "application/json" }
  });
}

function anthropicAuthError(message) {
  return new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message } }), {
    status: 422,
    headers: { "content-type": "application/json" }
  });
}

function okResponse() {
  return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

test("anthropic fallback: converts system and message strings to blocks only when gateway asks", async () => {
  await withFetchStub(
    async ({ calls }) => {
      if (calls.length === 1) return anthropicError("system: invalid type: string");
      if (calls.length === 2) return anthropicError("messages[0].content: invalid type: string");
      return okResponse();
    },
    async (calls) => {
      const resp = await postAnthropicWithFallbacks({
        baseLabel: "Anthropic(test)",
        timeoutMs: 1000,
        attempts: [
          {
            request: {
              baseUrl: "https://anthropic.test/v1",
              apiKey: "sk-ant-test",
              model: "claude-test",
              system: "system text",
              messages: [{ role: "user", content: "hello" }],
              tools: [],
              extraHeaders: {},
              requestDefaults: { max_tokens: 128 },
              stream: false
            }
          }
        ]
      });

      assert.equal(resp.ok, true);
      assert.equal(calls.length, 3);
      assert.equal(typeof calls[0].body.system, "string");
      assert.equal(typeof calls[0].body.messages[0].content, "string");
      assert.equal(Array.isArray(calls[1].body.system), true);
      assert.equal(typeof calls[1].body.messages[0].content, "string");
      assert.equal(Array.isArray(calls[2].body.system), true);
      assert.equal(Array.isArray(calls[2].body.messages[0].content), true);
      assert.deepEqual(calls[2].body.messages[0].content, [{ type: "text", text: "hello" }]);
    }
  );
});

test("anthropic fallback: removes tool_choice before dropping tools", async () => {
  const tools = [{ name: "lookup", input_schema: { type: "object", properties: {} } }];
  await withFetchStub(
    async ({ calls }) => (calls.length === 1 ? anthropicError("tool_choice is not supported") : okResponse()),
    async (calls) => {
      const resp = await postAnthropicWithFallbacks({
        baseLabel: "Anthropic(test-tool-choice)",
        timeoutMs: 1000,
        attempts: [
          {
            labelSuffix: "",
            request: {
              baseUrl: "https://anthropic.test/v1",
              apiKey: "sk-ant-test",
              model: "claude-test",
              system: "",
              messages: [{ role: "user", content: "hello" }],
              tools,
              extraHeaders: {},
              requestDefaults: { max_tokens: 128 },
              stream: true,
              includeToolChoice: true
            }
          },
          {
            labelSuffix: ":no-tool-choice",
            request: {
              baseUrl: "https://anthropic.test/v1",
              apiKey: "sk-ant-test",
              model: "claude-test",
              system: "",
              messages: [{ role: "user", content: "hello" }],
              tools,
              extraHeaders: {},
              requestDefaults: { max_tokens: 128 },
              stream: true,
              includeToolChoice: false
            }
          }
        ]
      });

      assert.equal(resp.ok, true);
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0].body.tool_choice, { type: "auto" });
      assert.equal(Object.prototype.hasOwnProperty.call(calls[1].body, "tool_choice"), false);
      assert.ok(Array.isArray(calls[1].body.tools), "no-tool-choice retry still keeps tools");
    }
  );
});

test("anthropic fallback: auth-like 422 does not enter compatibility retries", async () => {
  await withFetchStub(
    async () => anthropicAuthError("invalid_api_key"),
    async (calls) => {
      await assert.rejects(
        async () =>
          await postAnthropicWithFallbacks({
            baseLabel: "Anthropic(test-auth)",
            timeoutMs: 1000,
            attempts: [
              {
                request: {
                  baseUrl: "https://anthropic.test/v1",
                  apiKey: "bad-key",
                  model: "claude-test",
                  system: "system text",
                  messages: [{ role: "user", content: "hello" }],
                  tools: [],
                  extraHeaders: {},
                  requestDefaults: { max_tokens: 128 },
                  stream: false
                }
              }
            ]
          }),
        /Anthropic\(test-auth\) 422: first: authentication_error: invalid_api_key/
      );

      assert.equal(calls.length, 1);
      assert.equal(typeof calls[0].body.system, "string");
      assert.equal(typeof calls[0].body.messages[0].content, "string");
    }
  );
});

test("anthropic fallback: model-not-found 422 does not enter compatibility retries", async () => {
  const tools = [{ name: "lookup", input_schema: { type: "object", properties: {} } }];
  await withFetchStub(
    async ({ calls }) => (calls.length === 1 ? anthropicError("model_not_found: The model `claude-missing` does not exist") : okResponse()),
    async (calls) => {
      await assert.rejects(
        async () =>
          await postAnthropicWithFallbacks({
            baseLabel: "Anthropic(test-model)",
            timeoutMs: 1000,
            attempts: [
              {
                request: {
                  baseUrl: "https://anthropic.test/v1",
                  apiKey: "sk-ant-test",
                  model: "claude-missing",
                  system: "system text",
                  messages: [{ role: "user", content: "hello" }],
                  tools,
                  extraHeaders: {},
                  requestDefaults: { max_tokens: 128, temperature: 0.2 },
                  stream: true,
                  includeToolChoice: true
                }
              },
              {
                labelSuffix: ":no-tool-choice",
                request: {
                  baseUrl: "https://anthropic.test/v1",
                  apiKey: "sk-ant-test",
                  model: "claude-missing",
                  system: "system text",
                  messages: [{ role: "user", content: "hello" }],
                  tools,
                  extraHeaders: {},
                  requestDefaults: { max_tokens: 128 },
                  stream: true,
                  includeToolChoice: false
                }
              }
            ]
          }),
        /Anthropic\(test-model\) 422: first: invalid_request_error: model_not_found: The model `claude-missing` does not exist/
      );

      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].body.tool_choice, { type: "auto" });
      assert.ok(Array.isArray(calls[0].body.tools), "model failure should not drop tools");
      assert.equal(calls[0].body.temperature, 0.2);
    }
  );
});

test("anthropic chat fallback: strips images before dropping tools/tool blocks", async () => {
  const tools = [{ name: "lookup", input_schema: { type: "object", properties: {} } }];
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "hello" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
        { type: "tool_result", tool_use_id: "tu1", content: "result text" }
      ]
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu1", name: "lookup", input: { q: "x" } }]
    }
  ];

  await withFetchStub(
    async ({ calls }) => {
      if (calls.length === 1) return anthropicError("tool_choice is not supported");
      if (calls.length === 2) return anthropicError("images are not supported");
      if (calls.length === 3) return anthropicError("tools and tool blocks are not supported");
      return okResponse();
    },
    async (calls) => {
      const chunks = [];
      for await (const chunk of anthropicChatStreamChunks({
        baseUrl: "https://anthropic.test/v1",
        apiKey: "sk-ant-test",
        model: "claude-test",
        system: "system text",
        messages,
        tools,
        timeoutMs: 1000,
        extraHeaders: {},
        requestDefaults: { max_tokens: 128, temperature: 0.2 },
        supportToolUseStart: true
      })) {
        chunks.push(chunk);
      }

      assert.ok(chunks.some((c) => c && c.text === "ok"));
      assert.equal(calls.length, 4);

      assert.deepEqual(calls[0].body.tool_choice, { type: "auto" });
      assert.ok(Array.isArray(calls[0].body.tools));
      assert.match(JSON.stringify(calls[0].body.messages), /"type":"image"/);
      assert.match(JSON.stringify(calls[0].body.messages), /"type":"tool_use"/);

      assert.equal(Object.prototype.hasOwnProperty.call(calls[1].body, "tool_choice"), false);
      assert.ok(Array.isArray(calls[1].body.tools), "no-tool-choice retry still keeps tools");
      assert.match(JSON.stringify(calls[1].body.messages), /"type":"tool_use"/);

      assert.equal(Object.prototype.hasOwnProperty.call(calls[2].body, "tool_choice"), false);
      assert.ok(Array.isArray(calls[2].body.tools), "no-images retry still keeps tools");
      const noImagesMessagesJson = JSON.stringify(calls[2].body.messages);
      assert.doesNotMatch(noImagesMessagesJson, /"type":"image"/);
      assert.match(noImagesMessagesJson, /"type":"tool_use"/);
      assert.match(noImagesMessagesJson, /"type":"tool_result"/);
      assert.match(noImagesMessagesJson, /\[image omitted\]/);

      assert.equal(Object.prototype.hasOwnProperty.call(calls[3].body, "tools"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(calls[3].body, "tool_choice"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(calls[3].body, "temperature"), false);
      assert.equal(calls[3].body.max_tokens, 128);
      const finalMessagesJson = JSON.stringify(calls[3].body.messages);
      assert.doesNotMatch(finalMessagesJson, /"type":"image"/);
      assert.doesNotMatch(finalMessagesJson, /"type":"tool_use"/);
      assert.doesNotMatch(finalMessagesJson, /"type":"tool_result"/);
      assert.match(finalMessagesJson, /\[image omitted\]/);
      assert.match(finalMessagesJson, /\[tool_use name=lookup id=tu1\]/);
      assert.match(finalMessagesJson, /\[tool_result tool_use_id=tu1\]/);
    }
  );
});

test("anthropic chat fallback: image-only incompatibility recovers without dropping tools", async () => {
  const tools = [{ name: "lookup", input_schema: { type: "object", properties: {} } }];
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "hello" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }
      ]
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu1", name: "lookup", input: { q: "x" } }]
    }
  ];

  await withFetchStub(
    async ({ calls }) => (calls.length < 3 ? anthropicError("image blocks are not supported") : okResponse()),
    async (calls) => {
      const chunks = [];
      for await (const chunk of anthropicChatStreamChunks({
        baseUrl: "https://anthropic.test/v1",
        apiKey: "sk-ant-test",
        model: "claude-test",
        system: "system text",
        messages,
        tools,
        timeoutMs: 1000,
        extraHeaders: {},
        requestDefaults: { max_tokens: 128, temperature: 0.2 },
        supportToolUseStart: true
      })) {
        chunks.push(chunk);
      }

      assert.ok(chunks.some((c) => c && c.text === "ok"));
      assert.equal(calls.length, 3);

      assert.deepEqual(calls[0].body.tool_choice, { type: "auto" });
      assert.ok(Array.isArray(calls[0].body.tools));
      assert.match(JSON.stringify(calls[0].body.messages), /"type":"image"/);

      assert.equal(Object.prototype.hasOwnProperty.call(calls[1].body, "tool_choice"), false);
      assert.ok(Array.isArray(calls[1].body.tools));
      assert.match(JSON.stringify(calls[1].body.messages), /"type":"image"/);

      assert.equal(Object.prototype.hasOwnProperty.call(calls[2].body, "tool_choice"), false);
      assert.ok(Array.isArray(calls[2].body.tools), "no-images retry must keep tools");
      assert.equal(calls[2].body.temperature, 0.2);
      const noImagesMessagesJson = JSON.stringify(calls[2].body.messages);
      assert.doesNotMatch(noImagesMessagesJson, /"type":"image"/);
      assert.match(noImagesMessagesJson, /"type":"tool_use"/);
      assert.match(noImagesMessagesJson, /\[image omitted\]/);
    }
  );
});
