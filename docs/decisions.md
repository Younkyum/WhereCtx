# WhereCtx — Design Decisions (v0.1)

This document records cross-cutting decisions so later phases (and reviewers)
have a single, authoritative reference. It resolves the plan's "Open Questions"
(section 22) and the ambiguities surfaced during Phase 1 review.

## Open Questions (plan §22) — resolved

| # | Question | Decision |
|---|----------|----------|
| 1 | Node.js or Bun? | **Node.js** (>=20). Broadest self-hosting compatibility; libsql prebuilds avoid native compilation. |
| 2 | MCP transport? | **Streamable HTTP** for v0.1 (the plan's config examples advertise a URL). stdio can be added later. |
| 3 | Precise approval interactive vs static? | **Static policy only** in v0.1 (`ALLOW_PRECISE_TO_AGENT`, `PRECISE_REQUIRES_REASON`). Interactive approval is v0.2. |
| 4 | Store raw history by default? | **No.** `STORE_RAW_HISTORY=false`. Presence-first philosophy. |
| 5 | Reverse geocoding in v0.1? | **No.** Coarse location uses geohash only. Reverse geocoding is an optional v0.2 integration. |
| 6 | Single or multi-user in v0.1? | **Single-user.** All presence is attributed to `USER_ID` (default `"default"`). See "Single-user scope" below. |
| 7 | `near_home`/`home` separate or distance metadata? | **Separate statuses** (the plan enumerates both). `near_*` is derived from `radiusM * NEAR_RADIUS_MULTIPLIER`. |

## Config vs DB precedence (privacy / retention / stale)

Several values exist both as environment config **and** as persisted DB rows
(`privacy_settings`, and per-reading fields on `presence`). The rule:

> **Environment seeds the `privacy_settings` row on first boot. Thereafter the
> persisted row is authoritative.** Dashboard/admin edits write the DB row and
> must stick across restarts; env changes only affect a database that has not
> yet been seeded.

Naming is aligned on `defaultAgentAccess` across the type (`PrivacySettings`),
the DB column (`default_agent_access`), and the config field
(`config.privacy.defaultAgentAccess`). The env **variable** stays
`DEFAULT_AGENT_PRIVACY` for backward-compatible ergonomics.

`staleAfterSec` is stored per-reading on the `presence` row (captured at ingest
time from config) so that changing the global default does not retroactively
re-age historical readings.

## Single-user scope (v0.1)

v0.1 is explicitly single-user. `user_id` columns exist on the naturally
user-owned entities (`presence`, `places`, `privacy_settings`,
`location_history`) to make the v0.2 multi-user migration cheaper. Global/ops
entities (`tokens`, `webhooks`, `reminders`, `presence_events`) are intentionally
**not** user-scoped in v0.1. All store queries filter by `config.userId`. Multi-
user (plan §15) will add the remaining `user_id` columns and per-token user
binding in one migration.

## Label fallback

`PresenceContext.label` and the DB `label` column are nullable, but the agent-
facing `CoarsePresenceView.label` is a required string. The presence-store
mapping layer derives a fallback label from `status` (e.g. `near_home` →
"near home") whenever an explicit label is absent.

## Token hardening (implemented in Phase 2 bootstrap)

The `.env.example` ships placeholder tokens (`change-me-*`). The Phase 2 token
bootstrap **refuses to seed** any token that still matches `/^change-me/` or is
shorter than 24 characters, emitting a loud warning. Operators are directed to
generate strong random tokens. The default `HOST=0.0.0.0` bind is required for
Docker; docs instruct operators to keep WhereCtx behind a reverse proxy and never
expose it raw with placeholder tokens.

## Timestamps

All timestamp columns store app-generated **ISO-8601** strings
(`new Date().toISOString()`). SQL `CURRENT_TIMESTAMP` defaults are intentionally
avoided (different format → broken `updatedAgoSec` math and lexical sorting).
