const test = require("node:test");
const assert = require("node:assert/strict");

const { openAiResponsesCompleteText } = require("../payload/extension/out/byok/providers/openai-responses/text");

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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function sseResponse(text) {
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("openai-responses complete: falls back to stream request when non-stream JSON has no text", async () => {
  await withFetchStub(
    async ({ init, calls }) => {
      const body = JSON.parse(String(init?.body || "{}"));
      if (calls.length === 1) {
        assert.equal(body.stream, false);
        return jsonResponse({ id: "resp_1", object: "response", output: [] });
      }

      assert.equal(body.stream, true);
      return sseResponse(
        [
          `event: response.output_text.delta`,
          `data: ${JSON.stringify({ delta: "hello", output_index: 0 })}`,
          ``,
          `event: response.completed`,
          `data: ${JSON.stringify({ response: { output_text: "hello world" } })}`,
          ``,
          `data: [DONE]`,
          ``
        ].join("\n")
      );
    },
    async (calls) => {
      const out = await openAiResponsesCompleteText({
        baseUrl: "https://example.test/v1",
        apiKey: "sk-test",
        model: "gpt-test",
        instructions: "sys",
        input: [{ type: "message", role: "user", content: "hi" }],
        timeoutMs: 1000,
        extraHeaders: {},
        requestDefaults: { max_output_tokens: 123 }
      });

      assert.equal(out, "hello world");
      assert.equal(calls.length, 2);
    }
  );
});

test("openai-responses complete: JSON error fails fast without stream fallback", async () => {
  await withFetchStub(
    async () =>
      jsonResponse({
        id: "resp_bad",
        object: "response",
        status: "failed",
        error: { type: "invalid_request_error", message: "bad request" }
      }),
    async (calls) => {
      await assert.rejects(
        async () =>
          await openAiResponsesCompleteText({
            baseUrl: "https://example.test/v1",
            apiKey: "sk-test",
            model: "gpt-test",
            instructions: "",
            input: [],
            timeoutMs: 1000,
            extraHeaders: {},
            requestDefaults: {}
          }),
        /OpenAI\(responses\) upstream error: invalid_request_error: bad request/
      );
      assert.equal(calls.length, 1);
    }
  );
});

test("openai-responses complete: HTTP auth-like 400 fails before fallback chains", async () => {
  await withFetchStub(
    async ({ init }) => {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.stream, false);
      assert.equal(body.unknown_option, true);
      return jsonResponse({ error: { type: "invalid_api_key", message: "invalid_api_key" } }, 400);
    },
    async (calls) => {
      await assert.rejects(
        async () =>
          await openAiResponsesCompleteText({
            baseUrl: "https://example.test/v1",
            apiKey: "sk-test",
            model: "gpt-test",
            instructions: "",
            input: [],
            timeoutMs: 1000,
            extraHeaders: {},
            requestDefaults: { max_output_tokens: 123, unknown_option: true }
          }),
        /OpenAI\(responses\) 400: invalid_api_key: invalid_api_key/
      );
      assert.equal(calls.length, 1);
    }
  );
});

test("openai-responses complete: HTTP model-not-found 400 fails before fallback chains", async () => {
  await withFetchStub(
    async ({ init }) => {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.stream, false);
      assert.equal(body.unknown_option, true);
      return jsonResponse(
        {
          error: {
            type: "invalid_request_error",
            code: "model_not_found",
            message: "The model `missing-model` does not exist"
          }
        },
        400
      );
    },
    async (calls) => {
      await assert.rejects(
        async () =>
          await openAiResponsesCompleteText({
            baseUrl: "https://example.test/v1",
            apiKey: "sk-test",
            model: "missing-model",
            instructions: "",
            input: [],
            timeoutMs: 1000,
            extraHeaders: {},
            requestDefaults: { max_output_tokens: 123, unknown_option: true }
          }),
        /OpenAI\(responses\) 400: invalid_request_error\/model_not_found: The model `missing-model` does not exist/
      );
      assert.equal(calls.length, 1);
    }
  );
});

