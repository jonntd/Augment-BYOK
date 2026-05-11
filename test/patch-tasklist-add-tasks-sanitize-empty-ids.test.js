const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { patchTasklistAddTasksSanitizeEmptyIds } = require("../tools/patch/patch-tasklist-add-tasks-sanitize-empty-ids");

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

test("patchTasklistAddTasksSanitizeEmptyIds: strips empty optional ids in current const loop shape", () => {
  withTempDir("augment-byok-task-sanitize-", (dir) => {
    const filePath = path.join(dir, "extension.js");
    const src = [
      `class AddTasksTool{`,
      `  async handleBatchCreation(e,t){`,
      `    for(const s of t)try{const o=await this.createSingleTaskFromInput(e,s);console.log(o)}catch(o){console.log(o)}`,
      `  }`,
      `}`
    ].join("\n");
    writeUtf8(filePath, src);

    const r1 = patchTasklistAddTasksSanitizeEmptyIds(filePath);
    assert.equal(r1.changed, true);

    const out = readUtf8(filePath);
    assert.ok(out.includes("__augment_byok_tasklist_add_tasks_sanitize_empty_ids_patched_v1"));
    assert.ok(out.includes("for(const s of t)try{"));
    assert.ok(out.includes('typeof s.parent_task_id==="string"&&s.parent_task_id.trim()===""&&delete s.parent_task_id;'));
    assert.ok(out.includes("const o=await this.createSingleTaskFromInput(e,s);"));

    const r2 = patchTasklistAddTasksSanitizeEmptyIds(filePath);
    assert.equal(r2.changed, false);
  });
});
