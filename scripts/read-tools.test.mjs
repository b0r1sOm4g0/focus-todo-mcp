import { test } from "node:test";
import assert from "node:assert/strict";
import { READ_TOOL_DEFINITIONS, createReadHandlers } from "../read-tools.mjs";

const NOW = new Date(2026, 9, 13, 10, 0, 0).getTime();
const YESTERDAY = new Date(2026, 9, 12, 23, 59, 59).getTime();
const TODAY = new Date(2026, 9, 13, 23, 59, 59).getTime();

function data(tasks) {
  return {
    projects: new Map([["P1", { id: "P1", name: "Project 1", order: 0 }]]),
    tasks: new Map(tasks.map(t => [t.id, { projectId: "P1", state: 0, isFinished: false, rCycle: 0, rId: "", deadline: 0, creationDate: 1, ...t }])),
    subtasks: new Map(),
    pomodoros: new Map(),
  };
}

test("every read tool is annotated read-only and titled", () => {
  for (const def of READ_TOOL_DEFINITIONS) {
    assert.equal(def.annotations?.readOnlyHint, true, def.name);
    assert.ok(def.title, def.name);
  }
  assert.ok(READ_TOOL_DEFINITIONS.some(d => d.name === "find_duplicate_tasks"));
});

test("list_tasks status overdue follows the app rule", () => {
  const h = createReadHandlers({
    getData: () => data([
      { id: "late", deadline: YESTERDAY },
      { id: "today", deadline: TODAY },
      { id: "archived", deadline: YESTERDAY, state: 1 },
    ]),
    now: () => NOW,
  });
  assert.deepEqual(h.list_tasks({ status: "overdue" }).map(t => t.id), ["late"]);
});

test("list_tasks active excludes state 1 tasks", () => {
  const h = createReadHandlers({ getData: () => data([{ id: "a" }, { id: "s1", state: 1 }]), now: () => NOW });
  assert.deepEqual(h.list_tasks({ status: "active" }).map(t => t.id), ["a"]);
});

test("task summaries expose recurrence", () => {
  const h = createReadHandlers({ getData: () => data([{ id: "r", rCycle: 1, rId: "S1" }]), now: () => NOW });
  const [t] = h.list_tasks({});
  assert.equal(t.recurring, true);
  assert.equal(t.seriesId, "S1");
});

test("find_duplicate_tasks returns keep/remove groups and the extra count", () => {
  const h = createReadHandlers({
    getData: () => data([
      { id: "a", rCycle: 1, rId: "S1", deadline: TODAY, creationDate: 1 },
      { id: "b", rCycle: 1, rId: "S1", deadline: TODAY, creationDate: 2 },
    ]),
    now: () => NOW,
  });
  const r = h.find_duplicate_tasks({});
  assert.equal(r.extra_tasks, 1);
  assert.equal(r.groups[0].keep.id, "a");
  assert.deepEqual(r.groups[0].remove.map(t => t.id), ["b"]);
});
