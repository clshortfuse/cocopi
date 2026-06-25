import test from "node:test";
import assert from "node:assert/strict";

import {
  clearCocopiRateLimitSnapshots,
  clearCocopiRemoteUsageAnalyticsSnapshots,
  clearCocopiTokenCacheDebugSummaries,
  deleteCocopiTokenCacheDebugSession,
  deleteCocopiTokenCacheDebugSessions,
  deleteCocopiTokenCacheDebugSummary,
  initializeCocopiTokenCacheDebugStorage,
  onCocopiTokenCacheDebugSummary,
  readCocopiRateLimitSnapshotHistory,
  readCocopiRateLimitSnapshots,
  readCocopiRemoteUsageAnalyticsSnapshots,
  readCocopiTokenCacheDebugSummaries,
  readCocopiUsageAnalytics,
  readCocopiUsageWindowStatus,
  recordCocopiRateLimitSnapshots,
  recordCocopiRemoteUsageAnalytics,
  recordCocopiTokenCacheSummary
} from "../lib/vscode/token-cache-debug.js";

const COCOPI_TOKEN_CACHE_DEBUG_STORAGE_KEY = "cocopi.diagnostics.tokenTracker.v1";
const COCOPI_RATE_LIMIT_STORAGE_KEY = "cocopi.diagnostics.rateLimits.v1";

test("recordCocopiTokenCacheSummary bills using uncached input plus output", () => {
  clearCocopiTokenCacheDebugSummaries();

  const sessionId = "cocopi-token-cache-session";
  recordCocopiTokenCacheSummary(tokenCacheSummary({
    hostRequestIndex: 1,
    sessionId,
    inputTokens: 100,
    outputTokens: 10,
    cachedTokens: 50
  }));
  recordCocopiTokenCacheSummary(tokenCacheSummary({
    hostRequestIndex: 2,
    sessionId,
    inputTokens: 100,
    outputTokens: 10,
    cachedTokens: 50
  }));

  const entries = readCocopiTokenCacheDebugSummaries();
  const latest = entries.find((entry) => entry.hostRequestIndex === 2);
  const first = entries.find((entry) => entry.hostRequestIndex === 1);

  assert.ok(latest);
  assert.ok(first);

  assert.equal(latest.sessionInitialTokens, 60);
  assert.equal(first.sessionCumulativeTokens, 60);
  assert.equal(latest.sessionCumulativeTokens, 120);
  assert.equal(latest.sessionCumulativeTokens - latest.sessionInitialTokens, 60);
});

test("recordCocopiTokenCacheSummary ignores inconsistent total when input/output are present", () => {
  clearCocopiTokenCacheDebugSummaries();

  const sessionId = "cocopi-token-cache-session";
  recordCocopiTokenCacheSummary(tokenCacheSummary({
    hostRequestIndex: 1,
    sessionId,
    totalTokens: 1000,
    inputTokens: 100,
    outputTokens: 10,
    cachedTokens: 50
  }));

  const entry = readCocopiTokenCacheDebugSummaries().find((item) => item.hostRequestIndex === 1);
  assert.ok(entry);
  assert.equal(entry.billedInputTokens, 50);
  assert.equal(entry.billedOutputTokens, 10);
  assert.equal(entry.billedTotalTokens, 60);
  assert.equal(entry.totalTokens, 1000);
});

test("recordCocopiTokenCacheSummary clamps cached-token subtraction to zero", () => {
  clearCocopiTokenCacheDebugSummaries();

  recordCocopiTokenCacheSummary(tokenCacheSummary({
    hostRequestIndex: 1,
    totalTokens: 100,
    inputTokens: 100,
    outputTokens: 0,
    cachedTokens: 150
  }));

  const entry = readCocopiTokenCacheDebugSummaries().find((item) => item.hostRequestIndex === 1);
  assert.ok(entry);
  assert.equal(entry.sessionInitialTokens, 0);
  assert.equal(entry.sessionCumulativeTokens, 0);
});

