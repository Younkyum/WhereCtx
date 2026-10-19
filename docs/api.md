# REST API

Base URL: `http://localhost:8787` (set `BASE_URL` for the public URL).

A request authenticates in one of two ways:

- `Authorization: Bearer <token>` for devices, agents, and automation.
- The session cookie of a person signed in with a passkey (see
  [Accounts](#accounts-signed-in-people)). Writes with the cookie must send
  this server's `Origin`.

Either way, the request acts only on the data of the user who owns the
credential. A Bearer header wins over a cookie.

## Auth & scopes

| Scope | Token roles |
|-------|-------------|
| `write_location` | device |
| `read_presence`, `read_precise_location` | agent, admin |
| `manage_places`, `manage_tokens`, `manage_privacy` | admin |

A session has every scope above over its own data. The account, workspace,
sharing, and people routes take a session only and answer `403` to a token.

Responses: `401` (no or invalid credential), `403` (missing scope, or
`reauth_required`), `400` (validation), `404` (not found), `409` (a cap is reached,
the last owner or the last passkey), `410` (an expired or used invite),
`413` (body > 64 KB), `500`.

## Ingest (device)

Two device-only credential forms are accepted on these routes and nowhere
else: `?token=<secret>` in the query, and HTTP Basic with the token as the
password (the username is ignored; this is how OwnTracks authenticates). A
signed-in person's session also works here, so the dashboard can post a
one-shot `"source":"manual"` reading.

```
POST /v1/ingest             # generic JSON
POST /v1/ingest/shortcut    # iOS Shortcut
POST /v1/ingest/owntracks   # OwnTracks HTTP (returns [] per its contract)
```

Generic body (aliases tolerated: `latitude`/`lng`, `accuracy`/`acc`, `speed`, …):

```json
{ "source":"ios_shortcut", "lat":37.123, "lon":127.123,
  "accuracyM":21, "battery":64, "timestamp":"2026-06-05T15:30:00+09:00" }
```

Response: `{ "ok": true, "status": "home" }`.

## Presence (agent)

```http
GET /v1/presence
Authorization: Bearer AGENT_TOKEN
```
```json
{ "status":"near_home", "label":"near home", "motion":"walking",
  "updatedAgoSec":42, "stale":false, "lastReportAgoSec":42, "lastMovedAgoSec":3600,
  "freshness":"stationary", "privacy":"coarse", "area":"성남시 분당구 삼평동" }
```
`403` with `{ "privacy":"hidden" }` in hidden mode; `404` before any reading.
The signed-in owner (a session) reads their own coarse and precise presence
whatever the agent policy says; hidden mode and the precise gate are about
agents. The owner's precise answer adds `nearHome` (`{ name, lat, lon,
radiusM }` of the home place) while `skipProviderNearHome` is on and they
are near it, so the dashboard map shows that place instead of the point.

- Every age is from when the server received the report, not the device's
  timestamp. `updatedAgoSec` is the same as `lastReportAgoSec`, kept for
  older clients.
- `freshness`: `live` (received within `STALE_AFTER_SEC`, not at rest),
  `stationary` (at a registered place, reported at rest, or a connected
  phone gone quiet: it sends nothing while it stays put, so treat it as
  still at the last place), `offline` (a connected device, OwnTracks, the
  app or Home Assistant, has sent nothing for `DEVICE_OFFLINE_AFTER_SEC`,
  24 h by default), `unknown` (a connected device went quiet while driving
  or in transit, or a manual, Shortcut or Tasker reading is older than
  `STALE_AFTER_SEC`).
- `stale` is true for `offline`, and for a manual, Shortcut or Tasker
  reading past `STALE_AFTER_SEC`. `lastMovedAgoSec` counts from when the
  person arrived where they are now (reports within 100 m of that point keep
  it), absent for readings stored before it was tracked.
- `area` is the neighbourhood, present only when maps are on and the person
  lets agents see it (see [Maps](#maps)). A signed-in owner gets it while
  maps and `areaOnHome` are on.

Directions, ETA, address search and the maps keys. See
[privacy.md](privacy.md#maps-directions-eta-and-neighbourhood-names) for
what leaves the server. The switches are privacy settings (`geoEnabled`,
`skipProviderNearHome`, `areaOnHome`, `areaToAgents`, `etaToAgents`,
`areaToPeople`, `geoProvider` on `PUT /v1/privacy`).

```
GET    /v1/geo                               # session only: provider in use, my keys' hints, operator fallbacks
GET    /v1/geo/map-config                    # session only: the tiles the dashboard draws its maps on
PUT    /v1/geo/credentials/kakao             # session, step-up: { "restKey":"…" }
PUT    /v1/geo/credentials/naver             # session, step-up: { "clientId":"…", "clientSecret":"…" }
DELETE /v1/geo/credentials/:provider         # session, step-up: forget my keys for it
POST   /v1/geo/credentials/:provider/test    # session: looks up Seoul City Hall, then times a route to Seoul Station, with the saved key
GET    /v1/geo/search?q=                     # manage_places, maps on: address or place search, with coordinates
GET    /v1/geo/eta?to=&pick=&departAt=&avoid=&directions=&reason=
                                             # read_presence: drive time from my current location
```

`GET /v1/geo`:

```json
{ "active": { "provider":"kakao", "source":"own" },
  "credentials": [{ "provider":"kakao", "status":"ok", "kinds":{ "restKey":"cdef" },
    "createdAt":"…", "updatedAt":"…", "lastUsedAt":"…", "lastError":null }],
  "operator": [] }
```

A key is never returned here; `kinds` names each key kind held with its last
four characters (none for a secret). Saving replaces a provider's keys and
forgets how the old ones fared; removing answers `404` when none are saved.
REST keys resolve own before operator (`KAKAO_REST_API_KEY`,
`NAVER_MAPS_CLIENT_ID`/`_SECRET`, for `USER_ID` only unless
`GEO_OPERATOR_KEY_FOR_ALL`). A row saved before maps moved to open tiles
may still hold a map key (`jsKey`, `mapKeyId`); it is ignored, a row holding
only that is not listed, and the next save or removal drops it. `status` is
`unusable` (with `lastError`) when the saved row cannot be opened; calls skip
it, and it can still be replaced or removed. The key test counts against the
maps limits.

`GET /v1/geo/map-config` names the tiles the dashboard draws its maps on,
maps on or off; there is no key in it:

```json
{ "tiles": { "url":"https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  "attribution":"© OpenStreetMap contributors",
  "attributionUrl":"https://www.openstreetmap.org/copyright" } }
```

and `{ "tiles": null }` when `MAP_TILE_URL=off`. A token gets `403`
(`geo.map_config` in the access log).

The key test tries the address API (Kakao Local, Naver Reverse Geocoding),
then the route API (Kakao Mobility, Naver Directions 5), and stops at the
first that fails. A refusal says which and what to fix:

```json
{ "test": { "ok": false, "error": "auth", "api": "geocoding", "code": "map_service_disabled",
  "providerMessage": "App(…) disabled OPEN_MAP_AND_LOCAL service.",
  "message": "Kakao Map is turned off for this app" } }
```

`code` is one of `key_invalid`, `map_service_disabled` (Kakao's 카카오맵
product is off for the app), `service_not_enabled` (the API is not enabled or
selected for the app; Naver answers this as `429 Quota Exceeded`),
`review_required`, `quota`, `rejected`, `timeout`, `upstream`.
`providerMessage` is the provider's own error text with every key masked
(Kakao repeats the key it was sent), at most 300 characters; the dashboard
shows it beside a fix for the `code`. Success is `{ "ok": true, "label": "…" }`.

`GET /v1/geo/search` needs maps on (`403` otherwise); a token also needs a
presence it may see.

`GET /v1/geo/eta`: `to` is a registered place's name, else an address or a
place name to search. When a search finds several, the answer is `409` with
`candidates` numbered by `pick` (coordinates only for a session or a
`manage_places` token); pass `pick`. `departAt` is an ISO 8601 time with an
offset for a future departure (Kakao only; Naver answers `502`
`kind:"unsupported"`). `avoid` is a comma list of `toll`, `motorway`,
`ferries` (Naver: one of `toll`, `motorway`). `directions=true` asks for the
turn-by-turn steps. `reason` is why an agent needs the precise route.

The owner (a session) gets the provider's answer as it is, with `path`, the
whole route as the provider drew it, start to end:

```json
{ "eta": { "destination": { "label":"office", "kind":"place" }, "origin":"current_location",
  "precision":"exact", "durationMin":23, "distanceKm":11.4, "traffic":"live",
  "departAt":"…", "arriveAt":"…", "summary":["강남대로","테헤란로"], "steps":["…"],
  "path":[{ "lat":37.401, "lon":127.108 }, …],
  "tollFare":0, "taxiFare":15600, "provider":"kakao", "freshness":"live", "originAgeMin":2,
  "deepLinks": { "kakaoMap":"https://map.kakao.com/link/to/…", "naverMap":"nmap://navigation?…&appname=wherectx" } } }
```

A token gets `precision: "approximate"`: `durationMin` in 5-minute steps
(at least 5), `distanceKm` in whole kilometres, `arriveAt` to 5 minutes, no
fares, no `path`, and `summary` without any road within 1.5 km of either end, any side
street (…번길, …로12길) or any road the provider gave no geometry for. A
token may route only to a registered place, and gets `steps` (with
`directions=true`) only when it may read the precise location: it holds
`read_precise_location`, the person allows precise location, `reason` is
given if the person requires one, and they are not at home. An address
destination needs the same. Otherwise `stepsWithheld` says why.

`origin` is `home` only for the owner at or near home with
`skipProviderNearHome` on: the route starts at the home place. `freshness`
and `originAgeMin` say how old the reading the route starts from is.
`deepLinks` appear only for a session, a `manage_places` token, or an
address the caller named.

| Case | Status |
|------|--------|
| maps off, or (token) `etaToAgents` off | `403` |
| (token) hidden mode | `403` `{ "privacy":"hidden" }` |
| (token) at or near home with `skipProviderNearHome` on | `403` |
| (token) an address without precise access | `403` |
| no reading | `404` |
| the reading is not `live`, nor `stationary` inside a registered place | `409` `{ "error", "freshness", "originAgeMin" }` |
| no such place and nothing found | `404` |
| several matches | `409` with numbered `candidates` |
| no key set up | `409` |
| the person's 30 provider calls a minute, the key's 60, or (operator key, anyone but `USER_ID`) `GEO_OPERATOR_DAILY_CAP` a day are spent | `429` |
| the provider refused or failed | `502` `{ "error", "kind" }` (`auth`, `quota`, `no_route`, `unsupported`, `bad_request`, `timeout`, `upstream`) |

## Accounts (signed-in people)

People sign in with a passkey and get a session cookie (`__Host-wctx_session`
on https, `wctx_session` on http). Cookie-authenticated writes must send this
server's `Origin`. Each WebAuthn flow is two calls: `options` returns
`{ ceremony, options }`; pass `options` to `navigator.credentials`, then send
`ceremony` back unchanged with the credential to `verify`. Ceremonies expire
after 5 minutes and work once. Account errors carry `{ error, code }`.

```
POST /v1/auth/setup/options|verify        # first owner: { code } from the boot log
POST /v1/auth/login/options|verify        # discoverable passkey sign-in
POST /v1/auth/invite/preview              # { token } -> workspace name, role, expiry
POST /v1/auth/invite/options|verify       # { token, displayName } -> sign up
POST /v1/auth/recover                     # { code } recovery code; ends other sessions
POST /v1/auth/access-code/options|verify  # { code } from `reset-access`
POST /v1/auth/logout

GET|PATCH /v1/me                          # profile, workspaces, passkeys, sessions, isOperator
POST   /v1/me/reauth/options|verify       # re-prove a passkey (step-up, 10 min)
POST   /v1/me/passkeys/options|verify     # add a passkey            (step-up)
DELETE /v1/me/passkeys/:id                # never the last one       (step-up)
POST   /v1/me/recovery-codes              # replace all 8 codes      (step-up)
DELETE /v1/me/sessions/:id
POST   /v1/me/sessions/revoke-others

GET|POST /v1/workspaces                   # list mine / create
POST   /v1/workspaces/invites/accept      # { token } join while signed in
PATCH  /v1/workspaces/:id                 # rename
GET    /v1/workspaces/:id/members
PATCH|DELETE /v1/workspaces/:id/members/:userId
GET|POST /v1/workspaces/:id/invites       # POST { role } -> { url } shown once
DELETE /v1/workspaces/:id/invites/:inviteId
```

Step-up operations (and `POST /v1/tokens` from a session) answer `403` with
`code: "reauth_required"` when the session last proved a passkey more than 10
minutes ago. Unknown setup, invite, recovery, or access codes and failed
ceremonies answer `401` and count toward the auth-failure limit; expired or used
invites answer `410`.

## Location sharing (signed-in people)

Members of a common workspace can share their location with each other, like
Find My. Session only: tokens get `403`, so neither the owner's nor the
viewer's agents ever reach these routes.

```
GET    /v1/shares                        # { outgoing: [{ viewer:{id,displayName}, level, hideHomeExact }],
                                         #   incoming: [{ owner:{id,displayName}, level, hideHomeExact }] }
PUT    /v1/shares/:viewerUserId          # { "level":"coarse"|"precise", "hideHomeExact"?:bool, "showArea"?:bool } -> { share }
DELETE /v1/shares/:viewerUserId          # stop sharing
DELETE /v1/shares/incoming/:ownerUserId  # stop seeing someone who shares with me
GET    /v1/shares/audit?limit=50         # my shares' audit, newest first (max 500)
GET    /v1/people                        # everyone sharing with me, no coordinates
GET    /v1/people/:ownerUserId           # one of them, with coordinates when allowed
```

A person who shares no workspace with you answers `404`, as does an unknown
id; sharing with yourself is `400`. A new share's `hideHomeExact` defaults to
your `hideHomeExactCoordinates` privacy setting; an explicit value wins, and an
update that omits it keeps the current value. A share counts only while the
two people still have a workspace in common: it stops showing as soon as that
ends, and when the last common membership goes (leaving, removal, any other
path) the database deletes it and audits it as `membership_ended`.

Creating a share, raising it from `coarse` to `precise`, or turning
`hideHomeExact` off needs a passkey proof from the last 10 minutes (`403`
`code: "reauth_required"`, then `POST /v1/me/reauth`). Keeping, lowering and
revoking a share do not.

`GET /v1/people`:

```json
{ "people": [ {
  "user": { "id":"…", "displayName":"Mina" },
  "level": "precise",
  "paused": false,
  "presence": { "status":"away", "label":"away", "motion":"walking", "updatedAgoMin":3, "stale":false, "freshness":"live" },
  "precise": "available"
} ] }
```

`GET /v1/people/:ownerUserId` returns the same entry as `person`, except that
`precise` holds the coordinates:

```json
{ "person": { "…": "…",
  "precise": { "lat":37.6, "lon":127.1, "accuracyM":12, "mapUrl":"https://maps.google.com/?q=37.6,127.1", "updatedAgoMin":3 }
} }
```

- `label` is the status name (`home`, `near home`, `work`, `custom`, …), never
  the name or label of the owner's place. Ages are whole minutes.
- `presence` is `null` before the owner's first reading.
- `precise` is `null` unless the level is `precise`. With `hideHomeExact` on it
  is also `null`, with `preciseWithheld` saying why: `"at_home"` while the
  owner is at or near home, `"no_home_place"` when the owner has no `home`
  place (the server cannot tell when they are home, so it withholds
  coordinates everywhere). In the list, `"available"` means the person read
  would return coordinates now.
- `paused: true` (with `presence` and `precise` `null`) while the owner has
  `sharingPaused` on.

Both reads are sent with `Cache-Control: no-store`.

Only the person read with coordinates is audited (`precise_viewed`), at most
once per owner and viewer per hour: a view exactly one hour after the last
audited one is audited again. The list is never audited.

`GET /v1/shares/audit`:

```json
{ "audit": [ {
  "id":"…", "viewer": { "id":"…", "displayName":"Mina" },
  "action": "granted" | "changed" | "revoked" | "precise_viewed",
  "reason": null | "membership_ended" | "viewer_declined",
  "before": { "level":"coarse", "hideHomeExact":true } | null,
  "after":  { "level":"precise", "hideHomeExact":true } | null,
  "createdAt": "2026-10-18T10:00:00.000Z"
} ] }
```

`before` is `null` for a grant and a precise view, `after` for a revoke and a
precise view. The audit is kept for `SHARE_AUDIT_RETENTION_DAYS` (365 by
default). It is not part of presence events: `/v1/events`, MCP and webhooks
carry no sharing data.

## Tokens (admin)

```
GET    /v1/tokens            # manage_tokens — no secrets
POST   /v1/tokens            # { "name":"phone", "role":"device" } -> { token, secret } (secret shown once)
DELETE /v1/tokens/:id        # revoke
```

Creating an `agent` token also returns `mcpConfig`, a Claude Desktop
`mcpServers` entry pointing at `<BASE_URL>/mcp` with the secret filled in.
Agent tokens only ever read their owner's presence.

## Devices (pairing)

```
GET  /v1/devices             # manage_tokens
POST /v1/devices/pair        # manage_tokens (step-up from a session)
     { "name":"Mina's phone", "kind":"owntracks" | "shortcut" }
```

Mints a `device` token (counts toward the 50-token cap) and returns it with
what the phone needs. The secret appears only in this response, which is sent
with `Cache-Control: no-store` (as are token creation and every response
carrying recovery codes).

Before minting, the server checks that a phone could use `BASE_URL`: a
loopback host (`localhost`, `127.0.0.0/8`, `::1`) or plain http on any other
host answers `400` `{ error, code: "base_url_unusable" }`. Set `BASE_URL` to
the server's public https URL.

- `owntracks`: `{ token, kind, config, link, qrSvg }`. `config` is an OwnTracks
  remote configuration (`_type:"configuration"`, `mode:3` HTTP, `url` =
  `<BASE_URL>/v1/ingest/owntracks`, `auth:true` with the token as `password`,
  `deviceId`/`tid` from the name, `monitoring:1` significant changes). `link` is
  `owntracks:///config?inline=<percent-encoded base64 of config>`; `qrSvg` is
  that link as an SVG QR code.
- `shortcut`: `{ token, kind, url, method, headers }` for
  `POST <BASE_URL>/v1/ingest/shortcut` with `Authorization: Bearer <token>`.

`GET /v1/devices` lists the caller's device tokens with what they last sent:

```json
{ "devices":[{ "id":"…", "name":"Pixel", "createdAt":"…", "lastUsedAt":"…",
  "lastReceivedAt":"2026-10-18T08:10:00.000Z", "lastOutcome":"accepted",
  "accepted24h":280, "rejected24h":2 }] }
```
`lastReceivedAt` and `lastOutcome` come from the ingest log (null before the
first upload, or once it is pruned); the counts cover the last 24 hours.

## Activity (signed-in people)

The person's own record of who used their data. Session only: any token,
an admin token included, gets `403`. Responses are `no-store`, newest first,
and paged by keyset: pass the `next` of one page as `before` of the next.

```
GET /v1/activity/access?limit=50&before=&credential=   # agent and token reads (max 200)
GET /v1/activity/ingest?limit=50&before=               # device uploads (max 200)
```
```json
{ "entries":[{ "id":"…", "credential":{ "kind":"token", "id":"…", "name":"Claude Desktop" },
  "surface":"mcp", "action":"get_precise_location", "precise":true,
  "reason":"pick me up", "outcome":"denied", "denial":"precise location is disabled by policy (allowPreciseLocation=false)",
  "count":1, "createdAt":"…", "lastAt":"…" }], "next":"2026-10-18T08:10:00.000Z|…" }
```
- Access: one row for every token request to a `/v1` route other than
  `/v1/ingest*` (which has the ingest log) and `/v1/auth*` (which takes no
  token), and for every MCP `tools/call`, including calls refused before a
  tool runs.
  - `action` names what was asked: `presence.read`, `presence.precise`,
    `presence.history`, `places.list`, `places.write`, `places.delete`,
    `events.list`, `privacy.read`, `privacy.update`, `webhooks.list`,
    `webhooks.create`, `webhooks.update`, `webhooks.delete`,
    `webhooks.dead_letters`, `tokens.list`, `tokens.create`, `tokens.revoke`,
    `devices.list`, `devices.pair`, `activity.read`, `admin.logs`,
    `geo.settings`, `geo.credentials.write`, `geo.credentials.delete`,
    `geo.credentials.test`, `geo.search`, `geo.eta`; the maps provider calls
    `geo.reverse`, `geo.geocode`, `geo.route`; `account`
    for any `/v1/me`, `/v1/workspaces`, `/v1/shares`, `/v1/people` or
    `/v1/oauth` route, or the OAuth consent API under `/oauth/interaction/`
    (a token is always refused there); an MCP tool name; `mcp.request` for an
    MCP request refused before any tool (a token without `read_presence`, or
    a batch over the cap); or `unknown` for a path no route matched or a tool
    that does not exist. The path or tool name itself is never stored. A
    `HEAD` request is named as its `GET` route.
  - `outcome` is `allowed` (served, including an empty answer such as a
    `404` on a known route), `hidden` (hidden mode, a precise request
    included), `denied` (scope, precise policy, a missing reason, invalid
    MCP arguments, a bad request, an unknown route or tool), or `error` (the
    server failed, `5xx`). `denial` says why a request was denied.
  - `precise` is true when the request sought or returned coordinates: a
    precise read, history, and a place list for a `manage_places` token.
    `reason` is the reason an agent gave for a precise request (first 256
    characters, redacted like an ingest rejection).
  - Identical requests (same token, surface, action, outcome and denial)
    within a minute of the previous one fold into one row: `count` of them,
    the first at `createdAt`, the latest at `lastAt`. The row keeps the first
    reason.
  - `credential.kind` is `token` for a WhereCtx token, `oauth` for an MCP
    client connected with OAuth, or `system` (with `surface: "system"`) for
    a maps call WhereCtx made on its own: the background area lookup. An OAuth row's `id` is the grant id (the `id`
    in `GET /v1/oauth/grants`), and its `name` is the client's name, else its
    `client_id` host.
  - `credential` filters by token or grant id. The person's own dashboard
    reads are not recorded, nor is listing or disconnecting connected apps.
