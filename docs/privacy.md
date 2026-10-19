# Privacy & policy

WhereCtx is designed around one principle:

> **Presence by default, precise location when needed.**

Agents usually need a contextual state (`near_home`, `walking`, `stationary`), not raw
GPS. WhereCtx exposes coarse presence by default and gates precise location
behind explicit policy.

## What agents see

The default agent-facing view (`GET /v1/presence`, MCP `get_presence`) is:

```json
{
  "status": "near_home",
  "label": "near home",
  "motion": "walking",
  "updatedAgoSec": 42,
  "stale": false,
  "privacy": "coarse"
}
```

No latitude, longitude, geohash, accuracy, or place coordinates. Place lists
returned to agents contain only `name` + `type`: never a polygon's outline,
a radius, a label, or a place's rules (dwell times, approach distance,
recorded events, notify switches). While an arrival or departure waits out
its dwell time, `get_presence` says `entering` or `leaving`, the place type
and for how long, never the place's name.

Each person has their own presence, places, and privacy settings. A token
belongs to the person who made it and reads only that person's data. The
rules below apply per person.

## Privacy modes (`defaultAgentAccess`)

| Mode      | Agents get…                                              |
|-----------|----------------------------------------------------------|
| `hidden`  | nothing — presence, events, and precise are all withheld |
| `coarse`  | the coarse summary above; precise is gated               |
| `precise` | the same coarse summary; precise is gated (still requires reason/policy) |

`hidden` is enforced at every read path — coarse view, events, and precise.
The modes and the gate below are about agents: you, signed in to the
dashboard, always read your own presence, coarse and precise
(`GET /v1/presence` and `GET /v1/presence/precise` with a session), for Home
and its map.

## Precise location gate

`GET /v1/presence/precise?reason=…` (MCP `get_precise_location`) is allowed only
when **all** hold:

1. mode is not `hidden`,
2. the token carries `read_precise_location`,
3. `allowPreciseLocation` (env `ALLOW_PRECISE_TO_AGENT`) is true,
4. `preciseRequiresApproval` is false (WhereCtx has no interactive approval
   channel yet, so `true` always denies),
5. a non-empty `reason` is supplied when `preciseRequiresReason` is true,
6. **home protection** does not apply.

### Home protection

When `hideHomeExactCoordinates` is on (default) and you are at or near a `home`
place, precise location is **denied outright** — not rounded or blurred.
Coordinate rounding is not home-address anonymization, so WhereCtx refuses
instead. Disable `HIDE_HOME_EXACT_COORDINATES` if you want home coordinates
exposed to authorized agents.

### Home *place* protection

The home geofence itself is also protected (`protectHomePlace`, default on,
seeded from `PROTECT_HOME_PLACE` and toggleable live from the dashboard's
Privacy panel). While it is on, the MCP place-write tools (`create_place`,
`remember_current_place`) require the `manage_places` scope to create a
`home`-typed place or to touch an existing `home` place — otherwise an agent
could quietly move "home" and defeat the coordinate protection above. REST
place writes are always admin-only regardless of this toggle.

## Sharing with people

Location sharing between people (`/v1/shares`, `/v1/people`) is separate from
what agents see:

- It is off until you share with someone, and only with a person who belongs
  to a workspace you are in. It ends the moment the two of you no longer have
  a workspace in common, whichever way the membership ends.
- `coarse` shows your status name (`home`, `away`, `work`, `custom`, …),
  motion, how many whole minutes ago you were seen, and whether that is
  stale. It never shows a place's name or label (a street address, the name
  of a clinic) and never coordinates. `precise` adds your exact position, on
  the one-person read only.
- `hideHomeExact` withholds coordinates while you are at or near home. New
  shares take it from your `hideHomeExactCoordinates` setting (on by default).
  If you have no `home` place the server cannot tell when you are home, so it
  withholds coordinates everywhere until you add one or turn it off.
