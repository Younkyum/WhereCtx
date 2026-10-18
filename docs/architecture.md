# Architecture

WhereCtx is one Node server and one SQLite database, shipped as one container.
Several people can use one install. Every location row belongs to one user,
and every request acts for exactly one user.

```
phone (OwnTracks, Shortcut, HTTP)    browser (passkey session)       agent (MCP, token)
        │ POST /v1/ingest*                 │ /dashboard, /v1/*              │ POST /mcp
        ▼                                  ▼                                ▼
   ┌────────────────────────── resolve the Principal ───────────────────────────┐
   │ token (device, agent, admin)  or  session (signed-in person)               │
   └──────────────┬───────────────────────────────┬─────────────────────────────┘
                  │ ctx.forUser(userId)           │ ctx.forSession(actor)
                  ▼                               ▼
              UserScope                      AccountScope
   presence, places, events, tokens,     me, workspaces, sharing
   privacy, webhooks, reminders          (accounts/ and sharing/)
                  │
                  ▼
   Normalizer ─► PresenceService ─► geofence engine, privacy policy, stores
                  │
                  ▼
          presence_events ─► webhook dispatcher (HMAC, cursor per hook)
```

## Who a request acts as

`src/auth/principal.ts` defines the `Principal` union:

- `{ via: "token" }`: a device, an agent, or automation presenting a Bearer
  secret. Its scopes are the token's role scopes. REST and MCP resolve it the
  same way.
- `{ via: "session" }`: a person signed in with a passkey and holding the
  session cookie. They have every scope over their own data, and the session
  records when it last proved a passkey (`reauthAt`) for step-up checks.

`src/api/middleware.ts` has two mounts. `authenticate` accepts either kind
and attaches a `UserScope`. `sessionAuth` accepts only a session and attaches
an `AccountScope`. `/v1/me`, `/v1/workspaces`, `/v1/shares`, and
`/v1/people` use `sessionAuth`, so no token reaches them. `/mcp` accepts
tokens only.

## Scopes keep users apart

`src/app/context.ts` builds the dependency container and splits it by who may
cross user boundaries:

- `ctx.system` (`SystemStores`) holds the raw stores and services. Only boot,
  the webhook dispatcher, the periodic sweeps, and the auth boundary use it.
- `ctx.forUser(userId)` returns a `UserScope`. Each method is a store method
  with its first argument, the `UserId`, already bound. Routers and MCP tools
  receive only this scope, so reading another user's data is a type error.
- `ctx.forSession(actor)` returns an `AccountScope` bound the same way to one
  signed-in session. It covers the profile, passkeys, and sessions
  (`SelfService`), workspace actions (`WorkspaceService`), and location
  sharing (`SharingService`).
- `ctx.auth` (`PasskeyAuth`) serves the unauthenticated sign-in ceremonies
  with only the stores they need.

`UserId` is a branded string, so a raw id cannot stand in for one by
accident.

## Request flow (ingest)

1. `src/api/ingest.ts` takes a device token (Bearer, HTTP Basic password, or
   `?token=`) or a session, and reads the body.
2. `src/normalizer/*` turns the generic, iOS Shortcut, or OwnTracks payload
   into one `NormalizedReading`.
3. `PresenceService` (`src/presence/service.ts`) runs per user under a
   `KeyedMutex`:
   - the geofence engine (`src/geofence/*`) computes the status from the
     user's places,
   - the new presence is stored and diffed against the previous one to emit
     `presence.updated`, `presence.entered_place`, `presence.left_place`, and
     `presence.privacy_changed`. A sweep emits `presence.became_stale`.
   - raw history is recorded when enabled, and matching reminders fire.
4. The events are stored, then the webhook dispatcher delivers each user's
   events to that user's hooks. Each hook drains on its own from its cursor,
   with at most 8 drains at once, at most 2 per user, and 10 s per drain,
   so a slow endpoint delays only its own hook.

## Read flow

- Agents read through `src/privacy/policy.ts`: `agentCoarseView` (status,
  label, motion, age, stale, no coordinates) and `authorizePrecise`, a chain of
  deny checks (hidden mode, scope, policy, approval, reason, home protection).
- People read each other through `buildPersonView` in the same file. It shows
  the status name, never a place's name or label, ages in whole minutes, and
  coordinates only for a `precise` share. `hideHomeExact` withholds them at or
  near home and when the owner has no `home` place.

## Accounts

