![Cocopi — Codex-backed chat models for VS Code](./media/promo.png)

# Cocopi

Bring Codex-backed ChatGPT models into VS Code Chat.

Cocopi is an unofficial VS Code extension for using ChatGPT/Codex-backed models from the editor. It adds Cocopi models to the VS Code Chat model picker, provides an `@cocopi` chat participant, and includes local status, token, cache, and diagnostics views to help you understand what happened during a request.

Use Cocopi when you want Codex-style responses without leaving VS Code: ask coding questions, review files, continue a debugging conversation, or compare model behavior from the same Chat interface you already use.

## Highlights

- **Use Cocopi from VS Code Chat** — pick a Cocopi model in the Chat model selector or mention `@cocopi` directly.
- **Sign in from the editor** — complete the browser sign-in flow and keep runtime credentials in VS Code SecretStorage.
- **Tune response behavior** — choose reasoning effort, reasoning summaries, service tier, and transport settings.
- **Track local usage** — review token usage, prompt-cache behavior, selected model, service tier, and transport details in Token Tracker.
- **Diagnose safely** — inspect redacted local diagnostics when requests fail or backend responses look unexpected.
- **Stay in flow** — use the Cocopi status-bar item for sign-in state, usage status, and quick access to Cocopi actions.

## Requirements

- VS Code with the chat model provider support used by this extension. See `package.json` for the current engine range.
- A signed-in account with access to the ChatGPT/Codex backend services Cocopi uses.
- Internet access for authentication and model requests.

Backend availability, model access, rate limits, and exact capabilities depend on the signed-in account and upstream service behavior.

## Get started

1. Install Cocopi from a VSIX package or a published build.
2. Run **Cocopi: Sign In** from the command palette.
3. Complete the browser sign-in flow.
4. Open VS Code Chat and pick a Cocopi model, or type `@cocopi` in chat.
5. Use the Cocopi status-bar item to check sign-in state, usage status, Token Tracker, and Diagnostics.

## Everyday use

### Pick a Cocopi model

Open VS Code Chat and select a Cocopi model from the model picker. If no Cocopi model is selected, Cocopi can fall back to the configured `cocopi.model` value.

### Ask `@cocopi`

Mention `@cocopi` in chat when you want a direct Cocopi response without changing the active chat model. By default, `@cocopi` uses the selected Cocopi model when available and falls back to `cocopi.model` otherwise.

### Check status and usage

Hover the Cocopi status-bar item for a quick status summary. Click it to open a management menu with sign-in, status, Token Tracker, and Diagnostics actions.

### Review local diagnostics

Diagnostics are intended for troubleshooting extension behavior. They are stored locally, redact credentials, and can be disabled with `cocopi.issueTracking`.

## Commands

| Command | Description |
| --- | --- |
| `Cocopi: Sign In` | Starts browser OAuth and stores credentials in VS Code SecretStorage. |
| `Cocopi: Sign Out` | Clears stored Cocopi credentials and closes reusable Codex WebSocket sessions. |
| `Cocopi: Show Status` | Shows sign-in state, fallback model, usage-limit status, and tracker actions. |
| `Cocopi: Set Fallback Model` | Sets `cocopi.model`, used when no selected Cocopi model is available. |
| `Cocopi: Show Token Tracker` | Opens local token, cache, model, reasoning, transport, and usage-limit summaries. |
| `Cocopi: Show Diagnostics` | Opens local redacted diagnostics for runtime anomalies. |
| `Manage Cocopi` | Opens the compact Cocopi management menu. |

## Settings

### Common settings

