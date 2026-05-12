import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";

import { refreshCodexTokens } from "../lib/auth/oauth.js";
import { codexConfigFromEnv } from "../lib/codex-api/config.js";
import { chooseCodexModel, listCodexModels } from "../lib/codex-api/models.js";
import { fetchCodexRateLimits, fetchCodexUsageAnalytics } from "../lib/codex-api/rate-limits.js";
import { buildTextResponseBody } from "../lib/codex-api/response-body.js";
import { collectCodexResponseFromEvents, fetchCodexResponseStream } from "../lib/codex-api/responses.js";
import { fetchCodexResponseWebSocketStream } from "../lib/codex-api/websocket.js";
import { codexTokenMetadata } from "../lib/auth/token.js";
import { parseEnvFile, upsertEnvValues } from "../lib/utils/env-file.js";

const env = { ...(await readEnvForLiveTests()), ...process.env };
const liveSkipReason = liveTestSkipReason(env);
const LIVE_CODEX_MODEL = "gpt-5.3-codex-spark";
const ENV_PATH = ".env";
/** @type {Promise<{ accessToken: string, idToken?: string }> | undefined} */
let liveTokenRefresh;

test("live Codex models smoke", { skip: liveSkipReason }, async () => {
  const { models } = await readLiveCodexClient();
  assert.ok(models.length > 0, "expected at least one Codex model");

  const model = chooseLiveCodexModel(models);
  assert.equal(model, LIVE_CODEX_MODEL);
});

test("live Codex usage limits smoke", { skip: liveSkipReason }, async (context) => {
  const { config, accessToken, metadata } = await readLiveCodexClient();

  const snapshots = await fetchCodexRateLimits({
    apiBaseUrl: config.apiBaseUrl,
    accessToken,
    chatgptAccountId: metadata.chatgptAccountId
  });

  assert.ok(snapshots.length > 0, "expected at least one usage snapshot");
  assert.ok(
    snapshots.some((snapshot) => snapshot.primary || snapshot.secondary || snapshot.credits || snapshot.planType),
    "expected a usage snapshot with limit, credit, or plan data"
  );
  context.diagnostic(`Codex usage snapshots: ${snapshots.map((snapshot) => formatUsageSnapshotDiagnostic(snapshot)).join("; ")}`);
});

test("live Codex account usage analytics smoke", { skip: liveSkipReason }, async (context) => {
  const { config, accessToken, metadata } = await readLiveCodexClient();

  const analytics = await fetchCodexUsageAnalytics({
    apiBaseUrl: config.apiBaseUrl,
    accessToken,
    chatgptAccountId: metadata.chatgptAccountId
  });

  assert.equal(typeof analytics.startDate, "string");
  assert.equal(typeof analytics.endDate, "string");
  assert.ok(Array.isArray(analytics.dailyTokenUsage), "expected daily token usage array");
  assert.ok(Array.isArray(analytics.dailyWorkspaceUsage), "expected daily workspace usage array");
  assert.ok(
    analytics.dailyTokenUsage.length > 0 || analytics.dailyWorkspaceUsage.length > 0,
    "expected at least one account analytics row"
  );
  context.diagnostic(formatUsageAnalyticsDiagnostic(analytics));
});

test("live Codex Responses ISO datetime", { skip: liveSkipReason }, async (context) => {
  const { config, accessToken, metadata, models } = await readLiveCodexClient();
  const model = chooseLiveCodexModel(models);

  const response = await collectCodexResponseFromEvents(await fetchCodexResponseStream({
    apiBaseUrl: config.apiBaseUrl,
    accessToken,
    chatgptAccountId: metadata.chatgptAccountId,
    body: buildTextResponseBody({
      model,
      input: "Tell me the current datetime in ISO 8601 format. Return only the datetime string.",
      instructions: "Return exactly the requested ISO 8601 datetime string and nothing else.",
      promptCacheKey: "cocopi-live-smoke",
      clientMetadata: { "x-codex-installation-id": "cocopi-live-smoke" }
    })
  }));

  assert.ok(response && typeof response === "object", "expected a response object");
  const outputText = response.output_text ?? "";
  context.diagnostic(`AI response: ${outputText}`);
  assert.match(outputText, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u);
});

