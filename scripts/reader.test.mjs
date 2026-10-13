// Unit tests for reader.mjs using synthetic LevelDB files
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import v8 from "v8";
import { loadAllData } from "../reader.mjs";

const BLOCK_SIZE = 32768;
const HEADER_SIZE = 7;
const RECORD_FULL = 1;

function varint(n) {
  const out = [];
  while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
  return Buffer.from(out);
}

// Task store (os2) primary-data key: dbId=1, osId=2, indexId=1
function taskKey(id) {
  return Buffer.concat([Buffer.from([0x00, 0x01, 0x02, 0x01]), Buffer.from(id)]);
}

// WriteBatch with a single Put, zero-padded to exactly `size` bytes when given
function putBatch(key, value, size) {
  const batch = Buffer.concat([
    Buffer.alloc(8),                      // sequence number
    Buffer.from([1, 0, 0, 0]),            // count = 1
    Buffer.from([1]),                     // op = Put
    varint(key.length), key,
    varint(value.length), value,
  ]);
  if (size === undefined) return batch;
  assert.ok(batch.length <= size, "batch larger than requested size");
  return Buffer.concat([batch, Buffer.alloc(size - batch.length)]);
}

// Physical record; the checksum is never verified by the reader, but it must be
// non-zero so it cannot be mistaken for block padding
function record(payload) {
  const header = Buffer.alloc(HEADER_SIZE);
  header.fill(0xaa, 0, 4);
  header.writeUInt16LE(payload.length, 4);
  header[6] = RECORD_FULL;
  return Buffer.concat([header, payload]);
}

function withIDB(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), "focus-todo-idb-"));
  try {
    for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), data);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("reads WAL records that follow a block trailer shorter than a header", () => {
  const trailer = 3; // < HEADER_SIZE: LevelDB zero-fills it and starts the next block
  const first = record(putBatch(
    taskKey("A"),
    v8.serialize({ id: "A", name: "filler" }),
    BLOCK_SIZE - trailer - HEADER_SIZE,
  ));
  const second = record(putBatch(taskKey("B"), v8.serialize({ id: "B", name: "after trailer" })));
  const wal = Buffer.concat([first, Buffer.alloc(trailer), second]);
  assert.equal(wal.indexOf(second), BLOCK_SIZE);

  const { tasks } = withIDB({ "000001.log": wal }, dir => loadAllData(dir));

  assert.equal(tasks.get("A")?.name, "filler");
  assert.equal(tasks.get("B")?.name, "after trailer");
});
