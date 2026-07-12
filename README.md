![Cocopi — Codex-backed chat models for VS Code](./media/promo.png)

# Cocopi

Bring Codex-backed ChatGPT models into VS Code Chat.

Cocopi is an unofficial VS Code extension for using ChatGPT/Codex-backed models from the editor. It adds Cocopi models to the VS Code Chat model picker, provides an `@cocopi` chat participant, and includes local status, token, cache, and diagnostics views to help you understand what happened during a request.

Use Cocopi when you want Codex-style responses without leaving VS Code: ask coding questions, review files, continue a debugging conversation, or compare model behavior from the same Chat interface you already use.

## Highlights

- **Use Cocopi from VS Code Chat** — pick a Cocopi model in the Chat model selector or mention `@cocopi` directly.
- **Opt in to AI autocomplete** — enable Cocopi inline completions and choose a dedicated low-latency model for ghost text.
- **Sign in from the editor** — complete the browser sign-in flow and keep runtime credentials in VS Code SecretStorage.
- **Tune response behavior** — choose reasoning effort, context size, reasoning summaries, service tier, and transport settings.
- **Track local usage** — review token usage, prompt-cache behavior, selected model, service tier, and transport details in Token Tracker.
- **Diagnose safely** — inspect redacted local diagnostics when requests fail or backend responses look unexpected.
- **Stay in flow** — use the Cocopi status-bar item for sign-in state, usage status, and quick access to Cocopi actions.

## Requirements

- VS Code 1.126+ with the chat model provider support used by this extension. See `package.json` for the current engine range.
- A signed-in account with access to the ChatGPT/Codex backend services Cocopi uses.
- Internet access for authentication and model requests.

Backend availability, model access, rate limits, and exact capabilities depend on the signed-in account and upstream service behavior.

## Get started

1. Install Cocopi from a VSIX package or a published build. In VS Code 1.126+, published model-provider builds can also be found from the Language Models editor's **Install Model Providers** search.
2. Run **Cocopi: Sign In** from the command palette.
3. Complete the browser sign-in flow.
4. Open VS Code Chat and pick a Cocopi model, or type `@cocopi` in chat.
5. Optional: hover the Cocopi status-bar icon for a compact summary and quick links. Click the icon to open the richer Cocopi dashboard with card-style status and configuration actions. In VS Code builds with the proposed Chat status item API, Cocopi also mirrors the same summary into the native Chat/Copilot status dashboard. Open **Inline Options** for expanded autocomplete controls.
6. Use the Cocopi status-bar item to check sign-in state, usage status, Token Tracker, and Diagnostics.

## Everyday use

### Pick a Cocopi model

Open VS Code Chat and select a Cocopi model from the model picker. If no Cocopi model is selected, Cocopi can fall back to the configured `cocopi.model` value.

In VS Code 1.126+, Cocopi model entries participate in the unified model customization picker. Models with Codex reasoning metadata show **Thinking Effort** options, and models expose **Context Size** choices only when the signed-in Codex catalog advertises them, such as a lower recommended auto-compaction limit or a larger `max_context_window` than the default `context_window`.

### Ask `@cocopi`

Mention `@cocopi` in chat when you want a direct Cocopi response without changing the active chat model. By default, `@cocopi` uses the selected Cocopi model when available and falls back to `cocopi.model` otherwise.

### Check status and usage

Hover the Cocopi status-bar item for a compact status summary. Click it to open the richer Cocopi dashboard with card-style status and configuration actions. The **Instruction replacements** workbench shows the latest host instructions and tool description captured in extension-host memory, lets you paste alternate text, and previews regex rules while you toggle or edit them before applying the corresponding Cocopi settings. On VS Code versions that require an explicit utility-model choice for BYOK agents, the dashboard explains the available routing options and can apply the selected VS Code configuration.

### Use AI inline completions

