import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { CODEX_ORIGINATOR } from "../auth/oauth.js";
import { CODEX_TURN_METADATA_HEADER, codexAuthHeaders, codexTurnMetadataHeaderFromResponseBody } from "./codex-headers.js";
import { canonicalCodexJsonString } from "./json.js";
import { CodexResponseStreamError } from "./responses.js";

/** @typedef {import("../../data/Codex.js").CodexJsonValue} CodexJsonValue */
/** @typedef {import("../../data/Codex.js").CodexTool} CodexTool */
/** @typedef {import("../../data/Codex.js").CodexResponse} CodexResponse */
/** @typedef {import("../../data/Codex.js").CodexResponseCreateRequest} CodexResponseCreateRequest */
/** @typedef {import("../../data/Codex.js").CodexPreviousResponseDecision} CodexPreviousResponseDecision */
/** @typedef {import("../../data/Codex.js").CodexResponseStreamEvent} CodexResponseStreamEvent */
/** @typedef {{ request: CodexResponseCreateRequest, responseId: string, itemsAdded: CodexJsonValue[] }} CodexFullContinuationAnchor */
/** @typedef {{ responseId: string, baselineItems: number, baselineDigest: string, requestState?: Record<string, CodexJsonValue> }} CodexCompactContinuationAnchor */
/** @typedef {CodexFullContinuationAnchor | CodexCompactContinuationAnchor} CodexContinuationAnchor */
/** @typedef {{ readonly items: number, update(item: CodexJsonValue): void, snapshot(): { items: number, digest: string } }} CodexContinuationInputDigestBuilder */

/**
 * @typedef {object} CodexWebSocketRequestOptions
 * @property {CodexResponseCreateRequest} body
 * @property {AbortSignal} [signal]
 * @property {number} [idleTimeoutMs]
 * @property {() => void} [onWebSocketResponseCancel]
 * @property {(decision: CodexPreviousResponseDecision) => void} [onWebSocketContinuationDecision]
 * @property {(body: CodexResponseCreateRequest) => void} [onWebSocketRequestPrepared]
 * @property {CodexContinuationAnchor[]} [continuationAnchors]
 */

/**
 * @typedef {CodexWebSocketRequestOptions & {
 *   apiBaseUrl: string,
 *   accessToken: string,
 *   chatgptAccountId?: string,
 *   WebSocketConstructor?: typeof WebSocket
 * }} CodexWebSocketStreamOptions
 */

export const CODEX_RESPONSES_WEBSOCKET_BETA_HEADER = "responses_websockets=2026-02-06";

const TEXT_DECODER = new TextDecoder();
const TERMINAL_EVENT_TYPES = new Set(["response.completed", "response.failed", "response.incomplete"]);
const noop = () => {};
const DEFAULT_WEBSOCKET_INSTRUCTIONS = "You are a helpful coding assistant.";
// RFC 6455 section 7.4.1 close status codes observed through WebSocket CloseEvent.code.
const WEBSOCKET_CLOSE_NORMAL_CLOSURE = 1000;
const MAX_REQUEST_STATE_CHANGE_SUMMARIES = 12;
const MAX_CONTINUATION_ANCHORS = 32;
const CONTINUATION_VOLATILE_CLIENT_METADATA_KEYS = new Set([
  CODEX_TURN_METADATA_HEADER,
  "ws_request_header_traceparent",
  "ws_request_header_tracestate",
  "x-cocopi-request-index",
  "x-cocopi-host-request-index",
  "x-cocopi-turn-id"
]);
export class CodexResponseWebSocketError extends CodexResponseStreamError {
  /**
   * @param {string} message
   * @param {{ event?: CodexResponseStreamEvent | Record<string, CodexJsonValue>, eventData?: string, cause?: Error, code?: string, closeCode?: number, retryableWithSseBeforeOutput?: boolean, retryableWithFreshWebSocket?: boolean }} [options]
   */
  constructor(message, options = {}) {
    super(message, { event: /** @type {CodexResponseStreamEvent | undefined} */ (options.event), cause: options.cause });
    this.name = "CodexResponseWebSocketError";
    this.eventData = options.eventData;
    this.code = options.code;
    this.closeCode = options.closeCode;
    this.retryableWithSseBeforeOutput = options.retryableWithSseBeforeOutput === true;
    this.retryableWithFreshWebSocket = options.retryableWithFreshWebSocket === true;
  }
}

/**
 * @param {Error} error
 * @returns {boolean}
 */
export function isCodexPreviousResponseNotFoundError(error) {
  if (codexWebSocketErrorCode(error) === "previous_response_not_found") {
    return true;
  }

  return !(error instanceof CodexResponseWebSocketError)
    && /\bprevious_response_not_found\b|Previous response with id ['"][^'"]+['"] not found/iu.test(error.message);
}

/**
 * @param {Error} error
 * @returns {string | undefined}
 */
export function codexPreviousResponseIdFromNotFoundError(error) {
  const event = recordFromJsonValue(Reflect.get(error, "event"));
  const eventError = recordFromJsonValue(event?.error);
  const message = stringFromJsonValue(eventError?.message)
    ?? stringFromJsonValue(event?.message)
    ?? error.message;
  return /Previous response with id ['"]([^'"]+)['"] not found/iu.exec(message)?.[1];
}

