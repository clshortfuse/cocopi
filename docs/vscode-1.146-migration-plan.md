# VS Code 1.146: Copilot-first migration

Status: **implementation and offline/package validation complete; live acceptance open**, 2026-11-12. Target VS Code **1.146**, with the built-in Copilot Agent Host harness as the primary Cocopi integration. Installed-host interactive and matching SDK runtime acceptance remain unperformed.

## Direction

- Plan for retirement of the Local extension-host harness; do not depend on its continued availability for core Cocopi functionality. The official 1.146 release notes announce deprecation/function freeze now and removal in February 2027.
- Treat Cocopi as a BYOK language-model provider under the built-in Copilot harness, not as a replacement harness or a native Codex session provider.
- Remove the legacy `@cocopi` participant as explicitly requested. Keep the separately registered Cocopi language-model provider, authentication, commands and supported provider features. Local-only tests and features do not establish migration acceptance.
- Carry forward the open findings in [the 1.144 migration](vscode-1.144-migration-plan.md); changing the target does not close them. Do not bump the engine minimum or claim 1.146 support before reviewing and validating the exact target.

## Priority: context-window and compaction policy

The context-window problem is a known **upstream Copilot BYOK defect**, not a missing Cocopi feature. The reviewed 1.146 bridge still loses Cocopi's context-size choices and lower default prompt/compaction preference while passing fixed capacity metadata to the SDK. See [the context-size assessment](context-size-support-assessment.md). This is a primary migration risk, not an optional picker enhancement. The new conservative reporting workaround does not repair upstream choice propagation.

1. Pin the exact 1.146 source and installed SDK/runtime; recheck upstream issue #333017 and PR #341913 rather than assuming either is still open or included.
2. Trace catalog total/default/maximum capacity, output reserve, default prompt budget, selectable context budgets and effective compaction policy through provider metadata, BYOK projection, SDK session creation, request routing and live model switching.
3. Verify that selected/default budgets reach the component assembling and compacting prompts. A provider-side wire field or metadata-only test cannot establish this.
4. Exercise default and extended contexts, models without context choices, restored sessions, model switches and long tool-heavy histories. Check that output reserves are respected and compaction happens before backend capacity rejection.
5. If host propagation remains absent, document the concrete discrepancy and evaluate a supported conservative fixed-budget fallback separately. Do not silently equate the model's physical capacity with its preferred compaction budget, invent billing metadata, multiply model IDs or alter global user preferences.

## Other migration gates

### Required Cocopi workaround: conservative context reporting

User requirement (2026-11-12): add a Cocopi option, enabled by default, that advertises and uses only the lowest catalog-backed context tier for Copilot BYOK while the upstream context-window bug remains. This is an intentional conservative workaround, not upstream context-choice parity.

- Keep physical catalog capacity separate from effective advertised capacity. Do not advertise an extended maximum that the host can select implicitly despite the conservative option.
- Keep total window, prompt budget and output reserve consistent within the lowest tier; preserve the lower default compaction/input budget in the fixed prompt limit where the host otherwise loses it.
- With the option enabled, omit larger context choices. Apply the same effective limits to all provider variants and package profiles rather than relying on an unavailable request-level harness discriminator.
- Allow explicit opt-out to restore catalog-backed extended context behavior, with a warning about the upstream limitation. Do not change stored preferences automatically.
- Cover default-enabled and explicit opt-out behavior, default/extended catalogs, maximum-only catalogs, missing metadata, output reserves and Fast variants with offline tests. Demonstrate the conservative-reporting regression fails before implementing the change.

- Verify real Copilot-harness model discovery, selection, reasoning configuration and Ultra behavior; preserve catalog-driven wire effort independently of proactive orchestration support.
- Test tools, permissions, cancellation, errors/retries, response/thinking continuity, authentication and reload/session continuity through the actual bridge. Track host-owned losses separately from Cocopi defects.
- Remove `@cocopi` registration, participant-only configuration and implementation, and document selecting a Cocopi model in the Copilot harness instead. Preserve shared provider helpers and stored conversations; do not claim that a custom agent recreates the participant or that old participant conversations automatically migrate.
- Validate full and Marketplace profiles separately; do not assume the Marketplace profile gains proposed BYOK registration or context capabilities.
- Add offline regression/source-contract coverage for demonstrated defects, then run type checking, lint, offline tests and extracted-package checks. Keep live backend and interactive host acceptance separately identified and explicitly authorized.

## Acceptance

1.146 support requires evidence from the pinned host and matching runtime, including Copilot-harness turns and effective context/compaction behavior. Passing Local tests, successful packaging or SDK declarations alone is insufficient. The manifest/lockfile now target `^1.146.0`; no host installation or restart is performed.

## Verified source checkpoint (2026-11-12)

