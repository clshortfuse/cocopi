# Leading filename hidden after edit output

## Confirmed boundary

The affected answer's 120 text deltas and completed payload agree on all 575
characters, including its leading inline-code filename. The persisted chat
stores that filename as an inline reference; subsequent prose starts with
` now compiles`. The missing filename is a display-boundary issue, not transport
truncation or an incomplete model answer.

The last persistence record was an array append, not a complete response snapshot.
Replaying the earlier response patches revealed an edited-file block immediately
before the answer: Markdown fence, undo stop, codeblock URI, text edit group,
closing Markdown fence, then the filename reference and final prose. The edit
Markdown has no base URI; the prose Markdown has a workspace base URI.

Installed VS Code 1.144.0, commit
`2c33b50b16c472efe58357d1d2a8a5414bc23fbf`, annotates these parts as follows:

1. Inline references unconditionally append to the preceding Markdown block,
   skipping text edit groups/undo stops when choosing that block.
2. The filename therefore becomes part of the edit-block Markdown.
3. Normal prose cannot merge with that block because their base URI properties
   differ. The host's standalone-reference compatibility fallback does not apply:
   the previous block also contains the edit fence and URI, not just a reference.
4. The final prose block starts without its filename. The preceding Markdown is
   rendered as edited-file output, so retaining the filename in persisted data
   does not guarantee it appears in the visible final answer.

## Regression and local compatibility fix

`test/fixtures/vscode-leading-anchor-annotation.txt` contains the exact installed
annotation function, verified byte-for-byte against the installed bundle when
captured, with MIT attribution and commit provenance. The offline test supplies
minimal URI/Markdown dependencies and sanitized edit-boundary data. Balanced code
fences and merge-property comparison are scoped to this fixture, not presented
as a complete rendering harness. It checks that the filename belongs to the final
prose block, rather than merely appearing somewhere in the annotation output.

The test first failed with final prose ` now compiles.`. It passes unchanged
after Cocopi establishes a normal-Markdown paragraph boundary before leading
backtick text on a tool-result follow-up. This causes the host to associate the
subsequent inline file reference with the final prose instead of the earlier
edit block. The 120 delta boundaries, including the isolated initial backtick,
are represented by the corresponding fragmented-prefix regression pattern.

The fix adds two leading newlines to the reported presentation text only; it
does not rewrite the filename or model/transport payloads. Ordinary prose,
already whitespace-prefixed text, and non-tool-result requests are unchanged.
The terminal `task_complete` summary path gets the same leading-code boundary
because it otherwise bypasses the streamed text reporter. This is an explicit
Cocopi compatibility workaround for a core grouping bug, not an installed VS Code
patch or a claim of end-to-end UI verification. A rendered-host acceptance check
remains necessary; no window is reloaded or controlled by these tests.

Source reference:
<https://github.com/microsoft/vscode/blob/2c33b50b16c472efe58357d1d2a8a5414bc23fbf/src/vs/workbench/contrib/chat/common/widget/annotations.ts>