# Cocopi Research

## Objective

Build a hyperfocused VS Code extension that bridges VS Code chat model surfaces to remote Codex/OpenAI APIs directly. Cocopi is only for Codex-backed model access. It must not require the Codex CLI, the Codex IDE extension, or a local `codex app-server` process to be installed.

Author source in plain Node.js JavaScript. TypeScript is only for validation and declaration generation through `allowJs`, `checkJs`, and `tsc --emitDeclarationOnly`.

## Correct Boundary

The extension is not a wrapper around local Codex. It is a network client and protocol bridge:

```text
VS Code language model chat API
  -> Cocopi extension
  -> remote Codex/OpenAI APIs
  -> streamed model/tool events back to VS Code chat
```

No spawning `codex`. No checking for local CLI. No reading `~/.codex` as the primary path. No cloning or reimplementing the internal Rust `codex app-server` / webserver protocol. Any local config should be extension config only.

## Project Style Notes

The reference projects favor:

- Plain JavaScript source with `"type": "module"` where practical.
- `tsconfig.json` validating JS with `allowJs`, `checkJs`, `strict`, and generated declarations.
- Small top-level folders by concern, such as `lib`, `server`, `utils`, `test`, `types`, `docs`.
- Minimal runtime dependencies and scripts that call direct `node ...` entry points.
- Generated artifacts kept separate from handwritten source.

For this extension, keep that style while allowing a thin VS Code compatibility entry if the extension host requires CommonJS packaging for the activated entry point.

## VS Code Extension And Chat Surfaces

A VS Code extension is driven by `package.json` metadata and an activation module:

- `main` points to the extension entry, commonly `./extension.js` or bundled output.
- `activationEvents` control when the extension loads.
- `contributes.commands` exposes setup/status commands.
- The extension entry exports `activate(context)` and optional `deactivate()`.

The likely VS Code chat-facing API is:

1. `vscode.lm.registerLanguageModelChatProvider(vendor, provider)` plus `contributes.languageModelChatProviders`
   - Preferred path if available in the target VS Code build.
   - Makes Codex appear as a selectable language model provider.
   - The provider exposes model metadata and implements request streaming.

2. `vscode.chat.createChatParticipant(id, handler)`
   - Fallback if language model provider APIs are still proposed or not publishable.
  - Creates an `@codex` participant that sends requests to remote Codex/OpenAI APIs directly.

3. `vscode.lm.selectChatModels(selector)`
  - Useful for consuming existing models, but not the core path for making Codex available.

Possible `package.json` contribution:

```json
{
  "contributes": {
    "languageModelChatProviders": [
      {
        "vendor": "codex",
        "displayName": "Codex",
        "managementCommand": "cocopi.manage"
      }
    ],
    "commands": [
      {
        "command": "cocopi.manage",
        "title": "Manage Cocopi"
      }
    ]
  }
}
```

Important caveat: the provider API appears new/proposed. Verify VS Code version, proposal flags, and Marketplace publishing constraints before locking the public extension surface.

Current status as of 2026-05-13: Cocopi targets VS Code 1.120+ for the custom language model provider surface. The local `data/vscode-dts` proposal files include `LanguageModelChatProvider`, `LanguageModelChatInformation.configurationSchema`, `LanguageModelChatInformation.isUserSelectable`, `ProvideLanguageModelChatResponseOptions.modelConfiguration`, and `lm.registerLanguageModelChatProvider`. Cocopi implements the language model provider path against that 1.120 contract while keeping the `@cocopi` chat participant as a fallback/manual surface. Provider discovery exposes a generic configured model without requiring auth/network access, then refreshes model metadata from Codex `/models` at runtime when signed in. Cocopi exposes Codex catalog models as flat VS Code language model entries, marks them user-selectable for the active chat picker, and adds one `:fast` picker variant when the catalog reports the `fast` speed tier and no catalog fast variant already exists. Cocopi advertises one per-model `configurationSchema` navigation property, `reasoningEffort`, titled `Thinking Effort`; its enum values and descriptions come from the flat Codex reasoning levels supported by that model. Its schema default and request fallback use the catalog default reasoning effort when present, falling back to the highest supported effort only when the catalog omits a default. It does not encode summary or speed-tier choices into comma-separated `reasoningEffort` values. Global `cocopi.reasoningEffort`, `cocopi.reasoningSummary`, `cocopi.serviceTier`, and request-specific `modelConfiguration`/`modelOptions` remain available for non-picker request construction.

