# WhereCtx design decisions

This document records cross-cutting decisions so later phases and reviewers
have one reference. It started by resolving the plan's "Open Questions"
(section 22) for v0.1. Later entries are dated.

## Open Questions (plan §22) — resolved

| # | Question | Decision |
|---|----------|----------|
| 1 | Node.js or Bun? | **Node.js** (`^22.12 \|\| >=24`). Broadest self-hosting compatibility; libsql prebuilds avoid native compilation. |
| 2 | MCP transport? | **Streamable HTTP** for v0.1 (the plan's config examples advertise a URL). stdio can be added later. |
| 3 | Precise approval interactive vs static? | **Static policy only** in v0.1 (`ALLOW_PRECISE_TO_AGENT`, `PRECISE_REQUIRES_REASON`). Interactive approval is v0.2. |
| 4 | Store raw history by default? | **No.** `STORE_RAW_HISTORY=false`. Presence-first philosophy. |
| 5 | Reverse geocoding in v0.1? | **No.** Coarse location uses geohash only. Reverse geocoding is an optional v0.2 integration. |
| 6 | Single or multi-user in v0.1? | **Single-user** in v0.1. Since then every row is owned by a user and several people share one install. See "Single-user scope" and the 2026-10-18 entry below. |
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
token belongs to someone else). It does move the operator role, which is
whoever `USER_ID` names (the Server logs view, `isOperator`); `reset-access`
lets that person sign in if they have no passkey.

## Accounts, workspaces, passkeys

People sign in with passkeys and hold a browser session; tokens stay the
credential of agents, devices, and automation. Sessions and passkeys are
implemented in-house on `@simplewebauthn/server` rather than an auth framework:
the surface is small (no passwords, no email, no OAuth) and keeping it in the
codebase keeps the per-user scoping model in one place.

- **Workspaces group people, not data.** Every location row still belongs to
  one user. A workspace role grants rights over the workspace itself (name,
  members, invites), never over another member's location.
- **Roles are a registry** (`src/accounts/types.ts`): what each role may do,
  and which roles it may grant or act on. Admins cannot create or touch owners.
  Non-members get 404 for a workspace, never 403. The service checks the
  registry before a write, and the write re-checks it in SQL
  (`src/accounts/roleSql.ts`): an UPDATE or DELETE on a membership only lands
  if the actor's *current* role may act on the target's *current* role (and on
  the role being granted), next to the guard that a workspace keeps an owner.
  A role that changes between the check and the write cannot be exceeded.
- **Account scope.** Like `forUser(userId)` for location data,
  `forSession(actor)` hands `/v1/me` and `/v1/workspaces` handlers an
  `AccountScope` whose methods are pre-bound to the signed-in session. The
  sign-in ceremonies get only `PasskeyAuth`, built from exactly the stores it
  uses.
- **First owner.** While no passkey exists, boot prints a one-time setup code
  and stores its hash in `server_secrets`, so any instance sharing the
  database can check it; a restart replaces it. Only someone who can read the
  server log can register the first passkey, which goes to `USER_ID`.
  Migration 0005 made every pre-existing user the owner of their own
  "Default" workspace; boot does the same for `USER_ID` on a fresh install.
- **Operator break-glass.** `node dist/cli.js reset-access <userId>` (or
  `npm run reset-access -- <userId>`) stores a one-time access code for that
  user (hashed, valid 1 hour) and prints it. `POST
  /v1/auth/access-code/options|verify` registers a passkey with it, signs the
  user out everywhere else, and issues new recovery codes. It is the way back
  for someone with no passkey and no recovery code, and how migrated users
  other than `USER_ID` claim their accounts. Shell access to the server is the
  same trust as reading the setup code.
- **Invites, not email.** An owner or admin creates a 7-day, single-use link
  (`/dashboard/#invite=<token>`; the token always travels in JSON bodies,
  never URL paths). An invite is only as good as its creator's current
  standing: claiming it requires that the creator still holds a role allowed to
  issue its role, and removing or demoting a member deletes their pending
  invites that the new role cannot issue, in the same batch. Redeeming creates
  the user, their first passkey, and the membership in one batch conditioned on
  claiming the invite, so a race or crash cannot leave a half-joined account.
  Caps (20 workspaces per user, 50 pending invites per workspace) are part of
  the insert's own WHERE clause.