test("openai-responses complete: non-auth 400 retries with minimal defaults", async () => {
  await withFetchStub(
    async ({ init, calls }) => {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.stream, false);
      if (calls.length === 1) {
        assert.equal(body.max_output_tokens, 123);
        assert.equal(body.unknown_option, true);
        return jsonResponse({ error: { type: "invalid_request_error", message: "unsupported field: unknown_option" } }, 400);
      }

      assert.equal(body.max_output_tokens, 123);
      assert.equal(Object.prototype.hasOwnProperty.call(body, "unknown_option"), false);
      return jsonResponse({ output_text: "ok" });
    },
    async (calls) => {
      const out = await openAiResponsesCompleteText({
        baseUrl: "https://example.test/v1",
        apiKey: "sk-test",
        model: "gpt-test",
        instructions: "",
        input: [],
        timeoutMs: 1000,
        extraHeaders: {},
        requestDefaults: { max_output_tokens: 123, unknown_option: true }
      });

      assert.equal(out, "ok");
      assert.equal(calls.length, 2);
    }
  );
});

test("openai-responses complete: stream fallback surfaces failed response event", async () => {
  await withFetchStub(
    async ({ init, calls }) => {
      const body = JSON.parse(String(init?.body || "{}"));
      if (calls.length === 1) {
        assert.equal(body.stream, false);
        return jsonResponse({ id: "resp_1", object: "response", output: [] });
      }

      assert.equal(body.stream, true);
      return sseResponse(
        [
          `event: response.completed`,
          `data: ${JSON.stringify({
            response: {
              id: "resp_bad_stream",
              status: "failed",
              error: { type: "invalid_request_error", message: "stream bad request" }
            }
          })}`,
          ``,
          `data: [DONE]`,
          ``
        ].join("\n")
      );
    },
    async (calls) => {
      await assert.rejects(
        async () =>
          await openAiResponsesCompleteText({
            baseUrl: "https://example.test/v1",
            apiKey: "sk-test",
            model: "gpt-test",
            instructions: "",
            input: [],
            timeoutMs: 1000,
            extraHeaders: {},
            requestDefaults: {}
          }),
        /stream fallback 失败: OpenAI\(responses-stream\) upstream error: invalid_request_error: stream bad request/
      );
      assert.equal(calls.length, 2);
    }
  );
});

test("openai-responses complete: stream fallback uses incomplete response output_text", async () => {
  await withFetchStub(
    async ({ init, calls }) => {
      const body = JSON.parse(String(init?.body || "{}"));
      if (calls.length === 1) {
        assert.equal(body.stream, false);
        return jsonResponse({ id: "resp_1", object: "response", output: [] });
      }

      assert.equal(body.stream, true);
      return sseResponse(
        [
          `event: response.incomplete`,
          `data: ${JSON.stringify({
            response: {
              id: "resp_incomplete",
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
              output_text: "partial answer"
            }
          })}`,
          ``,
          `data: [DONE]`,
          ``
        ].join("\n")
      );
    },
    async (calls) => {
      const out = await openAiResponsesCompleteText({
        baseUrl: "https://example.test/v1",
        apiKey: "sk-test",
        model: "gpt-test",
        instructions: "",
        input: [],
        timeoutMs: 1000,
        extraHeaders: {},
        requestDefaults: {}
      });

      assert.equal(out, "partial answer");
      assert.equal(calls.length, 2);
    }
  );
});

test("openai-responses complete: stream fallback uses completed response output array", async () => {
  await withFetchStub(
    async ({ init, calls }) => {
      const body = JSON.parse(String(init?.body || "{}"));
      if (calls.length === 1) {
        assert.equal(body.stream, false);
        return jsonResponse({ id: "resp_1", object: "response", output: [] });
      }

      assert.equal(body.stream, true);
      return sseResponse(
        [
          `event: response.completed`,
          `data: ${JSON.stringify({
            response: {
              id: "resp_output_array",
              status: "completed",
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "text from completed output array" }]
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
      const out = await openAiResponsesCompleteText({
        baseUrl: "https://example.test/v1",
        apiKey: "sk-test",
        model: "gpt-test",
        instructions: "",
        input: [],
        timeoutMs: 1000,
        extraHeaders: {},
        requestDefaults: {}
      });

      assert.equal(out, "text from completed output array");
      assert.equal(calls.length, 2);
    }
  );
});
