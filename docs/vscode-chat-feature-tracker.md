# VS Code Chat Feature Tracker

## Purpose

This is the running table for VS Code Chat, Copilot-style, and adjacent user features that Cocopi can use or should intentionally avoid. It complements `docs/feature-checklist.md`: that file tracks implementation details, while this file tracks user-visible host features and whether Cocopi participates in them.

Update this file when the VS Code engine target changes or when a new proposed/stable chat API becomes relevant.

Status key:

- **Adopted**: Cocopi uses the host feature directly.
- **Partial**: Cocopi uses part of the feature, or support depends on host/model data.
- **Indirect**: VS Code owns the feature and Cocopi participates as the selected model/provider.
- **Watch**: Plausible future fit, but not implemented or not publishable yet.
- **Avoid**: Investigated and intentionally not used.
- **N/A**: Host-only or Copilot-account-only behavior with no Cocopi action.

## Current Adoption Matrix

### Core Chat Surfaces

| User feature | VS Code / Copilot surface | Cocopi status | Current Cocopi usage | Gap / next action |
| --- | --- | --- | --- | --- |
| Select Cocopi as a chat model | `contributes.languageModelChatProviders`, `vscode.lm.registerLanguageModelChatProvider` | Adopted | Cocopi registers the `cocopi` vendor, advertises live Codex model metadata, and streams responses into Chat. | Keep metadata aligned with live catalog capabilities. |
| Model-provider discovery | Language Models editor / **Install Model Providers** discovery | Adopted | Package metadata targets VS Code 1.130+ provider discovery. | Recheck manifest shape on each engine bump. |
| Unified model customization | Provider `LanguageModelChatInformation` options | Adopted | Cocopi exposes `reasoningEffort` and `contextSize` when Codex catalog metadata supports meaningful choices. | Add only server-backed options; avoid synthetic pricing/budget controls. |
| `@cocopi` direct mention | `contributes.chatParticipants`, `vscode.chat.createChatParticipant` | Adopted | Cocopi provides a sticky `@cocopi` participant for direct Codex requests and fallback workflows. | Keep participant model-source behavior aligned with selected Cocopi model. |
| Agent mode / chat tool loop | Host language-model request tools and tool-result replay | Indirect | When Cocopi is selected as the model, VS Code supplies tool metadata; Cocopi emits tool calls and consumes tool results. | Add real VS Code integration tests for tool replay, edit/retry, and compaction. |
| MCP and extension-contributed tools | `LanguageModelChatRequestOptions.tools`, `lm.invokeTool` in participant path | Partial | Provider path converts tool definitions and emits tool-call parts; participant path can invoke allowed tools with VS Code permission handling. | Continue narrowing schema repairs and tool-result serialization with tests. |
| Chat cancellation | `CancellationToken` | Adopted | Cocopi maps host cancellation to Codex request aborts and stream cleanup. | Keep cancellation tests covering SSE and WebSocket paths. |
| Chat errors | Provider/participant error reporting | Adopted | Cocopi converts backend/auth/stream failures into VS Code-friendly errors and local diagnostics. | Keep redaction guarantees in logs and UI. |

### Reasoning, Context, And Continuity

| User feature | VS Code / Copilot surface | Cocopi status | Current Cocopi usage | Gap / next action |
| --- | --- | --- | --- | --- |
| Thinking / reasoning display | Proposed `LanguageModelThinkingPart` | Adopted | Cocopi maps Codex reasoning summaries/text deltas into thinking parts when the host exposes the class. | Replace close-marker convention if VS Code documents a stronger thinking-end signal. |
| Hidden state across turns | `LanguageModelDataPart` replay in chat messages | Partial | Cocopi embeds stateful markers to preserve Codex response ids, replay items, and session metadata across provider turns. | Verify persistence across retry, edit, fork, export/import, reload, model switch, and compaction in real VS Code. |
| Participant replay metadata | `ChatResult.metadata` and `ChatResponseTurn.result` | Adopted | `@cocopi` stores response-item replay metadata for later participant turns. | Keep metadata minimal and redacted. |
| Context budgeting / compaction | Provider `maxInputTokens`, `maxOutputTokens`, and model customization | Partial | Cocopi lets VS Code own compaction, advertises server-backed context limits, and labels compaction diagnostics. | Add integration tests for summary-generation and summary-replay behavior. |
| Native checkpoint/file-change summaries | Chat checkpoint UI | N/A | Cocopi does not currently own VS Code checkpoint diffs; this is not a Cocopi capability gate. | Only revisit if VS Code exposes provider-edit/checkpoint APIs Cocopi can safely drive. |
| Stable conversation identity | No stable provider-facing chat/session id yet | Watch | Cocopi uses local session ids and stateful markers as a bridge. | Replace with explicit VS Code ids if they become available. |
| Prompt cache continuity | Codex `prompt_cache_key` plus Cocopi markers | Partial | Cocopi keeps a stable local prompt-cache key where markers or participant metadata restore session identity. | Use Token Tracker to flag cache continuity breaks; prefer explicit host ids if available. |

### Host Entry Points, Context, And Attachments

