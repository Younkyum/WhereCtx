# Privacy & policy

WhereCtx is designed around one principle:

> **Presence by default, precise location when needed.**

Agents usually need a contextual state (`near_home`, `walking`, `stale`), not raw
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
returned to agents contain only `name` + `type`.

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

Each reading carries `staleAfterSec` (env `STALE_AFTER_SEC`, default 900). Past
that, presence is marked `stale: true` and a `presence.became_stale` event fires
(once). Device-reported timestamps more than 5 minutes in the future are
distrusted and clamped to server-receive time, so a skewed or malicious device
cannot pin presence permanently "fresh".

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
| Access log (`access_log`) | Every agent or token request for the person's presence data: REST presence, places and events routes and every MCP tool call. The token's id and name, REST or MCP, the action, whether it was precise, the reason given for a precise read, the outcome (allowed, denied, hidden) and why it was denied. No coordinates. | `ACCESS_LOG_RETENTION_DAYS`, default 90 days | The person, signed in (Agent access view, `GET /v1/activity/access`). No token can read it. |
| Ingest log (`ingest_log`) | Every authenticated upload from a device: which token (none for the dashboard's "share now"), which route, accepted, rejected or ignored, and why. No coordinates: the table has no column for them, and a rejection message is redacted before it is stored. | `INGEST_LOG_RETENTION_DAYS`, default 7 days | The person, signed in (Devices view, `GET /v1/activity/ingest`, and the summary in `GET /v1/devices`). |
| Share audit (`share_audit`) | Grants, changes, revokes, and who viewed the person's precise location. | `SHARE_AUDIT_RETENTION_DAYS`, default 365 days | The person (`GET /v1/shares/audit`). |
| Server log | What the server reports: errors, rejected uploads, webhook failures, boot notices. Redacted as it is written: tokens, Bearer and Basic credentials, cookies, session ids, recovery, setup and access codes, signatures, and coordinates (key=value, JSON, or a lat,lon pair) are masked. | stdout/stderr (for `docker logs`) as long as the host keeps them; the last 1000 entries in memory until restart | The operator (the `USER_ID` person) in the Server logs view, `GET /v1/admin/logs`. Nobody else, no token. |

The person's own reads in the dashboard are not in the access log: it
records agents, not the owner looking at their own data. A request that fails
authentication names no owner and lands in no person's log.

The boot banners print the one-time setup code and any generated admin token
to stdout on purpose, for the operator at the console. They never enter the
in-memory log, so the Server logs view cannot show them.

## Webhooks & SSRF

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
codes, setup codes, and access codes. Adding or deleting a passkey, replacing
recovery codes, minting a token, and sharing more all need a passkey proof
from the last 10 minutes. See [decisions.md](decisions.md#accounts-workspaces-passkeys).

## Deployment posture

The default bind is `0.0.0.0` (required for Docker). Run WhereCtx behind a
reverse proxy with TLS. Passkeys work only on https or on localhost, so a
server reached by people on other devices needs TLS anyway (see the
[README](../README.md#passkeys-need-https-or-localhost)). Behind a proxy, set
`TRUST_PROXY` so rate limits see real clients. Prefer the
`Authorization: Bearer` header over the `?token=` query parameter, which only
ingest routes accept and which can leak into proxy logs.
