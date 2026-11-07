import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { CodexResponseWebSocketError, CodexResponsesWebSocketSession } from "../lib/codex-api/websocket.js";

/**
 * @param {import('node:test').TestContext} context
 * @param {number} idleTimeoutMs
 * @param {boolean} [confirm]
 */
async function fixture(context, idleTimeoutMs, confirm = true) {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  context.mock.method(performance, "now", Date.now);
  assert.equal(performance.now(), 1000);
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1", autoPong: false });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const connection = once(server, "connection");
  const session = new CodexResponsesWebSocketSession({ apiBaseUrl: `http://127.0.0.1:${address.port}`, accessToken: "fixture", WebSocketConstructor: /** @type {typeof globalThis.WebSocket} */ (/** @type {object} */ (WebSocket)) });
  context.after(async () => {
    const closed = once(server, "close");
    const client = session.socket;
    const clientClosed = client && client.readyState !== WebSocket.CLOSED ? once(client, "close") : Promise.resolve();
    session.dispose();
    for (const client of server.clients) client.terminate();
    server.close();
    await closed;
    await clientClosed;
  });
  /** @type {import('../lib/codex-api/websocket-heartbeat.js').CodexTransportStatus[]} */
  const statuses = [];
  /** @type {(() => void) | undefined} */
  let onStatus;
  const stream = await session.request({ body: { model: "fixture", stream: true, input: [] }, idleTimeoutMs, onTransportStatus(status) { statuses.push(status); onStatus?.(); } });
  const [peer] = await connection;
  /** @type {WebSocket} */
  const socket = peer;
  const reader = stream.getReader();
  /** @param {(status: import('../lib/codex-api/websocket-heartbeat.js').CodexTransportStatus) => boolean} predicate */
  const waitFor = (predicate) => new Promise((resolve) => {
    onStatus = () => {
      const status = statuses.at(-1);
      if (status && predicate(status)) resolve(status);
    };
    onStatus();
  });
  if (confirm) {
    const initialPing = once(socket, "ping");
    context.mock.timers.tick(0);
    const [payload] = await initialPing;
    const initialPong = waitFor((status) => status.heartbeat === "healthy");
    socket.pong(payload);
    await initialPong;
  }
  return { session, socket, reader, statuses, waitFor };
}

test("a server that never sends any traffic fails even without a first pong", { timeout: 10_000 }, async (context) => {
  const { session, socket, reader, statuses } = await fixture(context, 120_000, false);
  context.mock.timers.tick(0);
  assert.equal(statuses.at(-1)?.heartbeat, "probing");
  const rejected = assert.rejects(reader.read(), (error) => error instanceof CodexResponseWebSocketError && error.code === "heartbeat_timeout");
  context.mock.timers.tick(29_999);
  assert.equal(statuses.at(-1)?.heartbeat, "probing");
  context.mock.timers.tick(1);
  await rejected;
  assert.equal(statuses.at(-1)?.heartbeat, "failed");
  assert.equal(session.socket, undefined);
  socket.terminate();
});

test("real WebSocket probes remain healthy through quiet output and answer server pings", { timeout: 10_000 }, async (context) => {
  const { socket, reader, statuses, waitFor } = await fixture(context, 0);
  socket.on("ping", (payload) => socket.pong(payload));
  const serverPong = once(socket, "pong");
  socket.ping("server-fixture");
  const [payload] = await serverPong;
  assert.equal(String(payload), "server-fixture");
  for (let probe = 1; probe <= 6; probe += 1) {
    assert.equal(statuses.at(-1)?.nextPingAt, 1000 + probe * 15_000);
    const pong = waitFor((status) => status.lastPongAt === 1000 + probe * 15_000);
    context.mock.timers.tick(15_000);
    assert.equal(performance.now(), 1000 + probe * 15_000);
    assert.equal(statuses.at(-1)?.lastPingAt, 1000 + probe * 15_000);
    await pong;
  }
  assert.equal(statuses.at(-1)?.heartbeat, "healthy");
  assert.equal(statuses.at(-1)?.lastDataAt, undefined, "control frames never masquerade as response traffic");
  assert.equal(statuses.at(-1)?.responseIdleDeadlineAt, undefined);
  socket.send(JSON.stringify({ type: "response.completed", response: { id: "quiet", output: [] } }));
  const completed = await reader.read();
  assert.equal(completed.value?.type, "response.completed");
  const ended = await reader.read();
  assert.equal(ended.done, true);
  assert.equal(statuses.at(-1)?.nextPingAt, undefined, "completion clears the heartbeat");
});