export class CodexResponsesWebSocketSession {
  /**
   * @param {{
   *   apiBaseUrl: string,
   *   accessToken: string,
   *   chatgptAccountId?: string,
   *   conversationId?: string,
   *   WebSocketConstructor?: typeof WebSocket
   * }} options
   */
  constructor(options) {
    this.apiBaseUrl = options.apiBaseUrl;
    this.accessToken = options.accessToken;
    this.chatgptAccountId = options.chatgptAccountId;
    this.conversationId = options.conversationId;
    /** @type {typeof WebSocket} */
    this.WebSocketConstructor = options.WebSocketConstructor ?? globalThis.WebSocket;
    if (typeof this.WebSocketConstructor !== "function") {
      throw new CodexResponseWebSocketError("Codex Responses WebSocket transport is unavailable in this runtime.");
    }

    /** @type {WebSocket | undefined} */
    this.socket = undefined;
    /** @type {Promise<WebSocket> | undefined} */
    this.opening = undefined;
    /** @type {ReturnType<typeof createWebSocketRequestState> | undefined} */
    this.activeRequest = undefined;
    /** @type {Promise<void>} */
    this.requestQueue = Promise.resolve();
    /** @type {boolean} */
    this.hadPriorRequestWithoutResponseId = false;
    /** @type {CodexCompactContinuationAnchor[]} */
    this.continuationAnchors = [];
    this.disposed = false;

    this.handleMessage = this.handleMessage.bind(this);
    this.handleSocketError = this.handleSocketError.bind(this);
    this.handleSocketClose = this.handleSocketClose.bind(this);
  }

  /**
   * Opens the socket without sending a prompt payload.
   *
   * @param {{ body?: CodexResponseCreateRequest, signal?: AbortSignal }} [options]
   */
  async preconnect(options = {}) {
    await this.open(options.body, options.signal);
  }

  /**
   * Sends one Responses request over this session. Requests are serialized because a single
   * Responses WebSocket stream carries one active response at a time.
   *
   * @param {CodexWebSocketRequestOptions} options
   * @returns {Promise<ReadableStream<CodexResponseStreamEvent>>}
   */
  async request(options) {
    if (this.disposed) {
      throw new CodexResponseWebSocketError("Codex Responses WebSocket session is closed.");
    }

    const state = createWebSocketRequestState(this, options);
    const stream = new ReadableStream({
      start(controller) {
        state.controller = controller;
      },
      cancel() {
        state.cancel();
      }
    });

    const run = this.requestQueue.then(() => this.runRequest(options, state));
    this.requestQueue = run.catch(() => {});
    void run.catch((error) => {
      state.fail(error instanceof Error ? error : new CodexResponseWebSocketError(String(error)));
    });

    await state.started;
    return stream;
  }

  dispose() {
    this.disposed = true;
    this.activeRequest?.fail(new CodexResponseWebSocketError("Codex Responses WebSocket session was closed."));
    this.activeRequest = undefined;
    this.closeConnection();
  }

  /**
   * @param {CodexWebSocketRequestOptions} options
   * @param {ReturnType<typeof createWebSocketRequestState>} state
   */
  async runRequest(options, state) {
    if (state.cancelled) {
      state.markStarted();
      return;
    }

    const socket = await this.open(options.body, options.signal);
    if (state.cancelled) {
      state.markStarted();
      return;
    }

    this.refreshContinuationAnchors(options.continuationAnchors ?? []);
    const body = this.prepareRequestBody(options.body, options.onWebSocketContinuationDecision);
    options.onWebSocketRequestPrepared?.(body);
    try {
      if (!state.attachAbortListener()) {
        await state.finished;
        return;
      }
      state.resetIdleTimer();
      this.activeRequest = state;
      socket.send(canonicalCodexJsonString(responseCreateWebSocketMessage(body)));
      state.markStarted();
    } catch (error) {
      state.fail(new CodexResponseWebSocketError("Codex Responses WebSocket request could not be sent.", {
        cause: error instanceof Error ? error : undefined
      }));
      this.closeConnection();
      return;
    }

    await state.finished;
  }

