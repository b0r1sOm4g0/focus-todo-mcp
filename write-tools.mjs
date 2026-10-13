// Write tools: definitions, validation against current data, confirmation and result text
import { isActive, isRecurring, findDuplicateGroups } from "./filters.mjs";
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
    confirmed: {
      type: "boolean",
      description: "Confirms a preview the user approved. Ignored when the client supports confirmation forms.",
    },
  },
  required: ["task_ids"],
};

export const WRITE_TOOL_DEFINITIONS = [
  {
    name: "complete_tasks",
    title: "Complete tasks",
    description: "Mark tasks as completed using the Focus To-Do app's own logic; recurring tasks get their next occurrence. Changes sync to the Focus To-Do cloud. Requires user confirmation.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema,
  },
  {
    name: "skip_occurrences",
    title: "Skip recurring occurrences",
    description: "Skip the current occurrence of recurring tasks: the next occurrence is created and the current one is deleted without counting as completed. Changes sync to the Focus To-Do cloud. Requires user confirmation.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema,
  },
  {
    name: "remove_duplicate_tasks",
    title: "Remove duplicate tasks",
    description: "Delete extra copies reported by find_duplicate_tasks (including their subtasks and pomodoros). The copy kept for each group is never deleted. Changes sync to the Focus To-Do cloud. Requires user confirmation.",
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
  for (const id of ids) {
    const t = tasks.get(id);
    if (!t) rejected.push({ id, reason: "task not found" });
    else if (t.isFinished) skipped.push({ id, reason: "already completed" });
    else if (!isActive(t)) rejected.push({ id, reason: "task is not active (deleted or archived)" });
    else valid.push({ task: t });
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
    else if (removable.has(id)) valid.push(removable.get(id));
    else if (!tasks.has(id)) rejected.push({ id, reason: "task not found" });
    else rejected.push({ id, reason: "task is not a duplicate" });
  }
  return { valid, skipped: [], rejected };
}

function formatResults({ doneLabel, results, pendingSync, uiRefreshed, notes }) {
  const ok = results.filter(r => r.ok);
  const out = [`${doneLabel} ${ok.length}/${results.length}.`];
  const next = ok.filter(r => r.nextOccurrence);
  if (next.length) out.push(`Next occurrences: ${next.map(r => `${r.nextOccurrence.id} (${ts(r.nextOccurrence.deadline) ?? "no deadline"})`).join(", ")}`);
  for (const r of results.filter(r => !r.ok)) out.push(`Failed ${r.id}: ${r.error}`);
  out.push(...notes);
  if (pendingSync.length) out.push(`Saved locally but not yet confirmed by the sync server: ${pendingSync.join(", ")}. They upload on the next sync.`);
  if (ok.length && !uiRefreshed) out.push("The Focus To-Do window was not reloaded (a pomodoro is running or its state is unknown); it shows the changes on its next refresh.");
  return out.join("\n");
}

export function createWriteHandlers({ getData, invalidate, writer, confirm }) {
  const describe = (t, projects) => `${t.name} · ${projectName(projects, t.projectId)} · ${ts(t.deadline) ?? "no deadline"}`;

  async function run({ tool, verb, doneLabel, args, validate, execute }) {
    const ids = normalizeIds(args.task_ids);
    const { projects, tasks } = getData();
    const { valid, skipped, rejected } = validate(ids, tasks);
    const notes = [
      ...skipped.map(s => `Skipped ${s.id}: ${s.reason}`),
      ...rejected.map(r => `Rejected ${r.id}: ${r.reason}`),
    ];
    if (valid.length === 0) return ["Nothing to do.", ...notes].join("\n");

    const lines = valid.map(v => `- ${describe(v.task, projects)}${v.keep ? ` (keeps ${describe(v.keep, projects)})` : ""}`);
    const decision = await confirm({ message: `${verb} ${valid.length} task(s) in Focus To-Do?\n${lines.join("\n")}`, confirmed: args.confirmed });
    if (decision === "preview") {
      return [`Confirmation required; nothing was changed. ${verb} ${valid.length} task(s):`, ...lines, ...notes,
        `To apply, call ${tool} again with the same task_ids and confirmed: true.`].join("\n");
    }
    if (decision === "declined") return ["Cancelled; nothing was changed.", ...notes].join("\n");

    const outcome = await execute(valid.map(v => v.task.id));
    invalidate();
    return formatResults({ doneLabel, ...outcome, notes });
  }

  return {
    complete_tasks: args => run({ tool: "complete_tasks", verb: "Complete", doneLabel: "Completed", args, validate: validateComplete, execute: ids => writer.completeTasks(ids) }),
    skip_occurrences: args => run({ tool: "skip_occurrences", verb: "Skip the current occurrence of", doneLabel: "Skipped", args, validate: validateSkip, execute: ids => writer.skipOccurrences(ids) }),
    remove_duplicate_tasks: args => run({ tool: "remove_duplicate_tasks", verb: "Delete duplicate", doneLabel: "Removed", args, validate: validateRemoveDuplicates, execute: ids => writer.deleteTasks(ids) }),
  };
}
