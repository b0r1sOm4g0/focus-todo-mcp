import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createRequire } from "module";
import v8 from "v8";

const require = createRequire(import.meta.url);
const snappy = require("snappy");

const FOCUS_TODO_EXTENSION_ID = "ngceodoilcgpmkijopinlkmohnfifjfb";

// Auto-detect the Focus To-Do database path (Windows UWP app or Chrome extension on Linux/macOS/Windows).
// Override with FOCUS_TODO_IDB_PATH env var for non-standard installations.
export function findIDBPath() {
  if (process.env.FOCUS_TODO_IDB_PATH) {
    if (!existsSync(process.env.FOCUS_TODO_IDB_PATH)) {
      throw new Error(`Configured FOCUS_TODO_IDB_PATH does not exist: ${process.env.FOCUS_TODO_IDB_PATH}`);
    }
    return process.env.FOCUS_TODO_IDB_PATH;
  }

  const home = homedir();

  // 1. Check Windows UWP App (Microsoft Store)
  if (process.env.LOCALAPPDATA) {
    const packagesDir = join(process.env.LOCALAPPDATA, "Packages");
    try {
      const match = readdirSync(packagesDir).find(d => d.startsWith("52299SuperElement."));
      if (match) {
        const uwpPath = join(packagesDir, match, "LocalState", "EBWebView", "Default", "IndexedDB", "file__0.indexeddb.leveldb");
        if (existsSync(uwpPath)) return uwpPath;
      }
    } catch {}
  }

  // 2. Check Chrome Extension and Web App IndexedDB paths across browser profiles (Linux, macOS, Windows)
  const browserConfigs = [
    // Linux ~/.config
    join(home, ".config", "google-chrome"),
    join(home, ".config", "chromium"),
    join(home, ".config", "BraveSoftware", "Brave-Browser"),
    join(home, ".config", "microsoft-edge"),
    join(home, ".config", "vivaldi"),
    // Linux Flatpak
    join(home, ".var", "app", "com.google.Chrome", "config", "google-chrome"),
    join(home, ".var", "app", "org.chromium.Chromium", "config", "chromium"),
    // Linux Snap
    join(home, "snap", "google-chrome", "common", ".config", "google-chrome"),
    join(home, "snap", "chromium", "common", ".config", "chromium"),
    // macOS
    join(home, "Library", "Application Support", "Google", "Chrome"),
    join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser"),
    join(home, "Library", "Application Support", "Microsoft Edge"),
    // Windows Chrome / Browser User Data
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "User Data") : null,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "BraveSoftware", "Brave-Browser", "User Data") : null,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "User Data") : null,
  ].filter(Boolean);

  const targetDBs = [
    `chrome-extension_${FOCUS_TODO_EXTENSION_ID}_0.indexeddb.leveldb`,
    `https_www.focustodo.cn_0.indexeddb.leveldb`,
    `https_app.focustodo.cn_0.indexeddb.leveldb`,
  ];

  for (const bDir of browserConfigs) {
    if (!existsSync(bDir)) continue;
    let profiles = [];
    try {
      profiles = readdirSync(bDir).filter(p => p === "Default" || p.startsWith("Profile "));
    } catch {
      continue;
    }
    for (const prof of profiles) {
      for (const targetDB of targetDBs) {
        const idbPath = join(bDir, prof, "IndexedDB", targetDB);
        if (existsSync(idbPath)) return idbPath;
      }
    }
  }

  throw new Error(
    "Focus To-Do database path not found.\n" +
    "Ensure Focus To-Do (Windows app or Chrome Extension) is installed and has been opened at least once.\n" +
    "You can also set the FOCUS_TODO_IDB_PATH environment variable to specify the directory path manually."
  );
}

// Object store IDs
export const STORE = { PROJECTS: 1, TASKS: 2, SUBTASKS: 3, POMODOROS: 4, GROUPS: 6, GROUP_USERS: 7 };

// ── LevelDB SSTable parsing ──────────────────────────────────────────────────

