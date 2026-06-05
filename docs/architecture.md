# Architecture

WhereCtx is a single self-hosted server. Internally it is modular; deployment is
one container.

```
iOS Shortcut / OwnTracks / generic HTTP client
        │  POST /v1/ingest*
        ▼
   Ingest API ──► Normalizer ──► PresenceService
                                    │
            ┌───────────────────────┼───────────────────────┐
            ▼                       ▼                       ▼
      Geofence engine        Privacy/policy           Presence store
      (status, near)         (what agents see)        (SQLite/Drizzle)
                                    │
                                    ▼
        ┌──────────────┬───────────────────────┬──────────────┐
        ▼              ▼                       ▼              ▼
   MCP server      REST API              Webhook dispatcher  Dashboard
   (/mcp)          (/v1/*)               (HMAC, cursor)      (/dashboard)
        │
        ▼
  Hermes / Claude Desktop / OpenClaw / other agents
```

## Request flow (ingest)

1. **Ingest** (`src/api/ingest.ts`) authenticates a `device` token and reads the
   raw body.
2. **Normalizer** (`src/normalizer/*`) converts source-specific payloads
   (generic / iOS Shortcut / OwnTracks) into a single `NormalizedReading`.
3. **PresenceService** (`src/presence/service.ts`), serialized per user:
   - **Geofence engine** (`src/geofence/*`) computes `status` (home / near_home /
     work / near_work / custom / transit / away / unknown) from registered
     places using haversine distance.
   - Persists the new presence and diffs it against the previous state to emit
     events (`presence.updated`, `entered_place`, `left_place`,
     `privacy_changed`); a periodic sweep emits `became_stale`.
   - Optionally records raw history (off by default) and fires matching
     location reminders.
4. Emitted events are persisted, then the **webhook dispatcher** delivers them
   (cursor-based, at-least-once, HMAC-signed).

## Read flow (agents)

- **REST** (`/v1/presence`, `/v1/presence/precise`, …) and **MCP** (`/mcp`) both
  run reads through the same **privacy engine** (`src/privacy/policy.ts`):
  - `agentCoarseView` — status/label/motion/age/stale only; no GPS, no geohash.
  - `authorizePrecise` — layered deny gate (hidden → scope → policy → approval →
    reason → home-protection).

## Components

| Module | Responsibility |
|--------|----------------|
| `config.ts` | Typed env config + DATABASE_URL normalization (`db/url.ts`) |
| `db/` | Drizzle schema, libsql connection, migrations (`drizzle/`) |
| `auth/` | Token hashing, verification, bootstrap seeding, scopes |
| `normalizer/` | Source adapters → `NormalizedReading` |
| `geofence/` | Haversine distance, geohash, status computation |
| `privacy/` | Persisted settings + policy decisions/view builders |
| `store/` | Repositories (presence, places, events, history, reminders, webhooks) |
| `presence/` | The core domain service (orchestration) |
| `api/` | Hono REST routers + auth middleware |
| `mcp/` | MCP server (7 tools) + raw-Node `/mcp` handler |
| `webhooks/` | Dispatcher + SSRF guard |
| `dashboard/` | Static admin page |
| `app/` | DI container + HTTP app assembly |

## Composition (`src/index.ts`)

A single Node `http.Server` routes `pathname === "/mcp"` to the raw MCP handler
(the MCP transport writes directly to the Node response) and everything else to
the Hono app via `getRequestListener`. The webhook dispatcher and the periodic
stale sweep are started here and stopped on graceful shutdown.

## Storage

SQLite via libsql (prebuilt binaries → no native compile during install).
Migrations in `drizzle/` are the single source of truth and are applied at boot.
The default DB lives at `/data/wherectx.db` (a mounted volume in Docker).
