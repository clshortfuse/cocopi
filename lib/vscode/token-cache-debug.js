const MAX_COCOPI_TOKEN_CACHE_DEBUG_ENTRIES = 5000;
const MAX_COCOPI_RATE_LIMIT_SNAPSHOTS = 1000;
const MAX_COCOPI_REMOTE_USAGE_ANALYTICS_SNAPSHOTS = 20;
const LOCAL_USAGE_WINDOW_HOURS = 5;
const COCOPI_USAGE_ANALYTICS_WINDOW_HOURS = [1, 5, 24, 24 * 7];
const DEFAULT_COCOPI_USAGE_TIMELINE_WINDOW_DAYS = 7;
const COCOPI_WEEKLY_CYCLE_FALLBACK_WINDOW_MINUTES = 60 * 24 * 7;
const COCOPI_USAGE_TIMELINE_BUCKET_MINUTES = 60;
const MAX_COCOPI_USAGE_TIMELINE_SERIES = 6;
const COCOPI_TOKEN_CACHE_DEBUG_STORAGE_KEY = "cocopi.diagnostics.tokenTracker.v1";
const COCOPI_RATE_LIMIT_STORAGE_KEY = "cocopi.diagnostics.rateLimits.v1";
const COCOPI_REMOTE_USAGE_ANALYTICS_STORAGE_KEY = "cocopi.diagnostics.remoteUsageAnalytics.v1";
const CACHE_RISK_MEDIUM_UNCACHED_INPUT_TOKENS = 10_000;
const CACHE_RISK_HIGH_UNCACHED_INPUT_TOKENS = 50_000;

/** @typedef {'chat' | 'language-model'} CocopiTokenCacheDebugSource */
/** @typedef {'normal-turn' | 'normal-continuation' | 'tool-continuation' | 'summary-generation' | 'summary-replay' | 'summary-replay-cold-baseline' | 'summary-replay-continuation' | 'summary-replay-rebaseline'} CocopiTokenCacheTurnKind */
/** @typedef {'low' | 'medium' | 'high' | 'unknown'} CocopiTokenCacheRisk */

/**
 * @typedef {object} CocopiTokenCacheDebugSummary
 * @property {number} id
 * @property {string} recordedAt
 * @property {CocopiTokenCacheDebugSource} source
 * @property {number} hostRequestIndex
 * @property {number | undefined} [lastHostRequestIndex]
 * @property {number | undefined} [mergedRequestCount]
 * @property {string} sessionId
 * @property {string | undefined} [conversationSummary]
 * @property {string | undefined} [conversationDescription]
 * @property {string} model
 * @property {string | undefined} [selectedModel]
 * @property {number} inputItems
 * @property {boolean | undefined} [stateRestored]
 * @property {number | undefined} [requestMessages]
 * @property {number | undefined} [requestTextParts]
 * @property {number | undefined} [requestToolCallParts]
 * @property {number | undefined} [requestToolResultParts]
 * @property {number | undefined} [requestDataParts]
 * @property {number | undefined} [requestCocopiDataParts]
 * @property {number | undefined} [requestCocopiDataBytes]
 * @property {string | undefined} [requestDataMimeTypes]
 * @property {string | undefined} [transport]
 * @property {string | undefined} [serviceTier]
 * @property {string | undefined} [serviceTierSource]
 * @property {string | undefined} [reasoningEffort]
 * @property {string | undefined} [reasoningSummary]
 * @property {boolean | undefined} [fastRequested]
 * @property {boolean | undefined} [automaticContinuation]
 * @property {string | undefined} promptCacheKey
 * @property {string | undefined} [requestKind]
 * @property {string | undefined} [requestInputDigest]
 * @property {string | undefined} [requestToolsDigest]
 * @property {string | undefined} [requestBodyDigest]
 * @property {string | undefined} [wireMode]
 * @property {number | undefined} [wireInputItems]
 * @property {string | undefined} [wireInputDigest]
 * @property {string | undefined} [wireToolsDigest]
 * @property {string | undefined} [wireBodyDigest]
 * @property {import("../../data/Codex.js").CodexPreviousResponseDecisionAction | undefined} [webSocketContinuationAction]
 * @property {import("../../data/Codex.js").CodexPreviousResponseDecisionReason | undefined} [webSocketContinuationReason]
 * @property {string | undefined} [webSocketContinuationStateChanges]
 * @property {number | undefined} [webSocketContinuationMatchingItems]
 * @property {number | undefined} [webSocketContinuationMismatchIndex]
 * @property {string | undefined} [webSocketContinuationExpected]
 * @property {string | undefined} [webSocketContinuationActual]
 * @property {string | undefined} [webSocketContinuationExpectedDigest]
 * @property {string | undefined} [webSocketContinuationActualDigest]
 * @property {CocopiTokenCacheTurnKind | undefined} [turnKind]
 * @property {CocopiTokenCacheRisk | undefined} [cacheRisk]
 * @property {number | undefined} [uncachedInputTokens]
 * @property {string | undefined} [requestStartedAt]
 * @property {string | undefined} [requestCompletedAt]
 * @property {number | undefined} [requestDurationMs]
 * @property {number | undefined} [firstEventLatencyMs]
 * @property {number | undefined} [firstOutputLatencyMs]
 * @property {number | undefined} [outputTokensPerSecond]
 * @property {string | undefined} responseId
 * @property {number | undefined} inputTokens
 * @property {number | undefined} outputTokens
 * @property {number | undefined} reasoningTokens
 * @property {number | undefined} totalTokens
 * @property {number | undefined} cachedTokens
 * @property {'hit' | 'miss' | 'unknown'} cacheStatus
 * @property {number | undefined} cacheHitRatio
 * @property {number | undefined} [sessionInitialTokens]
 * @property {number | undefined} [sessionCumulativeTokens]
 * @property {number | undefined} [billedInputTokens]
 * @property {number | undefined} [billedOutputTokens]
 * @property {number | undefined} [billedTotalTokens]
 */

/**
 * @typedef {object} CocopiUsageWindowStatus
 * @property {string} windowStart
 * @property {string} windowEnd
 * @property {number} windowHours
 * @property {number} requestCount
 * @property {number} billableTokens
 * @property {number} averageTokensPerHour
 * @property {number} projectedWindowTokens
 * @property {'api' | 'local'} source
 * @property {CocopiRateLimitSnapshot[]} apiRateLimits
 * @property {string | undefined} [apiCapturedAt]
 */

/**
 * @typedef {object} CocopiUsageAnalyticsWindow
 * @property {string} label
 * @property {number} windowHours
 * @property {string} windowStart
 * @property {string} windowEnd
 * @property {number} requestCount
 * @property {number} billableTokens
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cachedTokens
 * @property {number} uncachedInputTokens
 * @property {number} tokensPerMinute
 * @property {number} requestsPerMinute
 * @property {number | undefined} averageLatencyMs
 * @property {number | undefined} averageFirstEventLatencyMs
 * @property {number | undefined} averageFirstOutputLatencyMs
 * @property {number | undefined} outputTokensPerSecond
 */

/**
 * @typedef {object} CocopiUsageTimelineBucket
 * @property {string} bucketStart
 * @property {string} bucketEnd
 * @property {number} requestCount
 * @property {number} billableTokens
 * @property {number} uncachedInputTokens
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cachedTokens
 * @property {number | undefined} averageLatencyMs
 * @property {number | undefined} averageFirstOutputLatencyMs
 * @property {number | undefined} outputTokensPerSecond
 */

/**
 * @typedef {object} CocopiUsageTimelineSeries
 * @property {string} key
 * @property {string} label
 * @property {string} model
 * @property {string} reasoningEffort
 * @property {number} requestCount
 * @property {number} billableTokens
 * @property {CocopiUsageTimelineBucket[]} buckets
 */

/**
 * @typedef {object} CocopiUsageTimeline
 * @property {string} label
 * @property {string} windowStart
 * @property {string} windowEnd
 * @property {number} windowHours
 * @property {number} bucketMinutes
 * @property {CocopiUsageTimelineBucket[]} buckets
 * @property {CocopiUsageTimelineSeries[]} series
 */

/**
 * @typedef {object} CocopiWeeklyCycleModelUsage
 * @property {string} label
 * @property {string} model
 * @property {string} reasoningEffort
 * @property {number} requestCount
 * @property {number} inputTokens
 * @property {number} cachedInputTokens
 * @property {number} uncachedInputTokens
 * @property {number} outputTokens
 * @property {number} apiMeteredTokens
 */

/**
 * @typedef {object} CocopiWeeklyCycleUsage
 * @property {'rate-limit-reset' | 'rate-limit-window' | 'rolling-7d'} source
 * @property {string} sourceLabel
 * @property {string} cycleStart
 * @property {string} cycleEnd
 * @property {number} windowHours
 * @property {number} elapsedHours
 * @property {number | undefined} [remainingHours]
 * @property {number} requestCount
 * @property {number} usageKnownRequestCount
 * @property {number} unknownUsageRequestCount
 * @property {number} inputTokens
 * @property {number} cachedInputTokens
 * @property {number} uncachedInputTokens
 * @property {number} outputTokens
 * @property {number} reasoningTokens
 * @property {number} totalTokens
 * @property {number} apiMeteredTokens
 * @property {number} outputTokensPerDay
 * @property {number} uncachedInputTokensPerDay
 * @property {number} apiMeteredTokensPerDay
 * @property {number | undefined} [projectedOutputTokens]
 * @property {number | undefined} [projectedUncachedInputTokens]
 * @property {number | undefined} [projectedApiMeteredTokens]
 * @property {string | undefined} [limitId]
 * @property {string | undefined} [limitName]
 * @property {string | undefined} [rateLimitCapturedAt]
 * @property {CocopiWeeklyCycleModelUsage[]} models
 */

/**
 * @typedef {object} CocopiRateLimitTrend
 * @property {string} limitId
 * @property {string} label
 * @property {string} windowLabel
 * @property {number} samples
 * @property {string} startCapturedAt
 * @property {string} endCapturedAt
 * @property {number} startUsedPercent
 * @property {number} endUsedPercent
 * @property {number} deltaUsedPercent
 * @property {number} deltaUsedPercentPerHour
 */

