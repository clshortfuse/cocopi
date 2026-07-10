import { CODEX_ORIGINATOR } from "../auth/oauth.js";
import { CODEX_TURN_METADATA_HEADER, codexAuthHeaders, codexTurnMetadataHeaderFromResponseBody, responseBodyWithoutCodexTurnMetadata } from "./codex-headers.js";
import { fetchWithRetries, readJsonResponse, throwHttpError } from "../utils/http.js";
import { canonicalCodexJsonString } from "./json.js";
import { decodeSseStream } from "./sse.js";

/** @typedef {import("../../data/Codex.js").CodexResponse} CodexResponse */
/** @typedef {import("../../data/Codex.js").CodexResponseCompletedEvent} CodexResponseCompletedEvent */
/** @typedef {import("../../data/Codex.js").CodexResponseCreateRequest} CodexResponseCreateRequest */
/** @typedef {import("../../data/Codex.js").CodexJsonValue} CodexJsonValue */
/** @typedef {import("../../data/Codex.js").CodexResponseStreamEvent} CodexResponseStreamEvent */

export class CodexResponseStreamError extends Error {
  /**
   * @param {string} message
   * @param {{ event?: CodexResponseStreamEvent, cause?: Error }} [options]
   */
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = "CodexResponseStreamError";
    this.event = options.event;
  }
}

/**
 * @param {{
 *   apiBaseUrl: string,
 *   accessToken: string,
 *   chatgptAccountId?: string,
 *   body: CodexResponseCreateRequest,
 *   fetch?: typeof fetch,
 *   signal?: AbortSignal,
 *   idleTimeoutMs?: number
 * }} options
 * @returns {Promise<ReadableStream<CodexResponseStreamEvent>>}
 */
export async function fetchCodexResponseStream(options) {
  const conversationId = options.body.prompt_cache_key || crypto.randomUUID();
  const headers = codexAuthHeaders({
    accessToken: options.accessToken,
    chatgptAccountId: options.chatgptAccountId,
    originator: CODEX_ORIGINATOR
  });
  headers.Accept = options.body.stream === true ? "text/event-stream" : "application/json";
  headers["session-id"] = conversationId;
  headers["thread-id"] = conversationId;
  headers["x-client-request-id"] = conversationId;
  const turnMetadataHeader = codexTurnMetadataHeaderFromResponseBody(options.body);
  if (turnMetadataHeader) {
    headers[CODEX_TURN_METADATA_HEADER] = turnMetadataHeader;
  }

  const response = await fetchWithRetries(`${options.apiBaseUrl}/responses`, {
    method: "POST",
    headers,
    signal: options.signal,
    body: canonicalCodexJsonString(responseBodyWithoutCodexTurnMetadata(options.body))
  }, {
    fetch: options.fetch
  });

  if (!response.ok) {
    await throwHttpError(response, "Codex Responses request");
  }

  const contentType = response.headers?.get?.("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = await readJsonResponse(response, "Codex Responses request");
    return withStreamControls(responseEventsFromCompletedJson(/** @type {CodexResponse} */ (body)), options);
  }

  if (!response.body) {
    throw new Error("Codex Responses request did not include a readable event stream");
  }

  return decodeSseStream(withStreamControls(response.body, options));
}

/**
 * @param {CodexResponseStreamEvent} event
 */
export function readCodexTextDelta(event) {
  return event.type === "response.output_text.delta" ? event.delta : "";
}

/**
 * @param {Map<string, string | null>} phases
 * @param {CodexResponseStreamEvent} event
 */
export function captureCodexOutputItemPhase(phases, event) {
  if (event.type !== "response.output_item.added" && event.type !== "response.output_item.done") {
    return;
  }

  const itemId = codexOutputItemEventId(event);
  const phase = codexOutputItemEventPhase(event);
  if (!itemId || phase === undefined) {
    return;
  }

  phases.set(itemId, phase);
}

/**
 * @param {Map<string, string | null>} phases
 * @param {CodexResponseStreamEvent} event
 * @returns {string | null | undefined}
 */
export function codexOutputTextDeltaPhase(phases, event) {
  return event.type === "response.output_text.delta" && typeof event.item_id === "string"
    ? phases.get(event.item_id)
    : undefined;
}