  /**
   * @param {CodexResponseCreateRequest | undefined} body
   * @param {AbortSignal | undefined} signal
   */
  async open(body, signal) {
    if (this.disposed) {
      throw new CodexResponseWebSocketError("Codex Responses WebSocket session is closed.");
    }

    const existingSocket = this.socket;
    if (existingSocket && existingSocket.readyState === existingSocket.OPEN) {
      return existingSocket;
    }

    if (this.opening) {
      return this.opening;
    }

    const conversationId = this.conversationId ?? body?.prompt_cache_key ?? crypto.randomUUID();
    this.conversationId = conversationId;
    const headers = codexAuthHeaders({
      accessToken: this.accessToken,
      chatgptAccountId: this.chatgptAccountId,
      originator: CODEX_ORIGINATOR
    });
    headers["OpenAI-Beta"] = CODEX_RESPONSES_WEBSOCKET_BETA_HEADER;
    headers["session-id"] = conversationId;
    headers["thread-id"] = conversationId;
    headers["x-client-request-id"] = conversationId;
    const turnMetadataHeader = body ? codexTurnMetadataHeaderFromResponseBody(body) : undefined;
    if (turnMetadataHeader) {
      headers[CODEX_TURN_METADATA_HEADER] = turnMetadataHeader;
    }

    /** @type {WebSocket} */
    let socket;
    try {
      socket = new this.WebSocketConstructor(codexResponsesWebSocketUrl(this.apiBaseUrl), { headers });
    } catch (error) {
      throw new CodexResponseWebSocketError("Codex Responses WebSocket connection could not be created.", {
        cause: error instanceof Error ? error : undefined
      });
    }

    this.socket = socket;
    socket.addEventListener("message", this.handleMessage);
    socket.addEventListener("error", this.handleSocketError);
    socket.addEventListener("close", this.handleSocketClose);

    this.opening = new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        socket.removeEventListener("open", handleOpen);
        socket.removeEventListener("error", handleError);
        socket.removeEventListener("close", handleClose);
        signal?.removeEventListener("abort", handleAbort);
      };
      /** @param {Error} error */
      const fail = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        this.opening = undefined;
        this.socket = undefined;
        reject(error);
      };
      const handleOpen = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        this.opening = undefined;
        resolve(socket);
      };
      const handleError = () => {
        fail(new CodexResponseWebSocketError("Codex Responses WebSocket reported a transport error while opening."));
      };
      /** @param {Event} event */
      const handleClose = (event) => {
        fail(new CodexResponseWebSocketError(`Codex Responses WebSocket closed before opening.${closeEventReason(event)}`, {
          closeCode: closeEventCode(event)
        }));
      };
      const handleAbort = () => {
        const reason = signal?.reason;
        fail(reason instanceof Error ? reason : new CodexResponseWebSocketError("Codex Responses WebSocket stream was aborted while opening."));
        closeSocket(socket);
      };

      socket.addEventListener("open", handleOpen);
      socket.addEventListener("error", handleError);
      socket.addEventListener("close", handleClose);
      if (signal?.aborted) {
        handleAbort();
      } else {
        signal?.addEventListener("abort", handleAbort, { once: true });
      }
    });

    return this.opening;
  }

  /**
   * @param {CodexResponseCreateRequest} body
   * @param {(decision: CodexPreviousResponseDecision) => void} [onDecision]
   * @returns {CodexResponseCreateRequest}
   */
  prepareRequestBody(body, onDecision) {
    if (this.continuationAnchors.length === 0) {
      if (this.hadPriorRequestWithoutResponseId) {
        onDecision?.(previousResponseDecision("skipped", "no-prior-response-id", body));
        return body;
      }
      onDecision?.(previousResponseDecision("skipped", "no-prior-request", body));
      return body;
    }

    if (body.previous_response_id) {
      onDecision?.(previousResponseDecision("skipped", "explicit-previous-response-id", body));
      return body;
    }

    const incremental = incrementalInputItemsFromAnchors(body, this.continuationAnchors);
    onDecision?.(incremental.decision);
    return incremental.input
      ? { ...body, previous_response_id: incremental.responseId, input: incremental.input }
      : body;
  }

  /** @param {MessageEvent} event */
  handleMessage(event) {
    void this.handleMessageAsync(event).catch((error) => {
      const normalized = error instanceof Error ? error : new CodexResponseWebSocketError(String(error));
      this.activeRequest?.fail(normalized);
      this.closeConnection();
    });
  }

  /** @param {MessageEvent} event */
  async handleMessageAsync(event) {
    const activeRequest = this.activeRequest;
    if (!activeRequest) {
      return;
    }

    activeRequest.resetIdleTimer();
    const responseEvent = decodeWebSocketMessageEvent(await readWebSocketMessageData(event));
    const wrappedError = websocketErrorFromEvent(responseEvent);
    if (wrappedError) {
      if (isCodexPreviousResponseNotFoundError(wrappedError)) {
        this.clearContinuationAnchors();
      }
      activeRequest.fail(wrappedError);
      this.activeRequest = undefined;
      this.closeConnection();
      return;
    }

    const codexEvent = /** @type {CodexResponseStreamEvent} */ (responseEvent);
    if (codexEvent.type === "response.output_item.done") {
      activeRequest.outputItems.push(cloneJsonValue(codexEvent.item));
    }

    activeRequest.controller?.enqueue(codexEvent);
    if (!TERMINAL_EVENT_TYPES.has(codexEvent.type)) {
      return;
    }

    if (codexEvent.type === "response.completed") {
      const responseId = codexEvent.response.id ?? "";
      this.hadPriorRequestWithoutResponseId = !responseId;
      if (responseId && Array.isArray(activeRequest.originalBody.input)) {
        this.recordContinuationAnchor(codexContinuationAnchorFromInputItems(
          responseId,
          activeRequest.originalBody.input,
          responseOutputItems(codexEvent.response, activeRequest.outputItems),
          codexContinuationRequestState(activeRequest.originalBody)
        ));
      }
    }

    activeRequest.controller?.close();
    activeRequest.finish();
    this.activeRequest = undefined;
  }

  handleSocketError() {
    this.activeRequest?.fail(new CodexResponseWebSocketError("Codex Responses WebSocket reported a transport error."));
    this.activeRequest = undefined;
    this.closeConnection();
  }

  /** @param {Event} event */
  handleSocketClose(event) {
    const activeRequest = this.activeRequest;
    this.activeRequest = undefined;
    this.socket = undefined;
    this.opening = undefined;
    this.clearContinuationAnchors();
    if (activeRequest && !activeRequest.settled) {
      const closeCode = closeEventCode(event);
      activeRequest.fail(new CodexResponseWebSocketError(`Codex Responses WebSocket closed before a terminal response event.${closeEventReason(event)}`, {
        closeCode,
        retryableWithSseBeforeOutput: isRetryableWebSocketCloseBeforeOutput(closeCode)
      }));
    }
  }

  closeConnection() {
    const socket = this.socket;
    this.socket = undefined;
    this.opening = undefined;
    this.clearContinuationAnchors();
    if (socket) {
      socket.removeEventListener("message", this.handleMessage);
      socket.removeEventListener("error", this.handleSocketError);
      socket.removeEventListener("close", this.handleSocketClose);
      closeSocket(socket);
    }
  }

  /** @param {() => void} [onCancelSent] */
  cancelActiveResponse(onCancelSent) {
    const socket = this.socket;
    if (socket && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(responseCancelWebSocketMessage()));
      onCancelSent?.();
    }
  }

  /** @param {CodexContinuationAnchor} anchor */
  recordContinuationAnchor(anchor) {
    this.recordContinuationAnchors([anchor]);
  }

  /** @param {CodexContinuationAnchor[]} anchors */
  recordContinuationAnchors(anchors) {
    for (const anchor of anchors) {
      const nextAnchor = compactContinuationAnchor(anchor);
      if (!nextAnchor) {
        continue;
      }

      const existingIndex = this.continuationAnchors.findIndex((candidate) => candidate.responseId === nextAnchor.responseId);
      if (existingIndex !== -1) {
        this.continuationAnchors.splice(existingIndex, 1);
      }

      this.continuationAnchors.push(nextAnchor);
    }

    if (this.continuationAnchors.length > MAX_CONTINUATION_ANCHORS) {
      this.continuationAnchors.splice(0, this.continuationAnchors.length - MAX_CONTINUATION_ANCHORS);
    }
  }

  /** @param {CodexContinuationAnchor[]} anchors */
  refreshContinuationAnchors(anchors) {
    for (const anchor of anchors) {
      if (!anchor.responseId) {
        continue;
      }

      const existingIndex = this.continuationAnchors.findIndex((candidate) => candidate.responseId === anchor.responseId);
      if (existingIndex === -1) {
        continue;
      }

      const nextAnchor = compactContinuationAnchor(anchor);
      if (!nextAnchor) {
        continue;
      }

      this.continuationAnchors[existingIndex] = nextAnchor;
    }
  }

  /** @param {string | undefined} responseId */
  removeContinuationAnchor(responseId) {
    if (!responseId) {
      this.clearContinuationAnchors();
      return;
    }

    this.continuationAnchors = this.continuationAnchors.filter((anchor) => anchor.responseId !== responseId);
  }

  clearContinuationAnchors() {
    this.continuationAnchors = [];
    this.hadPriorRequestWithoutResponseId = false;
  }
}

