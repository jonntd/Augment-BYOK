"use strict";

const fs = require("fs");
const path = require("path");

const { ok, assert, readText, readJson, parseArgs } = require("./util");
const { assertFileExists, assertContains, assertHasCommand, assertModelRegistryFlags } = require("./assertions");
const { assertCallApiShimSignatureContracts } = require("./check-callapi-shim");
const { assertProtocolEnumsAligned } = require("./check-protocol-enums");
const { assertAugmentProtocolShapes } = require("./check-augment-protocol-shapes");
const { listExtensionClientContextAssets } = require("../../patch/webview-assets");
const { LLM_ENDPOINT_SPECS } = require("../../report/llm-endpoints-spec");
const { endpointDetailsFromSource, sortedEndpointList } = require("../../lib/endpoint-analysis");
const { extractUiEndpointCatalogFromSource } = require("../../lib/ui-endpoint-catalog");

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

function listJsFilesRecursive(rootDir) {
  const root = path.resolve(String(rootDir || ""));
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of fs.readdirSync(dir).sort().reverse()) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) stack.push(p);
      else if (st.isFile() && name.endsWith(".js")) out.push(p);
    }
  }
  return out.sort();
}

function hasStaleEndpointLiteral(src, endpoint) {
  const s = String(src || "");
  const ep = String(endpoint || "");
  if (!ep) return false;
  return [JSON.stringify(ep), `'${ep}'`, `\`${ep}\``].some((needle) => s.includes(needle));
}

function assertNoStaleByokEndpointStrings(byokDir) {
  const staleEndpoints = ["/edit", "/generate-conversation-title", "/next_edit_loc", "/instruction-stream", "/smart-paste-stream"];
  const hits = [];
  for (const filePath of listJsFilesRecursive(byokDir)) {
    const src = readText(filePath);
    for (const ep of staleEndpoints) {
      if (hasStaleEndpointLiteral(src, ep)) hits.push(`${path.relative(byokDir, filePath)}:${ep}`);
    }
  }
  assert(hits.length === 0, `stale removed BYOK endpoint string(s) found:\n${hits.join("\n")}`);
  ok(`stale BYOK endpoint strings absent (${staleEndpoints.length})`);
}

