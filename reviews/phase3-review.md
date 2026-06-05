# WhereCtx — Phase 3 (Ingest + REST API) Review

**Reviewer:** Independent staff-engineer + API security critic
**Scope:** `app/context.ts`, `app/server.ts`, `index.ts`; `api/types.ts`, `api/middleware.ts`, `api/ingest.ts`, `api/presence.ts`, `api/places.ts`, `api/events.ts`, `api/privacy.ts`, `api/webhooks.ts`, `api/tokens.ts`, `api/api.test.ts`. Cross-referenced `privacy/policy.ts`, `auth/{scopes,tokens}.ts`, `presence/service.ts`, the stores, and `types.ts`.
**Verified state accepted as given:** typecheck clean; 81/81 vitest pass; live smoke test (healthz, place create, device ingest→home, agent coarse with no coords, agent precise-at-home→403); dist build boots.

---

## Summary

Phase 3 is a clean, well-layered REST surface. The DI container (`AppContext`) is wired once and threaded explicitly into every router (no globals), the privacy holes flagged in Phase 2 were genuinely closed at the boundary (`agentCoarseView` returns `null` in hidden mode → 403; `authorizePrecise` denies-first on hidden, then home-protection deny; the places list is sanitized for non-admins; `/precise` re-reads live settings), and the scope model is correctly mounted per-router. zod guards every JSON write body, the `onError` handler returns a generic 500, and webhook/token secrets are stripped from responses. The integration test covers the headline auth/privacy paths.

The defects cluster in **the auth-token-extraction boundary** (the single most security-sensitive function in the phase), **operational hardening for an internet-exposed default (`HOST=0.0.0.0`)**, and **a real correctness leak on `/v1/events` when settings are uninitialized**. None are remote-code-exec, but two of them are genuine privacy/auth weakenings that should not ship to a self-hostable internet boundary as-is.

No CRITICAL. Two HIGH (token-in-URL leakage + the raw-header auth ambiguity; `/events` null-settings privacy bypass). The rest are MEDIUM/LOW operational and test-coverage gaps.

---

## Findings

### AUTH BOUNDARY

**P1 — HIGH — `api/middleware.ts:21` — raw-token-in-header acceptance is an over-permissive parser that weakens the auth contract and invites confusion attacks.**
`extractSecret` first tries `Bearer <secret>`, then falls back to accepting **the entire `Authorization` header value as the secret** if it contains no whitespace (`if (header.trim().length > 0 && !/\s/.test(header.trim())) return header.trim();`). This means `Authorization: <rawtoken>`, `Authorization: Basic <rawtoken>`-with-no-space, or any single-token garbage is treated as a candidate secret. Consequences:
- It silently accepts malformed/non-standard auth schemes as if they were bearer tokens. A proxy or client that sticks the token in the header without the `Bearer ` prefix "works," which trains operators/clients to a non-standard contract that is easy to get subtly wrong.
- It widens the surface of what the verify path must treat as a secret. Today verify is hash-lookup so it's not exploitable, but the parser should be *strict* at the boundary, not permissive.
**Fix:** Drop the raw-header fallback. Accept only `Authorization: Bearer <secret>` (and the documented `?token=` query for device clients). If a non-Bearer scheme is presented, return 401. Strict parsing at the auth boundary is the correct default.

