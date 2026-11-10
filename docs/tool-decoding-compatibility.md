# Bridged tool decoding compatibility

## Evidence and scope

Renobot request 13 on 2026-11-09 UTC generated a `run_in_terminal`
argument object through a valid `mode` value, then emitted 16,374 consecutive
outside-string JSON whitespace characters in the retained provider capture.
The next fragment triggered the 16,384-character guard. The initial argument
prefix was empty; the terminal command was not executed. The incomplete object
was missing the required `timeout` field. Neither command contents nor raw
arguments are recorded here.

The request used low reasoning effort and `strict: true`. This is a confirmed
upstream compatibility mismatch, not proof of the backend's internal cause:
Codex `rust-v0.153.3` converts dynamic/MCP tool definitions with `strict: false`
in `tool_definition_to_responses_api_tool`:

<https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/tools/src/responses_api.rs>

## Change

- Default `cocopi.toolStrict` to false in both configuration reading and the
  contributed setting. Emit explicit `strict: false` through the existing tool
  options path, rather than omitting the wire property.
- Preserve original optional fields instead of applying strict-mode
  required-plus-null rewriting by default.
- Keep explicit configuration and request-level strict-mode opt-in supported.
- Treat non-strict decoding as the supported upstream-compatible mode in the
  dashboard, not a degraded feature.
- Preserve the whitespace guard, cancellation, tool-result validation, host
  approvals, and no-automatic-replay policy. Do not fabricate a completed tool
  call by closing unfinished JSON or supplying the missing field.

Existing explicit `cocopi.toolStrict: true` settings continue to opt into strict
decoding; this source change does not modify user settings or reload/install
running extension instances.

## Validation and remaining uncertainty

Offline regressions first fail against the prior defaults, then pass unchanged
after the correction. They cover the actual configuration-to-wire tool bridge,
optional-field preservation, strict request overrides, and manifest default.
They establish wire compatibility, **not** that a nondeterministic remote model
will never generate whitespace again. No paid generation is replayed for this
test. A new authorized live request is required to evaluate remote recurrence.

The isolated staged snapshot passed `npm run check`, `npm run lint`, and all
714 offline tests. The main worktree's unrelated concurrent preparation
profiler still has its previously identified type/lint errors; those changes
were excluded from this validation snapshot.