/**
 * @typedef {object} CocopiSessionUsageSummary
 * @property {string} agent
 * @property {CocopiTokenCacheDebugSource} source
 * @property {string} sessionId
 * @property {string | undefined} [conversationSummary]
 * @property {string | undefined} [conversationDescription]
 * @property {string} firstRecordedAt
 * @property {string} lastRecordedAt
 * @property {number} requestCount
 * @property {number} billableTokens
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} uncachedInputTokens
 * @property {number | undefined} [averageLatencyMs]
 * @property {number | undefined} [averageFirstOutputLatencyMs]
 * @property {number | undefined} [outputTokensPerSecond]
 */

/**
 * @typedef {object} CocopiUsageAnalytics
 * @property {string} capturedAt
 * @property {CocopiUsageAnalyticsWindow[]} windows
 * @property {CocopiWeeklyCycleUsage} weeklyCycle
 * @property {CocopiUsageTimeline} timeline
 * @property {CocopiRateLimitTrend[]} rateLimitTrends
 * @property {CocopiSessionUsageSummary[]} sessions
 * @property {CocopiRemoteUsageAnalyticsSnapshot | undefined} [remoteUsageAnalytics]
 * @property {number} retainedRequestRows
 * @property {number} retainedRateLimitSnapshots
 */

/**
 * @typedef {import("../codex-api/rate-limits.js").CodexUsageAnalyticsSnapshot & {
 *   capturedAt: string
 * }} CocopiRemoteUsageAnalyticsSnapshot
 */

/**
 * @typedef {import("../codex-api/rate-limits.js").CodexRateLimitWindow} CocopiRateLimitWindow
 * @typedef {import("../codex-api/rate-limits.js").CodexCreditsSnapshot} CocopiCreditsSnapshot
 */

/**
 * @typedef {import("../codex-api/rate-limits.js").CodexRateLimitSnapshot & {
 *   capturedAt: string
 * }} CocopiRateLimitSnapshot
 */

/** @type {CocopiTokenCacheDebugSummary[]} */
const cocopiTokenCacheDebugHistory = [];

/** @type {CocopiRateLimitSnapshot[]} */
const cocopiRateLimitSnapshots = [];

/** @type {CocopiRemoteUsageAnalyticsSnapshot[]} */
const cocopiRemoteUsageAnalyticsSnapshots = [];

/** @type {number} */
let nextCocopiTokenCacheDebugId = 1;

/** @type {EventTarget} */
const cocopiTokenCacheDebugSummaryTarget = new EventTarget();

/** @type {EventTarget} */
const cocopiTokenCacheDebugChangeTarget = new EventTarget();

/** @type {import("./secret-storage.js").SecretStorageLike | undefined} */
let cocopiTokenCacheDebugStorage;

/** @type {Promise<void>} */
let cocopiTokenCacheDebugStorageLoad = Promise.resolve();

/**
 * @typedef {object} CocopiTokenCacheDebugChangeEvent
 * @property {'record' | 'update' | 'delete' | 'delete-session' | 'delete-sessions' | 'clear'} type
 * @property {CocopiTokenCacheDebugSummary} [entry]
 * @property {number} [id]
 * @property {string} [sessionId]
 * @property {string[]} [sessionIds]
 */

/**
 * @param {import("./secret-storage.js").SecretStorageLike} secrets
 * @returns {Promise<void>}
 */
export function initializeCocopiTokenCacheDebugStorage(secrets) {
  cocopiTokenCacheDebugStorage = secrets;
  cocopiTokenCacheDebugStorageLoad = loadCocopiTokenCacheDebugSummariesFromStorage(secrets);
  return cocopiTokenCacheDebugStorageLoad;
}

/** @returns {Promise<void>} */
export function waitForCocopiTokenCacheDebugStorage() {
  return cocopiTokenCacheDebugStorageLoad;
}

/** @param {(summary: CocopiTokenCacheDebugSummary) => void} listener */
export function onCocopiTokenCacheDebugSummary(listener) {
  /** @type {(event: Event) => void} */
  const handler = (event) => {
    if (event instanceof CustomEvent) {
      listener(/** @type {CocopiTokenCacheDebugSummary} */ (event.detail));
    }
  };

  cocopiTokenCacheDebugSummaryTarget.addEventListener("summary", handler);
  return () => {
    cocopiTokenCacheDebugSummaryTarget.removeEventListener("summary", handler);
  };
}

/** @param {(event: CocopiTokenCacheDebugChangeEvent) => void} listener */
export function onCocopiTokenCacheDebugChange(listener) {
  /** @type {(event: Event) => void} */
  const handler = (event) => {
    if (event instanceof CustomEvent) {
      listener(/** @type {CocopiTokenCacheDebugChangeEvent} */ (event.detail));
    }
  };

  cocopiTokenCacheDebugChangeTarget.addEventListener("change", handler);
  return () => {
    cocopiTokenCacheDebugChangeTarget.removeEventListener("change", handler);
  };
}

/** @param {Omit<CocopiTokenCacheDebugSummary, "id" | "recordedAt">} summary */
export function recordCocopiTokenCacheSummary(summary) {
  const previous = latestSummaryForSession(summary.sessionId);
  const billedTokens = billableTokenSummary(summary);
  const derived = deriveCocopiTokenCacheDiagnostics(summary);
  const timing = timingSummary(summary);
  const billedTotalTokens = billedTokens.billedTotalTokens;
  const hasUsageTokens = billedTotalTokens !== undefined;
  const sessionInitialTokens = summary.sessionInitialTokens
    ?? previous?.sessionInitialTokens
    ?? billedTotalTokens;
  const sessionCumulativeTokens = summary.sessionCumulativeTokens
    ?? (hasUsageTokens
      ? (previous?.sessionCumulativeTokens ?? 0) + billedTotalTokens
      : previous?.sessionCumulativeTokens);

  const entry = {
    id: nextCocopiTokenCacheDebugId++,
    recordedAt: new Date().toISOString(),
    source: summary.source,
    hostRequestIndex: summary.hostRequestIndex,
    lastHostRequestIndex: summary.lastHostRequestIndex,
    mergedRequestCount: summary.mergedRequestCount,
    sessionId: summary.sessionId,
    conversationSummary: summary.conversationSummary,
    conversationDescription: summary.conversationDescription,
    model: summary.model,
    selectedModel: summary.selectedModel,
    inputItems: summary.inputItems,
    stateRestored: summary.stateRestored,
    requestMessages: summary.requestMessages,
    requestTextParts: summary.requestTextParts,
    requestToolCallParts: summary.requestToolCallParts,
    requestToolResultParts: summary.requestToolResultParts,
    requestDataParts: summary.requestDataParts,
    requestCocopiDataParts: summary.requestCocopiDataParts,
    requestCocopiDataBytes: summary.requestCocopiDataBytes,
    requestDataMimeTypes: summary.requestDataMimeTypes,
    transport: summary.transport,
    serviceTier: summary.serviceTier,
    serviceTierSource: summary.serviceTierSource,
    reasoningEffort: summary.reasoningEffort,
    reasoningSummary: summary.reasoningSummary,
    fastRequested: summary.fastRequested,
    automaticContinuation: summary.automaticContinuation,
    promptCacheKey: summary.promptCacheKey,
    requestKind: summary.requestKind,
    requestInputDigest: summary.requestInputDigest,
    requestToolsDigest: summary.requestToolsDigest,
    requestBodyDigest: summary.requestBodyDigest,
    wireMode: summary.wireMode,
    wireInputItems: summary.wireInputItems,
    wireInputDigest: summary.wireInputDigest,
    wireToolsDigest: summary.wireToolsDigest,
    wireBodyDigest: summary.wireBodyDigest,
    webSocketContinuationAction: summary.webSocketContinuationAction,
    webSocketContinuationReason: summary.webSocketContinuationReason,
    webSocketContinuationStateChanges: summary.webSocketContinuationStateChanges,
    webSocketContinuationMatchingItems: summary.webSocketContinuationMatchingItems,
    webSocketContinuationMismatchIndex: summary.webSocketContinuationMismatchIndex,
    webSocketContinuationExpected: summary.webSocketContinuationExpected,
    webSocketContinuationActual: summary.webSocketContinuationActual,
    webSocketContinuationExpectedDigest: summary.webSocketContinuationExpectedDigest,
    webSocketContinuationActualDigest: summary.webSocketContinuationActualDigest,
    turnKind: derived.turnKind,
    cacheRisk: derived.cacheRisk,
    uncachedInputTokens: derived.uncachedInputTokens,
    requestStartedAt: summary.requestStartedAt,
    requestCompletedAt: summary.requestCompletedAt,
    requestDurationMs: timing.requestDurationMs,
    firstEventLatencyMs: summary.firstEventLatencyMs,
    firstOutputLatencyMs: summary.firstOutputLatencyMs,
    outputTokensPerSecond: timing.outputTokensPerSecond,
    responseId: summary.responseId,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    reasoningTokens: summary.reasoningTokens,
    totalTokens: summary.totalTokens,
    cachedTokens: summary.cachedTokens,
    billedInputTokens: billedTokens.billedInputTokens,
    billedOutputTokens: billedTokens.billedOutputTokens,
    billedTotalTokens: billedTokens.billedTotalTokens,
    cacheStatus: summary.cacheStatus,
    cacheHitRatio: summary.cacheHitRatio,
    sessionInitialTokens,
    sessionCumulativeTokens
  };

  cocopiTokenCacheDebugHistory.unshift(entry);

  if (cocopiTokenCacheDebugHistory.length > MAX_COCOPI_TOKEN_CACHE_DEBUG_ENTRIES) {
    cocopiTokenCacheDebugHistory.length = MAX_COCOPI_TOKEN_CACHE_DEBUG_ENTRIES;
  }

  persistCocopiTokenCacheDebugSummaries();
  cocopiTokenCacheDebugSummaryTarget.dispatchEvent(new CustomEvent("summary", { detail: cloneCocopiTokenCacheDebugSummary(entry) }));
  dispatchCocopiTokenCacheDebugChange({ type: "record", entry: cloneCocopiTokenCacheDebugSummary(entry) });
}