- **Creating workspaces.** `ALLOW_MEMBER_WORKSPACES=true` (default) lets anyone
  signed in create one. When false, only `USER_ID` and people who already own
  or administer some workspace may; someone invited as a plain member cannot.
- **Ceremonies are stateless.** Between the options and verify calls the
  client carries a signed state: `{purpose, binding, challenge, exp, nonce}`
  HMAC-SHA256-signed with a per-install key generated on first boot
  (`server_secrets`). Verify checks the signature, the 5-minute expiry, the
  purpose, and the binding (the signed-in user, the invite token, the access
  code), then spends the nonce in `used_nonces` (insert-or-fail, pruned by the
  sweep). Nothing is held in memory, so `/options` floods cannot evict real
  ceremonies and any instance can finish a ceremony another started.
- **User verification is required** for registration and sign-in: a passkey
  is the only credential a person has. The WebAuthn user handle is 32 random
  bytes per user (`users.webauthn_handle`), not the internal user id. A stored
  signature counter only moves forward, and the write re-checks it.
- **Recovery** is 8 single-use codes shown once at sign-up and regenerable.
  Each is `LOOKUP-SECRET`: 6 public characters that find the row, then 24
  secret characters (~117 bits) stored only as SHA-256 and compared in
  constant time. Signing in with one ends every other session of the account.
- **Step-up.** A session records when it last proved a passkey (`reauth_at`;
  sign-in, setup, invite sign-up, recovery, and access codes all count).
  Adding or deleting a passkey, replacing recovery codes, and minting any token
  from a session need that proof within 10 minutes; `POST
  /v1/me/reauth/options|verify` renews it. Tokens are minted only with a fresh
  proof because a token outlives the session and works from anywhere; requests
  authenticated by a token are not affected. Changing member roles or removing
  members does not need step-up. Deleting a passkey or replacing recovery
  codes also signs out every other session.
- **Session cookie** `__Host-wctx_session` on https (Secure, Path=/, no
  Domain, so a sibling subdomain cannot plant it), `wctx_session` on plain
  http. HttpOnly, SameSite=Lax, 30 days sliding (refreshed at most daily) and
  never more than 90 days from sign-in. Only its SHA-256 is stored. Signing in
  again replaces the session the browser already had.
  Cookie-authenticated writes, and every `/v1/auth` POST, must carry this
  server's `Origin`. A Bearer header wins over a cookie.
- **Rate limits.** Failed authentications are counted per client across REST
  and MCP; the `/v1/auth/*/options` starters and `/v1/auth/recover` are also
  limited by request count, and recovery attempts per lookup id. The client is
  the socket peer unless `TRUST_PROXY` says every request comes through
  Cloudflare (`cf-connecting-ip`) or a proxy that sets `x-forwarded-for`.
  When the limiter's table is full, new keys share one overflow counter rather
  than going uncounted.
- **Tokens have no account rights.** `/v1/me` and `/v1/workspaces` require a
  session. MCP stays token-only.

## Label fallback

`PresenceContext.label` and the DB `label` column are nullable, but the agent-
facing `CoarsePresenceView.label` is a required string. The presence-store
mapping layer derives a fallback label from `status` (e.g. `near_home` →
"near home") whenever an explicit label is absent.

## Token hardening (implemented in Phase 2 bootstrap)

Bootstrap tokens are optional, and `.env.example` leaves them empty. The token
bootstrap **refuses to seed** any token that matches `/^change-me/` or is
shorter than 24 characters, and logs a warning. Operators are directed to
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

## 2026-10-18: multi-user accounts, sharing, and the new dashboard

- **Passkeys and sessions are in-house, on SimpleWebAuthn.** Better Auth was
  the alternative. WhereCtx needs passkeys only, with no passwords, email, or
  OAuth. A framework would bring its own user and session tables beside ours
  and its own idea of who a request acts as. Owning the account routes keeps
  the `Principal` and the per-user scopes in one model.
- **Isolation is per row now. A database per user waits for hosting.** Every
  table carries `user_id`, and handlers get only a `UserScope`, so a
  cross-user read is a type error. A separate SQLite file per person would
  give a harder wall, but it multiplies migrations and backups for a
  household-sized install. It becomes worth it with a hosted, multi-tenant
  service, and the scope boundary is where it would plug in.
