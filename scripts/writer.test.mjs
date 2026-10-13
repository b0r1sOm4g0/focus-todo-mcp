import { test } from "node:test";
import assert from "node:assert/strict";
import { createWriter } from "../writer.mjs";

function fakeSession({ replies = {}, pending = [], idle = true } = {}) {
  const log = [];
  return {
    log,
    async call(method, id, guard) {
      log.push(["call", method, id, guard]);
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

test("a failure after the writes still returns the results, with a warning", async () => {
  const s = fakeSession();
  s.syncAndWait = async () => { throw new Error("socket closed"); };
  const out = await createWriter({ openSession: async () => s }).deleteTasks(["d"]);
  assert.deepEqual(out.results, [{ id: "d", ok: true }]);
  assert.deepEqual(out.pendingSync, ["d"]);
  assert.equal(out.uiRefreshed, false);
  assert.match(out.warning, /applied.*socket closed/);
  assert.equal(s.log.at(-1)[0], "close");
});

test("each method sends the live-state guard the page must check", async () => {
  const s = fakeSession();
  const w = createWriter({ openSession: async () => s });
  await w.completeTasks(["a"]);
  await w.skipOccurrences(["r"]);
  await w.deleteTasks(["d"], { keepOf: { d: "k" } });
  assert.deepEqual(s.log.filter(e => e[0] === "call").map(e => e[3]), [{}, { recurring: true }, { keepId: "k" }]);
});

test("calls are serialized: the second waits until the first session closes", async () => {
  const order = [];
  let release;
  const gate = new Promise(r => { release = r; });
  let n = 0;
  const openSession = async () => {
    const i = ++n;
    order.push(`open${i}`);
    const s = fakeSession();
    if (i === 1) s.call = async () => { await gate; };
    const close = s.close;
    s.close = () => { order.push(`close${i}`); close(); };
    return s;
  };
  const w = createWriter({ openSession });
  const first = w.completeTasks(["a"]);
  const second = w.skipOccurrences(["r"]);
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(order, ["open1"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["open1", "close1", "open2", "close2"]);
});

test("a failed call does not block the next one", async () => {
  let n = 0;
  const w = createWriter({ openSession: async () => { if (++n === 1) throw new Error("no browser"); return fakeSession(); } });
  await assert.rejects(w.completeTasks(["a"]), /no browser/);
  assert.equal((await w.completeTasks(["a"])).results[0].ok, true);
});

test("completeTasks finishes without a new occurrence when the series already has one", async () => {
  const s = fakeSession({ replies: { late: { id: "late", isFinished: true }, plain: { finishedTask: {}, newTask: { id: "n9", deadline: 1 } } } });
  const out = await createWriter({ openSession: async () => s }).completeTasks(["late", "plain"], { successorOf: { late: "next" } });
  const calls = s.log.filter(e => e[0] === "call").map(e => [e[1], e[2], e[3]]);
  assert.deepEqual(calls, [["finishOnly", "late", { successorId: "next" }], ["completeTask", "plain", {}]]);
  assert.deepEqual(out.results, [{ id: "late", ok: true }, { id: "plain", ok: true, nextOccurrence: { id: "n9", deadline: 1 } }]);
});