/**
 * @param {Partial<CocopiTokenCacheDebugSummary>} summary
 * @returns {{ turnKind: CocopiTokenCacheTurnKind, cacheRisk: CocopiTokenCacheRisk, uncachedInputTokens: number | undefined }}
 */
export function deriveCocopiTokenCacheDiagnostics(summary) {
  const uncachedInputTokens = summary.uncachedInputTokens ?? uncachedInputTokenCount(summary);
  return {
    turnKind: normalizeTokenCacheTurnKind(summary.turnKind) ?? classifyTokenCacheTurnKind(summary),
    cacheRisk: normalizeTokenCacheRisk(summary.cacheRisk) ?? classifyTokenCacheRisk(summary, uncachedInputTokens),
    uncachedInputTokens
  };
}

/**
 * @param {import("../codex-api/rate-limits.js").CodexRateLimitSnapshot | import("../codex-api/rate-limits.js").CodexRateLimitSnapshot[]} snapshots
 * @param {{ capturedAt?: Date }} [options]
 */
export function recordCocopiRateLimitSnapshots(snapshots, options = {}) {
  const capturedAt = (options.capturedAt ?? new Date()).toISOString();
  const list = Array.isArray(snapshots) ? snapshots : [snapshots];
  for (const snapshot of list) {
    const entry = sanitizeRateLimitSnapshot({ ...snapshot, capturedAt });
    if (!entry) {
      continue;
    }

    const index = cocopiRateLimitSnapshots.findIndex((existing) => existing.limitId === entry.limitId && existing.capturedAt === entry.capturedAt);
    if (index === -1) {
      cocopiRateLimitSnapshots.unshift(entry);
    } else {
      cocopiRateLimitSnapshots.splice(index, 1, entry);
    }
  }

  cocopiRateLimitSnapshots.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));

  if (cocopiRateLimitSnapshots.length > MAX_COCOPI_RATE_LIMIT_SNAPSHOTS) {
    cocopiRateLimitSnapshots.length = MAX_COCOPI_RATE_LIMIT_SNAPSHOTS;
  }

  persistCocopiRateLimitSnapshots();
}

/**
 * @param {import("../codex-api/rate-limits.js").CodexUsageAnalyticsSnapshot} snapshot
 * @param {{ capturedAt?: Date }} [options]
 */
export function recordCocopiRemoteUsageAnalytics(snapshot, options = {}) {
  const entry = sanitizeRemoteUsageAnalyticsSnapshot({
    ...snapshot,
    capturedAt: (options.capturedAt ?? new Date()).toISOString()
  });
  if (!entry) {
    return;
  }

  cocopiRemoteUsageAnalyticsSnapshots.unshift(entry);
  if (cocopiRemoteUsageAnalyticsSnapshots.length > MAX_COCOPI_REMOTE_USAGE_ANALYTICS_SNAPSHOTS) {
    cocopiRemoteUsageAnalyticsSnapshots.length = MAX_COCOPI_REMOTE_USAGE_ANALYTICS_SNAPSHOTS;
  }
  persistCocopiRemoteUsageAnalyticsSnapshots();
}

/**
 * @param {string} sessionId
 * @returns {CocopiTokenCacheDebugSummary | undefined}
 */
function latestSummaryForSession(sessionId) {
  for (const entry of cocopiTokenCacheDebugHistory) {
    if (entry.sessionId === sessionId) {
      return entry;
    }
  }

  return;
}

/** @returns {CocopiTokenCacheDebugSummary[]} */
export function readCocopiTokenCacheDebugSummaries() {
  return cocopiTokenCacheDebugHistory.map((entry) => cloneCocopiTokenCacheDebugSummary(entry));
}

/** @returns {CocopiRateLimitSnapshot[]} */
export function readCocopiRateLimitSnapshots() {
  return latestRateLimitSnapshots(cocopiRateLimitSnapshots).map((entry) => cloneCocopiRateLimitSnapshot(entry));
}

/** @returns {CocopiRateLimitSnapshot[]} */
export function readCocopiRateLimitSnapshotHistory() {
  return cocopiRateLimitSnapshots.map((entry) => cloneCocopiRateLimitSnapshot(entry));
}

/** @returns {CocopiRemoteUsageAnalyticsSnapshot[]} */
export function readCocopiRemoteUsageAnalyticsSnapshots() {
  return cocopiRemoteUsageAnalyticsSnapshots.map((entry) => cloneCocopiRemoteUsageAnalyticsSnapshot(entry));
}

/** @param {number} id */
export function deleteCocopiTokenCacheDebugSummary(id) {
  const index = cocopiTokenCacheDebugHistory.findIndex((entry) => entry.id === id);
  if (index === -1) {
    return false;
  }

  cocopiTokenCacheDebugHistory.splice(index, 1);
  persistCocopiTokenCacheDebugSummaries();
  dispatchCocopiTokenCacheDebugChange({ type: "delete", id });
  return true;
}

/** @param {string} sessionId */
export function deleteCocopiTokenCacheDebugSession(sessionId) {
  const originalLength = cocopiTokenCacheDebugHistory.length;
  for (let index = cocopiTokenCacheDebugHistory.length - 1; index >= 0; index -= 1) {
    if (cocopiTokenCacheDebugHistory[index].sessionId === sessionId) {
      cocopiTokenCacheDebugHistory.splice(index, 1);
    }
  }

  if (cocopiTokenCacheDebugHistory.length === originalLength) {
    return false;
  }

  persistCocopiTokenCacheDebugSummaries();
  dispatchCocopiTokenCacheDebugChange({ type: "delete-session", sessionId });
  return true;
}

/**
 * @param {string[]} sessionIds
 * @returns {number}
 */
export function deleteCocopiTokenCacheDebugSessions(sessionIds) {
  const targets = new Set([...sessionIds].filter((sessionId) => typeof sessionId === "string" && sessionId.trim().length > 0));
  if (targets.size === 0) {
    return 0;
  }

  const originalLength = cocopiTokenCacheDebugHistory.length;
  for (let index = cocopiTokenCacheDebugHistory.length - 1; index >= 0; index -= 1) {
    if (targets.has(cocopiTokenCacheDebugHistory[index].sessionId)) {
      cocopiTokenCacheDebugHistory.splice(index, 1);
    }
  }

  const deletedEntries = originalLength - cocopiTokenCacheDebugHistory.length;
  if (deletedEntries === 0) {
    return 0;
  }

  persistCocopiTokenCacheDebugSummaries();
  dispatchCocopiTokenCacheDebugChange({ type: "delete-sessions", sessionIds: [...targets] });
  return deletedEntries;
}

export function clearCocopiTokenCacheDebugSummaries() {
  cocopiTokenCacheDebugHistory.length = 0;
  nextCocopiTokenCacheDebugId = 1;
  persistCocopiTokenCacheDebugSummaries();
  dispatchCocopiTokenCacheDebugChange({ type: "clear" });
}

export function clearCocopiRateLimitSnapshots() {
  cocopiRateLimitSnapshots.length = 0;
  persistCocopiRateLimitSnapshots();
}

export function clearCocopiRemoteUsageAnalyticsSnapshots() {
  cocopiRemoteUsageAnalyticsSnapshots.length = 0;
  persistCocopiRemoteUsageAnalyticsSnapshots();
}

/**
 * @param {{ now?: Date }} [options]
 * @returns {CocopiUsageWindowStatus}
 */
export function readCocopiUsageWindowStatus(options = {}) {
  const now = options.now ?? new Date();
  const windowHours = LOCAL_USAGE_WINDOW_HOURS;
  const windowMs = windowHours * 60 * 60 * 1000;
  const windowEndMs = now.getTime();
  const windowStartMs = windowEndMs - windowMs;

  let requestCount = 0;
  let billableTokens = 0;
  let firstEntryMs = windowEndMs;
  for (const entry of cocopiTokenCacheDebugHistory) {
    const recordedAtMs = Date.parse(entry.recordedAt);
    if (!Number.isFinite(recordedAtMs) || recordedAtMs < windowStartMs || recordedAtMs > windowEndMs) {
      continue;
    }
    if (entry.billedTotalTokens === undefined) {
      continue;
    }

    requestCount += entry.mergedRequestCount ?? 1;
    billableTokens += entry.billedTotalTokens;
    firstEntryMs = Math.min(firstEntryMs, recordedAtMs);
  }

  const activeMs = Math.max(60 * 1000, windowEndMs - firstEntryMs);
  const averageTokensPerHour = requestCount === 0 ? 0 : billableTokens / (activeMs / (60 * 60 * 1000));
  const projectedWindowTokens = averageTokensPerHour * windowHours;

  const apiRateLimits = readCocopiRateLimitSnapshots();
  return {
    windowStart: new Date(windowStartMs).toISOString(),
    windowEnd: now.toISOString(),
    windowHours,
    requestCount,
    billableTokens,
    averageTokensPerHour,
    projectedWindowTokens,
    source: apiRateLimits.some((snapshot) => snapshot.primary || snapshot.secondary || snapshot.credits) ? "api" : "local",
    apiRateLimits,
    apiCapturedAt: newestRateLimitCapturedAt(apiRateLimits)
  };
}

/**
 * @param {{ now?: Date, timelineDays?: number }} [options]
 * @returns {CocopiUsageAnalytics}
 */
export function readCocopiUsageAnalytics(options = {}) {
  const now = options.now ?? new Date();
  const windows = COCOPI_USAGE_ANALYTICS_WINDOW_HOURS.map((windowHours) => usageAnalyticsWindow(windowHours, now));
  return {
    capturedAt: now.toISOString(),
    windows,
    weeklyCycle: weeklyCycleUsage(now),
    timeline: usageTimeline(now, options.timelineDays),
    rateLimitTrends: rateLimitTrends(now, Math.max(...COCOPI_USAGE_ANALYTICS_WINDOW_HOURS)),
    sessions: sessionUsageSummaries(),
    remoteUsageAnalytics: readCocopiRemoteUsageAnalyticsSnapshots()[0],
    retainedRequestRows: cocopiTokenCacheDebugHistory.length,
    retainedRateLimitSnapshots: cocopiRateLimitSnapshots.length
  };
}

