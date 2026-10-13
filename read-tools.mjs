// Read-only tools: definitions and handlers
import { isActive, isOverdue, findDuplicateGroups } from "./filters.mjs";
import { ts, taskSummary } from "./format.mjs";

const SYSTEM_PREFIX = ["PRJ_", "id-"];
const STATUS = ["active", "overdue", "completed", "all"];
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const READ_TOOL_DEFINITIONS = [
  {
    name: "list_projects",
    title: "List projects",
    description: "List all Focus To-Do projects",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        include_system: { type: "boolean", description: "Include built-in system projects (Inbox, Today, etc.)", default: false },
      },
    },
  },
  {
    name: "list_tasks",
    title: "List tasks",
    description: "List tasks, optionally filtered by project or status. 'active' and 'overdue' follow the Focus To-Do app rules.",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Filter by project ID" },
        status: { type: "string", enum: STATUS, default: "active" },
        limit: { type: "number", default: 100 },
        include_system_projects: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "search_tasks",
    title: "Search tasks",
    description: "Search tasks by name",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        status: { type: "string", enum: STATUS, default: "all" },
        limit: { type: "number", default: 50 },
      },
      required: ["query"],
    },
  },
  {
    name: "get_task",
    title: "Get task",
    description: "Get full details of a task including its subtasks",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Task ID" } },
      required: ["id"],
    },
  },
  {
    name: "list_subtasks",
    title: "List subtasks",
    description: "List subtasks for a specific task",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string", description: "Task ID" } },
      required: ["task_id"],
    },
  },
  {
    name: "get_pomodoro_stats",
    title: "Pomodoro statistics",
    description: "Get pomodoro session statistics for the last N days",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: { days: { type: "number", description: "Number of days to look back (default 7)", default: 7 } },
    },
  },
  {
    name: "find_duplicate_tasks",
    title: "Find duplicate tasks",
    description: "Find active tasks that are duplicate occurrences of the same recurring series on the same day (optionally also non-recurring tasks with the same name, project and day). Each group lists the copy to keep and the extra copies.",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        include_non_recurring: { type: "boolean", description: "Also group non-recurring tasks by name, project and deadline day", default: false },
      },
    },
  },
];

export function createReadHandlers({ getData, now = Date.now }) {
  function filterByStatus(list, status) {
    if (status === "active") return list.filter(isActive);
    if (status === "overdue") return list.filter(t => isOverdue(t, now()));
    if (status === "completed") return list.filter(t => t.isFinished);
    return list;
  }

  function list_projects({ include_system = false } = {}) {
    const { projects } = getData();
    return [...projects.values()]
      .filter(p => include_system || !SYSTEM_PREFIX.some(pre => p.name?.startsWith(pre) || p.id?.startsWith(pre)))
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map(p => ({ id: p.id, name: p.name, state: p.state, color: p.color, isDefault: p.isDefault, type: p.type }));
  }

  function list_tasks({ project_id, status = "active", limit = 100, include_system_projects = false } = {}) {
    const { projects, tasks } = getData();
    let list = [...tasks.values()];
    if (project_id) {
      list = list.filter(t => t.projectId === project_id);
    } else if (!include_system_projects) {
      list = list.filter(t => {
        const p = projects.get(t.projectId);
        if (!p) return true;
        return !SYSTEM_PREFIX.some(pre => p.name?.startsWith(pre) || p.id?.startsWith(pre));
      });
    }
    list = filterByStatus(list, status);
    list.sort((a, b) => {
      if (a.deadline && b.deadline) return a.deadline - b.deadline;
      if (a.deadline) return -1;
      if (b.deadline) return 1;
      return (b.creationDate ?? 0) - (a.creationDate ?? 0);
    });
    return list.slice(0, limit).map(t => taskSummary(t, projects));
  }

  function search_tasks({ query, status = "all", limit = 50 } = {}) {
    const { projects, tasks } = getData();
    const q = query?.toLowerCase() ?? "";
    const list = filterByStatus([...tasks.values()].filter(t => t.name?.toLowerCase().includes(q)), status);
    return list.slice(0, limit).map(t => taskSummary(t, projects));
  }

  function get_task({ id } = {}) {
    const { projects, tasks, subtasks } = getData();
    const task = tasks.get(id);
    if (!task) return null;
    const subs = [...subtasks.values()]
      .filter(s => s.taskId === id)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map(s => ({ id: s.id, name: s.name, isFinished: s.isFinished, state: s.state }));
    return { ...taskSummary(task, projects), subtasks: subs };
  }

  function list_subtasks({ task_id } = {}) {
    const { subtasks } = getData();
    return [...subtasks.values()]
      .filter(s => s.taskId === task_id)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map(s => ({ id: s.id, name: s.name, isFinished: s.isFinished, state: s.state, estimatedPomoNum: s.estimatedPomoNum }));
  }

  function get_pomodoro_stats({ days = 7 } = {}) {
    const { pomodoros } = getData();
    const cutoff = now() - days * 86400_000;
    const byDay = {};
    let totalInterval = 0, totalPomos = 0;
    for (const p of pomodoros.values()) {
      if (!p.endDate || p.endDate < cutoff) continue;
      if ((p.state ?? 0) !== 0) continue; // skip cancelled/interrupted sessions
      const day = ts(p.endDate);
      if (!byDay[day]) byDay[day] = { date: day, pomodoros: 0, seconds: 0, tasks: new Set() };
      byDay[day].pomodoros++;
      byDay[day].seconds += p.interval ?? 0;
      if (p.taskId) byDay[day].tasks.add(p.taskId);
      totalPomos++;
      totalInterval += p.interval ?? 0; // only state=0 sessions counted
    }
    const daily = Object.values(byDay)
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(d => ({ date: d.date, pomodoros: d.pomodoros, minutes: Math.round(d.seconds / 60), tasks: d.tasks.size }));
    return { days, total_pomodoros: totalPomos, total_minutes: Math.round(totalInterval / 60), daily };
  }

  function find_duplicate_tasks({ include_non_recurring = false } = {}) {
    const { projects, tasks } = getData();
    const groups = findDuplicateGroups([...tasks.values()], { includeNonRecurring: include_non_recurring });
    return {
      extra_tasks: groups.reduce((n, g) => n + g.remove.length, 0),
      groups: groups.map(g => ({ keep: taskSummary(g.keep, projects), remove: g.remove.map(t => taskSummary(t, projects)) })),
    };
  }

  return { list_projects, list_tasks, search_tasks, get_task, list_subtasks, get_pomodoro_stats, find_duplicate_tasks };
}
