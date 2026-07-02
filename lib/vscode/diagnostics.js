import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";

import { canonicalCodexJsonString } from "../codex-api/json.js";
import { readCocopiIssues, recordCocopiIssue, updateCocopiIssue } from "./issues.js";
import { parseCodexRateLimitEvent } from "../codex-api/rate-limits.js";
import { deriveCocopiTokenCacheDiagnostics, readCocopiTokenCacheDebugSummaries, recordCocopiRateLimitSnapshots, recordCocopiTokenCacheSummary } from "./token-cache-debug.js";

export const COCOPI_OUTPUT_CHANNEL_NAME = "Cocopi";
const COCOPI_DEBUG_PAYLOAD_CHUNK_CHARS = 12_000;
const COCOPI_DEBUG_PAYLOAD_SIDECAR_MAX_CHARS = 24_000;
const COCOPI_DEBUG_PAYLOAD_DIRECTORY_NAME = "payloads";

/** @typedef {'hit' | 'miss' | 'unknown'} CocopiCacheStatus */

/**
 * @typedef {object} CodexUsageSummary
 * @property {number | undefined} inputTokens
 * @property {number | undefined} outputTokens
 * @property {number | undefined} reasoningTokens
 * @property {number | undefined} totalTokens
 * @property {number | undefined} cachedTokens
 * @property {CocopiCacheStatus} cacheStatus
 * @property {number | undefined} cacheHitRatio
 * @property {string[]} usageKeys
 * @property {string[]} cacheFields
 */

/**
 * @typedef {object} CodexTokenCacheSummaryContext
 * @property {'chat' | 'language-model'} source
 * @property {string | undefined} [selectedModel]
 * @property {string} model
 * @property {number} hostRequestIndex
 * @property {string} sessionId
 * @property {string | undefined} [conversationSummary]
 * @property {string | undefined} [conversationDescription]
 * @property {number} [inputItems]
 * @property {boolean} [stateRestored]
 * @property {number} [requestMessages]
 * @property {number} [requestTextParts]
 * @property {number} [requestToolCallParts]
 * @property {number} [requestToolResultParts]
 * @property {number} [requestDataParts]
 * @property {number} [requestCocopiDataParts]
 * @property {number} [requestCocopiDataBytes]
 * @property {string} [requestDataMimeTypes]
 * @property {string | undefined} [transport]
 * @property {string | undefined} [serviceTier]
 * @property {string | undefined} [serviceTierSource]
 * @property {string | undefined} [reasoningEffort]
 * @property {string | undefined} [reasoningSummary]
 * @property {boolean | undefined} [fastRequested]
 * @property {boolean | undefined} [automaticContinuation]
 * @property {string | undefined} [promptCacheKey]
 * @property {string | undefined} [requestKind]
 * @property {string | undefined} [requestInputDigest]
 * @property {string | undefined} [requestToolsDigest]
 * @property {string | undefined} [requestBodyDigest]
 * @property {string | undefined} [wireMode]
 * @property {number | undefined} [wireInputItems]
 * @property {string | undefined} [wireInputDigest]
 * @property {string | undefined} [wireToolsDigest]
 * @property {string | undefined} [wireBodyDigest]
 * @property {import("../../data/Codex.js").CodexPreviousResponseDecision | undefined} [webSocketContinuationDecision]
 * @property {string | undefined} [requestStartedAt]
 * @property {string | undefined} [requestCompletedAt]
 * @property {number | undefined} [requestDurationMs]
 * @property {number | undefined} [firstEventLatencyMs]
 * @property {number | undefined} [firstOutputLatencyMs]
 * @property {Record<string, import("../../data/Codex.js").CodexJsonValue> | undefined} [response]
 */

/**
 * @typedef {object} CodexWebSocketContinuationContext
 * @property {'chat' | 'language-model'} source
 * @property {string} model
 * @property {number} hostRequestIndex
 * @property {string} sessionId
 * @property {string | undefined} [promptCacheKey]
 */

/**
 * @typedef {object} CodexRequestDiagnosticsContext
 * @property {'chat' | 'language-model' | string} [source]
 * @property {number | undefined} [hostRequestIndex]
 * @property {string | undefined} [sessionId]
 * @property {string | undefined} [stage]
 */

/**
 * @typedef {CodexRequestDiagnosticsContext & {
 *   model?: string | undefined,
 *   inputItems?: number | undefined,
 *   messages?: number | undefined,
 *   textParts?: number | undefined,
 *   toolCallParts?: number | undefined,
 *   toolResultParts?: number | undefined,
 *   dataParts?: number | undefined,
 *   cocopiDataParts?: number | undefined,
 *   cocopiDataBytes?: number | undefined,
 *   continuationAnchors?: number | undefined,
 *   continuationAnchorInputItems?: number | undefined,
 *   continuationAnchorResponseItems?: number | undefined,
 *   tools?: number | undefined,
 *   toolCalls?: number | undefined,
 *   reasoningItems?: number | undefined,
 *   stateRestored?: boolean | undefined
 * }} CocopiMemoryDiagnosticsContext
 */

/**
 * @typedef {object} CocopiMemoryDiagnosticsOptions
 * @property {boolean} [force]
 * @property {'debug' | 'info'} [level]
 */

/**
 * @typedef {object} CocopiMemoryUsageSnapshot
 * @property {number} rss
 * @property {number} heapTotal
 * @property {number} heapUsed
 * @property {number} external
 * @property {number | undefined} [arrayBuffers]
 */

/**
 * @typedef {object} CodexRequestDiagnosticSummary
 * @property {'compaction' | 'conversation-summary' | 'normal'} requestKind
 * @property {number} inputItems
 * @property {number} tools
 * @property {'full' | 'previous-response'} wireMode
 * @property {string} inputDigest
 * @property {string} toolsDigest
 * @property {string} bodyDigest
 * @property {string} inputShape
 * @property {string} toolsShape
 */

/**
 * @typedef {object} CocopiLogger
 * @property {(message: string) => void} info
 * @property {(message: string) => void} debug
 * @property {(message: string, error?: Error | string | object | null | undefined) => void} error
 * @property {((entry: CocopiPayloadLogEntry) => CocopiPayloadLogResult | undefined) | undefined} [payload]
 * @property {() => void} dispose
 */

/**
 * @typedef {object} CocopiPayloadLogEntry
 * @property {string} prefix
 * @property {string} json
 * @property {number} chars
 * @property {string} digest
 * @property {string | undefined} [reason]
 */

/**
 * @typedef {object} CocopiPayloadLogResult
 * @property {string} path
 * @property {number} bytes
 */

/** @type {CocopiLogger} */
export const noopCocopiLogger = Object.freeze({
  info() {},
  debug() {},
  error() {},
  dispose() {}
});

/**
 * @typedef {object} CodexInputSummary
 * @property {number} messages
 * @property {number} userMessages
 * @property {number} assistantMessages
 * @property {number} toolCalls
 * @property {number} toolOutputs
 * @property {number} reasoningItems
 * @property {number} inputTextParts
 * @property {number} outputTextParts
 * @property {number} imageParts
 */

/**
 * @param {{ window: { createOutputChannel(name: string): { appendLine(value: string): void, dispose(): void } } }} vscode
 * @param {{ logUri?: { fsPath?: string } | undefined }} [context]
 * @returns {CocopiLogger}
 */
export function createCocopiLogger(vscode, context = {}) {
  const channel = vscode.window.createOutputChannel(COCOPI_OUTPUT_CHANNEL_NAME);
  const payload = createCocopiPayloadLogWriter(context.logUri?.fsPath);
  return {
    info(message) {
      channel.appendLine(formatLogLine("info", message));
    },
    debug(message) {
      channel.appendLine(formatLogLine("debug", message));
    },
    error(message, error) {
      channel.appendLine(formatLogLine("error", message));
      if (error) {
        channel.appendLine(redactCocopiLogText(formatErrorForLog(error)));
      }
    },
    payload,
    dispose() {
      channel.dispose();
    }
  };
}

/**
 * @param {string | undefined} logDirectory
 * @returns {((entry: CocopiPayloadLogEntry) => CocopiPayloadLogResult | undefined) | undefined}
 */