- Sharing more (a new share, coarse to precise, unhiding home) needs a recent
  passkey proof; sharing less never does. A viewer can also stop seeing you.
- `sharingPaused` (`PUT /v1/privacy`) hides you from everyone you share with
  at once, without deleting the shares.
- It does not follow `defaultAgentAccess`: putting agents in `hidden` mode
  does not hide you from people (use `sharingPaused` for that), and sharing
  with a person gives nothing to agents. Only a signed-in person sees shared
  locations; no token, including that person's own agent tokens, can.

### The share audit

Every grant, change (with the level and `hideHomeExact` before and after),
revoke (with the reason when it was not yours: `membership_ended`,
`viewer_declined`) and precise view lands in your share audit,
`GET /v1/shares/audit`, so you can see who looked. Precise views are recorded
at most once an hour per viewer, and only when coordinates were actually
shown. The audit is a separate table (`share_audit`), kept for
`SHARE_AUDIT_RETENTION_DAYS` (365 by default), and never part of presence
events: your agents, MCP, `/v1/events` and webhooks see nothing of whom you
share with.

## Token roles & the "device can't read" rule

- `device` tokens carry only `write_location` — they are rejected at every read
  boundary (REST and MCP), enforced by scope, not convention.
- `agent` tokens carry `read_presence` (+ optional `read_precise_location`).
- `admin` tokens carry the `manage_*` scopes.

Tokens are stored as SHA-256 hashes; the plaintext secret is shown once at
creation and never persisted. Bootstrap tokens left as `change-me-*` (or shorter
than 24 chars) are refused at boot; if no usable token is configured, a strong
admin token is generated and printed once.

## Staleness as a safety signal

A phone that reports on movement (OwnTracks in significant-change mode, the
mobile app, Home Assistant) keeps a connection and sends nothing while it
stays put, apart from an occasional ping. Silence from it means "has not
moved", not "unknown". Other sources (a reading posted by hand, a Shortcut
automation, a Tasker task) send only when something fires them, so their
silence says nothing either way.

Every age is from `receivedAt`, when the server heard the report, not the
device's own timestamp. The window is worked out from the source and the
config each time presence is read, so a config change applies to readings
already stored:

- A connected device's reading is `stale: true` (`freshness: offline`) only
  after `DEVICE_OFFLINE_AFTER_SEC` (default 86400, 24 h) with nothing
  received, and only then does `presence.became_stale` fire (once).
- A manual, Shortcut or Tasker reading is `stale: true`
  (`freshness: unknown`) after `STALE_AFTER_SEC` (default 900).
- Within its window a reading is `live` (received within `STALE_AFTER_SEC`
  and not at rest), `stationary` (at a registered place, reported at rest,
  or a connected device gone quiet: still at the last place), or `unknown`
  (a connected device that went quiet while driving or in transit).
- `lastMovedAgoSec` counts from when the person arrived where they are now:
  a report within 100 m of that arrival point keeps it, so a slow drift of
  small steps still counts as moving. `updatedAgoSec` is the same as
  `lastReportAgoSec`, kept for older clients.

The dashboard shows only how long ago, and "device offline" when freshness
is `offline`.

Device-reported timestamps more than 5 minutes in the future are
distrusted and clamped to server-receive time, so a skewed or malicious device
cannot pin presence permanently "fresh".

## Maps: directions, ETA and neighbourhood names

