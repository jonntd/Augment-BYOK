const test = require("node:test");
const assert = require("node:assert/strict");

const { fetchGeminiWithFallbacks } = require("../payload/extension/out/byok/providers/gemini/request");

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

function badGatewayResponse(label) {
  return new Response(JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: `unsupported field: ${label}` } }), {
    status: 400,
    headers: { "content-type": "application/json" }
  });
}

function errorResponse(status, message, statusName = "ERROR") {
  return new Response(JSON.stringify({ error: { status: statusName, message } }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function flattenParts(body) {
  return (Array.isArray(body?.contents) ? body.contents : []).flatMap((c) => (Array.isArray(c?.parts) ? c.parts : []));
}

test("gemini fallback chain: no-defaults/no-images/no-tools can recover combined gateway limits", async () => {
  const contents = [
    {
      role: "user",
      parts: [
        { text: "describe this" },
        { inlineData: { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" } }
      ]
    }
  ];
  const tools = [{ functionDeclarations: [{ name: "lookup", parameters: { type: "object", properties: {} } }] }];

  await withFetchStub(
    async ({ calls }) => {
      if (calls.length < 5) return badGatewayResponse(`attempt-${calls.length}`);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    },
    async (calls) => {
      const resp = await fetchGeminiWithFallbacks({
        baseUrl: "https://generativelanguage.googleapis.com",
        apiKey: "gemini-key",
        model: "gemini-test",
        systemInstruction: "sys",
        contents,
        tools,
        extraHeaders: {},
        requestDefaults: { max_tokens: 128, unsupported_default: true },
        stream: false,
        timeoutMs: 1000,
        label: "Gemini(test)"
      });

      assert.equal(resp.ok, true);
      assert.equal(calls.length, 5);

      assert.ok(calls[0].body.generationConfig, "first attempt keeps normalized defaults");
      assert.ok(Array.isArray(calls[0].body.tools), "first attempt keeps tools");
      assert.ok(calls[0].body.contents[0].parts.some((p) => p.inlineData), "first attempt keeps image");

      assert.equal(Object.prototype.hasOwnProperty.call(calls[1].body, "generationConfig"), false);
      assert.ok(Array.isArray(calls[1].body.tools), "no-defaults keeps tools");
      assert.ok(calls[1].body.contents[0].parts.some((p) => p.inlineData), "no-defaults keeps image");

      assert.equal(Object.prototype.hasOwnProperty.call(calls[2].body, "generationConfig"), false);
      assert.ok(Array.isArray(calls[2].body.tools), "no-images keeps tools");
      assert.equal(calls[2].body.contents[0].parts.some((p) => p.inlineData), false);

      assert.equal(Object.prototype.hasOwnProperty.call(calls[3].body, "tools"), false);
      assert.ok(calls[3].body.contents[0].parts.some((p) => p.inlineData), "no-tools keeps image before final combined fallback");

      assert.equal(Object.prototype.hasOwnProperty.call(calls[4].body, "tools"), false);
      assert.equal(calls[4].body.contents[0].parts.some((p) => p.inlineData), false);
      assert.equal(calls[4].body.contents[0].parts.some((p) => p.text === "[image omitted]"), true);
    }
  );
});

test("gemini fallback chain: no-tools converts function parts to text while preserving image fallback order", async () => {
  const contents = [
    {
      role: "model",
      parts: [
        { text: "need lookup" },
        { functionCall: { id: "call-1", name: "lookup", args: { q: "x" } } }
      ]
    },
    {
      role: "user",
      parts: [
        { functionResponse: { id: "call-1", name: "lookup", response: { answer: "42" } } },
        { inlineData: { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" } }
      ]
    }
  ];
  const tools = [{ functionDeclarations: [{ name: "lookup", parameters: { type: "object", properties: {} } }] }];

  await withFetchStub(
    async ({ calls }) => {
      if (calls.length < 5) return badGatewayResponse(`attempt-${calls.length}`);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    },
    async (calls) => {
      const resp = await fetchGeminiWithFallbacks({
        baseUrl: "https://generativelanguage.googleapis.com",
        apiKey: "gemini-key",
        model: "gemini-test",
        systemInstruction: "sys",
        contents,
        tools,
        extraHeaders: {},
        requestDefaults: { temperature: 0.2 },
        stream: false,
        timeoutMs: 1000,
        label: "Gemini(test-tool-parts)"
      });

      assert.equal(resp.ok, true);
      assert.equal(calls.length, 5);

      assert.ok(Array.isArray(calls[0].body.tools), "first attempt keeps top-level tools");
      assert.ok(flattenParts(calls[0].body).some((p) => p.functionCall), "first attempt keeps functionCall");
      assert.ok(flattenParts(calls[0].body).some((p) => p.functionResponse), "first attempt keeps functionResponse");
      assert.ok(flattenParts(calls[0].body).some((p) => p.inlineData), "first attempt keeps image");

      assert.ok(Array.isArray(calls[2].body.tools), "no-images keeps top-level tools");
      assert.ok(flattenParts(calls[2].body).some((p) => p.functionCall), "no-images keeps functionCall");
      assert.ok(flattenParts(calls[2].body).some((p) => p.functionResponse), "no-images keeps functionResponse");
      assert.equal(flattenParts(calls[2].body).some((p) => p.inlineData), false);

      assert.equal(Object.prototype.hasOwnProperty.call(calls[3].body, "tools"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(calls[3].body, "toolConfig"), false);
      assert.equal(flattenParts(calls[3].body).some((p) => p.functionCall || p.functionResponse), false);
      assert.ok(flattenParts(calls[3].body).some((p) => p.inlineData), "no-tools keeps image before combined fallback");
      const noToolsText = JSON.stringify(calls[3].body.contents);
      assert.match(noToolsText, /\[tool_call name=lookup id=call-1\]/);
      assert.match(noToolsText, /\[tool_result name=lookup id=call-1\]/);

      assert.equal(Object.prototype.hasOwnProperty.call(calls[4].body, "tools"), false);
      assert.equal(flattenParts(calls[4].body).some((p) => p.functionCall || p.functionResponse), false);
      assert.equal(flattenParts(calls[4].body).some((p) => p.inlineData), false);
      assert.ok(flattenParts(calls[4].body).some((p) => p.text === "[image omitted]"));
      const finalText = JSON.stringify(calls[4].body.contents);
      assert.match(finalText, /\[tool_call name=lookup id=call-1\]/);
      assert.match(finalText, /\[tool_result name=lookup id=call-1\]/);
    }
  );
});

test("gemini fallback chain: function parts trigger no-tools even without top-level tools", async () => {
  const contents = [
    {
      role: "model",
      parts: [
        { text: "need lookup" },
        { functionCall: { id: "call-1", name: "lookup", args: { q: "x" } } }
      ]
    },
    {
      role: "user",
      parts: [{ functionResponse: { id: "call-1", name: "lookup", response: { answer: "42" } } }]
    }
  ];

  await withFetchStub(
    async ({ calls }) => {
      if (calls.length < 3) return badGatewayResponse(`attempt-${calls.length}`);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    },
    async (calls) => {
      const resp = await fetchGeminiWithFallbacks({
        baseUrl: "https://generativelanguage.googleapis.com",
        apiKey: "gemini-key",
        model: "gemini-test",
        systemInstruction: "sys",
        contents,
        tools: [],
        extraHeaders: {},
        requestDefaults: { temperature: 0.2 },
        stream: false,
        timeoutMs: 1000,
        label: "Gemini(test-tool-history)"
      });

      assert.equal(resp.ok, true);
      assert.equal(calls.length, 3);
      assert.ok(flattenParts(calls[0].body).some((p) => p.functionCall), "first attempt keeps functionCall");
      assert.ok(flattenParts(calls[0].body).some((p) => p.functionResponse), "first attempt keeps functionResponse");
      assert.ok(flattenParts(calls[2].body).some((p) => typeof p.text === "string" && p.text.startsWith("[tool_call name=lookup id=call-1]")));
      assert.ok(flattenParts(calls[2].body).some((p) => typeof p.text === "string" && p.text.startsWith("[tool_result name=lookup id=call-1]")));
      assert.equal(flattenParts(calls[2].body).some((p) => p.functionCall || p.functionResponse), false);
    }
  );
});

test("gemini fallback chain: snake_case inline_data is stripped by no-images attempts", async () => {
  const contents = [
    {
      role: "user",
      parts: [
        { text: "describe this" },
        { inline_data: { mime_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" } }
      ]
    }
  ];

  await withFetchStub(
    async ({ calls }) => {
      if (calls.length < 3) return badGatewayResponse(`attempt-${calls.length}`);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    },
    async (calls) => {
      const resp = await fetchGeminiWithFallbacks({
        baseUrl: "https://generativelanguage.googleapis.com",
        apiKey: "gemini-key",
        model: "gemini-test",
        systemInstruction: "sys",
        contents,
        tools: [],
        extraHeaders: {},
        requestDefaults: { max_tokens: 128 },
        stream: false,
        timeoutMs: 1000,
        label: "Gemini(test-snake-image)"
      });

      assert.equal(resp.ok, true);
      assert.equal(calls.length, 3);
      assert.ok(calls[0].body.contents[0].parts.some((p) => p.inline_data), "first attempt keeps snake_case image");
      assert.ok(calls[1].body.contents[0].parts.some((p) => p.inline_data), "no-defaults keeps snake_case image");
      assert.equal(calls[2].body.contents[0].parts.some((p) => p.inline_data), false);
      assert.equal(calls[2].body.contents[0].parts.some((p) => p.text === "[image omitted]"), true);
    }
  );
});

test("gemini fallback chain: auth-like 400 does not trigger compatibility retries", async () => {
  const contents = [
    {
      role: "user",
      parts: [
        { text: "describe this" },
        { inlineData: { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" } }
      ]
    }
  ];
  const tools = [{ functionDeclarations: [{ name: "lookup", parameters: { type: "object", properties: {} } }] }];

  await withFetchStub(
    async () => errorResponse(400, "invalid_api_key", "UNAUTHENTICATED"),
    async (calls) => {
      await assert.rejects(
        async () =>
          await fetchGeminiWithFallbacks({
            baseUrl: "https://generativelanguage.googleapis.com",
            apiKey: "bad-key",
            model: "gemini-test",
            systemInstruction: "sys",
            contents,
            tools,
            extraHeaders: {},
            requestDefaults: { max_tokens: 128, unsupported_default: true },
            stream: false,
            timeoutMs: 1000,
            label: "Gemini(test-auth-400)"
          }),
        /Gemini\(test-auth-400\) 400: UNAUTHENTICATED: invalid_api_key/
      );

      assert.equal(calls.length, 1);
      assert.ok(calls[0].body.generationConfig, "auth failure first attempt keeps defaults");
      assert.ok(Array.isArray(calls[0].body.tools), "auth failure first attempt keeps tools");
      assert.ok(calls[0].body.contents[0].parts.some((p) => p.inlineData), "auth failure first attempt keeps image");
    }
  );
});

test("gemini fallback chain: model-not-found 400 does not trigger compatibility retries", async () => {
  const contents = [
    {
      role: "user",
      parts: [
        { text: "describe this" },
        { inlineData: { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" } }
      ]
    }
  ];
  const tools = [{ functionDeclarations: [{ name: "lookup", parameters: { type: "object", properties: {} } }] }];

  await withFetchStub(
    async () => errorResponse(400, "models/gemini-missing is not found for API version v1beta", "INVALID_ARGUMENT"),
    async (calls) => {
      await assert.rejects(
        async () =>
          await fetchGeminiWithFallbacks({
            baseUrl: "https://generativelanguage.googleapis.com",
            apiKey: "gemini-key",
            model: "gemini-missing",
            systemInstruction: "sys",
            contents,
            tools,
            extraHeaders: {},
            requestDefaults: { max_tokens: 128, unsupported_default: true },
            stream: false,
            timeoutMs: 1000,
            label: "Gemini(test-model-400)"
          }),
        /Gemini\(test-model-400\) 400: INVALID_ARGUMENT: models\/gemini-missing is not found for API version v1beta/
      );

      assert.equal(calls.length, 1);
      assert.ok(calls[0].body.generationConfig, "model failure first attempt keeps defaults");
      assert.ok(Array.isArray(calls[0].body.tools), "model failure first attempt keeps tools");
      assert.ok(calls[0].body.contents[0].parts.some((p) => p.inlineData), "model failure first attempt keeps image");
    }
  );
});

test("gemini fallback chain: auth errors do not trigger compatibility retries", async () => {
  const contents = [
    {
      role: "user",
      parts: [
        { text: "describe this" },
        { inlineData: { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" } }
      ]
    }
  ];
  const tools = [{ functionDeclarations: [{ name: "lookup", parameters: { type: "object", properties: {} } }] }];

  await withFetchStub(
    async () => errorResponse(401, "bad api key"),
    async (calls) => {
      await assert.rejects(
        async () =>
          await fetchGeminiWithFallbacks({
            baseUrl: "https://generativelanguage.googleapis.com",
            apiKey: "bad-key",
            model: "gemini-test",
            systemInstruction: "sys",
            contents,
            tools,
            extraHeaders: {},
            requestDefaults: { max_tokens: 128, unsupported_default: true },
            stream: false,
            timeoutMs: 1000,
            label: "Gemini(test-auth)"
          }),
        /Gemini\(test-auth\) 401: ERROR: bad api key/
      );

      assert.equal(calls.length, 1);
      assert.ok(calls[0].body.generationConfig, "auth failure first attempt keeps defaults");
      assert.ok(Array.isArray(calls[0].body.tools), "auth failure first attempt keeps tools");
      assert.ok(calls[0].body.contents[0].parts.some((p) => p.inlineData), "auth failure first attempt keeps image");
    }
  );
});
