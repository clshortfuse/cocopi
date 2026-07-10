import { runBrowserCodexLogin } from "../auth/browser-login.js";
import { codexTokenMetadata } from "../auth/token.js";
import { closeCodexResponseWebSocketSessions, fetchCodexRateLimitsWithAuthRefresh, fetchCodexUsageAnalyticsWithAuthRefresh, listCodexModelsWithAuthRefresh } from "./codex-request.js";
import { COCOPI_CONFIGURATION_SECTION, COCOPI_INLINE_COMPLETION_MODEL_AUTO, COCOPI_TOKEN_TRACKER_TIMELINE_MODES } from "./configuration.js";
import { readCocopiMemoryUsage } from "./diagnostics.js";
import { clearCocopiIssues, deleteCocopiIssue, initializeCocopiIssueStorage, onCocopiIssueChange, readCocopiIssues, waitForCocopiIssueStorage } from "./issues.js";
import { clearCocopiTokenCacheDebugSummaries, deleteCocopiTokenCacheDebugSession, deleteCocopiTokenCacheDebugSessions, deleteCocopiTokenCacheDebugSummary, deriveCocopiTokenCacheDiagnostics, initializeCocopiTokenCacheDebugStorage, onCocopiTokenCacheDebugSummary, readCocopiTokenCacheDebugSummaries, readCocopiUsageAnalytics, readCocopiUsageWindowStatus, recordCocopiRateLimitSnapshots, recordCocopiRemoteUsageAnalytics, waitForCocopiTokenCacheDebugStorage } from "./token-cache-debug.js";
import { readCocopiRuntime } from "./runtime.js";
import { deleteCodexAuth, readCodexAuth, storeCodexAuth } from "./secret-storage.js";

/** @typedef {import("./runtime.js").CocopiSecretContext} CocopiSecretContext */

/** @typedef {{ toString(): string }} UriLike */

/**
 * @typedef {object} ModelConfigurationUpdate
 * @property {(key: string, value: string | number | boolean, target?: boolean) => Thenable<void>} [update]
 */

/**
 * @typedef {object} StatusPanelConfigurationInspectResult
 * @property {string | number | boolean | undefined} [defaultValue]
 * @property {string | number | boolean | undefined} [globalValue]
 * @property {string | number | boolean | undefined} [workspaceValue]
 * @property {string | number | boolean | undefined} [workspaceFolderValue]
 * @property {string | number | boolean | undefined} [globalLanguageValue]
 * @property {string | number | boolean | undefined} [workspaceLanguageValue]
 * @property {string | number | boolean | undefined} [workspaceFolderLanguageValue]
 */

/**
 * @typedef {object} StatusPanelConfigurationReader
 * @property {{ get(key: string, defaultValue: string): string, get(key: string, defaultValue: number): number, get(key: string, defaultValue: boolean): boolean, inspect?: (key: string) => StatusPanelConfigurationInspectResult | undefined }} workspaceConfiguration
 */

/**
 * @typedef {object} StatusPanelSetting
 * @property {string} key
 * @property {string | number | boolean} value
 * @property {string} source
 * @property {string | number | boolean | undefined} [recommended]
 */

/**
 * @typedef {object} StatusPanelFeatureAuditItem
 * @property {string} title
 * @property {'enabled' | 'limited' | 'disabled' | 'info'} state
 * @property {string} summary
 * @property {string} detail
 * @property {StatusPanelSetting[]} settings
 */

/**
 * @typedef {object} StatusPanelUtilityRouting
 * @property {boolean} available
 * @property {'none' | 'mainAgent' | 'copilot' | 'specific' | 'external'} mode
 * @property {'recommended' | 'custom' | 'required'} state
 * @property {string} utilityModel
 * @property {string} utilitySmallModel
 * @property {string} selectedUtilityModel
 * @property {string} selectedUtilitySmallModel
 * @property {string} summary
 */

/**
 * @typedef {object} CocopiStatusQuickPickItem
 * @property {string} label
 * @property {string} [description]
 * @property {string} [detail]
 * @property {'token-tracker' | 'diagnostics' | 'sign-in' | 'sign-out' | 'select-model' | 'inline-options' | 'toggle-inline' | 'select-inline-model' | 'open-cocopi-inline-settings' | 'open-vscode-inline-settings' | 'inline-debug-events' | 'inline-debug-off'} [action]
 */

/**
 * @typedef {object} CocopiStatusSurfaceController
 * @property {() => Promise<void>} refresh
 * @property {boolean} chatStatusItemAvailable
 */

export const COCOPI_COMMANDS = Object.freeze({
  manage: "cocopi.manage",
  showDiagnostics: "cocopi.showDiagnostics",
  showTokenTracker: "cocopi.showTokenTracker",
  signIn: "cocopi.signIn",
  selectModel: "cocopi.selectModel",
  selectInlineCompletionModel: "cocopi.selectInlineCompletionModel",
  showInlineCompletionOptions: "cocopi.showInlineCompletionOptions",
  toggleInlineCompletions: "cocopi.toggleInlineCompletions",
  status: "cocopi.status",
  signOut: "cocopi.signOut"
});

const COCOPI_STATUS_TOKEN_TRACKER_ACTION = "Open Token Tracker";
const COCOPI_STATUS_DIAGNOSTICS_ACTION = "Open Diagnostics";
const COCOPI_STATUS_BAR_TEXT = "$(cocopi-logo)";
const COCOPI_STATUS_BAR_PRIORITY = 0;
const COCOPI_USAGE_REFRESH_THROTTLE_MS = 120_000;

/** @type {Promise<boolean> | undefined} */
let cocopiUsageRefreshPromise;
/** @type {number} */
let lastCocopiUsageRefreshFailureMs = 0;

/**
 * @typedef {object} VscodeCommandApi
 * @property {{ registerCommand(command: string, callback: () => void | Thenable<void>): { dispose(): void }, executeCommand?: (commandId: string, ...args: unknown[]) => Thenable<unknown> }} commands
 * @property {{ openExternal(target: UriLike): Thenable<boolean> }} env
 * @property {{ parse(value: string): UriLike }} Uri
 * @property {typeof import("vscode").MarkdownString} [MarkdownString]
 * @property {typeof import("vscode").StatusBarAlignment} [StatusBarAlignment]
 * @property {typeof import("vscode").ViewColumn} [ViewColumn]
 * @property {{ getConfiguration(section?: string): StatusPanelConfigurationReader["workspaceConfiguration"] }} workspace
 * @property {{ createStatusBarItem?: typeof import("vscode").window.createStatusBarItem, createChatStatusItem?: typeof import("vscode").window.createChatStatusItem, createWebviewPanel(viewType: string, title: string, showOptions: number, options?: { enableScripts?: boolean, enableCommandUris?: boolean | readonly string[] }): { webview: { html: string, postMessage?: (value: unknown) => Thenable<boolean>, onDidReceiveMessage?: (listener: (message: unknown) => void | Thenable<void>) => { dispose(): void } }, onDidDispose?: (listener: () => void) => { dispose(): void } }, showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined | void>, showWarningMessage(message: string, ...items: string[]): Thenable<string | undefined>, showQuickPick(items: Array<string | { label: string, description?: string, detail?: string, modelId?: string, setting?: string, value?: string, action?: string }>, options?: { placeHolder?: string }): Thenable<string | { label: string, description?: string, detail?: string, modelId?: string, setting?: string, value?: string, action?: string } | undefined | void>, setStatusBarMessage(message: string, hideAfterTimeout: number): { dispose(): void } }} window
 */

/**
 * @param {CocopiSecretContext & { subscriptions: { dispose(): void }[] }} context
 * @param {VscodeCommandApi} vscode
 */
export function registerCocopiCommands(context, vscode) {
  void initializeCocopiIssueStorage(context.secrets);
  void initializeCocopiTokenCacheDebugStorage(context.secrets);
  const statusSurfaces = registerCocopiStatusSurfaces(context, vscode);
  context.subscriptions.push(
    vscode.commands.registerCommand(COCOPI_COMMANDS.manage, () => showManageMenu(context, vscode)),
    vscode.commands.registerCommand(COCOPI_COMMANDS.showDiagnostics, () => showDiagnosticsWindow(vscode)),
    vscode.commands.registerCommand(COCOPI_COMMANDS.showTokenTracker, async () => {
      await showTokenTrackerWindow(context, vscode);
      await statusSurfaces?.refresh();
    }),
    vscode.commands.registerCommand(COCOPI_COMMANDS.signIn, async () => {
      await signIn(context, vscode);
      await statusSurfaces?.refresh();
    }),
    vscode.commands.registerCommand(COCOPI_COMMANDS.selectModel, async () => {
      await selectModel(context, vscode);
      await statusSurfaces?.refresh();
    }),
    vscode.commands.registerCommand(COCOPI_COMMANDS.selectInlineCompletionModel, async () => {
      await selectInlineCompletionModel(context, vscode);
      await statusSurfaces?.refresh();
    }),
    vscode.commands.registerCommand(COCOPI_COMMANDS.showInlineCompletionOptions, async () => {
      await showInlineCompletionOptions(context, vscode);
      await statusSurfaces?.refresh();
    }),
    vscode.commands.registerCommand(COCOPI_COMMANDS.toggleInlineCompletions, async () => {
      await toggleInlineCompletions(context, vscode);
      await statusSurfaces?.refresh();
    }),
    vscode.commands.registerCommand(COCOPI_COMMANDS.status, async () => {
      await showCocopiStatusWindow(context, vscode);
      await statusSurfaces?.refresh();
    }),
    vscode.commands.registerCommand(COCOPI_COMMANDS.signOut, async () => {
      await signOut(context, vscode);
      await statusSurfaces?.refresh();
    })
  );
}

/**
 * @param {CocopiSecretContext & { subscriptions: { dispose(): void }[] }} context
 * @param {VscodeCommandApi} vscode
 * @returns {CocopiStatusSurfaceController | undefined}
 */
function registerCocopiStatusSurfaces(context, vscode) {
  const controllers = [
    registerCocopiStatusBar(context, vscode),
    registerCocopiChatStatusItem(context, vscode)
  ].filter((controller) => controller !== undefined);
  if (controllers.length === 0) {
    return;
  }

  return {
    chatStatusItemAvailable: controllers.some((controller) => controller.chatStatusItemAvailable),
    async refresh() {
      await Promise.all(controllers.map((controller) => controller.refresh()));
    }
  };
}

/**
 * @param {CocopiSecretContext & { subscriptions: { dispose(): void }[] }} context
 * @param {VscodeCommandApi} vscode
 * @returns {CocopiStatusSurfaceController | undefined}
 */
function registerCocopiStatusBar(context, vscode) {
  if (typeof vscode.window.createStatusBarItem !== "function") {
    return;
  }

  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment?.Right, COCOPI_STATUS_BAR_PRIORITY);
  item.name = "Cocopi";
  item.text = COCOPI_STATUS_BAR_TEXT;
  item.tooltip = cocopiStatusBarTooltip(vscode);
  item.command = COCOPI_COMMANDS.status;
  item.show();

  const refresh = () => refreshCocopiStatusBarTooltip(context, vscode, item);
  const unsubscribeTokenSummaries = onCocopiTokenCacheDebugSummary(() => {
    void refresh();
  });
  const unsubscribeIssues = onCocopiIssueChange(() => {
    void refresh();
  });
  context.subscriptions.push(item, { dispose: unsubscribeTokenSummaries }, { dispose: unsubscribeIssues });
  void refresh();
  return { refresh, chatStatusItemAvailable: false };
}

/**
 * @param {CocopiSecretContext & { subscriptions: { dispose(): void }[] }} context
 * @param {VscodeCommandApi} vscode
 * @returns {CocopiStatusSurfaceController | undefined}
 */
function registerCocopiChatStatusItem(context, vscode) {
  if (typeof vscode.window.createChatStatusItem !== "function") {
    return;
  }

  const item = vscode.window.createChatStatusItem("cocopi.status");
  item.title = "Cocopi";
  item.description = "$(sync~spin) Reading status";
  item.detail = "Codex-backed VS Code Chat provider";
  item.tooltip = "Cocopi status";
  item.show();

  const refresh = () => refreshCocopiChatStatusItem(context, vscode, item);
  const unsubscribeTokenSummaries = onCocopiTokenCacheDebugSummary(() => {
    void refresh();
  });
  const unsubscribeIssues = onCocopiIssueChange(() => {
    void refresh();
  });
  context.subscriptions.push(item, { dispose: unsubscribeTokenSummaries }, { dispose: unsubscribeIssues });
  void refresh();
  return { refresh, chatStatusItemAvailable: true };
}

/**
 * @param {CocopiSecretContext} context
 * @param {VscodeCommandApi} vscode
 * @param {{ tooltip: string | import("vscode").MarkdownString | undefined }} item
 */
async function refreshCocopiStatusBarTooltip(context, vscode, item) {
  try {
    await Promise.allSettled([
      waitForCocopiIssueStorage(),
      waitForCocopiTokenCacheDebugStorage()
    ]);
    const runtime = await readCocopiRuntime(context, vscode, { refreshAuth: false });
    const renderTooltip = () => {
      item.tooltip = cocopiStatusBarTooltip(vscode, runtime.auth, runtime, readCocopiUsageWindowStatus(), readCocopiIssues().length);
    };
    renderTooltip();
    if (await refreshSharedCocopiUsageStatus(context, vscode, { refreshAuth: false, runtime })) {
      renderTooltip();
    }
  } catch {
    item.tooltip = cocopiStatusBarTooltip(vscode);
  }
}

/**
 * @param {CocopiSecretContext} context
 * @param {VscodeCommandApi} vscode
 * @param {import("vscode").ChatStatusItem} item
 */
async function refreshCocopiChatStatusItem(context, vscode, item) {
  try {
    await Promise.allSettled([
      waitForCocopiIssueStorage(),
      waitForCocopiTokenCacheDebugStorage()
    ]);
    const runtime = await readCocopiRuntime(context, vscode, { refreshAuth: false });
    const renderItem = () => {
      writeCocopiChatStatusItem(item, runtime.auth, runtime, readCocopiUsageWindowStatus(), readCocopiIssues().length);
    };
    renderItem();
    if (await refreshSharedCocopiUsageStatus(context, vscode, { refreshAuth: false, runtime })) {
      renderItem();
    }
  } catch {
    item.title = "Cocopi";
    item.description = "$(warning) Status unavailable";
    item.detail = chatStatusCommandLinks([
      [COCOPI_COMMANDS.status, "Open Status"],
      [COCOPI_COMMANDS.showDiagnostics, "Diagnostics"]
    ]);
    item.tooltip = "Cocopi status could not be read.";
    item.show();
  }
}

/**
 * @param {import("vscode").ChatStatusItem} item
 * @param {import("./runtime.js").CocopiRuntime["auth"]} auth
 * @param {import("./runtime.js").CocopiRuntime} runtime
 * @param {import("./token-cache-debug.js").CocopiUsageWindowStatus} usage
 * @param {number} issueCount
 */
function writeCocopiChatStatusItem(item, auth, runtime, usage, issueCount) {
  const usageSummary = chatStatusUsageSummary(usage);
  const inline = runtime.configuration.inlineCompletions;
  item.title = "Cocopi";
  item.description = auth
    ? `$(check) Signed in${usageSummary ? ` · ${usageSummary}` : ""}`
    : "$(warning) Not signed in";
  item.detail = [
    `$(server) Fallback model: ${escapeMarkdownText(runtime.configuration.model)}`,
    `$(sparkle) Inline completions: ${inline.enabled ? "Enabled" : "Disabled"} · ${escapeMarkdownText(inline.model)}`,
    `$(bug) Diagnostics: ${formatTokenCacheNumber(issueCount)} ${issueCount === 1 ? "issue" : "issues"}`,
    chatStatusCommandLinks([
      [auth ? COCOPI_COMMANDS.signOut : COCOPI_COMMANDS.signIn, auth ? "Sign Out" : "Sign In"],
      [COCOPI_COMMANDS.showInlineCompletionOptions, "Inline Options"],
      [COCOPI_COMMANDS.showTokenTracker, "Token Tracker"],
      [COCOPI_COMMANDS.showDiagnostics, "Diagnostics"]
    ])
  ].join("\n");
  item.tooltip = "Cocopi contributes this section to VS Code's native Chat status dashboard when the proposed ChatStatusItem API is available.";
  item.show();
}

/** @param {import("./token-cache-debug.js").CocopiUsageWindowStatus} usage */
function chatStatusUsageSummary(usage) {
  const rateLimits = statusUsageRateLimitSummaries(usage);
  if (rateLimits.length > 0) {
    return rateLimits.join(" · ");
  }

  if (usage.requestCount > 0) {
    return `${formatTokenCacheTokenCount(usage.billableTokens)} local`;
  }

  return "";
}

/** @param {Array<[string, string]>} links */
function chatStatusCommandLinks(links) {
  return links.map(([command, label]) => `[${escapeMarkdownText(label)}](command:${command})`).join(" · ");
}

/** @param {string} value */
function escapeMarkdownText(value) {
  const escape = String.fromCodePoint(92);
  return value.replaceAll(escape, escape.repeat(2)).replaceAll("[", `${escape}[`).replaceAll("]", `${escape}]`);
}

/**
 * @param {CocopiSecretContext} context
 * @param {VscodeCommandApi} vscode
 * @param {{ force?: boolean, refreshAuth?: boolean, runtime?: import("./runtime.js").CocopiRuntime }} [options]
 * @returns {Promise<boolean>}
 */
async function refreshSharedCocopiUsageStatus(context, vscode, options = {}) {
  if (cocopiUsageRefreshPromise) {
    return cocopiUsageRefreshPromise;
  }

  const now = Date.now();
  if (!options.force && shouldThrottleSharedUsageRefresh(now)) {
    return false;
  }

  cocopiUsageRefreshPromise = refreshSharedCocopiUsageStatusNow(context, vscode, options)
    .finally(() => {
      cocopiUsageRefreshPromise = undefined;
    });
  return cocopiUsageRefreshPromise;
}

/** @param {number} now */
function shouldThrottleSharedUsageRefresh(now) {
  const capturedAtMs = Date.parse(readCocopiUsageWindowStatus({ now: new Date(now) }).apiCapturedAt ?? "");
  if (Number.isFinite(capturedAtMs) && now - capturedAtMs < COCOPI_USAGE_REFRESH_THROTTLE_MS) {
    return true;
  }

  return lastCocopiUsageRefreshFailureMs > 0
    && now - lastCocopiUsageRefreshFailureMs < COCOPI_USAGE_REFRESH_THROTTLE_MS;
}

/**
 * @param {CocopiSecretContext} context
 * @param {VscodeCommandApi} vscode
 * @param {{ refreshAuth?: boolean, runtime?: import("./runtime.js").CocopiRuntime }} options
 * @returns {Promise<boolean>}
 */
async function refreshSharedCocopiUsageStatusNow(context, vscode, options) {
  const runtimeOptions = options.refreshAuth === undefined ? undefined : { refreshAuth: options.refreshAuth };
  const runtime = options.runtime ?? await readCocopiRuntime(context, vscode, runtimeOptions);
  if (!runtime.auth) {
    return false;
  }

  try {
    recordCocopiRateLimitSnapshots(await fetchCodexRateLimitsWithAuthRefresh(context, runtime));
    try {
      recordCocopiRemoteUsageAnalytics(await fetchCodexUsageAnalyticsWithAuthRefresh(context, runtime));
    } catch {
      // Remote analytics are supplementary; quota status should still refresh when they are unavailable.
    }
    lastCocopiUsageRefreshFailureMs = 0;
    return true;
  } catch {
    lastCocopiUsageRefreshFailureMs = Date.now();
    return false;
  }
}

/**
 * @param {VscodeCommandApi} vscode
 * @param {import("./runtime.js").CocopiRuntime["auth"]} [auth]
 * @param {import("./runtime.js").CocopiRuntime} [runtime]
 * @param {import("./token-cache-debug.js").CocopiUsageWindowStatus} [usage]
 * @param {number} [issueCount]
 */
function cocopiStatusBarTooltip(vscode, auth, runtime, usage, issueCount) {
  const commandLinks = statusMarkdownCommandLinks(statusHoverCommandRows(auth));
  const markdown = [
    "**Cocopi**",
    "",
    cocopiStatusHoverSummaryHtml(auth, runtime, usage, issueCount),
    "",
    ...commandLinks,
    "",
    "Click for the full Cocopi dashboard."
  ].join("\n");

  if (typeof vscode.MarkdownString !== "function") {
    return markdown;
  }

  const tooltip = new vscode.MarkdownString(markdown, true);
  tooltip.supportHtml = true;
  tooltip.isTrusted = {
    enabledCommands: [
      COCOPI_COMMANDS.status,
      COCOPI_COMMANDS.showTokenTracker,
      COCOPI_COMMANDS.showDiagnostics,
      COCOPI_COMMANDS.signIn,
      COCOPI_COMMANDS.signOut,
      COCOPI_COMMANDS.selectModel,
      COCOPI_COMMANDS.showInlineCompletionOptions,
      COCOPI_COMMANDS.selectInlineCompletionModel,
      COCOPI_COMMANDS.toggleInlineCompletions
    ]
  };
  return tooltip;
}

/**
 * @param {import("./runtime.js").CocopiRuntime["auth"]} [auth]
 * @param {import("./runtime.js").CocopiRuntime} [runtime]
 */
function cocopiStatusDashboardHtml(auth, runtime) {
  return [
    '<section class="dashboard">',
    statusDashboardHeroHtml(statusAuthSummaryRow(auth, runtime)),
    '</section>'
  ].join("\n");
}

/**
 * @param {import("./runtime.js").CocopiRuntime["auth"]} [auth]
 * @param {import("./runtime.js").CocopiRuntime} [runtime]
 * @param {import("./token-cache-debug.js").CocopiUsageWindowStatus} [usage]
 * @param {number} [issueCount]
 */
function cocopiStatusHoverSummaryHtml(auth, runtime, usage, issueCount) {
  return [
    "<table>",
    "<tbody>",
    statusHoverTableRow(statusHoverAccountLabel(auth, runtime), statusHoverAccountText(auth, runtime)),
    statusHoverTableRow("$(server) Model", runtime?.configuration.model ?? "Loading"),
    statusHoverTableRow("$(edit) Inline", statusHoverInlineCompletionText(runtime)),
    ...statusHoverUsageRows(usage),
    statusHoverTableRow(statusHoverDiagnosticsLabel(issueCount), statusHoverDiagnosticsText(issueCount)),
    "</tbody>",
    "</table>"
  ].join("");
}

/**
 * @param {string} label
 * @param {string} detail
 */
function statusHoverTableRow(label, detail) {
  return `<tr><th scope="row" style="text-align: left; padding-right: 1em; white-space: nowrap">${htmlTableCell(label)}</th><td>${htmlTableCell(detail)}</td></tr>`;
}

/**
 * @param {import("./runtime.js").CocopiRuntime["auth"] | undefined} auth
 * @param {import("./runtime.js").CocopiRuntime | undefined} runtime
 */
function statusHoverAccountLabel(auth, runtime) {
  if (!runtime) {
    return "$(sync~spin) Account";
  }

  return auth ? "$(check) Account" : "$(warning) Account";
}

/**
 * @param {import("./runtime.js").CocopiRuntime["auth"] | undefined} auth
 * @param {import("./runtime.js").CocopiRuntime | undefined} runtime
 */
function statusHoverAccountText(auth, runtime) {
  if (!runtime) {
    return "Loading";
  }

  if (auth?.chatgptPlanType) {
    return `Signed in · ${auth.chatgptPlanType}`;
  }

  if (auth) {
    return "Signed in";
  }

  return "Not signed in";
}

/** @param {import("./runtime.js").CocopiRuntime | undefined} runtime */
function statusHoverInlineCompletionText(runtime) {
  if (!runtime) {
    return "Loading";
  }

  const state = runtime.configuration.inlineCompletions.enabled ? "On" : "Off";
  return `${state} · ${runtime.configuration.inlineCompletions.model}`;
}

/** @param {import("./token-cache-debug.js").CocopiUsageWindowStatus | undefined} usage */
function statusHoverUsageRows(usage) {
  if (!usage) {
    return [statusHoverTableRow("$(pulse) Usage", "Open Token Tracker for live limits")];
  }

  const rateLimits = statusUsageRateLimitWindows(usage);
  if (rateLimits.length > 0) {
    return rateLimits.map((entry) => statusHoverTableRow(
      `${entry.icon} ${entry.bucket} ${entry.windowLabel}`,
      `${entry.remaining} left${entry.reset ? ` · resets ${entry.reset}` : ""}`
    ));
  }

  return [statusHoverTableRow("$(pulse) Usage", `${formatTokenCacheTokenCount(usage.billableTokens)} · ${formatTokenCacheNumber(usage.requestCount)} ${usage.requestCount === 1 ? "request" : "requests"}`)];
}

/** @param {number | undefined} issueCount */
function statusHoverDiagnosticsText(issueCount) {
  if (typeof issueCount !== "number") {
    return "Loading";
  }

  if (issueCount === 0) {
    return "No issues";
  }

  return `${formatTokenCacheNumber(issueCount)} ${issueCount === 1 ? "issue" : "issues"}`;
}

/** @param {number | undefined} issueCount */
function statusHoverDiagnosticsLabel(issueCount) {
  if (typeof issueCount !== "number") {
    return "$(sync~spin) Diagnostics";
  }

  return issueCount === 0 ? "$(check) Diagnostics" : "$(bug) Diagnostics";
}