function readVarInt(buf, off) {
  let result = 0, shift = 0;
  while (off < buf.length) {
    const b = buf[off++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { value: result, off };
}

function readBlockHandle(buf, off) {
  const o = readVarInt(buf, off);
  const s = readVarInt(buf, o.off);
  return { blockOffset: o.value, blockSize: s.value, offset: s.off };
}

function readBlock(file, offset, size) {
  const raw = file.subarray(offset, offset + size);
  const type = file[offset + size];
  if (type === 1) { try { return snappy.uncompressSync(raw); } catch {} }
  return raw;
}

function parseDataBlock(buf) {
  if (buf.length < 4) return [];
  const numRestarts = buf.readUInt32LE(buf.length - 4);
  const dataEnd = buf.length - 4 - numRestarts * 4;
  if (dataEnd < 0) return [];
  const entries = []; let pos = 0, curKey = Buffer.alloc(0);
  while (pos < dataEnd) {
    let r = readVarInt(buf, pos); const sh = r.value; pos = r.off;
    r = readVarInt(buf, pos); const un = r.value; pos = r.off;
    r = readVarInt(buf, pos); const vl = r.value; pos = r.off;
    if (pos + un + vl > dataEnd) break;
    const kd = buf.subarray(pos, pos + un); pos += un;
    curKey = Buffer.concat([curKey.subarray(0, sh), kd]);
    const val = buf.subarray(pos, pos + vl); pos += vl;
    entries.push({ key: Buffer.from(curKey), value: Buffer.from(val) });
  }
  return entries;
}

function parseSSTFile(filepath) {
  const data = readFileSync(filepath);
  if (data.length < 48) return [];
  const footer = data.subarray(data.length - 48);
  const metaH = readBlockHandle(footer, 0);
  const idxH = readBlockHandle(footer, metaH.offset);
  const idxRaw = readBlock(data, idxH.blockOffset, idxH.blockSize);
  const indexEntries = parseDataBlock(idxRaw);
  const entries = [];
  for (const ie of indexEntries) {
    const bh = readBlockHandle(ie.value, 0);
    entries.push(...parseDataBlock(readBlock(data, bh.blockOffset, bh.blockSize)));
  }
  return entries;
}

// ── WAL parsing ──────────────────────────────────────────────────────────────

const BLOCK_SIZE = 32768;

function parseWAL(filepath) {
  const data = readFileSync(filepath);
  const entries = [];
  let pos = 0;
  const pendingFragments = [];

  while (pos + 7 <= data.length) {
    // Detect block padding (all zeros)
    if (data[pos] === 0 && data[pos + 1] === 0 && data[pos + 2] === 0 && data[pos + 3] === 0) {
      const nextBlock = (Math.floor(pos / BLOCK_SIZE) + 1) * BLOCK_SIZE;
      pos = nextBlock;
      continue;
    }

    const length = data.readUInt16LE(pos + 4);
    const type = data[pos + 6];
    pos += 7;

    if (length === 0 || pos + length > data.length) break;
    const payload = data.subarray(pos, pos + length);
    pos += length;

    if (type === 1) { // FULL record
      processBatch(payload, entries);
    } else if (type === 2) { // FIRST
      pendingFragments.length = 0;
      pendingFragments.push(payload);
    } else if (type === 3) { // MIDDLE
      pendingFragments.push(payload);
    } else if (type === 4) { // LAST
      pendingFragments.push(payload);
      processBatch(Buffer.concat(pendingFragments), entries);
      pendingFragments.length = 0;
    }
  }
  return entries;
}

function processBatch(batch, entries) {
  if (batch.length < 12) return;
  const count = batch.readUInt32LE(8);
  let off = 12;
  for (let i = 0; i < count && off < batch.length; i++) {
    const opType = batch[off++];
    let r = readVarInt(batch, off); const kLen = r.value; off = r.off;
    if (off + kLen > batch.length) break;
    const key = batch.subarray(off, off + kLen); off += kLen;
    if (opType === 1) { // Put
      r = readVarInt(batch, off); const vLen = r.value; off = r.off;
      if (off + vLen > batch.length) break;
      const val = batch.subarray(off, off + vLen); off += vLen;
      entries.push({ key: Buffer.from(key), value: Buffer.from(val) });
    }
  }
}

// ── IDB key decoding ──────────────────────────────────────────────────────────

function decodeKeyPrefix(key) {
  if (key.length < 3 || key[0] !== 0x00) return null;
  let off = 1;
  function readIDBVarInt() {
    if (off >= key.length) return 0;
    const b1 = key[off++]; let v = b1 & 0x7f;
    if (b1 & 0x80) { if (off >= key.length) return v; const b2 = key[off++]; v |= (b2 & 0x7f) << 7; if (b2 & 0x80) { if (off >= key.length) return v; const b3 = key[off++]; v |= b3 << 14; } }
    return v;
  }
  const dbId = readIDBVarInt(), osId = readIDBVarInt(), indexId = readIDBVarInt();
  return { dbId, osId, indexId };
}

// ── Value decoding ────────────────────────────────────────────────────────────

const nodeV8Ver = v8.serialize({})[1];

function decodeValue(val) {
  if (!val || val.length < 4) return null;
  // Find the last 0xff in the first 25 bytes (V8 magic), then deserialize
  for (let i = Math.min(val.length - 2, 24); i >= 0; i--) {
    if (val[i] === 0xff) {
      let buf = val.subarray(i + 1);
      if (buf.length >= 1 && buf[0] > nodeV8Ver) {
        buf = Buffer.from(buf);
        buf[0] = nodeV8Ver;
      }
      try { return v8.deserialize(buf); } catch {}

      buf = val.subarray(i);
      if (buf.length >= 2 && buf[1] > nodeV8Ver) {
        buf = Buffer.from(buf);
        buf[1] = nodeV8Ver;
      }
      try { return v8.deserialize(buf); } catch {}
    }
  }
  return null;
}

// ── Main loader ───────────────────────────────────────────────────────────────

export function loadAllData(idbPath = findIDBPath()) {
  const stores = new Map(); // osId -> Map<id, record>
  for (const id of Object.values(STORE)) stores.set(id, new Map());

  function processEntry({ key, value }) {
    const prefix = decodeKeyPrefix(key);
    if (!prefix || prefix.indexId !== 1) return; // only primary data
    const store = stores.get(prefix.osId);
    if (!store) return;
    const decoded = decodeValue(value);
    if (!decoded || typeof decoded !== "object" || !decoded.id) return;
    store.set(decoded.id, decoded);
  }

  // 1. SST files (historical)
  const ldbFiles = readdirSync(idbPath).filter(f => f.endsWith(".ldb")).sort();
  for (const f of ldbFiles) {
    try {
      for (const e of parseSSTFile(join(idbPath, f))) processEntry(e);
    } catch {}
  }

  // 2. WAL (recent mutations — override SST data)
  const logFiles = readdirSync(idbPath).filter(f => f.endsWith(".log")).sort();
  for (const f of logFiles) {
    try {
      for (const e of parseWAL(join(idbPath, f))) processEntry(e);
    } catch {}
  }

  return {
    projects: stores.get(STORE.PROJECTS),
    tasks: stores.get(STORE.TASKS),
    subtasks: stores.get(STORE.SUBTASKS),
    pomodoros: stores.get(STORE.POMODOROS),
  };
}
