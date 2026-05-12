// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";

import { COCOPI_COMMANDS, registerCocopiCommands, selectModel, showAuthStatus, signIn, signOut } from "../lib/vscode/commands.js";
import { recordCocopiIssue, clearCocopiIssues } from "../lib/vscode/issues.js";
import { CODEX_SECRET_KEYS } from "../lib/vscode/secret-storage.js";
import { clearCocopiRateLimitSnapshots, clearCocopiRemoteUsageAnalyticsSnapshots, clearCocopiTokenCacheDebugSummaries, recordCocopiRemoteUsageAnalytics, recordCocopiTokenCacheSummary, waitForCocopiTokenCacheDebugStorage } from "../lib/vscode/token-cache-debug.js";

class MarkdownString {
  constructor(value = "", supportThemeIcons = false) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
  }
}

test("registerCocopiCommands wires diagnostics webview commands", async () => {
  clearCocopiIssues();
  clearCocopiTokenCacheDebugSummaries();
  clearCocopiRemoteUsageAnalyticsSnapshots();
  recordCocopiIssue({
    severity: "warning",
    category: "token-cache",
    title: "Cache miss",
    details: "A cache miss was detected.",
    metadata: { model: "gpt-test", cachedTokens: 0 }
  });
  recordCocopiTokenCacheSummary(tokenCacheSummary({
    id: 1,
    hostRequestIndex: 1,
    conversationSummary: "Setup conversation",
    conversationDescription: "Initial setup of cache summary UI",
    selectedModel: "gpt-test:fast",
    serviceTier: "priority",
    serviceTierSource: "model",
    reasoningEffort: "xhigh",
    reasoningSummary: "detailed",
    fastRequested: true,
    sessionInitialTokens: 100,
    sessionCumulativeTokens: 120
  }));
  recordCocopiTokenCacheSummary(tokenCacheSummary({
    id: 3,
    hostRequestIndex: 1,
    sessionId: "cocopi-language-model-blank"
  }));

  const vscode = fakeVscode();
  const context = fakeContext();
  registerCocopiCommands(context, vscode);
  await waitForCocopiTokenCacheDebugStorage();
  recordCocopiRemoteUsageAnalytics({
    startDate: "2026-04-01",
    endDate: "2026-04-30",
    tokenUnits: "tokens",
    dailyTokenUsage: [{
      date: "2026-04-30",
      productSurfaceUsageValues: {
        unknown: 60
      }
    }],
    dailyWorkspaceUsage: [{
      date: "2026-04-30",
      totals: {
        turns: 1,
        textTotalTokens: 60
      },
      clients: [{
        clientId: "CODEX_UNKNOWN_DEFAULT",
        turns: 1,
        textTotalTokens: 60
      }]
    }]
  }, {
    capturedAt: new Date("2026-04-30T12:00:00.000Z")
  });

  await vscode.commands.callbacks.get(COCOPI_COMMANDS.showDiagnostics)?.();
  assert.equal(vscode.panels[0].viewType, "cocopiDiagnostics");
  assert.equal(vscode.panels[0].title, "Diagnostics");
  assert.equal(vscode.panels[0].showOptions, vscode.ViewColumn.Active);
  assert.match(vscode.panels[0].webview.html, /Cache miss/u);
  assert.match(vscode.panels[0].webview.html, /model=gpt-test/u);
  assert.match(vscode.panels[0].webview.html, /<td title="\d{4}-\d{2}-\d{2}T[^"]+Z">[^<]+<\/td>/u);
  assert.doesNotMatch(vscode.panels[0].webview.html, /<td>\d{4}-\d{2}-\d{2}T[^<]+Z<\/td>/u);
  assert.doesNotMatch(vscode.panels[0].webview.html, /location\.reload/u);
  recordCocopiIssue({
    severity: "info",
    category: "runtime",
    title: "Live update",
    details: "Diagnostics should update without reloading the webview.",
    metadata: { source: "test" }
  });
  assert.match(vscode.panels[0].webview.html, /Live update/u);
  assert.deepEqual(vscode.panels[0].postedMessages, []);

  await vscode.commands.callbacks.get(COCOPI_COMMANDS.showTokenTracker)?.();
  assert.equal(vscode.panels[1].viewType, "cocopiTokenTracker");
  assert.equal(vscode.panels[1].title, "Token Tracker");
  assert.equal(vscode.panels[1].showOptions, vscode.ViewColumn.Active);
  assert.match(vscode.panels[1].webview.html, /Token Tracker/u);
  assert.match(vscode.panels[1].webview.html, /State restored/u);
  assert.match(vscode.panels[1].webview.html, /text=2 toolCalls=1 toolResults=1 data=2 cocopiData=1/u);
  assert.match(vscode.panels[1].webview.html, /Conversation summary/u);
  assert.match(vscode.panels[1].webview.html, /Setup conversation/u);
  assert.match(vscode.panels[1].webview.html, /Language Model · Setup conversation · …/u);
  assert.match(vscode.panels[1].webview.html, /Language Model · Language Model host request 1 · gpt-test · hit · 60 tokens/u);
  assert.match(vscode.panels[1].webview.html, /Language Model host request 1 · gpt-test · websocket · 3 input items/u);
  assert.match(vscode.panels[1].webview.html, /Selected model/u);
  assert.match(vscode.panels[1].webview.html, /gpt-test:fast/u);
  assert.match(vscode.panels[1].webview.html, /Reasoning effort/u);
  assert.match(vscode.panels[1].webview.html, /xhigh/u);
  assert.match(vscode.panels[1].webview.html, /Reasoning summary/u);
  assert.match(vscode.panels[1].webview.html, /detailed/u);
  assert.match(vscode.panels[1].webview.html, /Service tier/u);
  assert.match(vscode.panels[1].webview.html, /priority/u);
  assert.match(vscode.panels[1].webview.html, /Request kind/u);
  assert.match(vscode.panels[1].webview.html, /compaction/u);
  assert.match(vscode.panels[1].webview.html, /Turn kind/u);
  assert.match(vscode.panels[1].webview.html, /VS Code summary generation/u);
  assert.match(vscode.panels[1].webview.html, /Cache risk/u);
  assert.match(vscode.panels[1].webview.html, /low risk/u);
  assert.match(vscode.panels[1].webview.html, /Low risk because uncached input stayed below 10000 tokens/u);
  assert.match(vscode.panels[1].webview.html, /Uncached input tokens/u);
  assert.match(vscode.panels[1].webview.html, /50 uncached input/u);
  assert.match(vscode.panels[1].webview.html, /Continuation/u);
  assert.match(vscode.panels[1].webview.html, /previous-response/u);
  assert.match(vscode.panels[1].webview.html, /This extension local usage/u);
  assert.match(vscode.panels[1].webview.html, /Account quota depletion/u);
  assert.match(vscode.panels[1].webview.html, /This extension agent and session usage/u);
  assert.match(vscode.panels[1].webview.html, /Account usage by surface/u);
  assert.match(vscode.panels[1].webview.html, /not Cocopi-only/u);
  assert.match(vscode.panels[1].webview.html, /CODEX_UNKNOWN_DEFAULT \(unknown\/default; may include Cocopi\)/u);
  assert.match(vscode.panels[1].webview.html, /not uniquely Cocopi/u);
  assert.match(vscode.panels[1].webview.html, /Request duration/u);
  assert.match(vscode.panels[1].webview.html, /First output/u);
  assert.match(vscode.panels[1].webview.html, /5\.00 output tokens\/s/u);
  assert.match(vscode.panels[1].webview.html, /Wire mode/u);
  assert.match(vscode.panels[1].webview.html, /previous-response/u);
  assert.match(vscode.panels[1].webview.html, /Fast requested/u);
  assert.match(vscode.panels[1].webview.html, /title="\d{4}-\d{2}-\d{2}T/u);
  assert.match(vscode.panels[1].webview.html, /Conversation description/u);
  assert.match(vscode.panels[1].webview.html, /Initial setup of cache summary UI/u);
  assert.match(vscode.panels[1].webview.html, /Session token count/u);
  assert.match(vscode.panels[1].webview.html, /100 \+ 20 = 120/u);
  assert.match(vscode.panels[1].webview.html, /\b1 request · 60 tokens · 50 uncached · avg 2\.00s · 5\.00 output tokens\/s/u);
  assert.doesNotMatch(vscode.panels[1].webview.html, /when token tracking is enabled/u);
  assert.match(vscode.panels[1].webview.html, /Private local diagnostics stored in VS Code private storage/u);
  assert.match(vscode.panels[1].webview.html, /Delete 1-request sessions/u);
  assert.match(vscode.panels[1].webview.html, /Delete all sessions/u);
  assert.match(vscode.panels[1].webview.html, /deleteTokenCacheSessions/u);
  assert.match(vscode.panels[1].webview.html, /data-delete-entry-id="1"/u);
  assert.match(vscode.panels[1].webview.html, /data-delete-session-id="cocopi-language-model-test"/u);
  assert.match(vscode.panels[1].webview.html, /\.cache-status-hit \{ background: var\(--vscode-testing-iconPassed, #73c991\)/u);
  assert.match(vscode.panels[1].webview.html, /\.phase-summary-generation/u);
  assert.match(vscode.panels[1].webview.html, /\.phase-tool-continuation/u);
  assert.match(vscode.panels[1].webview.html, /\.risk-high/u);
  assert.match(vscode.panels[1].webview.html, /<span class="cache-status cache-status-hit">hit<\/span> 50\.0% hit/u);
  assert.match(vscode.panels[1].webview.html, /50\.0% hit · 50 uncached input · 60 tokens \(in 50 \/ out 10\) · 2\.00s · 5\.00 output tokens\/s/u);

  recordCocopiTokenCacheSummary(tokenCacheSummary({ id: 2, hostRequestIndex: 2, cacheHitRatio: undefined, sessionId: "cocopi-language-model-test" }));
  await new Promise((resolve) => setTimeout(resolve, 280));
  assert.deepEqual(vscode.panels[1].postedMessages.map((message) => message.type), ["appendTokenCacheSummaries"]);
  assert.equal(vscode.panels[1].postedMessages[0].groups?.[0]?.sessionId, "cocopi-language-model-test");
  assert.equal(vscode.panels[1].postedMessages[0].groups?.[0]?.conversationSummary, "Setup conversation");
  assert.match(vscode.panels[1].postedMessages[0].groups?.[0]?.entriesHtml, /100 \+ 80 = 180/u);
  assert.match(vscode.panels[1].postedMessages[0].groups?.[0]?.entriesHtml, /<span class="cache-status cache-status-hit">hit<\/span> 50\.0% hit/u);
  assert.match(vscode.panels[1].postedMessages[0].groups?.[0]?.entriesHtml, /50\.0% hit · 50 uncached input · 60 tokens \(in 50 \/ out 10\) · 2\.00s · 5\.00 output tokens\/s/u);
  assert.equal(vscode.panels[1].postedMessages[0].groups?.[0]?.sessionCumulativeTokens, 180);
  assert.match(vscode.panels[1].postedMessages[0].groups?.[0]?.sessionStats ?? "", /120 tokens · 100 uncached/u);
  assert.match(vscode.panels[1].postedMessages[0].analyticsHtml ?? "", /This extension local usage/u);

  vscode.panels[1].dispose();
  assert.equal(context.subscriptions.length, Object.keys(COCOPI_COMMANDS).length);
});

test("Cocopi status bar item is clickable", () => {
  const vscode = fakeVscode({ statusBar: true });
  const context = fakeContext();
  registerCocopiCommands(context, vscode);

  assert.equal(vscode.statusBarItems[0].alignment, 2);
  assert.equal(vscode.statusBarItems[0].priority, 0);
  assert.equal(vscode.statusBarItems[0].name, "Cocopi");
  assert.equal(vscode.statusBarItems[0].command, COCOPI_COMMANDS.status);
  assert.equal(vscode.statusBarItems[0].text, "$(cocopi-logo)");
  assert.equal(vscode.statusBarItems[0].tooltip.supportThemeIcons, true);
  assert.equal(vscode.statusBarItems[0].tooltip.supportHtml, true);
  assert.match(vscode.statusBarItems[0].tooltip.value, /\*\*Cocopi\*\*/u);
  assert.match(vscode.statusBarItems[0].tooltip.value, /<table>/u);
  assert.match(vscode.statusBarItems[0].tooltip.value, /<th scope="row" style="white-space: nowrap">\$\(server\)&nbsp;Default&nbsp;model<\/th>/u);
  assert.match(vscode.statusBarItems[0].tooltip.value, /Default&nbsp;model/u);
  assert.doesNotMatch(vscode.statusBarItems[0].tooltip.value, /\| Status \| Detail \|/u);
  assert.match(vscode.statusBarItems[0].tooltip.value, /Token Tracker/u);
  assert.deepEqual(vscode.statusBarItems[0].tooltip.isTrusted, {
    enabledCommands: [COCOPI_COMMANDS.status, COCOPI_COMMANDS.showTokenTracker, COCOPI_COMMANDS.showDiagnostics]
  });
  assert.equal(vscode.statusBarItems[0].visible, true);
});

test("Cocopi status action shows usage with tracker options", async (testContext) => {
  clearCocopiRateLimitSnapshots();
  clearCocopiTokenCacheDebugSummaries();
  const calls = [];
  testContext.mock.method(globalThis, "fetch", async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return Response.json({
      plan_type: "pro",
      rate_limit: {
        primary_window: {
          used_percent: 42,
          limit_window_seconds: 18_000
        }
      }
    });
  });
  const context = fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"],
    [CODEX_SECRET_KEYS.chatgptAccountId, "account-id"],
    [CODEX_SECRET_KEYS.chatgptPlanType, "pro"]
  ]));
  const vscode = fakeVscode({ quickPickSelectionIndex: 4, statusBar: true });
  registerCocopiCommands(context, vscode);

  await vscode.commands.callbacks.get(COCOPI_COMMANDS.status)?.();

  assert.match(calls[0]?.url ?? "", /\/usage$/u);
  assert.deepEqual(vscode.quickPickItems[0].map((item) => item.label), [
    "$(check) Signed in",
    "$(pulse) Codex usage limits",
    "$(dashboard) codex",
    "$(graph) Open Token Tracker",
    "$(bug) Open Diagnostics"
  ]);
  assert.equal(vscode.quickPickItems[0][0].description, "Plan: pro");
  assert.match(vscode.quickPickItems[0][2].detail ?? "", /5h: 58% left \(42% used\)/u);
  assert.match(vscode.statusBarItems[0].tooltip.value, /<th scope="col" style="white-space: nowrap">Limit<\/th>/u);
  assert.match(vscode.statusBarItems[0].tooltip.value, /<th scope="row" style="white-space: nowrap">codex<\/th><td>5h<\/td><td>58%<\/td><td>42%<\/td>/u);
  assert.deepEqual(vscode.executedCommands, [COCOPI_COMMANDS.showDiagnostics]);
});

