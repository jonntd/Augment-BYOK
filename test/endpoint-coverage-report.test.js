const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function withTempDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(value), "utf8");
}

function makeAnalysis(endpointDetails) {
  return {
    generatedAt: new Date(0).toISOString(),
    upstream: { publisher: "augment", extension: "vscode-augment", version: "test" },
    endpoints: Object.keys(endpointDetails).sort(),
    endpointDetails
  };
}

function makeUiCatalog(endpoints) {
  return `
    (function(){
      const ns = (window.__byokCfgPanel = window.__byokCfgPanel || {});
      ns.ENDPOINT_GROUPS_V1 = [{ id: "all", label: "all", endpoints: ${JSON.stringify(endpoints)} }];
      ns.ENDPOINT_MEANINGS_V1 = {};
    })();
  `;
}

function runCoverage(args) {
  return spawnSync(process.execPath, [path.join(__dirname, "../tools/report/endpoint-coverage.js"), ...args], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8"
  });
}

test("endpoint-coverage: fail-fast when UI endpoint catalog misses an upstream endpoint", () => {
  withTempDir("augment-byok-endpoint-coverage-", (dir) => {
    const analysisPath = path.join(dir, "analysis.json");
    const uiPath = path.join(dir, "ui.js");
    const outPath = path.join(dir, "report.md");
    writeJson(
      analysisPath,
      makeAnalysis({
        "/get-models": { callApi: 1, callApiStream: 0 },
        "/chat": { callApi: 1, callApiStream: 0 },
        "/completion": { callApi: 1, callApiStream: 0 },
        "/chat-input-completion": { callApi: 1, callApiStream: 0 },
        "/chat-stream": { callApi: 0, callApiStream: 1 },
        "/prompt-enhancer": { callApi: 0, callApiStream: 1 },
        "/next-edit-stream": { callApi: 0, callApiStream: 1 },
        "/generate-commit-message-stream": { callApi: 0, callApiStream: 1 },
        "/new-upstream-endpoint": { callApi: 1, callApiStream: 0 }
      })
    );
    writeText(
      uiPath,
      makeUiCatalog([
        "/get-models",
        "/chat",
        "/completion",
        "/chat-input-completion",
        "/chat-stream",
        "/prompt-enhancer",
        "/next-edit-stream",
        "/generate-commit-message-stream"
      ])
    );

    const res = runCoverage(["--analysis", analysisPath, "--out", outPath, "--ui-catalog", uiPath, "--fail-fast"]);

    assert.equal(res.status, 2);
    const report = fs.readFileSync(outPath, "utf8");
    assert.match(report, /UI endpoint catalog missing upstream endpoint\(s\): \/new-upstream-endpoint/);
  });
});

test("endpoint-coverage: fail-fast when UI endpoint catalog keeps a stale endpoint", () => {
  withTempDir("augment-byok-endpoint-coverage-", (dir) => {
    const analysisPath = path.join(dir, "analysis.json");
    const uiPath = path.join(dir, "ui.js");
    const outPath = path.join(dir, "report.md");
    const endpointDetails = {
      "/get-models": { callApi: 1, callApiStream: 0 },
      "/chat": { callApi: 1, callApiStream: 0 },
      "/completion": { callApi: 1, callApiStream: 0 },
      "/chat-input-completion": { callApi: 1, callApiStream: 0 },
      "/chat-stream": { callApi: 0, callApiStream: 1 },
      "/prompt-enhancer": { callApi: 0, callApiStream: 1 },
      "/next-edit-stream": { callApi: 0, callApiStream: 1 },
      "/generate-commit-message-stream": { callApi: 0, callApiStream: 1 }
    };
    writeJson(analysisPath, makeAnalysis(endpointDetails));
    writeText(uiPath, makeUiCatalog([...Object.keys(endpointDetails), "/removed-upstream-endpoint"]));

    const res = runCoverage(["--analysis", analysisPath, "--out", outPath, "--ui-catalog", uiPath, "--fail-fast"]);

    assert.equal(res.status, 2);
    const report = fs.readFileSync(outPath, "utf8");
    assert.match(report, /UI endpoint catalog has stale endpoint\(s\): \/removed-upstream-endpoint/);
  });
});