VS Code 1.120 source check: tag `1.120.0` keeps `configurationSchema` on provider-returned `LanguageModelChatInformation` entries and renders model configuration from schema properties. `src/vs/workbench/contrib/chat/browser/widget/input/chatModelSelectionLogic.ts` filters the active chat model picker to `isUserSelectable` models. `src/vs/workbench/contrib/chat/browser/widget/input/chatModelPicker.ts` resolves the first property whose `group` is `'navigation'` and whose `enum` has at least two entries, displays its `enumItemLabels`/`enumDescriptions`, marks the schema `default` as `(default)`, and calls `setModelConfiguration(modelIdentifier, { [config.key]: value })` on click. `src/vs/workbench/contrib/chat/common/languageModels.ts` stores per-model values in `chatLanguageModels.json`, removes a value when it equals the schema default, merges schema defaults with user overrides through `getModelConfiguration`, and forwards the resolved configuration to the provider as request `configuration`/`modelConfiguration`. There is no special VS Code parsing for comma-separated values or special collapse for a property named `reasoningEffort`.

## Definitive Sources

Use official documentation as the source of truth for shipped surfaces, and use OpenAI's Codex source only to understand implementation details that are not fully documented as direct remote APIs. The user has verified that direct ChatGPT/Codex token acquisition works for this project.

- VS Code extension API: `vscode.lm.registerLanguageModelChatProvider(vendor, provider)` registers a `LanguageModelChatProvider`; the extension must also declare the `languageModelChatProviders` contribution in `package.json`.
  - Source: VS Code API reference for `LanguageModelChatProvider` and `lm.registerLanguageModelChatProvider`.
- OpenAI Responses API: `POST /v1/responses`, streaming events, response input tokens, tool choices, and Responses WebSocket event models are documented in the OpenAI API reference.
  - Source: https://platform.openai.com/docs/api-reference/responses
- Codex authentication: Codex officially supports ChatGPT sign-in and API-key sign-in. Codex cloud requires ChatGPT sign-in; CLI and IDE support both ChatGPT and API key. Login details are cached locally and ChatGPT sessions refresh tokens during use.
  - Source: https://developers.openai.com/codex/auth
- Codex app-server account API: `account/login/start` documents `apiKey`, `chatgpt`, `chatgptDeviceCode`, and experimental `chatgptAuthTokens` modes. This is documentation for the local app-server JSON-RPC surface, not the remote API this extension should implement.
  - Source: https://developers.openai.com/codex/app-server
- Codex source details: the open-source CLI reveals underlying ChatGPT OAuth/device-code requests, token refresh, `CODEX_API_KEY`, `OPENAI_API_KEY`, and bearer-token handling. Use these as implementation references for our own clean-room JavaScript implementation.
  - Source: https://github.com/openai/codex
  - Relevant source files: `codex-rs/login/src/device_code_auth.rs`, `codex-rs/login/src/server.rs`, `codex-rs/login/src/auth/manager.rs`, `codex-rs/app-server-protocol/schema/typescript/v2/LoginAccountParams.ts`, and `codex-rs/app-server-protocol/schema/typescript/v2/LoginAccountResponse.ts`.
- Third-party forks: the user has looked at other forks, but this project should not copy code, structure, naming, or implementation details from them. They can inform what problems exist, not how this code is written.

## Remote APIs To Use

The Codex CLI code is useful only as a reference for how upstream hosted APIs are called. It is not a runtime dependency, and its internal Rust app-server/webserver is not something this extension should replicate.

