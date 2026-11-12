import assert from "node:assert/strict";
import { decodeSseStream } from "../lib/codex-api/sse.js";

const payload = { delta: "synthetic 😀 ".repeat(32_000) };
const bytes = new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
for (const chunkBytes of [64, 1024, 65_536]) {
  let offset = 0;
  const source = new ReadableStream({
    pull(controller) {
      if (offset === bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkBytes, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    }
  });
  const started = performance.now();
  let events = 0;
  for await (const event of decodeSseStream(source, { maxEventBytes: bytes.byteLength })) {
    assert.deepEqual(event, payload);
    events += 1;
  }
  assert.equal(events, 1);
  console.log(JSON.stringify({ inputBytes: bytes.byteLength, chunkBytes, chunks: Math.ceil(bytes.byteLength / chunkBytes), elapsedMs: performance.now() - started }));
}