Agents can ask roughly how long it takes you to drive to one of your places
(MCP `get_eta`, `get_directions`, REST `GET /v1/geo/eta`), and your presence
can carry the neighbourhood you are in (`area`, such as "성남시 분당구
삼평동"). Both need a call to Kakao or Naver with your location. Everything
is off by default.

| Setting (`PUT /v1/privacy`) | Default | What it does |
|---|---|---|
| `geoEnabled` | off | Master switch. Off: no provider call with your location, no area, and every cached area answer is dropped. |
| `skipProviderNearHome` | on | Within your home place's near radius (its radius times `NEAR_RADIUS_MULTIPLIER`, by distance, whatever the status says), nothing goes out: no area lookup, and an agent asking for a route is refused ("at or near home"). Your own drive-time check starts at your home place instead. |
| `areaOnHome` | on | Your own Home shows your neighbourhood. |
| `areaToAgents` | off | Agents' coarse presence includes `area`. |
| `etaToAgents` | off | Agents may ask for an approximate ETA from your current location to your registered places. Separate from precise location; a drive time still reveals roughly how far away you are. |
| `areaToPeople` | off | The starting value of each new share's `showArea` (a per-share switch, turned on with a fresh passkey like any widening). |
| `geoProvider` | null | `kakao`, `naver`, or null for whichever has a key, Kakao first. |

Turning on `geoEnabled`, `etaToAgents`, `areaToAgents` or `areaOnHome`, or
turning off `skipProviderNearHome`, needs you in the dashboard with a
passkey proof from the last 10 minutes. No token can, even with
`manage_privacy`. Turning them back is free.

What leaves the server, and when:

- **Rounded, at one boundary.** Every provider is reached through one
  wrapper that cuts each point to three decimals (about 100 m) before the
  adapter sees it: your position for an area lookup, a route's origin, and
  its destination. Your exact position never leaves.
- **Sent:** that rounded point, the rounded destination of a route, and the
  text of an address you or an agent searched for. Never your name, a place's
  name or a coordinate to more than three decimals.
- **Region names only.** The area is the city/district and dong from the
  provider's administrative-region lookup. No street, building or number is
  kept.
- **Only for someone.** The area is looked up only while someone will see
  it: your Home (`areaOnHome`), agents (`areaToAgents`), or a share with
  `showArea`. With none of them, nothing is sent.
- **Off the ingest path.** The area is looked up after a reading is stored,
  in the background, from a per-person cache first, and at most once every
  two minutes per person. A reading more than 200 m from where the area was
  looked up drops it as it is stored; a move inside the two minutes is looked
  up once the window ends. A reading the device took more than five minutes
  earlier is not looked up. A failed lookup drops the area rather than keep
  one for somewhere else.
- **The cache** (`geo_cache`) keeps each answer for the shorter of seven
  days and your `retentionHours`. A row is keyed by an HMAC of the rounded
  cell under a per-install key, so the table is not a list of coordinates;
  the region names are stored as they are, and the key sits in the same
  database. Turning maps off or removing a key drops all your rows.
- **What an agent's ETA says.** Minutes in 5-minute steps (at least 5),
  whole kilometres, an arrival time to 5 minutes, no fares (a taxi fare is
  the distance), and main roads only: no road with any point within 1.5 km
  of your position or of the registered place it routes to, no side street
  (…번길, …로12길), and no road the provider gave no geometry for. The
  destination must be one of your registered places. The turn-by-turn
  steps, which name the streets you start on, and a destination given as an
  address, need precise access: `read_precise_location`, your
  `allowPreciseLocation`, a reason, and not at home. Every answer carries
  `freshness` and `originAgeMin`.
- **Only a fresh start.** A route starts only from a `live` reading, or a
  `stationary` one inside a registered place. Anything else is refused with
  its freshness and age.
- **Map links** (to the destination, starting from the device's own
  location) only for an address the agent itself named, or to a token with
  `manage_places`, which sees place coordinates anyway.
- **Address search** (adding a place by address, `create_place` with
  `address`) needs maps on; an agent also needs `manage_places` and a
  presence it may see. It sends only the text typed.
- **Logged.** Each provider call an agent causes, and each background area
  lookup (credential `system`), is an access log row: `geo.reverse`,
  `geo.geocode`, `geo.route`. No coordinates. A provider failure is
  `error`. Your own calls from the dashboard (the drive-time check, a
  search, a key test) are not logged, as your own reads are not.
- **Limits.** Every provider call counts against you (30 a minute, whoever
  asks, you included; a route to an address is two calls) and against the
  key (60 a minute). On an operator key, everyone but `USER_ID` also has
  `GEO_OPERATOR_DAILY_CAP` calls a day (default 200). The counters are in
  memory. Requests time out after 5 s, are not retried, and an answer over
  4 MB is refused; every string kept from it is stripped of control
  characters and cut to 200 characters.

### Keys (BYOK)

Save your own Kakao REST API key, or a Naver Cloud Maps Client ID and Client
Secret, under **Maps & routes**. A key is sealed with AES-256-GCM under a
per-install key kept in `server_secrets` before it is written, bound to your
user id and the provider (a row copied to someone else does not open), and
is never returned: the dashboard shows the last four characters, the last
use and the last error. A row that cannot be opened is shown as unusable and
skipped; save the key again or remove it. Saving, replacing or removing a key needs a passkey proof
from the last 10 minutes; no token can touch keys. The key test looks up
Seoul City Hall, never your location. The sealing key sits in the same
database, so this protects a leaked `geo_credentials` table or dump of it,
not a copy of the whole database.

The operator can set fallback keys (`KAKAO_REST_API_KEY`,
`NAVER_MAPS_CLIENT_ID`/`NAVER_MAPS_CLIENT_SECRET`, and for the map
`KAKAO_JS_KEY`, `NAVER_MAPS_KEY_ID`). Only the `USER_ID` person uses them
unless `GEO_OPERATOR_KEY_FOR_ALL=true` (REST keys) or
`GEO_OPERATOR_MAP_KEY_FOR_ALL=true` (map keys). The map opt-in is separate
because map tiles load in each person's browser: the server never sees
them, so `GEO_OPERATOR_DAILY_CAP` cannot count or limit them. Your own key,
for any provider, always wins over an operator key.

The REST keys and the map key of a provider are saved and removed apart:
removing the REST keys keeps the map key, and the dashboard says so.

### Maps in the dashboard

With a **map key** (a Kakao JavaScript key, or a Naver Maps Client ID) and
maps on, the dashboard draws interactive maps: Home (you, and each person
whose exact location you opened there, the audited read; nobody else),
History (your track and places), Places (your geofences; click to pick a
point), and the route tester in Maps & routes (your own route). Agents and
MCP get nothing new.

- **What the provider sees.** The map is drawn in your browser from tiles
  your browser asks Kakao or Naver for, so the provider sees which area you
  are looking at (your position, your places, your history, a person you
  opened) and your browser's IP address, at tile precision. Every request
  carries the map key, so the provider can link those views to the account
  that owns the key and to this server's address (the origin the key is
  registered for); Naver's key check also sends the map page's address
  (`/dashboard/map.html`, never a dashboard route). No coordinate is sent by
  the server for a map.
