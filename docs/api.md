# REST API

Base URL: `http://localhost:8787` (set `BASE_URL` for the public URL).
All authenticated routes use `Authorization: Bearer <token>`.

## Auth & scopes

| Scope | Roles |
|-------|-------|
| `write_location` | device, (admin not by default) |
| `read_presence`, `read_precise_location` | agent, admin |
| `manage_places`, `manage_tokens`, `manage_privacy` | admin |

Responses: `401` (no/invalid token), `403` (missing scope), `400` (validation),
`404` (not found), `413` (body > 64 KB), `500`.

## Ingest (device)

`?token=` query auth is accepted on these routes only.

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
`retentionHours`, `storeRawHistory` (all optional).

## Tokens (admin)

```
GET    /v1/tokens            # manage_tokens — no secrets
POST   /v1/tokens            # { "name":"phone", "role":"device" } -> { token, secret } (secret shown once)
DELETE /v1/tokens/:id        # revoke
```

## Webhooks (admin)

```
GET    /v1/webhooks                 # manage_privacy — secrets stripped
POST   /v1/webhooks                 # { "url":"https://…", "events":["*"], "secret":"…" }
GET    /v1/webhooks/dead-letters    # undeliverable events
DELETE /v1/webhooks/:id
```
URLs that resolve to private/reserved IPs are rejected (SSRF guard) unless
`WEBHOOK_ALLOW_PRIVATE_TARGETS=true`. Secrets are encrypted at rest when
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
`presence.became_stale`, `presence.privacy_changed`.

## Misc

```
GET /            # { name, version, status }
GET /healthz     # { status:"ok" }
GET /dashboard   # admin web UI
POST /mcp        # MCP endpoint (see docs/mcp.md)
```