/**
 * @param {CodexResponseCreateRequest} body
 * @returns {Record<string, CodexJsonValue>}
 */
export function codexContinuationRequestState(body) {
  return /** @type {Record<string, CodexJsonValue>} */ (JSON.parse(canonicalJson(materialRequestStateForContinuation(withoutInputFields(body)))));
}

/**
 * @param {string} responseId
 * @param {CodexJsonValue[]} inputItems
 * @param {CodexJsonValue[]} [responseItems]
 * @param {Record<string, CodexJsonValue>} [requestState]
 * @returns {CodexCompactContinuationAnchor}
 */
export function codexContinuationAnchorFromInputItems(responseId, inputItems, responseItems = [], requestState) {
  const baseline = continuationInputDigest([inputItems, responseItems]);
  return {
    responseId,
    baselineItems: baseline.items,
    baselineDigest: baseline.digest,
    ...(requestState ? { requestState } : {})
  };
}

/**
 * Build a compact continuation digest incrementally so callers do not need to
 * retain replay item arrays just to persist a future `previous_response_id`
 * anchor.
 *
 * @param {readonly CodexJsonValue[][]} [groups]
 * @returns {CodexContinuationInputDigestBuilder}
 */
export function createCodexContinuationInputDigestBuilder(groups = []) {
  const hash = createHash("sha256");
  let items = 0;
  const builder = {
    get items() {
      return items;
    },
    /** @param {CodexJsonValue} item */
    update(item) {
      updateContinuationInputDigest(hash, item);
      items += 1;
    },
    snapshot() {
      return { items, digest: `sha256:${hash.copy().digest("hex")}` };
    }
  };
  for (const group of groups) {
    for (const item of group) {
      builder.update(item);
    }
  }

  return builder;
}

/**
 * Convenience one-shot helper. Reusable callers should keep a
 * `CodexResponsesWebSocketSession` and call `request` repeatedly.
 *
 * @param {CodexWebSocketStreamOptions} options
 * @returns {Promise<ReadableStream<CodexResponseStreamEvent>>}
 */
export async function fetchCodexResponseWebSocketStream(options) {
  const session = new CodexResponsesWebSocketSession({
    apiBaseUrl: options.apiBaseUrl,
    accessToken: options.accessToken,
    chatgptAccountId: options.chatgptAccountId,
    conversationId: options.body.prompt_cache_key,
    WebSocketConstructor: options.WebSocketConstructor
  });
  const stream = await session.request({
    body: options.body,
    signal: options.signal,
    idleTimeoutMs: options.idleTimeoutMs,
    onWebSocketResponseCancel: options.onWebSocketResponseCancel,
    onWebSocketContinuationDecision: options.onWebSocketContinuationDecision,
    onWebSocketRequestPrepared: options.onWebSocketRequestPrepared
  });

  return stream.pipeThrough(new TransformStream({
    transform(event, controller) {
      controller.enqueue(event);
    },
    flush() {
      session.dispose();
    }
  }));
}

/**
 * @param {string} apiBaseUrl
 */
