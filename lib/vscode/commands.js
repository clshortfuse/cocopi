import { runBrowserCodexLogin } from "../auth/browser-login.js";
import { codexTokenMetadata } from "../auth/token.js";
import { closeCodexResponseWebSocketSessions, fetchCodexRateLimitsWithAuthRefresh, fetchCodexUsageAnalyticsWithAuthRefresh, listCodexModelsWithAuthRefresh } from "./codex-request.js";
import { COCOPI_CONFIGURATION_SECTION } from "./configuration.js";
import { clearCocopiIssues, deleteCocopiIssue, initializeCocopiIssueStorage, onCocopiIssueChange, readCocopiIssues, waitForCocopiIssueStorage } from "./issues.js";
import { clearCocopiTokenCacheDebugSummaries, deleteCocopiTokenCacheDebugSession, deleteCocopiTokenCacheDebugSessions, deleteCocopiTokenCacheDebugSummary, deriveCocopiTokenCacheDiagnostics, initializeCocopiTokenCacheDebugStorage, onCocopiTokenCacheDebugSummary, readCocopiTokenCacheDebugSummaries, readCocopiUsageAnalytics, readCocopiUsageWindowStatus, recordCocopiRateLimitSnapshots, recordCocopiRemoteUsageAnalytics, waitForCocopiTokenCacheDebugStorage } from "./token-cache-debug.js";
import { readCocopiRuntime } from "./runtime.js";
import { deleteCodexAuth, readCodexAuth, storeCodexAuth } from "./secret-storage.js";

/** @typedef {import("./runtime.js").CocopiSecretContext} CocopiSecretContext */

/** @typedef {{ toString(): string }} UriLike */

/**
 * @typedef {object} ModelConfigurationUpdate
 * @property {(key: string, value: string, target?: boolean) => Thenable<void>} [update]
 */

/**
 * @typedef {object} CocopiStatusQuickPickItem
 * @property {string} label
 * @property {string} [description]
 * @property {string} [detail]
 * @property {'token-tracker' | 'diagnostics'} [action]
 */

/**
 * @typedef {object} CocopiStatusBarController
 * @property {() => Promise<void>} refresh
 */

