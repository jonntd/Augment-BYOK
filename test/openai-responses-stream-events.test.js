const test = require("node:test");
const assert = require("node:assert/strict");

const { openAiResponsesStreamTextDeltas } = require("../payload/extension/out/byok/providers/openai-responses/text");
const { openAiResponsesChatStreamChunks } = require("../payload/extension/out/byok/providers/openai-responses/chat-stream");

async function withFetchStub(handler, fn) {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return await handler({ url: String(url), init, calls });
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = previous;
  }
}

function sseResponse(text) {
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function responseCompletedSse(response) {
  return sseResponse(
    [
      `event: response.completed`,
      `data: ${JSON.stringify({ response })}`,
      ``,
      `data: [DONE]`,
      ``
    ].join("\n")
  );
}

test("openai-responses stream: completed output array emits text when delta is absent", async () => {
  await withFetchStub(
    async ({ init }) => {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.stream, true);
      return responseCompletedSse({
        id: "resp_stream_output_array",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "stream completed output text" }]
          }
        ]
      });
    },
    async (calls) => {
      const deltas = [];
      for await (const d of openAiResponsesStreamTextDeltas({
        baseUrl: "https://example.test/v1",
        apiKey: "sk-test",
        model: "gpt-test",
        instructions: "",
        input: [],
        timeoutMs: 1000,
        extraHeaders: {},
        requestDefaults: {}
      })) {
        deltas.push(d);
      }

      assert.deepEqual(deltas, ["stream completed output text"]);
      assert.equal(calls.length, 1);
    }
  );
});

test("openai-responses chat stream: completed output array emits text when delta is absent", async () => {
  await withFetchStub(
    async ({ init }) => {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.stream, true);
      return responseCompletedSse({
        id: "resp_chat_output_array",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "chat completed output text" }]
          }
        ],
        usage: { input_tokens: 3, output_tokens: 4 }
      });
    },
    async (calls) => {
      const chunks = [];
      for await (const c of openAiResponsesChatStreamChunks({
        baseUrl: "https://example.test/v1",
        apiKey: "sk-test",
        model: "gpt-test",
        instructions: "",
        input: [],
        tools: [],
        timeoutMs: 1000,
        extraHeaders: {},
        requestDefaults: {}
      })) {
        chunks.push(c);
      }

      assert.ok(chunks.some((c) => c && c.text === "chat completed output text"));
      assert.equal(calls.length, 1);
    }
  );
});

test("openai-responses stream: completed output array uses matching output_index for dedupe", async () => {
  await withFetchStub(
    async ({ init }) => {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.stream, true);
      return sseResponse(
        [
          `event: response.output_text.delta`,
          `data: ${JSON.stringify({ delta: "hello", output_index: 1 })}`,
          ``,
          `event: response.completed`,
          `data: ${JSON.stringify({
            response: {
              id: "resp_stream_indexed_output_array",
              status: "completed",
              output_text: "hello world",
              output: [
                { type: "reasoning", summary: [] },
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "hello world" }]
                }
              ]
            }
          })}`,
          ``,
          `data: [DONE]`,
          ``
        ].join("\n")
      );
    },
    async (calls) => {
      const deltas = [];
      for await (const d of openAiResponsesStreamTextDeltas({
        baseUrl: "https://example.test/v1",
        apiKey: "sk-test",
        model: "gpt-test",
        instructions: "",
        input: [],
        timeoutMs: 1000,
        extraHeaders: {},
        requestDefaults: {}
      })) {
        deltas.push(d);
      }

      assert.deepEqual(deltas, ["hello", " world"]);
      assert.equal(calls.length, 1);
    }
  );
});

test("openai-responses chat stream: completed output array uses matching output_index for dedupe", async () => {
  await withFetchStub(
    async ({ init }) => {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.stream, true);
      return sseResponse(
        [
          `event: response.output_text.delta`,
          `data: ${JSON.stringify({ delta: "chat", output_index: 1 })}`,
          ``,
          `event: response.completed`,
          `data: ${JSON.stringify({
            response: {
              id: "resp_chat_indexed_output_array",
              status: "completed",
              output_text: "chat text",
              output: [
                { type: "reasoning", summary: [] },
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "chat text" }]
                }
              ]
            }
          })}`,
          ``,
          `data: [DONE]`,
          ``
        ].join("\n")
      );
    },
    async (calls) => {
      const chunks = [];
      for await (const c of openAiResponsesChatStreamChunks({
        baseUrl: "https://example.test/v1",
        apiKey: "sk-test",
        model: "gpt-test",
        instructions: "",
        input: [],
        tools: [],
        timeoutMs: 1000,
        extraHeaders: {},
        requestDefaults: {}
      })) {
        chunks.push(c);
      }

      const text = chunks.map((c) => (typeof c?.text === "string" ? c.text : "")).join("");
      assert.equal(text, "chat text");
      assert.equal(chunks.filter((c) => c && c.text === "chat").length, 1);
      assert.equal(calls.length, 1);
    }
  );
});

