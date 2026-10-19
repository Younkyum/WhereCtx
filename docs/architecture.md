# Architecture

WhereCtx is one Node server and one SQLite database, shipped as one container.
Several people can use one install. Every location row belongs to one user,
and every request acts for exactly one user.

```
phone (OwnTracks, Shortcut, HTTP)    browser (passkey session)   agent (MCP, token or OAuth)
        │ POST /v1/ingest*                 │ /dashboard, /v1/*              │ POST /mcp
        ▼                                  ▼                                ▼
   ┌────────────────────────── resolve the Principal ───────────────────────────┐
   │ token (device, agent, admin), session (signed-in person), or oauth (/mcp)  │
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
- `{ via: "oauth" }`: an MCP client presenting an OAuth access token a person
  consented to. Its scopes come from the registry in `src/oauth/scopes.ts`.
  Only `/mcp` resolves it; REST's environment type excludes it.

`src/api/middleware.ts` has two mounts. `authenticate` accepts a token or a
session and attaches a `UserScope`. `sessionAuth` accepts only a session and
attaches an `AccountScope`. `/v1/me`, `/v1/workspaces`, `/v1/shares`,
`/v1/people`, `/v1/oauth`, and the consent API under `/oauth/interaction/`
use `sessionAuth`, so no token reaches them. `/mcp` accepts a
WhereCtx token or an OAuth access token.

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
   - the geofence engine (`src/geofence/*`) finds the place the reading is
     inside (the raw verdict), the dwell reducer turns it into the confirmed
     place, and the status follows the confirmed place (see
     [Geofencing](#geofencing)). The reading's freshness window comes from
     its source (`src/presence/freshness.ts`),
   - approach rings are checked, and the new presence is stored with its
     pending enter or leave. The step's events are `presence.updated`,
     `presence.entered_place`, `presence.left_place`,
     `presence.approaching_place` and `presence.privacy_changed`, each place
     event only when its place records that type. A sweep emits
     `presence.became_stale`, and another confirms a pending enter or leave.
   - raw history is recorded when enabled, and the reminders of a place just
     entered fire unless the place has `notifyReminders` off.
4. The events are stored, then the webhook dispatcher delivers each user's
   events to that user's hooks. Each hook drains on its own from its cursor,
   with at most 8 drains at once, at most 2 per user, and 10 s per drain,
   so a slow endpoint delays only its own hook.

## Geofencing

A place is a circle or a polygon. `src/geofence/shape.ts` turns either into
one tagged shape, and `measurePlace` answers every point-against-place
question: inside, near, distance to the boundary, and distance to the
anchor. The engine, MCP `is_near_place`, history's place labels, the maps
near-home guard and approach detection all call it. A place keeps
`lat`/`lon`/`radiusM` as its anchor circle: the geofence itself for a
circle, the centroid and circumradius of a polygon, computed when the
polygon is saved. Overlapping places rank by anchor distance.
`src/geofence/polygon.ts` validates a ring and measures in a local metric
projection around the centroid; a polygon's near band is the band an
equal-area circle gets. The dashboard maps draw every place from its
anchor, so a polygon shows as its circumcircle for now.

The dwell reducer (`src/geofence/dwell.ts`) holds one confirmed place. A
leave waits out the place's `exitAfterSec` from the first reading outside;
an enter waits out `enterAfterSec` from the first reading inside; a reading
back in the confirmed place cancels both. A reading in a place that lies
inside the confirmed one (a garden inside home) starts no leave: the inner
place is a candidate, and once its enter is confirmed it takes over
directly (left home, entered garden). Its state lives on the presence
row (`current_place_name`, `pending_exit_since`, `pending_place_name`,
`pending_place_since`), so a restart keeps a pending transition. With
every delay at 0 a step confirms at once, a plain geofence. The status,
label and coarse place type follow the confirmed place; with none, the
status is what it would be inside no place (`near_home`, `near_work`,
`away`, `transit`).

`PresenceService.sweepDwell` runs on the stale sweep's minute: one query for
rows with a pending field, then a dwell step per user, under the user's
lock, with no new reading. Dwell therefore resolves to about a minute.
Waits are timed by server receive time, not the device's clock: device
timestamps are not trusted, and a queue of old readings arriving together
does not satisfy a wait by itself.
Every step, a sweep and a place change included, measures the latest point
against the places as they are then. No enter with a delay is confirmed
while the latest reading is driving, in transit or faster than 3 m/s, so
driving past such a place does not count; a leave may be confirmed either
way. A deleted confirmed place leaves at once.

Approach detection (`src/geofence/approach.ts`) runs on readings only. It
fires `presence.approaching_place` once when a reading moves at least
25 m (or its accuracy) toward a place with `approachM` set, inside that
ring, and not into the confirmed or pending place; it re-arms once readings
are past 1.1 x the ring. The fired names are kept in `approached_places`.

Events of a place with `notifyWebhooks` off are stored with `webhook = 0`,
and so is `presence.updated` while inside it; the dispatcher's event read
filters `webhook = 1` in SQL. A hook with a place filter
(`webhooks.places`) gets place events only for those places;
`wants()` in the dispatcher is the one match.

## Read flow

- Agents read through `src/privacy/policy.ts`: `agentCoarseView` (status,
  label, motion, age, freshness, the area when allowed, no coordinates) and `authorizePrecise`, a chain of
  deny checks (hidden mode, scope, policy, approval, reason, home protection).
- People read each other through `buildPersonView` in the same file. It shows
  the status name, never a place's name or label, ages in whole minutes, and
  coordinates only for a `precise` share. `hideHomeExact` withholds them at or
  near home and when the owner has no `home` place.

## Activity logs

`src/activity/` holds two per-user logs and the one helper that writes the
first. Neither holds coordinates.

- `access_log` records every agent or token request. `accessRecorder(scope,
  principal, surface)` turns a principal into the credential to name
  (`credentialOf`: a token by its id and name, an OAuth client by its grant
  id and client name; a session maps to none, since the owner reading their
  own data is not an agent read) and swallows write failures into the server log.
  The store folds an identical request within a minute into the previous row
  (`count`, `last_at`).
- What a request came to is an `AccessDecision` (`outcome`, `denial`,
  `precise`) set by the code that decided it, never read back from a body.
  REST: the scope guards refuse through `refuse`, and handlers call `decide`
  (hidden mode, a precise refusal, a place list with coordinates); `settle`
  fills in the rest from the status, with any `5xx` an `error`. MCP: each tool
  returns a `Reply` holding its decision next to its answer.
- REST: `buildApp` mounts `auditAccess` (`src/api/accessAudit.ts`) ahead of
  the credential check on every `/v1` prefix but `/v1/ingest` and
  `/v1/auth`, and on the OAuth consent API. It names the action from the
  matched route pattern (`REST_ACTIONS`; `account` for the session-only
  routes; `unknown` when no route matched). A test sends a token request to
  every mounted route, and holds the routes left out (health, the dashboard,
  the public OAuth metadata) to a list with reasons.
- MCP: `buildMcpServer` watches the transport its server connects to and
  writes one row per `tools/call` when the response goes out, so calls the
  SDK refuses before a tool runs are recorded too. `/mcp` records a token
  without `read_presence`, and caps a batch at 10 messages.
- `ACCESS_ACTIONS` names every action; tests hold both surfaces to it, and
  the dashboard has copy for each.
- `ingest_log` records every authenticated upload in one middleware on the
  ingest router, ahead of the scope check. Handlers set the verdict
  (`ingestVerdict`) for a payload they could not read, OwnTracks included,
  which always answers `200`; a scope refusal comes from the access
  decision, and a `5xx` is `error`.
- `/v1/activity/*` reads them for the signed-in person only (`requireSession`).

## Maps

`src/geo/` holds one adapter per provider (`kakao.ts`, `naver.ts`), each a
GET with a 5 s timeout, a 4 MB body cap, no retries, the response parsed
with zod (every kept string cleaned and capped) and every failure mapped to
a `GeoError` kind. Every adapter is reached through `roundingProvider`
(`types.ts`), which cuts each point to three decimals, so no caller can send
an unrounded one. The rest is split by concern:

- `keys.ts` (`GeoKeys`): which provider and key (the person's sealed key,
  else the operator's), the per-person, per-key and daily budgets, and the
  only place a provider is called, with an access log row per call.
- `eta.ts`: what an ETA answer may say to whom (the freshness gate,
  near home by distance, an agent's coarse numbers and filtered roads).
- `area.ts` (`AreaRefresher`): the background area lookup.
- `service.ts` (`GeoService`): search and ETA for one caller, and the facade
  route handlers and MCP tools reach through `scope.geo`, bound to one user.
- `replies.ts`: each outcome as the REST status, body and access decision,
  shared by `api/geo.ts` and the MCP tools.

The area of a reading is looked up after the reading is stored:
`PresenceService.processReading` drops city and area as it stores a reading
more than 200 m from the point they were looked up for, then calls
`afterReading` once its lock is released (as does `reevaluateCurrent` after
a place change). `AreaRefresher.refresh` decides whether a lookup is due,
schedules a trailing one when the throttle holds, and
`PresenceService.setArea` writes the region names and the point back under
the lock, only if the person has not moved on since. Shutdown cancels
trailing lookups and waits for running ones. Every provider call is
server-side.

The one exception is the dashboard's map. `mapSdk.ts` (`MAP_SDKS`,
`SDK_ORIGINS`) names, per provider, the map key kind, the script URL and
origin, and every host the script loads from. `GET /v1/geo/map-config` hands
the signed-in owner their script URL. The provider's script never runs in
the dashboard page: `MapView` (`web/src/MapView.tsx`) frames
`/dashboard/map.html`, whose script (`web/src/mapFrame.ts`) loads the
provider's script and draws through one adapter per provider. The two talk
only by `postMessage`, in the shapes and parsers of `web/src/mapScene.ts`:
the dashboard sends `load` and `draw`, the frame answers `hello`, `ready`,
`failed` (`refused`, `blocked` or `load`) and `pick`. `MapView` falls back
to the existing views when there is no map or it fails, and says why.

## Server log

`src/util/log.ts` is the only writer to stdout and stderr (a source test
fails on `console.*` anywhere else under `src/`). A log call never throws. It
redacts every entry when it is written: values under keys whose last word is
sensitive, and credentials and coordinates inside any string. An error is
serialized as name, first message line, code, stack frames and cause, so a
`DrizzleQueryError` shows its SQL but never its parameters. It keeps the last
1000 entries in memory for `GET /v1/admin/logs`, which only the operator
(`USER_ID`, see `api/admin.ts` `isOperator`) can read.

The setup code, access codes and a generated admin token are a `Secret`
(`src/util/secret.ts`), which prints as `[secret]` and which `log.info`,
`warn`, `error` and `debug` refuse at the type level. `log.banner`, a tagged
template, is the one writer that reveals one, to stdout only.

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

The CSP (`src/app/securityHeaders.ts`) is `script-src 'self'`, `img-src
'self'` and `frame-src 'self'`. `style-src` allows `'unsafe-inline'` for the
two stylesheets the design system adds at runtime. `pageSecurity` is the one
writer of the CSP, `Referrer-Policy` and `X-Frame-Options`, by path alone:
every response gets the strict policy, `no-referrer` and `DENY`, but
`/dashboard/map.html`, the map frame, which gets both providers' map hosts
in `script-src`, `img-src` and `connect-src`, `frame-ancestors 'self'`,
`SAMEORIGIN` and `strict-origin`. No response depends on who asks, so
`index.html` and `map.html` are plain `no-cache` files. See
[decisions.md](decisions.md#2026-10-19-maps-in-the-dashboard).

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
| `src/geofence/` | Haversine distance, geohash, place shapes and polygons, status, the dwell reducer, approach detection |
| `src/privacy/` | Privacy settings and the policy views |
| `src/store/` | Presence, places, events, history, reminders, webhooks |
| `src/presence/` | `PresenceService` |
| `src/api/` | Hono routers, auth middleware, rate limiting |
| `src/mcp/` | MCP server (11 tools, each recorded in the access log) and the raw-Node `/mcp` handler |
| `src/oauth/` | OAuth 2.1 authorization server for MCP clients (oidc-provider), its store, scopes, and consent API |
| `src/activity/` | Access log and ingest log stores, the recording helper |
| `src/geo/` | Maps providers (Kakao, Naver, a fake) behind one rounding boundary; keys and budgets, the ETA policy, the background area lookup, search and ETA, each provider call access-logged |
| `src/webhooks/` | Dispatcher, delivery payload (shared with the dashboard's example), SSRF guard, secret encryption |
| `src/dashboard/` | Serves `dist/web` |
| `src/app/` | Context, scopes, and HTTP app assembly |
| `src/cli.ts` | `reset-access` |
| `web/` | The dashboard |

## Composition

`src/app/boot.ts` (`startServer`, called by `src/index.ts`) creates one Node
`http.Server` over the listener in `src/app/listener.ts`, which splits
requests into three surfaces:

- `/mcp` goes to the MCP handler, which writes to the Node response directly.
- The OAuth protocol endpoints (`/oauth/*` except `/oauth/interaction/*`, and
  the two authorization server metadata paths) go to oidc-provider.
- Everything else, the consent API under `/oauth/interaction/*` included, goes
  to the Hono app through `getRequestListener`.

Boot also prints the setup code while no passkey exists, starts the webhook
dispatcher, the stale and dwell sweeps every minute, and the prune sweep
(`src/app/prune.ts`) every 6 hours. The prune sweep removes old events, dead
letters, share audit rows, access and ingest log rows, each person's history
past their retention (the server default for a person with no settings row,
in batches), sessions, invites, nonces, access codes, and expired OAuth rows.

## Storage

SQLite through libsql, which ships prebuilt binaries. The migrations in
`drizzle/` are the source of truth and run at every boot. In Docker the
database is `/data/wherectx.db` on a volume.
