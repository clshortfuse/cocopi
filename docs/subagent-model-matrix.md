# Subagent model matrix proposal

## Operating defaults

The default `cocopi.subagents` value is `{ "preset": "gpt6-ultra" }`. It dynamically expands the available catalog: GPT-6 Ultra parents may spawn all GPT-5.6 and GPT-6 supported efforts except Ultra, excluding Fast models. Subagent aliases use ordinary service tier. Other parents receive no spawn tool. Match symbolic Ultra before wire translation, so xhigh/max parents do not gain Ultra permissions. Empty catalog fails closed. Saved custom settings remain authoritative; **Restore operating defaults** opts an existing configuration into the preset. Saving edited lists replaces the dynamic preset with explicit routes. Ultra may be a parent only, never a subagent alias. The 12-pair cap is raised to 256 to avoid truncating the catalog's effort combinations.

Implementation/validation plan: expand presets consistently for UI, published aliases and both request paths; preserve symbolic parent effort; test default expansion, excluded families/tiers, explicit override preservation and request wire effort; run offline validation and package the updated VSIX. Earlier opt-in/default descriptions below are historical and superseded.

## Selected-parent listboxes (supersedes the grid)

The UI now uses a single-selection parent listbox on the left and that parent's allowed subagent listbox on the right. A catalog model/effort selector supplies Add parent and Add subagent; Remove operates on the selected entry. Directed routes remain independently stored per parent. With routing enabled, empty/unconfigured parents receive no `runSubagent` tool. Disabling routing preserves legacy host behavior. Validate listbox persistence, directed tool filtering, offline tests, and rebuild the VSIX for manual testing.

## Cross-matrix correction (2026-09-05)

Implementation plan: replace the model-versus-effort editor with the same user-added model/effort pairs on both axes. Rows identify parents; columns identify subagent targets. Cells contain only accessible checkboxes. Add/remove pairs outside the grid. Persist directed links and filter the spawn menu and blank-model default by the current parent's effective model/effort. Preserve legacy global choices until the user saves the new grid. Validate routing, HTML and offline tests, then package for manual testing.

Location: **Cocopi: Show Status → Chat and background tasks → Subagents — parent × subagent**. Empty/unmatched rows retain ordinary parent inheritance and advertise no matrix choices; this is guidance, not a host-enforced model allowlist. Earlier model-versus-effort UI descriptions below are superseded.

Status: experimental implementation, disabled by default. Investigated and implemented 2026-09-05. Live host alias resolution and visual interaction remain unverified; offline tests do not establish those guarantees.

## Implemented surface

- Open **Cocopi: Show Status**, expand the chat-routing section, then **Subagents — model × reasoning effort**. Enable model/effort cells, enter a short label and use description, select an enabled default, enable matrix routing, and save.
- The implementation stores one atomic, application-scoped `cocopi.subagents` object (`enabled`, `defaultChoice`, `choices`) rather than the three separate settings originally proposed below. This prevents partially saved configurations from selecting an unintended default.
- At most 12 enabled choices are sent to the model. The current UI edits each combination inline in its table cell rather than using a separate cell inspector or summary table.
- Aliases are explicitly selectable and named `Cocopi Subagent <stable-id>` so host resolution does not depend on hidden-model support. Labels can change without changing the alias name. Picker visibility is a deliberate compatibility tradeoff, not a verified host-resolution result.
- Provider and custom participant paths expose the menu and default blank model arguments. Direct alias requests resolve to concrete catalog models with authoritative effort and ordinary service tier, including participant follow-ups. Unsupported/unknown catalog combinations fail closed rather than being adapted upward.
- Settings remain opt-in and explicitly experimental because the proposed live host spike has not been run. No custom agents or nesting settings were changed, and no live subagent was spawned during implementation.
- Validation: `npm run check`, `npm run lint`, and all 527 offline tests passed. Credential-backed `codex-live.test.js` was deliberately excluded. Coverage includes provider alias metadata and effort precedence, direct participant alias routing, default/explicit tool arguments, unsupported routes, settings persistence, and HTML escaping.

The sections below retain the design rationale and future compatibility/UX gates; they are not claims that all planned enhancements are implemented.

## Goal