/** @param {import("./secret-storage.js").SecretStorageLike} secrets */
async function loadCocopiTokenCacheDebugSummariesFromStorage(secrets) {
  const [stored, rateLimitStored, remoteUsageStored] = await Promise.all([
    secrets.get(COCOPI_TOKEN_CACHE_DEBUG_STORAGE_KEY),
    secrets.get(COCOPI_RATE_LIMIT_STORAGE_KEY),
    secrets.get(COCOPI_REMOTE_USAGE_ANALYTICS_STORAGE_KEY)
  ]);
  loadStoredRateLimitSnapshots(rateLimitStored);
  loadStoredRemoteUsageAnalyticsSnapshots(remoteUsageStored);
  if (!stored) {
    return;
  }

  const current = [...cocopiTokenCacheDebugHistory];
  const parsed = parseStoredTokenCacheDebugSummaries(stored);
  cocopiTokenCacheDebugHistory.length = 0;
  cocopiTokenCacheDebugHistory.push(...mergeStoredCocopiTokenCacheDebugSummaries(current, parsed).slice(0, MAX_COCOPI_TOKEN_CACHE_DEBUG_ENTRIES));
  nextCocopiTokenCacheDebugId = Math.max(0, ...cocopiTokenCacheDebugHistory.map((entry) => entry.id)) + 1;
}

/**
 * @param {CocopiTokenCacheDebugSummary[]} current
 * @param {CocopiTokenCacheDebugSummary[]} stored
 * @returns {CocopiTokenCacheDebugSummary[]}
 */
function mergeStoredCocopiTokenCacheDebugSummaries(current, stored) {
  /** @type {Set<string>} */
  const exactKeys = new Set();
  /** @type {Set<number>} */
  const usedIds = new Set();
  let nextId = Math.max(0, ...current.map((entry) => entry.id), ...stored.map((entry) => entry.id)) + 1;
  /** @type {CocopiTokenCacheDebugSummary[]} */
  const merged = [];

  for (const entry of [...current, ...stored]) {
    const exactKey = `${entry.id}\0${entry.recordedAt}\0${entry.source}\0${entry.sessionId}\0${entry.hostRequestIndex}`;
    if (exactKeys.has(exactKey)) {
      continue;
    }

    exactKeys.add(exactKey);
    const mergedEntry = usedIds.has(entry.id) ? { ...entry, id: nextId++ } : entry;
    usedIds.add(mergedEntry.id);
    merged.push(mergedEntry);
  }

  return merged.toSorted((left, right) => right.recordedAt.localeCompare(left.recordedAt));
}

/**
 * @param {string} stored
 * @returns {CocopiTokenCacheDebugSummary[]}
 */
function parseStoredTokenCacheDebugSummaries(stored) {
  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.map((summary) => sanitizeStoredTokenCacheDebugSummary(summary)).filter((summary) => summary !== undefined);
  } catch {
    return [];
  }
}

/* eslint-disable jsdoc/check-types -- Stored JSON is untyped external data. */
/**
 * @param {unknown} value
 * @returns {CocopiTokenCacheDebugSummary | undefined}
 */
function sanitizeStoredTokenCacheDebugSummary(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  const entry = /** @type {Record<string, unknown>} */ (value);
  const id = readPositiveInteger(entry.id);
  const recordedAt = readString(entry.recordedAt);
  const source = entry.source === "chat" || entry.source === "language-model" ? entry.source : undefined;
  const hostRequestIndex = readPositiveInteger(entry.hostRequestIndex) ?? readPositiveInteger(entry.requestIndex);
  const sessionId = readString(entry.sessionId);
  const model = readString(entry.model);
  const inputItems = readNonNegativeNumber(entry.inputItems);
  const cacheStatus = entry.cacheStatus === "hit" || entry.cacheStatus === "miss" || entry.cacheStatus === "unknown" ? entry.cacheStatus : undefined;
  if (!id || !recordedAt || !source || !hostRequestIndex || !sessionId || !model || inputItems === undefined || !cacheStatus) {
    return;
  }

  const result = /** @type {CocopiTokenCacheDebugSummary} */ ({
    id,
    recordedAt,
    source,
    hostRequestIndex,
    lastHostRequestIndex: readOptionalNumber(entry.lastHostRequestIndex) ?? readOptionalNumber(entry.lastRequestIndex),
    mergedRequestCount: readOptionalNumber(entry.mergedRequestCount),
    sessionId,
    conversationSummary: readOptionalString(entry.conversationSummary),
    conversationDescription: readOptionalString(entry.conversationDescription),
    model,
    selectedModel: readOptionalString(entry.selectedModel),
    inputItems,
    stateRestored: readOptionalBoolean(entry.stateRestored),
    requestMessages: readOptionalNumber(entry.requestMessages),
    requestTextParts: readOptionalNumber(entry.requestTextParts),
    requestToolCallParts: readOptionalNumber(entry.requestToolCallParts),
    requestToolResultParts: readOptionalNumber(entry.requestToolResultParts),
    requestDataParts: readOptionalNumber(entry.requestDataParts),
    requestCocopiDataParts: readOptionalNumber(entry.requestCocopiDataParts),
    requestCocopiDataBytes: readOptionalNumber(entry.requestCocopiDataBytes),
    requestDataMimeTypes: readOptionalString(entry.requestDataMimeTypes),
    transport: readOptionalString(entry.transport),
    serviceTier: readOptionalString(entry.serviceTier),
    serviceTierSource: readOptionalString(entry.serviceTierSource),
    reasoningEffort: readOptionalString(entry.reasoningEffort),
    reasoningSummary: readOptionalString(entry.reasoningSummary),
    fastRequested: readOptionalBoolean(entry.fastRequested),
    automaticContinuation: readOptionalBoolean(entry.automaticContinuation),
    promptCacheKey: readOptionalString(entry.promptCacheKey),
    requestKind: readOptionalString(entry.requestKind),
    requestInputDigest: readOptionalString(entry.requestInputDigest),
    requestToolsDigest: readOptionalString(entry.requestToolsDigest),
    requestBodyDigest: readOptionalString(entry.requestBodyDigest),
    wireMode: readOptionalString(entry.wireMode),
    wireInputItems: readOptionalNumber(entry.wireInputItems),
    wireInputDigest: readOptionalString(entry.wireInputDigest),
    wireToolsDigest: readOptionalString(entry.wireToolsDigest),
    wireBodyDigest: readOptionalString(entry.wireBodyDigest),
    webSocketContinuationAction: normalizeWebSocketContinuationAction(readOptionalString(entry.webSocketContinuationAction)),
    webSocketContinuationReason: normalizeWebSocketContinuationReason(readOptionalString(entry.webSocketContinuationReason)),
    webSocketContinuationStateChanges: readOptionalString(entry.webSocketContinuationStateChanges),
    webSocketContinuationMatchingItems: readOptionalNumber(entry.webSocketContinuationMatchingItems),
    webSocketContinuationMismatchIndex: readOptionalNumber(entry.webSocketContinuationMismatchIndex),
    webSocketContinuationExpected: readOptionalString(entry.webSocketContinuationExpected),
    webSocketContinuationActual: readOptionalString(entry.webSocketContinuationActual),
    webSocketContinuationExpectedDigest: readOptionalString(entry.webSocketContinuationExpectedDigest),
    webSocketContinuationActualDigest: readOptionalString(entry.webSocketContinuationActualDigest),
    turnKind: normalizeTokenCacheTurnKind(readOptionalString(entry.turnKind)),
    cacheRisk: normalizeTokenCacheRisk(readOptionalString(entry.cacheRisk)),
    uncachedInputTokens: readOptionalNumber(entry.uncachedInputTokens),
    requestStartedAt: readOptionalString(entry.requestStartedAt),
    requestCompletedAt: readOptionalString(entry.requestCompletedAt),
    requestDurationMs: readOptionalNumber(entry.requestDurationMs),
    firstEventLatencyMs: readOptionalNumber(entry.firstEventLatencyMs),
    firstOutputLatencyMs: readOptionalNumber(entry.firstOutputLatencyMs),
    outputTokensPerSecond: readOptionalNumber(entry.outputTokensPerSecond),
    responseId: readOptionalString(entry.responseId),
    inputTokens: readOptionalNumber(entry.inputTokens),
    outputTokens: readOptionalNumber(entry.outputTokens),
    reasoningTokens: readOptionalNumber(entry.reasoningTokens),
    totalTokens: readOptionalNumber(entry.totalTokens),
    cachedTokens: readOptionalNumber(entry.cachedTokens),
    billedInputTokens: readOptionalNumber(entry.billedInputTokens),
    billedOutputTokens: readOptionalNumber(entry.billedOutputTokens),
    billedTotalTokens: readOptionalNumber(entry.billedTotalTokens),
    cacheStatus,
    cacheHitRatio: readOptionalNumber(entry.cacheHitRatio),
    sessionInitialTokens: readOptionalNumber(entry.sessionInitialTokens),
    sessionCumulativeTokens: readOptionalNumber(entry.sessionCumulativeTokens)
  });
  const derived = deriveCocopiTokenCacheDiagnostics(result);
  result.turnKind = result.turnKind ?? derived.turnKind;
  result.cacheRisk = result.cacheRisk ?? derived.cacheRisk;
  result.uncachedInputTokens = result.uncachedInputTokens ?? derived.uncachedInputTokens;
  return result;
}

function persistCocopiTokenCacheDebugSummaries() {
  if (!cocopiTokenCacheDebugStorage) {
    return;
  }

  void cocopiTokenCacheDebugStorage.store(COCOPI_TOKEN_CACHE_DEBUG_STORAGE_KEY, JSON.stringify(cocopiTokenCacheDebugHistory));
}

function persistCocopiRateLimitSnapshots() {
  if (!cocopiTokenCacheDebugStorage) {
    return;
  }

  void cocopiTokenCacheDebugStorage.store(COCOPI_RATE_LIMIT_STORAGE_KEY, JSON.stringify(cocopiRateLimitSnapshots));
}

function persistCocopiRemoteUsageAnalyticsSnapshots() {
  if (!cocopiTokenCacheDebugStorage) {
    return;
  }

  void cocopiTokenCacheDebugStorage.store(COCOPI_REMOTE_USAGE_ANALYTICS_STORAGE_KEY, JSON.stringify(cocopiRemoteUsageAnalyticsSnapshots));
}

