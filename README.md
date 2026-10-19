# WhereCtx

**Self-hosted real-world presence for people and their AI agents.**

WhereCtx runs on your own server and knows whether each person in your
household or team is home, away, nearby, or on the move. Agents such as
Claude, Hermes, OpenClaw, and OpenCode read it over MCP. People sign in to a
passkey dashboard and share their location with each other, like Find My.

> Agents see your presence, not your raw GPS, unless you allow it.

## What it does

- Computes a status from your phone's location and your places: `home`,
  `near_home`, `work`, `custom`, `transit`, `away`, plus motion and how fresh
  the report is (a phone at rest is quiet, not stale).
- Gives agents a coarse view over MCP and REST. Precise coordinates sit behind
  a policy gate and are refused at or near home.
- Hosts several people. Each person's data belongs to them. Workspaces group
  people, with owner, admin, and member roles and single-use invite links.
- Lets workspace members share their location with each other, as status only
  or exact. Sharing is off until you turn it on, and an audit shows who looked.
- Signs people in with passkeys. No passwords, no email.
- Connects a phone by QR code (OwnTracks) or with ready-made steps (iOS
  Shortcut), and an agent with a generated MCP config.
- Fires geofence events to signed webhooks.
- Tells agents how long it takes you to drive somewhere with live traffic,
  and which neighbourhood you are in, through Kakao or Naver with your own
  key. Off until you turn it on; your position leaves the server rounded to
  about 100 m, and never from home.

## Quick start with Docker

```bash
cp docker-compose.example.yml docker-compose.yml
mkdir -p data && sudo chown 10001 data     # the container runs as uid 10001
docker compose up -d
docker compose logs wherectx               # find the setup code
```

Open <http://localhost:8787/dashboard>, choose **First-time setup**, enter the
setup code from the log and your name, and create the owner's passkey. Save
the recovery codes it shows. They are shown once.

The migrations in `drizzle/` run at every boot. There is no separate migrate
step.

## Quick start with Node

Node 22 or later.

```bash
npm install
cp .env.example .env
npm run build:web      # builds the dashboard into dist/web
npm run dev            # server on :8787, restarts on change
```

The setup code is in the terminal output. Open
<http://localhost:8787/dashboard> and continue as above. `npm run build` and
`npm start` run the compiled server instead.

## Passkeys need HTTPS or localhost

Browsers allow passkeys only in a secure context. WhereCtx binds each passkey
to the host name in `BASE_URL`. So:

- Open the dashboard at exactly the `BASE_URL` origin.
- On one machine, `http://localhost:8787` works. `http://127.0.0.1:8787`
  does not: WebAuthn refuses any IP-address host, loopback included.
- From other devices, serve WhereCtx over https on a domain name, for example
  behind Caddy, nginx, or a Cloudflare Tunnel
  ([deploy/README.md](deploy/README.md)), and set `BASE_URL` to that https
  URL.
- `http://192.168.1.20:8787` from a phone on your LAN does not work. Plain
  http on a LAN address is not a secure context, and a passkey cannot belong
  to an IP address. The sign-in page says so when it detects it.

Boot logs a warning when `BASE_URL` cannot carry passkeys. Phone pairing also
refuses (`base_url_unusable`) until `BASE_URL` is a public https URL.

## Add people

Owners and admins open **Workspace** and create an invite link with a role.
The invitee opens the link, enters a name, and creates a passkey. Every
person gets their own presence, places, privacy settings, devices, and agent
tokens. Nobody sees anyone else's location unless that person shares it.

`ALLOW_MEMBER_WORKSPACES=false` stops plain members from creating workspaces
of their own.

## Share your location

Under **Sharing**, choose not sharing, status only, or exact location for each
person in your workspaces, and whether to hide your exact location at home. **Home** shows the people who share with you. **Share my location now**
sends this device's position once.

