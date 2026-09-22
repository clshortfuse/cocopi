# Upstream Codex Baseline Tracking

This file tracks Cocopi-visible drift from the OpenAI Codex CLI baseline that Cocopi uses as a behavior reference. It is intentionally focused on remote API, model-catalog, auth, transport, tool, and VS Code bridge implications. It is not an exhaustive copy of every upstream CLI/TUI/app-server change.

## GPT-6 Sol And Luna Rollout

- Current Cocopi baseline: [`rust-v0.155.1`](https://github.com/openai/codex/releases/tag/rust-v0.155.1)
- Previous Cocopi baseline: [`rust-v0.153.3`](https://github.com/openai/codex/releases/tag/rust-v0.153.3)

The live ChatGPT Codex catalog returns `gpt-6-sol` and `gpt-6-luna` when queried with client version `0.155.1`; the same account does not receive them with `0.153.3`. OpenAI's model documentation identifies Sol as the replacement for the retiring GPT-5.5 default and Luna as the efficient focused-task model. Cocopi defaults its main model to Sol. Automatic general utility uses Luna Max, small utility uses Luna Low, and autocomplete uses Luna at its lowest supported effort; Sol is the next catalog fallback. Explicit route targets remain pinned, including older user-selected models, until the user changes them to Auto. Neither Spark nor GPT-5.6 is recommended for automatic selection. No GPT-6 Terra model is assumed.

`cocopi.clientVersion` lets users override the reported version for compatibility testing. The resolved value is used by the catalog `client_version` query, the `version` request header, model-catalog cache identity, and HTTP/WebSocket response transports. Changing it therefore starts a distinct catalog and WebSocket compatibility context.

### `0.153.3...0.155.1` Cocopi Impact Audit

| Upstream change | Cocopi disposition |
| --- | --- |
| `0.153.4` made Astra visible and the bundled default. | Superseded by the current Sol default and live catalog discovery. Cocopi does not import bundled picker visibility. |
| `0.154.0` added async user questions, managed worktrees, Windows app-server daemons, voice preparation, and richer TUI/session UI. | Host/runtime features outside Cocopi's backend bridge. VS Code owns user interaction, worktrees, and application lifecycle. |
| Model catalogs and WebSocket state became scoped to provider and auth identity. | Cocopi already keys catalog storage by API URL, reported client version, and account ID. Response WebSocket sessions are keyed by API URL, access-token digest, account ID, reported version, and conversation ID. |
| ChatGPT HTTP clients preserve the `__oailb` routing cookie. | No action: Cocopi uses stateless platform `fetch` and does not receive or maintain a first-party cookie jar. Track only if the backend begins requiring sticky-cookie behavior. |
| Remote compaction now consistently uses the streamed implementation and retired model entries were removed while migrations remain. | No immediate request change. Cocopi's VS Code bridge uses its existing compaction/replay strategy and live catalog rather than importing bundled retired entries. |
| Quota failures are distinguished from ordinary rate limits. | Cocopi currently surfaces backend terminal messages and keeps its existing retry policy. Dedicated quota presentation remains optional follow-up. |
| Reasoning effort is captured more consistently across compaction, replay, model switching, and tool execution. | Cocopi already records resolved model options in continuation state and applies each request's selected/catalog-compatible effort. No new wire field was identified. |
| `0.155.1` restored `none` as the local TUI reasoning-summary default to avoid providers that reject summaries. | Cocopi remains catalog-aware: it omits summaries when unsupported and uses its explicit/model-derived setting otherwise. The TUI default itself is not a backend protocol requirement. |
| Voice, Touch ID MCP verification, daemon update scheduling, task archive/delete, AWS credential commands, Python SDK publishing, and sandbox hardening landed. | These belong to Codex clients, app-server, providers, or sandbox runtimes and do not map to Cocopi's VS Code language-model provider. |

## GPT-6 Baseline Review

- Previous Cocopi baseline: [`rust-v0.144.0`](https://github.com/openai/codex/releases/tag/rust-v0.144.0)
- Current Cocopi baseline: [`rust-v0.153.3`](https://github.com/openai/codex/releases/tag/rust-v0.153.3)
- Upstream compare: [`rust-v0.144.0...rust-v0.153.3`](https://github.com/openai/codex/compare/rust-v0.144.0...rust-v0.153.3)

The upstream bundled catalog defines `gpt-6-astra` (`GPT-6-Astra`) with `minimal_client_version: "0.153.0"`. Cocopi therefore advertises stable client version `0.153.3` when fetching the live catalog and making requests. Model exposure remains catalog-driven: GPT-6 is not hardcoded into Cocopi, and the existing `gpt-5.5` fallback is unchanged.

Verified GPT-6 Astra catalog metadata:

| Field | Upstream value |
| --- | --- |
| Visibility | `hide` |
| API support | `supported_in_api: true` |
| Context window | 272,000 tokens; 872,000 maximum |
| Default reasoning | `low` |
| Supported reasoning | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| Multi-agent mode | `v2`, with `xhigh` multi-agent reasoning |

Ultra remains a symbolic orchestration selection rather than a literal Responses effort. In `0.153.3`, however, the request boundary first uses a valid catalog `multi_agent_reasoning_effort`; GPT-6 Astra selects wire `xhigh`. Max-compatible fallback remains in effect when the override is absent or invalid, while multi-agent availability affects only proactive orchestration instructions. Relevant upstream evidence:

1. [`models-manager/models.json`](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/models-manager/models.json) defines the GPT-6 Astra gate and capabilities.
2. [`rust-v0.153.3`](https://github.com/openai/codex/releases/tag/rust-v0.153.3) is the stable release selected for the client baseline.
3. [`model-provider-info/src/lib.rs`](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/model-provider-info/src/lib.rs) confirms the ChatGPT Codex endpoint and client-version request identity.

### `0.144.0...0.153.3` Source Contract Audit

Reviewed on 2026-09-04 from both tagged source trees rather than inferring compatibility from Cargo's `0.x` version numbering.

| Upstream change | Cocopi disposition |
| --- | --- |
| `reasoning_effort_for_request` now honors a valid model `multi_agent_reasoning_effort` before Max fallback. | Parse/cache the field and use it for Ultra. GPT-6 Astra Ultra sends `xhigh`; models without an override retain Max-compatible behavior. |
| `supports_reasoning_summaries` request gating was replaced by `supports_reasoning_summary_parameter`; reasoning parameters and encrypted reasoning inclusion are sent consistently. | Prefer the current catalog field with the old field as compatibility fallback. Cocopi already sends configured reasoning and `reasoning.encrypted_content`. |
| Codex backend requests add `x-codex-routing-hint: model=<slug>[;tier=<tier>]`. | Added to Cocopi HTTP and WebSocket handshakes. |
| Upstream removed `supports_parallel_tool_calls` from request gating and sets parallel calls on all model prompts. | Cocopi now sets `parallel_tool_calls` whenever it exposes model-visible tools. Stored stale `false` metadata no longer suppresses it. |
| Prompt cache keys default to session IDs. | Already matched: Cocopi uses its stable session ID for `prompt_cache_key`, `session-id`, and `thread-id`. |
| Outbound response-item IDs must be typed/prefixed. | No request change required: Cocopi omits IDs on authored messages and preserves server-issued IDs on replayed reasoning/output items. |
| WebSocket catalog ETags moved from upgrade headers to `codex.response.metadata`; `response.metadata` also carries richer safety/turn data. | Non-blocking. Cocopi catalog refresh remains endpoint/TTL-driven and preserves raw events for diagnostics. |
| Added stream events include content-part completion, output-text completion, refusal deltas, MCP argument deltas, and explicit function/custom-tool completion. | Additive for Cocopi's bridge. Existing output deltas, output-item completion, function calls, reasoning, and terminal events remain sufficient; unknown events remain diagnostic-safe. |
| Streaming connection recovery and rate-limit error classification became more specific. | Cocopi already has bounded HTTP retries, WebSocket fallback/reconnect behavior, and terminal error surfacing. Richer user-facing classification remains optional follow-up. |
| Provider-owned auth recovery, workload identity, and stricter workspace auth were added. | Not applicable to Cocopi's extension-owned ChatGPT OAuth and SecretStorage flow. OAuth endpoints and ordinary bearer/account headers remain compatible. |
| GPT-6 Astra advertises `use_responses_lite: true`, which upstream implements with an internal header plus prefixed instruction/tool input items. | Parse and retain the flag, but do not enable Lite yet. A live GPT-6 Astra standard `/responses` smoke succeeded, and adopting Lite requires a complete namespace-tool/replay implementation rather than sending only its internal header. |

Live account verification on 2026-09-04 returned `gpt-6-astra` from `/models?client_version=0.153.3`. A minimal request using Cocopi's current standard Responses payload completed with the expected `GPT6_OK` output. This confirms the deferred Lite adaptation does not block current GPT-6 use on the tested account.

## Previous `0.144.0` Baseline Review

- Previous Cocopi baseline: [`rust-v0.125.0`](https://github.com/openai/codex/releases/tag/rust-v0.125.0)
- Target upstream baseline: [`rust-v0.144.0`](https://github.com/openai/codex/releases/tag/rust-v0.144.0)
- Upstream compare: [`rust-v0.125.0...rust-v0.144.0`](https://github.com/openai/codex/compare/rust-v0.125.0...rust-v0.144.0)
- Review date: 2026-07-09

GitHub reports this compare as very large: 2,282 commits and 3,748 changed files. The GitHub compare API only returned the first 250 commits and 300 files, so this tracker relies on release notes plus focused source snapshots for Cocopi-relevant areas.

Release tags observed in this range: `0.125.0`, `0.128.0` through `0.144.0`. GitHub releases for `0.126.0` and `0.127.0` were not present in the release listing used for this review.

## Ultra Semantic Invariant At `0.144.0` (Superseded)

This section records the contract Cocopi implemented for `0.144.0`. The `0.153.3` audit above supersedes its unconditional Ultra-to-Max rule and parallel-call catalog gating.

This distinction is a regression guard, not optional terminology:

- `Ultra` is a client-side symbol selecting Max request reasoning **and** proactive multi-agent orchestration.
- The Responses request builder converts `ReasoningEffort::Ultra` to `ReasoningEffort::Max` unconditionally. Whether multi-agent instructions are available does not participate in that conversion.
- MultiAgentV2 and tool availability govern only the additional orchestration environment/instructions. On V1, with orchestration disabled, or without a host subagent tool, selected Ultra still follows the Max wire path.
- Cocopi may adapt Max to the nearest effort in an explicit older-model supported list. That catalog compatibility step is not a fallback to the model default. Missing catalog metadata means wire `max`, not omitted effort.

Authoritative upstream evidence, in descending order of relevance:

1. [`core/src/client.rs`](https://github.com/openai/codex/blob/rust-v0.144.0/codex-rs/core/src/client.rs): `reasoning_effort_for_request` maps `Ultra` to `Max` at the request boundary.
2. [`core/src/client_tests.rs`](https://github.com/openai/codex/blob/rust-v0.144.0/codex-rs/core/src/client_tests.rs): `ultra_reasoning_uses_max_for_requests` locks that mapping.
3. [`core/tests/suite/multi_agent_mode.rs`](https://github.com/openai/codex/blob/rust-v0.144.0/codex-rs/core/tests/suite/multi_agent_mode.rs): `ultra_reasoning_uses_max_and_proactive_mode` verifies both effects together, while `ultra_on_multi_agent_v1_uses_max_without_mode_instructions` proves the wire mapping survives without V2 instructions.

The protocol enum's ability to parse, display, or serialize `"ultra"` is not evidence that Responses accepts an Ultra effort. Catalog and TUI representations preserve the client selection; request-builder code and request-body tests define the wire contract. Any future change to this invariant requires new upstream request-boundary evidence, not an inference from model defaults, orchestration availability, enum serialization, or UI labels.

## Cocopi Actions For `0.144.0`

| Area | Upstream signal | Cocopi status |
| --- | --- | --- |
| Client baseline | GPT-5.6 catalog entries require `minimal_client_version: "0.144.0"`. | Bump `CODEX_CLIENT_VERSION` to `0.144.0`. |
| Model discovery | Model provider discovery remains catalog-driven. | Keep using live `/models?client_version=...`; do not hardcode GPT-5.6 production IDs. |
| Reasoning efforts | Upstream catalog adds `max` and `ultra`, and `ReasoningEffort` now accepts arbitrary non-empty model-defined strings. Ultra is client-side orchestration: upstream maps it to `max` on the wire and activates proactive MultiAgentV2 instructions. | Preserve catalog-defined values, but special-case Ultra as an orchestration mode. Send `max` to Responses and translate proactive delegation onto VS Code's real `runSubagent` tool when available and the catalog does not select `v1` or `disabled`. |
| Orchestration catalog | `multi_agent_version` selects `disabled`, `v1`, or `v2`; `tool_mode` selects `direct`, `code_mode`, or `code_mode_only`; `supports_parallel_tool_calls` reports parallel-call capability. Unknown selector strings are omitted upstream. | Parse, sanitize, and cache the recognized values. Missing selectors remain unknown for compatibility. Respect explicit parallel-tool `false` without fabricating unsupported native collaboration tools. |
| Request identity | Responses requests now use `session-id` and `thread-id`; `x-client-request-id` carries the thread id. | Send the 0.144 header names for SSE and WebSocket requests. Cocopi currently uses its stable conversation id for both session and thread identity. |
| Service tiers | Structured `service_tiers` and `default_service_tier` supersede deprecated `additional_speed_tiers`. | Parse and cache the structured fields; derive Fast picker variants from `service_tiers`, with the deprecated field retained as a compatibility fallback. |
| Catalog cache | Cocopi cache keys include API base URL, client version, and ChatGPT account id. | Version bump naturally isolates old `0.125.0` cache entries. |
| Validation | Baseline and reasoning changes should remain offline-testable. | Run `npm run check`, `npm run lint`, and `npm test`. |

## Focused Source Contract Audit

The full tag snapshots were compared in the Codex model, API, auth, protocol, and Responses transport areas after the initial release-note review.

| Upstream `0.144.0` contract | Cocopi disposition |
| --- | --- |
| Unknown non-empty reasoning effort strings deserialize as `Custom(String)` and serialize unchanged. | Implemented. Global Cocopi settings remain a curated known-value enum, while catalog-advertised custom values flow through model configuration and requests. |
| `ReasoningEffort::Ultra` is converted to `ReasoningEffort::Max` by `reasoning_effort_for_request`; with MultiAgentV2, the selected Ultra mode injects proactive multi-agent developer instructions. | Implemented. Cocopi sends `max`, appends truthful one-shot `runSubagent` guidance when the tool and selector permit it, and enables parallel calls unless the catalog explicitly reports no support. The custom participant exposes the tool as an optional baseline capability, while only Ultra activates this proactive policy. |
| MultiAgentV2 exposes `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, and `list_agents` through the `collaboration` namespace. | VS Code does not expose equivalent persistent-child lifecycle operations. Cocopi exposes the real host `runSubagent` tool, executes independent calls concurrently, and does not invent native tool names or semantics. |
| Root requests use normal Responses instructions and tools. `x-openai-subagent` and `x-codex-parent-thread-id` identify actual child requests and lineage. | Root Cocopi requests carry neither child header. VS Code owns subagent creation for `runSubagent`; add child headers only if Cocopi later owns a child request and has reliable parent lineage. |
| Responses request identity uses `session-id`, `thread-id`, and `x-client-request-id`; the latter two use thread identity. | Implemented for SSE and WebSocket. Deprecated underscore header names are no longer sent. |
| `service_tiers: [{ id, name, description }]` and `default_service_tier` augment the deprecated speed-tier list. | Implemented in parser types, stored catalog sanitization, Fast variant discovery, command details, and tests. Catalog defaults are recorded but are not silently applied, matching upstream request selection behavior. |
| Newly bundled catalog fields include `auto_review_model_override`, `comp_hash`, `include_skills_usage_instructions`, `multi_agent_version`, `tool_mode`, and `use_responses_lite`. | `multi_agent_version` and `tool_mode` are parsed and cached; the former gates V2 guidance. The remaining fields stay outside the current bridge. Cocopi translates onto actual VS Code `runSubagent` availability rather than importing Codex's native agent runtime. |
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

| Model | Default reasoning | Advertised reasoning | Cocopi `max` wire effort | Cocopi `ultra` wire effort |
| --- | --- | --- | --- | --- |
| `gpt-5.6-sol` | `low` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | `max` | `max` + proactive `runSubagent` mode |
| `gpt-5.5` | `medium` | `low`, `medium`, `high`, `xhigh` | `xhigh` | `xhigh` |
| `gpt-5.6-terra` | `medium` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | `max` | `max` + proactive `runSubagent` mode |
| `gpt-5.6-luna` | `medium` | `low`, `medium`, `high`, `xhigh`, `max` | `max` | `max` |
| `gpt-5.4` | `medium` | `low`, `medium`, `high`, `xhigh` | `xhigh` | `xhigh` |
| `gpt-5.4-mini` | `medium` | `low`, `medium`, `high`, `xhigh` | `xhigh` | `xhigh` |
| `gpt-5.3-codex-spark` | `high` | `low`, `medium`, `high`, `xhigh` | `xhigh` | `xhigh` |
| `codex-auto-review` | `medium` | `low`, `medium`, `high`, `xhigh` | `xhigh` | `xhigh` |

Conclusion: the new global settings/schema values do not force unsupported wire efforts onto older models. Cocopi resolves per live catalog metadata, then applies the upstream Ultra translation: selected Ultra becomes `max` (or the nearest older wire effort) and separately enables proactive `runSubagent` guidance when that VS Code tool is present and the catalog does not explicitly select `v1` or `disabled`. Missing selector metadata remains compatible. Upstream `ModelPreset::filter_by_auth` keeps every model in ChatGPT mode and applies `supported_in_api` only in API-key mode. Cocopi currently uses ChatGPT authentication, so a `supported_in_api: false` model remains a valid explicit workload target with its advertised reasoning levels. Automatic workloads now prefer GPT-6 Luna, then GPT-6 Sol; older models are used only when no preferred catalog model is available or explicitly pinned.

## Release-Driven Impact Matrix

| Upstream area | Relevant changes in `0.125.0...0.144.0` | Cocopi decision |
| --- | --- | --- |
| Models and reasoning | Model providers own discovery; model-defined reasoning levels flow through in advertised order; GPT-5.6 variants and `max` reasoning arrive; `ultra` appears as a client orchestration mode; Bedrock display names clarify GPT-5.6 family/variant. | Treat catalog metadata as source of truth without special-casing GPT-5.6 slugs. Preserve custom efforts, while translating Ultra to `max` plus proactive VS Code subagent guidance. |
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
- [x] Translate Ultra to `max` on the Responses wire and catalog-aware proactive `runSubagent` instructions when VS Code supplies that tool.
- [x] Parse and cache `multi_agent_version`, `tool_mode`, and `supports_parallel_tool_calls`.
- [x] Keep auto-added `runSubagent` optional at every custom-participant effort; reserve proactive instructions and parallel independent calls for Ultra, with stable result replay order.
- [x] Keep root requests free of child-only `x-openai-subagent` and `x-codex-parent-thread-id` headers.
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
