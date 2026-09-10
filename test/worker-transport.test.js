import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { CodexTransport } from "../lib/codex-api/transport.js";
import { CodexWorkerTransport } from "../lib/codex-api/worker-transport.js";
import { WorkerDeliveryBuffer } from "../lib/codex-api/worker-buffer.js";
import { CodexWorkerError } from "../lib/codex-api/worker-protocol.js";
import { closeCodexResponseWebSocketSessions, fetchCodexResponseStreamWithAuthRefresh } from "../lib/vscode/codex-request.js";

/**
 * @param {import("node:test").TestContext} context
 * @param {{ events?: object[], keepOpen?: boolean }} [options]
 */
async function fixture(context, options = {}) {
  const counts = new Int32Array(new SharedArrayBuffer(12));
  const server = new Worker(new URL("fixtures/transport-server.js", import.meta.url), { workerData: { counts: counts.buffer, interval: 25, ...options }, execArgv: [] });
  context.after(() => server.terminate());
  const [apiBaseUrl] = await once(server, "message");
  const service = process.env.COCOPI_TEST_TRANSPORT === "in-host" ? new CodexTransport() : new CodexWorkerTransport({ url: process.env.COCOPI_TEST_WORKER_URL ? new URL(process.env.COCOPI_TEST_WORKER_URL) : undefined });
  context.after(() => service.dispose());
  return { counts, service, apiBaseUrl: String(apiBaseUrl), idleTimeoutMs: 250, blockMs: 1200 };
}

for (const transport of ["websocket", "sse"]) {
  test(`worker ${transport} preserves one generation through a host stall`, async (context) => {
    const { counts, service, apiBaseUrl, idleTimeoutMs, blockMs } = await fixture(context);
    const stream = await service.request({ apiBaseUrl, transport, accessToken: "local-fixture", body: { model: "active", stream: true, input: [] }, idleTimeoutMs });
    const reader = stream.getReader();
    const first = await reader.read();
    assert.equal(first.value?.type, "response.created");
    // Intentionally block only the test host, never the independent server or
    // production transport worker. No debugger pause can substitute for this.
    /** @type {Promise<void>} */
    const blocked = new Promise((resolve) => setImmediate(() => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, blockMs);
      resolve();
    }));
    await blocked;
    assert.equal(Atomics.load(counts, 2), 1, "server completed while the host was blocked");
    const events = [];
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      events.push(result.value);
    }
    assert.equal(events.length, 31);
    assert.deepEqual(events.slice(0, 30).map((event) => "sequence_number" in event ? event.sequence_number : undefined), Array.from({ length: 30 }, (_, index) => index));
    assert.equal(events.at(-1)?.type, "response.completed");
    assert.equal(Atomics.load(counts, 0), 1, "exactly one outbound generation");
    if (service instanceof CodexWorkerTransport) {
      assert.ok(service.metrics);
      assert.ok(service.metrics.spoolHighWaterBytes > 0, "host stall overflows the memory budget into private storage");
      assert.ok(service.metrics.memoryHighWaterBytes <= 1024 * 1024);
      assert.equal(service.metrics.events, 32);
      context.diagnostic(JSON.stringify(service.metrics));
    }
    context.diagnostic(`hostBlockedMs=${blockMs} idleTimeoutMs=${idleTimeoutMs} events=${events.length + 1} generations=${Atomics.load(counts, 0)}`);
  });
}

test("worker still rejects genuine server silence", async (context) => {
  const { service, apiBaseUrl, counts } = await fixture(context);
  const stream = await service.request({ apiBaseUrl, transport: "websocket", accessToken: "local-fixture", body: { model: "silent", stream: true, input: [] }, idleTimeoutMs: 100 });
  const reader = stream.getReader();
  const first = await reader.read();
  assert.equal(first.value?.type, "response.created");
  await assert.rejects(reader.read(), /idle for 100ms/u);
  assert.equal(Atomics.load(counts, 0), 1);
});

test("worker cancellation discards backlog without another generation", async (context) => {
  const { service, apiBaseUrl, counts } = await fixture(context);
  const abort = new AbortController();
  const stream = await service.request({ apiBaseUrl, transport: "websocket", accessToken: "local-fixture", body: { model: "active", stream: true, input: [] }, signal: abort.signal });
  const reader = stream.getReader();
  await reader.read();
  abort.abort();
  await assert.rejects(reader.read(), { name: "AbortError" });
  assert.equal(Atomics.load(counts, 0), 1);
});

test("worker startup failure is local and never replayed", async () => {
  const service = new CodexWorkerTransport({ url: new URL("fixtures/missing-transport-worker.js", import.meta.url) });
  await assert.rejects(service.request({ apiBaseUrl: "http://127.0.0.1", accessToken: "local", body: { model: "active", input: [] } }), CodexWorkerError);
});

