# Live requests dashboard

- Track concurrent language-model provider calls in memory only, without prompts, tool arguments, or credentials.
- Show preparing locally, waiting for the server, and receiving server events, with model, session/turn identity, elapsed time, and time since the last event.
- Remove requests on completion, cancellation, and failure; dispose dashboard refresh timers when the panel closes.
- An empty list means no active Cocopi language-model calls, not that VS Code is idle. Host tool execution and internal scheduling are not observable here.
- Validate lifecycle tests and repository checks, lint, and tests.

## Dashboard presentation

- Label the panel **Active requests**, with a count and a compact model card per call.
- Keep factual stage and elapsed/last-event timing visible; place session and turn identifiers inside collapsed request details.
- Use VS Code theme colors and wrapping layouts. Do not imply completion percentages or infer a stalled request from silence.
- Refresh existing cards by request ID, updating changed text only. Preserve disclosure state and focus rather than replacing the panel every second.
- Keep the provider-only visibility limitation in a secondary scope tooltip and use a concise empty state.
- Show the numeric request count in status-bar and native Chat hovers, including `Requests: 0` when idle. Update the hover only when the count changes; stage-only events leave its content and object unchanged. Reuse cached account/runtime state without refreshing auth or remote usage. Detailed stages and heartbeat information remain on Live Tracker; ordinary account/usage refreshes remain separate.
- Put detailed live diagnostics on a separate **Live Tracker** page (`cocopi.showLiveTracker`), reachable from the Command Palette, status hover, native Chat status, and dashboard action links. The settings dashboard has no live cards, live update listener, or refresh timer.
- Keep the status-bar item visible with a numeric request count, including `0`. Do not show/hide the item or reassign its text on stage-only updates; live receiving/waiting/preparing details belong to the separate tracker.

## Transport heartbeat and idle monitoring

- Display the last stream event type separately from output progress. Generic status/metadata events do not establish output progress.
- Do not abort for lack of visible output. Quiet reasoning and host system-notification waits are not evidence of a dead connection. Host scheduling outside a model call remains unobservable.
- Preserve the existing `streamIdleTimeoutMs` response-idle policy: WebSocket response messages or SSE byte chunks (including comments) reset it. Ping/pong control frames do not. Show its actual transport-owned deadline, not an inferred deadline from provider consumption.
- The worker's `ws` client automatically answers server pings. Initialize heartbeat monitoring with an immediate, uniquely identified capability ping. Only its matching pong confirms support; server pings and unrelated pongs do not. An unanswered initial probe (30 seconds) marks support unconfirmed and disables heartbeat enforcement without aborting the response. The existing response-idle policy remains in effect.
- Once that socket has returned a matching pong, send client pings every 30 seconds and require each matching pong within 30 seconds. Record last client ping, matching pong, server ping, next probe, and pong deadline. A missed matching pong on a confirmed socket fails visibly with `heartbeat_timeout`, retires the socket, and does not automatically replay the generation.
- Retain confirmed/unconfirmed capability weakly by socket identity across requests. Do not assume support from the endpoint URL, another connection, or a previous live test; a new socket must establish its own capability. Short responses ending before probe resolution remain unconfirmed and may probe again on reuse.
- Active client probes are a Cocopi liveness policy, not a claim that upstream Responses sends periodic client pings. Current upstream `codex-rs/codex-api/src/endpoint/responses_websocket.rs` answers server pings outside the response queue; its response-idle timeout is likewise separate from heartbeat handling.
- Runtimes without control-frame APIs report heartbeat unavailable. SSE reports byte activity, never fictional ping/pong. Disabling response idle timeout does not disable WebSocket liveness probes.
- Carry health snapshots on an independently acknowledged worker channel with at most one message in flight and one coalesced latest snapshot. Output-consumer backpressure must not stall heartbeat processing or falsely refresh data ages.
- Use `performance.now()` for all live-request ages, transport activity timestamps, and heartbeat/response-idle deadlines. Node worker threads and the extension host share the process time origin, so snapshots stay comparable without wall-clock conversion; calendar-time usage accounting remains separate. Test wall-clock jumps explicitly.
- Clear timers/listeners on completion, cancellation, error, and disposal; keep telemetry payload-free and never record ping payloads, prompts, or credentials.
- Validate matching/mismatched/missing pongs, ongoing traffic without output, server ping replies, response-idle independence, worker backpressure, unsupported transports, UI countdowns, and cleanup.
- Already running requests use their loaded extension code; source changes do not retrofit their timers. No claim is made that this diagnoses the backend cause of an existing stall.