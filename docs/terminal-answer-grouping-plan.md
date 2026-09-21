# Keep Complete Answers Outside Intermediate Step Groups

Status: implementation applied; offline validation recorded below, live host smoke
still pending. Do not stage or commit without user review. Preserve unrelated
working-tree changes. The investigation and proposed steps below retain their
original context; the implementation checkpoint supersedes their pending status.

## Implementation checkpoint

- Aligned instruction defaults, tool descriptions, and copied summary-field
  descriptions around the complete answer, preserving configurable replacement
  keys, disabling, and custom precedence.
- Removed pre-tool substring deduplication and generic success acknowledgements.
  A valid summary is emitted after the completion boundary on both integration
  paths. Participant transcript accumulation became a text-presence bit.
- Added provider cancellation gating and a conservative known-host result-echo
  check. Only isolated trailing completion pairs qualify. Failure is surfaced
  without promoting the supplied answer or adding a model request.
- Missing/empty/malformed summaries after earlier text fail explicitly. The
  existing no-summary/no-earlier-text follow-up remains unchanged. This is a
  deliberate replacement for the misleading summaryless success shortcut, tested
  on both paths; it does not reconstruct an answer from earlier prose.
- Three regressions were shown failing before production edits, then passing
  unchanged. Added detailed Markdown answers, result failure, cancellation,
  malformed/empty fields, already-terminal/new-turn, unmatched and other-tool
  coverage. Existing reasoning/commentary/phase tests remain in the offline suite.
- `npm run check` and `npm run lint` pass. Initial concurrent offline run: 590/591
  passed; the unchanged worker SSE host-stall test failed its generation assertion.
  Its isolated suite subsequently passed 20/20. Live tests were excluded by file,
  and no credentials or model calls were used.
- Full serial offline rerun (`node --test --test-concurrency=1` with the same
  file list): all 591 tests passed. `git diff --check` passed.
- Host rendering still requires the manual smoke procedure in
  `docs/cocopi-local-semantics.md`; no running editor was reloaded or patched.

## User-visible problem

The September 19 screenshot shows a substantive explanation of a resource
destruction notification queue inside nested "Completed 3 steps" / "Finished
with 2 steps" UI. Outside that group is only a short recap beginning "Explained
the destruction-notification queue". The user should not have to open work
groups to read the answer. Removing the recap alone would not solve this.

## Assessment: confirmed versus unverified

Confirmed in the current repository:

- `lib/vscode/language-model-provider.js` reports both commentary and other
  output-text deltas through the ordinary text reporter, after finishing any
  reasoning part. It is not deliberately converting commentary to thinking.
- Its `terminalTaskCompletion()` recognizes a trailing `task_complete` result,
  retrieves the call's `summary`, and checks literal substring presence in a
  preceding segment of visible assistant text. This does not establish whether
  the user received a complete answer or where VS Code displayed it.
- The provider's terminal shortcut emits that summary and skips a model
  follow-up. If the summary is already visible, it emits `Task completed.`.
- `lib/vscode/chat-participant.js` has a related completion shortcut and literal
  deduplication, but does not emit that same placeholder. Audit both paths;
  their host-owned versus extension-owned tool loops differ.
- `data/vscode-instruction-overrides.json` tells the model to put a *concise
  completion summary* into `task_complete.summary`, promoted to final text.
  This encourages a recap, not necessarily the complete requested answer.
- Although the catalog labels its entry `1.127.0`, `defaultRegexReplacements()`
  merges entries into defaults without checking the running VS Code version.
  Do not assume the current host is excluded by that label.
- Existing tests explicitly expect summary-only completion and, on some
  provider paths, `Task completed.`. The local-semantics document describes
  this behavior as intentional.

Follow-up evidence: the second screenshot's exact turn was found in
`C:/Users/clsho/AppData/Roaming/Code/User/workspaceStorage/56a0bcb0424a068c6b63879761c4387f/chatSessions/99749593-60f3-4d95-a88b-56e0a898ca1f.jsonl`.
Line 934 stores `requests[253].response`, in this order:

1. Native reasoning title: `Explaining nonrecursive lock behavior`.
2. Empty thinking part with `vscode_reasoning_done: true`.
3. Empty thinking part with `vscodeReasoningDone: true, stopReason: "text"`.
4. The complete explanation beginning "The feature already has the resource
   lists", stored as ordinary Markdown text and inline references, not thinking.
5. `toolInvocationSerialized` with `toolId: "task_complete"`,
   `presentation: "hidden"`, `isComplete: true`, and call ID
   `call_H4psmikrfjum288JwOYNvWyk`.
6. The short recap beginning "The existing feature bindings are sufficient".

Line 924 also records the tool-call round with the complete explanation as its
response and that recap as the completion tool's `summary` argument. This proves
that the completion tool participated even though no tool row is visible in the
screenshot. It also confirms the full explanation was not stored as reasoning.
The nearby Cocopi log records terminal-summary shortcuts with
`summaryPresent=true alreadyVisible=false`.

Still unverified: wire phases, effective instructions, installed extension build,
and the exact host grouping implementation. Investigate why a hidden completion
tool acts as a grouping boundary, how step counts include invisible parts, and
whether the two differently named end markers contribute to nested groups.
Do not claim the markers are the cause merely because both exist. The first
screenshot's nested levels need their own correlation.

## September 19 follow-up: host boundary verified in source

This investigation did not change runtime code, settings, or running applications.
The installed-build and host-implementation questions above are now resolved for
the current installation, not retrospectively for every screenshot:

- VS Code `1.137.0`, commit `645f29cc3176500b4b5762ba887cf2a7f0ffdf2c`.
- Bundled Copilot Chat `0.65.0` under the editor's `extensions/copilot` directory.
- Installed Cocopi `0.0.1`: hashes of `language-model-provider.js`,
  `chat-participant.js`, and `vscode-instruction-overrides.json` match the workspace.

### Why ordinary Markdown becomes intermediate work

