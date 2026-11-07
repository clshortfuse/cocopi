import { Buffer } from "node:buffer";

/** @type {WeakMap<import('ws').WebSocket, { confirmed: boolean, lastPongAt?: number }>} */
const capabilities = new WeakMap();

/**
 * Activity timestamps and deadlines use performance.now(), relative to Node's
 * process-wide time origin shared by the extension host and transport worker.
 * @typedef {object} CodexTransportStatus
 * @property {'websocket' | 'sse'} transport
 * @property {'probing' | 'unconfirmed' | 'waiting' | 'healthy' | 'unsupported' | 'failed' | 'closed'} heartbeat
 * @property {number | undefined} [lastPingAt]
 * @property {number | undefined} [lastPongAt]
 * @property {number | undefined} [lastServerPingAt]
 * @property {number | undefined} [pongDeadlineAt]
 * @property {number | undefined} [nextPingAt]
 * @property {number | undefined} [lastDataAt]
 * @property {number | undefined} [responseIdleDeadlineAt]
 */

/**
 * Enforce receive liveness from activation; never count control frames as model progress.
 * @param {import('ws').WebSocket} socket
 * @param {(status: Partial<CodexTransportStatus>) => void} report
 * @param {(error: Error) => void} fail
 * @param {{ intervalMs?: number, timeoutMs?: number }} [options]
 */
export function startWebSocketHeartbeat(socket, report, fail, options = {}) {
  const intervalMs = options.intervalMs ?? 15_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const capability = capabilities.get(socket);
  // ws emits "message" only after the final fragment. Observe its established
  // receive socket as well, without changing parsing or response-idle activity.
  const receiveSocket = /** @type {import('node:net').Socket | undefined} */ (Reflect.get(socket, "_socket"));
  let confirmed = capability?.confirmed === true;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let silenceTimer;
  let deadlineAt = performance.now() + timeoutMs;
  /** @type {Buffer | undefined} */
  let pending;
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(silenceTimer);
    socket.off("ping", ping);
    socket.off("pong", pong);
    socket.off("message", message);
    receiveSocket?.off("data", activity);
    socket.off("close", close);
    socket.off("error", close);
  };
  const close = () => {
    stop();
    report({ heartbeat: "closed", pongDeadlineAt: undefined, nextPingAt: undefined });
  };
  const failed = () => {
    if (stopped) return;
    stop();
    if (!confirmed) {
      capabilities.set(socket, { confirmed: false });
    }
    report({ heartbeat: "failed", pongDeadlineAt: undefined, nextPingAt: undefined });
    fail(new Error(`Codex WebSocket heartbeat received no incoming traffic for ${timeoutMs}ms.`));
  };
  const resetSilenceDeadline = () => {
    clearTimeout(silenceTimer);
    deadlineAt = performance.now() + timeoutMs;
    report({ pongDeadlineAt: deadlineAt });
    silenceTimer = setTimeout(failed, timeoutMs);
    silenceTimer.unref?.();
  };
  /** @param {number} [delayMs] */
  const schedule = (delayMs = intervalMs) => {
    clearTimeout(timer);
    report({ nextPingAt: performance.now() + delayMs });
    const probe = () => {
      if (stopped) return;
      pending = Buffer.from(crypto.randomUUID());
      const now = performance.now();
      report({ heartbeat: confirmed ? "waiting" : "probing", lastPingAt: now, nextPingAt: undefined, pongDeadlineAt: deadlineAt });
      try {
        socket.ping(pending, true, (error) => { if (error && !stopped) failed(); });
      } catch {
        if (!stopped) failed();
      }
    };
    if (delayMs === 0) {
      probe();
    } else {
      timer = setTimeout(probe, delayMs);
      timer.unref?.();
    }
  };
  const activity = () => {
    if (stopped) return;
    resetSilenceDeadline();
    report({ heartbeat: confirmed ? "healthy" : "unconfirmed" });
    schedule();
  };
  const ping = () => {
    report({ lastServerPingAt: performance.now() });
    activity();
  };
  const message = () => {
    report({ lastDataAt: performance.now() });
    activity();
  };
  /** @param {Buffer} data */
  const pong = (data) => {
    if (pending && data.equals(pending)) {
      pending = undefined;
      confirmed = true;
      const lastPongAt = performance.now();
      capabilities.set(socket, { confirmed: true, lastPongAt });
      report({ lastPongAt });
      activity();
    } else {
      activity();
    }
  };
  socket.on("ping", ping);
  socket.on("pong", pong);
  socket.on("message", message);
  receiveSocket?.on("data", activity);
  socket.on("close", close);
  socket.on("error", close);
  report({ heartbeat: confirmed ? "healthy" : "probing", lastPongAt: capability?.lastPongAt, pongDeadlineAt: undefined });
  resetSilenceDeadline();
  schedule(confirmed ? intervalMs : 0);
  return () => { stop(); report({ pongDeadlineAt: undefined, nextPingAt: undefined }); };
}