function createCocopiPayloadLogWriter(logDirectory) {
  if (!logDirectory) {
    return;
  }

  const payloadDirectory = path.join(logDirectory, COCOPI_DEBUG_PAYLOAD_DIRECTORY_NAME);
  const payloadPath = path.join(payloadDirectory, `codex-payloads-${formatPayloadLogTimestamp(new Date())}-${readProcessId()}.jsonl`);
  let directoryReady = false;

  return (entry) => {
    if (!directoryReady) {
      mkdirSync(payloadDirectory, { recursive: true });
      directoryReady = true;
    }

    return writeCocopiPayloadLogEntry(payloadPath, entry);
  };
}

/**
 * @param {string} payloadPath
 * @param {CocopiPayloadLogEntry} entry
 * @returns {CocopiPayloadLogResult}
 */
function writeCocopiPayloadLogEntry(payloadPath, entry) {
  const metadata = {
    timestamp: new Date().toISOString(),
    prefix: entry.prefix,
    chars: entry.chars,
    digest: entry.digest,
    reason: entry.reason
  };
  const header = `${JSON.stringify(metadata).slice(0, -1)},"payload":`;
  const suffix = "}\n";
  const fd = openSync(payloadPath, "a");
  try {
    writeSync(fd, header);
    writeSync(fd, entry.json);
    writeSync(fd, suffix);
  } finally {
    closeSync(fd);
  }

  return {
    path: payloadPath,
    bytes: Buffer.byteLength(header) + Buffer.byteLength(entry.json) + Buffer.byteLength(suffix)
  };
}

/** @param {Date} date */
function formatPayloadLogTimestamp(date) {
  return date.toISOString().replaceAll(/[:.]/gu, "-");
}

function readProcessId() {
  return typeof process === "object" && process && typeof process.pid === "number"
    ? String(process.pid)
    : "unknown";
}

/**
 * @param {CocopiLogger} logger
 * @param {import("./configuration.js").CocopiConfiguration["debugLevel"]} debugLevel
 * @param {CocopiMemoryDiagnosticsContext} [context]
 * @param {CocopiMemoryDiagnosticsOptions} [options]
 * @returns {CocopiMemoryUsageSnapshot | undefined}
 */
export function logCocopiMemoryDiagnostics(logger, debugLevel, context = {}, options = {}) {
  if (debugLevel === "off" && options.force !== true) {
    return;
  }

  const snapshot = readCocopiMemoryUsage();
  const line = formatCocopiMemoryDiagnostics(snapshot, context);
  if (options.level === "info") {
    logger.info(line);
  } else {
    logger.debug(line);
  }

  return snapshot;
}

/** @returns {CocopiMemoryUsageSnapshot | undefined} */
export function readCocopiMemoryUsage() {
  const processLike = typeof process === "object" && process ? process : undefined;
  return typeof processLike?.memoryUsage === "function" ? processLike.memoryUsage() : undefined;
}

/**
 * @param {CocopiMemoryUsageSnapshot | undefined} snapshot
 * @param {CocopiMemoryDiagnosticsContext} [context]
 */
export function formatCocopiMemoryDiagnostics(snapshot, context = {}) {
  const contextFields = formatMemoryDiagnosticsContextFields(context);
  if (!snapshot) {
    return ["Extension host memory.", ...contextFields, "available=false"].join(" ");
  }

  return [
    "Extension host memory.",
    ...contextFields,
    ...formatMemoryByteFields("rss", snapshot.rss),
    ...formatMemoryByteFields("heapTotal", snapshot.heapTotal),
    ...formatMemoryByteFields("heapUsed", snapshot.heapUsed),
    ...formatMemoryByteFields("external", snapshot.external),
    ...formatMemoryByteFields("arrayBuffers", snapshot.arrayBuffers)
  ].join(" ");
}

/**
 * @param {CocopiLogger} logger
 * @param {import("./configuration.js").CocopiConfiguration["debugLevel"]} debugLevel
 * @param {import("../../data/Codex.js").CodexResponseStreamEvent | Record<string, import("../../data/Codex.js").CodexJsonValue>} event
 * @param {CodexRequestDiagnosticsContext} [context]
 */
export function logCodexResponseEventDiagnostics(logger, debugLevel, event, context = {}) {
  if (debugLevel === "off" || !event || typeof event !== "object" || Array.isArray(event)) {
    return;
  }

  const type = typeof event.type === "string" ? event.type : "unknown";
  const eventKeys = sortedKeys(event);
  const contextFields = formatDiagnosticsContextFields(context);
  if (debugLevel === "events" || debugLevel === "payloads") {
    logger.debug(["Codex stream event.", ...contextFields, `type=${type}`, `keys=${eventKeys.join(",")}`].join(" "));
  }

  if (debugLevel === "payloads") {
    logDebugJsonPayload(
      logger,
      formatDiagnosticsPrefix("Codex stream event payload.", [...contextFields, `type=${type}`]),
      event,
      {
        maxChars: COCOPI_DEBUG_PAYLOAD_SIDECAR_MAX_CHARS,
        omissionReason: "stream-payload-size-limit"
      }
    );
  }

  if (!KNOWN_CODEX_STREAM_EVENT_TYPES.has(type)) {
    logger.debug(["Unknown Codex stream event.", ...contextFields, `type=${type}`, `keys=${eventKeys.join(",")}`].join(" "));
    return;
  }

  if (type === "codex.rate_limits") {
    const snapshot = parseCodexRateLimitEvent(event);
    if (snapshot) {
      recordCocopiRateLimitSnapshots(snapshot);
    }
  }

  if (type === "response.completed" && "response" in event && event.response && typeof event.response === "object" && !Array.isArray(event.response)) {
    logCodexCompletedResponseDiagnostics(logger, /** @type {Record<string, import("../../data/Codex.js").CodexJsonValue>} */ (event.response), context);
  }
}

/**
 * @param {CocopiLogger} logger
 * @param {import("./configuration.js").CocopiConfiguration["debugLevel"]} debugLevel
 * @param {CodexTokenCacheSummaryContext} context
 * @param {{ issueTracking?: boolean, tokenTracking?: boolean }} [options]
 */