/** @param {CocopiTokenCacheDebugChangeEvent} event */
function dispatchCocopiTokenCacheDebugChange(event) {
  cocopiTokenCacheDebugChangeTarget.dispatchEvent(new CustomEvent("change", { detail: event }));
}

/** @param {CocopiTokenCacheDebugSummary} entry */
function cloneCocopiTokenCacheDebugSummary(entry) {
  return { ...entry };
}

/** @param {CocopiRateLimitSnapshot} entry */
function cloneCocopiRateLimitSnapshot(entry) {
  return {
    ...entry,
    primary: entry.primary ? { ...entry.primary } : undefined,
    secondary: entry.secondary ? { ...entry.secondary } : undefined,
    credits: entry.credits ? { ...entry.credits } : undefined
  };
}

/** @param {CocopiRemoteUsageAnalyticsSnapshot} entry */
function cloneCocopiRemoteUsageAnalyticsSnapshot(entry) {
  return {
    ...entry,
    dailyTokenUsage: entry.dailyTokenUsage.map((item) => ({
      ...item,
      productSurfaceUsageValues: { ...item.productSurfaceUsageValues }
    })),
    dailyWorkspaceUsage: entry.dailyWorkspaceUsage.map((item) => ({
      ...item,
      totals: { ...item.totals },
      clients: item.clients.map((client) => ({ ...client }))
    }))
  };
}

/** @param {string | undefined} stored */
function loadStoredRateLimitSnapshots(stored) {
  cocopiRateLimitSnapshots.length = 0;
  if (!stored) {
    return;
  }

  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      return;
    }

    cocopiRateLimitSnapshots.push(...parsed.map((snapshot) => sanitizeRateLimitSnapshot(snapshot)).filter((snapshot) => snapshot !== undefined).slice(0, MAX_COCOPI_RATE_LIMIT_SNAPSHOTS));
    cocopiRateLimitSnapshots.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
  } catch {
    // Ignore malformed private diagnostic storage.
  }
}

/** @param {string | undefined} stored */
function loadStoredRemoteUsageAnalyticsSnapshots(stored) {
  cocopiRemoteUsageAnalyticsSnapshots.length = 0;
  if (!stored) {
    return;
  }

  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      return;
    }

    cocopiRemoteUsageAnalyticsSnapshots.push(...parsed.map((snapshot) => sanitizeRemoteUsageAnalyticsSnapshot(snapshot)).filter((snapshot) => snapshot !== undefined).slice(0, MAX_COCOPI_REMOTE_USAGE_ANALYTICS_SNAPSHOTS));
  } catch {
    // Ignore malformed private diagnostic storage.
  }
}

/**
 * @param {unknown} value
 * @returns {CocopiRateLimitSnapshot | undefined}
 */
function sanitizeRateLimitSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  const entry = /** @type {Record<string, unknown>} */ (value);
  const capturedAt = readString(entry.capturedAt);
  if (!capturedAt) {
    return;
  }

  return {
    capturedAt,
    limitId: readOptionalString(entry.limitId) ?? "codex",
    limitName: readOptionalString(entry.limitName),
    primary: sanitizeRateLimitWindow(entry.primary),
    secondary: sanitizeRateLimitWindow(entry.secondary),
    credits: sanitizeCredits(entry.credits),
    planType: readOptionalString(entry.planType),
    rateLimitReachedType: readOptionalString(entry.rateLimitReachedType)
  };
}

/**
 * @param {unknown} value
 * @returns {CocopiRemoteUsageAnalyticsSnapshot | undefined}
 */
function sanitizeRemoteUsageAnalyticsSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  const entry = /** @type {Record<string, unknown>} */ (value);
  const capturedAt = readString(entry.capturedAt);
  const startDate = readString(entry.startDate);
  const endDate = readString(entry.endDate);
  if (!capturedAt || !startDate || !endDate) {
    return;
  }

  return {
    capturedAt,
    startDate,
    endDate,
    tokenUnits: readOptionalString(entry.tokenUnits),
    tokenGroupBy: readOptionalString(entry.tokenGroupBy),
    dailyTokenUsage: readArray(entry.dailyTokenUsage).map((item) => sanitizeDailyTokenUsage(item)).filter((item) => item !== undefined),
    workspaceGroupBy: readOptionalString(entry.workspaceGroupBy),
    dailyWorkspaceUsage: readArray(entry.dailyWorkspaceUsage).map((item) => sanitizeDailyWorkspaceUsage(item)).filter((item) => item !== undefined)
  };
}

/**
 * @param {unknown} value
 * @returns {import("../codex-api/rate-limits.js").CodexDailyTokenUsageBreakdown | undefined}
 */
function sanitizeDailyTokenUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  const entry = /** @type {Record<string, unknown>} */ (value);
  const date = readString(entry.date);
  if (!date) {
    return;
  }

  return {
    date,
    productSurfaceUsageValues: sanitizeNumberRecord(entry.productSurfaceUsageValues)
  };
}

/**
 * @param {unknown} value
 * @returns {import("../codex-api/rate-limits.js").CodexDailyWorkspaceUsageCounts | undefined}
 */
function sanitizeDailyWorkspaceUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  const entry = /** @type {Record<string, unknown>} */ (value);
  const date = readString(entry.date);
  if (!date) {
    return;
  }

  return {
    date,
    totals: sanitizeWorkspaceUsageTotals(entry.totals),
    clients: readArray(entry.clients).map((client) => sanitizeWorkspaceClientUsage(client)).filter((client) => client !== undefined)
  };
}

/** @param {unknown} value */
function sanitizeWorkspaceClientUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  const entry = /** @type {Record<string, unknown>} */ (value);
  const clientId = readString(entry.clientId);
  if (!clientId) {
    return;
  }

  return {
    clientId,
    ...sanitizeWorkspaceUsageTotals(entry)
  };
}

/** @param {unknown} value */
function sanitizeWorkspaceUsageTotals(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const entry = /** @type {Record<string, unknown>} */ (value);
  return {
    users: readOptionalNumber(entry.users),
    threads: readOptionalNumber(entry.threads),
    turns: readOptionalNumber(entry.turns),
    credits: readOptionalNumber(entry.credits),
    uncachedTextInputTokens: readOptionalNumber(entry.uncachedTextInputTokens),
    cachedTextInputTokens: readOptionalNumber(entry.cachedTextInputTokens),
    textOutputTokens: readOptionalNumber(entry.textOutputTokens),
    textTotalTokens: readOptionalNumber(entry.textTotalTokens)
  };
}

/** @param {unknown} value */
function sanitizeNumberRecord(value) {
  /** @type {Record<string, number>} */
  const result = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return result;
  }

  for (const [key, item] of Object.entries(value)) {
    const number = readOptionalNumber(item);
    if (number !== undefined && number >= 0) {
      result[key] = number;
    }
  }

  return result;
}

/**
 * @param {unknown} value
 * @returns {CocopiRateLimitWindow | undefined}
 */
function sanitizeRateLimitWindow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  const entry = /** @type {Record<string, unknown>} */ (value);
  const usedPercent = readNonNegativeNumber(entry.usedPercent);
  if (usedPercent === undefined) {
    return;
  }

  return {
    usedPercent,
    windowMinutes: readOptionalNumber(entry.windowMinutes),
    resetsAt: readOptionalNumber(entry.resetsAt)
  };
}

/**
 * @param {unknown} value
 * @returns {CocopiCreditsSnapshot | undefined}
 */
function sanitizeCredits(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  const entry = /** @type {Record<string, unknown>} */ (value);
  if (typeof entry.hasCredits !== "boolean" || typeof entry.unlimited !== "boolean") {
    return;
  }

  return {
    hasCredits: entry.hasCredits,
    unlimited: entry.unlimited,
    balance: readOptionalString(entry.balance)
  };
}

/** @param {unknown} value */
function readString(value) {
  return typeof value === "string" ? value : undefined;
}

/** @param {unknown} value */
function readOptionalString(value) {
  return value === undefined || typeof value === "string" ? value : undefined;
}

/** @param {unknown} value */
function readPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** @param {unknown} value */
function readNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** @param {unknown} value */
function readOptionalNumber(value) {
  return value === undefined || typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** @param {unknown} value */
function readOptionalBoolean(value) {
  return value === undefined || typeof value === "boolean" ? value : undefined;
}

/** @param {unknown} value */
function readArray(value) {
  return Array.isArray(value) ? value : [];
}
/* eslint-enable jsdoc/check-types */

/** @param {Omit<CocopiTokenCacheDebugSummary, "id" | "recordedAt">} summary */
function billableTokenSummary(summary) {
  const totalTokens = summary.totalTokens;
  const inputTokens = summary.inputTokens;
  const outputTokens = summary.outputTokens;
  const cachedTokens = summary.cachedTokens;

  const billedInputTokens = inputTokens === undefined
    ? undefined
    : Math.max(0, inputTokens - (cachedTokens ?? 0));

  const billedOutputTokens = outputTokens;
  const billedTotalTokens = billedInputTokens === undefined && billedOutputTokens === undefined
    ? (typeof totalTokens === "number" ? Math.max(0, totalTokens - (cachedTokens ?? 0)) : undefined)
    : (billedInputTokens ?? 0) + (billedOutputTokens ?? 0);

  return {
    billedInputTokens,
    billedOutputTokens,
    billedTotalTokens
  };
}

/** @param {Omit<CocopiTokenCacheDebugSummary, "id" | "recordedAt">} summary */
function timingSummary(summary) {
  const requestDurationMs = summary.requestDurationMs ?? requestDurationFromTimestamps(summary.requestStartedAt, summary.requestCompletedAt);
  const outputTokensPerSecond = summary.outputTokensPerSecond ?? outputTokenRate(summary.outputTokens, requestDurationMs);
  return {
    requestDurationMs,
    outputTokensPerSecond
  };
}

/**
 * @param {string | undefined} startedAt
 * @param {string | undefined} completedAt
 */
function requestDurationFromTimestamps(startedAt, completedAt) {
  const startedAtMs = Date.parse(startedAt ?? "");
  const completedAtMs = Date.parse(completedAt ?? "");
  return Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs) && completedAtMs >= startedAtMs
    ? completedAtMs - startedAtMs
    : undefined;
}

