import assert from "node:assert/strict";
import { once } from "node:events";
import { isMainThread, parentPort, Worker } from "node:worker_threads";
import { canonicalCodexJsonDigest } from "../lib/codex-api/json.js";

/** @typedef {import('../data/Codex.js').CodexResponseCreateRequest} Body */

/** @param {Body} body */
function prepare(body) {
  const started = performance.now();
  const fields = new Map([["input", ""], ["tools", ""]]);
  const digest = canonicalCodexJsonDigest(body, fields);
  const upload = new TextEncoder().encode(JSON.stringify({ apiBaseUrl: "https://example.invalid", accessToken: "synthetic-local", body, transport: "websocket" }));
  return { digest, inputDigest: fields.get("input"), toolsDigest: fields.get("tools"), upload, preparationMs: performance.now() - started };
}

if (isMainThread) {
  const count = Number(process.argv[2] ?? 512);
  const iterations = Number(process.argv[3] ?? 10);
  assert.ok(Number.isInteger(count) && count >= 1 && count <= 512, "count must be 1..512");
  assert.ok(Number.isInteger(iterations) && iterations >= 1 && iterations <= 30, "iterations must be 1..30");
  /** @type {Body} */
  const body = { model: "synthetic", stream: true, tools: [], input: Array.from({ length: count }, (_, index) => [
    { type: /** @type {const} */ ("reasoning"), id: `synthetic-reasoning-${index}`, summary: [], encrypted_content: Buffer.alloc(8192, index % 251 + 1).toString("base64") },
    { role: /** @type {const} */ ("assistant"), content: `${index}: synthetic history 😀\n`.repeat(256) }
  ]).flat() };
  const expected = prepare(body);
  const worker = new Worker(new URL(import.meta.url));
  try {
    const [ready] = await once(worker, "message");
    assert.equal(ready, "ready");
    const totals = { hostPreparationMs: 0, hostPostMs: 0, offloadRoundTripMs: 0, workerPreparationMs: 0 };
    const local = () => {
      const result = prepare(body);
      assert.equal(result.digest, expected.digest);
      assert.deepEqual(result.upload, expected.upload);
      return result.preparationMs;
    };
    const offload = async () => {
      const reply = once(worker, "message");
      const started = performance.now();
      worker.postMessage(body);
      const postMs = performance.now() - started;
      const [result] = await reply;
      const roundTripMs = performance.now() - started;
      assert.equal(result.digest, expected.digest);
      assert.equal(result.inputDigest, expected.inputDigest);
      assert.equal(result.toolsDigest, expected.toolsDigest);
      assert.deepEqual(result.upload, expected.upload);
      return { postMs, roundTripMs, workerMs: result.preparationMs };
    };
    // Alternate order and exclude one paired warmup. Only one request is in flight.
    for (let iteration = 0; iteration <= iterations; iteration += 1) {
      let hostMs;
      let measured;
      if (iteration % 2 === 0) {
        hostMs = local();
        measured = await offload();
      } else {
        measured = await offload();
        hostMs = local();
      }
      if (iteration > 0) {
        totals.hostPreparationMs += hostMs;
        totals.hostPostMs += measured.postMs;
        totals.offloadRoundTripMs += measured.roundTripMs;
        totals.workerPreparationMs += measured.workerMs;
      }
    }
    console.log(JSON.stringify({
      kind: "preparation-offload-profile", messages: count, iterations, uploadBytes: expected.upload.byteLength,
      averageMs: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value / iterations])),
      note: "Synthetic helper feasibility only. Host posting includes synchronous clone serialization; round trip includes worker deserialization, preparation and transferred reply. Excludes worker startup, provider conversion, real transport, auth, cancellation, admission and live VS Code. No network call."
    }));
  } finally {
    await worker.terminate();
  }
} else {
  assert.ok(parentPort);
  const port = parentPort;
  port.on("message", /** @param {Body} body */ (body) => {
    const result = prepare(body);
    port.postMessage(result, [result.upload.buffer]);
    assert.equal(result.upload.byteLength, 0);
  });
  port.postMessage("ready");
}