test("openai-responses stream: incomplete output array uses matching output_index for dedupe", async () => {
  await withFetchStub(
    async ({ init }) => {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.stream, true);
      return sseResponse(
        [
          `event: response.output_text.delta`,
          `data: ${JSON.stringify({ delta: "partial", output_index: 1 })}`,
          ``,
          `event: response.incomplete`,
          `data: ${JSON.stringify({
            response: {
              id: "resp_stream_indexed_incomplete_output_array",
              status: "incomplete",
              output_text: "partial text",
              incomplete_details: { reason: "max_output_tokens" },
              output: [
                { type: "reasoning", summary: [] },
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "partial text" }]
                }
              ]
            }
          })}`,
          ``,
          `data: [DONE]`,
          ``
        ].join("\n")
      );
    },
    async (calls) => {
      const deltas = [];
      for await (const d of openAiResponsesStreamTextDeltas({
        baseUrl: "https://example.test/v1",
        apiKey: "sk-test",
        model: "gpt-test",
        instructions: "",
        input: [],
        timeoutMs: 1000,
        extraHeaders: {},
        requestDefaults: {}
      })) {
        deltas.push(d);
      }

      assert.deepEqual(deltas, ["partial", " text"]);
      assert.equal(calls.length, 1);
    }
  );
});

test("openai-responses chat stream: incomplete output array uses matching output_index for dedupe", async () => {
  await withFetchStub(
    async ({ init }) => {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.stream, true);
      return sseResponse(
        [
          `event: response.output_text.delta`,
          `data: ${JSON.stringify({ delta: "partial", output_index: 1 })}`,
          ``,
          `event: response.incomplete`,
          `data: ${JSON.stringify({
            response: {
              id: "resp_chat_indexed_incomplete_output_array",
              status: "incomplete",
              output_text: "partial text",
              incomplete_details: { reason: "max_output_tokens" },
              output: [
                { type: "reasoning", summary: [] },
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "partial text" }]
                }
              ]
            }
          })}`,
          ``,
          `data: [DONE]`,
          ``
        ].join("\n")
      );
    },
    async (calls) => {
      const chunks = [];
      for await (const c of openAiResponsesChatStreamChunks({
        baseUrl: "https://example.test/v1",
        apiKey: "sk-test",
        model: "gpt-test",
        instructions: "",
        input: [],
        tools: [],
        timeoutMs: 1000,
        extraHeaders: {},
        requestDefaults: {}
      })) {
        chunks.push(c);
      }

      const text = chunks.map((c) => (typeof c?.text === "string" ? c.text : "")).join("");
      assert.equal(text, "partial text");
      assert.equal(chunks.filter((c) => c && c.text === "partial").length, 1);
      assert.equal(calls.length, 1);
    }
  );
});

test("openai-responses chat stream: completed failed response surfaces upstream error", async () => {
  await withFetchStub(
    async ({ init }) => {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.stream, true);
      return responseCompletedSse({
        id: "resp_chat_failed_completed",
        status: "failed",
        error: { type: "invalid_request_error", message: "chat stream failed via completed" }
      });
    },
    async (calls) => {
      await assert.rejects(
        async () => {
          for await (const _ of openAiResponsesChatStreamChunks({
            baseUrl: "https://example.test/v1",
            apiKey: "sk-test",
            model: "gpt-test",
            instructions: "",
            input: [],
            tools: [],
            timeoutMs: 1000,
            extraHeaders: {},
            requestDefaults: {}
          })) {
            // consume stream
          }
        },
        /OpenAI\(responses-chat-stream\) upstream error: invalid_request_error: chat stream failed via completed/
      );
      assert.equal(calls.length, 1);
    }
  );
});