test("recordCocopiTokenCacheSummary keeps automatic tool continuations as separate rows", () => {
  clearCocopiTokenCacheDebugSummaries();

  const sessionId = "cocopi-token-cache-session";
  recordCocopiTokenCacheSummary(tokenCacheSummary({
    hostRequestIndex: 3,
    sessionId,
    inputTokens: 1000,
    outputTokens: 100,
    cachedTokens: 900,
    reasoningEffort: "xhigh",
    reasoningSummary: "auto"
  }));
  recordCocopiTokenCacheSummary(tokenCacheSummary({
    hostRequestIndex: 4,
    sessionId,
    inputTokens: 500,
    outputTokens: 50,
    cachedTokens: 400,
    reasoningEffort: "xhigh",
    reasoningSummary: "auto",
    automaticContinuation: true
  }));

  const entries = readCocopiTokenCacheDebugSummaries();
  const continuation = entries.find((entry) => entry.hostRequestIndex === 4);
  const initial = entries.find((entry) => entry.hostRequestIndex === 3);
  assert.equal(entries.length, 2);
  assert.equal(continuation?.automaticContinuation, true);
  assert.equal(continuation?.inputTokens, 500);
  assert.equal(continuation?.outputTokens, 50);
  assert.equal(continuation?.cachedTokens, 400);
  assert.equal(continuation?.billedInputTokens, 100);
  assert.equal(continuation?.billedOutputTokens, 50);
  assert.equal(continuation?.billedTotalTokens, 150);
  assert.equal(continuation?.cacheHitRatio, 50);
  assert.equal(initial?.sessionInitialTokens, 200);
  assert.equal(initial?.sessionCumulativeTokens, 200);
  assert.equal(continuation?.sessionInitialTokens, 200);
  assert.equal(continuation?.sessionCumulativeTokens, 350);

  recordCocopiTokenCacheSummary(tokenCacheSummary({
    hostRequestIndex: 5,
    sessionId,
    inputTokens: 20,
    outputTokens: 5,
    cachedTokens: 0,
    reasoningEffort: "xhigh",
    reasoningSummary: "auto"
  }));

  assert.equal(readCocopiTokenCacheDebugSummaries().length, 3);
});

test("recordCocopiTokenCacheSummary classifies compaction cache risk", () => {
  clearCocopiTokenCacheDebugSummaries();

  recordCocopiTokenCacheSummary(tokenCacheSummary({
    hostRequestIndex: 1,
    requestKind: "conversation-summary",
    wireMode: "full",
    inputTokens: 125_280,
    outputTokens: 133,
    cachedTokens: 0,
    cacheStatus: "miss",
    cacheHitRatio: 0,
    webSocketContinuationAction: "skipped",
    webSocketContinuationReason: "no-prior-request"
  }));
  recordCocopiTokenCacheSummary(tokenCacheSummary({
    hostRequestIndex: 2,
    requestKind: "conversation-summary",
    wireMode: "previous-response",
    inputTokens: 217_966,
    outputTokens: 289,
    cachedTokens: 217_600,
    cacheHitRatio: 99.8,
    webSocketContinuationAction: "used",
    webSocketContinuationReason: "matched-prefix"
  }));

  const entries = readCocopiTokenCacheDebugSummaries();
  const coldBaseline = entries.find((entry) => entry.hostRequestIndex === 1);
  const continuation = entries.find((entry) => entry.hostRequestIndex === 2);

  assert.equal(coldBaseline?.turnKind, "summary-replay-cold-baseline");
  assert.equal(coldBaseline?.cacheRisk, "high");
  assert.equal(coldBaseline?.uncachedInputTokens, 125_280);
  assert.equal(coldBaseline?.webSocketContinuationAction, "skipped");
  assert.equal(coldBaseline?.webSocketContinuationReason, "no-prior-request");
  assert.equal(continuation?.turnKind, "summary-replay-continuation");
  assert.equal(continuation?.cacheRisk, "low");
  assert.equal(continuation?.uncachedInputTokens, 366);
});

