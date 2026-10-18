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
| 6 | Single or multi-user in v0.1? | **Single-user** in v0.1; data is now owned per user, with the token's owner deciding whose data a request sees. See "Single-user scope" below. |
| 7 | `near_home`/`home` separate or distance metadata? | **Separate statuses** (the plan enumerates both). `near_*` is derived from `radiusM * NEAR_RADIUS_MULTIPLIER`. |

## Config vs DB precedence (privacy / retention / stale)

Several values exist both as environment config **and** as persisted DB rows
(`privacy_settings`, and per-reading fields on `presence`). The rule:

> **Environment seeds a user's `privacy_settings` row the first time it is
> read** (at boot for `USER_ID`, on first request for any other user).
> **Thereafter the persisted row is authoritative.** Dashboard/admin edits write
> the DB row and must stick across restarts; env changes only affect users whose
> row has not yet been seeded.

Naming is aligned on `defaultAgentAccess` across the type (`PrivacySettings`),
the DB column (`default_agent_access`), and the config field
(`config.privacy.defaultAgentAccess`). The env **variable** stays
`DEFAULT_AGENT_PRIVACY` for backward-compatible ergonomics.

`staleAfterSec` is stored per-reading on the `presence` row (captured at ingest
time from config) so that changing the global default does not retroactively
re-age historical readings.

## Single-user scope (v0.1)

v0.1 shipped single-user. Migration 0004 rebuilt `tokens`, `webhooks`,
`reminders`, and `presence_events` with a `user_id NOT NULL` column and no
default, so every user-data table is now owned by a user. Pre-existing rows went
to the owner of the single v0.1 `privacy_settings` row (the `USER_ID` that
install booted with), or `'default'` if there was none. Every token belongs to a
user, and every REST route and MCP tool works through a scope bound to the user
of the presented token.

`USER_ID` names the owner of the env-configured bootstrap tokens and of the
settings row seeded at boot, and if that user has no admin token one is
generated for it. Changing `USER_ID` after first boot does not move any data:
existing rows and env tokens keep their original owner (boot warns when an env
token belongs to someone else).

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

## Privacy enforcement model (hardened during Phase 2 review)

Enforcement lives in `src/privacy/policy.ts` and is exercised end-to-end by tests:

- **`hidden` mode is fully enforced.** `agentCoarseView()` returns `null` and
  `authorizePrecise()` denies when `defaultAgentAccess === "hidden"`. Agents see
  nothing in hidden mode.
- **Home protection is a deny, not a blur.** When `hideHomeExactCoordinates` is
  set and the user is at/near a `home` place, precise location is *refused*
  outright rather than coarsened. (Rounding to N decimals is not home-address
  anonymization.) Operators who want home coordinates exposed must disable the
  flag.
- **Agent coarse view never carries raw GPS or geohash.** `CoarsePresenceView`
  is status/label/motion/age/stale/privacy only. The stored geohash is internal
  (admin) and is never surfaced to agents.
- **Live settings are authoritative at view time.** Views/authorization read the
  persisted `PrivacySettings`, not the per-reading `presence.privacy` snapshot,
  so a tightened policy applies immediately.
- **`preciseRequiresApproval`** has no interactive channel in v0.1, so when set
  `true` it denies precise access (fail-closed) rather than silently granting.
- **Device-controlled timestamps are distrusted when implausibly future.**
  `coerceIso` clamps an `updatedAt` more than 5 minutes ahead of receive time to
  the receive time, so a skewed/malicious device cannot pin presence permanently
  "fresh" (staleness is a safety signal).
- **Per-user serialization.** Ingest, stale checks, and privacy changes are
  serialized per user (`KeyedMutex`) so the read-diff-write sequence cannot race.

## Timestamps

All timestamp columns store app-generated **ISO-8601** strings
(`new Date().toISOString()`). SQL `CURRENT_TIMESTAMP` defaults are intentionally
avoided (different format → broken `updatedAgoSec` math and lexical sorting).