- Ingest: `{ id, token:{id,name}|null, source:"generic"|"shortcut"|"owntracks",
  outcome:"accepted"|"rejected"|"ignored"|"error", reason?, receivedAt }`.
  `token` is null for a reading posted from the dashboard. `ignored` is an
  OwnTracks message that is not a location; `error` is a server failure. No
  coordinates.

## Server logs (operator)

```
GET /v1/admin/logs?level=info&limit=200   # the operator's session only
```
```json
{ "entries":[{ "level":"error", "time":"…", "msg":"request failed",
  "fields":{ "method":"POST", "path":"/v1/webhooks",
    "err":{ "name":"DrizzleQueryError", "message":"Failed query: insert into …",
      "stack":["at …"], "cause":{ "name":"LibsqlError", "message":"…", "code":"SQLITE_BUSY" } } } }] }
```
The server's last 1000 log entries since it started, newest first, at or
above `level` (`debug`, `info`, `warn`, `error`). An error in `fields` is
always the same few fields: `name`, the first line of its `message` (for a
failed database query, the SQL with `?` placeholders, never the values),
`code`, `stack` frames, and its `cause` the same way, three levels deep.
The operator is the person whose id is `USER_ID`; `GET /v1/me` says
`isOperator`. Everyone else, and every token, gets `403`. Entries are
redacted when they are written, and the boot banners (setup code, generated
admin token) are never kept.

