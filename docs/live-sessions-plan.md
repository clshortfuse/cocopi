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
- The worker's `ws` client automatically answers server pings. Arm a 30-second receive-silence deadline immediately when request heartbeat monitoring starts, with no prerequisite successful ping/pong. Send an immediate initial probe and subsequent probes after 15 seconds without incoming traffic. Sending a probe never extends the receive deadline.
- Every incoming WebSocket message, server ping, or pong resets the receive-silence deadline. Only a matching pong confirms pong capability, but capability is informational and never disables enforcement. Thirty seconds of complete receive silence fails visibly with `heartbeat_timeout`, retires the socket, and does not automatically replay the generation. Control frames remain separate from model progress and response-idle activity.
- In the Node `ws` runtime, also observe `data` on its established `_socket`: `message` is emitted only after the final fragment, so partial frames/messages must refresh receive liveness too. This isolated private-field dependency adds/removes only its own listener; it never replaces `ws` parsing handlers. Byte activity does not update response progress, `lastDataAt` (complete-message activity), or the response-idle deadline. Real-socket regressions cover continued fragments, eventual completion, silence after a partial message, and listener cleanup.
- The existing `pongDeadlineAt` status field now carries the receive-silence deadline; the tracker labels it `Transport silence timeout` even before pong support is confirmed. It remains armed after successful activity, not merely while a probe is pending.
- Retain confirmed/unconfirmed capability weakly by socket identity across requests. Do not assume support from the endpoint URL, another connection, or a previous live test; a new socket must establish its own capability. Short responses ending before probe resolution remain unconfirmed and may probe again on reuse.
- Active client probes are a Cocopi liveness policy, not a claim that upstream Responses sends periodic client pings. Current upstream `codex-rs/codex-api/src/endpoint/responses_websocket.rs` answers server pings outside the response queue; its response-idle timeout is likewise separate from heartbeat handling.
- Runtimes without control-frame APIs report heartbeat unavailable. SSE reports byte activity, never fictional ping/pong. Disabling response idle timeout does not disable WebSocket liveness probes.
- Carry health snapshots on an independently acknowledged worker channel with at most one message in flight and one coalesced latest snapshot. Output-consumer backpressure must not stall heartbeat processing or falsely refresh data ages.
- Use `performance.now()` for all live-request ages, transport activity timestamps, and heartbeat/response-idle deadlines. Node worker threads and the extension host share the process time origin, so snapshots stay comparable without wall-clock conversion; calendar-time usage accounting remains separate. Test wall-clock jumps explicitly.
- Clear timers/listeners on completion, cancellation, error, and disposal; keep telemetry payload-free and never record ping payloads, prompts, or credentials.
- Validate matching/mismatched/missing pongs, ongoing traffic without output, server ping replies, response-idle independence, worker backpressure, unsupported transports, UI countdowns, and cleanup.
- Already running requests use their loaded extension code; source changes do not retrofit their timers. No claim is made that this diagnoses the backend cause of an existing stall.
- Bound unacknowledged host-to-worker dispatch to 30 seconds, not queue waiting. Protocol v5 sends an independent `accepted` message once the worker admits the invocation, before parsing/network/queue awaits. Acceptance clears the dispatch watchdog without claiming that the request has opened or produced output. A healthy shared session may serve an earlier generation longer than 30 seconds; queued requests must not expire for that reason. Socket-owned receive liveness remains fatal after 30 seconds without bytes/ping/pong; outgoing traffic never extends it. The existing socket connection-opening and response-idle protections remain separate.
- An unacknowledged dispatch fails with its actual dispatch-timeout reason and no automatic replay. Do not classify errors as user cancellation merely because their explanatory text contains `cancel` or `abort`: provider cancellation classification requires an aborted signal or an `AbortError`.

### Queue ownership investigation

- A synthetic local-server probe reproduced the reported card pattern with exactly one WebSocket: the first request remains active, while a second request awaits `state.started` and has no heartbeat status of its own. Separate cards do not establish separate sockets.
- Fixed cancellation gap: queued WebSocket requests now attach their abort listener at admission, before awaiting the queue. Cancellation immediately rejects the opening promise without cancelling or closing the active request's socket. When a cancelled entry reaches the queue front, it is skipped without sending a prompt.
- The strengthened queued-cancellation regression leaves the first request active, requires rejection after one event-loop turn, verifies no active-response cancel or socket close, and then verifies the first response completes normally. It failed on the original listener timing and passed unchanged after the fix.
- The worker dispatch deadline bounds unacknowledged admission only. Explicit cancellation can promptly settle an accepted queued request; its queue wait has no independent absolute expiry. The promise-chain queue still retains the cancelled entry until its position is reached; this change does not claim immediate removal of that entry or shared heartbeat reporting for queued cards.
- Continuous `response.function_call_arguments.delta` messages keep receive and response-idle deadlines alive without completing a tool call. A healthy heartbeat cannot detect an abandoned request that continues producing data.
- The affected window's minimal logs identify request starts and cancellations, but do not contain invocation/socket identifiers or enough terminal-event records to prove the exact live queue owner. Do not infer socket identity from the logical session ID alone.