export function codexResponsesWebSocketUrl(apiBaseUrl) {
  const url = new URL(`${apiBaseUrl.replace(/\/+$/u, "")}/responses`);
  switch (url.protocol) {
    case "https:": {
      url.protocol = "wss:";
      break;
    }
    case "http:": {
      url.protocol = "ws:";
      break;
    }
    default: {
      throw new CodexResponseWebSocketError(`Unsupported Codex WebSocket API URL protocol: ${url.protocol}`);
    }
  }

  return url.toString();
}

/**
 * @param {CodexResponseCreateRequest} body
 */
export function responseCreateWebSocketMessage(body) {
  const instructions = typeof body.instructions === "string" && body.instructions.trim()
    ? body.instructions
    : DEFAULT_WEBSOCKET_INSTRUCTIONS;
  // Strip the HTTP/SSE-only stream flag from the WebSocket response.create payload.
  const { stream: _stream, ...webSocketBody } = body;
  void _stream;

  return {
    type: "response.create",
    ...webSocketBody,
    instructions,
    generate: true
  };
}

export function responseCancelWebSocketMessage() {
  return {
    type: "response.cancel"
  };
}

/**
 * @param {CodexResponsesWebSocketSession} session
 * @param {CodexWebSocketRequestOptions} options
 */
function createWebSocketRequestState(session, options) {
  /** @type {() => void} */
  let resolveStarted = noop;
  /** @type {(error: Error) => void} */
  let rejectStarted = noop;
  /** @type {() => void} */
  let resolveFinished = noop;
  /** @type {(error: Error) => void} */
  let rejectFinished = noop;
  let startedSettled = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let idleTimer;

  const state = {
    originalBody: options.body,
    /** @type {ReadableStreamDefaultController<CodexResponseStreamEvent> | undefined} */
    controller: undefined,
    /** @type {CodexJsonValue[]} */
    outputItems: [],
    cancelled: false,
    settled: false,
    /** @type {Promise<void>} */
    started: new Promise((resolve, reject) => {
      resolveStarted = () => resolve();
      rejectStarted = reject;
    }),
    /** @type {Promise<void>} */
    finished: new Promise((resolve, reject) => {
      resolveFinished = () => resolve();
      rejectFinished = reject;
    }),
    markStarted() {
      if (!startedSettled) {
        startedSettled = true;
        resolveStarted();
      }
    },
    attachAbortListener() {
      if (options.signal?.aborted) {
        this.abort();
        return false;
      }
      options.signal?.addEventListener("abort", this.abort, { once: true });
      return true;
    },
    abort() {
      const reason = options.signal?.reason;
      this.cancelled = true;
      this.fail(reason instanceof Error ? reason : new CodexResponseWebSocketError("Codex Responses WebSocket stream was aborted."));
      if (session.activeRequest === this) {
        session.cancelActiveResponse(options.onWebSocketResponseCancel);
        session.closeConnection();
      }
    },
    resetIdleTimer() {
      this.clearIdleTimer();
      if (options.idleTimeoutMs && options.idleTimeoutMs > 0) {
        idleTimer = setTimeout(() => {
          this.fail(new CodexResponseWebSocketError(`Codex Responses WebSocket stream was idle for ${options.idleTimeoutMs}ms.`));
          session.closeConnection();
        }, options.idleTimeoutMs);
      }
    },
    clearIdleTimer() {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    },
    finish() {
      if (this.settled) {
        return;
      }
      this.settled = true;
      this.clearIdleTimer();
      options.signal?.removeEventListener("abort", this.abort);
      this.markStarted();
      resolveFinished();
    },
    /** @param {Error} error */
    fail(error) {
      if (this.settled) {
        return;
      }
      this.settled = true;
      this.clearIdleTimer();
      options.signal?.removeEventListener("abort", this.abort);
      if (!startedSettled) {
        startedSettled = true;
        rejectStarted(error);
      }
      this.controller?.error(error);
      rejectFinished(error);
    },
    cancel() {
      this.cancelled = true;
      if (session.activeRequest === this) {
        session.activeRequest = undefined;
        session.cancelActiveResponse(options.onWebSocketResponseCancel);
        session.closeConnection();
      }
      this.finish();
    }
  };

  state.abort = state.abort.bind(state);
  void state.finished.catch(noop);
  return state;
}

/**
 * @param {WebSocket} socket
 */
function closeSocket(socket) {
  if (socket.readyState !== socket.CLOSING && socket.readyState !== socket.CLOSED) {
    socket.close();
  }
}

/**
 * @param {Event} event
 */
async function readWebSocketMessageData(event) {
  const data = Reflect.get(event, "data");
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return TEXT_DECODER.decode(data);
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }

  if (data && typeof data === "object" && typeof Reflect.get(data, "arrayBuffer") === "function") {
    return TEXT_DECODER.decode(await Reflect.apply(Reflect.get(data, "arrayBuffer"), data, []));
  }

  throw new CodexResponseWebSocketError("Codex Responses WebSocket returned an unsupported message data type.");
}

/**
 * @param {string} data
 * @returns {CodexResponseStreamEvent | Record<string, CodexJsonValue>}
 */
function decodeWebSocketMessageEvent(data) {
  /** @type {CodexJsonValue | undefined} */
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    throw new CodexResponseWebSocketError("Codex Responses WebSocket returned malformed JSON.", {
      cause: error instanceof Error ? error : undefined,
      eventData: data
    });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CodexResponseWebSocketError("Codex Responses WebSocket event must be an object.");
  }

  if (typeof Reflect.get(parsed, "type") !== "string") {
    throw new CodexResponseWebSocketError("Codex Responses WebSocket event is missing a string type.");
  }

  return /** @type {CodexResponseStreamEvent | Record<string, CodexJsonValue>} */ (parsed);
}

