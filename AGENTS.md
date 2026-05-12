# Project Guidelines

## Project Context
Cocopi is a VS Code extension that provides a Codex-backed chat model provider for VS Code Chat. Keep changes tightly focused on extension behavior, testability, and authentication/safety flow reliability.

## Code Style
- Author production source in plain Node.js JavaScript (ESM modules). Do not add authored TypeScript source files.
- Keep code minimal and compositional; avoid unnecessary abstractions.
- Use existing project patterns with JSDoc + `checkJs` type guidance and ESLint/JSDoc rules.
- Favor platform APIs (`fetch`, `URL`, `AbortController`, streams, etc.) where practical.

## Architecture
- `lib/`: API/auth/network contracts and shared domain helpers.
- `vscode/`: VS Code host integration and registration glue.
- `scripts/`: local utilities and manual smoke tooling.
- `test/`: Node built-in test coverage for offline behavior first.
- `data/`: runtime data module surface.

## Build and Test
- After code changes, run:
  - `npm run check`
  - `npm run lint`
  - `npm test`
- For release/major changes, run:
  - `npm run validate`
- Live API checks are opt-in only:
  - set local `.env` credentials as needed
  - tests use those credentials when present.

## Conventions
- Prefer offline-first, fixture-driven tests before remote behavior.
- Keep request construction and parsing deterministic and easy to unit test.
- Avoid changing public behavior unless covered by tests and explicit docs.
- For Codex UX and wire semantics, treat upstream Codex CLI / codex-cli-rs as the reference behavior and verify it before inventing local Cocopi semantics.
- Use existing docs for detailed behavior:
  - `docs/construction-plan.md`
  - `docs/testing.md`

## Security and Privacy
- Never commit or log auth tokens, bearer tokens, refresh tokens, or raw sensitive request payloads.
- Extension runtime should keep credentials in VS Code SecretStorage.
- Treat `.env` as local test-only input; do not expand repository usage of it for runtime state.

## Validation Scope
This file provides workspace-wide guidance only. It does not replace ESLint/TypeScript checks or runtime secrets policies enforced elsewhere.
