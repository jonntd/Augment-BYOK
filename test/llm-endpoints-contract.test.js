const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { LLM_ENDPOINT_SPECS } = require("../tools/report/llm-endpoints-spec");
const { SUPPORTED_CALL_API_ENDPOINTS } = require("../payload/extension/out/byok/runtime/shim/call-api");
const { SUPPORTED_CALL_API_STREAM_ENDPOINTS } = require("../payload/extension/out/byok/runtime/shim/call-api-stream");
const { defaultConfig } = require("../payload/extension/out/byok/config/config");
const { hasStaleEndpointLiteral } = require("../tools/check/byok-contracts/main");

function sorted(xs) {
  return Array.from(new Set(Array.isArray(xs) ? xs : [])).sort();
}

function byokRouteEndpoints(rules) {
  return sorted(
    Object.entries(rules && typeof rules === "object" ? rules : {})
      .filter(([, rule]) => rule && typeof rule === "object" && rule.mode === "byok")
      .map(([endpoint]) => endpoint)
  );
}

test("LLM endpoints: spec matches runtime shims", () => {
  const specCallApi = sorted(LLM_ENDPOINT_SPECS.filter((s) => s && s.kind === "callApi").map((s) => s.endpoint));
  const specCallApiStream = sorted(LLM_ENDPOINT_SPECS.filter((s) => s && s.kind === "callApiStream").map((s) => s.endpoint));

  assert.deepEqual(specCallApi, SUPPORTED_CALL_API_ENDPOINTS);
  assert.deepEqual(specCallApiStream, SUPPORTED_CALL_API_STREAM_ENDPOINTS);
});

test("LLM endpoints: defaultConfig routes all to byok", () => {
  const cfg = defaultConfig();
  const specEndpoints = sorted(LLM_ENDPOINT_SPECS.map((s) => s.endpoint));
  for (const spec of LLM_ENDPOINT_SPECS) {
    const ep = spec && typeof spec === "object" ? String(spec.endpoint || "") : "";
    assert.ok(ep && ep.startsWith("/"), `bad spec endpoint: ${ep || "(empty)"}`);
    const r = cfg.routing.rules[ep];
    assert.ok(r && typeof r === "object", `missing default routing rule: ${ep}`);
    assert.equal(r.mode, "byok", `default routing rule must be byok: ${ep}`);
  }
  assert.deepEqual(byokRouteEndpoints(cfg.routing.rules), specEndpoints, "defaultConfig must not keep stale BYOK endpoint routes");
});

test("LLM endpoints: config.example BYOK routes stay aligned with spec", () => {
  const repoRoot = path.resolve(__dirname, "..");
  const example = JSON.parse(fs.readFileSync(path.join(repoRoot, "config.example.json"), "utf8"));
  const specEndpoints = sorted(LLM_ENDPOINT_SPECS.map((s) => s.endpoint));

  assert.deepEqual(byokRouteEndpoints(example?.routing?.rules), specEndpoints);
});

test("contracts: stale BYOK endpoint guard catches static template literals", () => {
  assert.equal(hasStaleEndpointLiteral('const ep = "/edit";', "/edit"), true);
  assert.equal(hasStaleEndpointLiteral("const ep = '/edit';", "/edit"), true);
  assert.equal(hasStaleEndpointLiteral("const ep = `/edit`;", "/edit"), true);
  assert.equal(hasStaleEndpointLiteral("const ep = `/safe`;", "/edit"), false);
});
