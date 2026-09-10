# Worker transport isolation plan

Date: 2026-09-09. Status: enabled by default; rollout gates remain open.
Implement and validate for user testing; do not stage or commit without review.

## Implementation work log

- Test-isolation follow-up: explicitly select in-host transport in chat, inline
  completion and provider fixtures that mock host-global networking. Preserve
  production/default configuration coverage and independent local-server worker
  tests. All 577 offline tests passed without forced exit (8.61 seconds),
  including the previously failing focused chat test. Type checks, lint and
  package consistency checks passed. Installed-extension and proxy/certificate
  validation remain pending.

- Default-selection follow-up: enable worker transport in the manifest and runtime
  fallback, retain explicit `false` opt-out, update default/invalid-value tests and
  documentation, then run check, lint and offline tests. Rollout validation below
  remains pending.

- Repeatability follow-up: removed the long-duration environment override from
  regression tests. Also fixed SSE watchdog cleanup on cancellation/read failure:
  the full 576-test offline suite dropped from 124.96 seconds to 7.91 seconds
  because cancelled streams no longer leave a 120-second timer alive. Production
  idle timeout behavior remains enabled and unchanged in duration.

- Preserve the existing uncommitted provider-owned completed-item recovery.
- Extract the shared transport/session/reconnect service without changing wire
  requests; auth refresh and VS Code callbacks remain host-owned.
- Add a worker selector, bounded ordered delivery and private
  temporary overflow storage, with local failures excluded from recovery.
- Reproduce host starvation using an independent local server, first against
  in-host transport and then against worker transport. Debugger pauses would
  distort this timing test; use synchronous test-host blocking instead.
- Run offline validation explicitly excluding credential-loading live tests.
- Windows installed-VSIX and remote WSL proxy/certificate parity are rollout
  gates, not assumptions. No user processes will be restarted for validation.

### Implemented boundary

`lib/codex-api/transport.js` is the shared VS Code-independent session and
reconnect/fallback owner in both modes. `worker-transport.js` owns the host
adapter; `transport-worker.js` owns socket/SSE receipt, parsing, timers and
session caches. All callers of the existing authenticated response entry point,
including provider recovery SSE, use the selected mode. Auth refresh stays in
the host and invalidates the old worker generation through the existing session
invalidation hook. There is no new post-output recovery owner.

`cocopi.workerTransport` defaults to **true**. Set it to **false** for subsequent
requests to use in-host transport. Failure of the selected worker does not fall back to the
host or replay a request; a new worker is created only for a future invocation.
VS Code registrations, tools, rendering and request conversion remain host-side.
Prepared-request callbacks are represented by ordered input-count/response-ID
records, not a second full request transfer. The adapter reconstructs the view
from the original host request for existing diagnostics.

Protocol v1 includes a ready handshake, generation/invocation IDs, start,
ordered records with local delivery sequence, acknowledgment, cancel and
shutdown. Session invalidation shuts down the entire credential generation.
One record per request can be unacknowledged; event credit is returned on the
next host pull, not on MessagePort receipt. Host streams have a zero high-water
mark. Completion/error drains preceding records; user cancellation discards
remaining delivery. Errors cross as explicit fields, not Error prototypes.
Worker/storage failures are not TypeError or retryable WebSocket errors.

### Explicit initial limits

| Resource | Limit |
| --- | --- |
| Active or undrained invocations | 8 |
| Serialized upload | 16 MiB each; 32 MiB aggregate until settled |
| Inbound WebSocket message / serialized delivery record | 4 MiB |
| HTTP chunk / completed JSON response / SSE event accumulation | 4 MiB |
| Retained completed WebSocket output | 4 MiB per request |
| In-memory delivery payload | 1 MiB per request; 8 MiB aggregate |
| Unacknowledged IPC payload | One event per request; at most 32 MiB aggregate |
| Overflow storage | 64 MiB per invocation lifetime; 512 MiB aggregate |
| Delivery record descriptors | 100,000 per invocation |
| Idle reusable sessions / serialized continuation cache | 32 / 16 MiB aggregate |
| Worker old-generation JS heap | 256 MiB |

