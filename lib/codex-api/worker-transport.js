import { Buffer } from "node:buffer";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { CodexWorkerError, decodeWorkerError, WORKER_LIMITS, WORKER_PROTOCOL_VERSION } from "./worker-protocol.js";

/** @typedef {import("../../data/Codex.js").CodexResponseStreamEvent} ResponseEvent */

export class CodexWorkerTransport {
  /** @param {{ url?: URL }} [options] */
  constructor(options = {}) {
    this.generation = crypto.randomUUID();
    /** @type {Map<string, { receive: (message: Extract<import("./worker-protocol.js").WorkerMessage, { type: "record" }>) => void, fail: (error: Error) => void }>} */
    this.invocations = new Map();
    this.closed = false;
    this.uploadBytes = 0;
    /** @type {import("./worker-protocol.js").WorkerMetrics | undefined} */
    this.metrics = undefined;
    this.directory = mkdtempSync(path.join(tmpdir(), `cocopi-transport-v1-${process.pid}-`));
    this.worker = new Worker(options.url ?? new URL("transport-worker.js", import.meta.url), {
      workerData: { generation: this.generation, directory: this.directory },
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "SYSTEMROOT", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"].includes(key.toUpperCase()))),
      resourceLimits: { maxOldGenerationSizeMb: 256 },
      execArgv: []
    });
    /** @type {Promise<void>} */
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.fail(new CodexWorkerError("Codex transport worker did not start.")); }, 30_000);
      this.worker.on("message", /** @param {import("./worker-protocol.js").WorkerMessage} message */ (message) => {
        if (this.closed) {
          return;
        }
        if (!message || typeof message !== "object" || message.version !== WORKER_PROTOCOL_VERSION || message.generation !== this.generation) {
          this.fail(new CodexWorkerError("Codex transport worker protocol mismatch."));
          return;
        }
        if (message.type === "ready") {
          clearTimeout(timeout);
          resolve();
        } else if (message.type === "record") {
          if (typeof message.id !== "string" || typeof message.data !== "string" || !Number.isSafeInteger(message.sequence)) {
            this.fail(new CodexWorkerError("Codex transport worker sent an invalid delivery envelope."));
            return;
          }
          this.invocations.get(message.id)?.receive(message);
        } else {
          this.fail(new CodexWorkerError("Codex transport worker sent an invalid envelope."));
        }
      });
      this.worker.on("error", () => {
        clearTimeout(timeout);
        const error = new CodexWorkerError("Codex transport worker failed; in-flight generations were not replayed. Usage may be unknown.");
        reject(error);
        this.fail(error);
      });
      this.worker.on("exit", () => {
        clearTimeout(timeout);
        void rm(this.directory, { recursive: true, force: true }).catch(() => {});
        const error = new CodexWorkerError("Codex transport worker exited; in-flight generations were not replayed. Usage may be unknown.");
        reject(error);
        this.fail(error);
      });
    });
    void this.ready.catch(() => {});
  }

  /**
   * @param {import("./transport.js").TransportOptions} options
   * @returns {Promise<ReadableStream<ResponseEvent>>}
   */
  async request(options) {
    options.signal?.throwIfAborted();
    await this.ready;
    options.signal?.throwIfAborted();
    if (this.closed || this.invocations.size >= WORKER_LIMITS.requests) {
      throw new CodexWorkerError("Codex transport worker is closed or its concurrent request budget is exhausted.");
    }
    const { signal, onWebSocketRequestPrepared, onWebSocketContinuationDecision, onWebSocketResponseCancel, onWebSocketReconnect, onWebSocketFallbackToSse, WebSocketConstructor, fetch: fetchOverride, ...plain } = options;
    void WebSocketConstructor;
    void fetchOverride;
    const json = JSON.stringify(plain);
    const uploadBytes = Buffer.byteLength(json);
    if (uploadBytes > WORKER_LIMITS.uploadBytes || this.uploadBytes + uploadBytes > WORKER_LIMITS.uploadTotalBytes) {
      throw new CodexWorkerError("Codex transport worker request upload budget exceeded.");
    }
    const id = crypto.randomUUID();
    let sequence = 0;
    let acknowledged = 0;
    let opened = false;
    /** @type {ResponseEvent | undefined} */
    let pending;
    /** @type {ReadableStreamDefaultController<ResponseEvent>} */
    let controller;
    /** @type {(() => void) | undefined} */
    let resolvePull;
    /** @type {() => void} */
    let resolveOpened;
    /** @type {(error: Error) => void} */
    let rejectOpened;
    /** @type {Promise<void>} */
    const opening = new Promise((resolve, reject) => { resolveOpened = resolve; rejectOpened = reject; });
    const send = /** @param {import("./worker-protocol.js").HostMessage} message */ (message) => this.worker.postMessage(message);
    const ack = () => {
      if (sequence > acknowledged && this.invocations.has(id)) {
        acknowledged = sequence;
        send({ version: WORKER_PROTOCOL_VERSION, generation: this.generation, id, type: "ack", sequence });
      }
    };
    const cleanup = () => {
      if (this.invocations.delete(id)) {
        this.uploadBytes -= uploadBytes;
      }
      signal?.removeEventListener("abort", abort);
      resolvePull?.();
      resolvePull = undefined;
    };
    const abort = () => {
      send({ version: WORKER_PROTOCOL_VERSION, generation: this.generation, id, type: "cancel" });
      fail(signal?.reason instanceof Error ? signal.reason : new DOMException("Codex worker request cancelled.", "AbortError"));
    };
    const fail = /** @param {Error} error */ (error) => {
      if (!opened) {
        rejectOpened(error);
      }
      controller.error(error);
      pending = undefined;
      cleanup();
    };
    const stream = new ReadableStream({
      start(value) { controller = value; },
      pull() {
        if (pending) {
          controller.enqueue(pending);
          pending = undefined;
          return;
        }
        ack(); // Previous event has left the stream queue, not just the port.
        return new Promise((resolve) => { resolvePull = resolve; });
      },
      cancel: () => {
        send({ version: WORKER_PROTOCOL_VERSION, generation: this.generation, id, type: "cancel" });
        cleanup();
      }
    }, { highWaterMark: 0 });
    this.uploadBytes += uploadBytes;
    this.invocations.set(id, {
      fail,
      receive: (message) => {
        try {
          if (message.sequence !== sequence + 1 || Buffer.byteLength(message.data) > WORKER_LIMITS.eventBytes || pending) {
            throw new CodexWorkerError("Codex transport worker delivery sequence or byte budget violated.");
          }
          sequence = message.sequence;
          /** @type {import("./worker-protocol.js").DeliveryRecord} */
          const record = JSON.parse(message.data);
          switch (record.type) {
            case "event": {
              if (resolvePull) {
                controller.enqueue(record.event);
                resolvePull();
                resolvePull = undefined;
              } else {
                pending = record.event;
              }
              return;
            }
            case "opened": { opened = true; resolveOpened(); break; }
            case "prepared": {
              onWebSocketRequestPrepared?.({ ...options.body,
                ...(record.previousResponseId ? { previous_response_id: record.previousResponseId } : {}),
                ...(record.inputItems !== undefined && Array.isArray(options.body.input) ? { input: options.body.input.slice(options.body.input.length - record.inputItems) } : {})
              });
              break;
            }
            case "decision": { onWebSocketContinuationDecision?.(record.decision); break; }
            case "cancelled": { onWebSocketResponseCancel?.(); break; }
            case "reconnect": { onWebSocketReconnect?.(decodeWorkerError(record.error)); break; }
            case "fallback": { onWebSocketFallbackToSse?.(decodeWorkerError(record.error)); break; }
            case "end": { this.metrics = record.metrics; ack(); controller.close(); cleanup(); return; }
            case "error": { this.metrics = record.metrics; ack(); fail(decodeWorkerError(record.error)); return; }
            default: { throw new CodexWorkerError("Codex transport worker sent an invalid record."); }
          }
          ack();
        } catch (error) {
          send({ version: WORKER_PROTOCOL_VERSION, generation: this.generation, id, type: "cancel" });
          fail(error instanceof CodexWorkerError ? error : new CodexWorkerError("Codex transport worker delivery failed locally."));
        }
      }
    });
    signal?.addEventListener("abort", abort, { once: true });
    send({ version: WORKER_PROTOCOL_VERSION, generation: this.generation, id, type: "start", options: json });
    await opening;
    return stream;
  }

  /** @param {Error} error */
  fail(error) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const invocation of this.invocations.values()) {
      invocation.fail(error);
    }
    void this.worker.terminate();
  }

  dispose() {
    if (this.closed) {
      return;
    }
    this.worker.postMessage({ version: WORKER_PROTOCOL_VERSION, generation: this.generation, id: "", type: "shutdown" });
    this.closed = true;
    for (const invocation of this.invocations.values()) {
      invocation.fail(new CodexWorkerError("Codex transport worker disposed or credentials invalidated."));
    }
  }
}