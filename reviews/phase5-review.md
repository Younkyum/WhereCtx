# WhereCtx — Phase 5 (Dashboard, Docker, Docs, Examples) + Final v0.1 Sanity Review

**Reviewer:** Independent staff-engineer + security reviewer
**Scope:** `src/dashboard/page.ts`, `src/dashboard/router.ts`, mounting in `src/app/server.ts`; `Dockerfile`, `.dockerignore`, `docker-compose.example.yml`, `examples/docker/docker-compose.yml`; `README.md`, `docs/architecture.md`, `docs/privacy.md`, `docs/api.md`, `docs/mcp.md`, `docs/clients.md`; `clients/ios-shortcut/*`, `clients/owntracks/README.md`; `examples/hermes/*`, `examples/claude-desktop/config.json`; `LICENSE`, `package.json`. Cross-referenced `db/url.ts`, `config.ts`, `.env.example`, `api/middleware.ts`, `api/presence.ts`, `api/events.ts`, `api/webhooks.ts`, `api/tokens.ts`, `privacy/policy.ts`, `index.ts`, `app/context.ts`.
**Verified state accepted as given:** typecheck clean; 125/125 tests; `dist` build boots and serves `/healthz` (200) + `/dashboard` (200); live e2e (MCP 7 tools, coarse presence, home-precise denied, 2 HMAC-signed webhooks). Docker image NOT built in this env.

---

## Summary

Phase 5 is solid and, on the single point the brief was most worried about — **the dashboard XSS → admin-token-theft chain — the code is not vulnerable**. I traced every `innerHTML` sink in `page.ts`; every server-controlled value (status, label, motion, place name/type/lat/lon/radius, token name/role/id, webhook url/events/id, event type/placeName/createdAt, dead-letter type/error, new-token secret, and the error-message path) is wrapped in `esc()`, and `esc()` escapes `& < > "`. The only attribute-context sinks use **double-quoted** attributes (`data-del="…"`, `data-tok`, `data-wh`), and since `"` is escaped a malicious ingested place/source/error string cannot break out of the attribute or open a tag. The unescaped interpolations are all developer-controlled (`p.stale?'warn':'ok'`, `w.active?'yes':'no'`, the `cls` literal, and `ago()` which only ever receives the numeric `updatedAgoSec`). So there is no stored-XSS path to `localStorage` token theft. Good.

The remaining issues are the *expected* v0.1 trade-offs and a few hardening gaps:

- **No `USER` in the Dockerfile — the container runs as root.** Flagged, but acceptable to ship for a single-user self-host (it's the standard posture for this class of tool); should be hardened before any wider distribution.
- **No CSP / `X-Content-Type-Options` / `X-Frame-Options` on the dashboard (or anywhere).** With `esc()` doing the real work this is defense-in-depth, not a live hole, but a CSP would have made the XSS verdict unconditional and costs one header.
- **Dashboard auth model** (unauthenticated HTML, admin token in `localStorage`, same-origin no-CORS calls) is **acceptable for v0.1** as documented — the page ships no data and every data path is behind the same token auth as the API.
- **Docs are accurate.** Endpoints, scopes (`manage_privacy` for webhooks, `manage_tokens` for tokens, `read_presence` for events/presence with `placeName` stripped for agents), status codes (400/403/404/413), env vars, tool names/signatures, and the `mapUrl` shape all match the implementation. The `sqlite:////data/wherectx.db` (4-slash) compose form is correctly normalized to the absolute `file:/data/wherectx.db` the Dockerfile defaults to. Curl examples work.

No CRITICAL, no HIGH. The MUST-FIX-BEFORE-SHIP list is **empty**. Findings are MEDIUM and below; the standing deferred items (P16 rate limiting, P12 logger redaction) remain open and are acceptable to ship in v0.1 behind the documented reverse-proxy posture.

---

## Findings

### DASHBOARD — security

**D1 — POSITIVE (no finding) — `dashboard/page.ts:140` `esc()` + all `innerHTML` sinks — stored XSS → token theft is NOT reachable.**
`esc()` escapes `& < > "`. Every server-derived value entering an `innerHTML` string is wrapped in `esc()`: presence `status/label/motion/privacy` (147–152), error `e.message` (153), place `name/type/lat/lon/radius` (165) and the `data-del` attribute (166), event `type/placeName/createdAt` (172), token `name/role/lastUsedAt/id` (177–178), webhook `url/events/id` (185–186), dead-letter `eventType/error/createdAt` (190), and the once-shown token `secret` (200). Attribute sinks (`data-del`, `data-tok`, `data-wh`) are double-quoted and `"` is escaped, so an ingested `source`/place name/error string cannot break out. The `data-del` value is re-read via `dataset` and passed through `encodeURIComponent`, so there is no second-order injection on delete. **No fix required.** Two defensive notes follow (D2, D3).

**D2 — LOW — `dashboard/page.ts:140` — `esc()` does not escape the single quote `'`.** Currently safe because every attribute in the page is double-quoted. It is a latent footgun: a future edit that switches any `data-*` attribute to single quotes (or builds a `style='…'`/`href='…'` from server data) would become injectable. **Fix:** add `'` → `&#39;` to the `esc()` replacement map so the helper is safe in either quoting style; cheap insurance.

**D3 — MEDIUM — `app/server.ts` / `dashboard/router.ts` — no Content-Security-Policy, `X-Content-Type-Options`, or `X-Frame-Options` header on the dashboard (none anywhere).** `esc()` is the sole XSS defense; a CSP (`default-src 'self'; script-src 'unsafe-inline'` is unavoidable here because the JS is inline, but a `default-src 'self'` still blocks exfiltration to attacker origins and external script loads) would turn the XSS verdict from "not vulnerable by code audit" into "not vulnerable by policy," and `X-Frame-Options: DENY` / `frame-ancestors 'none'` would stop clickjacking of the admin page. The token in `localStorage` is also readable by any script that *does* execute, so CSP is the meaningful second layer. **Fix:** set `Content-Security-Policy: default-src 'self'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`, plus `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`, on the dashboard route (Hono `secureHeaders` middleware, or set them in `dashboardRouter`). MEDIUM as defense-in-depth on the highest-value (admin-token-bearing) surface; not blocking because no injection sink is currently reachable.

**D4 — LOW — dashboard auth model (unauthenticated page, admin token in `localStorage`, same-origin fetch).** Acceptable and correctly documented (`page.ts:1-9`): the HTML carries no data, and every `/v1/*` call requires the admin token, so serving the shell unauthenticated leaks nothing. `localStorage` (vs an `HttpOnly` cookie) is the pragmatic v0.1 choice and is XSS-readable — which is exactly why D3 (CSP) matters. No CORS headers are set, so the API is same-origin-only; that is the correct posture (the dashboard is same-origin with the API). **Fix:** none for v0.1; note in docs that the admin token lives in browser storage and that the dashboard should only be reached over the TLS reverse proxy. Consider an `HttpOnly` session cookie + CSRF token in v0.2.

**D5 — LOW — `dashboard/page.ts:141` `ago()` — `s+'s'` string-coerces its argument with no escaping.** Reachable only if the server ever sends `updatedAgoSec` as a string; the type is `number` (`types.ts:166,177`) and `policy.ts` computes it numerically, so it is not attacker-controllable today. **Fix:** wrap as `esc(ago(...))` or coerce `Number(s)` for robustness against a future API change. LOW (currently unreachable).

**D6 — LOW — `dashboard/page.ts:201` — the dashboard hardcodes `events:['*']` on webhook create and offers no event-type selection or per-webhook activate/deactivate.** Plan §9.9 only requires create/list/delete of webhooks (it doesn't even require webhooks in the dashboard), so this is in-scope-minimal, but the table shows an `Active` column the UI can't toggle. **Fix:** none required for v0.1; note the gap (no event filtering / no toggle from the dashboard) so it isn't mistaken for a bug.

### DOCKER

**D7 — MEDIUM — `Dockerfile` — the container runs as root (no `USER` directive).** The runtime stage never creates or switches to a non-root user, so `node dist/index.js` runs as uid 0 and writes `/data` as root. For a single-user self-host behind a proxy this is the common posture and is acceptable to ship, but it violates least-privilege: a process compromise (e.g. via a dependency RCE) is immediately root-in-container, and the bind-mounted `./data` is written root-owned on the host. **Fix:** add a non-root user and `chown` the volume mountpoint, e.g. `RUN useradd -u 10001 -r -s /usr/sbin/nologin wherectx && mkdir -p /data && chown wherectx /data` then `USER wherectx`. Caveat: with a bind mount (`./data:/data`) the host directory's uid wins, so document that operators must `chown 10001 ./data` (or use a named volume) — which is exactly why this was likely deferred. Recommend hardening before publishing the image to `ghcr.io`, but not a v0.1 ship-blocker.

**D8 — LOW — `Dockerfile:22` `VOLUME ["/data"]` + root — no explicit `mkdir`/permissions for `/data`.** Today it works because root can create the DB file anywhere. The moment D7's non-root user lands, `/data` needs to exist and be owned by that user before the volume mounts, or libsql's first write fails. **Fix:** tie to D7 (`mkdir -p /data && chown`). Standalone-LOW.

**D9 — LOW — `.dockerignore` correctly KEEPS `drizzle/` (migrations) — verified, no finding — but excludes `docs`, `clients`, `examples`, `*.md`, `reviews`, `scripts`.** This is correct: `drizzle/` is *not* in the ignore list, so the `COPY drizzle ./drizzle` in the runtime stage succeeds and migrations apply at boot (`app/context.ts` → `ensureSchema` → `migrate`). Excluding docs/clients/examples from the image is the right call (smaller image; they're repo artifacts, not runtime deps). **No fix.** Flag only so the "must NOT exclude drizzle" requirement is recorded as met.

**D10 — LOW — `node:24-slim` base while `package.json` declares `engines.node >=20`.** `node:24-slim` is Debian-bookworm glibc, so `@libsql/client` prebuilds load fine (the stated rationale in the Dockerfile comment is correct). Minor: the image pins to Node 24 while the project supports 20+, so the tested-in-CI runtime and the shipped-image runtime can differ. **Fix:** none required; optionally pin to an LTS (`node:22-slim`) to match the `>=20` support floor, or document that the image targets Node 24. LOW.

### DOCKER COMPOSE / DOCS consistency

**D11 — LOW — `docker-compose.example.yml:23-25` / `examples/docker/docker-compose.yml:17-19` ship `change-me-*` tokens and rely on boot-time refusal.** This is intentional and documented (the comment explains placeholders are refused at boot and a strong admin token is auto-generated + printed once). It is a reasonable UX, but it means the literal "5-minute quick start" path (`cp … && docker compose up -d`) boots with **no operator-set tokens** and the operator must read the logs to recover the generated admin token. **Fix:** none required; the README already documents `docker compose logs wherectx`. Worth a one-line callout in the compose comment that the admin token must be retrieved from logs on first boot.

**D12 — LOW — host inconsistency between compose `BASE_URL: http://localhost:8787` and client/example docs using `https://wherectx.example.com`.** Internally consistent within each file (compose is a local quick-start; client docs show the public-proxy form), but a reader copying across the two sees mismatched hosts. `mapUrl` is built from `lat,lon` only (`policy.ts:84`, `https://maps.google.com/?q=…`), so `BASE_URL` does not actually affect map links in v0.1 despite the `.env.example` comment implying it does. **Fix:** none required; optionally note that `BASE_URL` is currently advisory (map links use a fixed Google Maps URL) so the comment doesn't over-promise.

**D13 — NIT — `clients/owntracks/README.md:41` curl uses `tst:1796515800` (2026-12-06), ~6 months ahead of the docs' "today" (2026-06-06).** The server clamps >5-min-future device timestamps to receive time (documented in `privacy.md`/`clients.md`), so the example still works (presence records, clamped), but a future-dated example timestamp is confusing next to a doc that warns about future timestamps. **Fix:** use a present/near-past unix time in the example.

### DOCS accuracy — verified correct (no findings)

- **Scopes** match code: webhooks list/create/delete = `manage_privacy` (`api/webhooks.ts:41`), tokens = `manage_tokens` (`api/tokens.ts:23`), events/presence = `read_presence` with `placeName` stripped for non-admins (`api/events.ts:19,40`) — exactly as `api.md` and `privacy.md` state.
- **Status codes** match: precise returns 400 (reason too long), 403 (hidden / denied), 404 (no reading / no precise), and the global 413 (body > 64 KB) and 401 (no/invalid token) (`api/presence.ts:34-68`, `app/server.ts:25-29`).
- **Tool names/signatures** in `mcp.md` match the 7 implemented tools, including the `create_location_reminder` caveats (place must exist; refused in hidden mode) added in the Phase 4 resolution.
- **DATABASE_URL** doc/compose forms (`sqlite:////data/wherectx.db`, `file:./data/wherectx.db`) normalize exactly as `db/url.ts` documents and as the Dockerfile default (`file:/data/wherectx.db`) expects.
- **`?token=` query auth** is real and correctly scoped to ingest routes only (`api/middleware.ts:32,39`), matching `clients.md`/`docs` warnings about proxy-log leakage.
- **Token-hash / bootstrap-refusal** claims in `privacy.md` match the Phase 2 behavior recorded in `decisions.md`.
- **README curl examples** (ingest with device token, places with admin token, MCP config) are accurate and would work against a running instance.
- **LICENSE** (MIT) matches `package.json` `"license":"MIT"`. **`package.json`** metadata, `engines`, scripts (`db:migrate`, `build`, `test`) are coherent.

### STANDING DEFERRED ITEMS (still open at ship)

- **P16 — rate limiting (`/mcp` + ingest) — OPEN. Acceptable to ship v0.1.** No throttle on any route. Mitigated by: all sensitive routes are token-gated, the documented posture is a TLS reverse proxy (which can rate-limit), and the 64 KB body cap bounds per-request cost. Should be closed before an internet-exposed GA / published image. Not a v0.1 blocker.
- **P12 — structured logger + secret redaction — OPEN. Acceptable to ship v0.1.** Logging is raw `console.*`. Verified the webhook `secret` and token plaintext are never logged; error objects *could* carry URL fragments. Low real exposure for a self-host. Close before GA.
- **Dashboard auth model — OPEN by design. Acceptable (D4).**
- **Non-root container (D7) — OPEN. Acceptable for v0.1 self-host; harden before publishing the image.**
- **L1 (attempts-map pruning), L9 (await in-flight tick on shutdown), L3 (`is_near_place` place-identity disclosure), P14 (drop read-triggered stale write) — OPEN, all LOW, all acceptable to ship** per the Phase 4 resolution's tracked-deferral list.

### TEST ADEQUACY (Phase 5)

**T1 — MEDIUM — the dashboard has no automated test.** `page.ts` is a string of inline HTML/JS with no unit/integration/e2e coverage; correctness of `esc()` and the `innerHTML` sinks rests on this manual audit and the live smoke. For a static, no-build, single-file admin page this is **acceptable to ship v0.1** (the security-relevant logic is one 1-line `esc()` and the API it calls is well-tested), but it is the weakest test area. **Fix (non-blocking):** add (a) a unit test for `esc()` asserting `& < > " '` are all escaped (this also forces the D2 fix), and (b) a tiny route test asserting `GET /dashboard` returns 200 `text/html` containing the expected element ids. A jsdom render test feeding a malicious place name and asserting no script node is created would lock the XSS verdict permanently. None of these block v0.1.

---

## MUST FIX BEFORE SHIP

*(blocking only)*

**None.** No CRITICAL or HIGH findings. The dashboard is not XSS-vulnerable, the Docker build is correct (migrations included, DB URL normalized, healthcheck present), and the docs accurately describe the implemented behavior. The MEDIUM findings (D3 CSP/security-headers, D7 non-root container, T1 dashboard test) are recommended hardening but are acceptable to ship in a documented single-user, reverse-proxy v0.1; they should be addressed before publishing a public image or any internet-exposed GA.

---

## v0.1 Success-Criteria Scorecard (plan §20)

| # | Criterion | Verdict | Evidence |
|---|-----------|---------|----------|
| 1 | Run with Docker Compose in < 5 min | **MET** | `Dockerfile` (multi-stage, prod-only deps, migrations copied, healthcheck) + `docker-compose.example.yml`; `cp … && docker compose up -d`. Caveat D11: admin token must be read from logs on first boot. |
| 2 | Send location from iOS Shortcut or OwnTracks | **MET** | `/v1/ingest/shortcut` + `/v1/ingest/owntracks` implemented; `clients/ios-shortcut/*` and `clients/owntracks/README.md` give working setups + curl. |
| 3 | Hermes / Claude Desktop connect via MCP | **MET** | Streamable-HTTP `/mcp` (Phase 4, device-token-rejected); `examples/hermes/config.yaml`, `examples/claude-desktop/config.json`, `docs/mcp.md`. |
| 4 | `get_presence()` returns current presence | **MET** | MCP tool + `GET /v1/presence` return the coarse view; verified in live e2e and tests. |
| 5 | `get_precise_location(reason)` returns precise only when policy allows | **MET** | `authorizePrecise` layered gate; home-precise denied in live e2e; `api/presence.ts:65` + `privacy/policy.ts`. |
| 6 | Home geofence enter/leave detection | **MET** | Haversine geofence engine emits `entered_place`/`left_place`; covered by Phase 3/4 tests. |
| 7 | Dashboard shows current presence + last update time | **MET** | `page.ts` "Current presence" card (status pill, `updated …s ago`, stale/fresh, agent access); `/dashboard` serves 200. |
| 8 | Default privacy mode does not expose raw GPS to agents | **MET** | `DEFAULT_AGENT_PRIVACY=coarse`, `ALLOW_PRECISE_TO_AGENT=false`, `HIDE_HOME_EXACT_COORDINATES=true` defaults; coarse view carries no lat/lon/geohash (`privacy/policy.ts`, `decisions.md`). |

**Scorecard: 8/8 MET.** (Repo structure §13: matches the plan's intent with one deliberate, documented difference — the server lives at `src/` rather than `apps/server/src/`, a single-package layout chosen in Phase 1; all named modules — `ingest/`→`api/ingest.ts`+`normalizer/`, `privacy/`, `geofence/`, `store/`, `mcp/tools`, `api/`, `webhooks/`, `dashboard/` — and the `clients/`, `examples/`, `docs/` trees are present.)

---

## Verdict

**Ship.** v0.1 meets all 8 success criteria, the dashboard is not XSS-vulnerable (every `innerHTML` sink is `esc()`-wrapped and attribute sinks are double-quoted), the Docker build is correct (migrations included, URL normalized, healthcheck present), and the docs are accurate; the only recommended pre-publish hardening is a dashboard CSP + security headers (D3), a non-root container (D7), and an `esc()` single-quote fix plus a one-line dashboard test (D2/T1) — none blocking for a documented single-user, reverse-proxy self-host.

---

## Resolution (applied post-review)

MUST-FIX was empty (ship-ready). The recommended hardening was applied anyway; 128/128 tests pass, typecheck clean, live-verified.

- **D3 (MEDIUM) — CSP + security headers.** `hono/secureHeaders` mounted globally with a strict CSP (`default-src 'self'`, inline JS/CSS allowed for the dashboard, `frame-ancestors 'none'`, `base-uri 'none'`), plus `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. Live-verified on `/dashboard`; REST unaffected.
- **D7 (MEDIUM) — non-root container.** Dockerfile now creates uid 10001 `wherectx`, `chown`s `/data` + `/app`, and `USER wherectx`. Compose comment documents the `chown 10001 ./data` step for bind mounts.
- **D2 (LOW) — `esc()` now escapes `'`** (`&#39;`) so it's safe in either quote style.
- **D5 (LOW) — `esc(ago(...))`** wraps the age string for robustness.
- **D13 (NIT) — OwnTracks example** uses a near-past `tst`.
- **T1 (MEDIUM) — dashboard tests added**: 200 + `text/html` + expected element ids; CSP/X-Frame/nosniff headers present; `esc()` map asserted to escape `&<>"'` (locks the XSS defense).

Still deferred to GA (documented, non-blocking for single-user reverse-proxy v0.1): P16 rate limiting, P12 structured-logger redaction, dashboard `HttpOnly`-cookie auth (v0.2), and the LOW items L1/L9/L3/P14.