Byte limits describe serialized payloads, not identical heap usage: UTF-16
strings, parsed objects, descriptor arrays, upload serialization, crypto buffers
and transient copies add overhead. The worker heap limit does not cap external
buffers or shared process RSS. Frame, HTTP, upload, retention, IPC and disk limits
bound those producer surfaces separately. The original VS Code request and
conversion remain host-owned and are outside this transport budget. Reaching a
limit is an explicit failure, not a guarantee that every combination of maximum
requests fits the heap or can be recovered for free.

`worker-buffer.js` retains ordered memory records then incrementally writes and
reads overflow records, never an entire backlog. Files use private temporary
directories and mode 0600 where supported. Each disk record uses AES-256-GCM;
the ephemeral request key is never persisted, protecting content even under
unusual Windows temporary-directory ACLs. Storage uses synchronous bounded
record IO in the worker to avoid an unbounded asynchronous write queue. Very
slow storage can stall the worker itself; slow-storage performance/fault probes
remain a rollout gate. This isolates **host** starvation, not arbitrary worker
or machine-wide starvation. There is no speculative disk repair.

Acknowledged terminal delivery, cancellation and shutdown clean request files.
The host removes the worker's private root after worker exit, including crashes.
Startup cleanup only considers mechanism-owned roots older than 24 hours whose
recorded parent PID is confirmed absent; keys from crashed requests are lost.
Cleanup failures can leave encrypted stale files until a later cleanup pass.

### Verification evidence

- Local CLI runtime: Node 24.11.1, libuv 1.51.0, OpenSSL 3.5.4; `ws` 8.21.3.
  Installed VS Code package declares 1.135.0 and Electron 42.8.1. The extension
  host's actual runtime/network patch behavior was not inferred from CLI Node.
- Upstream wire semantics remain those documented for Codex `rust-v0.153.3`:
  normal `response.create`, existing headers/continuation, no new generation
  keepalives, storage mode changes or undocumented reattachment requests.
  `ws` provides protocol pong responses; pings do not count as model output or
  reset the response-progress deadline. TLS verification remains enabled.
- Independent fake WebSocket/SSE server runs in its own worker. The same stall
  regression first failed with in-host transport for **both** protocols:
  `idle for 250ms` after a 1,200 ms host stall. Both passed using worker transport
  with all 32 events in order and exactly one generation. The block is scheduled
  in the event-loop check phase so expired timers precede queued socket reads;
  blocking at an arbitrary promise continuation did not reproduce that ordering.
- Historical one-off WebSocket probe (not a routine regression test):
  **130,000 ms host stall** against
  **120,000 ms idle timeout** passed; 32 events, one generation, terminal received
  while the host was blocked, then the server closed. Maximum decoded-event gap
  4,012.08 ms; maximum acknowledgment lag 130,001.46 ms; memory payload high-water
  1,042,034 bytes; encrypted spool high-water 1,363,376 bytes; worker event-loop
  delay maximum 34.31 ms. Sampled worker heap 10,494,080 bytes; **shared process**
  RSS 103,690,240 bytes. Decoded-event gaps are not raw network packet timestamps.
- Safety tests exercise real worker cancellation, parallel conversations, genuine
  silence including queued backlog, crash/start failure, malformed envelopes,
  exact commentary/reasoning/encrypted/tool/usage preservation, request/frame and
  concurrency limits, storage exhaustion/write failure/corruption and cleanup.
- Archive inspection caught and fixed VSIX dependency exclusion. The resulting
  archive contains the worker entry/helpers and `node_modules/ws`; its extracted
  worker passed both stall tests and the exact event-preservation test. This is a
  packaged-worker smoke test, **not** an installed extension-host smoke test.

