import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "http";
import { resolveChromePath, buildLaunchArgs, ensureBrowser, checkPortOwner, findExtensionTarget, EXTENSION_URL } from "../browser.mjs";

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

const noCheck = () => {};

test("ensureBrowser does not launch when the port already answers", async () => {
  const server = await fakeDevtools();
  try {
    let launched = false;
    const base = await ensureBrowser({ config: cfg(server.address().port), launch: () => { launched = true; }, checkOwner: noCheck });
    assert.equal(base, `http://127.0.0.1:${server.address().port}`);
    assert.equal(launched, false);
  } finally { server.close(); }
});

test("ensureBrowser checks who owns the port before trusting it", async () => {
  const server = await fakeDevtools();
  try {
    await assert.rejects(
      ensureBrowser({ config: cfg(server.address().port), launch: () => {}, checkOwner: () => { throw new Error("held by another user"); } }),
      /another user/,
    );
  } finally { server.close(); }
});

test("ensureBrowser opens the launcher and waits for the port", async () => {
  const probe = await fakeDevtools();
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  let server, launched = 0;
  try {
    const base = await ensureBrowser({
      config: cfg(port),
      launcherExists: () => true,
      launch: async () => { launched++; server = await fakeDevtools(port); },
      checkOwner: noCheck,
      pollMs: 20,
    });
    assert.equal(base, `http://127.0.0.1:${port}`);
    assert.equal(launched, 1);
  } finally { server?.close(); }
});

test("ensureBrowser explains a missing launcher", async () => {
  const probe = await fakeDevtools();
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  await assert.rejects(
    ensureBrowser({ config: cfg(port), launcherExists: () => false, launch: () => {}, checkOwner: noCheck }),
    /npm run setup:launcher/,
  );
});

test("ensureBrowser gives up when the port never opens", async () => {
  const probe = await fakeDevtools();
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  await assert.rejects(
    ensureBrowser({ config: cfg(port), launcherExists: () => true, launch: () => {}, checkOwner: noCheck, timeoutMs: 200, pollMs: 20 }),
    /did not respond.*without --remote-debugging-port/s,
  );
});

const TCP = [
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  "   0: 0100007F:2406 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1424519 1",
  "  36: 0100007F:CACA 0100007F:2406 06 00000000:00000000 03:00000713 00000000     0        0 0 3",
].join("\n");

test("checkPortOwner accepts a listener owned by the current user", () => {
  checkPortOwner(9222, { read: () => TCP, uid: 1000 });
});

test("checkPortOwner rejects a listener owned by another user", () => {
  assert.throws(() => checkPortOwner(9222, { read: () => TCP, uid: 1001 }), /Port 9222 is held by another user's process \(uid 1000\)/);
});

test("checkPortOwner skips when /proc is unavailable", () => {
  checkPortOwner(9222, { read: () => { throw new Error("ENOENT"); }, uid: 1000 });
});

test("findExtensionTarget refuses a debugger URL outside this port", async () => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify([{ type: "page", url: EXTENSION_URL, webSocketDebuggerUrl: "ws://10.0.0.5:9222/devtools/page/X" }]));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(findExtensionTarget(`http://127.0.0.1:${server.address().port}`), /unexpected debugger URL/);
  } finally { server.close(); }
});

test("findExtensionTarget returns the extension page on this port", async () => {
  const server = createServer((req, res) => {
    const port = server.address().port;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify([{ type: "page", url: EXTENSION_URL, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/X` }]));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  try {
    const t = await findExtensionTarget(`http://127.0.0.1:${server.address().port}`);
    assert.match(t.webSocketDebuggerUrl, /\/devtools\/page\/X$/);
  } finally { server.close(); }
});
