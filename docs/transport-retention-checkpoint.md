# Transport retention and backpressure checkpoint

## Plan and scope

1. Run fixed history, growing history, and session churn using full uploads.
2. Exercise delayed consumption until disk spooling, then verify exact output.
3. Cancel unconsumed output; verify host admission is released with no replay.
4. Validate the measurement harness independently of experimental runtime edits.

The offline harness is `scripts/benchmark-worker-transport.js`. Full upload is
the default, matching production. Delta history IPC remains an explicit
experimental selection and is rejected if its instrumentation is unavailable.
Missing optional instrumentation is reported as null, not fabricated zero.
All traffic uses a task-owned localhost fixture; no model, credential store,
user application, or existing worker is used or managed.

Each workload runs in a separate process. Request text is synthetic. Sample
rows include per-thread memory where available, total process RSS, timing,
buffer/spool high-water marks, and host reservation counts. Worker metrics are
not forced-GC. Growing input stays intentionally reachable. After-GC host heap
deltas and process RSS are not proof of a leak or isolated production retention.

## Backpressure and cancellation

Pressure modes produce 30 numbered 80,000-character deltas per request. A
fixture-only notification signals that generation has finished while the host
deliberately leaves the response unread. No arbitrary sleep or busy wait is
used. The backpressure mode then checks every delta's exact value and order,
terminal completion, positive disk-spool high-water usage, and zero settled
host invocation/upload reservations.

Cancellation mode cancels the unconsumed stream after the fixture notification.
It checks zero host reservations and exactly one generation per turn plus
warmup. Terminal worker metrics are unavailable after this local cancellation
and are not replaced with stale warmup values. This does not prove that worker
storage has already been reclaimed when host cancellation returns.

The fixture notification is opt-in. Fixture-owned timers are tracked per socket
and removed on completion/close, avoiding a growing close-listener list during
keep-open measurement. Existing unrelated input-capture fixture work remains
outside this staged checkpoint.

## Results and validation

Full-upload worktree measurements, 2026-11-10:

| Workload | Turns | Median turn ms | p95 turn ms | Host heap delta after GC MiB | Process max RSS MiB |
| --- | --- | --- | --- | --- | --- |
| Fixed input | 48 | 7.09 | 14.23 | 0.70 | 110.3 |
| Growing input | 48 | 54.13 | 95.12 | 23.29 | 219.5 |
| Session churn | 48 | 7.71 | 16.99 | 0.70 | 108.7 |
| Backpressure | 24 | 50.09 | 57.76 | 0.74 | 181.2 |
| Cancel unread output | 24 | 43.67 | 48.26 | 0.65 | 142.5 |

Fixed/growing/session runs preceded the pressure-fixture correction below;
their explicit completed-event path already honored keepOpen. Pressure rows
are the corrected reruns. Turn times include request preparation and fixture
generation; the cancellation row is **not cancellation-only latency**.

Growing history ends with 48 input items and about 6.6 MB of intentionally live
text. Last-turn host preparation is 27.31 ms and end-to-end latency 94.67 ms.
Session churn reaches the worktree's 32-session cap; fixed/growing stay at one.
Those cap/metrics changes are unstaged runtime experiments, not evidence of
bounded sessions in the committed runtime. All measured turns release host
invocation/upload reservations and use one generation each plus warmup.

The corrected backpressure run checks 720 exact deltas over 24 turns. The final
turn has 1,042,034 bytes memory high-water and 1,363,376 bytes encrypted spool
high-water. All pressure turns assert positive spooling, sequence/content
parity, and completed delivery. No replay occurs. Cancellation terminal worker
metrics remain deliberately unavailable; no immediate worker-disk reclamation
claim is made.

### Fixture defect found and reproduced

An initial repeated-cancellation run encountered a WebSocket opening error.
Inspection found the fixture's normal 30-delta completion path closed the
socket even when `keepOpen: true`; the explicit-event path honored the option.
Added a deterministic test that evaluates the actual generator with controlled
interval callbacks. It failed with `closed=1` instead of zero before the fix.
After making normal completion honor keepOpen, the unchanged test passes,
as do the 24-turn pressure/cancellation reruns. This proves a fixture contract
defect and removes that confounder; it does not prove every possible opening
error is fixture-caused or explain the old remote whitespace failure.

Production runtime changes, including session-LRU and experimental
metrics/history changes already present in the worktree, are not promoted by
staging this harness. Full worktree and isolated staged validation follow.

Validation completed: typecheck, lint, and all 846 offline tests pass in the
worktree. An archived staged snapshot with independent dependencies passes
typecheck, lint, and all 728 offline tests. The fixture regression was shown
failing before the correction and passing unchanged afterward. Input-capture
fixture changes and experimental runtime work remain unstaged.

