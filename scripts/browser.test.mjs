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
