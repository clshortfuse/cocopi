# Cost-conscious interrupted response recovery

## Scope and current decision

Implementation checkpoint, September 8, 2026. The user confirmed server-side
failures and requested a Cocopi-only fix. One provider-local completed-item
continuation is now implemented; the sibling VS Code repository is unchanged.
This narrows the original plan: global retry ownership and host status remain
unresolved. Local input replay is not free or guaranteed cached.

## Implemented policy

- `lib/vscode/stream-recovery.js` wraps only the language-model provider stream.
   Its request-local checkpoint retains normalized completed reasoning/messages,
   including encrypted reasoning, with at most 256 items and 1 MiB of serialized
   item data. Recovery is declined after two minutes of original request time.
- After an eligible transport read failure, one cancellation-aware 200 ms backoff
   precedes a full-context SSE continuation with a 30-second deadline. It includes
   original logical input plus completed items once, preserves model/instructions/
   tools/cache identity, and omits the failed `previous_response_id` and anchors.
   This is continuation, not reattachment or a reliability claim about SSE.
- Completed events are not replayed to progress. Incomplete output, unidentifiable
   deltas, out-of-order completed items, any function-call activity, oversized
   checkpoints, cancellation and non-transport failures prevent internal recovery.
   Partial tool arguments are never executed; emitted tools remain host-owned.
- A terminal completion ends consumption successfully, so a subsequent transport
   failure cannot invalidate it. Retry exhaustion still throws honestly.
- Checkpoints never cross provider calls or enter persisted metadata markers.
   Cleanup occurs on iterator exit, cancellation, unsafe output or recovery use.
- Logs distinguish recovery start, success, cancellation and failure (including
   backoff and request opening), report item/byte
   counts, and mark failed-attempt usage unknown. Existing terminal usage reflects
   the successful response only, not a measured aggregate of all paid attempts.

### Remaining limitations

Continuation is a new, nondeterministic generation: it need not start with the
same text and can paraphrase or repeat prior content. Not replaying completed
events guarantees only that Cocopi does not re-emit retained events itself.
Fresh model output is preserved even when its wording repeats earlier output;
recovery does not use prefix matching or text-similarity suppression. Retaining
completed context does not guarantee freedom from repeated output or token cost.

The host can still retry a rejected provider invocation up to three times. Each
invocation has at most one new post-output continuation, but there is no shared
global budget across host retries; repeated server failures can therefore increase
the total attempts. Its premature "Recovered" status is unchanged. This fix does
not promise exactly-once external tool execution across host retries, cache hits,
zero repeated model reasoning, or measured token savings. The chat-participant
path is unchanged. Real-host retention and billing measurements remain untested.

## Original investigation: verified source contract

Inspected the local sibling VS Code checkout, without modifying it:

- `extensions/copilot/src/platform/endpoint/vscode-node/extChatEndpoint.ts`,
  `ExtensionContributedChatEndpoint`: text, tools, state markers and thinking are
  forwarded to the stream callback before stream completion. Its catch maps every
  provider exception to `ChatFetchResponseType.Failed`, without preserving an
  error classification or retry disposition. The returned failure contains no
  accumulated text or usage. Callback consumers may retain progress separately;
  source inspection here does not establish subsequent history retention.
- `extensions/copilot/src/extension/intents/node/toolCallingLoop.ts`,
  `shouldAutoRetry`: auto-approve/autopilot retries `Failed` up to its three-retry
  limit. Changing a provider error class alone cannot prevent this: the adapter
  already discarded that distinction.
- The loop resolves recovery progress before calling `runOne`, not after that
  call succeeds. A production fix must not rely on this status as proof of success.
- Before this fix, Cocopi's provider emitted text before the terminal event; its response-state
  builder retains keys/counts, not completed item payloads. Its failure path
  throws, with no request-local continuation retry or interrupted checkpoint.

These are source findings, not a completed host integration reproduction. Actual
host history construction and pending tool execution still require integration
coverage. A fake consumer retaining provider progress is not that evidence.

## Original implementation gates (before Cocopi-only scope selection)

1. Add an offline provider characterization: completed encrypted reasoning and
   assistant message, followed by a transport read failure before the terminal
   response. Capture progress and the exact next request input for an explicit
   unchanged-input retry. Also cover partial text and tool arguments.