/**
 * @param {CodexResponseStreamEvent} event
 * @returns {string | undefined}
 */
export function codexOutputTextPartId(event) {
  return event.type === "response.output_text.delta" && typeof event.item_id === "string"
    ? `${event.item_id}:output:${event.content_index ?? 0}`
    : undefined;
}

/**
 * @param {CodexResponseStreamEvent} event
 * @param {string | null | undefined} phase
 * @returns {Record<string, string | number> | undefined}
 */
export function codexOutputTextMetadata(event, phase) {
  if (event.type !== "response.output_text.delta") {
    return;
  }

  return {
    openai_event_type: event.type,
    ...(typeof event.item_id === "string" ? { openai_item_id: event.item_id } : {}),
    ...(typeof event.output_index === "number" ? { openai_output_index: event.output_index } : {}),
    ...(typeof event.content_index === "number" ? { openai_content_index: event.content_index } : {}),
    ...(typeof event.sequence_number === "number" ? { openai_sequence_number: event.sequence_number } : {}),
    ...(typeof phase === "string" ? { openai_phase: phase } : {})
  };
}

/** @param {string | null | undefined} phase */
export function isCodexCommentaryOutputPhase(phase) {
  return phase === "commentary";
}

/**
 * @param {CodexResponseStreamEvent} event
 */
export function readCodexReasoningSummaryTextDelta(event) {
  return event.type === "response.reasoning_summary_text.delta" ? event.delta : "";
}

/**
 * @param {CodexResponseStreamEvent} event
 */
export function readCodexReasoningTextDelta(event) {
  return event.type === "response.reasoning_text.delta" ? event.delta : "";
}

/**
 * @param {CodexResponse} response
 * @returns {ReadableStream<CodexResponseStreamEvent>}
 */
function responseEventsFromCompletedJson(response) {
  return new ReadableStream({
    start(controller) {
      let textEmitted = false;
      if (Array.isArray(response.output)) {
        for (const [index, outputItem] of response.output.entries()) {
          const text = outputTextFromResponseOutputItem(outputItem);
          if (text) {
            const itemId = responseOutputItemId(outputItem) ?? `output-${index}`;
            controller.enqueue(/** @type {CodexResponseStreamEvent} */ ({
              type: "response.output_item.added",
              response_id: response.id,
              output_index: index,
              item: outputItem
            }));
            textEmitted = true;
            controller.enqueue(/** @type {CodexResponseStreamEvent} */ ({
              type: "response.output_text.delta",
              response_id: response.id,
              item_id: itemId,
              output_index: index,
              content_index: 0,
              delta: text
            }));
          }

          if (!isMessageResponseOutputItem(outputItem)) {
            controller.enqueue(/** @type {CodexResponseStreamEvent} */ ({
              type: "response.output_item.done",
              response_id: response.id,
              item_id: responseOutputItemId(outputItem) ?? `output-${index}`,
              output_index: index,
              item: outputItem
            }));
          }
        }
      }

      if (!textEmitted && typeof response.output_text === "string" && response.output_text) {
        controller.enqueue(/** @type {CodexResponseStreamEvent} */ ({
          type: "response.output_text.delta",
          response_id: response.id,
          delta: response.output_text
        }));
      }

      controller.enqueue(/** @type {CodexResponseCompletedEvent} */ ({
        type: "response.completed",
        response
      }));
      controller.close();
    }
  });
}

/**
 * @param {CodexJsonValue} item
 * @returns {boolean}
 */
function isMessageResponseOutputItem(item) {
  return Boolean(item && typeof item === "object" && !Array.isArray(item) && /** @type {Record<string, CodexJsonValue>} */ (item).type === "message");
}

/**
 * @param {CodexJsonValue} item
 * @returns {string | undefined}
 */
function responseOutputItemId(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return;
  }

  const outputItem = /** @type {Record<string, CodexJsonValue>} */ (item);
  return typeof outputItem.id === "string" && outputItem.id.trim()
    ? outputItem.id
    : undefined;
}

/**
 * @param {CodexResponseStreamEvent} event
 * @returns {string | undefined}
 */
