# Rewrite-safe host/worker history delta transfer

**Current status:** implemented and tested behind the internal constructor option
`historyDelta: true`. Default runtime uses full-request IPC (`false`). No user
setting or installed-extension change is introduced. Pre-execution recovery is
still pending; do not enable the retained-history path by default yet.

## Goal

Avoid serializing and uploading unchanged input history on every request. This
does not mean appending bytes to an existing JSON document or trusting message
identity. VS Code can edit existing messages, rewind, regenerate, compact, or
reuse mutable objects. Server continuation and local history delta transfer
are separate protocols.

## Required semantics

- Compare serialized input items by value on every preparation. Do not cache by
  mutable object identity. Only the longest unchanged prefix may be reused.
- Encode a request as an explicit base revision, retained prefix count, and
  replacement suffix. The resulting history is exactly prefix + suffix: drop
  every old item after the retained prefix, even when the suffix is empty.
- Append: keep the whole matching old history and append new items.
- Rewind: keep a shorter prefix, append nothing, discard the abandoned branch.
- Rewrite: keep items strictly before the first difference and replace the rest.
- Compaction/reordering: use the actual matching prefix, possibly zero.
- Non-array input, changed ownership, missing revision, worker restart, or cache
  eviction: full replacement. Never infer a server previous_response_id.
- Rebuild all non-input request fields from the current request; never patch old
  model, instructions, tools, auth, routing, or transport configuration forward.

## Transaction and retention rules

Preparation must not advance the sender revision. Commit only after successful
postMessage; failed upload admission/posting leaves the old base intact.
The receiver must resolve/check the base before any network request. A missing
base must request a full replacement before execution, not replay a generation.
Each invocation owns an immutable array snapshot; later rewinds must not mutate
the history of an active or queued invocation. Receiver application must happen
synchronously in port order before asynchronous request startup.

Retained payload history is a new memory cost, unlike compact continuation
anchors. Both sides need explicit byte/session bounds, release on shutdown/auth
invalidation, and acknowledgment-based ownership. Do not retain tokens or whole
options in the history cache. Upload-byte budgets alone do not cap reconstructed
or retained histories; account for these separately before enabling transport.

## Implementation checkpoints

1. Offline protocol primitive and tests for append, rewind, divergence, mutation,
   snapshots, failed posting, invalid base, and bounded retention.
2. Wire revision/ack/miss messages, separate retained/reconstructed admission,
   and safe full-replacement recovery before execution. Bump protocol version.
3. Integrate real-worker tests with edits, compaction, concurrent requests,
   cancellation, eviction, restart, auth invalidation, and network execution counts.
4. Measure uploaded bytes and retained memory versus full uploads. Enable only
   after correctness and bounded lifetime tests pass.

## Initial integrated protocol (version 4)

The implementation deliberately uses one non-evicting bounded history slot per
worker, not an independently evictable per-conversation cache. Both peers process
the same ordered revision stream. Interleaved conversations compare against the
most recently posted input; nonmatching histories replace the suffix from zero.
The slot retains serialized input only, never credentials or request options.
Host and worker each cap serialized history at 16 MiB. This is an additional
retention cost, not zero-copy history storage or a total heap cap.

Every request sends fresh non-input options plus a revisioned input patch inside
the transferred UTF-8 envelope. The host commits only after posting succeeds.
The worker applies each patch synchronously in port order and independently
acknowledges its revision before awaiting the transport. It parses only suffix
items and constructs a new input array; active requests retain their old arrays.
Non-array input clears the history slot and is sent normally. Shutdown or worker
failure clears host history; a new worker starts at revision zero.

There is no normal cache-miss path because the single slot is never independently
evicted. Revision mismatches reject locally before network execution; no paid
generation is replayed. Do not add eviction or per-session caches without the
explicit miss/full-replacement handshake described above. Unexpected receiver
desynchronization currently fails closed rather than automatically resyncing.

Upload envelopes still have 16 MiB individual/32 MiB aggregate admission bounds;
reconstructed serialized input is separately limited to 16 MiB. JSON object
overhead and parsed histories are not represented by these serialized-byte caps.
The host still serializes each input item to detect mutable/replaced history;
only unchanged-prefix upload, UTF-8 encoding, and receiver parsing are avoided.
Suffix strings are JSON-escaped in the envelope, so initial uploads can be larger
than the old full JSON path. No total CPU or RSS improvement is claimed yet.

Real-worker coverage compares server-received inputs for append, rewind, rewrite,
compaction and empty replacement; counts exactly one generation per request;
and verifies failed posting does not advance revisions before a successful retry.
Concurrent HTTP requests also verify that rewrites cannot replace an already
started invocation's input snapshot. An initial comparison incorrectly treated
JSON property order as meaningful; it was corrected to structural comparison.
The large-prefix append fixture uploads a history patch less than 1% the size
of its initial history patch; this is not a whole-envelope or CPU measurement.
Type checking, lint, and all 771 offline tests pass.