test("Token Tracker warns when token tracking is disabled", async () => {
  clearCocopiTokenCacheDebugSummaries();
  const vscode = fakeVscode({ tokenTracking: false });
  const context = fakeContext();
  registerCocopiCommands(context, vscode);

  await vscode.commands.callbacks.get(COCOPI_COMMANDS.showTokenTracker)?.();

  assert.match(vscode.panels[0].webview.html, /Token tracking is disabled/u);
  assert.match(vscode.panels[0].webview.html, /cocopi\.tokenTracking/u);
  assert.doesNotMatch(vscode.panels[0].webview.html, /when token tracking is enabled/u);
});

test("Token Tracker refreshes usage limits when opened", async (testContext) => {
  clearCocopiRateLimitSnapshots();
  clearCocopiTokenCacheDebugSummaries();
  const calls = [];
  testContext.mock.method(globalThis, "fetch", async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return Response.json({
      plan_type: "pro",
      rate_limit: {
        primary_window: {
          used_percent: 42,
          limit_window_seconds: 18_000
        }
      }
    });
  });
  const vscode = fakeVscode();
  const context = fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"],
    [CODEX_SECRET_KEYS.chatgptAccountId, "account-id"]
  ]));
  registerCocopiCommands(context, vscode);

  await vscode.commands.callbacks.get(COCOPI_COMMANDS.showTokenTracker)?.();

  assert.match(calls[0]?.url ?? "", /\/usage$/u);
  assert.equal(calls[0]?.options.headers.Authorization, "Bearer access-token");
  assert.equal(calls[0]?.options.headers["ChatGPT-Account-ID"], "account-id");
  assert.deepEqual(vscode.panels[0].postedMessages.map((message) => message.type), ["updateTokenCacheUsageStatus"]);
  assert.match(vscode.panels[0].postedMessages[0].html, /Codex usage limits/u);
  assert.match(vscode.panels[0].postedMessages[0].html, /pro/u);
  assert.match(vscode.panels[0].postedMessages[0].html, /58% left \(42% used\)/u);
});

