// Write tools: definitions, validation against current data, confirmation and result text
import { isActive, isRecurring, findDuplicateGroups, findSuccessor } from "./filters.mjs";
import { ts, projectName } from "./format.mjs";

export const MAX_TASK_IDS = 50;

const inputSchema = {
  type: "object",
  properties: {
    task_ids: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: MAX_TASK_IDS,
      description: "Focus To-Do task IDs (from list_tasks, search_tasks or find_duplicate_tasks)",
    },
  },
  required: ["task_ids"],
};

export const WRITE_TOOL_DEFINITIONS = [
  {
    name: "complete_tasks",
    title: "Complete tasks",
    description: "Mark tasks as completed using the Focus To-Do app's own logic. Recurring tasks get their next occurrence, unless the series already has a later active occurrence (then the task is only completed, so no duplicate is created). Changes sync to the Focus To-Do cloud. The user confirms each write in a form; clients without confirmation forms cannot write.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema,
  },
  {
    name: "skip_occurrences",
    title: "Skip recurring occurrences",
    description: "Skip the current occurrence of recurring tasks: the next occurrence is created and the current one is deleted without counting as completed. Changes sync to the Focus To-Do cloud. The user confirms each write in a form; clients without confirmation forms cannot write.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema,
  },
  {
    name: "remove_duplicate_tasks",
    title: "Remove duplicate tasks",
    description: "Delete extra copies reported by find_duplicate_tasks (including their subtasks and pomodoros). The copy kept for each group is never deleted. Changes sync to the Focus To-Do cloud. The user confirms each write in a form; clients without confirmation forms cannot write.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema,
  },
];

function normalizeIds(taskIds) {
  if (!Array.isArray(taskIds) || taskIds.length === 0) throw new Error("task_ids must be a non-empty array");
  const ids = [...new Set(taskIds.map(String))];
  if (ids.length > MAX_TASK_IDS) throw new Error(`At most ${MAX_TASK_IDS} task IDs per call (got ${ids.length})`);
  return ids;
}

function validateComplete(ids, tasks) {
  const valid = [], skipped = [], rejected = [];
  const all = [...tasks.values()];
  for (const id of ids) {
    const t = tasks.get(id);
    if (!t) rejected.push({ id, reason: "task not found" });
    else if (t.isFinished) skipped.push({ id, reason: "already completed" });
    else if (!isActive(t)) rejected.push({ id, reason: "task is not active (deleted or archived)" });
    else {
      const successor = findSuccessor(t, all);
      valid.push(successor ? { task: t, successor, warn: `next occurrence already exists: ${ts(successor.deadline)}` } : { task: t });
    }
  }
  return { valid, skipped, rejected };
}

function validateSkip(ids, tasks) {
  const valid = [], rejected = [];
  for (const id of ids) {
    const t = tasks.get(id);
    if (!t) rejected.push({ id, reason: "task not found" });
    else if (!isActive(t)) rejected.push({ id, reason: "task is not active (completed, deleted or archived)" });
    else if (!isRecurring(t)) rejected.push({ id, reason: "task is not recurring" });
    else valid.push({ task: t });
  }
  return { valid, skipped: [], rejected };
}

function validateRemoveDuplicates(ids, tasks) {
  const removable = new Map(), kept = new Set();
  for (const g of findDuplicateGroups([...tasks.values()], { includeNonRecurring: true })) {
    kept.add(g.keep.id);
    for (const t of g.remove) removable.set(t.id, { task: t, keep: g.keep });
  }
  const valid = [], rejected = [];
  for (const id of ids) {
    if (kept.has(id)) rejected.push({ id, reason: "this is the copy kept for its duplicate group" });
    else if (removable.has(id)) {
      const entry = removable.get(id), t = entry.task;
      const losses = [t.actualPomoNum > 0 && `its ${t.actualPomoNum} pomodoro(s)`, t.hasSubtask && "subtasks"].filter(Boolean);
      valid.push(losses.length ? { ...entry, warn: `deletes ${losses.join(" and ")}` } : entry);
    }
    else if (!tasks.has(id)) rejected.push({ id, reason: "task not found" });
    else rejected.push({ id, reason: "task is not a duplicate" });
  }
  return { valid, skipped: [], rejected };
}

