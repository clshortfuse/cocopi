import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { fetchCodexRateLimits, fetchCodexUsageAnalytics, parseCodexDailyTokenUsageBreakdownResponse, parseCodexRateLimitEvent, parseCodexUsageResponse, parseCodexWorkspaceUsageCountsResponse } from "../lib/codex-api/rate-limits.js";

const chatgptProUsageFixture = JSON.parse(await readFile(new URL("fixtures/codex-rate-limits/chatgpt-pro-usage.json", import.meta.url), "utf8"));
const dailyTokenUsageFixture = JSON.parse(await readFile(new URL("fixtures/codex-usage-analytics/daily-token-usage-breakdown.json", import.meta.url), "utf8"));
const dailyWorkspaceUsageFixture = JSON.parse(await readFile(new URL("fixtures/codex-usage-analytics/daily-workspace-usage-counts.json", import.meta.url), "utf8"));

test("parseCodexUsageResponse maps primary and additional rate limits", () => {
  const snapshots = parseCodexUsageResponse({
    plan_type: "pro",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 42,
        limit_window_seconds: 18_000,
        reset_at: 1_700_000_000
      },
      secondary_window: {
        used_percent: 84,
        limit_window_seconds: 604_800,
        reset_at: 1_700_604_800
      }
    },
    credits: {
      has_credits: true,
      unlimited: false,
      balance: "9.99"
    },
    rate_limit_reached_type: {
      type: "workspace_member_usage_limit_reached"
    },
    additional_rate_limits: [{
      limit_name: "codex_other",
      metered_feature: "codex_other",
      rate_limit: {
        primary_window: {
          used_percent: 70,
          limit_window_seconds: 900,
          reset_at: 789
        }
      }
    }]
  });

  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0]?.limitId, "codex");
  assert.equal(snapshots[0]?.primary?.usedPercent, 42);
  assert.equal(snapshots[0]?.primary?.windowMinutes, 300);
  assert.equal(snapshots[0]?.secondary?.windowMinutes, 10_080);
  assert.equal(snapshots[0]?.credits?.balance, "9.99");
  assert.equal(snapshots[0]?.planType, "pro");
  assert.equal(snapshots[0]?.rateLimitReachedType, "workspace_member_usage_limit_reached");
  assert.equal(snapshots[1]?.limitId, "codex_other");
  assert.equal(snapshots[1]?.limitName, "codex_other");
  assert.equal(snapshots[1]?.primary?.usedPercent, 70);
  assert.equal(snapshots[1]?.planType, "pro");
});

test("parseCodexRateLimitEvent maps stream event window data", () => {
  const snapshot = parseCodexRateLimitEvent({
    type: "codex.rate_limits",
    plan_type: "plus",
    metered_limit_name: "codex-sonic",
    rate_limits: {
      primary: {
        used_percent: 12.5,
        window_minutes: 300,
        reset_at: 1_700_000_000
      },
      secondary: {
        used_percent: 40,
        window_minutes: 10_080
      }
    },
    credits: {
      has_credits: true,
      unlimited: true
    }
  });

  assert.equal(snapshot?.limitId, "codex_sonic");
  assert.equal(snapshot?.primary?.usedPercent, 12.5);
  assert.equal(snapshot?.primary?.windowMinutes, 300);
  assert.equal(snapshot?.secondary?.usedPercent, 40);
  assert.equal(snapshot?.credits?.unlimited, true);
  assert.equal(snapshot?.planType, "plus");
});

test("parseCodexUsageResponse accepts sanitized live ChatGPT Pro usage fixture", () => {
  const snapshots = parseCodexUsageResponse(chatgptProUsageFixture);

  assert.ok(snapshots.length > 0, "expected at least one usage snapshot");
  assert.equal(snapshots[0]?.limitId, "codex");
  assert.equal(snapshots[0]?.planType, "pro");
  assert.equal(typeof snapshots[0]?.primary?.usedPercent, "number");
  assert.equal(typeof snapshots[0]?.secondary?.usedPercent, "number");
  assert.ok(snapshots.some((snapshot) => snapshot.limitId === "codex_bengalfox"), "expected additional model-specific limit");
});

