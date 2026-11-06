/** @type {Map<number, { id: number, model: string, sessionId: string, turn: number, stage: string, startedAt: number, lastEventAt: number | undefined, lastEventType?: string, lastProgressAt?: number, transportStatus?: import('../codex-api/websocket-heartbeat.js').CodexTransportStatus }>} */
const requests = new Map();
let nextId = 0;
/** @type {Set<() => void>} */
const listeners = new Set();

/** @param {() => void} listener */
export function onCocopiLiveRequestChange(listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notify() {
  for (const listener of listeners) listener();
}

/** @param {string} model */
export function startCocopiLiveRequest(model) {
  const id = ++nextId;
  requests.set(id, { id, model, sessionId: "", turn: 0, stage: "Preparing locally", startedAt: performance.now(), lastEventAt: undefined });
  notify();
  return {
    /** @param {import('../codex-api/websocket-heartbeat.js').CodexTransportStatus} status */
    recordTransportStatus(status) {
      const request = requests.get(id);
      if (request) {
        request.transportStatus = { ...status };
      }
    },
    /** @param {{ type: string, delta?: unknown }} event */
    recordEvent(event) {
      const request = requests.get(id);
      if (!request) return;
      request.lastEventAt = performance.now();
      request.lastEventType = event.type;
      if (/^response\.(?:output_text|reasoning_summary_text|reasoning_text|function_call_arguments)\.delta$/u.test(event.type) && "delta" in event && typeof event.delta === "string" && event.delta.length > 0) {
        request.lastProgressAt = performance.now();
      }
    },
    /** @param {{ model?: string, sessionId?: string, turn?: number, stage?: string, lastEventAt?: number }} update */
    update(update) {
      const request = requests.get(id);
      if (request) {
        const stageChanged = update.stage !== undefined && update.stage !== request.stage;
        Object.assign(request, update);
        if (stageChanged) notify();
      }
    },
    dispose() {
      if (requests.delete(id)) notify();
    }
  };
}

/** Read detached metadata snapshots; never retain request bodies. */
export function readCocopiLiveRequests() {
  return Array.from(requests.values(), (request) => ({ ...request, ...(request.transportStatus ? { transportStatus: { ...request.transportStatus } } : {}) }));
}