Remaining work: expose retained-history/upload metrics, measure mixed-history
CPU and peak allocation, test deliberate receiver desynchronization, and add a
pre-execution resync handshake before supporting evictable multi-session caches.

## Retention and upload accounting checkpoint

Worker metrics now expose actual request upload bytes, reused-prefix item count,
and current retained-history serialized bytes/items. The local transport profiler
also reports host retained serialized bytes and equivalent full-request bytes.
Worker retention metrics are current cache state at terminal delivery, not a
per-invocation heap measurement; concurrent requests can advance that cache.

In a 16-turn synthetic growing-history run, turn 16 uploaded 138,327 bytes versus
2,209,182 full-request bytes (about 94% fewer). Both peers retained 2,208,983
serialized history bytes, with 15 prefix items reused. Parsed worker history,
UTF-16 string representation, live invocation snapshots, and fixture objects add
memory beyond those byte counters. This trades retained state for smaller IPC;
it is not evidence of a heap reduction. Preparation still grows with full-history
host serialization and transport compatibility hashing. The comparison computes
full-request bytes outside measured request latency.

A deliberate receiver-base mismatch test verifies zero network generations,
no acknowledgment advance, and released invocation/upload reservations. Disposal
tests verify host history bytes/items return to zero. Automatic resynchronization
is still pending: fail-closed rejection is not recovery.

The benchmark exposed accumulated close listeners in the local server fixture.
The fixture now uses one close listener and a set of active request timers,
removing timers on completion; repeating the run no longer emits the warning.
No production listener behavior was changed by that fixture fix.

Type checking, lint, and all 772 offline tests pass. Next gates are the explicit
pre-execution resync handshake and mixed-history CPU/peak-allocation comparison.

## Full-versus-delta comparison

`node --expose-gc scripts/benchmark-worker-transport.js growing 24 full` and the
same command ending in `delta` use the same code, local fixture, transport, and
workload. Full mode sends ordinary request JSON and retains no IPC history;
delta mode enables revisioned prefix reuse. Four isolated processes ran in
full/delta/delta/full order, each with one warmup and 24 measured requests.
This compares IPC representations on the optimized working tree, not all prior
optimizations against the committed baseline.

| Metric | Full runs | Delta runs |
| --- | --- | --- |
| Average synchronous host preparation | 9.19 / 9.37 ms | 6.07 / 5.94 ms |
| Final synchronous host preparation | 16.88 / 15.66 ms | 8.94 / 10.95 ms |
| Final request latency | 57.93 / 54.60 ms | 41.31 / 43.22 ms |
| Settled host heap delta after GC | about 12.28 MB | about 18.35 MB |
| Host event-loop delay maximum | 24.64 / 29.59 ms | 18.71 / 20.25 ms |

Host preparation covers synchronous request serialization, encoding, posting,
and history commit, excluding readiness wait. It does not include provider
message conversion or diagnostic hashing. Settled host heap increases by about
6.06 MB with delta history in this fixture. Peak shared-process RSS fluctuates
with GC and includes both threads; these runs do not prove reduced peak memory.
Each process issued exactly 25 generations including warmup.

The result supports a CPU benefit for growing append-only history, not a free
memory optimization or a broad production recommendation. Keep delta opt-in
until explicit pre-execution resync and mixed/edit-heavy history comparisons are
complete. The existing upload limits remain in force on both representations.

## Fingerprint-only sender checkpoint

The host now retains per-item SHA-256 fingerprints and serialized byte counts,
not full serialized input. Each preparation still serializes current input and
hashes the candidate prefix to detect in-place mutations; no object-identity
cache is used. Patch suffixes remain payload strings while pending/active.
The receiver still retains serialized and parsed history. SHA-256 prefix matching
is probabilistic fingerprint equality, not byte-for-byte collision proof.

`history.bytes` and profiler `retainedHostHistoryBytes` now represent the logical
serialized history covered by the sender metadata, not retained payload bytes.
`retainedHostFingerprintCharacters` reports the actual fingerprint string length;
it excludes arrays, numeric byte counts, and runtime object overhead.

Repeating the full/delta/delta/full 24-turn comparison produced settled host heap
deltas about 12.283 MB for full versus 12.317 MB for fingerprint-only delta.
The prior extra ~6 MB of retained sender payload is no longer present; remaining
differences include metadata and runtime state, not isolated object-size proof.
Average synchronous host preparation was 8.68/9.64 ms for full and 10.17/8.18 ms
for delta. Final request latency was 52.58/55.33 ms versus 54.33/57.88 ms.
There is no consistent CPU/latency advantage in these runs after fingerprinting.
Do not carry forward the earlier sender-string CPU benefit to this implementation.

The experiment remains opt-in. Next architecture work must reduce repeated
full-history processing, not merely transfer size; automatic resync is still open.