test("parse Codex account analytics sanitized live fixtures", () => {
  const tokenUsage = parseCodexDailyTokenUsageBreakdownResponse(dailyTokenUsageFixture);
  const workspaceUsage = parseCodexWorkspaceUsageCountsResponse(dailyWorkspaceUsageFixture);

  assert.equal(tokenUsage.groupBy, "day");
  assert.equal(tokenUsage.units, "percent");
  assert.ok(tokenUsage.data.some((entry) => "vscode" in entry.productSurfaceUsageValues));
  assert.equal(workspaceUsage.groupBy, "day");
  assert.ok(workspaceUsage.data.some((entry) => entry.clients.some((client) => client.clientId === "CODEX_IDE_VSCODE")));
});

test("fetchCodexRateLimits falls back to upstream wham usage endpoint", async () => {
  /** @type {string[]} */
  const urls = [];
  const snapshots = await fetchCodexRateLimits({
    apiBaseUrl: "https://chatgpt.com/backend-api/codex",
    accessToken: "test-token",
    fetch: async (url) => {
      urls.push(String(url));
      if (String(url) === "https://chatgpt.com/backend-api/codex/usage") {
        return new Response("forbidden", { status: 403 });
      }

      return Response.json({
        plan_type: "plus",
        rate_limit: {
          primary_window: {
            used_percent: 5
          }
        }
      });
    }
  });

  assert.deepEqual(urls, [
    "https://chatgpt.com/backend-api/codex/usage",
    "https://chatgpt.com/backend-api/wham/usage"
  ]);
  assert.equal(snapshots[0]?.planType, "plus");
  assert.equal(snapshots[0]?.primary?.usedPercent, 5);
});

test("parse Codex account analytics responses", () => {
  const tokenUsage = parseCodexDailyTokenUsageBreakdownResponse({
    data: [{
      date: "2026-05-11",
      product_surface_usage_values: {
        vscode: 123,
        cli: 45,
        ignored: "not-a-number"
      }
    }],
    units: "tokens",
    group_by: "day"
  });
  const workspaceUsage = parseCodexWorkspaceUsageCountsResponse({
    data: [{
      date: "2026-05-11",
      totals: {
        users: 1,
        threads: 2,
        turns: 3,
        credits: 4,
        uncached_text_input_tokens: 5,
        cached_text_input_tokens: 6,
        text_output_tokens: 7,
        text_total_tokens: 18
      },
      clients: [{
        client_id: "vscode",
        turns: 3,
        text_total_tokens: 18
      }]
    }],
    group_by: "day"
  });

  assert.deepEqual(tokenUsage, {
    data: [{
      date: "2026-05-11",
      productSurfaceUsageValues: {
        vscode: 123,
        cli: 45
      }
    }],
    units: "tokens",
    groupBy: "day"
  });
  assert.equal(workspaceUsage.data[0]?.totals.turns, 3);
  assert.equal(workspaceUsage.data[0]?.totals.textTotalTokens, 18);
  assert.equal(workspaceUsage.data[0]?.clients[0]?.clientId, "vscode");
  assert.equal(workspaceUsage.data[0]?.clients[0]?.turns, 3);
});

test("fetchCodexUsageAnalytics reads wham account analytics endpoints", async () => {
  /** @type {string[]} */
  const urls = [];
  const snapshot = await fetchCodexUsageAnalytics({
    apiBaseUrl: "https://chatgpt.com/backend-api/codex",
    accessToken: "test-token",
    startDate: "2026-05-01",
    endDate: "2026-05-11",
    fetch: async (url) => {
      urls.push(String(url));
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/usage/daily-token-usage-breakdown")) {
        return Response.json({
          data: [{
            date: "2026-05-11",
            product_surface_usage_values: {
              vscode: 10
            }
          }],
          units: "tokens",
          group_by: "day"
        });
      }

      return Response.json({
        data: [{
          date: "2026-05-11",
          totals: {
            turns: 2,
            text_total_tokens: 10
          },
          clients: [{
            client_id: "vscode",
            turns: 2
          }]
        }],
        group_by: "day"
      });
    }
  });

  assert.equal(urls.length, 2);
  assert.ok(urls.includes("https://chatgpt.com/backend-api/wham/usage/daily-token-usage-breakdown?start_date=2026-05-01&end_date=2026-05-11&group_by=day"));
  assert.ok(urls.includes("https://chatgpt.com/backend-api/wham/analytics/daily-workspace-usage-counts?start_date=2026-05-01&end_date=2026-05-11&group_by=day"));
  assert.equal(snapshot.dailyTokenUsage[0]?.productSurfaceUsageValues.vscode, 10);
  assert.equal(snapshot.dailyWorkspaceUsage[0]?.totals.turns, 2);
});
