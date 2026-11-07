# Request efficiency

## First checkpoint

Request diagnostic digests and shape previews are evaluated lazily and memoized
within each summary. Cheap metadata reads no longer trigger canonical copies,
serialization, hashing, or preview generation for unused fields. Digest formats
are unchanged. No global request-body cache is introduced.

Summaries are request-local: consume their fields before mutating the source
request. This is not an immutable snapshot API.

## Incremental diagnostic hashing

Diagnostic canonical SHA-256 now traverses JSON directly with a bounded 16 KiB
batch instead of constructing a canonical object copy and a complete serialized
container string. Individual strings still require JSON escaping allocations.
Tests compare digests with existing canonical serialization, including numeric
object keys, optional fields, sparse arrays, Unicode, and large nested input.

`scripts/benchmark-diagnostic-hashing.js` compares both implementations in fresh
processes against identical synthetic history for 20 iterations. It reports time,
settled heap delta, and peak process RSS; it does not profile the live extension.

## Session retention checkpoint

The in-host transport previously had no default cache limits and did not trim
on stream settlement. It now uses the worker's existing defaults (32 sessions,
16 MiB idle continuation state), trims on completion/error/cancellation, and
updates session recency on use. Oldest idle sessions are evicted first; active,
opening, and queued requests are protected even when they exceed the cache limit.
Queued requests cannot reopen a disposed session. These are cache bounds, not
changes to request-upload admission or model context limits.

Offline regressions reproduce the previous unbounded default and verify bounded
session/continuation retention, protected pending work, and settlement cleanup.
This establishes an in-host retention defect, not that it caused the user's
worker-backed slowdown. Live extension-host profiling remains necessary.

## Worker upload ownership checkpoint

Worker protocol v2 transfers a dedicated UTF-8 `Uint8Array` buffer instead of
structured-cloning the complete serialized request string. Sender-side storage
is detached synchronously. Serialization stays in a synchronous local scope;
the worker clears its encoded upload reference immediately after parsing.
Post failures release host admission accounting and fail locally without replay.

The ownership regression fails with the original string handoff and verifies
actual buffer detachment, successful Unicode request processing, and settled
host invocation/upload counters. Existing wire-event parity tests still apply.
This removes the IPC string clone, not JSON serialization/parsing, UTF-8
encoding/decoding, request objects, or callback-owned request-body references.
Encoding also introduces a transient byte buffer on the host: no end-to-end
peak-memory or latency improvement is claimed without a transport benchmark.
Upload admission ceilings and their lifetime accounting remain unchanged.

## One-shot socket lifetime correction

The first real-socket benchmark completed its workload but could not shut its
transport worker down. A regression reproduced the cause: the one-shot helper
used a TransformStream `flush` callback as its only session-disposal path. A
consumer stopping at the terminal event could cancel before flush, retaining an
open socket after the response settled. The transport worker does exactly this.

The helper now disposes its private session on terminal-event delivery, end of
stream, read failure, cancellation, and startup failure. Reusable sessions keep
their existing lifetime. Both the fake-socket cancellation regression and the
real worker shutdown regression cover this path.

## Offline transport profile

Run `node scripts/benchmark-worker-transport.js` from the repository root.
It starts three fresh processes, each with a local fixture-server thread and
the real transport worker: fixed-size requests, growing history, and distinct
sessions. Each workload has one warmup plus 48 measured generations. For a
focused run use `node --expose-gc scripts/benchmark-worker-transport.js growing 48`.
The optional turn count is bounded to 1..80 to stay below upload admission limits.

Only synthetic text and a local dummy token are used; no `.env`, VS Code, or
remote API is involved. JSONL output contains numeric measurements and workload
names, never prompt bodies or credentials. Every turn asserts zero settled host
invocations/upload reservations and at most 32 cached sessions. Worker terminal
metrics now also include external/ArrayBuffer bytes and session/anchor counts.

Example Windows run, 2026-11-06 (not a performance guarantee):

| Workload | First / last request | Median / p95 | Peak process RSS | Final sessions |
| --- | --- | --- | --- | --- |
| Fixed ~138 KB input text | 14.2 / 6.4 ms | 8.1 / 19.4 ms | 110.1 MiB | 1 |
| Growing to 48 input messages (~6.6 MB text) | 13.6 / 105.6 ms | 76.5 / 127.0 ms | 217.3 MiB | 1 |
| 48 distinct sessions | 10.6 / 8.4 ms | 8.5 / 18.3 ms | 107.3 MiB | 32 |

Fixed/session workloads settled at approximately 0.45 MiB of additional host
heap after host GC. Growing history intentionally remained live and added about
11.7 MiB; this is not evidence of a leak. RSS includes all threads, fixture-server
allocations, allocator retention, and runtime overhead. Worker heap readings are
terminal snapshots, not forced-GC retained-heap measurements. Preparation time is
time to receive the worker's prepared callback, not isolated serialization CPU.
The local fixture returns only two small events and reuses a synthetic response
ID, so it does not characterize large outputs or multiple anchors per session.

