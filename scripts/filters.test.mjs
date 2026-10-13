import { test } from "node:test";
import assert from "node:assert/strict";
import { isActive, isOverdue, isRecurring, findDuplicateGroups } from "../filters.mjs";

const NOW = new Date(2026, 9, 13, 10, 0, 0).getTime(); // 13 Oct 2026 10:00 local
const MIDNIGHT = new Date(2026, 9, 13, 0, 0, 0).getTime();

let seq = 0;
function task(overrides = {}) {
  seq++;
  return {
    id: `T${seq}`, name: `Task ${seq}`, projectId: "P1", state: 0, isFinished: false,
    deadline: 0, rCycle: 0, rId: "", actualPomoNum: 0, hasSubtask: false, remark: "",
    creationDate: 1000 + seq, ...overrides,
  };
}

test("active means not finished and state 0", () => {
  assert.equal(isActive(task()), true);
  assert.equal(isActive(task({ isFinished: true })), false);
  assert.equal(isActive(task({ state: 1 })), false);
  assert.equal(isActive(task({ state: -1 })), false);
});

test("overdue boundary is local midnight today", () => {
  assert.equal(isOverdue(task({ deadline: MIDNIGHT - 1 }), NOW), true);
  assert.equal(isOverdue(task({ deadline: MIDNIGHT }), NOW), false);
});

test("tasks without deadline, finished or archived are never overdue", () => {
  assert.equal(isOverdue(task({ deadline: 0 }), NOW), false);
  assert.equal(isOverdue(task({ deadline: MIDNIGHT - 1, isFinished: true }), NOW), false);
  assert.equal(isOverdue(task({ deadline: MIDNIGHT - 1, state: 1 }), NOW), false);
});

test("recurring means rCycle > 0", () => {
  assert.equal(isRecurring(task({ rCycle: 1 })), true);
  assert.equal(isRecurring(task({ rCycle: 0 })), false);
});

test("groups active occurrences of the same series on the same day", () => {
  const a = task({ rId: "S1", rCycle: 1, deadline: MIDNIGHT + 3600e3 });
  const b = task({ rId: "S1", rCycle: 1, deadline: MIDNIGHT + 7200e3 });
  const otherDay = task({ rId: "S1", rCycle: 1, deadline: MIDNIGHT + 86400e3 });
  const finished = task({ rId: "S1", rCycle: 1, deadline: MIDNIGHT + 3600e3, isFinished: true });
  const groups = findDuplicateGroups([a, b, otherDay, finished]);
  assert.equal(groups.length, 1);
  assert.deepEqual([groups[0].keep.id, ...groups[0].remove.map(t => t.id)].sort(), [a.id, b.id].sort());
});

test("keeps the copy with pomodoros, then subtasks, then remark, then the oldest", () => {
  const base = { rId: "S2", rCycle: 1, deadline: MIDNIGHT + 1 };
  const old = task({ ...base, creationDate: 1 });
  const withRemark = task({ ...base, remark: "note", creationDate: 5 });
  const withSub = task({ ...base, hasSubtask: true, creationDate: 6 });
  const withPomos = task({ ...base, actualPomoNum: 2, creationDate: 7 });
  assert.equal(findDuplicateGroups([old, withRemark, withSub, withPomos])[0].keep.id, withPomos.id);
  assert.equal(findDuplicateGroups([old, withRemark, withSub])[0].keep.id, withSub.id);
  assert.equal(findDuplicateGroups([old, withRemark])[0].keep.id, withRemark.id);
  assert.equal(findDuplicateGroups([withRemark, old].map(t => ({ ...t, remark: "" })))[0].keep.id, old.id);
});

test("non-recurring duplicates only when requested", () => {
  const x = task({ name: "Same", deadline: MIDNIGHT + 1 });
  const y = task({ name: "Same", deadline: MIDNIGHT + 2 });
  assert.equal(findDuplicateGroups([x, y]).length, 0);
  assert.equal(findDuplicateGroups([x, y], { includeNonRecurring: true }).length, 1);
});