/**
 * @param {number | undefined} outputTokens
 * @param {number | undefined} requestDurationMs
 */
function outputTokenRate(outputTokens, requestDurationMs) {
  return typeof outputTokens === "number" && typeof requestDurationMs === "number" && requestDurationMs > 0
    ? outputTokens / (requestDurationMs / 1000)
    : undefined;
}

/** @param {Date} now */
function weeklyCycleUsage(now) {
  const descriptor = weeklyCycleDescriptor(now);
  const cycleStartMs = Date.parse(descriptor.cycleStart);
  const cycleEndMs = Date.parse(descriptor.cycleEnd);
  const nowMs = now.getTime();
  const aggregateEndMs = Math.min(nowMs, cycleEndMs);
  const entries = entriesWithinWindow(cycleStartMs, aggregateEndMs);
  const totals = aggregateTokenCacheEntries(entries);
  const elapsedMs = Math.max(0, aggregateEndMs - cycleStartMs);
  const elapsedHours = elapsedMs / (60 * 60 * 1000);
  const elapsedDays = Math.max(1 / (24 * 60), elapsedHours / 24);
  const scale = descriptor.source === "rate-limit-reset" && elapsedMs > 0
    ? (cycleEndMs - cycleStartMs) / elapsedMs
    : undefined;
  const apiMeteredTokens = totals.uncachedInputTokens + totals.outputTokens;
  return {
    source: descriptor.source,
    sourceLabel: descriptor.sourceLabel,
    cycleStart: descriptor.cycleStart,
    cycleEnd: descriptor.cycleEnd,
    windowHours: (cycleEndMs - cycleStartMs) / (60 * 60 * 1000),
    elapsedHours,
    remainingHours: descriptor.source === "rate-limit-reset" ? Math.max(0, (cycleEndMs - nowMs) / (60 * 60 * 1000)) : undefined,
    requestCount: totals.requestCount,
    usageKnownRequestCount: totals.usageKnownRequestCount,
    unknownUsageRequestCount: totals.unknownUsageRequestCount,
    inputTokens: totals.inputTokens,
    cachedInputTokens: totals.cachedTokens,
    uncachedInputTokens: totals.uncachedInputTokens,
    outputTokens: totals.outputTokens,
    reasoningTokens: totals.reasoningTokens,
    totalTokens: totals.totalTokens,
    apiMeteredTokens,
    outputTokensPerDay: totals.outputTokens / elapsedDays,
    uncachedInputTokensPerDay: totals.uncachedInputTokens / elapsedDays,
    apiMeteredTokensPerDay: apiMeteredTokens / elapsedDays,
    projectedOutputTokens: scale === undefined ? undefined : Math.round(totals.outputTokens * scale),
    projectedUncachedInputTokens: scale === undefined ? undefined : Math.round(totals.uncachedInputTokens * scale),
    projectedApiMeteredTokens: scale === undefined ? undefined : Math.round(apiMeteredTokens * scale),
    limitId: descriptor.limitId,
    limitName: descriptor.limitName,
    rateLimitCapturedAt: descriptor.rateLimitCapturedAt,
    models: weeklyCycleModelUsage(entries)
  };
}

/** @param {Date} now */
function weeklyCycleDescriptor(now) {
  const nowMs = now.getTime();
  const snapshot = latestWeeklyRateLimitSnapshot(now);
  if (snapshot?.secondary) {
    const windowMinutes = snapshot.secondary.windowMinutes && snapshot.secondary.windowMinutes > 0
      ? snapshot.secondary.windowMinutes
      : COCOPI_WEEKLY_CYCLE_FALLBACK_WINDOW_MINUTES;
    const resetMs = typeof snapshot.secondary.resetsAt === "number" ? snapshot.secondary.resetsAt * 1000 : undefined;
    if (resetMs !== undefined && Number.isFinite(resetMs) && resetMs > nowMs) {
      const cycleStartMs = resetMs - windowMinutes * 60 * 1000;
      return {
        source: /** @type {'rate-limit-reset'} */ ("rate-limit-reset"),
        sourceLabel: `${weeklyCycleLimitLabel(snapshot)} ${rateLimitWindowTrendLabel(snapshot.secondary, "weekly")}`,
        cycleStart: new Date(cycleStartMs).toISOString(),
        cycleEnd: new Date(resetMs).toISOString(),
        limitId: snapshot.limitId,
        limitName: snapshot.limitName,
        rateLimitCapturedAt: snapshot.capturedAt
      };
    }

    return {
      source: /** @type {'rate-limit-window'} */ ("rate-limit-window"),
      sourceLabel: `${weeklyCycleLimitLabel(snapshot)} ${rateLimitWindowTrendLabel(snapshot.secondary, "weekly")} rolling window`,
      cycleStart: new Date(nowMs - windowMinutes * 60 * 1000).toISOString(),
      cycleEnd: now.toISOString(),
      limitId: snapshot.limitId,
      limitName: snapshot.limitName,
      rateLimitCapturedAt: snapshot.capturedAt
    };
  }

  return {
    source: /** @type {'rolling-7d'} */ ("rolling-7d"),
    sourceLabel: "Rolling 7d fallback",
    cycleStart: new Date(nowMs - COCOPI_WEEKLY_CYCLE_FALLBACK_WINDOW_MINUTES * 60 * 1000).toISOString(),
    cycleEnd: now.toISOString()
  };
}

/** @param {Date} now */
function latestWeeklyRateLimitSnapshot(now) {
  const snapshots = latestRateLimitSnapshots(cocopiRateLimitSnapshots).filter((snapshot) => snapshot.secondary);
  return preferredWeeklyRateLimitSnapshot(snapshots.filter((snapshot) => {
    const resetsAtMs = typeof snapshot.secondary?.resetsAt === "number" ? snapshot.secondary.resetsAt * 1000 : undefined;
    return resetsAtMs === undefined || resetsAtMs > now.getTime();
  })) ?? preferredWeeklyRateLimitSnapshot(snapshots);
}

/** @param {CocopiRateLimitSnapshot[]} snapshots */
function preferredWeeklyRateLimitSnapshot(snapshots) {
  return snapshots.find((snapshot) => snapshot.limitId === "codex") ?? snapshots[0];
}

/** @param {CocopiRateLimitSnapshot} snapshot */
function weeklyCycleLimitLabel(snapshot) {
  const label = snapshot.limitName ?? snapshot.limitId ?? "Codex";
  if (snapshot.limitId === "codex" || label === "codex") {
    return "Regular";
  }
  if (/spark|bengalfox/iu.test(label) || /spark|bengalfox/iu.test(snapshot.limitId ?? "")) {
    return "Spark";
  }
  return label;
}

/** @param {CocopiTokenCacheDebugSummary[]} entries */
function weeklyCycleModelUsage(entries) {
  /** @type {Map<string, CocopiTokenCacheDebugSummary[]>} */
  const groups = new Map();
  for (const entry of entries) {
    const key = timelineSeriesKey(entry);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  return [...groups.values()].map((items) => {
    const first = items[0];
    const totals = aggregateTokenCacheEntries(items);
    return {
      label: first ? timelineSeriesLabel(first) : "unknown",
      model: first?.selectedModel ?? first?.model ?? "unknown",
      reasoningEffort: first?.reasoningEffort ?? "default",
      requestCount: totals.requestCount,
      inputTokens: totals.inputTokens,
      cachedInputTokens: totals.cachedTokens,
      uncachedInputTokens: totals.uncachedInputTokens,
      outputTokens: totals.outputTokens,
      apiMeteredTokens: totals.uncachedInputTokens + totals.outputTokens
    };
  }).toSorted((left, right) => right.apiMeteredTokens - left.apiMeteredTokens || left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: "base" }));
}

/**
 * @param {Date} now
 * @param {number | undefined} requestedDays
 * @returns {CocopiUsageTimeline}
 */
function usageTimeline(now, requestedDays) {
  const timelineDays = normalizeTimelineDays(requestedDays);
  const windowStart = new Date(now);
  windowStart.setDate(windowStart.getDate() - timelineDays);
  const windowHours = (now.getTime() - windowStart.getTime()) / (60 * 60 * 1000);
  const bucketMinutes = COCOPI_USAGE_TIMELINE_BUCKET_MINUTES;
  const windowEndMs = now.getTime();
  const windowStartMs = windowStart.getTime();
  const bucketBoundaries = timelineBucketBoundaries(windowStart, now, bucketMinutes);
  /** @type {CocopiTokenCacheDebugSummary[][]} */
  const buckets = Array.from({ length: Math.max(0, bucketBoundaries.length - 1) }, () => []);

  for (const entry of entriesWithinWindow(windowStartMs, windowEndMs)) {
    const recordedAtMs = Date.parse(entry.recordedAt);
    const index = timelineBucketIndex(bucketBoundaries, recordedAtMs);
    buckets[index]?.push(entry);
  }

  return {
    label: `${timelineDays}d by ${bucketMinutes}m`,
    windowStart: windowStart.toISOString(),
    windowEnd: now.toISOString(),
    windowHours,
    bucketMinutes,
    buckets: timelineBucketsFromEntryGroups(buckets, bucketBoundaries, windowStartMs, windowEndMs),
    series: timelineSeries(buckets, bucketBoundaries, windowStartMs, windowEndMs)
  };
}

/** @param {number | undefined} requestedDays */
function normalizeTimelineDays(requestedDays) {
  if (typeof requestedDays !== "number" || !Number.isFinite(requestedDays) || requestedDays < 1) {
    return DEFAULT_COCOPI_USAGE_TIMELINE_WINDOW_DAYS;
  }

  return Math.min(30, Math.trunc(requestedDays));
}

/**
 * @param {CocopiTokenCacheDebugSummary[][]} buckets
 * @param {number[]} bucketBoundaries
 * @param {number} windowStartMs
 * @param {number} windowEndMs
 * @returns {CocopiUsageTimelineBucket[]}
 */