2. Require a host adapter contract that preserves an explicit non-retryable /
   recovery-exhausted disposition through the endpoint and tool loop. Do not
   misuse cancellation, permissions, refusal, or a success response to suppress
   retries. Specify a shared logical-request budget or unambiguous retry owner.
3. In a separately authorized host patch, test the real endpoint and loop with a
   throwing provider. Assert retained text/data, next-request history, pending
   tool call/result lifecycle, exhausted-budget behavior and truthful status.
4. Only then implement bounded, in-memory, request-local completed-item
   continuation. Keep original context plus normalized completed items exactly
   once; do not reuse a lost server anchor, persist payload checkpoints, execute
   partial tool JSON, or retry around an already-emitted tool call.
5. Cover terminal-then-close, cancellation/backoff, checkpoint limits, concurrent
   requests, stale anchors and non-transient errors before enabling recovery.

## Cost acceptance criteria

- Count attempted generations separately from successful requests.
- Compare unchanged-input replay with completed-item continuation: replayed input,
  completed items reused, reported cached/uncached input and additional output /
  reasoning tokens when available. Failed-attempt usage can be unknown, not zero.
- Offline fixtures prove structural reuse and duplicate-progress behavior, not
  backend billing or cache hits. Live measurements require explicit opt-in.
- No multiplied automatic generation budget. No text-hiding token-savings claims.

## Validation

Run the focused reproduction, `npm run check`, `npm run lint`, and offline tests.
Exclude `codex-live.test.js` explicitly so local credentials cannot silently opt
this investigation into remote account usage.

## Original reproduction results

The three `interrupted stream characterization` tests pass against unchanged
production behavior. Each fake SSE stream delivers its events before raising a
transport read error. Each first provider call rejects after exactly one request.
Completed answer text and incomplete text are already present in provider
progress; partial tool arguments produce no executable tool call. None emits an
interrupted state marker. An explicit second call with unchanged messages sends
the same input, without the completed reasoning/message, and produces fresh text.
This characterizes the loss boundary; it is not a failing-then-passing recovery
regression or proof that the real host replays identical messages.

Validation: `npm run check`, `npm run lint`, `git diff --check`, and all 536
offline tests passed. Live tests were excluded; no billing savings were measured.

## Fix verification

The provider regression now asserts two outbound requests in one invocation,
original context preserved, completed reasoning/message appended once, no failed
server anchor, and no duplicate emission of the completed answer. Partial-text
and partial-tool cases still reject without internal replay. Nine iterator safety
tests cover WebSocket transport recovery, retry exhaustion, tools, partial output,
non-transient failure, stream/backoff cancellation, oversized checkpoints and
terminal completion followed by failure.

The same recovery test was run unchanged against temporary pass-through behavior:
it failed with the transport exception. Restoring the implementation made it
pass. Type checking, lint and all 545 offline tests passed. No live API calls or
account-cost measurements were made.

Packaging validation and the configured coverage thresholds also passed using
the offline equivalent of `npm run validate` (explicitly excluding the live test
file): 92.77% lines, 81.72% branches and 93.86% functions overall. The recovery
module has 94.02% line, 89.80% branch and 100% function coverage.

## Staging review fixes (September 9, 2026)

- Flush completed-only text at the recovery boundary and reset attempt-local
   fallback counters, output phases and indices. Both generations remain visible
   once and in order regardless of which supplies text deltas.
- Track failures from stream iteration separately from local normalization and
   checkpoint serialization. A local `TypeError` cannot initiate a paid retry.
- Report one terminal recovery failure/cancellation when backoff or request
   opening fails, as well as when the continuation stream fails. Deadline expiry
   is failure; explicit user cancellation is cancellation. Error payloads are not
   included in these status messages.
- Six initial regression cases failed before the fix and passed afterward.
   Expanded coverage includes all four cross-attempt text-delta combinations,
   normalization/serialization errors, opening failure, backoff cancellation and
   deadline expiry. The focused recovery suite passes all 21 cases.
- Final validation: type checks, lint, package checks, whitespace checks and all
   554 offline tests passed. Offline coverage passes the configured thresholds:
   92.80% lines, 81.76% branches and 93.87% functions overall. No live API calls.