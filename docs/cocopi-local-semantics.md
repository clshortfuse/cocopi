# Cocopi Local Semantics

## Purpose

This file inventories behavior Cocopi adds on top of VS Code and Codex. Some of it is necessary bridge code because VS Code and Codex do not expose identical conversation models. Some of it is diagnostic-only. Some of it is heuristic and should be treated as technical debt until replaced by explicit upstream API signals.

When changing any item here, prefer tests that prove the exact wire request, VS Code replay state, and Token Tracker diagnostics.

## Behavior-Changing Semantics

### Stateful Language Model Markers

Cocopi emits hidden `LanguageModelDataPart` values with MIME type `stateful_marker` from the language-model provider path.

Stored marker payloads can include:

- Codex response items to replay later.
- Cocopi session id.
- Last host request index.
- Completed Codex response id.
- Prior request state needed to reconstruct a continuation anchor.

Why it exists: VS Code replays `LanguageModelChatRequestMessage[]`, but Cocopi needs Codex response items such as encrypted reasoning, function calls, and response ids to preserve Codex state across turns.

Risk: this is Cocopi-owned state embedded in VS Code replay. If VS Code changes how data parts survive edits, compaction, export/import, or model switches, replay and continuation behavior can change.

Primary code/tests:

- `lib/vscode/language-model-provider.js`
- `test/vscode-language-model-provider.test.js`

### Cocopi Session Id As Prompt Cache Key

Cocopi creates a `cocopi-language-model-*` or chat session id and uses it as `prompt_cache_key`. Later turns restore that id from Cocopi markers or chat metadata.

Why it exists: VS Code's language-model provider request does not give Cocopi a backend prompt-cache identity that can be sent directly to Codex.

Risk: session identity is Cocopi-defined. If marker restoration fails, Cocopi may create a new prompt-cache key even though VS Code still considers the UI conversation continuous.

Primary code/tests:

- `lib/vscode/language-model-provider.js`
- `lib/vscode/chat-participant.js`
- `test/vscode-language-model-provider.test.js`
- `test/vscode-chat-participant.test.js`

### Host Request Index

Cocopi tracks a `hostRequestIndex` per Cocopi session and writes it into client metadata, stateful markers, Token Tracker rows, and logs.

Why it exists: VS Code does not provide a stable Cocopi-facing turn number suitable for diagnostics, persistence, or Token Tracker grouping.

Risk: this is not a Codex request id and not a durable VS Code conversation-turn id. It is a Cocopi diagnostic sequence restored from local markers when possible.

Primary code/tests:

- `lib/vscode/turn-metadata.js`
- `lib/vscode/token-cache-debug.js`
- `test/vscode-token-cache-debug.test.js`

### WebSocket `previous_response_id` Reduction

Cocopi can reduce a full reconstructed request into a WebSocket `previous_response_id` continuation by sending only the new input delta.

Why it exists: WebSocket Responses can continue from a prior response id. Cocopi reconstructs the full request from VS Code replay, then checks whether it equals a prior request plus prior response items plus new input.

Risk: this is only correct for append-only turns. If the request is a replacement of old history, such as compacted summary replay, continuation can attach stale backend state. See `docs/previous-response-continuation.md`.

Primary code/tests:

- `lib/codex-api/websocket.js`
- `lib/vscode/language-model-provider.js`
- `test/codex-websocket.test.js`
- `test/vscode-language-model-provider.test.js`

### Conversation Summary Boundary Handling

Cocopi treats user-role messages starting with `<conversation-summary>` as replay boundaries and clears older replay state around them. Cocopi also blocks `previous_response_id` for `requestKind=conversation-summary`.

Why it exists: VS Code compaction replay appears as a summary message replacing the old transcript, not as an append-only continuation.

Risk: this is inferred from text shape, not an explicit VS Code compaction flag. A user-authored message with the same wrapper can be treated as a replay boundary. The message text is still sent, but prior replay state and continuation anchors can be affected.

