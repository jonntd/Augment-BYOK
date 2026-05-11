const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { patchTasklistAddTasksErrors } = require("../tools/patch/patch-tasklist-add-tasks-errors");

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

test("patchTasklistAddTasksErrors: reports failures in current ternary return bundle shape", () => {
  withTempDir("augment-byok-task-errors-", (dir) => {
    const filePath = path.join(dir, "extension.js");
    const src = [
      `class AddTasksTool{`,
      `async handleBatchCreation(e,t){const r=await this._taskManager.getOrCreateTaskListId(e);if(!r)return jt("No task list found. [TL005]");const n=await this._taskManager.getHydratedTask(r);if(!n)return jt(\`Task with UUID \${r} not found.\`);const i=[];for(const s of t)try{const o=await this.createSingleTaskFromInput(e,s);i.push({taskId:o.taskId,taskName:o.taskName,success:!0})}catch(o){const l=s.name;i.push({taskName:l||"unknown",success:!1,error:o instanceof Error?o.message:String(o)})}const a=await this._taskManager.getHydratedTask(r);return a?{...nn(jg.formatBulkUpdateResponse(qM(n,a))),plan:a}:jt("Failed to retrieve updated task tree.")}`,
      `}`
    ].join("\n");
    writeUtf8(filePath, src);

    const r1 = patchTasklistAddTasksErrors(filePath);
    assert.equal(r1.changed, true);

    const out = readUtf8(filePath);
    assert.ok(out.includes("__augment_byok_tasklist_add_tasks_errors_patched_v1"));
    assert.ok(out.includes("let __byok_add_tasks_text=jg.formatBulkUpdateResponse(qM(n,a));"));
    assert.ok(out.includes("let __byok_failed=i.filter(t=>t&&t.success===!1);"));
    assert.ok(out.includes('return{...jt("Failed to add task(s)."+__byok_msg),plan:a}'));
    assert.ok(out.includes("return{...nn(__byok_add_tasks_text),plan:a}"));

    const r2 = patchTasklistAddTasksErrors(filePath);
    assert.equal(r2.changed, false);
  });
});