**P2 — HIGH — `api/middleware.ts:23-24` + `api/presence.ts:46-47` — `?token=` query-string auth leaks credentials into logs, proxies, and browser history; and it is accepted on EVERY route, including read-precise and all admin routes.**
`extractSecret` accepts `?token=` on every router (it's in shared middleware), not just the device ingest endpoints it was justified for. So an admin can (and a confused client will) call `GET /v1/tokens?token=<ADMIN_SECRET>` or `GET /v1/presence/precise?reason=map&token=<AGENT_SECRET>`. Query strings are routinely captured by: reverse-proxy access logs (the very reverse proxy the docs tell operators to put in front), CDN logs, `Referer` headers, and shell history. This is a classic credential-in-URL leak (CWE-598), and it is strictly worse on the admin/precise routes than on ingest. The `/precise` route additionally takes `reason` from the query and the token from the query in the same URL — both end up in the same log line.
**Fix:** Restrict `?token=` to the *ingest* routers only (the device-client justification), and reject it everywhere else. Even on ingest, document that it logs and recommend the header. At minimum, never accept `?token=` on `read_precise_location`, `manage_*` routes. Consider scrubbing `token` from any request logging now (before Phase 4 adds a logger).

**P3 — LOW — `api/middleware.ts:33` — verify is awaited on every request and unconditionally writes `lastUsedAt` (a DB UPDATE per authenticated request), but there is no `last_used_at` audit surface and the write is on the hot path.**
`TokenStore.verify` issues an `UPDATE tokens SET last_used_at` on every successful auth (`auth/tokens.ts:100-103`). For a single-user self-host this is fine, but: (a) it's an un-throttled write on the request hot path (every read does a write), (b) under the concurrent-request model it can contend on the single SQLite writer, and (c) despite paying that cost, `last_used_at` is never exposed for audit (the token list returns it, but there's no "stale token" review tooling). The prompt's "no audit of token last-used" concern is half-addressed: the data is captured but unused, at a write cost.
**Fix:** Acceptable for v0.1; consider throttling the `lastUsedAt` write (e.g. only if older than N minutes) to keep auth read-mostly, and surface it in the dashboard for audit in Phase 4.

### PRIVACY AT THE BOUNDARY

**P4 — HIGH — `api/events.ts:20-24` — `/v1/events` leaks presence transitions when privacy settings are uninitialized (`settings == null` skips the hidden-mode check entirely).**
The guard is `if (settings && !isAdmin && !accessAtLeast(...))`. When `settings` is `null`, the `settings &&` short-circuits and the request **falls through to return events** to any `read_presence` token. Compare with `presence.ts:36` and `privacy.ts:34`, which fail-closed with a 500 when settings are missing. Here the missing-settings case **fails open** — an agent gets the full event stream (which reveals home/away/entered_place/left_place transitions) with no policy applied. Settings are normally seeded at boot, but: a DB created out-of-band, a seed that failed, or a future code path that deletes/migrates the row all produce `null`, and this endpoint is the one that silently leaks. Inconsistent fail-direction across sibling endpoints is itself a smell.
**Fix:** Fail closed like the others: `if (!settings) return 500` (or treat absent settings as `hidden`). Do not let a null settings row bypass the hidden-mode gate.

**P5 — MEDIUM — `api/events.ts:19` + `policy.ts` — `/v1/events` is gated only by `read_presence` + `coarse`, but the events themselves carry `placeName` (e.g. `"home"`, `"work"`) and `status`, which is richer location signal than the coarse presence view deliberately withholds.**
The coarse view (`agentCoarseView`) was carefully designed to expose status/label/motion only — no geohash, no place identity beyond status. But `/v1/events` returns raw `PresenceEvent` rows including `placeName` for `entered_place`/`left_place`. So an agent in `coarse` mode learns the *names* of the user's places and the exact times of every enter/leave — a movement log — which the presence endpoint is careful not to give. This is arguably a privacy inconsistency: the events feed is a back-door history that `STORE_RAW_HISTORY=false` and the coarse-only philosophy were meant to avoid.
**Fix:** Decide the intended exposure. Either (a) treat `/v1/events` as admin-only (`manage_privacy`) like `/history`, or (b) sanitize agent-facing events to drop `placeName` (status-only), or (c) document explicitly that place names + transition times are intentionally agent-visible in coarse mode. Right now it's an unstated leak relative to the coarse-view design intent.

**P6 — MEDIUM — `api/places.ts:28-31` — `sanitize()` strips `lat`/`lon`/`id` but leaves `radiusM` + `name` + `type` + `label`, which materially narrows the home location and is more than an agent needs.**
The sanitized place is `{ name, label, radiusM, type, createdAt, updatedAt }`. The prompt asks whether `radiusM + name + type` is enough to triangulate — it is not enough alone (no coordinate), but combined with the coarse status (`home`/`near_home`) and the `/v1/events` place-name/transition stream (P5), an agent learns: there is a place named X of type `home` with radius R, and the precise wall-clock times the user enters/leaves it. `radiusM` in particular reveals the geofence size (e.g. a 30 m radius implies an apartment, 300 m implies a neighborhood) and leaks nothing useful to a legitimate agent. The sanitized object also still exposes `label`, which is often the literal address or building name the operator typed.
**Fix:** For the agent-facing list, return the minimum: `name` and `type` only (drop `radiusM`, `label`, and timestamps), or drop the agent-facing places list entirely and let agents use `is_near_place` semantics in Phase 4. `radiusM`/`label` should be admin-only.

