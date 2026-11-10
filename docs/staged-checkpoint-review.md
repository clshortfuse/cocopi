# Staged development checkpoint review — 2026-11-10

## Subsequent review correction

The package provenance and digest below describe the earlier checkpoint, not
the later mutable-hook safety correction. Prefix digest reuse is now discarded
when preparation/decision callbacks are present, fixing an anchor-versus-wire
mismatch reproduced during staged review. The normal worker path supplies such
callbacks, so prior worker-path reuse performance claims do not apply after
the correction. See `docs/transport-retention-checkpoint.md` for regressions and
validation. The user's usual working-tree `out/cocopi-1.0.0.vsix` was subsequently
rebuilt with the fix using `npm run package:vsix`; it is distinct from the older
isolated staged-only `0.0.1` artifact documented below. Nothing was installed.

## Reviewed scope

Runtime changes are limited to:

- Leading inline-code/filename presentation separation after tool output,
  including terminal completion summaries. This is a host compatibility shim;
  no installed VS Code source is patched.
- Default bridged tools to explicit non-strict decoding, with manifest/runtime
  agreement and explicit strict opt-in preserved. This is upstream alignment
  and an operationally successful mitigation, not a proven whitespace cause.
- Request-local continuation-prefix digest reuse and the shared-prefix scan
  prerequisite. Full/delta selection and anchor digests are preserved by
  focused regressions. No global cache of input objects or serialized history.

Other staged files are fixture lifecycle fixes, regression tests, profiling
utilities, and investigation/measurement documentation. Development profiling
requires newer Node APIs only when explicitly selected; it is not shipped in
the VSIX or enabled by the extension.

Existing unstaged release/Marketplace, SDK, transport serialization, streamed
output retention, LRU, worker-metric, history-delta and other work is excluded.
The package checker had a stale three-proposal expectation despite the staged
manifest already listing six. Staged only its matching six-proposal contract
and an explicit assertion of the new `toolStrict: false` default; did not pull
in unrelated checker/release edits.

## Reproducible package provenance

Build input index tree: `a4d7f0cbc4dc2168ca73471de5ac2eda9f8f66c5`.
An independent archive of the index was installed using cached dependencies,
without copying `.env`, unstaged source, or linking workspace `node_modules`.
Later additions to this review are documentation-only and are not packaged.

Snapshot directory:
`C:\Users\clsho\AppData\Local\Temp\cocopi-package-checkpoint-b4d028c27f254569b0e3da8aa7d6e130`

Artifact relative to that snapshot: `out/cocopi-0.0.1.vsix`.

- Bytes: 542245; archive entries: 150.
- SHA-256: `b4063d5698e1633bb045ce0b0b565f4b0bde53bc8be2cbb52bb92024dd97b157`.
- `npm run package:check` passes: generated declarations, manifest contracts,
  and npm dry-run package inventory.
- `npm run package:vsix` succeeds using the staged packaging implementation.
- Extracted runtime files for WebSocket transport, configuration, and model
  provider match the index byte-for-byte.
- Worker entrypoints, guard, declarations, and `ws` package/runtime are present.
- No local `.env`, `.env.local`, `.git`, test tree, or scripts tree is included.
  `.env.example` is intentionally included as documentation.

## Validation and extracted-package smoke

The isolated snapshot passes typecheck, lint, and offline tests with the
configured coverage thresholds (90% lines, 75% branches, 90% functions).
Measured coverage: **93.28% lines, 83.75% branches, 94.53% functions**.
Tests are explicitly enumerated excluding `codex-live.test.js`; do not run the
ordinary coverage glob when live credentials must remain unused. The preceding
same-runtime isolated validation passed all 739 offline tests.

The extracted VSIX's actual `CodexWorkerTransport` was run against a task-owned
localhost fixture. It loads packaged worker code and resolves packaged `ws`,
completes two generations, uses the previous response ID plus one incremental
input item on the second request, and releases host invocation/upload
reservations. Exactly two fixture generations occur; no remote requests or
generated tool execution. Only these task-created workers are shut down.

## Readiness and next work

This is a verified **development checkpoint**, not a Marketplace release:

- The staged manifest remains version `0.0.1`, not the unstaged `1.0.0` release
  worktree manifest.
- Proposed APIs remain enabled. Marketplace stripping/profile work is excluded.
- The staged packager uses `--skip-license`; local untracked license/changelog
  release files are not silently staged or claimed as part of this artifact.
- No publish, install, editor reload, commit, or user-process management occurs.

Review/commit this checkpoint only when requested. The next performance target
is host JSON serialization and UTF-8 encoding, subject to exact byte limits,
ownership, cancellation, and credential handling. Offloading and delta IPC
remain disabled. The old whitespace-generation root cause remains unconfirmed;
the day-long successful user run is operational evidence, not causal proof.