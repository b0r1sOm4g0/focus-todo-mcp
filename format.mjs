// Formatting helpers shared by read and write tools

export function ts(ms) {
  if (!ms || ms === 0) return null;
  return new Date(ms).toLocaleDateString("en-CA"); // YYYY-MM-DD in local timezone
}

export function projectName(projects, id) {
  const p = projects.get(id);
  return p ? p.name : id;
}

export function resolveTagNames(projects, tagIds) {
  if (!tagIds) return [];
  const ids = tagIds.split(",").map(s => s.trim()).filter(Boolean);
  return ids.map(id => projects.get(id)?.name).filter(Boolean);
}

export function taskSummary(t, projects) {
  const tagNames = resolveTagNames(projects, t.tags);
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
    tagNames: tagNames.length > 0 ? tagNames : undefined,
    remark: t.remark || undefined,
    recurring: (t.rCycle ?? 0) > 0,
    seriesId: t.rId || null,
  };
}