Primary code/tests:

- `lib/vscode/language-model-provider.js`
- `lib/vscode/diagnostics.js`
- `test/vscode-language-model-provider.test.js`
- `test/vscode-diagnostics.test.js`

### Request Kind Inference

Cocopi infers `requestKind=normal`, `requestKind=compaction`, or `requestKind=conversation-summary` from request text.

Why it exists: the diagnostics and Token Tracker need to distinguish normal turns, summary-generation turns, and summary-replay turns, but Cocopi does not currently receive an explicit typed field for this.

Risk: this is content-based. It should remain narrow and should not become a broad prompt parser.

Primary code/tests:

- `lib/vscode/diagnostics.js`
- `test/vscode-diagnostics.test.js`

### Compaction Limit Fallback

When the model catalog has no model-provided `auto_compact_token_limit`, Cocopi advertises a fallback `maxInputTokens`.

When the catalog does provide a lower `auto_compact_token_limit`, Cocopi exposes that value as the default VS Code 1.126 `contextSize` model configuration while keeping `maxInputTokens` at the full usable model window. When the catalog advertises `max_context_window` greater than the default `context_window`, Cocopi instead exposes the default and max windows as the `contextSize` choices. Accounts or API keys that do not receive that server metadata do not get a context-size selector.

Current default: 90% of usable input budget after reserving `maxOutputTokens`.

Why it exists: VS Code needs `maxInputTokens`/`maxOutputTokens` metadata to decide when to compact. Some Codex catalog entries do not provide an auto-compact limit.

Risk: this is a local safety margin. If it is too high, VS Code can send requests that Codex rejects for context length. If it is too low, VS Code compacts earlier than necessary.

Primary code/tests:

- `lib/vscode/language-model-provider.js`
- `package.json`
- `test/vscode-language-model-provider.test.js`

### Prompt/Instruction Preamble Detection

Cocopi may promote an initial VS Code-looking instruction preamble from the first user message into top-level Codex `instructions`.

Why it exists: VS Code can deliver provider instructions as a request message, while Codex has a top-level `instructions` field.

Risk: this is content-shape detection. It must stay specific to VS Code's known instruction wrapper and should not classify arbitrary user messages as instructions.

Primary code/tests:

- `lib/vscode/language-model-provider.js`
- `test/vscode-language-model-provider.test.js`

### VS Code/Copilot Task-Completion Instruction Rewrites

Cocopi applies built-in regex replacements to known VS Code/Copilot instruction and tool-description text around `task_complete`, then overlays user-configured regex replacements on top.

The built-in replacements specifically rewrite host wording that can imply the model should avoid emitting a visible completion summary in normal assistant text, or that the tool payload alone is the real user-facing summary.

Why it exists: Cocopi needs the final completion summary to remain visible in the chat transcript before `task_complete` is called. Some observed VS Code/Copilot instruction text and tool descriptions are awkward for that requirement because they can push the model toward treating the tool payload as the real summary and the visible chat text as optional.

The replacements must not tell the model to hide or avoid commentary/work-note output. They only clarify that the final completion summary cannot live solely in `task_complete` metadata.

Risk: this is version-sensitive text rewriting against upstream host wording, not a first-class API contract. It should stay evidence-backed, narrow, and easy for users to override or disable. Replacements must only target known host instruction/tool text, never arbitrary user prompt content.

Primary code/tests:

- `data/vscode-instruction-overrides.json`
- `lib/vscode/configuration.js`
- `lib/vscode/language-model-provider.js`
- `test/vscode-configuration.test.js`
- `test/vscode-language-model-provider.test.js`

### Tool Bridge Repairs

Cocopi mutates or repairs some tool-related data before sending it to Codex:

- Strips unsupported VS Code tool schema metadata.
- Removes optional `null` tool arguments when strict schema output would reject them.
- Prunes unpaired replayed function calls or outputs.
- Fills blank `runSubagent` model input with the active Cocopi model.
- Ignores malformed duplicate function-call output items after a valid arguments-done event already reported the same tool call.

