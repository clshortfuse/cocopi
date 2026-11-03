# Transport and recovery fixes

## Scope

- Normalize reasoning input with a missing summary to `summary: []` without mutating replay objects. Treat omitted and empty summaries as equivalent for continuation digests, but retain visible-summary differences.
- Recognize the backend's `Invalid previous_response_id` error variant. Preserve existing recovery restrictions: only automatically reduced requests with complete original history may fall back to full SSE before output; explicit delta-only requests must not be replayed as full history.
- Preserve terminal HTTP 429 `Retry-After` timing through a typed HTTP error and serialized worker errors. Keep local retry sleeps capped at 30 seconds independently of the terminal hint. Retain sanitized diagnostics and ignore malformed or nonfinite timing values.

## Integration boundary

The transport patch does not adopt proposed VS Code APIs, change provider metadata, add live-session integration, or enable opaque thinking. Provider `RateLimited` projection and its end-to-end provider regression remain part of the pending VS Code compatibility changes. The typed transport hint is preserved for that later integration.

## Validation

Run focused HTTP, Responses, WebSocket, and worker tests; then run the repository type check, lint, and test suite. Stage only transport implementations and standalone regression coverage, preserving unrelated worktree hunks. No live API checks are required.