# Whitespace provenance investigation

## Operational checkpoint (2026-11-10)

The user reports approximately a day of use without issues after the changes.
This is encouraging operational evidence, not a controlled test or a root-cause
finding. RAM pressure and strict-decoding explanations remain unconfirmed.
Keep the guard and no-replay policy. Resume performance measurement rather than
making additional speculative whitespace fixes absent a new recurrence.

## Question and investigation plan

Could recent whitespace/framing or WebSocket `handleMessageAsync` changes have
manufactured the Renobot tool-argument whitespace run?

1. Locate receive-path changes, including uncommitted edits.
2. Trace the guard relative to parsing, worker storage, and provider logging.
3. Replay the retained argument events against old and new implementations.
4. Separate experimentally checked transformations from unavailable raw-wire
   evidence. Do not replay a paid generation or change running instances.

## Capture facts

Source: window43, request 13, session
`cocopi-language-model-bc1a2148-a579-492e-a117-4a445c5b0724`.
The capture is the private Cocopi output log under
`output_logging_20261108T194145`; no command contents or argument payloads are
copied into this repository.

- The log identifies a WebSocket request and `response.cancel`; the request's
  continuation decision is `skipped`, reason `input-prefix-mismatch`.
- All 1,199 argument deltas have distinct, contiguous sequence numbers 5–1203.
  This is not evidence of one numbered event being repeatedly delivered.
- The initial function-call argument prefix is empty.
- The last meaningful argument event is index 119 (zero-based). The remaining
  1,079 deltas contain only JSON whitespace, totaling 16,374 characters.
- The unfinished object ends after a valid `mode` value, before `timeout`.
- The violating fragment is not present in provider-delivered event logging:
  the transport guard rejects it before worker delivery.

## Relevant changes

- The uncommitted SSE rewrite changes incremental line scanning, split CRLF
  handling, and byte accounting. Both old and new versions remove at most one
  framing space immediately after `data:`; neither trims the parsed `delta`.
  Newlines inside a JSON string arrive escaped, distinct from SSE line endings.
- The uncommitted WebSocket change makes common message decoding synchronous
  and retains an explicit microtask boundary before delivery. Its event decoder
  uses `JSON.parse`; the handler enqueues the resulting event.
- The guard introduced by `235be44` examines argument characters but enqueues
  the original event. It wraps transport output **before** worker storage and
  host/provider logging. Worker-only duplication therefore cannot explain the
  guard's own threshold failure.
- `strict: true` predates these changes: configuration has defaulted to it since
  initial commit `25437a4` (May 12). Switching that default is an upstream-parity
  mitigation, not an established fix for a newly introduced whitespace bug.

## Actual replay experiments

Read the 1,199 argument-delta objects from the private capture in memory. Never
print or persist their argument contents. Load historical modules from
`git show`, rewriting relative ESM import URLs to their source directory.
Historical top-level receive implementations use the current shared imports;
this is a receive-path comparison, not a full historical extension execution.

Tested versions:

| Version | WebSocket formats | SSE fragmentation | Result |
| --- | --- | --- | --- |
| `3df1589` (November 3, before November 6 changes) | string, Buffer, ArrayBuffer, Blob | 17 characters, 4096 characters, whole stream | Exact event equality |
| `235be44` (committed HEAD during investigation) | same four | same three | Exact event equality |
| Worktree | same four | same three | Exact event equality |
| Installed `shortfuse.cocopi-1.0.0` files at inspection | same four | same three | Exact event equality |

For WebSocket, JSON-encode each captured object into a message and concurrently
invoke the actual version's `handleMessageAsync` with a minimal active request
that records enqueued events. Compare the complete received array with the
captured array using strict deep equality. This checks values, count, and order,
including message-type conversions and microtask scheduling.

For SSE, JSON-encode each event in `data: ...\r\n\r\n` framing and feed the actual
decoder at each chunk size above. Strict deep equality also passes. SSE is an
alternate-path check, not the transport identified for this incident.

Additional experiments against the actual worktree implementation:

- Guard replay includes the two captured output-item-added events (1,201 total
  events). All pass through without any alteration.
- Append an explicitly **synthetic** 11-space delta: 16,374 + 11 = 16,385, and
  the guard rejects at the expected threshold. The synthetic event is not
  claimed to be the missing real fragment.
- Push the same 1,201 events through `WorkerDeliveryBuffer`, then JSON-decode
  the returned records. Both forced in-memory storage and forced encrypted-disk
  storage produce exactly the original events. Dispose only this experiment's
  own buffers and storage.

## Conclusion and remaining gaps

### Additional outgoing-request investigation

After the user requested a causal reproduction and fix, live A/B generation
was proposed with a maximum of two requests and no tool execution. The user
selected **offline investigation only**. No remote generations were made.

The following additional offline checks passed:

- Successful turn 12 and failed turn 13 have identical prepared and wire bodies
  within each turn. Turn 13's failure snapshot also matches its prepared body.
- Between turns 12 and 13, only `input` and `client_metadata` change. The previous
  90 input items are an exact common prefix; turn 13 adds a call/result pair.
  Model settings and all 61 tools are unchanged.
