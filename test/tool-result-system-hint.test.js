const test = require("node:test");
const assert = require("node:assert/strict");

const {
  REQUEST_NODE_TOOL_RESULT,
  TOOL_RESULT_CONTENT_TEXT,
  TOOL_RESULT_CONTENT_IMAGE
} = require("../payload/extension/out/byok/core/augment-protocol");

const {
  summarizeToolResultText,
  splitToolResultSystemHint,
  extractToolResultTextsFromRequestNodes
} = require("../payload/extension/out/byok/core/augment-chat/shared");

const { buildAnthropicMessages } = require("../payload/extension/out/byok/core/augment-chat/anthropic");

test("tool-result: splitToolResultSystemHint detects and splits system hints", () => {
  const input = "ok\n\n✔️请记住 something";
  const out = splitToolResultSystemHint(input);
  assert.equal(out.userText, "ok");
  assert.equal(out.systemHint.startsWith("✔️请记住"), true);
});

test("tool-result: summarizeToolResultText strips appended system hints", () => {
  const contentNodes = [
    { type: TOOL_RESULT_CONTENT_TEXT, text_content: "ok\n\n❌请记住 something" }
  ];
  assert.equal(summarizeToolResultText("", contentNodes), "ok");
  assert.equal(summarizeToolResultText("ok\n\n✔️请记住 something", []), "ok");
});

test("tool-result: does not strip marker phrases when they appear in normal content", () => {
  const input = "section A\n✔️请记住 这是文档正文\nsection B";
  const out = splitToolResultSystemHint(input);
  assert.equal(out.userText, input);
  assert.equal(out.systemHint, "");

  const contentNodes = [{ type: TOOL_RESULT_CONTENT_TEXT, text_content: input }];
  assert.equal(summarizeToolResultText("", contentNodes), input);
});

test("tool-result: extractToolResultTexts preserves later nodes after stripping hint text node", () => {
  const out = extractToolResultTextsFromRequestNodes([
    {
      type: REQUEST_NODE_TOOL_RESULT,
      tool_result_node: {
        tool_use_id: "t1",
        content_nodes: [
          { type: TOOL_RESULT_CONTENT_TEXT, text_content: "ok\n\n✔️请记住 suffix" },
          { type: TOOL_RESULT_CONTENT_IMAGE, image_content: { format: "png", image_data: "ZmFrZQ==" } },
          { type: TOOL_RESULT_CONTENT_TEXT, text_content: "later text" }
        ]
      }
    }
  ]);

  assert.equal(out.length, 1);
  assert.equal(out[0].toolUseId, "t1");
  assert.ok(out[0].text.includes("ok"));
  assert.ok(out[0].text.includes("[image omitted:"));
  assert.ok(out[0].text.includes("later text"));
  assert.equal(out[0].text.includes("请记住"), false);
});

test("anthropic: tool_result content strips appended system hints", () => {
  const messages = buildAnthropicMessages({
    message: "",
    chat_history: [],
    nodes: [
      {
        type: REQUEST_NODE_TOOL_RESULT,
        tool_result_node: {
          tool_use_id: "t1",
          content: "ok\n\n✔️请记住 something",
          is_error: false
        }
      }
    ]
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.equal(Array.isArray(messages[0].content), true);
  assert.equal(messages[0].content.length, 1);
  assert.equal(messages[0].content[0].type, "tool_result");
  assert.equal(messages[0].content[0].tool_use_id, "t1");
  assert.equal(messages[0].content[0].content, "ok");
});

test("anthropic: tool_result content keeps later images after stripping appended system hints", () => {
  const messages = buildAnthropicMessages({
    message: "",
    chat_history: [],
    nodes: [
      {
        type: REQUEST_NODE_TOOL_RESULT,
        tool_result_node: {
          tool_use_id: "t1",
          is_error: false,
          content_nodes: [
            { type: TOOL_RESULT_CONTENT_TEXT, text_content: "ok\n\n✔️请记住 something" },
            { type: TOOL_RESULT_CONTENT_IMAGE, image_content: { format: "png", image_data: "ZmFrZQ==" } }
          ]
        }
      }
    ]
  });

  const content = messages[0].content[0].content;
  assert.equal(Array.isArray(content), true);
  assert.equal(content.length, 2);
  assert.deepEqual(content[0], { type: "text", text: "ok" });
  assert.equal(content[1].type, "image");
  assert.equal(content[1].source.media_type, "image/png");
  assert.equal(content[1].source.data, "ZmFrZQ==");
});