Hover the Cocopi status-bar icon for a compact account/model/usage summary plus quick links to the dashboard, Token Tracker, and Diagnostics. Click the icon to open the richer Cocopi dashboard with card-style status and configuration actions; VS Code builds with the proposed Chat status item API also mirror that summary in the native Chat/Copilot status dashboard. **Inline Options** expands autocomplete controls for Cocopi context-budget settings, VS Code's native inline-suggest setting, and event debug logs. You can also run **Cocopi: Toggle Inline Completions** from the command palette, or use **Manage Cocopi** → **Toggle Inline Completions**, to enable or disable Cocopi ghost-text completions. The command shows a small confirmation popup after changing the setting. You can also set `cocopi.inlineCompletions.enabled` directly in Settings.

Run **Cocopi: Set Inline Completion Model** to choose the autocomplete model. If inline completions are disabled, the command offers an **Enable Now** popup action. The default `auto` mode prefers a Spark-like low-latency model from the signed-in account's model catalog when one is available, then falls back to `cocopi.model`. VS Code's own `editor.inlineSuggest.enabled` setting must also allow inline suggestions.

For testing, set `cocopi.debugLevel` to `events` or `payloads` and open the **Cocopi** output channel. Inline completion attempts log request metadata, selected model, context sizes, and stream event types. `payloads` also logs request/event payloads and can include surrounding editor text.

### Review local diagnostics

Diagnostics are intended for troubleshooting extension behavior. They are stored locally, redact credentials, and can be disabled with `cocopi.issueTracking`.

## Commands

| Command | Description |
| --- | --- |
| `Cocopi: Sign In` | Starts browser OAuth and stores credentials in VS Code SecretStorage. |
| `Cocopi: Sign Out` | Clears stored Cocopi credentials and closes reusable Codex WebSocket sessions. |
| `Cocopi: Show Status` | Shows sign-in state, fallback model, usage-limit status, and tracker actions. |
| `Cocopi: Set Fallback Model` | Sets `cocopi.model`, used when no selected Cocopi model is available. |
| `Cocopi: Set Inline Completion Model` | Sets `cocopi.inlineCompletions.model`, used by Cocopi AI autocomplete. |
| `Cocopi: Show Inline Completion Options` | Opens expanded inline autocomplete controls for state, model, settings, and debug logging. |
| `Cocopi: Toggle Inline Completions` | Enables or disables Cocopi AI autocomplete with a confirmation popup. |
| `Cocopi: Show Token Tracker` | Opens local token, cache, model, reasoning, transport, and usage-limit summaries. |
| `Cocopi: Show Diagnostics` | Opens local redacted diagnostics for runtime anomalies. |
| `Manage Cocopi` | Opens the compact Cocopi management menu. |

## Settings

### Common settings