function timelineBucketsFromEntryGroups(buckets, bucketBoundaries, windowStartMs, windowEndMs) {
  return buckets.map((entries, index) => {
      const totals = aggregateTokenCacheEntries(entries);
      return {
        bucketStart: new Date(bucketBoundaries[index] ?? windowStartMs).toISOString(),
        bucketEnd: new Date(bucketBoundaries[index + 1] ?? windowEndMs).toISOString(),
        requestCount: totals.requestCount,
        billableTokens: totals.billableTokens,
        uncachedInputTokens: totals.uncachedInputTokens,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cachedTokens: totals.cachedTokens,
        averageLatencyMs: average(totals.requestDurationMs, totals.timedRequestCount),
        averageFirstOutputLatencyMs: average(totals.firstOutputLatencyMs, totals.firstOutputCount),
        outputTokensPerSecond: totals.streamDurationMs > 0 ? totals.outputTokensForThroughput / (totals.streamDurationMs / 1000) : undefined
      };
    });
}

/**
 * @param {CocopiTokenCacheDebugSummary[][]} buckets
 * @param {number[]} bucketBoundaries
 * @param {number} windowStartMs
 * @param {number} windowEndMs
 * @returns {CocopiUsageTimelineSeries[]}
 */
function timelineSeries(buckets, bucketBoundaries, windowStartMs, windowEndMs) {
  /** @type {Map<string, CocopiTokenCacheDebugSummary[][]>} */
  const groups = new Map();
  for (const [index, entries] of buckets.entries()) {
    for (const entry of entries) {
      const key = timelineSeriesKey(entry);
      const group = groups.get(key) ?? Array.from({ length: buckets.length }, () => []);
      group[index]?.push(entry);
      groups.set(key, group);
    }
  }

  const series = [...groups.entries()].map(([key, groupedBuckets]) => {
    const firstEntry = groupedBuckets.flat()[0];
    const seriesBuckets = timelineBucketsFromEntryGroups(groupedBuckets, bucketBoundaries, windowStartMs, windowEndMs);
    return {
      key,
      label: firstEntry ? timelineSeriesLabel(firstEntry) : key,
      model: firstEntry?.selectedModel ?? firstEntry?.model ?? "unknown",
      reasoningEffort: firstEntry?.reasoningEffort ?? "default",
      requestCount: seriesBuckets.reduce((total, bucket) => total + bucket.requestCount, 0),
      billableTokens: seriesBuckets.reduce((total, bucket) => total + bucket.billableTokens, 0),
      buckets: seriesBuckets
    };
  });

  return series
    .toSorted((left, right) => right.billableTokens - left.billableTokens)
    .slice(0, MAX_COCOPI_USAGE_TIMELINE_SERIES)
    .toSorted(compareTimelineSeries);
}

/**
 * @param {CocopiUsageTimelineSeries} left
 * @param {CocopiUsageTimelineSeries} right
 */