/**
 * @param {CodexResponseStreamEvent | Record<string, CodexJsonValue>} event
 * @returns {CodexResponseWebSocketError | undefined}
 */
function websocketErrorFromEvent(event) {
  if (event.type !== "error") {
    return;
  }

  const error = recordFromJsonValue(event.error);
  const message = stringFromJsonValue(error?.message) ?? stringFromJsonValue(event.message) ?? "WebSocket error";
  const status = numberFromJsonValue(event.status) ?? numberFromJsonValue(event.status_code);
  const code = stringFromJsonValue(error?.code) ?? stringFromJsonValue(event.code);
  const parts = ["Codex Responses WebSocket request failed"];
  if (status) {
    parts.push(`with status ${status}`);
  }
  if (code) {
    parts.push(`code=${code}`);
  }
  parts.push(`message=${message}`);
  return new CodexResponseWebSocketError(parts.join("; "), {
    code,
    event,
    retryableWithFreshWebSocket: isWebSocketConnectionLimitError(code, message)
  });
}

/**
 * @param {Error} error
 * @returns {string | undefined}
 */
function codexWebSocketErrorCode(error) {
  if (error instanceof CodexResponseWebSocketError && error.code) {
    return error.code;
  }

  const event = recordFromJsonValue(Reflect.get(error, "event"));
  const eventError = recordFromJsonValue(event?.error);
  return stringFromJsonValue(eventError?.code) ?? stringFromJsonValue(event?.code);
}

/** @param {Event} event */
function closeEventCode(event) {
  const code = Reflect.get(event, "code");
  return typeof code === "number" ? code : undefined;
}

/** @param {number | undefined} code */
function isRetryableWebSocketCloseBeforeOutput(code) {
  return code === WEBSOCKET_CLOSE_NORMAL_CLOSURE;
}

/**
 * @param {string | undefined} code
 * @param {string} message
 */
function isWebSocketConnectionLimitError(code, message) {
  return code === "websocket_connection_limit_reached"
    || /\bwebsocket connection limit reached\b[\s\S]*\bnew websocket connection\b/iu.test(message);
}

/**
 * @param {Event} event
 */
function closeEventReason(event) {
  const code = Reflect.get(event, "code");
  const reason = Reflect.get(event, "reason");
  const parts = [];
  if (typeof code === "number" && code > 0) {
    parts.push(`code=${code}`);
  }
  if (typeof reason === "string" && reason) {
    parts.push(`reason=${reason}`);
  }

  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

/**
 * @param {CodexResponseCreateRequest} body
 * @param {CodexCompactContinuationAnchor[]} anchors
 * @returns {{ input: import("../../data/Codex.js").CodexResponseInput | undefined, responseId: string | undefined, decision: CodexPreviousResponseDecision }}
 */
function incrementalInputItemsFromAnchors(body, anchors) {
  /** @type {CodexPreviousResponseDecision | undefined} */
  let newestSkippedDecision;
  for (let index = anchors.length - 1; index >= 0; index -= 1) {
    const anchor = anchors[index];
    const incremental = incrementalInputItems(body, anchor);
    if (incremental.decision.action === "used") {
      return {
        input: incremental.input,
        responseId: anchor.responseId,
        decision: incremental.decision
      };
    }

    newestSkippedDecision ??= incremental.decision;
  }

  return {
    input: undefined,
    responseId: undefined,
    decision: newestSkippedDecision ?? previousResponseDecision("skipped", "no-prior-response-id", body)
  };
}

/**
 * @param {CodexResponseCreateRequest} body
 * @param {CodexCompactContinuationAnchor} anchor
 * @returns {{ input: import("../../data/Codex.js").CodexResponseInput | undefined, decision: CodexPreviousResponseDecision }}
 */
function incrementalInputItems(body, anchor) {
  if (!Array.isArray(body.input)) {
    return { input: undefined, decision: previousResponseDecision("skipped", "non-array-input", body) };
  }

  if (body.input.length < anchor.baselineItems) {
    return { input: undefined, decision: previousResponseDecision("skipped", "input-shorter-than-baseline", body, { baselineItems: anchor.baselineItems }) };
  }

  const prefixDigest = continuationInputDigest([body.input], anchor.baselineItems).digest;
  if (prefixDigest !== anchor.baselineDigest) {
    return { input: undefined, decision: previousResponseDecision("skipped", "input-prefix-mismatch", body, {
      baselineItems: anchor.baselineItems,
      inputPrefixExpectedDigest: anchor.baselineDigest,
      inputPrefixActualDigest: prefixDigest
    }) };
  }

  const requestStateChanges = anchor.requestState
    ? requestStateChangeSummaries(anchor.requestState, codexContinuationRequestState(body))
    : undefined;
  const input = body.input.slice(anchor.baselineItems);
  return {
    input,
    decision: previousResponseDecision("used", "matched-prefix", body, {
      baselineItems: anchor.baselineItems,
      deltaItems: input.length,
      requestStateChanges
    })
  };
}

/**
 * @param {CodexPreviousResponseDecision["action"]} action
 * @param {CodexPreviousResponseDecision["reason"]} reason
 * @param {CodexResponseCreateRequest} body
 * @param {{
 *   baselineItems?: number,
 *   deltaItems?: number,
 *   requestStateChanges?: string[],
 *   inputPrefixMatchingItems?: number,
 *   inputPrefixMismatchIndex?: number,
 *   inputPrefixExpected?: string,
 *   inputPrefixActual?: string,
 *   inputPrefixExpectedDigest?: string,
 *   inputPrefixActualDigest?: string
 * }} [counts]
 * @returns {CodexPreviousResponseDecision}
 */
function previousResponseDecision(action, reason, body, counts = {}) {
  /** @type {CodexPreviousResponseDecision} */
  const decision = {
    action,
    reason,
    inputItems: Array.isArray(body.input) ? body.input.length : undefined,
    baselineItems: counts.baselineItems,
    deltaItems: counts.deltaItems
  };
  if (counts.requestStateChanges && counts.requestStateChanges.length > 0) {
    decision.requestStateChanges = counts.requestStateChanges;
  }
  if (counts.inputPrefixMatchingItems !== undefined) {
    decision.inputPrefixMatchingItems = counts.inputPrefixMatchingItems;
  }
  if (counts.inputPrefixMismatchIndex !== undefined) {
    decision.inputPrefixMismatchIndex = counts.inputPrefixMismatchIndex;
  }
  if (counts.inputPrefixExpected) {
    decision.inputPrefixExpected = counts.inputPrefixExpected;
  }
  if (counts.inputPrefixActual) {
    decision.inputPrefixActual = counts.inputPrefixActual;
  }
  if (counts.inputPrefixExpectedDigest) {
    decision.inputPrefixExpectedDigest = counts.inputPrefixExpectedDigest;
  }
  if (counts.inputPrefixActualDigest) {
    decision.inputPrefixActualDigest = counts.inputPrefixActualDigest;
  }
  return decision;
}

/**
 * @param {CodexResponseCreateRequest} body
 */
function withoutInputFields(body) {
  const clone = { ...body };
  delete clone.input;
  delete clone.previous_response_id;
  clone.client_metadata = stableClientMetadataForContinuation(body.client_metadata);
  return clone;
}

/**
 * Some request state is allowed to change with a Responses continuation. In
 * particular, VS Code can lazily replace tool activation placeholders with
 * concrete tools between automatic tool follow-up requests.
 *
 * @param {CodexResponseCreateRequest} body
 */
function materialRequestStateForContinuation(body) {
  const clone = { ...body };
  delete clone.tools;
  return clone;
}

/**
 * Keep stable request identity metadata in the material-state comparison while ignoring
 * per-turn observability carriers that Codex forwards separately on WebSocket creates.
 *
 * @param {Record<string, CodexJsonValue> | undefined} metadata
 * @returns {Record<string, CodexJsonValue> | undefined}
 */
function stableClientMetadataForContinuation(metadata) {
  if (!metadata) {
    return;
  }

  /** @type {Record<string, CodexJsonValue>} */
  const stableMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!CONTINUATION_VOLATILE_CLIENT_METADATA_KEYS.has(key)) {
      stableMetadata[key] = value;
    }
  }

  return Object.keys(stableMetadata).length > 0 ? stableMetadata : undefined;
}

