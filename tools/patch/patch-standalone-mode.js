"use strict";

const { replaceOnce } = require("../lib/patch");

/**
 * Applies Hardcore Patches to enable running the extension offline
 * without an official backend or a valid Augment account.
 */
function patchStandaloneMode(extCode) {
  let patchedCode = extCode;

  // 1. Bypass gRPC initialization timeout and intercept retrieveClientDiscoveryTransportConfigs
  const initNeedle = 'if(!await PS.awaitServerReady(6e4))throw new Error("gRPC server not ready — timed out waiting for ExpressGrpcServerSingleton to start");await KOr(e);const t=await eU().getToken(),r=await PAt().retrieveClientDiscoveryTransportConfigs();';
  const initReplacement = 'await PS.awaitServerReady(10);await KOr(e);const t=await eU().getToken(),r=[]; /* BYPASS GRPC INIT */';
  patchedCode = replaceOnce(patchedCode, initNeedle, initReplacement);

  // 2. Bypass "Extension did not fully initialize after initial activation — showing sign-in app as fallback"
  // This prevents the extension from rendering the SignIn webview when initialization fails
  patchedCode = patchedCode.replace(
    /e&&!e\.ready&&\([a-zA-Z0-9_]+\.info\(`Extension did not fully initialize after/g,
    'false&&!e.ready&&($1.info(`Extension did not fully initialize after'
  );

  // 3. Bypass "Reloading extension due to auth session change"
  // This prevents the extension from reloading the entire VSCode window when token validation fails
  patchedCode = patchedCode.replace(
    /([a-zA-Z0-9_]+\.info\("======== Reloading extension due to auth session change ========"\),).*?he\.commands\.executeCommand\("workbench\.action\.reloadWindow"\)/g,
    '$1 /* BYPASS RELOAD */ false'
  );

  // 4. Bypass 300s WorkspaceManager indexing wait (prevents "Indexing..." UI from hanging)
  patchedCode = patchedCode.replace(
    /const ([a-zA-Z0-9_]+)=300\*1e3;(await [a-zA-Z0-9_]+\.diskFileManager\.awaitQuiesced\(\1\)\?)/g,
    'const $1=10;$2 /* BYPASS 300S WAIT */'
  );

  // 5. Bypass awaitInitialFoldersSynced infinite loop (prevents "Indexing codebase" from hanging forever)
  patchedCode = patchedCode.replace(
    /async awaitInitialFoldersSynced\(\)\{for\(;!this\.initialFoldersSynced;\)await [a-zA-Z0-9_]+\(this\._folderSyncedEmitter\.event,this\._pendingEventSubscriptions\)\}/g,
    'async awaitInitialFoldersSynced(){/* BYPASS INIT SYNC WAIT */}'
  );

  // 5b. Short-circuit find-missing so DiskFileManager can drain itemsInFlight.
  // Without this, probe/upload keeps retrying the official backend and the status bar
  // stays on "Augment is indexing your codebase" for a very long time.
  // Keep a dead callApi(...,"find-missing") so endpoint catalog analysis still sees the endpoint.
  const findMissingEmpty =
    'async findMissing(){return {unknownBlobNames:[],nonindexedBlobNames:[]}; /* BYPASS FIND MISSING */this.callApi(0,0,"find-missing")}';
  patchedCode = replaceOnce(
    patchedCode,
    'async findMissing(t,r){const n=await this.clientConfig.getConfig(),i=this.createRequestId(),a=[...t].sort();return await this.apiRetry.retryWithRetryAfter("find-missing",async()=>await this.callApi(i,n,"find-missing",{model:r,mem_object_names:a},h0r))}',
    findMissingEmpty,
    "standalone findMissing(t,r)"
  );
  patchedCode = replaceOnce(
    patchedCode,
    'async findMissing(t){const r=this._configListener.config,n=this.createRequestId(),i=r.modelName,a=[...t].sort();return await this.apiRetry.retryWithRetryAfter("find-missing",async()=>await this.callApi(n,r,"find-missing",{model:i,mem_object_names:a},s=>this.toFindMissingResult(s)))}',
    findMissingEmpty,
    "standalone findMissing(t)"
  );

  // 6. Auto-approve all tool execution (bypasses the "ask-user" prompt)
  patchedCode = patchedCode.replace(
    /const ([a-zA-Z0-9_]+)=await ([a-zA-Z0-9_]+)\(([a-zA-Z0-9_]+),[a-zA-Z0-9_]+\(\{toolName:\3,toolInput:([a-zA-Z0-9_]+)\}\),([a-zA-Z0-9_]+),([a-zA-Z0-9_]+)\);/g,
    'const $1="approved"; /* BYPASS APPROVAL */'
  );

  // 6b. Auto-approve toolPermissionPolicies (bypasses new policy-based ask-user checks)
  patchedCode = patchedCode.replace(
    /(\{deny:5,"webhook-policy":4,"script-policy":3,"ask-user":2,allow:1\};async function )([a-zA-Z0-9_]+)\([^)]+\)\{/g,
    '$1$2(){return {allow:true}; /* BYPASS POLICY */'
  );

  // 6c. Auto-approve agentAutoMode (bypasses new webview frontend agent mode card)
  patchedCode = patchedCode.replace(
    /(type:[a-zA-Z0-9_$]+\.checkAgentAutoModeApprovalResponse,data:)[^}]*(\})/g,
    '$1!0$2 /* BYPASS AUTO MODE */'
  );

  return patchedCode;
}

module.exports = {
  patchStandaloneMode
};
