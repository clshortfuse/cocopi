# Preparation offloading feasibility

## Scope and current decision

Keep production transport unchanged. The offline prototype shows a potential
host-responsiveness benefit, not lower total request latency or demonstrated
memory savings. Do not enable a new worker path from these measurements alone.

`scripts/benchmark-preparation-offload.js [message-pairs=512] [iterations=10]`
compares the same grouped canonical body/input/tools hashes and JSON/UTF-8 upload
preparation on the host and in one dedicated worker. Fixtures contain synthetic
Responses-shaped reasoning/message pairs with opaque base64 placeholders; no
model, cryptography, auth store, `.env`, or network is used.

One pair of runs on Windows, 2026-11-06:

| Assistant message pairs | Upload bytes | Host preparation | Synchronous worker post | Offload round trip | Worker preparation |
| --- | --- | --- | --- | --- | --- |
| 8 | 143,808 | 1.12 ms | 0.11 ms | 1.47 ms | 1.14 ms |
| 512 | 9,428,530 | 53.42 ms | 7.12 ms | 66.74 ms | 56.69 ms |

One warmup is excluded; host/offload execution order alternates across ten
measured pairs. Host post time includes synchronous structured-clone serialization.
Round trip also includes worker-side deserialization, preparation, scheduling,
and a transferred reply buffer. Exact upload bytes and all three hashes are
compared outside timed intervals. Sender-side buffer detachment is asserted.
Worker startup and fixture construction are excluded; only one operation is
in flight. The worker is terminated by the benchmark that created it.

For the large fixture, offloading reduced the measured synchronous host section
from about 53 ms to 7 ms but increased total helper latency by about 13 ms.
These are synthetic sequential measurements subject to GC/system load. They do
not measure live UI responsiveness, peak/retained memory, event-loop tail latency,
provider conversion, or actual host-to-transport-worker ownership transfers.
The worker receives a cloned full request, temporarily duplicating history;
the prototype transfers its encoded upload back to the host rather than directly
to the transport worker. Neither choice is approved as a production design.

## Required integration design

### Concurrent profiling checkpoint (2026-11-10)

The pressure mode is now available by supplying an explicit fourth argument:
`scripts/benchmark-preparation-offload.js [message-pairs] [iterations] [concurrency]`.
It supports 1–8 concurrent cloned requests, capped at 16 MiB per synthetic upload
and 32 MiB total per batch. It uses one worker with correlated replies, alternates
host/offload batch order, excludes a paired warmup, and checks exact hashes and
upload bytes. No credentials, API calls, or running editor changes are involved.
The existing compiler target is preserved: deferred completion uses a typed
`Promise` executor, not `Promise.withResolvers`.

Eight workloads, five measured iterations each, on the existing Windows session:

| Pairs | Concurrent | Reserved upload MiB | Host batch ms | Host scheduling probe ms | Offload post ms | Offload scheduling probe ms | Offload batch ms | Process max RSS MiB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 8 | 1 | 0.14 | 1.53 | 1.58 | 0.15 | 0.19 | 1.95 | 62.4 |
| 8 | 4 | 0.55 | 5.49 | 5.54 | 0.35 | 0.40 | 5.94 | 67.7 |
| 8 | 8 | 1.10 | 10.99 | 11.09 | 0.47 | 0.52 | 11.68 | 77.4 |
| 128 | 1 | 2.23 | 18.49 | 18.54 | 2.11 | 2.22 | 22.06 | 128.0 |
| 128 | 4 | 8.91 | 94.33 | 97.11 | 10.05 | 10.15 | 114.93 | 204.0 |
| 128 | 8 | 17.82 | 170.70 | 170.89 | 18.83 | 18.93 | 176.45 | 227.5 |
| 512 | 1 | 8.99 | 70.51 | 70.69 | 8.82 | 8.92 | 90.79 | 313.1 |
| 512 | 3 | 26.98 | 252.67 | 254.48 | 37.09 | 37.21 | 321.88 | 381.8 |

The scheduling probe is one `setImmediate` per batch, not live UI latency or a
tail-latency distribution. One worker handles preparation serially; these are
concurrent submissions, not parallel preparation across several workers. All
eight runs preserve exact reply identity and bytes.