Remaining rollout gates: installed-extension Windows and remote WSL runs,
proxy/system-certificate parity (VS Code network patches are not inherited),
slow-storage probes, complete fault-injected IPC/auth/session-continuation matrix,
and broader CPU/heap/transfer/drain profiling. No live credential requests or
changes to user-running VS Code/WSL processes are needed for the local tests.
The fix does not address Copilot prompt pruning or host-owned retry policy.

Final local validation: `npm run check`, `npm run lint`, package checks, VSIX
packaging and `git diff --check` pass. All **576 offline tests** pass. The offline
equivalent of `npm run validate` passes the configured aggregate coverage gates:
**92.60% lines, 81.81% branches, 93.65% functions**. Live tests were explicitly
excluded rather than allowing `.env` to activate them. These are the Node test
runner's reported coverage totals, not a claim of complete worker-thread coverage.
The review artifact is `out/cocopi-0.0.1.vsix`; nothing is staged or committed.
Dependency audit also reports three transitive tooling vulnerabilities
(`baseline-browser-mapping`, `brace-expansion`, `browserslist`), not `ws`; no
unrelated dependency upgrades were performed.

## Problem and intended outcome

Copilot prompt pruning can block the shared extension-host JavaScript thread for
minutes. September 9 CPU profiles attribute approximately 90-92% of sampled time
to repeated prompt-tree traversal and keepWith removal; garbage collection is
approximately 1-2%. The host was reported unresponsive from 15:38:57 to 15:42:27,
when two Cocopi idle errors were delivered together. This supports host starvation
as a timeout contributor, but does not prove the server sent bytes during the gap.

Cocopi currently receives WebSocket messages and runs its 120-second idle timer
on that thread. Move response transport into a Node.js worker so socket reads,
parsing, network inactivity measurement, and bounded buffering can continue while
the host is blocked. Deliver the original events in order when the host resumes.
Keeping a connection alive must not issue another generation request.

This does not move all of Cocopi into a worker. VS Code APIs and UI callbacks must
remain in the extension host. A worker does not fix Copilot's pruning algorithm,
make the frozen UI responsive, or survive termination of its parent process.

## Existing boundaries and concurrent work

- `lib/vscode/codex-request.js`: shared response transport entry point, auth
  refresh, WebSocket session lifecycle, and existing reconnect/fallback policy.
- `lib/codex-api/websocket.js`: socket events, continuation anchors, cancellation,
  and idle timer. `handleMessageAsync` resets idle before decoding each message.
- `lib/codex-api/responses.js` and `sse.js`: HTTP streaming and SSE parsing.
- `lib/vscode/runtime.js` and `secret-storage.js`: host configuration and auth.
- `language-model-provider.js`, `chat-participant.js`, and `inline-completions.js`
  under `lib/vscode/`: consumers of the shared response stream.
- `lib/vscode/stream-recovery.js` and the uncommitted provider/tests/docs changes
  already implement a separate completed-item continuation policy. Read
  `docs/stream-recovery-plan.md` and `docs/stream-recovery-handoff.md`. Preserve
  this work and coordinate the boundary; do not create another recovery owner.

## Architecture

Use one lazy, extension-owned ESM worker per extension host initially. Multiplex
requests by unique invocation ID; maintain distinct existing session identities
inside it. Avoid a worker per token, request, or conversation. Reconsider a small
pool only if profiling proves the transport worker itself becomes CPU-bound.

Host owns:

- VS Code registration, progress parts, tool execution, dashboard, SecretStorage,
  configuration, auth refresh, and the current provider recovery decision.
- Conversion of VS Code objects into the existing plain request contract.
- Cancellation forwarding and mapping worker errors back into existing errors.

Worker owns:

- WebSocket and SSE request execution, parsing, connection/session maps,
  continuation bookkeeping, transport cancellation, and transport idle timers.
- Ordered response-event storage/delivery, flow control, and transport metrics.
- Existing transport fallback/reconnect behavior only after explicitly extracting
  it from the host; never add a second independent retry layer.