- **The share audit is its own table.** The first version wrote
  `share.*` events into `presence_events`. That sent sharing data to
  webhooks, MCP, and `/v1/events`, which belong to the owner's agents, and
  mixed a person-to-person record into the agent event log. `share_audit`
  keeps who saw what out of every agent path and has its own retention
  (`SHARE_AUDIT_RETENTION_DAYS`).
- **People see status names only.** A person view shows `home`, `work`,
  `custom`, and so on, never a place's name or label. A label such as a
  clinic name or a street address says more than "at a custom place".
- **The CSP keeps `style-src 'unsafe-inline'`.** The design system adds two
  `<style>` elements at runtime, one for overlay motion and one for code
  highlighting. Under `style-src 'self'` the app still works, but those two
  are blocked. `script-src 'self'` stays strict. The built page has one
  module script and no inline code, and a test checks it.
- **The dashboard is React with the Astryx design system.** Both are
  devDependencies. Vite builds `web/` into `dist/web`, and the runtime image
  ships the built files and no React. The product UI never names the design
  system.
- **An IP-address host never counts as local for passkeys.** WebAuthn
  requires the caller's effective domain to be a valid domain and throws
  `SecurityError` otherwise (WebAuthn L3, section 5.1.3). That covers
  `127.0.0.1` and `[::1]` even though browsers treat them as secure contexts.
  Boot warns on any IP `BASE_URL`, and the sign-in page says so on an IP
  origin, both pointing at `http://localhost:<port>` or an https domain.
  Phone pairing keeps its own rule, which rejects every loopback host.
- **Webhook hooks drain independently, in a slot table.** The old dispatcher
  ran one tick over every hook and waited for all of them, so one user's
  hanging endpoint (5 s per event, up to 100 events) delayed every other
  user's next delivery. Now a tick marks hooks due, and due hooks start in
  least-recently-run order while a slot is free: 8 in all, 2 per user. A
  drain stops after 10 s and resumes from its cursor on the next tick, so
  delivery stays at-least-once. Shutdown aborts in-flight requests, which
  leave their cursors in place, and waits for drains before closing the DB.
- **MCP stays on bearer tokens.** Each token belongs to one person. OAuth 2.1
  for MCP clients is a later step (done, see "OAuth 2.1 for MCP clients"
  below).

## 2026-10-18: activity logs and the server log

- **The owner's own reads are not access-logged.** The access log answers
  "which agent read my location". A session is the person looking at their
  own data, so recording it would bury the agent rows. Tokens are always
  recorded, admin tokens included.
- **Record by structure, not by call site.** REST records in one middleware
  mounted on the presence, places and events prefixes; MCP registers every
  tool through one wrapper. A new route or tool is recorded without anyone
  remembering to. The outcome comes from the response, so handlers do not
  change.
- **Logs hold no coordinates.** `ingest_log` has no column for them and
  stores a redacted rejection message. The access log stores the reason an
  agent gave, never the answer.
- **No per-day cap on the ingest log.** A phone reporting every 5 minutes
  writes 288 rows a day, about 2,000 per device at the 7-day default. That
  is small for SQLite, and a cap would hide exactly the burst of rejections
  a person needs to see.
- **The operator is `USER_ID`.** The server log is about the whole install,
  so only the instance owner reads it, from a session. It is redacted when
  written, so the view shows what `docker logs` shows minus secrets and
  coordinates, and the boot banners never enter it.
- **History is pruned whether or not it is on.** Before, turning history off
  left the stored points forever.

## 2026-10-18: activity logs, second round

