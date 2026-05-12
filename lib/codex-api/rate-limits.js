import { codexAuthHeaders } from "./codex-headers.js";
import { fetchWithRetries, readJsonResponse } from "../utils/http.js";

/** @typedef {import("../../data/Codex.js").CodexJsonValue} CodexJsonValue */

/**
 * @typedef {object} CodexRateLimitWindow
 * @property {number} usedPercent
 * @property {number | undefined} [windowMinutes]
 * @property {number | undefined} [resetsAt]
 */

/**
 * @typedef {object} CodexCreditsSnapshot
 * @property {boolean} hasCredits
 * @property {boolean} unlimited
 * @property {string | undefined} [balance]
 */

/**
 * @typedef {object} CodexRateLimitSnapshot
 * @property {string | undefined} [limitId]
 * @property {string | undefined} [limitName]
 * @property {CodexRateLimitWindow | undefined} [primary]
 * @property {CodexRateLimitWindow | undefined} [secondary]
 * @property {CodexCreditsSnapshot | undefined} [credits]
 * @property {string | undefined} [planType]
 * @property {string | undefined} [rateLimitReachedType]
 */

/**
 * @typedef {object} CodexDailyTokenUsageBreakdown
 * @property {string} date
 * @property {Record<string, number>} productSurfaceUsageValues
 */

/**
 * @typedef {object} CodexWorkspaceUsageTotals
 * @property {number | undefined} [users]
 * @property {number | undefined} [threads]
 * @property {number | undefined} [turns]
 * @property {number | undefined} [credits]
 * @property {number | undefined} [uncachedTextInputTokens]
 * @property {number | undefined} [cachedTextInputTokens]
 * @property {number | undefined} [textOutputTokens]
 * @property {number | undefined} [textTotalTokens]
 */

/**
 * @typedef {CodexWorkspaceUsageTotals & {
 *   clientId: string
 * }} CodexWorkspaceClientUsage
 */

/**
 * @typedef {object} CodexDailyWorkspaceUsageCounts
 * @property {string} date
 * @property {CodexWorkspaceUsageTotals} totals
 * @property {CodexWorkspaceClientUsage[]} clients
 */

/**
 * @typedef {object} CodexUsageAnalyticsSnapshot
 * @property {string} startDate
 * @property {string} endDate
 * @property {string | undefined} [tokenUnits]
 * @property {string | undefined} [tokenGroupBy]
 * @property {CodexDailyTokenUsageBreakdown[]} dailyTokenUsage
 * @property {string | undefined} [workspaceGroupBy]
 * @property {CodexDailyWorkspaceUsageCounts[]} dailyWorkspaceUsage
 */

/**
 * @param {{ apiBaseUrl: string, accessToken: string, chatgptAccountId?: string, fetch?: typeof fetch }} options
 * @returns {Promise<CodexRateLimitSnapshot[]>}
 */
export async function fetchCodexRateLimits(options) {
  const urls = usageEndpointUrls(options.apiBaseUrl);
  let response;
  for (const url of urls) {
    response = await fetchWithRetries(url, {
      method: "GET",
      headers: codexAuthHeaders({ accessToken: options.accessToken, chatgptAccountId: options.chatgptAccountId })
    }, {
      fetch: options.fetch
    });

    if (response.ok || !shouldTryNextUsageEndpoint(response.status)) {
      break;
    }
  }

  if (!response) {
    throw new Error("missing Codex usage endpoint");
  }

  return parseCodexUsageResponse(await readJsonResponse(response, "Codex usage request"));
}

/**
 * @param {{ apiBaseUrl: string, accessToken: string, chatgptAccountId?: string, startDate?: string, endDate?: string, fetch?: typeof fetch }} options
 * @returns {Promise<CodexUsageAnalyticsSnapshot>}
 */
