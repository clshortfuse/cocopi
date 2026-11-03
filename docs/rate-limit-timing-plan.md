# Preserve rate-limit timing

The pinned languageModelRateLimit declaration accepts retryAfter in milliseconds. Preserve terminal HTTP Retry-After through a typed HTTP error, worker serialization, and the provider's RateLimited mapping. Keep local retry sleeps capped independently; do not cap the server's host backoff hint to 30 seconds. Ignore invalid values and preserve existing sanitized error messages. Stable builds retain their existing fallback. The upstream SDK proxy's HTTP 502 translation remains outside this fix.

Validation: add a failing end-to-end offline boundary regression (HTTP error → worker encode/decode → provider error), then run focused tests, check/lint and full validation.

Implemented: the boundary regression failed with undefined instead of 120000, then passed. Cases cover seconds, dates, elapsed dates, zero, invalid and nonfinite values. Existing local sleep-cap tests continue to pass. Final offline suite: 624 passed, six live tests disabled, zero failures; check/lint/coverage and both packaged-profile smoke checks pass. No live requests or host changes were made.