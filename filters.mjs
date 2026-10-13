// Task rules mirrored from the Focus To-Do app (fetchTasksOfDeadlineProjectType)

export function startOfLocalDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function localDayKey(ms) {
  return new Date(ms).toLocaleDateString("en-CA"); // YYYY-MM-DD in local timezone
}

export const isActive = t => !t.isFinished && t.state === 0;
export const isRecurring = t => (t.rCycle ?? 0) > 0;

export function isOverdue(t, now = Date.now()) {
  return isActive(t) && t.deadline >= 1 && t.deadline < startOfLocalDay(now);
}

// Best copy first: most pomodoros, has subtasks, has a note, oldest
function compareKeep(a, b) {
  return (b.actualPomoNum ?? 0) - (a.actualPomoNum ?? 0)
    || Number(!!b.hasSubtask) - Number(!!a.hasSubtask)
    || Number(!!b.remark) - Number(!!a.remark)
    || (a.creationDate ?? 0) - (b.creationDate ?? 0);
}

export function findDuplicateGroups(tasks, { includeNonRecurring = false } = {}) {
  const groups = new Map();
  for (const t of tasks) {
    if (!isActive(t)) continue;
    let key = null;
    if (t.rId && t.deadline) key = `r|${t.rId}|${localDayKey(t.deadline)}`;
    else if (includeNonRecurring && !t.rId) key = `n|${t.name}|${t.projectId}|${t.deadline ? localDayKey(t.deadline) : "-"}`;
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  return [...groups.values()]
    .filter(g => g.length > 1)
    .map(g => {
      const [keep, ...remove] = [...g].sort(compareKeep);
      return { keep, remove };
    });
}