test("usage refresh is shared and throttled across status surfaces", async (testContext) => {
  clearCocopiRateLimitSnapshots();
  clearCocopiTokenCacheDebugSummaries();
  const calls = [];
  testContext.mock.method(globalThis, "fetch", async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return Response.json({
      plan_type: "pro",
      rate_limit: {
        primary_window: {
          used_percent: 42,
          limit_window_seconds: 18_000
        }
      }
    });
  });
  const vscode = fakeVscode();
  const context = fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"],
    [CODEX_SECRET_KEYS.chatgptAccountId, "account-id"]
  ]));
  registerCocopiCommands(context, vscode);

  await vscode.commands.callbacks.get(COCOPI_COMMANDS.status)?.();
  await vscode.commands.callbacks.get(COCOPI_COMMANDS.showTokenTracker)?.();
  await vscode.commands.callbacks.get(COCOPI_COMMANDS.status)?.();

  assert.equal(calls.length, 3);
  assert.ok(calls.some((call) => /\/usage$/u.test(call.url)));
  assert.ok(calls.some((call) => /\/usage\/daily-token-usage-breakdown/u.test(call.url)));
  assert.ok(calls.some((call) => /\/analytics\/daily-workspace-usage-counts/u.test(call.url)));
  assert.match(vscode.panels[0].webview.html, /Codex usage limits/u);
  assert.match(vscode.panels[0].webview.html, /58% left \(42% used\)/u);
  assert.deepEqual(vscode.panels[0].postedMessages, []);
});

