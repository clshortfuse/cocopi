import { setTimeout as delay } from "node:timers/promises";
import { CodexResponseWebSocketError } from "../codex-api/websocket.js";

const MAX_CHECKPOINT_BYTES = 1024 * 1024;
const RECOVERY_TIMEOUT_MS = 30_000;

/**
 * One provider-owned continuation, not server stream reattachment. All retained
 * payloads live only as long as this iterator; nothing enters persisted markers.
 * @param {AsyncIterable<import("../../data/Codex.js").CodexResponseStreamEvent>} events
 * @param {{
 *   signal: AbortSignal,
 *   completedItem: (event: import("../../data/Codex.js").CodexResponseStreamEvent) => import("../../data/Codex.js").CodexResponseInputItem | undefined,
 *   resume: (items: import("../../data/Codex.js").CodexResponseInputItem[], signal: AbortSignal) => Promise<AsyncIterable<import("../../data/Codex.js").CodexResponseStreamEvent>>,
 *   report: (message: string) => void
 * }} options
 * @yields {import("../../data/Codex.js").CodexResponseStreamEvent}
 */
export async function* withCompletedItemRecovery(events, options) {
  /** @type {import("../../data/Codex.js").CodexResponseInputItem[]} */
  const items = [];
  const completed = new Set();
  const pending = new Set();
  let bytes = 0;
  let unsafe = false;
  let recovered = false;
  let recoverySignal = options.signal;
  const startedAt = Date.now();
  let lastCompletedIndex = -1;
  try {
    while (true) {
      let readFailed = false;
      try {
        for await (const event of trackStreamReadErrors(events, () => { readFailed = true; })) {
          recoverySignal.throwIfAborted();
          const key = "output_index" in event ? event.output_index : ("item_id" in event ? event.item_id : undefined);
          // Tool execution belongs to the host, including arguments.done events
          // that the provider can report before output_item.done.
          if (event.type.includes("function_call") || ("item" in event && event.item?.type === "function_call")) {
            unsafe = true;
          }
          if (!unsafe && !recovered && (event.type.endsWith(".delta") || event.type === "response.output_item.added")) {
            if (key === undefined) {
              unsafe = true;
            } else {
              pending.add(key);
            }
          }
          if (!unsafe && !recovered && event.type === "response.output_item.done") {
            const item = options.completedItem(event);
            if (item && key !== undefined) {
              pending.delete(key);
              if (!completed.has(key)) {
                if (typeof key === "number" && key < lastCompletedIndex) {
                  unsafe = true;
                }
                if (typeof key === "number") {
                  lastCompletedIndex = key;
                }
                completed.add(key);
                bytes += new TextEncoder().encode(JSON.stringify(item)).byteLength;
                if (bytes <= MAX_CHECKPOINT_BYTES && completed.size <= 256) {
                  items.push(item);
                } else {
                  unsafe = true;
                  items.length = 0;
                }
              }
            } else {
              unsafe = true;
            }
          }
          if (pending.size > 256) {
            unsafe = true;
          }
          if (unsafe) {
            items.length = 0;
            completed.clear();
            pending.clear();
          }
          yield event;
          if (event.type === "response.completed") {
            if (recovered) {
              options.report("Codex recovery succeeded. mode=completed-items failedAttemptUsage=unknown");
            }
            return;
          }
        }
        throw new Error("Codex response stream ended without a terminal response.");
      } catch (error) {
        // Transport read errors only. Never interpret policy/auth/quota/terminal
        // failures as transport failures based on their human-readable message.
        const transient = error instanceof CodexResponseWebSocketError
          ? !error.code && (error.closeCode === undefined || [1001, 1006, 1011, 1012, 1013].includes(error.closeCode))
          : error instanceof TypeError;
        if (recovered || unsafe || pending.size > 0 || items.length === 0 || options.signal.aborted || Date.now() - startedAt > 120_000 || !readFailed || !transient) {
          throw error;
        }
        recovered = true;
        recoverySignal = AbortSignal.any([options.signal, AbortSignal.timeout(RECOVERY_TIMEOUT_MS)]);
        options.report(`Codex recovery started. mode=completed-items attempt=1 completedItems=${items.length} checkpointBytes=${bytes} failedAttemptUsage=unknown`);
        await delay(200, undefined, { signal: recoverySignal });
        events = await options.resume([...items], recoverySignal);
        // No second recovery is allowed, so release the checkpoint immediately.
        items.length = 0;
        completed.clear();
        pending.clear();
      }
    }
  } catch (error) {
    if (recovered) {
      const status = options.signal.aborted ? "cancelled" : "failed";
      options.report(`Codex recovery ${status}. mode=completed-items attempt=1 failedAttemptUsage=unknown`);
    }
    throw error;
  } finally {
    items.length = 0;
    completed.clear();
    pending.clear();
  }
}

/**
 * Keep local checkpoint/normalization failures outside the transport boundary.
 * @param {AsyncIterable<import("../../data/Codex.js").CodexResponseStreamEvent>} events
 * @param {() => void} onReadError
 * @yields {import("../../data/Codex.js").CodexResponseStreamEvent}
 */
async function* trackStreamReadErrors(events, onReadError) {
  try {
    yield* events;
  } catch (error) {
    onReadError();
    throw error;
  }
}