# Write Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Claude complete tasks, skip recurring occurrences and remove duplicate tasks in Focus To-Do, by driving the extension's own services through Chrome DevTools Protocol in a dedicated Chrome instance.

**Architecture:** Reads stay on the LevelDB reader (now preferring the dedicated instance's database). Writes go `write-tools.mjs` (validation + confirmation) → `writer.mjs` (per-task loop) → `bridge.mjs` (locates the app's `TaskService`/`Synchronizer` singletons through closure scopes and calls them) → `cdp.mjs`/`browser.mjs` (CDP over the native `WebSocket`, launching Chrome when needed). `index.mjs` only wires the MCP server.

**Tech Stack:** Node.js ≥ 22 (ES modules, native `WebSocket`/`fetch`, `node:test`), `@modelcontextprotocol/sdk` 1.29 (low-level `Server`), Chrome DevTools Protocol 1.3.

**Spec:** `docs/superpowers/specs/2026-10-13-write-tools-design.md`

## Global Constraints

- Node engines: `">=22"` (native `WebSocket`); no new npm dependencies.
- Extension ID: `ngceodoilcgpmkijopinlkmohnfifjfb`; extension page: `chrome-extension://ngceodoilcgpmkijopinlkmohnfifjfb/WebContent/index.html`.
- Env vars: `FOCUS_TODO_USER_DATA_DIR` (default `~/.config/focustodo-chrome`), `FOCUS_TODO_CDP_PORT` (default `9222`), `FOCUS_TODO_CHROME_PATH` (default: first existing candidate), `FOCUS_TODO_IDB_PATH` (still highest priority for reads).
- App rules: active = `!isFinished && state === 0`; overdue = active and `1 <= deadline < start of local today`; recurring = `rCycle > 0`.
- Writes only through the app's services (`completeTask`, `deleteCurrentRepeatTask`, `deleteTask`); never write task records to IndexedDB directly.
- Every tool has a top-level `title` and `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` as in the spec table).
- Write tools accept 1–50 task IDs and always require confirmation (elicitation form, or preview + `confirmed: true` when the client lacks elicitation).
- Never reload the Focus To-Do page unless the timer state is exactly `"initial"`.
- Tool descriptions describe behavior only; they never instruct the model.
- Unit tests live in `scripts/*.test.mjs` and run with `npm run test:unit`; `npm test` (smoke on real data) keeps working.

## Review Focus

1. **Pomodoro running during a write** → the page must not reload; the result says the window refreshes later. Pinned in Task 8 (`refreshIfIdle` result surfaces as `uiRefreshed: false`) and Task 6 (message text).
2. **Same ID repeated in `task_ids`** → executed once, not twice (a second `completeTask` on a recurring task would complete the *new* occurrence logic twice). Pinned in Task 6.
3. **Deadline exactly at local midnight today** → not overdue; 23:59:59.999 yesterday → overdue. Pinned in Task 3.
4. **Passing the "keep" copy to `remove_duplicate_tasks`** → rejected with a reason; the other copies still removed. Pinned in Task 6.
5. **Chrome missing / port never opens** → clear error naming what was tried and the env var to set, no hang. Pinned in Task 7.

---

## File Structure

| File | Responsibility |
|---|---|
| `config.mjs` (new) | Extension ID, env-driven config, dedicated IndexedDB path |
| `reader.mjs` (modify) | LevelDB reader; `findIDBPath()` prefers the dedicated instance |
| `filters.mjs` (new) | Pure app rules: active, overdue, recurring, duplicate groups |
| `format.mjs` (new) | `ts`, `projectName`, `taskSummary` shared by read and write tools |
| `read-tools.mjs` (new) | Read tool definitions + handlers (moved out of `index.mjs`) |
| `confirm.mjs` (new) | Elicitation-or-preview confirmation |
| `write-tools.mjs` (new) | Write tool definitions, validation, confirmation flow, result text |
| `cdp.mjs` (new) | Minimal CDP client over `WebSocket` |
| `browser.mjs` (new) | Find/launch the dedicated Chrome, find the extension target |
| `bridge.mjs` (new) | Page-side service location and calls; `openSession()` |
| `writer.mjs` (new) | `completeTasks` / `skipOccurrences` / `deleteTasks` over a session |
| `index.mjs` (modify) | MCP server wiring only |
| `scripts/setup-launcher.mjs` (new) | Writes the `.desktop` launcher (Linux) |
| `scripts/e2e.mjs` (new) | Opt-in end-to-end check against the dedicated instance |
| `scripts/*.test.mjs` (new) | Unit tests |

---

### Task 1: Commit the WAL fix already in the working tree