| Setting | Default | Description |
| --- | --- | --- |
| `cocopi.model` | `gpt-5.5` | Fallback Codex model id. |
| `cocopi.chatParticipantModelSource` | `selected` | Whether `@cocopi` uses VS Code's selected Cocopi model or the configured fallback. |
| `cocopi.reasoningEffort` | `default` | Reasoning effort for Cocopi requests: `default`, `none`, `minimal`, `low`, `medium`, `high`, or `xhigh`. |
| `cocopi.reasoningSummary` | `default` | Reasoning summary behavior: `default`, `auto`, `off`, `concise`, or `detailed`. |
| `cocopi.serviceTier` | `auto` | Processing tier override: `auto`, `flex`, or `priority`. |
| `cocopi.transport` | `websocket` | Responses transport: `websocket` or `sse`. |
| `cocopi.tokenTracking` | `true` | Enables local Token Tracker entries. |
| `cocopi.issueTracking` | `true` | Enables local Diagnostics entries. |
| `cocopi.debugLevel` | `off` | Controls output-channel diagnostics. `payloads` can include prompt and output text; credentials are still redacted. |

### Advanced settings

| Setting | Default | Description |
| --- | --- | --- |
| `cocopi.apiBaseUrl` | `https://chatgpt.com/backend-api/codex` | Base URL for the ChatGPT Codex backend API. |
| `cocopi.authMode` | `secretStorage` | Credential source for runtime requests. |
| `cocopi.chatInstructions` | empty | Additional instructions to apply to Cocopi chat requests. |
| `cocopi.chatInstructionsMode` | `optional` | How to merge `cocopi.chatInstructions` with built-in chat instructions: `optional`, `replace`, `append`, or `regex`. |
| `cocopi.chatInstructionsRegexPattern` | empty | Pattern used when `cocopi.chatInstructionsMode` is `regex`. |
| `cocopi.chatInstructionsRegexReplacement` | empty | Replacement text used when `cocopi.chatInstructionsMode` is `regex`. |
| `cocopi.chatInstructionsRegexFlags` | `g` | Regex flags used with `cocopi.chatInstructionsRegexPattern`. |
| `cocopi.editProgressIntervalMs` | `30000` | Elapsed-time edit progress cadence in milliseconds. Set `0` to disable timed edit progress. |
| `cocopi.streamIdleTimeoutMs` | `120000` | Stream idle timeout in milliseconds. Set `0` to disable. |
| `cocopi.useModelDefaultCompactionLimit` | `true` | Uses the model-provided auto-compaction limit when available. |
| `cocopi.compactionFallbackStrategy` | `ninety-percent` | Fallback compaction threshold when no model-provided limit is available. |

## Privacy and storage

- Runtime credentials are stored in **VS Code SecretStorage**.
- Token Tracker and Diagnostics are private local extension data.
- Cocopi redacts credentials from diagnostics and debug output.
- Cocopi does not intentionally log bearer tokens, refresh tokens, ID tokens, or raw credentials.
- `cocopi.debugLevel: payloads` can log prompt and output payload text. Keep it off unless debugging locally.
- `.env` is only for local development and live smoke tests; it is not used as runtime extension storage.

## Troubleshooting

- If requests fail after a successful sign-in, run **Cocopi: Show Status** to check usage-limit and fallback-model state.
- If chat hangs, adjust `cocopi.streamIdleTimeoutMs` or switch `cocopi.transport` between `websocket` and `sse`.
- If a selected model is not used by `@cocopi`, check `cocopi.chatParticipantModelSource`.
- If you need detailed request diagnostics, temporarily set `cocopi.debugLevel` to `metadata` or `events`. Use `payloads` only for local debugging because it can include prompt and output text.

## Support

If Cocopi has helped your workflow, consider supporting the project so tools like this can keep existing.

- [Ko-fi](https://ko-fi.com/shortfuse)
- [Patreon](https://www.patreon.com/c/CLShortFuse)

## Development from source

Install dependencies:

```powershell
npm install
```

Run validation:

```powershell
npm run check
npm run lint
npm test
npm run validate
```

Package a VSIX:

```powershell
npm run package:vsix
```

The packaged extension is written to `out/cocopi-<version>.vsix`.

Regenerate PNG artwork and the status icon font from the SVG sources with:

```powershell
npm run assets:render
```

## Notes

Cocopi targets Codex-backed ChatGPT backend behavior and follows upstream Codex wire semantics where practical. Cocopi is not an official Microsoft, GitHub, or OpenAI extension.