function assertEndpointCoverageContracts({ extJs, config, callApiShim, callApiStreamShim }) {
  const endpointDetails = endpointDetailsFromSource(extJs);
  const upstreamEndpoints = sortedEndpointList(endpointDetails);
  const specCallApi = sorted(LLM_ENDPOINT_SPECS.filter((s) => s && s.kind === "callApi").map((s) => s.endpoint));
  const specCallApiStream = sorted(LLM_ENDPOINT_SPECS.filter((s) => s && s.kind === "callApiStream").map((s) => s.endpoint));
  const specEndpoints = sorted(LLM_ENDPOINT_SPECS.map((s) => s.endpoint));

  assert(
    JSON.stringify(sorted(callApiShim.SUPPORTED_CALL_API_ENDPOINTS)) === JSON.stringify(specCallApi),
    "callApi shim supported endpoints drift from LLM_ENDPOINT_SPECS"
  );
  assert(
    JSON.stringify(sorted(callApiStreamShim.SUPPORTED_CALL_API_STREAM_ENDPOINTS)) === JSON.stringify(specCallApiStream),
    "callApiStream shim supported endpoints drift from LLM_ENDPOINT_SPECS"
  );

  for (const spec of LLM_ENDPOINT_SPECS) {
    const d = endpointDetails[spec.endpoint];
    assert(d, `LLM endpoint missing from upstream extension.js: ${spec.endpoint}`);
    const callApi = Number(d.callApi || 0);
    const callApiStream = Number(d.callApiStream || 0);
    if (spec.kind === "callApi") {
      assert(callApi > 0 && callApiStream === 0, `LLM endpoint kind mismatch: ${spec.endpoint} expected=callApi got(${callApi}/${callApiStream})`);
    } else {
      assert(callApi === 0 && callApiStream > 0, `LLM endpoint kind mismatch: ${spec.endpoint} expected=callApiStream got(${callApi}/${callApiStream})`);
    }
  }

  const cfg = config.defaultConfig();
  assert(
    JSON.stringify(byokRouteEndpoints(cfg.routing?.rules)) === JSON.stringify(specEndpoints),
    "defaultConfig BYOK endpoint routes drift from LLM_ENDPOINT_SPECS"
  );
  ok(`LLM endpoint coverage ok (${upstreamEndpoints.length}/${specEndpoints.length})`);
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  const extensionDir = path.resolve(String(args.extensionDir || ""));
  const extJsPath = path.resolve(String(args.extJs || ""));
  const pkgPath = path.resolve(String(args.pkg || ""));

  assert(extensionDir && extensionDir !== path.parse(extensionDir).root, "missing --extensionDir");
  assert(extJsPath && extJsPath !== path.parse(extJsPath).root, "missing --extJs");
  assert(pkgPath && pkgPath !== path.parse(pkgPath).root, "missing --pkg");

  ok(`extensionDir=${extensionDir}`);

  assert(fs.existsSync(extensionDir), `extensionDir not found: ${extensionDir}`);
  assert(fs.existsSync(extJsPath), `extJs not found: ${extJsPath}`);
  assert(fs.existsSync(pkgPath), `package.json not found: ${pkgPath}`);

  const requiredRelFiles = [
    "out/byok/runtime/bootstrap/index.js",
    "out/byok/runtime/official/get-models.js",
    "out/byok/runtime/official/common.js",
    "out/byok/runtime/official/codebase-retrieval.js",
    "out/byok/runtime/official/context-canvas.js",
    "out/byok/runtime/official/external-sources.js",
    "out/byok/runtime/shim/call-api/index.js",
    "out/byok/runtime/shim/call-api-stream/index.js",
    "out/byok/runtime/shim/byok-chat/index.js",
    "out/byok/runtime/shim/byok-chat-stream/index.js",
    "out/byok/runtime/shim/byok-text/index.js",
    "out/byok/runtime/shim/route/index.js",
    "out/byok/runtime/shim/next-edit/index.js",
    "out/byok/runtime/shim/common/index.js",
    "out/byok/runtime/shim/augment-chat/index.js",
    "out/byok/runtime/shim/text-assembly/index.js",
    "out/byok/runtime/upstream/discovery.js",
    "out/byok/runtime/upstream/assets.js",
    "out/byok/runtime/upstream/checkpoints.js",
    "out/byok/runtime/upstream/official-chat-delegation.js",
    "out/byok/runtime/upstream/official-text-delegation.js",
    "out/byok/runtime/upstream/text-assembly/prompt-utils.js",
    "out/byok/runtime/workspace/file-chunks.js",
    "out/byok/config/config.js",
    "out/byok/config/default-config.js",
    "out/byok/config/normalize-config.js",
    "out/byok/config/state.js",
    "out/byok/config/official.js",
    "out/byok/core/router.js",
    "out/byok/core/protocol.js",
    "out/byok/core/model-registry.js",
    "out/byok/core/model-picker.js",
    "out/byok/core/official-delegation.js",
    "out/byok/core/augment-protocol.js",
    "out/byok/core/provider-types.js",
    "out/byok/core/provider-text.js",
    "out/byok/core/provider-augment-chat.js",
    "out/byok/core/augment-node-format.js",
    "out/byok/core/tool-pairing/index.js",
    "out/byok/core/augment-history-summary/index.js",
    "out/byok/core/augment-history-summary/abridged.js",
    "out/byok/core/augment-history-summary/cache.js",
    "out/byok/core/augment-history-summary/provider-dispatch.js",
    "out/byok/core/augment-history-summary/auto/index.js",
    "out/byok/core/augment-history-summary/auto/estimate.js",
    "out/byok/core/augment-history-summary/auto/config.js",
    "out/byok/core/augment-history-summary/auto/tail-selection.js",
    "out/byok/core/augment-chat/shared/index.js",
    "out/byok/core/augment-chat/shared/nodes.js",
    "out/byok/core/augment-chat/shared/tools.js",
    "out/byok/core/augment-chat/shared/request.js",
    "out/byok/core/augment-chat/openai.js",
    "out/byok/core/augment-chat/openai-responses.js",
    "out/byok/core/augment-chat/anthropic.js",
    "out/byok/core/augment-chat/gemini.js",
    "out/byok/core/tool-pairing/common.js",
    "out/byok/core/tool-pairing/openai.js",
    "out/byok/core/tool-pairing/openai-responses.js",
    "out/byok/core/tool-pairing/anthropic.js",
    "out/byok/core/next-edit/fields.js",
    "out/byok/core/next-edit/stream-utils.js",
    "out/byok/infra/constants.js",
    "out/byok/infra/util.js",
    "out/byok/infra/log.js",
    "out/byok/infra/log-redact.js",
    "out/byok/providers/openai/index.js",
    "out/byok/providers/chat-chunks-util.js",
    "out/byok/providers/openai/chat-completions-util.js",
    "out/byok/providers/openai/chat-completions-json-util.js",
    "out/byok/providers/openai-responses/index.js",
    "out/byok/providers/openai-responses/request.js",
    "out/byok/providers/openai-responses/json-util.js",
    "out/byok/providers/anthropic/index.js",
    "out/byok/providers/anthropic/request.js",
    "out/byok/providers/anthropic/json-util.js",
    "out/byok/providers/gemini/index.js",
    "out/byok/providers/gemini/json-util.js",
    "out/byok/ui/config-io.js",
    "out/byok/ui/config-panel/index.js",
    "out/byok/ui/config-panel/html.js",
    "out/byok/ui/config-panel/style.css",
    "out/byok/ui/config-panel/webview/util.js",
    "out/byok/ui/config-panel/webview/render/index.js",
    "out/byok/ui/config-panel/webview/render/providers.js",
    "out/byok/ui/config-panel/webview/render/endpoints.js",
    "out/byok/ui/config-panel/webview/render/app.js",
    "out/byok/ui/config-panel/webview/dom.js",
    "out/byok/ui/config-panel/webview/core.js",
    "out/byok/ui/config-panel/webview/handlers.js",
    "out/byok/ui/config-panel/webview/main.js"
  ];
  for (const rel of requiredRelFiles) assertFileExists(extensionDir, rel);
  ok(`required files ok (${requiredRelFiles.length})`);

  const pkg = readJson(pkgPath);
  assertHasCommand(pkg, "augment-byok.enable");
  assertHasCommand(pkg, "augment-byok.disable");
  assertHasCommand(pkg, "augment-byok.reloadConfig");
  assertHasCommand(pkg, "augment-byok.openConfigPanel");
  assertHasCommand(pkg, "augment-byok.clearHistorySummaryCache");
  assertHasCommand(pkg, "augment-byok.importConfig");
  assertHasCommand(pkg, "augment-byok.exportConfig");
  ok("package.json commands ok");

  const extJs = readText(extJsPath);
  assertContains(extJs, "__augment_byok_bootstrap_injected_v1", "bootstrap injected");
  assertContains(extJs, "__augment_byok_expose_upstream_v1", "expose upstream (toolsModel) injected");
  assertContains(extJs, "__augment_byok_upstream.officialChatDelegation", "expose upstream (official chat delegation) injected");
  assertContains(extJs, "__augment_byok_official_overrides_patched_v1", "official overrides patched");
  assertContains(extJs, "__augment_byok_callapi_shim_patched_v1", "callApi shim patched");
  assertContains(extJs, "__augment_byok_model_picker_byok_only_v1", "model picker (BYOK-only) patched");
  if (extJs.includes("upper_bound_size") || extJs.includes("memoriesParams")) {
    assertContains(extJs, "__augment_byok_memories_upper_bound_size_patched_v1", "memories upper_bound_size patched");
  }
  assertContains(extJs, "__augment_byok_tasklist_auto_root_patched_v1", "tasklist auto root patched");
  assertContains(extJs, "__augment_byok_tasklist_add_tasks_sanitize_empty_ids_patched_v1", "tasklist add_tasks sanitize empty ids patched");
  assertContains(extJs, "__augment_byok_tasklist_add_tasks_errors_patched_v1", "tasklist add_tasks errors patched");
  assertContains(extJs, "__augment_byok_tasklist_reorganize_noop_errors_patched_v1", "tasklist reorganize no-op errors patched");
  assert(!extJs.includes("case \"/autoAuth\"") && !extJs.includes("handleAutoAuth"), "autoAuth guard failed (post-check)");
  ok("extension.js markers ok");

  const webviewAssets = listExtensionClientContextAssets(extensionDir, "contracts");
  assert(webviewAssets.length > 0, "webview history summary asset missing");
  for (const assetPath of webviewAssets) {
    const webviewHistorySummary = readText(assetPath);
    assertContains(webviewHistorySummary, "__augment_byok_webview_history_summary_node_slim_v1", "webview history summary node patched");
    assert(
      /return\{id:[^}]+type:[^}]*TEXT[^}]+text_node:\{content:/s.test(webviewHistorySummary),
      `webview history summary node not rewritten to TEXT/text_node: ${assetPath}`
    );
    assert(
      !/type:[^,}]*HISTORY_SUMMARY,history_summary_node:/.test(webviewHistorySummary),
      `webview history summary node still carries upstream HISTORY_SUMMARY payload: ${assetPath}`
    );
  }
  ok(`webview history summary patch markers ok (${webviewAssets.length})`);

  assertCallApiShimSignatureContracts(extJs);

  const byokDir = path.join(extensionDir, "out", "byok");
  const coreDir = path.join(byokDir, "core");
  const configDir = path.join(byokDir, "config");
  const infraDir = path.join(byokDir, "infra");
  const uiRenderPath = path.join(byokDir, "ui", "config-panel", "webview", "render", "index.js");
  const modelRegistry = require(path.join(coreDir, "model-registry.js"));
  const protocol = require(path.join(coreDir, "protocol.js"));
  const augmentProtocol = require(path.join(coreDir, "augment-protocol.js"));
  const augmentChatShared = require(path.join(coreDir, "augment-chat", "shared", "index.js"));
  const augmentNodeFormat = require(path.join(coreDir, "augment-node-format.js"));
  const config = require(path.join(configDir, "config.js"));
  const router = require(path.join(coreDir, "router.js"));
  const util = require(path.join(infraDir, "util.js"));
  const callApiShim = require(path.join(byokDir, "runtime", "shim", "call-api", "index.js"));
  const callApiStreamShim = require(path.join(byokDir, "runtime", "shim", "call-api-stream", "index.js"));

  assertProtocolEnumsAligned(extensionDir, augmentProtocol, augmentChatShared, augmentNodeFormat);
  assertAugmentProtocolShapes(augmentProtocol);
  assertEndpointCoverageContracts({ extJs, config, callApiShim, callApiStreamShim });
  assertNoStaleByokEndpointStrings(byokDir);
  const uiEndpoints = extractUiEndpointCatalogFromSource(readText(uiRenderPath)).endpoints;
  assert(
    JSON.stringify(uiEndpoints) === JSON.stringify(sorted(Object.keys(endpointDetailsFromSource(extJs)))),
    "webview endpoint catalog drift from upstream endpoint set"
  );
  ok(`webview endpoint catalog ok (${uiEndpoints.length})`);

  const sampleByokId = "byok:openai:gpt-4o-mini";
  const flags = modelRegistry.ensureModelRegistryFeatureFlags({}, { byokModelIds: [sampleByokId], defaultModel: sampleByokId });
  assertModelRegistryFlags(flags);
  const regJson = JSON.parse(flags.modelRegistry || flags.model_registry || "{}");
  assert(regJson["openai: gpt-4o-mini"] === sampleByokId, "modelRegistry missing mapping: openai: gpt-4o-mini");
  ok("model registry flags ok");

  const getModels = protocol.makeBackGetModelsResult({ defaultModel: sampleByokId, models: [protocol.makeModelInfo(sampleByokId)] });
  assert(getModels && typeof getModels === "object", "makeBackGetModelsResult not object");
  assertModelRegistryFlags(getModels.feature_flags);
  ok("makeBackGetModelsResult contract ok");

  const cfg = config.defaultConfig();
  const cfgProvider = Array.isArray(cfg.providers) ? cfg.providers.find((p) => p && p.id === "openai") : null;
  if (cfgProvider) cfgProvider.apiKey = "sk-test-openai";
  const r = router.decideRoute({ cfg, endpoint: "/chat-stream", body: { model: sampleByokId }, runtimeEnabled: true });
  assert(r && r.mode === "byok", "router.decideRoute expected mode=byok");
  assert(r.provider && r.provider.id === "openai", "router.decideRoute expected provider=openai");
  assert(r.model === "gpt-4o-mini", "router.decideRoute expected model=gpt-4o-mini");
  ok("router decideRoute contract ok");

  assert(util.parseByokModelId(sampleByokId)?.providerId === "openai", "util.parseByokModelId parse failed");
  let threw = false;
  try {
    util.parseByokModelId("byok:badformat", { strict: true });
  } catch {
    threw = true;
  }
  assert(threw, "util.parseByokModelId(strict) should throw on invalid byok format");
  ok("util parseByokModelId contract ok");

  ok("ALL CONTRACTS OK");
}

module.exports = { main, hasStaleEndpointLiteral };

if (require.main === module) main();