- **Near home.** While `skipProviderNearHome` is on and you are near a home
  place, Home's map shows that place's circle, not your position, and does
  not zoom in on you. The map still loads the tiles of whatever area it
  shows: here, around your home place, which you registered.
- **People you open.** A person whose exact location you opened stays on
  Home's map for five minutes at most, and leaves as soon as their share no
  longer offers it.
- **Nothing without a key.** With no map key, or maps off,
  `GET /v1/geo/map-config` answers `{ "provider": null }`, no map frame is
  made, Home does not read your point for a map, and no script, tile or
  request goes to a provider. History draws your track from the points
  alone, as before.
- **The key.** A map key is a browser key by design: the provider restricts
  it to the domains you register (this dashboard's origin), not by secrecy.
  It is still sealed with your other keys and sent only to your own signed-in
  browser, never to a token. Saving it needs a fresh passkey; removing it
  does not.
- **CSP.** The dashboard page keeps the strict CSP for everyone
  (`script-src 'self'`); it only may frame its own pages. A map is a frame
  of `/dashboard/map.html`, the one page whose CSP adds the providers'
  exact hosts: Kakao `dapi.kakao.com`, `t1.kakaocdn.net` (scripts),
  `mts.kakaocdn.net`, `t1.kakaocdn.net` (images); Naver
  `oapi.map.naver.com`, `nrbe.pstatic.net` (scripts: the key check and
  tile metadata are JSONP), `nrbe.pstatic.net`, `ssl.pstatic.net`
  (images), `nrbe.pstatic.net` (connect). No `'unsafe-eval'`, no wildcard.
  Naver's error telemetry (`kr-col-ext.nelo.navercorp.com`) stays blocked.
  The provider's script, with the key in its URL, lives in that frame and
  goes with it, so signing out leaves no map script or key in the page.
- **What that CSP does not stop.** JSONP endpoints on `oapi.map.naver.com`
  and `nrbe.pstatic.net`, and a general CDN (`t1.kakaocdn.net`), will
  serve script for any URL on them, so inside the map frame `script-src`
  is not a barrier against those hosts. The frame is same-origin with the
  dashboard (Kakao checks the key by the Referer, which an opaque sandboxed
  frame never sends), so a script those hosts serve could reach the
  dashboard and its session. The dashboard page itself keeps its strict
  policy, so an injection there cannot use them; the frame runs only its own
  script and the provider's, and takes from the dashboard only a provider,
  a script URL from that provider's own https origin, and a parsed scene.
- **Referrer.** The map frame sends its origin, never its path, to those
  hosts (`Referrer-Policy: strict-origin`), so the provider can match the
  key's registered domain. Every other page sends no referrer.

## Raw history

Disabled by default (`STORE_RAW_HISTORY=false` seeds each person's
`storeRawHistory`; each person turns it on in Privacy). When enabled, each
reading's coordinates are kept and pruned past that person's
`retentionHours` (default `RETENTION_HOURS`, at most 8760). Pruning keeps
running after history is turned off, on every reading and in the 6-hourly
sweep, so points kept earlier still age out.

Only the person reads their own history: the dashboard's History view, or
`GET /v1/presence/history` with `manage_privacy` (their session, or their
admin token, whose read is recorded in the access log). A location share
gives a viewer no history.

## What is logged, for how long, and who sees it

| Log | What a row holds | Kept | Who can read it |
|-----|------------------|------|-----------------|
| Access log (`access_log`) | Every maps provider call made with the person's location or key (`geo.reverse`, `geo.geocode`, `geo.route`, under the agent or `system`). Every token request to the person's `/v1` routes (all but ingest and sign-in: presence, places, events, privacy, webhooks, tokens, devices, and token attempts at account, activity and admin routes) and every MCP tool call, refused calls included, from a token or a connected OAuth app. The token's id and name (for an app, its grant id and client name), REST or MCP, the action (never a raw path or tool name), whether it sought coordinates, the reason given for a precise request, the outcome (allowed, denied, hidden, error) and why it was denied. Identical requests within a minute share a row with a count. No coordinates. The reason and denial go through the same redaction as an ingest rejection. | `ACCESS_LOG_RETENTION_DAYS`, default 90 days | The person, signed in (Agent access view, `GET /v1/activity/access`). No token can read it. |
| Ingest log (`ingest_log`) | Every authenticated upload from a device: which token (none for the dashboard's "share now"), which route, accepted, rejected, ignored or a server error, and why. No coordinates: the table has no column for them, and a rejection message is redacted before it is stored. | `INGEST_LOG_RETENTION_DAYS`, default 7 days | The person, signed in (Devices view, `GET /v1/activity/ingest`, and the summary in `GET /v1/devices`). |
| Share audit (`share_audit`) | Grants, changes, revokes, and who viewed the person's precise location. | `SHARE_AUDIT_RETENTION_DAYS`, default 365 days | The person (`GET /v1/shares/audit`). |
| Server log | What the server reports: errors, webhook failures, boot notices. Written through one logger that redacts as it writes (see below). | stdout/stderr (for `docker logs`) as long as the host keeps them; the last 1000 entries in memory until restart | The operator (the `USER_ID` person) in the Server logs view, `GET /v1/admin/logs`. Nobody else, no token. |

The person's own reads in the dashboard are not in the access log: it
records agents, not the owner looking at their own data. A request that fails
authentication names no owner and lands in no person's log.

What keeps secrets and locations out of the server log, and what it does not
promise:

- **By construction.** The setup code, an access code and a generated admin
  token are a `Secret` value, not a string. The log's `info`, `warn`,
  `error` and `debug` calls do not accept one (a type error), and one that
  reaches a field anyway prints as `[redacted]`. Only the boot banner and
  the `reset-access` command print them, to stdout, and never into the
  in-memory log the Server logs view reads. An error is logged as a fixed set
  of fields (name, first line of its message, code, stack frames, cause), so
  a failed database query is logged by its SQL with placeholders, never by
  the values it was given.
- **By pattern.** Everything else is redacted as it is written: values under
  keys whose last word is token, secret, password, authorization, cookie,
  session, signature, lat, lon or precise (and keys such as `sessionId`,
  `setupCode`, `apiKey`); and inside any string, Bearer and Basic
  credentials, `wctx_` tokens, session cookies, a password in a URL
  (`scheme://user:pass@`), any query parameter whose name mentions token,
  secret, password, key, code or auth, coordinates written as `lat=`/`lon=`
  or a pair with three or more decimals, and long opaque runs. Patterns are
  a safety net, not a guarantee: a short value with no telling name or
  shape, such as a coordinate with two decimals in free text or a geohash,
  would not be recognised. Code that logs is written not to pass such
  values.

The operator role follows `USER_ID`. Changing `USER_ID` on an existing
install moves the Server logs view (and `isOperator`) to the person with the
new id; if that person has no passkey yet, `reset-access` gives them an access
code (README, "Recover access").

## Webhooks & SSRF

A place with `notifyWebhooks` off keeps its name away from every webhook:
its events, and `presence.updated` while inside it, are stored with
`webhook = 0` and the dispatcher reads only `webhook = 1` rows, in SQL. They
still appear in the person's own history and to their agents. A hook's
place filter narrows place events further.

Webhook delivery is a server-side outbound request to an operator-supplied URL.
WhereCtx blocks targets that resolve to private/reserved addresses (loopback,
`169.254.0.0/16` cloud metadata, RFC1918, ULA, link-local) at both create and
delivery time, and uses `redirect: "manual"`. Set
`WEBHOOK_ALLOW_PRIVATE_TARGETS=true` only to deliberately reach a LAN service
(e.g. a local Home Assistant). Webhook bodies are HMAC-SHA256 signed over
`"<timestamp>.<body>"` (`X-WhereCtx-Signature`, `X-WhereCtx-Timestamp` — see
docs/api.md for verification) when the subscription has a secret, and signing
secrets are encrypted at rest when `WEBHOOK_ENCRYPTION_KEY` is set.

## Accounts and sessions

People sign in with passkeys that require user verification (biometric or
PIN). The server stores only SHA-256 hashes of session cookies, recovery
codes, setup codes, access codes, and OAuth authorization codes, access
tokens, and refresh tokens. Adding or deleting a passkey, replacing recovery
codes, minting a token, connecting an MCP app, and sharing more all need a
passkey proof from the last 10 minutes. Signing in with a recovery code or an
access code, deleting a passkey, replacing recovery codes, and signing out
everywhere else also revoke every connected MCP app. See [decisions.md](decisions.md#accounts-workspaces-passkeys).

## Deployment posture

The default bind is `0.0.0.0` (required for Docker). Run WhereCtx behind a
reverse proxy with TLS. Passkeys work only on https or on localhost, so a
server reached by people on other devices needs TLS anyway (see the
[README](../README.md#passkeys-need-https-or-localhost)). Behind a proxy, set
`TRUST_PROXY` so rate limits see real clients. Prefer the
`Authorization: Bearer` header over the `?token=` query parameter, which only
ingest routes accept and which can leak into proxy logs.