/**
 * @param {Record<string, CodexJsonValue>} previous
 * @param {Record<string, CodexJsonValue>} current
 * @returns {string[]}
 */
function requestStateChangeSummaries(previous, current) {
  /** @type {string[]} */
  const changes = toolStateChangeSummaries(
    Array.isArray(previous.tools) ? /** @type {CodexTool[]} */ (previous.tools) : undefined,
    Array.isArray(current.tools) ? /** @type {CodexTool[]} */ (current.tools) : undefined
  );

  const keys = new Set([...Object.keys(previous), ...Object.keys(current)]);
  keys.delete("tools");
  for (const key of [...keys].toSorted()) {
    const previousValue = /** @type {Record<string, CodexJsonValue>} */ (previous)[key];
    const currentValue = /** @type {Record<string, CodexJsonValue>} */ (current)[key];
    if (canonicalJson(previousValue) !== canonicalJson(currentValue)) {
      changes.push(`${key}.changed`);
    }
    if (changes.length >= MAX_REQUEST_STATE_CHANGE_SUMMARIES) {
      return changes;
    }
  }

  return changes.slice(0, MAX_REQUEST_STATE_CHANGE_SUMMARIES);
}

/**
 * @param {CodexTool[] | undefined} previousTools
 * @param {CodexTool[] | undefined} currentTools
 * @returns {string[]}
 */
function toolStateChangeSummaries(previousTools, currentTools) {
  if (!Array.isArray(previousTools) || !Array.isArray(currentTools)) {
    return canonicalJson(previousTools) === canonicalJson(currentTools) ? [] : ["tools.changed"];
  }

  const previousByName = namedToolMap(previousTools);
  const currentByName = namedToolMap(currentTools);
  const names = [...new Set([...previousByName.keys(), ...currentByName.keys()])].toSorted();
  /** @type {string[]} */
  const added = [];
  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  const changed = [];
  for (const name of names) {
    const previousTool = previousByName.get(name);
    const currentTool = currentByName.get(name);
    if (!previousTool) {
      added.push(name);
    } else if (!currentTool) {
      removed.push(name);
    } else if (canonicalJson(previousTool) !== canonicalJson(currentTool)) {
      changed.push(name);
    }
  }

  /** @type {string[]} */
  const summaries = [];
  if (previousTools.length !== currentTools.length) {
    summaries.push(`tools.count:${previousTools.length}->${currentTools.length}`);
  }
  if (added.length > 0) {
    summaries.push(`tools.added:${added.join("|")}`);
  }
  if (removed.length > 0) {
    summaries.push(`tools.removed:${removed.join("|")}`);
  }
  if (changed.length > 0) {
    summaries.push(`tools.changed:${changed.join("|")}`);
  }
  return summaries;
}

