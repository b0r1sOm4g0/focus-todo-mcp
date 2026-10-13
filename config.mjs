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
