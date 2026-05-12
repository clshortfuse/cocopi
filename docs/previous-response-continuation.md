# Previous Response Continuation

## Purpose

This note documents when Cocopi may reduce a VS Code language-model request to a Codex `previous_response_id` continuation, and why compacted summary replay is excluded.

The rule exists because `previous_response_id` is not just a transport compression hint. It changes the logical request context: the backend starts from a prior completed response state and appends the new `input` items. That is only correct when the new request is an append-only continuation of the prior request and response.

## Terms

- `prompt_cache_key`: Stable prompt-cache identity. This is a cache key and can remain the same across full replays, summaries, and continuations.
- `previous_response_id`: Backend response-state continuation. This asks Codex to continue from a prior completed response and send only the new delta input.
- `requestKind=compaction`: Cocopi diagnostic label for a VS Code request asking the model to summarize an oversized conversation.
- `requestKind=conversation-summary`: Cocopi diagnostic label for a later VS Code request that replays a `<conversation-summary>...</conversation-summary>` message as the compacted base conversation state.

`requestKind` is Cocopi diagnostics, not a VS Code API field and not a Codex wire field.

## Invariant

Cocopi may use `previous_response_id` only when the current full request is equivalent to:

```text
prior request input
+ prior response items
+ new input delta
```

The WebSocket session enforces this for normal turns by comparing the reconstructed full input against stored continuation anchors. If the prefix does not match, Cocopi sends the full request.

## VS Code Compaction Phases

VS Code compaction has two different phases that must not be conflated.

1. Summary generation
   - Cocopi labels this `requestKind=compaction`.
   - VS Code is asking the model to summarize the old conversation.
   - The old context is still needed, because it is the content being summarized.
   - `previous_response_id` may be used if the anchor prefix check proves the request is an append-only continuation.

2. Summary replay
   - Cocopi labels this `requestKind=conversation-summary`.
   - VS Code is replaying the compacted summary as the new base state.
   - The old pre-summary transcript is being replaced by the summary.
   - `previous_response_id` to a pre-summary response must not be used, because it would make the backend carry the old transcript and then append the summary replay.

## Current Rule

For VS Code language-model provider requests:

- Allow `previous_response_id` for `requestKind=normal`.
- Allow `previous_response_id` for `requestKind=compaction`, subject to the existing append-only anchor check.
- Block `previous_response_id` for `requestKind=conversation-summary`.

When a stateful Cocopi marker appears inside the same VS Code message as a conversation-summary replay, Cocopi may still use the marker to restore the Cocopi session id and host request counter, but it must not leave a continuation anchor crossing that summary boundary.

## Why Summary Replay Is Blocked

The failed case that motivated this rule was a large VS Code summary replay:

```text
stage=prepared requestKind=conversation-summary wireMode=full inputItems=4 previousResponseId=absent
stage=wire     requestKind=normal               wireMode=previous-response inputItems=1 previousResponseId=present
error=context_length_exceeded
```

Cocopi had reduced a compacted replay to `previous_response_id`. That made the backend start from the old pre-compaction response state, then append the compacted replay delta. The result was logically larger than VS Code intended and the backend rejected it as over the model context window.

Sending the summary replay as an explicit full request preserves VS Code's compacted state: the backend sees the summary as the replacement base, not as an addition to the old response state.

## Why Not Disable Continuation Entirely

Disabling `previous_response_id` globally would avoid this class of error, but it would also remove valid append-only continuations for normal tool/result turns and regular chat turns.

Keeping continuation for append-only turns preserves the benefits of the WebSocket Responses path while avoiding the specific invalid case where VS Code has intentionally replaced history with a summary.

## Codex CLI Parity

Codex CLI behavior is the minimum bar. Cocopi should keep `prompt_cache_key`, `previous_response_id`, compaction, tool replay, and reasoning replay at least as reliable as upstream Codex CLI wherever VS Code exposes enough state to do so.

The summary-replay block is not meant to be a weaker Cocopi replacement for Codex CLI compaction. It is a VS Code bridge guard around a replacement-history replay shape. Normal append-only continuation and summary-generation compaction should still use the same kind of prefix-proof logic Codex uses before reducing a request to `previous_response_id`.

Future custom compaction options, including use of the remote Codex compaction endpoint, should be additive. They should preserve the continuation invariant and keep cache-continuity diagnostics visible rather than hiding misses or state changes.

See `docs/compaction-strategy.md` for the broader compaction roadmap. The default remains VS Code-owned compaction until a custom strategy can prove parity with Codex CLI under VS Code replay constraints.

## False Positive Risk

The current `conversation-summary` detection is inferred from message text that starts with `<conversation-summary>`. Cocopi does not currently receive a dedicated VS Code API flag proving that the message was generated by VS Code compaction.

If a user manually sends text shaped like a VS Code summary replay, Cocopi can treat it as a replay boundary. The message text is still sent, but prior replay state can be cleared and `previous_response_id` can be blocked for that turn.

This is conservative for backend correctness, but it is still an inference. Prefer an explicit VS Code compaction marker if the API exposes one later. Otherwise, keep the detection narrow and covered by regression tests.

## Tests

Relevant coverage lives in `test/vscode-language-model-provider.test.js`:

- `codexRequestStateFromLanguageModelMessages treats compaction summaries as replay boundaries`
- `codexRequestStateFromLanguageModelMessages does not continue from markers embedded in compaction summaries`

Relevant lower-level WebSocket continuation coverage lives in `test/codex-websocket.test.js`, especially anchor prefix matching and rewind behavior.