test("worker preserves phase, encrypted reasoning, tools, IDs and usage exactly", async (context) => {
  const expected = [
    { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "reasoning-local", encrypted_content: "fixture-encrypted", summary: [] } },
    { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "message-local", phase: "commentary", role: "assistant", content: [] } },
    { type: "response.output_text.delta", output_index: 1, item_id: "message-local", content_index: 0, delta: "commentary" },
    { type: "response.output_item.done", output_index: 2, item: { type: "function_call", id: "function-local", call_id: "call-local", name: "fixture", arguments: "{\"value\":1}" } },
    { type: "response.completed", response: { id: "response-local", status: "completed", output: [], usage: { input_tokens: 123, output_tokens: 7, total_tokens: 130 } } }
  ];
  const { service, apiBaseUrl, counts } = await fixture(context, { events: expected });
  for (const transport of ["websocket", "sse"]) {
    const stream = await service.request({ apiBaseUrl, transport, accessToken: "local", body: { model: "events", input: [], stream: true } });
    const received = [];
    for await (const event of stream) {
      received.push(event);
    }
    assert.deepEqual(received.slice(1), expected);
  }
  assert.equal(Atomics.load(counts, 0), 2);
});

test("worker cancelling one conversation leaves another receiving", async (context) => {
  const expected = [{ type: "response.completed", response: { id: "response-local", output: [], status: "completed" } }];
  const { service, apiBaseUrl, counts } = await fixture(context, { events: expected });
  const options = { apiBaseUrl, transport: "websocket", accessToken: "local", body: { model: "events", input: [], stream: true } };
  const first = await service.request({ ...options, body: { ...options.body, prompt_cache_key: "first" } });
  const second = await service.request({ ...options, body: { ...options.body, prompt_cache_key: "second" } });
  await first.cancel();
  const events = [];
  for await (const event of second) {
    events.push(event);
  }
  assert.equal(events.at(-1)?.type, "response.completed");
  assert.equal(Atomics.load(counts, 0), 2);
});

