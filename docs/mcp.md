# MCP integration

WhereCtx exposes presence to AI agents over the Model Context Protocol using the
**Streamable HTTP** transport at `POST /mcp`.

## Connecting

`/mcp` accepts two kinds of Bearer credential:

- An OAuth access token. A remote MCP client such as Claude gets one by
  sending you through a consent screen. Nothing is pasted.
- An `agent` or `admin` token from the dashboard. Use it for clients that
  cannot do OAuth, such as Hermes or a script.

Device tokens and session cookies are rejected. Either way, every tool reads
and writes only the presence, places, events, and reminders of the person who
consented or made the token.

### Connect with OAuth

Add `<BASE_URL>/mcp` as a remote MCP server in the client. The client finds
the rest on its own:

1. Its first request gets a `401` whose `WWW-Authenticate` header points at
   the protected resource metadata.
2. It reads the metadata, then the authorization server metadata, and starts
   an authorization code flow with PKCE.
3. Your browser opens the WhereCtx consent screen. Sign in with your passkey
   if you are not signed in.
4. Check the verified app ID, the redirect host, and the account. Choose
   whether to allow precise location, and click **Allow**.
5. If your last passkey proof is older than 10 minutes, confirm with your
   passkey again.

Connecting the same app again replaces its earlier connection.

To disconnect an app, open **Agents** in the dashboard and click **Revoke**
next to it under **Connected apps**. Its access and refresh tokens stop
working at once.

### Bearer token

Create an agent token under **Agents** in the dashboard. It is shown once,
together with a Claude Desktop entry for `<BASE_URL>/mcp`.

#### Claude Desktop

```json
{
  "mcpServers": {
    "wherectx": {
      "url": "https://wherectx.example.com/mcp",
      "headers": { "Authorization": "Bearer AGENT_TOKEN" }
    }
  }
}
```

#### Hermes

```yaml
mcp_servers:
  wherectx:
    url: "https://wherectx.example.com/mcp"
    headers:
      Authorization: "Bearer AGENT_TOKEN"
```

## OAuth reference

