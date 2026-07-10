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

The built-in replacements route the final completion summary through the `task_complete.summary` field and tell the model not to emit a duplicate pre-tool summary. Cocopi then renders that summary itself as normal user-visible assistant text after the tool succeeds, without another Codex request.

Why it exists: VS Code's terminal tool result is not a reliable user-facing communication surface, while asking the model to emit the summary both as assistant text and as tool metadata duplicates output. Cocopi makes the metadata useful by promoting the summary to visible assistant text at the terminal tool boundary.

The replacements only suppress a duplicate final completion summary. They must not tell the model to hide or avoid commentary, progress, or work-note output before completion.

Risk: this is version-sensitive text rewriting against upstream host wording, not a first-class API contract. It should stay evidence-backed, narrow, and easy for users to override or disable. Replacements must only target known host instruction/tool text, never arbitrary user prompt content.

Primary code/tests:

- `data/vscode-instruction-overrides.json`
- `lib/vscode/configuration.js`
- `lib/vscode/chat-participant.js`
- `lib/vscode/language-model-provider.js`
- `test/vscode-configuration.test.js`
- `test/vscode-chat-participant.test.js`
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

### Ultra Reasoning And VS Code Subagents

`ultra` is a Codex client orchestration mode, not a Responses API `reasoning.effort` value. Upstream Codex `rust-v0.144.0` translates selected Ultra to `max` on the wire. With MultiAgentV2 active, it also adds developer instructions and exposes the native collaboration environment.

The native V2 environment is a `collaboration` namespace with `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, and `list_agents`. Those operations manage persistent Codex-owned child threads. VS Code exposes a different real primitive: `runSubagent` runs one delegated task and returns its result. Cocopi therefore translates the orchestration policy onto `runSubagent`; it does not advertise six fake lifecycle tools that the host cannot implement.

Cocopi applies the equivalent bridge when VS Code supplies its `runSubagent` tool:

- Send `reasoning.effort: "max"`, never `"ultra"`.
- Parse and cache the catalog's closed `multi_agent_version` (`disabled`, `v1`, or `v2`), `tool_mode`, and `supports_parallel_tool_calls` fields. Explicit `v2` permits this bridge; explicit `v1` or `disabled` suppresses V2 guidance. Missing or unknown selector metadata remains unknown and uses the compatibility fallback instead of being treated as disabled.
- Append a narrow `<multi_agent_mode>` instruction that explains the real one-shot VS Code tool, permits proactive delegation, and asks for multiple independent calls in one response when parallel tool calls are supported.
- For the custom `@cocopi` participant, include the registered `runSubagent` tool automatically as an optional capability at every reasoning effort. Ordinary Max may use it opportunistically, but receives neither the proactive `<multi_agent_mode>` policy nor Ultra's parallel-call behavior. The auto-added tool remains optional with `tool_choice: "auto"`; explicit user tool references may still require a tool call. Language-model-provider requests use only the tools supplied by VS Code for that request.
- Set `parallel_tool_calls` for Ultra unless the selected model explicitly reports `supports_parallel_tool_calls: false`. The custom participant invokes multiple returned calls concurrently and replays their call/result pairs in stable model order.
- Keep the ordinary `max` reasoning translation without V2 instructions when `runSubagent` is unavailable or the catalog explicitly selects `v1` or `disabled`.

Cocopi does not synthesize subagent calls. The model decides whether delegation is useful and invokes the standard VS Code tool, so VS Code remains responsible for subagent execution, lifecycle, permissions, and results.

There is no separate root-request Ultra header. The server-visible root contract is the ordinary Responses body: Max reasoning, developer instructions, the actual tool definition, and `parallel_tool_calls`. Cocopi deliberately does not send `x-openai-subagent` or `x-codex-parent-thread-id` on root requests. Upstream adds child identity and parent lineage only when its own runtime creates a real child; VS Code owns that child path for `runSubagent`, so Cocopi has no reliable lineage to attach.

Primary upstream references:

- `codex-rs/core/src/client.rs` (`reasoning_effort_for_request`)
- `codex-rs/protocol/src/protocol.rs` (`MultiAgentVersion`)
- `codex-rs/protocol/src/openai_models.rs` (`ToolMode`, `supports_parallel_tool_calls`)
- `codex-rs/core/src/tools/spec_plan.rs` (V2 collaboration tool registration)
- `codex-rs/core/src/responses_metadata.rs` and `codex-rs/core/src/client.rs` (child identity and request headers)

Primary Cocopi code/tests:

- `lib/vscode/configuration.js`
- `lib/vscode/language-model-provider.js`
- `lib/vscode/chat-participant.js`
- `test/vscode-configuration.test.js`
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

Cocopi treats assistant output text with Codex `phase: "commentary"` as normal visible assistant text. The language-model provider emits `LanguageModelTextPart`, and the `@cocopi` chat participant emits markdown. When Responses API text moves to a different `output_index`, Cocopi inserts a blank-line separator so commentary and final-answer items do not fuse.

Only Codex reasoning events such as `response.reasoning_summary_text.delta` and `response.reasoning_text.delta` are mapped to VS Code thinking UI.

Why it exists: commentary-phase output is still assistant-visible text meant for the user, while reasoning events are the closest match to VS Code's separate thinking surface. Rendering commentary as thinking made ordinary progress text appear semantically hidden or internal when it was actually part of the visible answer flow. The output-item separator matches VS Code's own Responses API handling in microsoft/vscode#312173.

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
