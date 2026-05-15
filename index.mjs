#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadAllData } from "./reader.mjs";

// ── Data cache ────────────────────────────────────────────────────────────────

let cache = null;
let cacheTime = 0;
const CACHE_TTL = 30_000; // 30s

function getData() {
  if (!cache || Date.now() - cacheTime > CACHE_TTL) {
    cache = loadAllData();
    cacheTime = Date.now();
  }
  return cache;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ts(ms) {
  if (!ms || ms === 0) return null;
  return new Date(ms).toLocaleDateString("en-CA"); // YYYY-MM-DD in local timezone
}

function projectName(projects, id) {
  const p = projects.get(id);
  return p ? p.name : id;
}

function taskSummary(t, projects) {
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
  };
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

function handleListProjects({ include_system = false } = {}) {
  const { projects } = getData();
  const SYSTEM_PREFIX = ["PRJ_", "id-"];
  const list = [...projects.values()]
    .filter(p => include_system || !SYSTEM_PREFIX.some(pre => p.name?.startsWith(pre) || p.id?.startsWith(pre)))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map(p => ({
      id: p.id,
      name: p.name,
      state: p.state,
      color: p.color,
      isDefault: p.isDefault,
      type: p.type,
    }));
  return list;
}

function handleListTasks({ project_id, status = "active", limit = 100, include_system_projects = false } = {}) {
  const { projects, tasks } = getData();
  const SYSTEM_PREFIX = ["PRJ_", "id-"];

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

  if (status === "active") list = list.filter(t => !t.isFinished && t.state !== -1);
  else if (status === "completed") list = list.filter(t => t.isFinished);

  list.sort((a, b) => {
    if (a.deadline && b.deadline) return a.deadline - b.deadline;
    if (a.deadline) return -1;
    if (b.deadline) return 1;
    return (b.creationDate ?? 0) - (a.creationDate ?? 0);
  });

  return list.slice(0, limit).map(t => taskSummary(t, projects));
}

function handleSearchTasks({ query, status = "all", limit = 50 } = {}) {
  const { projects, tasks } = getData();
  const q = query?.toLowerCase() ?? "";
  let list = [...tasks.values()].filter(t => t.name?.toLowerCase().includes(q));
  if (status === "active") list = list.filter(t => !t.isFinished && t.state !== -1);
  else if (status === "completed") list = list.filter(t => t.isFinished);
  return list.slice(0, limit).map(t => taskSummary(t, projects));
}

function handleGetTask({ id } = {}) {
  const { projects, tasks, subtasks } = getData();
  const task = tasks.get(id);
  if (!task) return null;
  const subs = [...subtasks.values()]
    .filter(s => s.taskId === id)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map(s => ({ id: s.id, name: s.name, isFinished: s.isFinished, state: s.state }));
  return { ...taskSummary(task, projects), subtasks: subs };
}

function handleGetPomodoroStats({ days = 7 } = {}) {
  const { pomodoros, tasks } = getData();
  const cutoff = Date.now() - days * 86400_000;
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

  const dailyStats = Object.values(byDay)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(d => ({ date: d.date, pomodoros: d.pomodoros, minutes: Math.round(d.seconds / 60), tasks: d.tasks.size }));

  return {
    days,
    total_pomodoros: totalPomos,
    total_minutes: Math.round(totalInterval / 60),
    daily: dailyStats,
  };
}

function handleListSubtasks({ task_id } = {}) {
  const { subtasks } = getData();
  return [...subtasks.values()]
    .filter(s => s.taskId === task_id)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map(s => ({ id: s.id, name: s.name, isFinished: s.isFinished, state: s.state, estimatedPomoNum: s.estimatedPomoNum }));
}

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "focus-todo", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_projects",
      description: "List all Focus To-Do projects",
      inputSchema: {
        type: "object",
        properties: {
          include_system: { type: "boolean", description: "Include built-in system projects (Inbox, Today, etc.)", default: false },
        },
      },
    },
    {
      name: "list_tasks",
      description: "List tasks, optionally filtered by project or status",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Filter by project ID" },
          status: { type: "string", enum: ["active", "completed", "all"], default: "active" },
          limit: { type: "number", default: 100 },
          include_system_projects: { type: "boolean", default: false },
        },
      },
    },
    {
      name: "search_tasks",
      description: "Search tasks by name",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          status: { type: "string", enum: ["active", "completed", "all"], default: "all" },
          limit: { type: "number", default: 50 },
        },
        required: ["query"],
      },
    },
    {
      name: "get_task",
      description: "Get full details of a task including its subtasks",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Task ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "list_subtasks",
      description: "List subtasks for a specific task",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task ID" },
        },
        required: ["task_id"],
      },
    },
    {
      name: "get_pomodoro_stats",
      description: "Get pomodoro session statistics for the last N days",
      inputSchema: {
        type: "object",
        properties: {
          days: { type: "number", description: "Number of days to look back (default 7)", default: 7 },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  let result;

  try {
    switch (name) {
      case "list_projects":    result = handleListProjects(args); break;
      case "list_tasks":       result = handleListTasks(args); break;
      case "search_tasks":     result = handleSearchTasks(args); break;
      case "get_task":         result = handleGetTask(args); break;
      case "list_subtasks":    result = handleListSubtasks(args); break;
      case "get_pomodoro_stats": result = handleGetPomodoroStats(args); break;
      default: throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
