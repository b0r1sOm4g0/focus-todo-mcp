// Checks run inside the Focus To-Do page against the live record, right before and after an app call.
// Each function must stay self-contained (no imports or outer variables): bridge.mjs injects its source.

// Why the live task must not be written, or null when it is safe
export function liveTaskProblem(task, guard, keep, successor) {
  const day = ms => new Date(ms).toLocaleDateString("en-CA");
  if (!task) return "task no longer exists";
  if (task.state !== 0 || (task.isFinished && !guard.allowFinished)) return "task is no longer active (it changed since it was read)";
  if (guard.recurring && !(task.rCycle > 0)) return "task is no longer recurring";
  if (guard.successorId) {
    const still = successor && !successor.isFinished && successor.state === 0 && successor.rId === task.rId && successor.deadline > task.deadline;
    if (!still) return "the next occurrence changed since it was read; nothing was done";
  }
  if (guard.keepId) {
    if (!keep || keep.isFinished || keep.state !== 0) return "the copy to keep is no longer active";
    if (keep.rId !== task.rId || day(keep.deadline) !== day(task.deadline)) return "task is no longer a duplicate of the copy to keep";
  }
  return null;
}

// Why the app call did not take effect, or null when the record shows the change
export function appliedProblem(method, after) {
  const applied = method === "completeTask" || method === "finishOnly" ? !!after?.isFinished : after?.state === -1;
  return applied ? null : `the app did not apply ${method}`;
}