function codexOutputItemEventId(event) {
  if ("item_id" in event && typeof event.item_id === "string" && event.item_id.trim()) {
    return event.item_id;
  }

  if (!("item" in event) || !event.item || typeof event.item !== "object" || Array.isArray(event.item)) {
    return;
  }

  const item = /** @type {Record<string, CodexJsonValue>} */ (event.item);
  return typeof item.id === "string" && item.id.trim() ? item.id : undefined;
}

/**
 * @param {CodexResponseStreamEvent} event
 * @returns {string | null | undefined}
 */
function codexOutputItemEventPhase(event) {
  if (!("item" in event) || !event.item || typeof event.item !== "object" || Array.isArray(event.item)) {
    return;
  }

  const item = /** @type {Record<string, CodexJsonValue>} */ (event.item);
  return typeof item.phase === "string" || item.phase === null ? item.phase : undefined;
}

/**
 * @param {CodexJsonValue} item
 * @returns {string | undefined}
 */
function outputTextFromResponseOutputItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return;
  }

  const outputItem = /** @type {Record<string, CodexJsonValue>} */ (item);
  if (outputItem.type !== "message" || !Array.isArray(outputItem.content)) {
    return;
  }

  let text = "";
  for (const contentItem of outputItem.content) {
    if (!contentItem || typeof contentItem !== "object" || Array.isArray(contentItem)) {
      continue;
    }

    const outputContentItem = /** @type {Record<string, CodexJsonValue>} */ (contentItem);
    if (outputContentItem.type === "output_text" && typeof outputContentItem.text === "string") {
      text += outputContentItem.text;
    }
  }

  return text || undefined;
}

/**
 * @param {CodexResponseStreamEvent} event
 * @returns {string | undefined}
 */
export function codexReasoningSummaryPartId(event) {
  switch (event.type) {
    case "response.reasoning_summary_part.added":
    case "response.reasoning_summary_text.delta":
    case "response.reasoning_summary_text.done":
    case "response.reasoning_summary_part.done": {
      return `${event.item_id}:${event.summary_index}`;
    }
    default: {
      return;
    }
  }
}

/**
 * @param {CodexResponseStreamEvent} event
 * @returns {string | undefined}
 */
export function codexReasoningTextPartId(event) {
  switch (event.type) {
    case "response.reasoning_text.delta":
    case "response.reasoning_text.done": {
      return `${event.item_id}:reasoning:${event.content_index}`;
    }
    default: {
      return;
    }
  }
}

/**
 * @param {CodexResponseStreamEvent} event
 * @returns {Record<string, string | number> | undefined}
 */
export function codexReasoningSummaryMetadata(event) {
  switch (event.type) {
    case "response.reasoning_summary_part.added":
    case "response.reasoning_summary_text.delta":
    case "response.reasoning_summary_text.done":
    case "response.reasoning_summary_part.done": {
      return {
        openai_event_type: event.type,
        openai_item_id: event.item_id,
        openai_output_index: event.output_index,
        openai_summary_index: event.summary_index,
        ...(typeof event.sequence_number === "number" ? { openai_sequence_number: event.sequence_number } : {})
      };
    }
    default: {
      return;
    }
  }
}

/**
 * @param {CodexResponseStreamEvent} event
 * @returns {Record<string, string | number> | undefined}
 */
export function codexReasoningTextMetadata(event) {
  switch (event.type) {
    case "response.reasoning_text.delta":
    case "response.reasoning_text.done": {
      return {
        openai_event_type: event.type,
        openai_item_id: event.item_id,
        openai_output_index: event.output_index,
        openai_content_index: event.content_index,
        ...(typeof event.sequence_number === "number" ? { openai_sequence_number: event.sequence_number } : {})
      };
    }
    default: {
      return;
    }
  }
}

/**
 * @param {CodexResponseStreamEvent} event
 */
export function isCodexReasoningSummaryDoneEvent(event) {
  return event.type === "response.reasoning_summary_text.done" || event.type === "response.reasoning_summary_part.done";
}

/**
 * @param {CodexResponseStreamEvent} event
 */
export function isCodexReasoningTextDoneEvent(event) {
  return event.type === "response.reasoning_text.done";
}

/** @param {CodexResponseStreamEvent} event */
export function throwIfCodexTerminalEvent(event) {
  switch (event.type) {
    case "response.failed": {
      throw new CodexResponseStreamError(formatTerminalEventMessage("failed", event), { event });
    }
    case "response.incomplete": {
      throw new CodexResponseStreamError(formatTerminalEventMessage("incomplete", event), { event });
    }
    default:
  }
}

