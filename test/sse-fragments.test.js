import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { decodeSseStream } from "../lib/codex-api/sse.js";

/**
 * @param {(string | Uint8Array)[]} chunks
 * @param {{ maxEventBytes?: number }} [options]
 */
async function decode(chunks, options = {}) {
  const source = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
  const events = [];
  for await (const event of decodeSseStream(source, options)) events.push(event);
  return events;
}

test("SSE fragmented-line byte accounting stays linear in input size", async () => {
  const value = { delta: "x".repeat(20_000) };
  const wire = `data: ${JSON.stringify(value)}\n\n`;
  const chunks = Array.from({ length: Math.ceil(wire.length / 10) }, (_, index) => wire.slice(index * 10, index * 10 + 10));
  const byteLength = Buffer.byteLength;
  let countedCharacters = 0;
  Buffer.byteLength = (value, encoding) => {
    if (typeof value === "string") countedCharacters += value.length;
    return byteLength(value, encoding);
  };
  try {
    assert.deepEqual(await decode(chunks, { maxEventBytes: 30_000 }), [value]);
    assert.ok(countedCharacters < wire.length * 4, `byte accounting scanned ${countedCharacters} characters for ${wire.length} input characters`);
  } finally {
    Buffer.byteLength = byteLength;
  }
});

test("SSE preserves multiline JSON across split CRLF boundaries", async () => {
  assert.deepEqual(await decode(['data: {"a":\r', '\ndata: 1}\r', '\n\r', '\n']), [{ a: 1 }]);
});

test("SSE handles UTF-8 split at every byte and an unterminated final event", async () => {
  const value = { delta: "Unicode 😀 é 漢字" };
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify(value)}`);
  assert.deepEqual(await decode(Array.from(bytes, (_, index) => bytes.subarray(index, index + 1))), [value]);
});

test("SSE retains event and partial-line byte limits", async () => {
  await assert.rejects(decode(["data: ", "x".repeat(100)], { maxEventBytes: 50 }), /buffer limit/u);
  await assert.rejects(decode(['data: {"a":\n', 'data: "' + "x".repeat(100) + '"}\n\n'], { maxEventBytes: 50 }), /buffer limit/u);
});

test("SSE string fragments count a split surrogate pair as four UTF-8 bytes", async () => {
  const value = { delta: "😀" };
  const wire = `data: ${JSON.stringify(value)}`;
  const split = wire.indexOf("😀") + 1;
  assert.deepEqual(await decode([wire.slice(0, split), wire.slice(split)], { maxEventBytes: Buffer.byteLength(wire) }), [value]);
});