Give the parent model a small, user-curated set of subagent model/effort choices rather than routinely inheriting an expensive parent configuration. Preserve VS Code's real `runSubagent` execution, permissions, and agent selection.

Model choice, reasoning effort, and agent role are separate decisions. A lightweight model running an elaborate agent workflow can still consume many tokens. This feature should make routing explicit without claiming to impose a total token budget.

## Upstream style and intentional improvements

Follow Codex CLI Rust conventions where they fit, but do not require upstream feature parity before improving the UX. The user explicitly permits improvements beyond upstream.

Verified against the repository's `rust-v0.153.3` baseline:

- `multi_agents_spec.rs` already builds a bounded, catalog-derived list of available model overrides in the spawn tool description, including model descriptions, supported reasoning efforts, their defaults, and service tiers. Exposure is conditional; V2 can omit model/effort overrides entirely.
- Native spawn schemas distinguish `agent_type`, `model`, and `reasoning_effort`. Their guidance prefers inheriting the parent model/effort unless an override is needed.
- `multi_agents.rs` describes starting from the effective parent configuration and layering role-specific configuration while retaining runtime safety state. The V1 `multi_agents/spawn.rs` handler applies model overrides, role configuration where applicable, and runtime overrides; it records effective model/effort after spawning. Do not assume this means every upstream path has the same override precedence as VS Code.
- Tool guidance emphasizes concrete, bounded tasks, avoiding duplicate work, and retaining immediate blocking work locally. Native asynchronous messaging, history forks, separate workspaces, and wait behavior must not be copied into VS Code's one-shot tool instructions unless the host actually supports them.

The existing upstream tool model menu is a direct precedent, not a feature that needs inventing. No equivalent user-editable cross-matrix UI was established by this source inspection; that is not a claim that none exists anywhere upstream.

| Aspect | Follow upstream | Intentional Cocopi improvement/adaptation |
| --- | --- | --- |
| Model guidance | Compact catalog-derived choices in the spawn tool description | Present only user-enabled matrix combinations with concise use guidance |
| Selection concepts | Keep model, reasoning effort, and agent role distinct | Edit model/effort pairs visually; optional labels are UI conveniences, not a new agent-role hierarchy |
| Default selection | Preserve parent inheritance when matrix mode is disabled | Opt-in user-selected economical default instead of automatic parent inheritance |
| Wire semantics | Real model IDs and supported efforts at the request boundary | Encode a pair as a Cocopi alias because the host tool lacks native effort selection |
| Delegation policy | Bounded tasks; avoid duplication and unnecessary delegation | Explicit least-intensive-adequate-choice guidance, without asserting unmeasured savings |
| Safety and lifecycle | Preserve the owning runtime's permissions and constraints | Let VS Code own child execution; do not emulate unsupported Codex lifecycle operations |

Prefer a thin configuration-and-tool-description layer over a new orchestration framework. Future upstream changes should inform this design, not automatically remove deliberate, documented Cocopi UX improvements.

## Recommended UI

Add a **Subagents** section to the existing Cocopi settings webview, not a new custom-agent editor.

- Rows: concrete models from the authenticated model catalog.
- Columns: supported reasoning efforts, ordered by known effort rank; retain unfamiliar catalog-defined values without inventing a ranking.
- Cells: enable/disable a model + effort combination. Unsupported combinations are unavailable, not silently adapted upward.
- Selecting an enabled cell opens a small inline editor: short label, “Use for” description, and mark as default.
- Show a compact enabled-choices summary below the matrix. Only these choices go into the model prompt; never send the whole catalog matrix.
- Show unavailable saved models explicitly. Do not silently substitute the parent, Auto, another provider, or a stronger effort.
- Use VS Code theme variables, semantic table headers, keyboard-operable cell controls, and explicit text states rather than color alone.

Illustrative matrix; actual names and available efforts come from the catalog:

| Model | Low | Medium | High |
| --- | --- | --- | --- |
| User-selected lightweight model | Lookup — default | — | — |
| User-selected general model | — | Standard | — |
| User-selected capable model | — | — | Deep |

Illustrative enabled-choices summary:

