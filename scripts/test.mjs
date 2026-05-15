// Quick smoke test — loads data and prints counts + samples
import { loadAllData } from "../reader.mjs";

console.log("Loading data...");
const start = Date.now();
const { projects, tasks, subtasks, pomodoros } = loadAllData();
console.log(`Loaded in ${Date.now() - start}ms`);

console.log(`\nProjects:   ${projects.size}`);
console.log(`Tasks:      ${tasks.size}`);
console.log(`Subtasks:   ${subtasks.size}`);
console.log(`Pomodoros:  ${pomodoros.size}`);

// Active tasks sample
const active = [...tasks.values()].filter(t => !t.isFinished && t.state !== -1);
console.log(`\nActive tasks: ${active.length}`);
console.log("\nFirst 5 active tasks:");
for (const t of active.slice(0, 5)) {
  const proj = projects.get(t.projectId);
  console.log(`  [${proj?.name ?? t.projectId}] ${t.name} (pomos: ${t.actualPomoNum}/${t.estimatePomoNum})`);
}

// Today's pomodoros
const today = new Date().toISOString().slice(0, 10);
const todayPomos = [...pomodoros.values()].filter(p => {
  if (!p.endDate) return false;
  return new Date(p.endDate).toISOString().slice(0, 10) === today;
});
console.log(`\nToday's pomodoros: ${todayPomos.length}`);
if (todayPomos.length > 0) {
  const total = todayPomos.reduce((s, p) => s + (p.interval ?? 0), 0);
  console.log(`Total focus time today: ${Math.round(total/60)} minutes`);
}
