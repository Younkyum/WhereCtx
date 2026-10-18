# OwnTracks → WhereCtx

[OwnTracks](https://owntracks.org) is an open-source location app for iOS and
Android. WhereCtx accepts its HTTP mode directly.

## Pair with a QR code

Ask the server for a ready configuration (from a signed-in session that has
re-confirmed its passkey, or with an admin token). The config points the
phone at `BASE_URL`, so the server refuses to pair (`base_url_unusable`) until
`BASE_URL` is its public https URL:

```bash
curl -X POST https://wherectx.example.com/v1/devices/pair \
  -H "Authorization: Bearer ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Mina phone","kind":"owntracks"}'
```

The response holds a new device token and:

- `config`: an OwnTracks remote configuration in HTTP mode (`mode: 3`) that
  posts to `/v1/ingest/owntracks` and authenticates with HTTP Basic, the token
  being the password. It uses `monitoring: 1` (significant location changes),
  which the OwnTracks booklet describes as the battery-friendly mode.
- `link`: `owntracks:///config?inline=…`. Open it on the phone, or
- `qrSvg`: the same link as a QR code. Scan it with the phone camera.

OwnTracks imports the configuration and starts reporting. The token is shown
only in this response; to replace it, revoke it under `/v1/tokens` and pair
again.

### iPhone: allow configuration by link first

OwnTracks for iOS 26.2.2 and later turns off configuration from
`owntracks://` links and config files by default. Scanning the code then
fails with "URL or file configuration not allowed". To pair:

1. In OwnTracks, open **Settings** and allow configuration by URL and config
   file. The app shows a confirmation dialog, because any such link can
   reconfigure it completely. Confirm it.
2. Scan the QR code (or open the link) again.
3. Once the phone reports, turn the setting back off.

Sources: the [26.2.2 release notes](https://newreleases.io/project/github/owntracks/ios/release/26.2.2)
and the booklet's [remote configuration](https://owntracks.org/booklet/features/remoteconfig/) page.

## Configure OwnTracks by hand (HTTP mode)

In the OwnTracks app: **Settings → Connection**

- **Mode:** `HTTP`
- **Host / URL:** `https://wherectx.example.com/v1/ingest/owntracks`
- **Authentication:** turn on authentication and enter any username with the
  device token as the **password**. OwnTracks sends it as HTTP Basic, which
  WhereCtx accepts on ingest routes only.
  Alternatively append the token to the URL:
  `https://wherectx.example.com/v1/ingest/owntracks?token=DEVICE_TOKEN`
  (query strings can end up in proxy logs, so prefer the password field).
  Use TLS either way so the token isn't sent in clear text.

OwnTracks posts several message types; WhereCtx normalizes `_type:"location"`
messages and acknowledges the rest with an empty array `[]`, as OwnTracks
expects.

## Fields used

| OwnTracks | WhereCtx |
|-----------|----------|
| `lat`, `lon` | coordinates (required) |
| `acc` | accuracy (m) |
| `alt` | altitude (m) |
| `vel` | velocity (km/h → m/s) → motion inference |
| `cog` | heading (°) |
| `batt` | battery level (%) |
| `bs` | battery status (2 = charging) |
| `tst` | timestamp (unix seconds) |

## Test

```bash
curl -X POST "https://wherectx.example.com/v1/ingest/owntracks?token=DEVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"_type":"location","lat":37.123,"lon":127.123,"acc":12,"vel":0,"batt":80,"bs":1,"tst":1717000000}'
# -> []
```

Then check presence:

```bash
curl https://wherectx.example.com/v1/presence -H "Authorization: Bearer AGENT_TOKEN"
```