`src/accounts/` holds users, workspaces and memberships, invites, passkeys,
sessions, recovery codes, access codes, and the role registry
(`types.ts`). Role checks run twice. The service checks the registry, and the
SQL write re-checks the actor's current role (`roleSql.ts`), so a role that
changes between the check and the write cannot be exceeded.

WebAuthn runs on `@simplewebauthn/server` (`passkeys.ts`). The RP ID is the
host name of `BASE_URL` and the expected origin is its origin.

Ceremonies are stateless (`ceremonies.ts`). The `options` call returns a
state `{ purpose, binding, challenge, exp, nonce }` signed with HMAC-SHA256
and a per-install key from `server_secrets`. The client sends it back to
`verify`, which checks the signature, the 5-minute expiry, the purpose, and the
binding, then inserts the nonce into `used_nonces`. A second use fails the
insert. Nothing lives in memory, so any instance can finish a ceremony and an
`options` flood cannot push out real ones.

## Location sharing

`src/sharing/` holds `location_shares` (owner, viewer, level,
`hide_home_exact`) and `share_audit`. `SharingService` loads and audits. The
rules live in SQL. A write needs a current common workspace and a viewer
other than the owner. A read re-checks the common workspace.

`share_audit` is its own table, indexed on `(owner_user_id, created_at)`.
Sharing never writes to `presence_events`, so webhooks, MCP, and
`/v1/events` carry no sharing data.

The `memberships_end_orphaned_shares` trigger (migration 0006) runs after a
membership row is deleted. It audits as `membership_ended` and deletes every
share whose two people no longer have a workspace in common. Every way of
leaving a workspace goes through it, including paths added later.

## Dashboard

`web/` is a React app built with the Astryx design system (devDependencies
only). Vite builds it into `dist/web` with base `/dashboard/`.
`src/dashboard/router.ts` reads that build once at startup into a table
keyed by path and serves it at `/dashboard`. `index.html` is `no-cache`, and
the hashed files under `assets/` are cached for a year. A missing build
answers `503`. The runtime image contains `dist/web` and no React.

The dashboard talks to `/v1/*` with the session cookie. It keeps only the
language, the color mode, and the selected workspace in `localStorage`. No credential is stored there.

The CSP (`src/app/server.ts`) is `script-src 'self'` and `img-src 'self'`.
`style-src` allows `'unsafe-inline'` for the two stylesheets the design system
adds at runtime. See [decisions.md](decisions.md#2026-10-18-multi-user-accounts-sharing-and-the-new-dashboard).

## Components

| Path | Responsibility |
|------|----------------|
| `src/config.ts` | Typed env config. `.env.example` lists every variable, and a test keeps them in step. |
| `src/db/` | Drizzle schema, libsql connection, migrations from `drizzle/` |
| `src/auth/` | `Principal`, token hashing and seeding, role scopes |
| `src/accounts/` | People, workspaces, invites, passkeys, sessions, recovery, ceremonies |
| `src/sharing/` | Shares, share audit, person views |
| `src/devices/` | Pairing: OwnTracks config, link, and QR code; Shortcut settings |
| `src/normalizer/` | Source payloads to `NormalizedReading` |
| `src/geofence/` | Haversine distance, geohash, status |
| `src/privacy/` | Privacy settings and the policy views |
| `src/store/` | Presence, places, events, history, reminders, webhooks |
| `src/presence/` | `PresenceService` |
| `src/api/` | Hono routers, auth middleware, rate limiting |
| `src/mcp/` | MCP server (9 tools) and the raw-Node `/mcp` handler |
| `src/webhooks/` | Dispatcher, SSRF guard, secret encryption |
| `src/dashboard/` | Serves `dist/web` |
| `src/app/` | Context, scopes, and HTTP app assembly |
| `src/cli.ts` | `reset-access` |
| `web/` | The dashboard |

## Composition

`src/index.ts` creates one Node `http.Server`. A request whose path is `/mcp`
goes to the MCP handler, which writes to the Node response directly.
Everything else goes to the Hono app through `getRequestListener`. Boot also
prints the setup code while no passkey exists, starts the webhook dispatcher,
the stale sweep every minute, and the prune sweep every 6 hours. The prune
sweep removes old events, dead letters, share audit rows, sessions, invites,
nonces, and access codes.

## Storage

SQLite through libsql, which ships prebuilt binaries. The migrations in
`drizzle/` are the source of truth and run at every boot. In Docker the
database is `/data/wherectx.db` on a volume.