export function logCodexTokenCacheSummary(logger, debugLevel, context, options = {}) {
  const fields = [
    `source=${context.source}`,
    `hostRequest=${context.hostRequestIndex}`,
    `sessionId=${formatLogScalar(context.sessionId)}`,
    `model=${formatLogScalar(context.model)}`,
    `inputItems=${formatNumber(context.inputItems)}`
  ];
  if (context.selectedModel) {
    fields.push(`selectedModel=${formatLogScalar(context.selectedModel)}`);
  }
  if (context.transport) {
    fields.push(`transport=${formatLogScalar(context.transport)}`);
  }
  if (context.serviceTier) {
    fields.push(`serviceTier=${formatLogScalar(context.serviceTier)}`);
  }
  if (context.serviceTierSource) {
    fields.push(`serviceTierSource=${formatLogScalar(context.serviceTierSource)}`);
  }
  if (context.reasoningEffort) {
    fields.push(`reasoningEffort=${formatLogScalar(context.reasoningEffort)}`);
  }
  if (context.reasoningSummary) {
    fields.push(`reasoningSummary=${formatLogScalar(context.reasoningSummary)}`);
  }
  if (context.fastRequested !== undefined) {
    fields.push(`fastRequested=${context.fastRequested}`);
  }
  if (context.automaticContinuation !== undefined) {
    fields.push(`automaticContinuation=${context.automaticContinuation}`);
  }
  if (context.requestKind) {
    fields.push(`requestKind=${formatLogScalar(context.requestKind)}`);
  }
  if (context.requestInputDigest) {
    fields.push(`requestInputDigest=${formatLogScalar(context.requestInputDigest)}`);
  }
  if (context.requestToolsDigest) {
    fields.push(`requestToolsDigest=${formatLogScalar(context.requestToolsDigest)}`);
  }
  if (context.requestBodyDigest) {
    fields.push(`requestBodyDigest=${formatLogScalar(context.requestBodyDigest)}`);
  }
  if (context.wireMode) {
    fields.push(`wireMode=${formatLogScalar(context.wireMode)}`);
  }
  if (context.wireInputItems !== undefined) {
    fields.push(`wireInputItems=${formatNumber(context.wireInputItems)}`);
  }
  if (context.wireInputDigest) {
    fields.push(`wireInputDigest=${formatLogScalar(context.wireInputDigest)}`);
  }
  if (context.wireToolsDigest) {
    fields.push(`wireToolsDigest=${formatLogScalar(context.wireToolsDigest)}`);
  }
  if (context.wireBodyDigest) {
    fields.push(`wireBodyDigest=${formatLogScalar(context.wireBodyDigest)}`);
  }
  if (context.webSocketContinuationDecision) {
    fields.push(`webSocketContinuation=${context.webSocketContinuationDecision.action}/${context.webSocketContinuationDecision.reason}`);
    if (context.webSocketContinuationDecision.requestStateChanges?.length) {
      fields.push(`webSocketStateChanges=${formatLogScalar(context.webSocketContinuationDecision.requestStateChanges.join("|"))}`);
    }
    fields.push(...formatContinuationMismatchFields(context.webSocketContinuationDecision, "webSocket"));
  }
  if (context.requestDurationMs !== undefined) {
    fields.push(`durationMs=${formatNumber(context.requestDurationMs)}`);
  }
  if (context.firstEventLatencyMs !== undefined) {
    fields.push(`firstEventMs=${formatNumber(context.firstEventLatencyMs)}`);
  }
  if (context.firstOutputLatencyMs !== undefined) {
    fields.push(`firstOutputMs=${formatNumber(context.firstOutputLatencyMs)}`);
  }
  if (context.conversationSummary) {
    fields.push(`conversationSummary=${formatLogScalar(context.conversationSummary)}`);
  }
  if (context.conversationDescription) {
    fields.push(`conversationDescription=${formatLogScalar(context.conversationDescription)}`);
  }

  const promptCacheKey = context.promptCacheKey ?? context.sessionId;
  fields.push(`promptCacheKey=${formatLogScalar(promptCacheKey)}`);

  const response = context.response;
  const responseId = response && typeof response === "object" && !Array.isArray(response) && "id" in response
    ? formatLogScalar(response.id)
    : undefined;
  if (responseId !== undefined) {
    fields.push(`responseId=${responseId}`);
  }

  const usage = readCodexUsageSummary(response ?? {});
  const webSocketContinuationAction = context.webSocketContinuationDecision?.action;
  const webSocketContinuationReason = context.webSocketContinuationDecision?.reason;
  const webSocketContinuationStateChanges = context.webSocketContinuationDecision?.requestStateChanges?.join(",");
  const tokenCacheDiagnostics = deriveCocopiTokenCacheDiagnostics({
    requestKind: context.requestKind,
    wireMode: context.wireMode,
    automaticContinuation: context.automaticContinuation,
    webSocketContinuationAction,
    webSocketContinuationReason,
    webSocketContinuationStateChanges,
    inputTokens: usage?.inputTokens,
    cachedTokens: usage?.cachedTokens,
    cacheStatus: usage?.cacheStatus ?? "unknown"
  });
  fields.push(
    `turnKind=${formatLogScalar(tokenCacheDiagnostics.turnKind)}`,
    `cacheRisk=${formatLogScalar(tokenCacheDiagnostics.cacheRisk)}`,
    ...(tokenCacheDiagnostics.uncachedInputTokens === undefined ? [] : [`uncachedInputTokens=${formatNumber(tokenCacheDiagnostics.uncachedInputTokens)}`])
  );
  if (options.issueTracking !== false) {
    recordTokenCacheIssue(context, usage);
  }
  if (usage) {
    fields.push(formatCodexUsageSummary(usage));
  } else {
    fields.push("usage=absent");
  }

  if (options.tokenTracking !== false && usage) {
    recordCocopiTokenCacheSummary({
      source: context.source,
      hostRequestIndex: context.hostRequestIndex,
      sessionId: context.sessionId,
      conversationSummary: trimConversationMetadata(context.conversationSummary),
      conversationDescription: trimConversationMetadata(context.conversationDescription),
      model: context.model,
      selectedModel: context.selectedModel,
      inputItems: context.inputItems ?? 0,
      stateRestored: context.stateRestored,
      requestMessages: context.requestMessages,
      requestTextParts: context.requestTextParts,
      requestToolCallParts: context.requestToolCallParts,
      requestToolResultParts: context.requestToolResultParts,
      requestDataParts: context.requestDataParts,
      requestCocopiDataParts: context.requestCocopiDataParts,
      requestCocopiDataBytes: context.requestCocopiDataBytes,
      requestDataMimeTypes: context.requestDataMimeTypes,
      transport: context.transport,
      serviceTier: context.serviceTier,
      serviceTierSource: context.serviceTierSource,
      reasoningEffort: context.reasoningEffort,
      reasoningSummary: context.reasoningSummary,
      fastRequested: context.fastRequested,
      automaticContinuation: context.automaticContinuation,
      promptCacheKey: context.promptCacheKey ?? context.sessionId,
      requestKind: context.requestKind,
      requestInputDigest: context.requestInputDigest,
      requestToolsDigest: context.requestToolsDigest,
      requestBodyDigest: context.requestBodyDigest,
      wireMode: context.wireMode,
      wireInputItems: context.wireInputItems,
      wireInputDigest: context.wireInputDigest,
      wireToolsDigest: context.wireToolsDigest,
      wireBodyDigest: context.wireBodyDigest,
      webSocketContinuationAction,
      webSocketContinuationReason,
      webSocketContinuationStateChanges,
      webSocketContinuationMatchingItems: context.webSocketContinuationDecision?.inputPrefixMatchingItems,
      webSocketContinuationMismatchIndex: context.webSocketContinuationDecision?.inputPrefixMismatchIndex,
      webSocketContinuationExpected: context.webSocketContinuationDecision?.inputPrefixExpected,
      webSocketContinuationActual: context.webSocketContinuationDecision?.inputPrefixActual,
      webSocketContinuationExpectedDigest: context.webSocketContinuationDecision?.inputPrefixExpectedDigest,
      webSocketContinuationActualDigest: context.webSocketContinuationDecision?.inputPrefixActualDigest,
      turnKind: tokenCacheDiagnostics.turnKind,
      cacheRisk: tokenCacheDiagnostics.cacheRisk,
      uncachedInputTokens: tokenCacheDiagnostics.uncachedInputTokens,
      requestStartedAt: context.requestStartedAt,
      requestCompletedAt: context.requestCompletedAt,
      requestDurationMs: context.requestDurationMs,
      firstEventLatencyMs: context.firstEventLatencyMs,
      firstOutputLatencyMs: context.firstOutputLatencyMs,
      responseId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      totalTokens: usage.totalTokens,
      cachedTokens: usage.cachedTokens,
      cacheStatus: usage.cacheStatus,
      cacheHitRatio: usage.cacheHitRatio
    });
  }

  if (debugLevel === "off") {
    return;
  }

  logger.debug(["Codex token/cache summary.", ...fields].join(" "));
}

/**
 * @param {CocopiLogger} logger
 * @param {import("./configuration.js").CocopiConfiguration["debugLevel"]} debugLevel
 * @param {CodexWebSocketContinuationContext} context
 * @param {import("../../data/Codex.js").CodexPreviousResponseDecision} decision
 * @param {{ issueTracking?: boolean }} [options]
 */
export function logCodexWebSocketContinuationDecision(logger, debugLevel, context, decision, options = {}) {
  if (options.issueTracking !== false && shouldRecordWebSocketContinuationIssue(decision)) {
    recordCocopiIssue({
      severity: "info",
      category: "websocket-continuation",
      title: "Codex WebSocket continuation was not used",
      details: "Cocopi could not safely reduce this WebSocket response.create request to a previous_response_id continuation, so it sent the full request state instead.",
      metadata: webSocketContinuationIssueMetadata(context, decision)
    });
  }

  if (debugLevel === "off") {
    return;
  }

  logger.debug([
    "Codex WebSocket continuation.",
    `source=${context.source}`,
    `hostRequest=${context.hostRequestIndex}`,
    `sessionId=${formatLogScalar(context.sessionId)}`,
    `model=${formatLogScalar(context.model)}`,
    `action=${decision.action}`,
    `reason=${decision.reason}`,
    `inputItems=${formatNumber(decision.inputItems)}`,
    `baselineItems=${formatNumber(decision.baselineItems)}`,
    `deltaItems=${formatNumber(decision.deltaItems)}`,
    `stateChanges=${formatLogScalar(decision.requestStateChanges?.join("|"))}`,
    ...formatContinuationMismatchFields(decision, "inputPrefix"),
    `promptCacheKey=${formatLogScalar(context.promptCacheKey ?? context.sessionId)}`
  ].join(" "));
}

/** @param {import("../../data/Codex.js").CodexPreviousResponseDecision} decision */
function shouldRecordWebSocketContinuationIssue(decision) {
  return decision.action === "skipped" && (
    decision.reason === "input-prefix-mismatch"
    || decision.reason === "no-prior-response-id"
  );
}

