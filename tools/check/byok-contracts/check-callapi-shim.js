"use strict";

const { assert, ok, escapeRegExp } = require("./util");
const { findAsyncMethodParams } = require("./js-parse");

function assertInjectedShimContext(methodWindow, label) {
  const shimIdx = methodWindow.indexOf("const __byok_host=this;");
  assert(shimIdx >= 0, `${label} contract: expected injected shim at method entry`);
  assert(
    /\bconst\s+__byok_host\s*=\s*this\s*;/.test(methodWindow),
    `${label} contract: expected shim to capture upstream call host as __byok_host=this`
  );
  assert(
    /upstreamCallHost\s*:\s*__byok_host/.test(methodWindow),
    `${label} contract: expected shim to pass upstreamCallHost:__byok_host`
  );
  assert(
    !/delete\s+__byok_body\.(?:third_party_override|thirdPartyOverride)/.test(methodWindow),
    `${label} contract: shim must not mutate upstream body; BYOK-only override stripping belongs inside runtime shim`
  );
  assert(
    !/arguments\s*\[\s*1\s*\]\s*[^;]{0,80}\.apiToken/.test(methodWindow),
    `${label} contract: shim must not read upstream config apiToken before runtimeEnabled rollback gate`
  );
  assert(
    !/arguments\s*\[\s*5\s*\]\s*[^;]{0,120}\.toString\s*\(/.test(methodWindow),
    `${label} contract: shim must not stringify upstream completionURL before runtimeEnabled rollback gate`
  );
}

function assertShimBefore(methodWindow, pattern, label, what) {
  const shimIdx = methodWindow.indexOf("const __byok_host=this;");
  assert(shimIdx >= 0, `${label} contract: injected shim missing`);
  const match = methodWindow.match(pattern);
  assert(match && typeof match.index === "number", `${label} contract: expected ${what}`);
  assert(
    shimIdx < match.index,
    `${label} contract: injected shim must run before ${what} so runtimeEnabled=false has no upstream side effects`
  );
}

function assertCallApiShimSignatureContracts(extJs) {
  const ident = (name) => `(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`;
  const callApiNeedle = 'require("./byok/runtime/shim/call-api").maybeHandleCallApi';
  const callApiStreamNeedle = 'require("./byok/runtime/shim/call-api-stream").maybeHandleCallApiStream';

  const callApis = findAsyncMethodParams(extJs, "callApi", { mustInclude: callApiNeedle });
  assert(callApis.length > 0, `callApi contract: failed to locate patched async callApi(...) methods (needle=${callApiNeedle})`);

  const callApiMain = callApis.slice().sort((a, b) => b.params.length - a.params.length)[0];
  assert(callApiMain && typeof callApiMain === "object", "callApi contract: failed to pick main candidate");
  const callApiParamCount = callApiMain.params.length;
  assert(callApiParamCount >= 11, `callApi contract: expected a main callApi(...) with >=11 params; candidates=${callApis.map((m) => m.paramsText).join(" | ")}`);

  const cfgVar = callApiMain.names[1];
  const endpointVar = callApiMain.names[2];
  const completionUrlVar = callApiMain.names[5];
  const abortSignalVar = callApiMain.names[8];
  const apiTokenVar = callApiMain.names[10];
  assert(cfgVar && endpointVar && completionUrlVar && abortSignalVar && apiTokenVar, `callApi contract: unexpected param shapes; params=${callApiMain.paramsText}`);

  const callApiWindow = extJs.slice(callApiMain.start, Math.min(extJs.length, callApiMain.start + 9000));
  assertInjectedShimContext(callApiWindow, "callApi");
  assertShimBefore(
    callApiWindow,
    new RegExp(`\\bnew\\s+URL\\s*\\(\\s*${escapeRegExp(endpointVar)}\\s*,\\s*${escapeRegExp(completionUrlVar)}\\s*\\)`),
    "callApi",
    `new URL(${endpointVar},${completionUrlVar})`
  );
  assertShimBefore(
    callApiWindow,
    new RegExp(`${ident(completionUrlVar)}\\s*=\\s*await\\s+this\\.clientAuth\\.getCompletionURL\\s*\\(`),
    "callApi",
    `${completionUrlVar}=await this.clientAuth.getCompletionURL(...)`
  );
  assertShimBefore(
    callApiWindow,
    new RegExp(`${ident(apiTokenVar)}\\s*=\\s*await\\s+this\\.clientAuth\\.getAPIToken\\s*\\(`),
    "callApi",
    `${apiTokenVar}=await this.clientAuth.getAPIToken(...)`
  );
  assert(
    new RegExp(`\\bnew\\s+URL\\s*\\(\\s*${escapeRegExp(endpointVar)}\\s*,\\s*${escapeRegExp(completionUrlVar)}\\s*\\)`).test(callApiWindow),
    `callApi contract: expected new URL(${endpointVar},${completionUrlVar}) within method body`
  );
  assert(
    new RegExp(`${ident(completionUrlVar)}\\s*=\\s*await\\s+this\\.clientAuth\\.getCompletionURL\\s*\\(`).test(callApiWindow),
    `callApi contract: expected ${completionUrlVar}=await this.clientAuth.getCompletionURL(...) within method body`
  );
  assert(
    new RegExp(`${ident(apiTokenVar)}\\s*=\\s*await\\s+this\\.clientAuth\\.getAPIToken\\s*\\(`).test(callApiWindow),
    `callApi contract: expected ${apiTokenVar}=await this.clientAuth.getAPIToken(...) within method body`
  );
  assert(
    /upstreamApiToken\s*:\s*arguments\s*\[\s*10\s*\]/.test(callApiWindow),
    "callApi contract: expected injected shim to pass only arguments[10] as upstreamApiToken"
  );
  assert(
    /upstreamCompletionURL\s*:\s*arguments\s*\[\s*5\s*\]/.test(callApiWindow),
    "callApi contract: expected injected shim to pass only arguments[5] as upstreamCompletionURL"
  );
  assert(
    new RegExp(
      `\\.concat\\(\\s*${escapeRegExp(abortSignalVar)}\\s*\\?\\s*\\[\\s*${escapeRegExp(abortSignalVar)}\\s*\\]\\s*:\\s*\\[\\s*\\]\\s*\\)`
    ).test(callApiWindow),
    `callApi contract: expected abort signal concat pattern using ${abortSignalVar} within method body`
  );

  const callApiStreams = findAsyncMethodParams(extJs, "callApiStream", { mustInclude: callApiStreamNeedle });
  assert(callApiStreams.length > 0, `callApiStream contract: failed to locate patched async callApiStream(...) methods (needle=${callApiStreamNeedle})`);

  const callApiStreamMain = callApiStreams.slice().sort((a, b) => b.params.length - a.params.length)[0];
  assert(callApiStreamMain && typeof callApiStreamMain === "object", "callApiStream contract: failed to pick main candidate");
  const callApiStreamParamCount = callApiStreamMain.params.length;
  assert(
    callApiStreamParamCount >= 9,
    `callApiStream contract: expected a main callApiStream(...) with >=9 params; candidates=${callApiStreams.map((m) => m.paramsText).join(" | ")}`
  );

  const streamCfgVar = callApiStreamMain.names[1];
  const streamEndpointVar = callApiStreamMain.names[2];
  const streamCompletionUrlVar = callApiStreamMain.names[5];
  const streamAbortSignalVar = callApiStreamMain.names[8];
  assert(
    streamCfgVar && streamEndpointVar && streamCompletionUrlVar && streamAbortSignalVar,
    `callApiStream contract: unexpected param shapes; params=${callApiStreamMain.paramsText}`
  );

  const callApiStreamWindow = extJs.slice(callApiStreamMain.start, Math.min(extJs.length, callApiStreamMain.start + 9000));
  assertInjectedShimContext(callApiStreamWindow, "callApiStream");
  assertShimBefore(
    callApiStreamWindow,
    new RegExp(`\\bnew\\s+URL\\s*\\(\\s*${escapeRegExp(streamEndpointVar)}\\s*,\\s*${escapeRegExp(streamCompletionUrlVar)}\\s*\\)`),
    "callApiStream",
    `new URL(${streamEndpointVar},${streamCompletionUrlVar})`
  );
  assertShimBefore(
    callApiStreamWindow,
    new RegExp(`${ident(streamCompletionUrlVar)}\\s*=\\s*await\\s+this\\.clientAuth\\.getCompletionURL\\s*\\(`),
    "callApiStream",
    `${streamCompletionUrlVar}=await this.clientAuth.getCompletionURL(...)`
  );
  assertShimBefore(
    callApiStreamWindow,
    new RegExp(`${ident(streamCfgVar)}\\.apiToken(?![\\w$])`),
    "callApiStream",
    `${streamCfgVar}.apiToken`
  );
  assert(
    new RegExp(`\\bnew\\s+URL\\s*\\(\\s*${escapeRegExp(streamEndpointVar)}\\s*,\\s*${escapeRegExp(streamCompletionUrlVar)}\\s*\\)`).test(callApiStreamWindow),
    `callApiStream contract: expected new URL(${streamEndpointVar},${streamCompletionUrlVar}) within method body`
  );
  assert(
    new RegExp(`${ident(streamCompletionUrlVar)}\\s*=\\s*await\\s+this\\.clientAuth\\.getCompletionURL\\s*\\(`).test(callApiStreamWindow),
    `callApiStream contract: expected ${streamCompletionUrlVar}=await this.clientAuth.getCompletionURL(...) within method body`
  );
  assert(
    new RegExp(`${ident(streamCfgVar)}\\.apiToken(?![\\w$])`).test(callApiStreamWindow),
    `callApiStream contract: expected ${streamCfgVar}.apiToken usage within method body`
  );
  assert(
    /upstreamCompletionURL\s*:\s*arguments\s*\[\s*5\s*\]/.test(callApiStreamWindow),
    "callApiStream contract: expected injected shim to pass only arguments[5] as upstreamCompletionURL"
  );
  assert(
    new RegExp(
      `\\.concat\\(\\s*${escapeRegExp(streamAbortSignalVar)}\\s*\\?\\s*\\[\\s*${escapeRegExp(streamAbortSignalVar)}\\s*\\]\\s*:\\s*\\[\\s*\\]\\s*\\)`
    ).test(callApiStreamWindow),
    `callApiStream contract: expected abort signal concat pattern using ${streamAbortSignalVar} within method body`
  );

  ok("callApi/callApiStream signature contract ok");
}

module.exports = { assertCallApiShimSignatureContracts };