test("signIn stores browser login tokens and account metadata", async () => {
  const secrets = new Map();
  const context = fakeContext(secrets);
  const vscode = fakeVscode();

  await signIn(context, vscode, {
    runLogin: async ({ openExternal }) => {
      await openExternal("https://chatgpt.example.test/auth");
      return {
        accessToken: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-id" } }),
        refreshToken: "refresh-token",
        idToken: jwt({ "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } })
      };
    }
  });

  assert.equal(secrets.get(CODEX_SECRET_KEYS.refreshToken), "refresh-token");
  assert.equal(secrets.get(CODEX_SECRET_KEYS.chatgptAccountId), "account-id");
  assert.equal(secrets.get(CODEX_SECRET_KEYS.chatgptPlanType), "plus");
  assert.deepEqual(vscode.externalUrls, ["https://chatgpt.example.test/auth"]);
  assert.deepEqual(vscode.statusMessages.map((entry) => entry.message), [
    "Opening ChatGPT sign-in for Cocopi.",
    "Cocopi sign-in complete."
  ]);
});

test("status and sign-out commands report auth state", async () => {
  const secrets = new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"],
    [CODEX_SECRET_KEYS.chatgptPlanType, "plus"]
  ]);
  const context = fakeContext(secrets);
  const vscode = fakeVscode({ warningSelection: "Sign Out" });

  await showAuthStatus(context, vscode);
  assert.equal(vscode.quickPickItems[0][0].label, "$(check) Signed in");
  assert.equal(vscode.quickPickItems[0][0].description, "Plan: plus");
  assert.match(vscode.quickPickItems[0][0].detail ?? "", /Fallback model: gpt-current/u);

  await signOut(context, vscode);
  assert.equal(secrets.has(CODEX_SECRET_KEYS.accessToken), false);
  assert.equal(vscode.informationMessages.at(-1), "Cocopi credentials cleared.");

  await showAuthStatus(context, vscode);
  assert.equal(vscode.quickPickItems.at(-1)[0].label, "$(warning) Not signed in");
});

