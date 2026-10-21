import { test } from "node:test";
import assert from "node:assert/strict";
import { WRITE_TOOL_DEFINITIONS, createWriteHandlers } from "../write-tools.mjs";

const TODAY = new Date(2026, 9, 13, 23, 59, 59).getTime();

function data(tasks) {
  return {
    projects: new Map([["P1", { id: "P1", name: "Project 1" }]]),
    tasks: new Map(tasks.map(t => [t.id, { name: t.id, projectId: "P1", state: 0, isFinished: false, rCycle: 0, rId: "", deadline: TODAY, creationDate: 1, ...t }])),
  };
}

function setup(tasks, { decision = "accepted", result, fail } = {}) {
  const calls = { writer: [], confirm: [], invalidated: 0, options: [] };
  const respond = method => async (ids, options) => {
    calls.writer.push([method, ids]);
    calls.options.push(options);
    if (fail) throw fail;
    return result ?? { results: ids.map(id => ({ id, ok: true })), pendingSync: [], uiRefreshed: true };
  };
  const h = createWriteHandlers({
    getData: () => data(tasks),
    invalidate: () => { calls.invalidated++; },
    writer: {
      createTask: async fields => { calls.writer.push(["create", fields]); return `Created task: ${fields.name} (task-id)`; },
      updateTask: async (id, patch) => { calls.writer.push(["update", id, patch]); return `Updated task: ${id}`; },
      completeTasks: respond("complete"),
      uncompleteTasks: respond("uncomplete"),
      skipOccurrences: respond("skip"),
      deleteTasks: respond("delete"),
    },
    confirm: async args => { calls.confirm.push(args); return decision; },
  });
  return { h, calls };
}

