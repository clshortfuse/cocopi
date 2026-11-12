import assert from "node:assert/strict";
import test from "node:test";
import { createWorkerStatusChannel } from "../lib/codex-api/worker-status.js";

test("routine statuses coalesce to the latest snapshot on a bounded cadence", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  /** @type {import('../lib/codex-api/websocket-heartbeat.js').CodexTransportStatus[]} */
  const sent = [];
  const channel = createWorkerStatusChannel((status) => sent.push(status), { now: () => now });
  channel.update({ transport: "websocket", heartbeat: "healthy", lastDataAt: 0 });
  assert.equal(sent.length, 1);
  channel.acknowledge();
  for (let index = 1; index <= 1000; index += 1) channel.update({ transport: "websocket", heartbeat: "healthy", lastDataAt: index });
  assert.equal(sent.length, 1);
  now = 100;
  context.mock.timers.tick(100);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].lastDataAt, 1000);
  channel.dispose();
});

test("health transitions bypass the cadence but still require acknowledgement credit", () => {
  /** @type {import('../lib/codex-api/websocket-heartbeat.js').CodexTransportStatus[]} */
  const sent = [];
  const channel = createWorkerStatusChannel((status) => sent.push(status), { now: () => 0 });
  channel.update({ transport: "websocket", heartbeat: "healthy" });
  channel.update({ transport: "websocket", heartbeat: "failed" });
  assert.equal(sent.length, 1);
  assert.equal(channel.acknowledge(), true);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].heartbeat, "failed");
  channel.acknowledge();
  channel.update({ transport: "sse", heartbeat: "unsupported" });
  assert.equal(sent.length, 3);
  channel.dispose();
});

test("idle deadline clearing bypasses routine timestamp throttling", () => {
  const sent = [];
  const channel = createWorkerStatusChannel((status) => sent.push(status), { now: () => 0 });
  channel.update({ transport: "websocket", heartbeat: "healthy", responseIdleDeadlineAt: 1000 });
  channel.acknowledge();
  channel.update({ transport: "websocket", heartbeat: "healthy", responseIdleDeadlineAt: undefined });
  assert.equal(sent.length, 2);
  channel.dispose();
});

test("disposing a status channel clears pending work and prevents further sends", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  const sent = [];
  const channel = createWorkerStatusChannel((status) => sent.push(status), { now: () => now });
  channel.update({ transport: "websocket", heartbeat: "healthy" });
  channel.acknowledge();
  channel.update({ transport: "websocket", heartbeat: "healthy", lastDataAt: 1 });
  channel.dispose();
  now = 100;
  context.mock.timers.tick(100);
  channel.update({ transport: "websocket", heartbeat: "failed" });
  assert.equal(channel.acknowledge(), false);
  assert.equal(sent.length, 1);
});