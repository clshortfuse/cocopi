import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readSync, writeSync } from "node:fs";
import test from "node:test";
import { WorkerDeliveryBuffer } from "../lib/codex-api/worker-buffer.js";

/** @param {number} index */
const record = (index) => ({ type: /** @type {const} */ ("event"), event: { type: /** @type {const} */ ("response.output_text.delta"), delta: String(index) } });

test("backlog delivery does not shift the descriptor array per event", () => {
  const buffer = new WorkerDeliveryBuffer();
  let shifts = 0;
  const shift = buffer.queue.shift.bind(buffer.queue);
  buffer.queue.shift = () => { shifts += 1; return shift(); };
  try {
    for (let index = 0; index < 3000; index += 1) buffer.push(record(index));
    for (let index = 0; index < 3000; index += 1) assert.equal(buffer.shift(), JSON.stringify(record(index)));
    assert.equal(buffer.shift(), undefined);
    assert.equal(buffer.memoryBytes, 0);
    assert.equal(shifts, 0);
  } finally {
    buffer.dispose();
  }
});

test("record budget counts pending entries rather than already consumed entries", () => {
  const buffer = new WorkerDeliveryBuffer({ records: 3 });
  try {
    for (let index = 0; index < 3; index += 1) buffer.push(record(index));
    assert.throws(() => buffer.push(record(3)), /record budget/u);
    assert.equal(buffer.shift(), JSON.stringify(record(0)));
    buffer.push(record(3));
    assert.throws(() => buffer.push(record(4)), /record budget/u);
    for (let index = 1; index <= 3; index += 1) assert.equal(buffer.shift(), JSON.stringify(record(index)));
  } finally {
    buffer.dispose();
  }
});

test("cursor clearing releases consumed payloads and preserves order across compaction", () => {
  const buffer = new WorkerDeliveryBuffer();
  try {
    for (let index = 0; index < 5000; index += 1) buffer.push(record(index));
    const initialQueue = buffer.queue;
    assert.equal(buffer.shift(), JSON.stringify(record(0)));
    assert.equal(initialQueue[0], undefined);
    for (let index = 1; index < 3000; index += 1) assert.equal(buffer.shift(), JSON.stringify(record(index)));
    assert.notEqual(buffer.queue, initialQueue);
    for (let index = 5000; index < 6000; index += 1) buffer.push(record(index));
    for (let index = 3000; index < 6000; index += 1) assert.equal(buffer.shift(), JSON.stringify(record(index)));
    assert.equal(buffer.queue.length, 0);
    assert.equal(buffer.head, 0);
    buffer.push(record(6000));
    assert.equal(buffer.shift(), JSON.stringify(record(6000)));
  } finally {
    buffer.dispose();
  }
});

test("encrypted overflow uses direct envelope views without Buffer.concat", () => {
  const buffer = new WorkerDeliveryBuffer({ memoryBytes: 0 });
  const concat = Buffer.concat;
  let concatenations = 0;
  Buffer.concat = (...args) => { concatenations += 1; return concat(...args); };
  try {
    for (const text of ["", "Unicode 😀 é 漢字", "x".repeat(100_000)]) {
      const value = { type: /** @type {const} */ ("event"), event: { type: /** @type {const} */ ("response.output_text.delta"), delta: text } };
      buffer.push(value);
      assert.equal(buffer.shift(), JSON.stringify(value));
    }
    assert.equal(concatenations, 0);
  } finally {
    Buffer.concat = concat;
    buffer.dispose();
  }
});

for (const [part, offset] of [["nonce", 0], ["tag", 12], ["ciphertext", 28]]) {
  test(`encrypted overflow rejects altered ${part} before returning plaintext`, () => {
    const buffer = new WorkerDeliveryBuffer({ memoryBytes: 0 });
    try {
      buffer.push(record(1));
      assert.equal(typeof buffer.fd, "number");
      const fd = /** @type {number} */ (buffer.fd);
      const byte = new Uint8Array(1);
      readSync(fd, byte, 0, 1, Number(offset));
      byte[0] ^= 1;
      writeSync(fd, byte, 0, 1, Number(offset));
      assert.throws(() => buffer.shift(), /cannot read private response storage/u);
    } finally {
      buffer.dispose();
    }
  });
}