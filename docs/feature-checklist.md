# Feature Checklist

This is the running checklist for the bridge between remote Codex APIs and VS Code chat/model surfaces. It is not a claim that we have enumerated every possible feature; it is the current working map for what we need to build and verify.

## Basis And Scope

This checklist is based on four inputs:

- VS Code extension surfaces, especially the language model chat provider API, chat participant fallback, command contributions, SecretStorage, cancellation tokens, and tool-calling concepts.
- Official OpenAI/Codex documentation for Codex auth, the app-server auth model as a reference boundary, and the public Responses API shape.
- OpenAI Codex source as a clean-room behavioral reference for ChatGPT/Codex OAuth, model catalog calls, Responses request fields, streaming events, headers, and cloud task research targets.
- Our project's own verified behavior: offline tests, live `/models` smoke, and live streaming `/responses` ISO datetime smoke against the ChatGPT Codex backend.

Keep it practical: update status as we verify behavior in tests, official documentation, VS Code API behavior, or live Codex behavior. Items marked `[?]` are deliberately not trusted yet.

Status key:

- `[x]` Implemented and covered by tests.
- `[~]` Partially implemented or researched, not complete.
- `[ ]` Not started.
- `[?]` Needs confirmation from official docs, VS Code API behavior, or live Codex behavior.

## Codex API Features

### Auth And Account

- `[x]` Browser OAuth login for ChatGPT/Codex tokens.
- `[x]` Optional device-code OAuth flow.
- `[x]` Local `.env` storage for developer live tests.
- `[x]` Account id extraction from ChatGPT token metadata.
- `[x]` Refresh-token flow for expired ChatGPT/Codex access tokens.
- `[x]` VS Code SecretStorage-backed token storage.
- `[x]` VS Code browser sign-in command that stores ChatGPT/Codex OAuth tokens in SecretStorage.
- `[x]` Account/status command that reports signed-in state without printing secrets.
- `[x]` Sign-out command that clears extension-owned credentials.
- `[?]` Multi-account/workspace selection behavior.

### Usage And Rate Limits

- `[x]` Fetch Codex usage/rate-limit snapshots from the backend `/usage` endpoint.
- `[x]` Parse `codex.rate_limits` stream events and persist the latest private local snapshots.
- `[x]` Status and Token Tracker prefer API-backed limits over local estimates.
- `[x]` Local fallback reports recent Token Tracker activity only, without manual plan budgets or guessed allowance warnings.
- `[?]` Whether all transports expose useful 429/rate-limit response metadata beyond `/usage` and stream events.

### Models

- `[x]` `GET /models` request against the ChatGPT Codex backend.
- `[x]` `client_version` query parameter.
- `[x]` `ChatGPT-Account-ID` header support.
- `[x]` Default model selection with `gpt-5.5` preference.
- `[x]` Cache model catalog with expiry/refresh.
- `[~]` Surface model display names/capabilities to VS Code provider metadata.
- `[?]` Map Codex model capability fields to VS Code model capabilities.

### Responses Transport

- `[x]` `POST /responses` live smoke using streaming payload shape.
- `[x]` Required Codex headers: bearer auth, account id, originator, session id, client request id.
- `[x]` Minimal `text/event-stream` parsing for completed response smoke tests.
- `[x]` Dedicated SSE parser module with explicit malformed-event errors.
- `[x]` Readable stream consumption with async iteration for SSE responses.
- `[x]` Redacted HTTP error diagnostics.
- `[~]` General reusable Responses streaming client.
- `[x]` Incremental SSE parser for streaming chunks instead of whole response text.
- `[x]` Abort/cancellation support using `AbortController`.
- `[x]` Timeout handling for idle streams, with SSE comment heartbeats treated as activity.
- `[x]` Retry/refresh behavior for 401 responses.
- `[ ]` WebSocket Responses transport.
- `[?]` Sticky routing / `x-codex-turn-state` behavior.

### Responses Body And Events

- `[x]` Streaming request body shape with structured user message input.
- `[x]` `tools`, `tool_choice`, `parallel_tool_calls`, `store`, `include`, `prompt_cache_key`, and `client_metadata` fields.
- `[x]` Reusable request-body builder for arbitrary text messages.
- `[ ]` Conversation/session id lifecycle.
- `[~]` `instructions` and developer/system message handling.
- `[x]` Text delta events.
- `[x]` Completed events.
- `[x]` Failed/incomplete events.
- `[ ]` Cancelled events.
- `[x]` Usage/cache/reasoning metadata extraction for diagnostics.
- `[~]` Reasoning encrypted-content include and replay support.
- `[x]` Consecutive `@cocopi` tool-call follow-up loop replays reasoning, function calls, and function outputs since the last user message.
- `[x]` `@cocopi` cross-turn response-item history through `ChatResult.metadata` so encrypted reasoning, function calls, and function outputs can replay beyond immediate tool follow-ups.
- `[x]` Native provider emits encrypted reasoning response items as a custom `LanguageModelDataPart` and replays that data part when VS Code includes it in later `LanguageModelChatRequestMessage` content.
- `[ ]` Output schema / `text.format` support.
- `[?]` Full Codex event taxonomy required for VS Code model provider compatibility.

### Tools

- `[x]` Convert VS Code tool metadata to Responses tool definitions.
- `[x]` Parse Codex tool-call events.
- `[x]` Invoke allowed VS Code tools from Codex tool calls in the `@cocopi` chat participant path.
- `[x]` Send tool results back to Codex in follow-up input in the `@cocopi` chat participant path.
- `[x]` Continue `@cocopi` tool follow-ups until Codex stops requesting tools, preserving encrypted reasoning items between rounds.
- `[x]` Tool-call cancellation/error propagation in the `@cocopi` chat participant path.
- `[x]` Text, JSON-like, and binary-summary serialization for VS Code tool result content.
- `[x]` Tool permission/confirmation UX delegated to VS Code by passing `ChatRequest.toolInvocationToken` into `lm.invokeTool`.
- `[?]` Exact event shapes for all Codex tool types we need first.