| Choice | Use for | Model / effort |
| --- | --- | --- |
| Lookup | Narrow searches, locating definitions, extracting facts | Lightweight / low |
| Standard | Bounded implementation or analysis involving several files | General / medium |
| Deep | Difficult reasoning after a concrete blocker, or explicitly requested deep work | Capable / high |

These are user-configured capability labels, not asserted model pricing or performance rankings. Multiple choices may use the same model with different efforts. No production hardcoded model IDs or dollar estimates.

For v1, require explicit efforts for models advertising reasoning. Exclude symbolic Ultra from matrix cells: it is orchestration, not a wire effort. Models explicitly advertising no reasoning have a single Not applicable cell. Unknown catalog metadata remains unknown; do not represent it as unsupported or promise an enforceable effort until verified.

## Verified baseline

- `lib/vscode/tool-bridge.js`: `withDefaultRunSubagentToolModel` fills an omitted/blank model with the active Cocopi qualified name and preserves explicit model strings. `codexToolsFromLanguageModelTools` constructs model-visible tool descriptions and schemas.
- `lib/vscode/language-model-provider.js` and `lib/vscode/chat-participant.js` both use that default-model bridge.
- `lib/vscode/workload-routes.js` already resolves Cocopi model aliases to concrete models, reasoning efforts, and service tiers. Utility/autocomplete routing is precedent, not a ready-made subagent policy: its automatic fallback behavior is inappropriate for a cost-conscious matrix.
- `languageModelInformationWithWorkloadRoutes` publishes specialized aliases; `specializedWorkloadConfigurationSchema` removes ordinary reasoning customization, and the response path applies route-owned reasoning. This provides an implementation pattern for making an alias authoritative over inherited reasoning settings.
- `lib/vscode/commands.js` already hosts catalog-backed model and reasoning controls in the settings webview.
- Checked-in stable/proposed provider request types expose tools, model options, model configuration, and request initiator, but no explicit parent/child lineage contract. Do not infer nesting depth or a shared budget from those fields.
- Current VS Code documentation specifies selection precedence: explicit `runSubagent.model`, then agent-configured model, then parent model. It also documents host cost-tier restrictions and nesting disabled by default.

## Routing and tool exposure

1. Store each enabled cell with a stable opaque choice ID, concrete catalog model ID, effort, short label, and bounded use description. Display-name edits must not change the routing identity.
2. Publish a dedicated Cocopi model alias per enabled choice, e.g. provider-local `subagent-<id>`, with a unique qualified display name. Reuse the existing alias architecture, but keep this namespace separate from utility/autocomplete aliases.
3. Resolve aliases at the Cocopi request boundary. Apply the choice's model and explicit effort authoritatively over parent/global/model-picker options. Never transmit the alias as a Codex model ID. Preserve the target's real capabilities and BYOK metadata.
4. When a request actually includes `runSubagent` with a compatible `model` field, append a concise choice list to the outgoing tool description and, where safe, its model-field description. Each entry gives the exact host-qualified alias name, resolved model/effort, and use description.
5. Keep the host's original argument contract. Do not introduce fictitious `reasoningEffort`, `budget`, or `complexity` arguments. Do not replace the tool or mutate the host's shared schema object to add matrix guidance.
6. In enabled matrix mode, fill omitted/blank model arguments with the configured default choice instead of the parent. Preserve explicit model selections in v1; consequently this is guided routing, not a model allowlist. Explain that explicit selection takes precedence over custom-agent model configuration.
7. Apply identical routing and tool-description behavior to the language-model-provider and custom participant paths. Replayed explicit model selections should remain explicit; streaming tool arguments must be finalized consistently before forwarding.
8. If a matrix choice becomes unavailable, reject its route clearly rather than falling back. If the tool schema cannot express model selection, do not advertise matrix routing as supported. Keep matrix mode off until a usable default exists.

Suggested concise policy accompanying the choices:

> Prefer doing trivial work directly. For worthwhile delegation, choose the least intensive configured option adequate for the task. Use the default for narrow lookups. Choose Deep only for a specific reasoning need, not simply because a subagent is available. Give the child one bounded task and ask for a concise result. Choose agent role separately; do not select an elaborate workflow when a simple worker suffices. Respect explicit user restrictions on delegation.

