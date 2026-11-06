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
 * Probe only WebSocket control-frame liveness; never count pongs as model progress.
 * @param {import('ws').WebSocket} socket
 * @param {(status: Partial<CodexTransportStatus>) => void} report
 * @param {(error: Error) => void} fail
 * @param {{ intervalMs?: number, timeoutMs?: number }} [options]
 */
export function startWebSocketHeartbeat(socket, report, fail, options = {}) {
  const intervalMs = options.intervalMs ?? 30_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const capability = capabilities.get(socket);
  let confirmed = capability?.confirmed === true;
  if (capability && !confirmed) {
    report({ heartbeat: "unconfirmed", pongDeadlineAt: undefined, nextPingAt: undefined });
    return () => {};
  }
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {Buffer | undefined} */
  let pending;
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    socket.off("ping", ping);
    socket.off("pong", pong);
    socket.off("close", close);
    socket.off("error", close);
  };
  const close = () => {
    stop();
    report({ heartbeat: "closed", pongDeadlineAt: undefined, nextPingAt: undefined });
  };
  const failed = () => {
    stop();
    if (!confirmed) {
      capabilities.set(socket, { confirmed: false });
      report({ heartbeat: "unconfirmed", pongDeadlineAt: undefined, nextPingAt: undefined });
      return;
    }
    report({ heartbeat: "failed", pongDeadlineAt: undefined, nextPingAt: undefined });
    fail(new Error(`Codex WebSocket heartbeat received no matching pong within ${timeoutMs}ms.`));
  };
  /** @param {number} [delayMs] */
  const schedule = (delayMs = intervalMs) => {
    report({ nextPingAt: performance.now() + delayMs });
    const probe = () => {
      if (stopped) return;
      pending = Buffer.from(crypto.randomUUID());
      const now = performance.now();
      report({ heartbeat: confirmed ? "waiting" : "probing", lastPingAt: now, nextPingAt: undefined, pongDeadlineAt: now + timeoutMs });
      timer = setTimeout(failed, timeoutMs);
      timer.unref?.();
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
  const ping = () => { report({ lastServerPingAt: performance.now() }); };
  /** @param {Buffer} data */
  const pong = (data) => {
    if (pending && data.equals(pending)) {
      pending = undefined;
      clearTimeout(timer);
      confirmed = true;
      const lastPongAt = performance.now();
      capabilities.set(socket, { confirmed: true, lastPongAt });
      report({ heartbeat: "healthy", lastPongAt, pongDeadlineAt: undefined });
      schedule();
    }
  };
  socket.on("ping", ping);
  socket.on("pong", pong);
  socket.on("close", close);
  socket.on("error", close);
  report({ heartbeat: confirmed ? "healthy" : "probing", lastPongAt: capability?.lastPongAt, pongDeadlineAt: undefined });
  schedule(confirmed ? intervalMs : 0);
  return () => { stop(); report({ pongDeadlineAt: undefined, nextPingAt: undefined }); };
}