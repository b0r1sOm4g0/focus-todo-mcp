import { test } from "node:test";
import assert from "node:assert/strict";
import { createWriter } from "../writer.mjs";

function fakeSession({ replies = {}, pending = [], idle = true } = {}) {
  const log = [];
  return {
    log,
    async call(method, id) {
      log.push(["call", method, id]);
      const r = replies[id];
      if (r instanceof Error) throw r;
      return r;
    },
    async syncAndWait(ids) { log.push(["sync", ids]); return pending; },
    async refreshIfIdle() { log.push(["refresh"]); return idle; },
    close() { log.push(["close"]); },
  };
}

test("completeTasks calls completeTask per id and reports next occurrences", async () => {
  const s = fakeSession({ replies: { a: { finishedTask: { id: "a" }, newTask: { id: "n1", deadline: 5 } }, b: { finishedTask: { id: "b" }, newTask: null } } });
  const out = await createWriter({ openSession: async () => s }).completeTasks(["a", "b"]);
  assert.deepEqual(out.results, [
    { id: "a", ok: true, nextOccurrence: { id: "n1", deadline: 5 } },
    { id: "b", ok: true },
  ]);
  assert.deepEqual(s.log.filter(e => e[0] === "call").map(e => e[1]), ["completeTask", "completeTask"]);
  assert.deepEqual(s.log.find(e => e[0] === "sync")[1], ["a", "n1", "b"]);
  assert.equal(out.uiRefreshed, true);
});

test("skipOccurrences uses deleteCurrentRepeatTask and its returned task", async () => {
  const s = fakeSession({ replies: { r: { id: "n2", deadline: 9 } } });
  const out = await createWriter({ openSession: async () => s }).skipOccurrences(["r"]);
  assert.equal(s.log[0][1], "deleteCurrentRepeatTask");
  assert.deepEqual(out.results, [{ id: "r", ok: true, nextOccurrence: { id: "n2", deadline: 9 } }]);
});

test("deleteTasks uses deleteTask", async () => {
  const s = fakeSession();
  const out = await createWriter({ openSession: async () => s }).deleteTasks(["d"]);
  assert.equal(s.log[0][1], "deleteTask");
  assert.deepEqual(out.results, [{ id: "d", ok: true }]);
});

test("a failing task does not stop the others", async () => {
  const s = fakeSession({ replies: { bad: new Error("boom") } });
  const out = await createWriter({ openSession: async () => s }).deleteTasks(["bad", "good"]);
  assert.deepEqual(out.results, [{ id: "bad", ok: false, error: "boom" }, { id: "good", ok: true }]);
  assert.deepEqual(s.log.find(e => e[0] === "sync")[1], ["good"]);
});

test("nothing succeeded: no sync, no reload, session closed", async () => {
  const s = fakeSession({ replies: { bad: new Error("boom") } });
  const out = await createWriter({ openSession: async () => s }).deleteTasks(["bad"]);
  assert.deepEqual(out.pendingSync, []);
  assert.equal(out.uiRefreshed, false);
  assert.deepEqual(s.log.map(e => e[0]), ["call", "close"]);
});

test("passes through pending sync ids and a skipped reload (pomodoro running)", async () => {
  const s = fakeSession({ pending: ["d"], idle: false });
  const out = await createWriter({ openSession: async () => s }).deleteTasks(["d"]);
  assert.deepEqual(out.pendingSync, ["d"]);
  assert.equal(out.uiRefreshed, false);
});

test("session is closed even when sync throws", async () => {
  const s = fakeSession();
  s.syncAndWait = async () => { throw new Error("socket closed"); };
  await assert.rejects(createWriter({ openSession: async () => s }).deleteTasks(["d"]), /socket closed/);
  assert.equal(s.log.at(-1)[0], "close");
});
