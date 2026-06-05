# WhereCtx — Phase 2 (Core Services) Review

**Reviewer:** Independent staff-engineer + security/privacy critic
**Scope:** `util/time.ts`; `geofence/{distance,engine}.ts`; `normalizer/{types,generic,shortcut,owntracks}.ts`; `auth/{scopes,tokens}.ts`; `privacy/{settingsStore,policy}.ts`; `store/{presence,places,events,history,reminders,webhooks}Store.ts`; `presence/service.ts`; tests `geofence/geofence.test.ts`, `normalizer/normalizer.test.ts`, `privacy/policy.test.ts`, `presence/service.test.ts`.
**Verified state accepted as given:** typecheck clean, 51/51 vitest pass.

---

## Summary

The Phase 2 core is clean, well-factored, and largely faithful to the plan: pure geofence/distance math, injectable clocks for determinism, hash-only token storage with placeholder rejection and auto-generated admin bootstrap, and a layered precise-location gate. The mapping layers round-trip correctly and the presence service keeps webhook delivery out of the domain core (good for testability).

However, this phase is privacy- and security-critical, and there are **real holes in the privacy enforcement model** that are not caught by the passing tests because the tests only exercise the policy functions in isolation — they never assert the end-to-end guarantee. The two headline problems:

1. **`hidden` privacy mode is effectively unenforced.** Neither `buildCoarseView` nor `authorizePrecise`/`buildPreciseView` consult `defaultAgentAccess`. A user who sets agent access to `hidden` still gets full coarse presence (status/label/motion/geohash-derived) returned, and precise reads are gated only by scope + `allowPreciseLocation` + reason. The whole top of the `hidden < coarse < precise` ladder that `accessAtLeast` defines is dead code at the decision points.
2. **`hideHomeExactCoordinates` is coordinate rounding to 3 decimals (~110m), which is weak home-address protection and arguably security theater** when accuracy/altitude/geohash and the *exact* place definition are all still reachable elsewhere, and when the rounding is the *only* barrier rather than a deny.

The presence-service transition logic is correct for the single-threaded test path but has a **concurrent-ingest race** (read-prev → compute-diff → last-write-wins upsert) that will double-emit or drop enter/leave events under real-world overlapping updates. And `presence.privacy_changed` is only ever emitted as a side effect of an ingest, never when the admin actually changes the setting — so the plan's `privacy_changed` event is essentially missing.

No remote-code-exec / injection class issues. The normalizers are appropriately strict on coordinates. Severity is concentrated in privacy-semantics correctness.

---

## Findings

### SECURITY — tokens & scopes

**F1 — HIGH — `privacy/policy.ts:96-110` (`authorizePrecise`) — "device tokens can never read location" is enforced, but `hidden` mode and `preciseRequiresApproval` are silently ignored at the precise gate.**
`authorizePrecise` checks (1) `read_precise_location` scope, (2) `allowPreciseLocation`, (3) reason. It never checks `settings.defaultAgentAccess === "hidden"` and never checks `settings.preciseRequiresApproval`. So:
- An operator who sets `defaultAgentAccess: "hidden"` (the strongest privacy mode in the plan, §9.3) **still leaks precise GPS** to any agent token carrying `read_precise_location`, as long as `allowPreciseLocation` is true. `hidden` is supposed to be the most-restrictive mode; here it has zero effect on the precise path.
- `preciseRequiresApproval` exists in the schema (`privacy_settings.precise_requires_approval`), the type, and the seed, but is read by nothing. v0.1 decided approval is static-policy-only (decisions.md), but a column named `*RequiresApproval=true` that grants access anyway is a latent footgun once Phase 3 wires the API.
**Fix:** In `authorizePrecise`, deny first when `!accessAtLeast(settings.defaultAgentAccess, "precise")` is intended to gate precise — or, more correctly for this product, deny precise when `defaultAgentAccess === "hidden"`. Also either honor `preciseRequiresApproval` (deny when true in v0.1, since no approval channel exists) or delete the column from the v0.1 surface so it can't be set to a value that is silently ignored.

