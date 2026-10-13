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