test("token tracker persists records and deletion in private storage", async () => {
  const secrets = fakeSecretStorage();
  await initializeCocopiTokenCacheDebugStorage(secrets);
  clearCocopiTokenCacheDebugSummaries();

  recordCocopiTokenCacheSummary(tokenCacheSummary({ hostRequestIndex: 1, sessionId: "session-a", cachedTokens: 10 }));
  recordCocopiTokenCacheSummary(tokenCacheSummary({ hostRequestIndex: 2, sessionId: "session-b", cachedTokens: 20 }));
  await Promise.resolve();

  const persisted = JSON.parse(secrets.values.get(COCOPI_TOKEN_CACHE_DEBUG_STORAGE_KEY) ?? "[]");
  assert.equal(persisted.length, 2);
  assert.equal(persisted[0].sessionId, "session-b");

  assert.equal(deleteCocopiTokenCacheDebugSummary(persisted[0].id), true);
  await Promise.resolve();
  assert.equal(JSON.parse(secrets.values.get(COCOPI_TOKEN_CACHE_DEBUG_STORAGE_KEY) ?? "[]").length, 1);

  assert.equal(deleteCocopiTokenCacheDebugSession("session-a"), true);
  await Promise.resolve();
  assert.deepEqual(JSON.parse(secrets.values.get(COCOPI_TOKEN_CACHE_DEBUG_STORAGE_KEY) ?? "[]"), []);
});

test("token tracker preserves in-memory records when storage loads", async () => {
  clearCocopiTokenCacheDebugSummaries();
  recordCocopiTokenCacheSummary(tokenCacheSummary({ hostRequestIndex: 1, sessionId: "live-session", cachedTokens: 10 }));

  const secrets = fakeSecretStorage(new Map([[COCOPI_TOKEN_CACHE_DEBUG_STORAGE_KEY, JSON.stringify([
    storedTokenCacheSummary({
      id: 1,
      recordedAt: "2026-04-30T10:00:00.000Z",
      hostRequestIndex: 2,
      billedTotalTokens: 250
    })
  ])]]));
  await initializeCocopiTokenCacheDebugStorage(secrets);

  const summaries = readCocopiTokenCacheDebugSummaries();
  assert.deepEqual(summaries.map((entry) => entry.sessionId).toSorted(), ["cocopi-language-model-test", "live-session"]);
  assert.equal(new Set(summaries.map((entry) => entry.id)).size, 2);

  clearCocopiTokenCacheDebugSummaries();
});

test("token tracker summary listeners cannot mutate stored records", () => {
  clearCocopiTokenCacheDebugSummaries();
  const unsubscribe = onCocopiTokenCacheDebugSummary((summary) => {
    summary.model = "mutated-model";
  });

  recordCocopiTokenCacheSummary(tokenCacheSummary({ hostRequestIndex: 1, sessionId: "clone-session", cachedTokens: 10 }));
  unsubscribe();

  assert.equal(readCocopiTokenCacheDebugSummaries()[0]?.model, "gpt-test");
});

test("token tracker deletes multiple sessions at once", () => {
  clearCocopiTokenCacheDebugSummaries();

  recordCocopiTokenCacheSummary(tokenCacheSummary({ hostRequestIndex: 1, sessionId: "session-a", cachedTokens: 10 }));
  recordCocopiTokenCacheSummary(tokenCacheSummary({ hostRequestIndex: 2, sessionId: "session-b", cachedTokens: 20 }));
  recordCocopiTokenCacheSummary(tokenCacheSummary({ hostRequestIndex: 3, sessionId: "session-a", cachedTokens: 30 }));
  recordCocopiTokenCacheSummary(tokenCacheSummary({ hostRequestIndex: 4, sessionId: "session-c", cachedTokens: 40 }));

  assert.equal(deleteCocopiTokenCacheDebugSessions(["session-a", "session-c", "session-missing"]), 3);
  assert.deepEqual(readCocopiTokenCacheDebugSummaries().map((entry) => entry.sessionId), ["session-b"]);
  assert.equal(deleteCocopiTokenCacheDebugSessions(["session-a"]), 0);
});

test("token tracker loads stored records and continues ids", async () => {
  clearCocopiTokenCacheDebugSummaries();
  const secrets = fakeSecretStorage(new Map([[COCOPI_TOKEN_CACHE_DEBUG_STORAGE_KEY, JSON.stringify([{
    id: 11,
    recordedAt: "2026-04-29T00:00:00.000Z",
    source: "language-model",
    hostRequestIndex: 1,
    sessionId: "stored-session",
    model: "gpt-test",
    inputItems: 1,
    cacheStatus: "hit"
  }])]]));

  await initializeCocopiTokenCacheDebugStorage(secrets);
  assert.equal(readCocopiTokenCacheDebugSummaries()[0]?.sessionId, "stored-session");

  recordCocopiTokenCacheSummary(tokenCacheSummary({ hostRequestIndex: 2, cachedTokens: 10 }));
  assert.equal(readCocopiTokenCacheDebugSummaries()[0]?.id, 12);

  clearCocopiTokenCacheDebugSummaries();
});