function compareTimelineSeries(left, right) {
  return compareTimelineModel(left.model, right.model)
    || compareTimelineRank(left.reasoningEffort, right.reasoningEffort, ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
    || left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * @param {string} left
 * @param {string} right
 */
function compareTimelineModel(left, right) {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * @param {string} left
 * @param {string} right
 * @param {string[]} order
 */
function compareTimelineRank(left, right, order) {
  const leftRank = order.indexOf(left);
  const rightRank = order.indexOf(right);
  const normalizedLeftRank = leftRank === -1 ? order.length : leftRank;
  const normalizedRightRank = rightRank === -1 ? order.length : rightRank;
  return normalizedLeftRank - normalizedRightRank || left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

/** @param {CocopiTokenCacheDebugSummary} entry */
function timelineSeriesKey(entry) {
  return `${entry.selectedModel ?? entry.model}\0${entry.reasoningEffort ?? "default"}`;
}

/** @param {CocopiTokenCacheDebugSummary} entry */
function timelineSeriesLabel(entry) {
  const model = entry.selectedModel ?? entry.model;
  const effort = entry.reasoningEffort ?? "default";
  return `${model} · ${effort}`;
}

/**
 * @param {Date} windowStart
 * @param {Date} windowEnd
 * @param {number} bucketMinutes
 */
function timelineBucketBoundaries(windowStart, windowEnd, bucketMinutes) {
  const boundaries = [windowStart.getTime()];
  const cursor = new Date(windowStart);
  while (cursor.getTime() < windowEnd.getTime()) {
    const previousMs = cursor.getTime();
    cursor.setMinutes(cursor.getMinutes() + bucketMinutes);
    const nextMs = cursor.getTime();
    boundaries.push(Math.min(nextMs, windowEnd.getTime()));
    if (nextMs <= previousMs) {
      break;
    }
  }
  return boundaries;
}

/**
 * @param {number[]} boundaries
 * @param {number} recordedAtMs
 */
function timelineBucketIndex(boundaries, recordedAtMs) {
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index];
    const end = boundaries[index + 1];
    if (start !== undefined && end !== undefined && recordedAtMs >= start && recordedAtMs <= end) {
      return index;
    }
  }
  return Math.max(0, boundaries.length - 2);
}

/**
 * @param {number} windowHours
 * @param {Date} now
 * @returns {CocopiUsageAnalyticsWindow}
 */
function usageAnalyticsWindow(windowHours, now) {
  const windowEndMs = now.getTime();
  const windowStartMs = windowEndMs - windowHours * 60 * 60 * 1000;
  const totals = aggregateTokenCacheEntries(entriesWithinWindow(windowStartMs, windowEndMs));
  const activeMinutes = activeUsageMinutes(totals.firstEntryMs, windowEndMs);
  return {
    label: usageWindowLabel(windowHours),
    windowHours,
    windowStart: new Date(windowStartMs).toISOString(),
    windowEnd: now.toISOString(),
    requestCount: totals.requestCount,
    billableTokens: totals.billableTokens,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cachedTokens: totals.cachedTokens,
    uncachedInputTokens: totals.uncachedInputTokens,
    tokensPerMinute: totals.requestCount === 0 ? 0 : totals.billableTokens / activeMinutes,
    requestsPerMinute: totals.requestCount === 0 ? 0 : totals.requestCount / activeMinutes,
    averageLatencyMs: average(totals.requestDurationMs, totals.timedRequestCount),
    averageFirstEventLatencyMs: average(totals.firstEventLatencyMs, totals.firstEventCount),
    averageFirstOutputLatencyMs: average(totals.firstOutputLatencyMs, totals.firstOutputCount),
    outputTokensPerSecond: totals.streamDurationMs > 0 ? totals.outputTokensForThroughput / (totals.streamDurationMs / 1000) : undefined
  };
}

/**
 * @param {number} windowStartMs
 * @param {number} windowEndMs
 */
function entriesWithinWindow(windowStartMs, windowEndMs) {
  return cocopiTokenCacheDebugHistory.filter((entry) => {
    const recordedAtMs = Date.parse(entry.recordedAt);
    return Number.isFinite(recordedAtMs) && recordedAtMs >= windowStartMs && recordedAtMs <= windowEndMs;
  });
}

/** @param {CocopiTokenCacheDebugSummary[]} entries */
function aggregateTokenCacheEntries(entries) {
  const totals = {
    requestCount: 0,
    usageKnownRequestCount: 0,
    unknownUsageRequestCount: 0,
    billableTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    uncachedInputTokens: 0,
    requestDurationMs: 0,
    timedRequestCount: 0,
    firstEventLatencyMs: 0,
    firstEventCount: 0,
    firstOutputLatencyMs: 0,
    firstOutputCount: 0,
    streamDurationMs: 0,
    outputTokensForThroughput: 0,
    firstEntryMs: /** @type {number | undefined} */ (undefined)
  };

  for (const entry of entries) {
    const requestCount = entry.mergedRequestCount ?? 1;
    const recordedAtMs = Date.parse(entry.recordedAt);
    if (hasUsageCounters(entry)) {
      totals.usageKnownRequestCount += requestCount;
    } else {
      totals.unknownUsageRequestCount += requestCount;
    }
    totals.requestCount += requestCount;
    totals.billableTokens += entry.billedTotalTokens ?? 0;
    totals.inputTokens += entry.inputTokens ?? 0;
    totals.outputTokens += entry.outputTokens ?? 0;
    totals.reasoningTokens += entry.reasoningTokens ?? 0;
    totals.totalTokens += entry.totalTokens ?? 0;
    totals.cachedTokens += entry.cachedTokens ?? 0;
    totals.uncachedInputTokens += deriveCocopiTokenCacheDiagnostics(entry).uncachedInputTokens ?? 0;
    if (Number.isFinite(recordedAtMs)) {
      totals.firstEntryMs = totals.firstEntryMs === undefined || recordedAtMs < totals.firstEntryMs ? recordedAtMs : totals.firstEntryMs;
    }
    if (typeof entry.requestDurationMs === "number") {
      totals.requestDurationMs += entry.requestDurationMs;
      totals.timedRequestCount += 1;
      if (typeof entry.outputTokens === "number") {
        totals.outputTokensForThroughput += entry.outputTokens;
        totals.streamDurationMs += entry.requestDurationMs;
      }
    }
    if (typeof entry.firstEventLatencyMs === "number") {
      totals.firstEventLatencyMs += entry.firstEventLatencyMs;
      totals.firstEventCount += 1;
    }
    if (typeof entry.firstOutputLatencyMs === "number") {
      totals.firstOutputLatencyMs += entry.firstOutputLatencyMs;
      totals.firstOutputCount += 1;
    }
  }

  return totals;
}

/** @param {CocopiTokenCacheDebugSummary} entry */
function hasUsageCounters(entry) {
  return entry.inputTokens !== undefined
    || entry.outputTokens !== undefined
    || entry.reasoningTokens !== undefined
    || entry.totalTokens !== undefined
    || entry.cachedTokens !== undefined
    || entry.billedTotalTokens !== undefined;
}

/**
 * @param {number | undefined} firstEntryMs
 * @param {number} windowEndMs
 */
function activeUsageMinutes(firstEntryMs, windowEndMs) {
  if (firstEntryMs === undefined || !Number.isFinite(firstEntryMs)) {
    return 1;
  }

  return Math.max(1, (windowEndMs - firstEntryMs) / (60 * 1000));
}

/**
 * @param {number} total
 * @param {number} count
 */
function average(total, count) {
  return count > 0 ? total / count : undefined;
}

/** @param {number} windowHours */
function usageWindowLabel(windowHours) {
  if (windowHours % (24 * 7) === 0) {
    return `${windowHours / (24 * 7)}w`;
  }
  if (windowHours % 24 === 0) {
    return `${windowHours / 24}d`;
  }
  return `${windowHours}h`;
}

/** @returns {CocopiSessionUsageSummary[]} */
function sessionUsageSummaries() {
  /** @type {Map<string, CocopiTokenCacheDebugSummary[]>} */
  const groups = new Map();
  for (const entry of cocopiTokenCacheDebugHistory) {
    const key = `${entry.source}\0${entry.sessionId}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  return [...groups.values()].map((entries) => {
    const sorted = entries.toSorted((left, right) => left.recordedAt.localeCompare(right.recordedAt));
    const first = sorted[0];
    const last = sorted.at(-1);
    const totals = aggregateTokenCacheEntries(sorted);
    return {
      agent: first?.source ?? "language-model",
      source: first?.source ?? "language-model",
      sessionId: first?.sessionId ?? "unknown",
      conversationSummary: firstDefined(sorted, (entry) => entry.conversationSummary),
      conversationDescription: firstDefined(sorted, (entry) => entry.conversationDescription),
      firstRecordedAt: first?.recordedAt ?? "",
      lastRecordedAt: last?.recordedAt ?? "",
      requestCount: totals.requestCount,
      billableTokens: totals.billableTokens,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      uncachedInputTokens: totals.uncachedInputTokens,
      averageLatencyMs: average(totals.requestDurationMs, totals.timedRequestCount),
      averageFirstOutputLatencyMs: average(totals.firstOutputLatencyMs, totals.firstOutputCount),
      outputTokensPerSecond: totals.streamDurationMs > 0 ? totals.outputTokensForThroughput / (totals.streamDurationMs / 1000) : undefined
    };
  }).toSorted((left, right) => right.lastRecordedAt.localeCompare(left.lastRecordedAt));
}

/**
 * @template T
 * @param {T[]} values
 * @param {(value: T) => string | undefined} selector
 * @returns {string | undefined}
 */
function firstDefined(values, selector) {
  for (const value of values) {
    const selected = selector(value);
    if (typeof selected === "string" && selected.trim().length > 0) {
      return selected;
    }
  }

  return;
}

/**
 * @param {Date} now
 * @param {number} windowHours
 * @returns {CocopiRateLimitTrend[]}
 */
function rateLimitTrends(now, windowHours) {
  const windowStartMs = now.getTime() - windowHours * 60 * 60 * 1000;
  /** @type {Map<string, Array<{ snapshot: CocopiRateLimitSnapshot, kind: 'primary' | 'secondary', usedPercent: number, windowLabel: string }>>} */
  const groups = new Map();
  for (const snapshot of cocopiRateLimitSnapshots) {
    const capturedAtMs = Date.parse(snapshot.capturedAt);
    if (!Number.isFinite(capturedAtMs) || capturedAtMs < windowStartMs || capturedAtMs > now.getTime()) {
      continue;
    }
    for (const item of rateLimitTrendItems(snapshot)) {
      const key = `${snapshot.limitId}\0${item.kind}\0${item.windowLabel}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
  }

  const trends = [];
  for (const items of groups.values()) {
    const sorted = items.toSorted((left, right) => left.snapshot.capturedAt.localeCompare(right.snapshot.capturedAt));
    const first = sorted[0];
    const last = sorted.at(-1);
    if (!first || !last || sorted.length < 2) {
      continue;
    }
    const elapsedHours = (Date.parse(last.snapshot.capturedAt) - Date.parse(first.snapshot.capturedAt)) / (60 * 60 * 1000);
    if (elapsedHours <= 0) {
      continue;
    }
    const deltaUsedPercent = last.usedPercent - first.usedPercent;
    const limitId = last.snapshot.limitId ?? "codex";
    trends.push({
      limitId,
      label: last.snapshot.limitName ?? limitId,
      windowLabel: last.windowLabel,
      samples: sorted.length,
      startCapturedAt: first.snapshot.capturedAt,
      endCapturedAt: last.snapshot.capturedAt,
      startUsedPercent: first.usedPercent,
      endUsedPercent: last.usedPercent,
      deltaUsedPercent,
      deltaUsedPercentPerHour: deltaUsedPercent / elapsedHours
    });
  }

  return trends.toSorted((left, right) => right.endCapturedAt.localeCompare(left.endCapturedAt));
}

/**
 * @param {CocopiRateLimitSnapshot} snapshot
 * @returns {Array<{ snapshot: CocopiRateLimitSnapshot, kind: 'primary' | 'secondary', usedPercent: number, windowLabel: string }>}
 */
function rateLimitTrendItems(snapshot) {
  const items = [];
  if (snapshot.primary) {
    items.push({
      snapshot,
      kind: /** @type {'primary'} */ ("primary"),
      usedPercent: snapshot.primary.usedPercent,
      windowLabel: rateLimitWindowTrendLabel(snapshot.primary, "5h")
    });
  }
  if (snapshot.secondary) {
    items.push({
      snapshot,
      kind: /** @type {'secondary'} */ ("secondary"),
      usedPercent: snapshot.secondary.usedPercent,
      windowLabel: rateLimitWindowTrendLabel(snapshot.secondary, "weekly")
    });
  }
  return items;
}

/**
 * @param {CocopiRateLimitWindow} window
 * @param {string} fallback
 */
function rateLimitWindowTrendLabel(window, fallback) {
  if (!window.windowMinutes) {
    return fallback;
  }
  if (window.windowMinutes % (60 * 24 * 7) === 0) {
    const weeks = window.windowMinutes / (60 * 24 * 7);
    return weeks === 1 ? "weekly" : `${weeks}w`;
  }
  if (window.windowMinutes % (60 * 24) === 0) {
    return `${window.windowMinutes / (60 * 24)}d`;
  }
  if (window.windowMinutes % 60 === 0) {
    return `${window.windowMinutes / 60}h`;
  }
  return `${window.windowMinutes}m`;
}

/** @param {CocopiRateLimitSnapshot[]} snapshots */
function latestRateLimitSnapshots(snapshots) {
  /** @type {Map<string, CocopiRateLimitSnapshot>} */
  const latest = new Map();
  for (const snapshot of snapshots.toSorted((left, right) => right.capturedAt.localeCompare(left.capturedAt))) {
    const limitId = snapshot.limitId ?? "codex";
    if (!latest.has(limitId)) {
      latest.set(limitId, snapshot);
    }
  }

  return [...latest.values()];
}

/** @param {Partial<CocopiTokenCacheDebugSummary>} summary */
function uncachedInputTokenCount(summary) {
  return typeof summary.inputTokens === "number" && typeof summary.cachedTokens === "number"
    ? Math.max(0, summary.inputTokens - summary.cachedTokens)
    : undefined;
}

/** @param {Partial<CocopiTokenCacheDebugSummary>} summary */
function classifyTokenCacheTurnKind(summary) {
  if (summary.automaticContinuation === true) {
    return "tool-continuation";
  }

  if (summary.requestKind === "compaction") {
    return "summary-generation";
  }

  if (summary.requestKind === "conversation-summary") {
    if (summary.webSocketContinuationAction === "used" || summary.wireMode === "previous-response") {
      return "summary-replay-continuation";
    }
    if (summary.webSocketContinuationReason === "no-prior-request" || summary.webSocketContinuationReason === "no-prior-response-id") {
      return "summary-replay-cold-baseline";
    }
    if (summary.wireMode === "full") {
      return "summary-replay-rebaseline";
    }
    return "summary-replay";
  }

  return summary.webSocketContinuationAction === "used" || summary.wireMode === "previous-response"
    ? "normal-continuation"
    : "normal-turn";
}

/**
 * @param {Partial<CocopiTokenCacheDebugSummary>} summary
 * @param {number | undefined} uncachedInputTokens
 */
function classifyTokenCacheRisk(summary, uncachedInputTokens) {
  if (summary.cacheStatus === "unknown") {
    return "unknown";
  }

  const uncached = uncachedInputTokens ?? (summary.cacheStatus === "miss" ? summary.inputTokens : undefined);
  if (typeof uncached !== "number") {
    return summary.cacheStatus === "miss" ? "medium" : "unknown";
  }
  if (uncached >= CACHE_RISK_HIGH_UNCACHED_INPUT_TOKENS) {
    return "high";
  }
  if (uncached >= CACHE_RISK_MEDIUM_UNCACHED_INPUT_TOKENS || summary.cacheStatus === "miss") {
    return "medium";
  }
  return "low";
}

/** @param {string | undefined} value */
function normalizeTokenCacheTurnKind(value) {
  return value === "normal-turn"
    || value === "normal-continuation"
    || value === "tool-continuation"
    || value === "summary-generation"
    || value === "summary-replay"
    || value === "summary-replay-cold-baseline"
    || value === "summary-replay-continuation"
    || value === "summary-replay-rebaseline"
    ? value
    : undefined;
}

/** @param {string | undefined} value */
function normalizeTokenCacheRisk(value) {
  return value === "low" || value === "medium" || value === "high" || value === "unknown" ? value : undefined;
}

/** @param {string | undefined} value */
function normalizeWebSocketContinuationAction(value) {
  return value === "used" || value === "skipped" ? value : undefined;
}

/** @param {string | undefined} value */
function normalizeWebSocketContinuationReason(value) {
  return value === "matched-prefix"
    || value === "no-prior-request"
    || value === "no-prior-response-id"
    || value === "explicit-previous-response-id"
    || value === "non-array-input"
    || value === "request-state-changed"
    || value === "input-shorter-than-baseline"
    || value === "input-prefix-mismatch"
    ? value
    : undefined;
}

/** @param {CocopiRateLimitSnapshot[]} snapshots */
function newestRateLimitCapturedAt(snapshots) {
  let newest = 0;
  for (const snapshot of snapshots) {
    const capturedAtMs = Date.parse(snapshot.capturedAt);
    if (Number.isFinite(capturedAtMs)) {
      newest = Math.max(newest, capturedAtMs);
    }
  }

  return newest > 0 ? new Date(newest).toISOString() : undefined;
}