The open-source Codex model layer talks to the OpenAI Responses endpoint directly:

- HTTP streaming path: `POST /v1/responses` with `Accept: text/event-stream`.
- WebSocket path: Responses WebSocket with `response.create` messages.
- Request body includes fields like `model`, `instructions`, `input`, `tools`, `tool_choice`, `parallel_tool_calls`, `reasoning`, `stream`, `include`, `service_tier`, `prompt_cache_key`, `text`, and `client_metadata`.
- Authentication is bearer-token based for API usage.
- Codex code also uses request headers such as `x-client-request-id`, conversation headers, `x-codex-turn-state`, `x-codex-turn-metadata`, `x-codex-installation-id`, and the Responses WebSocket beta header when that transport is enabled.

Initial implementation decision: use the ChatGPT/Codex backend base URL `https://chatgpt.com/backend-api/codex` with the Responses wire API for ChatGPT OAuth tokens. This mirrors Codex's provider behavior, where ChatGPT auth defaults the OpenAI provider base URL to the ChatGPT Codex backend instead of `https://api.openai.com/v1`. Use `gpt-5.5` as the first default model, while allowing `.env`/settings override through `CODEX_MODEL`.

Request/response types should live in acmejs-style JSDoc data files, not authored TypeScript. The primary official source for the generic request body is the OpenAI Responses API reference, and the official `openai` JavaScript SDK also publishes generated TypeScript declarations for public OpenAI APIs. Codex-specific model catalog and auth header conventions come from OpenAI Codex source, especially `codex-rs/protocol/src/openai_models.rs`, `codex-rs/codex-api/src/endpoint/models.rs`, and `codex-rs/model-provider/src/bearer_auth_provider.rs`.

The Codex cloud/task code talks to remote Codex task endpoints, including shapes like:

- Codex API style: `/api/codex/tasks`, `/api/codex/tasks/{id}`, `/api/codex/tasks/list`, `/api/codex/config/requirements`.
- ChatGPT backend style: `/wham/tasks`, `/wham/tasks/{id}`, `/wham/tasks/list`, `/wham/config/requirements`.

Those cloud endpoints appear tied to ChatGPT/Codex backend auth. Treat them as research targets until we verify which endpoints are needed for this extension's first useful behavior.

## Authentication Direction

There are two different auth stories, but this project should lead with ChatGPT/Codex auth:

- ChatGPT/Codex auth: the required first-class path for this extension. It uses browser OAuth by default, keeps device-code login as an optional fallback, stores OAuth tokens in extension-owned storage, and sends bearer tokens to Codex/OpenAI-compatible APIs.
- API-key / OpenAI platform auth: documented and useful as a later fallback, but not the initial setup path for this project.

For the first implementation, support extension-managed credentials in VS Code SecretStorage. Do not depend on Codex CLI login cache.

### Codex Token Acquisition

The implementation options are ordered by project priority:

1. Direct ChatGPT/Codex browser OAuth flow, source-derived from OpenAI Codex
  - The local setup command starts a localhost callback server at `/auth/callback` and opens `${issuer}/oauth/authorize` in the browser.
  - The authorization URL uses `response_type=code`, the Codex client id, localhost `redirect_uri`, scope `openid profile email offline_access api.connectors.read api.connectors.invoke`, PKCE `code_challenge`, `code_challenge_method=S256`, `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `state`, and `originator`.
  - The callback returns `code` and `state`; the implementation must reject state mismatches and OAuth callback errors.
  - The authorization code is exchanged at `POST https://auth.openai.com/oauth/token` using form data `grant_type=authorization_code`, `code`, localhost `redirect_uri`, `client_id`, and `code_verifier`.
  - This is the default because ChatGPT Security Settings can disable device-code authorization.