/**
 * @param {CodexWebSocketContinuationContext} context
 * @param {import("../../data/Codex.js").CodexPreviousResponseDecision} decision
 * @returns {Record<string, string | number | boolean | undefined>}
 */
function webSocketContinuationIssueMetadata(context, decision) {
  return {
    source: context.source,
    hostRequestIndex: context.hostRequestIndex,
    sessionId: trimConversationMetadata(context.sessionId),
    model: context.model,
    promptCacheKey: trimConversationMetadata(context.promptCacheKey ?? context.sessionId),
    action: decision.action,
    reason: decision.reason,
    inputItems: decision.inputItems,
    baselineItems: decision.baselineItems,
    deltaItems: decision.deltaItems,
    stateChanges: decision.requestStateChanges?.join(","),
    inputPrefixMatchingItems: decision.inputPrefixMatchingItems,
    inputPrefixMismatchIndex: decision.inputPrefixMismatchIndex,
    inputPrefixExpected: decision.inputPrefixExpected,
    inputPrefixActual: decision.inputPrefixActual,
    inputPrefixExpectedDigest: decision.inputPrefixExpectedDigest,
    inputPrefixActualDigest: decision.inputPrefixActualDigest
  };
}

/**
 * @param {CodexTokenCacheSummaryContext} context
 * @param {CodexUsageSummary | undefined} usage
 */
function recordTokenCacheIssue(context, usage) {
  if (!usage) {
    recordCocopiIssue({
      severity: "info",
      category: "token-cache",
      title: "Codex request did not include usage counters",
      details: missingUsageDetails(context),
      metadata: tokenCacheIssueMetadata(context, usage)
    });
    return;
  }

  if (usage.cacheStatus === "unknown") {
    recordCocopiIssue({
      severity: "info",
      category: "token-cache",
      title: "Codex response did not expose cached-token counters",
      details: "Cocopi saw usage counters, but none of the recognized cached-token fields were present.",
      metadata: tokenCacheIssueMetadata(context, usage)
    });
    return;
  }

  if (usage.cacheStatus === "hit") {
    markRecoveredTokenCacheMissIssues(context, usage);
    return;
  }

  if (usage.cacheStatus !== "miss") {
    return;
  }

  const promptCacheKey = context.promptCacheKey ?? context.sessionId;
  const previousHit = readCocopiTokenCacheDebugSummaries().find((summary) =>
    summary.sessionId === context.sessionId
    && summary.model === context.model
    && summary.promptCacheKey === promptCacheKey
    && summary.cacheStatus === "hit"
  );
  recordCocopiIssue({
    severity: previousHit ? "warning" : "info",
    category: "token-cache",
    title: previousHit ? "Prompt cache missed after a previous hit" : "Prompt cache miss",
    details: previousHit
      ? cacheMissAfterHitDetails(context.webSocketContinuationDecision)
      : coldCacheMissDetails(context.webSocketContinuationDecision),
    metadata: {
      ...tokenCacheIssueMetadata(context, usage),
      previousHitHostRequest: previousHit?.hostRequestIndex,
      previousHitCachedTokens: previousHit?.cachedTokens
    }
  });
}

/** @param {CodexTokenCacheSummaryContext} context */
function missingUsageDetails(context) {
  if (context.response && typeof context.response === "object" && !Array.isArray(context.response)) {
    return "Cocopi could not evaluate prompt-cache behavior for this request because the completed response had no usage object.";
  }

  return "Cocopi could not evaluate prompt-cache behavior because the request failed or ended before a completed response with usage counters was observed.";
}

/** @param {import("../../data/Codex.js").CodexPreviousResponseDecision | undefined} decision */
function cacheMissAfterHitDetails(decision) {
  const details = "A request using the same model and prompt cache key returned zero cached tokens after an earlier hit. This can indicate a token-continuity drop or a backend cache reset.";
  return appendContinuationDiagnosis(details, decision);
}

/** @param {import("../../data/Codex.js").CodexPreviousResponseDecision | undefined} decision */
function coldCacheMissDetails(decision) {
  const details = "A request returned zero cached tokens. This can be expected for a cold cache, but is tracked while Cocopi is under development.";
  return appendContinuationDiagnosis(details, decision);
}

/**
 * @param {string} details
 * @param {import("../../data/Codex.js").CodexPreviousResponseDecision | undefined} decision
 */
function appendContinuationDiagnosis(details, decision) {
  if (!decision) {
    return details;
  }

  const changes = decision.requestStateChanges?.length
    ? ` (${decision.requestStateChanges.join(", ")})`
    : "";
  if (decision.action === "used" && decision.requestStateChanges?.length) {
    return `${details} The immediately preceding WebSocket continuation used previous_response_id while request state changed${changes}.`;
  }

  if (decision.action !== "skipped") {
    return details;
  }

  return `${details} The immediately preceding WebSocket continuation was skipped because ${decision.reason}${changes}.`;
}

/**
 * @param {CodexTokenCacheSummaryContext} context
 * @param {CodexUsageSummary} usage
 */
function markRecoveredTokenCacheMissIssues(context, usage) {
  const promptCacheKey = context.promptCacheKey ?? context.sessionId;
  for (const issue of readCocopiIssues()) {
    if (!isMatchingTokenCacheMissIssue(issue, context, promptCacheKey) || issue.metadata.recovered === true) {
      continue;
    }

    updateCocopiIssue(issue.id, {
      details: recoveredTokenCacheMissDetails(issue.details),
      metadata: {
        ...issue.metadata,
        recovered: true,
        recoveredHostRequest: context.hostRequestIndex,
        recoveredCachedTokens: usage.cachedTokens,
        recoveredCacheHitRatio: usage.cacheHitRatio,
        recoveredInputTokens: usage.inputTokens
      }
    });
  }
}

/**
 * @param {import("./issues.js").CocopiIssue} issue
 * @param {CodexTokenCacheSummaryContext} context
 * @param {string} promptCacheKey
 */
function isMatchingTokenCacheMissIssue(issue, context, promptCacheKey) {
  return issue.category === "token-cache"
    && issue.metadata.sessionId === context.sessionId
    && issue.metadata.model === context.model
    && issue.metadata.promptCacheKey === promptCacheKey
    && issue.metadata.cacheStatus === "miss";
}

/** @param {string} details */
function recoveredTokenCacheMissDetails(details) {
  if (details.includes("A later matching request reported cached tokens again")) {
    return details;
  }

  return `${details} A later matching request reported cached tokens again; the miss remains recorded because it may have incurred cost.`;
}

/**
 * @param {CodexTokenCacheSummaryContext} context
 * @param {CodexUsageSummary | undefined} usage
 * @returns {Record<string, string | number | boolean | undefined>}
 */
function tokenCacheIssueMetadata(context, usage) {
  const tokenCacheDiagnostics = deriveCocopiTokenCacheDiagnostics({
    requestKind: context.requestKind,
    wireMode: context.wireMode,
    automaticContinuation: context.automaticContinuation,
    webSocketContinuationAction: context.webSocketContinuationDecision?.action,
    webSocketContinuationReason: context.webSocketContinuationDecision?.reason,
    webSocketContinuationStateChanges: context.webSocketContinuationDecision?.requestStateChanges?.join(","),
    inputTokens: usage?.inputTokens,
    cachedTokens: usage?.cachedTokens,
    cacheStatus: usage?.cacheStatus ?? "unknown"
  });
  return {
    source: context.source,
    hostRequestIndex: context.hostRequestIndex,
    sessionId: context.sessionId,
    conversationSummary: context.conversationSummary,
    conversationDescription: context.conversationDescription,
    model: context.model,
    selectedModel: context.selectedModel,
    serviceTier: context.serviceTier,
    serviceTierSource: context.serviceTierSource,
    reasoningEffort: context.reasoningEffort,
    reasoningSummary: context.reasoningSummary,
    fastRequested: context.fastRequested,
    automaticContinuation: context.automaticContinuation,
    inputItems: context.inputItems,
    transport: context.transport,
    promptCacheKey: context.promptCacheKey ?? context.sessionId,
    requestKind: context.requestKind,
    requestInputDigest: context.requestInputDigest,
    requestToolsDigest: context.requestToolsDigest,
    requestBodyDigest: context.requestBodyDigest,
    wireMode: context.wireMode,
    wireInputItems: context.wireInputItems,
    wireInputDigest: context.wireInputDigest,
    wireToolsDigest: context.wireToolsDigest,
    wireBodyDigest: context.wireBodyDigest,
    webSocketContinuationAction: context.webSocketContinuationDecision?.action,
    webSocketContinuationReason: context.webSocketContinuationDecision?.reason,
    webSocketStateChanges: context.webSocketContinuationDecision?.requestStateChanges?.join(","),
    webSocketInputPrefixMatchingItems: context.webSocketContinuationDecision?.inputPrefixMatchingItems,
    webSocketInputPrefixMismatchIndex: context.webSocketContinuationDecision?.inputPrefixMismatchIndex,
    webSocketInputPrefixExpected: context.webSocketContinuationDecision?.inputPrefixExpected,
    webSocketInputPrefixActual: context.webSocketContinuationDecision?.inputPrefixActual,
    webSocketInputPrefixExpectedDigest: context.webSocketContinuationDecision?.inputPrefixExpectedDigest,
    webSocketInputPrefixActualDigest: context.webSocketContinuationDecision?.inputPrefixActualDigest,
    turnKind: tokenCacheDiagnostics.turnKind,
    cacheRisk: tokenCacheDiagnostics.cacheRisk,
    uncachedInputTokens: tokenCacheDiagnostics.uncachedInputTokens,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    cachedTokens: usage?.cachedTokens,
    cacheStatus: usage?.cacheStatus,
    cacheHitRatio: usage?.cacheHitRatio
  };
}