test("worker cancellation before start never sends a request", async (context) => {
  const { service, apiBaseUrl, counts } = await fixture(context);
  await assert.rejects(service.request({ apiBaseUrl, accessToken: "local", body: { model: "events", input: [] }, signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(Atomics.load(counts, 0), 0);
});

test("worker rejects oversized uploads before sending a generation", async (context) => {
  const { service, apiBaseUrl, counts } = await fixture(context);
  await assert.rejects(service.request({ apiBaseUrl, accessToken: "local", body: { model: "events", input: "x".repeat(17 * 1024 * 1024) } }), /upload budget/u);
  assert.equal(Atomics.load(counts, 0), 0);
});

test("worker bounds aggregate requests without disturbing active conversations", async (context) => {
  const { service, apiBaseUrl, counts } = await fixture(context);
  const options = { apiBaseUrl, transport: "websocket", accessToken: "local", body: { model: "silent", input: [], stream: true } };
  const readers = [];
  for (let index = 0; index < 8; index += 1) {
    const stream = await service.request(options);
    const reader = stream.getReader();
    await reader.read();
    readers.push(reader);
  }
  await assert.rejects(service.request(options), /concurrent request budget/u);
  assert.equal(Atomics.load(counts, 0), 8);
  await Promise.all(readers.map((reader) => reader.cancel()));
});

for (const transport of ["websocket", "sse"]) {
  test(`worker ${transport} rejects unsupported event sizes without recovery`, async (context) => {
    const { service, apiBaseUrl, counts } = await fixture(context, { events: [{ type: "response.output_text.delta", delta: "x".repeat(5 * 1024 * 1024) }] });
    const stream = await service.request({ apiBaseUrl, transport, accessToken: "local", body: { model: "events", input: [], stream: true } });
    const reader = stream.getReader();
    await reader.read();
    await assert.rejects(reader.read(), (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof TypeError, false);
      if (error.name === "CodexResponseWebSocketError") {
        assert.equal(Reflect.get(error, "code"), "local_buffer_limit");
      }
      return true;
    });
    assert.equal(Atomics.load(counts, 0), 1);
  });
}

for (const failure of ["crash", "invalid-envelope", "dispose"]) {
  test(`worker ${failure} rejects an active stream without replay`, async (context) => {
    const { service, apiBaseUrl, counts } = await fixture(context);
    assert.ok(service instanceof CodexWorkerTransport);
    const stream = await service.request({ apiBaseUrl, transport: "websocket", accessToken: "local", body: { model: "silent", input: [], stream: true } });
    const reader = stream.getReader();
    await reader.read();
    const rejected = assert.rejects(reader.read(), CodexWorkerError);
    if (failure === "crash") {
      await service.worker.terminate();
    } else if (failure === "invalid-envelope") {
      service.worker.emit("message", null);
    } else {
      service.dispose();
    }
    await rejected;
    assert.equal(Atomics.load(counts, 0), 1);
  });
}

test("worker reports genuine silence after draining preceding backlog", async (context) => {
  const expected = [{ type: "response.output_text.delta", item_id: "local", delta: "complete queued event" }];
  const { service, apiBaseUrl, counts } = await fixture(context, { events: expected, keepOpen: true });
  const stream = await service.request({ apiBaseUrl, transport: "websocket", accessToken: "local", body: { model: "events", input: [], stream: true }, idleTimeoutMs: 150 });
  const reader = stream.getReader();
  await reader.read();
  await delay(350);
  const queued = await reader.read();
  assert.deepEqual(queued.value, expected[0]);
  await assert.rejects(reader.read(), /idle for 150ms/u);
  assert.equal(Atomics.load(counts, 0), 1);
});

test("corrupted spool fails explicitly instead of losing an event", () => {
  const buffer = new WorkerDeliveryBuffer({ memoryBytes: 0 });
  try {
    buffer.push({ type: "opened" });
    truncateSync(path.join(/** @type {string} */ (buffer.directory), "events"), 0);
    assert.throws(() => buffer.shift(), /buffer-storage failure/u);
  } finally {
    buffer.dispose();
  }
});

test("delivery buffer drains memory then disk in order and removes private storage", () => {
  const buffer = new WorkerDeliveryBuffer({ memoryBytes: 30 });
  try {
    buffer.push({ type: "opened" });
    for (let index = 0; index < 10; index += 1) {
      buffer.push({ type: "prepared", inputItems: index });
    }
    assert.ok(buffer.memoryHighWater <= 30);
    assert.ok(buffer.diskHighWater > 0);
    assert.equal(JSON.parse(/** @type {string} */ (buffer.shift())).type, "opened");
    for (let index = 0; index < 10; index += 1) {
      assert.equal(JSON.parse(/** @type {string} */ (buffer.shift())).inputItems, index);
    }
    assert.equal(buffer.shift(), undefined);
    const directory = /** @type {string} */ (buffer.directory);
    assert.ok(existsSync(directory));
    assert.equal(readFileSync(path.join(directory, "events"), "utf8").includes("prepared"), false, "response spool is encrypted");
    buffer.dispose();
    assert.equal(existsSync(directory), false);
  } finally {
    buffer.dispose();
  }
});

test("delivery storage budgets and write failure are explicit local errors", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "cocopi-buffer-test-"));
  try {
    const buffer = new WorkerDeliveryBuffer({ directory, memoryBytes: 0, diskBytes: 60 });
    buffer.push({ type: "opened" });
    assert.throws(() => buffer.push({ type: "prepared", inputItems: 1 }), CodexWorkerError);
    assert.equal(JSON.parse(/** @type {string} */ (buffer.shift())).type, "opened");
    buffer.dispose();
    assert.deepEqual(readdirSync(directory), []);
    const unavailable = new WorkerDeliveryBuffer({ directory: path.join(directory, "missing"), memoryBytes: 0 });
    assert.throws(() => unavailable.push({ type: "opened" }), /buffer-storage failure/u);
    unavailable.dispose();
    const oversized = new WorkerDeliveryBuffer({ eventBytes: 1 });
    assert.throws(() => oversized.push({ type: "opened" }), CodexWorkerError);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("shared response entry point invalidates worker streams on account changes", async (context) => {
  const { apiBaseUrl, counts } = await fixture(context);
  context.after(closeCodexResponseWebSocketSessions);
  const secretContext = { secrets: { async get() { return ""; }, async store() {}, async delete() {} } };
  const runtime = {
    configuration: /** @type {import("../lib/vscode/configuration.js").CocopiConfiguration} */ ({ apiBaseUrl, transport: "websocket", workerTransport: true }),
    auth: { accessToken: "local", chatgptAccountId: undefined, chatgptPlanType: undefined }, clientVersion: "fixture"
  };
  const stream = await fetchCodexResponseStreamWithAuthRefresh(secretContext, runtime, { body: { model: "silent", input: [], stream: true } });
  const reader = stream.getReader();
  await reader.read();
  const rejected = assert.rejects(reader.read(), CodexWorkerError);
  closeCodexResponseWebSocketSessions();
  await rejected;
  assert.equal(Atomics.load(counts, 0), 1);
});