- Installed VS Code: **1.146.0**, `69047191fc427f2f92828279aae1d90d8eeda7ab`. Fetched that object into the existing neighboring Git store without checkout or changes to its worktree. Baseline: `2c33b50b16c472efe58357d1d2a8a5414bc23fbf` (1.144).
- Installed application manifest: **Electron 43.8.6**. A separate task-owned Node-mode invocation verified **Node 24.22.1** and Electron 43.8.6 without interacting with the running editor. SDK metadata read passively from `node_modules.asar`: **`@github/copilot-sdk` 1.0.30-preview.0**, CLI/runtime **1.0.108-0**, runtime source **`0b6fd711aceb7d1b08736913111176774483cce6`**. This matches the pinned source dependency. No separate package Node engine is added.
- BYOK DTO and renderer handler have **no endpoint diff** from reviewed 1.144. The actual-source projection probe reproduces context-default loss and confirms the new fixed **64,000** prompt limit survives projection for a synthetic **100,000** lowest-tier fixture. This is not live SDK compaction validation.
- Reviewed target `synthesizeByokSessionConfig`: passes fixed total/prompt/output limits, deduplicates selection IDs and forwards vision support. Adjacent additive live sync retains withdrawn entries to avoid transient selection changes; a provider refresh alone does not prove an existing SDK session adopted new limits.
- Reviewed the full custom-agent converter: 1.146 uses URI-derived runtime names, retains authored names in `displayName`, and normalizes descriptions to one line. Scalar/array model selection, effort validation, all-tools semantics for empty arrays and omission of required model policy remain. Do not invent runtime hashes or infer a hashed task entry's model route. Existing name-matching guidance stays fail-safe: no match means no guidance.
- Extended `scripts/verify-sdk-host-contracts.js` to the pinned 1.146 revision. Actual extracted source checks pass for YAML/conversion, aliases/efforts, display names, empty tools, array fallback, policy omission, tool mapping/filtering, model readiness, identity, context loss/fixed projection, system/tool replay, reasoning state, cached-usage loss and policy refusal. Synthetic adapters are used; plugin-root URI materialization and proprietary runtime execution are not tested.
- Verified `capabilities.agentsWindow.supported` against the target manifest schema. Cocopi already declares it. Added workspace-less activation coverage without the participant API; retained optional-status failure coverage. Real virtual-repository tools and all Agents-window UI surfaces are not certified.
- Stable declaration deltas include unrelated timeline APIs; the five remaining enabled proposals have no endpoint changes. No new provider API adoption was demonstrated. Existing stable declaration snapshot remains; a full snapshot refresh is not represented as performed. Removed the participant-only binary-reference proposal/declaration.
- This is a scoped integration review, not an exhaustive 1.144–1.146 audit. Remote BYOK, proxy inheritance, live model switching, restored sessions and actual concurrent chat-window acceptance remain separate questions.

## Implementation checkpoint

- Removed participant contribution/registration, participant-only setting, history/reference modules and their tests. Kept provider registration, shared instruction/tool conversion, commands, auth and stored conversations.
- Added default-enabled `cocopi.lowestContextWindow`, fixed lowest-tier input reporting, explicit opt-out, configuration refresh and normal/Fast, maximum-only and small-window regression coverage.
- Four new regressions failed before the fix, then passed unchanged after it. Separate opt-out coverage preserves extended-context behavior; existing extended-context tests opt out explicitly.
- Final type check and lint passed. **807 offline tests passed**, zero failures/cancellations/skips; the entire credential-driven live module was excluded. Release coverage thresholds passed: **93.74% lines, 84.21% branches, 95.11% functions**.
- Full VSIX: **157 files, 535.09 KB**; Marketplace VSIX: **87 files, 315.44 KB**. Both builds, Marketplace isolation verification and both extracted-provider smoke checks passed. Artifact checks include participant/source absence, default conservative context and explicit extended opt-out. Package declaration generation and manifest validation passed.
- The pinned 1.146 source probe and previous 1.144 probe passed. Existing opaque conversation identity, worker concurrent-cancellation isolation, disposal, host tool outcome and SDK policy tests were retained rather than duplicated; routed utility metadata now also asserts the conservative tier/input budget.
- `npm run validate` was not invoked verbatim because its coverage glob loads credential-driven live tests. Equivalent type/lint/package checks and the same coverage thresholds were run with explicit offline file enumeration. No remote inference or editor installation/restart was performed. No changes were staged or committed.
- Formatting caveat: `git diff --check` still reports a trailing blank line at EOF in `lib/vscode/language-model-provider.js`. The patch editor retained that blank line despite attempted removal; no terminal file rewrite was used. This does not affect passing type/lint/tests or package smoke checks, but the whitespace gate is not claimed as passing.

## Planned commit sequence

