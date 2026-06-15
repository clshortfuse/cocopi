import { createHash } from "node:crypto";

import { listCodexModels } from "../codex-api/models.js";
import { fetchCodexRateLimits, fetchCodexUsageAnalytics } from "../codex-api/rate-limits.js";
import { fetchCodexResponseStream } from "../codex-api/responses.js";
import { CodexResponseWebSocketError, CodexResponsesWebSocketSession, fetchCodexResponseWebSocketStream, isCodexPreviousResponseNotFoundError } from "../codex-api/websocket.js";
import { isCodexAuthFailure, refreshStoredCodexAuth } from "./runtime.js";

/** @typedef {import("../../data/Codex.js").CodexModelSummary} CodexModelSummary */
/** @typedef {import("../codex-api/rate-limits.js").CodexRateLimitSnapshot} CodexRateLimitSnapshot */
/** @typedef {import("../codex-api/rate-limits.js").CodexUsageAnalyticsSnapshot} CodexUsageAnalyticsSnapshot */
/** @typedef {import("../../data/Codex.js").CodexResponseCreateRequest} CodexResponseCreateRequest */
/** @typedef {import("../../data/Codex.js").CodexResponseStreamEvent} CodexResponseStreamEvent */
/** @typedef {import("./runtime.js").CocopiRuntime} CocopiRuntime */
/** @typedef {import("./runtime.js").CocopiSecretContext} CocopiSecretContext */

/** @type {Map<string, CodexResponsesWebSocketSession>} */
const codexResponsesWebSocketSessions = new Map();
const WEBSOCKET_FALLBACK_SAFE_EVENT_TYPES = new Set(["codex.rate_limits", "response.created", "response.in_progress"]);
const MAX_FRESH_WEBSOCKET_RETRIES = 1;

/**
 * @param {CocopiSecretContext} context
 * @param {CocopiRuntime} runtime
 * @returns {Promise<CodexModelSummary[]>}
 */
export async function listCodexModelsWithAuthRefresh(context, runtime) {
  if (!runtime.auth) {
    throw new Error("Cocopi is not signed in.");
  }

  try {
    return await listCodexModels({
      apiBaseUrl: runtime.configuration.apiBaseUrl,
      accessToken: runtime.auth.accessToken,
      chatgptAccountId: runtime.auth.chatgptAccountId,
      clientVersion: runtime.clientVersion
    });
  } catch (error) {
    if (!isCodexAuthFailure(normalizeCaughtError(error))) {
      throw error;
    }

    const auth = await refreshStoredCodexAuth(context);
    if (!auth) {
      throw error;
    }
    closeCodexResponseWebSocketSessions();

    return listCodexModels({
      apiBaseUrl: runtime.configuration.apiBaseUrl,
      accessToken: auth.accessToken,
      chatgptAccountId: auth.chatgptAccountId,
      clientVersion: runtime.clientVersion
    });
  }
}

/**
 * @param {CocopiSecretContext} context
 * @param {CocopiRuntime} runtime
 * @returns {Promise<CodexRateLimitSnapshot[]>}
 */
export async function fetchCodexRateLimitsWithAuthRefresh(context, runtime) {
  if (!runtime.auth) {
    throw new Error("Cocopi is not signed in.");
  }

  try {
    return await fetchCodexRateLimits({
      apiBaseUrl: runtime.configuration.apiBaseUrl,
      accessToken: runtime.auth.accessToken,
      chatgptAccountId: runtime.auth.chatgptAccountId
    });
  } catch (error) {
    if (!isCodexAuthFailure(normalizeCaughtError(error))) {
      throw error;
    }

    const auth = await refreshStoredCodexAuth(context);
    if (!auth) {
      throw error;
    }
    closeCodexResponseWebSocketSessions();

    return fetchCodexRateLimits({
      apiBaseUrl: runtime.configuration.apiBaseUrl,
      accessToken: auth.accessToken,
      chatgptAccountId: auth.chatgptAccountId
    });
  }
}

/**
 * @param {CocopiSecretContext} context
 * @param {CocopiRuntime} runtime
 * @returns {Promise<CodexUsageAnalyticsSnapshot>}
 */
export async function fetchCodexUsageAnalyticsWithAuthRefresh(context, runtime) {
  if (!runtime.auth) {
    throw new Error("Cocopi is not signed in.");
  }

  try {
    return await fetchCodexUsageAnalytics({
      apiBaseUrl: runtime.configuration.apiBaseUrl,
      accessToken: runtime.auth.accessToken,
      chatgptAccountId: runtime.auth.chatgptAccountId
    });
  } catch (error) {
    if (!isCodexAuthFailure(normalizeCaughtError(error))) {
      throw error;
    }

    const auth = await refreshStoredCodexAuth(context);
    if (!auth) {
      throw error;
    }
    closeCodexResponseWebSocketSessions();

    return fetchCodexUsageAnalytics({
      apiBaseUrl: runtime.configuration.apiBaseUrl,
      accessToken: auth.accessToken,
      chatgptAccountId: auth.chatgptAccountId
    });
  }
}

