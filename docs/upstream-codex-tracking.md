# Upstream Codex Baseline Tracking

This file tracks Cocopi-visible drift from the OpenAI Codex CLI baseline that Cocopi uses as a behavior reference. It is intentionally focused on remote API, model-catalog, auth, transport, tool, and VS Code bridge implications. It is not an exhaustive copy of every upstream CLI/TUI/app-server change.

## Current Baseline Review

- Previous Cocopi baseline: [`rust-v0.125.0`](https://github.com/openai/codex/releases/tag/rust-v0.125.0)
- Target upstream baseline: [`rust-v0.144.0`](https://github.com/openai/codex/releases/tag/rust-v0.144.0)
- Upstream compare: [`rust-v0.125.0...rust-v0.144.0`](https://github.com/openai/codex/compare/rust-v0.125.0...rust-v0.144.0)
- Review date: 2026-07-09

GitHub reports this compare as very large: 2,282 commits and 3,748 changed files. The GitHub compare API only returned the first 250 commits and 300 files, so this tracker relies on release notes plus focused source snapshots for Cocopi-relevant areas.

Release tags observed in this range: `0.125.0`, `0.128.0` through `0.144.0`. GitHub releases for `0.126.0` and `0.127.0` were not present in the release listing used for this review.

## Cocopi Actions For `0.144.0`

| Area | Upstream signal | Cocopi status |
| --- | --- | --- |
| Client baseline | GPT-5.6 catalog entries require `minimal_client_version: "0.144.0"`. | Bump `CODEX_CLIENT_VERSION` to `0.144.0`. |
| Model discovery | Model provider discovery remains catalog-driven. | Keep using live `/models?client_version=...`; do not hardcode GPT-5.6 production IDs. |
| Reasoning efforts | Upstream catalog adds `max` and `ultra`, and `ReasoningEffort` now accepts arbitrary non-empty model-defined strings. | Add the known values to user settings and ordering while preserving future catalog-defined values through parsing, cache restore, picker metadata, and request resolution. |
| Request identity | Responses requests now use `session-id` and `thread-id`; `x-client-request-id` carries the thread id. | Send the 0.144 header names for SSE and WebSocket requests. Cocopi currently uses its stable conversation id for both session and thread identity. |
| Service tiers | Structured `service_tiers` and `default_service_tier` supersede deprecated `additional_speed_tiers`. | Parse and cache the structured fields; derive Fast picker variants from `service_tiers`, with the deprecated field retained as a compatibility fallback. |
| Catalog cache | Cocopi cache keys include API base URL, client version, and ChatGPT account id. | Version bump naturally isolates old `0.125.0` cache entries. |
| Validation | Baseline and reasoning changes should remain offline-testable. | Run `npm run check`, `npm run lint`, and `npm test`. |

## Focused Source Contract Audit

The full tag snapshots were compared in the Codex model, API, auth, protocol, and Responses transport areas after the initial release-note review.

| Upstream `0.144.0` contract | Cocopi disposition |
| --- | --- |
| Unknown non-empty reasoning effort strings deserialize as `Custom(String)` and serialize unchanged. | Implemented. Global Cocopi settings remain a curated known-value enum, while catalog-advertised custom values flow through model configuration and requests. |
| Responses request identity uses `session-id`, `thread-id`, and `x-client-request-id`; the latter two use thread identity. | Implemented for SSE and WebSocket. Deprecated underscore header names are no longer sent. |
| `service_tiers: [{ id, name, description }]` and `default_service_tier` augment the deprecated speed-tier list. | Implemented in parser types, stored catalog sanitization, Fast variant discovery, command details, and tests. Catalog defaults are recorded but are not silently applied, matching upstream request selection behavior. |
| Newly bundled catalog fields include `auto_review_model_override`, `comp_hash`, `include_skills_usage_instructions`, `multi_agent_version`, `tool_mode`, and `use_responses_lite`. | Intentionally out of the current bridge scope. They control upstream CLI review, compaction, skill prompt assembly, multi-agent/tool orchestration, or Responses Lite behavior; Cocopi delegates those concerns to VS Code and uses standard Responses requests. |
| `response.reasoning_summary_text.done` provides finalized summary text. | Already handled by Cocopi's reasoning-part identity, metadata, and completion paths. |
| `response.metadata` can carry model verification, moderation, turn-state, and server-model metadata; safety-buffering notifications can accompany ordinary response events. | Not a request/stream correctness blocker. Cocopi preserves the raw event stream for diagnostics but does not yet expose first-party Codex moderation, verification, or buffering UI. Track as presentation work. |
| Completed responses may carry `end_turn`. | Not a blocker for the VS Code bridge, whose continuation loop is driven by explicit function-call items. The permissive response object retains the field for diagnostics. |
| Optional `stream_options.reasoning_summary_delivery: "sequential_cutoff"` enables an upstream feature-gated summary delivery mode. | Not enabled. Cocopi already keys summary parts by item and summary index; adopt only if live streams demonstrate a bridge problem or VS Code needs this delivery policy. |
| Optional reasoning `context` is used by upstream Responses Lite mode. | Out of scope because Cocopi does not use Responses Lite. |
| `bio_policy` failures receive a dedicated upstream invalid-request classification. | Cocopi's terminal-event handling already surfaces the server message. A dedicated local error class would only improve categorization. |
| Rate-limit responses can include a reached-limit type. | Non-blocking diagnostics/usage follow-up; current retry and user-facing failure behavior remains intact. |

## Focused Model Catalog Diff

Source snapshots:

- `https://raw.githubusercontent.com/openai/codex/rust-v0.125.0/codex-rs/models-manager/models.json`
- `https://raw.githubusercontent.com/openai/codex/rust-v0.144.0/codex-rs/models-manager/models.json`

| Field | `rust-v0.125.0` | `rust-v0.144.0` |
| --- | --- | --- |
| Catalog model count | 6 | 8 |
| Added slugs | — | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` |
| Removed slugs | — | `gpt-5.3-codex` removed from the bundled fixture |
| Reasoning efforts | `low`, `medium`, `high`, `xhigh` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `minimal_client_version: "0.144.0"` | — | GPT-5.6 Sol, Terra, Luna |

GPT-5.6 fixture metadata at `rust-v0.144.0`:

| Slug | Default reasoning | Supported reasoning | Context window | API support |
| --- | --- | --- | --- | --- |
| `gpt-5.6-sol` | `low` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | 372000 | `supported_in_api: true` |
| `gpt-5.6-terra` | `medium` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | 372000 | `supported_in_api: true` |
| `gpt-5.6-luna` | `medium` | `low`, `medium`, `high`, `xhigh`, `max` | 372000 | `supported_in_api: true` |

## Live Account Catalog Audit

Checked with active local credentials on 2026-07-09 using `client_version=0.144.0`. The backend returned eight models and the parser found no unknown reasoning efforts, no defaults outside their model's advertised supported list, and no parsed/advertised reasoning mismatch.

| Model | Default reasoning | Advertised reasoning | Cocopi `max` request | Cocopi `ultra` request |
| --- | --- | --- | --- | --- |
| `gpt-5.6-sol` | `low` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | `max` | `ultra` |
| `gpt-5.5` | `medium` | `low`, `medium`, `high`, `xhigh` | `xhigh` | `xhigh` |
| `gpt-5.6-terra` | `medium` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | `max` | `ultra` |
| `gpt-5.6-luna` | `medium` | `low`, `medium`, `high`, `xhigh`, `max` | `max` | `max` |
| `gpt-5.4` | `medium` | `low`, `medium`, `high`, `xhigh` | `xhigh` | `xhigh` |
| `gpt-5.4-mini` | `medium` | `low`, `medium`, `high`, `xhigh` | `xhigh` | `xhigh` |
| `gpt-5.3-codex-spark` | `high` | `low`, `medium`, `high`, `xhigh` | omitted because `supported_in_api: false` | omitted because `supported_in_api: false` |
| `codex-auto-review` | `medium` | `low`, `medium`, `high`, `xhigh` | `xhigh` | `xhigh` |

Conclusion: the new global settings/schema values do not force unsupported reasoning efforts onto older models. Cocopi resolves per live catalog metadata: old lists clamp `max`/`ultra` to nearest supported effort, GPT-5.6 Luna clamps `ultra` to `max`, and API-unsupported reasoning models omit reasoning entirely.

## Release-Driven Impact Matrix

| Upstream area | Relevant changes in `0.125.0...0.144.0` | Cocopi decision |
| --- | --- | --- |
| Models and reasoning | Model providers own discovery; model-defined reasoning levels flow through in advertised order; GPT-5.6 variants and `max` reasoning arrive; `ultra` appears in the catalog; Bedrock display names clarify GPT-5.6 family/variant. | Treat catalog metadata as source of truth. Preserve arbitrary non-empty catalog effort strings, but do not special-case GPT-5.6 slugs. |
| Usage and rate limits | Upstream adds richer `/usage` views and reset-credit redemption details. | Cocopi already reads backend usage/rate snapshots and keeps local Token Tracker rows. Track reset-credit metadata separately if the backend exposes it through Cocopi's `/usage` path. |
| Auth and login | ChatGPT auth refresh behavior improves; Python/app-server gain auth APIs; hosted/external auth and MCP auth elicitation grow; device-code login warning copy now highlights phishing prevention. | Runtime remains extension-owned browser OAuth/device-code with SecretStorage. Review Cocopi device-code UX copy against upstream phishing-warning wording. |
| Responses/WebSocket transport | Upstream centralizes Responses retry handling, changes session/thread request headers, improves incremental WebSocket comparisons, routes Responses API through system proxies, and preserves WebSockets with proxy/custom CA handling. | Align request identity headers and keep existing continuation tests. System-proxy/custom-CA parity remains separate environment-specific work. |
| Tools and turn items | Upstream adds canonical command, dynamic tool, sub-agent, collab, review, hook prompt, and extension-owned turn items, then stops emitting some legacy command events directly. | Cocopi should continue translating public Responses events and VS Code tool parts. Capture payload diagnostics for new event names before adding mappings. |
| Tool schemas | Upstream preserves richer schema constructs, compacts large schemas more carefully, and raises tool-schema compaction thresholds. | Cocopi already normalizes VS Code schemas to the supported Responses subset. Watch for live failures with large MCP schemas before broadening local schema repair. |
| Compaction and resume | Upstream improves remote compaction retries, selected-model retry when compaction references a retired model, compacted-history reuse, and dynamic skill catalog parity. | Cocopi remains VS Code-default compaction with `previous_response_id` markers. Watch for retired-model compaction errors and prefer explicit backend signals over local inference. |
| Images and hosted tools | Upstream improves local image path exposure, exact referenced image edits, image-generation extension defaults, and remote-image rejection semantics. | Cocopi supports user image input metadata; do not claim image-edit/generation parity until the selected model/tool path is verified through VS Code. |
| App-server, remote executors, plugins, goals, sandbox, TUI | Many upstream changes expand CLI/TUI/app-server surfaces, remote execution, plugin sharing, permissions, goals, Windows sandboxing, and Code Mode. | Mostly out of Cocopi runtime scope. Keep as behavioral reference only when it affects remote API payloads, auth, model metadata, or chat/tool replay. |

## Release Timeline Notes

These are the release-note themes most likely to affect Cocopi or future Cocopi parity work.

| Release | Cocopi-relevant notes |
| --- | --- |
| `0.125.0` | Model providers own discovery; `/models` fixtures refreshed; app-server remote thread/resume/fork APIs grow; reasoning-token usage appears in `codex exec --json`. |
| `0.128.0` | MultiAgentV2 settings expand; resume/interruption fixes; Bedrock model support and GPT-5.4 reasoning levels fixed. |
| `0.129.0` | Codex Apps auth and MCP elicitations surface through UI/Guardian; custom CA login behind TLS-inspecting proxies fixed; analytics expands for service tiers and tool lifecycles. |
| `0.130.0` | App-server large-thread paging; remote compaction emits `response.processed`; remote thread-store internals removed. |
| `0.131.0` | Data-driven service-tier commands; `codex doctor` diagnostics; auth reliability improves by revoking superseded login tokens. |
| `0.132.0` | Python SDK gains first-class auth; resumed exec can use `--output-schema`; image fidelity preserved across app-server turns. |
| `0.133.0` | Extension lifecycle events and tool execution metadata expand; realtime v1 WebSocket compatibility fixed. |
| `0.134.0` | Streamable HTTP MCP OAuth options; connector schemas preserve `$ref`/`$defs`; Node-based tools honor managed proxy env; WebSocket/request tracing improves. |
| `0.135.0` | Responses retry handling centralized; MCP tool naming logic centralized. |
| `0.136.0` | ChatGPT auth refreshes before a five-minute expiry window; relogin-required path improves; Bedrock catalog metadata refreshed. |
| `0.137.0` | Compact reasoning-only status item; hosted web/image tools expand; plugin/auth routing and managed MITM CA exports improve. |
| `0.138.0` | Model-defined reasoning levels flow through in advertised order; app-server account token usage; v2 personal access tokens; OAuth-backed MCP credentials pre-refresh. |
| `0.139.0` | Tool schemas preserve `oneOf`/`allOf`; image edits use exact file paths; proxy-only networking enforcement improves. |
| `0.140.0` | `/usage` views added; encrypted local storage for CLI/MCP OAuth; MCP reliability and auth status reporting improve. |
| `0.141.0` | App-server reset-credit read/redeem; TLS P-521 cert support; repeated request/history copies reduced. |
| `0.142.0` | Usage-limit reset credit redemption; rollout token budgets; startup latency improves by warming model cache and skipping redundant catalog sync; per-event WebSocket payload logging reduced. |
| `0.143.0` | Auth and Responses API traffic route through macOS/Windows system proxies; GPT-5.6 Sol/Terra/Luna and first-class `max` reasoning; incremental WebSocket comparison ignores response metadata. |
| `0.144.0` | `ultra` reasoning warning for high multi-agent concurrency; compaction retry with selected model for retired models; proxy/custom CA WebSocket handling; device-code phishing warning; model names clarify GPT-5.6 family/variant. |

## Follow-Up Watchlist

- [x] Bump Cocopi `CODEX_CLIENT_VERSION` to `0.144.0`.
- [x] Accept `max` and `ultra` in all Cocopi reasoning settings/model metadata paths.
- [x] Preserve arbitrary non-empty model-defined reasoning values from the catalog.
- [x] Send `session-id` and `thread-id` on SSE and WebSocket Responses requests.
- [x] Parse structured service-tier metadata while retaining deprecated speed-tier fallback behavior.
- [x] Keep GPT-5.6 exposure catalog-driven instead of hardcoding production IDs.
- [x] Run a live signed-in `/models` smoke to confirm account-visible GPT-5.6 entries and per-model reasoning lists.
- [x] Capture a representative GPT-5.6 Sol SSE stream after the header migration. The nine observed event types were all already recognized by Cocopi diagnostics: created, in-progress, output-item added/done, content-part added/done, output-text delta/done, and completed.
- [ ] Review device-code login copy for upstream phishing-warning parity.
- [ ] Validate WebSocket transport through a system-proxy/custom-CA environment before claiming upstream parity there.
- [ ] Add first-party moderation, model-verification, and safety-buffering presentation only when VS Code has an appropriate UX or live behavior requires it.
- [ ] Track reset-credit metadata only if Cocopi's authenticated backend usage endpoints expose it.
