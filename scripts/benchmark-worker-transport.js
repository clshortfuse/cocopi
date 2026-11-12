import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { Session } from "node:inspector/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { CodexWorkerTransport } from "../lib/codex-api/worker-transport.js";
import { parseWorkerCpuProfile, summarizeCpuProfile } from "./cpu-profile-summary.js";

// Every workload has its own process. Both worker threads contribute to RSS;
// heap/external counters are per isolate. No credentials or remote endpoints.
const workload = process.argv[2];
const turns = Number(process.argv[3] ?? 48);
const ipcMode = process.argv[4] ?? "full";
const cpu = process.argv[5] === "cpu";
assert.ok(process.argv[5] === undefined || cpu, "profile mode must be cpu");
assert.ok(["full", "delta"].includes(ipcMode), "IPC mode must be full or delta");
assert.ok(Number.isInteger(turns) && turns >= 1 && turns <= 80, "turns must be 1..80");
if (workload === undefined) {
  for (const mode of ["fixed", "growing", "release", "sessions", "backpressure", "cancel"]) {
    const result = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), mode, String(turns), ipcMode, ...(cpu ? ["cpu"] : [])], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || "Transport benchmark failed");
    process.stdout.write(result.stdout);
  }
} else {
  assert.ok(["fixed", "growing", "release", "sessions", "backpressure", "cancel"].includes(workload), "unknown workload");
  const growing = workload === "growing" || workload === "release";
  if (workload === "release") assert.ok(globalThis.gc, "release workload requires --expose-gc");
  const pressure = workload === "backpressure" || workload === "cancel";
  const counts = new Int32Array(new SharedArrayBuffer(12));
  const server = new Worker(new URL("../test/fixtures/transport-server.js", import.meta.url), {
    execArgv: [],
    workerData: {
      counts: counts.buffer, interval: 1, keepOpen: true,
      notifyCompletion: pressure,
      events: pressure ? undefined : [{ type: "response.completed", response: { id: "synthetic-response", output: [], status: "completed" } }]
    }
  });
  const transport = new CodexWorkerTransport(/** @type {ConstructorParameters<typeof CodexWorkerTransport>[0] & { historyDelta: boolean }} */ ({ historyDelta: ipcMode === "delta" }));
  const observed = /** @type {typeof transport & { lastPreparationMs?: number, history?: { bytes: number, items: string[] } }} */ (transport);
  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  /** @type {number[]} */
  const latencies = [];
  /** @type {number[]} */
  const preparations = [];
  /** @type {number[]} */
  const hostPreparations = [];
  const history = [];
  let historyTextBytes = 0;
  const inspector = cpu ? new Session() : undefined;
  /** @type {{ stop(): Promise<string> } | undefined} */
  let workerProfile;
  try {
    assert.ok(ipcMode === "full" || observed.history, "delta IPC requires experimental history instrumentation");
    const [apiBaseUrl] = await once(server, "message");
    await transport.ready;
    // Warm module/socket initialization separately from measured requests.
    const warmup = await transport.request({ apiBaseUrl, transport: "websocket", accessToken: "synthetic-local", body: { model: "warmup", stream: true, input: [] } });
    for await (const event of warmup) assert.ok(event.type);
    globalThis.gc?.();
    const baseline = process.memoryUsage();
    if (inspector) {
      inspector.connect();
      await inspector.post("Profiler.enable");
      await inspector.post("Profiler.start");
      const startProfile = Reflect.get(transport.worker, "startCpuProfile");
      assert.equal(typeof startProfile, "function", "CPU mode requires Node worker.startCpuProfile support");
      workerProfile = await startProfile.call(transport.worker);
    }
    loopDelay.enable();
    for (let turn = 1; turn <= turns; turn += 1) {
      const text = `${turn}:` + "synthetic history 😀 ".repeat(6000);
      const textBytes = Buffer.byteLength(text);
      historyTextBytes += textBytes;
      if (growing) history.push({ role: "user", content: [{ type: "input_text", text }] });
      const input = growing ? history : [{ role: "user", content: [{ type: "input_text", text }] }];
      const body = { model: "events", stream: true, input, prompt_cache_key: workload === "sessions" ? `synthetic-${turn}` : "synthetic-shared" };
      const started = performance.now();
      let preparedMs = 0;
      const generated = pressure ? once(server, "message", { signal: AbortSignal.timeout(10_000) }) : undefined;
      const stream = await transport.request({
        apiBaseUrl, transport: "websocket", accessToken: "synthetic-local", body,
        onWebSocketRequestPrepared() { preparedMs = performance.now() - started; }
      });
      if (generated) {
        const [message] = await generated;
        assert.equal(message.type, "generated");
      }
      let completed = false;
      let deltas = 0;
      if (workload === "cancel") {
        await stream.cancel();
      } else {
        for await (const event of stream) {
          if (event.type === "response.completed") completed = true;
          if (event.type === "response.output_text.delta") {
            assert.equal(event.sequence_number, deltas);
            assert.equal(event.delta, `${deltas}:${"x".repeat(80_000)}`);
            deltas += 1;
          }
        }
        assert.ok(completed);
        if (pressure) assert.equal(deltas, 30);
      }
      latencies.push(performance.now() - started);
      preparations.push(preparedMs);
      if (observed.lastPreparationMs !== undefined) hostPreparations.push(observed.lastPreparationMs);
      assert.equal(transport.invocations.size, 0);
      assert.equal(transport.uploadBytes, 0);
      assert.ok(transport.metrics);
      const metrics = /** @type {Partial<NonNullable<typeof transport.metrics>> & { cachedSessions?: number, continuationAnchors?: number }} */ (workload === "cancel" ? {} : transport.metrics);
      if (workload === "backpressure") assert.ok((metrics.spoolHighWaterBytes ?? 0) > 0, "delayed consumption must exercise disk backpressure");
      if (metrics.cachedSessions !== undefined) assert.ok(metrics.cachedSessions <= 32);
      if (turn === 1 || turn % 8 === 0 || turn === turns) {
        const memory = process.memoryUsage();
        console.log(JSON.stringify({
          kind: "sample", workload, ipcMode, turn, inputItems: input.length,
          deliveredDeltas: deltas, cancelled: workload === "cancel",
          inputTextBytes: growing ? historyTextBytes : textBytes,
          elapsedMs: latencies.at(-1), preparedMs,
          hostPreparationMs: observed.lastPreparationMs ?? null,
          hostHeapBytes: memory.heapUsed, hostExternalBytes: memory.external,
          hostArrayBufferBytes: memory.arrayBuffers,
          ...metrics, activeHostInvocations: transport.invocations.size,
          reservedHostUploadBytes: transport.uploadBytes,
          retainedHostHistoryBytes: observed.history?.bytes ?? null,
          retainedHostFingerprintCharacters: observed.history?.items.reduce((total, item) => total + item.length, 0) ?? null,
          fullRequestUploadBytes: Buffer.byteLength(JSON.stringify({ apiBaseUrl, transport: "websocket", accessToken: "synthetic-local", body }))
        }));
      }
    }
    if (inspector && workerProfile) {
      const workerResult = parseWorkerCpuProfile(await workerProfile.stop());
      workerProfile = undefined;
      const hostResult = await inspector.post("Profiler.stop");
      console.log(JSON.stringify({ kind: "cpu", workload, ipcMode, turns,
        host: summarizeCpuProfile(hostResult.profile), worker: summarizeCpuProfile(workerResult),
        note: "Warmup/startup and post-run GC excluded. Host includes fixture construction, output accounting and report serialization; worker includes live transport processing. Profiling changes timing; compare unprofiled runs separately."
      }));
    }
    loopDelay.disable();
    globalThis.gc?.();
    const settled = process.memoryUsage();
    if (workload === "release") {
      const releasedItems = history.length;
      history.length = 0;
      // End consumption continuations before checking host-owned reachability.
      // This is not a forced GC or reclamation claim for the worker isolate.
      await nextTurn();
      globalThis.gc?.();
      const released = process.memoryUsage();
      assert.equal(history.length, 0);
      assert.equal(transport.invocations.size, 0);
      assert.equal(transport.uploadBytes, 0);
      console.log(JSON.stringify({
        kind: "release", workload, ipcMode, releasedItems, releasedTextBytes: historyTextBytes,
        hostHeapBaselineBytes: baseline.heapUsed,
        hostHeapWithHistoryBytes: settled.heapUsed,
        hostHeapAfterReleaseBytes: released.heapUsed,
        hostHeapReclaimedBytes: settled.heapUsed - released.heapUsed,
        hostHeapDeltaAfterReleaseBytes: released.heapUsed - baseline.heapUsed,
        hostExternalAfterReleaseBytes: released.external,
        hostArrayBuffersAfterReleaseBytes: released.arrayBuffers,
        sharedProcessRssAfterReleaseBytes: released.rss,
        activeHostInvocations: transport.invocations.size,
        reservedHostUploadBytes: transport.uploadBytes,
        note: "Host GC only; transport/fixture workers remain running. RSS need not fall. Delta IPC may deliberately retain encoded history. No strict memory threshold is asserted."
      }));
    }
    const sorted = latencies.toSorted((left, right) => left - right);
    assert.equal(Atomics.load(counts, 0), turns + 1, "one generation per turn plus warmup; no replay");
    console.log(JSON.stringify({
      kind: "summary", workload, ipcMode, turns,
      firstMs: latencies[0], lastMs: latencies.at(-1),
      medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      firstPreparedMs: preparations[0], lastPreparedMs: preparations.at(-1),
      lastHostPreparationMs: hostPreparations.at(-1),
      averageHostPreparationMs: hostPreparations.length > 0 ? hostPreparations.reduce((sum, value) => sum + value, 0) / hostPreparations.length : null,
      hostHeapDeltaBytesAfterGc: settled.heapUsed - baseline.heapUsed,
      hostGcCheckpoint: workload === "release" ? "before-history-release" : "history-retained",
      hostExternalDeltaBytesAfterGc: settled.external - baseline.external,
      sharedProcessMaxRssKiB: process.resourceUsage().maxRSS,
      hostEventLoopDelayMaxMs: loopDelay.max / 1_000_000,
      cachedSessions: workload === "cancel" ? null : Reflect.get(transport.metrics ?? {}, "cachedSessions") ?? null,
      continuationAnchors: workload === "cancel" ? null : Reflect.get(transport.metrics ?? {}, "continuationAnchors") ?? null,
      generations: Atomics.load(counts, 0),
      note: "Full upload is default. Includes fixture and transport threads in RSS; worker heap is not forced-GC; growing history remains intentionally live. Backpressure waits for fixture generation, not an arbitrary sleep. Cancel samples omit unavailable terminal worker metrics; cleared host reservations do not prove worker storage has already been reclaimed."
    }));
  } finally {
    if (workerProfile) await workerProfile.stop().catch(() => {});
    inspector?.disconnect();
    loopDelay.disable();
    try {
      const exited = once(transport.worker, "exit", { signal: AbortSignal.timeout(5000) });
      transport.dispose();
      await exited;
    } finally {
      await transport.worker.terminate();
      await server.terminate();
    }
  }
}