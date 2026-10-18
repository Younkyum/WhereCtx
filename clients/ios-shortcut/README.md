# iOS Shortcut → WhereCtx

Send your location to WhereCtx from an iPhone using the built-in **Shortcuts**
app. No app to install.

## Build the shortcut

1. Open **Shortcuts** → **+** → name it "Update WhereCtx".
2. Add **Get Current Location**.
3. Add **Get Contents of URL** and configure:
   - **URL:** `https://wherectx.example.com/v1/ingest/shortcut`
   - **Method:** `POST`
   - **Headers:** tap **Add new header** twice.

     | Header name | Header value |
     |-------------|--------------|
     | `Authorization` | `Bearer DEVICE_TOKEN` |
     | `Content-Type` | `application/json` |

     The Authorization value is the word `Bearer`, one space, then the
     device token (`Bearer wctx_…`). Leaving out `Bearer ` is the most common
     reason for a `401`. The dashboard's Devices page shows the header name
     and the full value separately, and its copy button copies the value with
     the prefix.
   - **Request Body:** `JSON`
     - `latitude` → (Magic Variable) Current Location → **Latitude**
     - `longitude` → Current Location → **Longitude**
     - `accuracyM` → Current Location → **Horizontal Accuracy**
     - `altitude` → Current Location → **Altitude** (optional)
     - `battery` → **Battery Level** (optional; 0–1 is fine)

The `shortcut` endpoint tolerates Apple's field names (Latitude, Longitude,
Horizontal Accuracy, Battery Level, …), so you don't need exact key names.

## Automate it

Use the **Automation** tab to run the shortcut:

- **When I arrive / leave** a location (geofence trigger), and/or
- on a **time-of-day** schedule, and/or
- via a **personal automation** triggered by CarPlay/charging.

> iOS may prompt before running automations. For unattended updates, enable
> "Run Immediately" / disable "Ask Before Running" where iOS allows.

## Test from a Mac/terminal

```bash
curl -X POST https://wherectx.example.com/v1/ingest/shortcut \
  -H "Authorization: Bearer DEVICE_TOKEN" -H "Content-Type: application/json" \
  -d '{"Latitude":37.123,"Longitude":127.123,"Horizontal Accuracy":15,"Battery Level":0.8}'
# -> {"ok":true,"status":"home"}
```

See [shortcut-template.json](shortcut-template.json) for the request body shape.