| User feature | VS Code / Copilot surface | Cocopi status | Current Cocopi usage | Gap / next action |
| --- | --- | --- | --- | --- |
| Ask / Edit / Agent mode routing | VS Code Chat mode picker | Indirect | Cocopi participates when it is the selected model and VS Code routes the mode through normal language-model requests and tools. | Smoke-test each mode in real VS Code; document any Copilot-only routing. |
| Agent Host Copilot SDK sessions | Agent Host BYOK model bridge | Indirect | VS Code 1.130 synchronizes extension models with `isBYOK: true` and no `targetChatSessionType`, then routes Copilot SDK model calls through Cocopi's existing provider. VS Code owns the Agent Host, AHP, SDK, CLI runtime, permissions, and worktree isolation. | Smoke-test in real VS Code. The current bridge carries text/tools but buffers output and omits Cocopi thinking/data marker parts. |
| Inline chat / quick editor edit | Editor inline chat / quick edit UI | Watch | Cocopi has no editor-inline-chat-specific integration; it can participate only if the host routes the request through the selected model provider. | Verify current behavior before adding settings or docs claims. |
| Copilot smart actions | Explain, fix, generate tests, review, docs, and similar chat actions | Watch | Cocopi should handle the expanded prompt if the action honors the selected model provider. | Source/behavior-check which actions route to third-party providers and which remain Copilot-only. |
| Image / multimodal chat attachments | `LanguageModelDataPart` image data; provider `imageInput` metadata | Partial | Cocopi carries model image-input metadata and maps user image data parts to Codex `input_image` content. | Add tests/live smoke; ensure unsupported models are not advertised or selected for image requests. |
| Notebook chat and notebook edits | Notebook-aware chat context/edit surfaces | Partial | Cocopi inline completions support `vscode-notebook-cell`; chat requests are handled as normal provider messages when VS Code routes them to Cocopi. | Verify notebook chat/edit mode and notebook-specific response parts before claiming fuller support. |
| Terminal context and command generation | Copilot terminal chat/actions | Watch | Cocopi has no terminal-specific integration and should only consume terminal context that VS Code explicitly includes in the request. | Verify routing; do not scrape terminal state or bypass host context policy. |
| Workspace context attachments and exclusions | Chat context attachments, ignored-file policy, workspace tool permissions | Indirect | Cocopi consumes request messages/data parts and host tools as provided; it does not bypass VS Code context or tool-permission decisions. | Catalog attachment/data-part shapes in diagnostics while keeping paths and payloads redacted. |

### Inline And Editing Features

| User feature | VS Code / Copilot surface | Cocopi status | Current Cocopi usage | Gap / next action |
| --- | --- | --- | --- | --- |
| Ghost-text inline completions | `InlineCompletionItemProvider` | Adopted | Cocopi registers inline completions for file, untitled, and notebook-cell documents behind an opt-in setting. | Include inline-completion usage in Token Tracker summaries. |
| Inline model selection | Cocopi commands/settings | Adopted | Users can set a dedicated inline model or use `auto` to prefer a low-latency catalog model. | Revisit if VS Code exposes a publishable inline model-picker API. |
| Native inline-suggest setting awareness | `editor.inlineSuggest.enabled` | Adopted | Dashboard feature settings report whether host inline suggestions block Cocopi completions. | Keep dashboard focused on capability gates, not display-only preferences. |
| Next Edit Suggestions / inline quick settings | Native Copilot chat status quick settings | Indirect | VS Code owns these settings; Cocopi reports host inline-suggest gating but does not implement NES. | Do not imply Cocopi provides NES unless it gets a dedicated edit-suggestion provider path. |
| NES fetcher override | `github.copilot.chat.nesFetcher` / Copilot `NextEditSuggestionsFetcher` | N/A | This is Copilot's experiment-backed transport fetcher selector for its Xtab/NES provider; it is passed as `useFetcher` to Copilot's own `makeChatRequest2` call. | Do not read or recommend it for Cocopi unless VS Code exposes a provider-scoped Next Edit Suggestions API. |
| Edit progress while tools generate patches | Chat progress / provider response parts | Partial | Cocopi reports elapsed/target/progress details while streamed edit tool arguments are generated. | Revisit richer edit response parts if a stable/proposed API is publishable. |
| File-edit application UX | VS Code tools such as patch/insert-edit tools | Indirect | Cocopi can request host tools; VS Code/Copilot tooling applies edits and confirmations. | Keep tool-call progress and tool-result replay correct. |

### Status, Diagnostics, And Settings

| User feature | VS Code / Copilot surface | Cocopi status | Current Cocopi usage | Gap / next action |
| --- | --- | --- | --- | --- |
| Cocopi status bar item | `window.createStatusBarItem` | Adopted | Cocopi shows auth/model/usage summary and opens the dashboard. | Keep compact hover useful but not overloaded. |
| Native Chat/Copilot status dashboard row | Proposed `chatStatusItem` / `window.createChatStatusItem` | Adopted | Cocopi mirrors a status summary into the native Chat/Copilot dashboard when available. | Keep this as Cocopi-owned status; do not write global Copilot quota state. |
| Cocopi dashboard | Webview panel | Adopted | Dashboard shows auth, runtime, quota windows, models, Token Tracker, Diagnostics, and feature settings. | Continue adding only feature gates that affect Cocopi capability. |
| Feature settings audit | `workspace.getConfiguration(...).inspect(...)` | Adopted | Dashboard reports enabled/limited state for Cocopi-impacting settings and opens safe settings queries. | Keep allow-list explicit; omit UI-only preferences. |
| Token and cache diagnostics | Cocopi SecretStorage-backed local diagnostics | Adopted | Token Tracker records usage, cache behavior, model settings, request shape, and replay diagnostics. | Add inline completion rows and more compaction labels. |
| Runtime issue diagnostics | Cocopi issue storage and diagnostics webview | Adopted | Cocopi records private diagnostic entries for anomalies and cache/continuity risks. | Keep records local and redacted. |
| Native Copilot quota bars | `vscode.chat.updateQuotas` / shared chat entitlement state | Avoid | Investigated and removed: the API writes global shared Copilot quota fields, not provider-scoped Cocopi quota fields. | Do not use unless VS Code adds provider-scoped quotas. |
| Native Accounts integration | `AuthenticationProvider`, Accounts menu, authentication sessions | Watch | Cocopi uses extension-owned sign-in commands and SecretStorage instead of registering a VS Code account provider. | Consider only if it improves OAuth UX without broadening credential exposure or confusing ChatGPT/Copilot accounts. |
| Per-response usage details in Chat | Native response usage/details surfaces when available | Watch | Cocopi records usage in Token Tracker/dashboard diagnostics; it does not currently expose a first-class native per-message usage UI. | Prefer provider-scoped native usage surfaces if VS Code stabilizes them. |
| User settings as feature gates | VS Code configuration service | Adopted | Cocopi reads local settings that affect Cocopi behavior, such as inline completion, token tracking, diagnostics, reasoning summaries, strict tools, edit progress, and context limits. | Avoid reading secrets or treating display-only settings as feature limits. |