test("token tracker stores effective request configuration", () => {
  clearCocopiTokenCacheDebugSummaries();

  recordCocopiTokenCacheSummary(tokenCacheSummary({
    hostRequestIndex: 1,
    cachedTokens: 10,
    selectedModel: "gpt-test:fast",
    serviceTier: "priority",
    serviceTierSource: "model",
    reasoningEffort: "xhigh",
    reasoningSummary: "detailed",
    fastRequested: true
  }));

  const [entry] = readCocopiTokenCacheDebugSummaries();
  assert.equal(entry?.selectedModel, "gpt-test:fast");
  assert.equal(entry?.serviceTier, "priority");
  assert.equal(entry?.serviceTierSource, "model");
  assert.equal(entry?.reasoningEffort, "xhigh");
  assert.equal(entry?.reasoningSummary, "detailed");
  assert.equal(entry?.fastRequested, true);
});

test("token tracker stores continuation mismatch diagnostics", () => {
  clearCocopiTokenCacheDebugSummaries();

  recordCocopiTokenCacheSummary({
    ...tokenCacheSummary({
      hostRequestIndex: 1,
      cachedTokens: 0,
      webSocketContinuationAction: "skipped",
      webSocketContinuationReason: "input-prefix-mismatch"
    }),
    webSocketContinuationMatchingItems: 12,
    webSocketContinuationMismatchIndex: 13,
    webSocketContinuationExpected: "message:assistant:content=1:output_text:text:4ch/sha256:expected",
    webSocketContinuationActual: "function_call_output:call=sha256:call:output=5ch/sha256:actual",
    webSocketContinuationExpectedDigest: "sha256:expected",
    webSocketContinuationActualDigest: "sha256:actual"
  });

  const [entry] = readCocopiTokenCacheDebugSummaries();
  assert.equal(entry?.webSocketContinuationMatchingItems, 12);
  assert.equal(entry?.webSocketContinuationMismatchIndex, 13);
  assert.equal(entry?.webSocketContinuationExpectedDigest, "sha256:expected");
  assert.equal(entry?.webSocketContinuationActualDigest, "sha256:actual");
});

test("readCocopiUsageWindowStatus reports recent local token activity", async () => {
  const secrets = fakeSecretStorage(new Map([[COCOPI_TOKEN_CACHE_DEBUG_STORAGE_KEY, JSON.stringify([
    storedTokenCacheSummary({
      id: 1,
      recordedAt: "2026-04-30T10:00:00.000Z",
      hostRequestIndex: 1,
      billedTotalTokens: 1000
    }),
    storedTokenCacheSummary({
      id: 2,
      recordedAt: "2026-04-30T12:00:00.000Z",
      hostRequestIndex: 2,
      billedTotalTokens: 1500
    }),
    storedTokenCacheSummary({
      id: 3,
      recordedAt: "2026-04-30T03:00:00.000Z",
      hostRequestIndex: 3,
      billedTotalTokens: 9999
    })
  ])]]));
  await initializeCocopiTokenCacheDebugStorage(secrets);
  clearCocopiRateLimitSnapshots();

  const status = readCocopiUsageWindowStatus({
    now: new Date("2026-04-30T13:00:00.000Z")
  });

  assert.equal(status.requestCount, 2);
  assert.equal(status.billableTokens, 2500);
  assert.equal(Math.round(status.averageTokensPerHour), 833);
  assert.equal(Math.round(status.projectedWindowTokens), 4167);
  assert.equal(status.source, "local");

  clearCocopiTokenCacheDebugSummaries();
});