WhereCtx follows the
[MCP authorization spec, revision 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).
The authorization server is embedded and runs on
[oidc-provider](https://github.com/panva/node-oidc-provider). Its issuer is
`BASE_URL` in canonical form (lower-case host, no default port), so
`BASE_URL` must be the public `https` origin. Every endpoint URL, redirect,
and cookie flag comes from `BASE_URL`. The server ignores the request's
`Host`, `X-Forwarded-Host`, and `X-Forwarded-Proto` headers here, whatever
`TRUST_PROXY` says. `TRUST_PROXY` only picks the header that carries the
client IP for rate limits.

### Endpoints

| Path | Purpose |
|------|---------|
| `/.well-known/oauth-protected-resource/mcp` | protected resource metadata for `/mcp` (RFC 9728). Also served at `/.well-known/oauth-protected-resource`. |
| `/.well-known/oauth-authorization-server` | authorization server metadata (RFC 8414). Also served at `/.well-known/openid-configuration`. |
| `/oauth/authorize` | authorization endpoint |
| `/oauth/token` | token endpoint |
| `/oauth/revoke` | token revocation (RFC 7009) |
| `/oauth/jwks` | the server's public signing key |
| `/oauth/register` | dynamic client registration, only when `OAUTH_DYNAMIC_REGISTRATION=true` |
| `/oauth/interaction/:uid` | sends the browser to the dashboard consent screen. `POST …/confirm` needs a passkey proof from the last 10 minutes. |
| `/v1/oauth/grants` | `GET` lists your connected apps, `DELETE /v1/oauth/grants/:id` revokes one (session only) |

### Scopes

| OAuth scope | Grants | On the consent screen |
|-------------|--------|-----------------------|
| `presence:read` | `read_presence` | always granted when requested |
| `location:precise` | `read_precise_location` | granted only if you tick the box. It is unticked by default. |
| `offline_access` | nothing | granted when requested. It does not decide refresh tokens. |
| `openid` | nothing | never granted, so no ID token is issued |

Precise location stays subject to the privacy settings, as it is for agent
tokens. An OAuth token never gets `manage_places`, so the home place stays
protected from it.

### Clients

- Clients identify themselves with a
  [Client ID Metadata Document](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/):
  an `https` URL as `client_id` that serves the client's metadata. The server
  advertises `client_id_metadata_document_supported: true`. It refuses to
  fetch documents from private or special-use addresses.
- Dynamic client registration is off. The MCP spec deprecates it. Set
  `OAUTH_DYNAMIC_REGISTRATION=true` to turn it on for older clients. A
  registered client expires after 30 days.
- Every client is public (`token_endpoint_auth_method: none`). PKCE with
  `S256` is required.
- The consent screen shows the host of the `client_id` as the verified app
  ID. The app name is the title, and the website is labelled as the app's own
  claim: neither is verified. The screen also shows the redirect host and the
  account that is consenting. It warns when this request's redirect URI is
  not `https` (loopback `http` or an app's own URL scheme), because any
  program on that device could use the name. Consent is asked on every
  authorization, never skipped.
- `/oauth/authorize`, `/oauth/token`, and `/oauth/register` allow 60 requests
  per client per minute.

### Tokens

- The `resource` parameter (RFC 8707) must name `<BASE_URL>/mcp`. Any other
  resource gets `invalid_target`. Upper-case scheme and host and a trailing
  slash are accepted.
- Access tokens are opaque, last 10 minutes, and are bound to `/mcp` as their
  audience. REST endpoints under `/v1/` reject them.
- A refresh token is issued whenever the client's metadata lists the
  `refresh_token` grant type, with or without `offline_access`. Refresh
  tokens rotate on every use and last 30 days, as long as the grant.
- A person holds one grant per client. Consenting again revokes the earlier
  grant and every token issued under it.
- Authorization codes, access tokens, and refresh tokens are stored as
  SHA-256 hashes.
- Signing in with a recovery code or an access code, deleting a passkey,
  replacing recovery codes, and signing out everywhere else revoke every
  connected app.
- Authorization responses include `iss` (RFC 9207).
- Signing and cookie keys are generated on first boot and kept in the
  database, so every instance sharing it agrees.

### Errors on `/mcp`

| Case | Status | `WWW-Authenticate` |
|------|--------|--------------------|
| no credential | `401` | `Bearer scope="presence:read location:precise", resource_metadata="…"`. Does not count toward the failed-auth limit. |
| unknown, expired, or revoked token, or a token for another resource | `401` | adds `error="invalid_token"` |
| token without `read_presence` | `403` | `Bearer error="insufficient_scope", scope="presence:read", resource_metadata="…"` |

## Tools

| Tool | Args | Returns |
|------|------|---------|
| `get_presence` | – | coarse status/label/motion/age, `freshness`, `lastReportAgoSec` (`updatedAgoSec` is the same), `lastMovedAgoSec`, `stale` (no GPS); `area` when allowed; `transition: {kind, placeType, forSec}` while an arrival or departure waits out its place's dwell time. `{status:"hidden"}` in hidden mode |
| `get_precise_location` | `reason: string` | `{lat, lon, accuracyM?, mapUrl, updatedAgoSec}` or an error if denied by policy/home-protection |
| `is_near_place` | `name: string` | `{name, inside, near, confirmed, pending, freshness, lastReportAgoSec}` as of the last report (no coordinates) |
| `list_places` | – | `[{name, type}]` (a `manage_places` token also gets coordinates, radius, a polygon's outline and the rules) |
| `get_location_age` | – | `{updatedAgoSec, updatedAt, stale, freshness, lastReportAgoSec, lastMovedAgoSec}`; ages are from when the server heard the phone, `updatedAt` is the device's own time of the fix |
| `list_recent_presence_events` | `limit?: number` | recent events, `approaching_place` included (place names omitted for agents) |
| `create_location_reminder` | `place: string, message: string` | `{id, place, message}`; the place must exist; refused in hidden mode |
| `create_place` | `name, type, lat, lon, radiusM?` or `name, type, address, pick?, radiusM?` | `{name, type, radiusM, address?}`; registers/replaces a geofence. An address is looked up with the user's maps provider, which needs the user's maps on, `manage_places` and a presence the agent may see; several matches come back numbered for `pick` |
| `remember_current_place` | `name, type?, radiusM?` | `{name, type, radiusM}`; saves the **current** location as a place (coordinates are never returned) |
| `get_eta` | `to, mode?, pick?, departAt?, avoid?, reason?` | `{mode, destination, origin, precision:"approximate", durationMin, distanceKm, departAt, arriveAt, summary, provider, freshness, originAgeMin, …}`; by car also `traffic`; by transit also `walkMin`, and `transfers` only beside named lines. `mode` is `car` (default), `transit`, `walk` or `bike`. Roughly how long the trip takes from where the user is now to a registered place. Never coordinates. Needs the user's `geoEnabled` and `etaToAgents`. It still tells the agent roughly how far away the user is |
| `get_directions` | same | `get_eta` plus `steps` (turn instructions, or a transit route's legs, which name stations; at most 30) when the agent may read the precise location, else `stepsWithheld`; and, for an address the agent named or a `manage_places` token, `deepLinks` (Kakao Map web, Naver Map app) |

All tools apply the same privacy rules as the REST API: hidden mode withholds,
precise is policy-gated, home coordinates are protected, and coarse tools never
return raw coordinates or geohash.

### Confirmed and pending places

A place may ask for a few minutes inside before an arrival counts, or
outside before a departure counts. Presence follows the **confirmed**
place: `status` stays `work` while a departure from work waits out its
time, and does not say `work` while an arrival there waits. `is_near_place`
separates the two. `inside` is where the last report is; `confirmed` is
whether presence counts the user at the place; `pending` is `entering` or
`leaving` while a wait is on, else `null`. Both are always given, so the
reply does not reveal whether a place has a wait set. `get_presence` adds
`transition: {kind: "entering" | "leaving", placeType, forSec}` while one
is pending, without the place's name. Waits resolve within about a minute.
`presence.approaching_place` fires once as the user heads toward a place
that watches for it. Agents never see a place's shape, radius, coordinates
or rules; polygon places answer the same tools as circles.

### Home place protection

By default (`PROTECT_HOME_PLACE=true`, toggleable live from the dashboard's
Privacy panel), `create_place` and `remember_current_place` refuse to create a
`home`-typed place — or to overwrite an existing `home` place under any type —
unless the credential carries the `manage_places` scope (an admin token). This stops an agent
from moving the home geofence, which would mislead the home-coordinate privacy
protections. Non-home places stay writable by agent tokens.

Both tools write circles, so they refuse to overwrite a polygon place for any
credential: it would silently lose its outline. A polygon place is changed
over REST (`POST /v1/places`) or in the dashboard.

Every `tools/call` request is recorded in the owner's access log (the token
name, or the connected app's name for an OAuth client; tool; outcome; and the reason given for `get_precise_location`), one
row per call, including calls refused before a tool runs: arguments that
fail the tool's schema are recorded as denied with "invalid arguments", and a
tool name that does not exist as `unknown` (the name is not stored). A token
without `read_presence` (an OAuth token without `presence:read`) is refused
with `403` and recorded as `mcp.request`.
Identical calls within a minute share a row with a count. The owner sees it
in the dashboard's Agent access view; see [privacy.md](privacy.md#what-is-logged-for-how-long-and-who-sees-it).

A POST may batch at most 10 JSON-RPC messages; a larger batch is refused with
`400` and JSON-RPC error `-32600`.

### ETA and directions

`to` is the name of one of the user's registered places (`home`,
`office`). `mode` is `car` (the default), `transit`, `walk` or `bike`. The
route starts at the user's current location, rounded to about 100 m before
it leaves the server.

The answer is approximate on purpose, so it cannot be worked back to where
the user is: `departAt` floored to 5 minutes, `durationMin` in 5-minute
steps (at least 5; on foot or by bicycle, 15-minute steps from 15 on),
`arriveAt` exactly `departAt` plus `durationMin`, `distanceKm` in whole
kilometres (at least 1), no fares, and `summary` only the main roads that
run at least 1.5 km from the start, the destination and every registered
place, without side streets (…번길, …로12길). The same credential asking
the same thing within 5 minutes gets the same answer back, with no new
provider call. It still reveals roughly how far away the user is, which is
why the user turns it on separately (`etaToAgents`).

By transit, `summary` names one line per ride (`"2호선"`, `"간선 472"`), in
the order ridden, only when every ride runs farther than 1.5 km from the
start, the destination and every registered place, and carries a citywide
label (a 간선, 지선, 광역, 직행, 순환, 급행 or 공항 bus number, `N호선`, or a
named rail line such as 신분당선). Otherwise `summary` is empty and
`transfers` is left out. A village bus (`마을 서초09`) is never named.
`walkMin` is the minutes on foot in 5-minute steps. No stop name, fare or
leg is given. With precise access each ride's first line is named and
`get_directions` gives the legs' steps, which name stations. On foot and by
bicycle, `summary` is empty and the steps follow the same gate.

Precise access opens two more things: the `steps` of `get_directions`, at
most 30 (they name the streets or stations around the user), and an address or
place to search as `to`. It needs `read_precise_location`, the user's
`allowPreciseLocation`, a `reason` when the user requires one, and the user
not at home, the same gate as `get_precise_location`. Without it, an address
is refused and `stepsWithheld` says why the steps are missing. Several
search matches return `{ambiguous:true, candidates:[{pick, label, address,
…}]}`; call again with `pick`.

A provider failure reaches the agent as fixed words per kind (`no route
found`), never the provider's own text. A tool answers with an error text,
never a guess, when maps or ETA for
agents are off, the user is at or near home (with `skipProviderNearHome`,
the default), no maps key is set up, the user's maps budget is spent (30
provider calls a minute, a route to an address being two), or the reading is
too old to start from. A route starts only from a `live` reading or a
`stationary` one inside a registered place; the refusal carries `freshness`
and `originAgeMin`, as every answer does. Each call also writes a
`geo.geocode` or `geo.route` row (`geo.route.transit`, `.walk`, `.bike` by
mode) to the user's access log under the same credential.

Provider support: by car, Kakao (Kakao Mobility Directions) times a future
`departAt` on predicted traffic (`traffic:"predicted"`); Naver Directions 5
always uses live traffic and refuses `departAt`. Transit, walking and
cycling come from the Kakao Map API (added 2026-07-21) and time a departure
now only: a later `departAt` or any `avoid` with them is refused as
`unsupported_option` (REST `400`) before anything is sent. Naver Cloud Maps
has no transit, walking or cycling API, so on Naver those modes answer
`unsupported_mode` with `supported` (the modes it does route) and, when
another provider with a key routes the mode, a `hint` to switch
`geoProvider`; nothing is sent.
Transit times are the provider's estimate, not a live timetable.

## Agent usage policy

Recommended system-prompt snippet (also in `examples/hermes/prompt.md`):

```md
You have access to user presence through WhereCtx.

Use location only when relevant.
Prefer coarse presence over precise GPS.
Never reveal raw coordinates unless the user explicitly asks.
A quiet phone is normal: phones report only when they move. Treat
freshness "stationary" as still at the last place. "offline" and "unknown"
mean the location may be wrong; say that clearly.
When the user is moving, prefer concise replies.
When precise location is requested, provide the reason to the tool.
Do not infer sensitive behavior from location history.
```

## Notes

- The transport is stateless (one server/transport per request); no session
  cookies. Request bodies are capped at 64 KB.
- A denied precise request returns an MCP tool error with a human-readable
  reason (e.g. "exact home/near-home coordinates are protected by policy").