Sharing more needs a fresh passkey check. Sharing ends when the two of you no
longer have a workspace in common. The sharing log lists every grant, change,
revoke, and exact-location view. Agents never see any of it. See
[docs/privacy.md](docs/privacy.md#sharing-with-people).

## Connect a phone

Under **Devices**, choose OwnTracks or iOS Shortcut and create a connection.
OwnTracks gets a QR code and an open link that configure the app. The iOS
Shortcut gets the URL, header, and steps. Each connection is a `device`
token, which can write a location and read nothing.

Any HTTP client can post too:

```bash
curl -X POST https://wherectx.example.com/v1/ingest \
	-H "Authorization: Bearer $DEVICE_TOKEN" -H "Content-Type: application/json" \
	-d '{"lat":37.123,"lon":127.123,"accuracyM":21,"battery":64}'
```

See [docs/clients.md](docs/clients.md) and [clients/](clients/).

## Connect an agent

A remote MCP client that supports OAuth, such as Claude, needs only the URL
`https://wherectx.example.com/mcp`. It opens a WhereCtx consent screen where
you sign in with your passkey and choose what it may read. Revoke it later
under **Agents**, in **Connected apps**.

For a client without OAuth, create a token under **Agents**. The dashboard
shows it once, with a Claude Desktop entry ready to paste:

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

An agent token reads only the presence of the person who made it. The tools
are `get_presence`, `get_precise_location`, `is_near_place`, `list_places`,
`get_location_age`, `list_recent_presence_events`,
`create_location_reminder`, `create_place`, and `remember_current_place`. See
[docs/mcp.md](docs/mcp.md) and [examples/](examples/) for Hermes and a
recommended system prompt.

## Token roles

| Role     | Scopes | For |
|----------|--------|-----|
| `device` | `write_location` | a phone. It never reads presence. |
| `agent`  | `read_presence`, `read_precise_location` | an AI agent. Precise reads still pass the policy gate. |
| `admin`  | the agent scopes, `manage_places`, `manage_tokens`, `manage_privacy` | automation acting for one person |

A signed-in person has every scope over their own data. Tokens never reach
account, workspace, or sharing routes.

## Upgrade from v0.1

Back up `wherectx.db`, then start the new version with the same `USER_ID` and
`DATABASE_URL`. The boot migrations:

- give every row a `user_id` and assign the existing data to `USER_ID`,
- create a user for `USER_ID`, a workspace named "Default", and an owner
  membership,
- leave every existing token working, owned by `USER_ID`.

Because no passkey exists yet, boot prints a setup code. Use it in
**First-time setup** to register the owner's passkey. It attaches to
`USER_ID` and its data. The old dashboard's pasted admin token is gone, so
sign in with the passkey instead.

`ADMIN_TOKEN`, `DEVICE_TOKEN`, and `AGENT_TOKEN` are now optional. Tokens
already in the database keep working when you remove them from the
environment.

## Recover access

A person who lost every passkey can sign in with a recovery code. If they
have none left, or a user migrated from v0.1 other than `USER_ID` needs to
claim an account, run this on the server:

```bash
docker compose exec wherectx node dist/cli.js reset-access <userId>
npm run reset-access -- <userId>     # from a source checkout
```

It prints a code that is valid for one hour. The person opens the dashboard,
chooses **Use an access code**, and creates a new passkey. Their other
sessions end and they get new recovery codes. Member ids are in
`GET /v1/workspaces/:id/members`.

## Run behind a proxy

Failed sign-ins and bad tokens are rate-limited per client. By default the
client is the TCP peer. Behind a proxy, every request comes from the proxy,
so set `TRUST_PROXY`:

- `cloudflare` when every request arrives through Cloudflare. It reads
  `cf-connecting-ip`.
- `xff` behind a proxy that sets `X-Forwarded-For`. It reads the first hop.
- `none` (default) otherwise. Trusting a header that clients can reach
  directly lets them pick their own address.

Every configuration variable is in [.env.example](.env.example).

## Documentation

- [Architecture](docs/architecture.md)
- [Privacy and policy](docs/privacy.md)
- [REST API](docs/api.md)
- [MCP tools](docs/mcp.md)
- [Clients](docs/clients.md): [iOS Shortcut](clients/ios-shortcut/), [OwnTracks](clients/owntracks/)
- [Design decisions](docs/decisions.md)
- [Deploy on a Synology NAS with Cloudflare Tunnel](deploy/README.md)

## Development

```bash
npm run dev           # server with reload (tsx watch), reads .env
npm run dev:web       # dashboard with hot reload on :5173, proxies /v1 to :8787
npm run build         # tsc for the server, then the web typecheck and Vite build into dist/web
npm test              # vitest: server, dashboard, and migration tests
npm run typecheck     # server and web/
npm run db:generate   # write a migration after changing src/db/schema.ts
```

The dashboard is a React app in `web/`. The dev server on :5173 is for
layout work. Passkeys there are checked against the `BASE_URL` origin, so
sign in through the server's own address.

The review trail for each phase is in [reviews/](reviews/).

## License

MIT
