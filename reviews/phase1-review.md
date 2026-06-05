# WhereCtx — Phase 1 (Foundation) Review

**Reviewer:** Independent staff-engineer critic
**Scope:** `src/types.ts`, `src/config.ts`, `src/config.test.ts`, `src/db/schema.ts`, `src/db/index.ts`, `src/db/migrate.ts`, `drizzle/0000_*.sql`, `drizzle.config.ts`, `package.json`, `tsconfig.json`, `.env.example`, `.gitignore`
**Verified state accepted as given:** typecheck clean, 5/5 vitest pass, migration applies to local SQLite.

---

## Summary

Phase 1 is a solid, well-organized foundation. The TypeScript domain types faithfully mirror plan section 10, the Drizzle schema covers all required entities plus sensible forward-looking tables (webhooks, reminders, location_history), the config loader is typed and defensive, and the chosen stack matches the plan (TS + Hono + libsql/SQLite + Drizzle + MCP SDK). Tokens are stored as hashes, not plaintext — a good early decision.

The problems are not in *what* was built but in **three sources of truth that can silently diverge**: (1) the hand-written `createTablesFallback()` SQL vs the Drizzle schema, (2) the duplicated `normalize()` in `drizzle.config.ts` vs `normalizeDatabaseUrl()` in `config.ts`, and (3) privacy/retention/stale values that exist both in env-config *and* in the `privacy_settings`/`presence` tables with no defined precedence. None of these break Phase 1, but each becomes a real defect the moment Phase 2 (auth, policy engine, presence store) starts reading/writing through these paths. There is also one genuine **upgrade-path boot bug** lurking in the dual schema strategy.

No CRITICAL issues. Several MEDIUM items should be resolved before Phase 2 to avoid building the policy engine on ambiguous foundations.

---

## Findings

