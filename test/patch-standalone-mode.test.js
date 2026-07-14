const test = require("node:test");
const assert = require("node:assert/strict");

const { patchStandaloneMode } = require("../tools/patch/patch-standalone-mode");

function fixtureExtensionJs() {
  return [
    `if(!await PS.awaitServerReady(6e4))throw new Error("gRPC server not ready — timed out waiting for ExpressGrpcServerSingleton to start");await KOr(e);const t=await eU().getToken(),r=await PAt().retrieveClientDiscoveryTransportConfigs();`,
    `async awaitInitialFoldersSynced(){for(;!this.initialFoldersSynced;)await mge(this._folderSyncedEmitter.event,this._pendingEventSubscriptions)}`,
    `const p=300*1e3;await a.diskFileManager.awaitQuiesced(p)?r.logger.info("Source folder synced successfully"):r.logger.info("timeout");`,
    `async findMissing(t,r){const n=await this.clientConfig.getConfig(),i=this.createRequestId(),a=[...t].sort();return await this.apiRetry.retryWithRetryAfter("find-missing",async()=>await this.callApi(i,n,"find-missing",{model:r,mem_object_names:a},h0r))}`,
    `async findMissing(t){const r=this._configListener.config,n=this.createRequestId(),i=r.modelName,a=[...t].sort();return await this.apiRetry.retryWithRetryAfter("find-missing",async()=>await this.callApi(n,r,"find-missing",{model:i,mem_object_names:a},s=>this.toFindMissingResult(s)))}`,
  ].join("\n");
}

test("patchStandaloneMode: bypasses init wait and findMissing indexing drain", () => {
  const out = patchStandaloneMode(fixtureExtensionJs());

  assert.ok(out.includes("BYPASS GRPC INIT"));
  assert.ok(out.includes("BYPASS INIT SYNC WAIT"));
  assert.ok(out.includes("BYPASS 300S WAIT"));
  assert.equal(out.includes("awaitInitialFoldersSynced(){for(;!this.initialFoldersSynced;)"), false);
  assert.equal(out.includes('retryWithRetryAfter("find-missing"'), false);
  assert.equal((out.match(/BYPASS FIND MISSING/g) || []).length, 2);
  assert.ok(
    out.includes(
      'async findMissing(){return {unknownBlobNames:[],nonindexedBlobNames:[]}; /* BYPASS FIND MISSING */this.callApi(0,0,"find-missing")}'
    )
  );
  // Endpoint catalog scanners still need a static callApi third-arg for /find-missing.
  assert.equal((out.match(/callApi\(0,0,"find-missing"\)/g) || []).length, 2);
});

test("patchStandaloneMode: applies against cached upstream extension.js when present", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const candidates = [
    path.join(__dirname, "..", ".cache", "extension.js"),
    path.join(__dirname, "..", ".cache", "work", "manual-unpack", "extension", "out", "extension.js"),
  ];
  const srcPath = candidates.find((p) => fs.existsSync(p));
  if (!srcPath) {
    // Cache is optional for CI-like environments without upstream unpack.
    return;
  }

  const src = fs.readFileSync(srcPath, "utf8");
  // Skip if this cache is already patched (e.g. contracts-check artifacts).
  if (src.includes("BYPASS FIND MISSING")) return;

  const out = patchStandaloneMode(src);
  assert.ok(out.includes("BYPASS INIT SYNC WAIT"));
  assert.ok(out.includes("BYPASS 300S WAIT"));
  assert.equal((out.match(/BYPASS FIND MISSING/g) || []).length, 2);
  assert.equal(out.includes('retryWithRetryAfter("find-missing"'), false);
});
