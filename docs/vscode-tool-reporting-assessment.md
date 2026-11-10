# Tool execution reporting assessment

Assessment date: 2026-11-08. This is an observability assessment, not a timeout
change or evidence that a slow tool has hung.

## Verified stable target

The official Windows stable update endpoint reports **1.145.2**, commit
`c4453f8ea430795f941c1b2ff6c9321135a74a02`:
<https://update.code.visualstudio.com/api/update/win32-x64-user/stable/latest>.
The affected Renounce renderer logs previously identified 1.144.0. No editor
upgrade, extension reload, installation, or settings change was performed.

Exact tagged declarations were compared at 1.144.0 and 1.145.2, rather than
assuming documentation for `main` describes the installed/stable version.

## Capability and ownership matrix

| Surface | Stable 1.145.2? | What it actually provides | Cocopi implication |
| --- | --- | --- | --- |
| `LanguageModelToolInvocationOptions.toolInvocationToken` | Yes | Associates a caller's invocation with chat; native invocation progress and confirmation UI | Already passed by the Cocopi chat participant when it invokes tools |
| `LanguageModelTool.prepareInvocation` and `PreparedToolInvocation.invocationMessage` | Yes | Tool-owned initial running message; preparation may not be followed by invocation | Useful to tools Cocopi implements, not a global execution subscription |
| `LanguageModelChatProvider.provideLanguageModelChatResponse` | Yes | Streams model response parts, including model-selected tool calls | Does not receive host tool-start/finish notifications after returning |
| `LanguageModelTool.invoke(..., progress)` / `ToolProgressStep` | **Proposed `toolProgress`** | Tool implementation reports message and increment while executing | A tool-author capability; cannot be added by Cocopi to tools another extension owns |
| `PreparedToolInvocation.pastTenseMessage`, presentation, richer tool results | **Proposed `chatParticipantPrivate`** | Tool/completion presentation metadata | Not a stable global lifecycle observer |
| `chat.onDidReceiveChatDebugEvent` | **Proposed `chatDebug`** | Subscription to core-originated chat debug events | Potential diagnostics bridge; coverage must be tested, not assumed |
| `chat.registerChatDebugLogProvider` | **Proposed `chatDebug`** | Supplies debug data to the host debug view | Not a universal reader of another extension's debug provider; only one provider at a time |
| `ILanguageModelToolsService.onDidInvokeTool` and prepare-unresponsive event | Internal workbench service | Core-side tool notification | Not an extension API; do not import or hook private workbench services |

The relevant public tool/provider interface blocks are unchanged between the
two checked versions. `vscode.proposed.toolProgress.d.ts` and
`vscode.proposed.chatDebug.d.ts` are byte-identical between those tags. Thus an
upgrade to 1.145.2 alone does not provide Cocopi a new stable tool observer.

## Verified implementation details

- `extHostLanguageModelTools.ts` supplies the third `invoke` progress argument
  only when the **tool's owning extension** is authorized for `toolProgress`.
  It sends progress via `$acceptToolProgress`; `mainThreadLanguageModelTools.ts`
  forwards it to the running core invocation's progress reporter. A model
  provider cannot gain this ownership by enabling the proposal for itself.
- `mainThreadChatDebug.ts` subscribes to `IChatDebugService.onDidAddEvent` and
  forwards only events passing `isCoreEvent`. `chatDebugServiceImpl.ts`
  distinguishes provider-originated events via a WeakSet. The existence of
  `ChatDebugToolCallEvent` and serialization support therefore does **not** prove
  that all Copilot/MCP/Agent Host tool lifecycle events reach a separate Cocopi
  subscriber. The exact producers, start/update/completion coverage, session
  correlation, and operation with the debug view closed remain a validation gate.
- Debug events can carry input/output payloads. Any exploratory adapter must
  extract only allowlisted lifecycle metadata and must not copy prompts, tool
  arguments, results, or credentials into ordinary logging/tracker state.

## Cocopi paths are different

### Model provider used by VS Code Agent

