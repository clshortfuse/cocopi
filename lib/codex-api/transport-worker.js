import { monitorEventLoopDelay } from "node:perf_hooks";
import { parentPort, workerData } from "node:worker_threads";
import WebSocket from "ws";
import { CodexTransport } from "./transport.js";
import { cleanStaleWorkerStorage, WorkerDeliveryBuffer } from "./worker-buffer.js";
import { CodexWorkerError, encodeWorkerError, WORKER_LIMITS, WORKER_PROTOCOL_VERSION } from "./worker-protocol.js";
import { createWorkerStatusChannel } from "./worker-status.js";
import { WorkerHistory } from "./worker-history.js";

const port = parentPort;
if (!port) {
  throw new CodexWorkerError("Codex transport must run in a worker.");
}
const generation = String(workerData.generation);
const transport = new CodexTransport({ cacheBytes: 16 * 1024 * 1024, sessions: 32 });
const history = new WorkerHistory(WORKER_LIMITS.uploadBytes);
/** @type {import('../../data/Codex.js').CodexResponseInputItem[]} */
let historyInput = [];
cleanStaleWorkerStorage();
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

/** @type {typeof fetch} */
async function boundedFetch(input, init) {
  const response = await fetch(input, init);
  if (!response.body) {
    return response;
  }
  const reader = response.body.getReader();
  const streamed = response.headers.get("content-type")?.includes("text/event-stream");
  let bytes = 0;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          reader.releaseLock();
          return;
        }
        bytes = streamed ? result.value.byteLength : bytes + result.value.byteLength;
        if (bytes > WORKER_LIMITS.eventBytes) {
          throw new CodexWorkerError("Codex local HTTP response buffer limit exceeded.");
        }
        controller.enqueue(result.value);
      } catch (error) {
        await reader.cancel().catch(() => {});
        controller.error(error);
      }
    },
    cancel(reason) { return reader.cancel(reason); }
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

class BoundedWebSocket extends WebSocket {
  /**
   * @param {string | URL} url
   * @param {import("ws").ClientOptions} options
   */
  constructor(url, options) {
    super(url, { ...options, autoPong: true, maxPayload: WORKER_LIMITS.eventBytes, perMessageDeflate: false, handshakeTimeout: 30_000 });
  }
}

/** @typedef {{ abort: AbortController, buffer: WorkerDeliveryBuffer, uploadBytes: number, reusedHistoryItems: number, sequence: number, inFlight: boolean, status: ReturnType<typeof createWorkerStatusChannel>, ended: boolean, events: number, lastDecodedAt: number, maxDecodedGapMs: number, sentAt: number, maxAcknowledgmentLagMs: number, terminal?: import("./worker-protocol.js").DeliveryRecord }} Invocation */
/** @type {Map<string, Invocation>} */
const invocations = new Map();
let uploadBytes = 0;

/**
 * @param {string} id
 * @param {Invocation} invocation
 */
function flush(id, invocation) {
  if (invocation.inFlight || !invocations.has(id)) {
    return;
  }
  let data;
  try {
    data = invocation.buffer.shift();
  } catch (error) {
    invocation.abort.abort();
    invocation.buffer.dispose();
    invocation.terminal = { type: "error", error: encodeWorkerError(/** @type {Error} */ (error)) };
  }
  if (data === undefined && invocation.terminal) {
    if (invocation.terminal.type === "end" || invocation.terminal.type === "error") {
      const memory = process.memoryUsage();
      invocation.terminal.metrics = {
        requestUploadBytes: invocation.uploadBytes,
        retainedHistoryBytes: history.bytes,
        retainedHistoryItems: history.items.length,
        reusedHistoryItems: invocation.reusedHistoryItems,
        events: invocation.events,
        maxDecodedGapMs: invocation.maxDecodedGapMs,
        maxAcknowledgmentLagMs: invocation.maxAcknowledgmentLagMs,
        memoryHighWaterBytes: invocation.buffer.memoryHighWater,
        spoolHighWaterBytes: invocation.buffer.diskHighWater,
        workerHeapBytes: memory.heapUsed,
        workerExternalBytes: memory.external,
        workerArrayBufferBytes: memory.arrayBuffers,
        cachedSessions: transport.sessions.size,
        continuationAnchors: [...transport.sessions.values()].reduce((count, session) => count + session.continuationAnchors.length, 0),
        sharedProcessRssBytes: memory.rss,
        workerEventLoopDelayMaxMs: eventLoopDelay.max / 1_000_000
      };
    }
    data = JSON.stringify(invocation.terminal);
    invocation.terminal = undefined;
    invocation.ended = true;
  }
  if (data !== undefined) {
    invocation.inFlight = true;
    invocation.sentAt = performance.now();
    port?.postMessage({ version: WORKER_PROTOCOL_VERSION, generation, type: "record", id, sequence: ++invocation.sequence, data });
  }
}

/**
 * @param {string} id
 * @param {Invocation} invocation
 * @param {import("./worker-protocol.js").DeliveryRecord} record
 */
function deliver(id, invocation, record) {
  if (!invocation.abort.signal.aborted) {
    invocation.buffer.push(record);
    flush(id, invocation);
  }
}

/**
 * @param {string} id
 * @param {Invocation} invocation
 * @param {Uint8Array} upload
 * @param {boolean} observeTransportStatus
 */
