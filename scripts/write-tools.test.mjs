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
    writer: { completeTasks: respond("complete"), skipOccurrences: respond("skip"), deleteTasks: respond("delete") },
    confirm: async args => { calls.confirm.push(args); return decision; },
  });
  return { h, calls };
}

test("write tools are annotated as in the spec", () => {
  const byName = Object.fromEntries(WRITE_TOOL_DEFINITIONS.map(d => [d.name, d.annotations]));
  assert.deepEqual(byName.complete_tasks, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  assert.deepEqual(byName.skip_occurrences, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  assert.deepEqual(byName.remove_duplicate_tasks, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  for (const d of WRITE_TOOL_DEFINITIONS) {
    assert.equal(d.inputSchema.properties.task_ids.maxItems, 50);
    assert.ok(d.inputSchema.properties.confirmation_token);
    assert.equal(d.inputSchema.properties.confirmed, undefined);
  }
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

const tokenOf = text => text.match(/confirmation_token: "([^"]+)"/)?.[1];

test("without a form: preview changes nothing and issues a token", async () => {
  const { h, calls } = setup([{ id: "a" }], { decision: "unavailable" });
  const text = await h.complete_tasks({ task_ids: ["a"] });
  assert.equal(calls.writer.length, 0);
  assert.match(text, /nothing was changed/);
  assert.ok(tokenOf(text));
});

test("without a form: the preview token applies exactly the previewed IDs", async () => {
  const { h, calls } = setup([{ id: "a" }, { id: "b" }], { decision: "unavailable" });
  const token = tokenOf(await h.complete_tasks({ task_ids: ["b", "a"] }));
  assert.match(await h.complete_tasks({ task_ids: ["a", "b"], confirmation_token: token }), /Completed 2\/2/);
  assert.deepEqual(calls.writer, [["complete", ["a", "b"]]]);
});

test("without a form: an invented token only produces a new preview", async () => {
  const { h, calls } = setup([{ id: "a" }], { decision: "unavailable" });
  const text = await h.complete_tasks({ task_ids: ["a"], confirmation_token: "made-up" });
  assert.equal(calls.writer.length, 0);
  assert.match(text, /nothing was changed/);
});

test("without a form: a token is single-use and bound to its IDs and tool", async () => {
  const { h, calls } = setup([{ id: "a" }, { id: "b" }, { id: "r", rCycle: 1, rId: "S1" }], { decision: "unavailable" });
  const token = tokenOf(await h.complete_tasks({ task_ids: ["a"] }));
  assert.match(await h.complete_tasks({ task_ids: ["a", "b"], confirmation_token: token }), /nothing was changed/);
  const t2 = tokenOf(await h.complete_tasks({ task_ids: ["r"] }));
  assert.match(await h.skip_occurrences({ task_ids: ["r"], confirmation_token: t2 }), /nothing was changed/);
  const t3 = tokenOf(await h.complete_tasks({ task_ids: ["a"] }));
  await h.complete_tasks({ task_ids: ["a"], confirmation_token: t3 });
  assert.match(await h.complete_tasks({ task_ids: ["a"], confirmation_token: t3 }), /nothing was changed/);
  assert.deepEqual(calls.writer, [["complete", ["a"]]]);
});

test("with a form, a token cannot bypass a declined form", async () => {
  const { h, calls } = setup([{ id: "a" }], { decision: "declined" });
  assert.match(await h.complete_tasks({ task_ids: ["a"], confirmation_token: "anything" }), /Cancelled/);
  assert.equal(calls.writer.length, 0);
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