**P7 — LOW — `api/presence.ts:46` — `/precise` correctly re-checks live settings, but the `reason` query param is unvalidated, unbounded, and (today) only existence-checked, so any non-empty string satisfies `preciseRequiresReason`.**
`authorizePrecise` only checks `reason?.trim()` is non-empty. A caller passes `?reason=x` and the "reason required" gate is satisfied. That's acceptable as a v0.1 policy (the reason is for audit/logging, not authorization), but: the reason is currently logged nowhere (so the audit value is zero), and it's unbounded length (a multi-KB `reason` is accepted and would land in any future log verbatim). Combined with P2 (token in same URL), a precise request URL is a high-value log line.
**Fix:** Bound `reason` length (e.g. ≤256 chars), and when an audit log is added in Phase 4, record the reason there so the gate has actual value. Low severity because it's a policy/audit knob, not an auth bypass.

### INPUT VALIDATION

**P8 — MEDIUM — no request body-size limit anywhere; `app/server.ts` mounts no `bodyLimit` middleware, so every `c.req.json()` will buffer an arbitrarily large body before zod ever runs.**
There is no `bodyLimit` (Hono ships `hono/body-limit`) and `@hono/node-server` has no default cap. `POST /v1/ingest`, `/places`, `/privacy`, `/webhooks`, `/tokens` all call `await c.req.json()` first and validate after. An unauthenticated... almost — auth runs first via `app.use("*", bearerAuth)`, so the body isn't parsed until after a valid token on most routers. **But** the body is read *inside the handler* after auth, and on a default `0.0.0.0` bind a single valid device token (the lowest-privilege token, often embedded in a phone Shortcut/OwnTracks config and the most likely to leak) can POST a multi-hundred-MB JSON body to `/v1/ingest` and OOM the process. There is no DoS ceiling.
**Fix:** Add `bodyLimit({ maxSize: ... })` globally (e.g. 64 KB — ingest payloads are tiny) before the routers, returning 413. This is cheap and closes the OOM/DoS vector on an internet-exposed self-host.

**P9 — LOW — `api/presence.ts:70` & `api/events.ts:25` — `limit` query param is parsed with `Number.parseInt` and only NaN-guarded at the route; negative/huge values pass the route unguarded.**
`Number.parseInt("-5")` → `-5` (not NaN), so the route passes `-5` to the store. It happens to be safe because `eventsStore`/`historyStore` clamp via `Math.max(1, Math.min(limit, cap))`. So this is defended *in the store*, not at the boundary — fine today, but the boundary should not rely on it, and `parseInt("10x")` → `10` (silent truncation of trailing garbage) is accepted without complaint.
**Fix:** Validate `limit` with zod (`z.coerce.number().int().min(1).max(cap)`) at the route, returning 400 on garbage, rather than depending on store-side clamping.

**P10 — LOW — `api/ingest.ts:68-79` — the OwnTracks `[]`-ack contract is correct for success and non-location messages, but a malformed body returns `{error: ...}` (a JSON *object*, status 400), breaking the array contract the OwnTracks client expects.**
On success and on non-location messages the handler returns `c.json([])` (correct — OwnTracks expects a JSON array of commands). But the `catch` returns `c.json({ error: err.message }, 400)` — an object, not an array. OwnTracks tolerates non-2xx, but a malformed-but-parseable payload that throws `NormalizeError` (e.g. lat/lon out of range) yields a 400 object that the OwnTracks client may log as a hard error or retry-loop on. Also note: a location message with `_type` *absent* and lat/lon present is accepted as a location (owntracks.ts:62), which is a reasonable lenient choice but worth a test.
**Fix:** Return `c.json([], 200)` (or `[]` with a 4xx) for OwnTracks errors to preserve the array contract, or document that OwnTracks ingest errors intentionally break the contract to surface bad payloads. Add a test for the `_type`-absent and out-of-range cases.