test("write tools are annotated as in the spec", () => {
  const byName = Object.fromEntries(WRITE_TOOL_DEFINITIONS.map(d => [d.name, d.annotations]));
  assert.deepEqual(byName.create_task, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  assert.deepEqual(byName.update_task, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  assert.deepEqual(byName.delete_tasks, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
  assert.deepEqual(byName.complete_tasks, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  assert.deepEqual(byName.uncomplete_tasks, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  assert.deepEqual(byName.skip_occurrences, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  assert.deepEqual(byName.remove_duplicate_tasks, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  const batchTools = WRITE_TOOL_DEFINITIONS.filter(d => ["complete_tasks", "uncomplete_tasks", "skip_occurrences", "remove_duplicate_tasks", "delete_tasks"].includes(d.name));
  for (const d of batchTools) {
    assert.equal(d.inputSchema.properties.task_ids.maxItems, 50);
    assert.deepEqual(Object.keys(d.inputSchema.properties), ["task_ids"]);
  }
  const createDef = WRITE_TOOL_DEFINITIONS.find(d => d.name === "create_task");
  assert.ok(createDef.inputSchema.properties.name);
  const updateDef = WRITE_TOOL_DEFINITIONS.find(d => d.name === "update_task");
  assert.ok(updateDef.inputSchema.properties.id);
});

test("complete_tasks completes active tasks after confirmation", async () => {
  const { h, calls } = setup([{ id: "a" }]);
  const text = await h.complete_tasks({ task_ids: ["a"] });
  assert.deepEqual(calls.writer, [["complete", ["a"]]]);
  assert.match(calls.confirm[0].message, /a · Project 1 · 2026-10-13/);
  assert.match(text, /Completed 1\/1/);
  assert.equal(calls.invalidated, 1);
});

test("repeated IDs are executed once", async () => {
  const { h, calls } = setup([{ id: "a" }]);
  await h.complete_tasks({ task_ids: ["a", "a"] });
  assert.deepEqual(calls.writer, [["complete", ["a"]]]);
});

test("already completed tasks are skipped without calling the writer", async () => {
  const { h, calls } = setup([{ id: "done", isFinished: true }]);
  const text = await h.complete_tasks({ task_ids: ["done"] });
  assert.equal(calls.writer.length, 0);
  assert.match(text, /Nothing to do/);
  assert.match(text, /done: already completed/);
});

test("unknown and archived IDs are rejected, valid ones still run", async () => {
  const { h, calls } = setup([{ id: "a" }, { id: "arch", state: 1 }]);
  const text = await h.complete_tasks({ task_ids: ["a", "nope", "arch"] });
  assert.deepEqual(calls.writer, [["complete", ["a"]]]);
  assert.match(text, /Rejected nope: task not found/);
  assert.match(text, /Rejected arch: task is not active/);
});

test("more than 50 IDs is an error", async () => {
  const ids = Array.from({ length: 51 }, (_, i) => `t${i}`);
  const { h } = setup(ids.map(id => ({ id })));
  await assert.rejects(h.complete_tasks({ task_ids: ids }), /At most 50/);
});

test("without confirmation forms, writes are refused and nothing changes", async () => {
  for (const tool of ["complete_tasks", "skip_occurrences", "remove_duplicate_tasks"]) {
    const { h, calls } = setup([
      { id: "a", rCycle: 1, rId: "S1", creationDate: 1 },
      { id: "b", rCycle: 1, rId: "S1", creationDate: 2 },
    ], { decision: "unavailable" });
    const text = await h[tool]({ task_ids: ["b"] });
    assert.equal(calls.writer.length, 0, tool);
    assert.match(text, /confirmation forms.*nothing was changed/s, tool);
  }
});

test("declined changes nothing", async () => {
  const { h, calls } = setup([{ id: "a" }], { decision: "declined" });
  assert.match(await h.complete_tasks({ task_ids: ["a"] }), /Cancelled/);
  assert.equal(calls.writer.length, 0);
});

test("skip_occurrences rejects non-recurring tasks", async () => {
  const { h, calls } = setup([{ id: "plain" }, { id: "rec", rCycle: 1, rId: "S1" }]);
  const text = await h.skip_occurrences({ task_ids: ["plain", "rec"] });
  assert.deepEqual(calls.writer, [["skip", ["rec"]]]);
  assert.match(text, /Rejected plain: task is not recurring/);
});

test("remove_duplicate_tasks rejects the kept copy and removes the extra one", async () => {
  const { h, calls } = setup([
    { id: "keep", rCycle: 1, rId: "S1", creationDate: 1 },
    { id: "extra", rCycle: 1, rId: "S1", creationDate: 2 },
  ]);
  const text = await h.remove_duplicate_tasks({ task_ids: ["keep", "extra"] });
  assert.deepEqual(calls.writer, [["delete", ["extra"]]]);
  assert.match(text, /Rejected keep: this is the copy kept/);
  assert.match(calls.confirm[0].message, /keeps keep/);
});

test("remove_duplicate_tasks rejects tasks that are not duplicates", async () => {
  const { h, calls } = setup([{ id: "solo", rCycle: 1, rId: "S9" }]);
  assert.match(await h.remove_duplicate_tasks({ task_ids: ["solo"] }), /Rejected solo: task is not a duplicate/);
  assert.equal(calls.writer.length, 0);
});

test("reports next occurrences, failures, pending sync and a skipped reload", async () => {
  const { h } = setup([{ id: "a", rCycle: 1, rId: "S1" }, { id: "b" }], {
    result: {
      results: [{ id: "a", ok: true, nextOccurrence: { id: "N1", deadline: TODAY + 86400e3 } }, { id: "b", ok: false, error: "boom" }],
      pendingSync: ["N1"],
      uiRefreshed: false,
    },
  });
  const text = await h.complete_tasks({ task_ids: ["a", "b"] });
  assert.match(text, /Completed 1\/2/);
  assert.match(text, /N1 \(2026-10-14\)/);
  assert.match(text, /Failed b: boom/);
  assert.match(text, /not yet confirmed by the sync server: N1/);
  assert.match(text, /window was not reloaded/);
});

test("remove_duplicate_tasks tells the writer which copy each removal keeps", async () => {
  const { h, calls } = setup([
    { id: "keep", rCycle: 1, rId: "S1", creationDate: 1 },
    { id: "extra", rCycle: 1, rId: "S1", creationDate: 2 },
  ]);
  await h.remove_duplicate_tasks({ task_ids: ["extra"] });
  assert.deepEqual(calls.options[0], { keepOf: { extra: "keep" } });
});

test("the form says which pomodoros and subtasks a duplicate removal deletes", async () => {
  const { h, calls } = setup([
    { id: "keep", rCycle: 1, rId: "S1", actualPomoNum: 4, creationDate: 1 },
    { id: "extra", rCycle: 1, rId: "S1", actualPomoNum: 3, hasSubtask: true, creationDate: 2 },
  ]);
  await h.remove_duplicate_tasks({ task_ids: ["extra"] });
  assert.match(calls.confirm[0].message, /extra .*deletes its 3 pomodoro\(s\) and subtasks/);
});

test("the cache is invalidated even when the writer fails", async () => {
  const { h, calls } = setup([{ id: "a" }], { fail: new Error("CDP connection closed") });
  await assert.rejects(h.complete_tasks({ task_ids: ["a"] }), /closed/);
  assert.equal(calls.invalidated, 1);
});

test("a writer warning reaches the result text", async () => {
  const { h } = setup([{ id: "a" }], { result: { results: [{ id: "a", ok: true }], pendingSync: ["a"], uiRefreshed: false, warning: "The changes were applied, but X" } });
  assert.match(await h.complete_tasks({ task_ids: ["a"] }), /The changes were applied, but X/);
});

test("complete_tasks keeps an existing next occurrence instead of creating another", async () => {
  const { h, calls } = setup([
    { id: "late", rCycle: 1, rId: "S1", deadline: TODAY - 10 * 86400e3 },
    { id: "next", rCycle: 1, rId: "S1", deadline: TODAY + 86400e3 },
    { id: "lone", rCycle: 1, rId: "S2", deadline: TODAY - 86400e3 },
  ]);
  await h.complete_tasks({ task_ids: ["late", "lone"] });
  assert.deepEqual(calls.options[0], { successorOf: { late: "next" } });
  assert.match(calls.confirm[0].message, /late .*\[next occurrence already exists: 2026-10-14\]/);
});

test("complete_tasks describes the no-duplicate behaviour for recurring tasks", () => {
  const d = WRITE_TOOL_DEFINITIONS.find(x => x.name === "complete_tasks").description;
  assert.match(d, /unless the series already has a later active occurrence/);
});

test("create_task validates, confirms, builds fields and calls writer", async () => {
  const { h, calls } = setup([]);
  const res = await h.create_task({
    name: "Buy groceries",
    project_id: "P1",
    priority: 2,
    deadline: "2026-10-15",
    notes: "Milk, eggs, bread",
    estimated_pomos: 2,
  });
  assert.equal(calls.writer.length, 1);
  assert.equal(calls.writer[0][0], "create");
  const fields = calls.writer[0][1];
  assert.equal(fields.name, "Buy groceries");
  assert.equal(fields.projectId, "P1");
  assert.equal(fields.priority, 2);
  assert.equal(fields.remark, "Milk, eggs, bread");
  assert.equal(fields.estimatePomoNum, 2);
  assert.match(res, /Created task: Buy groceries/);
  assert.equal(calls.invalidated, 1);
});

test("create_task rejects unknown project_id", async () => {
  const { h } = setup([]);
  await assert.rejects(h.create_task({ name: "Test", project_id: "unknown_p" }), /Project not found: unknown_p/);
});

test("create_task respects declined confirmation", async () => {
  const { h, calls } = setup([], { decision: "declined" });
  const res = await h.create_task({ name: "Cancelled task" });
  assert.equal(calls.writer.length, 0);
  assert.match(res, /Cancelled; nothing was created/);
  assert.equal(calls.invalidated, 0);
});

test("delete_tasks deletes active and completed tasks after confirmation", async () => {
  const { h, calls } = setup([{ id: "t1" }, { id: "t2", isFinished: true }]);
  const text = await h.delete_tasks({ task_ids: ["t1", "t2"] });
  assert.deepEqual(calls.writer[0], ["delete", ["t1", "t2"]]);
  assert.deepEqual(calls.options[0], { allowFinished: true });
  assert.match(text, /Deleted 2\/2/);
  assert.equal(calls.invalidated, 1);
});

test("delete_tasks skips already deleted tasks and rejects unknown", async () => {
  const { h, calls } = setup([{ id: "t1", state: -1 }]);
  const text = await h.delete_tasks({ task_ids: ["t1", "unknown"] });
  assert.equal(calls.writer.length, 0);
  assert.match(text, /Nothing to do/);
  assert.match(text, /t1: already deleted/);
  assert.match(text, /unknown: task not found/);
});

test("update_task validates, confirms and calls writer with patch", async () => {
  const { h, calls } = setup([{ id: "t1", name: "Old name", priority: 0 }]);
  const res = await h.update_task({
    id: "t1",
    name: "New name",
    priority: 3,
    notes: "Updated note",
    deadline: "2026-10-20",
    estimated_pomos: 4,
  });
  assert.equal(calls.writer.length, 1);
  assert.equal(calls.writer[0][0], "update");
  assert.equal(calls.writer[0][1], "t1");
  const patch = calls.writer[0][2];
  assert.equal(patch.name, "New name");
  assert.equal(patch.priority, 3);
  assert.equal(patch.remark, "Updated note");
  assert.equal(patch.estimatePomoNum, 4);
  assert.ok(patch.deadline > 0);
  assert.match(res, /Updated task: t1/);
  assert.equal(calls.invalidated, 1);
});

test("update_task returns Nothing to update if no fields changed", async () => {
  const { h, calls } = setup([{ id: "t1", name: "Same name" }]);
  const res = await h.update_task({ id: "t1", name: "Same name" });
  assert.equal(calls.writer.length, 0);
  assert.match(res, /Nothing to update/);
});

test("update_task rejects unknown task ID", async () => {
  const { h } = setup([]);
  await assert.rejects(h.update_task({ id: "nonexistent", name: "Test" }), /Task not found: nonexistent/);
});

test("update_task respects declined confirmation", async () => {
  const { h, calls } = setup([{ id: "t1", name: "Old name" }], { decision: "declined" });
  const res = await h.update_task({ id: "t1", name: "New name" });
  assert.equal(calls.writer.length, 0);
  assert.match(res, /Cancelled; nothing was changed/);
  assert.equal(calls.invalidated, 0);
});

test("uncomplete_tasks reopens completed tasks after confirmation", async () => {
  const { h, calls } = setup([{ id: "done", isFinished: true }]);
  const text = await h.uncomplete_tasks({ task_ids: ["done"] });
  assert.deepEqual(calls.writer[0], ["uncomplete", ["done"]]);
  assert.match(text, /Reopened 1\/1/);
  assert.equal(calls.invalidated, 1);
});

test("uncomplete_tasks skips active tasks and rejects deleted tasks", async () => {
  const { h, calls } = setup([{ id: "active", isFinished: false }, { id: "del", isFinished: true, state: -1 }]);
  const text = await h.uncomplete_tasks({ task_ids: ["active", "del", "unknown"] });
  assert.equal(calls.writer.length, 0);
  assert.match(text, /Nothing to do/);
  assert.match(text, /active: already active/);
  assert.match(text, /del: task is deleted/);
  assert.match(text, /unknown: task not found/);
});