/**
 * @param {CocopiSecretContext} context
 * @param {CocopiRuntime} runtime
 * @param {{ body: CodexResponseCreateRequest, signal?: AbortSignal, idleTimeoutMs?: number, continuationAnchors?: import("../codex-api/websocket.js").CodexContinuationAnchor[], onWebSocketResponseCancel?: () => void, onWebSocketContinuationDecision?: (decision: import("../../data/Codex.js").CodexPreviousResponseDecision) => void, onWebSocketRequestPrepared?: (body: CodexResponseCreateRequest) => void, onWebSocketReconnect?: (error: Error) => void, onWebSocketFallbackToSse?: (error: Error) => void }} options
 * @returns {Promise<ReadableStream<CodexResponseStreamEvent>>}
 */
export async function fetchCodexResponseStreamWithAuthRefresh(context, runtime, options) {
  if (!runtime.auth) {
    throw new Error("Cocopi is not signed in.");
  }

  try {
    return await fetchCodexResponseStreamForRuntime(runtime, runtime.auth.accessToken, runtime.auth.chatgptAccountId, options);
  } catch (error) {
    if (!isCodexAuthFailure(normalizeCaughtError(error))) {
      throw error;
    }

    const auth = await refreshStoredCodexAuth(context);
    if (!auth) {
      throw error;
    }
    closeCodexResponseWebSocketSessions();

    return fetchCodexResponseStreamForRuntime(runtime, auth.accessToken, auth.chatgptAccountId, options);
  }
}

/**
 * @param {CocopiRuntime} runtime
 * @param {string} accessToken
 * @param {string | undefined} chatgptAccountId
 * @param {{ body: CodexResponseCreateRequest, signal?: AbortSignal, idleTimeoutMs?: number, continuationAnchors?: import("../codex-api/websocket.js").CodexContinuationAnchor[], onWebSocketResponseCancel?: () => void, onWebSocketContinuationDecision?: (decision: import("../../data/Codex.js").CodexPreviousResponseDecision) => void, onWebSocketRequestPrepared?: (body: CodexResponseCreateRequest) => void, onWebSocketReconnect?: (error: Error) => void, onWebSocketFallbackToSse?: (error: Error) => void }} options
 * @returns {Promise<ReadableStream<CodexResponseStreamEvent>>}
 */
function fetchCodexResponseStreamForRuntime(runtime, accessToken, chatgptAccountId, options) {
  const transportOptions = {
    apiBaseUrl: runtime.configuration.apiBaseUrl,
    accessToken,
    chatgptAccountId,
    body: options.body,
    signal: options.signal,
    idleTimeoutMs: options.idleTimeoutMs,
    continuationAnchors: options.continuationAnchors,
    onWebSocketResponseCancel: options.onWebSocketResponseCancel,
    onWebSocketContinuationDecision: options.onWebSocketContinuationDecision,
    onWebSocketRequestPrepared: options.onWebSocketRequestPrepared,
    onWebSocketReconnect: options.onWebSocketReconnect,
    onWebSocketFallbackToSse: options.onWebSocketFallbackToSse
  };

  if (runtime.configuration.transport !== "websocket" || options.body.stream === false) {
    return fetchCodexResponseStream(transportOptions);
  }

  return fetchCodexResponseWebSocketStreamForRuntime(transportOptions)
    .then((stream) => withEarlyWebSocketCloseFallback(stream, transportOptions));
}

/**
 * @param {{
 *   apiBaseUrl: string,
 *   accessToken: string,
 *   chatgptAccountId?: string,
 *   body: CodexResponseCreateRequest,
 *   signal?: AbortSignal,
 *   idleTimeoutMs?: number,
 *   continuationAnchors?: import("../codex-api/websocket.js").CodexContinuationAnchor[],
 *   onWebSocketResponseCancel?: () => void,
 *   onWebSocketContinuationDecision?: (decision: import("../../data/Codex.js").CodexPreviousResponseDecision) => void,
 *   onWebSocketRequestPrepared?: (body: CodexResponseCreateRequest) => void,
 *   onWebSocketReconnect?: (error: Error) => void,
 *   onWebSocketFallbackToSse?: (error: Error) => void
 * }} options
 * @returns {Promise<ReadableStream<CodexResponseStreamEvent>>}
 */
function fetchCodexResponseWebSocketStreamForRuntime(options) {
  const conversationId = options.body.prompt_cache_key;
  if (!conversationId) {
    return fetchCodexResponseWebSocketStream(options);
  }

  const key = codexResponsesWebSocketSessionKey({
    apiBaseUrl: options.apiBaseUrl,
    accessToken: options.accessToken,
    chatgptAccountId: options.chatgptAccountId,
    conversationId
  });
  let session = codexResponsesWebSocketSessions.get(key);
  if (!session) {
    session = new CodexResponsesWebSocketSession({
      apiBaseUrl: options.apiBaseUrl,
      accessToken: options.accessToken,
      chatgptAccountId: options.chatgptAccountId,
      conversationId
    });
    codexResponsesWebSocketSessions.set(key, session);
  }

  return session.request({
    body: options.body,
    signal: options.signal,
    idleTimeoutMs: options.idleTimeoutMs,
    continuationAnchors: options.continuationAnchors,
    onWebSocketResponseCancel: options.onWebSocketResponseCancel,
    onWebSocketContinuationDecision: options.onWebSocketContinuationDecision,
    onWebSocketRequestPrepared: options.onWebSocketRequestPrepared
  });
}

