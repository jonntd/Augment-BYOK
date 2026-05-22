const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const {
  fetchOpenAiChatCompletionResponseWithFallbackDefaults,
  postOpenAiChatStreamWithFallbacks
} = require("../payload/extension/out/byok/providers/openai/chat-completions-util");

function startOpenAiServer(handler) {
  return new Promise((resolve) => {
    const calls = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const bodyText = Buffer.concat(chunks).toString("utf8");
        const body = bodyText ? JSON.parse(bodyText) : {};
        calls.push({ method: req.method, url: req.url, body });
        handler(req, res, body, calls.length);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, calls, baseUrl: `http://127.0.0.1:${addr.port}/v1` });
    });
  });
}

function jsonError(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

test("openai-compatible fallback: 400 auth-like error fails fast", async () => {
  const { server, calls, baseUrl } = await startOpenAiServer((req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    jsonError(res, 400, { error: { type: "authentication_error", message: "invalid API key" } });
  });

  try {
    await assert.rejects(
      async () =>
        await fetchOpenAiChatCompletionResponseWithFallbackDefaults({
          baseUrl,
          apiKey: "sk-test-openai",
          model: "gpt-test",
          messages: [{ role: "user", content: "hello" }],
          requestDefaults: { temperature: 0.2, unknown_option: true },
          timeoutMs: 2000,
          label: "OpenAI(test-auth)"
        }),
      /OpenAI\(test-auth\) 400: authentication_error: invalid API key/
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.unknown_option, true);
  } finally {
    await closeServer(server);
  }
});

test("openai-compatible fallback: 400 quota-like error fails fast", async () => {
  const { server, calls, baseUrl } = await startOpenAiServer((req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    jsonError(res, 400, { error: { type: "insufficient_quota", message: "You exceeded your current quota." } });
  });

  try {
    await assert.rejects(
      async () =>
        await fetchOpenAiChatCompletionResponseWithFallbackDefaults({
          baseUrl,
          apiKey: "sk-test-openai",
          model: "gpt-test",
          messages: [{ role: "user", content: "hello" }],
          requestDefaults: { temperature: 0.2, unknown_option: true },
          timeoutMs: 2000,
          label: "OpenAI(test-quota)"
        }),
      /OpenAI\(test-quota\) 400: insufficient_quota: You exceeded your current quota\./
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.unknown_option, true);
  } finally {
    await closeServer(server);
  }
});

test("openai-compatible fallback: 400 model-not-found error fails fast", async () => {
  const { server, calls, baseUrl } = await startOpenAiServer((req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    jsonError(res, 400, { error: { type: "invalid_request_error", code: "model_not_found", message: "The model `missing-model` does not exist" } });
  });

  try {
    await assert.rejects(
      async () =>
        await fetchOpenAiChatCompletionResponseWithFallbackDefaults({
          baseUrl,
          apiKey: "sk-test-openai",
          model: "missing-model",
          messages: [{ role: "user", content: "hello" }],
          requestDefaults: { temperature: 0.2, unknown_option: true },
          timeoutMs: 2000,
          label: "OpenAI(test-model)"
        }),
      /OpenAI\(test-model\) 400: invalid_request_error\/model_not_found: The model `missing-model` does not exist/
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.unknown_option, true);
  } finally {
    await closeServer(server);
  }
});

test("openai-compatible fallback: non-auth 400 retries with minimal defaults", async () => {
  const { server, calls, baseUrl } = await startOpenAiServer((req, res, body, callNo) => {
    assert.equal(req.url, "/v1/chat/completions");
    if (callNo === 1) {
      assert.equal(body.unknown_option, true);
      jsonError(res, 400, { error: { type: "invalid_request_error", message: "unsupported field: unknown_option" } });
      return;
    }
    assert.equal(body.unknown_option, undefined);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "ok" }));
  });

  try {
    const resp = await fetchOpenAiChatCompletionResponseWithFallbackDefaults({
      baseUrl,
      apiKey: "sk-test-openai",
      model: "gpt-test",
      messages: [{ role: "user", content: "hello" }],
      requestDefaults: { temperature: 0.2, unknown_option: true },
      timeoutMs: 2000,
      label: "OpenAI(test-fallback)"
    });
    assert.equal(resp.status, 200);
    assert.equal(calls.length, 2);
  } finally {
    await closeServer(server);
  }
});

test("openai-compatible stream fallback: strips images before dropping tools/functions", async () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "lookup",
        description: "lookup",
        parameters: { type: "object", properties: {} }
      }
    }
  ];
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "describe this image" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" } }
      ]
    }
  ];
  const { server, calls, baseUrl } = await startOpenAiServer((req, res, body, callNo) => {
    assert.equal(req.url, "/v1/chat/completions");
    if (callNo < 5) {
      jsonError(res, 400, { error: { type: "invalid_request_error", message: "image_url is not supported" } });
      return;
    }

    assert.equal(Array.isArray(body.tools), true, "image-only fallback should preserve tools before legacy functions/no-tools");
    assert.equal(Object.prototype.hasOwnProperty.call(body, "functions"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(body, "tool_choice"), false);
    assert.equal(body.unknown_option, undefined);
    assert.equal(body.temperature, 0.2);
    assert.equal(body.messages[0].content, "describe this image\n\n[non-text content omitted]");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: [DONE]\n\n");
  });

  try {
    const resp = await postOpenAiChatStreamWithFallbacks({
      baseUrl,
      apiKey: "sk-test-openai",
      model: "gpt-test",
      messages,
      tools,
      requestDefaults: { temperature: 0.2, unknown_option: true },
      timeoutMs: 2000
    });

    assert.equal(resp.status, 200);
    assert.equal(calls.length, 5);

    assert.ok(Array.isArray(calls[0].body.tools));
    assert.equal(calls[0].body.tool_choice, "auto");
    assert.deepEqual(calls[0].body.stream_options, { include_usage: true });
    assert.equal(calls[0].body.unknown_option, true);
    assert.ok(Array.isArray(calls[0].body.messages[0].content));

    assert.ok(Array.isArray(calls[1].body.tools));
    assert.equal(calls[1].body.tool_choice, "auto");
    assert.equal(Object.prototype.hasOwnProperty.call(calls[1].body, "stream_options"), false);
    assert.ok(Array.isArray(calls[1].body.messages[0].content));

    assert.ok(Array.isArray(calls[2].body.tools));
    assert.equal(Object.prototype.hasOwnProperty.call(calls[2].body, "tool_choice"), false);
    assert.ok(Array.isArray(calls[2].body.messages[0].content));

    assert.ok(Array.isArray(calls[3].body.tools));
    assert.equal(calls[3].body.unknown_option, undefined);
    assert.equal(calls[3].body.temperature, 0.2);
    assert.ok(Array.isArray(calls[3].body.messages[0].content));

    assert.ok(Array.isArray(calls[4].body.tools));
    assert.equal(Object.prototype.hasOwnProperty.call(calls[4].body, "functions"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(calls[4].body, "tool_choice"), false);
    assert.equal(calls[4].body.messages[0].content, "describe this image\n\n[non-text content omitted]");
  } finally {
    await closeServer(server);
  }
});
