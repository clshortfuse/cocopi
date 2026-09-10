import { CodexResponseStreamError } from "./responses.js";
import { CodexResponseWebSocketError } from "./websocket.js";

export const WORKER_PROTOCOL_VERSION = 1;
export const WORKER_LIMITS = Object.freeze({ requests: 8, uploadBytes: 16 * 1024 * 1024, uploadTotalBytes: 32 * 1024 * 1024, eventBytes: 4 * 1024 * 1024, memoryBytes: 1024 * 1024, diskBytes: 64 * 1024 * 1024, records: 100_000 });

/** @typedef {{ name: string, message: string, code?: string, closeCode?: number, retryableWithSseBeforeOutput?: boolean, retryableWithFreshWebSocket?: boolean, event?: import("../../data/Codex.js").CodexResponseStreamEvent }} ErrorEnvelope */
/** @typedef {{ events: number, maxDecodedGapMs: number, maxAcknowledgmentLagMs: number, memoryHighWaterBytes: number, spoolHighWaterBytes: number, workerHeapBytes: number, sharedProcessRssBytes: number, workerEventLoopDelayMaxMs: number }} WorkerMetrics */
/** @typedef {{ type: "event", event: import("../../data/Codex.js").CodexResponseStreamEvent } | { type: "opened" } | { type: "end", metrics?: WorkerMetrics } | { type: "error", error: ErrorEnvelope, metrics?: WorkerMetrics } | { type: "prepared", inputItems?: number, previousResponseId?: string } | { type: "decision", decision: import("../../data/Codex.js").CodexPreviousResponseDecision } | { type: "reconnect" | "fallback", error: ErrorEnvelope } | { type: "cancelled" }} DeliveryRecord */
/** @typedef {{ version: number, generation: string, id: string, type: "start", options: string } | { version: number, generation: string, id: string, type: "ack", sequence: number } | { version: number, generation: string, id: string, type: "cancel" } | { version: number, generation: string, id: string, type: "shutdown" }} HostMessage */
/** @typedef {{ version: number, generation: string, type: "ready" } | { version: number, generation: string, type: "record", id: string, sequence: number, data: string }} WorkerMessage */

// Not a TypeError or WebSocket error: local storage/worker failures must never
// become eligible for a paid completed-item continuation.
export class CodexWorkerError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "CodexWorkerError";
  }
}

/**
 * @param {Error} error
 * @returns {ErrorEnvelope}
 */
export function encodeWorkerError(error) {
  return {
    name: error.name,
    message: error.message,
    ...(error instanceof CodexResponseWebSocketError ? {
      code: error.code, closeCode: error.closeCode,
      retryableWithFreshWebSocket: error.retryableWithFreshWebSocket,
      retryableWithSseBeforeOutput: error.retryableWithSseBeforeOutput
    } : {}),
    ...(error instanceof CodexResponseStreamError ? { event: error.event } : {})
  };
}

/** @param {ErrorEnvelope} error */
export function decodeWorkerError(error) {
  switch (error.name) {
    case "CodexResponseWebSocketError": { return new CodexResponseWebSocketError(error.message, error); }
    case "CodexResponseStreamError": { return new CodexResponseStreamError(error.message, { event: error.event }); }
    case "TypeError": { return new TypeError(error.message); }
    case "AbortError": { return new DOMException(error.message, "AbortError"); }
    case "CodexWorkerError": { return new CodexWorkerError(error.message); }
    default: { return new Error(error.message); }
  }
}