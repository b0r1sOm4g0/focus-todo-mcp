// LevelDB reader for Focus To-Do IndexedDB data
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { createRequire } from "module";
import v8 from "v8";

const require = createRequire(import.meta.url);
const snappy = require("snappy");

// Auto-detect the Focus To-Do UWP package path.
// Override with FOCUS_TODO_IDB_PATH env var for non-standard installations.
export function findIDBPath() {
  if (process.env.FOCUS_TODO_IDB_PATH) return process.env.FOCUS_TODO_IDB_PATH;

  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("LOCALAPPDATA environment variable not found. Are you on Windows?");

  const packagesDir = join(localAppData, "Packages");
  let match;
  try {
    match = readdirSync(packagesDir).find(d => d.startsWith("52299SuperElement."));
  } catch {
    throw new Error(`Could not read ${packagesDir}`);
  }

  if (!match) throw new Error("Focus To-Do package not found in %LOCALAPPDATA%\\Packages. Is the app installed from the Microsoft Store?");

  const idbPath = join(packagesDir, match, "LocalState", "EBWebView", "Default", "IndexedDB", "file__0.indexeddb.leveldb");
  if (!existsSync(idbPath)) throw new Error(`IndexedDB path not found: ${idbPath}`);
  return idbPath;
}

export const IDB_PATH = findIDBPath();

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

function decodeValue(val) {
  if (!val || val.length < 4) return null;
  // Find the last 0xff in the first 25 bytes (V8 magic), then deserialize
  for (let i = Math.min(val.length - 2, 24); i >= 0; i--) {
    if (val[i] === 0xff) {
      try { return v8.deserialize(val.subarray(i + 1)); } catch {}
      try { return v8.deserialize(val.subarray(i)); } catch {}
    }
  }
  return null;
}

// ── Main loader ───────────────────────────────────────────────────────────────

export function loadAllData() {
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
  const ldbFiles = readdirSync(IDB_PATH).filter(f => f.endsWith(".ldb")).sort();
  for (const f of ldbFiles) {
    try {
      for (const e of parseSSTFile(join(IDB_PATH, f))) processEntry(e);
    } catch {}
  }

  // 2. WAL (recent mutations — override SST data)
  const logFiles = readdirSync(IDB_PATH).filter(f => f.endsWith(".log")).sort();
  for (const f of logFiles) {
    try {
      for (const e of parseWAL(join(IDB_PATH, f))) processEntry(e);
    } catch {}
  }

  return {
    projects: stores.get(STORE.PROJECTS),
    tasks: stores.get(STORE.TASKS),
    subtasks: stores.get(STORE.SUBTASKS),
    pomodoros: stores.get(STORE.POMODOROS),
  };
}