### Prompting And Customization Ecosystem

| User feature | VS Code / Copilot surface | Cocopi status | Current Cocopi usage | Gap / next action |
| --- | --- | --- | --- | --- |
| User/workspace custom instructions | Host chat prompt construction | Indirect | VS Code can include instructions in the request it sends to the selected model; Cocopi converts received messages/instructions to Codex. | Add tests for known instruction-wrapper shapes before adding special handling. |
| Prompt files / reusable prompts | VS Code prompt file features | Indirect | If VS Code expands a prompt into chat messages, Cocopi sees the expanded request as the selected provider. | Only add Cocopi-specific prompt discovery if VS Code exposes a provider-relevant API. |
| Chat modes / custom agents | VS Code Chat customization features | Indirect | Cocopi participates when selected as the model and receives the resulting messages/tools. | Track any explicit model-provider hooks separately if they become public. |
| Custom agents, skills, hooks, and plugins | Copilot customization files and proposed `chatPromptFiles` readers/providers | Indirect | Cocopi should consume the host-expanded prompt, instructions, tools, and tool policy when selected as the model. | Verify wrapper shapes before adding special handling; contribute Cocopi-specific runtime resources only if there is a scoped need. |
| Participant followups | `ChatParticipant.followupProvider` | Watch | `@cocopi` does not currently suggest follow-up prompts after responses. | Consider small, generic followups only if they improve discovery without duplicating model content. |
| Participant slash commands | Chat participant command contributions | Watch | `@cocopi` currently exposes commands through the Command Palette/dashboard, not participant subcommands. | Consider `/status`, `/signin`, or `/inline` only if supported by current VS Code manifest/API shape. |
| Agent customization files in this repo | `.instructions.md`, `.prompt.md`, `.agent.md`, `AGENTS.md` | N/A | Cocopi itself follows repo guidance but does not ship user chat customizations. | Do not conflate development-agent customization with runtime Cocopi features. |
| Ignored files / workspace exclusions | Host context and tool policy | Watch | Cocopi relies on VS Code-provided request content and tool permissions. | Consider provider-specific ignored-file integration only if a scoped, documented API exists. |

## VS Code 1.130 Complete Release-Note Audit