test("missing pong fails the stream with a non-replayable heartbeat code and retires the socket", { timeout: 10_000 }, async (context) => {
  const { session, socket, reader, statuses } = await fixture(context, 120_000);
  const pendingRead = reader.read();
  const rejected = assert.rejects(pendingRead, (error) => error instanceof CodexResponseWebSocketError && error.code === "heartbeat_timeout" && !error.retryableWithFreshWebSocket && !error.retryableWithSseBeforeOutput);
  context.mock.timers.tick(15_000);
  context.mock.timers.tick(15_000);
  await rejected;
  assert.equal(session.socket, undefined);
  assert.equal(statuses.at(-1)?.heartbeat, "failed");
  assert.equal(statuses.at(-1)?.pongDeadlineAt, undefined);
  assert.equal(statuses.at(-1)?.responseIdleDeadlineAt, undefined);
  socket.terminate();
});

test("incoming fragments keep transport live without completing a response message", { timeout: 10_000 }, async (context) => {
  const { session, socket, reader, statuses } = await fixture(context, 120_000, false);
  assert.ok(session.socket);
  const receiveSocket = /** @type {import('node:net').Socket} */ (Reflect.get(session.socket, "_socket"));
  const originalDataListeners = receiveSocket.listenerCount("data");
  context.mock.timers.tick(0);
  for (let fragment = 0; fragment < 5; fragment += 1) {
    context.mock.timers.tick(10_000);
    const received = once(receiveSocket, "data");
    socket.send(fragment === 0 ? '{"type":"response.completed","response":{"id":"fragmented","output":[' : " ", { fin: false });
    await received;
    assert.equal(statuses.at(-1)?.pongDeadlineAt, performance.now() + 30_000);
    assert.equal(statuses.at(-1)?.responseIdleDeadlineAt, 121_000, "fragments do not count as complete response messages");
    assert.equal(statuses.at(-1)?.lastDataAt, undefined);
    assert.notEqual(statuses.at(-1)?.heartbeat, "failed");
  }
  socket.send("]}}", { fin: true });
  const completed = await reader.read();
  assert.equal(completed.value?.type, "response.completed");
  assert.equal(receiveSocket.listenerCount("data"), originalDataListeners - 1, "completion removes only the heartbeat byte listener");
});

test("an incomplete message fails after 30 seconds without further receive bytes", { timeout: 10_000 }, async (context) => {
  const { session, socket, reader, statuses } = await fixture(context, 120_000, false);
  assert.ok(session.socket);
  const receiveSocket = /** @type {import('node:net').Socket} */ (Reflect.get(session.socket, "_socket"));
  const originalDataListeners = receiveSocket.listenerCount("data");
  const rejected = assert.rejects(reader.read(), (error) => error instanceof CodexResponseWebSocketError && error.code === "heartbeat_timeout");
  context.mock.timers.tick(10_000);
  const received = once(receiveSocket, "data");
  socket.send('{"type":', { fin: false });
  await received;
  context.mock.timers.tick(29_999);
  assert.notEqual(statuses.at(-1)?.heartbeat, "failed");
  context.mock.timers.tick(1);
  await rejected;
  assert.equal(statuses.at(-1)?.heartbeat, "failed");
  assert.equal(receiveSocket.listenerCount("data"), originalDataListeners - 1);
  socket.terminate();
});

test("healthy pongs do not extend the response-idle deadline", { timeout: 10_000 }, async (context) => {
  const { socket, reader, statuses, waitFor } = await fixture(context, 120_000);
  socket.on("ping", (payload) => socket.pong(payload));
  const rejected = assert.rejects(reader.read(), /idle for 120000ms/u);
  for (let probe = 1; probe <= 7; probe += 1) {
    const pong = waitFor((status) => status.lastPongAt === 1000 + probe * 15_000);
    context.mock.timers.tick(15_000);
    await pong;
    assert.equal(statuses.at(-1)?.responseIdleDeadlineAt, 121_000);
  }
  context.mock.timers.tick(15_000);
  await rejected;
  assert.equal(statuses.at(-1)?.responseIdleDeadlineAt, undefined);
});