export const COCOPI_COMMANDS = Object.freeze({
  manage: "cocopi.manage",
  showDiagnostics: "cocopi.showDiagnostics",
  showTokenTracker: "cocopi.showTokenTracker",
  signIn: "cocopi.signIn",
  selectModel: "cocopi.selectModel",
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
 * @property {{ registerCommand(command: string, callback: () => void | Thenable<void>): { dispose(): void }, executeCommand?: (commandId: string, ...args: never[]) => Thenable<unknown> }} commands
 * @property {{ openExternal(target: UriLike): Thenable<boolean> }} env
 * @property {{ parse(value: string): UriLike }} Uri
 * @property {typeof import("vscode").MarkdownString} [MarkdownString]
 * @property {typeof import("vscode").StatusBarAlignment} [StatusBarAlignment]
 * @property {typeof import("vscode").ViewColumn} [ViewColumn]
 * @property {import("./configuration.js").ConfigurationApiLike["workspace"]} workspace
 * @property {{ createStatusBarItem?: typeof import("vscode").window.createStatusBarItem, createWebviewPanel(viewType: string, title: string, showOptions: number, options?: { enableScripts?: boolean }): { webview: { html: string, postMessage?: (value: unknown) => Thenable<boolean>, onDidReceiveMessage?: (listener: (message: unknown) => void | Thenable<void>) => { dispose(): void } }, onDidDispose?: (listener: () => void) => { dispose(): void } }, showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined | void>, showWarningMessage(message: string, ...items: string[]): Thenable<string | undefined>, showQuickPick(items: Array<string | { label: string, description?: string, detail?: string, modelId?: string, setting?: string, value?: string, action?: string }>, options?: { placeHolder?: string }): Thenable<string | { label: string, description?: string, detail?: string, modelId?: string, setting?: string, value?: string, action?: string } | undefined | void>, setStatusBarMessage(message: string, hideAfterTimeout: number): { dispose(): void } }} window
 */

/**
 * @param {CocopiSecretContext & { subscriptions: { dispose(): void }[] }} context
 * @param {VscodeCommandApi} vscode
 */
export function registerCocopiCommands(context, vscode) {
  void initializeCocopiIssueStorage(context.secrets);
  void initializeCocopiTokenCacheDebugStorage(context.secrets);
  const statusBar = registerCocopiStatusBar(context, vscode);
  context.subscriptions.push(
    vscode.commands.registerCommand(COCOPI_COMMANDS.manage, () => showManageMenu(context, vscode)),
    vscode.commands.registerCommand(COCOPI_COMMANDS.showDiagnostics, () => showDiagnosticsWindow(vscode)),
    vscode.commands.registerCommand(COCOPI_COMMANDS.showTokenTracker, async () => {
      await showTokenTrackerWindow(context, vscode);
      await statusBar?.refresh();
    }),
    vscode.commands.registerCommand(COCOPI_COMMANDS.signIn, async () => {
      await signIn(context, vscode);
      await statusBar?.refresh();
    }),
    vscode.commands.registerCommand(COCOPI_COMMANDS.selectModel, () => selectModel(context, vscode)),
    vscode.commands.registerCommand(COCOPI_COMMANDS.status, async () => {
      await showAuthStatus(context, vscode);
      await statusBar?.refresh();
    }),
    vscode.commands.registerCommand(COCOPI_COMMANDS.signOut, async () => {
      await signOut(context, vscode);
      await statusBar?.refresh();
    })
  );
}

/**
 * @param {CocopiSecretContext & { subscriptions: { dispose(): void }[] }} context
 * @param {VscodeCommandApi} vscode
 * @returns {CocopiStatusBarController | undefined}
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
  return { refresh };
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
  const status = statusTooltipAuthLabel(auth, runtime);
  const account = statusTooltipAccount(auth, runtime);
  const model = runtime?.configuration.model ?? "Loading";
  const usageSummary = usage ? statusTooltipUsageHtml(usage) : htmlTableCell("Click for live usage and tracker options");
  const diagnostics = typeof issueCount === "number" ? `${formatTokenCacheNumber(issueCount)} ${issueCount === 1 ? "issue" : "issues"}` : "Loading";
  const markdown = [
    "**Cocopi**",
    "",
    "<table>",
    "<tbody>",
    `<tr>${statusTooltipRowHeader(status)}<td>${htmlTableCell(account)}</td></tr>`,
    `<tr>${statusTooltipRowHeader("$(server) Default model")}<td>${htmlTableCell(model)}</td></tr>`,
    `<tr>${statusTooltipRowHeader("$(pulse) Usage")}<td>${usageSummary}</td></tr>`,
    `<tr>${statusTooltipRowHeader("$(bug) Diagnostics")}<td>${htmlTableCell(diagnostics)}</td></tr>`,
    "</tbody>",
    "</table>",
    "",
    `[Open Status](command:${COCOPI_COMMANDS.status}) · [Token Tracker](command:${COCOPI_COMMANDS.showTokenTracker}) · [Diagnostics](command:${COCOPI_COMMANDS.showDiagnostics})`,
    "",
    "Click the status bar item for the full usage picker."
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
      COCOPI_COMMANDS.showDiagnostics
    ]
  };
  return tooltip;
}

/**
 * @param {import("./runtime.js").CocopiRuntime["auth"]} [auth]
 * @param {import("./runtime.js").CocopiRuntime} [runtime]
 */
function statusTooltipAuthLabel(auth, runtime) {
  if (!runtime) {
    return "$(sync~spin) Loading";
  }

  return auth ? "$(check) Signed in" : "$(warning) Not signed in";
}

/**
 * @param {import("./runtime.js").CocopiRuntime["auth"]} [auth]
 * @param {import("./runtime.js").CocopiRuntime} [runtime]
 */
function statusTooltipAccount(auth, runtime) {
  if (auth?.chatgptPlanType) {
    return `Plan: ${auth.chatgptPlanType}`;
  }

  if (auth) {
    return "Ready";
  }

  return runtime ? "Run Cocopi: Sign In" : "Reading local state";
}

/** @param {import("./token-cache-debug.js").CocopiUsageWindowStatus} status */
function statusTooltipUsageHtml(status) {
  const apiRows = statusTooltipRateLimitRowsHtml(status);
  if (apiRows.length > 0) {
    const updatedRow = status.apiCapturedAt
      ? `<tr>${statusTooltipRowHeader("Updated")}<td colspan="4">${htmlTableCell(formatTokenCacheTimestamp(status.apiCapturedAt))}</td></tr>`
      : "";
    return [
      "<table>",
      "<thead>",
      "<tr>",
      '<th scope="col" style="white-space: nowrap">Limit</th>',
      '<th scope="col">Window</th>',
      '<th scope="col">Left</th>',
      '<th scope="col">Used</th>',
      '<th scope="col">Reset</th>',
      "</tr>",
      "</thead>",
      "<tbody>",
      ...apiRows,
      updatedRow,
      "</tbody>",
      "</table>"
    ].join("");
  }

  return [
    "<table>",
    "<tbody>",
    `<tr>${statusTooltipRowHeader("Window")}<td>${htmlTableCell(`${formatTokenCacheRounded(status.windowHours)}h`)}</td></tr>`,
    `<tr>${statusTooltipRowHeader("Billable tokens")}<td>${htmlTableCell(formatTokenCacheTokenCount(status.billableTokens))}</td></tr>`,
    `<tr>${statusTooltipRowHeader("Requests")}<td>${htmlTableCell(formatTokenCacheNumber(status.requestCount))}</td></tr>`,
    "</tbody>",
    "</table>"
  ].join("");
}

/** @param {import("./token-cache-debug.js").CocopiUsageWindowStatus} status */
function statusTooltipRateLimitRowsHtml(status) {
  const rows = [];
  for (const snapshot of status.apiRateLimits) {
    const label = snapshot.limitName ?? snapshot.limitId ?? "codex";
    if (snapshot.primary) {
      rows.push(statusTooltipRateLimitRowHtml(label, snapshot.primary, "5h"));
    }
    if (snapshot.secondary) {
      rows.push(statusTooltipRateLimitRowHtml(label, snapshot.secondary, "weekly"));
    }
    if (snapshot.credits?.hasCredits) {
      const credits = snapshot.credits.unlimited ? "unlimited" : snapshot.credits.balance ?? "available";
      rows.push(`<tr>${statusTooltipRowHeader(label)}<td>Credits</td><td>${htmlTableCell(credits)}</td><td></td><td></td></tr>`);
    }
    if (snapshot.rateLimitReachedType) {
      rows.push(`<tr>${statusTooltipRowHeader(label)}<td>Limit state</td><td>${htmlTableCell(snapshot.rateLimitReachedType)}</td><td></td><td></td></tr>`);
    }
  }

  return rows;
}

/**
 * @param {string} label
 * @param {import("./token-cache-debug.js").CocopiRateLimitWindow} window
 * @param {string} fallback
 */
function statusTooltipRateLimitRowHtml(label, window, fallback) {
  const remaining = Math.max(0, 100 - window.usedPercent);
  const reset = window.resetsAt === undefined ? "-" : new Date(window.resetsAt * 1000).toLocaleString();
  return `<tr>${statusTooltipRowHeader(label)}<td>${htmlTableCell(rateLimitWindowLabel(window, fallback))}</td><td>${htmlTableCell(`${formatTokenCacheRounded(remaining)}%`)}</td><td>${htmlTableCell(`${formatTokenCacheRounded(window.usedPercent)}%`)}</td><td>${htmlTableCell(reset)}</td></tr>`;
}

/** @param {string} label */
function statusTooltipRowHeader(label) {
  return `<th scope="row" style="white-space: nowrap">${htmlNoWrap(label)}</th>`;
}

/** @param {string} value */
function htmlNoWrap(value) {
  return htmlTableCell(value).replaceAll(" ", "&nbsp;");
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

  panel.webview.html = diagnosticsHtml(readCocopiIssues());

  const unsubscribe = onCocopiIssueChange((event) => {
    if (event.type === "delete" && typeof panel.webview.postMessage === "function") {
      void panel.webview.postMessage({ type: "cocopiDiagnosticChange", event });
      return;
    }

    panel.webview.html = diagnosticsHtml(readCocopiIssues());
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
    });
  }

  if (typeof panel.onDidDispose === "function") {
    panel.onDidDispose(unsubscribe);
  }
}

/**
 * @param {import("./issues.js").CocopiIssue[]} entries
 * @returns {string}
 */
function diagnosticsHtml(entries) {
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
  </style>
</head>
<body>
  <h2>Diagnostics</h2>
  <p>Private local diagnostics for suspected token-cache drops, state replay repairs, and runtime anomalies. Stored in VS Code private storage. Payload text and credentials are not recorded here.</p>
  <p><button type="button" id="clearDiagnostics">Clear all</button></p>
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
  panel.webview.html = tokenTrackerHtml(history, {
    tokenTracking: configuration.get("tokenTracking", true),
    usageStatus: readCocopiUsageWindowStatus(),
    usageAnalytics: readCocopiUsageAnalytics()
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
      analyticsHtml: usageAnalyticsHtml(readCocopiUsageAnalytics())
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

  await refreshTokenCacheUsageStatus(context, vscode, panel.webview);
}

/**
 * @param {CocopiSecretContext} context
 * @param {VscodeCommandApi} vscode
 * @param {{ postMessage?: (value: unknown) => Thenable<boolean> }} webview
 */
async function refreshTokenCacheUsageStatus(context, vscode, webview) {
  if (typeof webview.postMessage !== "function") {
    return;
  }

  if (!await refreshSharedCocopiUsageStatus(context, vscode)) {
    return;
  }

  await webview.postMessage({
    type: "updateTokenCacheUsageStatus",
    html: usageStatusHtml(readCocopiUsageWindowStatus()),
    analyticsHtml: usageAnalyticsHtml(readCocopiUsageAnalytics())
  });
}

/**
 * @param {import("./token-cache-debug.js").CocopiTokenCacheDebugSummary[]} entries
 * @param {{ tokenTracking?: boolean, usageStatus?: import("./token-cache-debug.js").CocopiUsageWindowStatus, usageAnalytics?: import("./token-cache-debug.js").CocopiUsageAnalytics }} [options]
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
    .analytics-grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); margin: 10px 0; }
    .analytics-panel { border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; padding: 8px; }
    .analytics-panel h3 { margin: 0 0 6px; }
    .analytics-note { color: var(--vscode-descriptionForeground); margin: 6px 0 0; }
    .analytics-table { border-collapse: collapse; width: 100%; }
    .analytics-table th, .analytics-table td { border-bottom: 1px dashed var(--vscode-editorWidget-border); padding: 4px 6px; text-align: right; white-space: nowrap; }
    .analytics-table th:first-child, .analytics-table td:first-child { text-align: left; }
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
  <div id="tokenCacheUsageAnalytics">${usageAnalyticsHtml(options.usageAnalytics)}</div>
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

/** @param {import("./token-cache-debug.js").CocopiUsageAnalytics | undefined} analytics */
function usageAnalyticsHtml(analytics) {
  if (!analytics) {
    return "";
  }

  return `
    <section class="analytics-grid">
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

/** @param {import("./token-cache-debug.js").CocopiUsageAnalyticsWindow[]} windows */
function usageAnalyticsWindowsTableHtml(windows) {
  if (windows.length === 0) {
    return `<p class="empty">No local usage rows retained yet.</p>`;
  }

  return `
    <table class="analytics-table">
      <thead>
        <tr>
          <th>Window</th>
          <th>Req</th>
          <th>Billable</th>
          <th>Uncached</th>
          <th>Tok/min</th>
          <th>Req/min</th>
          <th>Latency</th>
          <th>First output</th>
          <th>Out tok/s</th>
        </tr>
      </thead>
      <tbody>
        ${windows.map((window) => `
          <tr>
            <td>${escapeHtml(window.label)}</td>
            <td>${escapeHtml(formatTokenCacheNumber(window.requestCount))}</td>
            <td>${escapeHtml(formatTokenCacheNumber(window.billableTokens))}</td>
            <td>${escapeHtml(formatTokenCacheNumber(window.uncachedInputTokens))}</td>
            <td>${escapeHtml(formatTokenCacheRounded(window.tokensPerMinute))}</td>
            <td>${escapeHtml(formatTokenCacheRounded(window.requestsPerMinute))}</td>
            <td>${escapeHtml(formatTokenCacheDuration(window.averageLatencyMs))}</td>
            <td>${escapeHtml(formatTokenCacheDuration(window.averageFirstOutputLatencyMs))}</td>
            <td>${escapeHtml(formatTokenCacheRounded(window.outputTokensPerSecond ?? Number.NaN))}</td>
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
          <th>Limit</th>
          <th>Window</th>
          <th>Samples</th>
          <th>Used delta</th>
          <th>Delta/hour</th>
          <th>Latest used</th>
        </tr>
      </thead>
      <tbody>
        ${trends.slice(0, 8).map((trend) => `
          <tr title="${escapeHtml(`${trend.startCapturedAt} to ${trend.endCapturedAt}`)}">
            <td>${escapeHtml(trend.label)}</td>
            <td>${escapeHtml(trend.windowLabel)}</td>
            <td>${escapeHtml(formatTokenCacheNumber(trend.samples))}</td>
            <td>${escapeHtml(formatSignedPercent(trend.deltaUsedPercent))}</td>
            <td>${escapeHtml(`${formatSignedPercent(trend.deltaUsedPercentPerHour)}/h`)}</td>
            <td>${escapeHtml(formatTokenCachePercent(trend.endUsedPercent))}</td>
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
          <th>Surface</th>
          <th>${escapeHtml(snapshot.tokenUnits ?? "usage")}</th>
        </tr>
      </thead>
      <tbody>
        ${totals.slice(0, 12).map(([surface, value]) => `
          <tr>
            <td>${escapeHtml(surface)}</td>
            <td>${escapeHtml(formatTokenCacheNumber(value))}</td>
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
          <th>Client</th>
          <th>Turns</th>
          <th>Total tokens</th>
          <th>Uncached</th>
          <th>Cached</th>
          <th>Output</th>
        </tr>
      </thead>
      <tbody>
        ${clients.slice(0, 12).map((client) => `
          <tr>
            <td title="${escapeHtml(remoteWorkspaceClientTitle(client.clientId))}">${escapeHtml(formatRemoteWorkspaceClientLabel(client.clientId))}</td>
            <td>${escapeHtml(formatTokenCacheNumber(client.turns))}</td>
            <td>${escapeHtml(formatTokenCacheNumber(client.textTotalTokens))}</td>
            <td>${escapeHtml(formatTokenCacheNumber(client.uncachedTextInputTokens))}</td>
            <td>${escapeHtml(formatTokenCacheNumber(client.cachedTextInputTokens))}</td>
            <td>${escapeHtml(formatTokenCacheNumber(client.textOutputTokens))}</td>
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
          <th>Agent/session</th>
          <th>Req</th>
          <th>Billable</th>
          <th>Uncached</th>
          <th>Latency</th>
          <th>Out tok/s</th>
        </tr>
      </thead>
      <tbody>
        ${sessions.slice(0, 8).map((session) => `
          <tr title="${escapeHtml(session.sessionId)}">
            <td>${escapeHtml(`${formatTokenCacheSource(session.source)} · ${compactTokenCacheSessionId(session.sessionId)}`)}</td>
            <td>${escapeHtml(formatTokenCacheNumber(session.requestCount))}</td>
            <td>${escapeHtml(formatTokenCacheNumber(session.billableTokens))}</td>
            <td>${escapeHtml(formatTokenCacheNumber(session.uncachedInputTokens))}</td>
            <td>${escapeHtml(formatTokenCacheDuration(session.averageLatencyMs))}</td>
            <td>${escapeHtml(formatTokenCacheRounded(session.outputTokensPerSecond ?? Number.NaN))}</td>
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
  const selection = await vscode.window.showQuickPick(auth ? ["Show Status", "Sign Out"] : ["Sign In", "Show Status"], {
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
    placeHolder: "Cocopi status"
  });
  await handleStatusAction(selection, vscode);
}

/**
 * @param {string | { action?: string } | undefined | void} selection
 * @param {VscodeCommandApi} vscode
 */
async function handleStatusAction(selection, vscode) {
  const action = typeof selection === "object" && selection ? selection.action : selection;
  if (action === "token-tracker" || action === COCOPI_STATUS_TOKEN_TRACKER_ACTION) {
    await vscode.commands.executeCommand?.(COCOPI_COMMANDS.showTokenTracker);
    return;
  }

  if (action === "diagnostics" || action === COCOPI_STATUS_DIAGNOSTICS_ACTION) {
    await vscode.commands.executeCommand?.(COCOPI_COMMANDS.showDiagnostics);
  }
}

/**
 * @param {Awaited<ReturnType<typeof readCodexAuth>>} auth
 * @param {import("./runtime.js").CocopiRuntime} runtime
 * @param {import("./token-cache-debug.js").CocopiUsageWindowStatus} usage
 * @returns {CocopiStatusQuickPickItem[]}
 */
function cocopiStatusQuickPickItems(auth, runtime, usage) {
  return [
    {
      label: auth ? "$(check) Signed in" : "$(warning) Not signed in",
      description: auth?.chatgptPlanType ? `Plan: ${auth.chatgptPlanType}` : undefined,
      detail: `Fallback model: ${runtime.configuration.model}. Use VS Code's chat model picker to choose active Cocopi models.`
    },
    ...usageStatusQuickPickItems(usage),
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

/** @param {import("../../data/Codex.js").CodexModelSummary} model */
function modelDetail(model) {
  const details = [];
  if (model.contextWindow) details.push(`${model.contextWindow.toLocaleString()} tokens`);
  if (model.additionalSpeedTiers?.includes("fast")) details.push("Fast available");
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