Why it exists: VS Code tool schemas/results and Codex Responses tool-call wire shape are similar but not identical. VS Code can also replay partial tool state.

Risk: these are repairs, not transparent pass-through. They should be logged where they change behavior and covered by focused tests.

Primary code/tests:

- `lib/vscode/tool-bridge.js`
- `lib/vscode/language-model-provider.js`
- `lib/vscode/chat-participant.js`
- `test/vscode-language-model-provider.test.js`
- `test/vscode-chat-participant.test.js`

### Reasoning To Thinking-Part Mapping

Cocopi maps Codex reasoning summary or reasoning text deltas into VS Code `LanguageModelThinkingPart` when the host exposes that class. Cocopi also emits an empty thinking part with metadata to close the thinking state.

Why it exists: Codex reasoning events and VS Code thinking UI are different surfaces.

Risk: close-state conventions are Cocopi-owned unless VS Code documents a stronger end marker. UI behavior can change across VS Code versions.

Primary code/tests:

- `lib/vscode/language-model-provider.js`
- `lib/vscode/chat-participant.js`
- `test/vscode-language-model-provider.test.js`
- `test/vscode-chat-participant.test.js`

### Commentary Is Visible Output, Not Thinking

Cocopi treats assistant output text with Codex `phase: "commentary"` as visible assistant progress/commentary. In the language-model provider path it renders as a visible `Commentary` details block even when VS Code supports native thinking parts. In the `@cocopi` chat participant path it also renders as visible markdown commentary.

Only Codex reasoning events such as `response.reasoning_summary_text.delta` and `response.reasoning_text.delta` are mapped to VS Code thinking UI.

Why it exists: commentary-phase output is still assistant-visible text meant for the user, while reasoning events are the closest match to VS Code's separate thinking surface. Rendering commentary as thinking made ordinary progress text appear semantically hidden or internal when it was actually part of the visible answer flow.

Risk: this depends on the current meaning of Codex output-item `phase` values. If upstream changes commentary semantics or exposes a stronger host-facing distinction, Cocopi may need to revisit the mapping.

Primary code/tests:

- `lib/vscode/language-model-provider.js`
- `lib/vscode/chat-participant.js`
- `test/vscode-language-model-provider.test.js`
- `test/vscode-chat-participant.test.js`

### Fast Model Variant Mapping

Cocopi exposes catalog speed tiers as model ids like `gpt-5.5:fast` and maps them back to a base Codex model plus service tier.

Why it exists: VS Code model picker entries are model ids, while Codex may express speed as a service tier or catalog option.

Risk: suffixes are Cocopi UI identifiers, not Codex model ids. All wire requests must strip the suffix before sending `model`.

Primary code/tests:

- `lib/vscode/language-model-provider.js`
- `test/vscode-language-model-provider.test.js`

### Chat Participant Hidden Replay Metadata

The `@cocopi` chat participant stores hidden Codex replay metadata in `ChatResult.metadata`.

Why it exists: the chat participant API path is not the same as the language-model provider path, so it cannot rely on provider stateful markers alone.

Risk: this is another Cocopi-owned persistence channel. It must stay redacted and should not store credentials or raw sensitive payloads beyond required replay items.

Primary code/tests:

- `lib/vscode/chat-participant.js`
- `test/vscode-chat-participant.test.js`

## Diagnostic-Only Semantics

### Token Tracker

Cocopi records local Token Tracker rows in VS Code private storage for usage, prompt-cache behavior, request shape, model settings, and replay diagnostics.

Why it exists: Codex/Copilot usage and cache behavior are otherwise hard to inspect from VS Code. The tracker is a local diagnostic view.

Risk: rows are Cocopi diagnostics, not authoritative billing records. Missing backend usage data produces `unknown`, and cache-hit/drop labels are only as good as available response usage counters.

Primary code/tests:

- `lib/vscode/token-cache-debug.js`
- `lib/vscode/commands.js`
- `test/vscode-token-cache-debug.test.js`

### Cache Miss And Continuity Issues

Cocopi creates local issue records for suspected cache drops, previous-response reduction skips, missing usage counters, and related anomalies.

Why it exists: one cache miss can be expensive and should be visible, even when a later request recovers cache hits.

Risk: these are heuristics. They should not suppress misses just because a later hit occurs, and they should include enough metadata to diagnose why a miss occurred.

Primary code/tests:

- `lib/vscode/diagnostics.js`
- `lib/vscode/issue-tracker.js`
- `test/vscode-diagnostics.test.js`
- `test/vscode-issues.test.js`

## Replacement Preference

Prefer replacing Cocopi-local inference with explicit upstream signals when available:

- A VS Code compaction-request or summary-replay flag should replace `<conversation-summary>` text inference.
- A VS Code stable conversation id and turn id should replace Cocopi-only session and host request numbering where possible.
- A model-provided auto-compact limit should replace fallback compaction heuristics.
- Documented VS Code thinking completion semantics should replace the empty thinking-part close marker.
- Direct Codex/Copilot usage and cache diagnostics should replace local issue heuristics where the backend exposes enough detail.

## Codex CLI Parity Policy

Codex CLI is the behavioral floor for Cocopi. Cocopi may add VS Code-specific controls and diagnostics, but it should not knowingly be worse than Codex CLI for cache continuity, context preservation, compaction reliability, tool replay, or reasoning replay.

When Cocopi cannot match Codex CLI because VS Code does not expose equivalent state, the limitation should be documented, logged with enough metadata to diagnose, and covered by tests that prove the fallback behavior is intentional.

Custom compaction controls are still desirable as additive behavior. Cocopi may expose local strategy options or use the remote Codex compaction endpoint, but those options should preserve the same request-state invariants as Codex CLI and should not silently trade away prompt-cache continuity or continuation correctness.

See `docs/compaction-strategy.md` for the default `vscode` strategy and future `codex-remote` or manual strategy gates.

## Upstream Codex Comparison

Checked against upstream `openai/codex` source on 2026-05-11.

### Present In Upstream Codex

- Thread/session identity: Codex has session id, thread id, window id, installation id, and session source state in its model client.
- Prompt cache key: Codex sets `prompt_cache_key` from the thread id when building Responses requests.
- WebSocket incremental continuation: Codex keeps the last full request and last response for a turn-scoped WebSocket session. It only sends an incremental payload with `previous_response_id` when non-input request fields match and the new input is an extension of the prior request plus returned output items.
- Sticky routing: Codex uses `x-codex-turn-state` within a turn and explicitly treats it as scoped to that turn.
- Compaction as a first-class operation: Codex has a compact endpoint path and app-server compaction lifecycle items/events.
- Reasoning/event bridging: Codex has protocol-level reasoning items and app-server UI event shapes.

### Cocopi-Specific Or VS Code-Specific

- `LanguageModelDataPart` stateful markers with MIME type `stateful_marker`.
- Restoring Codex response ids and continuation anchors from VS Code replayed message parts.
- Inferring `requestKind=conversation-summary` from literal `<conversation-summary>` text.
- Blocking `previous_response_id` based on that inferred VS Code summary-replay shape.
- `hostRequestIndex` as a Cocopi diagnostic sequence restored from markers.
- Token Tracker webview rows, issue records, and cache-drop heuristics.
- VS Code tool schema/result repairs.
- Mapping Codex reasoning deltas into VS Code `LanguageModelThinkingPart`.
- Exposing `:fast` suffixed VS Code model ids and translating them back to base Codex model plus service tier.

### Important Distinction

Upstream Codex owns the thread state directly. Cocopi is a VS Code language-model provider, so VS Code owns the visible conversation replay and Cocopi has to reconstruct enough Codex state from that replay. That is why Cocopi has stateful marker and summary-shape heuristics that Codex CLI does not need in the same form.