2. Direct ChatGPT/Codex device-code flow, verified by the user and source-derived from OpenAI Codex
  - Codex source requests a user code with `POST https://auth.openai.com/api/accounts/deviceauth/usercode`, body `{ "client_id": "app_EMoamEEZ73f0CkXaXp7hrann" }`.
  - It shows the user `https://auth.openai.com/codex/device` and the returned code.
  - Codex source polls `POST https://auth.openai.com/api/accounts/deviceauth/token`, body `{ "device_auth_id": "...", "user_code": "..." }` until it receives an authorization code plus PKCE verifier/challenge.
  - Codex source exchanges that code at `POST https://auth.openai.com/oauth/token` using form data `grant_type=authorization_code`, `code`, `redirect_uri=https://auth.openai.com/deviceauth/callback`, `client_id`, and `code_verifier`.
  - The token response contains `id_token`, `access_token`, and `refresh_token`.
  - Codex source refreshes managed ChatGPT tokens at `POST https://auth.openai.com/oauth/token` with `grant_type=refresh_token`, `client_id`, and `refresh_token`.
  - Cocopi refreshes expired SecretStorage access tokens before runtime requests when the stored access token has an expired JWT `exp` claim, then writes the refreshed token set and updated plan metadata back to SecretStorage. If a Codex `/models` or `/responses` request races token expiry and receives a 401, the VS Code provider/participant path refreshes the stored token set and retries the request once.
  - Codex source also has an ID-token exchange for an API-key-style access token using `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `requested_token=openai-api-key`, `subject_token=<id_token>`, and `subject_token_type=urn:ietf:params:oauth:token-type:id_token`.
  - Device-code login can fail with a disabled-device-code policy and should direct users to the browser callback flow.

3. Codex app-server auth API, documented but out of process for this project
   - `account/login/start` supports `{ "type": "apiKey", "apiKey": "sk-..." }`.
   - `account/login/start` supports `{ "type": "chatgpt" }` and returns `authUrl` for the browser flow.
   - `account/login/start` supports `{ "type": "chatgptDeviceCode" }` and returns `verificationUrl` plus `userCode`.
   - This confirms the auth model, but we should not call this API by spawning or embedding the app-server.

4. User-provided API key fallback
  - Keep this as a possible later fallback for users who explicitly want platform billing.
  - This is not the setup path we are building first.

Implementation rule: implement the direct ChatGPT/Codex browser OAuth and device-code flows ourselves in plain JavaScript from first principles, using official docs and OpenAI Codex source as references. Do not copy or translate code from third-party forks.

Credential storage rule: store ChatGPT/Codex OAuth tokens only in VS Code SecretStorage at extension runtime. Local `.env` is only for developer live tests. Never write a Codex-compatible `auth.json`, and never read third-party fork credentials.

Open questions:

- Whether Codex cloud task APIs are officially available for third-party extension clients.
- Which Codex-specific model ids and server-side capabilities should be exposed.

## Tool Translation Direction

VS Code language model requests can include `options.tools`, each with a name, description, and JSON schema. The direct Responses API also supports `tools`, tool choice, and tool-call events.

Initial translation should be narrow:

1. Convert VS Code `LanguageModelChatTool` metadata to Responses API tool definitions.
2. Stream model output from SSE/WebSocket events back as VS Code response parts.
3. When Codex requests a tool call, invoke the matching VS Code tool if it is registered and permitted.
4. Send tool results back to the Responses API using the expected follow-up input/tool-result shape.
5. Preserve request/session identity with generated conversation ids and request ids.

Do not introduce a generic provider framework. The code should be named around Codex and optimized only for the remote Codex/OpenAI API surface we actually call.

Current status: Cocopi maps VS Code request `tools` to Responses `function` tools, maps VS Code tool mode `Required` to Responses `tool_choice: "required"`, emits `LanguageModelToolCallPart` for finalized function-call events, and serializes prior VS Code tool calls/results back into Responses `function_call` and `function_call_output` input items. VS Code's provider contract states that when a provider returns `LanguageModelToolCallPart`, the caller is responsible for invoking the tool and then sending an assistant tool-call message followed by a user tool-result message. That means Cocopi's language model provider should not call `vscode.lm.invokeTool`; it should emit tool-call parts and consume later tool-result parts, which is the flow currently implemented. The `@cocopi` chat participant is different because it receives `ChatRequest.toolInvocationToken`, so it invokes attached VS Code tools through `vscode.lm.invokeTool`, sends the tool results back through a follow-up Responses request, and streams the final answer.

Tool permission and confirmation UX should remain owned by VS Code tools. The `LanguageModelToolInvocationOptions.toolInvocationToken` docs state that passing the chat request token shows the tool invocation in the correct chat conversation, automatically shows a progress bar, and displays inline confirmation UI when the invoked tool's `prepareInvocation` returns `confirmationMessages`. Cocopi should therefore pass the token through and avoid adding its own separate confirmation prompt around registered VS Code tools.

## Proposed Minimal Architecture

```text
extension.js or extension.cjs
lib/
  codex-auth.js            # SecretStorage credentials and direct Codex OAuth/device-code flow
  codex-client.js          # direct HTTP/SSE client for /v1/responses
  codex-websocket.js       # optional Responses WebSocket transport
  codex-events.js          # parse Responses SSE/WS events into internal events
  codex-model-provider.js  # VS Code LanguageModelChatProvider adapter
  tool-bridge.js           # VS Code tool specs/results <-> Responses API tools/results
  config.js                # model, endpoint, auth, transport settings
  ids.js                   # conversation/request/session id helpers