/** @param {string | undefined} value */
function trimConversationMetadata(value) {
  if (typeof value !== "string") {
    return;
  }

  const trimmed = value.trim().replaceAll(/\s+/g, " ");
  return trimmed.length > 220 ? `${trimmed.slice(0, 217)}...` : trimmed;
}

/**
 * @param {CocopiLogger} logger
 * @param {import("./configuration.js").CocopiConfiguration["debugLevel"]} debugLevel
 * @param {import("../../data/Codex.js").CodexResponseCreateRequest} body
 * @param {CodexRequestDiagnosticsContext} [context]
 */
export function logCodexRequestDiagnostics(logger, debugLevel, body, context = {}) {
  if (debugLevel === "off") {
    return;
  }

  const contextFields = formatDiagnosticsContextFields(context);
  if (debugLevel === "payloads") {
    logDebugJsonPayload(logger, formatDiagnosticsPrefix("Codex request payload.", contextFields), body);
  }

  const input = Array.isArray(body.input) ? body.input : [];
  const requestSummary = summarizeCodexRequestBodyForDiagnostics(body);
  /** @type {CodexInputSummary} */
  const counts = {
    messages: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolOutputs: 0,
    reasoningItems: 0,
    inputTextParts: 0,
    outputTextParts: 0,
    imageParts: 0
  };
  for (const item of input) {
    summarizeInputItem(counts, item);
  }

  logger.debug([
    "Codex request input.",
    ...contextFields,
    `model=${body.model}`,
    `requestKind=${requestSummary.requestKind}`,
    `wireMode=${requestSummary.wireMode}`,
    `inputItems=${input.length}`,
    `messages=${counts.messages}`,
    `userMessages=${counts.userMessages}`,
    `assistantMessages=${counts.assistantMessages}`,
    `toolCalls=${counts.toolCalls}`,
    `toolOutputs=${counts.toolOutputs}`,
    `reasoningItems=${counts.reasoningItems}`,
    `inputTextParts=${counts.inputTextParts}`,
    `outputTextParts=${counts.outputTextParts}`,
    `imageParts=${counts.imageParts}`,
    `instructions=${body.instructions ? "present" : "absent"}`,
    `tools=${body.tools?.length ?? 0}`,
    `toolsShape=${formatLogScalar(requestSummary.toolsShape)}`,
    `reasoningEffort=${formatLogScalar(body.reasoning?.effort)}`,
    `reasoningSummary=${formatLogScalar(body.reasoning?.summary)}`,
    `previousResponseId=${body.previous_response_id ? "present" : "absent"}`,
    `promptCacheKey=${formatLogScalar(body.prompt_cache_key)}`,
    `inputDigest=${requestSummary.inputDigest}`,
    `toolsDigest=${requestSummary.toolsDigest}`,
    `bodyDigest=${requestSummary.bodyDigest}`,
    `inputShape=${formatLogScalar(requestSummary.inputShape)}`
  ].join(" "));
}

/**
 * @param {CocopiLogger} logger
 * @param {import("./configuration.js").CocopiConfiguration["debugLevel"]} debugLevel
 * @param {Error | string | object | null | undefined} error
 * @param {CodexRequestDiagnosticsContext} [context]
 * @param {{ requestBody?: import("../../data/Codex.js").CodexResponseCreateRequest, wireBody?: import("../../data/Codex.js").CodexResponseCreateRequest }} [payloads]
 */
export function logCodexFailurePayloadDiagnostics(logger, debugLevel, error, context = {}, payloads = {}) {
  if (debugLevel !== "payloads") {
    return;
  }

  const contextFields = formatDiagnosticsContextFields(context);
  if (payloads.requestBody) {
    logDebugJsonPayload(logger, formatDiagnosticsPrefix("Codex request payload on error.", contextFields), payloads.requestBody);
  }
  if (payloads.wireBody && (!payloads.requestBody || canonicalCodexJsonString(payloads.wireBody) !== canonicalCodexJsonString(payloads.requestBody))) {
    logDebugJsonPayload(logger, formatDiagnosticsPrefix("Codex wire request payload on error.", contextFields), payloads.wireBody);
  }

  const errorEvent = errorEventPayload(error);
  if (errorEvent) {
    logDebugJsonPayload(logger, formatDiagnosticsPrefix("Codex error event payload.", contextFields), errorEvent);
  }

  const errorData = errorEventData(error);
  if (errorData) {
    logDebugTextPayload(logger, formatDiagnosticsPrefix("Codex error raw payload.", contextFields), errorData);
  }
}

/**
 * @param {import("../../data/Codex.js").CodexResponseCreateRequest} body
 * @returns {CodexRequestDiagnosticSummary}
 */
export function summarizeCodexRequestBodyForDiagnostics(body) {
  const input = Array.isArray(body.input) ? body.input : [];
  const tools = Array.isArray(body.tools) ? body.tools : undefined;
  return {
    requestKind: inferCodexRequestKind(input),
    inputItems: input.length,
    tools: tools?.length ?? 0,
    wireMode: body.previous_response_id ? "previous-response" : "full",
    inputDigest: codexDiagnosticDigest(input),
    toolsDigest: tools ? codexDiagnosticDigest(tools) : "absent",
    bodyDigest: codexDiagnosticDigest(body),
    inputShape: codexInputShapeSummary(input),
    toolsShape: codexToolsShapeSummary(tools)
  };
}

/**
 * @param {CodexInputSummary} summary
 * @param {import("../../data/Codex.js").CodexResponseInputItem} item
 */
function summarizeInputItem(summary, item) {
  if (item.type === "function_call") {
    summary.toolCalls += 1;
    return summary;
  }

  if (item.type === "function_call_output") {
    summary.toolOutputs += 1;
    return summary;
  }

  if (item.type === "reasoning") {
    summary.reasoningItems += 1;
    return summary;
  }

  if (!("role" in item) || !("content" in item) || !Array.isArray(item.content)) {
    return summary;
  }

  summary.messages += 1;
  if (item.role === "user") {
    summary.userMessages += 1;
  }
  if (item.role === "assistant") {
    summary.assistantMessages += 1;
  }

  for (const content of item.content) {
    switch (content.type) {
      case "input_text": {
        summary.inputTextParts += 1;
        break;
      }
      case "output_text": {
        summary.outputTextParts += 1;
        break;
      }
      case "input_image": {
        summary.imageParts += 1;
        break;
      }
      default:
    }
  }

  return summary;
}

/**
 * @param {import("../../data/Codex.js").CodexResponseInputItem[]} input
 * @returns {string}
 */
function codexInputShapeSummary(input) {
  if (input.length === 0) {
    return "empty";
  }

  return previewIndexes(input.length, 4)
    .map((index) => `${index}:${codexInputItemSignature(input[index])}`)
    .join("|");
}

/**
 * @param {import("../../data/Codex.js").CodexTool[] | undefined} tools
 * @returns {string}
 */
function codexToolsShapeSummary(tools) {
  if (!tools) {
    return "absent";
  }
  if (tools.length === 0) {
    return "empty";
  }

  const names = previewIndexes(tools.length, 5)
    .map((index) => `${index}:${codexToolSignature(tools[index])}`)
    .join("|");
  return `count=${tools.length};${names}`;
}

