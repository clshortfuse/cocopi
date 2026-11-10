import assert from "node:assert/strict";
import { once } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
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

/**
 * @param {Worker} worker
 * @param {Body} body
 * @param {ReturnType<typeof prepare>} expected
 * @param {number} iterations
 * @param {number} concurrency
 */
async function profilePressure(worker, body, expected, iterations, concurrency) {
  assert.ok(expected.upload.byteLength <= 16 * 1024 * 1024);
  assert.ok(expected.upload.byteLength * concurrency <= 32 * 1024 * 1024, "batch exceeds 32 MiB synthetic upload budget");
  const totals = { hostBatchMs: 0, hostBatchDelayMs: 0, postBatchMs: 0, offloadBatchMs: 0, offloadBatchDelayMs: 0 };
  const baseline = process.memoryUsage();
  let hostHeapMax = baseline.heapUsed;
  let hostExternalMax = baseline.external;
  let workerHeapMax = 0;
  let workerExternalMax = 0;
  let sequence = 0;
  /** @param {ReturnType<typeof prepare>} result */
  const verify = (result) => {
    assert.equal(result.digest, expected.digest);
    assert.equal(result.inputDigest, expected.inputDigest);
    assert.equal(result.toolsDigest, expected.toolsDigest);
    assert.deepEqual(result.upload, expected.upload);
  };
  const sampleHost = () => {
    const memory = process.memoryUsage();
    hostHeapMax = Math.max(hostHeapMax, memory.heapUsed);
    hostExternalMax = Math.max(hostExternalMax, memory.external);
  };
  const local = async () => {
    const started = performance.now();
    const pulse = nextTurn().then(() => performance.now() - started);
    const results = Array.from({ length: concurrency }, () => prepare(body));
    const batchMs = performance.now() - started;
    sampleHost();
    const delayMs = await pulse;
    for (const result of results) verify(result);
    return { batchMs, delayMs };
  };
  const offload = async () => {
    /** @type {Map<number, ReturnType<typeof prepare>>} */
    const results = new Map();
    const firstId = sequence;
    const completion = /** @type {{ resolve: () => void, reject: (error: Error) => void }} */ ({});
    /** @type {Promise<void>} */
    const completed = new Promise((resolve, reject) => {
      completion.resolve = resolve;
      completion.reject = reject;
    });
    /** @param {ReturnType<typeof prepare> & { requestId: number, memory: ReturnType<typeof process.memoryUsage> }} result */
    const receive = (result) => {
      assert.ok(result.requestId >= firstId && result.requestId < firstId + concurrency);
      assert.equal(results.has(result.requestId), false);
      results.set(result.requestId, result);
      workerHeapMax = Math.max(workerHeapMax, result.memory.heapUsed);
      workerExternalMax = Math.max(workerExternalMax, result.memory.external);
      sampleHost();
      if (results.size === concurrency) completion.resolve();
    };
    worker.on("message", receive);
    worker.on("error", completion.reject);
    try {
      const started = performance.now();
      const pulse = nextTurn().then(() => performance.now() - started);
      for (let index = 0; index < concurrency; index += 1) worker.postMessage({ requestId: sequence++, body });
      const postMs = performance.now() - started;
      sampleHost();
      const [delayMs] = await Promise.all([pulse, completed]);
      const batchMs = performance.now() - started;
      for (const result of results.values()) verify(result);
      return { postMs, delayMs, batchMs };
    } finally {
      worker.off("message", receive);
      worker.off("error", completion.reject);
    }
  };
  for (let iteration = 0; iteration <= iterations; iteration += 1) {
    let host;
    let remote;
    if (iteration % 2 === 0) { host = await local(); remote = await offload(); }
    else { remote = await offload(); host = await local(); }
    if (iteration > 0) {
      totals.hostBatchMs += host.batchMs;
      totals.hostBatchDelayMs += host.delayMs;
      totals.postBatchMs += remote.postMs;
      totals.offloadBatchMs += remote.batchMs;
      totals.offloadBatchDelayMs += remote.delayMs;
    }
  }
  console.log(JSON.stringify({
    kind: "preparation-pressure-profile", concurrency, iterations, uploadBytes: expected.upload.byteLength,
    inputItems: Array.isArray(body.input) ? body.input.length : undefined,
    reservedUploadBytes: expected.upload.byteLength * concurrency,
    averageMs: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value / iterations])),
    sampledMemory: { hostHeapBaseline: baseline.heapUsed, hostExternalBaseline: baseline.external, sharedProcessRssBaseline: baseline.rss, hostHeapMax, hostExternalMax, workerHeapMax, workerExternalMax, sharedProcessMaxRssKiB: process.resourceUsage().maxRSS },
    note: "One worker, separately cloned requests, exact correlated replies. One paired warmup excluded. Delay is one setImmediate scheduling probe per batch, not live UI latency. Memory is sampled, includes warmup/fixtures/GC effects and retained parity buffers, not isolated peaks or leak evidence. No runtime admission or cancellation implementation. No network call."
  }));
}

if (isMainThread) {
  const count = Number(process.argv[2] ?? 512);
  const iterations = Number(process.argv[3] ?? 10);
  const concurrency = Number(process.argv[4] ?? 1);
  assert.ok(Number.isInteger(count) && count >= 1 && count <= 512, "count must be 1..512");
  assert.ok(Number.isInteger(iterations) && iterations >= 1 && iterations <= 30, "iterations must be 1..30");
  assert.ok(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8, "concurrency must be 1..8");
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
    if (process.argv[4] === undefined) {
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
      worker.postMessage({ requestId: 0, body });
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
    } else {
      await profilePressure(worker, body, expected, iterations, concurrency);
    }
  } finally {
    await worker.terminate();
  }
} else {
  assert.ok(parentPort);
  const port = parentPort;
  port.on("message", /** @param {{ requestId: number, body: Body }} request */ ({ requestId, body }) => {
    const result = prepare(body);
    port.postMessage({ ...result, requestId, memory: process.memoryUsage() }, [result.upload.buffer]);
    assert.equal(result.upload.byteLength, 0);
  });
  port.postMessage("ready");
}