This policy must not rewrite the root Ultra effort invariant. Matrix workers should not inherit Ultra merely because the parent selected it. Existing Ultra proactive guidance needs a focused compatibility review so it does not defeat the bounded-selection policy.

## Settings and safety

- Proposed settings: `cocopi.subagents.enabled`, `cocopi.subagents.choices`, and `cocopi.subagents.defaultChoice`.
- Opt-in initially; disabling restores current routing behavior. The UI must say that current behavior pins blank model inputs to the parent, including when an agent has its own configured model.
- Save at user scope by default. Treat use descriptions as user-authored instructions; do not silently accept workspace-controlled policy escalation. Decide whether these settings should be restricted in untrusted workspaces during implementation.
- Service tier stays ordinary `auto` in v1. Priority is not a token budget, and adding it to the main matrix would confuse the two axes.
- No generated `.agent.md` files, changed user agents, changed nesting settings, native Codex child-thread tools, or new orchestration runtime.
- No promised hard limits on tool calls, total tokens, fan-out, or recursion: VS Code owns those lifecycles. A route selects model/effort but does not prove a request is a child or identify its parent.
- Record metadata-only choice ID, resolved model, selected/effective effort, and actual usage when available. Do not fabricate per-parent totals or log prompts to evaluate routing.

## Compatibility gates before implementation rollout

The docs support explicit model selection; they do not establish every detail of alias resolution in the installed harness. A host smoke test is required before treating the design as production-ready:

1. Verify `runSubagent` resolves a Cocopi qualified alias name, including when `isUserSelectable: false`. If hidden aliases are excluded, test selectable aliases with clear naming rather than inventing a host API.
2. Verify host cost-tier/BYOK checks accept the alias using truthful target metadata. Do not manufacture cheap multipliers to bypass checks.
3. Verify explicit alias choice wins over an agent-configured model and parent reasoning; confirm the provider receives the alias ID and sends the configured concrete model/effort.
4. Verify ordinary chat and custom `@cocopi` paths, including a host schema missing the model field and unavailable aliases. Do not silently fall back to Copilot.
5. Verify whether the parent sees duplicate/conflicting host model guidance; keep the matrix supplement short and compatible with host constraints.

No live subagents or API requests were used for this investigation. Host execution behavior above remains untested, not confirmed merely by mocked tests.

## Implementation sequence

1. Prove host alias compatibility with a minimal opt-in spike before building the full UI.
2. Add deterministic choice configuration/resolution and offline tests. Keep stale-choice behavior distinct from existing utility route fallbacks.
3. Publish aliases and make model/effort resolution authoritative; test inherited high/Ultra settings against a low-effort choice.
4. Add concise tool-choice descriptions and configurable blank-model default in both request paths.
5. Add the theme-aware matrix and enabled-choices editor to the existing settings webview; cover persistence, unavailable entries, escaping, and keyboard interaction.
6. Update local semantics/README and document guidance versus enforcement. Run `npm run check`, `npm run lint`, and offline tests; run live compatibility checks only with explicit opt-in.

Acceptance coverage includes unchanged behavior when disabled; unchanged ordinary chat/utility/autocomplete routing; explicit model preservation; blank/null model handling; strict tool schemas; streaming call finalization; renamed choice stability; unavailable targets; unsupported efforts; and no root Ultra regression. Evaluate actual total token use on a fixed task set before claiming savings: reduced reasoning effort can still increase retries or tool calls.

## References

- [Codex Rust spawn tool schemas and model descriptions (`rust-v0.153.3`)](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/core/src/tools/handlers/multi_agents_spec.rs)
- [Codex Rust collaboration handler conventions (`rust-v0.153.3`)](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/core/src/tools/handlers/multi_agents.rs)
- [Codex Rust V1 spawn implementation (`rust-v0.153.3`)](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs)
- [VS Code subagents: model selection and nesting](https://code.visualstudio.com/docs/agents/run/subagents)
- [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/language-model)
- `data/vscode-dts/vscode.d.ts`: `ProvideLanguageModelChatResponseOptions`, `LanguageModelChatInformation`
- `data/vscode-dts/vscode.proposed.chatProvider.d.ts`: model configuration, BYOK metadata, selectability
- `docs/cocopi-local-semantics.md`: Tool Bridge Repairs; Ultra Mode And VS Code Subagents