# Clients

Send location updates to WhereCtx from any client that can make an HTTP POST,
using a **device** token.

| Client | Endpoint | Guide |
|--------|----------|-------|
| Generic HTTP | `POST /v1/ingest` | below |
| iOS Shortcut | `POST /v1/ingest/shortcut` | [clients/ios-shortcut](../clients/ios-shortcut/) |
| OwnTracks | `POST /v1/ingest/owntracks` | [clients/owntracks](../clients/owntracks/) |
| Android Tasker | `POST /v1/ingest` | use the generic shape below |
| Home Assistant | `POST /v1/ingest` | use a REST command with the generic shape below |

## Pairing a phone

In the dashboard, open **Devices**, name the phone, pick OwnTracks or iOS
Shortcut, and choose **Create connection**. OwnTracks shows a QR code, an open
link, and a `.otrc` file to download. The iOS Shortcut shows the URL, the
header, and the steps. The dashboard asks for your passkey first when you
have not used it in the last 10 minutes.

Behind it is `POST /v1/devices/pair`. With `{ "name": "...", "kind":
"owntracks" }` it mints a device token and returns an OwnTracks config, an
`owntracks:///config?inline=` link, and the same link as a QR code. With
`"kind": "shortcut"` it returns the URL, token, and headers for the iOS
Shortcut. See [api.md](api.md#devices-pairing). The manual setup below still
works.

On an iPhone, OwnTracks 26.2.2 and later refuses configuration by link or
file until you allow it in its Settings (it asks you to confirm). Allow it,
scan again, and turn it back off once the phone reports. See
[clients/owntracks](../clients/owntracks/README.md#iphone-allow-configuration-by-link-first).
The dashboard says the same next to the QR code.

The config points the phone at `BASE_URL`, so set it to the server's public
https URL first. Pairing refuses (`400`, `code: "base_url_unusable"`) while
`BASE_URL` is a loopback address (`localhost`, `127.x`, `::1`), which a phone
cannot reach, or plain http on any other host, which would send the token in
the clear. Nothing is minted when it refuses.

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

## Receiving webhooks (n8n, Zapier, internal APIs)

Webhooks go the other way: WhereCtx calls your service when your presence
changes. If the receiving end authenticates by a request header, give the hook
an auth header in the dashboard (Webhooks, Add webhook, "Auth header") or
through `authHeader` in the API (docs/api.md, "Auth header").

The server needs `WEBHOOK_ENCRYPTION_KEY` set (the dashboard says so when it
is not), and the receiver's URL must be `https` unless
`WEBHOOK_ALLOW_PRIVATE_TARGETS=true`. The header name is `Authorization`,
`Api-Key`, `X-Api-Key`, or an `X-` name ending in `-Token`, `-Key`, `-Auth`,
`-Authorization`, `-Secret` or `-Signature`.

- **n8n**: in the Webhook node choose Authentication "Header Auth", create a
  credential with a name and value, and enter the same name and value in
  WhereCtx, for example `X-N8N-Auth` and a long random string.
- **Zapier, Make, an internal API**: a catch hook that checks
  `Authorization: Bearer <token>` takes name `Authorization` and value
  `Bearer <token>`.

The auth header proves the call is allowed; the signing secret proves the
body came from this server and was not changed. Use either or both.