test/
  *.test.js
types/
docs/
```

Keep `extension.js` tiny. Most behavior should live in focused modules under `lib`.

## First Implementation Milestones

1. Create plain-JS VS Code extension scaffold with `checkJs` validation.
2. Register the Codex language model provider if the API is available in the target VS Code build.
3. Add extension settings for endpoint, model id, preferred auth mode, and credential status.
4. Implement `codex-auth.js` with direct ChatGPT/Codex browser OAuth and optional device-code fallback in VS Code SecretStorage.
5. Implement token refresh for ChatGPT/Codex OAuth tokens.
6. Implement `codex-client.js` for `POST /v1/responses` streaming SSE.
7. Convert `LanguageModelChatRequestMessage[]` into Responses `instructions` and `input`.
8. Convert streamed Responses events into VS Code text response parts.
9. Handle cancellation with `AbortController`.
10. Add the narrow VS Code tool bridge.
11. Add optional WebSocket transport only after HTTP/SSE is stable.
12. Investigate Codex cloud task APIs separately and only add them if needed for this use.

## Explicit Non-Goals

- Do not require `codex` on PATH.
- Do not spawn `codex exec`.
- Do not spawn `codex app-server`.
- Do not replicate the internal Codex CLI Rust app-server/webserver.
- Do not depend on `~/.codex/auth.json` as an auth mechanism.
- Do not write a Codex-compatible `auth.json`.
- Do not copy or translate code from third-party forks.
- Do not build a generic OpenAI/custom-provider framework.
- Do not implement local sandboxing or local command execution as part of the bridge.

## Open Questions

- Whether Marketplace publishing is possible with the current custom model provider API.
- Whether Codex cloud task APIs are public/stable enough for this extension.
- Whether an API-key fallback is worth adding after ChatGPT/Codex login works.
- How much chat context history arrives in `LanguageModelChatRequestMessage[]`, and how faithfully it should be replayed into Codex.
- Which Responses event types must be translated for first useful behavior beyond text deltas and tool calls.

## Current Recommendation

Continue with the clean-room plain JavaScript VS Code extension as a direct remote Codex provider. The preferred surface is now the VS Code language model provider, with `@cocopi` retained as a manual fallback. Keep provider discovery generic and cheap at compile/activation time, refresh signed-in model metadata from `/models` at runtime, and send chat requests directly to the Responses API. Treat Codex cloud task APIs as a second research track unless they are needed for the core chat/model bridge.