export async function fetchCodexUsageAnalytics(options) {
  const endDate = options.endDate ?? isoDateOnly(new Date());
  const startDate = options.startDate ?? isoDateOnly(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000));
  const urls = usageAnalyticsEndpointUrls(options.apiBaseUrl, startDate, endDate);
  const headers = codexAuthHeaders({ accessToken: options.accessToken, chatgptAccountId: options.chatgptAccountId });
  const [tokenResponse, workspaceResponse] = await Promise.all([
    fetchWithRetries(urls.dailyTokenUsage, { method: "GET", headers }, { fetch: options.fetch }),
    fetchWithRetries(urls.dailyWorkspaceUsage, { method: "GET", headers }, { fetch: options.fetch })
  ]);

  if (!tokenResponse.ok) {
    throw new Error(`Codex daily token usage request failed with status ${tokenResponse.status}`);
  }
  if (!workspaceResponse.ok) {
    throw new Error(`Codex workspace usage request failed with status ${workspaceResponse.status}`);
  }

  const tokenUsage = parseCodexDailyTokenUsageBreakdownResponse(await readJsonResponse(tokenResponse, "Codex daily token usage request"));
  const workspaceUsage = parseCodexWorkspaceUsageCountsResponse(await readJsonResponse(workspaceResponse, "Codex workspace usage request"));
  return {
    startDate,
    endDate,
    tokenUnits: tokenUsage.units,
    tokenGroupBy: tokenUsage.groupBy,
    dailyTokenUsage: tokenUsage.data,
    workspaceGroupBy: workspaceUsage.groupBy,
    dailyWorkspaceUsage: workspaceUsage.data
  };
}

/* eslint-disable jsdoc/check-types -- Codex usage and stream payloads are untyped external JSON. */

/**
 * @param {unknown} body
 * @returns {CodexRateLimitSnapshot[]}
 */
export function parseCodexUsageResponse(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("invalid Codex usage response");
  }

  const record = /** @type {Record<string, unknown>} */ (body);
  const planType = readOptionalString(record.plan_type ?? record.planType);
  const rateLimitReachedType = readRateLimitReachedType(record.rate_limit_reached_type ?? record.rateLimitReachedType);
  const snapshots = [makeRateLimitSnapshot({
    limitId: "codex",
    rateLimit: record.rate_limit ?? record.rateLimit,
    credits: record.credits,
    planType,
    rateLimitReachedType
  })];

  const additional = record.additional_rate_limits ?? record.additionalRateLimits;
  if (Array.isArray(additional)) {
    for (const item of additional) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }

      const additionalRecord = /** @type {Record<string, unknown>} */ (item);
      const limitId = readOptionalString(additionalRecord.metered_feature ?? additionalRecord.meteredFeature)
        ?? readOptionalString(additionalRecord.limit_name ?? additionalRecord.limitName);
      snapshots.push(makeRateLimitSnapshot({
        limitId,
        limitName: readOptionalString(additionalRecord.limit_name ?? additionalRecord.limitName),
        rateLimit: additionalRecord.rate_limit ?? additionalRecord.rateLimit,
        planType
      }));
    }
  }

  return snapshots.filter((snapshot) => snapshot.limitId || snapshot.primary || snapshot.secondary || snapshot.credits || snapshot.planType);
}

/**
 * @param {unknown} body
 * @returns {{ data: CodexDailyTokenUsageBreakdown[], units: string | undefined, groupBy: string | undefined }}
 */
export function parseCodexDailyTokenUsageBreakdownResponse(body) {
  const record = readObject(body);
  if (!record) {
    throw new Error("invalid Codex daily token usage response");
  }

  return {
    data: readArray(record.data)
      .map((item) => {
        const itemRecord = readObject(item);
        const date = readOptionalString(itemRecord?.date);
        if (!itemRecord || !date) {
          return;
        }

        return {
          date,
          productSurfaceUsageValues: readNumberRecord(itemRecord.product_surface_usage_values ?? itemRecord.productSurfaceUsageValues)
        };
      })
      .filter((item) => item !== undefined),
    units: readOptionalString(record.units),
    groupBy: readOptionalString(record.group_by ?? record.groupBy)
  };
}

/**
 * @param {unknown} body
 * @returns {{ data: CodexDailyWorkspaceUsageCounts[], groupBy: string | undefined }}
 */
export function parseCodexWorkspaceUsageCountsResponse(body) {
  const record = readObject(body);
  if (!record) {
    throw new Error("invalid Codex workspace usage counts response");
  }

  return {
    data: readArray(record.data)
      .map((item) => {
        const itemRecord = readObject(item);
        const date = readOptionalString(itemRecord?.date);
        if (!itemRecord || !date) {
          return;
        }

        return {
          date,
          totals: readWorkspaceUsageTotals(itemRecord.totals),
          clients: readArray(itemRecord.clients).map((client) => readWorkspaceClientUsage(client)).filter((client) => client !== undefined)
        };
      })
      .filter((item) => item !== undefined),
    groupBy: readOptionalString(record.group_by ?? record.groupBy)
  };
}

