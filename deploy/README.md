# Deploy WhereCtx on a Synology NAS behind Cloudflare Tunnel

This guide runs WhereCtx on a Synology NAS (Container Manager) and reaches it
from the internet through a **Cloudflare Tunnel**. No router ports are opened,
and Cloudflare provides HTTPS, which passkeys require.

```
phone, browser, AI agent ──https──► Cloudflare edge ──tunnel──► cloudflared ─► wherectx:8787
```

**Prerequisites:** a domain on Cloudflare, a Synology with Container Manager
(DSM 7.2 or later), and about 15 minutes.

---

## Step 1: Get the image built (one time, on GitHub)

The repo's GitHub Actions workflow (`.github/workflows/docker-publish.yml`)
builds a multi-arch image (amd64 and arm64) and pushes it to GitHub Container
Registry on every push to `main`.

1. Open the repo's **Actions** tab and confirm that the "Build and publish
   Docker image" run is green.
2. Make the image public so the NAS can pull it without a login:
   repo → **Packages** → `wherectx` → **Package settings** → **Change
   visibility → Public**. To keep it private instead, run `docker login
   ghcr.io` on the NAS with a PAT that has `read:packages`.

The image is `ghcr.io/younkyum/wherectx:latest`.

---

## Step 2: Create the Cloudflare Tunnel

1. In the Cloudflare dashboard, open **Zero Trust → Networks → Tunnels →
   Create a tunnel**. Choose **Cloudflared** and name it `wherectx`.
2. On the install screen, open the **Docker** tab and copy the **tunnel
   token**, the long `eyJ...` string after `--token`.
3. Add a **Public Hostname**:
   - **Subdomain:** `wherectx`, **Domain:** your domain. The public URL is
     `https://wherectx.yourdomain.com`.
   - **Service:** `HTTP`, **URL:** `wherectx:8787`. This is the compose
     service name and port. cloudflared reaches it over the internal network.
4. Save. The tunnel shows "down" until Step 3 starts cloudflared.

---

## Step 3: Run it on the NAS (Container Manager)

1. In **File Station**, create a folder such as `docker/wherectx`.
2. Put two files in it:
   - `docker-compose.yml`, copied from
     [`docker-compose.nas.yml`](docker-compose.nas.yml).
   - `.env`, copied from [`.env.nas.example`](.env.nas.example). Set
     `BASE_URL=https://wherectx.yourdomain.com` and `CF_TUNNEL_TOKEN` to the
     token from Step 2. Every other line can stay as it is. The compose file
     passes each setting in `.env` to the server.
3. In **Container Manager → Project → Create**, set **Path** to the folder.
   It finds `docker-compose.yml` and reads `.env`. Choose **Next → Done**.
4. When the `wherectx` log shows `WhereCtx listening on http://0.0.0.0:8787`,
   the server is up. The tunnel page from Step 2 turns **Healthy**.

---

## Step 4: Create the owner's passkey

1. In **Container Manager → Container → wherectx → Logs**, find the box that
   says "No passkey is registered yet" and copy the setup code.
2. Open `https://wherectx.yourdomain.com/dashboard`, choose **First-time
   setup**, enter the code and your name, and create a passkey.
3. Save the recovery codes it shows. They are shown once.

The setup code works until the first passkey exists. A restart prints a new
one. Open the dashboard at the `BASE_URL` address. A passkey made there does
not work at the NAS's LAN address.

---

## Step 5: Connect phones, agents, and people

- **Phone:** **Devices** in the dashboard. OwnTracks gets a QR code. The iOS
  Shortcut gets the URL and header. See [`../docs/clients.md`](../docs/clients.md).
- **AI agent:** **Agents** in the dashboard. It shows the token once, with a
  Claude Desktop config for `https://wherectx.yourdomain.com/mcp`. See
  [`../docs/mcp.md`](../docs/mcp.md).
- **Other people:** **Workspace → Create invite link**. Send the link. They create their
  own passkey.

To check from a shell:

```bash
curl https://wherectx.yourdomain.com/healthz             # {"status":"ok"}
curl https://wherectx.yourdomain.com/v1/presence \
	-H "Authorization: Bearer $AGENT_TOKEN"              # your status, once a phone has reported
```

---

## Optional: Cloudflare Access in front of the dashboard

Passkeys protect the dashboard, so Access is not required. If you want a
second gate in front of `/dashboard`:

1. Open **Zero Trust → Access → Applications → Add an application →
   Self-hosted**.
2. Set **Application domain** to `wherectx.yourdomain.com` and **Path** to
   `dashboard`.
3. Add an *Allow* policy for the email address of **every person you invite**.
   An invite link opens `/dashboard`, so anyone the policy leaves out cannot
   accept it.

Leave `/mcp`, `/v1/*`, and `/v1/ingest*` outside Access. Agents, phones, and
the dashboard's own API calls authenticate with WhereCtx tokens and sessions,
not an interactive login.

---

## Notes and security

- **No inbound ports.** The tunnel is outbound only, so nothing on the NAS or
  router is exposed.
- **TLS** ends at the Cloudflare edge, so tokens and cookies never cross the
  internet in clear text.
- **`TRUST_PROXY=cloudflare`** is the default here. Every request comes from
  the cloudflared container, so the rate limiters read the client from
  `cf-connecting-ip`. If you also publish the LAN port, LAN clients could set
  that header themselves.
- **Locked out:** run `node dist/cli.js reset-access <userId>` in the
  `wherectx` container (Container Manager → Container → wherectx → Terminal)
  for a one-hour access code. See the
  [README](../README.md#recover-access).
- **Updating:** stop the project, re-pull `ghcr.io/younkyum/wherectx:latest`
  in **Registry**, and start it again. Migrations run at boot. Data stays in
  the `wherectx-data` named volume.
- **Backups:** the volume holds `wherectx.db` (SQLite). Back it up with
  Container Manager or `docker cp`.
- **LAN access:** uncomment the `ports:` block in the compose file to reach
  `http://<nas-ip>:8787`. The API works there. Passkey sign-in does not,
  because it is plain http on an IP address.
- **Webhooks to Home Assistant on the LAN:** set
  `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` in `.env`. Otherwise the SSRF guard
  blocks private addresses.
- **Dashboard maps** need no maps key: they are drawn on OpenStreetMap's
  tiles by default. Those servers are run by volunteers for light use under
  the [tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
  (attribution shown on every map, a valid Referer, no heavy or offline
  use). For more than a household, set `MAP_TILE_URL` in `.env` to your own
  or a paid tile server (an https Leaflet template with `{z}`, `{x}`, `{y}`
  on one host; the CSP allows exactly that host), with its
  `MAP_TILE_ATTRIBUTION` and `MAP_TILE_ATTRIBUTION_URL`. `MAP_TILE_URL=off`
  draws no maps. A malformed value stops the server at boot. The Kakao or
  Naver keys in Maps & routes are only for drive times and addresses.
- **Rate limiting at the edge** (optional): add a Cloudflare WAF rate-limiting
  rule on the zone to throttle abusive clients before they reach the NAS.