/**
 * @param {AsyncIterable<CodexResponseStreamEvent>} events
 * @returns {Promise<CodexResponse>}
 */
export async function collectCodexResponseFromEvents(events) {
  let eventCount = 0;
  let outputText = "";
  /** @type {CodexResponse | undefined} */
  let completedResponse;

  for await (const event of events) {
    eventCount += 1;
    outputText += readCodexTextDelta(event);

    switch (event.type) {
      case "response.completed": {
        if (completedResponse) {
          throw new CodexResponseStreamError("Codex response request returned multiple completed response events.", { event });
        }

        completedResponse = event.response;
        break;
      }

      case "response.failed":
      case "response.incomplete": {
        throwIfCodexTerminalEvent(event);
        break;
      }
      default:
    }
  }

  if (completedResponse) {
    const response = { ...completedResponse, status: "completed" };
    if (outputText) {
      response.output_text = outputText;
    }
    return /** @type {CodexResponse} */ (response);
  }

  if (eventCount > 0) {
    return { status: "completed", output_text: outputText || undefined };
  }

  throw new CodexResponseStreamError("Codex response request returned an empty event stream.");
}

/**
 * @param {ReadableStream<CodexResponseStreamEvent>} stream
 * @param {{ signal?: AbortSignal, idleTimeoutMs?: number }} options
 */
function withStreamControls(stream, options) {
  return withAbortControl(withIdleTimeout(stream, options), options);
}

/**
 * @template T
 * @param {ReadableStream<T>} stream
 * @param {{ signal?: AbortSignal }} options
 */
function withAbortControl(stream, options) {
  if (!options.signal) {
    return stream;
  }

  /** @type {TransformStreamDefaultController<T> | undefined} */
  let activeController;

  const abortStream = () => {
    const reason = options.signal?.reason;
    activeController?.error(reason instanceof Error ? reason : new CodexResponseStreamError("Codex Responses stream was aborted."));
  };

  return stream.pipeThrough(new TransformStream({
    start(controller) {
      activeController = controller;
      if (options.signal?.aborted) {
        abortStream();
        return;
      }

      options.signal?.addEventListener("abort", abortStream, { once: true });
    },
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
    flush() {
      options.signal?.removeEventListener("abort", abortStream);
    }
  }));
}

/**
 * @template T
 * @param {ReadableStream<T>} stream
 * @param {{ idleTimeoutMs?: number, signal?: AbortSignal }} options
 */
function withIdleTimeout(stream, options) {
  if (!options.idleTimeoutMs || options.idleTimeoutMs <= 0) {
    return stream;
  }

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timeout;
  /** @type {TransformStreamDefaultController<T> | undefined} */
  let activeController;

  const clearIdleTimer = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };

  const resetIdleTimer = () => {
    clearIdleTimer();
    if (options.idleTimeoutMs && options.idleTimeoutMs > 0) {
      timeout = setTimeout(() => {
        activeController?.error(new CodexResponseStreamError(`Codex Responses stream was idle for ${options.idleTimeoutMs}ms.`));
      }, options.idleTimeoutMs);
    }
  };

  const stopIdleTimer = () => {
    clearIdleTimer();
  };

  return stream.pipeThrough(new TransformStream({
    start(controller) {
      activeController = controller;
      if (options.signal?.aborted) {
        return;
      }

      options.signal?.addEventListener("abort", stopIdleTimer, { once: true });
      resetIdleTimer();
    },
    transform(chunk, controller) {
      resetIdleTimer();
      controller.enqueue(chunk);
    },
    flush() {
      clearIdleTimer();
      options.signal?.removeEventListener("abort", stopIdleTimer);
    }
  }));
}

/**
 * @param {'failed' | 'incomplete'} status
 * @param {CodexResponseStreamEvent} event
 */
function formatTerminalEventMessage(status, event) {
  if (event.type === "response.failed") {
    const error = event.error ?? event.response?.error;
    const message = typeof error?.message === "string" ? ` ${error.message}` : "";
    return `Codex response ${status}.${message}`;
  }

  return `Codex response ${status}.`;
}