/**
 * @param {number} length
 * @param {number} edgeItems
 * @returns {number[]}
 */
function previewIndexes(length, edgeItems) {
  if (length <= edgeItems * 2) {
    return Array.from({ length }, (_value, index) => index);
  }

  return [
    ...Array.from({ length: edgeItems }, (_value, index) => index),
    ...Array.from({ length: edgeItems }, (_value, index) => length - edgeItems + index)
  ];
}

/**
 * @param {import("../../data/Codex.js").CodexResponseInputItem | undefined} item
 * @returns {string}
 */
function codexInputItemSignature(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return `scalar:${typeof item}`;
  }

  if (item.type === "function_call") {
    return [
      "function_call",
      diagnosticIdentifier(typeof item.name === "string" ? item.name : "unknown"),
      `call=${diagnosticStringDigest(typeof item.call_id === "string" ? item.call_id : "")}`,
      `args=${diagnosticStringStats(typeof item.arguments === "string" ? item.arguments : "")}`
    ].join(":");
  }

  if (item.type === "function_call_output") {
    return [
      "function_call_output",
      `call=${diagnosticStringDigest(typeof item.call_id === "string" ? item.call_id : "")}`,
      `output=${diagnosticStringStats(typeof item.output === "string" ? item.output : "")}`
    ].join(":");
  }

  if (item.type === "reasoning") {
    const encryptedContentState = diagnosticEncryptedContentState(item.encrypted_content);
    return [
      "reasoning",
      `id=${diagnosticStringDigest(typeof item.id === "string" ? item.id : "")}`,
      `summary=${Array.isArray(item.summary) ? item.summary.length : "absent"}`,
      `encrypted=${encryptedContentState}`
    ].join(":");
  }

  if ("role" in item && typeof item.role === "string" && "content" in item && Array.isArray(item.content)) {
    const content = item.content
      .slice(0, 4)
      .map((part) => codexContentItemSignature(part))
      .join("+");
    return [
      "message",
      diagnosticIdentifier(item.role),
      `content=${item.content.length}`,
      content || "empty"
    ].join(":");
  }

  return `object:${codexDiagnosticDigest(item)}`;
}

/**
 * @param {import("../../data/Codex.js").CodexContentItem | Record<string, import("../../data/Codex.js").CodexJsonValue>} item
 * @returns {string}
 */
function codexContentItemSignature(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return `scalar:${typeof item}`;
  }

  if (item.type === "input_text" || item.type === "output_text") {
    const text = typeof item.text === "string" ? item.text : "";
    return `${item.type}:${diagnosticTextKind(text)}:${diagnosticStringStats(text)}`;
  }
  if (item.type === "input_image") {
    return `input_image:${diagnosticStringDigest(typeof item.image_url === "string" ? item.image_url : "")}`;
  }

  return `${diagnosticIdentifier(typeof item.type === "string" ? item.type : "content")}:${codexDiagnosticDigest(item)}`;
}

/**
 * @param {import("../../data/Codex.js").CodexTool | undefined} tool
 * @returns {string}
 */
function codexToolSignature(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
    return `scalar:${typeof tool}`;
  }

  const name = "name" in tool && typeof tool.name === "string" ? tool.name : "unknown";
  return `${diagnosticIdentifier(name)}:${codexDiagnosticDigest(tool)}`;
}

/**
 * @param {import("../../data/Codex.js").CodexPreviousResponseDecision} decision
 * @param {string} prefix
 * @returns {string[]}
 */
function formatContinuationMismatchFields(decision, prefix) {
  const fields = [];
  if (decision.inputPrefixMatchingItems !== undefined) {
    fields.push(`${prefix}MatchingItems=${formatNumber(decision.inputPrefixMatchingItems)}`);
  }
  if (decision.inputPrefixMismatchIndex !== undefined) {
    fields.push(`${prefix}MismatchIndex=${formatNumber(decision.inputPrefixMismatchIndex)}`);
  }
  if (decision.inputPrefixExpected) {
    fields.push(`${prefix}Expected=${formatLogScalar(decision.inputPrefixExpected)}`);
  }
  if (decision.inputPrefixActual) {
    fields.push(`${prefix}Actual=${formatLogScalar(decision.inputPrefixActual)}`);
  }
  if (decision.inputPrefixExpectedDigest) {
    fields.push(`${prefix}ExpectedDigest=${formatLogScalar(decision.inputPrefixExpectedDigest)}`);
  }
  if (decision.inputPrefixActualDigest) {
    fields.push(`${prefix}ActualDigest=${formatLogScalar(decision.inputPrefixActualDigest)}`);
  }
  return fields;
}

/** @param {string} text */
function diagnosticTextKind(text) {
  if (/^\s*<conversation-summary>/iu.test(text)) {
    return "conversation-summary";
  }
  if (/conversation has grown too large for the context window and must be compacted now/iu.test(text)) {
    return "compaction-prompt";
  }
  return "text";
}

/** @param {import("../../data/Codex.js").CodexJsonValue | undefined} value */
function diagnosticEncryptedContentState(value) {
  if (typeof value === "string") {
    return "present";
  }
  if (value === null) {
    return "null";
  }
  return "absent";
}

/** @param {string} text */
function diagnosticStringStats(text) {
  return `${text.length}ch/${diagnosticStringDigest(text)}`;
}

/** @param {string} text */
function diagnosticStringDigest(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;
}

/** @param {string} value */
function diagnosticIdentifier(value) {
  const normalized = value.trim().replaceAll(/[^\w.-]+/gu, "_").replaceAll(/^_+|_+$/gu, "");
  const safe = normalized || "unknown";
  return safe.length > 80 ? `${safe.slice(0, 80)}...` : safe;
}

/**
 * @param {import("../../data/Codex.js").CodexResponseInputItem[]} input
 * @returns {'compaction' | 'conversation-summary' | 'normal'}
 */
function inferCodexRequestKind(input) {
  /** @type {string | undefined} */
  let firstText;
  for (const text of codexInputTextParts(input)) {
    firstText = firstText ?? text;
    if (/conversation has grown too large for the context window and must be compacted now/iu.test(text)) {
      return "compaction";
    }
  }

  if (firstText && /^\s*<conversation-summary>/iu.test(firstText)) {
    return "conversation-summary";
  }

  return "normal";
}

/**
 * @param {import("../../data/Codex.js").CodexResponseInputItem[]} input
 * @returns {string[]}
 */
function codexInputTextParts(input) {
  /** @type {string[]} */
  const texts = [];
  for (const item of input) {
    if (!("content" in item) || !Array.isArray(item.content)) {
      continue;
    }

    for (const content of item.content) {
      if (content.type === "input_text" && typeof content.text === "string") {
        texts.push(content.text);
      }
    }
  }

  return texts;
}

/**
 * @param {import("../../data/Codex.js").CodexResponseCreateRequest | import("../../data/Codex.js").CodexResponseInputItem[] | import("../../data/Codex.js").CodexTool[] | import("../../data/Codex.js").CodexJsonValue} value
 * @returns {string}
 */
function codexDiagnosticDigest(value) {
  return `sha256:${createHash("sha256").update(canonicalCodexJsonString(value)).digest("hex").slice(0, 16)}`;
}

const KNOWN_CODEX_STREAM_EVENT_TYPES = new Set([
  "codex.rate_limits",
  "error",
  "response.created",
  "response.in_progress",
  "response.output_item.added",
  "response.output_text.delta",
  "response.output_text.done",
  "response.reasoning_summary_text.delta",
  "response.reasoning_summary_text.done",
  "response.reasoning_summary_part.added",
  "response.reasoning_summary_part.done",
  "response.reasoning_text.delta",
  "response.reasoning_text.done",
  "response.content_part.added",
  "response.content_part.done",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.output_item.done"
]);

const KNOWN_CODEX_RESPONSE_KEYS = new Set([
  "id",
  "object",
  "created_at",
  "status",
  "background",
  "error",
  "completed_at",
  "incomplete_details",
  "frequency_penalty",
  "instructions",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "model",
  "output",
  "output_text",
  "parallel_tool_calls",
  "presence_penalty",
  "previous_response_id",
  "prompt_cache_key",
  "prompt_cache_retention",
  "reasoning",
  "safety_identifier",
  "service_tier",
  "store",
  "temperature",
  "text",
  "tool_choice",
  "tool_usage",
  "tools",
  "top_logprobs",
  "top_p",
  "truncation",
  "usage",
  "user"
]);