Offloading reduces synchronous host blocking but does not reduce total helper
latency in these measurements. Cloning still blocks the host for approximately
37 ms in the largest batch. Process maximum RSS combines fixtures, parity
buffers, host and worker, both measurement paths, warmup, and GC/system effects;
it is not a path-specific comparison, retained-memory measurement, evidence of
a leak, or an explanation of the earlier whitespace incident. Baselines and
sampled per-thread memory are included in the report for subsequent runs.

**Decision:** do not enable production offloading. Next investigate ownership
and admission before cloning, and measure retention/cancellation/backpressure
in a separate transport workload. The host/network worker separation remains a
requirement; do not move preparation onto the heartbeat worker.

Validation: the worktree passes typecheck, lint, and all 843 offline tests. An
independent archived staged tree, with its own cached dependency installation,
passes typecheck, lint, and all 722 offline tests. The counts differ because
unrelated worktree changes remain unstaged. Smoke coverage includes legacy
sequential reporting, concurrency 1/3/8, invalid concurrency, exact upload/hash
parity, private-payload exclusion, and the aggregate synthetic upload bound.
The previously identified profiler type/lint blockers are resolved. No compiler
target, runtime transport default, dependency version, or running process was
changed; only benchmark-created workers were terminated by their own runner.

1. Define immutable request ownership at admission. Do not allow caller mutation
   between measured-byte reservation, digest calculation, and wire serialization.
2. Bound concurrency and queued bytes before cloning. Existing 8-request,
   16 MiB individual and 32 MiB total upload protections must not be bypassed
   while a request is waiting for its exact serialized size. Never replace exact
   UTF-8 accounting with a character-count estimate.
3. Keep preparation CPU off the network/heartbeat worker so hashing cannot starve
   the liveness processing that worker was introduced to protect. Decide whether
   a separate worker is worth startup, memory, and scheduling costs.
4. Preserve request-local digest formats, prepared/wire summary identity rules,
   callback ordering, and token-tracker metadata. If prepared continuation input
   differs, diagnostics must describe the actual wire body, not the original.
5. Cancel queued preparation promptly without touching another request; discard
   late replies by invocation/generation identity and release reservations on
   every failure. Worker crashes must not replay a potentially paid generation.
6. Specify final encoded-buffer transfer ownership, error envelopes, shutdown,
   protocol versioning, packaging, and opt-in rollout. Avoid shipping another
   full JSON clone/parse hop just to move timing between threads.

## Adoption gates still open

### Staged checkpoint dependency validation

The benchmark initially depended on `canonicalCodexJsonDigest`, which existed
only in the working tree. The previously implemented incremental/grouped hasher,
lazy request-local diagnostics, optional diagnostic-summary reuse, and their
regressions are now staged with the profiling utilities. No new hashing
algorithm or runtime offload path was introduced by this reconciliation.

An index-only tree was exported outside the repository and installed with its
own `npm ci --ignore-scripts` dependency directory, without linking workspace
`node_modules`, copying unstaged source, or loading local credentials. Typecheck,
lint, and all 700 offline tests passed in that isolated staged snapshot. This
test count differs from the 821-test working-tree run because unrelated and
earlier performance/SDK work remains unstaged. The snapshot is retained under
the system temporary directory; no running extension was changed.

Dependency installation reported seven audit alerts (five moderate, two high)
from the snapshot's existing lockfile. No dependency versions were changed or
automatic audit fixes applied as part of performance validation.

This closes the isolated-snapshot check for the current hashing/profiling
checkpoint only, not for a future runtime offloading implementation. The
following adoption gates remain open:

- Paired CPU/event-loop-delay and peak-memory profiles at small/large histories,
  including concurrent requests and cancellation/backpressure.
- Deterministic mutation, cancellation, startup failure, crash, stale reply,
  admission-boundary, and exact Unicode upload-byte tests.
- End-to-end provider/worker parity for full and incremental continuations,
  prepared diagnostics, tools, encrypted thinking, and account changes.
- Offline validation of an isolated staged snapshot, extracted-package worker
  loading, and explicit review before changing a runtime default.

The feasibility script and its smoke test are profiling utilities only. Delta
history IPC and token-tracker journal persistence remain disabled by default.