/** @param {{ icon: string, title: string, detail: string, meta?: string }} row */
function statusDashboardHeroHtml(row) {
  return [
    '<article class="status-card hero">',
    `<div class="status-icon" aria-hidden="true">${htmlTableCell(row.icon)}</div>`,
    '<div>',
    `<h2>${htmlTableCell(row.title)}</h2>`,
    `<p>${htmlTableCell(row.detail)}</p>`,
    row.meta ? `<p class="status-meta">${htmlTableCell(row.meta)}</p>` : "",
    '</div>',
    '</article>'
  ].filter(Boolean).join("\n");
}

/**
 * @param {import("./runtime.js").CocopiRuntime["auth"] | undefined} auth
 * @param {import("./runtime.js").CocopiRuntime | undefined} runtime
 */
function statusAuthSummaryRow(auth, runtime) {
  if (!runtime) {
    return { icon: "…", title: "Loading Cocopi", detail: "Reading local state", meta: "Cocopi status" };
  }

  if (auth?.chatgptPlanType) {
    return { icon: "✓", title: "Codex account ready", detail: `Signed in · ${auth.chatgptPlanType}`, meta: "Cocopi status" };
  }

  if (auth) {
    return { icon: "✓", title: "Codex account ready", detail: "Signed in", meta: "Cocopi status" };
  }

  return { icon: "!", title: "Sign in to Codex", detail: "Run Cocopi: Sign In", meta: "Cocopi status" };
}

/**
 * @param {import("./runtime.js").CocopiRuntime["auth"] | undefined} auth
 * @returns {Array<Array<{ command: string, label: string }>>}
 */
function statusHoverCommandRows(auth) {
  /** @type {Array<{ command: string, label: string }>} */
  const primary = [
    { command: COCOPI_COMMANDS.status, label: "Open Dashboard" },
    { command: COCOPI_COMMANDS.showTokenTracker, label: "Token Tracker" },
    { command: COCOPI_COMMANDS.showDiagnostics, label: "Diagnostics" }
  ];
  if (!auth) {
    primary.push({ command: COCOPI_COMMANDS.signIn, label: "Sign In" });
  }

  return [primary];
}

/** @param {Array<Array<{ command: string, label: string }>>} rows */
function statusMarkdownCommandLinks(rows) {
  return rows.map((row) => row.map((link) => `[${link.label}](command:${link.command})`).join(" · "));
}

/** @param {string} value */
function htmlTableCell(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll(/\r?\n/gu, " ");
}

/** @param {VscodeCommandApi} vscode */
function cocopiWebviewColumn(vscode) {
  return vscode.ViewColumn?.Active ?? 1;
}

/**
 * @param {CocopiSecretContext} context
 * @param {VscodeCommandApi} vscode
 */
async function showCocopiStatusWindow(context, vscode) {
  const panel = vscode.window.createWebviewPanel(
    "cocopiStatus",
    "Cocopi",
    cocopiWebviewColumn(vscode),
    {
      enableScripts: true
    }
  );
  const render = async () => {
    const snapshot = await readCocopiStatusSnapshot(context, vscode);
    panel.webview.html = cocopiStatusWindowHtml(snapshot.auth, snapshot.runtime, snapshot.usage, snapshot.issueCount, snapshot.featureAudit, snapshot.models, snapshot.utilityRouting);
  };
  await render();

  if (typeof panel.webview.onDidReceiveMessage === "function") {
    panel.webview.onDidReceiveMessage(async (message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        return;
      }

      const command = /** @type {{ command?: unknown }} */ (message).command;
      if (command === "refresh" || command === COCOPI_COMMANDS.status) {
        await render();
        return;
      }

      const record = /** @type {Record<string, unknown>} */ (message);
      if (record.type === "updateUtilityRouting") {
        await updateCocopiStatusPanelUtilityRouting(vscode, record);
        await render();
        return;
      }

      if (record.type === "updateSettings") {
        await updateCocopiStatusPanelSettings(vscode, record.settings);
        await render();
        return;
      }

      if (record.type === "openSettings") {
        const query = statusPanelSettingsQuery(typeof record.query === "string" ? record.query : undefined);
        if (query) {
          await vscode.commands.executeCommand?.("workbench.action.openSettings", query);
        }
        return;
      }

      if (typeof command === "string" && allowedCocopiStatusPanelCommands().includes(command)) {
        await vscode.commands.executeCommand?.(command);
        await render();
      }
    });
  }
}

/**
 * @param {CocopiSecretContext} context
 * @param {VscodeCommandApi} vscode
 */
async function readCocopiStatusSnapshot(context, vscode) {
  await Promise.allSettled([
    waitForCocopiIssueStorage(),
    waitForCocopiTokenCacheDebugStorage()
  ]);
  const auth = await readCodexAuth(context.secrets);
  const runtime = await readCocopiRuntime(context, vscode);
  await refreshSharedCocopiUsageStatus(context, vscode, { runtime });
  const models = await readCocopiStatusModels(context, runtime);
  const utilityRouting = readCocopiStatusUtilityRouting(vscode, runtime, models);
  return {
    auth,
    runtime,
    models,
    utilityRouting,
    featureAudit: readCocopiStatusFeatureAudit(vscode, runtime),
    usage: readCocopiUsageWindowStatus(),
    issueCount: readCocopiIssues().length
  };
}

/**
 * @param {VscodeCommandApi} vscode
 * @param {import("./runtime.js").CocopiRuntime} runtime
 * @param {import("../../data/Codex.js").CodexModelSummary[]} models
 * @returns {StatusPanelUtilityRouting}
 */
function readCocopiStatusUtilityRouting(vscode, runtime, models) {
  const configuration = vscode.workspace.getConfiguration("chat");
  const available = Boolean(configuration.inspect?.("byokUtilityModelDefault"));
  const defaultMode = configuration.get("byokUtilityModelDefault", "none");
  const utilityModel = configuration.get("utilityModel", "").trim();
  const utilitySmallModel = configuration.get("utilitySmallModel", "").trim();
  const utilityModelId = cocopiQualifiedModelId(utilityModel);
  const utilitySmallModelId = cocopiQualifiedModelId(utilitySmallModel);
  const hasOverride = Boolean(utilityModel || utilitySmallModel);
  const hasOnlyCocopiOverrides = (!utilityModel || Boolean(utilityModelId))
    && (!utilitySmallModel || Boolean(utilitySmallModelId));
  /** @type {StatusPanelUtilityRouting["mode"]} */
  let mode;
  if (hasOverride) {
    mode = hasOnlyCocopiOverrides ? "specific" : "external";
  } else if (defaultMode === "mainAgent" || defaultMode === "copilot") {
    mode = defaultMode;
  } else {
    mode = "none";
  }

  const selectedUtilityModel = utilityModelId ?? preferredCocopiUtilityModel(models, runtime.configuration.model);
  const selectedUtilitySmallModel = utilitySmallModelId ?? preferredCocopiSmallUtilityModel(models, runtime.configuration.model);
  const complete = mode !== "specific" || Boolean(utilityModelId && utilitySmallModelId);
  const recommended = mode === "specific"
    && utilityModelId === "gpt-5.6-terra"
    && utilitySmallModelId === "gpt-5.6-luna";
  return {
    available,
    mode,
    state: recommended ? "recommended" : (complete ? "custom" : "required"),
    utilityModel,
    utilitySmallModel,
    selectedUtilityModel,
    selectedUtilitySmallModel,
    summary: utilityRoutingSummary(mode, complete, utilityModel, utilitySmallModel)
  };
}

/** @param {string} qualifiedModel */
function cocopiQualifiedModelId(qualifiedModel) {
  const prefix = "cocopi/";
  return qualifiedModel.startsWith(prefix) && qualifiedModel.length > prefix.length
    ? qualifiedModel.slice(prefix.length)
    : undefined;
}

/** @param {import("../../data/Codex.js").CodexModelSummary[]} models */
function hasGpt56UtilityModelSet(models) {
  const modelIds = new Set(models.map((model) => model.id));
  return ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].every((modelId) => modelIds.has(modelId));
}

/**
 * @param {import("../../data/Codex.js").CodexModelSummary[]} models
 * @param {string} fallbackModel
 */
function preferredCocopiUtilityModel(models, fallbackModel) {
  return hasGpt56UtilityModelSet(models) ? "gpt-5.6-terra" : fallbackModel;
}

/**
 * @param {import("../../data/Codex.js").CodexModelSummary[]} models
 * @param {string} fallbackModel
 */
function preferredCocopiSmallUtilityModel(models, fallbackModel) {
  if (hasGpt56UtilityModelSet(models)) {
    return "gpt-5.6-luna";
  }
  return models.toSorted(compareInlineCompletionModelQuickPickItems)[0]?.id ?? fallbackModel;
}

/**
 * @param {StatusPanelUtilityRouting["mode"]} mode
 * @param {boolean} complete
 * @param {string} utilityModel
 * @param {string} utilitySmallModel
 */
function utilityRoutingSummary(mode, complete, utilityModel, utilitySmallModel) {
  switch (mode) {
    case "copilot": {
      return "Background tasks use GitHub Copilot.";
    }
    case "mainAgent": {
      return "Background tasks use the main chat model.";
    }
    case "specific": {
      return complete
        ? "Larger and quick background tasks use dedicated Cocopi models."
        : "Choose Cocopi models for both larger and quick background tasks.";
    }
    case "external": {
      return `Background tasks use an existing custom provider: ${[utilityModel, utilitySmallModel].filter(Boolean).join(" · ")}.`;
    }
    default: {
      return "Background tasks are disabled.";
    }
  }
}

/**
 * @param {CocopiSecretContext} context
 * @param {import("./runtime.js").CocopiRuntime} runtime
 * @returns {Promise<import("../../data/Codex.js").CodexModelSummary[]>}
 */
async function readCocopiStatusModels(context, runtime) {
  if (!runtime.auth) {
    return [];
  }

  try {
    return await listCodexModelsWithAuthRefresh(context, runtime);
  } catch {
    return [];
  }
}

/**
 * @param {VscodeCommandApi} vscode
 * @param {import("./runtime.js").CocopiRuntime} runtime
 * @returns {StatusPanelFeatureAuditItem[]}
 */
function readCocopiStatusFeatureAudit(vscode, runtime) {
  const inlineEnabled = readStatusPanelSetting(vscode, COCOPI_CONFIGURATION_SECTION, "inlineCompletions.enabled", runtime.configuration.inlineCompletions.enabled, true);
  const inlineHost = readStatusPanelSetting(vscode, "editor.inlineSuggest", "enabled", true, true);
  const tokenTracking = readStatusPanelSetting(vscode, COCOPI_CONFIGURATION_SECTION, "tokenTracking", true, true);
  const issueTracking = readStatusPanelSetting(vscode, COCOPI_CONFIGURATION_SECTION, "issueTracking", runtime.configuration.issueTracking, true);
  const debugLevel = readStatusPanelSetting(vscode, COCOPI_CONFIGURATION_SECTION, "debugLevel", runtime.configuration.debugLevel, "off");
  const reasoningSummary = readStatusPanelSetting(vscode, COCOPI_CONFIGURATION_SECTION, "reasoningSummary", runtime.configuration.reasoningSummary, "auto");
  const toolStrict = readStatusPanelSetting(vscode, COCOPI_CONFIGURATION_SECTION, "toolStrict", runtime.configuration.toolStrict, true);
  const editProgressIntervalMs = readStatusPanelSetting(vscode, COCOPI_CONFIGURATION_SECTION, "editProgressIntervalMs", runtime.configuration.editProgressIntervalMs ?? 0, 30_000);
  const useModelDefaultCompactionLimit = readStatusPanelSetting(vscode, COCOPI_CONFIGURATION_SECTION, "useModelDefaultCompactionLimit", runtime.configuration.useModelDefaultCompactionLimit, true);
  const compactionFallbackStrategy = readStatusPanelSetting(vscode, COCOPI_CONFIGURATION_SECTION, "compactionFallbackStrategy", runtime.configuration.compactionFallbackStrategy, "ninety-percent");

  return [
    {
      title: "Inline autocomplete",
      state: inlineEnabled.value === false ? "disabled" : (inlineHost.value === false ? "limited" : "enabled"),
      summary: inlineEnabled.value === false
        ? "Cocopi inline completions are off."
        : (inlineHost.value === false
          ? "Cocopi inline completions are on, but VS Code inline suggestions are disabled."
          : "Cocopi and VS Code inline suggestion settings are enabled."),
      detail: inlineEnabled.value === false
        ? "Enable Cocopi inline completions to request ghost-text completions."
        : (inlineHost.value === false
          ? "Set editor.inlineSuggest.enabled to true so VS Code can show Cocopi ghost text."
          : "The selected Cocopi inline model can appear as editor ghost text."),
      settings: [inlineEnabled, inlineHost]
    },
    {
      title: "Token Tracker recording",
      state: tokenTracking.value === false ? "disabled" : "enabled",
      summary: tokenTracking.value === false ? "Local request and token summaries are not recorded." : "Local request, cache, and quota history are recorded.",
      detail: tokenTracking.value === false ? "Enable this before relying on local usage, cache-risk, or quota trend history." : "Private local diagnostics remain in VS Code extension storage.",
      settings: [tokenTracking]
    },
    {
      title: "Runtime diagnostics",
      state: issueTracking.value === false ? "disabled" : "enabled",
      summary: issueTracking.value === false ? "Cocopi runtime issue records are disabled." : "Cocopi can record private runtime issue diagnostics.",
      detail: issueTracking.value === false ? "Enable this before relying on Diagnostics for cache, replay, or transport anomalies." : "Debug logging controls extra output-channel detail; issue records avoid prompts and credentials.",
      settings: [issueTracking, debugLevel]
    },
    {
      title: "Reasoning summaries",
      state: reasoningSummary.value === "off" ? "disabled" : "enabled",
      summary: reasoningSummary.value === "off" ? "Cocopi will not request visible reasoning summaries." : "Cocopi requests model-supported reasoning summaries.",
      detail: reasoningSummary.value === "off" ? "Enable summaries if users should see model reasoning progress/details when available." : "Request-specific VS Code model options can still override this default.",
      settings: [reasoningSummary]
    },
    {
      title: "Tool schema strictness",
      state: toolStrict.value === false ? "limited" : "enabled",
      summary: toolStrict.value === false ? "Cocopi sends non-strict tool schemas." : "Cocopi sends strict tool schemas to Codex.",
      detail: toolStrict.value === false ? "Enable strict schemas for stronger structured tool-call validation when supported." : "Request-specific tool options can still override this default.",
      settings: [toolStrict]
    },
    {
      title: "Edit progress updates",
      state: editProgressIntervalMs.value === 0 ? "disabled" : "enabled",
      summary: editProgressIntervalMs.value === 0 ? "Timed edit progress updates are disabled." : "Cocopi can show timed progress for long streamed edits.",
      detail: editProgressIntervalMs.value === 0 ? "Set a positive interval to surface elapsed-time progress while edit tool arguments stream." : "This affects Cocopi progress reporting, not VS Code's general progress UI preference.",
      settings: [editProgressIntervalMs]
    },
    {
      title: "Context budgeting",
      state: useModelDefaultCompactionLimit.value === false ? "limited" : "enabled",
      summary: useModelDefaultCompactionLimit.value === false ? "Cocopi ignores model-provided compaction thresholds." : "Cocopi uses model-provided compaction thresholds when available.",
      detail: useModelDefaultCompactionLimit.value === false ? "The fallback strategy still applies, but model-specific context budgeting is reduced." : "The fallback strategy is used only when the model catalog does not provide a threshold.",
      settings: [useModelDefaultCompactionLimit, compactionFallbackStrategy]
    }
  ];
}

/** @returns {Set<string>} */
function statusPanelKnownSettings() {
  return new Set([
    "cocopi.inlineCompletions.enabled",
    "editor.inlineSuggest.enabled",
    "cocopi.tokenTracking",
    "cocopi.issueTracking",
    "cocopi.debugLevel",
    "cocopi.reasoningSummary",
    "cocopi.toolStrict",
    "cocopi.editProgressIntervalMs",
    "cocopi.useModelDefaultCompactionLimit",
    "cocopi.compactionFallbackStrategy",
    "chat.byokUtilityModelDefault",
    "chat.utilityModel",
    "chat.utilitySmallModel"
  ]);
}

/** @param {string | undefined} query */
function statusPanelSettingsQuery(query) {
  return typeof query === "string" && statusPanelKnownSettings().has(query) ? query : undefined;
}

/**
 * @param {VscodeCommandApi} vscode
 * @param {string} section
 * @param {string} key
 * @param {string | number | boolean} defaultValue
 * @param {string | number | boolean} recommended
 * @returns {StatusPanelSetting}
 */
function readStatusPanelSetting(vscode, section, key, defaultValue, recommended) {
  const configuration = vscode.workspace.getConfiguration(section);
  /** @type {string | number | boolean} */
  let value;
  if (typeof defaultValue === "string") {
    value = configuration.get(key, defaultValue);
  } else if (typeof defaultValue === "number") {
    value = configuration.get(key, defaultValue);
  } else {
    value = configuration.get(key, defaultValue);
  }
  return {
    key: section ? `${section}.${key}` : key,
    value,
    recommended,
    source: statusPanelSettingSource(configuration.inspect?.(key))
  };
}

/** @param {StatusPanelConfigurationInspectResult | undefined} inspected */
function statusPanelSettingSource(inspected) {
  if (!inspected) {
    return "current";
  }
  if (inspected.workspaceFolderLanguageValue !== undefined) {
    return "workspace folder language";
  }
  if (inspected.workspaceLanguageValue !== undefined) {
    return "workspace language";
  }
  if (inspected.globalLanguageValue !== undefined) {
    return "user language";
  }
  if (inspected.workspaceFolderValue !== undefined) {
    return "workspace folder";
  }
  if (inspected.workspaceValue !== undefined) {
    return "workspace";
  }
  if (inspected.globalValue !== undefined) {
    return "user";
  }

  return "default";
}

/** @returns {string[]} */
function allowedCocopiStatusPanelCommands() {
  return [
    COCOPI_COMMANDS.showTokenTracker,
    COCOPI_COMMANDS.showDiagnostics,
    COCOPI_COMMANDS.signIn,
    COCOPI_COMMANDS.signOut
  ];
}

/* eslint-disable jsdoc/check-types -- Webview messages are untyped external data. */

/**
 * @param {VscodeCommandApi} vscode
 * @param {unknown} settings
 */
async function updateCocopiStatusPanelSettings(vscode, settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return;
  }

  const configuration = /** @type {ModelConfigurationUpdate} */ (vscode.workspace.getConfiguration(COCOPI_CONFIGURATION_SECTION));
  for (const [key, value] of Object.entries(settings)) {
    if (key === "inlineCompletionChoice") {
      for (const normalized of statusPanelInlineCompletionChoiceValues(value)) {
        await configuration.update?.(normalized.key, normalized.value, true);
      }
      continue;
    }

    const normalized = statusPanelConfigurationValue(key, value);
    if (!normalized) {
      continue;
    }

    await configuration.update?.(normalized.key, normalized.value, true);
  }
}

/**
 * @param {VscodeCommandApi} vscode
 * @param {Record<string, unknown>} message
 */
async function updateCocopiStatusPanelUtilityRouting(vscode, message) {
  const mode = typeof message.mode === "string" ? message.mode : "";
  const configuration = /** @type {ModelConfigurationUpdate} */ (vscode.workspace.getConfiguration("chat"));
  if (mode === "recommended") {
    await configuration.update?.("utilityModel", "cocopi/gpt-5.6-terra", true);
    await configuration.update?.("utilitySmallModel", "cocopi/gpt-5.6-luna", true);
    await configuration.update?.("byokUtilityModelDefault", "none", true);
    return;
  }

  if (mode === "none" || mode === "mainAgent" || mode === "copilot") {
    await configuration.update?.("utilityModel", "", true);
    await configuration.update?.("utilitySmallModel", "", true);
    await configuration.update?.("byokUtilityModelDefault", mode, true);
    return;
  }

  if (mode !== "specific") {
    return;
  }

  const utilityModel = normalizedCocopiQualifiedModel(message.utilityModel);
  const utilitySmallModel = normalizedCocopiQualifiedModel(message.utilitySmallModel);
  if (!utilityModel || !utilitySmallModel) {
    return;
  }

  await configuration.update?.("utilityModel", utilityModel, true);
  await configuration.update?.("utilitySmallModel", utilitySmallModel, true);
  await configuration.update?.("byokUtilityModelDefault", "none", true);
}

/** @param {unknown} value */
function normalizedCocopiQualifiedModel(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return cocopiQualifiedModelId(text) ? text : undefined;
}

/**
 * @param {unknown} value
 * @returns {Array<{ key: string, value: string | boolean }>}
 */
function statusPanelInlineCompletionChoiceValues(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "off") {
    return [{ key: "inlineCompletions.enabled", value: false }];
  }

  if (text === COCOPI_INLINE_COMPLETION_MODEL_AUTO) {
    return [
      { key: "inlineCompletions.enabled", value: true },
      { key: "inlineCompletions.model", value: COCOPI_INLINE_COMPLETION_MODEL_AUTO }
    ];
  }

  if (text.startsWith("model:")) {
    const model = text.slice("model:".length).trim();
    return model ? [
      { key: "inlineCompletions.enabled", value: true },
      { key: "inlineCompletions.model", value: model }
    ] : [];
  }

  return [];
}

/**
 * @param {string} key
 * @param {unknown} value
 * @returns {{ key: string, value: string | number | boolean } | undefined}
 */
function statusPanelConfigurationValue(key, value) {
  if (key === "model" || key === "inlineCompletions.model") {
    const text = typeof value === "string" ? value.trim() : "";
    return text ? { key, value: text } : undefined;
  }

  if (key === "inlineCompletions.enabled") {
    return typeof value === "boolean" ? { key, value } : undefined;
  }

  if (key === "inlineCompletions.maxPrefixCharacters" || key === "inlineCompletions.maxSuffixCharacters" || key === "inlineCompletions.timeoutMs") {
    const numberValue = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numberValue) || numberValue < 0) {
      return;
    }

    return { key, value: Math.trunc(numberValue) };
  }

  if (key === "debugLevel" && typeof value === "string" && ["off", "metadata", "events", "payloads"].includes(value)) {
    return { key, value };
  }

  return;
}

/* eslint-enable jsdoc/check-types */

/**
 * @param {import("./runtime.js").CocopiRuntime["auth"]} auth
 * @param {import("./runtime.js").CocopiRuntime} runtime
 * @param {import("./token-cache-debug.js").CocopiUsageWindowStatus} usage
 * @param {number} issueCount
 * @param {StatusPanelFeatureAuditItem[]} featureAudit
 * @param {import("../../data/Codex.js").CodexModelSummary[]} [models]
 * @param {StatusPanelUtilityRouting} [utilityRouting]
 */