test("selectModel updates the configured fallback model", async (testContext) => {
  const context = fakeContext(new Map([
    [CODEX_SECRET_KEYS.accessToken, "access-token"],
    [CODEX_SECRET_KEYS.refreshToken, "refresh-token"],
    [CODEX_SECRET_KEYS.idToken, "id-token"]
  ]));
  const vscode = fakeVscode({ quickPickSelectionIndex: 1 });
  testContext.mock.method(globalThis, "fetch", /** @type {typeof fetch} */ (async () => Response.json({
    models: [
      { slug: "gpt-current", display_name: "Current" },
      { slug: "gpt-next", display_name: "Next", context_window: 128_000, additional_speed_tiers: ["fast"] }
    ]
  })));

  await selectModel(context, vscode);

  assert.deepEqual(vscode.configurationUpdates, [{ key: "model", value: "gpt-next", target: true }]);
  assert.match(vscode.quickPickItems[0][1].detail ?? "", /128,000 tokens \| Fast available/u);
});

/**
 * @param {{ id: number, hostRequestIndex: number, cacheHitRatio?: number, sessionId?: string, conversationSummary?: string, conversationDescription?: string, selectedModel?: string, serviceTier?: string, serviceTierSource?: string, reasoningEffort?: string, reasoningSummary?: string, fastRequested?: boolean, sessionInitialTokens?: number, sessionCumulativeTokens?: number }} options
 * @returns {import("../lib/vscode/token-cache-debug.js").CocopiTokenCacheDebugSummary}
 */
