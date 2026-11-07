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