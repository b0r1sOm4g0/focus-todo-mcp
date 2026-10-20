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

const createTaskSchema = {
  type: "object",
  properties: {
    name: { type: "string", description: "Task name (required)" },
    project_id: { type: "string", description: "Project ID to add the task to (from list_projects). Omit for the default Inbox." },
    priority: { type: "number", enum: [0, 1, 2, 3], description: "0 = none (default), 1 = low, 2 = medium, 3 = high" },
    deadline: { type: "string", description: "Deadline date as YYYY-MM-DD. Sets the task's due date to end-of-day local time." },
    notes: { type: "string", description: "Task notes or description (remark field)" },
    estimated_pomos: { type: "number", description: "Estimated number of pomodoros" },
    recurrence: {
      type: "object",
      description: "Make the task recurring. Omit for a one-off task.",
      properties: {
        unit: { type: "string", enum: ["days", "weeks", "months"], description: "Recurrence unit" },
        cycle: { type: "number", description: "Every N units. Default 1. Example: cycle=2 + unit=weeks = biweekly." },
        days: {
          type: "array", items: { type: "number", minimum: 0, maximum: 6 },
          description: "For unit=weeks: which days of the week (0=Sun, 1=Mon, ..., 6=Sat). Example: [1,2,3,4,5] = weekdays. Omit for the deadline's weekday only.",
        },
      },
      required: ["unit"],
    },
  },
  required: ["name"],
};

export const WRITE_TOOL_DEFINITIONS = [
  {
    name: "create_task",
    title: "Create a task",
    description: "Create a new task in Focus To-Do, optionally with a deadline, priority, project and recurrence. Changes sync to the Focus To-Do cloud. The user confirms each write in a form; clients without confirmation forms cannot write.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: createTaskSchema,
  },
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

function endOfDay(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

function buildTaskFields(args) {
  const fields = { name: args.name };
  if (args.project_id) fields.projectId = args.project_id;
  if (args.priority != null) fields.priority = args.priority;
  if (args.notes) fields.remark = args.notes;
  if (args.estimated_pomos) fields.estimatePomoNum = args.estimated_pomos;
  if (args.deadline) fields.deadline = endOfDay(args.deadline);
  if (args.recurrence) {
    const r = args.recurrence;
    fields.rCycle = r.cycle ?? 1;
    fields.rUnit = r.unit;
    fields.rValue = r.unit === "weeks" && r.days ? r.days.join(",") : "";
    fields.rFirstDeadline = fields.deadline || endOfDay(new Date().toLocaleDateString("en-CA"));
    if (!fields.deadline) fields.deadline = fields.rFirstDeadline;
  }
  return fields;
}

function describeCreate(args, projects) {
  const parts = [args.name];
  if (args.project_id) parts.push(`in ${projectName(projects, args.project_id)}`);
  if (args.priority) parts.push(`priority ${["none", "low", "medium", "high"][args.priority]}`);
  if (args.deadline) parts.push(`deadline ${args.deadline}`);
  if (args.recurrence) {
    const r = args.recurrence;
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const cycle = r.cycle && r.cycle > 1 ? `every ${r.cycle} ${r.unit}` : `every ${r.unit.replace(/s$/, "")}`;
    const days = r.unit === "weeks" && r.days ? ` on ${r.days.map(d => dayNames[d]).join("/")}` : "";
    parts.push(`recurring ${cycle}${days}`);
  }
  return parts.join(" · ");
}

export function createWriteHandlers({ getData, invalidate, writer, confirm }) {
  const describe = (t, projects) => `${t.name} · ${projectName(projects, t.projectId)} · ${ts(t.deadline) ?? "no deadline"}`;

  async function runCreate(args) {
    if (!args.name || !args.name.trim()) throw new Error("name is required");
    const { projects } = getData();
    if (args.project_id && !projects.has(args.project_id)) throw new Error(`Project not found: ${args.project_id}`);

    const summary = describeCreate(args, projects);
    const decision = await confirm({ message: `Create task in Focus To-Do?\n- ${summary}` });
    if (decision === "declined") return "Cancelled; nothing was created.";
    if (decision === "unavailable") return `Writes need a client with confirmation forms (MCP elicitation, e.g. Claude Code); nothing was created. Would create:\n- ${summary}`;

    const fields = buildTaskFields(args);
    try {
      return await writer.createTask(fields);
    } finally {
      invalidate();
    }
  }

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
    create_task: args => runCreate(args),
    complete_tasks: args => run({ verb: "Complete", doneLabel: "Completed", args, validate: validateComplete, execute: (ids, valid) => writer.completeTasks(ids, { successorOf: Object.fromEntries(valid.filter(v => v.successor).map(v => [v.task.id, v.successor.id])) }) }),
    skip_occurrences: args => run({ verb: "Skip the current occurrence of", doneLabel: "Skipped", args, validate: validateSkip, execute: ids => writer.skipOccurrences(ids) }),
    remove_duplicate_tasks: args => run({ verb: "Delete duplicate", doneLabel: "Removed", args, validate: validateRemoveDuplicates, execute: (ids, valid) => writer.deleteTasks(ids, { keepOf: Object.fromEntries(valid.map(v => [v.task.id, v.keep.id])) }) }),
  };
}