These runs establish socket cleanup and bounded host accounting. They show
growing-history cost, but neither reproduce progressive fixed-size degradation
nor measure full provider conversion, diagnostic overhead, rendering, or live
VS Code behavior. No before/after end-to-end transfer comparison is claimed.

## Shared continuation-prefix work

Anchor selection previously rebuilt the prefix digest independently for every
candidate. With multiple overlapping mismatches this repeatedly canonicalized
and hashed the same history. Selection now uses one request-local forward hash
builder and saves digest snapshots only at candidate prefix lengths. It stops
when an anchor matches and can extend the scan for a later, longer candidate.
It retains no item digests or input objects across requests.

The operation-count regression failed with nine input-item serializations before
the change and passes with four, selecting the identical older matching anchor.
A second test covers newest short matches, non-monotonic prefix lengths, and
mutations between requests (no stale identity cache).

`node scripts/benchmark-continuation-prefixes.js` compares the previous repeated
algorithm against selection using shared prefix snapshots. One synthetic run of
20 selections, 256 input items, and 16 overlapping candidate anchors measured
607.5 ms repeated versus 58.0 ms shared (about 90% less time). This workload
deliberately exercises mismatching newer anchors; it is not a typical-chat or
end-to-end speedup claim. The newest matching-anchor path still hashes its
necessary prefix once, and full-history conversion/upload remains outstanding.

## Provider diagnostic summary reuse

Language-model requests, chat requests/tool follow-ups, and inline completions
now pass their existing request-local summary to diagnostic logging. Token
tracking and logging previously created separate summaries and repeated input,
tool, and body hashes for the same unmodified payload. Prepared and wire bodies
still use distinct summaries; no global or cross-request cache is introduced.