- All 35 historical function-call argument strings parse as JSON. Each call has
  a result, each result has a call, and neither set has duplicate call IDs.
- Feeding the failed body through `responseCreateWebSocketMessage` from
  `3df1589`, `235be44`, and the worktree produces deeply equal request objects.
  Canonical and native JSON serialization parse to deeply equal objects. This
  is semantic equality, not byte-for-byte serialization equality.
- The `run_in_terminal` schema's property order is unchanged between canonical
  and native serialization: command, explanation, goal, isBackground, mode,
  timeout. The specific stalled field boundary is not explained by a reordered
  terminal schema.
- The actual worktree worker-transport `request` method, exercised with a
  synthetic local message port, uploads the failed body without changes after
  UTF-8 decoding/JSON parsing. Experimental history sync is disabled for this
  probe. Invocation and upload reservations return to zero. No network is used.

These are hypothesis-elimination checks, not a failing regression for the
reported stall. No new production fix or claim of causal reproduction follows
from them. The requested root-cause/failing-test/fix sequence remains blocked
on a reproducible defect or additional origin evidence within the authorized
offline scope.

### Newly available passive post-change observations

Subsequent user activity produced a separate window43 capture,
`codex-payloads-2026-11-09T01-12-39-091Z-51068.jsonl`, and output log
`output_logging_20261108T201232/8-Cocopi.log`. Request counters restart in this
capture: its request 13 is **not** the original failed request 13. Keep the
capture filename/session context when correlating events.

At inspection, that capture contains 21 wire requests, all using
`gpt-6.1-sol` with low effort and non-strict tools. Its associated output log
contains 23 completion events and no whitespace-guard errors. Completion totals
are log-wide observations, not an assertion that all 23 match those 21 requests.

The non-strict `run_in_terminal` schema requires only `command`, `explanation`,
`goal`, and `mode`. `timeout` (number) and `isBackground` (boolean) are optional.
Five captured completed terminal calls all omit `timeout`; one also omits
`isBackground`. Commands and arguments remain private.

By comparison, the original strict wire schema requires all six fields and
makes the two originally optional fields nullable. The failed call stalls after
the valid `mode` field and before required `timeout`. Thus the strict setting
changes more than the validation label: it changes omission into mandatory
null/value generation for a field the successful non-strict calls omit.

This is new evidence consistent with a strict-decoding/optional-field interaction
and strengthens that hypothesis. It is not controlled A/B generation, proof of
the backend decoder's cause, or proof that the mitigation prevents recurrence.
All observations came from existing user activity; the investigation launched
no remote requests and executed no generated tool commands.

### Observed terminal-schema regression

Added `terminal wire schema preserves omission of timeout and legacy background
flag` in `test/vscode-configuration.test.js`. It uses the observed six-field
terminal schema with exactly four required fields, including `mode`.

In the independent staged validation snapshot, restoring only the original
`toolStrict` runtime default makes this test fail: actual required fields also
include `isBackground` and `timeout`. Restoring the staged non-strict default
makes the **same unchanged test** pass. The latest isolated snapshot passes
typecheck, lint, and all 715 offline tests.

This reproduces and protects the optional-field wire-contract difference. It
does not reproduce the model's whitespace generation. The latter root-cause
gate remains open; do not substitute this contract regression for it.

### Captured schema satisfiability checks

Audited all 61 strict tool schemas (241 schema nodes) from the original failed
wire request for empty/incompatible enums, required fields absent from object
properties, non-closed strict objects, and strict objects leaving properties
optional. No such contradiction was found. This is an audit of these specific
normalized subset constraints, not a general JSON Schema satisfiability proof.

Both terminal `timeout` and `isBackground` accept null. Appending the synthetic
suffix `,"timeout":null}` to the **actual retained argument prefix** produces
valid JSON satisfying every terminal required field, field type, enum, and
closed-object property constraint. The command contents are not printed or
stored in the repository; nothing is executed. The suffix is only an offline
counterexample to an impossible-schema-state hypothesis, never a runtime repair.

Thus a schema-valid continuation existed at the observed stall point. The
evidence does not support claiming that Cocopi emitted an unsatisfiable terminal
schema or that a decoder necessarily had no valid next token. An interaction
between the model and strict decoding remains possible, not established.

The tested framing, decoding, guard, and worker-storage changes did not create,
remove, or duplicate whitespace for the retained event sequence. No receive-path
regression was reproduced. That is narrower than proving the original server
sent these exact bytes: the available capture is post-parser, not raw frames.

The currently installed files were written after the incident, so they are not
proof of the exact modules loaded in the affected extension host. Reconstructed
WebSocket/SSE input is valid JSON built from retained events, not the original
socket input. These tests do not exercise outgoing request changes, historical
worker scheduling end-to-end, or every possible raw framing edge case.

No model/backend cause, strict-decoding cause, or specific introducing commit is
established. Keep the existing guard and no-replay policy. Further attribution
needs the incident's exact loaded build and pre-parser evidence from an
authorized future request, or a separate reproduction of an outgoing
request/history defect. Do not label the strict-default change a proven
root-cause fix.