These are logical implementation boundaries, not instructions to stage or commit the current working tree. Existing unrelated changes must remain untouched. Commits after the audit are conditional on demonstrated need; do not manufacture code changes for host-owned features.

### 1. `docs: audit VS Code 1.146 Copilot integration contracts`

- Pin installed target `69047191fc427f2f92828279aae1d90d8eeda7ab` and compare with reviewed 1.144 target `2c33b50b16c472efe58357d1d2a8a5414bc23fbf` without modifying neighboring checkout work.
- Record exact bundled SDK/runtime, stable/proposed declaration changes, BYOK projection, session configuration, custom-agent conversion and Agents-window extension support contracts.
- Recheck upstream context-window findings; distinguish a host defect from a Cocopi-owned compatibility change.
- Update the retirement schedule from the 1.146 release notes: Local is deprecated and functionally frozen, with removal announced for February 2027.

### 2. `feat!: remove the legacy @cocopi chat participant`

- Remove participant manifest contribution, registration/activation wiring, participant-only implementation and `cocopi.chatParticipantModelSource`; trace usages before removing any shared helper, command or type.
- Replace participant-only tests with absence/activation regressions while retaining provider, authentication and shared behavior coverage. Confirm both package profiles omit the participant.
- Update README, configuration/troubleshooting docs and changelog in the same commit. Explain Copilot harness + Cocopi model selection and the intentional loss of the participant entry point.
- Do not erase persisted conversation/history data or silently rewrite saved user settings. Retire the obsolete setting's implementation and declaration, not unrelated user preferences.
- Breaking-change note: `BREAKING CHANGE: @cocopi and its participant-only model-source setting have been removed; select a Cocopi model in the Copilot harness.`

### 3. `fix: align Cocopi provider contracts with VS Code 1.146`

- First isolate the required workaround as `fix: default Copilot BYOK to the lowest context tier`: add the default-enabled Cocopi option, consistent fixed capacity/prompt reporting, regression coverage and user-facing documentation described above. This explicitly requested behavior is required even if no other provider contract changes are found.
- Implement only provider/API/SDK-facing changes demonstrated by commit 1, with focused offline regressions. Preserve catalog-driven model discovery, reasoning/Ultra wire invariants, SecretStorage and full/Marketplace proposal isolation.
- Cover the actual Copilot BYOK request/response boundary; do not add a second SDK runtime or patch private host services to conceal upstream limitations.
- Omit this commit if the audit finds no production contract changes. Keep independently substantial fixes in separate Conventional Commits rather than bundling unrelated repairs.

### 4. `fix: support Cocopi in the Agents window`

- Audit and, where needed, adapt manifest support, activation, authentication commands and status/dashboard fallbacks against the verified host contract.
- Test workspace-less and virtual-workspace behavior; remove unjustified local-path assumptions only where demonstrated. Verify that editor-only optional UI does not prevent provider/command registration.
- Declare support only for validated capabilities. Keep remote Agent Host BYOK eligibility separate; virtual-repository support is not proof of remote BYOK support.
- Omit or split this commit according to actual findings; do not add a support declaration on release-note evidence alone.

### 5. `test: cover Copilot harness session and tool boundaries`

- Add missing offline coverage for concurrent session identity/continuation isolation, cancellation and disposal, reasoning/model selections, and host-provided tool handling. Reuse existing coverage rather than duplicate it.
- Exercise model-comparison-shaped concurrency without implementing comparison orchestration. Preserve host approval ownership; no automatic broad permission grants.
- Record remaining source-contract versus matching-runtime/live acceptance separately. Offline fixtures must not be labeled end-to-end Copilot validation.
- Any production defect discovered here gets its own focused `fix:` commit with a regression, not a hidden implementation change inside a test-only commit.

### 6. `chore: target VS Code 1.146`

- After compatibility review, update the engine target and checked-in declarations/build checks as required by repository tooling; derive and record Electron/Node and SDK versions from the exact target.
- Run `npm run check`, `npm run lint`, the offline test suite excluding the credential-driven live module, and full/Marketplace packaging with extracted-provider and Marketplace verification. Run release validation only with live checks kept explicitly opt-in.
- Publish an accurate support matrix and known upstream context-window limitation. Record unperformed interactive/runtime acceptance instead of declaring parity.
- Do not install, restart or modify the user's running editor. Backend/live acceptance requires separate explicit authorization.

## Commit review rules

- No staging or committing until explicitly requested. Select only task-owned changes/hunks from the already dirty working tree; do not sweep in existing transport, token-tracker or release work.
- Each production change carries its relevant regression and documentation. Demonstrate new bug regressions fail against equivalent unfixed behavior before showing the same tests pass after repair.
- The upstream context-window defect is tracked evidence, not a promised local fix or a reason to misreport capacity. If still present in 1.146, state the concrete limitation and keep its acceptance question open.