The regression fails before reuse (three instruction reads) and passes with two
(one body hash plus the logger's existing presence check). Log output and digest
formats are unchanged. `node scripts/benchmark-diagnostic-summary-reuse.js`
compares provider-style token-diagnostic consumption plus metadata logging,
asserting identical log output: one synthetic run of 20 iterations/256 items
measured 247.2 ms duplicate versus 182.1 ms shared (about 26% less time).
This is a diagnostic workload comparison, not an end-to-end chat latency claim.
With debug logging off, logging was already gated and this change does not
eliminate the digests still consumed by token tracking.

## Continuation-cache byte accounting

Trimming previously JSON-serialized every idle anchor on every pass, including
unchanged instructions and metadata. Internally generated request-state
snapshots are now recursively frozen after their existing detached JSON copy is
created; stored compact anchor envelopes are shallow-frozen. Their serialized
byte counts are measured once and held in a WeakMap keyed by the anchor.
Eviction does not leave a strong reference through the accounting cache.

Caller-owned mutable request state is neither frozen nor cached. Its byte count
is remeasured, so growth still triggers the same byte budget. Replacing/refreshing
an anchor creates a new envelope and cannot reuse the old byte count. Original
request/tool objects remain mutable: only detached internal snapshots are frozen.

The regression failed with three serializations for three trims before this
change and now passes with one. Additional tests cover mutable state, snapshot
ownership, and refreshed-anchor eviction. `node scripts/benchmark-continuation-cache.js`
compares 100 accounting passes over 32 sessions (~4.4 MB retained serialized state):
one run measured 446.4 ms repeated serialization versus 6.2 ms immutable accounting,
including the first measurement. This deliberately targets repeated trimming of
unchanged cached state, not end-to-end request latency; snapshot construction and
freezing are outside the timed loops.

## Identical continuation-state sharing

Consecutive completed responses can now reuse the newest retained anchor's
immutable request-state snapshot when its canonical SHA-256 signature matches.
The weak ownership map stores only a digest, not a second serialized snapshot.
Changed material state creates a new detached/frozen copy; caller-owned mutable
objects are never adopted. Existing anchor-count and byte-admission semantics
remain conservative and unchanged, even when several anchors share one object.

This preserves existing material-state semantics: input, tools, and volatile
turn metadata are excluded by the existing normalization. Tool changes must not
invalidate this snapshot's identity. Updated tests explicitly cover this and
replace a prior ineffective tool-freezing assertion with a retained-metadata
ownership assertion. The original request/metadata remain mutable.

`node scripts/benchmark-continuation-state.js` compares 100 snapshot constructions
with 32 retained references, with and without previous-snapshot reuse. It reports
unique object counts and their serialized JSON sizes, not V8 heap measurements.
One synthetic run retained 32 separate snapshots (4,418,560 serialized bytes)
versus one shared snapshot (138,080 bytes); 100 constructions took 43.4 ms versus
37.1 ms. This demonstrates reduced duplicate retained state, not a 32-fold
extension-host RAM reduction. The session-level regression also verifies shared
identity across changing input and volatile turn metadata with unchanged wire
continuation behavior. Canonical serialization/signature work still occurs.

## Backlog delivery cursor

Worker delivery previously called `Array.shift()` on its descriptor queue for
every delivered record. Large backlogs repeatedly moved the remaining entries.
The queue now advances a head cursor, clears each consumed slot immediately,
resets on full drain, and compacts only after at least 1024 consumed entries and
at least half the array is consumed. Descriptor movement is amortized rather
than per-event. Record admission counts only pending entries (`length - head`).
Memory accounting, FIFO order, encrypted overflow IO, disk-lifetime budgets,
acknowledgment credit, and explicit storage-error handling are unchanged.

The operation-count regression failed with 3001 array shifts and now passes with
zero. Tests also verify reference clearing, refill/compaction ordering, and
pending-record admission. `node scripts/benchmark-worker-delivery-queue.js`
compares a 100,000-event in-memory backlog: one run measured 11,660.8 ms for array
shifting versus 3.3 ms cursor draining. The fixture increases the memory budget
only for the benchmark to isolate queue operations; production defaults do not
change. This is a deliberately large backlog stress test, not ordinary streaming
latency or encrypted-disk IO throughput. Both loops verify each delivered value.

## Encrypted overflow byte views

Encrypted records now allocate one exact-sized envelope, fill the nonce in its
first 12 bytes, and populate ciphertext/tag at explicit offsets. Nonce and tag
access uses `.subarray()` views. Decryption uses the crypto API's UTF-8 output
instead of concatenating plaintext buffers. No plaintext is returned before
`decipher.final()` verifies authentication. Crypto APIs still allocate update
results: this is fewer copies, not zero-copy encryption.

The persisted format remains nonce(12), tag(16), ciphertext; short-read/write
loops, nonce randomness, encryption, budgets, and cleanup remain unchanged.
Three roundtrips (empty delta, Unicode, large text) previously used nine
`Buffer.concat` calls and now use zero. Separate tests alter nonce, tag, and
ciphertext and verify explicit failure before any plaintext is returned.

`node scripts/benchmark-encrypted-record-buffers.js` checks every roundtrip and
compares 500 synthetic ~90 KB records without filesystem IO. One run measured
251.2 ms concatenation versus 194.5 ms envelope views (about 23% less time).
This isolates encryption/envelope/decode work, not disk throughput or whole-chat
latency. No scratch views escape the operation or retain a larger backing buffer.

## Incremental SSE fragment parsing

The SSE parser previously scanned the entire accumulated partial line on every
chunk and recounted accumulated line/event bytes. It now scans only new decoded
text and maintains line/event byte counters. Completed lines are assembled only
when needed; boundary accounting remembers the last UTF-16 unit separately so
checking a split surrogate does not access/flatten the accumulated string rope.
The byte decoder remains streaming, preserving UTF-8 sequences across chunks.

A 20,020-character fixture in ten-character chunks previously counted 20,050,022
characters for budget checks. The unchanged regression now requires fewer than
four times the input size. Existing event/partial-line limits remain enforced,
including exact accounting for surrogate pairs split across string chunks.

The regression also exposed premature event dispatch when CRLF was split across
chunks. A pending-CR flag now recognizes that LF as the same line ending. Tests
cover multiline JSON, every-byte UTF-8 fragmentation, unterminated final events,
limits, and surrogate splits.

`node scripts/benchmark-sse-fragments.js` checks a synthetic ~480 KB event with
64/1024/65536-byte chunk views. It reports current timings only, not a before/after
speedup. JSON still requires decoded text and final event parsing; this does not
claim zero-copy SSE or remove the event byte budget. WebSocket parsing is unchanged.

## Coalesced transport-health delivery

Routine socket timestamp snapshots now coalesce to the latest pending value at
a 100 ms reporting cadence. The channel still has one in-flight message and one
pending snapshot, with independent acknowledgment credit from output delivery.
Transport/heartbeat state transitions and actual idle-deadline clearing bypass
the cadence when credit is available. Disposal clears the timer and pending
references. Intermediate routine snapshots are intentionally replaceable.

Socket-side timestamps, ping/pong enforcement, response idle timers, output
events, and backpressure behavior are not throttled. Only reporting crosses IPC
less frequently. Resetting an active idle timer no longer reports an intermediate
undefined deadline immediately before its replacement; settlement still clears
the deadline. Coalesced routine UI timestamps may lag by approximately 100 ms
plus host scheduling/acknowledgment delay, not a new liveness timeout.

The real-worker regression initially received 308 health snapshots for 202
output events. With coalescing one run delivered all 202 events with four health
snapshots. Deterministic tests cover latest-value cadence, acknowledgment credit,
state transitions, deadline clearing, and disposal. The existing regression
continues to verify health advances while output consumption is backpressured.
This is an IPC message-count improvement, not a server-generation speedup.

## Streamed-output digest retention

WebSocket sessions no longer structured-clone and retain completed output items
solely to compute a continuation baseline at the terminal event. The first
completed item initializes an input digest and an independent streamed-output
branch. Later items update that branch immediately, before consumer delivery.
Nonempty terminal `response.output` remains authoritative, using a separate fork
of the input digest; an absent/empty terminal array uses the streamed branch.
The input prefix is hashed once for both branches. Completion/failure clears
both digest references. Existing completed-output byte admission is unchanged.

The regression failed on the old structured clone and now verifies zero clones,
digest parity, and independence from consumer mutation. Additional tests cover
fork isolation and authoritative terminal output overriding streamed items.

`node scripts/benchmark-streamed-continuation.js` runs both retention strategies
in fresh processes with host GC and verifies identical digests. One synthetic
256-item workload measured 2,421,840 bytes of additional heap with retained
clones versus 145,048 bytes with streamed digests. Timings were 13.8 versus
14.6 ms: this checkpoint targets retained payload memory, not a demonstrated CPU
speedup. These figures are not total worker/VS Code RAM savings. Digest work
now occurs as completed items arrive; parsing, downstream delivery queues,
original request bodies, and terminal response objects can still retain memory.

## Native WebSocket wire serialization

The WebSocket send path now directly JSON-serializes the existing response.create
message rather than recursively creating a sorted object/array tree first.
Canonical JSON remains unchanged for continuation signatures, persisted markers,
and diagnostics. Wire property insertion order replaces lexical sorting; parsed
JSON content, optional-field omission, and request construction remain the
contract. Retry tests now compare normalized JSON rather than raw key order.

Reference checked 2026-11-06: upstream
`codex-rs/codex-api/src/endpoint/responses_websocket.rs` uses
`serde_json::to_string(request)` in `serialize_websocket_request`, with a direct
serialization payload-parity test. No server call was made for this checkpoint.

The operation-count regression failed on a nested canonical-copy traversal and
passes with no such traversal. `node scripts/benchmark-websocket-serialization.js`
uses fresh processes and warmed synthetic inputs, asserting parsed payload
parity. A ~3 MB request over 20 iterations measured 196.8 ms canonical versus
201.2 ms native, with peak process RSS 124,520 versus 120,844 KiB. These noisy
whole-process samples do not establish a speedup or an isolated allocation
delta. The implemented benefit is removal of the recursive temporary tree;
JSON string allocation, UTF-8 transmission, and full-history conversion remain.

## Saturated edit-progress previews

The language-model provider retains at most 64 Ki UTF-16 code units of streamed
edit arguments for UI target/progress previews. It previously concatenated every
later delta, sliced back to that cap, and normalized/reparsed the unchanged
prefix. Appending now slices only the remaining capacity and returns the existing
string immediately when full. Target parsing runs only when the preview grows.
Character-threshold/timed reporting and final tool-call processing are unchanged.

The integration regression failed with 21 normalizations of the same saturated
preview and now passes with one. It verifies a completed patch with 90,000 content
characters still reaches the tool call intact. This is a preview-only bounded
work optimization, not tool argument truncation or a whole-request latency claim.
Before the cap is reached, patch-target parsing still examines the growing
preview to detect additional files.

## Grouped request diagnostic digests

Input, tools, and full-body diagnostic digests now share a single canonical
traversal. Independent SHA-256 states receive the same canonical chunks while
visiting selected root fields; field boundaries flush the bounded text batch so
commas, property names, and enclosing punctuation cannot contaminate a field
digest. Nested fields with the same names do not start a new root-field digest.

Request summaries compute this digest group on first digest access, then reuse
it. Basic metadata and unused shape previews remain cheap/lazy. This intentionally
trades away per-digest laziness: consuming only one digest computes the group,
while production token tracking consumes all three. No cross-request cache or
canonical payload tree is introduced. Existing missing-input/tools semantics,
canonical digest values, and log formats are preserved.

The regression failed with two tool-output getter reads before grouping and
passes with one. Direct parity tests cover root/field hashes, nested field names,
undefined/missing fields, and Unicode across batching boundaries.
`node scripts/benchmark-grouped-digests.js` checks all digests on each iteration:
one synthetic 512-item/20-iteration run measured 807.7 ms separate versus 613.9 ms
grouped (about 24% less time). This is diagnostic hashing work, not whole-chat
latency. Independent hash states still each process their required bytes.

## Ordinary WebSocket frame conversion

Text, ArrayBuffer, and typed-array/DataView frames now convert synchronously;
only Blob-like `arrayBuffer()` data requires an asynchronous conversion Promise.
Ordinary frames parse JSON in their delivery callback, then reuse one resolved
Promise for the existing stream scheduling boundary instead of allocating a
conversion Promise per frame. Byte-view conversion still respects byte offset
and byte length; tests include nonzero-offset views surrounded by invalid bytes.

An initial fully synchronous delivery variant dropped queued metadata when an
error immediately followed it. That variant was rejected: the shared scheduling
boundary preserves the existing metadata/error fallback tests. No promise-free
delivery or measured latency improvement is claimed. The frame handler remains
async, and Blob conversion remains asynchronous. New tests cover common parsing,
Unicode ArrayBuffer/subarray/DataView frames, and Blob compatibility.

## Observer-specific health subscriptions

Worker starts now explicitly say whether the host supplied an onTransportStatus
observer (internal protocol v3). Unobserved requests omit the worker forwarding
callback, avoiding snapshot copies, status messages, and host acknowledgments
that cannot be consumed. Requests with observers keep the bounded coalesced
channel. Local heartbeat probing/enforcement, transport timestamps, idle timers,
and output behavior remain active independently of this reporting subscription.

The real-worker regression failed with two unused status messages for a short
completed request before the change and passes with zero. Existing observed
backpressure/cadence regressions pass, and a request without an observer still
rejects genuine server silence. This is a message/allocation reduction for
unobserved calls, not a latency claim for observed chat requests.

## Provider preparation stage profile

`node scripts/benchmark-provider-preparation.js` runs 8/32/128/512 synthetic
messages in fresh processes with one warmup and ten measured iterations each.
It invokes production message conversion, body construction, grouped diagnostic
digests, and JSON/UTF-8 upload preparation. A focused size is accepted as the
first argument (1..512). No auth, `.env`, remote API, extension reload, or network
call is involved. Output contains numeric stage/memory results, not message text.

Example Windows run, 2026-11-06; average milliseconds per iteration:

| Messages | Upload bytes | Conversion | Construction | Digests | JSON + UTF-8 |
| --- | --- | --- | --- | --- | --- |
| 8 | 56,059 | 0.059 | 0.011 | 0.574 | 0.315 |
| 32 | 229,043 | 0.116 | 0.017 | 2.242 | 1.340 |
| 128 | 930,195 | 0.246 | 0.019 | 7.367 | 4.683 |
| 512 | 3,804,435 | 0.549 | 0.033 | 31.992 | 19.339 |

This identifies grouped digest computation and upload serialization/encoding as
the dominant measured large-history helper costs; plain-text conversion is
comparatively small. It does not attribute a live slowdown or leak. Excluded
work includes routing, catalog/auth, schema adaptation, marker/encrypted replay,
images/tools, transport, callback diagnostics, rendering, and host scheduling.
The upload stage does not perform a transfer. Memory samples include intentionally
live fixture/final-iteration objects and runtime allocation/GC effects; external
memory deltas are not proof of retained upload-buffer leaks. No runtime behavior
changes in this profiling checkpoint.

## Shared UTF-8 bytes for grouped hashes

Grouped canonical hashing now lazily allocates one request-local 64 KiB scratch
buffer. `TextEncoder.encodeInto` fills it, and a `Uint8Array.subarray` view feeds
both the root and selected-field SHA states synchronously. No byte views or
payload cache survive the invocation. Single-hash updates retain direct string
hashing. Canonical digests, including Unicode and encoding boundaries, remain
unchanged.

The operation-count regression failed before this change and passes afterward:
both hash states consume the same bounded byte view. Type checking, lint, and
all 763 offline tests pass; live API tests were excluded.

A paired same-process synthetic comparison loaded the staged prior implementation
and candidate, alternated execution order over six rounds, discarded warmup,
and checked expected digests outside timed loops. For ten iterations per sample,
ASCII hashing averaged 179.5 ms before versus 151.7 ms after (about 16% less),
and Unicode averaged 736.8 ms versus 526.6 ms (about 29% less). These measure
targeted grouped hashing, not end-to-end VS Code latency or a progressive leak.
Upload budgets and compression behavior are unchanged.

## Binary-image preparation profile

`node --expose-gc scripts/benchmark-provider-preparation.js 512 images` exercises
production image-part conversion using 512 deterministic 8 KiB byte arrays.
These are synthetic encoding payloads, not validated PNG images: the profile
does not decode images, inspect dimensions, or invoke a model. Fixture creation
is outside measured stages, and each converted message must retain an image part.

Example Windows run on 2026-11-06, one warmup and ten measured iterations:
5,638,419 upload bytes; conversion 278.34 ms, body construction 0.04 ms,
grouped digests 39.78 ms, JSON + UTF-8 upload preparation 28.96 ms.
Unlike plain text and paired tool results, conversion dominates this fixture.
The existing `base64Encode` helper spreads byte views into character arguments,
accumulates binary strings, and calls `btoa`; direct native byte encoding is a
candidate for a separately tested optimization. No base64 behavior changed in
this profiling checkpoint. Results do not establish a live leak or typical-chat
latency; post-GC memory samples retain fixture/final-iteration state and runtime
allocation effects. Marker replay remains unprofiled.

## Native byte-oriented base64 encoding

The shared provider base64 helper now uses
`Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64")`.
The temporary Buffer views the exact input range without copying its bytes;
the encoded output remains an allocated string. No byte cache is retained.
This removes byte spreading, binary-character strings, chunk arrays and joins.
Both images and the existing UTF-8 marker encoder use this helper.

A focused regression first failed against the old `btoa` path, then passed
unchanged after replacement. It checks empty data, padding lengths, all byte
values, nonzero offsets, lengths surrounding 32 KiB and larger than 64 KiB,
and unchanged source storage. Existing marker tests also pass. Type checking,
lint, and all 766 offline tests pass; live API tests were excluded.

Repeating the same 512-image workload produced identical upload size
(5,638,419 bytes) and average conversion time 3.01 ms versus the preceding
278.34 ms run (about 99% less in this fixture). These are sequential runs,
not a controlled paired comparison: hashing and upload timings also varied,
so do not attribute their changes to this encoder or claim a whole-chat gain.
Marker replay and live VS Code remain separate investigation work.

## Compact marker-history preparation

`node --expose-gc scripts/benchmark-provider-preparation.js 512 markers`
constructs 512 assistant messages, each with visible synthetic text and a
current version-3 metadata-only marker. Fixture envelopes use a valid scoped
Cocopi session ID and computed SHA-256 values. Encoding fixtures is outside
measurement. Production conversion decodes the markers, restores the session
and latest host-request index, and retains only the newest continuation anchor.
Assertions verify these properties and that no marker envelope enters the body.
Output contains numeric results, not hidden marker state or payload text.

Example Windows run on 2026-11-06, one warmup and ten measured iterations:
3,805,971 upload bytes; conversion 3.99 ms, construction 0.03 ms,
grouped digests 21.17 ms, JSON + UTF-8 preparation 16.40 ms per iteration.
This includes visible-text conversion plus marker decoding/restoration, not
isolated decoder timing. It does not exercise legacy payload migration,
encrypted thinking replay, leading-marker/delta Agent Host requests, network,
or live VS Code. Hashing and upload preparation remain the larger measured
stages for this fixture. No production behavior changes in this checkpoint.
Type checking, lint, and all 767 offline tests pass.

## Remaining investigation

### Skip unused visible-replay hashing on Agent Host requests

When `includeEncryptedThinking` is enabled, the provider intentionally suppresses
Cocopi stateful markers for Agent Host compatibility. It nevertheless constructed
the visible replay-anchor builder, hashed the full request input, accumulated
assistant text, and updated tool-call digests for an anchor that was never emitted.
The builder is now absent on that exact marker-suppressed path; its text/tool
updates are skipped as well. Ordinary requests retain existing marker building.

The existing full-replay Agent Host integration test now observes continuation
item length-prefix updates. It failed with 10 unused updates before the fix and
passes unchanged with zero afterward across tool turns and provider recreation.
It still checks full wire input, stable conversation identity, tool output and
absence of markers. Worker transport continuation hashing is independent and
unchanged; this removes only the unused host visible-marker digest and text
accumulation. Type checking, lint and all 814 offline tests pass. No end-to-end
latency or heap reduction is claimed without runtime measurements.

### Continuation serialization compatibility and rejected candidate

The default continuation digest frames each comparable item's canonical JSON as
`UTF16Length:json;`. The length is JavaScript string length, not UTF-8 byte size.
A new regression independently reconstructs this framing with Unicode, escaped
control characters, a lone surrogate and a large text value, and verifies that
a fork cannot mutate the retained prefix digest. Byte-oriented changes must not
silently invalidate existing compact anchors by changing that length convention.

A direct canonical-string traversal candidate avoided the canonical object tree
but measured 122.68 ms versus 78.69 ms for the existing tree+native-stringify
path over 30 synthetic iterations. Exact string/digest and 48 focused protocol
tests passed, but the candidate was removed because the measurement did not
support it. The production canonical serializer remains unchanged from before
this experiment; only framing regression coverage is retained. No live-chat
speedup or reconstruction-cost reduction is claimed.

### Passive installed-extension collection setup

On 2026-11-06, six recent installed Cocopi output logs were checked using only
allowlisted numeric extraction. They provided no usable extension-host memory,
request-duration or first-event latency fields. No causal attribution can be
made from that absence, and old logs do not establish which uncommitted
optimizations the running build contains.

The user explicitly authorized enabling workspace `cocopi.debugLevel=metadata`.
The installed extension manifest confirms the setting exists and defaults to
off. The local workspace settings file previously had no Cocopi diagnostic
override; it now contains that metadata override. This file is Git-ignored and
remains local-only, including its pre-existing terminal approval settings.
Payload logging was not enabled. No extension restart, reload, installation,
remote test generation or UI control was performed.

Next collection must use ordinary subsequent activity and extract numeric
memory/timing samples without printing raw payloads, conversation descriptions,
credentials or session identifiers. Compare stages within a single host/session,
not unrelated log files or processes. A future normal request is needed before
the new setting can provide useful evidence. Restore the previous absence of
the override when collection is finished with user authorization.

### Token-tracker persistence scaling

`node scripts/benchmark-token-tracker.js <0..5000>` seeds synthetic metadata in
an isolated process, waits for initialization writes, then measures 20 settled
record/persist cycles against in-memory storage. This includes durable-field
encoding, string interning, JSON serialization and stored-byte counting, but
not VS Code SecretStorage I/O. It emits numeric results, never stored rows.

Example Windows run, 2026-11-06:

| Final rows | Average record | Average persistence | Snapshot bytes |
| --- | --- | --- | --- |
| 20 | 0.083 ms | 0.068 ms | 5,809 |
| 120 | 0.023 ms | 0.319 ms | 32,623 |
| 1,020 | 0.050 ms | 2.809 ms | 274,281 |
| 5,000 | 0.107 ms | 11.294 ms | 1,357,320 |

The tracker bounds raw rows at 5,000 and verbose rows at 100; older evictions
feed hourly aggregates. Its persistence drain coalesces overlapping writes,
but separate settled turns still encode/store the whole retained snapshot.
This is a concrete bounded history-dependent cost, not proof of a leak or live
slowdown. No persistence behavior changed in this profiling checkpoint.
Potential changes must preserve shutdown durability, migration, loading races,
deletions and hourly retention; do not add a debounce without those contracts.

A preclassified column-descriptor experiment was rejected: two candidate runs
at 5,000 rows measured 20.86/21.45 ms persistence versus 14.74/14.34 ms after
restoring the original implementation. Snapshot sizes remained identical at
1,357,320 bytes. These are sequential runs with system-load variability, but
they do not support keeping the candidate. The production encoder is restored;
31 focused tracker/profile tests passed during the experiment. Future work
should address snapshot rewrite amplification with durability/migration tests,
not assume object descriptors outperform existing Set lookups.

Persistence failure handling had a separate correctness issue: the drain cleared
its dirty flag before writing, so a rejected store left an unpersisted snapshot
that a later explicit flush could silently skip. A regression demonstrated the
missing retry before the fix. Failed writes now restore dirty state; the drain
does not restart itself on failure, avoiding a tight rejection/retry loop. A
later explicit flush or subsequent update can retry. Flush still reports write
errors rather than pretending durability, and successful write cadence is
unchanged. The unchanged regression passes afterward and verifies reload of the
recovered row. Type checking, lint, and all 777 offline tests pass. This is a
durability fix, not a reduction in full-snapshot serialization cost.

The serializer now reuses the last parsed timestamp for adjacent rows with the
same timestamp text. The cache is two snapshot-local scalar values, not a map
retained across requests or a second per-row index. Invalid timestamps still
encode as null, and stored snapshot format/write cadence remain unchanged.
A regression verifies 300 adjacent identical timestamps require one parse and
persist the original numeric value. Type checking, lint, and 778 offline tests
pass. One repeated 5,000-row synthetic run measured 11.86 ms persistence with
the same 1,357,320-byte snapshot. Burst-seeded fixtures have many identical
timestamps; real turns separated in time may get little or no benefit, so this
is not evidence of fixing progressive slowdown or rewrite amplification.

### Reuse prepared diagnostics for unchanged wire bodies

Token/cache tracking consumes request digests even with debug logging off, so
removing hashing solely on that setting would lose existing diagnostics.
Instead, the worker host now preserves the original body identity when its
prepared record reports unchanged input count and previous response ID. These
are the only request fields the prepared-record reconstruction adapts.
Incremental input or changed response ID still creates a distinct wire body.

The provider reuses its already-computed request-local diagnostics summary when
the wire body is the original body. This avoids a second canonical traversal and
digest group for unchanged requests and retries. Changed wire bodies still get
fresh summaries, and logged/tracked digests remain present. No cross-request
mutable-body cache, history retention, or delta IPC is required.

A real-worker regression verifies identity preservation on the first request
and distinct, correct suffix/response-ID adaptation on the next continuation.
No end-to-end timing gain is claimed from this checkpoint.
The chat participant now applies the same request-local reuse to initial
requests and tool follow-ups. This matters especially for explicit
`previous_response_id` requests whose wire body is already final. Changed wire
bodies continue to get independent summaries. Inline completions have no
separate wire-summary callback, so there is no matching duplicate to remove.

### Paired tool-history preparation checkpoint

`node --expose-gc scripts/benchmark-provider-preparation.js 512 tools` profiles
512 synthetic call/result pairs (1,024 host messages and input items). The
fixture uses production structural tool-part conversion and verifies that every
call and output survives pairing. It includes large text results, not tool
execution or model-visible tool schema adaptation. Text mode remains the default.
The profiler emits only numeric measurements and workload labels, never payloads.

Example Windows run on 2026-11-06, one warmup and ten measured iterations:
3,863,497 upload bytes; conversion 1.51 ms, construction 0.04 ms, grouped
digests 25.39 ms, JSON + UTF-8 upload preparation 20.73 ms per iteration.
This reinforces hashing/serialization as the dominant measured helper costs
for this fixture; it is not an end-to-end speed comparison or live leak evidence.
Post-GC external-memory deltas include runtime buffer accounting and must not
be interpreted as leaked bytes. Marker replay and image workloads remain open.

### Opaque encrypted-thinking preparation checkpoint

`node --expose-gc scripts/benchmark-provider-preparation.js 512 encrypted`
profiles 512 assistant messages, each with an empty-summary opaque thinking part
and visible text. Each synthetic opaque value is base64 of 8 KiB deterministic
bytes, created outside measured stages. This exercises production replay, not
cryptography or backend acceptance of the synthetic ciphertext. Assertions check
all 512 reasoning IDs, exact opaque values, empty summaries, and adjacent visible
output in their original order. Output contains numeric measurements only.

Example Windows run, 2026-11-06, one warmup and ten measured iterations:
1,024 input items, 9,444,005 upload bytes; average conversion 0.92 ms,
construction 0.03 ms, grouped digests 27.28 ms, JSON + UTF-8 upload preparation
28.52 ms. The upload stage does not transfer the buffer or contact a server.
Heap/external memory samples retain fixture/final-iteration state and runtime
allocation effects; they are not evidence of leaked ciphertext or upload bytes.

Hashing and upload serialization remain the dominant measured costs in this
fixture, not encrypted-part conversion. This checkpoint changes profiling only;
it neither enables experimental history IPC nor alters replay/diagnostic/wire
semantics. Legacy marker migration, Agent Host delta replay, and full live-host
profiling remain separate work. The next optimization should target the measured
hash/upload stages rather than add a ciphertext cache or guess at decoder costs.

### Rejected key-ordering and upload-encoder candidates

Two in-memory candidates were measured without changing production code. A
key-ordering alternative preserved JavaScript's numeric-key prefix and sorted
only non-index keys, avoiding repeated numeric classification in the existing
canonical comparator. Six alternating-order rounds of ten grouped hashes over
512 synthetic text messages measured 121.20–136.27 ms for the current code and
125.01–161.31 ms for the candidate. Digest parity was checked, but the candidate
did not justify replacing the current implementation.

For synthetic opaque-thinking upload JSON, four alternating-order rounds of 15
encodes compared current `TextEncoder.encode`, exact-size `Uint8Array` plus
`encodeInto`, and exact-size unpooled Buffer allocation plus native UTF-8 write.
Every output was checked byte-for-byte. Current encoding measured 235.24–301.03
ms, `encodeInto` 228.64–310.31 ms, and native Buffer writing 264.50–311.18 ms.
The two-pass alternatives require a UTF-8 byte-length scan before allocating;
results show no reliable gain. Current dedicated-buffer upload encoding remains
unchanged. These allocation-heavy same-process comparisons are sensitive to GC
and system load; they do not establish stable production latency differences.

A subsequent V8 CPU profile of the 512-message encrypted workload captured 596
samples across startup, fixture construction, warmup, measured work, correctness
assertions, and GC. Aggregating repeated function nodes, `TextEncoder.encode`
accounted for 17.79%, `encodeInto` 12.75%, crypto hash `update` 10.74%, and
canonical `visit` 10.23%; GC accounted for 4.36%. The profiler's top-level script
frame (22.65%) includes unattributed native/inlined work and must not be labeled
solely JSON serialization. Profiling overhead changed stage timings, so use the
unprofiled runs for timing comparisons. The synthetic-only CPU artifact was
retained outside the repository under the system temporary directory.

These results support investigating how much preparation can safely move off
the host, not replacing platform encoders or adding a cross-request payload
cache. Any offloading design must preserve request-local diagnostic digests,
prepared-body callback ordering, exact transfer ownership, cancellation, and
upload admission accounting; protocol changes need isolated staged validation
before enabling them. No production optimization is claimed in this checkpoint.

### Preparation worker feasibility checkpoint

The offline `scripts/benchmark-preparation-offload.js` prototype compares host
preparation with structured-cloning a request into a dedicated preparation
worker, including the synchronous posting cost and a transferred upload reply.
Both paths verify identical grouped hashes and exact UTF-8 upload bytes.

For 512 synthetic reasoning/message pairs (9,428,530 upload bytes), one ten-pair
alternating-order run measured 53.42 ms host preparation, 7.12 ms synchronous
worker post, and 66.74 ms total offload round trip. This suggests a host-blocking
tradeoff at the cost of higher total helper latency; it is not an end-to-end
speedup, live responsiveness measurement, or memory reduction. Worker startup,
production admission/cancellation, real transport transfer, and provider stages
are excluded. Full-body cloning introduces temporary duplication that must be
measured before adoption. See `docs/preparation-offload-plan.md` for the small
fixture comparison, method, design requirements, and open adoption gates.

No production worker or protocol behavior changes in this checkpoint. Network
liveness must not be sacrificed by moving heavy preparation onto its worker.

The profiling checkpoint's staging dependencies were subsequently reconciled:
the existing canonical hasher and request-local diagnostic changes/tests are
staged alongside their consumers. An exported index-only snapshot, with its own
dependency installation, passes typecheck, lint and 700 offline tests. This is
independent of the larger 821-test working tree and does not include unstaged
SDK/transport experiments. See the offload plan for remaining integration gates
and the existing lockfile's installation audit warnings.

- Extend preparation profiling to legacy marker migration,
  Agent Host delta replay, and live VS Code; current text/tool/image/compact-marker
  helper workloads are covered.
- Reduce or offload grouped digest and JSON/UTF-8 preparation costs identified above.
- Separate serialization CPU from worker scheduling and network preparation time.
- Audit completion, cancellation, failure, and continuation-cache references.
- Benchmark transferable uploads end-to-end and evaluate bounded transfer backpressure.
- Evaluate compression only after measuring CPU and peak allocation costs.
- Audit per-event diagnostics, IPC acknowledgments, and UI refresh frequency.

The first checkpoint does not establish a memory leak, change upload budgets,
add compression, or eliminate hashing for fields that callers actually consume.