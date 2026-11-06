import assert from "node:assert/strict";
import test from "node:test";
import { onCocopiLiveRequestChange, readCocopiLiveRequests, startCocopiLiveRequest } from "../lib/vscode/live-sessions.js";

test("activity notifications track lifecycle and stage changes, not streamed tokens", () => {
  let changes = 0;
  const unsubscribe = onCocopiLiveRequestChange(() => { changes += 1; });
  const request = startCocopiLiveRequest("fixture");
  try {
    assert.equal(changes, 1);
    request.update({ stage: "Waiting for server" });
    request.update({ stage: "Waiting for server" });
    assert.equal(changes, 2);
    request.recordEvent({ type: "response.output_text.delta", delta: "fixture" });
    assert.equal(changes, 2);
    request.update({ stage: "Receiving server events" });
    assert.equal(changes, 3);
    request.dispose();
    request.dispose();
    assert.equal(changes, 4);
    unsubscribe();
    const another = startCocopiLiveRequest("fixture");
    another.dispose();
    assert.equal(changes, 4);
  } finally {
    unsubscribe();
    request.dispose();
  }
});

test("output and status activity are observational and never arm an output abort", (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  context.mock.method(performance, "now", Date.now);
  const request = startCocopiLiveRequest("fixture");
  try {
    context.mock.timers.tick(60_000);
    request.recordEvent({ type: "response.in_progress" });
    assert.equal(readCocopiLiveRequests()[0].lastEventType, "response.in_progress");
    assert.equal(readCocopiLiveRequests()[0].lastProgressAt, undefined);
    context.mock.timers.tick(600_000);
    request.recordEvent({ type: "response.output_text.delta", delta: "synthetic output" });
    assert.equal(readCocopiLiveRequests()[0].lastProgressAt, 661_000);
    assert.equal(readCocopiLiveRequests()[0].stage, "Preparing locally");
  } finally {
    request.dispose();
  }
});

test("transport health remains separate from consumed events and snapshots are detached", () => {
  const request = startCocopiLiveRequest("fixture");
  try {
    /** @type {import('../lib/codex-api/websocket-heartbeat.js').CodexTransportStatus} */
    const status = { transport: "websocket", heartbeat: "healthy", lastPongAt: 30_000, responseIdleDeadlineAt: 120_000 };
    request.recordTransportStatus(status);
    const snapshot = readCocopiLiveRequests()[0];
    assert.deepEqual(snapshot.transportStatus, status);
    assert.equal(snapshot.lastEventAt, undefined);
    assert.equal(snapshot.lastProgressAt, undefined);
    if (snapshot.transportStatus) snapshot.transportStatus.lastPongAt = 99;
    assert.equal(readCocopiLiveRequests()[0].transportStatus?.lastPongAt, 30_000);
    request.recordTransportStatus({ transport: "sse", heartbeat: "unsupported" });
    assert.equal(readCocopiLiveRequests()[0].transportStatus?.lastPongAt, undefined);
    request.dispose();
    request.recordTransportStatus(status);
    assert.deepEqual(readCocopiLiveRequests(), []);
  } finally {
    request.dispose();
  }
});

test("live requests track concurrent calls with detached metadata and cleanup", () => {
  const first = startCocopiLiveRequest("fixture-a");
  const second = startCocopiLiveRequest("fixture-b");
  try {
    first.update({ stage: "Waiting for server", sessionId: "session-a", turn: 2 });
    second.update({ stage: "Receiving server events", lastEventAt: 123 });
    const snapshots = readCocopiLiveRequests();
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[0].stage, "Waiting for server");
    assert.equal(snapshots[0].turn, 2);
    assert.equal(snapshots[1].lastEventAt, 123);
    snapshots[0].stage = "mutated";
    assert.equal(readCocopiLiveRequests()[0].stage, "Waiting for server");
    first.dispose();
    first.update({ stage: "Must not resurrect" });
    assert.equal(readCocopiLiveRequests().length, 1);
  } finally {
    first.dispose();
    second.dispose();
  }
  assert.deepEqual(readCocopiLiveRequests(), []);
});

test("live request ages use the monotonic clock despite wall-clock adjustments", (context) => {
  let now = 1000.25;
  context.mock.method(performance, "now", () => now);
  const request = startCocopiLiveRequest("fixture");
  try {
    context.mock.method(Date, "now", () => -9_000_000);
    now = 2000.75;
    request.recordEvent({ type: "response.output_text.delta", delta: "fixture" });
    const snapshot = readCocopiLiveRequests()[0];
    assert.equal(snapshot.startedAt, 1000.25);
    assert.equal(snapshot.lastEventAt, 2000.75);
    assert.equal(snapshot.lastProgressAt, 2000.75);
  } finally {
    request.dispose();
  }
});