| # | Severity | Location | Problem | Fix |
|---|----------|----------|---------|-----|
| 1 | HIGH | `src/db/index.ts:71-173` & `:58-65` | **Dual schema strategy is a drift + upgrade hazard.** `createTablesFallback()` hand-duplicates every table from `schema.ts`/the migration. It already diverges from the generated SQL (see #2). Worse: the fallback creates tables **without** writing to drizzle's `__drizzle_migrations` ledger. If a deployment first boots with no `drizzle/` folder (fallback runs, tables created) and later that folder appears (npm update / image rebuild ships migrations), the next boot calls `migrate()`, which finds an empty migrations ledger and issues plain `CREATE TABLE` (no `IF NOT EXISTS`) → **"table already exists" → server fails to start.** | Remove `createTablesFallback()` entirely. Migrations are the canonical path and `drizzle/` is committed to the repo and resolved relative to the module (works from `src` and `dist`). If a defensive net is truly wanted, make migrations a hard requirement and fail loudly with a clear message when the folder is missing, rather than silently forking schema creation. |
| 2 | MEDIUM | `src/db/index.ts:115,117,144-149` vs `drizzle/0000_*.sql:45,47,66-71` | **Boolean defaults differ between the two schema sources.** Fallback emits `DEFAULT 0` / `DEFAULT 1`; generated migration emits `DEFAULT false` / `DEFAULT true`. Both happen to work on modern SQLite/libsql (TRUE/FALSE are 1/0 since SQLite 3.23), so it's latent, but it proves the two definitions are maintained by hand and already out of sync. | Resolved automatically by removing the fallback (#1). If kept, generate it from `schema.ts` instead of hand-writing. |
| 3 | MEDIUM | `drizzle.config.ts:5-14` vs `src/config.ts:67-95` | **Two different DATABASE_URL normalizers.** `drizzle.config.ts` uses `replace(/^\/{2,}/, "/")` which mishandles the `sqlite://./relative` case: `sqlite://./data/wherectx.db` → `file:/./data/wherectx.db` (absolute-ish), whereas `config.ts` correctly yields `file:./data/wherectx.db` (relative). So drizzle-kit and the runtime can point at **different database files** for the same env value. Also `startsWith("http")` (config splits `http://`/`https://`) and missing `ws://`/`wss://` handling. | Extract one `normalizeDatabaseUrl` into a dependency-free module (e.g. `src/db/url.ts`) and import it from both `config.ts` and `drizzle.config.ts`. Add the `sqlite://./` and `:memory:` cases to the test. |
| 4 | MEDIUM | `src/config.ts:109,136` vs `src/db/schema.ts:130` vs `:80` | **Naming + source-of-truth split for privacy defaults.** Config calls it `defaultAgentPrivacy`; the `privacy_settings` table calls it `default_agent_access`; the live `presence` row carries its own `privacy_mode`. Likewise `retentionHours`/`staleAfterSec` live in *both* env-config and DB columns. Phase 2's policy engine will have to decide which wins (env vs persisted row) and there is currently no documented precedence — a classic config/DB drift bug. | Decide and document precedence now: env values seed the `privacy_settings` row on first boot; thereafter the persisted row is authoritative (dashboard edits must stick). Align the names (`defaultAgentAccess` everywhere) to avoid mapping bugs. |
| 5 | MEDIUM | `src/db/schema.ts:97-110,154-176` | **Inconsistent `user_id` coverage blocks the v0.2 multi-user roadmap.** `places`, `presence`, `privacy_settings`, `location_history` carry `user_id`; `presence_events`, `webhooks`, `reminders`, and `tokens` do not. For single-user v0.1 this is fine, but the asymmetry guarantees a schema migration + data-backfill the moment multi-user (plan §15) lands, and it's easy to write Phase-2 queries that bake in the single-user assumption. | Either commit to single-user explicitly (document it, drop the stray `user_id` columns for symmetry) or add `user_id` consistently now while tables are empty. Pick one; don't leave it half-scoped. |
| 6 | MEDIUM | `.env.example:18-20` + `src/config.ts:130-134` | **Default bootstrap tokens are publicly-known placeholders with no guard.** `change-me-admin` / `change-me-device` / `change-me-agent` are shipped verbatim and loaded as-is; nothing warns or refuses to seed a token still set to its placeholder. Since the seeding logic lands in Phase 2, an operator who skips reading the docs gets a server whose admin token is in the public repo. | In Phase 2 token bootstrap: refuse to seed (or refuse to boot in production) any token matching `/^change-me/` or shorter than ~24 chars, and emit a loud warning. Consider generating random tokens on first run and printing them once. Flagged here because the placeholder values originate in this phase. |
| 7 | LOW | `src/db/schema.ts:26,47,78,80,130 …` | **No `$type<>()` binding between TS unions and `text` columns.** `status`, `motion`, `source`, `type`, `role`, `privacy_mode`, `coarse_place_type` are all bare `text` with only `// comment` hints. There is zero compile-time link between `types.ts` and `schema.ts`, so a typo'd status string or a renamed union member won't be caught until runtime. | Pragmatic mitigation: annotate columns, e.g. `text("status").$type<PresenceStatus>().notNull()`, `text("role").$type<TokenRole>()`, `text("scopes", { mode: "json" }).$type<TokenScope[]>()`. Zero runtime cost, recovers compile-time safety, and lets store code use `InferInsertModel`/`InferSelectModel`. |
| 8 | LOW | `src/config.ts:94` & `src/db/index.ts:30-31` | **`:memory:` is mangled.** `normalizeDatabaseUrl(":memory:")` → bare-path branch → `file::memory:`, which libsql/SQLite treats as a *named shared-cache file* db, not the special in-memory db (`:memory:`). Tests that want an ephemeral DB in Phase 2 will get surprising on-disk-ish semantics. | Short-circuit `:memory:` (and `file::memory:`) before the bare-path branch and pass through untouched. |
| 9 | LOW | `src/db/schema.ts:190` | **`now = sql\`CURRENT_TIMESTAMP\`` is an ISO/format trap.** Every timestamp column is documented as ISO-8601 (`updatedAt`/`receivedAt` are app-generated ISO strings), but `CURRENT_TIMESTAMP` produces `YYYY-MM-DD HH:MM:SS` (space, no `T`, no `Z`). If anyone wires this as a column `.default(now)`, you get mixed timestamp formats that break `updatedAgoSec` math and lexical sorting. | Remove the unused `now` export, or replace with an app-side `new Date().toISOString()` helper so all timestamps share one format. |
| 10 | LOW | `src/config.ts:99` + `.env.example:6` | **Default `HOST=0.0.0.0` binds all interfaces.** For a privacy-positioned, self-hosted location product, the out-of-the-box bind is public. Combined with #6 (placeholder admin token), the default posture is "publicly reachable server with a known admin token." | Keep `0.0.0.0` for Docker (it needs it), but document prominently that WhereCtx must sit behind a reverse proxy / not be exposed raw, and tie it to the token-hardening in #6. |
| 11 | NIT | `src/db/schema.ts` (all tables) | **No `CHECK` constraints** on enum-like columns (`role`, `status`, `type`, `privacy_mode`). Acceptable given SQLite + Drizzle ergonomics, but means *all* validation must live in the app layer. | Ensure Phase 2 validates these with Zod at every write boundary (Zod is already a dependency). Optionally add `CHECK (role IN (...))` via raw SQL in the migration for defense-in-depth. |
| 12 | NIT | `src/config.ts:144-146` | `geofence.nearRadiusMultiplier` default `3` is undocumented as a tuning knob and `NEAR_RADIUS_MULTIPLIER` isn't validated as `> 1`. A value `<= 1` would make `near_*` unreachable. | Clamp/validate to `>= 1` (or `> 1`) in `loadConfig`, with a clear error. |
| 13 | NIT | `src/types.ts:162-169` | `CoarsePresenceView.label` is a required `string`, but `PresenceContext.label` and the DB `label` column are both nullable. Phase 2 must supply a fallback label (e.g. derive from `status`) or this view can't be constructed. | Note it now: define the `status → label` fallback in the presence-store mapping layer. |

---

## Detailed notes on the four mandated questions

**1. Schema fidelity vs plan §10.** Faithful. `PresenceContext`, `Place`, `PresenceEvent`, `Token`, `PrivacySettings` are all represented with correct types and nullability (precise/coarse/battery fields nullable, `status`/`source`/`privacy_mode` NOT NULL, `radius_m`/`lat`/`lon` NOT NULL). Indexes are sensible: unique on `token_hash`, unique on `(user_id, name)` for places, time indexes on events/history/reminders. The only fidelity gaps are organizational, not field-level: inconsistent `user_id` (#5) and enum columns unconstrained/unbound (#7, #11). The schema also *adds* `current_place_name` and `stale_event_fired` to `presence` — good, these are needed for enter/leave + `became_stale` event de-duplication in Phase 2, and are a correct anticipation of plan §9.8.

**2. The dual schema strategy (`createTablesFallback`).** **Recommendation: remove it.** It provides no real resilience — the `drizzle/` folder is committed and module-relative-resolved, so it's present in every realistic deployment — yet it (a) is hand-maintained and already drifting (#2), and (b) introduces a concrete upgrade-path boot failure because it bypasses the `__drizzle_migrations` ledger (#1). A "boots no matter what" net that can brick an upgrade is worse than a loud, early failure. Replace the fallback branch with an explicit error if migrations are missing.

**3. Drift between `types.ts` and `schema.ts`.** Severity: **moderate but cheap to fix.** Today the only link is human discipline + `// comments`. Risk grows with every store/serializer in Phase 2 that maps rows to `PresenceContext`. Pragmatic mitigation (no architecture change): add `.$type<…>()` annotations to the enum/JSON `text` columns and derive insert/select types via `InferInsertModel`/`InferSelectModel`. That gives compile-time coupling without an ORM/codegen overhaul.

**4. Config edge cases.** `normalizeDatabaseUrl` is correct for the documented cases and well-tested *except*: the `:memory:` mangle (#8), the divergent second implementation in `drizzle.config.ts` (#3), and unguarded placeholder tokens (#6). Env validation is otherwise reasonable (ints/floats/bools throw on garbage), but lacks: bootstrap-token strength checks, `BASE_URL`/`PORT` range validation, and `NEAR_RADIUS_MULTIPLIER >= 1` (#12). The env→DB precedence for privacy/retention/stale is undefined (#4) and must be nailed down before the policy engine is written.

**5. Phase 2+ risk callouts.**
- *Auth/scopes:* token table is hash-based and scope-carrying (good), but enforcement, placeholder-token rejection (#6), and `last_used_at` updates are all unbuilt — make sure the "device tokens can never read location" rule (plan §9.3) is enforced at the scope check, not just by convention.
- *Policy engine:* the env-vs-DB precedence ambiguity (#4) is the single biggest design decision to resolve first.
- *Presence store:* `label` nullability mismatch (#13) and the `now`/ISO format trap (#9) will bite the `updatedAgoSec`/`stale` computation if not handled.
- *MCP/webhooks:* `webhooks`/`reminders` tables lack `user_id` (#5) and `events` is free-form JSON text with no validation — fine for now, but Zod-validate on write.

---

## MUST FIX BEFORE PHASE 2

1. **(Finding #1, HIGH)** Remove `createTablesFallback()` in `src/db/index.ts` (or make missing-migrations a hard, loud failure). As written it can cause a "table already exists" boot failure on the upgrade path because it bypasses the `__drizzle_migrations` ledger.
2. **(Finding #3, MEDIUM)** Unify the DATABASE_URL normalizer — `drizzle.config.ts` and `src/config.ts` currently disagree on `sqlite://./relative`, so drizzle-kit and the runtime can target different database files for the same env value. Extract one shared, dependency-free normalizer and import it in both.
3. **(Finding #4, MEDIUM)** Define and document precedence for privacy/retention/stale values that live in *both* env-config and the `privacy_settings`/`presence` tables (recommended: env seeds the row on first boot, persisted row is authoritative thereafter), and align the naming (`defaultAgentPrivacy` vs `default_agent_access`). The policy engine cannot be built correctly until this is settled.

---

## Final verdict

**Conditional pass** — a clean, faithful foundation with no critical defects, but remove the drift-prone dual-schema fallback and resolve the two normalizer / config-precedence ambiguities before building Phase 2 on top of them.

---

## Resolution (post-review, applied before Phase 2)

- **#1 HIGH** — `createTablesFallback()` removed from `src/db/index.ts`; missing migrations now throw a clear, loud error. Migrations are the single source of truth. Verified: fresh boot creates `__drizzle_migrations` + all 8 tables.
- **#3 MEDIUM** — Single normalizer extracted to `src/db/url.ts`; imported by both `src/config.ts` and `drizzle.config.ts`. `:memory:` short-circuit and `sqlite://./` / `sqlite:///` cases added with tests (7/7 pass). `drizzle-kit check` confirms config loads.
- **#4 MEDIUM** — Env→DB precedence documented in `docs/decisions.md` (env seeds `privacy_settings` on first boot; persisted row authoritative thereafter). Naming aligned on `defaultAgentAccess`.
- **#5 MEDIUM** — Single-user scope made explicit and documented in `docs/decisions.md`.
- **#6 MEDIUM** — Placeholder-token hardening plan recorded; to be enforced in Phase 2 token bootstrap.
- **#7 LOW** — `.$type<>()` bindings added to all enum columns; `scopes`/`events` use `{ mode: "json" }`.
- **#8 LOW** — `:memory:` handled in shared normalizer.
- **#9 LOW** — Unused `now`/`CURRENT_TIMESTAMP` export removed; ISO-8601 convention documented.
- **#12 NIT** — `NEAR_RADIUS_MULTIPLIER >= 1` validated in `loadConfig`.
- **#13 NIT** — Label fallback strategy documented for the Phase 2 store layer.

Deferred to their natural phases (tracked): #6 enforcement (Phase 2), #11 Zod write-validation (Phase 2/3). #5 column symmetry and #10 deployment hardening are documented decisions, not code blockers.
