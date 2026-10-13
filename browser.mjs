// Find or launch the dedicated Chrome instance and locate the Focus To-Do page
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { EXTENSION_ID, getConfig, launcherPath } from "./config.mjs";

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

// Opens the launcher written by `npm run setup:launcher`; fixed argv, no shell
function defaultLaunch() {
  spawn("gtk-launch", ["focus-todo"], { detached: true, stdio: "ignore", shell: false }).unref();
}

// Linux: refuse a debug port held by another user's process (port squatting)
export function checkPortOwner(port, { read = path => readFileSync(path, "utf8"), uid = process.getuid?.() } = {}) {
  if (uid === undefined) return;
  let table;
  try { table = read("/proc/net/tcp"); } catch { return; } // not Linux
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  const owners = table.split("\n").slice(1)
    .map(line => line.trim().split(/\s+/))
    .filter(f => f.length > 7 && f[1].endsWith(`:${hexPort}`) && f[3] === "0A")
    .map(f => Number(f[7]));
  const foreign = owners.find(o => o !== uid);
  if (foreign !== undefined) {
    throw new Error(`Port ${port} is held by another user's process (uid ${foreign}); refusing to connect. Stop that process or set FOCUS_TODO_CDP_PORT.`);
  }
}

async function fetchJSON(url, timeoutMs = 2000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

export async function ensureBrowser({
  config = getConfig(), launch = defaultLaunch, launcherExists = () => existsSync(launcherPath()),
  checkOwner = checkPortOwner, timeoutMs = 20_000, pollMs = 250,
} = {}) {
  const base = `http://127.0.0.1:${config.cdpPort}`;
  const answers = async () => { try { await fetchJSON(`${base}/json/version`); return true; } catch { return false; } };

  if (!(await answers())) {
    if (!launcherExists()) {
      throw new Error("The dedicated Focus To-Do Chrome is not running and no launcher is installed. Open it manually, or run `npm run setup:launcher` once so it can be opened automatically.");
    }
    await launch();
    const deadline = Date.now() + timeoutMs;
    let up = false;
    while (!up && Date.now() < deadline) {
      await sleep(pollMs);
      up = await answers();
    }
    if (!up) {
      throw new Error(
        `Chrome was started but port ${config.cdpPort} did not respond within ${timeoutMs / 1000}s. ` +
        `If a Chrome window is already using ${config.userDataDir} without --remote-debugging-port, close it and try again.`
      );
    }
  }
  checkOwner(config.cdpPort);
  return base;
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
  const expected = `${base.replace(/^http:/, "ws:")}/devtools/page/`;
  if (!target.webSocketDebuggerUrl?.startsWith(expected)) {
    throw new Error(`Refusing unexpected debugger URL ${target.webSocketDebuggerUrl}; expected ${expected}…`);
  }
  return target;
}
