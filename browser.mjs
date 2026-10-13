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

// cmd is resolveChromePath()'s result (FOCUS_TODO_CHROME_PATH or a fixed candidate list, checked to
// exist); args come from buildLaunchArgs(). argv array, no shell, so nothing is interpreted.
function defaultLaunch(cmd, args) {
  // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
  spawn(cmd, args, { detached: true, stdio: "ignore", shell: false }).unref();
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
