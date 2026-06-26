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
| Model-provider discovery | Language Models editor / **Install Model Providers** discovery | Adopted | Package metadata targets VS Code 1.126+ provider discovery. | Recheck manifest shape on each engine bump. |
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
| Agent Window local sessions | Local Agent Window session model picker | Partial | Cocopi advertises general user-selectable BYOK models with tool calling and explicit agent-mode capability hints. | Verify Cocopi appears under Local Agent Window sessions; agent-host sessions such as built-in Claude/Codex filter for session-targeted models and will not list general Cocopi models. |
| Inline chat / quick editor edit | Editor inline chat / quick edit UI | Watch | Cocopi has no editor-inline-chat-specific integration; it can participate only if the host routes the request through the selected model provider. | Verify 1.126 behavior before adding settings or docs claims. |
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

## Proposed API Watchlist

Checked against `microsoft/vscode` `src/vscode-dts` on 2026-06-25. Keep this table source-backed: proposed APIs are unstable and should only become Cocopi dependencies when they unlock a clear provider-scoped feature.

| Proposed API | Cocopi status | Why it matters | Decision / next action |
| --- | --- | --- | --- |
| `chatProvider` | Adopted | Adds provider-facing model metadata, per-model configuration, model picker hints, and edit-tool preferences. | Already checked in under `data/vscode-dts` and enabled in `package.json`; keep in sync with engine bumps. |
| `chatStatusItem` | Adopted | Adds native Chat/Copilot status dashboard rows. | Already checked in and used for Cocopi-owned status only. |
| `languageModelThinkingPart` | Adopted | Adds streamable thinking/reasoning response parts. | Already checked in and used when available. |
| `inlineCompletionsAdditions` | Watch | Closest proposed surface to NES-like behavior: `InlineCompletionItem.isInlineEdit`, `showRange`, `showInlineEditMenu`, `jumpToPosition`, provider `modelInfo`, provider options, `yieldTo`, debounce, and lifecycle callbacks. | No dedicated provider-scoped Next Edit Suggestions API found. Consider only for Cocopi inline completions after the proposal stabilizes enough to replace Cocopi-owned controls. |
| `mappedEditsProvider` | Watch | Lets an extension map chat/code-block output into text or notebook edits. | Potential future fit for edit-application UX; not a language-model provider hook and not needed while host edit tools handle Cocopi tool calls. |
| `chatParticipantAdditions` | Watch | Adds rich participant response parts: text/notebook/workspace edits, external-edit tracking, multi-diff parts, thinking progress, usage details, streamed tool invocation UI, confirmations, and user action events. | Useful mainly for `@cocopi` participant UX. Avoid broad enablement until a specific response part is needed and tests cover fallback behavior. |
| `chatPromptFiles` | Watch | Exposes providers and readers for agents, instructions, prompt files, skills, slash commands, hooks, and plugins. | Cocopi currently consumes expanded host prompts indirectly. Only add if Cocopi needs to contribute or inspect Cocopi-specific runtime resources. |
| `chatSessionCustomizationProvider` | Watch | Lets a chat-session runtime expose supported agents, skills, prompts, instructions, hooks, plugins, and creation locations. | Relevant only if Cocopi owns a custom chat session type; not needed for plain model-provider participation. |
| `chatSessionsProvider` | Watch | Lets extensions provide native chat session lists, session content, active response callbacks, forks, option groups, and session metadata. | Possible long-term replacement for Cocopi-local session UI/state bridges, but high scope and only useful if Cocopi owns sessions rather than just models. |
| `languageModelCapabilities` | Watch | Adds runtime `LanguageModelChat.capabilities` fields such as tool calling, image-to-text, and `editToolsHint`. | Compare with stable/provider metadata during engine bumps; do not duplicate capability data unless host UI consumes it. |
| `languageModelPricing` | Avoid | Adds display pricing/cost fields to model metadata and runtime model objects. | Do not use static public pricing. Revisit only if Cocopi has authenticated backend-provided Codex cost metadata that maps cleanly to VS Code's fields. |
| `chatParticipantPrivate` | Avoid | Includes private chat/LM hooks such as ignored-file helpers and historically unsafe quota surfaces. | Keep disabled; previous `updateQuotas` investigation showed global Copilot entitlement writes without provider scoping. |

## Version Watch Table

| VS Code version / source | Feature | Cocopi status | Decision / note |
| --- | --- | --- | --- |
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