### ERROR HANDLING & INFO LEAKS

**P11 — MEDIUM — `api/places.ts:54`, `api/privacy.ts:47`, `api/webhooks.ts:56`, `api/tokens.ts:38` — zod `error.issues` are echoed verbatim to the client in the `detail` field.**
Every POST/PUT validation failure returns `{ error: "...", detail: parsed.error.issues }`. zod `issues` include the full path, the received type, expected enum members, and sometimes the offending value. For these admin-only routes the disclosure risk is low (the caller already holds an admin token), but it's still internal-schema disclosure to whatever sits between client and server, and it sets a precedent that will be wrong if any of these bodies ever becomes lower-privilege. The ingest path (highest-exposure, device-token) is *not* affected — it returns only `err.message` (good).
**Fix:** Either return a flattened, message-only summary (`parsed.error.issues.map(i => i.message)`) or gate the verbose `detail` behind a debug flag. Low-to-medium because the affected routes are all `manage_*`-scoped.

**P12 — LOW — `app/server.ts:33-37` — `onError` logs the full error to stdout (`console.error("request error:", err)`) which is correct, but the same handler is the only catch for unexpected throws from `verify`/stores; a thrown error that contains a token or body fragment would be logged.**
The generic 500 to the client is good (no leak to client). But `console.error(err)` logs the full error object. Today no code path puts a secret into an Error message, but the ingest path rethrows non-`NormalizeError` errors (`ingest.ts:50,63,78`) and DB errors can include bound parameters in some drivers. Worth a note since Phase 4 adds a real logger.
**Fix:** When the structured logger lands, ensure it redacts `authorization`, `token`, `secret`. No code change required now; flag for Phase 4.

### CORRECTNESS / LIFECYCLE

**P13 — MEDIUM — `index.ts:39-47` — graceful shutdown calls `process.exit(0)` synchronously after `server.close()` and `closeAppContext`, not waiting for in-flight requests to drain, and `server.close()`'s callback is ignored.**
`shutdown` calls `server.close()` (which stops accepting new connections but the callback fires only after existing ones drain), then immediately `closeAppContext(ctx)` (closes the libsql client) and `process.exit(0)`. So an in-flight request can have the DB client yanked out from under it and the process killed before it responds. For a presence service this is mostly cosmetic, but `closeAppContext` closing the DB mid-request can surface as a confusing 500.
**Fix:** Pass a callback to `server.close(() => { closeAppContext(ctx); process.exit(0); })` so the DB closes after the HTTP server drains; optionally add a force-exit timeout. Also handle a second SIGINT to force-quit.

**P14 — LOW — `api/presence.ts:30-31` & `app/context.ts:41` — `checkStale()` runs as a read side-effect on `GET /v1/presence` and its emitted event is pushed to `ctx.onEvents?.()`, which is `undefined` in Phase 3, so a `became_stale` event is appended to the DB but never dispatched.**
This is by design (the comment says Phase 4 sweeps), and the event *is* persisted (so `/v1/events` will show it). But note the read-triggers-write side effect: a `GET` mutates the DB (`setStaleEventFired`) under the per-user mutex. It's serialized (good, from F10), but it means `GET /v1/presence` can block behind a concurrent ingest, and a burst of reads each take the write lock to check. Acceptable, but the read-path write is worth flagging for Phase 4 when the sweep makes it redundant.
**Fix:** Once Phase 4 adds the periodic sweep, consider dropping the read-triggered stale write (or make it best-effort/non-blocking) so reads don't contend on the writer.