function tokenCacheSummary(options) {
  return {
    id: options.id,
    recordedAt: "2026-04-27T00:00:00.000Z",
    source: "language-model",
    hostRequestIndex: options.hostRequestIndex,
    sessionId: options.sessionId ?? "cocopi-language-model-test",
    conversationSummary: options.conversationSummary,
    conversationDescription: options.conversationDescription,
    model: "gpt-test",
    selectedModel: options.selectedModel,
    inputItems: 3,
    stateRestored: true,
    requestMessages: 4,
    requestTextParts: 2,
    requestToolCallParts: 1,
    requestToolResultParts: 1,
    requestDataParts: 2,
    requestCocopiDataParts: 1,
    requestCocopiDataBytes: 1234,
    requestDataMimeTypes: "stateful_marker:1,image/png:1",
    transport: "websocket",
    serviceTier: options.serviceTier,
    serviceTierSource: options.serviceTierSource,
    reasoningEffort: options.reasoningEffort,
    reasoningSummary: options.reasoningSummary,
    fastRequested: options.fastRequested,
    promptCacheKey: "cocopi-language-model-test",
    requestKind: options.hostRequestIndex === 1 ? "compaction" : undefined,
    requestInputDigest: options.hostRequestIndex === 1 ? "sha256:requestinput" : undefined,
    requestToolsDigest: options.hostRequestIndex === 1 ? "sha256:requesttools" : undefined,
    requestBodyDigest: options.hostRequestIndex === 1 ? "sha256:requestbody" : undefined,
    wireMode: options.hostRequestIndex === 1 ? "previous-response" : undefined,
    wireInputItems: options.hostRequestIndex === 1 ? 1 : undefined,
    wireInputDigest: options.hostRequestIndex === 1 ? "sha256:wireinput" : undefined,
    wireToolsDigest: options.hostRequestIndex === 1 ? "sha256:wiretools" : undefined,
    wireBodyDigest: options.hostRequestIndex === 1 ? "sha256:wirebody" : undefined,
    requestStartedAt: "2026-04-27T00:00:00.000Z",
    requestCompletedAt: "2026-04-27T00:00:02.000Z",
    requestDurationMs: 2000,
    firstEventLatencyMs: 250,
    firstOutputLatencyMs: 500,
    responseId: "resp-test",
    inputTokens: 100,
    outputTokens: 10,
    reasoningTokens: 5,
    totalTokens: 110,
    sessionInitialTokens: options.sessionInitialTokens,
    sessionCumulativeTokens: options.sessionCumulativeTokens,
    cachedTokens: 50,
    cacheStatus: "hit",
    cacheHitRatio: options.cacheHitRatio ?? 50
  };
}

/** @param {Map<string, string>} [secrets] */
function fakeContext(secrets = new Map()) {
  return {
    subscriptions: [],
    secrets: {
      /** @param {string} key */
      async get(key) {
        return secrets.get(key);
      },
      /**
       * @param {string} key
       * @param {string} value
       */
      async store(key, value) {
        secrets.set(key, value);
      },
      /** @param {string} key */
      async delete(key) {
        secrets.delete(key);
      }
    }
  };
}

