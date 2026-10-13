import { test } from "node:test";
import assert from "node:assert/strict";
import { liveTaskProblem, appliedProblem } from "../guards.mjs";

const DAY = new Date(2026, 9, 13, 23, 59, 59).getTime();
const live = (o = {}) => ({ id: "t", isFinished: false, state: 0, rCycle: 0, rId: "", deadline: DAY, ...o });

test("a task that vanished or changed since it was read is refused", () => {
  assert.match(liveTaskProblem(undefined, {}), /no longer exists/);
  assert.match(liveTaskProblem(live({ isFinished: true }), {}), /no longer active/);
  assert.match(liveTaskProblem(live({ state: -1 }), {}), /no longer active/);
  assert.equal(liveTaskProblem(live(), {}), null);
});

test("skip requires the live task to still be recurring", () => {
  assert.match(liveTaskProblem(live({ rCycle: 0 }), { recurring: true }), /no longer recurring/);
  assert.equal(liveTaskProblem(live({ rCycle: 1 }), { recurring: true }), null);
});

test("duplicate removal requires the kept copy to be live and still a duplicate", () => {
  const dup = live({ rId: "S1", rCycle: 1 });
  assert.match(liveTaskProblem(dup, { keepId: "k" }, undefined), /copy to keep/);
  assert.match(liveTaskProblem(dup, { keepId: "k" }, live({ id: "k", rId: "S1", isFinished: true })), /copy to keep/);
  assert.match(liveTaskProblem(dup, { keepId: "k" }, live({ id: "k", rId: "S2" })), /no longer a duplicate/);
  assert.match(liveTaskProblem(dup, { keepId: "k" }, live({ id: "k", rId: "S1", deadline: DAY + 86400e3 })), /no longer a duplicate/);
  assert.equal(liveTaskProblem(dup, { keepId: "k" }, live({ id: "k", rId: "S1" })), null);
});

test("allowFinished lets cleanup delete completed tasks", () => {
  assert.equal(liveTaskProblem(live({ isFinished: true }), { allowFinished: true }), null);
  assert.match(liveTaskProblem(live({ state: -1 }), { allowFinished: true }), /no longer active/);
});

test("the change must be visible after the app call", () => {
  assert.equal(appliedProblem("completeTask", live({ isFinished: true })), null);
  assert.match(appliedProblem("completeTask", live()), /did not apply/);
  assert.equal(appliedProblem("deleteTask", live({ state: -1 })), null);
  assert.equal(appliedProblem("deleteCurrentRepeatTask", live({ state: -1 })), null);
  assert.match(appliedProblem("deleteTask", live()), /did not apply/);
});

test("guards are self-contained so they can run inside the page", () => {
  for (const fn of [liveTaskProblem, appliedProblem]) {
    const copy = new Function(`return (${fn.toString()})`)();
    assert.equal(typeof copy, "function");
  }
  assert.equal(new Function(`return (${liveTaskProblem.toString()})`)()(live(), {}), null);
});
