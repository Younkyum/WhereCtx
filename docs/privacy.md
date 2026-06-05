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
4. `preciseRequiresApproval` is false (no interactive approval channel in v0.1),
5. a non-empty `reason` is supplied when `preciseRequiresReason` is true,
6. **home protection** does not apply.

### Home protection

When `hideHomeExactCoordinates` is on (default) and you are at or near a `home`
place, precise location is **denied outright** — not rounded or blurred.
Coordinate rounding is not home-address anonymization, so WhereCtx refuses
instead. Disable `HIDE_HOME_EXACT_COORDINATES` if you want home coordinates
exposed to authorized agents.

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

Disabled by default (`STORE_RAW_HISTORY=false`). When enabled, raw points are
pruned past `RETENTION_HOURS`. Raw history is admin-only (`GET /v1/presence/history`).

## Webhooks & SSRF

Webhook delivery is a server-side outbound request to an operator-supplied URL.
WhereCtx blocks targets that resolve to private/reserved addresses (loopback,
`169.254.0.0/16` cloud metadata, RFC1918, ULA, link-local) at both create and
delivery time, and uses `redirect: "manual"`. Set
`WEBHOOK_ALLOW_PRIVATE_TARGETS=true` only to deliberately reach a LAN service
(e.g. a local Home Assistant). Webhook bodies are HMAC-SHA256 signed
(`X-WhereCtx-Signature: sha256=…`) when the subscription has a secret.

## Deployment posture

The default bind is `0.0.0.0` (required for Docker). Run WhereCtx behind a
reverse proxy with TLS; do not expose it raw with placeholder tokens. Prefer the
`Authorization: Bearer` header over the `?token=` query parameter (which is only
accepted on ingest routes and can leak into proxy logs).