/**
 * @param {ReadableStream<CodexResponseStreamEvent>} stream
 * @param {{
 *   apiBaseUrl: string,
 *   accessToken: string,
 *   chatgptAccountId?: string,
 *   body: CodexResponseCreateRequest,
 *   signal?: AbortSignal,
 *   idleTimeoutMs?: number,
 *   continuationAnchors?: import("../codex-api/websocket.js").CodexContinuationAnchor[],
 *   onWebSocketResponseCancel?: () => void,
 *   onWebSocketContinuationDecision?: (decision: import("../../data/Codex.js").CodexPreviousResponseDecision) => void,
 *   onWebSocketRequestPrepared?: (body: CodexResponseCreateRequest) => void,
 *   onWebSocketReconnect?: (error: Error) => void,
 *   onWebSocketFallbackToSse?: (error: Error) => void
 * }} options
 */
function withEarlyWebSocketCloseFallback(stream, options) {
  /** @type {ReadableStreamDefaultReader<CodexResponseStreamEvent> | undefined} */
  let activeReader;
  let fallbackAllowed = true;
  let freshWebSocketRetries = 0;

  return new ReadableStream({
    async start(controller) {
      activeReader = stream.getReader();

      while (true) {
        try {
          await pumpEvents(activeReader, controller, (event) => {
            if (!WEBSOCKET_FALLBACK_SAFE_EVENT_TYPES.has(event.type)) {
              fallbackAllowed = false;
            }
          });
          controller.close();
          return;
        } catch (error) {
          const normalized = normalizeCaughtError(error);
          if (!options.signal?.aborted && fallbackAllowed && freshWebSocketRetries < MAX_FRESH_WEBSOCKET_RETRIES && isRetryableFreshWebSocketFailureBeforeOutput(normalized)) {
            freshWebSocketRetries += 1;
            options.onWebSocketReconnect?.(normalized);
            try {
              const retryStream = await fetchCodexResponseWebSocketStreamForRuntime(options);
              activeReader = retryStream.getReader();
              continue;
            } catch (retryError) {
              controller.error(retryError);
              return;
            }
          }

          if (!options.signal?.aborted && fallbackAllowed && isRetryableWebSocketFailureBeforeOutput(normalized, options.body)) {
            options.onWebSocketFallbackToSse?.(normalized);
            const fallbackStream = await fetchCodexResponseStream(options);
            activeReader = fallbackStream.getReader();
            try {
              await pumpEvents(activeReader, controller);
              controller.close();
              return;
            } catch (fallbackError) {
              controller.error(fallbackError);
              return;
            }
          }

          controller.error(error);
          return;
        }
      }
    },
    cancel(reason) {
      return activeReader?.cancel(reason);
    }
  });
}

/**
 * @param {ReadableStreamDefaultReader<CodexResponseStreamEvent>} reader
 * @param {ReadableStreamDefaultController<CodexResponseStreamEvent>} controller
 * @param {(event: CodexResponseStreamEvent) => void} [onEvent]
 */
async function pumpEvents(reader, controller, onEvent) {
  while (true) {
    const read = await reader.read();
    if (read.done) {
      return;
    }

    onEvent?.(read.value);
    controller.enqueue(read.value);
  }
}

/** @param {Error} error */
function isRetryableFreshWebSocketFailureBeforeOutput(error) {
  return error instanceof CodexResponseWebSocketError
    && error.retryableWithFreshWebSocket;
}

/**
 * @param {Error} error
 * @param {CodexResponseCreateRequest} body
 */
function isRetryableWebSocketFailureBeforeOutput(error, body) {
  return error instanceof CodexResponseWebSocketError
    && (error.retryableWithSseBeforeOutput
      || (!body.previous_response_id && isCodexPreviousResponseNotFoundError(error)));
}

export function closeCodexResponseWebSocketSessions() {
  for (const session of codexResponsesWebSocketSessions.values()) {
    session.dispose();
  }
  codexResponsesWebSocketSessions.clear();
}

/**
 * @param {{ apiBaseUrl: string, accessToken: string, chatgptAccountId?: string, conversationId: string }} options
 */
function codexResponsesWebSocketSessionKey(options) {
  return [
    options.apiBaseUrl,
    sessionKeyHash(options.accessToken),
    options.chatgptAccountId ?? "",
    options.conversationId
  ].join("\n");
}

/** @param {string} value */
function sessionKeyHash(value) {
  return createHash("sha256").update(value).digest("base64url");
}

// eslint-disable-next-line jsdoc/reject-any-type -- Catch values are untyped external data; normalize before matching auth failures.
/** @param {*} error */
function normalizeCaughtError(error) {
  if (error instanceof Error || typeof error === "string" || error === null || error === undefined) {
    return error;
  }

  if (typeof error === "object") {
    return error;
  }

  return String(error);
}