async function run(id, invocation, upload, observeTransportStatus) {
  try {
    /** @type {import("./transport.js").TransportOptions & { history?: import('./worker-history.js').HistoryPatch, arrayInput?: boolean }} */
    const options = JSON.parse(new TextDecoder().decode(upload));
    upload = new Uint8Array();
    // Port handlers reach this synchronous application before the network await.
    // Each invocation owns a distinct array, including after rewind/rewrite.
    if (options.history) {
      const nextInput = [...historyInput.slice(0, options.history.keep),
        ...options.history.suffix.map((item) => JSON.parse(item))];
      history.apply(options.history);
      invocation.reusedHistoryItems = options.history.keep;
      historyInput = nextInput;
      if (options.arrayInput) options.body.input = nextInput;
      port?.postMessage({ version: WORKER_PROTOCOL_VERSION, generation, type: "history-ack", revision: history.revision });
    }
    const stream = await transport.request({
      ...options,
      maxEventBytes: WORKER_LIMITS.eventBytes,
      maxRetainedOutputBytes: WORKER_LIMITS.eventBytes,
      fetch: boundedFetch,
      signal: invocation.abort.signal,
      WebSocketConstructor: /** @type {typeof globalThis.WebSocket} */ (/** @type {object} */ (BoundedWebSocket)),
      onTransportStatus: observeTransportStatus ? (status) => invocation.status.update(status) : undefined,
      onWebSocketRequestPrepared: (body) => deliver(id, invocation, { type: "prepared", inputItems: Array.isArray(body.input) ? body.input.length : undefined, previousResponseId: body.previous_response_id }),
      onWebSocketContinuationDecision: (decision) => deliver(id, invocation, { type: "decision", decision }),
      onWebSocketResponseCancel: () => deliver(id, invocation, { type: "cancelled" }),
      onWebSocketReconnect: (error) => deliver(id, invocation, { type: "reconnect", error: encodeWorkerError(error) }),
      onWebSocketFallbackToSse: (error) => deliver(id, invocation, { type: "fallback", error: encodeWorkerError(error) })
    });
    deliver(id, invocation, { type: "opened" });
    for await (const event of stream) {
      const now = performance.now();
      if (invocation.events > 0) {
        invocation.maxDecodedGapMs = Math.max(invocation.maxDecodedGapMs, now - invocation.lastDecodedAt);
      }
      invocation.lastDecodedAt = now;
      invocation.events += 1;
      deliver(id, invocation, { type: "event", event });
      if (["response.completed", "response.failed", "response.incomplete"].includes(event.type)) {
        break;
      }
    }
    invocation.terminal = { type: "end" };
  } catch (error) {
    invocation.terminal = { type: "error", error: encodeWorkerError(error instanceof Error ? error : new CodexWorkerError("Codex worker transport failed.")) };
    invocation.abort.abort();
  } finally {
    transport.trimSessions();
    flush(id, invocation);
  }
}

/** @param {string} id */
function dispose(id) {
  const invocation = invocations.get(id);
  if (invocation) {
    invocations.delete(id);
    invocation.status.dispose();
    uploadBytes -= invocation.uploadBytes;
    invocation.abort.abort();
    invocation.buffer.dispose();
  }
}

port.on("message", /** @param {import("./worker-protocol.js").HostMessage} message */ (message) => {
  if (message.version !== WORKER_PROTOCOL_VERSION || message.generation !== generation) {
    throw new CodexWorkerError("Codex worker protocol mismatch.");
  }
  if (message.type === "shutdown") {
    for (const id of invocations.keys()) {
      dispose(id);
    }
    transport.dispose();
    eventLoopDelay.disable();
    port.close();
    return;
  }
  if (message.type === "start") {
    const bytes = message.options.byteLength;
    if (invocations.has(message.id) || invocations.size >= WORKER_LIMITS.requests || bytes > WORKER_LIMITS.uploadBytes || uploadBytes + bytes > WORKER_LIMITS.uploadTotalBytes) {
      throw new CodexWorkerError("Codex worker request budget exceeded.");
    }
    const status = createWorkerStatusChannel((snapshot) => port.postMessage({ version: WORKER_PROTOCOL_VERSION, generation, type: "transport-status", id: message.id, status: snapshot }));
    const invocation = { abort: new AbortController(), buffer: new WorkerDeliveryBuffer({ directory: String(workerData.directory) }), uploadBytes: bytes, reusedHistoryItems: 0, sequence: 0, inFlight: false, status, ended: false, events: 0, lastDecodedAt: 0, maxDecodedGapMs: 0, sentAt: 0, maxAcknowledgmentLagMs: 0 };
    uploadBytes += bytes;
    invocations.set(message.id, invocation);
    // Admission is not stream opening: a healthy shared socket may be serving
    // an earlier request. Acknowledge before waiting on the session queue.
    port.postMessage({ version: WORKER_PROTOCOL_VERSION, generation, type: "accepted", id: message.id });
    void run(message.id, invocation, message.options, message.observeTransportStatus);
    return;
  }
  const invocation = invocations.get(message.id);
  if (!invocation) {
    return;
  }
  if (message.type === "cancel") {
    dispose(message.id);
  } else if (message.type === "status-ack" && invocation.status.acknowledge()) {
    // Independent status credit; output delivery credit is unchanged.
  } else if (message.type === "ack" && invocation.inFlight && message.sequence === invocation.sequence) {
    invocation.maxAcknowledgmentLagMs = Math.max(invocation.maxAcknowledgmentLagMs, performance.now() - invocation.sentAt);
    invocation.inFlight = false;
    if (invocation.ended) {
      dispose(message.id);
    } else {
      flush(message.id, invocation);
    }
  } else {
    throw new CodexWorkerError("Codex worker received an invalid delivery acknowledgment.");
  }
});
port.postMessage({ version: WORKER_PROTOCOL_VERSION, generation, type: "ready" });