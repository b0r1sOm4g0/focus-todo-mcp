// Formatting helpers shared by read and write tools

export function ts(ms) {
  if (!ms || ms === 0) return null;
  return new Date(ms).toLocaleDateString("en-CA"); // YYYY-MM-DD in local timezone
}

export function projectName(projects, id) {
  const p = projects.get(id);
  return p ? p.name : id;
}

export function taskSummary(t, projects) {
  return {
    id: t.id,
    name: t.name,
    project: projectName(projects, t.projectId),
    projectId: t.projectId,
    isFinished: t.isFinished,
    state: t.state,
    deadline: ts(t.deadline),
    creationDate: ts(t.creationDate),
    finishedDate: ts(t.finishedDate),
    estimatePomos: t.estimatePomoNum,
    actualPomos: t.actualPomoNum,
    hasSubtask: t.hasSubtask,
    priority: t.priority,
    tags: t.tags,
    recurring: (t.rCycle ?? 0) > 0,
    seriesId: t.rId || null,
  };
}