/**
 * @param {CocopiLogger} logger
 * @param {Record<string, import("../../data/Codex.js").CodexJsonValue>} response
 * @param {CodexRequestDiagnosticsContext} [context]
 */
function logCodexCompletedResponseDiagnostics(logger, response, context = {}) {
  const keys = sortedKeys(response);
  const unknownKeys = keys.filter((key) => !KNOWN_CODEX_RESPONSE_KEYS.has(key));
  const fields = [...formatDiagnosticsContextFields(context), `keys=${keys.join(",") || "none"}`];
  if (unknownKeys.length > 0) {
    fields.push(`unknownKeys=${unknownKeys.join(",")}`);
  }
  fields.push(`promptCacheKey=${formatLogScalar(response.prompt_cache_key)}`);
  if ("prompt_cache_retention" in response) {
    fields.push(`promptCacheRetention=${formatLogScalar(response.prompt_cache_retention)}`);
  }

  const usage = readCodexUsageSummary(response);
  if (usage) {
    fields.push(formatCodexUsageSummary(usage));
  } else {
    fields.push("usage=absent");
  }

  logger.debug(`Codex response completed. ${fields.join(" ")}`);
}

/** @param {Record<string, import("../../data/Codex.js").CodexJsonValue>} value */
export function readCodexUsageSummary(value) {
  if (!("usage" in value) || !value.usage || typeof value.usage !== "object" || Array.isArray(value.usage)) {
    return;
  }

  const usage = /** @type {Record<string, import("../../data/Codex.js").CodexJsonValue>} */ (value.usage);
  const inputTokens = readNumber(usage.input_tokens) ?? readNumber(usage.prompt_tokens);
  const outputTokens = readNumber(usage.output_tokens) ?? readNumber(usage.completion_tokens);
  const totalTokens = readNumber(usage.total_tokens);
  const reasoningTokens = readNestedNumber(usage, ["output_tokens_details", "reasoning_tokens"])
    ?? readNestedNumber(usage, ["completion_tokens_details", "reasoning_tokens"])
    ?? readNumber(usage.reasoning_tokens);
  const cachedTokens = readNestedNumber(usage, ["input_tokens_details", "cached_tokens"])
    ?? readNestedNumber(usage, ["prompt_tokens_details", "cached_tokens"])
    ?? readNumber(usage.cached_tokens);
  const usageKeys = sortedKeys(usage);
  const cacheFields = readNumericFieldsMatching(usage, /cache/iu);

  /** @type {CocopiCacheStatus} */
  const cacheStatus = formatCacheStatus(cachedTokens);
  const cacheHitRatio = typeof inputTokens === "number" && typeof cachedTokens === "number" && inputTokens > 0
    ? (cachedTokens / inputTokens) * 100
    : undefined;

  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    cachedTokens,
    cacheStatus,
    cacheHitRatio,
    usageKeys,
    cacheFields
  };
}

/** @param {CodexUsageSummary} usage */
function formatCodexUsageSummary(usage) {
  return [
    `usageKeys=${usage.usageKeys.join(",") || "none"}`,
    `inputTokens=${formatNumber(usage.inputTokens)}`,
    `outputTokens=${formatNumber(usage.outputTokens)}`,
    `reasoningTokens=${formatNumber(usage.reasoningTokens)}`,
    `totalTokens=${formatNumber(usage.totalTokens)}`,
    `cachedTokens=${formatNumber(usage.cachedTokens)}`,
    `cacheStatus=${usage.cacheStatus}`,
    `cacheHitRatio=${formatPercent(usage.cacheHitRatio)}`,
    `cacheFields=${usage.cacheFields.join(",") || "none"}`
  ].join(" ");
}

/**
 * @param {number | undefined} cachedTokens
 * @returns {CocopiCacheStatus}
 */
function formatCacheStatus(cachedTokens) {
  if (cachedTokens === undefined) {
    return "unknown";
  }

  return cachedTokens > 0 ? "hit" : "miss";
}

/**
 * @param {Record<string, import("../../data/Codex.js").CodexJsonValue>} value
 * @param {RegExp} keyPattern
 * @param {string} [prefix]
 * @returns {string[]}
 */
function readNumericFieldsMatching(value, keyPattern, prefix = "") {
  /** @type {string[]} */
  const fields = [];
  for (const key of sortedKeys(value)) {
    const field = value[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof field === "number" && Number.isFinite(field) && keyPattern.test(path)) {
      fields.push(`${path}=${field}`);
      continue;
    }

    if (field && typeof field === "object" && !Array.isArray(field)) {
      fields.push(...readNumericFieldsMatching(/** @type {Record<string, import("../../data/Codex.js").CodexJsonValue>} */ (field), keyPattern, path));
    }
  }

  return fields;
}

/**
 * @param {Record<string, import("../../data/Codex.js").CodexJsonValue>} value
 * @param {string[]} path
 */
function readNestedNumber(value, path) {
  /** @type {import("../../data/Codex.js").CodexJsonValue | undefined} */
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !(key in current)) {
      return;
    }
    current = /** @type {Record<string, import("../../data/Codex.js").CodexJsonValue>} */ (current)[key];
  }

  return readNumber(current);
}

/** @param {import("../../data/Codex.js").CodexJsonValue | undefined} value */
function readNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** @param {number | undefined} value */
function formatNumber(value) {
  return value === undefined ? "unknown" : String(value);
}

/** @param {number | undefined} value */
function formatMebibytes(value) {
  return value === undefined ? "unknown" : (value / 1_048_576).toFixed(1);
}

/**
 * @param {string} name
 * @param {number | undefined} value
 */
function formatMemoryByteFields(name, value) {
  return [`${name}Bytes=${formatNumber(value)}`, `${name}MiB=${formatMebibytes(value)}`];
}

/** @param {number | undefined} value */
function formatPercent(value) {
  return value === undefined ? "unknown" : `${Number.isFinite(value) ? value.toFixed(1) : "unknown"}`;
}

/**
 * @param {CocopiMemoryDiagnosticsContext} context
 * @returns {string[]}
 */
function formatMemoryDiagnosticsContextFields(context) {
  const fields = formatDiagnosticsContextFields(context);
  if (context.model) {
    fields.push(`model=${formatLogScalar(context.model)}`);
  }
  if (context.inputItems !== undefined) {
    fields.push(`inputItems=${formatNumber(context.inputItems)}`);
  }
  if (context.messages !== undefined) {
    fields.push(`messages=${formatNumber(context.messages)}`);
  }
  if (context.textParts !== undefined) {
    fields.push(`textParts=${formatNumber(context.textParts)}`);
  }
  if (context.toolCallParts !== undefined) {
    fields.push(`toolCallParts=${formatNumber(context.toolCallParts)}`);
  }
  if (context.toolResultParts !== undefined) {
    fields.push(`toolResultParts=${formatNumber(context.toolResultParts)}`);
  }
  if (context.dataParts !== undefined) {
    fields.push(`dataParts=${formatNumber(context.dataParts)}`);
  }
  if (context.cocopiDataParts !== undefined) {
    fields.push(`cocopiDataParts=${formatNumber(context.cocopiDataParts)}`);
  }
  if (context.cocopiDataBytes !== undefined) {
    fields.push(`cocopiDataBytes=${formatNumber(context.cocopiDataBytes)}`);
  }
  if (context.continuationAnchors !== undefined) {
    fields.push(`continuationAnchors=${formatNumber(context.continuationAnchors)}`);
  }
  if (context.continuationAnchorInputItems !== undefined) {
    fields.push(`continuationAnchorInputItems=${formatNumber(context.continuationAnchorInputItems)}`);
  }
  if (context.continuationAnchorResponseItems !== undefined) {
    fields.push(`continuationAnchorResponseItems=${formatNumber(context.continuationAnchorResponseItems)}`);
  }
  if (context.tools !== undefined) {
    fields.push(`tools=${formatNumber(context.tools)}`);
  }
  if (context.toolCalls !== undefined) {
    fields.push(`toolCalls=${formatNumber(context.toolCalls)}`);
  }
  if (context.reasoningItems !== undefined) {
    fields.push(`reasoningItems=${formatNumber(context.reasoningItems)}`);
  }
  if (context.stateRestored !== undefined) {
    fields.push(`stateRestored=${context.stateRestored}`);
  }

  return fields;
}