## Places (admin)

```
GET    /v1/places          # read_presence: [{name, type}]; manage_places: full places
POST   /v1/places          # manage_places: create or replace by name
DELETE /v1/places/:name    # manage_places
```
A person has at most 100 places; creating one more is refused with 409
(changing an existing place still works). MCP `create_place` and
`remember_current_place` share the limit.

A place is a circle or a polygon, never both:

```json
{ "name":"office", "type":"work", "polygon":[[127.0123,37.5678],[127.0145,37.5678],[127.0145,37.5691],[127.0123,37.5691]],
  "enterAfterSec":180, "exitAfterSec":300, "approachM":500,
  "emits":["presence.entered_place","presence.left_place","presence.approaching_place"],
  "notifyWebhooks":true, "notifyReminders":true }
```
- Circle: `lat`/`lon` (or `useCurrentLocation`) and `radiusM` (default 150,
  at most 100000).
- Polygon: a GeoJSON-style ring of `[lon, lat]`, open or closed (the server
  closes it). 3 to 200 vertices, no zero-length edge, no edges that cross
  or touch, a longitude span under 180° (no antimeridian), at least
  100 m², and within 100 km of its centroid. Each broken rule is a `400`
  naming it. The stored place's `lat`, `lon` and `radiusM` are the
  polygon's centroid and circumradius.