**F2 — MEDIUM — `auth/tokens.ts:83-101` (`verify`) — the constant-time compare is real but defends the wrong boundary; the primary lookup is an indexed equality on the hash, which is the actual enumeration/timing surface.**
`verify` looks the row up with `WHERE token_hash = ?` against a unique index, then runs `constantTimeEqualHex(row.tokenHash, hash)`. By the time that compare runs, `row.tokenHash === hash` is guaranteed (it's the lookup key), so the constant-time step compares a value to itself and is a no-op for security purposes — the comment ("defense-in-depth") overstates it. The meaningful timing/enumeration channel is the indexed `=` lookup and the early `if (!row) return null`. Because the lookup key is a SHA-256 of the secret (high-entropy, not the raw secret), this is *acceptable* in practice — an attacker cannot feasibly enumerate 256-bit hash space, and the secrets are 256-bit random — but the code's framing implies a protection it does not provide.
**Fix:** Either (a) keep it and correct the comment to say the security rests on high-entropy random secrets + SHA-256, not on the timing-safe compare; or (b) if you want a genuinely constant-time path, fetch by a non-secret id and compare the hash in constant time. Given 256-bit random secrets, (a) is sufficient — but do not represent the current compare as the protection.

**F3 — LOW — `auth/tokens.ts:33-35` — unsalted, un-stretched SHA-256 of the token.** For 256-bit random secrets (`generateTokenSecret`) this is fine (no dictionary/brute-force is feasible). But `isWeakSecret` permits operator-chosen secrets as short as 24 chars, which may be low-entropy human strings; a single unsalted SHA-256 of those is offline-crackable if the DB leaks. **Fix:** Acceptable for v0.1 given random-secret default; note in docs that operator-set tokens must be high-entropy, or raise the bootstrap minimum and/or HMAC the hash with a server-side key. Not blocking.

**F4 — LOW — `auth/tokens.ts:204-211` (`constantTimeEqualHex`) — `Buffer.from(x,"hex")` silently truncates/ignores non-hex.** If `tokenHash` were ever non-hex (it can't be today — always `digest("hex")`), `Buffer.from` would produce a short/empty buffer and the length guard would still pass-or-fail unpredictably. Inert today; brittle if the hash encoding ever changes. **Fix:** Compare the hex strings directly with a constant-time string compare, or assert hex length (64) up front.

### PRIVACY ENFORCEMENT — the policy engine

**F5 — HIGH — `privacy/policy.ts:35-47` (`buildCoarseView`) — `hidden` mode is not enforced; coarse presence is returned regardless of `defaultAgentAccess`.**
`buildCoarseView` unconditionally returns `status`, `label`, `motion`, `updatedAgoSec`, `stale`, and `privacy`. It never consults `settings.defaultAgentAccess`. The plan (§9.3) lists `hidden` as a first-class privacy mode and the code even defines `ACCESS_ORDER.hidden = 0` and `accessAtLeast`, but nothing calls them on the coarse path. Result: setting agent access to `hidden` does **not** hide presence — the agent still learns home/away/near_home/transit and motion. This is a direct violation of the privacy ladder the module advertises.
**Fix:** Gate the coarse path on access level. Either return `null`/an empty `{status:"unknown", privacy:"hidden"}` envelope when `defaultAgentAccess === "hidden"`, or have the API layer refuse `read_presence` when access is hidden. Add an end-to-end test: hidden settings + agent token → presence is withheld.

**F6 — HIGH — `privacy/policy.ts:54-76,112-121` (`buildPreciseView` / `shouldHideExact`) — `hideHomeExactCoordinates` rounds to ~110m and is the *only* barrier; it is weak protection and leaks via the unrounded geohash + place definition.**
Several layered issues:
- **Rounding ≈ security theater for a home address.** `round3` → ~110m at the equator (less N–S nearer the poles). A home address is uniquely identifiable within a 110m square in any residential area; truncating to 3 decimals does not anonymize a house, it just removes the last visual digits. It is *better than nothing* only because it removes accuracy, but it should not be presented as protecting the home location.
- **The geohash bypasses it.** `presence.coarse.geohash` is computed from the *exact* lat/lon at precision 6 (~1.2km cell) and stored, and is exposed through any view that surfaces coarse data; it is never rounded or suppressed when `hideExact` is true. Precision-6 geohash + "status: home" reconstructs the home cell.
- **Trigger is narrow.** `shouldHideExact` only fires for `status==="home" || "near_home"`. The home's *exact coordinates* are also recoverable any time the user is physically at home but the computed status differs (e.g. a closer overlapping custom place wins, making status `custom` while standing in the living room → exact coords returned).
- **Mode-agnostic.** Hiding is independent of `defaultAgentAccess`; combined with F1, a `hidden`-mode user can still pull rounded-but-real home coordinates.
**Fix:** Treat home protection as a *deny*, not a *blur*: when `hideHomeExactCoordinates` and the reading is inside/near a `home`-type place, return no precise coordinates at all (null) rather than rounded ones. Suppress/round the stored `geohash` for home readings too, or omit it from agent-facing coarse views. Document that 3-decimal rounding is a coarsening convenience, not anonymization.

**F7 — MEDIUM — `presence/service.ts:171-173` + `privacy/settingsStore.ts:73-85` — `presence.privacy_changed` only fires incidentally on the next ingest; changing the privacy setting emits no event.**
The only emitter of `privacy_changed` is `emitTransitionEvents`, which compares `prev.privacy.mode !== next.privacy.mode` during `processReading`. `SettingsStore.update()` (the actual privacy-change path) emits nothing. So an admin toggling `defaultAgentAccess` produces a `privacy_changed` event only if and when a *new location reading* later arrives — and never at all if no reading follows. Plan §9.8 lists `presence.privacy_changed` as a presence event; agents relying on it to re-evaluate trust will miss the change. **Fix:** Emit `presence.privacy_changed` from the settings-update path (or a service method the API calls after `update`), independent of ingest.

**F8 — MEDIUM — `presence/service.ts:107-113` — presence row's `privacy.mode` is snapshotted from settings at ingest time, so a privacy change does not apply to the already-stored current reading until the next ingest.**
`next.privacy.mode = settings.defaultAgentAccess` is captured per reading. If the admin tightens access to `hidden` but no new reading arrives, `getCurrent()` still returns a presence whose `privacy.mode` is the old value, and any view built from it uses the stale mode. Combined with F5/F1 (views don't consult live settings anyway) this compounds: enforcement should read *current* settings at view-build time, not a per-reading snapshot. **Fix:** Have the API/view layer pass the authoritative `PrivacySettings` (already persisted) into the policy functions and decide on the live value, not `presence.privacy.mode`.

**F9 — LOW — `privacy/policy.ts:54` (`round3`) — rounding is biased and `-0` can appear.** `Math.round` rounds half-up, so it is not symmetric for negative coordinates (`-x.xxx5` rounds toward zero differently than `+x.xxx5`), and `round3(-0.0005)` yields `-0`, which serializes as `0` in JSON but is a smell. Cosmetic; only relevant because rounding is being relied on for privacy (see F6). **Fix:** none required if F6 converts to deny; otherwise normalize `-0`.

### CORRECTNESS — presence service

**F10 — HIGH — `presence/service.ts:72-145` — concurrent `processReading` calls race: read-prev → compute-diff → last-write-wins upsert is not atomic.**
`processReading` reads `prev` (line 96), computes transition events from `prev` vs `next`, then `upsert`s. Two overlapping ingests (two devices, or rapid retries) both observe the same `prev`, both emit `entered_place`/`left_place` based on it, and the second `upsert` clobbers the first. Consequences: duplicated enter/leave events, a missed `left_place` (if A→B→A interleaves), and `staleEventFired` resets racing with `checkStale`. The single-user test path never exercises concurrency so 51/51 pass regardless. **Fix:** Serialize per-user presence mutation — a per-`userId` async mutex around read-diff-write, or do the diff inside a transaction with the upsert (SQLite is single-writer; wrap read+compute+write in one `db.transaction`). At minimum document the single-writer assumption and reject concurrent ingest.

**F11 — MEDIUM — `util/time.ts:14-20` (`secondsSince`) + `normalizer/generic.ts:69-78` (`coerceIso`) — future `updatedAt` is clamped to age 0 and never goes stale, so a device clock skew (or a malicious device) pins presence permanently "fresh."**
`secondsSince` does `Math.max(0, …)`, and `coerceIso` accepts arbitrarily-future timestamps with no upper bound. A device sending `updatedAt` an hour in the future yields `updatedAgoSec = 0`, `stale = false` forever (until real time catches up). An agent then trusts stale-but-future-stamped presence as current. Plan §9.8/§7.6 make staleness a load-bearing safety signal. **Fix:** In `coerceIso`, reject/clamp timestamps more than a small skew (e.g. a few minutes) in the future to `receivedAt`/now; or in `secondsSince`, treat a future timestamp as suspicious (e.g. fall back to `receivedAt`). At minimum, derive staleness from `receivedAt` when `updatedAt` is in the future.

**F12 — MEDIUM — `presence/service.ts:182-193` (`fireReminders`) — reminders only fire on a place *transition*, and the same name across places collides; a reminder also can't fire for a place the user is already in.**
- `fireReminders` returns `[]` when `prev?.currentPlaceName === nextPlace`, so a reminder created *while already inside* the target place will never fire until the user leaves and re-enters. Plan §7.4's intent ("remind me when I'm near a convenience store") implies firing on presence, not strictly on edge.
- `listActiveForPlace(nextPlace)` matches reminders by `placeName` string only; reminders are not user- or place-id-scoped, so any reminder whose `placeName` equals the entered place's `name` fires. In single-user v0.1 this is acceptable, but it couples reminders to place *names* (mutable, re-usable) rather than ids.
- Custom-place reminders only fire when the place is the *closest containing* place (`currentPlaceName = matchedPlace.name`); if an overlapping home/work place is closer, the custom place is never "entered" and its reminder never fires.
**Fix:** Define reminder semantics explicitly (edge-trigger vs presence-trigger), and consider firing for *all* containing places (not just the closest) so overlapping custom-place reminders work. Scope by place id where possible.

**F13 — LOW — `presence/service.ts:200-212` (`checkStale`) — `became_stale` once-only is correct, but staleness is never re-armed on a *failed-to-refresh* basis, and `checkStale` is read-triggered only.** The flag resets to `false` on every `upsert` (presenceStore stores `staleEventFired:false` on each new reading) — correct. But `checkStale` must be actively called (on read or by a sweep that Phase 3/4 must wire). If nothing calls it, `became_stale` never fires even though presence is stale. This is by design (comment says so) but is a silent dependency. **Fix:** Ensure Phase 3/4 wires a periodic sweep; add a test that two `checkStale` calls after a *new* fresh reading re-arm correctly (stale → fresh → stale fires again).

### GEOFENCE — engine edge cases

**F14 — MEDIUM — `geofence/engine.ts:65-75` + `distance.ts:15-28` — antimeridian and very-near-pole correctness.** Haversine itself is correct across the antimeridian (it uses `Δlon` through `cos`, so 179° vs −179° gives ~222km, not ~40000km — good, verified by the math). The risk is not in distance but in any future bounding-box prefilter; none exists yet, so v0.1 is fine. Poles: `cos(lat)` → 0 is handled by haversine. **No bug today**, but there is **no test** for an antimeridian-straddling place or a polar place (see F19). Keep the pure-haversine approach (don't add a naive lat/lon box later without wrapping).

**F15 — LOW — `geofence/engine.ts:80-105` — overlapping places: `inside` picks the closest *containing* place by center distance, which is not always the "most specific" place.** When a small custom place and a large home place both contain the point, the one whose *center* is nearest wins (test line 87-93 documents this). That can select a large place over a small tightly-containing one if the point is nearer the large place's center. For status purposes this is a judgment call, but it means `near_*` and reminders key off a possibly-surprising place. **Fix:** Consider ranking inside-matches by `distanceM - radiusM` (depth inside) or by smallest radius, not raw center distance. Document the chosen rule.

**F16 — LOW — `geofence/engine.ts:71-72` — boundary is inclusive (`<=`) for both `inside` and `near`, and `near` overlaps `inside` for home/work.** A point exactly at `radiusM` is "inside"; a point at `radiusM*mult` is "near." Inclusive is fine, but the `near` predicate (`distanceM <= radiusM*mult`) is also true for points that are *inside* — harmless because `inside` is checked first, but if `nearMultiplier === 1`, `near_home` becomes unreachable (every near point is also inside). Config validates `>= 1`; at exactly 1 the near band is degenerate. **Fix:** Either require `> 1` for a meaningful near band, or document that `==1` disables near_*.

### NORMALIZERS — abuse / coercion

**F17 — LOW — `normalizer/generic.ts:71-77` (`coerceIso`) — unix s-vs-ms boundary is `> 1e12` (off-by-one) and there is no future bound.** At exactly `1e12` the value is treated as **seconds** (→ year 33658), not milliseconds (→ 2001-09-09). Real epochs avoid this exact value, and unix-seconds (~1.7e9 now) vs ms (~1.7e12 now) are well separated, so this is an edge case — but the threshold should be `>= 1e12` and ideally a range check. Combined with F11 (no future clamp), a crafted `tst`/`timestamp` can place a reading far in the future or past. **Fix:** Use `>= 1e12`, and clamp/reject implausible years.

**F18 — LOW — `normalizer/owntracks.ts:91-92` — battery `charging` is `bs === 2` only; `bs === 3` ("full", typically still plugged in) reports `charging:false`.** Minor fidelity loss. The generic/shortcut path takes `charging` as a raw boolean with no validation (any truthy passes `z.boolean()`), which is fine. **Fix:** Treat `bs === 2 || bs === 3` as charging if "on power" is the intent, or document that `charging` means "actively charging."

**F19 — NIT — normalizers accept and silently drop unknown fields (`.passthrough()`), and `coerceSource`/`coerceMotion` fall back rather than reject invalid enums.** This is permissive-by-design (good for ingest ergonomics) and not an injection vector — all values are typed/coerced before storage, and there is no string interpolation into SQL (Drizzle parameterizes) or into the geohash/labels beyond what's validated. Accuracy/speed/altitude are not range-checked (a negative `accuracyM` or absurd `altitudeM` is stored verbatim), but they are not security-relevant. **Fix:** Optional: clamp `accuracyM >= 0`, ignore absurd `speedMps`. Not blocking.

### DATA INTEGRITY — stores

**F20 — MEDIUM — `store/presenceStore.ts:141-148` (`upsert`) — `onConflictDoUpdate` always overwrites `staleEventFired` to `false` and `currentPlaceName` from the new reading, which is correct for ingest but makes the `setStaleEventFired`/`checkStale` write a read-modify-write race with a concurrent `upsert` (ties into F10).** Also, because `presence.userId` is the PK and the single row is per-user, the `{ userId:_u, ...rest }` set correctly excludes the conflict target. No mapping bug found in the row↔domain round-trip — `precise`/`coarse`/`battery` nullability is handled symmetrically and verified by inspection. **Fix:** Covered by F10 (serialize mutations).

**F21 — LOW — `store/historyStore.ts:72-82` (`prune`) — lexical `<` comparison on ISO strings is only correct if all timestamps are UTC `Z` and same precision; `coerceIso` always emits `toISOString()` (UTC, ms) so this holds today, but `recordedAt` comes from `reading.updatedAt` which is device-influenced.** Since `coerceIso` normalizes everything to `…Z`, lexical ordering is sound. But a future-stamped reading (F11) writes a future `recordedAt` that prune will never remove until real time passes it — unbounded history growth from a misbehaving device when `storeRawHistory` is on. **Fix:** Tie to F11 (clamp future timestamps); optionally prune on `receivedAt` rather than device `recordedAt`.

**F22 — LOW — `store/*` — events/webhooks/reminders are global (not user-scoped) per decisions.md, but `EventsStore.listRecent` / `RemindersStore.listActive` have no user filter and will leak across users the moment v0.2 multi-user lands.** Documented as an intentional v0.1 decision; flagged so it isn't forgotten. `WebhooksStore.create` defaults empty events to `["*"]` (all events) — a footgun (accidental subscribe-to-everything) but matches plan intent. **Fix:** none for v0.1; track for multi-user migration.

**F23 — NIT — `store/eventsStore.ts:59-67` + `historyStore.ts:60-67` — ordering by `desc(createdAt)`/`desc(recordedAt)` ties are non-deterministic** (multiple events in the same millisecond sort arbitrarily, since `createdAt` has ms resolution and no tiebreak id in the ORDER BY). Rare, but enter+leave+updated emitted in one `processReading` share a near-identical `createdAt`. **Fix:** add `, desc(id)` or a monotonic sequence to the ORDER BY for stable pagination.

### TEST ADEQUACY — concrete gaps

The 51 passing tests cover the happy paths and the isolated policy functions well, but the **privacy guarantees that define this product are not tested end-to-end.** Concretely missing:

- **No test that `hidden` mode actually hides anything** (F1, F5). There is no test where `defaultAgentAccess: "hidden"` and an assertion that coarse/precise are withheld. This is the single most important untested behavior.
- **No test of `preciseRequiresApproval`** at all (F1) — the column can be `true` and access is still granted, untested.
- **No test that the geohash is suppressed/coarsened when hiding home** (F6) — the home-coordinate leak via geohash is unguarded and unasserted.
- **No concurrency test** for `processReading` (F10) — overlapping ingests, A→B→A interleave, lost `left_place`.
- **No future-timestamp test** (F11) — a reading stamped in the future and the resulting `updatedAgoSec=0` / never-stale behavior.
- **No test that changing privacy settings emits `presence.privacy_changed`** (F7) — because it doesn't, and nothing asserts it should.
- **No test for a reminder created while already inside the place** (F12), nor for overlapping-place reminder firing.
- **No `near_work`/custom-place reminder, multi-place overlap reminder, or `nearMultiplier == 1` degenerate-band test** (F12, F16).
- **No antimeridian / polar geofence test** (F14) — the math is right but unguarded against future regressions.
- **No token-revocation-then-verify test**, and no test that a `device` token (only `write_location`) is rejected by `authorizePrecise` *and* by the coarse read path (the device-can-never-read guarantee is asserted only by scope-set construction, not at the read boundary).
- **No `setStaleEventFired` re-arm test** across fresh→stale→fresh→stale (F13).
- **Mapping round-trip not directly tested** for `presenceStore` (precise-absent, coarse-absent, battery-absent rows) — only exercised transitively via the service.

---

## MUST FIX BEFORE PHASE 3

These are blocking because Phase 3 (REST/MCP API) will wire these functions directly to agent-facing endpoints; shipping them as-is bakes the privacy holes into the external surface.

1. **(F5, HIGH)** Enforce `hidden` mode on the coarse read path. `buildCoarseView` (or the API layer calling it) must withhold presence when `defaultAgentAccess === "hidden"`. Today `hidden` returns full coarse presence.
2. **(F1, HIGH)** Enforce `hidden` mode (and decide `preciseRequiresApproval`) in `authorizePrecise`. Today a `hidden`-mode user still leaks precise GPS to any token with `read_precise_location` + `allowPreciseLocation`, and `preciseRequiresApproval=true` is silently ignored.
3. **(F6, HIGH)** Make home protection a deny, not a 110m blur, and close the geohash leak: when `hideHomeExactCoordinates` applies, return no precise coordinates and do not expose the precision-6 geohash derived from the exact home location. Rounding to 3 decimals is not home-address anonymization.
4. **(F10, HIGH)** Serialize per-user presence mutation (per-user mutex or wrap read-diff-upsert in a single transaction). The current read-prev → diff → last-write-wins upsert races on concurrent ingest, double-emitting or dropping enter/leave events and racing `staleEventFired`.
5. **(F11, MEDIUM)** Clamp/reject future `updatedAt` (device-controlled) so a future timestamp cannot pin presence permanently non-stale; derive staleness from `receivedAt` when `updatedAt` is implausibly future. Staleness is a safety signal and is currently spoofable by the device.
6. **(Tests)** Add the end-to-end privacy tests named above — at minimum: hidden-mode withholds coarse and precise; device token rejected at the read boundary; geohash suppressed for hidden-home; future-timestamp staleness. The current 51/51 green does not exercise the product's core guarantee.

---

## Verdict

**Conditional pass on engineering quality, FAIL on privacy enforcement as-shipped** — the core is clean and well-tested for happy paths, but `hidden` mode is unenforced, home protection is a 110m blur with a geohash leak, and concurrent ingest races; these six items must be fixed before the Phase 3 API exposes them to agents.

---

## Resolution (applied before Phase 3)

All six MUST-FIX items resolved; 66/66 tests pass (was 51), typecheck clean.

- **F5 + F1 (HIGH) — hidden mode enforced.** `policy.ts` now has `agentCoarseView()` (returns `null` when `defaultAgentAccess==="hidden"`) and `authorizePrecise()` denies first on hidden. `preciseRequiresApproval` now denies (fail-closed) since v0.1 has no approval channel. E2E test: hidden withholds coarse *and* precise.
- **F6 (HIGH) — home protection is now a deny.** `authorizePrecise()` refuses precise when `shouldHideExact()` applies (home/near_home). The agent `CoarsePresenceView` carries no geohash/raw coords (verified by a test asserting the geohash string is absent from the serialized view). Rounding-as-protection removed.
- **F10 (HIGH) — per-user serialization.** New `util/mutex.ts` `KeyedMutex`; `processReading`, `checkStale`, and `changePrivacySettings` run under it. Concurrency test asserts no double/dropped enter-leave events.
- **F11 (MEDIUM) — future-timestamp clamp.** `coerceIso` distrusts `updatedAt` >5min ahead of receive time; `1e12` boundary fixed to `>=`. Tests cover clamp + within-skew accept.
- **F7 (MEDIUM) — privacy_changed on settings change.** New `PresenceService.changePrivacySettings()` emits the event and updates the live presence snapshot. Test asserts emit-on-change and no-emit-on-no-change.
- **F2 / F4 (MEDIUM/LOW) — token compare.** Misleading comment corrected (security rests on 256-bit random secret + SHA-256, not the timing compare); `constantTimeEqualHex` now compares UTF-8 bytes of the hex (no silent hex truncation).
- **Tests added:** hidden withholds; device token rejected at read boundary (`canReadPresence`); home deny; geohash never in agent view; future-timestamp staleness; privacy_changed; stale re-arm (fresh→stale→fresh→stale); concurrent ingest.

Deferred (documented, non-blocking): F3 operator-token entropy (note in docs), F12 reminder edge-vs-presence semantics + overlap (revisit in Phase 4 when reminders are wired to MCP), F13 periodic stale sweep wiring (Phase 4), F15/F16 geofence ranking/`==1` band (documented), F18/F19 normalizer fidelity, F22/F23 multi-user scoping + ordering tiebreak (v0.2). These do not expose privacy holes through the Phase 3 surface.
