# Testing Strategy

## Goals

The test system should let us move quickly without leaking credentials or depending on third-party forks. Default tests run offline when no local credentials are present. Live ChatGPT/Codex tests are local-only and run when the developer provides a private `.env` with usable credentials.

## Test Layers

1. Static validation
   - `npm run check`
   - TypeScript validates plain JavaScript through `allowJs` and `checkJs`.
   - No authored TypeScript source.

2. Unit tests
   - `npm test`
   - Uses Node's built-in `node:test` runner.
   - No network calls.
   - Covers request shaping, SSE parsing, tool translation, token storage helpers, and auth state machines with fixtures.

3. Coverage
   - `npm run coverage`
   - Uses Node's built-in test coverage, scoped to `lib/**/*.js`.
   - Enforces minimum aggregate coverage of 90% lines, 75% branches, and 90% functions.
   - `npm run validate` runs coverage instead of plain `npm test` so coverage cannot silently regress.

4. Contract tests with mocked HTTP
   - Still run under `npm test` once added.
   - Mock the ChatGPT/Codex endpoints we call directly.
   - Verify headers, request bodies, streaming event parsing, cancellation, and token refresh behavior.

5. Usage/rate-limit status tests
   - Run under `npm test`.
   - Parse hand-written `/usage` responses and `codex.rate_limits` stream events.
   - Verify snapshots persist only in private local storage.
   - Verify status prefers API-backed limits and falls back to recent Token Tracker activity without asking for manual budgets.

6. Live smoke tests
   - Skipped when no private `.env` credentials are present.
   - Run when `.env` contains `CODEX_CHATGPT_ACCESS_TOKEN`.
   - Verify minimal connectivity, auth behavior, `/usage` rate-limit snapshots, and tiny Responses/WebSocket behavior.
   - Must never print bearer tokens, refresh tokens, user codes, or full response bodies that might contain private data.

## Private `.env`

Use `.env.example` as the template and copy it to `.env` for local testing. `.env` and `.env.*` are ignored by git.

Supported initial variables:

```text
COCOPI_AUTH_MODE=chatgpt_browser
CODEX_CHATGPT_ACCESS_TOKEN=
CODEX_CHATGPT_REFRESH_TOKEN=
CODEX_CHATGPT_ID_TOKEN=
CODEX_AUTH_ISSUER=https://auth.openai.com
CODEX_API_BASE_URL=https://chatgpt.com/backend-api/codex
CODEX_MODEL=gpt-5.5
```

Do not store production credentials in repository files. The extension runtime should store ChatGPT/Codex OAuth tokens in VS Code SecretStorage, not in `.env` and not in Codex-compatible `auth.json`.

## Clean-Room Rule

Tests may assert behavior described by official docs or OpenAI Codex source. Do not copy fixtures, helper names, module structure, or implementation details from third-party forks. If a third-party fork reveals a useful scenario, write a fresh test name and fixture from our own understanding.

## Near-Term Test Work

1. Add request-shape tests for `/v1/responses`.
2. Add SSE parser tests with hand-written event fixtures.
3. Add browser callback login tests for authorization URL generation, local callback parsing, state validation, and token exchange.
4. Add SecretStorage adapter tests using an in-memory fake.
5. Keep live smoke tests enabled automatically by private `.env` credentials.

Run live smoke tests after `npm run setup:codex-login` has written `.env`, then run `npm run test:live` or `npm test`. The live tests may call the remote models endpoint, the Codex `/usage` endpoint, and tiny streaming Responses requests. Output must stay redacted and limited to safe diagnostics such as model ids, rate-limit percentages, and the ISO datetime smoke response.

For a more meaningful manual stream check, run:

```powershell
npm run codex:stream
```

This command reads `.env`, sends a larger default prompt, and writes text deltas to stdout as they arrive. Use `npm run codex:stream -- --raw` to print each parsed SSE event as JSON, or `npm run codex:stream -- --prompt "write 120 numbered one-line test observations"` to provide a custom prompt.