/**
 * @param {unknown} event
 * @returns {CodexRateLimitSnapshot | undefined}
 */
export function parseCodexRateLimitEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return;
  }

  const record = /** @type {Record<string, unknown>} */ (event);
  if (record.type !== "codex.rate_limits") {
    return;
  }

  const rateLimits = record.rate_limits ?? record.rateLimits;
  const details = rateLimits && typeof rateLimits === "object" && !Array.isArray(rateLimits)
    ? /** @type {Record<string, unknown>} */ (rateLimits)
    : undefined;
  const credits = readCredits(record.credits);
  const limitId = normalizeLimitId(readOptionalString(record.metered_limit_name ?? record.meteredLimitName ?? record.limit_name ?? record.limitName));

  return {
    limitId: limitId ?? "codex",
    primary: readEventWindow(details?.primary),
    secondary: readEventWindow(details?.secondary),
    credits,
    planType: readOptionalString(record.plan_type ?? record.planType)
  };
}

/**
 * @param {{ limitId?: string, limitName?: string, rateLimit: unknown, credits?: unknown, planType?: string, rateLimitReachedType?: string }} options
 * @returns {CodexRateLimitSnapshot}
 */
function makeRateLimitSnapshot(options) {
  const rateLimit = options.rateLimit && typeof options.rateLimit === "object" && !Array.isArray(options.rateLimit)
    ? /** @type {Record<string, unknown>} */ (options.rateLimit)
    : undefined;

  return {
    limitId: normalizeLimitId(options.limitId),
    limitName: options.limitName,
    primary: readUsageWindow(rateLimit?.primary_window ?? rateLimit?.primaryWindow),
    secondary: readUsageWindow(rateLimit?.secondary_window ?? rateLimit?.secondaryWindow),
    credits: readCredits(options.credits),
    planType: options.planType,
    rateLimitReachedType: options.rateLimitReachedType
  };
}

/** @param {unknown} value */
function readUsageWindow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  const record = /** @type {Record<string, unknown>} */ (value);
  const usedPercent = readFiniteNumber(record.used_percent ?? record.usedPercent);
  const windowSeconds = readFiniteNumber(record.limit_window_seconds ?? record.limitWindowSeconds);
  const windowMinutes = readFiniteNumber(record.window_minutes ?? record.windowMinutes)
    ?? (windowSeconds === undefined ? undefined : windowMinutesFromSeconds(windowSeconds));
  const resetsAt = readFiniteNumber(record.reset_at ?? record.resetAt);
  if (usedPercent === undefined && windowMinutes === undefined && resetsAt === undefined) {
    return;
  }

  return {
    usedPercent: usedPercent ?? 0,
    windowMinutes,
    resetsAt
  };
}

/** @param {unknown} value */
function readWorkspaceUsageTotals(value) {
  const record = readObject(value);
  if (!record) {
    return {};
  }

  return {
    users: readFiniteNumber(record.users),
    threads: readFiniteNumber(record.threads),
    turns: readFiniteNumber(record.turns),
    credits: readFiniteNumber(record.credits),
    uncachedTextInputTokens: readFiniteNumber(record.uncached_text_input_tokens ?? record.uncachedTextInputTokens),
    cachedTextInputTokens: readFiniteNumber(record.cached_text_input_tokens ?? record.cachedTextInputTokens),
    textOutputTokens: readFiniteNumber(record.text_output_tokens ?? record.textOutputTokens),
    textTotalTokens: readFiniteNumber(record.text_total_tokens ?? record.textTotalTokens)
  };
}

/** @param {unknown} value */
function readWorkspaceClientUsage(value) {
  const record = readObject(value);
  const clientId = readOptionalString(record?.client_id ?? record?.clientId);
  if (!record || !clientId) {
    return;
  }

  return {
    clientId,
    ...readWorkspaceUsageTotals(record)
  };
}

/** @param {unknown} value */
function readObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : undefined;
}

/** @param {unknown} value */
function readArray(value) {
  return Array.isArray(value) ? value : [];
}

/** @param {unknown} value */
function readNumberRecord(value) {
  const record = readObject(value);
  /** @type {Record<string, number>} */
  const result = {};
  if (!record) {
    return result;
  }

  for (const [key, item] of Object.entries(record)) {
    const number = readFiniteNumber(item);
    if (number !== undefined) {
      result[key] = number;
    }
  }

  return result;
}

