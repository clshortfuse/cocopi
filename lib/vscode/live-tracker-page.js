import { readCocopiLiveRequests } from "./live-sessions.js";

/** @param {Pick<import('./commands.js').VscodeCommandApi, 'window' | 'ViewColumn'>} vscode */
export function showCocopiLiveTracker(vscode) {
  const panel = vscode.window.createWebviewPanel("cocopiLiveTracker", "Cocopi Live Tracker", vscode.ViewColumn?.Active ?? 1, { enableScripts: true });
  panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><title>Cocopi Live Tracker</title><style>
    body { background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); padding: 20px; }
    h1 { font-size: 22px; margin-bottom: 8px; }
    .live-requests-heading, .live-request-heading { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; }
    .live-requests-heading h2 { align-items: center; display: flex; gap: 8px; margin: 0; font-size: 16px; }
    .live-request-count { background: var(--vscode-badge-background); border-radius: 999px; color: var(--vscode-badge-foreground); min-width: 22px; padding: 2px 6px; text-align: center; }
    .live-request-scope, .live-request-timing, .live-requests-empty, .scope { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .live-request-list { display: grid; gap: 12px; margin-top: 16px; }
    .live-request-card { border: 1px solid var(--vscode-editorWidget-border); border-radius: 10px; padding: 16px; }
    .live-request-heading strong { overflow-wrap: anywhere; }
    .live-request-stage { background: var(--vscode-badge-background); border-radius: 999px; color: var(--vscode-badge-foreground); font-size: 12px; padding: 3px 8px; }
    .live-request-timing { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 8px; font-variant-numeric: tabular-nums; }
    .live-request-details { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 10px; }
    .live-request-details summary { cursor: pointer; width: max-content; }
    .live-request-details dl { display: grid; gap: 4px 12px; grid-template-columns: auto 1fr; }
    .live-request-details dd { margin: 0; overflow-wrap: anywhere; user-select: text; }
  </style></head><body><h1>Live Tracker</h1><p class="scope">Active Cocopi model calls only. Host tools and VS Code scheduling are not observable here.</p>
  <section id="cocopiLiveRequests" aria-label="Active requests">${liveRequestsHtml()}</section><script>
    window.addEventListener('message', (event) => {
      if (event.data?.type !== 'cocopiLiveRequests' || typeof event.data.html !== 'string') return;
      const liveRequests = document.getElementById('cocopiLiveRequests');
      const template = document.createElement('template');
      template.innerHTML = event.data.html;
      const incoming = template.content;
      liveRequests.querySelector('[data-live-count]').textContent = incoming.querySelector('[data-live-count]').textContent;
      liveRequests.querySelector('[data-live-empty]').hidden = incoming.querySelector('[data-live-empty]').hidden;
      const list = liveRequests.querySelector('[data-live-list]');
      const cards = new Map([...list.querySelectorAll('[data-live-request-id]')].map((card) => [card.dataset.liveRequestId, card]));
      for (const next of incoming.querySelectorAll('[data-live-request-id]')) {
        const current = cards.get(next.dataset.liveRequestId);
        if (current) {
          for (const field of ['model', 'stage', 'elapsed', 'activity', 'progress', 'deadline', 'heartbeat', 'heartbeat-deadline', 'wire', 'event', 'session', 'turn']) {
            const target = current.querySelector('[data-live-' + field + ']');
            const text = next.querySelector('[data-live-' + field + ']').textContent;
            if (target.textContent !== text) target.textContent = text;
          }
          cards.delete(next.dataset.liveRequestId);
        } else { list.append(next); }
      }
      for (const removed of cards.values()) removed.remove();
    });
  </script></body></html>`;
  const timer = setInterval(() => {
    void panel.webview.postMessage?.({ type: "cocopiLiveRequests", html: liveRequestsHtml() });
  }, 1000);
  timer.unref?.();
  panel.onDidDispose?.(() => clearInterval(timer));
  return panel;
}

/** @param {string} text */
function escapeHtml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Render escaped, payload-free transport metadata. */
function liveRequestsHtml() {
  const requests = readCocopiLiveRequests();
  const now = performance.now();
  return `<div class="live-requests-heading"><h2>Active requests <span class="live-request-count" data-live-count>${requests.length}</span></h2><span class="live-request-scope">Model activity</span></div>
    <p class="live-requests-empty" data-live-empty${requests.length > 0 ? " hidden" : ""}>No active model requests.</p>
    <div class="live-request-list" data-live-list>${requests.map((request) => {
      const elapsed = Math.max(0, Math.floor((now - request.startedAt) / 1000));
      const duration = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;
      const activity = request.lastEventAt === undefined ? "No events yet" : `Last event ${age(request.lastEventAt)}s ago`;
      const progress = request.lastProgressAt === undefined ? "No output progress yet" : `Output progress ${age(request.lastProgressAt)}s ago`;
      const status = request.transportStatus;
      /** @param {number | undefined} time */
      function age(time) { return Math.max(0, Math.floor((now - (time ?? now)) / 1000)); }
      /** @param {number | undefined} time */
      const observed = (time) => time === undefined ? "not observed" : `${age(time)}s ago`;
      /**
       * @param {string} label
       * @param {number} time
       */
      const countdown = (label, time) => time > now ? `${label} in ${Math.ceil((time - now) / 1000)}s` : `${label} overdue by ${Math.floor((now - time) / 1000)}s`;
      const deadline = status?.responseIdleDeadlineAt === undefined ? "Response idle timer inactive" : countdown("Response idle timeout", status.responseIdleDeadlineAt);
      let heartbeat = "Heartbeat not started";
      if (status) {
        switch (status.heartbeat) {
          case "unconfirmed": { heartbeat = "WebSocket pong support unconfirmed; incoming traffic monitored"; break; }
          case "unsupported": { heartbeat = status.transport === "sse" ? "SSE: no ping/pong; byte activity monitored" : "WebSocket heartbeat unavailable in this runtime"; break; }
          default: { heartbeat = `WebSocket heartbeat: ${status.heartbeat}; ping ${observed(status.lastPingAt)}; pong ${observed(status.lastPongAt)}`; }
        }
      }
      let heartbeatDeadline = "No transport liveness deadline armed";
      if (status?.pongDeadlineAt === undefined) {
        if (status?.nextPingAt !== undefined) heartbeatDeadline = countdown("Next ping", status.nextPingAt);
      } else {
        heartbeatDeadline = countdown("Transport silence timeout", status.pongDeadlineAt);
      }
      const wire = `Last transport data ${observed(status?.lastDataAt)}; server ping ${observed(status?.lastServerPingAt)}`;
      return `<article class="live-request-card" data-live-request-id="${request.id}">
        <div class="live-request-heading"><strong data-live-model>${escapeHtml(request.model)}</strong><span class="live-request-stage" data-live-stage>${escapeHtml(request.stage)}</span></div>
        <div class="live-request-timing"><span data-live-elapsed>${duration} elapsed</span><span data-live-activity>${activity}</span></div>
        <div class="live-request-timing"><span data-live-progress>${progress}</span><strong data-live-deadline>${deadline}</strong></div>
        <div class="live-request-timing"><span data-live-heartbeat>${heartbeat}</span><strong data-live-heartbeat-deadline>${heartbeatDeadline}</strong></div>
        <div class="live-request-timing" data-live-wire>${wire}</div><div class="live-request-timing" data-live-event>${escapeHtml(request.lastEventType ?? "No stream event received")}</div>
        <details class="live-request-details"><summary>Request details</summary><dl><dt>Session</dt><dd data-live-session>${escapeHtml(request.sessionId || "Not assigned yet")}</dd><dt>Turn</dt><dd data-live-turn>${request.turn || "Not assigned yet"}</dd></dl></details>
      </article>`;
    }).join("")}</div>`;
}