Audited against the complete [VS Code 1.130 release notes](https://code.visualstudio.com/updates/v1_130) and the exact `1.130.0` source tree on 2026-07-22. Every product-feature heading, sub-feature, engineering item, and community contribution on the page is covered below. No release-note-driven Cocopi manifest/API migration was found. Follow-up real-host validation found one provider behavior gap: terminal `task_complete` replay requests must emit host-recognized text instead of returning zero response parts.

### Product Features

| Release-note item | Cocopi status | Relevance and decision |
| --- | --- | --- |
| The agent host | Indirect | VS Code continues the 1.129 host-owned AHP architecture and progressively rolls it out in the editor and Agents windows. Cocopi remains an extension language-model provider and must not install `@github/copilot-sdk`, launch a CLI, or implement AHP. |
| Assisted tool approvals (`chat.assistedPermissions.enabled`) | Indirect | When enabled, Agent Host asks its language model to assess tool-call risk and shows **Assisted permissions** in the host permission picker. Cocopi can participate as the selected BYOK model through ordinary requests, but VS Code/AHP owns risk state, approval explanations, policy, execution, and UI; there is no new provider API to implement. |
| Agents window: file-level diff statistics | N/A | Live insertion/deletion counts are computed and rendered by the host Changes editor. Cocopi neither owns the diff model nor contributes this editor. |
| Agents window: compact multi-file diff view | N/A | Gutter, header, line-number, and unchanged-region layout are host UI only. |
| Agents window: compact quick chats | N/A | Agent Host quick-chat rows and regular-session metadata are host session-list presentation. Cocopi contributes no session-list provider. |
| Agents window: worktree support for all Agent Host harnesses | N/A | VS Code now applies Git worktree isolation to Claude and native Codex harnesses as well as Copilot. This does not turn Cocopi into a Codex harness: Cocopi is only a selectable BYOK model, and the host owns worktree creation, branch setup, working directory, and cleanup. |
| Chat timestamps (`chat.verbose`) | Indirect | VS Code records and renders request/response timestamps plus elapsed time. Cocopi needs no timestamp response part and should keep its own diagnostics timing separate from host message metadata. |
| Aggregate AI credit usage for Copilot Business and Enterprise | Avoid | The Copilot status menu can show account-wide billing-cycle credits when no user budget exists. This is global Copilot entitlement data, not provider-scoped Cocopi quota state; do not copy it into Cocopi or write shared quota fields. |
| Clickable terminal file links for Git mnemonic prefixes | N/A | VS Code strips `i/`, `w/`, `1/`, and `2/` prefixes when resolving Git diff links. Cocopi has no terminal-link provider and needs no parser change. |
| Engineering: release TypeScript 7 compiler and extension | N/A | This is VS Code's build/tooling migration. Cocopi remains plain Node.js JavaScript with TypeScript used only for checking/declarations; no runtime rewrite or dependency change follows from the host compiler version. |

### Community Fixes And Acknowledgements

| Release-note contribution | Cocopi status | Relevance and decision |
| --- | --- | --- |
| Voice auto-narration opt-out ([#325799](https://github.com/microsoft/vscode/pull/325799)), delayed narration request ([#325928](https://github.com/microsoft/vscode/pull/325928)), and dropped-narration revalidation ([#325966](https://github.com/microsoft/vscode/pull/325966)) | N/A | Voice backend protocol and narration lifecycle are host/Copilot features; no language-model-provider contract changed. |
| Detect Command Code as an agent CLI in terminal tab titles ([#324417](https://github.com/microsoft/vscode/pull/324417)) | N/A | Terminal process-title detection is unrelated to Cocopi requests or Agent Host participation. |
| Fix PDFs sent to BYOK Anthropic endpoints as image blocks ([#324960](https://github.com/microsoft/vscode/pull/324960)) | N/A | This fixes VS Code's built-in Anthropic custom-endpoint adapter. Cocopi maps its own image/file data to the Codex Responses API and must not copy the Anthropic translation. |
| Update `windows-process-tree` for UTF-8 Process Explorer command lines ([#324283](https://github.com/microsoft/vscode/pull/324283)) | N/A | Host process inspection only. |
| Parse Git diff mnemonic prefixes in terminal links ([#298490](https://github.com/microsoft/vscode/pull/298490)) | N/A | Implements the terminal release-note feature; Cocopi has no terminal-link contribution. |
| Fall back to lower-priority decoration colors ([#325422](https://github.com/microsoft/vscode/pull/325422)) | N/A | Host decoration rendering only. |
| Remove dead `CODEOWNERS` rules ([#325932](https://github.com/microsoft/vscode/pull/325932)) | N/A | VS Code repository maintenance only. |
| Voice barge-in playback/protocol ([#325808](https://github.com/microsoft/vscode/pull/325808), [#326159](https://github.com/microsoft/vscode/pull/326159)), client locale ([#325931](https://github.com/microsoft/vscode/pull/325931)), always-on streaming ([#326165](https://github.com/microsoft/vscode/pull/326165)), and scoped live transcripts ([#326134](https://github.com/microsoft/vscode/pull/326134)) | N/A | Voice-agent transport and rendering remain host-owned and do not add Cocopi response types. |
| Avoid stale simple-dialog folder updates ([#321357](https://github.com/microsoft/vscode/pull/321357)) and create nested folders ([#321355](https://github.com/microsoft/vscode/pull/321355)) | N/A | Native file-dialog state and folder creation only. |
| Fix quota-trajectory billing-period calculation ([#325895](https://github.com/microsoft/vscode/pull/325895)) | Avoid | Corrects Copilot billing-period projection. Cocopi must continue using its provider-owned rate-limit/usage data rather than global Copilot quota state. |
| Recognize OCaml in settings labels ([#325457](https://github.com/microsoft/vscode/pull/325457)) | N/A | Settings UI language labeling only. |
| Match uppercase query characters in `fuzzyContains` ([#324047](https://github.com/microsoft/vscode/pull/324047)) | N/A | General workbench fuzzy matching; no Cocopi-specific integration is needed. |
| Fix `tunnelProtocol` resolving to HTTPS after focus ([#325445](https://github.com/microsoft/vscode/pull/325445)) | N/A | Remote tunnel context-key correctness, unrelated to Cocopi transport configuration. |
| Issue-tracking contributor acknowledgements | N/A | Attribution only; no extension-facing behavior or migration. |

## VS Code 1.130 Exact-Source Audit

The release-note audit was supplemented with an uncapped local comparison of the exact `microsoft/vscode` `1.129.0` and `1.130.0` trees. The comparison found 1,144 changed paths and was used to catch API, provider, Agent Host, configuration, and runtime changes not called out individually in the release notes. Exact tag contents, not range commit subjects, are the compatibility evidence.

No declaration or manifest migration is required. The engine target is now `^1.130.0`; the checked-in enabled declarations were refreshed from the release tag and produced no declaration diff. Real-host validation additionally required Cocopi's terminal completion short-circuit to emit a concise text acknowledgement when the full answer is already visible.

| Exact-tree finding | Cocopi status | Relevance and decision |
| --- | --- | --- |
| Stable and enabled proposal declarations unchanged | Adopted | `vscode.d.ts`, `vscode.proposed.chatProvider.d.ts`, `vscode.proposed.chatStatusItem.d.ts`, and `vscode.proposed.languageModelThinkingPart.d.ts` are byte-for-byte unchanged. Cocopi's provider registration, metadata, model configuration, status item, and thinking-part code need no migration. |
| `chatContextProvider` context-item icon rename | Watch | The only changed proposed declaration replaces `ChatContextItem.icon` with `iconPath` and updates related docs. Cocopi neither checks in nor enables this proposal, so no manifest or source edit is warranted. |
| Agent Host BYOK model discovery changed from pull to pushed snapshots | Indirect | Each eligible renderer now pushes its current BYOK model list on subscribe and whenever `ILanguageModelsService` changes. The node registry caches one serving window's snapshot, prefers a populated serving connection, and excludes windows that never bind the provider. Cocopi already fires `onDidChangeLanguageModelChatInformation` for auth/catalog changes, so the host receives fresher model availability without a provider change. |
| Agent Host BYOK transport remains lossy | Partial | The bridge still flattens text/tool messages, buffers completion output, and carries only text, tool calls, and best-effort usage. It still omits `LanguageModelThinkingPart`, Cocopi state-marker `LanguageModelDataPart` values, and per-model `configurationSchema`; ordinary VS Code Chat remains the full-fidelity Cocopi path. |
| Copilot BYOK response success classification | Adopted | `extChatEndpoint.ts` returns success only when a provider stream contains nonempty text or at least one tool call; a zero-part or data-only terminal replay becomes `unknown` and Autopilot retries it. Cocopi now reports `Task completed.` after an already-visible `task_complete` answer instead of returning an empty stream. |
| Shared model-selection state machine | Indirect | Workbench Chat and the Agents window now share configured/default, remembered, session-restored, pending, and fallback selection logic. Asynchronous vendor resolution can remain pending until absence is conclusive, reducing premature fallback while Cocopi's provider/catalog resolves. This is host state management, not a provider callback change. |
| Selected-model storage moved to profile scope | Indirect | VS Code lazily migrates prior application-scoped selections and shares the profile-scoped remembered model across appropriate surfaces. Cocopi must not duplicate this storage or infer it from its own `cocopi.model` fallback setting. |
| Per-editor model-configuration restoration hardened | Indirect | The host preserves editor-local snapshots, heals defaults after delayed provider registration, filters restored values against the live schema, avoids redundant writes, and protects persisted buckets from prototype keys. Cocopi's `reasoningEffort` and `contextSize` schemas benefit automatically; no schema workaround is needed. |
| Agent Host assisted-permission and risk state | Indirect | The session schema adds an opt-in `assisted` approval level and host progress can carry loading/complete risk assessments with explanations and safety. Enterprise auto-approval policy normalization and picker visibility remain inside VS Code; Cocopi should not implement a parallel approval mode. |
| Session mode/approval configuration and worktree isolation | N/A | Host code separates interactive/plan/autopilot mode from default/assisted/allow-all approvals and adds common worktree setup for harnesses. These settings configure Agent Host sessions before transport and are not Cocopi model options. |
| Native Codex harness customizations | N/A | New Codex harness code scans and exposes native Codex skills, hooks, plugins, MCP data, and worktree configuration. It belongs to VS Code's Codex app-server harness, not Cocopi's remote Responses-backed BYOK model provider; do not import or emulate it. |
| Chat timestamp persistence/rendering | Indirect | Request/response timing is maintained by the host chat model and UI. Cocopi's stream timing diagnostics remain useful for backend analysis but should not attempt to author host timestamps. |
| Copilot aggregate credits and quota trajectory | Avoid | Source changes read and display Copilot organization entitlement/billing state. They remain unscoped to a third-party provider and do not supersede Cocopi's local usage/rate-limit surfaces. |
| Electron and Node runtime | Adopted | VS Code 1.130 remains on Electron `42.6.0`; that runtime resolves to Node.js `24.18.0`, Chromium `148.0.7778.280`, and V8 `14.8.178.38`. No Cocopi runtime compatibility change was found. |
| TypeScript 7 host toolchain | N/A | VS Code compiles itself and ships its language extension with TypeScript 7. This does not change the extension-host API declarations or require Cocopi to author TypeScript. |

## VS Code 1.129 Complete Release-Note Audit

Audited against the complete [VS Code 1.129 release notes](https://code.visualstudio.com/updates/v1_129) and the `1.129.0` source tree on 2026-07-15. This table covers every product-feature heading and sub-feature on the page, not only the Copilot SDK announcement. No additional Cocopi production-code gap was found beyond the engine/API, BYOK, and manifest work already recorded in this repository.

### Product Features

| Release-note item | Cocopi status | Relevance and decision |
| --- | --- | --- |
| The Agent Host | Indirect | VS Code owns the dedicated process, AHP connection, harnesses, and Copilot SDK runtime. Cocopi remains a direct ChatGPT/Codex language-model provider and must not add `@github/copilot-sdk`. |
| New editor panel in the Agents window | N/A | This is host-owned session/editor layout, diff rendering, state restoration, and pull-request UI. Cocopi contributes neither the Agents window nor its editors. |
| Session-management tools for Agent Host sessions | Indirect | VS Code supplies `list_sessions`, `get_current_session`, `create_session`, `create_chat`, `send_message`, `get_session_context`, and `delete_session` as ordinary tool definitions. The BYOK bridge forwards those definitions and Cocopi's existing generic tool-call path can select them; VS Code executes them and owns confirmations, recursion/fan-out limits, and self-target guards. |
| Remembered Agents-window session defaults | N/A | Agent mode and approval defaults are stored and applied by the host before a model request. |
| Agents-window **New Worktree** checkbox | N/A | Worktree/folder isolation is host session setup. Cocopi receives only the resulting prompt, context, and tools. |
| Run commands with `!` prefix | N/A | Agent Host parses a leading `!` as a local chat command and runs it without forwarding the turn to the SDK or BYOK model. A lone `!`, or one preceded by whitespace, remains a normal prompt. Cocopi needs no command parser or terminal permission bypass. |
| BYOK models with the Copilot Agent Host harness | Indirect | Cocopi models already advertise `isBYOK: true`, omit `targetChatSessionType`, and support agent/tool use. A regression test protects these eligibility fields. The bridge currently returns only text and tool calls, dropping provider thinking and hidden data parts. |
| Migrate prompt files to skills | N/A | VS Code migrates user/workspace `*.prompt.md` files into skill folders and expands customizations before provider transport. Cocopi ships no prompt files and does not implement migration or prompt discovery. |
| Reopen an editor from the editor toolbar | N/A | Host editor discovery UI; Cocopi contributes no custom editor. |
| Modern UI preview | N/A | Experimental workbench styling controlled entirely by VS Code. |
| GitHub Enterprise support for Copilot in Agent Host | N/A | This changes host-owned GitHub Enterprise authentication for Copilot and Claude harnesses. Cocopi's ChatGPT/Codex OAuth and SecretStorage flow remains separate and must not be redirected to GHE. |
| Proposed custom-editor priorities for files, diffs, and merges | N/A | Cocopi has no `customEditors` contribution. It does not need the `customEditorPriority` proposal or `workbench.diffEditorAssociations`; VS Code's new custom-editor defaults do not affect Cocopi. |

### Community Fixes And Acknowledgements

| Release-note contribution | Cocopi status | Relevance and decision |
| --- | --- | --- |
| Voice answers on question carousels ([#323161](https://github.com/microsoft/vscode/pull/323161)) | N/A | Host voice/question-carousel rendering; no provider contract change. |
| Modern UI full-label tab decoration color ([#325291](https://github.com/microsoft/vscode/pull/325291)) | N/A | Experimental host styling only. |
| Preserve the selected Chat model and scoped configuration across retry/confirmation paths ([#323767](https://github.com/microsoft/vscode/pull/323767)) | Indirect | This host fix benefits third-party providers such as Cocopi: switching models before **Try Again** now sends the visible selected model and its per-model configuration. Cocopi already consumes the selected model/options and needs no workaround. |
| Rerun `reevaluateOnRerun` tasks more than once ([#324571](https://github.com/microsoft/vscode/pull/324571)) | N/A | VS Code task lifecycle fix. |
| Unstick a pinned tab dragged to the unpinned row start ([#324734](https://github.com/microsoft/vscode/pull/324734)) | N/A | Host tab-management fix. |
| Update the Azure Developer CLI Fig specification ([#321221](https://github.com/microsoft/vscode/pull/321221)) | N/A | Built-in terminal completion data, unrelated to Cocopi transport or commands. |
| Fix persistent workbench UI performance degradation ([#324986](https://github.com/microsoft/vscode/pull/324986)) | N/A | Host performance fix. |
| Right-align debug exception-widget toolbar actions ([#325077](https://github.com/microsoft/vscode/pull/325077)) | N/A | Debug UI styling only. |
| Fix `ObjectSettingCheckboxWidget` memory leak ([#323670](https://github.com/microsoft/vscode/pull/323670)) | N/A | Host settings-widget lifecycle fix. |
| Register IPC handlers when listeners are added ([#323663](https://github.com/microsoft/vscode/pull/323663)) | N/A | VS Code IPC infrastructure fix; Cocopi uses public extension APIs. |
| Use `startColumn` in `growUntilVariableBoundaries` ([#324523](https://github.com/microsoft/vscode/pull/324523)) | N/A | Host editor variable-boundary fix. |
| Issue-tracking contributor acknowledgements | N/A | Attribution only; no extension-facing behavior or migration. |

## VS Code 1.129 Exact-Source Audit

The release-note audit above was supplemented with an uncapped local comparison of the exact `microsoft/vscode` `1.128.1` and `1.129.0` trees. This catches proposal, schema, host-behavior, and bug-fix changes that were not individually advertised. GitHub's compare response was used only for triage because it was capped at 250 commits and 300 files; commit subjects were not treated as final-tree evidence because the release histories diverge. The exact tag trees are authoritative.

No additional Cocopi production-code gap was found. The findings below record the host improvements Cocopi receives automatically, bridge limitations that remain upstream, and changes that should not be copied into this extension.

| Exact-tree finding | Cocopi status | Relevance and decision |
| --- | --- | --- |
| Agent Host BYOK bridge enabled by default | Indirect | `chat.agentHost.byokModels.enabled` changed from `false` to `true`. Eligible Cocopi models participate without a Cocopi setting or SDK dependency, subject to Agent Host availability and restart behavior. |
| Original BYOK model identity and visibility propagation | Indirect | The bridge now carries the renderer `modelIdentifier`, and synthetic Agent Host entries retain it as `byokModelIdentifier`. Picker visibility and **Manage Models** toggles therefore follow the original Cocopi model instead of an independent duplicate. |
| Agent Host BYOK metadata/options remain lossy | Partial | Synthetic entries copy core name/context/vision identity but not Cocopi's `configurationSchema`. The OpenAI proxy forwards `temperature`, `top_p`, and `max_tokens`, but not `reasoning_effort`; provider thinking and hidden data parts are still omitted and output is buffered. Keep the normal provider path as the full-fidelity Cocopi path and do not invent an Agent Host side channel. |
| Edited-request model configuration preservation | Indirect | When an edited request keeps the same model, VS Code now captures and reuses that request's scoped configuration; switching models uses the newly selected model's configuration. Cocopi already consumes `modelConfiguration`, so no workaround is needed. |
| Provider/session model promotion metadata | Watch | `chatProvider` and `chatSessionsProvider` can carry `promo`. Positive discounts receive discount presentation and placement; non-positive promo entries are featured without discount UI. Leave unset until authenticated Cocopi backend data provides a trustworthy promotion. |
| Attach-context and tab-context proposal split | Watch | `chatContextProvider` adds attach-specific APIs and tab-aware providers for text documents or custom `viewType` tabs while retaining deprecated compatibility shims. Cocopi consumes host-expanded context and does not enable this proposal. |
| Agent Editor Comments lifecycle additions | N/A | `agentEditorComments` adds comment-acceptance state, broader change notifications, and comment deletion. Cocopi contributes no editor-comments provider. |
| Agent Host `!` paste guard | N/A | A host capture-phase guard asks before pasted text begins with the command prefix at offset zero. Parsing matches command dispatch: leading whitespace does not trigger it. Cocopi still never receives a host-intercepted command turn. |
| Agent Host built-in prompts and instruction telemetry | Indirect | VS Code formalizes built-in prompt/skill storage and synchronizes host skills into Agent Host; `instructionsCollected` counts SDK-returned sources for telemetry. Cocopi sees only resulting prompts/tools and needs no customization storage or telemetry hook. |
| MCP OAuth scope and authority fixes | Indirect | Host authentication now treats an explicit empty token scope as authoritative and preserves authorization-server, client, resource, and audience context during revalidation. This avoids sign-in loops and incorrect-tenant teardown for host MCP servers; Cocopi never receives those credentials. |
| MCP prompt/account fixes | Indirect | Agent Host surfaces each pending MCP authentication server once per conversation until it becomes ready, and enterprise XAA account enumeration preserves the identity-provider account when resource tokens are opaque. These improve host tool availability without changing Cocopi auth. |
| Messages-API reasoning-effort forwarding | N/A | The change maps effort to Anthropic Messages `output_config.effort` in the built-in Copilot custom-endpoint adapter. It is not the Agent Host renderer BYOK bridge and does not alter Cocopi's Responses request path. |
| Windowed token-cache eviction | N/A | Copilot inline-completion snippet relevance replaced a broken local FIFO implementation with an LRU cache. Cocopi's independent inline provider does not use that code or cache. |
| Utility-model setting candidates | N/A | `chat.byokUtilityModelDefault`, `chat.utilityModel`, and `chat.utilitySmallModel` appeared in range history but are identical in both exact release trees. They are not 1.129 migrations and provide no Cocopi action. |
| Provider contribution schema | Adopted | No additional exact-tree Cocopi manifest migration was found beyond removing deprecated provider `managementCommand`. Provider-level `configuration` still models named schema-driven instances and remains intentionally unsuitable for Cocopi's singleton browser OAuth plus SecretStorage flow. |

## Proposed API Watchlist

Checked against `microsoft/vscode` `src/vscode-dts` on 2026-07-22. Keep this table source-backed: proposed APIs are unstable and should only become Cocopi dependencies when they unlock a clear provider-scoped feature.

| Proposed API | Cocopi status | Why it matters | Decision / next action |
| --- | --- | --- | --- |
| `chatProvider` | Adopted | Adds provider-facing model metadata, per-model configuration, model picker hints, and edit-tool preferences. VS Code 1.129 added optional `warningText` and `promo` metadata; the declaration is unchanged in 1.130. | Already checked in under `data/vscode-dts` and enabled in `package.json`; Cocopi does not currently have provider-backed warning or promotion data to publish. |
| `chatStatusItem` | Adopted | Adds native Chat/Copilot status dashboard rows. | Already checked in and used for Cocopi-owned status only. |
| `languageModelThinkingPart` | Adopted | Adds streamable thinking/reasoning response parts. | Already checked in and used when available. |
| `inlineCompletionsAdditions` | Watch | Closest proposed surface to NES-like behavior: `InlineCompletionItem.isInlineEdit`, `showRange`, `showInlineEditMenu`, `jumpToPosition`, provider `modelInfo`, provider options, `yieldTo`, debounce, and lifecycle callbacks. | No dedicated provider-scoped Next Edit Suggestions API found. Consider only for Cocopi inline completions after the proposal stabilizes enough to replace Cocopi-owned controls. |
| `mappedEditsProvider` | Watch | Lets an extension map chat/code-block output into text or notebook edits. | Potential future fit for edit-application UX; not a language-model provider hook and not needed while host edit tools handle Cocopi tool calls. |
| `chatParticipantAdditions` | Watch | Adds rich participant response parts: text/notebook/workspace edits, external-edit tracking, multi-diff parts, thinking progress, usage details, streamed tool invocation UI, confirmations, and user action events. | Useful mainly for `@cocopi` participant UX. Avoid broad enablement until a specific response part is needed and tests cover fallback behavior. |
| `chatPromptFiles` | Watch | Exposes providers and readers for agents, instructions, prompt files, skills, slash commands, hooks, and plugins. | Cocopi currently consumes expanded host prompts indirectly. Only add if Cocopi needs to contribute or inspect Cocopi-specific runtime resources. |
| `chatSessionCustomizationProvider` | Watch | Lets a chat-session runtime expose supported agents, skills, prompts, instructions, hooks, plugins, and creation locations. | Relevant only if Cocopi owns a custom chat session type; not needed for plain model-provider participation. |
| `chatSessionsProvider` | Watch | Lets extensions provide native chat session lists, session content, active response callbacks, forks, option groups, session metadata, and optional 1.129 promotion metadata. | Possible long-term replacement for Cocopi-local session UI/state bridges, but high scope and only useful if Cocopi owns sessions rather than just models. |
| `chatContextProvider` | Watch | VS Code 1.129 separated explicit attach-context providers from automatic tab-context providers; 1.130 replaces `ChatContextItem.icon` with `iconPath`. | Cocopi currently consumes context after the host expands it and does not enable this proposal. Do not adopt an unstable provider merely to inspect or duplicate host attachments. |
| `agentEditorComments` | N/A | VS Code 1.129 adds comment-acceptance state, change notifications for that state, and comment deletion. | Cocopi contributes no Agent Editor Comments provider and should not enable the proposal. |
| `languageModelCapabilities` | Watch | Adds runtime `LanguageModelChat.capabilities` fields such as tool calling, image-to-text, and `editToolsHint`. | Compare with stable/provider metadata during engine bumps; do not duplicate capability data unless host UI consumes it. |
| `languageModelPricing` | Avoid | Adds display pricing/cost fields to model metadata and runtime model objects. | Do not use static public pricing. Revisit only if Cocopi has authenticated backend-provided Codex cost metadata that maps cleanly to VS Code's fields. |
| `customEditorPriority` | N/A | VS Code 1.129 proposes separate automatic-selection priorities for custom text, diff, and merge editors. | Cocopi contributes no custom editor, so do not enable or check in this proposal. |
| `chatParticipantPrivate` | Avoid | Includes private chat/LM hooks such as ignored-file helpers and historically unsafe quota surfaces. | Keep disabled; previous `updateQuotas` investigation showed global Copilot entitlement writes without provider scoping. |

## Version Watch Table

| VS Code version / source | Feature | Cocopi status | Decision / note |
| --- | --- | --- | --- |
| 1.130 | Stable and enabled proposed API declarations | Adopted | No contract delta: provider, status-item, and thinking declarations are unchanged after the exact-tag refresh. |
| 1.130 | BYOK terminal response classification | Adopted | The host recognizes only nonempty text or tool calls as a successful BYOK response. Cocopi emits a concise acknowledgement after an already-visible terminal `task_complete` replay rather than returning zero parts. |
| 1.130 | Agent Host pushed BYOK model snapshots | Indirect | Host model availability now follows renderer change events and serving-window state; Cocopi's existing catalog-change event is sufficient. |
| 1.130 | Shared model selection/configuration restoration | Indirect | Host-side pending selection, profile storage, and per-editor schema restore reduce fallback/configuration races without a provider change. |
| 1.130 | Assisted tool approvals | Indirect | Agent Host owns risk assessment, policy, picker UI, and execution. Do not add Cocopi approval settings or tool bypasses. |
| 1.130 | Worktrees across Agent Host harnesses | N/A | Applies to Copilot, Claude, and native Codex harnesses; Cocopi remains a BYOK model, not a harness. |
| 1.130 | Chat timestamps | Indirect | Host renders timestamps and elapsed time; Cocopi keeps separate transport diagnostics. |
| 1.130 | Aggregate Copilot AI credits | Avoid | Copilot Business/Enterprise account state is not provider-scoped and must not back Cocopi quota UI. |
| 1.130 | Proposed `chatContextProvider.iconPath` | Watch | Cocopi does not enable this proposal, so the rename requires no declaration or source change. |
| 1.129 | Agent Host and built-in Copilot SDK harness | Indirect | Host-owned architecture, not a new extension API or Cocopi dependency. Keep Cocopi's direct OAuth/Codex backend bridge. |
| 1.129 | Agent Host BYOK model bridge | Indirect | Cocopi's existing `isBYOK`, user-selectable, tool-capable models are automatically enumerated and routed through the provider when the host bridge is enabled. |
| 1.129 | Agent Host session-management tools | Indirect | Tool definitions traverse the ordinary BYOK request path; VS Code owns execution and safety policy. |
| 1.129 | Agent Host `!` commands | N/A | Host-local command handling occurs before SDK/provider dispatch, so Cocopi does not receive the command. |
| 1.129 | Selected Chat model retry fix | Indirect | Host retry and confirmation paths now preserve the selected model plus scoped model configuration, benefiting Cocopi without a provider change. |
| 1.129 | Proposed `chatProvider` warning/promotion metadata | Adopted | Refreshed declarations include optional `warningText` and `promo`; leave unset until authenticated Cocopi backend data maps cleanly to them. |
| 1.126 | Language model provider discovery | Adopted | Package targets provider discovery through `contributes.languageModelChatProviders`. |
| 1.126 | Unified model customization picker | Adopted | `reasoningEffort` and server-backed `contextSize` are exposed as model options. |
| 1.126 | Proposed chat status item | Adopted | Cocopi contributes status/details to the native Chat/Copilot status dashboard when available. |
| 1.126 | Proposed thinking part | Adopted | Cocopi maps Codex reasoning deltas/summaries into `LanguageModelThinkingPart` when available. |
| 1.126 | Proposed chat quota updates | Avoid | Removed because `updateQuotas` writes shared Copilot entitlement/quota state without provider scoping. |
| Future | Provider-scoped quota/status usage | Watch | Safe if VS Code adds provider/vendor/model scoping. |
| Future | Publishable inline-completion additions | Watch | Could replace Cocopi-owned inline model/status controls if host support becomes provider-aware. |
| Future | Explicit compaction/session/retry metadata | Watch | Preferred replacement for summary text inference and Cocopi-owned session ids. |
| Future | Rich edit/checkpoint response parts | Watch | Useful only if Cocopi can drive them without hiding or corrupting VS Code-owned edit state. |

## Review Checklist For Each Engine Bump

1. Re-read the stable and proposed VS Code chat/language-model API changes for the target version.
2. Add new user-visible features to the matrix before implementing them.
3. Mark unsafe global APIs as **Avoid** with the reason, not just absent.
4. Prefer host-owned features when Cocopi can participate as the selected provider without duplicating UI.
5. Prefer Cocopi-owned dashboard/status UI for provider-specific data that VS Code exposes only globally.
6. Add or update tests/docs before changing public behavior.
