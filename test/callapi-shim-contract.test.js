const test = require("node:test");
const assert = require("node:assert/strict");

const { assertCallApiShimSignatureContracts } = require("../tools/check/byok-contracts/check-callapi-shim");

function makeShimSource({ lateCallApi = false, lateCallApiStream = false } = {}) {
  const apiShim = [
    "const __byok_host=this;",
    "const __byok_ep=typeof arguments[2]===\"string\"?arguments[2]:\"\";",
    "const __byok_res=await require(\"./byok/runtime/shim/call-api\").maybeHandleCallApi({endpoint:__byok_ep,body:arguments[3],transform:arguments[4],timeoutMs:arguments[6],abortSignal:arguments[8],upstreamApiToken:arguments[10],upstreamCompletionURL:arguments[5],upstreamCallHost:__byok_host});",
    "if(__byok_res!==void 0)return __byok_res;"
  ].join("");
  const streamShim = [
    "const __byok_host=this;",
    "const __byok_ep=typeof arguments[2]===\"string\"?arguments[2]:\"\";",
    "const __byok_res=await require(\"./byok/runtime/shim/call-api-stream\").maybeHandleCallApiStream({endpoint:__byok_ep,body:arguments[3],transform:arguments[4],timeoutMs:arguments[6],abortSignal:arguments[8],upstreamApiToken:arguments[10],upstreamCompletionURL:arguments[5],upstreamCallHost:__byok_host});",
    "if(__byok_res!==void 0)return __byok_res;"
  ].join("");
  const apiSideEffects = [
    "completionURL=await this.clientAuth.getCompletionURL();",
    "apiToken=await this.clientAuth.getAPIToken();",
    "const url=new URL(endpoint,completionURL);",
    "return [url,apiToken].concat(abortSignal?[abortSignal]:[]);"
  ].join("");
  const streamSideEffects = [
    "completionURL=await this.clientAuth.getCompletionURL();",
    "const token=cfg.apiToken;",
    "const url=new URL(endpoint,completionURL);",
    "return [url,token].concat(abortSignal?[abortSignal]:[]);"
  ].join("");

  return [
    "class Client{",
    `async callApi(ctx,cfg,endpoint,body,transform,completionURL,timeoutMs,p7,abortSignal,p9,apiToken){${lateCallApi ? apiSideEffects + apiShim : apiShim + apiSideEffects}}`,
    `async callApiStream(ctx,cfg,endpoint,body,transform,completionURL,timeoutMs,p7,abortSignal){${lateCallApiStream ? streamSideEffects + streamShim : streamShim + streamSideEffects}}`,
    "}"
  ].join("\n");
}

function withContractExitAsThrow(fn) {
  const prevExit = process.exit;
  const prevError = console.error;
  const errors = [];
  process.exit = (code) => {
    const err = new Error(`contract exited: ${Number(code) || 0}`);
    err.exitCode = Number(code) || 0;
    throw err;
  };
  console.error = (...args) => errors.push(args.map((x) => String(x)).join(" "));
  try {
    const result = fn();
    return { result, errors };
  } finally {
    process.exit = prevExit;
    console.error = prevError;
  }
}

function assertContractPasses(source) {
  withContractExitAsThrow(() => assertCallApiShimSignatureContracts(source));
}

function assertContractFails(source, pattern) {
  const { errors } = withContractExitAsThrow(() => {
    assert.throws(() => assertCallApiShimSignatureContracts(source), /contract exited: 1/);
  });
  assert.match(errors.join("\n"), pattern);
}

test("callApi shim contract: accepts injected shim before upstream side effects", () => {
  assertContractPasses(makeShimSource());
});

test("callApi shim contract: fails when callApi injection runs after upstream URL/token side effects", () => {
  assertContractFails(
    makeShimSource({ lateCallApi: true }),
    /callApi contract: injected shim must run before new URL/
  );
});

test("callApi shim contract: fails when callApiStream injection runs after upstream URL/token side effects", () => {
  assertContractFails(
    makeShimSource({ lateCallApiStream: true }),
    /callApiStream contract: injected shim must run before new URL/
  );
});