- `enterAfterSec` / `exitAfterSec` (0..86400, default 0): how long readings
  must stay inside before the arrival counts, or outside before the
  departure counts. They are checked on every reading and once a minute, so
  a wait can run up to a minute long. An arrival with a wait is never
  confirmed while the latest reading is driving, in transit or over 3 m/s.
- `approachM` (10..50000, or null for off, the default): fire
  `presence.approaching_place` once when readings head toward the place
  within this many meters of its boundary.
- `emits` (default all three): the place event types recorded for this
  place. A type left out is not recorded at all; presence still moves.
- `notifyWebhooks` (default true): false records the place's events (and
  `presence.updated` while inside it) without ever delivering them.
- `notifyReminders` (default true): false keeps arrivals here from
  triggering reminders.

`POST` replaces the shape and label; a rule it leaves out keeps the value
the place has (the default for a new place). Saving a place re-checks the
current presence against it right away.

## Webhooks (admin)

```
GET    /v1/webhooks                 # manage_privacy — secrets stripped
POST   /v1/webhooks                 # { "url":"https://…", "events":["*"], "places"?: ["home"], "secret":"…" }
PATCH  /v1/webhooks/:id             # { "events"?: [...], "places"?: [...] | null, "active"?: bool }
GET    /v1/webhooks/dead-letters    # undeliverable events
DELETE /v1/webhooks/:id
```
`events` is a non-empty list of the event types below, or `["*"]` for all of
them (including any added later). The server stores each type once, in the
order given, and stores `["*"]` alone when the list includes `"*"`; an
unknown type is `400`. `PATCH` changes a hook's selection or pauses it;
another person's hook id answers `404`. Turning a paused hook back on starts
it from now, so it does not replay what happened while it was off, even when
a delivery was in flight across the pause. A delivery in flight when the
selection changes is the last one sent under the old selection.
The dashboard creates hooks for `presence.entered_place` and
`presence.left_place` unless the person picks otherwise.
`places` (1 to 50 names) limits every event that names a place to those
places: `entered_place`, `left_place`, `approaching_place`, and
`presence.updated` while inside a place. An event that names no place
(`presence.updated` outside every place, `became_stale`,
`privacy_changed`) is delivered as before. Leaving it out, or `PATCH` with
`null`, delivers every place. Events of a place with `notifyWebhooks` off are never
delivered, whatever the hook selects.
`POST` answers `400` when the URL's host does not resolve, or resolves to a
private or reserved IP (SSRF guard) unless `WEBHOOK_ALLOW_PRIVATE_TARGETS=true`.
The delivery re-checks the address each time. Each user may have 20 webhooks
(`409` beyond that). Secrets are encrypted at rest when
`WEBHOOK_ENCRYPTION_KEY` is set.

