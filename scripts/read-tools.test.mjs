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

test("search_tasks finds by name, remark, and tagNames", () => {
  const projects = new Map([
    ["P1", { id: "P1", name: "Work", order: 0, type: 1000 }],
    ["TAG1", { id: "TAG1", name: "Urgent", order: 1, type: 3000 }],
  ]);
  const tasks = [
    { id: "t1", name: "Fix billing bug", projectId: "P1", tags: "" },
    { id: "t2", name: "Review PR", projectId: "P1", remark: "Need billing team review", tags: "" },
    { id: "t3", name: "Deploy release", projectId: "P1", tags: "TAG1" },
  ];
  const h = createReadHandlers({
    getData: () => ({ projects, tasks: new Map(tasks.map(t => [t.id, { state: 0, isFinished: false, ...t }])), subtasks: new Map(), pomodoros: new Map() }),
    now: () => NOW,
  });
  assert.deepEqual(h.search_tasks({ query: "billing" }).map(t => t.id), ["t1", "t2"]);
  assert.deepEqual(h.search_tasks({ query: "urgent" }).map(t => t.id), ["t3"]);
});

test("get_task returns full details with subtasks and pomodoros", () => {
  const projects = new Map([["P1", { id: "P1", name: "Project 1" }]]);
  const tasks = new Map([["t1", { id: "t1", name: "Task 1", projectId: "P1", state: 0, isFinished: false }]]);
  const subtasks = new Map([["s1", { id: "s1", taskId: "t1", name: "Sub 1", isFinished: false, state: 0, order: 1, estimatedPomoNum: 1 }]]);
  const pomodoros = new Map([
    ["p1", { id: "p1", taskId: "t1", interval: 1500, endDate: NOW - 1000, state: 0 }],
    ["p2", { id: "p2", taskId: "t1", interval: 1500, endDate: NOW - 2000, state: 0 }],
  ]);
  const h = createReadHandlers({
    getData: () => ({ projects, tasks, subtasks, pomodoros }),
    now: () => NOW,
  });
  const detail = h.get_task({ id: "t1" });
  assert.equal(detail.name, "Task 1");
  assert.equal(detail.subtasks.length, 1);
  assert.equal(detail.subtasks[0].name, "Sub 1");
  assert.equal(detail.total_focus_minutes, 50);
  assert.equal(detail.pomodoro_count, 2);
  assert.equal(detail.recent_pomodoros.length, 2);
});

test("get_today_focus computes focus stats, tasks focused, due today and overdue", () => {
  const projects = new Map([["P1", { id: "P1", name: "Main Project" }]]);
  const tasks = new Map([
    ["due_t", { id: "due_t", name: "Due Today", projectId: "P1", state: 0, isFinished: false, deadline: TODAY, order: 1 }],
    ["late_t", { id: "late_t", name: "Overdue Task", projectId: "P1", state: 0, isFinished: false, deadline: YESTERDAY, order: 2 }],
    ["future_t", { id: "future_t", name: "Future Task", projectId: "P1", state: 0, isFinished: false, deadline: TODAY + 86400e3 }],
  ]);
  const pomodoros = new Map([
    ["p1", { id: "p1", taskId: "due_t", interval: 1500, endDate: NOW, state: 0 }],
    ["p2", { id: "p2", taskId: "due_t", interval: 1500, endDate: NOW, state: 0 }],
  ]);
  const h = createReadHandlers({
    getData: () => ({ projects, tasks, subtasks: new Map(), pomodoros }),
    now: () => NOW,
  });
  const today = h.get_today_focus();
  assert.equal(today.total_pomodoros, 2);
  assert.equal(today.total_focus_minutes, 50);
  assert.equal(today.tasks_focused.length, 1);
  assert.equal(today.tasks_focused[0].taskName, "Due Today");
  assert.deepEqual(today.due_today.map(t => t.id), ["due_t"]);
  assert.deepEqual(today.overdue.map(t => t.id), ["late_t"]);
});

test("list_projects marks tags with isTag true", () => {
  const projects = new Map([
    ["L1", { id: "L1", name: "Work", type: 1000, order: 0 }],
    ["T1", { id: "T1", name: "Backend", type: 3000, order: 1 }],
  ]);
  const h = createReadHandlers({ getData: () => ({ projects, tasks: new Map(), subtasks: new Map(), pomodoros: new Map() }), now: () => NOW });
  const res = h.list_projects();
  assert.equal(res.find(p => p.id === "L1").isTag, false);
  assert.equal(res.find(p => p.id === "T1").isTag, true);
});