/**
 * @param {CodexTool[]} tools
 * @returns {Map<string, CodexTool>}
 */
function namedToolMap(tools) {
  /** @type {Map<string, CodexTool>} */
  const byName = new Map();
  for (const tool of tools) {
    if (tool && typeof tool === "object" && !Array.isArray(tool) && typeof tool.name === "string") {
      byName.set(tool.name, tool);
    }
  }
  return byName;
}

/** @param {CodexContinuationAnchor} anchor */
function compactContinuationAnchor(anchor) {
  if (!anchor.responseId) {
    return;
  }

  if ("baselineItems" in anchor && "baselineDigest" in anchor) {
    return Number.isSafeInteger(anchor.baselineItems) && anchor.baselineItems >= 0 && typeof anchor.baselineDigest === "string"
      ? {
        responseId: anchor.responseId,
        baselineItems: anchor.baselineItems,
        baselineDigest: anchor.baselineDigest,
        ...(anchor.requestState ? { requestState: anchor.requestState } : {})
      }
      : undefined;
  }

  return Array.isArray(anchor.request.input) && Array.isArray(anchor.itemsAdded)
    ? codexContinuationAnchorFromInputItems(anchor.responseId, anchor.request.input, anchor.itemsAdded, codexContinuationRequestState(anchor.request))
    : undefined;
}

/**
 * @param {readonly CodexJsonValue[][]} groups
 * @param {number} [limit]
 */
function continuationInputDigest(groups, limit = Number.POSITIVE_INFINITY) {
  const builder = createCodexContinuationInputDigestBuilder();
  for (const group of groups) {
    for (const item of group) {
      if (builder.items >= limit) {
        return builder.snapshot();
      }

      builder.update(item);
    }
  }

  return builder.snapshot();
}

/**
 * @param {import("node:crypto").Hash} hash
 * @param {CodexJsonValue} item
 */
function updateContinuationInputDigest(hash, item) {
  const json = canonicalJson(continuationComparableInputItem(item));
  hash.update(`${json.length}:`);
  hash.update(json);
  hash.update(";");
}

/**
 * @param {CodexResponse} response
 * @param {CodexJsonValue[]} streamedOutputItems
 */
function responseOutputItems(response, streamedOutputItems) {
  return Array.isArray(response.output) && response.output.length > 0
    ? response.output
    : streamedOutputItems;
}

/**
 * @param {CodexJsonValue} value
 * @returns {CodexJsonValue}
 */
function cloneJsonValue(value) {
  return /** @type {CodexJsonValue} */ (structuredClone(value));
}

/**
 * Compare replay-equivalent response items instead of raw streamed output
 * payloads. VS Code replays prior output as Responses input items, while the
 * WebSocket baseline may contain backend output items with response-only fields.
 *
 * @param {CodexJsonValue} item
 * @returns {CodexJsonValue}
 */
function continuationComparableInputItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return item;
  }

  const record = /** @type {Record<string, CodexJsonValue>} */ (item);
  if (record.type === "function_call") {
    const callId = stringFromJsonValue(record.call_id) ?? stringFromJsonValue(record.id);
    const name = stringFromJsonValue(record.name);
    if (callId && name) {
      return {
        type: "function_call",
        call_id: callId,
        name,
        arguments: typeof record.arguments === "string" ? record.arguments : "{}"
      };
    }
  }

  if (record.type === "reasoning") {
    /** @type {Record<string, CodexJsonValue>} */
    const reasoning = { type: "reasoning" };
    if (typeof record.id === "string") {
      reasoning.id = record.id;
    }
    if (Array.isArray(record.summary)) {
      reasoning.summary = record.summary;
    }
    if (typeof record.encrypted_content === "string" || record.encrypted_content === null) {
      reasoning.encrypted_content = record.encrypted_content;
    }
    if (typeof record.phase === "string" || record.phase === null) {
      reasoning.phase = record.phase;
    }
    return reasoning;
  }

  if ((record.type === "message" || record.type === undefined) && record.role === "assistant" && Array.isArray(record.content)) {
    let text = "";
    for (const contentItem of record.content) {
      if (!contentItem || typeof contentItem !== "object" || Array.isArray(contentItem)) {
        continue;
      }
      const contentRecord = /** @type {Record<string, CodexJsonValue>} */ (contentItem);
      if (contentRecord.type === "output_text" && typeof contentRecord.text === "string") {
        text += contentRecord.text;
      }
    }
    if (text) {
      /** @type {Record<string, CodexJsonValue>} */
      const message = { role: "assistant", content: [{ type: "output_text", text }] };
      if (typeof record.phase === "string" || record.phase === null) {
        message.phase = record.phase;
      }
      return message;
    }
  }

  return item;
}

/**
 * @param {CodexJsonValue | undefined} value
 * @returns {Record<string, CodexJsonValue> | undefined}
 */
function recordFromJsonValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, CodexJsonValue>} */ (value)
    : undefined;
}

/** @param {CodexJsonValue | undefined} value */
function stringFromJsonValue(value) {
  return typeof value === "string" && value ? value : undefined;
}

/** @param {CodexJsonValue | undefined} value */
function numberFromJsonValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** @param {CodexJsonValue | undefined} value */
const canonicalJson = canonicalCodexJsonString;