### Cloud Tasks And Remote Codex Features

- `[~]` Research notes for Codex task/cloud endpoints.
- `[ ]` Decide whether cloud task APIs are in scope for this extension.
- `[?]` Public/stable availability of ChatGPT backend task endpoints for this client.

## VS Code Chat Features

### Extension Shell

- `[x]` Minimal VS Code extension entrypoint.
- `[x]` Management command placeholder.
- `[~]` Real setup/manage command UI.
- `[x]` Activation events appropriate for provider registration and commands.
- `[x]` Extension configuration settings for model, endpoint, auth mode, and stream timeout.
- `[x]` Output/log channel with secret redaction.

### Language Model Provider

- `[~]` Research notes for `vscode.lm.registerLanguageModelChatProvider`.
- `[x]` Confirm stable/proposed API availability for target VS Code version.
- `[x]` `contributes.languageModelChatProviders` manifest entry.
- `[x]` Provider registration in `activate`.
- `[x]` VS Code's built-in chat model picker is the primary Cocopi model selection UI.
- `[x]` Generic provider model metadata for compile-time/activation discovery.
- `[x]` Runtime model metadata refresh from Codex `/models` when signed in.
- `[x]` Convert VS Code chat request messages to Codex Responses input.
- `[x]` Stream Codex text deltas back as VS Code response parts.
- `[x]` Stream Codex response IDs back as `LanguageModelDataPart` using VS Code's `stateful_marker` MIME.
- `[x]` Map cancellation token to Codex request abort.
- `[x]` Report provider errors in VS Code-friendly form.
- `[?]` VS Code/Copilot Chat persistence semantics for custom provider `LanguageModelDataPart` state across edit, retry, fork, export, and compaction flows.
- `[?]` Marketplace restrictions for custom model providers.
- `[x]` Provider registration and per-model configuration target the VS Code 1.119+ chat provider proposal surface.
- `[~]` Default compaction strategy follows VS Code; future custom strategy options are documented but not implemented.

#### Provider Hidden-State Carrier

OpenAI Responses reasoning models can return encrypted reasoning items that must be replayed in later stateless requests. Chat participants have a supported metadata channel for this: `ChatResult.metadata`, later available from `ChatResponseTurn.result`. `LanguageModelChatProvider` does not currently expose an equivalent response metadata channel or a stable chat/session id in `ProvideLanguageModelChatResponseOptions`.

To keep the provider path usable, Cocopi emits the completed Responses `response.id` as a `LanguageModelDataPart` with MIME type `stateful_marker`, encoded as `modelId\responseId`. When VS Code includes that data part in later `LanguageModelChatRequestMessage.content`, Cocopi decodes the latest marker for the active model, sends it as `previous_response_id`, and includes only the post-marker request history. This matches the VS Code/Copilot stateful marker path; the behavior still needs real chat UI verification across retries, edits, forks, exports, and compaction.

### Chat Participant Fallback

- `[~]` Research notes for `vscode.chat.createChatParticipant` fallback.
- `[x]` Decide if fallback is needed before provider API is stable.
- `[x]` Create `@cocopi` participant handler.
- `[x]` Convert participant request to Codex Responses input.
- `[x]` Convert participant chat history to Codex Responses input.
- `[x]` Stream response text back to chat.
- `[x]` Report participant errors in VS Code-friendly form.
- `[x]` `@cocopi` defaults to VS Code's selected Cocopi model and uses `cocopi.model` only as a fallback or explicit override.

### Tool Bridge

- `[x]` Discover tool metadata provided on VS Code language model requests.
- `[x]` Translate VS Code tool schemas to Responses tools.
- `[x]` Invoke tools and stream results back into Codex in the `@cocopi` chat participant path.
- `[x]` Map Codex tool-call progress to VS Code chat progress in the `@cocopi` participant path.
- `[x]` Confirm provider-side tool follow-up is caller-owned; providers emit `LanguageModelToolCallPart` and consume later `LanguageModelToolResultPart` messages.

### Storage And Secrets

- `[x]` SecretStorage adapter for ChatGPT/Codex tokens.
- `[x]` In-memory fake SecretStorage for tests.
- `[x]` Runtime sign-in stores credentials in SecretStorage; `.env` remains development-only for scripts and live tests.
- `[x]` Token redaction helpers for logs/errors.

### Testing And Quality

- `[x]` Node test runner.
- `[x]` TypeScript checking for JavaScript.
- `[x]` ESLint with Unicorn.
- `[x]` Offline auth/request/model tests.
- `[x]` Live models smoke test.
- `[x]` Live Responses ISO datetime smoke test with AI response diagnostic.
- `[x]` Node activation wiring test for commands, provider, participant, and diagnostics registration.
- `[~]` Mocked streaming contract tests.
- `[~]` Cancellation tests.
- `[ ]` VS Code extension integration tests.
- `[x]` Cheap packaging validation with manifest checks and `npm pack --dry-run`.
- `[x]` VSIX packaging validation through package.json `files`, generated declarations, and `npm run package:vsix`.

## Next Implementation Slice

The next slice should verify provider continuity and cache behavior in the real VS Code chat UI:

1. Verify VS Code preserves Cocopi's custom `LanguageModelDataPart` across normal provider turns and provider tool follow-up turns.
2. Investigate prompt-cache key and retention behavior now that participant request prefixes are more stable across turns.
3. Add VS Code extension integration tests for participant metadata persistence in the real chat UI.