**Files:**
- Already modified: `reader.mjs` (WAL block-trailer skip), `package.json` (`test:unit` script)
- Already created: `scripts/reader.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces: `npm run test:unit` script (`node --test scripts/*.test.mjs`) used by every later task

- [ ] **Step 1: Run the unit tests**

Run: `npm run test:unit`
Expected: `ℹ pass 1`, `ℹ fail 0`

- [ ] **Step 2: Run the smoke test**

Run: `npm test`
Expected: prints `Tasks:` with a count > 0 and no stack trace

- [ ] **Step 3: Commit**

```bash
git add reader.mjs package.json scripts/reader.test.mjs
git commit -m "fix: handle short WAL block trailers in reader

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Config module and dedicated-instance read path

**Files:**
- Create: `config.mjs`
- Modify: `reader.mjs:1-21` (imports, extension ID constant, start of `findIDBPath`)
- Test: `scripts/reader.test.mjs` (append)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `EXTENSION_ID: string`
  - `getConfig(env = process.env): { userDataDir: string, cdpPort: number, chromePath: string | null }`
  - `dedicatedIDBPath(config = getConfig()): string`

- [ ] **Step 1: Write the failing test** — append to `scripts/reader.test.mjs`

```js
import { mkdirSync } from "fs";
import { findIDBPath } from "../reader.mjs";

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

test("findIDBPath prefers the dedicated Chrome instance", () => {
  const dir = mkdtempSync(join(tmpdir(), "focus-todo-udd-"));
  try {
    const idb = join(dir, "Default", "IndexedDB", "chrome-extension_ngceodoilcgpmkijopinlkmohnfifjfb_0.indexeddb.leveldb");
    mkdirSync(idb, { recursive: true });
    const found = withEnv({ FOCUS_TODO_IDB_PATH: undefined, FOCUS_TODO_USER_DATA_DIR: dir }, () => findIDBPath());
    assert.equal(found, idb);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FOCUS_TODO_IDB_PATH still wins over the dedicated instance", () => {
  const dir = mkdtempSync(join(tmpdir(), "focus-todo-udd-"));
  try {
    mkdirSync(join(dir, "Default", "IndexedDB", "chrome-extension_ngceodoilcgpmkijopinlkmohnfifjfb_0.indexeddb.leveldb"), { recursive: true });
    const explicit = join(dir, "explicit");
    mkdirSync(explicit);
    const found = withEnv({ FOCUS_TODO_IDB_PATH: explicit, FOCUS_TODO_USER_DATA_DIR: dir }, () => findIDBPath());
    assert.equal(found, explicit);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

The two `import` lines at the top of this block are shown for clarity only: instead of adding them, change the existing imports at the top of the file to
`import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";` and
`import { loadAllData, findIDBPath } from "../reader.mjs";`, then append the rest of the block (from `function withEnv` on) at the end of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit`
Expected: FAIL in "findIDBPath prefers the dedicated Chrome instance" — `actual` is a path under `~/.config/google-chrome/...`, not the temp dir.

- [ ] **Step 3: Create `config.mjs`**

```js
// Shared configuration for the reader and the CDP writer
import { homedir } from "os";
import { join } from "path";

export const EXTENSION_ID = "ngceodoilcgpmkijopinlkmohnfifjfb";
export const IDB_DIR_NAME = `chrome-extension_${EXTENSION_ID}_0.indexeddb.leveldb`;

export function getConfig(env = process.env) {
  return {
    userDataDir: env.FOCUS_TODO_USER_DATA_DIR || join(homedir(), ".config", "focustodo-chrome"),
    cdpPort: Number(env.FOCUS_TODO_CDP_PORT || 9222),
    chromePath: env.FOCUS_TODO_CHROME_PATH || null,
  };
}

// IndexedDB of the dedicated Chrome instance that the writer controls
export function dedicatedIDBPath(config = getConfig()) {
  return join(config.userDataDir, "Default", "IndexedDB", IDB_DIR_NAME);
}
```

- [ ] **Step 4: Use it in `reader.mjs`**

Replace

```js
const FOCUS_TODO_EXTENSION_ID = "ngceodoilcgpmkijopinlkmohnfifjfb";
```

with

```js
import { EXTENSION_ID as FOCUS_TODO_EXTENSION_ID, dedicatedIDBPath } from "./config.mjs";
```

(move that import up next to the other imports at the top of the file), and in `findIDBPath()` insert right after the `FOCUS_TODO_IDB_PATH` block (before `const home = homedir();`):

```js
  // 1. Dedicated Chrome instance used by the writer (see README)
  const dedicated = dedicatedIDBPath();
  if (existsSync(dedicated)) return dedicated;
```

Renumber the following comments (`// 2. Check Windows UWP App`, `// 3. Check Chrome Extension ...`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:unit`
Expected: `ℹ pass 3`, `ℹ fail 0`

- [ ] **Step 6: Commit**

```bash
git add config.mjs reader.mjs scripts/reader.test.mjs
git commit -m "feat: read from the dedicated Chrome instance when present

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: App rules in `filters.mjs`

**Files:**
- Create: `filters.mjs`
- Test: `scripts/filters.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `startOfLocalDay(now: number): number`
  - `localDayKey(ms: number): string` (`YYYY-MM-DD`, local)
  - `isActive(t): boolean`, `isRecurring(t): boolean`, `isOverdue(t, now = Date.now()): boolean`
  - `findDuplicateGroups(tasks: Task[], { includeNonRecurring = false } = {}): Array<{ keep: Task, remove: Task[] }>`

- [ ] **Step 1: Write the failing tests** — `scripts/filters.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { isActive, isOverdue, isRecurring, findDuplicateGroups } from "../filters.mjs";

const NOW = new Date(2026, 9, 13, 10, 0, 0).getTime(); // 13 Oct 2026 10:00 local
const MIDNIGHT = new Date(2026, 9, 13, 0, 0, 0).getTime();

let seq = 0;
function task(overrides = {}) {
  seq++;
  return {
    id: `T${seq}`, name: `Task ${seq}`, projectId: "P1", state: 0, isFinished: false,
    deadline: 0, rCycle: 0, rId: "", actualPomoNum: 0, hasSubtask: false, remark: "",
    creationDate: 1000 + seq, ...overrides,
  };
}

test("active means not finished and state 0", () => {
  assert.equal(isActive(task()), true);
  assert.equal(isActive(task({ isFinished: true })), false);
  assert.equal(isActive(task({ state: 1 })), false);
  assert.equal(isActive(task({ state: -1 })), false);
});

test("overdue boundary is local midnight today", () => {
  assert.equal(isOverdue(task({ deadline: MIDNIGHT - 1 }), NOW), true);
  assert.equal(isOverdue(task({ deadline: MIDNIGHT }), NOW), false);
});

test("tasks without deadline, finished or archived are never overdue", () => {
  assert.equal(isOverdue(task({ deadline: 0 }), NOW), false);
  assert.equal(isOverdue(task({ deadline: MIDNIGHT - 1, isFinished: true }), NOW), false);
  assert.equal(isOverdue(task({ deadline: MIDNIGHT - 1, state: 1 }), NOW), false);
});

test("recurring means rCycle > 0", () => {
  assert.equal(isRecurring(task({ rCycle: 1 })), true);
  assert.equal(isRecurring(task({ rCycle: 0 })), false);
});

test("groups active occurrences of the same series on the same day", () => {
  const a = task({ rId: "S1", rCycle: 1, deadline: MIDNIGHT + 3600e3 });
  const b = task({ rId: "S1", rCycle: 1, deadline: MIDNIGHT + 7200e3 });
  const otherDay = task({ rId: "S1", rCycle: 1, deadline: MIDNIGHT + 86400e3 });
  const finished = task({ rId: "S1", rCycle: 1, deadline: MIDNIGHT + 3600e3, isFinished: true });
  const groups = findDuplicateGroups([a, b, otherDay, finished]);
  assert.equal(groups.length, 1);
  assert.deepEqual([groups[0].keep.id, ...groups[0].remove.map(t => t.id)].sort(), [a.id, b.id].sort());
});

test("keeps the copy with pomodoros, then subtasks, then remark, then the oldest", () => {
  const base = { rId: "S2", rCycle: 1, deadline: MIDNIGHT + 1 };
  const old = task({ ...base, creationDate: 1 });
  const withRemark = task({ ...base, remark: "note", creationDate: 5 });
  const withSub = task({ ...base, hasSubtask: true, creationDate: 6 });
  const withPomos = task({ ...base, actualPomoNum: 2, creationDate: 7 });
  assert.equal(findDuplicateGroups([old, withRemark, withSub, withPomos])[0].keep.id, withPomos.id);
  assert.equal(findDuplicateGroups([old, withRemark, withSub])[0].keep.id, withSub.id);
  assert.equal(findDuplicateGroups([old, withRemark])[0].keep.id, withRemark.id);
  assert.equal(findDuplicateGroups([withRemark, old].map(t => ({ ...t, remark: "" })))[0].keep.id, old.id);
});

test("non-recurring duplicates only when requested", () => {
  const x = task({ name: "Same", deadline: MIDNIGHT + 1 });
  const y = task({ name: "Same", deadline: MIDNIGHT + 2 });
  assert.equal(findDuplicateGroups([x, y]).length, 0);
  assert.equal(findDuplicateGroups([x, y], { includeNonRecurring: true }).length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit`
Expected: FAIL — `Cannot find module '.../filters.mjs'`

- [ ] **Step 3: Create `filters.mjs`**

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit`
Expected: all pass, `ℹ fail 0`

- [ ] **Step 5: Commit**

```bash
git add filters.mjs scripts/filters.test.mjs
git commit -m "feat: add app task rules (active, overdue, duplicates)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Read tools module, annotations and `find_duplicate_tasks`

**Files:**
- Create: `format.mjs`, `read-tools.mjs`
- Modify: `index.mjs` (whole file — becomes wiring only)
- Test: `scripts/read-tools.test.mjs`

**Interfaces:**
- Consumes: `isActive`, `isOverdue`, `findDuplicateGroups` from `filters.mjs`
- Produces:
  - `format.mjs`: `ts(ms): string | null`, `projectName(projects: Map, id): string`, `taskSummary(t, projects): object` (adds `recurring`, `seriesId`)
  - `read-tools.mjs`: `READ_TOOL_DEFINITIONS: object[]`, `createReadHandlers({ getData, now = Date.now }): Record<string, (args) => any>`

- [ ] **Step 1: Write the failing tests** — `scripts/read-tools.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { READ_TOOL_DEFINITIONS, createReadHandlers } from "../read-tools.mjs";

const NOW = new Date(2026, 9, 13, 10, 0, 0).getTime();
const YESTERDAY = new Date(2026, 9, 12, 23, 59, 59).getTime();
const TODAY = new Date(2026, 9, 13, 23, 59, 59).getTime();

function data(tasks) {
  return {
    projects: new Map([["P1", { id: "P1", name: "Project 1", order: 0 }]]),
    tasks: new Map(tasks.map(t => [t.id, { projectId: "P1", state: 0, isFinished: false, rCycle: 0, rId: "", deadline: 0, creationDate: 1, ...t }])),
    subtasks: new Map(),
    pomodoros: new Map(),
  };
}

test("every read tool is annotated read-only and titled", () => {
  for (const def of READ_TOOL_DEFINITIONS) {
    assert.equal(def.annotations?.readOnlyHint, true, def.name);
    assert.ok(def.title, def.name);
  }
  assert.ok(READ_TOOL_DEFINITIONS.some(d => d.name === "find_duplicate_tasks"));
});

test("list_tasks status overdue follows the app rule", () => {
  const h = createReadHandlers({
    getData: () => data([
      { id: "late", deadline: YESTERDAY },
      { id: "today", deadline: TODAY },
      { id: "archived", deadline: YESTERDAY, state: 1 },
    ]),
    now: () => NOW,
  });
  assert.deepEqual(h.list_tasks({ status: "overdue" }).map(t => t.id), ["late"]);
});

test("list_tasks active excludes state 1 tasks", () => {
  const h = createReadHandlers({ getData: () => data([{ id: "a" }, { id: "s1", state: 1 }]), now: () => NOW });
  assert.deepEqual(h.list_tasks({ status: "active" }).map(t => t.id), ["a"]);
});

test("task summaries expose recurrence", () => {
  const h = createReadHandlers({ getData: () => data([{ id: "r", rCycle: 1, rId: "S1" }]), now: () => NOW });
  const [t] = h.list_tasks({});
  assert.equal(t.recurring, true);
  assert.equal(t.seriesId, "S1");
});

test("find_duplicate_tasks returns keep/remove groups and the extra count", () => {
  const h = createReadHandlers({
    getData: () => data([
      { id: "a", rCycle: 1, rId: "S1", deadline: TODAY, creationDate: 1 },
      { id: "b", rCycle: 1, rId: "S1", deadline: TODAY, creationDate: 2 },
    ]),
    now: () => NOW,
  });
  const r = h.find_duplicate_tasks({});
  assert.equal(r.extra_tasks, 1);
  assert.equal(r.groups[0].keep.id, "a");
  assert.deepEqual(r.groups[0].remove.map(t => t.id), ["b"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit`
Expected: FAIL — `Cannot find module '.../read-tools.mjs'`

- [ ] **Step 3: Create `format.mjs`** (moved from `index.mjs`, plus two fields)

```js
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
```

- [ ] **Step 4: Create `read-tools.mjs`** (handlers moved from `index.mjs`; status filter uses `filters.mjs`)

```js
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
```

- [ ] **Step 5: Replace `index.mjs` with wiring only**

```js
#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadAllData } from "./reader.mjs";
import { READ_TOOL_DEFINITIONS, createReadHandlers } from "./read-tools.mjs";

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

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "focus-todo", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const TOOL_DEFINITIONS = [...READ_TOOL_DEFINITIONS];
const handlers = { ...createReadHandlers({ getData }) };

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = handlers[name];
  let result;

  try {
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    result = await handler(args ?? {});
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }

  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return { content: [{ type: "text", text }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run test:unit`
Expected: all pass, `ℹ fail 0`

- [ ] **Step 7: Check the server still lists tools over stdio**

Run:
```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | timeout 5 node index.mjs | tail -1 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result.tools.map(t=>t.name).join(",")))'
```
Expected: `list_projects,list_tasks,search_tasks,get_task,list_subtasks,get_pomodoro_stats,find_duplicate_tasks`

- [ ] **Step 8: Commit**

```bash
git add format.mjs read-tools.mjs index.mjs scripts/read-tools.test.mjs
git commit -m "feat: annotate read tools, add overdue status and find_duplicate_tasks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Confirmation via elicitation or preview

**Files:**
- Create: `confirm.mjs`
- Test: `scripts/confirm.test.mjs`

**Interfaces:**
- Consumes: an object with `getClientCapabilities()` and `elicitInput(params)` (the SDK `Server`)
- Produces: `createConfirm(server): ({ message: string, confirmed?: boolean }) => Promise<"accepted" | "declined" | "preview">`

- [ ] **Step 1: Write the failing tests** — `scripts/confirm.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createConfirm } from "../confirm.mjs";

function fakeServer({ caps, reply, error } = {}) {
  const calls = [];
  return {
    calls,
    getClientCapabilities: () => caps,
    elicitInput: async params => { calls.push(params); if (error) throw error; return reply; },
  };
}

test("accepts when the user confirms the form", async () => {
  const s = fakeServer({ caps: { elicitation: { form: {} } }, reply: { action: "accept", content: { confirm: true } } });
  assert.equal(await createConfirm(s)({ message: "Complete 2 task(s)?" }), "accepted");
  assert.equal(s.calls[0].mode, "form");
  assert.equal(s.calls[0].message, "Complete 2 task(s)?");
  assert.deepEqual(s.calls[0].requestedSchema.required, ["confirm"]);
});

test("unchecked box, decline and cancel all mean declined", async () => {
  for (const reply of [{ action: "accept", content: { confirm: false } }, { action: "decline" }, { action: "cancel" }]) {
    const s = fakeServer({ caps: { elicitation: {} }, reply });
    assert.equal(await createConfirm(s)({ message: "m" }), "declined");
  }
});

test("confirmed flag cannot bypass the form when elicitation is available", async () => {
  const s = fakeServer({ caps: { elicitation: {} }, reply: { action: "decline" } });
  assert.equal(await createConfirm(s)({ message: "m", confirmed: true }), "declined");
});

test("without elicitation: preview first, accepted with confirmed", async () => {
  const s = fakeServer({ caps: {} });
  assert.equal(await createConfirm(s)({ message: "m" }), "preview");
  assert.equal(await createConfirm(s)({ message: "m", confirmed: true }), "accepted");
  assert.equal(s.calls.length, 0);
});

test("falls back to preview when the client rejects form elicitation", async () => {
  const s = fakeServer({ caps: { elicitation: {} }, error: new Error("Client does not support form elicitation.") });
  assert.equal(await createConfirm(s)({ message: "m" }), "preview");
});

test("other elicitation errors propagate", async () => {
  const s = fakeServer({ caps: { elicitation: {} }, error: new Error("Request timed out") });
  await assert.rejects(createConfirm(s)({ message: "m" }), /timed out/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit`
Expected: FAIL — `Cannot find module '.../confirm.mjs'`

- [ ] **Step 3: Create `confirm.mjs`**

```js
// Ask the user to approve a write: native form when supported, otherwise a two-call preview

const SCHEMA = {
  type: "object",
  properties: {
    confirm: { type: "boolean", title: "Confirm", description: "Apply these changes to Focus To-Do" },
  },
  required: ["confirm"],
};

export function createConfirm(server) {
  return async function confirm({ message, confirmed }) {
    if (server.getClientCapabilities()?.elicitation) {
      try {
        const r = await server.elicitInput({ mode: "form", message, requestedSchema: SCHEMA });
        return r.action === "accept" && r.content?.confirm === true ? "accepted" : "declined";
      } catch (err) {
        if (!/does not support/i.test(err.message)) throw err;
      }
    }
    return confirmed === true ? "accepted" : "preview";
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit`
Expected: all pass, `ℹ fail 0`

- [ ] **Step 5: Commit**

```bash
git add confirm.mjs scripts/confirm.test.mjs
git commit -m "feat: add write confirmation via elicitation with preview fallback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Write tools (validation, confirmation flow, result text)

**Files:**
- Create: `write-tools.mjs`
- Test: `scripts/write-tools.test.mjs`

**Interfaces:**
- Consumes:
  - `isActive`, `isRecurring`, `findDuplicateGroups` (Task 3); `ts`, `projectName` (Task 4)
  - `confirm({ message, confirmed }) → "accepted" | "declined" | "preview"` (Task 5)
  - `writer` with `completeTasks(ids)`, `skipOccurrences(ids)`, `deleteTasks(ids)`, each resolving to
    `{ results: Array<{ id: string, ok: boolean, nextOccurrence?: { id: string, deadline: number }, error?: string }>, pendingSync: string[], uiRefreshed: boolean }` (implemented in Task 8)
- Produces: `MAX_TASK_IDS = 50`, `WRITE_TOOL_DEFINITIONS: object[]`, `createWriteHandlers({ getData, invalidate, writer, confirm }): { complete_tasks, skip_occurrences, remove_duplicate_tasks }` (each `async (args) => string`)

Note on the spec's "refuse removing every member of a group": the copy chosen as `keep` is never accepted by `remove_duplicate_tasks`, so a group can never lose all members; the test "keep copy is rejected" pins that guarantee.

- [ ] **Step 1: Write the failing tests** — `scripts/write-tools.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { WRITE_TOOL_DEFINITIONS, createWriteHandlers } from "../write-tools.mjs";

const TODAY = new Date(2026, 9, 13, 23, 59, 59).getTime();

function data(tasks) {
  return {
    projects: new Map([["P1", { id: "P1", name: "Project 1" }]]),
    tasks: new Map(tasks.map(t => [t.id, { name: t.id, projectId: "P1", state: 0, isFinished: false, rCycle: 0, rId: "", deadline: TODAY, creationDate: 1, ...t }])),
  };
}

function setup(tasks, { decision = "accepted", result } = {}) {
  const calls = { writer: [], confirm: [], invalidated: 0 };
  const respond = method => async ids => {
    calls.writer.push([method, ids]);
    return result ?? { results: ids.map(id => ({ id, ok: true })), pendingSync: [], uiRefreshed: true };
  };
  const h = createWriteHandlers({
    getData: () => data(tasks),
    invalidate: () => { calls.invalidated++; },
    writer: { completeTasks: respond("complete"), skipOccurrences: respond("skip"), deleteTasks: respond("delete") },
    confirm: async args => { calls.confirm.push(args); return decision; },
  });
  return { h, calls };
}

test("write tools are annotated as in the spec", () => {
  const byName = Object.fromEntries(WRITE_TOOL_DEFINITIONS.map(d => [d.name, d.annotations]));
  assert.deepEqual(byName.complete_tasks, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  assert.deepEqual(byName.skip_occurrences, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  assert.deepEqual(byName.remove_duplicate_tasks, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  for (const d of WRITE_TOOL_DEFINITIONS) assert.equal(d.inputSchema.properties.task_ids.maxItems, 50);
});

test("complete_tasks completes active tasks after confirmation", async () => {
  const { h, calls } = setup([{ id: "a" }]);
  const text = await h.complete_tasks({ task_ids: ["a"] });
  assert.deepEqual(calls.writer, [["complete", ["a"]]]);
  assert.match(calls.confirm[0].message, /a · Project 1 · 2026-10-13/);
  assert.match(text, /Completed 1\/1/);
  assert.equal(calls.invalidated, 1);
});

test("repeated IDs are executed once", async () => {
  const { h, calls } = setup([{ id: "a" }]);
  await h.complete_tasks({ task_ids: ["a", "a"] });
  assert.deepEqual(calls.writer, [["complete", ["a"]]]);
});

test("already completed tasks are skipped without calling the writer", async () => {
  const { h, calls } = setup([{ id: "done", isFinished: true }]);
  const text = await h.complete_tasks({ task_ids: ["done"] });
  assert.equal(calls.writer.length, 0);
  assert.match(text, /Nothing to do/);
  assert.match(text, /done: already completed/);
});

test("unknown and archived IDs are rejected, valid ones still run", async () => {
  const { h, calls } = setup([{ id: "a" }, { id: "arch", state: 1 }]);
  const text = await h.complete_tasks({ task_ids: ["a", "nope", "arch"] });
  assert.deepEqual(calls.writer, [["complete", ["a"]]]);
  assert.match(text, /Rejected nope: task not found/);
  assert.match(text, /Rejected arch: task is not active/);
});

test("more than 50 IDs is an error", async () => {
  const ids = Array.from({ length: 51 }, (_, i) => `t${i}`);
  const { h } = setup(ids.map(id => ({ id })));
  await assert.rejects(h.complete_tasks({ task_ids: ids }), /At most 50/);
});

test("preview changes nothing and explains how to apply", async () => {
  const { h, calls } = setup([{ id: "a" }], { decision: "preview" });
  const text = await h.complete_tasks({ task_ids: ["a"] });
  assert.equal(calls.writer.length, 0);
  assert.match(text, /nothing was changed/);
  assert.match(text, /confirmed: true/);
});

test("declined changes nothing", async () => {
  const { h, calls } = setup([{ id: "a" }], { decision: "declined" });
  assert.match(await h.complete_tasks({ task_ids: ["a"] }), /Cancelled/);
  assert.equal(calls.writer.length, 0);
});

test("skip_occurrences rejects non-recurring tasks", async () => {
  const { h, calls } = setup([{ id: "plain" }, { id: "rec", rCycle: 1, rId: "S1" }]);
  const text = await h.skip_occurrences({ task_ids: ["plain", "rec"] });
  assert.deepEqual(calls.writer, [["skip", ["rec"]]]);
  assert.match(text, /Rejected plain: task is not recurring/);
});

test("remove_duplicate_tasks rejects the kept copy and removes the extra one", async () => {
  const { h, calls } = setup([
    { id: "keep", rCycle: 1, rId: "S1", creationDate: 1 },
    { id: "extra", rCycle: 1, rId: "S1", creationDate: 2 },
  ]);
  const text = await h.remove_duplicate_tasks({ task_ids: ["keep", "extra"] });
  assert.deepEqual(calls.writer, [["delete", ["extra"]]]);
  assert.match(text, /Rejected keep: this is the copy kept/);
  assert.match(calls.confirm[0].message, /keeps keep/);
});

test("remove_duplicate_tasks rejects tasks that are not duplicates", async () => {
  const { h, calls } = setup([{ id: "solo", rCycle: 1, rId: "S9" }]);
  assert.match(await h.remove_duplicate_tasks({ task_ids: ["solo"] }), /Rejected solo: task is not a duplicate/);
  assert.equal(calls.writer.length, 0);
});

test("reports next occurrences, failures, pending sync and a skipped reload", async () => {
  const { h } = setup([{ id: "a", rCycle: 1, rId: "S1" }, { id: "b" }], {
    result: {
      results: [{ id: "a", ok: true, nextOccurrence: { id: "N1", deadline: TODAY + 86400e3 } }, { id: "b", ok: false, error: "boom" }],
      pendingSync: ["N1"],
      uiRefreshed: false,
    },
  });
  const text = await h.complete_tasks({ task_ids: ["a", "b"] });
  assert.match(text, /Completed 1\/2/);
  assert.match(text, /N1 \(2026-10-14\)/);
  assert.match(text, /Failed b: boom/);
  assert.match(text, /not yet confirmed by the sync server: N1/);
  assert.match(text, /window was not reloaded/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit`
Expected: FAIL — `Cannot find module '.../write-tools.mjs'`

- [ ] **Step 3: Create `write-tools.mjs`**

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit`
Expected: all pass, `ℹ fail 0`

- [ ] **Step 5: Commit**

```bash
git add write-tools.mjs scripts/write-tools.test.mjs
git commit -m "feat: add complete, skip and remove-duplicate write tools

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: CDP client and dedicated browser management

**Files:**
- Create: `cdp.mjs`, `browser.mjs`
- Test: `scripts/browser.test.mjs`

**Interfaces:**
- Consumes: `EXTENSION_ID`, `getConfig()` (Task 2)
- Produces:
  - `cdp.mjs`: `connectCDP(wsUrl, { timeoutMs = 10000 } = {}): Promise<{ send(method, params?): Promise<object>, evaluate(expression): Promise<any>, close(): void }>`
  - `browser.mjs`: `EXTENSION_URL`, `CHROME_CANDIDATES`, `resolveChromePath(config, exists = existsSync): string | null`, `buildLaunchArgs(config): string[]`, `ensureBrowser({ config, launch, exists, timeoutMs, pollMs } = {}): Promise<string>` (returns `http://127.0.0.1:<port>`), `findExtensionTarget(base, { timeoutMs, pollMs } = {}): Promise<{ webSocketDebuggerUrl: string, url: string }>`

- [ ] **Step 1: Write the failing tests** — `scripts/browser.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { resolveChromePath, buildLaunchArgs, ensureBrowser } from "../browser.mjs";

function fakeDevtools(port = 0) {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(req.url === "/json/version" ? JSON.stringify({ Browser: "Chrome/155" }) : "[]");
  });
  return new Promise(resolve => server.listen(port, "127.0.0.1", () => resolve(server)));
}

const cfg = port => ({ userDataDir: "/tmp/udd dir", cdpPort: port, chromePath: null });

test("buildLaunchArgs uses the dedicated profile, debug port and app id", () => {
  assert.deepEqual(buildLaunchArgs(cfg(9333)), [
    "--user-data-dir=/tmp/udd dir",
    "--remote-debugging-port=9333",
    "--app-id=ngceodoilcgpmkijopinlkmohnfifjfb",
  ]);
});

test("resolveChromePath honours FOCUS_TODO_CHROME_PATH and candidates", () => {
  assert.equal(resolveChromePath({ chromePath: "/x/chrome" }, p => p === "/x/chrome"), "/x/chrome");
  assert.equal(resolveChromePath({ chromePath: "/x/chrome" }, () => false), null);
  assert.equal(resolveChromePath({ chromePath: null }, p => p === "/usr/bin/google-chrome"), "/usr/bin/google-chrome");
});

test("ensureBrowser does not launch when the port already answers", async () => {
  const server = await fakeDevtools();
  try {
    let launched = false;
    const base = await ensureBrowser({ config: cfg(server.address().port), launch: () => { launched = true; } });
    assert.equal(base, `http://127.0.0.1:${server.address().port}`);
    assert.equal(launched, false);
  } finally { server.close(); }
});

test("ensureBrowser launches Chrome and waits for the port", async () => {
  const probe = await fakeDevtools();
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  let server, launchedWith;
  try {
    const base = await ensureBrowser({
      config: cfg(port),
      exists: p => p === "/usr/bin/google-chrome",
      launch: async (cmd, args) => { launchedWith = [cmd, args]; server = await fakeDevtools(port); },
      pollMs: 20,
    });
    assert.equal(base, `http://127.0.0.1:${port}`);
    assert.equal(launchedWith[0], "/usr/bin/google-chrome");
    assert.ok(launchedWith[1].includes(`--remote-debugging-port=${port}`));
  } finally { server?.close(); }
});

test("ensureBrowser explains a missing Chrome", async () => {
  const probe = await fakeDevtools();
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  await assert.rejects(ensureBrowser({ config: cfg(port), exists: () => false, launch: () => {} }), /Chrome not found.*FOCUS_TODO_CHROME_PATH/s);
});

test("ensureBrowser gives up when the port never opens", async () => {
  const probe = await fakeDevtools();
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  await assert.rejects(
    ensureBrowser({ config: cfg(port), exists: () => true, launch: () => {}, timeoutMs: 200, pollMs: 20 }),
    /did not respond.*without --remote-debugging-port/s,
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit`
Expected: FAIL — `Cannot find module '.../browser.mjs'`

- [ ] **Step 3: Create `cdp.mjs`**

```js
// Minimal Chrome DevTools Protocol client over Node's native WebSocket

export async function connectCDP(wsUrl, { timeoutMs = 10_000 } = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP connection timed out: ${wsUrl}`)), timeoutMs);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error(`CDP connection failed: ${wsUrl}`)); };
  });

  let nextId = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    const p = msg.id && pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
    else p.resolve(msg.result);
  };
  ws.onclose = () => {
    for (const p of pending.values()) p.reject(new Error("CDP connection closed"));
    pending.clear();
  };

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject, method });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  return { send, evaluate, close: () => ws.close() };
}
```

- [ ] **Step 4: Create `browser.mjs`**

```js
// Find or launch the dedicated Chrome instance and locate the Focus To-Do page
import { spawn } from "child_process";
import { existsSync } from "fs";
import { EXTENSION_ID, getConfig } from "./config.mjs";

export const EXTENSION_URL = `chrome-extension://${EXTENSION_ID}/WebContent/index.html`;

export const CHROME_CANDIDATES = [
  "/opt/google/chrome/chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function resolveChromePath(config, exists = existsSync) {
  if (config.chromePath) return exists(config.chromePath) ? config.chromePath : null;
  return CHROME_CANDIDATES.find(p => exists(p)) ?? null;
}

export function buildLaunchArgs(config) {
  return [
    `--user-data-dir=${config.userDataDir}`,
    `--remote-debugging-port=${config.cdpPort}`,
    `--app-id=${EXTENSION_ID}`,
  ];
}

function defaultLaunch(cmd, args) {
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

async function fetchJSON(url, timeoutMs = 2000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

export async function ensureBrowser({ config = getConfig(), launch = defaultLaunch, exists = existsSync, timeoutMs = 20_000, pollMs = 250 } = {}) {
  const base = `http://127.0.0.1:${config.cdpPort}`;
  try { await fetchJSON(`${base}/json/version`); return base; } catch {}

  const chrome = resolveChromePath(config, exists);
  if (!chrome) {
    throw new Error(`Chrome not found. Tried: ${config.chromePath ?? CHROME_CANDIDATES.join(", ")}. Set FOCUS_TODO_CHROME_PATH to the Chrome executable.`);
  }
  await launch(chrome, buildLaunchArgs(config));

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    try { await fetchJSON(`${base}/json/version`); return base; } catch {}
  }
  throw new Error(
    `Chrome was started but port ${config.cdpPort} did not respond within ${timeoutMs / 1000}s. ` +
    `If a Chrome window is already using ${config.userDataDir} without --remote-debugging-port, close it and try again.`
  );
}

export async function findExtensionTarget(base, { timeoutMs = 20_000, pollMs = 250 } = {}) {
  const find = async () => (await fetchJSON(`${base}/json/list`))
    .find(t => t.type === "page" && t.url.startsWith(EXTENSION_URL));

  let target = await find();
  if (!target) await fetch(`${base}/json/new?${encodeURIComponent(EXTENSION_URL)}`, { method: "PUT" });
  const deadline = Date.now() + timeoutMs;
  while (!target && Date.now() < deadline) {
    await sleep(pollMs);
    target = await find();
  }
  if (!target) throw new Error("Focus To-Do page not found in the dedicated Chrome. Install the Focus To-Do extension there and log in.");
  return target;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:unit`
Expected: all pass, `ℹ fail 0`

- [ ] **Step 6: Commit**

```bash
git add cdp.mjs browser.mjs scripts/browser.test.mjs
git commit -m "feat: add CDP client and dedicated Chrome launcher

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Writer over a session

**Files:**
- Create: `writer.mjs`
- Test: `scripts/writer.test.mjs`

**Interfaces:**
- Consumes: `openSession(): Promise<Session>` where `Session = { call(method: string, id: string): Promise<any>, syncAndWait(ids: string[]): Promise<string[]>, refreshIfIdle(): Promise<boolean>, close(): void }` (real one in Task 9)
- Produces: `createWriter({ openSession }): { completeTasks(ids), skipOccurrences(ids), deleteTasks(ids) }` resolving to `{ results, pendingSync, uiRefreshed }` exactly as consumed by Task 6

- [ ] **Step 1: Write the failing tests** — `scripts/writer.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createWriter } from "../writer.mjs";

function fakeSession({ replies = {}, pending = [], idle = true } = {}) {
  const log = [];
  return {
    log,
    async call(method, id) {
      log.push(["call", method, id]);
      const r = replies[id];
      if (r instanceof Error) throw r;
      return r;
    },
    async syncAndWait(ids) { log.push(["sync", ids]); return pending; },
    async refreshIfIdle() { log.push(["refresh"]); return idle; },
    close() { log.push(["close"]); },
  };
}

test("completeTasks calls completeTask per id and reports next occurrences", async () => {
  const s = fakeSession({ replies: { a: { finishedTask: { id: "a" }, newTask: { id: "n1", deadline: 5 } }, b: { finishedTask: { id: "b" }, newTask: null } } });
  const out = await createWriter({ openSession: async () => s }).completeTasks(["a", "b"]);
  assert.deepEqual(out.results, [
    { id: "a", ok: true, nextOccurrence: { id: "n1", deadline: 5 } },
    { id: "b", ok: true },
  ]);
  assert.deepEqual(s.log.filter(e => e[0] === "call").map(e => e[1]), ["completeTask", "completeTask"]);
  assert.deepEqual(s.log.find(e => e[0] === "sync")[1], ["a", "n1", "b"]);
  assert.equal(out.uiRefreshed, true);
});

test("skipOccurrences uses deleteCurrentRepeatTask and its returned task", async () => {
  const s = fakeSession({ replies: { r: { id: "n2", deadline: 9 } } });
  const out = await createWriter({ openSession: async () => s }).skipOccurrences(["r"]);
  assert.equal(s.log[0][1], "deleteCurrentRepeatTask");
  assert.deepEqual(out.results, [{ id: "r", ok: true, nextOccurrence: { id: "n2", deadline: 9 } }]);
});

test("deleteTasks uses deleteTask", async () => {
  const s = fakeSession();
  const out = await createWriter({ openSession: async () => s }).deleteTasks(["d"]);
  assert.equal(s.log[0][1], "deleteTask");
  assert.deepEqual(out.results, [{ id: "d", ok: true }]);
});

test("a failing task does not stop the others", async () => {
  const s = fakeSession({ replies: { bad: new Error("boom") } });
  const out = await createWriter({ openSession: async () => s }).deleteTasks(["bad", "good"]);
  assert.deepEqual(out.results, [{ id: "bad", ok: false, error: "boom" }, { id: "good", ok: true }]);
  assert.deepEqual(s.log.find(e => e[0] === "sync")[1], ["good"]);
});

test("nothing succeeded: no sync, no reload, session closed", async () => {
  const s = fakeSession({ replies: { bad: new Error("boom") } });
  const out = await createWriter({ openSession: async () => s }).deleteTasks(["bad"]);
  assert.deepEqual(out.pendingSync, []);
  assert.equal(out.uiRefreshed, false);
  assert.deepEqual(s.log.map(e => e[0]), ["call", "close"]);
});

test("passes through pending sync ids and a skipped reload (pomodoro running)", async () => {
  const s = fakeSession({ pending: ["d"], idle: false });
  const out = await createWriter({ openSession: async () => s }).deleteTasks(["d"]);
  assert.deepEqual(out.pendingSync, ["d"]);
  assert.equal(out.uiRefreshed, false);
});

test("session is closed even when sync throws", async () => {
  const s = fakeSession();
  s.syncAndWait = async () => { throw new Error("socket closed"); };
  await assert.rejects(createWriter({ openSession: async () => s }).deleteTasks(["d"]), /socket closed/);
  assert.equal(s.log.at(-1)[0], "close");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:unit`
Expected: FAIL — `Cannot find module '.../writer.mjs'`

- [ ] **Step 3: Create `writer.mjs`**

```js
// Runs app service calls for a batch of tasks over one browser session

const occurrence = t => (t && t.id ? { id: t.id, deadline: t.deadline } : undefined);

export function createWriter({ openSession }) {
  async function run(ids, method, nextOf) {
    const session = await openSession();
    try {
      const results = [];
      for (const id of ids) {
        try {
          const next = nextOf(await session.call(method, id));
          results.push(next ? { id, ok: true, nextOccurrence: next } : { id, ok: true });
        } catch (err) {
          results.push({ id, ok: false, error: err.message });
        }
      }
      const touched = results.filter(r => r.ok).flatMap(r => [r.id, r.nextOccurrence?.id].filter(Boolean));
      if (touched.length === 0) return { results, pendingSync: [], uiRefreshed: false };
      const pendingSync = await session.syncAndWait(touched);
      const uiRefreshed = await session.refreshIfIdle();
      return { results, pendingSync, uiRefreshed };
    } finally {
      session.close();
    }
  }

  return {
    completeTasks: ids => run(ids, "completeTask", r => occurrence(r?.newTask)),
    skipOccurrences: ids => run(ids, "deleteCurrentRepeatTask", r => occurrence(r)),
    deleteTasks: ids => run(ids, "deleteTask", () => undefined),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit`
Expected: all pass, `ℹ fail 0`

- [ ] **Step 5: Commit**

```bash
git add writer.mjs scripts/writer.test.mjs
git commit -m "feat: add writer that batches app service calls per session

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Bridge to the app, server wiring and end-to-end check

**Files:**
- Create: `bridge.mjs`, `scripts/e2e.mjs`
- Modify: `index.mjs` (imports and handler/definition lists from Task 4), `package.json` (scripts)

**Interfaces:**
- Consumes: `connectCDP` (Task 7), `ensureBrowser`, `findExtensionTarget` (Task 7), `getConfig` (Task 2), `createWriter` (Task 8), `createConfirm` (Task 5), `WRITE_TOOL_DEFINITIONS`, `createWriteHandlers` (Task 6)
- Produces: `openSession({ config } = {}): Promise<Session & { evaluate(expression): Promise<any> }>`

Facts this task relies on (verified 2026-10-13 against extension 7.1.1; see spec "Contexto"):
- React 16 root: `document.getElementById("root")._reactRootContainer._internalRoot.current`.
- TaskService singleton = some module export `X.default.shared` having `completeTask`, `deleteCurrentRepeatTask`, `deleteTask`, `fetchTaskById` (methods take a task **id**; `completeTask` resolves `{ finishedTask, newTask }`, `deleteCurrentRepeatTask` resolves the new task or `null`, `deleteTask` resolves `undefined`; all write with `sync: 0` and trigger a sync).
- Synchronizer singleton = `X.default.shared` having `syncNow`, `sync`, `updateProgressBar`.
- Timer state: the Redux store on a fiber's `memoizedProps.store`; `store.getState().timerInfo.state` ∈ `initial | work | pause | rest | waitingForRest`.
- IndexedDB database name starts with `PomodoroDB` (currently `PomodoroDB6`), store `Task`, keyPath `id`.
- Logged-in marker: `localStorage["cookie.ACCT"]`.

- [ ] **Step 1: Create `bridge.mjs`**

```js
// Talks to the Focus To-Do page: finds the app's service singletons and calls them
import { connectCDP } from "./cdp.mjs";
import { ensureBrowser, findExtensionTarget } from "./browser.mjs";
import { getConfig } from "./config.mjs";

const GROUP = "focus-todo-mcp";
const SERVICES_LOST = "focus-todo-mcp: services not located";
const SHAPES = {
  taskService: ["completeTask", "deleteCurrentRepeatTask", "deleteTask", "fetchTaskById"],
  synchronizer: ["syncNow", "sync", "updateProgressBar"],
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const APP_STATE = `(() => {
  const root = document.getElementById("root");
  if (document.readyState !== "complete" || !root || !root._reactRootContainer) return "loading";
  return localStorage.getItem("cookie.ACCT") ? "ready" : "logged-out";
})()`;

// One function per mounted component type; their closures reach the app's modules
const COLLECT_FUNCTIONS = `(() => {
  const root = document.getElementById("root")._reactRootContainer._internalRoot.current;
  const fns = [], seen = new Set(), stack = [root];
  while (stack.length) {
    const f = stack.pop();
    if (!f) continue;
    stack.push(f.sibling, f.child);
    const sn = f.stateNode;
    if (!sn || sn instanceof Node || typeof sn !== "object" || seen.has(f.type)) continue;
    seen.add(f.type);
    const own = Object.values(sn).find(v => typeof v === "function");
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(sn))
      .filter(k => k !== "constructor")
      .map(k => sn[k])
      .find(v => typeof v === "function");
    if (own || proto) fns.push(own || proto);
  }
  return fns;
})()`;

// Called with \`this\` = a closure variable; stores matching singletons on window
const PROBE = `function (shapes) {
  const s = this && this.default && this.default.shared;
  if (!s || typeof s !== "object") return null;
  const store = (window.__focusTodoMcp = window.__focusTodoMcp || {});
  for (const [name, methods] of Object.entries(shapes)) {
    if (!store[name] && methods.every(m => typeof s[m] === "function")) { store[name] = s; return name; }
  }
  return null;
}`;

const TIMER_STATE = `(() => {
  const root = document.getElementById("root")._reactRootContainer._internalRoot.current;
  const stack = [root];
  while (stack.length) {
    const f = stack.pop();
    if (!f) continue;
    stack.push(f.sibling, f.child);
    const store = f.memoizedProps && f.memoizedProps.store;
    if (store && typeof store.getState === "function") return store.getState().timerInfo?.state ?? null;
  }
  return null;
})()`;

async function waitForApp(cdp, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await cdp.evaluate(APP_STATE).catch(() => "loading");
    if (state === "ready") return;
    if (state === "logged-out") throw new Error("Not logged in to Focus To-Do in the dedicated Chrome. Log in there and try again.");
    await sleep(250);
  }
  throw new Error("Focus To-Do page did not finish loading in 20s.");
}

async function located(cdp) {
  return cdp.evaluate(`(() => { const s = window.__focusTodoMcp || {}; return ${JSON.stringify(Object.keys(SHAPES))}.filter(k => !s[k]); })()`);
}

async function locateServices(cdp) {
  if ((await located(cdp)).length === 0) return;
  try {
    const list = await cdp.send("Runtime.evaluate", { expression: COLLECT_FUNCTIONS, objectGroup: GROUP });
    const items = (await cdp.send("Runtime.getProperties", { objectId: list.result.objectId, ownProperties: true })).result
      .filter(p => /^\d+$/.test(p.name) && p.value?.objectId);
    for (const item of items) {
      let fnId = item.value.objectId, scopes;
      for (let hop = 0; hop < 2 && !scopes; hop++) {
        const internal = (await cdp.send("Runtime.getProperties", { objectId: fnId })).internalProperties ?? [];
        scopes = internal.find(p => p.name === "[[Scopes]]");
        const target = internal.find(p => p.name === "[[TargetFunction]]");
        if (!scopes && target) fnId = target.value.objectId;
      }
      if (!scopes) continue;
      for (const scope of (await cdp.send("Runtime.getProperties", { objectId: scopes.value.objectId })).result) {
        if (!scope.value?.objectId) continue;
        const vars = (await cdp.send("Runtime.getProperties", { objectId: scope.value.objectId })).result;
        if (vars.length > 200) continue; // global/script scopes
        for (const v of vars) {
          if (v.value?.type !== "object" || !v.value.objectId) continue;
          await cdp.send("Runtime.callFunctionOn", { objectId: v.value.objectId, functionDeclaration: PROBE, arguments: [{ value: SHAPES }], returnByValue: true });
        }
      }
      if ((await located(cdp)).length === 0) return;
    }
  } finally {
    await cdp.send("Runtime.releaseObjectGroup", { objectGroup: GROUP }).catch(() => {});
  }
  const missing = await located(cdp);
  if (missing.length) {
    const version = await cdp.evaluate("chrome.runtime.getManifest().version").catch(() => "unknown");
    throw new Error(`Focus To-Do services not found (extension ${version}); missing: ${missing.map(m => `${m} [${SHAPES[m].join(", ")}]`).join("; ")}. The extension may have changed.`);
  }
}

function callService(cdp, method, id) {
  return cdp.evaluate(`(async () => {
    const s = window.__focusTodoMcp && window.__focusTodoMcp.taskService;
    if (!s) throw new Error(${JSON.stringify(SERVICES_LOST)});
    const r = await s[${JSON.stringify(method)}](${JSON.stringify(id)});
    return r == null ? null : JSON.parse(JSON.stringify(r));
  })()`);
}

// IDs whose record still has sync !== 1 (missing records count as synced)
function unsynced(cdp, ids) {
  return cdp.evaluate(`(async () => {
    const ids = ${JSON.stringify(ids)};
    const name = (await indexedDB.databases()).map(d => d.name).find(n => /^PomodoroDB/.test(n));
    const db = await new Promise((res, rej) => { const q = indexedDB.open(name); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    try {
      const st = db.transaction("Task").objectStore("Task");
      const rows = await Promise.all(ids.map(id => new Promise(res => { const q = st.get(id); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); })));
      return ids.filter((id, i) => rows[i] && rows[i].sync !== 1);
    } finally { db.close(); }
  })()`);
}

async function syncAndWait(cdp, ids, timeoutMs = 30_000) {
  await locateServices(cdp);
  await cdp.evaluate("void window.__focusTodoMcp.synchronizer.syncNow(); true");
  const deadline = Date.now() + timeoutMs;
  let pending = await unsynced(cdp, ids);
  while (pending.length && Date.now() < deadline) {
    await sleep(1000);
    pending = await unsynced(cdp, ids);
  }
  return pending;
}

// Reload only with the timer idle, and wait for the app so the next session never races the reload
async function refreshIfIdle(cdp) {
  const state = await cdp.evaluate(TIMER_STATE).catch(() => null);
  if (state !== "initial") return false;
  await cdp.send("Page.reload");
  await sleep(500);
  await waitForApp(cdp);
  return true;
}

export async function openSession({ config = getConfig() } = {}) {
  const base = await ensureBrowser({ config });
  const target = await findExtensionTarget(base);
  const cdp = await connectCDP(target.webSocketDebuggerUrl);
  try {
    await waitForApp(cdp);
    await locateServices(cdp);
  } catch (err) {
    cdp.close();
    throw err;
  }
  return {
    async call(method, id) {
      try {
        return await callService(cdp, method, id);
      } catch (err) {
        if (!String(err.message).includes(SERVICES_LOST)) throw err;
        await waitForApp(cdp);
        await locateServices(cdp);
        return callService(cdp, method, id);
      }
    },
    syncAndWait: (ids, timeoutMs) => syncAndWait(cdp, ids, timeoutMs),
    refreshIfIdle: () => refreshIfIdle(cdp),
    evaluate: expression => cdp.evaluate(expression),
    close: () => cdp.close(),
  };
}
```

- [ ] **Step 2: Wire write tools in `index.mjs`**

Add imports below the existing `read-tools.mjs` import:

```js
import { WRITE_TOOL_DEFINITIONS, createWriteHandlers } from "./write-tools.mjs";
import { createConfirm } from "./confirm.mjs";
import { createWriter } from "./writer.mjs";
import { openSession } from "./bridge.mjs";
```

Add below `getData()`:

```js
function invalidate() {
  cache = null;
}
```

Replace

```js
const TOOL_DEFINITIONS = [...READ_TOOL_DEFINITIONS];
const handlers = { ...createReadHandlers({ getData }) };
```

with

```js
const TOOL_DEFINITIONS = [...READ_TOOL_DEFINITIONS, ...WRITE_TOOL_DEFINITIONS];
const handlers = {
  ...createReadHandlers({ getData }),
  ...createWriteHandlers({ getData, invalidate, writer: createWriter({ openSession }), confirm: createConfirm(server) }),
};
```

- [ ] **Step 3: Create `scripts/e2e.mjs`**

```js
// Opt-in end-to-end check against the dedicated Chrome instance.
// Creates throwaway tasks named MCP-E2E-<timestamp>, exercises complete/skip/delete through the
// real writer, verifies IndexedDB, then deletes everything it created. Touches no other task.
import assert from "node:assert/strict";
import { openSession } from "../bridge.mjs";
import { createWriter } from "../writer.mjs";

if (process.env.FOCUS_TODO_E2E !== "1") {
  console.log("Skipped: set FOCUS_TODO_E2E=1 with the dedicated Focus To-Do Chrome open.");
  process.exit(0);
}

const PREFIX = `MCP-E2E-${Date.now()}`;
const endOfToday = new Date();
endOfToday.setHours(23, 59, 59, 999);
const TODAY = endOfToday.getTime();
const YESTERDAY = TODAY - 86400e3;

// All tasks this run created, read straight from the app's IndexedDB
function prefixedTasks(session) {
  return session.evaluate(`(async () => {
    const name = (await indexedDB.databases()).map(d => d.name).find(n => /^PomodoroDB/.test(n));
    const db = await new Promise(r => { const q = indexedDB.open(name); q.onsuccess = () => r(q.result); });
    const all = await new Promise(r => { const q = db.transaction("Task").objectStore("Task").getAll(); q.onsuccess = () => r(q.result); });
    db.close();
    return all.filter(t => t.name.startsWith(${JSON.stringify(PREFIX)}));
  })()`);
}

function addTask(session, fields) {
  return session.evaluate(`window.__focusTodoMcp.taskService.addTask(${JSON.stringify(fields)}).then(t => JSON.parse(JSON.stringify(t)))`);
}

function dailySeries(name, deadline, rId) {
  return { name, deadline, rCycle: 1, rUnit: "days", rValue: "", rId, rFirstDeadline: deadline };
}

let failed = false;
try {
  const setup = await openSession();
  let plain, rec, dupA, dupB;
  try {
    const uuid = () => setup.evaluate("crypto.randomUUID().toUpperCase()");
    plain = await addTask(setup, { name: `${PREFIX} plain`, deadline: YESTERDAY });
    rec = await addTask(setup, dailySeries(`${PREFIX} recurring`, YESTERDAY, await uuid()));
    const series = await uuid();
    dupA = await addTask(setup, dailySeries(`${PREFIX} dup`, TODAY, series));
    dupB = await addTask(setup, dailySeries(`${PREFIX} dup`, TODAY, series));
  } finally {
    setup.close();
  }

  const writer = createWriter({ openSession });
  const completed = await writer.completeTasks([plain.id]);
  assert.equal(completed.results[0].ok, true, JSON.stringify(completed));
  const skipped = await writer.skipOccurrences([rec.id]);
  assert.ok(skipped.results[0].nextOccurrence?.id, JSON.stringify(skipped));
  const removed = await writer.deleteTasks([dupB.id]);
  assert.equal(removed.results[0].ok, true, JSON.stringify(removed));

  const check = await openSession();
  try {
    const byId = new Map((await prefixedTasks(check)).map(t => [t.id, t]));
    assert.equal(byId.get(plain.id).isFinished, true, "plain task completed");
    assert.equal(byId.get(rec.id).state, -1, "skipped occurrence deleted");
    const next = byId.get(skipped.results[0].nextOccurrence.id);
    assert.equal(next.isFinished, false, "next occurrence active");
    assert.equal(next.rId, rec.rId, "next occurrence in the same series");
    assert.equal(byId.get(dupB.id).state, -1, "duplicate removed");
    assert.equal(byId.get(dupA.id).state, 0, "kept copy untouched");
    console.log("PASS: complete, skip and remove-duplicate work end to end");
  } finally {
    check.close();
  }
} catch (err) {
  failed = true;
  console.error("FAIL:", err.message);
} finally {
  const cleanup = await openSession();
  try {
    const leftovers = (await prefixedTasks(cleanup)).filter(t => t.state !== -1);
    for (const t of leftovers) await cleanup.call("deleteTask", t.id);
    await cleanup.syncAndWait(leftovers.map(t => t.id));
  } finally {
    cleanup.close();
  }
}
process.exit(failed ? 1 : 0);
```

- [ ] **Step 4: Add scripts to `package.json`**

In `"scripts"`, add after `"test:unit"`:

```json
    "test:e2e": "FOCUS_TODO_E2E=1 node scripts/e2e.mjs",
```

- [ ] **Step 5: Run unit tests**

Run: `npm run test:unit`
Expected: all pass, `ℹ fail 0`

- [ ] **Step 6: Run the end-to-end check** (dedicated Focus To-Do window open and logged in)

Run: `npm run test:e2e`
Expected: `PASS: complete, skip and remove-duplicate work end to end`, exit code 0. Afterwards, no task whose name starts with `MCP-E2E-` is active in the Focus To-Do window. If a pomodoro is running the window is not reloaded; that is expected.

- [ ] **Step 7: Check tools/list over stdio**

Run the same command as Task 4 Step 7.
Expected: `list_projects,list_tasks,search_tasks,get_task,list_subtasks,get_pomodoro_stats,find_duplicate_tasks,complete_tasks,skip_occurrences,remove_duplicate_tasks`

- [ ] **Step 8: Commit**

```bash
git add bridge.mjs index.mjs scripts/e2e.mjs package.json
git commit -m "feat: drive Focus To-Do services over CDP and expose write tools

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Launcher, engines and README

**Files:**
- Create: `scripts/setup-launcher.mjs`
- Test: `scripts/setup-launcher.test.mjs`
- Modify: `package.json` (`engines`, `setup:launcher` script), `README.md`

**Interfaces:**
- Consumes: `getConfig`, `EXTENSION_ID` (Task 2), `resolveChromePath`, `buildLaunchArgs` (Task 7)
- Produces: `buildDesktopEntry({ chromePath, args, icon }): string`

- [ ] **Step 1: Write the failing test** — `scripts/setup-launcher.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDesktopEntry } from "./setup-launcher.mjs";

test("desktop entry quotes arguments with spaces and sets the window class", () => {
  const entry = buildDesktopEntry({
    chromePath: "/opt/google/chrome/chrome",
    args: ["--user-data-dir=/home/u/My Data", "--remote-debugging-port=9222"],
    icon: "/home/u/logo128.png",
  });
  assert.match(entry, /^\[Desktop Entry\]$/m);
  assert.match(entry, /^Exec=\/opt\/google\/chrome\/chrome "--user-data-dir=\/home\/u\/My Data" --remote-debugging-port=9222$/m);
  assert.match(entry, /^Icon=\/home\/u\/logo128\.png$/m);
  assert.match(entry, /^StartupWMClass=chrome-ngceodoilcgpmkijopinlkmohnfifjfb-Default$/m);
});

test("desktop entry omits Icon when none is found", () => {
  assert.doesNotMatch(buildDesktopEntry({ chromePath: "/c", args: [], icon: null }), /^Icon=/m);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:unit`
Expected: FAIL — `Cannot find module '.../setup-launcher.mjs'`

- [ ] **Step 3: Create `scripts/setup-launcher.mjs`**

```js
// Writes a Linux .desktop launcher that opens Focus To-Do in the dedicated Chrome instance
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { EXTENSION_ID, getConfig } from "../config.mjs";
import { resolveChromePath, buildLaunchArgs } from "../browser.mjs";

// Desktop Entry spec: quote arguments containing reserved characters
function quoteExec(arg) {
  return /[\s"'\\$`]/.test(arg) ? `"${arg.replace(/(["\\$`])/g, "\\$1")}"` : arg;
}

export function buildDesktopEntry({ chromePath, args, icon }) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Focus To-Do",
    "Comment=Focus To-Do in the dedicated Chrome instance used by focus-todo-mcp",
    `Exec=${[chromePath, ...args].map(quoteExec).join(" ")}`,
    icon ? `Icon=${icon}` : null,
    `StartupWMClass=chrome-${EXTENSION_ID}-Default`,
    "Categories=Utility;",
    "Terminal=false",
    "",
  ].filter(line => line !== null).join("\n");
}

function findIcon(userDataDir) {
  const dir = join(userDataDir, "Default", "Extensions", EXTENSION_ID);
  if (!existsSync(dir)) return null;
  for (const version of readdirSync(dir).sort().reverse()) {
    const icon = join(dir, version, "images", "logo128.png");
    if (existsSync(icon)) return icon;
  }
  return null;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = getConfig();
  const chromePath = resolveChromePath(config);
  if (!chromePath) {
    console.error("Chrome not found. Set FOCUS_TODO_CHROME_PATH to the Chrome executable.");
    process.exit(1);
  }
  const appsDir = join(homedir(), ".local", "share", "applications");
  mkdirSync(appsDir, { recursive: true });
  const file = join(appsDir, "focus-todo.desktop");
  writeFileSync(file, buildDesktopEntry({ chromePath, args: buildLaunchArgs(config), icon: findIcon(config.userDataDir) }));
  console.log(`Launcher written to ${file}`);
}
```

- [ ] **Step 4: Update `package.json`**

Change `"engines": { "node": ">=18" }` to `"engines": { "node": ">=22" }` and add to `"scripts"`:

```json
    "setup:launcher": "node scripts/setup-launcher.mjs",
```

- [ ] **Step 5: Update `README.md`**

1. Requirements: change `- Node.js 18+` to `- Node.js 22+`.
2. In "Tools", replace the table with:

```markdown
### Read tools (read-only)

| Tool | Description |
|------|-------------|
| `list_projects` | List all projects (hides system projects by default) |
| `list_tasks` | List tasks filtered by project and status (`active`/`overdue`/`completed`/`all`, using the app's rules) |
| `search_tasks` | Search tasks by name |
| `get_task` | Get full task details including subtasks |
| `list_subtasks` | List subtasks for a task |
| `get_pomodoro_stats` | Pomodoro statistics by day for the last N days |
| `find_duplicate_tasks` | Find duplicate occurrences of recurring tasks (same series, same day) |

### Write tools (require the dedicated Chrome instance)

| Tool | Description |
|------|-------------|
| `complete_tasks` | Complete tasks; recurring tasks get their next occurrence |
| `skip_occurrences` | Skip the current occurrence of recurring tasks without counting it as done |
| `remove_duplicate_tasks` | Delete extra copies found by `find_duplicate_tasks`; the kept copy is never deleted |

Every write asks for confirmation (a form in Claude Code; a preview plus `confirmed: true` in clients without forms) and syncs to the Focus To-Do cloud through the app itself.
```

3. Add a new section after "Auto-detection & Custom Path":

```markdown
## Write setup: dedicated Chrome instance (Linux)

Writes go through the Focus To-Do extension's own code via the Chrome DevTools Protocol. Chrome 136+ refuses remote debugging on your default Chrome profile, so Focus To-Do runs in a separate Chrome instance:

1. Start it once:
   `google-chrome --user-data-dir="$HOME/.config/focustodo-chrome" --remote-debugging-port=9222`
2. Install the Focus To-Do extension from the Chrome Web Store in that window and log in.
3. Wait for the first sync. Large accounts take a few minutes and the app shows no progress.
4. Run `npm run setup:launcher` to add a "Focus To-Do" launcher that opens it as an app window, and use that window from now on.

When a write is requested and this instance is closed, the server opens it. The server also reads from this instance's database when it exists.

Environment variables: `FOCUS_TODO_USER_DATA_DIR` (default `~/.config/focustodo-chrome`), `FOCUS_TODO_CDP_PORT` (default `9222`), `FOCUS_TODO_CHROME_PATH`.

**Security:** the debugging port listens on localhost only, but any local process can control this Chrome instance. Keep only Focus To-Do in it: no Google account and no other logins.

**Duplicates:** running Focus To-Do in several clients at once (other Chrome profiles, other devices) appears to create duplicate occurrences of recurring tasks. Using a single desktop client reduces them; `find_duplicate_tasks` and `remove_duplicate_tasks` clean them up.
```

4. In "Notes", replace `- The server opens database files in read-only mode and never modifies your data.` with `- Reads open database files in read-only mode. Writes happen only through the write tools, inside the Focus To-Do app, after your confirmation.`
5. In "How it works", replace the line `2. Reads the LevelDB SSTable ...` list intro sentence `This server:` with `For reads, this server:` (keep the numbered list), and add after the list: `For writes, it connects to the dedicated Chrome instance over the DevTools Protocol, locates the app's task and sync services, and calls them, so recurrence and cloud sync behave exactly as in the app.`

- [ ] **Step 6: Run all checks**

Run: `npm run test:unit && npm test`
Expected: unit tests all pass (`ℹ fail 0`); smoke test prints task counts.

- [ ] **Step 7: Install the launcher on this machine**

Run: `npm run setup:launcher`
Expected: `Launcher written to ~/.local/share/applications/focus-todo.desktop`

- [ ] **Step 8: Commit**

```bash
git add scripts/setup-launcher.mjs scripts/setup-launcher.test.mjs package.json README.md
git commit -m "feat: add launcher setup and document write tools

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
