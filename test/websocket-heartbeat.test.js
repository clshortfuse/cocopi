import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import test from "node:test";
import { startWebSocketHeartbeat } from "../lib/codex-api/websocket-heartbeat.js";

// Match ws's Node event API, rather than the browser's EventTarget API.
// eslint-disable-next-line unicorn/prefer-event-target
class HeartbeatSocket extends EventEmitter {
  /** @type {Buffer[]} */
  sent = [];
  /** @type {Error | undefined} */
  sendError;
  /**
   * @param {Buffer} data
   * @param {boolean} _mask
   * @param {(error?: Error) => void} callback
   */
  ping(data, _mask, callback) {
    this.sent.push(Buffer.from(data));
    callback(this.sendError);
  }
}

/**
 * @param {import('node:test').TestContext} context
 * @param {boolean} [confirm]
 */
function fixture(context, confirm = true) {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  // Capture the virtual timer clock so replacing Date.now cannot change monotonic time.
  context.mock.method(performance, "now", Date.now);
  const socket = new HeartbeatSocket();
  /** @type {Partial<import('../lib/codex-api/websocket-heartbeat.js').CodexTransportStatus>} */
  const status = {};
  /** @type {Error[]} */
  const failures = [];
  const stop = startWebSocketHeartbeat(/** @type {import('ws').WebSocket} */ (/** @type {object} */ (socket)), (update) => Object.assign(status, update), (error) => failures.push(error));
  context.mock.timers.tick(0);
  if (confirm) {
    socket.emit("pong", socket.sent[0]);
    socket.sent.length = 0;
    status.lastPongAt = undefined;
  }
  context.after(stop);
  return { socket, status, failures, stop };
}

test("unanswered initialization probe never aborts an unconfirmed socket", (context) => {
  const { socket, status, failures } = fixture(context, false);
  assert.equal(status.heartbeat, "probing");
  assert.equal(status.lastPingAt, 1000);
  socket.emit("pong", Buffer.from("unrelated"));
  socket.emit("ping", Buffer.from("server-ping"));
  context.mock.timers.tick(30_000);
  assert.equal(status.heartbeat, "unconfirmed");
  assert.equal(status.pongDeadlineAt, undefined);
  assert.equal(failures.length, 0);
  context.mock.timers.tick(300_000);
  assert.equal(socket.sent.length, 1);
  const stop = startWebSocketHeartbeat(/** @type {import('ws').WebSocket} */ (/** @type {object} */ (socket)), (update) => Object.assign(status, update), (error) => failures.push(error));
  context.after(stop);
  context.mock.timers.tick(300_000);
  assert.equal(socket.sent.length, 1, "reusing an unconfirmed connection does not re-arm enforcement");
});

test("confirmed capability survives request reuse but never transfers to a new socket", (context) => {
  const { socket, stop, failures } = fixture(context);
  stop();
  const again = startWebSocketHeartbeat(/** @type {import('ws').WebSocket} */ (/** @type {object} */ (socket)), () => {}, (error) => failures.push(error));
  context.after(again);
  context.mock.timers.tick(30_000);
  context.mock.timers.tick(30_000);
  assert.equal(failures.length, 1, "confirmed peers are still subject to missing-pong enforcement");
  const fresh = new HeartbeatSocket();
  /** @type {Error[]} */
  const freshFailures = [];
  const freshStop = startWebSocketHeartbeat(/** @type {import('ws').WebSocket} */ (/** @type {object} */ (fresh)), () => {}, (error) => freshFailures.push(error));
  context.after(freshStop);
  context.mock.timers.tick(0);
  context.mock.timers.tick(30_000);
  assert.deepEqual(freshFailures, [], "new sockets must establish their own capability");
});

test("heartbeat sends identified probes and only matching pongs satisfy their deadline", (context) => {
  const { socket, status, failures } = fixture(context);
  assert.equal(status.nextPingAt, 31_000);
  context.mock.timers.tick(30_000);
  assert.equal(socket.sent.length, 1);
  assert.equal(status.lastPingAt, 31_000);
  assert.equal(status.pongDeadlineAt, 61_000);
  socket.emit("pong", Buffer.from("unrelated"));
  assert.equal(status.lastPongAt, undefined);
  context.mock.timers.tick(1000);
  socket.emit("pong", socket.sent[0]);
  assert.equal(status.heartbeat, "healthy");
  assert.equal(status.lastPongAt, 32_000);
  assert.equal(status.pongDeadlineAt, undefined);
  assert.equal(status.nextPingAt, 62_000);
  context.mock.timers.tick(30_000);
  assert.equal(socket.sent.length, 2);
  assert.notDeepEqual(socket.sent[0], socket.sent[1]);
  socket.emit("pong", socket.sent[0]);
  assert.equal(status.pongDeadlineAt, 92_000, "a stale pong cannot satisfy a new probe");
  assert.deepEqual(failures, []);
});

test("server pings and application messages cannot mask a missing matching pong", (context) => {
  const { socket, status, failures } = fixture(context);
  context.mock.timers.tick(30_000);
  socket.emit("ping", Buffer.from("server-probe"));
  socket.emit("message", "status-only response");
  assert.equal(status.lastServerPingAt, 31_000);
  context.mock.timers.tick(30_000);
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /no matching pong within 30000ms/u);
  assert.equal(status.heartbeat, "failed");
  assert.equal(status.pongDeadlineAt, undefined);
  context.mock.timers.tick(300_000);
  assert.equal(socket.sent.length, 1);
  assert.equal(failures.length, 1);
});

for (const ending of ["dispose", "close", "error"]) {
  test(`heartbeat ${ending} clears pending probes and listeners`, (context) => {
    const { socket, status, failures, stop } = fixture(context);
    context.mock.timers.tick(30_000);
    if (ending === "dispose") stop();
    else socket.emit(ending);
    assert.equal(socket.listenerCount("ping"), 0);
    assert.equal(socket.listenerCount("pong"), 0);
    context.mock.timers.tick(300_000);
    assert.equal(socket.sent.length, 1);
    assert.deepEqual(failures, []);
    assert.equal(status.pongDeadlineAt, undefined);
  });
}

test("failed ping writes fail once and leave no timer", (context) => {
  const { socket, status, failures } = fixture(context);
  socket.sendError = new Error("fixture send failure");
  context.mock.timers.tick(30_000);
  assert.equal(failures.length, 1);
  assert.equal(status.heartbeat, "failed");
  context.mock.timers.tick(300_000);
  assert.equal(failures.length, 1);
});

test("wall-clock jumps cannot change heartbeat timestamps or deadlines", (context) => {
  const { socket, status } = fixture(context);
  context.mock.method(Date, "now", () => -9_000_000);
  context.mock.timers.tick(30_000);
  assert.equal(status.lastPingAt, 31_000);
  assert.equal(status.pongDeadlineAt, 61_000);
  context.mock.method(Date, "now", () => 9_000_000);
  context.mock.timers.tick(1000);
  socket.emit("pong", socket.sent[0]);
  assert.equal(status.lastPongAt, 32_000);
  assert.equal(status.nextPingAt, 62_000);
});