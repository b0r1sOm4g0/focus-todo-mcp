// Opt-in end-to-end check against the dedicated Chrome instance.
// Creates throwaway tasks named MCP-E2E-<timestamp>, exercises complete/skip/delete through the
// real writer, verifies IndexedDB, then deletes everything it created. Touches no other task.
import assert from "node:assert/strict";
import { openSession } from "../bridge.mjs";
import { createWriter } from "../writer.mjs";

if (process.env.FOCUS_TODO_E2E !== "1") {
  console.log("Skipped: set FOCUS_TODO_E2E=1 with the dedicated Focus To-Do Chrome open.");
  process.exit(0);
}

const PREFIX = `MCP-E2E-${Date.now()}`;
const endOfToday = new Date();
endOfToday.setHours(23, 59, 59, 999);
const TODAY = endOfToday.getTime();
const YESTERDAY = TODAY - 86400e3;

// All tasks this run created, read straight from the app's IndexedDB
function prefixedTasks(session) {
  return session.evaluate(`(async () => {
    const name = (await indexedDB.databases()).map(d => d.name).find(n => /^PomodoroDB/.test(n));
    const db = await new Promise(r => { const q = indexedDB.open(name); q.onsuccess = () => r(q.result); });
    const all = await new Promise(r => { const q = db.transaction("Task").objectStore("Task").getAll(); q.onsuccess = () => r(q.result); });
    db.close();
    return all.filter(t => t.name.startsWith(${JSON.stringify(PREFIX)}));
  })()`);
}

function addTask(session, fields) {
  return session.evaluate(`window.__focusTodoMcp.taskService.addTask(${JSON.stringify(fields)}).then(t => JSON.parse(JSON.stringify(t)))`);
}

function dailySeries(name, deadline, rId) {
  return { name, deadline, rCycle: 1, rUnit: "days", rValue: "", rId, rFirstDeadline: deadline };
}

let failed = false;
try {
  const setup = await openSession();
  let plain, rec, dupA, dupB;
  try {
    const uuid = () => setup.evaluate("crypto.randomUUID().toUpperCase()");
    plain = await addTask(setup, { name: `${PREFIX} plain`, deadline: YESTERDAY });
    rec = await addTask(setup, dailySeries(`${PREFIX} recurring`, YESTERDAY, await uuid()));
    const series = await uuid();
    dupA = await addTask(setup, dailySeries(`${PREFIX} dup`, TODAY, series));
    dupB = await addTask(setup, dailySeries(`${PREFIX} dup`, TODAY, series));
  } finally {
    setup.close();
  }

  const writer = createWriter({ openSession });
  const completed = await writer.completeTasks([plain.id]);
  assert.equal(completed.results[0].ok, true, JSON.stringify(completed));
  const skipped = await writer.skipOccurrences([rec.id]);
  assert.ok(skipped.results[0].nextOccurrence?.id, JSON.stringify(skipped));
  const removed = await writer.deleteTasks([dupB.id], { keepOf: { [dupB.id]: dupA.id } });
  assert.equal(removed.results[0].ok, true, JSON.stringify(removed));
  // Stale snapshot: the occurrence was already skipped (deleted); the live check must refuse it
  const again = await writer.skipOccurrences([rec.id]);
  assert.equal(again.results[0].ok, false, JSON.stringify(again));
  assert.match(again.results[0].error, /no longer active/);

  const check = await openSession();
  try {
    const byId = new Map((await prefixedTasks(check)).map(t => [t.id, t]));
    assert.equal(byId.get(plain.id).isFinished, true, "plain task completed");
    assert.equal(byId.get(rec.id).state, -1, "skipped occurrence deleted");
    const next = byId.get(skipped.results[0].nextOccurrence.id);
    assert.equal(next.isFinished, false, "next occurrence active");
    assert.equal(next.rId, rec.rId, "next occurrence in the same series");
    assert.equal(byId.get(dupB.id).state, -1, "duplicate removed");
    assert.equal(byId.get(dupA.id).state, 0, "kept copy untouched");
    const activeInSeries = [...byId.values()].filter(t => t.rId === rec.rId && t.state === 0 && !t.isFinished);
    assert.equal(activeInSeries.length, 1, "refused retry created no extra occurrence");
    console.log("PASS: complete, skip and remove-duplicate work end to end");
  } finally {
    check.close();
  }
} catch (err) {
  failed = true;
  console.error("FAIL:", err.message);
} finally {
  const cleanup = await openSession();
  try {
    const leftovers = (await prefixedTasks(cleanup)).filter(t => t.state !== -1);
    for (const t of leftovers) await cleanup.call("deleteTask", t.id, { allowFinished: true });
    await cleanup.syncAndWait(leftovers.map(t => t.id));
  } finally {
    cleanup.close();
  }
}
process.exit(failed ? 1 : 0);