/**
 * @param {CodexRequestDiagnosticsContext} context
 * @returns {string[]}
 */
function formatDiagnosticsContextFields(context) {
  const fields = [];
  if (context.source) {
    fields.push(`source=${formatLogScalar(context.source)}`);
  }
  if (context.hostRequestIndex !== undefined) {
    fields.push(`hostRequest=${formatNumber(context.hostRequestIndex)}`);
  }
  if (context.sessionId) {
    fields.push(`sessionId=${formatLogScalar(context.sessionId)}`);
  }
  if (context.stage) {
    fields.push(`stage=${formatLogScalar(context.stage)}`);
  }
  return fields;
}

/**
 * @param {string} prefix
 * @param {string[]} contextFields
 */
function formatDiagnosticsPrefix(prefix, contextFields) {
  return contextFields.length === 0 ? prefix : `${prefix} ${contextFields.join(" ")}`;
}

/** @param {import("../../data/Codex.js").CodexJsonValue | undefined} value */
function formatLogScalar(value) {
  switch (typeof value) {
    case "string": {
      return value ? value.replaceAll(/\s+/gu, "_") : "empty";
    }
    case "number":
    case "boolean": {
      return String(value);
    }
    default: {
      return value === null ? "null" : "absent";
    }
  }
}

/**
 * @param {Record<string, import("../../data/Codex.js").CodexJsonValue>} value
 * @returns {string[]}
 */
function sortedKeys(value) {
  // eslint-disable-next-line unicorn/no-array-sort -- The project target does not include Array#toSorted.
  return Object.keys(value).sort();
}

/**
 * @param {string} text
 */
export function redactCocopiLogText(text) {
  return text
    .replaceAll(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gu, "Bearer [redacted]")
    .replaceAll(/sk-[A-Za-z0-9_-]+/gu, "sk-[redacted]")
    .replaceAll(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "jwt-[redacted]")
    .replaceAll(/\b((?:access_?|refresh_?|id_)?token=)[^\s&]+/giu, "$1[redacted]")
    .replaceAll(/([?&][^=&#]*(?:authorization|token|secret|credential|api[-_]?key|cookie|session)[^=&#]*=)[^&#\s]+/giu, "$1[redacted]")
    .replaceAll(/("(?:access|refresh|id)?_?token"\s*:\s*")[^"]+(")/giu, "$1[redacted]$2")
    .replaceAll(/("(?:authorization|secret|credential|api[-_]?key|cookie|session)"\s*:\s*")[^"]+(")/giu, "$1[redacted]$2");
}

/**
 * @param {Error | string | object | null | undefined} error
 */
function formatErrorForLog(error) {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }

  return String(error);
}

/**
 * @param {'info' | 'debug' | 'error'} level
 * @param {string} message
 */
function formatLogLine(level, message) {
  return redactCocopiLogText(`[${new Date().toISOString()}] ${level}: ${message}`);
}

/**
 * @param {CocopiLogger} logger
 * @param {string} prefix
 * @param {import("../../data/Codex.js").CodexJsonValue | Record<string, import("../../data/Codex.js").CodexJsonValue> | import("../../data/Codex.js").CodexResponseCreateRequest} value
 * @param {{ maxChars?: number, omissionReason?: string }} [options]
 */
function logDebugJsonPayload(logger, prefix, value, options = {}) {
  const json = stringifyDebugJson(value);
  const sidecarMaxChars = options.maxChars ?? COCOPI_DEBUG_PAYLOAD_SIDECAR_MAX_CHARS;
  if (json.length > sidecarMaxChars) {
    const reason = options.omissionReason ?? "payload-size-limit";
    const digest = diagnosticStringDigest(json);
    const payloadResult = writeCocopiPayloadSidecar(logger, {
      prefix,
      json,
      chars: json.length,
      digest,
      reason
    });
    if (payloadResult) {
      logger.debug(`${prefix} payloadFile=${JSON.stringify(payloadResult.path)} payloadStored=true chars=${json.length} maxChars=${sidecarMaxChars} bytes=${payloadResult.bytes} digest=${digest} reason=${reason}`);
      return;
    }

    logger.debug(`${prefix} payloadFile=unavailable payloadStored=false chars=${json.length} maxChars=${sidecarMaxChars} digest=${digest} reason=${reason}`);
    return;
  }

  if (json.length <= COCOPI_DEBUG_PAYLOAD_CHUNK_CHARS) {
    logger.debug(`${prefix} ${json}`);
    return;
  }

  const chunks = Math.ceil(json.length / COCOPI_DEBUG_PAYLOAD_CHUNK_CHARS);
  logger.debug(`${prefix} chunks=${chunks} chars=${json.length}`);
  for (let index = 0; index < chunks; index += 1) {
    const start = index * COCOPI_DEBUG_PAYLOAD_CHUNK_CHARS;
    const chunk = json.slice(start, start + COCOPI_DEBUG_PAYLOAD_CHUNK_CHARS);
    logger.debug(`${prefix} chunk=${index + 1}/${chunks} ${chunk}`);
  }
}

/**
 * @param {CocopiLogger} logger
 * @param {CocopiPayloadLogEntry} entry
 * @returns {CocopiPayloadLogResult | undefined}
 */
function writeCocopiPayloadSidecar(logger, entry) {
  if (!logger.payload) {
    return;
  }

  try {
    return logger.payload(entry);
  } catch (error) {
    logger.error(`${entry.prefix} payload file write failed. reason=${formatLogScalar(entry.reason)}`, error instanceof Error ? error : String(error));
    return;
  }
}

/**
 * @param {CocopiLogger} logger
 * @param {string} prefix
 * @param {string} value
 */
function logDebugTextPayload(logger, prefix, value) {
  const sidecarMaxChars = COCOPI_DEBUG_PAYLOAD_SIDECAR_MAX_CHARS;
  if (value.length > sidecarMaxChars) {
    const reason = "raw-payload-size-limit";
    const digest = diagnosticStringDigest(value);
    const payloadResult = writeCocopiPayloadSidecar(logger, {
      prefix,
      json: JSON.stringify(value),
      chars: value.length,
      digest,
      reason
    });
    if (payloadResult) {
      logger.debug(`${prefix} payloadFile=${JSON.stringify(payloadResult.path)} payloadStored=true chars=${value.length} maxChars=${sidecarMaxChars} bytes=${payloadResult.bytes} digest=${digest} reason=${reason}`);
      return;
    }

    logger.debug(`${prefix} payloadFile=unavailable payloadStored=false chars=${value.length} maxChars=${sidecarMaxChars} digest=${digest} reason=${reason}`);
    return;
  }

  if (value.length <= COCOPI_DEBUG_PAYLOAD_CHUNK_CHARS) {
    logger.debug(`${prefix} ${value}`);
    return;
  }

  const chunks = Math.ceil(value.length / COCOPI_DEBUG_PAYLOAD_CHUNK_CHARS);
  logger.debug(`${prefix} chunks=${chunks} chars=${value.length}`);
  for (let index = 0; index < chunks; index += 1) {
    const start = index * COCOPI_DEBUG_PAYLOAD_CHUNK_CHARS;
    const chunk = value.slice(start, start + COCOPI_DEBUG_PAYLOAD_CHUNK_CHARS);
    logger.debug(`${prefix} chunk=${index + 1}/${chunks} ${chunk}`);
  }
}

/** @param {import("../../data/Codex.js").CodexJsonValue | Record<string, import("../../data/Codex.js").CodexJsonValue> | import("../../data/Codex.js").CodexResponseCreateRequest} value */
function stringifyDebugJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

/** @param {Error | string | object | null | undefined} error */
function errorEventPayload(error) {
  if (!error || typeof error !== "object") {
    return;
  }

  const event = Reflect.get(error, "event");
  if (event && typeof event === "object" && !Array.isArray(event)) {
    return /** @type {Record<string, import("../../data/Codex.js").CodexJsonValue>} */ (event);
  }

  const cause = Reflect.get(error, "cause");
  return errorEventPayload(/** @type {Error | string | object | null | undefined} */ (cause));
}

/** @param {Error | string | object | null | undefined} error */
function errorEventData(error) {
  if (!error || typeof error !== "object") {
    return;
  }

  const eventData = Reflect.get(error, "eventData") ?? Reflect.get(error, "data");
  if (typeof eventData === "string" && eventData) {
    return eventData;
  }

  const cause = Reflect.get(error, "cause");
  return errorEventData(/** @type {Error | string | object | null | undefined} */ (cause));
}