Keep current pure transport helpers reusable in offline tests. Prefer a small
worker entry module, host stream adapter, and shared JSDoc protocol definitions
under `lib/`; choose names consistent with the repository during implementation.
Do not import `vscode` from worker modules.

## IPC and ordering contract

Define a versioned, discriminated protocol for start/ready, request start,
transport-opened, event batches, delivery acknowledgments, cancel, terminal/error,
session invalidation, and shutdown. Every request message carries an invocation
ID and worker generation ID. Ignore stale messages from disposed invocations.

Use a monotonically increasing local delivery sequence distinct from upstream
sequence numbers. Preserve every upstream event and its original phase, reasoning,
encrypted content, tools, IDs, terminal state, and usage. Do not manufacture text,
reclassify commentary, hide events, or execute tools in the worker.

Expose the existing asynchronous stream interface to consumers. Replace callbacks
such as continuation decisions and prepared-request diagnostics with ordered
protocol records. Avoid transferring a second full request just for diagnostics;
keep full payload handling in the worker where needed. Do not structured-clone
AbortSignals, callbacks, VS Code objects, or Error prototypes. Reconstruct typed
errors from explicit fields, preserving status and recovery-relevant categories.

Use bounded byte credits and batch-size limits. Acknowledge only after host-side
consumption has freed the batch, not upon receipt into another unbounded queue.
Bound both MessagePort traffic and the host ReadableStream queue. Account for
large individual events, request uploads, and structured-clone/transient copies.
Measure request transfer costs; the initial VS Code conversion still runs on the
host and cannot benefit from this isolation.

## Buffering without losing conversation data

Worker reads must continue when host delivery stalls. Credits alone cannot solve
this: stopping socket consumption can move the unbounded queue into the socket
library. Establish explicit per-request and aggregate memory budgets, maximum
in-flight IPC bytes, and supported frame/event sizes before enabling the worker.

Spool overflow to private, request-scoped temporary files owned by the worker.
This is transient delivery storage, not optional debug payload logging and not
VS Code chat metadata. Preserve event order across memory and disk. Include
spool read/write queues and upstream buffering in the memory budget; avoid a
whole-file read or whole-backlog replay on host recovery. Drain incrementally.

Define a bounded disk budget, cleanup on acknowledged completion/cancel/disposal,
and conservative startup cleanup of stale files owned by this mechanism. No
credentials in the spool. Treat response/tool/reasoning content as sensitive;
apply private file access and do not include it in normal diagnostics. A write
failure or exceeded budget must terminate explicitly with buffer-storage failure,
not silently discard output, fall back to unlimited RAM, or start a new request.
Do not implement speculative disk-repair or out-of-space recovery machinery.

Audit `outputItems`, original request retention, continuation caches, recovery
checkpoints, parser buffers, and completed responses as well as the delivery queue.
Moving existing unbounded retention into a worker is not a memory fix. Release
references at their actual lifecycle boundaries without removing required replay.

## Timeouts, cancellation, auth, and failure

- Measure network receipt with a worker monotonic clock. Separate transport
  receipt, decoded events, delivery backlog, and host acknowledgment time.
- Host silence must not be interpreted as server inactivity. Remove duplicate
  host network-idle watchdogs for worker requests. Keep genuine network-idle
  detection even while buffered events await host delivery.
- Terminal receipt settles transport independently of delayed UI delivery. Drain
  preceding events before reporting terminal/error; later socket closure must not
  invalidate a completed response.
- Do not add application-level keepalive prompts. Verify supported WebSocket
  ping/pong behavior before using it; connection liveness is distinct from model
  progress. Preserve upstream wire semantics.
- Forward user cancellation when the host can process it; cancel the matching
  worker request and discard further delivery. A blocked host cannot immediately
  observe a user action, so do not promise instant cancellation during freezes.
