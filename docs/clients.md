# Clients

Send location updates to WhereCtx from any client that can make an HTTP POST,
using a **device** token.

| Client | Endpoint | Guide |
|--------|----------|-------|
| Generic HTTP | `POST /v1/ingest` | below |
| iOS Shortcut | `POST /v1/ingest/shortcut` | [clients/ios-shortcut](../clients/ios-shortcut/) |
| OwnTracks | `POST /v1/ingest/owntracks` | [clients/owntracks](../clients/owntracks/) |
| Android Tasker | `POST /v1/ingest` | use the generic shape (v0.2 template planned) |
| Home Assistant | `POST /v1/ingest` | use a REST/webhook automation (v0.2 example planned) |

## Pairing a phone

`POST /v1/devices/pair` with `{ "name": "...", "kind": "owntracks" }` mints a
device token and returns an OwnTracks config, an `owntracks:///config?inline=`
link and the same link as a QR code: scan it on the phone and OwnTracks is set
up. `"kind": "shortcut"` returns the URL, token and headers for the iOS
Shortcut. See [api.md](api.md#devices-pairing). The manual setup below still
works.

## Authentication

Prefer the header:

```
Authorization: Bearer DEVICE_TOKEN
```

For clients that can't set headers, the ingest routes (only) also accept the
token as a query parameter: `POST /v1/ingest?token=DEVICE_TOKEN`, or as the
password of HTTP Basic auth (any username). Query strings can appear in proxy
logs, so prefer a header when you can.

## Generic payload

```json
{
  "source": "ios_shortcut",
  "lat": 37.123456,
  "lon": 127.123456,
  "accuracyM": 21,
  "battery": 64,
  "timestamp": "2026-06-05T15:30:00+09:00"
}
```

Tolerated aliases: `latitude`/`longitude`/`lng`, `accuracy`/`acc`, `altitude`,
`speed`, `heading`/`course`, `batteryLevel`, `charging`, `time`. Battery may be a
0–1 fraction or 0–100 percentage. `motion` may be provided explicitly, otherwise
it's inferred from speed.

## Tips

- Send updates on a geofence transition and/or a periodic interval (e.g. every
  few minutes while moving).
- Keep `accuracyM` accurate — it helps the geofence engine.
- A reading whose `timestamp` is far in the future is distrusted; let the device
  clock be correct or omit the timestamp (the server uses receive time).