**Next priority:** isolate growing-history preparation/allocation cost and
request/anchor ownership before adding a preparation worker. The current
measurements justify that investigation, not a claim of a production leak or
promotion of delta IPC. Controlled release-of-history measurements and worker
post-cancellation reclamation remain open; cancellation-return timing alone is
insufficient evidence. No production defaults or runtime implementations were
changed in this checkpoint.

## Controlled history release (2026-11-10)

Added an explicit `release` workload. It grows the same full-upload history,
measures host heap after GC while the input remains reachable, clears the
fixture-owned array, crosses one `setImmediate` turn, and measures host heap
after GC again. The transport and server workers remain alive throughout.
The mode requires `--expose-gc`; memory values are observations, not brittle
pass/fail thresholds. The ordinary summary is labeled as the pre-release GC
checkpoint so it cannot be confused with the separate release row.

Two independent worktree runs, each 48 turns, retain 6,624,135 UTF-8 text bytes:

| Observation | Run 1 | Run 2 |
| --- | --- | --- |
| Host baseline heap bytes | 5,946,048 | 5,946,120 |
| Host heap with history after GC | 30,375,576 | 30,375,664 |
| Host heap after clearing history and GC | 6,417,224 | 6,417,296 |
| Reclaimed host heap bytes | 23,958,352 | 23,958,368 |
| Residual host heap above baseline | 471,176 | 471,176 |
| Last-turn host preparation ms | 28.00 | 36.15 |
| Last-turn end-to-end ms | 102.41 | 157.71 |

Both runs settle with zero host invocations and upload reservations and exactly
49 generations including warmup. The larger after-GC heap from the earlier
growing workload is therefore mostly reclaimable fixture/history-associated
data in this experiment, not demonstrated permanently retained host memory.
The difference between UTF-8 text size and host heap reclamation is not a
precise count of copies: representation, other reachable allocations, and GC
accounting differ.

RSS and transferred ArrayBuffer accounting fluctuate independently and need
not drop immediately. These runs do not force worker GC, prove cancellation
storage reclamation, cover long-lived provider/chat state, or exclude a
production leak elsewhere. The near-identical heap results are observations,
not asserted constants. Total latency varies with existing system load.

**Decision:** no new runtime memory optimization is justified by this release
test alone. Focus subsequent profiling on the measured growing-request CPU
cost and worker-side lifetime, rather than adding speculative host cleanup or
enabling experimental delta IPC/offloading.

Release checkpoint validation passes typecheck, lint, and all 848 offline
worktree tests; the independent staged snapshot passes typecheck, lint, and
all 730 offline tests. Tests verify release-row shape, explicit GC opt-in,
zero host reservations, unchanged generation count, and exclusion of synthetic
payload text from reports, without asserting machine-dependent heap thresholds.

## Growing-history CPU profile (2026-11-10)

Opt-in profiling: supply `cpu` after the workload, turn count, and IPC mode.
The harness starts host inspector sampling and the task-owned transport
worker's `startCpuProfile` after warmup. It stops both before post-run GC and
prints only aggregate self-sample counts, with directory paths removed. No raw
profile or request payload is written. Ordinary modes do not require the newer
worker profiling API. CPU mode checks support explicitly; smoke coverage skips
only that mode if unavailable. Documentation reference:
<https://nodejs.org/api/worker_threads.html#workerstartcpuprofileoptions>.

48-turn full-upload growing-history profile on local Node 24.11.1:

| Isolate | Samples | Idle | Non-idle |
| --- | --- | --- | --- |
| Host | 2594 | 1731 | 863 |
| Transport worker | 2128 | 708 | 1420 |

Selected **self-sample** shares, percentages of each isolate's non-idle samples:

- Host: anonymous worker-transport preparation closure 37.54%; UTF-8 `encode`
	27.00%; `encodeUtf8String` 6.14%; GC 3.36%; benchmark top-level frame 5.33%.
- Worker: crypto hash `update` 25.00%; continuation digest update 21.97%; UTF-8
	decode 11.20%; worker `run` 9.08%; GC 7.82%; canonical JSON serialization
	7.46%; an additional unattributed `update` frame 7.46%.

These are not inclusive-stack costs or exact CPU-duration shares. Do not call
every sample in an anonymous preparation frame `JSON.stringify`, or attribute
every generic `update` frame to a particular hasher. Host profiling includes
fixture construction, verification/reporting, and one extra full-request size
serialization at sample checkpoints. Profiling perturbs latency: the profiled
last turn is 150.81 ms, not a replacement for unprofiled timing results.

### Profiler metadata portability regression

The local native worker profiling API returns a JSON string with unescaped
`C:\...` URL metadata. Plain `JSON.parse` fails. A synthetic regression with
that format was demonstrated failing before a narrow profile-decoder fallback
and passing unchanged afterward. First try normal parsing; only on a syntax
error escape native drive-path URL fields and parse again. Valid JSON remains
unchanged and unrelated malformed JSON still fails. This helper is never used
for model requests, responses, tool arguments, or stored transport records.

### Next candidate