Exact-version source:
[chatListRenderer.ts](https://github.com/microsoft/vscode/blob/645f29cc3176500b4b5762ba887cf2a7f0ffdf2c/src/vs/workbench/contrib/chat/browser/widget/chatListRenderer.ts).

- `getFinalResponseStartIndex`, lines 260–278, finds the last nonempty Markdown
  part and walks backward over adjacent Markdown parts only. A hidden tool is
  still a non-Markdown boundary; this function does not inspect presentation,
  reasoning metadata, or Codex phases.
- `updateCompletedResponseDisclosure`, lines 2873–2990, puts earlier rendered
  nodes into an outer `completed-response-disclosure` once the response and its
  final Markdown finish rendering. Existing inner thinking/tool groups can
  therefore sit inside this outer disclosure. The installed workbench bundle
  contains the corresponding implementation.
- `getVisibleCompletedResponseItemCount`, lines 381–389, counts top-level DOM
  nodes, skipping elements with `hidden` or inline `display: none`. It does not
  count semantic tool calls. Do not equate the displayed number with a count of
  visible tools, or claim these screenshots prove invisible tools are counted.

A small Node harness executed the exact upstream boundary-function body against
synthetic response parts. All three assertions passed:

| Sequence | Markdown left outside the outer group |
| --- | --- |
| Reasoning → detailed answer → hidden completion → recap | Recap |
| Reasoning → progress → hidden completion → detailed answer | Detailed answer |
| Reasoning → detailed answer, no completion tool | Detailed answer |

This reproduces the boundary decision, not DOM rendering or a live model turn.
It explains the recorded second screenshot's sequence without blaming either
reasoning-end marker. Streaming/reopen screenshots and the first screenshot's
exact nested structure remain unverified.

### The completion carrier accepts a full answer, but guidance conflicts

Exact-version source:
[taskCompleteTool.ts](https://github.com/microsoft/vscode/blob/645f29cc3176500b4b5762ba887cf2a7f0ffdf2c/src/vs/workbench/contrib/chat/common/tools/builtinTools/taskCompleteTool.ts#L28-L77).
The installed bundle agrees with this source:

- `summary` is an optional string with no `maxLength`. Its description asks for
  a brief summary; that is guidance, not a schema-enforced length restriction.
- The invocation is hidden and returns `summary ?? 'All done!'` as tool-result
  text. This implementation does not itself emit a final assistant Markdown
  answer. Cocopi's provider replay shortcut is the known final-text carrier in
  the recorded turn.
- The full tool description still includes both “Provide a brief summary of
  what was accomplished” and “IMPORTANT: Before calling this tool, you MUST
  output a brief text message summarizing what was done. The task is not complete
  until both your summary message AND this tool call are present.”
- Current tool replacements change only the “Do not restate…” sentence. The
  instruction regex for “Before calling task_complete” does not cover this
  different wording. A synthetic application of the catalog replacements
  confirmed that contradictory pre-tool and no-pre-tool instructions survive.
- `resolveVscodeLanguageModelTools()` rewrites only top-level `description`;
  `inputSchema.properties.summary.description` retains the brief-summary wording.
  Tests currently use a single-sentence tool description, missing this conflict.

### Recommended implementation delta

Proceed with the existing carrier rather than altering reasoning or transports:

1. Replace the exact known completion guidance with one contract: put the complete
   user-facing answer in `summary`; keep progress before the call, but do not
   separately emit the completed answer or a recap there. Preserve the existing
   success/verification requirements. Update the catalog and matching manifest
   defaults together, including the current full pre-tool paragraph.
2. Align the model-visible `summary` property description too, narrowly for the
   recognized completion schema and with replacement disable/custom precedence
   preserved. Do not change requiredness, validation, or the host-owned schema
   object. Unknown descriptions must remain untouched.
3. For a valid terminal completion result, emit its nonempty answer after the
   tool boundary even if identical text appeared before the tool. The current
   substring check proves only pre-tool visibility, not terminal delivery. No
   retained transcript or text-based answer classifier is necessary. Treat a
   later assistant answer as nonterminal replay rather than re-emitting it.
4. Audit the participant separately: its loop invokes tools directly and knows
   whether invocation threw or cancellation occurred. The provider helper currently
   checks call identity but not result success, and runs before its later
   cancellation check. Define authoritative failure handling before claiming that
   any matching result is successful; never infer success from prose.
5. Keep missing/malformed-summary behavior as an explicitly unresolved edge case
   until tests justify its replacement. Earlier progress is not a complete answer,
   and removing the placeholder by returning an empty BYOK stream is not safe.
   Do not silently add a paid follow-up to cases that currently shortcut.

The first regression should use the full installed tool description and schema,
then verify the effective model-visible result. Add a multi-paragraph completion
fixture and a pre-tool-identical-answer case; demonstrate failure on unchanged
runtime code before implementing the fix. The boundary harness is source evidence,
not a replacement for these provider/participant regression tests or host smoke.

Upstream Codex `rust-v0.153.3`
[models.rs](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/protocol/src/models.rs#L906-L920)
explicitly distinguishes interim `commentary` from terminal `final_answer` and
requires compatibility behavior when phase is absent. Preserve that contract;
the host disclosure boundary does not justify inventing phases.

**Optional immediate workaround, not applied:** set
`chat.agent.collapseCompletedResponses` to `false` to disable the outer completed
response disclosure. This does not repair redundant completion output or disable
inner thinking/tool groups. Leave the user's settings unchanged unless requested.

## Intended contract

1. A completed turn exposes one complete, useful answer outside collapsed work
   groups. Explanations retain the details, code, links, and caveats requested.
2. Progress commentary stays visible as commentary. Native reasoning keeps its
   own channel. Preserve original phases on replay; do not infer them from prose.
3. A completion recap is not a substitute for an answer. Do not add generic
   `Done` / `Task completed.` output merely to satisfy a nonempty-response check.
4. Do not hide or delete earlier text, relabel all commentary as final, or replay
   the entire turn into the final response. A progress note is not an answer.
5. No transport retries, provider fallback, extra model call, or silent cost
   changes should be introduced as a presentation fix.

## Implementation Plan

### 1. Establish the host boundary and capture a small reproduction

Use a short explanatory question that needs a multi-paragraph answer and no
edits, followed by a coding task with real tool calls. Record installed VS Code,
Copilot, and Cocopi versions, configured instruction overrides, and the actual
model-visible completion tool schema. Prefer existing diagnostics; do not load
large conversation logs or retain full payloads in memory.

Correlate output item IDs, phases, text-part ordering, completion call/result,
and any continuation with what appears in the UI. Obtain a sanitized fixture.
Inspect the installed/upstream host implementation for step grouping and the
completion tool; record source references for the applicable version. Consult
the upstream Codex reference for phase semantics before changing local behavior.

Answer these questions before choosing the fix:

- Does a normal post-tool provider text response reliably appear outside groups?
- Does the host display the tool's summary itself, or request a provider follow-up?
- Does the provider shortcut run for this reproduction?
- Is grouping driven by tool-loop position, native part metadata, or both?
- Does the current tool schema impose length/content restrictions on `summary`?

### 2. Prefer repairing the existing final-answer carrier

If the host reproduction confirms that the existing post-tool summary emission
is the terminal text surface and the tool accepts a full answer, retain that
mechanism but change the narrow, known-host instruction replacements:

- Treat the completion field as the complete user-facing answer, not a report
  about having answered. For explanatory questions it must contain the actual
  explanation; for coding work it contains the appropriate outcome and validation.
- Avoid emitting the full final answer before the terminal tool just to repeat
  a recap afterward. Preserve useful progress updates during work.
- Align the tool-description replacement with the instruction replacement so
  one does not ask for a full answer while the other demands only a brief recap.
- Preserve custom instruction precedence and existing disable/override behavior.
  Test the effective result, not just that a regex matched a fixture.

This is the preferred minimal route, conditional on step 1. If the actual host
contract makes it impossible, document that limitation and propose a supported
terminal-output mechanism before implementing a broader workaround. Do not
strip the tool, fabricate calls, patch VS Code, or add a paid follow-up by default.

### 3. Correct terminal handling and deduplication

Separate "text was emitted earlier" from "a terminal answer was delivered".
Remove reliance on literal substring equality as evidence of terminal delivery.
Do not replace a needed terminal answer with `Task completed.` just because its
text exists in an intermediate work group. Conversely, do not duplicate text
already delivered in the actual terminal surface.

Use only authoritative tool/output metadata available on the relevant path;
do not guess answer boundaries from wording or Markdown. Design the state from
the confirmed host sequence in step 1. Avoid introducing large retained text
buffers, transcript copies, or new replay-marker payloads.

Handle missing/empty/malformed completion fields deliberately. Preserve explicit
errors and cancellation, and never report success after a failed completion tool.
Keep the current fallback behavior unless a tested replacement is justified;
document any remaining limitation rather than inventing an answer.

### 4. Regression Coverage

Extend `test/vscode-language-model-provider.test.js`,
`test/vscode-chat-participant.test.js`, and `test/vscode-configuration.test.js`:

- Detailed explanatory answer survives the completion boundary intact.
- Earlier progress plus completion yields a complete terminal answer, not a recap.
- Identical text in an intermediate group does not trigger the generic placeholder.
- An already delivered terminal answer is not duplicated.
- Native reasoning ends before ordinary answer text; commentary remains ordinary
  text and replay preserves its authoritative phase.
- Tool success, failure, cancellation, empty/malformed summary, and unmatched or
  nonterminal completion calls behave correctly.
- Calls on other tool paths and ordinary answers without `task_complete` are unchanged.
- Updated instruction/tool replacements agree, unknown host text remains unchanged,
  and custom overrides retain precedence.
- Completion does not add an unexpected model request or accumulate transcript data.

Provider unit tests cannot prove VS Code grouping. Add a host-level manual smoke
procedure or integration test with screenshots: while streaming, after completion,
after collapsing every work group, and after reopening the conversation. Test
both normal and Autopilot modes where available, and both integration paths.

### 5. Validation and Handoff

Update the task-completion section of `docs/cocopi-local-semantics.md` to describe
the resulting contract and verified host limitations. Run `npm run check`,
`npm run lint`, and `npm test` using the documented offline procedure, without
opting into live tests through local credentials.

Acceptance: with all work groups collapsed, the user can read the complete
answer without a redundant second summary. No commentary/reasoning is hidden,
no replay phases are fabricated, and no extra request is made solely to restate
completion. Report files changed, test results, verified host versions, and any
remaining limitations. Leave changes unstaged and uncommitted for review.