function cocopiStatusWindowHtml(auth, runtime, usage, issueCount, featureAudit, models = [], utilityRouting) {
  const actions = cocopiStatusDashboardActionsHtml(auth);
  const features = cocopiStatusFeatureAuditHtml(featureAudit);
  const settings = cocopiStatusDashboardSettingsHtml(runtime, models);
  const utilityModels = utilityRouting ? cocopiStatusUtilityRoutingHtml(utilityRouting, models) : "";
  const conversationContext = cocopiStatusConversationContextHtml();
  const usageMeters = cocopiStatusUsageMetersHtml(usage);
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cocopi</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 13px; line-height: 1.4; margin: 0; padding: 20px; }
    main { display: grid; gap: 16px; margin: 0 auto; max-width: 900px; }
    header { align-items: center; display: flex; gap: 12px; justify-content: space-between; }
    h1 { font-size: 22px; font-weight: 750; letter-spacing: -0.03em; margin: 0; }
    .dashboard { display: grid; gap: 12px; }
    .status-card, .control-card, .feature-panel, .feature-card, .usage-panel, .links { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); border-radius: 14px; box-shadow: 0 8px 24px rgb(0 0 0 / 0.14); }
    .status-card { align-items: start; display: grid; gap: 10px; grid-template-columns: auto 1fr; min-height: 104px; padding: 14px; }
    .status-card.hero { background: linear-gradient(135deg, color-mix(in srgb, var(--vscode-button-background) 22%, transparent), var(--vscode-editorWidget-background)); min-height: 112px; }
    .status-icon { align-items: center; background: color-mix(in srgb, var(--vscode-button-background) 16%, transparent); border: 1px solid color-mix(in srgb, var(--vscode-button-background) 35%, transparent); border-radius: 999px; color: var(--vscode-button-background); display: inline-flex; font-size: 15px; height: 28px; justify-content: center; width: 28px; }
    h2, h3 { font-size: 14px; font-weight: 650; margin: 0 0 6px; }
    .status-card p { margin: 0; }
    .status-meta, .hint, .field-hint { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 4px !important; }
    .control-grid { align-items: start; display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
    .control-card { display: grid; gap: 12px; padding: 14px; }
    .control-card h2 { margin-bottom: 0; }
    .utility-panel { display: grid; gap: 12px; padding: 14px; }
    .utility-head { align-items: start; display: flex; gap: 12px; justify-content: space-between; }
    .utility-head p { margin: 0; }
    .utility-state { border-radius: 999px; font-size: 11px; font-weight: 650; padding: 2px 8px; white-space: nowrap; }
    .utility-state.recommended { background: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 22%, transparent); color: var(--vscode-testing-iconPassed, #73c991); }
    .utility-state.custom { background: color-mix(in srgb, var(--vscode-textLink-foreground) 18%, transparent); color: var(--vscode-textLink-foreground); }
    .utility-state.required { background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 22%, transparent); color: var(--vscode-editorWarning-foreground, #cca700); }
    .utility-form { display: grid; gap: 10px; max-width: 620px; }
    .utility-description { margin: 0; }
    .advanced-models { display: grid; gap: 10px; }
    .advanced-models[hidden] { display: none; }
    .utility-preview { background: var(--vscode-textCodeBlock-background); border-radius: 6px; font-family: var(--vscode-editor-font-family); font-size: 11px; margin: 0; max-width: 100%; overflow: auto; padding: 10px; white-space: pre-wrap; }
    .utility-actions { align-items: center; display: flex; flex-wrap: wrap; gap: 10px; }
    .field-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); }
    .feature-panel { display: grid; gap: 12px; padding: 14px; }
    .feature-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
    .feature-card { box-shadow: none; display: grid; gap: 8px; padding: 12px; }
    .feature-head { align-items: start; display: flex; gap: 8px; justify-content: space-between; }
    .feature-card h3 { margin: 0; }
    .feature-card p { margin: 0; }
    .feature-state { border-radius: 999px; font-size: 11px; font-weight: 650; padding: 2px 8px; white-space: nowrap; }
    .feature-enabled .feature-state { background: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 22%, transparent); color: var(--vscode-testing-iconPassed, #73c991); }
    .feature-limited .feature-state { background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 22%, transparent); color: var(--vscode-editorWarning-foreground, #cca700); }
    .feature-disabled .feature-state { background: color-mix(in srgb, var(--vscode-editorError-foreground, #f14c4c) 18%, transparent); color: var(--vscode-editorError-foreground, #f14c4c); }
    .feature-info .feature-state { background: color-mix(in srgb, var(--vscode-textLink-foreground) 18%, transparent); color: var(--vscode-textLink-foreground); }
    .setting-list { display: grid; gap: 4px; list-style: none; margin: 0; padding: 0; }
    .setting-list li { align-items: baseline; display: flex; flex-wrap: wrap; gap: 4px; }
    .setting-value, .setting-source { color: var(--vscode-descriptionForeground); font-size: 12px; }
    label { display: grid; gap: 4px; }
    .switch { align-items: center; display: flex; gap: 8px; }
    input, select { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border)); border-radius: 6px; color: var(--vscode-input-foreground); font: inherit; min-height: 28px; padding: 4px 7px; width: 100%; }
    input[type="checkbox"] { min-height: 0; width: auto; }
    button { align-self: start; background: var(--vscode-button-secondaryBackground, transparent); border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; color: var(--vscode-textLink-foreground); cursor: pointer; font: inherit; line-height: 1.2; min-height: 28px; padding: 4px 10px; width: max-content; }
    .action-chip { background: var(--vscode-button-secondaryBackground, transparent); border: 1px solid var(--vscode-editorWidget-border); border-radius: 999px; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 4px 10px; }
    button.primary { background: var(--vscode-button-background); border-color: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    button:hover, .action-chip:hover { background: var(--vscode-list-hoverBackground); text-decoration: none; }
    .usage-panel { display: grid; gap: 12px; padding: 14px; }
    .usage-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); }
    .usage-meter { background: color-mix(in srgb, var(--vscode-editor-background) 65%, transparent); border: 1px solid color-mix(in srgb, var(--vscode-editorWidget-border) 80%, transparent); border-radius: 10px; display: grid; gap: 7px; padding: 10px; }
    .meter-head { align-items: baseline; display: flex; gap: 8px; justify-content: space-between; }
    .meter-name { font-weight: 650; }
    .meter-value { color: var(--vscode-descriptionForeground); font-size: 12px; white-space: nowrap; }
    progress { appearance: none; background: var(--vscode-progressBar-background); border: 0; border-radius: 999px; height: 8px; overflow: hidden; width: 100%; }
    progress::-webkit-progress-bar { background: color-mix(in srgb, var(--vscode-descriptionForeground) 18%, transparent); border-radius: 999px; }
    progress::-webkit-progress-value { background: var(--vscode-button-background); border-radius: 999px; }
    progress::-moz-progress-bar { background: var(--vscode-button-background); border-radius: 999px; }
    a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
    a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
    .links { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; padding: 12px; }
  </style>
</head>
<body>
  <main aria-label="Cocopi status">
    <header>
      <h1>Cocopi</h1>
      <button class="primary" type="button" data-command="refresh">Refresh</button>
    </header>
    ${cocopiStatusDashboardHtml(auth, runtime)}
    ${usageMeters}
    ${features}
    ${utilityModels}
    ${conversationContext}
    ${settings}
    <nav class="links" aria-label="Cocopi actions">
      ${actions}
    </nav>
    <p class="hint">Edit common Cocopi and VS Code routing settings here; use Token Tracker and Diagnostics for detailed history.</p>
  </main>
  <script>
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', (event) => {
      const utilityApply = event.target?.closest?.('#applyUtilitySetup');
      if (utilityApply) {
        event.preventDefault();
        const setup = document.querySelector('[name="utilitySetupChoice"]');
        const utilityModel = document.querySelector('[name="utilityModel"]');
        const utilitySmallModel = document.querySelector('[name="utilitySmallModel"]');
        if (setup?.value && setup.value !== 'external') {
          vscode.postMessage({
            type: 'updateUtilityRouting',
            mode: setup.value,
            utilityModel: utilityModel?.value,
            utilitySmallModel: utilitySmallModel?.value
          });
        }
        return;
      }

      const settingLink = event.target?.closest?.('[data-setting]');
      if (settingLink) {
        event.preventDefault();
        vscode.postMessage({ type: 'openSettings', query: settingLink.dataset.setting });
        return;
      }

      const link = event.target?.closest?.('[data-command]');
      if (!link) {
        return;
      }

      event.preventDefault();
      vscode.postMessage({ command: link.dataset.command });
    });
    document.addEventListener('change', (event) => {
      const field = event.target;
      if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement) || !field.name) {
        return;
      }

      let value = field.value;
      if (field instanceof HTMLInputElement && field.type === 'number') {
        value = Number(field.value);
      }
      if (field.name === 'utilitySetupChoice' || field.name === 'utilityModel' || field.name === 'utilitySmallModel') {
        updateUtilitySetupPreview();
        return;
      }
      vscode.postMessage({ type: 'updateSettings', settings: { [field.name]: value } });
    });

    function updateUtilitySetupPreview() {
      const setup = document.querySelector('[name="utilitySetupChoice"]');
      const utilityModel = document.querySelector('[name="utilityModel"]');
      const utilitySmallModel = document.querySelector('[name="utilitySmallModel"]');
      const advanced = document.getElementById('utilityAdvancedModels');
      const description = document.getElementById('utilitySetupDescription');
      const preview = document.getElementById('utilitySettingsPreview');
      const apply = document.getElementById('applyUtilitySetup');
      if (!setup || !advanced || !description || !preview || !apply) {
        return;
      }

      const descriptions = {
        recommended: 'Terra for larger tasks. Luna for quick tasks.',
        mainAgent: 'Use your selected chat model for every background task.',
        copilot: 'Use GitHub Copilot for every background task.',
        none: 'Reserve model use for the main conversation.',
        specific: 'Choose a Cocopi model for each task type.',
        external: 'Current settings use another model provider.'
      };
      const choice = setup.value;
      advanced.hidden = choice !== 'specific';
      description.textContent = descriptions[choice] ?? '';
      apply.disabled = choice === 'external';

      if (choice === 'external') {
        return;
      }

      const settings = {
        'chat.utilityModel': choice === 'recommended' ? 'cocopi/gpt-5.6-terra' : (choice === 'specific' ? utilityModel?.value ?? '' : ''),
        'chat.utilitySmallModel': choice === 'recommended' ? 'cocopi/gpt-5.6-luna' : (choice === 'specific' ? utilitySmallModel?.value ?? '' : ''),
        'chat.byokUtilityModelDefault': choice === 'mainAgent' || choice === 'copilot' ? choice : 'none'
      };
      preview.textContent = JSON.stringify(settings, undefined, 2);
    }
  </script>
</body>
</html>`;
}

/** @param {import("./runtime.js").CocopiRuntime["auth"]} auth */
function cocopiStatusDashboardActionsHtml(auth) {
  const authAction = auth
    ? `<a class="action-chip" href="#" data-command="${COCOPI_COMMANDS.signOut}">Sign Out</a>`
    : `<a class="action-chip" href="#" data-command="${COCOPI_COMMANDS.signIn}">Sign In</a>`;
  return [
    `<a class="action-chip" href="#" data-command="${COCOPI_COMMANDS.showTokenTracker}">Token Tracker</a>`,
    `<a class="action-chip" href="#" data-command="${COCOPI_COMMANDS.showDiagnostics}">Diagnostics</a>`,
    authAction
  ].join("\n");
}

/** @param {StatusPanelFeatureAuditItem[]} items */
function cocopiStatusFeatureAuditHtml(items) {
  if (items.length === 0) {
    return "";
  }

  return `
    <section class="feature-panel" aria-label="Feature gate audit">
      <div>
        <h2>Feature gates</h2>
        <p class="field-hint">Only settings that change Cocopi behavior or host-provided model input are listed; display-only VS Code preferences are omitted. Credentials remain in VS Code SecretStorage.</p>
      </div>
      <div class="feature-grid">
        ${items.map((item) => statusFeatureAuditCardHtml(item)).join("\n")}
      </div>
    </section>`;
}

/** @param {StatusPanelFeatureAuditItem} item */
function statusFeatureAuditCardHtml(item) {
  return `
        <article class="feature-card feature-${htmlTableCell(item.state)}">
          <div class="feature-head"><h3>${htmlTableCell(item.title)}</h3><span class="feature-state">${htmlTableCell(statusFeatureStateLabel(item.state))}</span></div>
          <p>${htmlTableCell(item.summary)}</p>
          <p class="field-hint">${htmlTableCell(item.detail)}</p>
          <ul class="setting-list">
            ${item.settings.map((setting) => statusFeatureSettingHtml(setting)).join("\n")}
          </ul>
        </article>`;
}

/** @param {StatusPanelSetting} setting */
function statusFeatureSettingHtml(setting) {
  const recommended = setting.recommended === undefined || setting.recommended === setting.value
    ? ""
    : ` · recommended ${formatStatusSettingValue(setting.recommended)}`;
  return `<li><a href="#" data-setting="${htmlTableCell(setting.key)}">${htmlTableCell(setting.key)}</a><span class="setting-value">= ${htmlTableCell(formatStatusSettingValue(setting.value))}</span><span class="setting-source">(${htmlTableCell(setting.source)}${htmlTableCell(recommended)})</span></li>`;
}

/** @param {'enabled' | 'limited' | 'disabled' | 'info'} state */
function statusFeatureStateLabel(state) {
  switch (state) {
    case "enabled": {
      return "Enabled";
    }
    case "limited": {
      return "Limited";
    }
    case "disabled": {
      return "Disabled";
    }
    default: {
      return "Info";
    }
  }
}

/** @param {string | number | boolean} value */
function formatStatusSettingValue(value) {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * @param {import("./runtime.js").CocopiRuntime} runtime
 * @param {import("../../data/Codex.js").CodexModelSummary[]} models
 */
function cocopiStatusDashboardSettingsHtml(runtime, models) {
  const configuration = runtime.configuration;
  const inline = configuration.inlineCompletions;
  return `
    <section class="control-grid" aria-label="Cocopi controls">
      <article class="control-card">
        <h2>Fallback model</h2>
        <label>
          Model
          <select name="model">
            ${statusPanelModelSelectOptionsHtml(models, configuration.model)}
          </select>
        </label>
        <p class="field-hint">Changes apply immediately. Used when no selected Cocopi chat model is available.</p>
      </article>
      <article class="control-card">
        <h2>Inline autocomplete</h2>
        <label>
          Mode
          <select name="inlineCompletionChoice">
            ${statusPanelInlineCompletionOptionsHtml(models, inline.enabled, inline.model)}
          </select>
        </label>
        <div class="field-grid">
          <label>Prefix chars<input type="number" min="0" name="inlineCompletions.maxPrefixCharacters" value="${htmlTableCell(String(inline.maxPrefixCharacters))}"></label>
          <label>Suffix chars<input type="number" min="0" name="inlineCompletions.maxSuffixCharacters" value="${htmlTableCell(String(inline.maxSuffixCharacters))}"></label>
          <label>Timeout ms<input type="number" min="0" name="inlineCompletions.timeoutMs" value="${htmlTableCell(String(inline.timeoutMs ?? 0))}"></label>
        </div>
        <p class="field-hint">Use <strong>auto</strong> to prefer Spark-like low-latency models.</p>
      </article>
      <article class="control-card">
        <h2>Diagnostics</h2>
        <label>
          Debug logging
          <select name="debugLevel">
            ${statusPanelSelectOptionHtml("off", "Off", configuration.debugLevel)}
            ${statusPanelSelectOptionHtml("metadata", "Metadata", configuration.debugLevel)}
            ${statusPanelSelectOptionHtml("events", "Events", configuration.debugLevel)}
            ${statusPanelSelectOptionHtml("payloads", "Payloads", configuration.debugLevel)}
          </select>
        </label>
        <p class="field-hint">Payload logs can include prompt and editor text.</p>
      </article>
    </section>`;
}

/**
 * @param {StatusPanelUtilityRouting} routing
 * @param {import("../../data/Codex.js").CodexModelSummary[]} models
 */
function cocopiStatusUtilityRoutingHtml(routing, models) {
  if (!routing.available) {
    return "";
  }

  const recommendedActive = routing.state === "recommended";
  const setupChoice = recommendedActive ? "recommended" : routing.mode;
  const advancedHidden = setupChoice === "specific" ? "" : " hidden";
  const applyDisabled = setupChoice === "external" ? " disabled" : "";
  const stateLabel = {
    recommended: "Recommended active",
    custom: "Custom setup",
    required: "Setup required"
  }[routing.state];
  const settings = statusPanelUtilitySettingsForChoice(
    setupChoice,
    setupChoice === "specific" ? `cocopi/${routing.selectedUtilityModel}` : routing.utilityModel,
    setupChoice === "specific" ? `cocopi/${routing.selectedUtilitySmallModel}` : routing.utilitySmallModel
  );
  return `
    <section class="utility-panel control-card" aria-label="Background task models">
      <div class="utility-head">
        <div>
          <h2>Background tasks</h2>
          <p>Choose how VS Code handles chat titles, summaries, and quick helpers.</p>
          <p class="field-hint"><strong>Current setup:</strong> ${htmlTableCell(routing.summary)}</p>
        </div>
        <span class="utility-state ${routing.state}">${stateLabel}</span>
      </div>
      <div class="utility-form">
        <label>
          Setup
          <select name="utilitySetupChoice">
            ${statusPanelSelectOptionHtml("recommended", "Recommended Cocopi setup — Terra + Luna", setupChoice)}
            ${statusPanelSelectOptionHtml("mainAgent", "Use main chat model", setupChoice)}
            ${statusPanelSelectOptionHtml("copilot", "Use GitHub Copilot", setupChoice)}
            ${statusPanelSelectOptionHtml("none", "Disable background tasks", setupChoice)}
            ${statusPanelSelectOptionHtml("specific", "Advanced custom models", setupChoice)}
            ${setupChoice === "external" ? '<option value="external" selected>Existing external setup</option>' : ""}
          </select>
        </label>
        <p id="utilitySetupDescription" class="utility-description">${htmlTableCell(utilitySetupDescription(setupChoice))}</p>
        <div id="utilityAdvancedModels" class="advanced-models"${advancedHidden}>
          <label>
            Larger background tasks
            <select name="utilityModel">
              ${statusPanelUtilityModelOptionsHtml(models, routing.selectedUtilityModel)}
            </select>
          </label>
          <label>
            Quick background tasks
            <select name="utilitySmallModel">
              ${statusPanelUtilityModelOptionsHtml(models, routing.selectedUtilitySmallModel)}
            </select>
          </label>
        </div>
        <label>
          VS Code user settings to write
          <pre id="utilitySettingsPreview" class="utility-preview">${escapeHtml(JSON.stringify(settings, undefined, 2))}</pre>
        </label>
        <p class="field-hint"><code>chat.byokUtilityModelDefault</code> selects the fallback when the two model fields are empty.</p>
        <div class="utility-actions">
          <button id="applyUtilitySetup" class="primary" type="button"${applyDisabled}>Apply setup</button>
          <a href="#" data-setting="chat.byokUtilityModelDefault">Open these settings in VS Code</a>
        </div>
      </div>
    </section>`;
}

/**
 * @param {string} choice
 * @param {string} utilityModel
 * @param {string} utilitySmallModel
 */
function statusPanelUtilitySettingsForChoice(choice, utilityModel, utilitySmallModel) {
  return {
    "chat.utilityModel": choice === "recommended" ? "cocopi/gpt-5.6-terra" : (choice === "specific" || choice === "external" ? utilityModel : ""),
    "chat.utilitySmallModel": choice === "recommended" ? "cocopi/gpt-5.6-luna" : (choice === "specific" || choice === "external" ? utilitySmallModel : ""),
    "chat.byokUtilityModelDefault": choice === "mainAgent" || choice === "copilot" ? choice : "none"
  };
}

/** @param {string} choice */
function utilitySetupDescription(choice) {
  switch (choice) {
    case "recommended": {
      return "Terra for larger tasks. Luna for quick tasks.";
    }
    case "mainAgent": {
      return "Use your selected chat model for every background task.";
    }
    case "copilot": {
      return "Use GitHub Copilot for every background task.";
    }
    case "none": {
      return "Reserve model use for the main conversation.";
    }
    case "specific": {
      return "Choose a Cocopi model for each task type.";
    }
    default: {
      return "Current settings use another model provider.";
    }
  }
}

function cocopiStatusConversationContextHtml() {
  return `
    <section class="control-card" aria-label="Conversation context">
      <h2>Conversation context</h2>
      <p>Compaction follows the main model. GPT-5.6 currently allows about 320K input.</p>
    </section>`;
}

/**
 * @param {import("../../data/Codex.js").CodexModelSummary[]} models
 * @param {string} currentModel
 */
function statusPanelUtilityModelOptionsHtml(models, currentModel) {
  return statusPanelModelOptions(models, currentModel)
    .map((model) => statusPanelSelectOptionHtml(`cocopi/${model.id}`, statusPanelModelOptionLabel(model), `cocopi/${currentModel}`))
    .join("\n");
}

/**
 * @param {import("../../data/Codex.js").CodexModelSummary[]} models
 * @param {string} currentModel
 */
function statusPanelModelSelectOptionsHtml(models, currentModel) {
  return statusPanelModelOptions(models, currentModel)
    .map((model) => statusPanelSelectOptionHtml(model.id, statusPanelModelOptionLabel(model), currentModel))
    .join("\n");
}

/**
 * @param {import("../../data/Codex.js").CodexModelSummary[]} models
 * @param {boolean} enabled
 * @param {string} currentModel
 */
function statusPanelInlineCompletionOptionsHtml(models, enabled, currentModel) {
  let current = "off";
  if (enabled) {
    current = currentModel === COCOPI_INLINE_COMPLETION_MODEL_AUTO ? COCOPI_INLINE_COMPLETION_MODEL_AUTO : `model:${currentModel}`;
  }
  return [
    statusPanelSelectOptionHtml("off", "Off", current),
    statusPanelSelectOptionHtml(COCOPI_INLINE_COMPLETION_MODEL_AUTO, "Auto (prefer Spark)", current),
    ...statusPanelModelOptions(models, currentModel)
      .toSorted(compareInlineCompletionModelQuickPickItems)
      .map((model) => statusPanelSelectOptionHtml(`model:${model.id}`, statusPanelModelOptionLabel(model), current))
  ].join("\n");
}

/**
 * @param {import("../../data/Codex.js").CodexModelSummary[]} models
 * @param {string} currentModel
 */
function statusPanelModelOptions(models, currentModel) {
  const options = [];
  const seen = new Set();
  for (const model of models) {
    if (seen.has(model.id)) {
      continue;
    }
    seen.add(model.id);
    options.push(model);
  }
  if (currentModel && !seen.has(currentModel) && currentModel !== COCOPI_INLINE_COMPLETION_MODEL_AUTO) {
    options.unshift({ id: currentModel, displayName: currentModel });
  }

  return options;
}

/** @param {import("../../data/Codex.js").CodexModelSummary} model */
function statusPanelModelOptionLabel(model) {
  return model.displayName && model.displayName !== model.id ? `${model.displayName} (${model.id})` : model.id;
}

/**
 * @param {string} value
 * @param {string} label
 * @param {string} current
 */
function statusPanelSelectOptionHtml(value, label, current) {
  return `<option value="${htmlTableCell(value)}"${value === current ? " selected" : ""}>${htmlTableCell(label)}</option>`;
}

/** @param {import("./token-cache-debug.js").CocopiUsageWindowStatus} usage */
function cocopiStatusUsageMetersHtml(usage) {
  const meters = statusUsageMeterRows(usage);
  if (meters.length === 0) {
    return "";
  }

  return `
    <section class="usage-panel" aria-label="Codex usage quota windows">
      <h2>Quota windows</h2>
      <div class="usage-grid">
        ${meters.map((meter) => statusUsageMeterHtml(meter)).join("\n")}
      </div>
    </section>`;
}

/**
 * @param {import("./token-cache-debug.js").CocopiUsageWindowStatus} usage
 * @returns {Array<{ name: string, remaining: number, reset: string }>}
 */
function statusUsageMeterRows(usage) {
  return sortedStatusRateLimitSnapshots(usage).flatMap((snapshot) => {
    const bucket = statusRateLimitDisplayLabel(snapshot);
    /** @type {Array<{ name: string, remaining: number, reset: string }>} */
    const rows = [];
    if (snapshot.primary) {
      rows.push(statusUsageMeterRow(bucket, snapshot.primary, "5h"));
    }
    if (snapshot.secondary) {
      rows.push(statusUsageMeterRow(bucket, snapshot.secondary, "weekly"));
    }
    return rows;
  });
}

/**
 * @param {string} bucket
 * @param {import("./token-cache-debug.js").CocopiRateLimitWindow} window
 * @param {string} fallbackWindowLabel
 */
function statusUsageMeterRow(bucket, window, fallbackWindowLabel) {
  return {
    name: `${bucket} ${rateLimitWindowLabel(window, fallbackWindowLabel)}`,
    remaining: Math.max(0, Math.min(100, 100 - window.usedPercent)),
    reset: window.resetsAt === undefined ? "Reset not reported" : `Resets ${formatStatusResetTimestamp(window.resetsAt)}`
  };
}

/** @param {{ name: string, remaining: number, reset: string }} meter */
function statusUsageMeterHtml(meter) {
  const remaining = formatTokenCacheRounded(meter.remaining);
  return `
          <article class="usage-meter">
            <div class="meter-head"><span class="meter-name">${htmlTableCell(meter.name)}</span><span class="meter-value">${htmlTableCell(remaining)}% left</span></div>
            <progress max="100" value="${htmlTableCell(String(Math.round(meter.remaining)))}">${htmlTableCell(remaining)}%</progress>
            <p class="status-meta">${htmlTableCell(meter.reset)}</p>
          </article>`;
}

/** @param {import("./token-cache-debug.js").CocopiUsageWindowStatus} usage */
function statusUsageRateLimitSummaries(usage) {
  return sortedStatusRateLimitSnapshots(usage).flatMap((snapshot) => {
    const windows = [];
    if (snapshot.primary) {
      windows.push(statusRateLimitWindowSummary(snapshot.primary, "5h"));
    }
    if (snapshot.secondary) {
      windows.push(statusRateLimitWindowSummary(snapshot.secondary, "weekly"));
    }
    if (windows.length === 0) {
      return [];
    }

    return `${statusRateLimitDisplayLabel(snapshot)}: ${windows.join(", ")}`;
  });
}

/** @param {import("./token-cache-debug.js").CocopiUsageWindowStatus} usage */
function statusUsageRateLimitWindows(usage) {
  return sortedStatusRateLimitSnapshots(usage).flatMap((snapshot) => {
    const bucket = statusRateLimitDisplayLabel(snapshot);
    const icon = bucket === "Spark" ? "$(sparkle)" : "$(pulse)";
    const windows = [];
    if (snapshot.primary) {
      windows.push(statusRateLimitWindowHoverEntry(bucket, icon, snapshot.primary, "5h"));
    }
    if (snapshot.secondary) {
      windows.push(statusRateLimitWindowHoverEntry(bucket, icon, snapshot.secondary, "weekly"));
    }

    return windows;
  });
}

/** @param {import("./token-cache-debug.js").CocopiUsageWindowStatus} usage */
function sortedStatusRateLimitSnapshots(usage) {
  return usage.apiRateLimits.toSorted((left, right) => {
    const priority = statusRateLimitPriority(left) - statusRateLimitPriority(right);
    if (priority !== 0) {
      return priority;
    }

    return statusRateLimitDisplayLabel(left).localeCompare(statusRateLimitDisplayLabel(right));
  });
}

/** @param {import("./token-cache-debug.js").CocopiRateLimitSnapshot} snapshot */
function statusRateLimitPriority(snapshot) {
  const label = statusRateLimitDisplayLabel(snapshot);
  if (label === "Regular") {
    return 0;
  }
  if (label === "Spark") {
    return 1;
  }

  return 2;
}

/**
 * @param {import("./token-cache-debug.js").CocopiRateLimitSnapshot} snapshot
 */
function statusRateLimitDisplayLabel(snapshot) {
  const label = snapshot.limitName ?? snapshot.limitId ?? "codex";
  if (snapshot.limitId === "codex" || label === "codex") {
    return "Regular";
  }
  if (/spark|bengalfox/iu.test(label) || /spark|bengalfox/iu.test(snapshot.limitId ?? "")) {
    return "Spark";
  }

  return label;
}

/**
 * @param {import("./token-cache-debug.js").CocopiRateLimitWindow} window
 * @param {string} fallbackWindowLabel
 */
function statusRateLimitWindowSummary(window, fallbackWindowLabel) {
  const remaining = Math.max(0, 100 - clampPercentage(window.usedPercent));
  const reset = window.resetsAt === undefined ? "" : `, resets ${formatStatusResetTimestamp(window.resetsAt)}`;
  return `${formatTokenCacheRounded(remaining)}% left (${rateLimitWindowLabel(window, fallbackWindowLabel)}${reset})`;
}

/**
 * @param {string} bucket
 * @param {string} icon
 * @param {import("./token-cache-debug.js").CocopiRateLimitWindow} window
 * @param {string} fallbackWindowLabel
 */
function statusRateLimitWindowHoverEntry(bucket, icon, window, fallbackWindowLabel) {
  const remaining = Math.max(0, 100 - clampPercentage(window.usedPercent));
  return {
    bucket,
    icon,
    remaining: `${formatTokenCacheRounded(remaining)}%`,
    reset: window.resetsAt === undefined ? "" : formatStatusResetTimestamp(window.resetsAt),
    windowLabel: rateLimitWindowLabel(window, fallbackWindowLabel)
  };
}

/** @param {number} resetsAt */
function formatStatusResetTimestamp(resetsAt) {
  return new Date(resetsAt * 1000).toLocaleString(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "numeric"
  });
}

/** @param {number} value */
function clampPercentage(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, value));
}


/**
 * @param {VscodeCommandApi} vscode
 */
async function showDiagnosticsWindow(vscode) {
  await waitForCocopiIssueStorage();
  const panel = vscode.window.createWebviewPanel(
    "cocopiDiagnostics",
    "Diagnostics",
    cocopiWebviewColumn(vscode),
    {
      enableScripts: true
    }
  );

  const render = () => {
    panel.webview.html = diagnosticsHtml(readCocopiIssues(), readCocopiMemoryUsage());
  };
  render();

  const unsubscribe = onCocopiIssueChange((event) => {
    if (event.type === "delete" && typeof panel.webview.postMessage === "function") {
      void panel.webview.postMessage({ type: "cocopiDiagnosticChange", event });
      return;
    }

    render();
  });

  if (typeof panel.webview.onDidReceiveMessage === "function") {
    panel.webview.onDidReceiveMessage((message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        return;
      }

      const record = /** @type {Record<string, unknown>} */ (message);
      if (record.type === "deleteDiagnostic" && typeof record.id === "number") {
        deleteCocopiIssue(record.id);
      }
      if (record.type === "clearDiagnostics") {
        clearCocopiIssues();
      }
      if (record.type === "refreshDiagnostics") {
        render();
      }
    });
  }

  if (typeof panel.onDidDispose === "function") {
    panel.onDidDispose(unsubscribe);
  }
}

/**
 * @param {import("./issues.js").CocopiIssue[]} entries
 * @param {{ rss: number, heapTotal: number, heapUsed: number, external: number, arrayBuffers?: number } | undefined} memory
 * @returns {string}
 */
function diagnosticsHtml(entries, memory) {
  const renderedEntries = entries.length === 0
    ? `
        <tbody>
          <tr>
            <td colspan="8" class="empty">No Cocopi diagnostics recorded yet.</td>
          </tr>
        </tbody>`
    : `<tbody>${entries.map((entry) => `
          <tr data-diagnostic-row-id="${escapeHtml(String(entry.id))}">
            <td title="${escapeHtml(entry.recordedAt)}">${escapeHtml(formatTokenCacheTimestamp(entry.recordedAt))}</td>
            <td><span class="severity severity-${escapeHtml(entry.severity)}">${escapeHtml(entry.severity)}</span></td>
            <td>${escapeHtml(entry.category)}</td>
            <td>${escapeHtml(entry.title)}</td>
            <td>${escapeHtml(entry.details)}</td>
            <td>${escapeHtml(formatIssueMetadata(entry.metadata))}</td>
            <td>${escapeHtml(String(entry.id))}</td>
            <td><button type="button" data-delete-diagnostic-id="${escapeHtml(String(entry.id))}">Delete</button></td>
          </tr>`).join("")}</tbody>`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Diagnostics</title>
  <style>
    body { font-family: var(--vscode-font-family); font-size: 12px; padding: 12px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid var(--vscode-editorWidget-border); padding: 6px; text-align: left; vertical-align: top; }
    th { position: sticky; top: 0; background: var(--vscode-editor-background); z-index: 1; }
    tbody tr:nth-child(even) { background: var(--vscode-list-even-item-background); }
    .empty { color: var(--vscode-descriptionForeground); }
    .severity { border-radius: 3px; padding: 1px 5px; text-transform: uppercase; }
    .severity-info { background: var(--vscode-editorInfo-foreground); color: var(--vscode-editor-background); }
    .severity-warning { background: var(--vscode-editorWarning-foreground); color: var(--vscode-editor-background); }
    .severity-error { background: var(--vscode-editorError-foreground); color: var(--vscode-editor-background); }
    .metadata { white-space: pre-wrap; }
    .toolbar { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; }
    .memory-panel { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); border-radius: 8px; margin: 12px 0; padding: 12px; }
    .memory-grid { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
    .memory-meter { background: var(--vscode-editor-background); border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; padding: 8px; }
    .meter-head { align-items: baseline; display: flex; gap: 8px; justify-content: space-between; }
    .meter-name { font-weight: 650; }
    .meter-value, .hint { color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <h2>Diagnostics</h2>
  <p>Private local diagnostics for suspected token-cache drops, state replay repairs, and runtime anomalies. Stored in VS Code private storage. Payload text and credentials are not recorded here.</p>
  ${diagnosticsMemoryHtml(memory)}
  <p class="toolbar"><button type="button" id="refreshDiagnostics">Refresh</button><button type="button" id="clearDiagnostics">Clear all</button></p>
  <table>
    <thead>
      <tr>
        <th>Timestamp</th>
        <th>Severity</th>
        <th>Category</th>
        <th>Title</th>
        <th>Details</th>
        <th>Metadata</th>
        <th>ID</th>
        <th>Actions</th>
      </tr>
    </thead>
    ${renderedEntries}
  </table>
  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById("refreshDiagnostics")?.addEventListener("click", () => vscode.postMessage({ type: "refreshDiagnostics" }));
    document.getElementById("clearDiagnostics")?.addEventListener("click", () => vscode.postMessage({ type: "clearDiagnostics" }));
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const id = Number(target.dataset.deleteDiagnosticId);
      if (Number.isInteger(id)) {
        vscode.postMessage({ type: "deleteDiagnostic", id });
      }
    });
    window.addEventListener("message", (event) => {
      const change = event.data?.event;
      if (event.data?.type !== "cocopiDiagnosticChange" || !change) {
        return;
      }

      if (change.type === "delete" && typeof change.id === "number") {
        document.querySelector('[data-diagnostic-row-id="' + String(change.id) + '"]')?.remove();
      }
    });
  </script>
</body>
</html>`;
}

