const test = require("node:test");
const assert = require("node:assert/strict");

const { selfTestProvider } = require("../payload/extension/out/byok/core/self-test/provider-test");

async function runConfigOnlyProvider(provider) {
  const logs = [];
  const report = await selfTestProvider({
    provider,
    timeoutMs: 1000,
    abortSignal: null,
    log: (line) => logs.push(String(line || "")),
    capturedToolDefinitions: []
  });
  return { report, logs };
}

test("self-test provider config gate treats placeholder apiKey values as missing auth", async () => {
  for (const apiKey of ["<redacted>", "(set)", "Bearer", "Basic", "Bearer <redacted>"]) {
    const { report } = await runConfigOnlyProvider({
      id: `p-${apiKey}`,
      type: "openai_compatible",
      baseUrl: "https://example.test/v1",
      apiKey,
      headers: {},
      models: ["m"],
      defaultModel: "m"
    });

    assert.equal(report.ok, false, apiKey);
    assert.equal(report.tests[0]?.name, "config", apiKey);
    assert.match(report.tests[0]?.detail || "", /auth=empty/, apiKey);
  }
});
