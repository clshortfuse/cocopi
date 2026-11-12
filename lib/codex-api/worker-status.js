/** @typedef {import('./websocket-heartbeat.js').CodexTransportStatus} Status */

/**
 * One in-flight snapshot and one latest pending snapshot, independent of output.
 * @param {(status: Status) => void} send
 * @param {{ intervalMs?: number, now?: () => number }} [options]
 */
export function createWorkerStatusChannel(send, options = {}) {
  const intervalMs = options.intervalMs ?? 100;
  const now = options.now ?? (() => performance.now());
  /** @type {Status | undefined} */
  let pending;
  /** @type {Status | undefined} */
  let previous;
  let sentAt = Number.NEGATIVE_INFINITY;
  let inFlight = false;
  let disposed = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const flush = () => {
    if (disposed || inFlight || !pending) return;
    const changed = previous?.transport !== pending.transport || previous?.heartbeat !== pending.heartbeat ||
      (previous?.responseIdleDeadlineAt !== undefined && pending.responseIdleDeadlineAt === undefined);
    const remaining = sentAt + intervalMs - now();
    if (!changed && remaining > 0) {
      timer ??= setTimeout(() => { timer = undefined; flush(); }, remaining);
      timer.unref?.();
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    previous = pending;
    pending = undefined;
    sentAt = now();
    inFlight = true;
    send(previous);
  };
  return {
    /** @param {Status} status */
    update(status) {
      if (disposed) return;
      pending = status;
      flush();
    },
    acknowledge() {
      if (disposed || !inFlight) return false;
      inFlight = false;
      flush();
      return true;
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      timer = undefined;
      pending = undefined;
      previous = undefined;
    }
  };
}