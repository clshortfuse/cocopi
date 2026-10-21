# Banked reset expiration

- Read `/wham/rate-limit-reset-credits` with existing authenticated quota refresh.
- Retain only expiration timestamps for available, plan-supported Codex resets; never retain credit or account identifiers.
- Show available count and earliest unexpired deadline separately from regular replenishment, in local time with a countdown.
- Keep regular quota refresh functional when the supplementary endpoint is unavailable.
- Validate parser filtering, authenticated endpoint routing, persistence, and status presentation with offline tests.