/**
 * @param {{ rss: number, heapTotal: number, heapUsed: number, external: number, arrayBuffers?: number } | undefined} memory
 */
function diagnosticsMemoryHtml(memory) {
  if (!memory) {
    return `
  <section class="memory-panel" aria-label="Extension host memory">
    <h3>Extension host memory</h3>
    <p class="hint">Memory usage is unavailable in this VS Code extension host.</p>
  </section>`;
  }

  return `
  <section class="memory-panel" aria-label="Extension host memory">
    <h3>Extension host memory</h3>
    <div class="memory-grid">
      ${diagnosticsMemoryMeterHtml("RSS", memory.rss, "Process resident set size")}
      ${diagnosticsMemoryMeterHtml("Heap used", memory.heapUsed, "Live JavaScript heap currently in use")}
      ${diagnosticsMemoryMeterHtml("Heap total", memory.heapTotal, "Committed JavaScript heap")}
      ${diagnosticsMemoryMeterHtml("External", memory.external, "Native memory attached to JavaScript objects")}
      ${memory.arrayBuffers === undefined ? "" : diagnosticsMemoryMeterHtml("Array buffers", memory.arrayBuffers, "ArrayBuffer and Buffer backing stores")}
    </div>
    <p class="hint">Captured from the VS Code extension host process. Use Refresh after a long chat turn to compare heap growth.</p>
  </section>`;
}

/**
 * @param {string} name
 * @param {number} bytes
 * @param {string} detail
 */
function diagnosticsMemoryMeterHtml(name, bytes, detail) {
  return `
      <article class="memory-meter">
        <div class="meter-head"><span class="meter-name">${htmlTableCell(name)}</span><span class="meter-value">${htmlTableCell(formatDiagnosticsMemoryMiB(bytes))}</span></div>
        <p class="hint">${htmlTableCell(detail)}</p>
      </article>`;
}

/** @param {number} bytes */
function formatDiagnosticsMemoryMiB(bytes) {
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

/** @param {Record<string, string | number | boolean | undefined>} metadata */
function formatIssueMetadata(metadata) {
  const entries = Object.entries(metadata).filter(([, value]) => value !== undefined);
  return entries.map(([key, value]) => `${key}=${String(value)}`).join("\n");
}

/**
 * @param {CocopiSecretContext} context
 * @param {VscodeCommandApi} vscode
 */
async function showTokenTrackerWindow(context, vscode) {
  await waitForCocopiTokenCacheDebugStorage();
  const panel = vscode.window.createWebviewPanel(
    "cocopiTokenTracker",
    "Token Tracker",
    cocopiWebviewColumn(vscode),
    {
      enableScripts: true
    }
  );

  const history = readCocopiTokenCacheDebugSummaries().toReversed();
  const configuration = vscode.workspace.getConfiguration(COCOPI_CONFIGURATION_SECTION);
  const timelineDays = configuration.get("tokenTrackerTimelineDays", 7);
  panel.webview.html = tokenTrackerHtml(history, {
    tokenTracking: configuration.get("tokenTracking", true),
    showTokenTrackerTimeline: configuration.get("showTokenTrackerTimeline", true),
    tokenTrackerTimelineMode: configuration.get("tokenTrackerTimelineMode", COCOPI_TOKEN_TRACKER_TIMELINE_MODES.both),
    usageStatus: readCocopiUsageWindowStatus(),
    usageAnalytics: readCocopiUsageAnalytics({ timelineDays })
  });

  /** @type {import("./token-cache-debug.js").CocopiTokenCacheDebugSummary[]} */
  let pending = [];
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let flushTimer;

  const flushPendingSummaries = () => {
    if (pending.length === 0) {
      return;
    }
    const next = [...pending];
    pending = [];
    flushTimer = undefined;

    const webview = panel.webview;
    if (typeof webview.postMessage !== "function") {
      return;
    }

    void webview.postMessage({
      type: "appendTokenCacheSummaries",
      groups: tokenCacheConversationGroups(next),
      usageHtml: usageStatusHtml(readCocopiUsageWindowStatus()),
      analyticsHtml: usageAnalyticsHtml(readCocopiUsageAnalytics({ timelineDays }), {
        timeline: configuration.get("showTokenTrackerTimeline", true),
        timelineMode: configuration.get("tokenTrackerTimelineMode", COCOPI_TOKEN_TRACKER_TIMELINE_MODES.both)
      })
    });
  };

  /** @param {import("./token-cache-debug.js").CocopiTokenCacheDebugSummary} entry */
  const queueSummary = (entry) => {
    pending = [...pending, entry];
    if (flushTimer === undefined) {
      flushTimer = setTimeout(flushPendingSummaries, 250);
      if (typeof flushTimer.unref === "function") {
        flushTimer.unref();
      }
    }
  };

  const clearPending = () => {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
  };

  const unsubscribe = onCocopiTokenCacheDebugSummary(queueSummary);

  if (typeof panel.webview.onDidReceiveMessage === "function") {
    panel.webview.onDidReceiveMessage((message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        return;
      }

      const record = /** @type {Record<string, unknown>} */ (message);
      if (record.type === "deleteTokenCacheEntry" && typeof record.id === "number") {
        deleteCocopiTokenCacheDebugSummary(record.id);
      }
      if (record.type === "deleteTokenCacheSession" && typeof record.sessionId === "string") {
        deleteCocopiTokenCacheDebugSession(record.sessionId);
      }
      if (record.type === "deleteTokenCacheSessions" && Array.isArray(record.sessionIds)) {
        deleteCocopiTokenCacheDebugSessions(record.sessionIds.filter((sessionId) => typeof sessionId === "string"));
      }
      if (record.type === "clearTokenCacheSummaries") {
        clearCocopiTokenCacheDebugSummaries();
      }
    });
  }

  if (typeof panel.onDidDispose === "function") {
    panel.onDidDispose(() => {
      clearPending();
      unsubscribe();
    });
  }

  await refreshTokenCacheUsageStatus(context, vscode, panel.webview, {
    timelineDays,
    timeline: configuration.get("showTokenTrackerTimeline", true),
    timelineMode: configuration.get("tokenTrackerTimelineMode", COCOPI_TOKEN_TRACKER_TIMELINE_MODES.both)
  });
}

/**
 * @param {CocopiSecretContext} context
 * @param {VscodeCommandApi} vscode
 * @param {{ postMessage?: (value: unknown) => Thenable<boolean> }} webview
 * @param {{ timelineDays?: number, timeline?: boolean, timelineMode?: string }} [options]
 */
async function refreshTokenCacheUsageStatus(context, vscode, webview, options = {}) {
  if (typeof webview.postMessage !== "function") {
    return;
  }

  if (!await refreshSharedCocopiUsageStatus(context, vscode)) {
    return;
  }

  await webview.postMessage({
    type: "updateTokenCacheUsageStatus",
    html: usageStatusHtml(readCocopiUsageWindowStatus()),
    analyticsHtml: usageAnalyticsHtml(readCocopiUsageAnalytics({ timelineDays: options.timelineDays }), options)
  });
}

/**
 * @param {import("./token-cache-debug.js").CocopiTokenCacheDebugSummary[]} entries
 * @param {{ tokenTracking?: boolean, showTokenTrackerTimeline?: boolean, tokenTrackerTimelineMode?: string, usageStatus?: import("./token-cache-debug.js").CocopiUsageWindowStatus, usageAnalytics?: import("./token-cache-debug.js").CocopiUsageAnalytics }} [options]
 * @returns {string}
 */
