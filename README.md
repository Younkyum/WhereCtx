# WhereCtx

**Self-hosted real-world presence context for AI agents.**

WhereCtx lets Hermes, Claude, OpenClaw, OpenCode, and other MCP-compatible agents
understand whether you're home, away, commuting, nearby, or exactly where you
are — privately, on your own server.

> Agents see your presence, not your raw GPS — unless you explicitly allow it.

## Why?

AI agents know your files, calendar, terminal, browser, and memory. But they
usually don't know your real-world context. WhereCtx adds a privacy-first
presence layer:

- home / away / near home / work / transit
- walking / driving / stationary (motion)
- stale-location detection
- optional precise GPS, policy-gated
- geofence enter/leave events + webhooks
- MCP tools for agents
- iOS Shortcut, OwnTracks, and generic HTTP ingest

WhereCtx is **not** a location-tracking app. It is infrastructure for giving
personal AI agents safe, user-controlled awareness of real-world context.

## Quick start (Docker)

```bash
cp .env.example .env            # set strong ADMIN/DEVICE/AGENT tokens
cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

Open the dashboard at <http://localhost:8787/dashboard> and paste your admin
token. (If you left the tokens as `change-me-*`, a strong admin token is
auto-generated and printed once in the logs: `docker compose logs wherectx`.)

## Quick start (local / Node ≥ 20)

```bash
npm install
cp .env.example .env
npm run db:migrate     # apply the SQLite schema
npm run dev            # or: npm run build && npm start
```

## Send your location

From a phone, post location updates with the **device** token:

```bash
curl -X POST http://localhost:8787/v1/ingest \
  -H "Authorization: Bearer $DEVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source":"ios_shortcut","lat":37.123,"lon":127.123,"accuracyM":21,"battery":64}'
```

See [clients/](clients/) for iOS Shortcut and OwnTracks setup.

## Register a home geofence

```bash
curl -X POST http://localhost:8787/v1/places \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"home","lat":37.123,"lon":127.123,"radiusM":150,"type":"home"}'
```

## Connect an agent (MCP)

```jsonc
// Claude Desktop
{
  "mcpServers": {
    "wherectx": {
      "url": "http://localhost:8787/mcp",
      "headers": { "Authorization": "Bearer AGENT_TOKEN" }
    }
  }
}
```

Your agent can now call:

- `get_presence()` — coarse status (no raw GPS)
- `is_near_place("home")`
- `get_precise_location(reason)` — only when policy allows
- `get_location_age()`, `list_places()`, `list_recent_presence_events()`
- `create_location_reminder(place, message)`

See [examples/](examples/) for Hermes and Claude Desktop configs and a
recommended agent system prompt.

## Token roles

| Role     | Can…                                                            |
|----------|-----------------------------------------------------------------|
| `device` | write location (`write_location`) — **never reads** presence     |
| `agent`  | read coarse presence, read precise (if policy allows)            |
| `admin`  | manage places, tokens, privacy, webhooks                         |

## Privacy model

- **Presence by default, precise location when needed.** Agents get a coarse
  summary (status/label/motion/age) with no raw coordinates or geohash.
- **`hidden` mode** withholds presence entirely from agents.
- **Home protection**: precise location is *denied* (not blurred) while you're at
  or near a `home` place, unless you disable `HIDE_HOME_EXACT_COORDINATES`.
- **Stale detection**: device timestamps far in the future are distrusted so
  presence can't be spoofed "fresh".
- **Webhook SSRF guard**: delivery to private/reserved IPs is blocked by default.

Full details in [docs/privacy.md](docs/privacy.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Privacy & policy](docs/privacy.md)
- [REST API](docs/api.md)
- [MCP tools](docs/mcp.md)
- [Clients](docs/clients.md) · [iOS Shortcut](clients/ios-shortcut/) · [OwnTracks](clients/owntracks/)
- [Design decisions](docs/decisions.md)

## Tech stack

TypeScript · [Hono](https://hono.dev) · SQLite (libsql) · [Drizzle ORM](https://orm.drizzle.team) ·
[`@modelcontextprotocol/sdk`](https://modelcontextprotocol.io) · Docker.

## Development

```bash
npm run typecheck     # tsc --noEmit
npm test              # vitest (unit + integration)
npm run db:generate   # regenerate migrations after a schema change
```

The codebase ships with an independent multi-pass code-review trail under
[`reviews/`](reviews/).

## License

MIT