### Queue deadline regression correction

On 2026-11-08, affected-window metadata showed repeated 30-second worker-opening
timeouts while an earlier generation continued receiving events. The original
queue-inclusive watchdog confused request opening with connection liveness, and
the error mapper hid the timeout behind a generic cancellation message. Real
worker/local WebSocket regression coverage first failed with a rejected queued
request behind an active generation, then passed after admission acknowledgment.
The same test verifies one active generation and successful queue progression
after explicit cancellation of the first request. Separate coverage verifies
unacknowledged dispatch still times out and cancellation wording does not hide
operational failures. No running requests are cancelled or replayed by applying
these source changes.

### Renounce whitespace-only argument stall

Passive payload/log inspection on 2026-11-08 mapped `C:/Mods/renounce` to its
workspace-storage chat and window14 capture. Request turn 46 was prepared at
19:18:03.807Z, its wire request at 19:18:03.817Z, and `response.created` at
19:18:04.170Z. The prepared request had 99 input items; continuation adaptation
sent one input item plus a previous-response ID, with 57 tools. These metadata
alone do not implicate continuation adaptation in the failure.

The retained output-log tail spans 19:43:53.339Z–19:55:13.166Z and contains
34,007 payload-decoded `response.function_call_arguments.delta` events for one
item. Their sequence numbers are contiguous, 77,399–111,405. All 204,045 captured
argument characters are whitespace, across only five distinct chunk values.
No non-argument stream event or terminal completion appears in that retained
tail. Initial large response events survive in the payload sidecar, but the
earlier small-delta output-log prefix is not retained; do not claim the full
37-minute generation was whitespace-only or reconstruct its initial arguments.

This confirms an actively delivered, non-completing whitespace generation loop,
not a silent socket or repeated display of the same sequence-numbered event.
It also establishes a local UX/safety gap: argument fragments keep response idle
and displayed output progress fresh even when no usable tool call results.
Transport liveness must remain byte/ping/pong based. Any future runaway-argument
guard must be separate, tested against legitimate JSON string content and
fragment boundaries, fail visibly without automatic paid replay, and not impose
an arbitrary time cap on valid long-running output. No runtime guard was added
or active generation cancelled during this investigation. Raw argument text,
prompts, and credentials are intentionally absent from these notes.

### Runaway argument guard

The shared `CodexTransport` stream now rejects more than 16,384 consecutive JSON
whitespace characters (space, tab, CR, LF) outside a string within one unfinished
function-call argument stream. This is an explicit Cocopi-local defensive limit,
not an upstream protocol restriction, total response deadline, or limit on
whitespace inside a tool's string values. A deliberately formatted valid JSON
argument containing a longer outside-string run is also rejected by this policy.

Per-item lexical state tracks quotes and backslash escapes across delta
boundaries, including initial arguments on `response.output_item.added`. Any
non-whitespace JSON progress resets the run. Completed items and responses clear
state; no argument text is retained or rewritten by the guard. Interleaved calls
do not share whitespace counters. SSE and WebSocket paths use the same guard,
including the actual worker-backed path before delivery to the host. Existing
heartbeat and response-idle semantics are unchanged.

On violation, cancel only the guarded source, release its reader/admission
resources, and return a payload-free `tool arguments stalled` error. It is not a
retryable WebSocket/TypeError failure, so no automatic SSE fallback, socket retry,
or paid completed-item continuation is triggered. No active installed request is
modified merely by changing source files.

The fragmented whitespace regression first failed with `Missing expected
rejection` before the guard, then passed unchanged afterward. Additional tests
cover large quoted whitespace with escaped quotes split across chunks, exact
boundary acceptance, non-whitespace progress, interleaved calls, completed-item
cleanup, downstream cancellation, WebSocket non-replay behavior, and real worker
error delivery/admission cleanup.

Upstream comparison on 2026-11-08:
`openai/codex` main `codex-rs/codex-api/src/sse/responses.rs` handles function
argument delta/done events as unhandled transport events and relies on completed
output items; no equivalent 16,384-character whitespace-run limit appears in
that handler. This guard is intentional local safety behavior, not claimed
upstream parity.