- **A typed decision, not the response body.** The access and ingest logs
  read outcomes back out of JSON bodies. Now the code that decides (a scope
  guard, the privacy policy, a handler, an MCP tool's `Reply`) records an
  `AccessDecision`, and the recorder fills in only what was left open, from
  the status. A body change can no longer change what the log says.
- **Default on for tokens.** Every token request on every `/v1` route but
  ingest and sign-in is recorded, not only the presence routes: privacy,
  webhook and token changes made with an admin token are the ones a person
  most needs to see. A test sends a token request to every mounted route.
- **MCP records per request, not per handler.** The SDK refuses bad
  arguments and unknown tools before any handler runs, so a handler wrapper
  missed them. The server watches its transport instead and writes one row
  per `tools/call` when the response goes out.
- **Never store what the caller chose.** A path no route matched and a tool
  name that does not exist are recorded as `unknown`, so the log cannot be
  filled with attacker-chosen text.
- **Fold, do not drop.** Identical requests within a minute become one row
  with a count, so a looping agent is visible without flooding the table.
  The window slides from the latest request. 0007 was unreleased, so it was
  amended rather than followed by a new migration.
- **Secrets are a type.** The setup code, access codes and generated admin
  tokens are a `Secret`; only the stdout banner takes one. Errors are logged
  as a fixed set of fields, because drizzle puts query parameters in its
  error messages and regexes cannot recognise every value.
- **A webhook drain stops when its hook changed.** Its cursor writes only go
  forward, only while the hook is active and has the selection the drain
  read, so pausing, resuming or unsubscribing during a delivery cannot
  replay or over-deliver.

## 2026-10-18: OAuth 2.1 for MCP clients

- **The authorization server is embedded and runs on oidc-provider.** A remote
  MCP client such as Claude should connect without a pasted token, and the MCP
  spec (revision 2026-07-28) needs an OAuth 2.1 server for that. Writing the
  protocol by hand was ruled out: PKCE, code replay, refresh rotation, and
  RFC 9207 `iss` are easy to get subtly wrong. An external server (Keycloak,
  Authentik) would add a second service and its own account database to a
  household install. oidc-provider is certified, ships Client ID Metadata
  Documents, and stores everything through one adapter over our database
  (`oauth_store`).
- **Clients register with Client ID Metadata Documents. Dynamic registration
  is off.** The spec deprecates dynamic registration, and it lets anyone write
  client rows. `OAUTH_DYNAMIC_REGISTRATION=true` turns it back on for older
  clients.
- **An OAuth token is a third kind of `Principal`.** `via: "oauth"` carries the
  grant and the client next to the user. Tokens and sessions keep their
  meaning, and the MCP tools still see only `ctx.forUser(userId)`, so an OAuth
  token reaches its owner's presence and nothing of anyone else's.
- **Access tokens are opaque and short.** They last 10 minutes and are looked
  up in the database on each `/mcp` request. That costs a read per request,
  but revoking an app takes effect at once, with no window where a signed JWT
  still works. Each token's audience is `<BASE_URL>/mcp`. `/mcp` checks it,
  and REST never accepts OAuth tokens.
- **Consent is asked every time, and precise location is opt-in.** The scope
  registry (`src/oauth/scopes.ts`) has two scopes: `presence:read` and
  `location:precise`. The person can drop precise location on the consent
  screen. The privacy settings still gate it after that. Asking every time
  follows the spec's advice not to redirect to a client automatically. The
  consent screen is part of the dashboard, so it uses the existing passkey
  sign-in.
- **Bearer tokens stay.** Agent and admin tokens keep working on `/mcp`, for
  clients that cannot do OAuth. A secret is first looked up as a WhereCtx
  token, then as an OAuth token.
- **The runtime moves to Node 22.** oidc-provider 9 supports Node 22 LTS and
  later. Node 24 is still avoided for the NAS reason in the `Dockerfile`.
- **Endpoints follow `BASE_URL`, never the request.** Every request reaches
  oidc-provider with `X-Forwarded-Proto` and `X-Forwarded-Host` overwritten
  from `BASE_URL`, and the provider always trusts them. Discovery, redirects
  back from consent, and the `Secure` flag on its cookies therefore match
  `BASE_URL` whatever `Host` header or proxy setup a request comes through.
  `TRUST_PROXY` still only decides which header carries the client IP.
- **Consent needs a fresh passkey proof.** Allowing an app mints a 30-day
  credential, the same as `POST /v1/tokens`, so a stolen session cookie alone
  is not enough. A person holds at most one grant per client: consenting again
  revokes the earlier grant and every token issued under it.
- **Losing a device ends connected apps too.** Recovery, an operator access
  code, deleting a passkey, replacing recovery codes, and signing out
  everywhere else end every other session. They now also revoke every OAuth
  grant of the person.
- **An OAuth client's calls are access-logged like a token's.** The access
  log answers "which agent read my location", and a connected app is an
  agent. Its credential is the grant (kind `oauth`), named after the client
  name it registered, else its `client_id` host. Every `tools/call` and the
  `insufficient_scope` refusal write a row. The unauthenticated `/oauth/*`
  and `/.well-known/*` endpoints carry no credential, so they are not; nor is
  revoking a connected app, which only a session can do.
- **The OAuth migration is `0009_oauth_store`.** The activity logs merged
  first and took 0007 and 0008, so the OAuth table was regenerated after
  them. Neither branch had reached production.

## 2026-10-19: stale means the device is offline

- **A quiet phone is not a stale one.** OwnTracks in significant-change mode
  publishes nothing while the phone stays put, "even if you don't move for
  hours", except a `t: "p"` ping: iOS "once in a while", Android every
  `ping` minutes, 15 by default
  ([booklet, location](https://owntracks.org/booklet/features/location/),
  [JSON](https://owntracks.org/booklet/tech/json/); the minutes and default
  are from the Android app's `Scheduler.kt` and `DefaultsProvider.kt`). With
  `STALE_AFTER_SEC` at 900, a person at home for an evening read as stale,
  and agents distrusted a location that was right. Pairing now sets
  `ping: 15` explicitly.
- **Two windows, by source.** A reading from a device that reports on its
  own is stored with `DEVICE_OFFLINE_AFTER_SEC` (default 24 h) as its
  `staleAfterSec`; a manual reading keeps `STALE_AFTER_SEC`. 24 h is longer
  than an iPhone may go without a ping overnight; agents that need tighter
  judgement read `lastReportAgoSec`. Because the window is stored per reading,
  `stale`, the sweep and `presence.became_stale` change meaning without new
  code paths: the event now means "the device appears offline", and its type
  name stays for compatibility.
- **Say what is known.** Views add `freshness` (`live`, `stationary`,
  `offline`, `unknown`), `lastReportAgoSec`, `lastMovedAgoSec` (from
  `presence.moved_at`, migration 0011: the first report within 100 m of the
  current spot) and `likelyStationary` (dropped on 2026-10-19, below). A device reading is `stationary` when
  it is inside a registered place, at rest, or older than `STALE_AFTER_SEC`:
  such a device would have reported a move. `stale` stays for older clients.
- **The dashboard shows the age only.** The person reading their own or a
  shared presence sees "12 min ago", not a stale badge; `stale` is a signal
  for agents.

## 2026-10-19: maps for agents (directions, ETA, neighbourhood)

- **Kakao and Naver, with the person's own key.** Agents asked for routes
  that reflect real traffic in Korea, which global providers serve poorly.
  Kakao (Local API for addresses and regions, Kakao Mobility Directions for
  car routes) takes one REST key as `Authorization: KakaoAK <key>`; Naver
  Cloud Maps (Geocoding, Reverse Geocoding, Directions 5 on
  `maps.apigw.ntruss.com`) takes an Application's Client ID and Secret in
  `x-ncp-apigw-api-key-id` / `x-ncp-apigw-api-key`. Both bill per call
  against the key holder, so each person brings their own; the operator's
  keys are a fallback for `USER_ID` unless `GEO_OPERATOR_KEY_FOR_ALL`.
  Each adapter's base URL is one constant, and contract tests run it against
  the sample responses in the providers' docs.
- **Driving only.** Both Directions APIs route cars. Kakao times a future
  departure (`/v1/future/directions`, `departure_time` as YYYYMMDDHHMM, read
  as KST since the docs name no zone); Naver Directions 5 has no departure
  time and always applies live traffic, so a future `departAt` on Naver is
  `unsupported` rather than silently timed for now.
- **What leaves, decided once.** `GeoService` is the only caller of a
  provider. It rounds any point to three decimals, sends nothing while maps
  are off or (by default) near home, where a route starts at the home place,
  and writes an access log row per call. The area lookup runs after the
  ingest lock is released, so a slow provider never delays a reading.
- **No coordinates to agents through routes.** An ETA reveals distance, so
  it has its own switch (`etaToAgents`) apart from precise location. Map
  links carry the destination's coordinates, so they go only to callers who
  already know them: the owner, a `manage_places` token, or an agent that
  named the address. The links start from the device's own location, so the
  user's position is never in them. Only the documented links are used:
  `https://map.kakao.com/link/to/<name>,<lat>,<lng>` and
  `nmap://navigation?dlat=…&dlng=…&dname=…&appname=…`. The `kakaomap://`
  app scheme was not confirmed in current docs, so it is left out.
- **Sealed keys, one bag per provider.** The keys of a provider are one
  JSON value sealed with AES-256-GCM under a per-install key in
  `server_secrets`. Saving merges kinds, so the map SDK keys of a later
  release (a Kakao JavaScript key, a Naver web client id) fit beside the
  REST keys with no migration. The sealing key lives in the same database:
  this guards a leaked table or a partial dump, not the whole file. (Saving
  now replaces the bag; see below.)
- **The area is a consent like a share level.** Agents see it only with
  `areaToAgents`; a person only through a share's `showArea`, which widens
  the share and needs a fresh passkey; the owner always, while maps are on.

## 2026-10-19: maps after an adversarial review

A two-model review of the maps work found ways an agent could learn more
than the switches promise. Each fix below is enforced in one place.

- **An agent's route is coarse.** Turn-by-turn steps and the first road of
  a route name the street the person starts on (Kakao's sample begins on
  판교역로241번길). Agents now get minutes in 5-minute steps, whole
  kilometres, the arrival to 5 minutes and no fares, and main roads only:
  none with a point within 1.5 km of the origin or of a registered
  destination (from Kakao `vertexes` and the run of Naver's `path` a
  section covers), no side streets (`\d+번?길$`), and none without
  geometry. Steps, and a destination given as an address, need the same
  gate as `get_precise_location`. A registered destination is any place,
  not only home: an agent sees place names, never where they are. The owner
  keeps the provider's answer. Rejected: rounding only, since even a
  rounded number with a named nearby street triangulates.
- **Rounding at one boundary.** `roundingProvider` wraps every adapter, so
  destinations are rounded too and no future caller can forget.
- **Near home is a refusal, by distance.** An agent near home used to get a
  route from the home place, which told it the person was home. Now it is
  refused. Near home is measured to every home place (radius times
  `NEAR_RADIUS_MULTIPLIER`), so a custom place beside home no longer hides
  it. Home no longer times the way home on every load; the owner presses a
  button.
- **Freshness from the server's clock.** Ages come from `receivedAt`; the
  arrival point is stored (`moved_lat`, `moved_lon`) so a drift of small
  steps counts as moving; a phone that went quiet while driving is
  `unknown`. The offline window is worked out at read time from the source
  (OwnTracks, the app and Home Assistant use `DEVICE_OFFLINE_AFTER_SEC`; a
  manual reading, a Shortcut and Tasker use `STALE_AFTER_SEC`), so stored
  rows and config changes agree. `stale_after_sec` is still written for a
  rolled-back build. `likelyStationary` and `trafficAware` repeated other
  fields and go. A route starts only from a `live` reading or a `stationary`
  one inside a registered place.
- **The area follows the reading.** A move of more than 200 m from the
  point the area was looked up for drops it at ingest; a move inside the
  throttle gets one trailing lookup. The area is looked up only for a
  consumer (the owner's new `areaOnHome`, `areaToAgents`, a share with
  `showArea`).
- **The cache is no trail.** Cells are HMAC-keyed, rows live for the
  shorter of seven days and `retentionHours`, and turning maps off or
  removing a key drops them.
- **Budgets per person and per key.** Every provider call counts (a route
  by address is two), the owner's and the key test's included; a daily cap
  (`GEO_OPERATOR_DAILY_CAP`) protects the operator's key from other
  people. In memory, so a restart resets them.
- **Widening needs the person.** Turning on a switch that sends more out
  needs a fresh passkey in the dashboard; a `manage_privacy` token cannot.
  Turning off `skipProviderNearHome` counts as widening too.
- **Keys bound to their row.** The sealed bag carries `userId|provider` as
  associated data, a save replaces the bag, and a row that cannot be opened
  is reported `unusable` instead of failing the page.
- **Provider failures are errors.** `no_route`, `bad_request` and the rest
  are `error` in the access log, not `denied`: nothing was decided about the
  caller. One table answers each outcome for REST and MCP.
