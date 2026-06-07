# Deploy WhereCtx on Synology NAS behind Cloudflare Tunnel

This guide runs WhereCtx on a Synology NAS (Container Manager) and exposes it to
the internet through a **Cloudflare Tunnel** — no router ports opened, automatic
HTTPS — with the admin dashboard protected by **Cloudflare Access**.

```
phone / AI agent  ──https──►  Cloudflare edge  ──tunnel──►  cloudflared ─► wherectx:8787
                                   │
                              Access (login) gates  /dashboard only
```

**Prerequisites:** a domain on Cloudflare, a Synology with Container Manager
(DSM 7.2+), and ~15 minutes.

---

## Step 1 — Get the image building (one-time, on GitHub)

The repo includes a GitHub Actions workflow
(`.github/workflows/docker-publish.yml`) that builds a multi-arch image
(amd64 + arm64) and pushes it to GitHub Container Registry on every push to
`main`.

1. Push the repo (already done). Open the repo's **Actions** tab and confirm the
   "Build and publish Docker image" run is green.
2. Make the image public so the NAS can pull it without a login:
   repo → **Packages** → `wherectx` → **Package settings** → **Change visibility
   → Public**.
   (Alternatively keep it private and `docker login ghcr.io` on the NAS with a
   PAT that has `read:packages`.)

The image is now at `ghcr.io/younkyum/wherectx:latest`.

> No NAS-side build needed. To update later: re-pull the image and recreate the
> container in Container Manager.

---

## Step 2 — Create the Cloudflare Tunnel

1. Go to **Cloudflare dashboard → Zero Trust → Networks → Tunnels → Create a
   tunnel**. Choose **Cloudflared**. Name it `wherectx`.
2. On the install screen, pick the **Docker** tab and copy the **tunnel token**
   (the long `eyJ...` string after `--token`). You only need the token.
3. Add a **Public Hostname**:
   - **Subdomain:** `wherectx` · **Domain:** your domain → public URL becomes
     `https://wherectx.yourdomain.com`
   - **Service:** `HTTP` · **URL:** `wherectx:8787`
     (this is the Docker service name + port — cloudflared reaches it over the
     internal compose network)
4. Save. (The tunnel will show "down" until Step 4 starts cloudflared.)

---

## Step 3 — Protect the dashboard with Cloudflare Access

So `/dashboard` requires *your* login, while the API and MCP stay token-only.

1. **Zero Trust → Access → Applications → Add an application → Self-hosted.**
2. **Application domain:** `wherectx.yourdomain.com` · **Path:** `dashboard`
   (add a second one for `dashboard/*` if your Access version needs the wildcard
   separately).
3. **Policy:** Action *Allow*, rule *Emails* → your email. Save.
4. Leave MCP (`/mcp`) and ingest (`/v1/ingest*`) **outside** Access — agents and
   your phone authenticate with WhereCtx tokens, not an interactive login.

> Optional hardening: **Zero Trust → ... → WAF / Rate limiting** on the zone to
> throttle abusive clients. This covers the rate-limit gap noted in the docs.

---

## Step 4 — Run it on the NAS (Container Manager)

1. In **File Station**, create a folder, e.g. `docker/wherectx`.
2. Put two files in it:
   - `docker-compose.yml` ← copy from
     [`deploy/docker-compose.nas.yml`](docker-compose.nas.yml)
   - `.env` ← copy from [`.env.nas.example`](.env.nas.example) and fill in:
     - `BASE_URL=https://wherectx.yourdomain.com`
     - strong `ADMIN_TOKEN` / `DEVICE_TOKEN` / `AGENT_TOKEN`
       (e.g. run `openssl rand -base64 24 | tr -d '/+='` three times)
     - `CF_TUNNEL_TOKEN=` the token from Step 2
3. **Container Manager → Project → Create:**
   - **Path:** the `docker/wherectx` folder
   - It detects `docker-compose.yml` → **Next → Done**. Container Manager reads
     the `.env` automatically.
4. Watch the build/up logs. When `wherectx` logs
   `WhereCtx listening on http://0.0.0.0:8787`, it's up. The Cloudflare tunnel
   page (Step 2) should flip to **Healthy**.

> **First-boot token note:** if you left any token as `change-me-*`, WhereCtx
> refuses it and generates a strong admin token printed **once** in the
> `wherectx` container log — grab it from Container Manager → Container →
> wherectx → **Logs**. (If you set real tokens in `.env`, ignore this.)

---

## Step 5 — Verify

```bash
# Health (public)
curl https://wherectx.yourdomain.com/healthz          # {"status":"ok"}

# Dashboard → opens the Cloudflare Access login first, then the WhereCtx page
open https://wherectx.yourdomain.com/dashboard

# Register home + send a test location (admin/device tokens)
curl -X POST https://wherectx.yourdomain.com/v1/places \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"home","lat":37.5665,"lon":126.9780,"radiusM":150,"type":"home"}'

curl -X POST https://wherectx.yourdomain.com/v1/ingest \
  -H "Authorization: Bearer $DEVICE_TOKEN" -H "Content-Type: application/json" \
  -d '{"lat":37.5665,"lon":126.9780,"battery":72}'

curl https://wherectx.yourdomain.com/v1/presence \
  -H "Authorization: Bearer $AGENT_TOKEN"            # {"status":"home",...}
```

## Step 6 — Connect clients

- **Phone (iOS Shortcut / OwnTracks):** point them at
  `https://wherectx.yourdomain.com/v1/ingest/shortcut` (or `/owntracks`) with the
  **device** token. See [`../clients/`](../clients/).
- **AI agent (Claude Desktop / Hermes):** MCP URL
  `https://wherectx.yourdomain.com/mcp` with the **agent** token. See
  [`../docs/mcp.md`](../docs/mcp.md).

---

## Notes & security

- **No inbound ports** are opened on the NAS or router — the tunnel is
  outbound-only. This is the biggest security win over port-forwarding.
- **TLS is automatic** at the Cloudflare edge, so tokens are never sent in clear
  text.
- The dashboard's admin token lives in your browser's `localStorage`; Cloudflare
  Access in front of `/dashboard` is the meaningful second layer.
- **Updating WhereCtx:** in Container Manager, stop the project → in the Registry
  re-pull `ghcr.io/younkyum/wherectx:latest` → recreate. Data persists in the
  `wherectx-data` named volume.
- **Backups:** the volume holds `wherectx.db` (SQLite). Back it up via Container
  Manager or `docker cp` if you want history of places/tokens/settings.
- **LAN-only access too:** uncomment the `ports:` block in the compose to also
  reach `http://<nas-ip>:8787` from your local network.
- **Webhooks to Home Assistant on the LAN:** set
  `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` (otherwise private-IP targets are blocked
  by the SSRF guard).