/**
 * @param {{ informationSelection?: string, warningSelection?: string, quickPickSelectionIndex?: number, tokenTracking?: boolean }} [options]
 */
function fakeVscode(options = {}) {
  const configuration = new Map([["model", "gpt-current"]]);
  const vscode = {
    commands: {
      callbacks: new Map(),
      /**
       * @param {string} command
       * @param {() => void | Promise<void>} callback
       */
      registerCommand(command, callback) {
        this.callbacks.set(command, callback);
        return { dispose() {} };
      },
      /** @param {string} command */
      async executeCommand(command) {
        vscode.executedCommands.push(command);
      }
    },
    env: {
      /** @param {{ toString(): string }} target */
      async openExternal(target) {
        vscode.externalUrls.push(target.toString());
        return true;
      }
    },
    Uri: {
      /** @param {string} value */
      parse(value) {
        return { toString: () => value };
      }
    },
    workspace: {
      getConfiguration() {
        return {
          /**
           * @param {string} key
           * @param {string | number} defaultValue
           */
          get(key, defaultValue) {
            if (key === "tokenTracking" && typeof options.tokenTracking === "boolean") {
              return options.tokenTracking;
            }
            return configuration.get(key) ?? defaultValue;
          },
          /**
           * @param {string} key
           * @param {string} value
           * @param {boolean} target
           */
          async update(key, value, target) {
            vscode.configurationUpdates.push({ key, value, target });
            configuration.set(key, value);
          }
        };
      }
    },
    window: {
      /**
       * @param {string} viewType
       * @param {string} title
       * @param {number} showOptions
       * @param {{ enableScripts?: boolean }} panelOptions
       */
      createWebviewPanel(viewType, title, showOptions, panelOptions) {
        const panel = createPanel(viewType, title, showOptions, panelOptions);
        vscode.panels.push(panel);
        return panel;
      },
      /**
       * @param {string} message
       * @param {...string} items
       */
      async showInformationMessage(message, ...items) {
        vscode.informationMessages.push(message);
        vscode.informationMessageItems.push(items);
        return options.informationSelection;
      },
      /** @param {string} message */
      async showWarningMessage(message) {
        vscode.warningMessages.push(message);
        return options.warningSelection;
      },
      /** @param {Array<string | { label: string }>} items */
      async showQuickPick(items) {
        vscode.quickPickItems.push(items);
        return items[options.quickPickSelectionIndex ?? 0];
      },
      /**
       * @param {string} message
       * @param {number} hideAfterTimeout
       */
      setStatusBarMessage(message, hideAfterTimeout) {
        vscode.statusMessages.push({ message, hideAfterTimeout });
        return { dispose() {} };
      }
    },
    panels: [],
    postedMessages: [],
    quickPickItems: [],
    informationMessages: [],
    informationMessageItems: [],
    warningMessages: [],
    statusMessages: [],
    statusBarItems: [],
    externalUrls: [],
    executedCommands: [],
    configurationUpdates: [],
    MarkdownString,
    ViewColumn: { Active: -1, One: 1, Two: 2 }
  };

  if (options.statusBar) {
    vscode.StatusBarAlignment = { Right: 2 };
    vscode.window.createStatusBarItem = (alignment, priority) => {
      const item = {
        alignment,
        priority,
        text: "",
        tooltip: "",
        command: "",
        visible: false,
        show() {
          item.visible = true;
        },
        hide() {
          item.visible = false;
        },
        dispose() {}
      };
      vscode.statusBarItems.push(item);
      return item;
    };
  }

  return vscode;
}

function createPanel(viewType, title, showOptions, options) {
  let disposeListener = () => {};
  const panel = {
    viewType,
    title,
    showOptions,
    options,
    postedMessages: [],
    webview: {
      html: "",
      async postMessage(message) {
        panel.postedMessages.push(message);
        return true;
      }
    },
    /** @param {() => void} listener */
    onDidDispose(listener) {
      disposeListener = listener;
      return { dispose() {} };
    },
    dispose() {
      disposeListener();
    }
  };
  return panel;
}

/** @param {object} payload */
function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}
