# focus-todo-mcp

MCP server that reads your [Focus To-Do](https://www.focustodo.cn/) data directly from your local database (Windows app or Chrome Extension on Linux/Pop!_OS/macOS) — no account login, no API key, no export needed.

## What it does

Exposes your Focus To-Do tasks, projects, subtasks and Pomodoro sessions to Claude (or any MCP-compatible client) by parsing the app's IndexedDB (Chrome LevelDB format) stored locally.

## Requirements

- **Linux (Pop!_OS, Debian, Ubuntu, etc.)**, **macOS**, or **Windows**
- **Focus To-Do** installed via:
  - Chrome Extension (`ngceodoilcgpmkijopinlkmohnfifjfb`) in Chrome, Chromium, Brave, Edge, Vivaldi (standard, Flatpak, or Snap)
  - Microsoft Store App (Windows UWP)
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

## Auto-detection & Custom Path

The server automatically detects your Focus To-Do database across:
- **Linux (Pop!_OS / Debian / Ubuntu)**: `~/.config/google-chrome/<Profile>/IndexedDB/chrome-extension_ngceodoilcgpmkijopinlkmohnfifjfb_0.indexeddb.leveldb` (as well as Chromium, Brave, Edge, Vivaldi, Flatpak, and Snap profiles)
- **Windows**: Microsoft Store App (%LOCALAPPDATA%\Packages) or Chrome Extension profiles
- **macOS**: `~/Library/Application Support/Google/Chrome/<Profile>/IndexedDB/...`

If you use a non-standard browser profile path, override auto-detection with:

```bash
FOCUS_TODO_IDB_PATH="/path/to/IndexedDB/chrome-extension_ngceodoilcgpmkijopinlkmohnfifjfb_0.indexeddb.leveldb" node index.mjs
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

Focus To-Do (both the Windows app and the Chrome extension) stores data in IndexedDB (Chrome's LevelDB format). This server:

1. Auto-detects the active LevelDB path for Windows UWP or Chrome Extension profiles
2. Reads the LevelDB SSTable (`.ldb`) files and Write-Ahead Log (`.log`) directly in read-only mode
3. Parses Chrome IndexedDB key prefixes to extract object store records
4. Decodes values using Node.js's `v8.deserialize` with automatic V8 header patch for modern Chrome versions
5. Caches data in memory for 30 seconds to avoid re-reading on every tool call

**Object stores read:**
- `os1` → Projects
- `os2` → Tasks
- `os3` → Subtasks
- `os4` → Pomodoro sessions

## Notes

- The server opens database files in read-only mode and never modifies your data.
- Data is read directly from disk, reflecting the last state flushed by Chrome/Focus To-Do.

## License

MIT