test("rate limit snapshots persist and make usage status API-backed", async () => {
  const secrets = fakeSecretStorage();
  await initializeCocopiTokenCacheDebugStorage(secrets);
  clearCocopiRateLimitSnapshots();

  recordCocopiRateLimitSnapshots({
    limitId: "codex",
    primary: {
      usedPercent: 25,
      windowMinutes: 300,
      resetsAt: 1_700_000_000
    },
    secondary: {
      usedPercent: 10,
      windowMinutes: 10_080
    },
    credits: {
      hasCredits: true,
      unlimited: false,
      balance: "5"
    },
    planType: "pro"
  }, {
    capturedAt: new Date("2026-04-30T13:00:00.000Z")
  });
  await Promise.resolve();

  const persisted = JSON.parse(secrets.values.get(COCOPI_RATE_LIMIT_STORAGE_KEY) ?? "[]");
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].primary.usedPercent, 25);

  const status = readCocopiUsageWindowStatus({
    now: new Date("2026-04-30T13:10:00.000Z")
  });
  assert.equal(status.source, "api");
  assert.equal(status.apiCapturedAt, "2026-04-30T13:00:00.000Z");
  assert.equal(status.apiRateLimits[0]?.primary?.usedPercent, 25);

  clearCocopiRateLimitSnapshots();
});