| Setting | Default | Description |
| --- | --- | --- |
| `cocopi.model` | `gpt-5.5` | Fallback Codex model id. |
| `cocopi.chatParticipantModelSource` | `selected` | Whether `@cocopi` uses VS Code's selected Cocopi model or the configured fallback. |
| `cocopi.reasoningEffort` | `default` | Reasoning mode for Cocopi requests: `default`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`. Ultra sends `max` on the wire but, unlike Max, adds proactive VS Code `runSubagent` policy and parallel independent delegation when the tool and model catalog permit it. The custom `@cocopi` participant keeps the real tool optionally available at other efforts without enabling that Ultra policy. |
| `cocopi.reasoningSummary` | `auto` | Reasoning summary behavior: `auto`, `model-default`, `off`, `concise`, or `detailed`. |
| `cocopi.serviceTier` | `auto` | Processing tier override: `auto`, `flex`, or `priority`. |
| `cocopi.transport` | `websocket` | Responses transport: `websocket` or `sse`. |
| `cocopi.tokenTracking` | `true` | Enables local Token Tracker entries. |
| `cocopi.issueTracking` | `true` | Enables local Diagnostics entries. |
| `cocopi.debugLevel` | `off` | Controls output-channel diagnostics. `payloads` can include prompt and output text; credentials are still redacted. |

### Inline completion settings

| Setting | Default | Description |
| --- | --- | --- |
| `cocopi.inlineCompletions.enabled` | `false` | Enables Cocopi AI autocomplete. Kept opt-in because it sends editor context as you type. |
| `cocopi.inlineCompletions.model` | `auto` | Autocomplete model id. `auto` prefers a Spark-like model from the catalog when available, then falls back to `cocopi.model`. |
| `cocopi.inlineCompletions.maxPrefixCharacters` | `6000` | Maximum characters before the cursor sent as completion context. |
| `cocopi.inlineCompletions.maxSuffixCharacters` | `2000` | Maximum characters after the cursor sent as completion context. |
| `cocopi.inlineCompletions.timeoutMs` | `10000` | Inline completion stream idle timeout. Set `0` to disable this timeout. |

### Advanced settings

| Setting | Default | Description |
| --- | --- | --- |
| `cocopi.apiBaseUrl` | `https://chatgpt.com/backend-api/codex` | Base URL for the ChatGPT Codex backend API. |
| `cocopi.authMode` | `secretStorage` | Credential source for runtime requests. |
| `cocopi.chatInstructions` | empty | Custom instructions to apply to Cocopi chat requests. |
| `cocopi.chatInstructionsPlacement` | `append` | How to place `cocopi.chatInstructions`: append to source instructions, replace source instructions, or turn custom instructions off. |
| `cocopi.chatRegexFlags` | `g` | Regex flags used with Cocopi chat instruction and tool description replacement maps. |
| `cocopi.chatInstructionsRegexReplacements` | built-in regex map | Regex pattern-to-replacement entries always applied to chat instruction text. User entries add patterns or override defaults by using the same pattern key. Empty replacement text removes matches for a custom pattern; set a default pattern to empty text to disable that built-in replacement. |
| `cocopi.chatToolDescriptionRegexReplacements` | built-in regex map | Regex pattern-to-replacement entries always applied to VS Code tool descriptions. User entries add patterns or override defaults by using the same pattern key. Empty replacement text removes matches for a custom pattern; set a default pattern to empty text to disable that built-in replacement. |
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
- Inline completions are opt-in because they send limited surrounding editor text to the selected Codex model as you type.
- `.env` is only for local development and live smoke tests; it is not used as runtime extension storage.

## Troubleshooting

- If requests fail after a successful sign-in, run **Cocopi: Show Status** to check usage-limit and fallback-model state.
- If chat hangs, adjust `cocopi.streamIdleTimeoutMs` or switch `cocopi.transport` between `websocket` and `sse`.
- If a selected model is not used by `@cocopi`, check `cocopi.chatParticipantModelSource`.
- If inline completions do not appear, run **Cocopi: Toggle Inline Completions**, ensure VS Code's `editor.inlineSuggest.enabled` is enabled, then run **Cocopi: Set Inline Completion Model**. Set `cocopi.debugLevel` to `events` to confirm requests appear in the **Cocopi** output channel.
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

Nightly GitHub prereleases are created by `.github/workflows/nightly-release.yml`. The workflow packages a VSIX and skips itself when there are no commits since the latest `nightly-*` prerelease.

Regenerate PNG artwork and the status icon font from the SVG sources with:

```powershell
npm run assets:render
```

## Maintainer docs

If you are working on Cocopi itself and need the rationale behind bridge behavior or host-specific workarounds, start with these docs:

- [docs/cocopi-local-semantics.md](./docs/cocopi-local-semantics.md) for Cocopi-specific behavior, heuristics, host quirks, and rationale.
- [docs/previous-response-continuation.md](./docs/previous-response-continuation.md) for `previous_response_id`, replay restoration, and continuation decisions.
- [docs/compaction-strategy.md](./docs/compaction-strategy.md) for VS Code compaction behavior and parity goals.
- [docs/testing.md](./docs/testing.md) for validation scope and test commands.
- [docs/construction-plan.md](./docs/construction-plan.md) for broader implementation constraints and project direction.

## Notes

Cocopi targets Codex-backed ChatGPT backend behavior and follows upstream Codex wire semantics where practical. Cocopi is not an official Microsoft, GitHub, or OpenAI extension.