test("live Codex Responses WebSocket reports prompt-cache hits", { skip: liveSkipReason }, async (context) => {
  const { config, accessToken, metadata, models } = await readLiveCodexClient();
  const model = chooseLiveCodexModel(models);
  const promptCacheKey = env.COCOPI_LIVE_CACHE_KEY || "cocopi-live-websocket-cache";
  const body = buildTextResponseBody({
    model,
    input: liveCachePrompt(),
    instructions: "Return exactly the requested marker string and nothing else.",
    promptCacheKey,
    clientMetadata: { "x-codex-installation-id": "cocopi-live-websocket-cache" }
  });

  const warmup = await collectCodexResponseFromEvents(await fetchCodexResponseWebSocketStream({
    apiBaseUrl: config.apiBaseUrl,
    accessToken,
    chatgptAccountId: metadata.chatgptAccountId,
    body,
    idleTimeoutMs: 120_000
  }));
  context.diagnostic(formatCacheDiagnostic("warmup", warmup));

  /** @type {import("../data/Codex.js").CodexResponse} */
  let cached = warmup;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    cached = await collectCodexResponseFromEvents(await fetchCodexResponseWebSocketStream({
      apiBaseUrl: config.apiBaseUrl,
      accessToken,
      chatgptAccountId: metadata.chatgptAccountId,
      body,
      idleTimeoutMs: 120_000
    }));
    context.diagnostic(formatCacheDiagnostic(`cache-check-${attempt}`, cached));
    if ((readCachedTokens(cached) ?? 0) > 0) {
      break;
    }
  }

  assert.equal(normalizeOutputText(warmup.output_text), "cache-ok");
  assert.equal(normalizeOutputText(cached.output_text), "cache-ok");
  assert.ok(readCachedTokens(cached) !== undefined, "expected cached token usage in completed response");
  assert.ok((readCachedTokens(cached) ?? 0) > 0, "expected the repeated WebSocket request to report cached tokens");
});

async function readLiveCodexClient() {
  const config = codexConfigFromEnv(env);
  const tokens = {
    accessToken: env.CODEX_CHATGPT_ACCESS_TOKEN ?? "",
    idToken: env.CODEX_CHATGPT_ID_TOKEN
  };

  try {
    return await readLiveCodexClientWithTokens(config, tokens);
  } catch (error) {
    if (!(error instanceof Error) || !isCodexAuthError(error) || !env.CODEX_CHATGPT_REFRESH_TOKEN) {
      throw error;
    }
  }

  return readLiveCodexClientWithTokens(config, await refreshLiveTokens());
}

/**
 * @param {ReturnType<typeof codexConfigFromEnv>} config
 * @param {{ accessToken: string, idToken?: string }} tokens
 */
async function readLiveCodexClientWithTokens(config, tokens) {
  const metadata = codexTokenMetadata({
    idToken: tokens.idToken,
    accessToken: tokens.accessToken,
    explicitAccountId: config.chatgptAccountId
  });

  const models = await listCodexModels({
    apiBaseUrl: config.apiBaseUrl,
    accessToken: tokens.accessToken,
    chatgptAccountId: metadata.chatgptAccountId,
    clientVersion: config.clientVersion
  });
  return { config, accessToken: tokens.accessToken, metadata, models };
}

async function refreshLiveTokens() {
  liveTokenRefresh ??= refreshLiveTokensOnce();
  return liveTokenRefresh;
}

async function refreshLiveTokensOnce() {
  const tokens = await refreshCodexTokens({
    issuer: env.CODEX_AUTH_ISSUER,
    refreshToken: env.CODEX_CHATGPT_REFRESH_TOKEN ?? ""
  });
  env.CODEX_CHATGPT_ACCESS_TOKEN = tokens.accessToken;
  env.CODEX_CHATGPT_REFRESH_TOKEN = tokens.refreshToken;
  env.CODEX_CHATGPT_ID_TOKEN = tokens.idToken;

  const metadata = codexTokenMetadata({
    idToken: tokens.idToken,
    accessToken: tokens.accessToken
  });
  if (metadata.chatgptAccountId) {
    env.CODEX_CHATGPT_ACCOUNT_ID = metadata.chatgptAccountId;
  }
  if (metadata.chatgptPlanType) {
    env.CODEX_CHATGPT_PLAN_TYPE = metadata.chatgptPlanType;
  }

  /** @type {Record<string, string>} */
  const updates = {
    CODEX_CHATGPT_ACCESS_TOKEN: tokens.accessToken,
    CODEX_CHATGPT_REFRESH_TOKEN: tokens.refreshToken,
    CODEX_CHATGPT_ID_TOKEN: tokens.idToken
  };
  if (metadata.chatgptAccountId) {
    updates.CODEX_CHATGPT_ACCOUNT_ID = metadata.chatgptAccountId;
  }
  if (metadata.chatgptPlanType) {
    updates.CODEX_CHATGPT_PLAN_TYPE = metadata.chatgptPlanType;
  }

  const envText = await readFile(ENV_PATH, "utf8").catch(() => "");
  await writeFile(ENV_PATH, upsertEnvValues(envText, updates), "utf8");
  return { accessToken: tokens.accessToken, idToken: tokens.idToken };
}

/**
 * @param {import("../data/Codex.js").CodexModelSummary[]} models
 */
function chooseLiveCodexModel(models) {
  const model = chooseCodexModel(models, LIVE_CODEX_MODEL);
  if (model !== LIVE_CODEX_MODEL) {
    throw new Error(`Live tests require ${LIVE_CODEX_MODEL}; available models: ${models.map((entry) => entry.id).join(", ")}`);
  }

  return model;
}