test("usage analytics aggregates local rows and quota depletion over time", async () => {
  clearCocopiTokenCacheDebugSummaries();
  const secrets = fakeSecretStorage(new Map([[COCOPI_TOKEN_CACHE_DEBUG_STORAGE_KEY, JSON.stringify([
    storedTokenCacheSummary({
      id: 1,
      recordedAt: "2026-04-30T10:00:00.000Z",
      hostRequestIndex: 1,
      sessionId: "session-a",
      selectedModel: "gpt-a",
      reasoningEffort: "high",
      reasoningSummary: "auto",
      billedTotalTokens: 1000,
      inputTokens: 1200,
      outputTokens: 100,
      cachedTokens: 300,
      requestDurationMs: 2000,
      firstOutputLatencyMs: 500
    }),
    storedTokenCacheSummary({
      id: 2,
      recordedAt: "2026-04-30T12:00:00.000Z",
      hostRequestIndex: 2,
      sessionId: "session-a",
      selectedModel: "gpt-b",
      reasoningEffort: "low",
      reasoningSummary: "concise",
      billedTotalTokens: 1500,
      inputTokens: 1800,
      outputTokens: 200,
      cachedTokens: 500,
      requestDurationMs: 4000,
      firstOutputLatencyMs: 1000
    })
  ])]]));
  await initializeCocopiTokenCacheDebugStorage(secrets);
  clearCocopiRateLimitSnapshots();

  recordCocopiRateLimitSnapshots({
    limitId: "codex",
    limitName: "codex",
    primary: {
      usedPercent: 25,
      windowMinutes: 300
    }
  }, {
    capturedAt: new Date("2026-04-30T10:00:00.000Z")
  });
  recordCocopiRateLimitSnapshots({
    limitId: "codex",
    limitName: "codex",
    primary: {
      usedPercent: 35,
      windowMinutes: 300
    },
    secondary: {
      usedPercent: 40,
      windowMinutes: 10_080,
      resetsAt: 1_777_640_400
    }
  }, {
    capturedAt: new Date("2026-04-30T12:00:00.000Z")
  });
  recordCocopiRemoteUsageAnalytics({
    startDate: "2026-04-01",
    endDate: "2026-04-30",
    tokenUnits: "tokens",
    tokenGroupBy: "day",
    dailyTokenUsage: [{
      date: "2026-04-30",
      productSurfaceUsageValues: {
        vscode: 500,
        cli: 250
      }
    }],
    workspaceGroupBy: "day",
    dailyWorkspaceUsage: [{
      date: "2026-04-30",
      totals: {
        turns: 4,
        textTotalTokens: 750
      },
      clients: [{
        clientId: "vscode",
        turns: 3,
        textTotalTokens: 500
      }, {
        clientId: "cli",
        turns: 1,
        textTotalTokens: 250
      }]
    }]
  }, {
    capturedAt: new Date("2026-04-30T12:30:00.000Z")
  });

  const analytics = readCocopiUsageAnalytics({
    now: new Date("2026-04-30T13:00:00.000Z"),
    timelineDays: 3
  });
  const fiveHour = analytics.windows.find((window) => window.label === "5h");
  const expectedTimelineStart = new Date("2026-04-30T13:00:00.000Z");
  expectedTimelineStart.setDate(expectedTimelineStart.getDate() - 3);
  assert.equal(fiveHour?.requestCount, 2);
  assert.equal(fiveHour?.billableTokens, 2500);
  assert.equal(fiveHour?.uncachedInputTokens, 2200);
  assert.equal(fiveHour?.averageLatencyMs, 3000);
  assert.equal(fiveHour?.averageFirstOutputLatencyMs, 750);
  assert.equal(fiveHour?.outputTokensPerSecond, 50);
  assert.equal(analytics.timeline.label, "3d by 60m");
  assert.equal(analytics.timeline.windowStart, expectedTimelineStart.toISOString());
  assert.equal(analytics.timeline.buckets.reduce((total, bucket) => total + bucket.requestCount, 0), 2);
  assert.equal(analytics.timeline.buckets.reduce((total, bucket) => total + bucket.billableTokens, 0), 2500);
  assert.deepEqual(analytics.timeline.series.map((series) => series.label), [
    "gpt-a · high",
    "gpt-b · low"
  ]);
  assert.deepEqual(analytics.timeline.series.map((series) => series.billableTokens), [1000, 1500]);
  assert.equal(analytics.weeklyCycle.source, "rate-limit-reset");
  assert.equal(analytics.weeklyCycle.sourceLabel, "Regular weekly");
  assert.equal(analytics.weeklyCycle.cycleStart, "2026-04-24T13:00:00.000Z");
  assert.equal(analytics.weeklyCycle.cycleEnd, "2026-05-01T13:00:00.000Z");
  assert.equal(analytics.weeklyCycle.requestCount, 2);
  assert.equal(analytics.weeklyCycle.usageKnownRequestCount, 2);
  assert.equal(analytics.weeklyCycle.inputTokens, 3000);
  assert.equal(analytics.weeklyCycle.cachedInputTokens, 800);
  assert.equal(analytics.weeklyCycle.uncachedInputTokens, 2200);
  assert.equal(analytics.weeklyCycle.outputTokens, 300);
  assert.equal(analytics.weeklyCycle.apiMeteredTokens, 2500);
  assert.equal(Math.round(analytics.weeklyCycle.outputTokensPerDay), 50);
  assert.equal(analytics.weeklyCycle.projectedOutputTokens, 350);
  assert.equal(analytics.weeklyCycle.projectedUncachedInputTokens, 2567);
  assert.equal(analytics.weeklyCycle.projectedApiMeteredTokens, 2917);
  assert.deepEqual(analytics.weeklyCycle.models.map((model) => [model.label, model.apiMeteredTokens]), [
    ["gpt-b · low", 1500],
    ["gpt-a · high", 1000]
  ]);
  assert.equal(analytics.sessions[0]?.sessionId, "session-a");
  assert.equal(analytics.sessions[0]?.billableTokens, 2500);
  assert.equal(analytics.rateLimitTrends[0]?.deltaUsedPercent, 10);
  assert.equal(analytics.rateLimitTrends[0]?.deltaUsedPercentPerHour, 5);
  assert.equal(analytics.remoteUsageAnalytics?.dailyTokenUsage[0]?.productSurfaceUsageValues.vscode, 500);
  assert.equal(analytics.remoteUsageAnalytics?.dailyWorkspaceUsage[0]?.clients[1]?.clientId, "cli");
  assert.equal(readCocopiRateLimitSnapshots().length, 1);
  assert.equal(readCocopiRateLimitSnapshotHistory().length, 2);
  assert.equal(readCocopiRemoteUsageAnalyticsSnapshots().length, 1);

  clearCocopiTokenCacheDebugSummaries();
  clearCocopiRateLimitSnapshots();
  clearCocopiRemoteUsageAnalyticsSnapshots();
});

test("rate limit snapshots load from private storage", async () => {
  const secrets = fakeSecretStorage(new Map([[COCOPI_RATE_LIMIT_STORAGE_KEY, JSON.stringify([{
    capturedAt: "2026-04-30T13:00:00.000Z",
    limitId: "codex",
    primary: {
      usedPercent: 75,
      windowMinutes: 300
    }
  }])]]));

  await initializeCocopiTokenCacheDebugStorage(secrets);
  assert.equal(readCocopiRateLimitSnapshots()[0]?.primary?.usedPercent, 75);

  clearCocopiRateLimitSnapshots();
});