### Delivery signature

When the subscription has a secret, each delivery carries:

```
X-WhereCtx-Event:     presence.entered_place
X-WhereCtx-Timestamp: 1780000000                  # unix seconds
X-WhereCtx-Signature: sha256=<hex>
```

The signature is `HMAC-SHA256(secret, "<timestamp>.<raw body>")`. Verify by
recomputing it over the literal timestamp header value, a dot, and the raw
request body — and reject deliveries whose timestamp is older than a few
minutes (replay protection):

```js
const expected = "sha256=" + crypto
  .createHmac("sha256", secret)
  .update(`${req.headers["x-wherectx-timestamp"]}.${rawBody}`)
  .digest("hex");
const fresh = Math.abs(Date.now() / 1000 - Number(req.headers["x-wherectx-timestamp"])) < 300;
ok = fresh && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-wherectx-signature"]));
```

> **Breaking change (v0.2):** v0.1 signed only the body. Consumers verifying
> the old scheme must switch to `"<timestamp>.<body>"`.

### Webhook payload

```json
{ "id":"…", "event":"presence.entered_place", "place":"home",
  "status":"home", "source":"owntracks", "timestamp":"2026-06-05T15:30:00.000Z" }
```

Events: `presence.updated`, `presence.entered_place`, `presence.left_place`,
`presence.approaching_place`, `presence.became_stale`,
`presence.privacy_changed`. `entered_place` and `left_place` fire when the
arrival or departure is confirmed, after the place's `enterAfterSec` or
`exitAfterSec`. `presence.became_stale`
means the device appears offline (see `freshness` above); it does not fire
for a phone that is only quiet at rest. Location sharing is not
delivered by webhook; its audit is at `GET /v1/shares/audit`.

## Misc

```
GET /            # { name, version, status }
GET /healthz     # { status:"ok" }
GET /dashboard   # web UI: passkey sign-in, people, sharing, devices, agents
POST /mcp        # MCP endpoint (see docs/mcp.md)
```

`/mcp` refuses a JSON-RPC batch of more than 10 messages with `400` and a
JSON-RPC error (`-32600`, "batch too large").
