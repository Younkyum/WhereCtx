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
  "updatedAgoSec":42, "stale":false, "privacy":"coarse" }
```
`403` with `{ "privacy":"hidden" }` in hidden mode; `404` before any reading.

```http
GET /v1/presence/precise?reason=user_requested_map
Authorization: Bearer AGENT_TOKEN
```
```json
{ "lat":37.123456, "lon":127.123456, "accuracyM":21,
  "mapUrl":"https://maps.google.com/?q=37.123456,127.123456", "updatedAgoSec":42 }
```
`403 { "error":"precise location denied", "detail":"…" }` when policy/home-protection deny it.

```
GET /v1/presence/history?limit=100   # admin (manage_privacy); empty unless STORE_RAW_HISTORY
```

## Places

```
GET    /v1/places            # read_presence (agents: name+type only) | manage_places (full)
POST   /v1/places            # manage_places — create/replace by name
DELETE /v1/places/:name      # manage_places
```
```json
{ "name":"home", "label":"Home", "lat":37.123, "lon":127.123, "radiusM":150, "type":"home" }
```
`type`: `home | work | custom`.

## Events

```
GET /v1/events?limit=50      # read_presence; placeName stripped for agents; 403 in hidden mode
```

## Privacy (admin)

```
GET /v1/privacy              # manage_privacy
PUT /v1/privacy              # manage_privacy — partial update; emits privacy_changed
```
Body keys: `defaultAgentAccess`, `allowPreciseLocation`, `preciseRequiresReason`,
`preciseRequiresApproval`, `hideHomeExactCoordinates`, `protectHomePlace`,
`retentionHours`, `storeRawHistory`, `sharingPaused` (all optional).
`sharingPaused` hides you from everyone you share your location with (see
[Location sharing](#location-sharing-signed-in-people)); it has no effect on
agents.

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

GET|PATCH /v1/me                          # profile, workspaces, passkeys, sessions
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
PUT    /v1/shares/:viewerUserId          # { "level":"coarse"|"precise", "hideHomeExact"?:bool } -> { share }
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
  "presence": { "status":"away", "label":"away", "motion":"walking", "updatedAgoMin":3, "stale":false },
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

## Webhooks (admin)

```
GET    /v1/webhooks                 # manage_privacy — secrets stripped
POST   /v1/webhooks                 # { "url":"https://…", "events":["*"], "secret":"…" }
GET    /v1/webhooks/dead-letters    # undeliverable events
DELETE /v1/webhooks/:id
```
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
`presence.became_stale`, `presence.privacy_changed`. Location sharing is not
delivered by webhook; its audit is at `GET /v1/shares/audit`.

## Misc

```
GET /            # { name, version, status }
GET /healthz     # { status:"ok" }
GET /dashboard   # web UI: passkey sign-in, people, sharing, devices, agents
POST /mcp        # MCP endpoint (see docs/mcp.md)
```