`lib/vscode/language-model-provider.js` reports generated tool calls; VS Code's
agent owns their actual invocation, confirmations, execution, and results.
Its current edit-tool argument progress is **argument preparation**, not proof
the edit tool is executing. The Live Tracker counts model calls only. Zero
model calls must never be interpreted as an idle, finished, or hung chat task.

### Cocopi chat participant

`lib/vscode/chat-participant.js:streamToolFollowUp` actually awaits
`vscode.lm.invokeTool` with the chat request's invocation token. It can accurately
measure its own invocation wait from dispatch to settlement and surface errors.
The current `reportToolInvocationProgress` reports start for arbitrary tools but
completion/failure text mainly for its edit-tool mapping. This is a concrete
reporting gap that can be improved using existing stable APIs, without waiting
for a new VS Code release or observing another extension's private state.

## Prioritized improvements

1. **Make scope unmistakable.** Keep model-call count separate from task/tool
   activity. An empty model list should say no active model call, not imply
   VS Code has no work. Never classify a zero-request interval as a stall.
2. **Improve participant-owned invocation reporting.** Add consistent start,
   elapsed wait, settlement/error metadata for every invoked tool, including
   parallel calls. Use native invocation-token UI rather than duplicate
   confirmation prompts. Dispatch-to-result elapsed time includes preparation,
   approvals and hooks; do not label all of it CPU execution time. Repeated
   elapsed notices mean still waiting, not verified useful progress.
3. **Assess an opt-in full-profile `chatDebug` observer.** Use passive metadata
   only, session URI and call ID correlation, bounded retention, runtime proposal
   authorization checks, and no takeover of the host's existing debug provider.
   Prove core event coverage with real read/edit/terminal/MCP tools and with the
   debug panel closed before claiming the model-provider path can track them.
   Agent Host and normal Local chat must be tested separately.
4. **Keep uncertainty explicit for host-owned tools.** The provider knows what
   calls it emitted, not whether core started, approved, finished or abandoned
   them. A subsequent tool-result replay is retrospective evidence and its
   elapsed interval includes scheduling. Do not synthesize a current 'running'
   state solely from model output.
5. **Do not add arbitrary tool timeouts.** Legitimate builds, diagnostics, and
   task waits may take minutes. Report the measured stage and duration; only
   fail on a concrete operational error or an independently justified guard.

## Evidence and validation still required

- No runtime integration is implemented by this document.
- Public API absence is established for the inspected tool/provider surfaces;
  proposed debug coverage is explicitly unresolved, not claimed impossible.
- Verify update eligibility and installed version separately before considering
  a VS Code upgrade. Stable application availability does not authorize proposals
  for an extension or make a proposed API Marketplace-safe.

## Sources

- Stable declarations: <https://github.com/microsoft/vscode/blob/1.145.2/src/vscode-dts/vscode.d.ts>
- Baseline declarations: <https://github.com/microsoft/vscode/blob/1.144.0/src/vscode-dts/vscode.d.ts>
- Tool progress: <https://github.com/microsoft/vscode/blob/1.145.2/src/vscode-dts/vscode.proposed.toolProgress.d.ts>
- Private presentation metadata: <https://github.com/microsoft/vscode/blob/1.145.2/src/vscode-dts/vscode.proposed.chatParticipantPrivate.d.ts>
- Chat debug: <https://github.com/microsoft/vscode/blob/1.145.2/src/vscode-dts/vscode.proposed.chatDebug.d.ts>
- <https://github.com/microsoft/vscode/blob/1.145.2/src/vs/workbench/api/common/extHostLanguageModelTools.ts>
- <https://github.com/microsoft/vscode/blob/1.145.2/src/vs/workbench/api/browser/mainThreadLanguageModelTools.ts>
- <https://github.com/microsoft/vscode/blob/1.145.2/src/vs/workbench/contrib/chat/browser/tools/languageModelToolsService.ts>
- <https://github.com/microsoft/vscode/blob/1.145.2/src/vs/workbench/api/browser/mainThreadChatDebug.ts>
- <https://github.com/microsoft/vscode/blob/1.145.2/src/vs/workbench/api/common/extHostChatDebug.ts>
- <https://github.com/microsoft/vscode/blob/1.145.2/src/vs/workbench/contrib/chat/common/chatDebugServiceImpl.ts>