function formatResults({ doneLabel, results, pendingSync, uiRefreshed, warning, notes }) {
  const ok = results.filter(r => r.ok);
  const out = [`${doneLabel} ${ok.length}/${results.length}.`];
  const next = ok.filter(r => r.nextOccurrence);
  if (next.length) out.push(`Next occurrences: ${next.map(r => `${r.nextOccurrence.id} (${ts(r.nextOccurrence.deadline) ?? "no deadline"})`).join(", ")}`);
  for (const r of results.filter(r => !r.ok)) out.push(`Failed ${r.id}: ${r.error}`);
  out.push(...notes);
  if (warning) out.push(warning);
  if (pendingSync.length) out.push(`Saved locally but not yet confirmed by the sync server: ${pendingSync.join(", ")}. They upload on the next sync.`);
  if (ok.length && !uiRefreshed) out.push("The Focus To-Do window was not reloaded (a pomodoro is running or its state is unknown); it shows the changes on its next refresh.");
  return out.join("\n");
}

export function createWriteHandlers({ getData, invalidate, writer, confirm }) {
  const describe = (t, projects) => `${t.name} · ${projectName(projects, t.projectId)} · ${ts(t.deadline) ?? "no deadline"}`;

  async function run({ verb, doneLabel, args, validate, execute }) {
    const ids = normalizeIds(args.task_ids);
    const { projects, tasks } = getData();
    const { valid, skipped, rejected } = validate(ids, tasks);
    const notes = [
      ...skipped.map(s => `Skipped ${s.id}: ${s.reason}`),
      ...rejected.map(r => `Rejected ${r.id}: ${r.reason}`),
    ];
    if (valid.length === 0) return ["Nothing to do.", ...notes].join("\n");

    const lines = valid.map(v => `- ${describe(v.task, projects)}${v.warn ? ` [${v.warn}]` : ""}${v.keep ? ` (keeps ${describe(v.keep, projects)})` : ""}`);
    const validIds = valid.map(v => v.task.id);
    const decision = await confirm({ message: `${verb} ${valid.length} task(s) in Focus To-Do?\n${lines.join("\n")}` });
    if (decision === "declined") return ["Cancelled; nothing was changed.", ...notes].join("\n");
    // Only the user can approve a write; a client without forms would leave approval to the model
    if (decision === "unavailable") {
      return [`Writes need a client with confirmation forms (MCP elicitation, e.g. Claude Code); nothing was changed. Would ${verb.toLowerCase()} ${valid.length} task(s):`, ...lines, ...notes].join("\n");
    }

    try {
      return formatResults({ doneLabel, ...(await execute(validIds, valid)), notes });
    } finally {
      invalidate(); // even on failure: some writes may have been applied
    }
  }

  return {
    complete_tasks: args => run({ verb: "Complete", doneLabel: "Completed", args, validate: validateComplete, execute: (ids, valid) => writer.completeTasks(ids, { successorOf: Object.fromEntries(valid.filter(v => v.successor).map(v => [v.task.id, v.successor.id])) }) }),
    skip_occurrences: args => run({ verb: "Skip the current occurrence of", doneLabel: "Skipped", args, validate: validateSkip, execute: ids => writer.skipOccurrences(ids) }),
    remove_duplicate_tasks: args => run({ verb: "Delete duplicate", doneLabel: "Removed", args, validate: validateRemoveDuplicates, execute: (ids, valid) => writer.deleteTasks(ids, { keepOf: Object.fromEntries(valid.map(v => [v.task.id, v.keep.id])) }) }),
  };
}