**P15 — LOW — `app/context.ts:41` + all routers — `onEvents` is wired into ingest, presence, and privacy routes but is `undefined` in Phase 3, so every `await ctx.onEvents?.(...)` is a no-op. The wiring is sound for Phase 4, but events produced now are only persisted, never delivered, and there is no retry/queue between persist and the (future) sink.** The contract ("failures here must never break the request path") is correctly implemented via optional chaining. The one gap: events are appended to the DB *before* `onEvents` is called, and `onEvents` gets only the freshly-returned events — so if Phase 4's sink is down, those events are persisted but never delivered and there's no replay from the events table. **Fix:** In Phase 4, make the dispatcher read undelivered events from the store (with a delivered flag/cursor) rather than relying solely on the in-memory hand-off, so a sink outage doesn't silently drop events.

### MISSING (operational hardening for `HOST=0.0.0.0`)

**P16 — MEDIUM — no rate limiting on any route, including ingest and the auth boundary.** A leaked device token (the most-distributed, lowest-privilege token) can be replayed without limit; there is no per-token or per-IP throttle on ingest, and no backoff on failed auth (though auth failure is cheap since it's a single hash lookup). For an internet-exposed self-host this is a real DoS/abuse gap. **Fix:** Add a simple in-memory or store-backed rate limiter (per-token) on ingest and a global cap; document reverse-proxy rate limiting as the primary control.

**P17 — MEDIUM — no CORS policy.** No `cors()` middleware is mounted. Hono defaults to no CORS headers, so browsers block cross-origin reads — which is *safe by default* (good), but it also means the future dashboard (plan §9.9) and any browser-based client will silently fail until CORS is added, and there's a temptation to then add `origin: "*"` broadly. **Fix:** No change needed for v0.1 API-only; when the dashboard lands, add a tightly-scoped CORS allowlist (never `*` with credentials).

**P18 — LOW — no `last_used_at` audit surface / no token-rotation visibility (see P3).** Captured but unused.

### TEST ADEQUACY — concrete missing cases

`api.test.ts` covers the headline paths well (401 no-token, 403 agent-into-ingest, device ingest→home, agent coarse with no coords/geohash, precise-at-home 403, precise-away 200, no-reason 403, hidden→403 for presence+events, places sanitize, place delete idempotency, token list/create/forbid). Concrete **untested** boundary behavior:

- **`?token=` query auth** (P2) — never tested that the query param authenticates at all, nor that it's (after a fix) rejected on admin/precise routes.
- **Raw-header auth** (P1) — the `Authorization: <rawtoken>` (no `Bearer`) fallback is untested; its acceptance is silent.
- **Malformed JSON body** → 400 on every POST/PUT (ingest, places, privacy, webhooks, tokens). Only the *missing-coords* (valid JSON, bad shape) case is tested.
- **Oversized body** → no test (and no limit to test, P8).
- **Device token hitting admin/read routes** — tested only that agent→ingest is 403. **Not** tested: device token → `GET /v1/presence` (403, the "device can never read" guarantee at the read boundary), device → `/v1/tokens` (403), device → `/v1/places` GET (403).
- **`/v1/presence/history` admin-only** — no test that an agent token gets 403 on `/history`, nor that `manage_privacy` is required (it's gated by `manage_privacy`, an odd scope choice for *history* vs `manage_places`/a dedicated read scope — worth asserting).
- **`/events` null-settings fail-open** (P4) — the leak is untested precisely because settings are always seeded in the test harness.
- **`/events` exposes `placeName`** (P5) — no assertion about what an agent can/can't see in the event feed.
- **Privacy PUT emits `privacy_changed`** end-to-end via the API (`privacyChanged: true` in the response) — service-level only.
- **OwnTracks contract**: non-location message → `[]` (P10), malformed → array vs object, `_type`-absent location accepted.
- **404 vs 401 ordering** — e.g. unknown route under `/v1/*` with no token; `notFound` returns 404 but route-level auth on a real-but-wrong-method path.
- **`reason` length / empty-but-present** (P7).
- **Concurrent ingest through the HTTP layer** (the mutex is unit-tested at the service, not through two overlapping HTTP requests).

---

## MUST FIX BEFORE PHASE 4

1. **(P4, HIGH)** `api/events.ts:22` — fail **closed** when `settings` is null. The current `if (settings && ...)` lets an uninitialized-settings DB return the full presence-transition event stream to any `read_presence` token, bypassing hidden mode. Match the fail-closed 500 used by `presence.ts`/`privacy.ts`.
2. **(P2, HIGH)** `api/middleware.ts:23-24` — stop accepting `?token=` query auth on non-ingest routes (especially `read_precise_location` and all `manage_*` admin routes). Credentials-in-URL leak into the reverse-proxy/CDN access logs the deployment docs require. Restrict `?token=` to ingest only, or remove it.
3. **(P1, HIGH)** `api/middleware.ts:21` — remove the raw-token-in-`Authorization`-header fallback. Accept only `Bearer <secret>`; reject other schemes with 401. Strict parsing at the auth boundary.
4. **(P8, MEDIUM)** `app/server.ts` — add a global `bodyLimit` (e.g. 64 KB) before the routers. With `HOST=0.0.0.0` default and a device token, an unbounded `c.req.json()` is an OOM/DoS vector.
5. **(Tests)** Add the boundary tests that prove the above: `?token=` rejected on admin/precise; raw-header rejected; device token → `GET /v1/presence` and `/v1/tokens` → 403; `/history` agent → 403; oversized body → 413; malformed JSON → 400; `/events` with no settings does not leak.

(P5/P6 — the `/events` `placeName` exposure and the `radiusM`/`label` in the sanitized places list — are privacy-design decisions that should be explicitly resolved before Phase 4 wires MCP, but are MEDIUM, not strictly blocking.)

---

## Verdict

**Conditional pass** — the REST surface is clean and the Phase 2 privacy fixes are correctly enforced at the boundary, but the token-extraction parser is too permissive (raw-header + universal `?token=` query leakage) and `/v1/events` fails *open* on null settings; fix those four auth/privacy items and add the missing boundary tests before Phase 4 exposes the same handlers through MCP.

---

## Resolution (applied before Phase 4)

All MUST-FIX items resolved; 93/93 tests pass (was 81), typecheck clean.

- **P4 (HIGH) — /events now fails closed.** `events.ts` returns 500 when settings are null (matches presence/privacy). Test: deleting the settings row → `/events` 500.
- **P2 (HIGH) — `?token=` restricted to ingest.** `bearerAuth(ctx, { allowQueryToken })`; only `ingestRouter` opts in. Test: query token works on ingest, returns 401 on `/precise` and `/tokens`.
- **P1 (HIGH) — raw-header fallback removed.** Only `Authorization: Bearer <secret>` accepted; other schemes → 401. Test: raw header → 401.
- **P8 (MEDIUM) — body limit.** Global `bodyLimit({ maxSize: 64 KB })` mounted before routers (runs before auth). Test: 70 KB body → 413.
- **P5 (MEDIUM) — /events placeName.** Stripped for agents (status-only feed), full for admins. Test asserts both.
- **P6 (MEDIUM) — places list minimized.** Agent list is `{ name, type }` only (no radiusM/label/timestamps/coords). Test asserts agent vs admin shape.
- **P11 (MEDIUM) — zod issues no longer echoed.** `validation.zodMessages()` returns a message-only string list across places/privacy/webhooks/tokens. Test asserts `detail` is a string array.
- **P13 (MEDIUM) — graceful shutdown.** `server.close(cb)` drains before closing the DB; second signal force-quits; 10s safety timeout.
- **P10 (LOW) — OwnTracks contract.** Bad payloads return `[]` (200) and are logged, preserving the array contract. Tests for non-location and out-of-range.
- **P7 (LOW) — reason bound.** `/precise` rejects `reason` > 256 chars (400).
- **P3 (LOW) — lastUsedAt throttled.** Written at most once per 60s per token; auth is now read-mostly.

Added boundary tests: device-can-never-read at every read route (`/presence`, `/places`, `/events`, `/tokens` → 403); `/history` admin-only; malformed JSON → 400; oversized → 413; privacy_changed over the API.

Deferred to Phase 4 (tracked): P12 logger redaction (when the structured logger lands), P14 read-triggered stale write becomes redundant once the periodic sweep exists, P15 webhook dispatcher should replay undelivered events from the store (not rely on the in-memory hand-off), P16 rate limiting, P17 CORS (when the dashboard lands), P9 limit zod-coercion (store still clamps defensively).
