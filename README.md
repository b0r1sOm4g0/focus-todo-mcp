# ⏱️ Focus To-Do MCP Server

[![MCP Protocol](https://img.shields.io/badge/MCP-Protocol-blue.svg)](https://modelcontextprotocol.io)
[![Official Skill](https://img.shields.io/badge/Official%20Skill-Focus%20OS%20($19)-orange.svg)](https://wisetools.gumroad.com/l/focus-os-sprint-planner)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

> 🧠 **Supercharge with Focus OS:** Take this MCP server beyond raw database access. Transform Claude, Cursor, and AI agents into your autonomous Chief of Staff with the official **[Focus OS — Autonomous Sprint & Pomodoro Planner Skill](https://wisetools.gumroad.com/l/focus-os-sprint-planner)** by Wise Tools (Eisenhower prioritization, 8-pomodoro daily budgets, and automated backlog grooming).

MCP server that connects your local [Focus To-Do](https://www.focustodo.cn/) database (Windows app or Chrome Extension on Linux/macOS) directly to Claude, Cursor, and MCP clients — no account login, no API key, no export needed.
## What it does

Exposes your Focus To-Do tasks, projects, subtasks and Pomodoro sessions to Claude (or any MCP-compatible client) by parsing the app's IndexedDB (Chrome LevelDB format) stored locally.

## Requirements

- **Linux (Pop!_OS, Debian, Ubuntu, etc.)**, **macOS**, or **Windows**
- **Focus To-Do** installed via:
  - Chrome Extension (`ngceodoilcgpmkijopinlkmohnfifjfb`) in Chrome, Chromium, Brave, Edge, Vivaldi (standard, Flatpak, or Snap)
  - Microsoft Store App (Windows UWP)
- Node.js 22+

## Installation

```bash
git clone https://github.com/b0r1sOm4g0/focus-todo-mcp
cd focus-todo-mcp
npm install
```

## Setup with Claude Code

```bash
claude mcp add --scope user focus-todo node "/path/to/focus-todo-mcp/index.mjs"
```

Then restart Claude Code.

## Auto-detection & Custom Path

The server automatically detects your Focus To-Do database across:
- **Linux (Pop!_OS / Debian / Ubuntu)**: `~/.config/google-chrome/<Profile>/IndexedDB/chrome-extension_ngceodoilcgpmkijopinlkmohnfifjfb_0.indexeddb.leveldb` (as well as Chromium, Brave, Edge, Vivaldi, Flatpak, and Snap profiles)
- **Windows**: Microsoft Store App (%LOCALAPPDATA%\Packages) or Chrome Extension profiles
- **macOS**: `~/Library/Application Support/Google/Chrome/<Profile>/IndexedDB/...`

If you use a non-standard browser profile path, override auto-detection with:

```bash
FOCUS_TODO_IDB_PATH="/path/to/IndexedDB/chrome-extension_ngceodoilcgpmkijopinlkmohnfifjfb_0.indexeddb.leveldb" node index.mjs
```

## Write setup: dedicated Chrome instance (Linux)

Writes go through the Focus To-Do extension's own code via the Chrome DevTools Protocol. Chrome 136+ refuses remote debugging on your default Chrome profile, so Focus To-Do runs in a separate Chrome instance:

1. Start it once:
   `google-chrome --user-data-dir="$HOME/.config/focustodo-chrome" --remote-debugging-port=9222`
2. Install the Focus To-Do extension from the Chrome Web Store in that window and log in.
3. Wait for the first sync. Large accounts take a few minutes and the app shows no progress.
4. Run `npm run setup:launcher` to add a "Focus To-Do" launcher that opens it as an app window, and use that window from now on.

With the launcher installed, a write opens the instance (via `gtk-launch`) when it is closed. The server also reads from this instance's database when it exists. After a write, the window is reloaded only when no pomodoro is running or paused.

Environment variables: `FOCUS_TODO_USER_DATA_DIR` (default `~/.config/focustodo-chrome`), `FOCUS_TODO_CDP_PORT` (default `9222`), `FOCUS_TODO_CHROME_PATH`.

**Security:** the debugging port listens on localhost only, but any local process can control this Chrome instance. Keep only Focus To-Do in it: no Google account and no other logins. On Linux the server refuses a debug port held by another user's process.

**Duplicates:** running Focus To-Do in several clients at once (other Chrome profiles, other devices) appears to create duplicate occurrences of recurring tasks. Using a single desktop client reduces them; `find_duplicate_tasks` and `remove_duplicate_tasks` clean them up.

## Tools

### Read tools (read-only)

| Tool | Description |
|------|-------------|
| `list_projects` | List all projects and tags (hides system projects by default, includes `isTag` indicator) |
| `list_tasks` | List tasks filtered by project and status (`active`/`overdue`/`completed`/`all`, using the app's rules) |
| `search_tasks` | Search tasks by name, notes (remark), or tag names |
| `get_task` | Get full task details including subtasks, total focus time, and recent pomodoros |
| `list_subtasks` | List subtasks for a task |
| `get_pomodoro_stats` | Pomodoro statistics by day for the last N days |
| `get_today_focus` | Daily overview: today's focus time, pomodoros completed (with task breakdown), due today, and overdue |
| `find_duplicate_tasks` | Find duplicate occurrences of recurring tasks (same series, same day) |

### Write tools (require the dedicated Chrome instance)

| Tool | Description |
|------|-------------|
| `create_task` | Create a new task, optionally with deadline, priority, project, notes, and recurrence |
| `update_task` | Update fields of an existing task (name, project, priority, deadline, notes, estimated pomodoros) |
| `delete_tasks` | Soft-delete one or more tasks (`state: -1`) |
| `complete_tasks` | Complete tasks; recurring tasks get their next occurrence unless the series already has one |
| `uncomplete_tasks` | Reopen previously completed tasks (`isFinished: false`) |
| `skip_occurrences` | Skip the current occurrence of recurring tasks without counting it as done |
| `remove_duplicate_tasks` | Delete extra copies found by `find_duplicate_tasks`; the kept copy is never deleted |
| `create_subtask` | Add a new subtask to an existing task (sets `hasSubtask` on parent) |
| `update_subtask` | Update a subtask (rename, complete/reopen, delete, or update estimated pomodoros) |
| `create_project` | Create a new project list or tag (optionally with hex color) |
Every write is confirmed by you in a form (MCP elicitation, supported by Claude Code). Clients without confirmation forms can read but cannot write, so approval never rests with the model. Changes sync to the Focus To-Do cloud through the app itself.

## How it works

Focus To-Do (both the Windows app and the Chrome extension) stores data in IndexedDB (Chrome's LevelDB format). For reads, this server:

1. Auto-detects the active LevelDB path for Windows UWP or Chrome Extension profiles
2. Reads the LevelDB SSTable (`.ldb`) files and Write-Ahead Log (`.log`) directly in read-only mode
3. Parses Chrome IndexedDB key prefixes to extract object store records
4. Decodes values using Node.js's `v8.deserialize` with automatic V8 header patch for modern Chrome versions
5. Caches data in memory for 30 seconds to avoid re-reading on every tool call

For writes, it connects to the dedicated Chrome instance over the DevTools Protocol, locates the app's task and sync services, and calls them, so recurrence and cloud sync behave exactly as in the app.

**Object stores read:**
- `os1` → Projects
- `os2` → Tasks
- `os3` → Subtasks
- `os4` → Pomodoro sessions

## Notes

- Reads open database files in read-only mode. Writes happen only through the write tools, inside the Focus To-Do app, after your confirmation.
- Data is read directly from disk, reflecting the last state flushed by Chrome/Focus To-Do.

## 🏛️ Ecosystem & Commercial Skills

Maintained with ❤️ by **Wise Tools**.  
Explore our production-grade MCP skills and automation toolkits at **[wisetools.gumroad.com](https://wisetools.gumroad.com)**.

## License

MIT
