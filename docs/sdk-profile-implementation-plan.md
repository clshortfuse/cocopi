# SDK adoption implementation

Date: 2026-10-25. Offline implementation against installed SDK / VS Code 1.143 contracts recorded in `vscode-sdk-adoption-audit.md`.

## Deliverables

1. A deterministic catalog-validated SDK custom-agent profile generator, using the already published `cocopi/subagent-<choice>` model aliases. Export only SDK-supported explicit efforts; reject unsupported/Ultra choices with reasons, never coerce them.
2. A command and dashboard action to select a profile and open an untitled Markdown preview. Users choose the destination through native Save As; Cocopi never writes or overwrites a customization automatically. Suggested workspace location: `.github/agents/<name>.agent.md`. No SDK reload or setting change.
3. Full-build eligibility, current-account cached catalog validation without network access, and effective strict-plugin-only policy checks before and after asynchronous selection. Warn about stale catalog/discovery, SDK parent fallback, inherited host tools, non-enforcement of the Local directed matrix and lack of quota isolation.
4. A dashboard coverage matrix for Local `runSubagent`, SDK custom agents, execution subagents/task, session delegation, utilities, runtime extensions/canvases, workflows, context choices, and remote/mobile lifetime.
5. Offline unit/integration tests, type/lint checks and both package builds with extracted smoke checks. No installation, host lifecycle changes or commits.

## Runtime-extension assessment

### Host-listed SDK task guidance

The pinned `copilotMockLlm.integrationTest.ts` sibling-agent fixture dispatches `task` with `agent_type` naming the custom agent; a separate credential fixture also uses a distinct `model` argument. These are not the Local `runSubagent` model/display-name contract. Add optional model-facing guidance only when an incoming `task` schema explicitly enumerates `agent_type` names matching generated current catalog routes. Do not infer discovery from a description or prefix, advertise names absent from that enum, modify schemas/arguments, set a default, remove SDK tools or reinterpret the Local directed matrix as SDK policy. Describe matching names as candidates: an enum alone does not verify the contents/model of a saved file or prevent runtime fallback. Hosts without this enum get no synthetic discovery claim.

Implemented in `withSdkCustomAgentGuidance` and the provider request path. Three focused tests cover exact enum matching, absent/unconstrained schemas, misleading descriptions, disabled/unavailable routes, nonmutation, other tools and separation from the Local parent graph. The provider-to-wire test now confirms candidate guidance and schema preservation while an explicit `explore` call remains unchanged. Marketplace guidance is disabled; extracted smoke checks enforce this full/stable separation. The pinned fixtures establish the `task.agent_type` argument, **not** that every installed SDK tool schema exposes an enum; this adaptation is conditional.

Latest validation: type/lint and cached-host source verifier passed; **663 offline tests passed**, zero failed/cancelled/skipped, 7,385.5819 ms. Offline full build: 150 files / 527.55 KB; Marketplace: 83 files / 310.13 KB. Both VSIX outputs and extracted smoke checks passed, with existing CRLF warnings only in whitespace validation. No live SDK, host installation/restart or quota/fallback acceptance was performed.

### Offline acceptance follow-through

Implement a reproducible cached-source probe that loads the pinned frontmatter parser and custom-agent converter, tests generated profiles through that converter, verifies exact provider/group-qualified model identity helpers, and exercises renderer BYOK request/result conversion with synthetic services. Include context-default loss, cached-usage loss, policy refusal and cancellation-token forwarding as explicit outcomes. No upstream process, proprietary SDK, service, installation or lifecycle operation is authorized. Source-isolated probes complement rather than replace the normal offline extension suite and installed-host acceptance.

The installed `joinSession` entry point enables a companion process with tools/hooks/canvases, but does not give it SecretStorage or repair VS Code's BYOK context/cancellation contract. A companion that merely duplicates routing or bypasses excluded workflow tools is not a justified implementation. This iteration ships the real supported agent-profile integration and makes the remaining surfaces explicit; it does not claim a companion process, independent SDK service or host-disabled workflows are implemented.

## Implemented and validated

- `sdk-agent-profiles.js`: deterministic escaped Markdown, model-qualified existing alias IDs, explicit supported efforts, non-reasoning handling and rejection reasons for unavailable/unsupported routes. No auth/runtime object is serialized.
- `sdk-profile-preview.js`: full-profile/proposal checks, effective strict-plugin policy lookup, current account/backend/client cached catalog, untitled preview and explicit native Save As. Policy, account, auth identity and route content are checked again after selection and before offering Save As. No credential refresh, network catalog request, automatic file write, overwrite, configuration change or runtime reload.
- Registered **Cocopi: Preview SDK Agent Profile** and a dashboard action. Dashboard coverage explicitly distinguishes Local runSubagent, SDK custom agents, execution/task/session/utility routes, customizations, runtime extensions/canvases, excluded workflows, context choices and remote/mobile lifetime. Preview does not trigger a dashboard/catalog refresh afterward.
- Added ten offline profile tests plus dashboard/activation assertions. Tests cover serialization/escaping, supported/non-reasoning/unsupported/Ultra routes, disabled matrix, cancellation, wrong-account cache, build/proposal and policy refusal, state changes after asynchronous selection, pre-save policy revocation, no network and user-controlled Save As.
- Type check and lint passed; **657 offline tests passed**, zero failed/cancelled/skipped, 7,789.6766 ms. The entire live credential module was excluded.
- Offline full build: `out/cocopi-1.0.0.vsix`, 150 files, 526.44 KB. Offline Marketplace build: `out/cocopi-1.0.0-marketplace.vsix`, 83 files, 309.23 KB. Marketplace isolation and both extracted-provider smoke tests passed, including packaged command/profile serialization and earlier context/system/icon regressions. Whitespace validation passed with existing CRLF warnings.

Native Save As and installed-host profile discovery/model execution were not driven during this offline work. SDK parent fallback remains possible; export is neither a directed-matrix enforcement mechanism nor a quota-isolation guarantee. Runtime-extension/canvas, independent remote/mobile service, workflow execution and host context-choice repair remain unimplemented, not implicitly certified by these tests. No extension installation, host restart or Git commit was performed.

**Offline follow-through:** `verify-sdk-host-contracts.js` now reproducibly exercises the actual pinned YAML/custom-agent parser, identity helpers and renderer bridge with synthetic services. Generated profile selection is also tested through actual Cocopi alias publication and wire effort resolution. Current validation is **660 passing offline tests** plus the separate cached-source verifier, type/lint checks and both rebuilt package smoke checks. See [SDK offline contracts](sdk-offline-contracts.md) for the exact supported evidence and remaining limitations. No live SDK or installed-host discovery acceptance is inferred.