async function readEnvForLiveTests() {
  try {
    return parseEnvFile(await readFile(".env", "utf8"));
  } catch {
    return {};
  }
}

/**
 * @param {Record<string, string | undefined>} liveEnv
 * @returns {false | string}
 */
function liveTestSkipReason(liveEnv) {
  if (!liveEnv.CODEX_CHATGPT_ACCESS_TOKEN) {
    return "missing CODEX_CHATGPT_ACCESS_TOKEN in .env";
  }

  return false;
}

/** @param {Error} error */
function isCodexAuthError(error) {
  return error instanceof Error && /\bstatus 401\b|token_invalidated|token refresh failed/u.test(error.message);
}

function liveCachePrompt() {
  const corpus = Array.from({ length: 320 }, (_, index) => {
    const id = String(index + 1).padStart(3, "0");
    return `Cache probe ${id}: this deterministic line is repeated only to make prompt-cache token accounting visible.`;
  }).join("\n");

  return [
    "Read the deterministic cache probe corpus below.",
    "Do not summarize it.",
    "Return exactly: cache-ok",
    "",
    corpus
  ].join("\n");
}

/**
 * @param {string} label
 * @param {import("../data/Codex.js").CodexResponse} response
 */
function formatCacheDiagnostic(label, response) {
  return [
    label,
    `id=${response.id ?? "unknown"}`,
    `promptCacheKey=${readResponsePromptCacheKey(response) ?? "unknown"}`,
    `cachedTokens=${readCachedTokens(response) ?? "unknown"}`,
    `output=${normalizeOutputText(response.output_text)}`
  ].join(" ");
}

/** @param {import("../lib/codex-api/rate-limits.js").CodexRateLimitSnapshot} snapshot */
function formatUsageSnapshotDiagnostic(snapshot) {
  return [
    snapshot.limitId ?? "unknown",
    snapshot.planType ? `plan=${snapshot.planType}` : undefined,
    snapshot.primary ? `primary=${Math.round(snapshot.primary.usedPercent)}%` : undefined,
    snapshot.secondary ? `secondary=${Math.round(snapshot.secondary.usedPercent)}%` : undefined,
    snapshot.credits?.hasCredits ? "credits=available" : undefined
  ].filter(Boolean).join(" ");
}

/** @param {import("../lib/codex-api/rate-limits.js").CodexUsageAnalyticsSnapshot} analytics */
function formatUsageAnalyticsDiagnostic(analytics) {
  const surfaces = [...new Set(analytics.dailyTokenUsage.flatMap((item) => Object.keys(item.productSurfaceUsageValues)))].toSorted();
  const clients = [...new Set(analytics.dailyWorkspaceUsage.flatMap((item) => item.clients.map((client) => client.clientId)))].toSorted();
  return [
    `range=${analytics.startDate}..${analytics.endDate}`,
    `tokenRows=${analytics.dailyTokenUsage.length}`,
    `workspaceRows=${analytics.dailyWorkspaceUsage.length}`,
    `surfaces=${surfaces.slice(0, 8).join(",") || "none"}`,
    `clients=${clients.slice(0, 8).join(",") || "none"}`
  ].join(" ");
}

/**
 * @param {import("../data/Codex.js").CodexResponse} response
 * @returns {number | undefined}
 */
function readCachedTokens(response) {
  const usage = readRecordProperty(response, "usage");
  if (!usage) {
    return;
  }

  return readNestedNumber(usage, ["input_tokens_details", "cached_tokens"])
    ?? readNestedNumber(usage, ["prompt_tokens_details", "cached_tokens"])
    ?? readNumber(usage.cached_tokens);
}

/**
 * @param {import("../data/Codex.js").CodexResponse} response
 */
function readResponsePromptCacheKey(response) {
  const value = readRecordProperty(response, "prompt_cache_key");
  return typeof value === "string" ? value : undefined;
}

/**
 * @param {Record<string, import("../data/Codex.js").CodexJsonValue>} object
 * @param {string} key
 */
function readRecordProperty(object, key) {
  const value = Reflect.get(object, key);
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, import("../data/Codex.js").CodexJsonValue>} */ (value)
    : undefined;
}

/**
 * @param {Record<string, import("../data/Codex.js").CodexJsonValue>} object
 * @param {string[]} path
 */
function readNestedNumber(object, path) {
  /** @type {Record<string, import("../data/Codex.js").CodexJsonValue> | undefined} */
  let cursor = object;
  for (let index = 0; index < path.length - 1; index += 1) {
    cursor = readRecordProperty(cursor, path[index]);
    if (!cursor) {
      return;
    }
  }

  return readNumber(cursor[path.at(-1) ?? ""]);
}

/** @param {import("../data/Codex.js").CodexJsonValue} value */
function readNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** @param {string | undefined} value */
function normalizeOutputText(value) {
  return (value ?? "").trim().toLowerCase();
}
