const test = require("node:test");
const assert = require("node:assert/strict");

const { openAiResponsesStreamTextDeltas } = require("../payload/extension/out/byok/providers/openai-responses/text");
const { openAiResponsesChatStreamChunks } = require("../payload/extension/out/byok/providers/openai-responses/chat-stream");

async function withFetchStub(responseText, fn) {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    assert.equal(JSON.parse(String(init?.body || "{}")).stream, true);
    return new Response(responseText, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = previous;
  }
}

function responseEventWithMissingOutputIndex({ eventType, delta, fullText }) {
  const response = {
    id: `resp_${eventType.replace(".", "_")}`,
    status: eventType === "response.incomplete" ? "incomplete" : "completed",
    incomplete_details: eventType === "response.incomplete" ? { reason: "max_output_tokens" } : undefined,
    output: [
      { type: "reasoning", summary: [] },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: fullText }]
      }
    ]
  };
  return [
    `event: response.output_text.delta`,
    `data: ${JSON.stringify({ delta })}`,
    ``,
    `event: ${eventType}`,
    `data: ${JSON.stringify({ response })}`,
    ``,
    `data: [DONE]`,
    ``
  ].join("\n");
}


function responseCompletedWithMultiOutputAggregate() {
  return [
    `event: response.output_text.delta`,
    `data: ${JSON.stringify({ delta: "A", output_index: 0 })}`,
    ``,
    `event: response.output_text.delta`,
    `data: ${JSON.stringify({ delta: "B", output_index: 1 })}`,
    ``,
    `event: response.completed`,
    `data: ${JSON.stringify({ response: { id: "resp_multi_aggregate", status: "completed", output_text: "AB" } })}`,
    ``,
    `data: [DONE]`,
    ``
  ].join("\n");
}

function responseCompletedWithOutOfOrderOutputIndexAggregate() {
  return [
    `event: response.output_text.delta`,
    `data: ${JSON.stringify({ delta: "B", output_index: 1 })}`,
    ``,
    `event: response.output_text.delta`,
    `data: ${JSON.stringify({ delta: "A", output_index: 0 })}`,
    ``,
    `event: response.completed`,
    `data: ${JSON.stringify({ response: { id: "resp_out_of_order", status: "completed", output_text: "AB" } })}`,
    ``,
    `data: [DONE]`,
    ``
  ].join("\n");
}

function responseCompletedWithDirectOutputText({ delta, fullText }) {
  return [
    `event: response.output_text.delta`,
    `data: ${JSON.stringify({ delta, output_index: 1 })}`,
    ``,
    `event: response.completed`,
    `data: ${JSON.stringify({ response: { id: "resp_direct_text", status: "completed", output_text: fullText } })}`,
    ``,
    `data: [DONE]`,
    ``
  ].join("\n");
}

async function collectTextDeltas(responseText) {
  const out = [];
  await withFetchStub(responseText, async (calls) => {
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
      out.push(d);
    }
    assert.equal(calls.length, 1);
  });
  return out;
}

async function collectChatText(responseText) {
  const chunks = [];
  await withFetchStub(responseText, async (calls) => {
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
    assert.equal(calls.length, 1);
  });
  return chunks.map((c) => (typeof c?.text === "string" ? c.text : "")).join("");
}

for (const eventType of ["response.completed", "response.incomplete"]) {
  test(`openai-responses stream: ${eventType} dedupes missing output_index deltas`, async () => {
    const sse = responseEventWithMissingOutputIndex({ eventType, delta: "hello", fullText: "hello world" });
    assert.deepEqual(await collectTextDeltas(sse), ["hello", " world"]);
  });

  test(`openai-responses chat stream: ${eventType} dedupes missing output_index deltas`, async () => {
    const sse = responseEventWithMissingOutputIndex({ eventType, delta: "chat", fullText: "chat text" });
    assert.equal(await collectChatText(sse), "chat text");
  });
}

test("openai-responses stream: direct completed output_text dedupes explicit indexed delta", async () => {
  const sse = responseCompletedWithDirectOutputText({ delta: "hello", fullText: "hello world" });
  assert.deepEqual(await collectTextDeltas(sse), ["hello", " world"]);
});

test("openai-responses chat stream: direct completed output_text dedupes explicit indexed delta", async () => {
  const sse = responseCompletedWithDirectOutputText({ delta: "chat", fullText: "chat text" });
  assert.equal(await collectChatText(sse), "chat text");
});


test("openai-responses stream: direct aggregate output_text dedupes multiple explicit output indexes", async () => {
  assert.deepEqual(await collectTextDeltas(responseCompletedWithMultiOutputAggregate()), ["A", "B"]);
});

test("openai-responses chat stream: direct aggregate output_text dedupes multiple explicit output indexes", async () => {
  assert.equal(await collectChatText(responseCompletedWithMultiOutputAggregate()), "AB");
});

test("openai-responses stream: direct aggregate output_text dedupes out-of-order explicit output indexes", async () => {
  assert.deepEqual(await collectTextDeltas(responseCompletedWithOutOfOrderOutputIndexAggregate()), ["B", "A"]);
});

test("openai-responses chat stream: direct aggregate output_text dedupes out-of-order explicit output indexes", async () => {
  assert.equal(await collectChatText(responseCompletedWithOutOfOrderOutputIndexAggregate()), "BA");
});