Review whether the continuation-prefix digest builder can be reused when
constructing the completed-response baseline. The current worktree discards
prefix-hashing work after deciding continuation, then may hash the full input
again for the response anchor. This is a candidate, not a proven safe patch:
preserve exact digests, immutable ownership, lazy allocation, full/delta
continuation selection, output-item/completed-output semantics, and error/
cancellation cleanup. Demonstrate a focused redundancy regression and measure
the unchanged workload before promoting any runtime change. No runtime
optimization or new preparation-worker path is added in this CPU checkpoint.

CPU checkpoint validation passes typecheck, lint, and all 851 offline worktree
tests; the independent staged tree passes typecheck, lint, and all 733 offline
tests. The local CPU smoke test runs both profilers on supported runtimes;
synthetic summary tests cover self/idle accounting, directory removal, valid
JSON preservation, Windows metadata recovery, and malformed-input rejection.

## Request-local continuation digest reuse

### Implementation and ownership

The prefix scan now hands its hash builder to the active request. When output
requires an anchor, the builder hashes only the remaining input suffix before
combining output. It contains a hash state and item count, not input arrays,
serialized history, or credentials. It is never shared between requests or
cached by mutable input identity. No extra suffix hashing occurs for an
unfinished response merely because a prefix scan happened.

The staged baseline keeps its existing completed-output construction and uses
the builder directly at completion. The worktree's separate streamed-output
experiment uses the same prefix handoff before its existing digest forks.
Only the shared-prefix scan prerequisite and request-local reuse are staged;
unrelated wire serialization, streamed-output retention, session-LRU and worker
experiments remain unstaged.

### Failing regression and parity

The initial focused offline test counted canonical reads of a matched prefix
item. Before reuse it failed with two reads instead of one. The unchanged
test passed after the implementation, with the same incremental wire input and
completed anchor digest. Expanded coverage tests matched and mismatched
prefixes against empty, authoritative completed, and streamed-only output:
six cases. Mismatch permits one additional read for full wire serialization,
not an extra anchor hash. Both baseline and worktree implementations pass.

### Measurements and limits

The worktree 48-turn full-upload CPU profile changed worker non-idle samples
from 1420 to 944. Hash `update` and continuation-update self-sample shares
changed from 25.00% + 21.97% to 20.34% + 8.26%. Host preparation/encoding remain
dominant host costs. Sample counts are not exact duration; runtime/system load
and profiler overhead prevent treating these as a universal speedup percentage.

An independent staged runtime was measured with reuse enabled, then disabled
only at the prefix-handoff callback as a no-reuse control:

| 48-turn run | Median ms | p95 ms | Last turn ms |
| --- | --- | --- | --- |
| Reuse | 64.44 | 157.93 | 112.29 |
| Same snapshot, handoff disabled | 77.43 | 132.18 | 112.99 |

The median improves in this pair, but the tail does not; this is not a
statistically controlled latency guarantee. The deterministic result is one
canonical prefix scan reused for the anchor, with unchanged digests and wire
semantics. No preparation offloading, default IPC change, automatic replay,
or claim about the historical whitespace cause follows from this optimization.

Digest-reuse validation passes typecheck, lint, and all 857 offline worktree
tests. The independent minimal staged runtime passes typecheck, lint, and all
739 offline tests, including the six new read-count/digest-parity regressions.
No credentials, paid API calls, running extension reloads, or commits are used.

### Review correction: mutable preparation hooks

Staged review reproduced a regression: full-input fallback hashes a prefix,
then `onWebSocketRequestPrepared` can change an already-hashed item before it
is sent. The cached anchor then differs from the actual wire input. The same
problem occurs if `onWebSocketContinuationDecision` mutates through a closure.
The pre-optimization implementation produced the correct anchor in this case.

Added both mutation paths across empty, completed, and streamed output. All six
new cases failed with incorrect digest assertions before the fix. After the
hooks run, discard the cached builder if either hook is present. This restores
anchor construction from post-hook input without freezing caller data, cloning
full history, changing callback contracts, or introducing a new trust flag.
Callback-free requests still reuse their prefix; all 12 parity cases now pass,
and each also verifies a subsequent incremental continuation from the anchor.

**Performance qualification:** the standard worker path supplies these hooks,
as does the transport benchmark. Prefix-to-anchor reuse is therefore disabled
on that path after this correction. Earlier reuse CPU/timing results above
describe the pre-correction candidate and must not be advertised as the current
worker-path performance benefit. Shared-prefix hashing across candidate anchors
remains, but safe worker-path reuse needs a separate immutable-ownership design.

The worktree passes typecheck, lint, and all 863 offline tests after correction.
An independent staged snapshot passes typecheck, lint, and all 745 offline
tests. Rebuilt the user's usual `out/cocopi-1.0.0.vsix` using
`npm run package:vsix`; declaration/manifest checks and full-profile packaging
pass. The artifact includes the working tree, not merely the staged subset.
No install, reload, or commit was performed.