/** @param {{ hostRequestIndex: number, sessionId?: string, totalTokens?: number, inputTokens?: number, outputTokens?: number, cachedTokens: number, cacheStatus?: 'hit' | 'miss' | 'unknown', cacheHitRatio?: number, selectedModel?: string, serviceTier?: string, serviceTierSource?: string, reasoningEffort?: string, reasoningSummary?: string, fastRequested?: boolean, automaticContinuation?: boolean, requestKind?: string, wireMode?: string, webSocketContinuationAction?: import("../data/Codex.js").CodexPreviousResponseDecisionAction, webSocketContinuationReason?: import("../data/Codex.js").CodexPreviousResponseDecisionReason, requestDurationMs?: number, firstOutputLatencyMs?: number }} options */
function tokenCacheSummary(options) {
  return {
    id: options.hostRequestIndex,
    recordedAt: "2026-04-27T00:00:00.000Z",
    source: /** @type {"chat" | "language-model"} */ ("language-model"),
    hostRequestIndex: options.hostRequestIndex,
    sessionId: options.sessionId ?? "cocopi-language-model-test",
    model: "gpt-test",
    selectedModel: options.selectedModel,
    inputItems: 1,
    stateRestored: false,
    requestMessages: 1,
    requestTextParts: 1,
    requestToolCallParts: 0,
    requestToolResultParts: 0,
    requestDataParts: 0,
    requestCocopiDataParts: 0,
    requestCocopiDataBytes: 0,
    requestDataMimeTypes: "-",
    transport: "sse",
    serviceTier: options.serviceTier,
    serviceTierSource: options.serviceTierSource,
    reasoningEffort: options.reasoningEffort,
    reasoningSummary: options.reasoningSummary,
    fastRequested: options.fastRequested,
    automaticContinuation: options.automaticContinuation,
    promptCacheKey: options.sessionId ?? "cocopi-language-model-test",
    requestKind: options.requestKind,
    wireMode: options.wireMode,
    webSocketContinuationAction: options.webSocketContinuationAction,
    webSocketContinuationReason: options.webSocketContinuationReason,
    responseId: "resp-test",
    inputTokens: options.inputTokens ?? 90,
    outputTokens: options.outputTokens ?? 20,
    requestDurationMs: options.requestDurationMs,
    firstOutputLatencyMs: options.firstOutputLatencyMs,
    reasoningTokens: 0,
    totalTokens: options.totalTokens,
    cachedTokens: options.cachedTokens,
    cacheStatus: options.cacheStatus ?? /** @type {"unknown" | "hit" | "miss"} */ ("hit"),
    cacheHitRatio: options.cacheHitRatio ?? 50
  };
}

/** @param {{ id: number, recordedAt: string, hostRequestIndex: number, billedTotalTokens: number, sessionId?: string, selectedModel?: string, reasoningEffort?: string, reasoningSummary?: string, inputTokens?: number, outputTokens?: number, cachedTokens?: number, requestDurationMs?: number, firstOutputLatencyMs?: number }} options */
function storedTokenCacheSummary(options) {
  return {
    ...tokenCacheSummary({
      hostRequestIndex: options.hostRequestIndex,
      sessionId: options.sessionId,
      selectedModel: options.selectedModel,
      reasoningEffort: options.reasoningEffort,
      reasoningSummary: options.reasoningSummary,
      inputTokens: options.inputTokens ?? options.billedTotalTokens,
      outputTokens: options.outputTokens ?? 0,
      cachedTokens: options.cachedTokens ?? 0,
      requestDurationMs: options.requestDurationMs,
      firstOutputLatencyMs: options.firstOutputLatencyMs
    }),
    id: options.id,
    recordedAt: options.recordedAt,
    billedInputTokens: options.billedTotalTokens,
    billedOutputTokens: 0,
    billedTotalTokens: options.billedTotalTokens
  };
}

/** @param {Map<string, string>} [values] */
function fakeSecretStorage(values = new Map()) {
  return {
    values,
    /** @param {string} key */
    async get(key) {
      return values.get(key);
    },
    /**
     * @param {string} key
     * @param {string} value
     */
    async store(key, value) {
      values.set(key, value);
    },
    /** @param {string} key */
    async delete(key) {
      values.delete(key);
    }
  };
}
