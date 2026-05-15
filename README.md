# focus-todo-mcp

MCP server that reads your [Focus To-Do](https://www.focustodo.cn/) data directly from the local Windows app database — no account, no API key, no export needed.

## What it does

Exposes your Focus To-Do tasks, projects, subtasks and Pomodoro sessions to Claude (or any MCP-compatible client) by parsing the app's IndexedDB (Chrome LevelDB format) stored locally on Windows.

## Requirements

- Windows with [Focus To-Do](https://apps.microsoft.com/detail/9nksqgp7f2nh) installed from the Microsoft Store
- Node.js 18+

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

## Custom path

By default the server auto-detects the Focus To-Do package in `%LOCALAPPDATA%\Packages`. If needed, override with:

```bash
FOCUS_TODO_IDB_PATH="C:\path\to\IndexedDB\file__0.indexeddb.leveldb" node index.mjs
```

## Tools

| Tool | Description |
|------|-------------|
| `list_projects` | List all projects (hides system projects by default) |
| `list_tasks` | List tasks filtered by project, status (`active`/`completed`/`all`) |
| `search_tasks` | Search tasks by name |
| `get_task` | Get full task details including subtasks |
| `list_subtasks` | List subtasks for a task |
| `get_pomodoro_stats` | Pomodoro statistics by day for the last N days |

## How it works

Focus To-Do on Windows is built with a Chromium WebView and stores all data in IndexedDB (Chrome's LevelDB format). This server:

1. Reads the LevelDB SSTable (`.ldb`) files and Write-Ahead Log (`.log`) directly
2. Parses the Chrome IndexedDB key prefix encoding to identify object stores
3. Decodes values using Node.js's `v8.deserialize` after skipping the Blink serialization header
4. Caches data in memory for 30 seconds to avoid re-reading on every tool call

**Object stores read:**
- `os1` → Projects
- `os2` → Tasks
- `os3` → Subtasks
- `os4` → Pomodoro sessions

## Notes

- The app must be installed from the Microsoft Store (UWP). Other install methods may use a different storage path.
- The server opens files in read-only mode and never modifies the database.
- Data is read from disk, so it reflects the last time the app flushed to disk (usually within seconds).

## License

MIT