/** @param {unknown} value */
function readEventWindow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  const record = /** @type {Record<string, unknown>} */ (value);
  const usedPercent = readFiniteNumber(record.used_percent ?? record.usedPercent);
  if (usedPercent === undefined) {
    return;
  }

  return {
    usedPercent,
    windowMinutes: readFiniteNumber(record.window_minutes ?? record.windowMinutes),
    resetsAt: readFiniteNumber(record.reset_at ?? record.resetAt)
  };
}

/** @param {unknown} value */
function readCredits(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  const record = /** @type {Record<string, unknown>} */ (value);
  const hasCredits = readBoolean(record.has_credits ?? record.hasCredits);
  const unlimited = readBoolean(record.unlimited);
  if (hasCredits === undefined || unlimited === undefined) {
    return;
  }

  return {
    hasCredits,
    unlimited,
    balance: readOptionalString(record.balance)
  };
}

/** @param {unknown} value */
function readRateLimitReachedType(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return readOptionalString(value);
  }

  const record = /** @type {Record<string, unknown>} */ (value);
  return readOptionalString(record.type ?? record.kind);
}

/** @param {unknown} value */
function readOptionalString(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** @param {unknown} value */
function readFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** @param {unknown} value */
function readBoolean(value) {
  return typeof value === "boolean" ? value : undefined;
}

/** @param {number} seconds */
function windowMinutesFromSeconds(seconds) {
  return seconds > 0 ? Math.round(seconds / 60) : undefined;
}

/** @param {Date} date */
function isoDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

/** @param {string | undefined} value */
function normalizeLimitId(value) {
  return value?.trim().toLowerCase().replaceAll("-", "_") || undefined;
}

/** @param {string} apiBaseUrl */
function usageEndpointUrls(apiBaseUrl) {
  const primary = new URL(`${apiBaseUrl.replace(/\/+$/u, "")}/usage`);
  const urls = [primary.toString()];

  if (/\/codex\/usage$/u.test(primary.pathname)) {
    const wham = new URL(primary.toString());
    wham.pathname = wham.pathname.replace(/\/codex\/usage$/u, "/wham/usage");
    urls.push(wham.toString());
  }

  return [...new Set(urls)];
}

/**
 * @param {string} apiBaseUrl
 * @param {string} startDate
 * @param {string} endDate
 */
function usageAnalyticsEndpointUrls(apiBaseUrl, startDate, endDate) {
  const base = whamBaseUrl(apiBaseUrl);
  const dailyTokenUsage = new URL(`${base}/usage/daily-token-usage-breakdown`);
  dailyTokenUsage.searchParams.set("start_date", startDate);
  dailyTokenUsage.searchParams.set("end_date", endDate);
  dailyTokenUsage.searchParams.set("group_by", "day");

  const dailyWorkspaceUsage = new URL(`${base}/analytics/daily-workspace-usage-counts`);
  dailyWorkspaceUsage.searchParams.set("start_date", startDate);
  dailyWorkspaceUsage.searchParams.set("end_date", endDate);
  dailyWorkspaceUsage.searchParams.set("group_by", "day");

  return {
    dailyTokenUsage: dailyTokenUsage.toString(),
    dailyWorkspaceUsage: dailyWorkspaceUsage.toString()
  };
}

/** @param {string} apiBaseUrl */
function whamBaseUrl(apiBaseUrl) {
  const base = new URL(apiBaseUrl.replace(/\/+$/u, ""));
  if (/\/codex$/u.test(base.pathname)) {
    base.pathname = base.pathname.replace(/\/codex$/u, "/wham");
    return base.toString().replace(/\/$/u, "");
  }
  if (/\/codex\/usage$/u.test(base.pathname)) {
    base.pathname = base.pathname.replace(/\/codex\/usage$/u, "/wham");
    return base.toString().replace(/\/$/u, "");
  }
  if (/\/wham(?:\/usage)?$/u.test(base.pathname)) {
    base.pathname = base.pathname.replace(/\/wham\/usage$/u, "/wham");
    return base.toString().replace(/\/$/u, "");
  }
  return base.toString().replace(/\/$/u, "");
}

/** @param {number} status */
function shouldTryNextUsageEndpoint(status) {
  return status === 403 || status === 404 || status === 405;
}
/* eslint-enable jsdoc/check-types */
