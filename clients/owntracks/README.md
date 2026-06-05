# OwnTracks → WhereCtx

[OwnTracks](https://owntracks.org) is an open-source location app for iOS and
Android. WhereCtx accepts its HTTP mode directly.

## Configure OwnTracks (HTTP mode)

In the OwnTracks app: **Settings → Connection**

- **Mode:** `HTTP`
- **Host / URL:** `https://wherectx.example.com/v1/ingest/owntracks`
- **Authentication:** the simplest path is to append the device token as a query
  parameter on the URL:
  `https://wherectx.example.com/v1/ingest/owntracks?token=DEVICE_TOKEN`
  (Use TLS so the token isn't sent in clear text. The header form
  `Authorization: Bearer DEVICE_TOKEN` also works if your OwnTracks build lets
  you set custom headers.)

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
