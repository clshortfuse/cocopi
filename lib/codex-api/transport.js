import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { fetchCodexResponseStream } from "./responses.js";
import { CodexResponseWebSocketError, CodexResponsesWebSocketSession, fetchCodexResponseWebSocketStream, isCodexPreviousResponseNotFoundError } from "./websocket.js";

/** @typedef {import("../../data/Codex.js").CodexResponseStreamEvent} ResponseEvent */
/**
 * @typedef {import("./websocket.js").CodexWebSocketStreamOptions & {
 * transport?: string,
 * maxEventBytes?: number,
 * fetch?: typeof fetch,
 * onWebSocketReconnect?: (error: Error) => void,
 * onWebSocketFallbackToSse?: (error: Error) => void
 * }} TransportOptions
 */
const SAFE_EVENTS = new Set(["codex.rate_limits", "codex.response.metadata", "response.created", "response.in_progress"]);

export class CodexTransport {
  /** @param {{ cacheBytes?: number, sessions?: number }} [limits] */
  constructor(limits = {}) {
    this.limits = limits;
    /** @type {Map<string, CodexResponsesWebSocketSession>} */
    this.sessions = new Map();
  }

  /** @param {TransportOptions} options */
  async request(options) {
    if (options.transport !== "websocket" || options.body.stream === false) {
      return fetchCodexResponseStream(options);
    }
    const stream = await this.websocket(options);
    let reader = stream.getReader();
    let fallbackAllowed = true;
    let retries = 0;
    return new ReadableStream({
      pull: async (controller) => {
        while (true) {
          try {
            const result = await reader.read();
            if (result.done) {
              reader.releaseLock();
              controller.close();
            } else {
              if (!SAFE_EVENTS.has(result.value.type)) {
                fallbackAllowed = false;
              }
              controller.enqueue(result.value);
            }
            return;
          } catch (error) {
            reader.releaseLock();
            if (!options.signal?.aborted && fallbackAllowed && error instanceof CodexResponseWebSocketError) {
              if (retries < 1 && error.retryableWithFreshWebSocket) {
                retries += 1;
                options.onWebSocketReconnect?.(error);
                const retryStream = await this.websocket(options);
                reader = retryStream.getReader();
                continue;
              }
              if (error.retryableWithSseBeforeOutput || (!options.body.previous_response_id && isCodexPreviousResponseNotFoundError(error))) {
                fallbackAllowed = false;
                options.onWebSocketFallbackToSse?.(error);
                const fallbackStream = await fetchCodexResponseStream(options);
                reader = fallbackStream.getReader();
                continue;
              }
            }
            throw error;
          }
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      }
    }, { highWaterMark: 0 });
  }

  /** @param {TransportOptions} options */
  websocket(options) {
    const conversationId = options.body.prompt_cache_key;
    if (!conversationId) {
      return fetchCodexResponseWebSocketStream(options);
    }
    const key = [options.apiBaseUrl, createHash("sha256").update(options.accessToken).digest("base64url"), options.chatgptAccountId ?? "", options.clientVersion ?? "", conversationId].join("\n");
    let session = this.sessions.get(key);
    if (!session) {
      session = new CodexResponsesWebSocketSession({ ...options, conversationId });
      this.sessions.set(key, session);
    }
    return session.request(options);
  }

  dispose() {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
  }

  trimSessions() {
    let bytes = 0;
    for (const [key, session] of [...this.sessions].toReversed()) {
      if (session.activeRequest) {
        continue;
      }
      for (let index = session.continuationAnchors.length - 1; index >= 0; index -= 1) {
        const size = Buffer.byteLength(JSON.stringify(session.continuationAnchors[index]));
        if (this.limits.cacheBytes !== undefined && bytes + size > this.limits.cacheBytes) {
          session.continuationAnchors.splice(index, 1);
        } else {
          bytes += size;
        }
      }
      if (this.limits.sessions !== undefined && this.sessions.size > this.limits.sessions) {
        session.dispose();
        this.sessions.delete(key);
      }
    }
  }
}