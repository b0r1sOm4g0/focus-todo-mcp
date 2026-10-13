// Writes a Linux .desktop launcher that opens Focus To-Do in the dedicated Chrome instance.
// The MCP server also uses it (via gtk-launch) to open that instance when a write needs it.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { pathToFileURL } from "url";
import { EXTENSION_ID, getConfig, launcherPath } from "../config.mjs";
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
  const file = launcherPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, buildDesktopEntry({ chromePath, args: buildLaunchArgs(config), icon: findIcon(config.userDataDir) }));
  console.log(`Launcher written to ${file}`);
}