function tokenTrackerHtml(entries, options = {}) {
  const renderedEntries = entries.length === 0 ? `
    <p id="token-cache-empty-state" class="empty">No token/cache summaries yet. Make a Cocopi request with token tracking enabled.</p>` :
    tokenCacheConversationGroupsHtml(tokenCacheSummariesBySession(entries));
  const statusMessage = options.tokenTracking === false
    ? `<p class="warning">Token tracking is disabled. Enable <code>cocopi.tokenTracking</code> to record new token/cache summaries.</p>`
    : "";

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Token Tracker</title>
  <style>
    body { font-family: var(--vscode-font-family); font-size: 11px; padding: 12px; }
    .subtitle { color: var(--vscode-descriptionForeground); margin: 0 0 10px; }
    .warning { border: 1px solid var(--vscode-editorWarning-foreground); border-radius: 6px; color: var(--vscode-editorWarning-foreground); padding: 8px; }
    .list-shell { border: 1px solid var(--vscode-editorWidget-border); padding: 6px; max-height: 75vh; overflow-y: auto; }
    .conversation-group { border: 1px solid var(--vscode-editorWidget-border); margin: 0 0 10px; border-radius: 6px; }
    .conversation-summary { display: flex; justify-content: space-between; gap: 14px; cursor: pointer; padding: 8px; }
    .conversation-meta { padding: 0 10px; }
    .entry { border: 1px solid var(--vscode-editorWidget-border); margin: 0 0 8px; border-radius: 6px; }
    .conversation-group .entry { margin: 0 10px 10px; }
    .entry[open] { background: var(--vscode-list-hoverBackground); }
    .entry[open] { background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-editorSelection-background)); }
    .entry-summary { align-items: flex-start; display: flex; justify-content: space-between; gap: 14px; cursor: pointer; padding: 8px; }
    .summary-main { font-weight: 600; min-width: 0; }
    .summary-stats { color: var(--vscode-descriptionForeground); white-space: nowrap; text-align: right; }
    .summary-detail { color: var(--vscode-descriptionForeground); display: block; font-weight: 400; margin-top: 3px; }
    .tracker-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .entry-body { padding: 0 10px 10px; }
    .meta-grid { display: grid; grid-template-columns: 1fr; gap: 6px; }
    .meta-row { display: flex; justify-content: space-between; border-bottom: 1px dashed var(--vscode-editorWidget-border); padding-bottom: 5px; }
    .meta-label { color: var(--vscode-descriptionForeground); margin-right: 8px; }
    .analytics-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(min(100%, var(--analytics-panel-min-width, 96ch)), 1fr)); margin: 10px 0; }
    .analytics-panel { border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; min-width: 0; overflow-x: auto; padding: 8px; }
    .analytics-panel h3 { margin: 0 0 6px; }
    .analytics-panel h4 { margin: 10px 0 6px; }
    .analytics-note { color: var(--vscode-descriptionForeground); margin: 6px 0 0; }
    .chart-panel { grid-column: 1 / -1; }
    .chart-grid { display: grid; gap: 10px; grid-template-columns: 1fr; }
    .chart-card { border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; min-width: 0; padding: 8px; }
    .chart-card h4 { margin: 0 0 6px; }
    .timeline-chart { background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-editorWidget-border)); border: 1px solid var(--vscode-editorWidget-border); border-radius: 4px; display: block; height: auto; width: 100%; }
    .chart-axis { stroke: var(--vscode-editorWidget-border); stroke-width: 1; }
    .chart-grid-line { stroke: color-mix(in srgb, var(--vscode-editorWidget-border) 65%, transparent); stroke-dasharray: 2 4; stroke-width: 1; }
    .chart-label { fill: var(--vscode-descriptionForeground); font-size: 10px; }
    .usage-bar { fill: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 72%, transparent); }
    .uncached-bar { fill: color-mix(in srgb, var(--vscode-charts-orange, #d18616) 72%, transparent); }
    .speed-line { fill: none; stroke: var(--vscode-testing-iconPassed, #73c991); stroke-linecap: round; stroke-linejoin: round; stroke-width: 2; }
    .latency-line { fill: none; stroke: var(--vscode-charts-purple, #b180d7); stroke-linecap: round; stroke-linejoin: round; stroke-width: 2; }
    .chart-point { fill: currentColor; }
    .chart-legend { color: var(--vscode-descriptionForeground); display: flex; flex-wrap: wrap; gap: 10px; margin: 6px 0 0; }
    .legend-swatch { border-radius: 2px; display: inline-block; height: 9px; margin-right: 4px; width: 9px; }
    .analytics-table { border-collapse: collapse; table-layout: fixed; width: max(100%, var(--analytics-table-min-width, var(--analytics-panel-min-width, 96ch))); }
    .analytics-table th, .analytics-table td { border-bottom: 1px dashed var(--vscode-editorWidget-border); box-sizing: border-box; overflow: hidden; padding: 4px 6px; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
    .analytics-table th { cursor: help; }
    .analytics-table th:first-child, .analytics-table td:first-child { min-width: var(--analytics-first-column-width, 16ch); text-align: left; width: var(--analytics-first-column-width, 16ch); }
    .analytics-table th:not(:first-child), .analytics-table td:not(:first-child) { min-width: var(--analytics-column-width, 10ch); width: var(--analytics-column-width, 10ch); }
    .cache-status { border-radius: 999px; display: inline-block; font-weight: 600; min-width: 52px; padding: 1px 8px; text-align: center; }
    .cache-status-hit { background: var(--vscode-testing-iconPassed, #73c991); color: var(--vscode-editor-background, #1f1f1f); }
    .cache-status-miss { background: var(--vscode-testing-iconFailed, #f14c4c); color: var(--vscode-editor-background, #1f1f1f); }
    .cache-status-unknown { background: var(--vscode-testing-iconQueued, #cca700); color: var(--vscode-editor-background, #1f1f1f); }
    .phase-badge, .risk-badge { border: 1px solid var(--vscode-editorWidget-border); border-radius: 999px; display: inline-block; font-weight: 600; padding: 1px 8px; }
    .phase-normal-turn { background: color-mix(in srgb, var(--vscode-descriptionForeground) 18%, transparent); color: var(--vscode-foreground); }
    .phase-normal-continuation { background: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 24%, transparent); color: var(--vscode-testing-iconPassed, #73c991); }
    .phase-tool-continuation { background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 28%, transparent); color: var(--vscode-charts-blue, #3794ff); }
    .phase-summary-generation { background: color-mix(in srgb, var(--vscode-charts-purple, #b180d7) 30%, transparent); color: var(--vscode-charts-purple, #b180d7); }
    .phase-summary-replay { background: color-mix(in srgb, var(--vscode-charts-orange, #d18616) 24%, transparent); color: var(--vscode-charts-orange, #d18616); }
    .phase-summary-replay-cold-baseline, .phase-summary-replay-rebaseline { background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 30%, transparent); color: var(--vscode-editorWarning-foreground, #cca700); }
    .phase-summary-replay-continuation { background: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 24%, transparent); color: var(--vscode-testing-iconPassed, #73c991); }
    .risk-low { background: color-mix(in srgb, var(--vscode-testing-iconPassed, #73c991) 16%, transparent); color: var(--vscode-testing-iconPassed, #73c991); }
    .risk-medium { background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 16%, transparent); color: var(--vscode-editorWarning-foreground, #cca700); }
    .risk-high { background: color-mix(in srgb, var(--vscode-editorError-foreground, #f14c4c) 16%, transparent); color: var(--vscode-editorError-foreground, #f14c4c); }
    .risk-unknown { background: color-mix(in srgb, var(--vscode-descriptionForeground) 14%, transparent); color: var(--vscode-descriptionForeground); }
    .empty { color: var(--vscode-descriptionForeground); }
    details > summary::marker { color: var(--vscode-descriptionForeground); }
  </style>
</head>
<body>
  <h2>Token Tracker</h2>
  <p class="subtitle">Private local diagnostics stored in VS Code private storage. Payload text and credentials are not recorded here.</p>
  <div id="tokenCacheUsageStatus">${usageStatusHtml(options.usageStatus)}</div>
  <div id="tokenCacheUsageAnalytics">${usageAnalyticsHtml(options.usageAnalytics, { timeline: options.showTokenTrackerTimeline, timelineMode: options.tokenTrackerTimelineMode })}</div>
  <p class="tracker-actions">
    <button type="button" id="clearTokenCacheSummaries">Clear all</button>
    <button type="button" id="deleteSingleRequestTokenCacheSessions">Delete 1-request sessions</button>
    <button type="button" id="deleteAllTokenCacheSessions">Delete all sessions</button>
  </p>
  ${statusMessage}
  <div class="list-shell" id="tokenTrackerEntries">
    ${renderedEntries}
  </div>
  <script>
    const entries = document.getElementById("tokenTrackerEntries");
    const vscode = acquireVsCodeApi();
      /** @type {Map<string, { details: HTMLDetailsElement, summaryStatsEl: HTMLElement, entriesEl: HTMLElement, summaryValueEl: HTMLElement, descriptionValueEl: HTMLElement, sessionCumulativeTokens: number | undefined }>} */
      const conversationState = new Map();
    const emptyTokenCacheStateHtml = '<p id="token-cache-empty-state" class="empty">No token/cache summaries yet. Make a Cocopi request with token tracking enabled.</p>';
    const setTokenCacheEmptyState = () => {
      if (entries) {
        entries.innerHTML = emptyTokenCacheStateHtml;
      }
      conversationState.clear();
    };
    /** @param {Element[]} groups */
    const deleteTokenCacheSessionGroups = (groups) => {
      const sessionIds = [];
      for (const group of groups) {
        if (!(group instanceof HTMLElement)) {
          continue;
        }

        const sessionId = group.dataset.sessionId;
        if (!sessionId) {
          continue;
        }

        sessionIds.push(sessionId);
        conversationState.delete(sessionId);
        group.remove();
      }

      if (sessionIds.length === 0) {
        return;
      }

      vscode.postMessage({ type: "deleteTokenCacheSessions", sessionIds });
      if (!entries?.querySelector("details.conversation-group")) {
        setTokenCacheEmptyState();
      }
    };
    document.getElementById("clearTokenCacheSummaries")?.addEventListener("click", () => {
      vscode.postMessage({ type: "clearTokenCacheSummaries" });
      setTokenCacheEmptyState();
    });
    document.getElementById("deleteSingleRequestTokenCacheSessions")?.addEventListener("click", () => {
      deleteTokenCacheSessionGroups([...document.querySelectorAll("details.conversation-group")]
        .filter((group) => group.querySelectorAll("details.entry").length <= 1));
    });
    document.getElementById("deleteAllTokenCacheSessions")?.addEventListener("click", () => {
      deleteTokenCacheSessionGroups([...document.querySelectorAll("details.conversation-group")]);
    });
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const entryId = Number(target.dataset.deleteEntryId);
      if (Number.isInteger(entryId)) {
        event.preventDefault();
        event.stopPropagation();
        vscode.postMessage({ type: "deleteTokenCacheEntry", id: entryId });
        target.closest("details.entry")?.remove();
      }
      const sessionId = target.dataset.deleteSessionId;
      if (sessionId) {
        event.preventDefault();
        event.stopPropagation();
        vscode.postMessage({ type: "deleteTokenCacheSession", sessionId });
        conversationState.delete(sessionId);
        target.closest("details.conversation-group")?.remove();
        if (!entries?.querySelector("details.conversation-group")) {
          setTokenCacheEmptyState();
        }
      }
    });

        /** @param {number} count */
        const formatRequestCount = (count) => String(count.toLocaleString()) + " request" + (count === 1 ? "" : "s");

        /** @param {number | undefined} value */
        const formatTokenCacheNumber = (value) => value === undefined ? "unknown" : String(value);

      /** @param {number} requestCount
       * @param {number | undefined} sessionCumulativeTokens */
      const formatTokenCacheConversationSummaryStats = (requestCount, sessionCumulativeTokens) =>
        formatRequestCount(requestCount) + " · " + formatTokenCacheTokenCount(sessionCumulativeTokens);

        /** @param {number | undefined} value */
        const formatTokenCacheTokenCount = (value) => formatTokenCacheNumber(value) + " tokens";

        const initializeConversationState = () => {
          if (!entries) {
            return;
          }

          for (const details of entries.querySelectorAll("details.conversation-group")) {
            const sessionId = details.dataset.sessionId;
            if (!sessionId) {
              continue;
            }

            const summaryStatsEl = details.querySelector(".conversation-summary .summary-stats-value");
            const entriesEl = details.querySelector(".conversation-entries");
            const summaryValueEl = details.querySelector(".conversation-meta .meta-row:first-child span:last-child");
            const descriptionValueEl = details.querySelector(".conversation-meta .meta-row:nth-child(2) span:last-child");
            if (!(summaryStatsEl instanceof HTMLElement) || !(entriesEl instanceof HTMLElement) || !(summaryValueEl instanceof HTMLElement) || !(descriptionValueEl instanceof HTMLElement)) {
              continue;
            }

            conversationState.set(sessionId, {
              details: details,
              summaryStatsEl,
              entriesEl,
              summaryValueEl,
              descriptionValueEl,
              sessionCumulativeTokens: undefined
            });
          }
        };

        /** @param {string} sessionId
         * @param {string | undefined} conversationSummary
         * @param {string | undefined} conversationDescription
         * @param {string | undefined} sessionStats
         * @param {number | undefined} sessionCumulativeTokens */
        const createConversationDetails = (sessionId, sessionLabel, conversationSummary, conversationDescription, sessionStats, sessionCumulativeTokens) => {
          if (!entries) {
            return;
          }

          const details = document.createElement("details");
          details.className = "conversation-group";
          details.open = true;
          details.dataset.sessionId = sessionId;

          const summary = document.createElement("summary");
          summary.className = "conversation-summary";

          const summaryMain = document.createElement("span");
          summaryMain.className = "summary-main";
          summaryMain.textContent = sessionLabel ?? ("Session " + sessionId);

          const summaryStats = document.createElement("span");
          summaryStats.className = "summary-stats";
          const summaryStatsValue = document.createElement("span");
          summaryStatsValue.className = "summary-stats-value";
          summaryStatsValue.textContent = sessionStats ?? formatRequestCount(0);
          const deleteSessionButton = document.createElement("button");
          deleteSessionButton.type = "button";
          deleteSessionButton.dataset.deleteSessionId = sessionId;
          deleteSessionButton.textContent = "Delete session";
          summaryStats.append(summaryStatsValue, " ", deleteSessionButton);

          summary.append(summaryMain, summaryStats);

          const meta = document.createElement("div");
          meta.className = "conversation-meta";

          const metaSummaryRow = document.createElement("div");
          metaSummaryRow.className = "meta-row";
          const metaSummaryLabel = document.createElement("span");
          metaSummaryLabel.className = "meta-label";
          metaSummaryLabel.textContent = "Conversation summary";
          const metaSummaryValue = document.createElement("span");
          metaSummaryValue.textContent = conversationSummary ?? "-";

          const metaDescriptionRow = document.createElement("div");
          metaDescriptionRow.className = "meta-row";
          const metaDescriptionLabel = document.createElement("span");
          metaDescriptionLabel.className = "meta-label";
          metaDescriptionLabel.textContent = "Conversation description";
          const metaDescriptionValue = document.createElement("span");
          metaDescriptionValue.textContent = conversationDescription ?? "-";

          metaSummaryRow.append(metaSummaryLabel, metaSummaryValue);
          metaDescriptionRow.append(metaDescriptionLabel, metaDescriptionValue);
          meta.append(metaSummaryRow, metaDescriptionRow);

          const entriesList = document.createElement("div");
          entriesList.className = "conversation-entries";

          details.append(summary, meta, entriesList);
          entries.appendChild(details);

          const state = {
            details,
            summaryStatsEl: summaryStatsValue,
            entriesEl: entriesList,
            summaryValueEl: metaSummaryValue,
            descriptionValueEl: metaDescriptionValue,
            sessionCumulativeTokens
          };
          conversationState.set(sessionId, state);
          return state;
        };

        /** @param {string} html */
        const appendEntryHtml = (html) => {
          if (!entries) {
            return;
          }

          const fragment = document.createRange().createContextualFragment(html);
          entries.appendChild(fragment);
        };

        /** @param {Array<{ sessionId: string, conversationSummary?: string, conversationDescription?: string, entriesHtml: string, sessionStats?: string, sessionCumulativeTokens?: number }>} groups */
        const appendConversationGroups = (groups) => {
          if (!entries || !Array.isArray(groups)) {
            return;
          }

          const emptyState = document.getElementById("token-cache-empty-state");
          if (emptyState) {
            emptyState.remove();
          }

          for (const group of groups) {
            if (!group?.sessionId || !group?.entriesHtml) {
              continue;
            }

            const state = conversationState.get(group.sessionId)
              ?? createConversationDetails(
                group.sessionId,
                group.sessionLabel,
                group.conversationSummary,
                group.conversationDescription,
                group.sessionStats,
                group.sessionCumulativeTokens
              );
            if (!state) {
              continue;
            }

            if (group.conversationSummary) {
              state.summaryValueEl.textContent = group.conversationSummary;
            }
            if (group.conversationDescription) {
              state.descriptionValueEl.textContent = group.conversationDescription;
            }

            const fragment = document.createRange().createContextualFragment(group.entriesHtml);
            const entryDetails = [...fragment.querySelectorAll("details.entry")];
            if (entryDetails.length === 0) {
              state.entriesEl.appendChild(fragment);
            } else {
              for (const entry of entryDetails) {
                if (!(entry instanceof HTMLElement)) {
                  continue;
                }

                const entryId = entry.dataset.entryId;
                const existing = entryId
                  ? [...state.entriesEl.querySelectorAll("details.entry")]
                    .find((candidate) => candidate instanceof HTMLElement && candidate.dataset.entryId === entryId)
                  : undefined;
                if (existing) {
                  existing.replaceWith(entry);
                } else {
                  state.entriesEl.appendChild(entry);
                }
              }
            }
            if (group.sessionCumulativeTokens !== undefined) {
              state.sessionCumulativeTokens = group.sessionCumulativeTokens;
            }
            state.summaryStatsEl.textContent = group.sessionStats ?? formatTokenCacheConversationSummaryStats(
              state.entriesEl.childElementCount,
              state.sessionCumulativeTokens
            );
          }
        };

        initializeConversationState();

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message?.type === "updateTokenCacheUsageStatus" && typeof message.html === "string") {
        const usageStatus = document.getElementById("tokenCacheUsageStatus");
        if (usageStatus) {
          usageStatus.innerHTML = message.html;
        }
        const usageAnalytics = document.getElementById("tokenCacheUsageAnalytics");
        if (usageAnalytics && typeof message.analyticsHtml === "string") {
          usageAnalytics.innerHTML = message.analyticsHtml;
        }
        return;
      }

      if (message?.type !== "appendTokenCacheSummaries") {
        return;
      }

          if (Array.isArray(message.groups)) {
            const usageStatus = document.getElementById("tokenCacheUsageStatus");
            if (usageStatus && typeof message.usageHtml === "string") {
              usageStatus.innerHTML = message.usageHtml;
            }
            const usageAnalytics = document.getElementById("tokenCacheUsageAnalytics");
            if (usageAnalytics && typeof message.analyticsHtml === "string") {
              usageAnalytics.innerHTML = message.analyticsHtml;
            }
            appendConversationGroups(message.groups);
            return;
          }

          if (typeof message.html === "string") {
            appendEntryHtml(message.html);
      }
    });
  </script>
</body>
</html>`;
}

/** @param {import("./token-cache-debug.js").CocopiUsageWindowStatus | undefined} status */
function usageStatusHtml(status) {
  if (!status) {
    return "";
  }

  const apiRows = rateLimitStatusRowsHtml(status);
  if (apiRows) {
    return `
    <section class="usage-status">
      <h3>Codex usage limits</h3>
      <div class="meta-grid">
        ${apiRows}
        <div class="meta-row"><span class="meta-label">Updated</span><span title="${escapeHtml(status.apiCapturedAt ?? "")}">${escapeHtml(formatTokenCacheTimestamp(status.apiCapturedAt))}</span></div>
      </div>
    </section>`;
  }

  return `
    <section class="usage-status">
      <h3>Recent local token activity</h3>
      <p>Codex API usage limits are unavailable. Showing recent Token Tracker activity only.</p>
      <div class="meta-grid">
        <div class="meta-row"><span class="meta-label">Window</span><span>${escapeHtml(formatTokenCacheRounded(status.windowHours))}h</span></div>
        <div class="meta-row"><span class="meta-label">Billable tokens</span><span>${escapeHtml(formatTokenCacheTokenCount(status.billableTokens))}</span></div>
        <div class="meta-row"><span class="meta-label">Average pace</span><span>${escapeHtml(formatTokenCacheRounded(status.averageTokensPerHour))} tokens/hour</span></div>
        <div class="meta-row"><span class="meta-label">Projected local activity</span><span>${escapeHtml(formatTokenCacheTokenCount(Math.round(status.projectedWindowTokens)))}</span></div>
      </div>
    </section>`;
}

/**
 * @param {import("./token-cache-debug.js").CocopiUsageAnalytics | undefined} analytics
 * @param {{ timeline?: boolean, timelineMode?: string }} [options]
 */
function usageAnalyticsHtml(analytics, options = {}) {
  if (!analytics) {
    return "";
  }
  const timeline = options.timeline === false ? "" : usageAnalyticsTimelineHtml(analytics.timeline, options.timelineMode);

  return `
    <section class="analytics-grid">
      ${timeline}
      ${usageAnalyticsWeeklyCycleHtml(analytics.weeklyCycle)}
      <div class="analytics-panel">
        <h3>This extension local usage</h3>
        ${usageAnalyticsWindowsTableHtml(analytics.windows)}
        <p class="analytics-note">Rates use only this Cocopi extension's local private-storage rows. Billable tokens are uncached input plus output.</p>
      </div>
      <div class="analytics-panel">
        <h3>Account quota depletion</h3>
        ${usageAnalyticsQuotaTableHtml(analytics.rateLimitTrends)}
        <p class="analytics-note">Quota rates are account-wide Codex usage and may include CLI, web, other extensions, and other Cocopi installs.</p>
      </div>
      <div class="analytics-panel">
        <h3>This extension agent and session usage</h3>
        ${usageAnalyticsSessionsTableHtml(analytics.sessions)}
        <p class="analytics-note">Tracking ${escapeHtml(formatTokenCacheNumber(analytics.retainedRequestRows))} local request rows and ${escapeHtml(formatTokenCacheNumber(analytics.retainedRateLimitSnapshots))} account quota snapshots.</p>
      </div>
      <div class="analytics-panel">
        <h3>Account usage by surface</h3>
        ${usageAnalyticsRemoteSurfaceTableHtml(analytics.remoteUsageAnalytics)}
        <p class="analytics-note">Fetched from ChatGPT account analytics when available. These totals are not Cocopi-only.</p>
      </div>
      <div class="analytics-panel">
        <h3>Account usage by client</h3>
        ${usageAnalyticsRemoteClientTableHtml(analytics.remoteUsageAnalytics)}
        <p class="analytics-note">Client ids come from account analytics and may represent VS Code, CLI, web, or other Codex clients. Cocopi direct usage currently appears under the unknown/default client bucket.</p>
      </div>
    </section>`;
}

/** @param {import("./token-cache-debug.js").CocopiWeeklyCycleUsage} cycle */
function usageAnalyticsWeeklyCycleHtml(cycle) {
  return `
      <div class="analytics-panel">
        <h3>Current weekly cycle token totals</h3>
        <div class="meta-grid">
          <div class="meta-row"><span class="meta-label">Cycle source</span><span>${escapeHtml(cycle.sourceLabel)}</span></div>
          <div class="meta-row"><span class="meta-label">Window</span><span title="${escapeHtml(`${cycle.cycleStart} to ${cycle.cycleEnd}`)}">${escapeHtml(formatTokenCacheTimestamp(cycle.cycleStart))} → ${escapeHtml(formatTokenCacheTimestamp(cycle.cycleEnd))}</span></div>
          <div class="meta-row"><span class="meta-label">Elapsed</span><span>${escapeHtml(formatTokenCacheRounded(cycle.elapsedHours))}h${cycle.remainingHours === undefined ? "" : ` · ${escapeHtml(formatTokenCacheRounded(cycle.remainingHours))}h remaining`}</span></div>
          <div class="meta-row"><span class="meta-label">Requests</span><span>${escapeHtml(formatTokenCacheNumber(cycle.requestCount))}${cycle.unknownUsageRequestCount > 0 ? ` · ${escapeHtml(formatTokenCacheNumber(cycle.unknownUsageRequestCount))} missing usage counters` : ""}</span></div>
        </div>
        ${usageAnalyticsWeeklyCycleTokensTableHtml(cycle)}
        ${usageAnalyticsWeeklyCycleModelsTableHtml(cycle.models)}
        <p class="analytics-note">Raw Cocopi-local counters only. Use current official rates yourself: cost = uncached input / 1M × input rate + cached input / 1M × cached rate + output / 1M × output rate.</p>
      </div>`;
}

/** @param {import("./token-cache-debug.js").CocopiWeeklyCycleUsage} cycle */
function usageAnalyticsWeeklyCycleTokensTableHtml(cycle) {
  const rows = [
    {
      label: "Uncached input",
      value: cycle.uncachedInputTokens,
      pace: cycle.uncachedInputTokensPerDay,
      projection: cycle.projectedUncachedInputTokens,
      title: "Input tokens not reported as prompt-cache hits."
    },
    {
      label: "Cached input",
      value: cycle.cachedInputTokens,
      title: "Input tokens reported as prompt-cache hits."
    },
    {
      label: "Output / generated",
      value: cycle.outputTokens,
      pace: cycle.outputTokensPerDay,
      projection: cycle.projectedOutputTokens,
      title: "Generated output tokens reported by Codex."
    },
    {
      label: "API-metered units",
      value: cycle.apiMeteredTokens,
      pace: cycle.apiMeteredTokensPerDay,
      projection: cycle.projectedApiMeteredTokens,
      title: "Uncached input plus output tokens. Cached input is shown separately for rate-card calculations."
    },
    {
      label: "Reasoning tokens",
      value: cycle.reasoningTokens,
      title: "Reasoning tokens when reported by the backend. These are tracked separately and should not be double-counted if already included in output tokens."
    },
    {
      label: "Total reported",
      value: cycle.totalTokens,
      title: "Total tokens reported by the backend when present."
    }
  ];

  return `
        <table class="analytics-table">
          <thead>
            <tr>
              ${analyticsTableHeaderHtml("Token class", "Raw token counter for the active weekly cycle.")}
              ${analyticsTableHeaderHtml("Tokens", "Tokens logged by Cocopi in this cycle.")}
              ${analyticsTableHeaderHtml("Per day", "Current pace based on elapsed cycle time.")}
              ${analyticsTableHeaderHtml("Projected", "Projected by reset when a future backend reset timestamp is available.")}
            </tr>
          </thead>
          <tbody>
            ${rows.map((row) => `
              <tr>
                ${analyticsTableCellHtml(row.label, row.title)}
                ${analyticsTableCellHtml(formatTokenCacheNumber(row.value))}
                ${analyticsTableCellHtml(row.pace === undefined ? "-" : formatTokenCacheRounded(row.pace))}
                ${analyticsTableCellHtml(row.projection === undefined ? "-" : formatTokenCacheNumber(row.projection))}
              </tr>`).join("")}
          </tbody>
        </table>`;
}

/** @param {import("./token-cache-debug.js").CocopiWeeklyCycleModelUsage[]} models */
function usageAnalyticsWeeklyCycleModelsTableHtml(models) {
  if (models.length === 0) {
    return `<p class="empty">No local usage rows in the current weekly cycle.</p>`;
  }

  return `
        <h4>Model breakdown</h4>
        <table class="analytics-table">
          <thead>
            <tr>
              ${analyticsTableHeaderHtml("Model", "Selected model and reasoning effort for local Cocopi rows.")}
              ${analyticsTableHeaderHtml("Req", "Requests logged for this model group.")}
              ${analyticsTableHeaderHtml("Input", "Total input tokens reported for this model group.")}
              ${analyticsTableHeaderHtml("Cached", "Cached input tokens reported for this model group.")}
              ${analyticsTableHeaderHtml("Uncached", "Input tokens not reported as prompt-cache hits.")}
              ${analyticsTableHeaderHtml("Output", "Generated output tokens reported for this model group.")}
              ${analyticsTableHeaderHtml("Metered", "Uncached input plus output tokens.")}
            </tr>
          </thead>
          <tbody>
            ${models.slice(0, 8).map((model) => `
              <tr title="${escapeHtml(`${model.model} · ${model.reasoningEffort}`)}">
                ${analyticsTableCellHtml(model.label)}
                ${analyticsTableCellHtml(formatTokenCacheNumber(model.requestCount))}
                ${analyticsTableCellHtml(formatTokenCacheNumber(model.inputTokens))}
                ${analyticsTableCellHtml(formatTokenCacheNumber(model.cachedInputTokens))}
                ${analyticsTableCellHtml(formatTokenCacheNumber(model.uncachedInputTokens))}
                ${analyticsTableCellHtml(formatTokenCacheNumber(model.outputTokens))}
                ${analyticsTableCellHtml(formatTokenCacheNumber(model.apiMeteredTokens))}
              </tr>`).join("")}
          </tbody>
        </table>`;
}

/**
 * @param {import("./token-cache-debug.js").CocopiUsageTimeline} timeline
 * @param {string | undefined} mode
 */
function usageAnalyticsTimelineHtml(timeline, mode) {
  if (timeline.buckets.every((bucket) => bucket.requestCount === 0)) {
    return `<div class="analytics-panel chart-panel"><h3>Local usage and speed over time</h3><p class="empty">No local usage rows in the last ${escapeHtml(formatTokenCacheRounded(timeline.windowHours))} hours.</p></div>`;
  }

  const timelineMode = normalizeTimelineMode(mode);
  const combined = timelineMode === COCOPI_TOKEN_TRACKER_TIMELINE_MODES.combined || timelineMode === COCOPI_TOKEN_TRACKER_TIMELINE_MODES.both;
  const split = timelineMode === COCOPI_TOKEN_TRACKER_TIMELINE_MODES.split || timelineMode === COCOPI_TOKEN_TRACKER_TIMELINE_MODES.both;

  return `
    <div class="analytics-panel chart-panel">
      <h3>Local usage and speed over time</h3>
    <div class="chart-grid">
      ${combined ? `
      <div class="chart-card">
        <h4>Usage by hour</h4>
        ${usageTimelineUsageChartHtml(timeline)}
        <p class="chart-legend"><span><span class="legend-swatch" style="background: var(--vscode-charts-blue, #3794ff);"></span>Billable tokens</span><span><span class="legend-swatch" style="background: var(--vscode-charts-orange, #d18616);"></span>Uncached input tokens</span></p>
      </div>
      <div class="chart-card">
        <h4>Speed by hour</h4>
        ${usageTimelineSpeedChartHtml(timeline)}
        <p class="chart-legend"><span><span class="legend-swatch" style="background: var(--vscode-testing-iconPassed, #73c991);"></span>Output tokens/sec</span><span><span class="legend-swatch" style="background: var(--vscode-charts-purple, #b180d7);"></span>First output latency</span></p>
      </div>
      ` : ""}
      ${split ? `
      <div class="chart-card">
        <h4>Usage split by model + reasoning</h4>
        ${usageTimelineSeriesChartHtml(timeline, "billableTokens")}
        ${usageTimelineSeriesLegendHtml(timeline)}
      </div>
      <div class="chart-card">
        <h4>Speed split by model + reasoning</h4>
        ${usageTimelineSeriesChartHtml(timeline, "outputTokensPerSecond")}
        ${usageTimelineSeriesLegendHtml(timeline)}
      </div>
      ` : ""}
    </div>
    <p class="analytics-note">Hourly local rows use UTC-stored timestamps, rendered in local calendar buckets. The split view groups by selected model plus reasoning effort.</p>
    </div>`;
}

/**
 * @param {string} label
 * @param {string} title
 */
function analyticsTableHeaderHtml(label, title) {
  return `<th title="${escapeHtml(title)}"><span title="${escapeHtml(title)}">${escapeHtml(label)}</span></th>`;
}

/**
 * @param {string} value
 * @param {string} [title]
 */
function analyticsTableCellHtml(value, title = value) {
  return `<td title="${escapeHtml(title)}"><span title="${escapeHtml(title)}">${escapeHtml(value)}</span></td>`;
}

/** @param {string | undefined} mode */
function normalizeTimelineMode(mode) {
  switch (mode) {
    case COCOPI_TOKEN_TRACKER_TIMELINE_MODES.combined:
    case COCOPI_TOKEN_TRACKER_TIMELINE_MODES.split:
    case COCOPI_TOKEN_TRACKER_TIMELINE_MODES.both: {
      return mode;
    }
    default: {
      return COCOPI_TOKEN_TRACKER_TIMELINE_MODES.both;
    }
  }
}

/** @param {import("./token-cache-debug.js").CocopiUsageTimeline} timeline */
function usageTimelineUsageChartHtml(timeline) {
  const width = 720;
  const height = 220;
  const plot = chartPlotBox(width, height);
  const maxValue = Math.max(1, ...timeline.buckets.map((bucket) => Math.max(bucket.billableTokens, bucket.uncachedInputTokens)));
  const bucketWidth = plot.width / timeline.buckets.length;
  const bars = timeline.buckets.map((bucket, index) => {
    const x = plot.left + index * bucketWidth;
    const billableHeight = chartScale(bucket.billableTokens, maxValue, plot.height);
    const uncachedHeight = chartScale(bucket.uncachedInputTokens, maxValue, plot.height);
    const title = `${formatTimelineBucketLabel(bucket.bucketStart)}: ${formatTokenCacheNumber(bucket.billableTokens)} billable tokens, ${formatTokenCacheNumber(bucket.uncachedInputTokens)} uncached input tokens, ${formatTokenCacheNumber(bucket.requestCount)} requests`;
    return `
      <g>
        <title>${escapeHtml(title)}</title>
        <rect class="usage-bar" x="${formatSvgNumber(x + 1)}" y="${formatSvgNumber(plot.bottom - billableHeight)}" width="${formatSvgNumber(Math.max(1, bucketWidth - 2))}" height="${formatSvgNumber(billableHeight)}"></rect>
        <rect class="uncached-bar" x="${formatSvgNumber(x + bucketWidth * 0.35)}" y="${formatSvgNumber(plot.bottom - uncachedHeight)}" width="${formatSvgNumber(Math.max(1, bucketWidth * 0.3))}" height="${formatSvgNumber(uncachedHeight)}"></rect>
      </g>`;
  }).join("");

  return chartSvgHtml(width, height, plot, bars, `${formatTokenCacheNumber(maxValue)} tokens`, timeline);
}

/** @param {import("./token-cache-debug.js").CocopiUsageTimeline} timeline */
function usageTimelineSpeedChartHtml(timeline) {
  const width = 720;
  const height = 220;
  const plot = chartPlotBox(width, height);
  const speedValues = timeline.buckets.map((bucket) => bucket.outputTokensPerSecond).filter((value) => typeof value === "number");
  const latencyValues = timeline.buckets.map((bucket) => bucket.averageFirstOutputLatencyMs).filter((value) => typeof value === "number");
  const maxValue = Math.max(1, ...speedValues, ...latencyValues.map((value) => value / 1000));
  const speedPath = timelineLinePath(timeline.buckets.map((bucket) => bucket.outputTokensPerSecond), maxValue, plot, timeline.buckets.length);
  const latencyPath = timelineLinePath(timeline.buckets.map((bucket) => bucket.averageFirstOutputLatencyMs === undefined ? undefined : bucket.averageFirstOutputLatencyMs / 1000), maxValue, plot, timeline.buckets.length);
  const points = timeline.buckets.map((bucket, index) => {
    if (bucket.outputTokensPerSecond === undefined && bucket.averageFirstOutputLatencyMs === undefined) {
      return "";
    }
    const x = timelinePointX(index, timeline.buckets.length, plot);
    const y = bucket.outputTokensPerSecond === undefined ? plot.bottom : timelinePointY(bucket.outputTokensPerSecond, maxValue, plot);
    const title = `${formatTimelineBucketLabel(bucket.bucketStart)}: ${formatTokenCacheRounded(bucket.outputTokensPerSecond ?? Number.NaN)} output tok/s, ${formatTokenCacheDuration(bucket.averageFirstOutputLatencyMs)} first output, ${formatTokenCacheNumber(bucket.requestCount)} requests`;
    return `<circle class="chart-point" style="color: var(--vscode-testing-iconPassed, #73c991);" cx="${formatSvgNumber(x)}" cy="${formatSvgNumber(y)}" r="2"><title>${escapeHtml(title)}</title></circle>`;
  }).join("");
  const lines = `${speedPath ? `<path class="speed-line" d="${escapeHtml(speedPath)}"></path>` : ""}${latencyPath ? `<path class="latency-line" d="${escapeHtml(latencyPath)}"></path>` : ""}${points}`;

  return chartSvgHtml(width, height, plot, lines, `${formatTokenCacheRounded(maxValue)} tok/s or sec`, timeline);
}

/**
 * @param {import("./token-cache-debug.js").CocopiUsageTimeline} timeline
 * @param {"billableTokens" | "outputTokensPerSecond"} metric
 */
function usageTimelineSeriesChartHtml(timeline, metric) {
  if (timeline.series.length === 0) {
    return `<p class="empty">No model/reasoning branches in this timeline.</p>`;
  }

  const width = 720;
  const height = 220;
  const plot = chartPlotBox(width, height);
  const maxValue = Math.max(1, ...timeline.series.flatMap((series) => series.buckets.map((bucket) => metric === "billableTokens" ? bucket.billableTokens : bucket.outputTokensPerSecond ?? 0)));
  const body = timeline.series.map((series, index) => {
    const color = timelineSeriesColor(index);
    const values = series.buckets.map((bucket) => metric === "billableTokens" ? bucket.billableTokens : bucket.outputTokensPerSecond);
    const path = timelineLinePath(values, maxValue, plot, series.buckets.length);
    if (!path) {
      return "";
    }
    const title = `${series.label}: ${formatTokenCacheNumber(series.requestCount)} requests, ${formatTokenCacheNumber(series.billableTokens)} billable tokens`;
    return `<path d="${escapeHtml(path)}" fill="none" stroke="${escapeHtml(color)}" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><title>${escapeHtml(title)}</title></path>`;
  }).join("");
  const label = metric === "billableTokens" ? `${formatTokenCacheNumber(maxValue)} tokens` : `${formatTokenCacheRounded(maxValue)} tok/s`;

  return chartSvgHtml(width, height, plot, body, label, timeline);
}

/** @param {import("./token-cache-debug.js").CocopiUsageTimeline} timeline */
function usageTimelineSeriesLegendHtml(timeline) {
  return `
    <p class="chart-legend">
      ${timeline.series.map((series, index) => `<span title="${escapeHtml(series.key)}"><span class="legend-swatch" style="background: ${escapeHtml(timelineSeriesColor(index))};"></span>${escapeHtml(series.label)}</span>`).join("")}
    </p>`;
}

/** @param {number} index */
function timelineSeriesColor(index) {
  return [
    "var(--vscode-charts-blue, #3794ff)",
    "var(--vscode-charts-orange, #d18616)",
    "var(--vscode-charts-purple, #b180d7)",
    "var(--vscode-testing-iconPassed, #73c991)",
    "var(--vscode-editorWarning-foreground, #cca700)",
    "var(--vscode-editorError-foreground, #f14c4c)"
  ][index % 6] ?? "var(--vscode-foreground)";
}

/**
 * @param {number} width
 * @param {number} height
 */
function chartPlotBox(width, height) {
  const left = 42;
  const right = width - 12;
  const top = 12;
  const bottom = height - 28;
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}

/**
 * @param {number} width
 * @param {number} height
 * @param {{ left: number, right: number, top: number, bottom: number, width: number, height: number }} plot
 * @param {string} body
 * @param {string} maxLabel
 * @param {import("./token-cache-debug.js").CocopiUsageTimeline} timeline
 */
function chartSvgHtml(width, height, plot, body, maxLabel, timeline) {
  return `
    <svg class="timeline-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(timeline.label)}">
      <line class="chart-axis" x1="${plot.left}" y1="${plot.bottom}" x2="${plot.right}" y2="${plot.bottom}"></line>
      <line class="chart-axis" x1="${plot.left}" y1="${plot.top}" x2="${plot.left}" y2="${plot.bottom}"></line>
      <line class="chart-grid-line" x1="${plot.left}" y1="${plot.top}" x2="${plot.right}" y2="${plot.top}"></line>
      <line class="chart-grid-line" x1="${plot.left}" y1="${plot.top + plot.height / 2}" x2="${plot.right}" y2="${plot.top + plot.height / 2}"></line>
      <text class="chart-label" x="4" y="${plot.top + 4}">${escapeHtml(maxLabel)}</text>
      <text class="chart-label" x="4" y="${plot.bottom}">0</text>
      <text class="chart-label" x="${plot.left}" y="${height - 8}">${escapeHtml(formatTimelineBucketLabel(timeline.windowStart))}</text>
      <text class="chart-label" text-anchor="end" x="${plot.right}" y="${height - 8}">${escapeHtml(formatTimelineBucketLabel(timeline.windowEnd))}</text>
      ${body}
    </svg>`;
}

/**
 * @param {(number | undefined)[]} values
 * @param {number} maxValue
 * @param {{ left: number, right: number, top: number, bottom: number, width: number, height: number }} plot
 * @param {number} count
 */
function timelineLinePath(values, maxValue, plot, count) {
  /** @type {string[]} */
  const commands = [];
  let open = false;
  for (const [index, value] of values.entries()) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      open = false;
      continue;
    }
    const x = timelinePointX(index, count, plot);
    const y = timelinePointY(value, maxValue, plot);
    commands.push(`${open ? "L" : "M"}${formatSvgNumber(x)} ${formatSvgNumber(y)}`);
    open = true;
  }
  return commands.join(" ");
}

/**
 * @param {number} index
 * @param {number} count
 * @param {{ left: number, width: number }} plot
 */
function timelinePointX(index, count, plot) {
  return plot.left + (index + 0.5) * (plot.width / count);
}

/**
 * @param {number} value
 * @param {number} maxValue
 * @param {{ bottom: number, height: number }} plot
 */
function timelinePointY(value, maxValue, plot) {
  return plot.bottom - chartScale(value, maxValue, plot.height);
}

/**
 * @param {number} value
 * @param {number} maxValue
 * @param {number} height
 */
function chartScale(value, maxValue, height) {
  return Math.max(0, Math.min(height, value / maxValue * height));
}

/** @param {number} value */
function formatSvgNumber(value) {
  return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : "0";
}

/** @param {string} value */
function formatTimelineBucketLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** @param {import("./token-cache-debug.js").CocopiUsageAnalyticsWindow[]} windows */
function usageAnalyticsWindowsTableHtml(windows) {
  if (windows.length === 0) {
    return `<p class="empty">No local usage rows retained yet.</p>`;
  }

  return `
    <table class="analytics-table">
      <thead>
        <tr>
          ${analyticsTableHeaderHtml("Window", "Time window included in this local usage aggregate.")}
          ${analyticsTableHeaderHtml("Req", "Number of Cocopi requests recorded in the window.")}
          ${analyticsTableHeaderHtml("Billable", "Estimated billable tokens: uncached input tokens plus output tokens.")}
          ${analyticsTableHeaderHtml("Uncached", "Input tokens not reported as prompt-cache hits.")}
          ${analyticsTableHeaderHtml("Tok/min", "Estimated billable tokens per active minute in the window.")}
          ${analyticsTableHeaderHtml("Req/min", "Recorded Cocopi requests per active minute in the window.")}
          ${analyticsTableHeaderHtml("Latency", "Average request duration from start to completion.")}
          ${analyticsTableHeaderHtml("First output", "Average time until the first visible output token.")}
          ${analyticsTableHeaderHtml("Out tok/s", "Average visible output token throughput per second.")}
        </tr>
      </thead>
      <tbody>
        ${windows.map((window) => `
          <tr>
            ${analyticsTableCellHtml(window.label, `${window.windowStart} to ${window.windowEnd}`)}
            ${analyticsTableCellHtml(formatTokenCacheNumber(window.requestCount))}
            ${analyticsTableCellHtml(formatTokenCacheNumber(window.billableTokens))}
            ${analyticsTableCellHtml(formatTokenCacheNumber(window.uncachedInputTokens))}
            ${analyticsTableCellHtml(formatTokenCacheRounded(window.tokensPerMinute))}
            ${analyticsTableCellHtml(formatTokenCacheRounded(window.requestsPerMinute))}
            ${analyticsTableCellHtml(formatTokenCacheDuration(window.averageLatencyMs))}
            ${analyticsTableCellHtml(formatTokenCacheDuration(window.averageFirstOutputLatencyMs))}
            ${analyticsTableCellHtml(formatTokenCacheRounded(window.outputTokensPerSecond ?? Number.NaN))}
          </tr>`).join("")}
      </tbody>
    </table>`;
}

/** @param {import("./token-cache-debug.js").CocopiRateLimitTrend[]} trends */
function usageAnalyticsQuotaTableHtml(trends) {
  if (trends.length === 0) {
    return `<p class="empty">Need at least two persisted usage-limit snapshots to compute quota depletion.</p>`;
  }

  return `
    <table class="analytics-table">
      <thead>
        <tr>
          ${analyticsTableHeaderHtml("Limit", "Codex account usage-limit bucket.")}
          ${analyticsTableHeaderHtml("Window", "Quota window reported by the backend.")}
          ${analyticsTableHeaderHtml("Samples", "Persisted usage-limit snapshots used to compute this trend.")}
          ${analyticsTableHeaderHtml("Used delta", "Change in used quota percentage between the oldest and newest retained samples.")}
          ${analyticsTableHeaderHtml("Delta/hour", "Used quota percentage change normalized per hour.")}
          ${analyticsTableHeaderHtml("Latest used", "Latest used quota percentage in retained snapshots.")}
        </tr>
      </thead>
      <tbody>
        ${trends.slice(0, 8).map((trend) => `
          <tr title="${escapeHtml(`${trend.startCapturedAt} to ${trend.endCapturedAt}`)}">
            ${analyticsTableCellHtml(trend.label, `${trend.label} (${trend.limitId})`)}
            ${analyticsTableCellHtml(trend.windowLabel)}
            ${analyticsTableCellHtml(formatTokenCacheNumber(trend.samples))}
            ${analyticsTableCellHtml(formatSignedPercent(trend.deltaUsedPercent), `${trend.startCapturedAt} to ${trend.endCapturedAt}`)}
            ${analyticsTableCellHtml(`${formatSignedPercent(trend.deltaUsedPercentPerHour)}/h`)}
            ${analyticsTableCellHtml(formatTokenCachePercent(trend.endUsedPercent))}
          </tr>`).join("")}
      </tbody>
    </table>`;
}

/** @param {import("./token-cache-debug.js").CocopiRemoteUsageAnalyticsSnapshot | undefined} snapshot */
function usageAnalyticsRemoteSurfaceTableHtml(snapshot) {
  if (!snapshot) {
    return `<p class="empty">No account analytics snapshot retained yet.</p>`;
  }

  const totals = remoteProductSurfaceTotals(snapshot);
  if (totals.length === 0) {
    return `<p class="empty">Account analytics did not include product-surface usage.</p>`;
  }

  return `
    <table class="analytics-table">
      <thead>
        <tr>
          ${analyticsTableHeaderHtml("Surface", "Account analytics product surface reported by ChatGPT/Codex.")}
          ${analyticsTableHeaderHtml(snapshot.tokenUnits ?? "usage", "Account analytics usage total for this surface.")}
        </tr>
      </thead>
      <tbody>
        ${totals.slice(0, 12).map(([surface, value]) => `
          <tr>
            ${analyticsTableCellHtml(surface)}
            ${analyticsTableCellHtml(formatTokenCacheNumber(value))}
          </tr>`).join("")}
      </tbody>
    </table>
    <p class="analytics-note">Range ${escapeHtml(snapshot.startDate)} to ${escapeHtml(snapshot.endDate)} · updated ${escapeHtml(formatTokenCacheTimestamp(snapshot.capturedAt))}</p>`;
}

/** @param {import("./token-cache-debug.js").CocopiRemoteUsageAnalyticsSnapshot | undefined} snapshot */
function usageAnalyticsRemoteClientTableHtml(snapshot) {
  if (!snapshot) {
    return `<p class="empty">No account client analytics snapshot retained yet.</p>`;
  }

  const clients = remoteWorkspaceClientTotals(snapshot);
  if (clients.length === 0) {
    return `<p class="empty">Account analytics did not include per-client usage.</p>`;
  }

  return `
    <table class="analytics-table">
      <thead>
        <tr>
          ${analyticsTableHeaderHtml("Client", "Account analytics client bucket reported by ChatGPT/Codex.")}
          ${analyticsTableHeaderHtml("Turns", "Account analytics turn count for this client bucket.")}
          ${analyticsTableHeaderHtml("Total tokens", "Total text tokens reported for this account analytics client bucket.")}
          ${analyticsTableHeaderHtml("Uncached", "Uncached text input tokens reported for this client bucket.")}
          ${analyticsTableHeaderHtml("Cached", "Cached text input tokens reported for this client bucket.")}
          ${analyticsTableHeaderHtml("Output", "Text output tokens reported for this client bucket.")}
        </tr>
      </thead>
      <tbody>
        ${clients.slice(0, 12).map((client) => `
          <tr>
            ${analyticsTableCellHtml(formatRemoteWorkspaceClientLabel(client.clientId), remoteWorkspaceClientTitle(client.clientId))}
            ${analyticsTableCellHtml(formatTokenCacheNumber(client.turns))}
            ${analyticsTableCellHtml(formatTokenCacheNumber(client.textTotalTokens))}
            ${analyticsTableCellHtml(formatTokenCacheNumber(client.uncachedTextInputTokens))}
            ${analyticsTableCellHtml(formatTokenCacheNumber(client.cachedTextInputTokens))}
            ${analyticsTableCellHtml(formatTokenCacheNumber(client.textOutputTokens))}
          </tr>`).join("")}
      </tbody>
    </table>
    ${usageAnalyticsRemoteWorkspaceTotalsHtml(snapshot)}`;
}

/** @param {string} clientId */
function formatRemoteWorkspaceClientLabel(clientId) {
  return clientId === "CODEX_UNKNOWN_DEFAULT"
    ? "CODEX_UNKNOWN_DEFAULT (unknown/default; may include Cocopi)"
    : clientId;
}

/** @param {string} clientId */
function remoteWorkspaceClientTitle(clientId) {
  return clientId === "CODEX_UNKNOWN_DEFAULT"
    ? "Unknown/default account analytics client bucket. Cocopi direct usage currently appears here, but this bucket is not uniquely Cocopi."
    : clientId;
}

/** @param {import("./token-cache-debug.js").CocopiRemoteUsageAnalyticsSnapshot} snapshot */
function usageAnalyticsRemoteWorkspaceTotalsHtml(snapshot) {
  const totals = remoteWorkspaceTotals(snapshot);
  return `<p class="analytics-note">Account totals: ${escapeHtml(formatTokenCacheNumber(totals.turns))} turns · ${escapeHtml(formatTokenCacheNumber(totals.threads))} threads · ${escapeHtml(formatTokenCacheNumber(totals.textTotalTokens))} total tokens · ${escapeHtml(formatTokenCacheNumber(totals.credits))} credits.</p>`;
}

/** @param {import("./token-cache-debug.js").CocopiSessionUsageSummary[]} sessions */
function usageAnalyticsSessionsTableHtml(sessions) {
  if (sessions.length === 0) {
    return `<p class="empty">No agent/session rows retained yet.</p>`;
  }

  return `
    <table class="analytics-table">
      <thead>
        <tr>
          ${analyticsTableHeaderHtml("Agent/session", "Local Cocopi source and compact session identifier.")}
          ${analyticsTableHeaderHtml("Req", "Number of Cocopi requests recorded for this session.")}
          ${analyticsTableHeaderHtml("Billable", "Estimated billable tokens for this session: uncached input plus output.")}
          ${analyticsTableHeaderHtml("Uncached", "Input tokens not reported as prompt-cache hits for this session.")}
          ${analyticsTableHeaderHtml("Latency", "Average request duration for this session.")}
          ${analyticsTableHeaderHtml("Out tok/s", "Average visible output token throughput for this session.")}
        </tr>
      </thead>
      <tbody>
        ${sessions.slice(0, 8).map((session) => `
          <tr title="${escapeHtml(session.sessionId)}">
            ${analyticsTableCellHtml(`${formatTokenCacheSource(session.source)} · ${compactTokenCacheSessionId(session.sessionId)}`, session.sessionId)}
            ${analyticsTableCellHtml(formatTokenCacheNumber(session.requestCount))}
            ${analyticsTableCellHtml(formatTokenCacheNumber(session.billableTokens))}
            ${analyticsTableCellHtml(formatTokenCacheNumber(session.uncachedInputTokens))}
            ${analyticsTableCellHtml(formatTokenCacheDuration(session.averageLatencyMs))}
            ${analyticsTableCellHtml(formatTokenCacheRounded(session.outputTokensPerSecond ?? Number.NaN))}
          </tr>`).join("")}
      </tbody>
    </table>`;
}

/** @param {import("./token-cache-debug.js").CocopiRemoteUsageAnalyticsSnapshot} snapshot */
function remoteProductSurfaceTotals(snapshot) {
  /** @type {Map<string, number>} */
  const totals = new Map();
  for (const day of snapshot.dailyTokenUsage) {
    for (const [surface, value] of Object.entries(day.productSurfaceUsageValues)) {
      totals.set(surface, (totals.get(surface) ?? 0) + value);
    }
  }

  return [...totals.entries()].toSorted((left, right) => right[1] - left[1]);
}

/** @param {import("./token-cache-debug.js").CocopiRemoteUsageAnalyticsSnapshot} snapshot */
function remoteWorkspaceClientTotals(snapshot) {
  /** @type {Map<string, import("../codex-api/rate-limits.js").CodexWorkspaceClientUsage>} */
  const totals = new Map();
  for (const day of snapshot.dailyWorkspaceUsage) {
    for (const client of day.clients) {
      totals.set(client.clientId, mergeWorkspaceClientUsage(totals.get(client.clientId), client));
    }
  }

  return [...totals.values()].toSorted((left, right) => (right.textTotalTokens ?? 0) - (left.textTotalTokens ?? 0));
}

/** @param {import("./token-cache-debug.js").CocopiRemoteUsageAnalyticsSnapshot} snapshot */
function remoteWorkspaceTotals(snapshot) {
  /** @type {import("../codex-api/rate-limits.js").CodexWorkspaceUsageTotals} */
  let totals = {};
  for (const day of snapshot.dailyWorkspaceUsage) {
    totals = mergeWorkspaceUsageTotals(totals, day.totals);
  }

  return totals;
}

/**
 * @param {import("../codex-api/rate-limits.js").CodexWorkspaceClientUsage | undefined} left
 * @param {import("../codex-api/rate-limits.js").CodexWorkspaceClientUsage} right
 * @returns {import("../codex-api/rate-limits.js").CodexWorkspaceClientUsage}
 */
function mergeWorkspaceClientUsage(left, right) {
  return {
    clientId: right.clientId,
    ...mergeWorkspaceUsageTotals(left, right)
  };
}

/**
 * @param {import("../codex-api/rate-limits.js").CodexWorkspaceUsageTotals | undefined} left
 * @param {import("../codex-api/rate-limits.js").CodexWorkspaceUsageTotals | undefined} right
 * @returns {import("../codex-api/rate-limits.js").CodexWorkspaceUsageTotals}
 */
function mergeWorkspaceUsageTotals(left, right) {
  return {
    users: sumOptional(left?.users, right?.users),
    threads: sumOptional(left?.threads, right?.threads),
    turns: sumOptional(left?.turns, right?.turns),
    credits: sumOptional(left?.credits, right?.credits),
    uncachedTextInputTokens: sumOptional(left?.uncachedTextInputTokens, right?.uncachedTextInputTokens),
    cachedTextInputTokens: sumOptional(left?.cachedTextInputTokens, right?.cachedTextInputTokens),
    textOutputTokens: sumOptional(left?.textOutputTokens, right?.textOutputTokens),
    textTotalTokens: sumOptional(left?.textTotalTokens, right?.textTotalTokens)
  };
}

/**
 * @param {number | undefined} left
 * @param {number | undefined} right
 */
function sumOptional(left, right) {
  if (left === undefined && right === undefined) {
    return;
  }

  return (left ?? 0) + (right ?? 0);
}

/** @param {import("./token-cache-debug.js").CocopiUsageWindowStatus} status */
function rateLimitStatusRowsHtml(status) {
  const rows = [];
  for (const snapshot of status.apiRateLimits) {
    const labelPrefix = snapshot.limitName ?? snapshot.limitId ?? "codex";
    if (snapshot.planType) {
      rows.push(`<div class="meta-row"><span class="meta-label">Plan</span><span>${escapeHtml(snapshot.planType)}</span></div>`);
    }
    if (snapshot.primary) {
      rows.push(rateLimitWindowRowHtml(`${labelPrefix} ${rateLimitWindowLabel(snapshot.primary, "5h")}`, snapshot.primary));
    }
    if (snapshot.secondary) {
      rows.push(rateLimitWindowRowHtml(`${labelPrefix} ${rateLimitWindowLabel(snapshot.secondary, "weekly")}`, snapshot.secondary));
    }
    if (snapshot.credits?.hasCredits) {
      const credits = snapshot.credits.unlimited ? "unlimited" : snapshot.credits.balance ?? "available";
      rows.push(`<div class="meta-row"><span class="meta-label">Credits</span><span>${escapeHtml(credits)}</span></div>`);
    }
    if (snapshot.rateLimitReachedType) {
      rows.push(`<div class="meta-row"><span class="meta-label">Limit state</span><span>${escapeHtml(snapshot.rateLimitReachedType)}</span></div>`);
    }
  }

  return rows.join("");
}

/**
 * @param {string} label
 * @param {import("./token-cache-debug.js").CocopiRateLimitWindow} window
 */
function rateLimitWindowRowHtml(label, window) {
  const remaining = Math.max(0, 100 - window.usedPercent);
  const reset = window.resetsAt === undefined ? "" : ` · resets ${new Date(window.resetsAt * 1000).toLocaleString()}`;
  return `<div class="meta-row"><span class="meta-label">${escapeHtml(label)} limit</span><span>${escapeHtml(`${formatTokenCacheRounded(remaining)}% left (${formatTokenCacheRounded(window.usedPercent)}% used)${reset}`)}</span></div>`;
}

/**
 * @param {import("./token-cache-debug.js").CocopiRateLimitWindow} window
 * @param {string} fallback
 */
function rateLimitWindowLabel(window, fallback) {
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

/** @param {import("./token-cache-debug.js").CocopiTokenCacheDebugSummary} entry */
function tokenCacheSummaryDetailsHtml(entry) {
  const billedSummary = formatTokenCacheBilledSummary(entry);
  const cacheStatusClass = tokenCacheStatusClass(entry.cacheStatus);
  const recordedAt = formatTokenCacheTimestamp(entry.recordedAt);
  const conversationSummary = tokenCacheEntryConversationSummary(entry);
  const conversationDescription = tokenCacheEntryConversationDescription(entry);
  const diagnostics = deriveCocopiTokenCacheDiagnostics(entry);
  const turnKindLabel = formatTokenCacheTurnKind(diagnostics.turnKind);
  const turnKindClass = tokenCacheTurnKindClass(diagnostics.turnKind);
  const continuationSummary = formatTokenCacheContinuationSummary(entry);
  const cacheRiskLabel = formatTokenCacheCacheRisk(diagnostics.cacheRisk);
  const cacheRiskExplanation = formatTokenCacheRiskExplanation(entry, diagnostics.cacheRisk, diagnostics.uncachedInputTokens);
  return `
    <details class="entry" data-entry-id="${escapeHtml(String(entry.id))}">
      <summary class="entry-summary">
        <span class="summary-main" title="${escapeHtml(entry.recordedAt)}">${escapeHtml(recordedAt)} · ${escapeHtml(formatTokenCacheSource(entry.source))} · ${escapeHtml(formatTokenCacheHostRequestSummary(entry))} · ${escapeHtml(entry.model)}${escapeHtml(formatTokenCacheRequestOptionsSummary(entry))}
          <span class="summary-detail"><span class="phase-badge ${escapeHtml(turnKindClass)}">${escapeHtml(turnKindLabel)}</span> ${escapeHtml(formatTokenCacheWireSummary(entry))}</span>
        </span>
        <span class="summary-stats"><span class="risk-badge ${escapeHtml(tokenCacheRiskClass(diagnostics.cacheRisk))}" title="${escapeHtml(cacheRiskExplanation)}">${escapeHtml(cacheRiskLabel)}</span> <span class="cache-status ${cacheStatusClass}">${escapeHtml(entry.cacheStatus)}</span> ${escapeHtml(formatTokenCacheHitSummary(entry))} · ${escapeHtml(formatTokenCacheUncachedInputSummary(diagnostics.uncachedInputTokens))} · ${escapeHtml(billedSummary)} · ${escapeHtml(formatTokenCacheLatencySummary(entry))}</span>
      </summary>
      <div class="entry-body">
        <div class="meta-grid">
          <div class="meta-row"><span class="meta-label">Recorded</span><span title="${escapeHtml(entry.recordedAt)}">${escapeHtml(recordedAt)}</span></div>
          <div class="meta-row"><span class="meta-label">Host request</span><span>${escapeHtml(formatTokenCacheHostRequestSummary(entry))}</span></div>
          <div class="meta-row"><span class="meta-label">API calls</span><span>${escapeHtml(formatTokenCacheNumber(entry.mergedRequestCount ?? 1))}</span></div>
          <div class="meta-row"><span class="meta-label">Turn kind</span><span><span class="phase-badge ${escapeHtml(turnKindClass)}">${escapeHtml(turnKindLabel)}</span></span></div>
          <div class="meta-row"><span class="meta-label">Cache risk</span><span><span class="risk-badge ${escapeHtml(tokenCacheRiskClass(diagnostics.cacheRisk))}">${escapeHtml(cacheRiskLabel)}</span> ${escapeHtml(cacheRiskExplanation)}</span></div>
          <div class="meta-row"><span class="meta-label">Uncached input tokens</span><span>${escapeHtml(formatTokenCacheNumber(diagnostics.uncachedInputTokens))}</span></div>
          <div class="meta-row"><span class="meta-label">Continuation</span><span>${escapeHtml(continuationSummary)}</span></div>
          <div class="meta-row"><span class="meta-label">Continuation input match</span><span>${escapeHtml(formatTokenCacheContinuationInputMatch(entry))}</span></div>
          <div class="meta-row"><span class="meta-label">Continuation expected item</span><span>${escapeHtml(formatTokenCacheOptional(entry.webSocketContinuationExpected))}</span></div>
          <div class="meta-row"><span class="meta-label">Continuation actual item</span><span>${escapeHtml(formatTokenCacheOptional(entry.webSocketContinuationActual))}</span></div>
          <div class="meta-row"><span class="meta-label">Request started</span><span>${escapeHtml(formatTokenCacheTimestamp(entry.requestStartedAt))}</span></div>
          <div class="meta-row"><span class="meta-label">Request completed</span><span>${escapeHtml(formatTokenCacheTimestamp(entry.requestCompletedAt))}</span></div>
          <div class="meta-row"><span class="meta-label">Request duration</span><span>${escapeHtml(formatTokenCacheDuration(entry.requestDurationMs))}</span></div>
          <div class="meta-row"><span class="meta-label">First stream event</span><span>${escapeHtml(formatTokenCacheDuration(entry.firstEventLatencyMs))}</span></div>
          <div class="meta-row"><span class="meta-label">First output</span><span>${escapeHtml(formatTokenCacheDuration(entry.firstOutputLatencyMs))}</span></div>
          <div class="meta-row"><span class="meta-label">Output throughput</span><span>${escapeHtml(formatTokenCacheOutputRate(entry.outputTokensPerSecond))}</span></div>
          <div class="meta-row"><span class="meta-label">Conversation summary</span><span>${escapeHtml(conversationSummary)}</span></div>
          <div class="meta-row"><span class="meta-label">Conversation description</span><span>${escapeHtml(conversationDescription)}</span></div>
          <div class="meta-row"><span class="meta-label">Session label</span><span>${escapeHtml(formatTokenCacheSessionLabel({ sessionId: entry.sessionId, conversationSummary, conversationDescription, source: entry.source }))}</span></div>
          <div class="meta-row"><span class="meta-label">Session ID</span><span>${escapeHtml(entry.sessionId)}</span></div>
          <div class="meta-row"><span class="meta-label">Selected model</span><span>${escapeHtml(entry.selectedModel ?? entry.model)}</span></div>
          <div class="meta-row"><span class="meta-label">Codex model</span><span>${escapeHtml(entry.model)}</span></div>
          <div class="meta-row"><span class="meta-label">Service tier</span><span>${escapeHtml(formatTokenCacheOptional(entry.serviceTier))}</span></div>
          <div class="meta-row"><span class="meta-label">Service tier source</span><span>${escapeHtml(formatTokenCacheOptional(entry.serviceTierSource))}</span></div>
          <div class="meta-row"><span class="meta-label">Fast requested</span><span>${escapeHtml(formatTokenCacheBoolean(entry.fastRequested))}</span></div>
          <div class="meta-row"><span class="meta-label">Reasoning effort</span><span>${escapeHtml(formatTokenCacheOptional(entry.reasoningEffort))}</span></div>
          <div class="meta-row"><span class="meta-label">Reasoning summary</span><span>${escapeHtml(formatTokenCacheOptional(entry.reasoningSummary))}</span></div>
          <div class="meta-row"><span class="meta-label">Transport</span><span>${escapeHtml(entry.transport ?? "-")}</span></div>
          <div class="meta-row"><span class="meta-label">Prompt cache key</span><span>${escapeHtml(entry.promptCacheKey ?? "-")}</span></div>
          <div class="meta-row"><span class="meta-label">Response ID</span><span>${escapeHtml(entry.responseId ?? "-")}</span></div>
          <div class="meta-row"><span class="meta-label">Request kind</span><span>${escapeHtml(formatTokenCacheOptional(entry.requestKind))}</span></div>
          <div class="meta-row"><span class="meta-label">Request input digest</span><span>${escapeHtml(formatTokenCacheOptional(entry.requestInputDigest))}</span></div>
          <div class="meta-row"><span class="meta-label">Request tools digest</span><span>${escapeHtml(formatTokenCacheOptional(entry.requestToolsDigest))}</span></div>
          <div class="meta-row"><span class="meta-label">Request body digest</span><span>${escapeHtml(formatTokenCacheOptional(entry.requestBodyDigest))}</span></div>
          <div class="meta-row"><span class="meta-label">Wire mode</span><span>${escapeHtml(formatTokenCacheOptional(entry.wireMode))}</span></div>
          <div class="meta-row"><span class="meta-label">Wire input items</span><span>${escapeHtml(formatTokenCacheNumber(entry.wireInputItems))}</span></div>
          <div class="meta-row"><span class="meta-label">Wire input digest</span><span>${escapeHtml(formatTokenCacheOptional(entry.wireInputDigest))}</span></div>
          <div class="meta-row"><span class="meta-label">Wire tools digest</span><span>${escapeHtml(formatTokenCacheOptional(entry.wireToolsDigest))}</span></div>
          <div class="meta-row"><span class="meta-label">Wire body digest</span><span>${escapeHtml(formatTokenCacheOptional(entry.wireBodyDigest))}</span></div>
          <div class="meta-row"><span class="meta-label">Input items</span><span>${escapeHtml(String(entry.inputItems))}</span></div>
          <div class="meta-row"><span class="meta-label">State restored</span><span>${escapeHtml(formatTokenCacheBoolean(entry.stateRestored))}</span></div>
          <div class="meta-row"><span class="meta-label">VS Code messages</span><span>${escapeHtml(formatTokenCacheNumber(entry.requestMessages))}</span></div>
          <div class="meta-row"><span class="meta-label">VS Code parts</span><span>${escapeHtml(formatTokenCacheRequestParts(entry))}</span></div>
          <div class="meta-row"><span class="meta-label">Data MIME types</span><span>${escapeHtml(entry.requestDataMimeTypes ?? "-")}</span></div>
          <div class="meta-row"><span class="meta-label">Input tokens</span><span>${escapeHtml(formatTokenCacheNumber(entry.inputTokens))}</span></div>
          <div class="meta-row"><span class="meta-label">Output tokens</span><span>${escapeHtml(formatTokenCacheNumber(entry.outputTokens))}</span></div>
          <div class="meta-row"><span class="meta-label">Billed input tokens</span><span>${escapeHtml(formatTokenCacheNumber(entry.billedInputTokens))}</span></div>
          <div class="meta-row"><span class="meta-label">Billed output tokens</span><span>${escapeHtml(formatTokenCacheNumber(entry.billedOutputTokens))}</span></div>
          <div class="meta-row"><span class="meta-label">Billed total tokens</span><span>${escapeHtml(formatTokenCacheNumber(entry.billedTotalTokens))}</span></div>
          <div class="meta-row"><span class="meta-label">Cached tokens</span><span>${escapeHtml(formatTokenCacheNumber(entry.cachedTokens))}</span></div>
          <div class="meta-row"><span class="meta-label">Session token count</span><span>${escapeHtml(formatTokenCacheSessionTokens(entry))}</span></div>
          <div class="meta-row"><span class="meta-label">Cache status</span><span class="cache-status ${cacheStatusClass}">${escapeHtml(entry.cacheStatus)}</span></div>
          <div class="meta-row"><span class="meta-label">Actions</span><span><button type="button" data-delete-entry-id="${escapeHtml(String(entry.id))}">Delete row</button></span></div>
        </div>
      </div>
    </details>`;
}

/** @param {string} value */
function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** @param {number | undefined} value */
function formatTokenCacheNumber(value) {
  return value === undefined ? "unknown" : String(value);
}

/** @param {string | undefined} value */
function formatTokenCacheOptional(value) {
  return value && value.trim() ? value : "-";
}

/** @param {import("./token-cache-debug.js").CocopiTokenCacheDebugSummary} entry */
function formatTokenCacheRequestOptionsSummary(entry) {
  const parts = [
    entry.reasoningEffort ? `effort ${entry.reasoningEffort}` : undefined,
    entry.reasoningSummary ? `summary ${entry.reasoningSummary}` : undefined,
    entry.serviceTier ? `tier ${entry.serviceTier}` : undefined,
    entry.fastRequested === true ? "fast" : undefined
  ].filter((part) => typeof part === "string" && part.length > 0);

  return parts.length === 0 ? "" : ` · ${parts.join(" · ")}`;
}

/** @param {import("./token-cache-debug.js").CocopiTokenCacheDebugSummary} entry */
function formatTokenCacheHostRequestSummary(entry) {
  const lastHostRequestIndex = entry.lastHostRequestIndex;
  return typeof lastHostRequestIndex === "number" && lastHostRequestIndex !== entry.hostRequestIndex
    ? `host requests ${entry.hostRequestIndex}-${lastHostRequestIndex}`
    : `host request ${entry.hostRequestIndex}`;
}

/** @param {import("./token-cache-debug.js").CocopiTokenCacheTurnKind} kind */
function formatTokenCacheTurnKind(kind) {
  switch (kind) {
    case "normal-continuation": {
      return "Normal continuation";
    }
    case "tool-continuation": {
      return "Tool continuation";
    }
    case "summary-generation": {
      return "VS Code summary generation";
    }
    case "summary-replay": {
      return "VS Code summary replay";
    }
    case "summary-replay-cold-baseline": {
      return "VS Code summary replay · cold baseline";
    }
    case "summary-replay-continuation": {
      return "VS Code summary continuation";
    }
    case "summary-replay-rebaseline": {
      return "VS Code summary replay · full baseline";
    }
    default: {
      return "Normal turn";
    }
  }
}

/** @param {import("./token-cache-debug.js").CocopiTokenCacheRisk} risk */
function formatTokenCacheCacheRisk(risk) {
  switch (risk) {
    case "high": {
      return "high risk";
    }
    case "medium": {
      return "medium risk";
    }
    case "low": {
      return "low risk";
    }
    default: {
      return "unknown risk";
    }
  }
}

/**
 * @param {import("./token-cache-debug.js").CocopiTokenCacheDebugSummary} entry
 * @param {import("./token-cache-debug.js").CocopiTokenCacheRisk} risk
 * @param {number | undefined} uncachedInputTokens
 */
function formatTokenCacheRiskExplanation(entry, risk, uncachedInputTokens) {
  if (risk === "unknown") {
    return "Risk is unknown because backend usage or cache counters were unavailable.";
  }

  const uncached = typeof uncachedInputTokens === "number" ? formatTokenCacheNumber(uncachedInputTokens) : "unknown";
  const hit = formatTokenCacheHitSummary(entry);
  if (risk === "high") {
    return `High risk because ${uncached} input tokens were not cached. High risk starts at 50000 uncached input tokens. ${hit}.`;
  }
  if (risk === "medium") {
    return `Medium risk because ${uncached} input tokens were not cached, or the backend reported a miss. Medium risk starts at 10000 uncached input tokens. ${hit}.`;
  }

  return `Low risk because uncached input stayed below 10000 tokens. ${uncached} input tokens were not cached. ${hit}.`;
}

/** @param {import("./token-cache-debug.js").CocopiTokenCacheRisk} risk */
function tokenCacheRiskClass(risk) {
  return `risk-${risk}`;
}

/** @param {import("./token-cache-debug.js").CocopiTokenCacheTurnKind} kind */
function tokenCacheTurnKindClass(kind) {
  return `phase-${kind}`;
}

/** @param {number | undefined} value */
function formatTokenCacheUncachedInputSummary(value) {
  return value === undefined ? "uncached input unknown" : `${formatTokenCacheNumber(value)} uncached input`;
}

/** @param {import("./token-cache-debug.js").CocopiTokenCacheDebugSummary} entry */
function formatTokenCacheWireSummary(entry) {
  const parts = [
    entry.requestKind ? `requestKind=${entry.requestKind}` : undefined,
    entry.wireMode ? `wire=${entry.wireMode}` : undefined,
    entry.wireInputItems === undefined ? undefined : `wireInput=${entry.wireInputItems}`,
    entry.webSocketContinuationAction && entry.webSocketContinuationReason
      ? `continuation=${entry.webSocketContinuationAction}/${entry.webSocketContinuationReason}`
      : undefined
  ].filter((part) => typeof part === "string" && part.length > 0);
  return parts.length === 0 ? "request shape unknown" : parts.join(" · ");
}

/** @param {import("./token-cache-debug.js").CocopiTokenCacheDebugSummary} entry */
function formatTokenCacheContinuationSummary(entry) {
  if (entry.webSocketContinuationAction && entry.webSocketContinuationReason) {
    const stateChanges = entry.webSocketContinuationStateChanges ? ` (${entry.webSocketContinuationStateChanges})` : "";
    const mismatch = entry.webSocketContinuationMismatchIndex === undefined ? "" : ` mismatchAt=${entry.webSocketContinuationMismatchIndex}`;
    return `${entry.webSocketContinuationAction}/${entry.webSocketContinuationReason}${mismatch}${stateChanges}`;
  }
  if (entry.wireMode === "previous-response") {
    return "previous-response";
  }
  if (entry.wireMode === "full") {
    return "full request";
  }
  return "-";
}

/** @param {import("./token-cache-debug.js").CocopiTokenCacheDebugSummary} entry */
function formatTokenCacheContinuationInputMatch(entry) {
  if (entry.webSocketContinuationMatchingItems === undefined && entry.webSocketContinuationMismatchIndex === undefined) {
    return "-";
  }

  const matched = entry.webSocketContinuationMatchingItems === undefined
    ? "unknown matched"
    : `${formatTokenCacheNumber(entry.webSocketContinuationMatchingItems)} matched`;
  const mismatch = entry.webSocketContinuationMismatchIndex === undefined
    ? "mismatch unknown"
    : `mismatch at ${formatTokenCacheNumber(entry.webSocketContinuationMismatchIndex)}`;
  const expected = entry.webSocketContinuationExpectedDigest ? `expected ${entry.webSocketContinuationExpectedDigest}` : undefined;
  const actual = entry.webSocketContinuationActualDigest ? `actual ${entry.webSocketContinuationActualDigest}` : undefined;
  return [matched, mismatch, expected, actual].filter((part) => typeof part === "string" && part.length > 0).join(" · ");
}

/** @param {number} value */
function formatTokenCacheRounded(value) {
  if (!Number.isFinite(value)) {
    return "unknown";
  }

  return value >= 10 ? Math.round(value).toLocaleString() : value.toFixed(2);
}

/** @param {number | undefined} value */
function formatTokenCacheDuration(value) {
  if (value === undefined || !Number.isFinite(value)) {
    return "unknown";
  }

  return value >= 1000 ? `${formatTokenCacheRounded(value / 1000)}s` : `${Math.round(value)}ms`;
}

/** @param {number | undefined} value */
function formatTokenCacheOutputRate(value) {
  return value === undefined || !Number.isFinite(value) ? "unknown" : `${formatTokenCacheRounded(value)} output tokens/s`;
}

/** @param {import("./token-cache-debug.js").CocopiTokenCacheDebugSummary} entry */
function formatTokenCacheLatencySummary(entry) {
  const parts = [
    entry.requestDurationMs === undefined ? undefined : formatTokenCacheDuration(entry.requestDurationMs),
    entry.outputTokensPerSecond === undefined ? undefined : formatTokenCacheOutputRate(entry.outputTokensPerSecond)
  ].filter((part) => typeof part === "string" && part.length > 0);
  return parts.length === 0 ? "latency unknown" : parts.join(" · ");
}

/** @param {number} value */
function formatSignedPercent(value) {
  if (!Number.isFinite(value)) {
    return "unknown";
  }

  const sign = value > 0 ? "+" : "";
  return `${sign}${formatTokenCachePercent(value)}`;
}

/** @param {number | undefined} value */
function formatTokenCacheTokenCount(value) {
  return `${formatTokenCacheNumber(value)} tokens`;
}

/** @param {import("./token-cache-debug.js").CocopiTokenCacheDebugSummary} entry */
function formatTokenCacheBilledSummary(entry) {
  const billedTotalTokens = entry.billedTotalTokens;
  const billedInputTokens = entry.billedInputTokens;
  const billedOutputTokens = entry.billedOutputTokens;

  if (billedTotalTokens === undefined) {
    return "unknown tokens";
  }

  if (billedInputTokens === undefined && billedOutputTokens === undefined) {
    return formatTokenCacheTokenCount(billedTotalTokens);
  }

  const input = `in ${billedInputTokens === undefined ? "unknown" : formatTokenCacheNumber(billedInputTokens)}`;
  const output = `out ${billedOutputTokens === undefined ? "unknown" : formatTokenCacheNumber(billedOutputTokens)}`;
  return `${formatTokenCacheTokenCount(billedTotalTokens)} (${input} / ${output})`;
}

/** @param {import("./token-cache-debug.js").CocopiTokenCacheDebugSummary} entry */
function formatTokenCacheSessionTokens(entry) {
  if (entry.sessionInitialTokens === undefined || entry.sessionCumulativeTokens === undefined) {
    return formatTokenCacheNumber(entry.totalTokens);
  }

  const additionalTokens = entry.sessionCumulativeTokens - entry.sessionInitialTokens;
  const safeAdditional = Number.isFinite(additionalTokens) ? additionalTokens : undefined;
  if (safeAdditional === undefined || safeAdditional < 0) {
    return formatTokenCacheNumber(entry.sessionCumulativeTokens);
  }

  return `${formatTokenCacheNumber(entry.sessionInitialTokens)} + ${formatTokenCacheNumber(safeAdditional)} = ${formatTokenCacheNumber(entry.sessionCumulativeTokens)}`;
}

/** @param {boolean | undefined} value */
function formatTokenCacheBoolean(value) {
  return value === undefined ? "unknown" : String(value);
}

/** @param {string | undefined} value */
function formatTokenCacheTimestamp(value) {
  if (!value) {
    return "unknown";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

/** @param {'chat' | 'language-model'} source */
function formatTokenCacheSource(source) {
  return source === "language-model" ? "Language Model" : "Chat";
}

/** @param {import("./token-cache-debug.js").CocopiTokenCacheDebugSummary} entry */
function formatTokenCacheRequestParts(entry) {
  return [
    `text=${formatTokenCacheNumber(entry.requestTextParts)}`,
    `toolCalls=${formatTokenCacheNumber(entry.requestToolCallParts)}`,
    `toolResults=${formatTokenCacheNumber(entry.requestToolResultParts)}`,
    `data=${formatTokenCacheNumber(entry.requestDataParts)}`,
    `cocopiData=${formatTokenCacheNumber(entry.requestCocopiDataParts)}`,
    `cocopiBytes=${formatTokenCacheNumber(entry.requestCocopiDataBytes)}`
  ].join(" ");
}

/** @param {import("./token-cache-debug.js").CocopiTokenCacheDebugSummary} entry */
function tokenCacheEntryConversationSummary(entry) {
  return firstNonBlank(
    entry.conversationSummary,
    entry.conversationDescription,
    `${formatTokenCacheSource(entry.source)} host request ${entry.hostRequestIndex} · ${entry.model} · ${entry.cacheStatus} · ${formatTokenCacheBilledSummary(entry)}`
  );
}

/** @param {import("./token-cache-debug.js").CocopiTokenCacheDebugSummary} entry */
function tokenCacheEntryConversationDescription(entry) {
  return firstNonBlank(
    entry.conversationDescription,
    entry.conversationSummary,
    tokenCacheEntryRequestShape(entry)
  );
}

/** @param {import("./token-cache-debug.js").CocopiTokenCacheDebugSummary} entry */
function tokenCacheEntryRequestShape(entry) {
  return [
    `${formatTokenCacheSource(entry.source)} ${formatTokenCacheHostRequestSummary(entry)}`,
    entry.model,
    entry.transport,
    `${entry.inputItems} input ${entry.inputItems === 1 ? "item" : "items"}`,
    entry.requestMessages === undefined ? undefined : `${entry.requestMessages} VS Code ${entry.requestMessages === 1 ? "message" : "messages"}`,
    `parts: ${formatTokenCacheRequestParts(entry)}`
  ].filter((part) => typeof part === "string" && part.length > 0).join(" · ");
}

/** @param {number | undefined} value */
function formatTokenCachePercent(value) {
  return value === undefined || !Number.isFinite(value) ? "unknown" : `${value.toFixed(1)}%`;
}

/** @param {import("./token-cache-debug.js").CocopiTokenCacheDebugSummary} entry */
function formatTokenCacheHitSummary(entry) {
  if (entry.cacheStatus === "unknown" || entry.cacheHitRatio === undefined || !Number.isFinite(entry.cacheHitRatio)) {
    return "cache unknown";
  }

  return `${formatTokenCachePercent(entry.cacheHitRatio)} hit`;
}

/**
 * @param {'hit' | 'miss' | 'unknown'} status
 * @returns {string}
 */
function tokenCacheStatusClass(status) {
  return `cache-status-${status}`;
}

/**
 * @param {import("./token-cache-debug.js").CocopiTokenCacheDebugSummary[]} entries
 * @returns {Record<string, import("./token-cache-debug.js").CocopiTokenCacheDebugSummary[]>}
 */
function tokenCacheSummariesBySession(entries) {
  /** @type {Record<string, import("./token-cache-debug.js").CocopiTokenCacheDebugSummary[]>} */
  const grouped = {};
  for (const entry of entries) {
    grouped[entry.sessionId] = grouped[entry.sessionId] ?? [];
    grouped[entry.sessionId].push(entry);
  }

  return grouped;
}

/**
 * @param {Record<string, import("./token-cache-debug.js").CocopiTokenCacheDebugSummary[]>} grouped
 * @returns {string}
 */
function tokenCacheConversationGroupsHtml(grouped) {
  return Object.entries(grouped)
    .map(([sessionId, sessionEntries]) => tokenCacheConversationGroupHtml({
      sessionId,
      conversationSummary: firstDefined(sessionEntries, (entry) => entry.conversationSummary) ?? firstDefined(sessionEntries, tokenCacheEntryConversationSummary),
      conversationDescription: firstDefined(sessionEntries, (entry) => entry.conversationDescription) ?? firstDefined(sessionEntries, tokenCacheEntryConversationDescription),
      entries: sessionEntries
    }))
    .join("");
}

/**
 * @param {{
 *   sessionId: string,
 *   conversationSummary: string | undefined,
 *   conversationDescription: string | undefined,
 *   entries: import("./token-cache-debug.js").CocopiTokenCacheDebugSummary[]
 * }} options
 * @returns {string}
 */
function tokenCacheConversationGroupHtml(options) {
  const entriesHtml = options.entries.map((entry) => tokenCacheSummaryDetailsHtml(entry)).join("");
  const sessionLabel = formatTokenCacheSessionLabel({
    sessionId: options.sessionId,
    conversationSummary: options.conversationSummary,
    conversationDescription: options.conversationDescription,
    source: options.entries[0]?.source
  });
  return `
    <details class="conversation-group" data-session-id="${escapeHtml(options.sessionId)}">
      <summary class="conversation-summary">
        <span class="summary-main" title="${escapeHtml(options.sessionId)}">${escapeHtml(sessionLabel)}</span>
        <span class="summary-stats"><span class="summary-stats-value">${escapeHtml(formatTokenCacheConversationUsageStats(options.entries))}</span> <button type="button" data-delete-session-id="${escapeHtml(options.sessionId)}">Delete session</button></span>
      </summary>
      <div class="conversation-meta">
        <div class="meta-row"><span class="meta-label">Conversation summary</span><span>${escapeHtml(options.conversationSummary ?? "No summary available")}</span></div>
        <div class="meta-row"><span class="meta-label">Conversation description</span><span>${escapeHtml(options.conversationDescription ?? "No description available")}</span></div>
        <div class="meta-row"><span class="meta-label">Session ID</span><span>${escapeHtml(options.sessionId)}</span></div>
      </div>
      <div class="conversation-entries">${entriesHtml}</div>
    </details>`;
}

/**
 * @param {{ sessionId: string, conversationSummary?: string, conversationDescription?: string, source?: 'chat' | 'language-model' }} options
 * @returns {string}
 */
function formatTokenCacheSessionLabel(options) {
  const title = options.conversationSummary?.trim() || options.conversationDescription?.trim();
  const source = options.source ? formatTokenCacheSource(options.source) : "Session";
  const suffix = compactTokenCacheSessionId(options.sessionId);
  return title ? `${source} · ${title} · ${suffix}` : `${source} · ${suffix}`;
}

/** @param {string} sessionId */
function compactTokenCacheSessionId(sessionId) {
  const match = /cocopi-(chat|language-model)-(.+)$/u.exec(sessionId);
  const rawTail = match?.[2] ?? sessionId;
  const tail = rawTail.length > 8 ? rawTail.slice(-8) : rawTail;
  return `…${tail}`;
}

/**
 * @param {number} count
 * @returns {string}
 */
function formatTokenCacheConversationCount(count) {
  return `${count.toLocaleString()} request${count === 1 ? "" : "s"}`;
}

/** @param {import("./token-cache-debug.js").CocopiTokenCacheDebugSummary[]} entries */
function formatTokenCacheConversationUsageStats(entries) {
  let billableTokens = 0;
  let uncachedInputTokens = 0;
  let durationMs = 0;
  let timedRequests = 0;
  let outputTokens = 0;
  let throughputDurationMs = 0;
  for (const entry of entries) {
    billableTokens += entry.billedTotalTokens ?? 0;
    uncachedInputTokens += deriveCocopiTokenCacheDiagnostics(entry).uncachedInputTokens ?? 0;
    if (typeof entry.requestDurationMs === "number") {
      durationMs += entry.requestDurationMs;
      timedRequests += 1;
      if (typeof entry.outputTokens === "number") {
        outputTokens += entry.outputTokens;
        throughputDurationMs += entry.requestDurationMs;
      }
    }
  }

  const averageDurationMs = timedRequests > 0 ? durationMs / timedRequests : undefined;
  const outputTokensPerSecond = throughputDurationMs > 0 ? outputTokens / (throughputDurationMs / 1000) : undefined;
  return [
    formatTokenCacheConversationCount(entries.length),
    formatTokenCacheTokenCount(billableTokens),
    `${formatTokenCacheNumber(uncachedInputTokens)} uncached`,
    `avg ${formatTokenCacheDuration(averageDurationMs)}`,
    formatTokenCacheOutputRate(outputTokensPerSecond)
  ].join(" · ");
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
 * @param  {...(string | undefined)} values
 * @returns {string}
 */
function firstNonBlank(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return "No metadata available";
}

/**
 * @param {import("./token-cache-debug.js").CocopiTokenCacheDebugSummary[]} entries
 * @returns {{ sessionId: string, conversationSummary: string | undefined, conversationDescription: string | undefined, entriesHtml: string }[]}
 */
function tokenCacheConversationGroups(entries) {
  const bySession = tokenCacheSummariesBySession(entries);
  return Object.entries(bySession).map(([sessionId, sessionEntries]) => ({
    sessionId,
    sessionLabel: formatTokenCacheSessionLabel({
      sessionId,
      conversationSummary:
        firstDefined(sessionEntries, (entry) => entry.conversationSummary)
        ?? latestConversationMetadataFromSession(sessionId, (entry) => entry.conversationSummary)
        ?? firstDefined(sessionEntries, tokenCacheEntryConversationSummary),
      conversationDescription:
        firstDefined(sessionEntries, (entry) => entry.conversationDescription)
        ?? latestConversationMetadataFromSession(sessionId, (entry) => entry.conversationDescription)
        ?? firstDefined(sessionEntries, tokenCacheEntryConversationDescription),
      source: sessionEntries[0]?.source
    }),
    sessionCumulativeTokens: sessionEntries.at(-1)?.sessionCumulativeTokens,
    sessionStats: formatTokenCacheConversationUsageStats(readCocopiTokenCacheDebugSummaries()
      .filter((entry) => entry.sessionId === sessionId)
      .toReversed()),
    conversationSummary:
      firstDefined(sessionEntries, (entry) => entry.conversationSummary)
      ?? latestConversationMetadataFromSession(sessionId, (entry) => entry.conversationSummary)
      ?? firstDefined(sessionEntries, tokenCacheEntryConversationSummary),
    conversationDescription:
      firstDefined(sessionEntries, (entry) => entry.conversationDescription)
      ?? latestConversationMetadataFromSession(sessionId, (entry) => entry.conversationDescription)
      ?? firstDefined(sessionEntries, tokenCacheEntryConversationDescription),
    entriesHtml: sessionEntries.map((entry) => tokenCacheSummaryDetailsHtml(entry)).join("")
  }));
}

/**
 * @param {string} sessionId
 * @param {(entry: import("./token-cache-debug.js").CocopiTokenCacheDebugSummary) => string | undefined} selector
 * @returns {string | undefined}
 */
function latestConversationMetadataFromSession(sessionId, selector) {
  for (const entry of readCocopiTokenCacheDebugSummaries()) {
    if (entry.sessionId !== sessionId) {
      continue;
    }

    const value = selector(entry);
    if (value) {
      return value;
    }
  }

  return;
}

/**
 * @param {CocopiSecretContext} context
 * @param {VscodeCommandApi} vscode
 */
async function showManageMenu(context, vscode) {
  const auth = await readCodexAuth(context.secrets);
  const selection = await vscode.window.showQuickPick(auth ? ["Show Status", "Set Fallback Model", "Set Inline Completion Model", "Toggle Inline Completions", "Sign Out"] : ["Sign In", "Show Status", "Toggle Inline Completions"], {
    placeHolder: "Manage Cocopi"
  });

  switch (selection) {
    case "Sign In": {
      await signIn(context, vscode);
      break;
    }

    case "Show Status": {
      await showAuthStatus(context, vscode);
      break;
    }

    case "Set Fallback Model": {
      await selectModel(context, vscode);
      break;
    }

    case "Set Inline Completion Model": {
      await selectInlineCompletionModel(context, vscode);
      break;
    }

    case "Toggle Inline Completions": {
      await toggleInlineCompletions(context, vscode);
      break;
    }

    case "Sign Out": {
      await signOut(context, vscode);
      break;
    }

    default:
  }
}

/**
 * @param {CocopiSecretContext} context
 * @param {VscodeCommandApi} vscode
 * @param {{ runLogin?: typeof runBrowserCodexLogin }} [options]
 */
export async function signIn(context, vscode, options = {}) {
  vscode.window.setStatusBarMessage("Opening ChatGPT sign-in for Cocopi.", 5000);
  const tokens = await (options.runLogin ?? runBrowserCodexLogin)({
    openExternal: async (url) => {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  });
  const metadata = codexTokenMetadata({
    idToken: tokens.idToken,
    accessToken: tokens.accessToken
  });

  await storeCodexAuth(context.secrets, {
    ...tokens,
    chatgptAccountId: metadata.chatgptAccountId,
    chatgptPlanType: metadata.chatgptPlanType
  });
  closeCodexResponseWebSocketSessions();
  vscode.window.setStatusBarMessage("Cocopi sign-in complete.", 5000);
}

/**
 * @param {CocopiSecretContext} context
 * @param {VscodeCommandApi} vscode
 */
export async function showAuthStatus(context, vscode) {
  const auth = await readCodexAuth(context.secrets);
  const runtime = await readCocopiRuntime(context, vscode);
  await waitForCocopiTokenCacheDebugStorage();
  await refreshSharedCocopiUsageStatus(context, vscode, { runtime });
  const usage = readCocopiUsageWindowStatus();
  const selection = await vscode.window.showQuickPick(cocopiStatusQuickPickItems(auth, runtime, usage), {
    placeHolder: "Cocopi"
  });
  await handleStatusAction(selection, vscode);
}

/**
 * @param {string | { action?: string } | undefined | void} selection
 * @param {VscodeCommandApi} vscode
 */
async function handleStatusAction(selection, vscode) {
  const action = typeof selection === "object" && selection ? selection.action : selection;
  if (action === "sign-in") {
    await vscode.commands.executeCommand?.(COCOPI_COMMANDS.signIn);
    return;
  }

  if (action === "sign-out") {
    await vscode.commands.executeCommand?.(COCOPI_COMMANDS.signOut);
    return;
  }

  if (action === "select-model") {
    await vscode.commands.executeCommand?.(COCOPI_COMMANDS.selectModel);
    return;
  }

  if (action === "inline-options") {
    await vscode.commands.executeCommand?.(COCOPI_COMMANDS.showInlineCompletionOptions);
    return;
  }

  if (action === "toggle-inline") {
    await vscode.commands.executeCommand?.(COCOPI_COMMANDS.toggleInlineCompletions);
    return;
  }

  if (action === "select-inline-model") {
    await vscode.commands.executeCommand?.(COCOPI_COMMANDS.selectInlineCompletionModel);
    return;
  }

  if (action === "token-tracker" || action === COCOPI_STATUS_TOKEN_TRACKER_ACTION) {
    await vscode.commands.executeCommand?.(COCOPI_COMMANDS.showTokenTracker);
    return;
  }

  if (action === "diagnostics" || action === COCOPI_STATUS_DIAGNOSTICS_ACTION) {
    await vscode.commands.executeCommand?.(COCOPI_COMMANDS.showDiagnostics);
  }
}

/**
 * @param {CocopiSecretContext} context
 * @param {VscodeCommandApi} vscode
 */
export async function showInlineCompletionOptions(context, vscode) {
  const runtime = await readCocopiRuntime(context, vscode, { refreshAuth: false });
  const selection = await vscode.window.showQuickPick(cocopiInlineCompletionOptionsQuickPickItems(runtime), {
    placeHolder: "Cocopi inline completions"
  });
  await handleInlineCompletionOptionAction(selection, vscode);
}

/**
 * @param {string | { action?: string } | undefined | void} selection
 * @param {VscodeCommandApi} vscode
 */
async function handleInlineCompletionOptionAction(selection, vscode) {
  const action = typeof selection === "object" && selection ? selection.action : selection;
  if (action === "toggle-inline") {
    await vscode.commands.executeCommand?.(COCOPI_COMMANDS.toggleInlineCompletions);
    return;
  }

  if (action === "select-inline-model") {
    await vscode.commands.executeCommand?.(COCOPI_COMMANDS.selectInlineCompletionModel);
    return;
  }

  if (action === "open-cocopi-inline-settings") {
    await vscode.commands.executeCommand?.("workbench.action.openSettings", "cocopi.inlineCompletions");
    return;
  }

  if (action === "open-vscode-inline-settings") {
    await vscode.commands.executeCommand?.("workbench.action.openSettings", "editor.inlineSuggest.enabled");
    return;
  }

  if (action === "inline-debug-events" || action === "inline-debug-off") {
    const configuration = /** @type {ModelConfigurationUpdate} */ (vscode.workspace.getConfiguration(COCOPI_CONFIGURATION_SECTION));
    const debugLevel = action === "inline-debug-events" ? "events" : "off";
    await configuration.update?.("debugLevel", debugLevel, true);
    await vscode.window.showInformationMessage(debugLevel === "events"
      ? "Cocopi event debug logs enabled. Open the Cocopi output channel while testing inline completions."
      : "Cocopi debug logs disabled.");
  }
}

/**
 * @param {import("./runtime.js").CocopiRuntime} runtime
 * @returns {CocopiStatusQuickPickItem[]}
 */
function cocopiInlineCompletionOptionsQuickPickItems(runtime) {
  const inline = runtime.configuration.inlineCompletions;
  const enabled = inline.enabled;
  return [
    {
      label: enabled ? "$(check) Cocopi Inline Completions" : "$(circle-slash) Cocopi Inline Completions",
      description: enabled ? "Enabled" : "Disabled",
      detail: "Toggle Cocopi AI ghost-text autocomplete. VS Code's editor.inlineSuggest.enabled must also be enabled.",
      action: "toggle-inline"
    },
    {
      label: "$(settings-gear) Inline Completion Model",
      description: inline.model,
      detail: "Choose the model used for Cocopi AI autocomplete. Auto prefers a Spark-like low-latency model when available.",
      action: "select-inline-model"
    },
    {
      label: "$(list-selection) Cocopi Inline Settings",
      description: `${formatTokenCacheNumber(inline.maxPrefixCharacters)} prefix · ${formatTokenCacheNumber(inline.maxSuffixCharacters)} suffix`,
      detail: `Open settings for context budgets and timeout. Current timeout: ${inline.timeoutMs ?? "disabled"} ms.`,
      action: "open-cocopi-inline-settings"
    },
    {
      label: "$(symbol-event) VS Code Inline Suggest Settings",
      description: "Required host setting",
      detail: "Open VS Code's native inline suggestion settings, including editor.inlineSuggest.enabled.",
      action: "open-vscode-inline-settings"
    },
    {
      label: "$(output) Enable Event Debug Logs",
      description: runtime.configuration.debugLevel === "events" ? "Enabled" : undefined,
      detail: "Log inline completion request metadata and stream event types to the Cocopi output channel for testing.",
      action: "inline-debug-events"
    },
    {
      label: "$(circle-slash) Disable Debug Logs",
      description: runtime.configuration.debugLevel === "off" ? "Enabled" : undefined,
      detail: "Turn Cocopi debug output off.",
      action: "inline-debug-off"
    }
  ];
}

/**
 * @param {Awaited<ReturnType<typeof readCodexAuth>>} auth
 * @param {import("./runtime.js").CocopiRuntime} runtime
 * @param {import("./token-cache-debug.js").CocopiUsageWindowStatus} usage
 * @returns {CocopiStatusQuickPickItem[]}
 */
function cocopiStatusQuickPickItems(auth, runtime, usage) {
  const inlineState = runtime.configuration.inlineCompletions.enabled ? "Enabled" : "Disabled";
  return [
    {
      label: auth ? "$(check) Signed in" : "$(warning) Not signed in",
      description: auth?.chatgptPlanType ? `Plan: ${auth.chatgptPlanType}` : undefined,
      detail: auth ? "Cocopi can use ChatGPT Codex from this account." : "Sign in to use ChatGPT Codex-backed chat and inline completions.",
      action: auth ? undefined : "sign-in"
    },
    ...usageStatusQuickPickItems(usage),
    {
      label: "$(sparkle) Inline Completions",
      description: inlineState,
      detail: `Open inline autocomplete controls. Current model: ${runtime.configuration.inlineCompletions.model}.`,
      action: "inline-options"
    },
    {
      label: "$(server) Set Fallback Model",
      description: runtime.configuration.model,
      detail: "Set the fallback Codex model used when VS Code has not selected a specific Cocopi chat model.",
      action: "select-model"
    },
    {
      label: `$(graph) ${COCOPI_STATUS_TOKEN_TRACKER_ACTION}`,
      description: "Usage and cache history",
      detail: "View token, cache-hit, model, reasoning, transport, and service-tier summaries.",
      action: "token-tracker"
    },
    {
      label: `$(bug) ${COCOPI_STATUS_DIAGNOSTICS_ACTION}`,
      description: "Runtime diagnostics",
      detail: "View private local runtime and token-cache diagnostics with credential redaction.",
      action: "diagnostics"
    },
    auth ? {
      label: "$(sign-out) Sign Out",
      description: auth.chatgptPlanType ? `Plan: ${auth.chatgptPlanType}` : undefined,
      detail: "Remove Cocopi's locally stored ChatGPT Codex credentials from VS Code SecretStorage.",
      action: "sign-out"
    } : {
      label: "$(sign-in) Sign In",
      detail: "Open the Cocopi browser sign-in flow for ChatGPT Codex.",
      action: "sign-in"
    }
  ];
}

/**
 * @param {import("./token-cache-debug.js").CocopiUsageWindowStatus} status
 * @returns {CocopiStatusQuickPickItem[]}
 */
function usageStatusQuickPickItems(status) {
  const apiItems = apiUsageStatusQuickPickItems(status);
  if (apiItems.length > 0) {
    return apiItems;
  }

  const window = `${formatTokenCacheRounded(status.windowHours)}h`;
  const used = formatTokenCacheTokenCount(status.billableTokens);
  const pace = `${formatTokenCacheRounded(status.averageTokensPerHour)} tokens/hour`;
  const projected = formatTokenCacheTokenCount(Math.round(status.projectedWindowTokens));
  return [{
    label: "$(pulse) Recent local token activity",
    description: `${used} billable tokens`,
    detail: `Codex API usage limits unavailable. Window: ${window}. Requests: ${formatTokenCacheNumber(status.requestCount)}. Pace: ${pace}. Projected: ${projected}.`
  }];
}

/**
 * @param {import("./token-cache-debug.js").CocopiUsageWindowStatus} status
 * @returns {CocopiStatusQuickPickItem[]}
 */
function apiUsageStatusQuickPickItems(status) {
  const planTypes = [...new Set(status.apiRateLimits.map((snapshot) => snapshot.planType).filter((planType) => typeof planType === "string" && planType.length > 0))];
  const usageRows = status.apiRateLimits.flatMap((snapshot) => {
    const label = snapshot.limitName ?? snapshot.limitId ?? "codex";
    const detailParts = [
      snapshot.primary ? formatRateLimitQuickPickDetail(snapshot.primary, "5h") : undefined,
      snapshot.secondary ? formatRateLimitQuickPickDetail(snapshot.secondary, "weekly") : undefined,
      snapshot.credits?.hasCredits ? `credits: ${snapshot.credits.unlimited ? "unlimited" : snapshot.credits.balance ?? "available"}` : undefined,
      snapshot.rateLimitReachedType ? `limit state: ${snapshot.rateLimitReachedType}` : undefined
    ].filter((part) => typeof part === "string" && part.length > 0);

    return detailParts.length === 0
      ? []
      : [{
        label: `$(dashboard) ${label}`,
        description: snapshot.planType ? `Plan: ${snapshot.planType}` : undefined,
        detail: detailParts.join(" · ")
      }];
  });

  if (usageRows.length === 0) {
    return [];
  }

  return [{
    label: "$(pulse) Codex usage limits",
    description: planTypes.length > 0 ? `Plan: ${planTypes.join(", ")}` : "From Codex API",
    detail: status.apiCapturedAt ? `Updated ${formatTokenCacheTimestamp(status.apiCapturedAt)}` : "Updated from Codex API"
  }, ...usageRows];
}

/**
 * @param {import("./token-cache-debug.js").CocopiRateLimitWindow} window
 * @param {string} fallback
 */
function formatRateLimitQuickPickDetail(window, fallback) {
  const remaining = formatTokenCacheRounded(Math.max(0, 100 - window.usedPercent));
  const used = formatTokenCacheRounded(window.usedPercent);
  const reset = window.resetsAt === undefined ? "" : `, resets ${new Date(window.resetsAt * 1000).toLocaleString()}`;
  return `${rateLimitWindowLabel(window, fallback)}: ${remaining}% left (${used}% used${reset})`;
}

/**
 * @param {CocopiSecretContext} context
 * @param {VscodeCommandApi} vscode
 */
export async function selectModel(context, vscode) {
  const runtime = await readCocopiRuntime(context, vscode);
  if (!runtime.auth) {
    await vscode.window.showInformationMessage("Sign in to Cocopi before setting a fallback model.");
    return;
  }

  const models = await listCodexModelsWithAuthRefresh(context, runtime);
  const items = models.map((model) => ({
    label: model.id,
    description: model.id === runtime.configuration.model ? "Current" : model.displayName,
    detail: modelDetail(model),
    modelId: model.id
  }));
  const selection = await vscode.window.showQuickPick(items, {
    placeHolder: "Set fallback Cocopi model"
  });
  if (!selection || typeof selection === "string" || !selection.modelId) {
    return;
  }

  const configuration = /** @type {ModelConfigurationUpdate} */ (vscode.workspace.getConfiguration(COCOPI_CONFIGURATION_SECTION));
  await configuration.update?.("model", selection.modelId, true);
  await vscode.window.showInformationMessage(`Cocopi fallback model set to ${selection.modelId}. Use VS Code's chat model picker for active model selection.`);
}

/**
 * @param {CocopiSecretContext} context
 * @param {VscodeCommandApi} vscode
 */
export async function selectInlineCompletionModel(context, vscode) {
  const runtime = await readCocopiRuntime(context, vscode);
  if (!runtime.auth) {
    await vscode.window.showInformationMessage("Sign in to Cocopi before setting an inline completion model.");
    return;
  }

  const currentModel = runtime.configuration.inlineCompletions.model;
  const models = await listCodexModelsWithAuthRefresh(context, runtime);
  const items = [
    {
      label: "$(sparkle) Auto (prefer Spark)",
      description: currentModel === COCOPI_INLINE_COMPLETION_MODEL_AUTO ? "Current" : "Uses a low-latency Spark-like model when available",
      detail: `Falls back to ${runtime.configuration.model}.`,
      modelId: COCOPI_INLINE_COMPLETION_MODEL_AUTO
    },
    ...inlineCompletionModelQuickPickItems(models, currentModel)
  ];
  const selection = await vscode.window.showQuickPick(items, {
    placeHolder: "Set Cocopi inline completion model"
  });
  if (!selection || typeof selection === "string" || !selection.modelId) {
    return;
  }

  const configuration = /** @type {ModelConfigurationUpdate} */ (vscode.workspace.getConfiguration(COCOPI_CONFIGURATION_SECTION));
  await configuration.update?.("inlineCompletions.model", selection.modelId, true);
  if (runtime.configuration.inlineCompletions.enabled) {
    await vscode.window.showInformationMessage(`Cocopi inline completion model set to ${selection.modelId}.`);
    return;
  }

  const choice = await vscode.window.showInformationMessage(`Cocopi inline completion model set to ${selection.modelId}. Inline completions are currently disabled.`, "Enable Now");
  if (choice === "Enable Now") {
    await configuration.update?.("inlineCompletions.enabled", true, true);
    await vscode.window.showInformationMessage("Cocopi inline completions enabled. VS Code's editor.inlineSuggest.enabled must also be enabled.");
  }
}

/**
 * @param {CocopiSecretContext} context
 * @param {VscodeCommandApi} vscode
 */
export async function toggleInlineCompletions(context, vscode) {
  const runtime = await readCocopiRuntime(context, vscode, { refreshAuth: false });
  const enabled = !runtime.configuration.inlineCompletions.enabled;
  const configuration = /** @type {ModelConfigurationUpdate} */ (vscode.workspace.getConfiguration(COCOPI_CONFIGURATION_SECTION));
  await configuration.update?.("inlineCompletions.enabled", enabled, true);
  if (!enabled) {
    await vscode.window.showInformationMessage("Cocopi inline completions disabled.");
    return;
  }

  const choice = await vscode.window.showInformationMessage("Cocopi inline completions enabled. VS Code's editor.inlineSuggest.enabled must also be enabled.", "Set Model");
  if (choice === "Set Model") {
    await selectInlineCompletionModel(context, vscode);
  }
}

/**
 * @param {import("../../data/Codex.js").CodexModelSummary[]} models
 * @param {string} currentModel
 */
function inlineCompletionModelQuickPickItems(models, currentModel) {
  return models
    .toSorted(compareInlineCompletionModelQuickPickItems)
    .map((model) => ({
      label: model.id,
      description: model.id === currentModel ? "Current" : inlineCompletionModelDescription(model),
      detail: modelDetail(model),
      modelId: model.id
    }));
}

/**
 * @param {import("../../data/Codex.js").CodexModelSummary} left
 * @param {import("../../data/Codex.js").CodexModelSummary} right
 */
function compareInlineCompletionModelQuickPickItems(left, right) {
  const leftSpark = isSparkModel(left);
  const rightSpark = isSparkModel(right);
  if (leftSpark !== rightSpark) {
    return leftSpark ? -1 : 1;
  }

  return left.id.localeCompare(right.id);
}

/** @param {import("../../data/Codex.js").CodexModelSummary} model */
function inlineCompletionModelDescription(model) {
  return isSparkModel(model) ? "Spark candidate" : model.displayName;
}

/** @param {import("../../data/Codex.js").CodexModelSummary} model */
function isSparkModel(model) {
  return /spark/iu.test(`${model.id}\n${model.displayName}`);
}

/** @param {import("../../data/Codex.js").CodexModelSummary} model */
function modelDetail(model) {
  const details = [];
  if (model.contextWindow) details.push(`${model.contextWindow.toLocaleString()} tokens`);
  if (model.serviceTiers?.some((tier) => tier.id === "priority" || tier.id === "fast") || model.additionalSpeedTiers?.includes("fast")) details.push("Fast available");
  return details.join(" | ");
}

/**
 * @param {CocopiSecretContext} context
 * @param {VscodeCommandApi} vscode
 */
export async function signOut(context, vscode) {
  const choice = await vscode.window.showWarningMessage("Sign out of Cocopi and clear stored ChatGPT/Codex credentials?", "Sign Out");
  if (choice !== "Sign Out") {
    return;
  }

  await deleteCodexAuth(context.secrets);
  closeCodexResponseWebSocketSessions();
  await vscode.window.showInformationMessage("Cocopi credentials cleared.");
}