- Keep refresh/ID tokens in the host. Pass only required access credentials and
  account context, never through command lines or diagnostics. On auth failures,
  use the existing refresh policy with a bounded host handshake. Invalidate
  sessions on sign-out/account changes and reject stale credential generations.
- Worker startup failure, crash, and protocol failure reject affected streams
  truthfully. Restart only for future requests; do not silently replay in-flight
  generations or switch to a paid provider. Failed usage may be unknown.
- Preserve existing recovery eligibility and attempt budgets. Worker exit and
  local buffer failures must not accidentally become retryable transport failures.
  A queued successful terminal must not trigger provider recovery while awaiting
  host delivery. Never run recovery simultaneously in host and worker.

## Implementation sequence

1. Characterize current stream/cancellation/error/continuation contracts and the
   uncommitted recovery integration. Verify installed Node worker, WebSocket,
   proxy, TLS, and certificate behavior; workers may not inherit VS Code network
   patches. Check current upstream Codex behavior using the tracking docs before
   changing wire semantics. Record actual versions and findings.
2. Extract a VS Code-independent transport service and add the worker adapter,
   explicit lifecycle ownership, error envelopes, and cancellation propagation.
   Implement bounded delivery and disk overflow before exposing the new path.
3. Route all response consumers through it: main agent, utility aliases,
   autocomplete, chat participant, and recovery SSE. Keep workload identity in
   diagnostics; sockets remain keyed by appropriate conversation/auth context.
4. Add a temporary experimental dashboard/configuration selector for in-host vs
   worker transport. Default to existing behavior until integration passes; do
   not silently fall back if the selected worker fails. Explain that the option
   protects stream reception during host stalls, not UI rendering performance.
5. Validate packaging and local Windows plus remote WSL extension hosts. Verify
   worker entry files ship in the VSIX and shutdown/sign-out dispose them. Decide
   default rollout after user testing and report remaining host limitations.

## Required verification

Use an independent local fake WebSocket/SSE server in a worker or child process.
A server on the blocked test thread is not a valid reproduction. Block the test
host synchronously beyond a shortened idle deadline while the server continues
sending. Assert worker receipt continues, buffers remain bounded, and the host
receives every event in order after recovery with one outbound generation only.
Any future real 120-second-scale probe must be a separately requested manual
experiment, never part of the test suite. Routine stall regressions use a fixed
250 ms idle deadline and 1,200 ms host stall; there is no environment override
that lengthens them to production-scale timing.

Also cover:

- Genuine server silence, terminal while host blocked, and close after terminal.
- Disk overflow/drain ordering, slow storage, budget exhaustion, and cleanup.
- Cancellation before start, during backlog, and after terminal receipt.
- Concurrent conversations/utility/autocomplete; cancel one without affecting others.
- Worker crash/start failure, stale IPC, invalid envelopes, and account changes.
- Existing continuation anchors, fallback/auth boundaries, recovery eligibility,
  phase/reasoning/tool ordering, and terminal usage behavior across IPC.
- Large requests/events and slow host consumers: bound host IPC allocation too.
- Installed VSIX smoke test and proxy/certificate parity in Windows and WSL.

Run `npm run check`, `npm run lint`, and `npm test` after code changes and
`npm run validate` for this architectural change. Ensure live credential tests
remain opt-in; inspect the test runner before allowing `.env` to activate them.
No live paid request is needed for the blocked-host reproduction.

## Evidence and acceptance

Record worker receipt gaps, worker event-loop delay, host delivery lag, queue and
spool high-water bytes, drain time, CPU, host/worker heap, and attempted-generation
counts using metadata-only diagnostics. Do not claim worker RSS as independent
process memory; report shared process RSS separately from per-worker heap.

Acceptance: an extension-host stall longer than the configured network idle
timeout does not kill an actively receiving stream, multiply generations, lose
events, change replay semantics, or cause unbounded buffering. Genuine upstream
silence and local failures remain explicit. Provide the authoring diff and test
results for review without staging or committing.
