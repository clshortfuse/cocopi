# Compaction Strategy

## Purpose

This note defines Cocopi's compaction policy and roadmap. Cocopi runs inside VS Code, so the default behavior must respect VS Code's language-model chat lifecycle. Custom compaction should be additive and explicit, not a silent replacement for VS Code's strategy.

## Current Default: VS Code Strategy

The default strategy is `vscode`.

In this mode:

- VS Code decides when a language-model conversation needs compaction.
- Cocopi advertises model `maxInputTokens` and `maxOutputTokens` through `LanguageModelChatInformation`.
- Cocopi uses the model-provided `auto_compact_token_limit` when available and enabled.
- If no model-provided limit is available, Cocopi falls back to 90% of the usable input budget after reserving max output tokens.
- Cocopi treats summary generation and summary replay as separate phases for diagnostics and continuation safety.
- Cocopi does not replace VS Code's compacted replay with its own hidden transcript state.

This keeps Cocopi aligned with the host that owns the visible chat transcript, edits, retries, forks, and model-provider replay.

## Required Invariants

Every compaction strategy must preserve these rules:

- Codex CLI behavior is the minimum bar where VS Code exposes enough state.
- `prompt_cache_key` should remain stable across ordinary turns, compaction, and summary replay for the same Cocopi conversation.
- `previous_response_id` may be used only when a prefix check proves the request is an append-only continuation of prior request input plus prior response items.
- Summary replay must not accidentally append a compacted summary to stale pre-summary backend state.
- Cache misses, missing usage counters, full-replay fallbacks, and continuation skips must stay visible in logs, Token Tracker rows, or issue records.
- Any strategy that cannot meet Codex CLI parity must document the VS Code limitation and include tests proving the fallback is intentional.

## Candidate Future Strategies

### `vscode`

Default. Preserve VS Code's existing compaction behavior and focus on making the bridge reliable.

Required before considering this complete:

- Keep summary-generation compaction eligible for `previous_response_id` only when prefix-proof.
- Keep summary replay as a replacement-history boundary.
- Track compaction request kind, wire mode, prompt cache key, cache usage, and continuation decisions in diagnostics.
- Verify marker persistence across retries, edits, forks, model switches, reloads, and compaction in real VS Code sessions.

### `codex-remote`

Optional future strategy. Use the remote Codex compaction endpoint, or an equivalent first-class Codex compaction operation, to generate compacted state.

Open design questions:

- Whether VS Code exposes enough control to replace its compacted replay safely in the language-model provider path.
- Whether this belongs only in the `@cocopi` chat participant path, where Cocopi owns more conversation metadata.
- How to represent remote compacted state back to VS Code without hiding meaningful transcript changes from the user.
- Whether the remote compact endpoint preserves better cache continuity than VS Code summary replay in the provider path.

Minimum acceptance criteria:

- Side-by-side fixture tests comparing `vscode` and `codex-remote` wire requests.
- Live smoke or replay tests proving no context-window regression around compaction.
- Token Tracker labels showing the selected compaction strategy.
- Cache miss diagnostics retained even if the remote strategy later recovers cache hits.

### `manual` Or `disabled`

Optional future strategy. Expose explicit manual compaction controls or a way to defer automatic host compaction where VS Code permits it.

This is lower priority than `codex-remote` because disabling compaction can directly cause context-window failures. It should not be exposed unless Cocopi can make the resulting risk obvious and recoverable.

## Implementation Roadmap

1. Keep `vscode` as the default and current only supported strategy.
2. Add strategy labels to compaction diagnostics and Token Tracker records before adding user-facing strategy controls.
3. Build a small remote compact client around the Codex compact endpoint in a testable `lib/codex-api` module.
4. Prototype `codex-remote` in the path where Cocopi owns enough state to be correct, likely the chat participant path first.
5. Only expose a user setting after tests prove strategy-specific behavior for normal turns, tool-result turns, summary generation, summary replay, edit/rewind, model switch, and extension reload.

## Non-Goals

- Do not silently replace VS Code compaction by default.
- Do not suppress cache miss diagnostics because a later request recovers.
- Do not use `previous_response_id` to cross a replacement-history boundary just to preserve cache.
- Do not add strategy settings that imply guarantees Cocopi cannot prove under VS Code replay constraints.
