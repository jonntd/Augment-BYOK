const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { patchTasklistReorganizeNoopErrors } = require("../tools/patch/patch-tasklist-reorganize-noop-errors");

function withTempDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readUtf8(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function writeUtf8(filePath, content) {
  fs.writeFileSync(filePath, content, "utf8");
}

test("patchTasklistReorganizeNoopErrors: marks no-op in current const/notify bundle shape", () => {
  withTempDir("augment-byok-task-reorg-", (dir) => {
    const filePath = path.join(dir, "extension.js");
    const src = [
      `class ReorganizeTool{`,
      `async call(e,t,r,n,i,a){try{const s=e.markdown;if(!s)return jt("No markdown provided.");const o=await this._taskManager.getOrCreateTaskListId(a);if(!o)return jt("No task list found. [TL003]");const l=await this._taskManager.getHydratedTask(o);if(!l)return jt(\`Task with UUID \${o} not found.\`);let c;c=parse(s);c.uuid=o;await this._taskManager.updateHydratedTask(c,Xd.AGENT);const p=await this._taskManager.getHydratedTask(o);if(!p)return jt("Failed to retrieve updated task tree after reorganization.");const g=jg.formatBulkUpdateResponse(qM(l,c));return a&&vde(a,p.uuid),{...nn(g),plan:p}}catch(s){return jt(String(s))}}`,
      `}`
    ].join("\n");
    writeUtf8(filePath, src);

    const r1 = patchTasklistReorganizeNoopErrors(filePath);
    assert.equal(r1.changed, true);

    const out = readUtf8(filePath);
    assert.ok(out.includes("__augment_byok_tasklist_reorganize_noop_errors_patched_v1"));
    assert.ok(out.includes("let __byok_reorg_diff=qM(l,c);"));
    assert.ok(out.includes('return{...jt("Task list reorganization produced no changes."),plan:p}'));
    assert.ok(out.includes("let g=jg.formatBulkUpdateResponse(__byok_reorg_diff);"));
    assert.ok(out.includes("return a&&vde(a,p.uuid),{...nn(g),plan:p}"));

    const r2 = patchTasklistReorganizeNoopErrors(filePath);
    assert.equal(r2.changed, false);
  });
});
