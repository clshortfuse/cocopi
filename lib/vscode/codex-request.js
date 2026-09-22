import { CodexWorkerTransport } from "../codex-api/worker-transport.js";
import { CodexTransport } from "../codex-api/transport.js";

import { listCodexModels } from "../codex-api/models.js";
import { fetchCodexRateLimits, fetchCodexUsageAnalytics } from "../codex-api/rate-limits.js";
import { isCodexAuthFailure, refreshStoredCodexAuth } from "./runtime.js";

/** @typedef {import("../../data/Codex.js").CodexModelSummary} CodexModelSummary */
/** @typedef {import("../codex-api/rate-limits.js").CodexRateLimitSnapshot} CodexRateLimitSnapshot */
/** @typedef {import("../codex-api/rate-limits.js").CodexUsageAnalyticsSnapshot} CodexUsageAnalyticsSnapshot */
/** @typedef {import("../../data/Codex.js").CodexResponseCreateRequest} CodexResponseCreateRequest */
/** @typedef {import("../../data/Codex.js").CodexResponseStreamEvent} CodexResponseStreamEvent */
/** @typedef {import("./runtime.js").CocopiRuntime} CocopiRuntime */
/** @typedef {import("./runtime.js").CocopiSecretContext} CocopiSecretContext */

const inHostTransport = new CodexTransport();
/** @type {CodexWorkerTransport | undefined} */
let workerTransport;

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
    clientVersion: runtime.clientVersion,
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

  if (runtime.configuration.workerTransport) {
    if (!workerTransport || workerTransport.closed) {
      workerTransport = new CodexWorkerTransport();
    }
    return workerTransport.request({ ...transportOptions, transport: runtime.configuration.transport });
  }

  return inHostTransport.request({ ...transportOptions, transport: runtime.configuration.transport });
}

export function closeCodexResponseWebSocketSessions() {
  workerTransport?.dispose();
  workerTransport = undefined;
  inHostTransport.dispose();
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
