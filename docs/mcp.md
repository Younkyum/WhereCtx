# MCP integration

WhereCtx exposes presence to AI agents over the Model Context Protocol using the
**Streamable HTTP** transport at `POST /mcp`.

## Connecting

The `/mcp` endpoint authenticates with a Bearer token that has the
`read_presence` scope (an `agent` or `admin` token). Device tokens and session
cookies are rejected.

Create an agent token under **Agents** in the dashboard. It is shown once,
together with a Claude Desktop entry for `<BASE_URL>/mcp`. A token belongs to
the person who made it, and every tool reads and writes only that person's
presence, places, events, and reminders.

### Claude Desktop

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

### Hermes

```yaml
mcp_servers:
  wherectx:
    url: "https://wherectx.example.com/mcp"
    headers:
      Authorization: "Bearer AGENT_TOKEN"
```

## Tools

| Tool | Args | Returns |
|------|------|---------|
| `get_presence` | – | coarse status/label/motion/age/stale (no GPS). `{status:"hidden"}` in hidden mode |
| `get_precise_location` | `reason: string` | `{lat, lon, accuracyM?, mapUrl, updatedAgoSec}` or an error if denied by policy/home-protection |
| `is_near_place` | `name: string` | `{name, inside, near}` booleans (no coordinates) |
| `list_places` | – | `[{name, type}]` (admins also get coordinates) |
| `get_location_age` | – | `{updatedAgoSec, stale, updatedAt}` |
| `list_recent_presence_events` | `limit?: number` | recent events (place names omitted for agents) |
| `create_location_reminder` | `place: string, message: string` | `{id, place, message}`; the place must exist; refused in hidden mode |
| `create_place` | `name, type, lat, lon, radiusM?` | `{name, type, radiusM}`; registers/replaces a geofence |
| `remember_current_place` | `name, type?, radiusM?` | `{name, type, radiusM}`; saves the **current** location as a place (coordinates are never returned) |

All tools apply the same privacy rules as the REST API: hidden mode withholds,
precise is policy-gated, home coordinates are protected, and coarse tools never
return raw coordinates or geohash.

### Home place protection

By default (`PROTECT_HOME_PLACE=true`, toggleable live from the dashboard's
Privacy panel), `create_place` and `remember_current_place` refuse to create a
`home`-typed place — or to overwrite an existing `home` place under any type —
unless the token carries the `manage_places` scope (admin). This stops an agent
from moving the home geofence, which would mislead the home-coordinate privacy
protections. Non-home places stay writable by agent tokens.

Every tool call is recorded in the owner's access log (token name, tool,
outcome, and the reason given for `get_precise_location`). The owner sees it
in the dashboard's Agent access view; see [privacy.md](privacy.md#what-is-logged-for-how-long-and-who-sees-it).

## Agent usage policy

Recommended system-prompt snippet (also in `examples/hermes/prompt.md`):

```md
You have access to user presence through WhereCtx.

Use location only when relevant.
Prefer coarse presence over precise GPS.
Never reveal raw coordinates unless the user explicitly asks.
If location is stale, say that clearly.
When the user is moving, prefer concise replies.
When precise location is requested, provide the reason to the tool.
Do not infer sensitive behavior from location history.
```

## Notes

- The transport is stateless (one server/transport per request); no session
  cookies. Request bodies are capped at 64 KB.
- A denied precise request returns an MCP tool error with a human-readable
  reason (e.g. "exact home/near-home coordinates are protected by policy").
