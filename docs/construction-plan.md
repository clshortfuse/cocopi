# Construction Plan

## Principle

Build the extension from offline, testable modules first. VS Code integration should be a thin layer over code that can run under plain Node tests.

Codex CLI behavior is the minimum bar for Cocopi. Bridge code may adapt Codex semantics to VS Code, but it should not knowingly make cache continuity, context preservation, compaction reliability, or tool/reasoning replay worse than upstream Codex CLI without an explicit documented limitation and diagnostic evidence.

Use [feature-checklist.md](feature-checklist.md) as the running implementation checklist for Codex API features, VS Code chat features, and bridge gaps.

Use [cocopi-local-semantics.md](cocopi-local-semantics.md) as the inventory of Cocopi-specific bridge behavior, heuristics, diagnostics, and replacement preferences.

Use [previous-response-continuation.md](previous-response-continuation.md) as the design note for `previous_response_id` continuation, VS Code compaction replay, and related token/cache diagnostics.

Use [compaction-strategy.md](compaction-strategy.md) as the roadmap for VS Code-default compaction, future remote/custom compaction options, and Codex CLI parity gates.

## Phase 1: Local Auth Setup

Goal: make local live tests possible without touching VS Code APIs.

1. Test `.env` parsing and safe updates.
2. Add `npm run setup:codex-login` for ChatGPT/Codex login and persist returned tokens into `.env`.
3. Support browser callback login as the default setup flow because device-code authorization can be disabled in ChatGPT Security Settings.
4. Keep device-code login as an optional fallback for accounts where it is enabled.
5. Keep `.env` ignored by git and use it only for local live tests.
6. Use the presence of private `.env` credentials as the live test opt-in.

## Phase 2: Offline Client Contracts

Goal: define the network contract before real network calls.

1. Build request-shape helpers for `POST /v1/responses`.
2. Test authorization headers without printing secrets.
3. Test SSE parsing using handwritten fixtures.
4. Test cancellation with `AbortController` and mocked fetch.

## Phase 3: Live Smoke Tests

Goal: prove credentials and API shape with minimal remote calls.

1. Load `.env` and skip live tests only when required credentials are missing.
2. Verify the ChatGPT/Codex token can reach a harmless Codex-compatible endpoint.
3. Add a tiny Responses API smoke test after the request builder is stable.
4. Keep live test output redacted.

## Phase 4: Direct ChatGPT/Codex Auth

Goal: implement ChatGPT/Codex auth as tested state machines.

1. Mock browser callback authorization URL generation and callback parsing.
2. Mock `deviceauth/usercode`, `deviceauth/token`, and `oauth/token` for optional device-code login.
3. Test polling behavior, timeout, disabled device-code handling, and token refresh.
4. Persist test credentials to `.env` only for local CLI setup; extension runtime uses VS Code SecretStorage.
5. Do not read or write Codex-compatible `auth.json`.

## Phase 5: VS Code Shell

Goal: connect tested modules to the extension host.

1. Register management commands.
2. Add SecretStorage-backed credential adapter.
3. Register the VS Code language model provider once the API shape is confirmed.
4. Keep extension activation small and covered by integration tests later.
