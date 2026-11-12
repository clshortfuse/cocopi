# Participant reference handling

Status: **retired**, 2026-11-12. `@cocopi` and this participant-only implementation were removed for the 1.146 Copilot-first migration. The sections below preserve historical findings, not shipped reference support. The host now owns attachment/reference handling when using a Cocopi provider model; persisted user conversation data is not deleted.

## Implemented resource handling

- Resolve explicit URI/location references using the host document API so unsaved text and selected ranges are respected. Never infer paths from arbitrary strings or call arbitrary reference accessors.
- Restrict resource resolution to file, vscode-remote and already-open untitled documents; fail explicitly for unsupported schemes, oversized content and failed reads.
- Check cancellation before and after each asynchronous read; do not start backend work after cancellation.
- Resolve current and historical references consistently. Historical URI references without a stored snapshot are explicitly current resource content, not a claimed original snapshot; persist resolved references in response metadata for subsequent replay.
- Keep binary image access gated on the actual host binary-reference class and full-build proposal availability, with MIME/size checks. Stable profiles must not access proposal-only APIs.
- Exercise these boundaries with offline injected host fixtures before integration, then validate both package profiles.

- Preserve host-resolved string references in current and historical user turns, as user content rather than instructions.
- Keep prompt text unchanged; append each reference as a separate text content part in host-provided order, without deduplication.
- Reject unsupported reference values explicitly instead of silently sending an incomplete request. Read only explicitly attached URI/location resources and genuine host binary references.
- Validate references before authentication/catalog/network work. Permit reference-only requests when they contain resolved text.
- Demonstrate offline regressions failing before the fix, then passing unchanged. Run check, lint, tests and package validation.

Both build profiles support string and file/location text references. Full builds additionally enable `chatReferenceBinaryData`; Marketplace excludes binary-reference access. Document reads use the host text API, not a PDF/document-format decoder. Historical snapshots are accepted only from adjacent Cocopi request/response turns.

## Validation

Resource/image implementation added after the initial text-only checkpoint: explicit file/remote/location reads, already-open untitled documents, unsaved selections, cancellation checks, bounded text/image input and snapshot replay. Full builds enable the pinned `chatReferenceBinaryData` proposal; Marketplace never reads that API. Unknown objects/accessors and unsupported binary MIME types fail closed. Final validation including tool-loop snapshot persistence: 630 passed, six live tests disabled; both VSIX builds and profile smoke checks pass. Aggregate image input is limited to 10 MiB per resolution, with 5 MiB per image.

Implemented and validated: four added regressions reproduced omissions before the fix; all now pass. The handler fixture required complete mock authentication credentials, without changing its assertions. Full offline validation: 623 passed, six live tests disabled, zero failures; check/lint, both VSIX builds and extracted-provider smoke checks pass. No extension installation or interactive host test performed.