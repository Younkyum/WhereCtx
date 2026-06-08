# Dashboard Redesign Review — `src/dashboard/page.ts`

Independent, read-only review of the rewritten bilingual admin dashboard. Verdict at bottom.

Pre-verified by author: typecheck clean, 129/129 tests pass, inline JS parses via `new Function()`, both languages + toggle present. This review confirms those and digs into the five evaluation axes.

---

## 0. Summary

The redesign is genuinely attractive and the XSS discipline is intact — **every** server-supplied value flows through `esc()` and every attribute sink is double-quoted. i18n key parity is perfect (72/72 both languages, no orphans either direction).

The notable defects are all in the **same family**: the two presence states that are *not* the happy path (no presence recorded yet, hidden-by-policy) leak raw English server error strings into the UI in both languages, and the two i18n keys written specifically for those states (`presence.none`, `presence.hidden`) are dead — never referenced. This is a real bilingual + empty-state correctness gap, but it is not blocking.

No CRITICAL findings. No security regressions. **MUST FIX set is empty.**

---

## 1. DESIGN / UX

Overall: a polished, intentional dark dashboard. Radial-gradient background, sticky blurred header, a real presence "hero" with an emoji status tile, pill badges with semantic color (ok/warn/acc), uppercase micro-labels on cards, monospace one-time-secret block with a warning border. This is well above generic. The 2-col grid collapsing to 1-col at 760px (line 111) is correct, and `.checks` also collapsing is a nice touch.

- **[MEDIUM] Empty/error presence state looks broken, not designed.** When `/v1/presence` 404s (no data yet) or 403s (hidden), the hero shows `❓ / —` and dumps the raw server `error` string into `#heroMeta` (lines 309–312). There are purpose-built strings (`presence.none`, `presence.hidden`) that are never used. The hero — the visual centerpiece — is exactly where a clean empty state matters most. See §2 and §4 for the wiring.
- **[LOW] `precise` button has no success feedback.** Clicking "Precise" opens a map tab on success but shows nothing in-app (line 403). On a browser that blocks the popup, the user gets zero signal. A toast ("opening map…") or inline handling of a blocked `window.open` (null return) would help.
- **[LOW] Hero `actions` can wrap under `main` awkwardly on mid widths.** `.hero` is `flex-wrap:wrap` with `.main { min-width:180px }` (lines 72–74); between ~420–520px the two ghost buttons drop below the status with no top spacing on the `.actions` container, so they hug the meta line. A small `margin-top` on `.hero .actions` when wrapped would tidy it. Cosmetic only.
- **[LOW] Webhook "Add" row is wide.** The `#webhookForm` has a 230px URL input + 190px secret input + button on one `actions-row` (lines 206–210); below ~760px these stack (inputs are `width:100%` by default but overridden with fixed px widths), so on a 360px phone the 230px field overflows the card slightly. Same pattern on `#placeForm` (fixed px widths inside a wrapping flex row). Consider `max-width:100%` on those inputs so they shrink on narrow screens. Cosmetic / minor overflow.
- **[NIT] Two `<h2>` inside one card** (Webhooks + Dead-letters share a card, lines 203 & 211). Visually fine given the uppercase label treatment, but semantically the dead-letters block reads as a subsection of webhooks; acceptable.
- **[NIT] Color use is cohesive** — single accent (`--acc` blue) with ok/warn/err semantic trio, no purple-gradient-on-white slop. Good.

No layout that outright *breaks*. Responsive behavior at 760px is correct.

---

## 2. i18n CORRECTNESS

- **Key parity: PASS.** 72 keys in `en`, 72 in `ko`, zero asymmetry in either direction (verified by extraction). Korean phrasing is natural and idiomatic ("연결 해제", "관리자 토큰을 붙여넣어…", "한 번만 표시됩니다", "전송 실패 기록"). `st.*` status labels read well.

- **[HIGH] English server-error strings leak in Korean mode (multiple sinks).** Every `loadX()` catch is silent (`catch(e){}`) *except* `loadPresence`, which writes `e.message` straight into `#heroMeta` (line 312). `e.message` is the server's English `error` field (e.g. `"no presence recorded yet"`, `"presence is hidden from agents by policy"` from `src/api/presence.ts:34,40`). In Korean mode the operator sees raw English. The same English leakage occurs in **every action toast on failure** — `toast(e.message,false)` at lines 335, 361, 377, 403, 407, 411, 417, 421 surfaces server English regardless of `LANG`. This is the single biggest i18n gap: dynamic error text never passes through `t()`.

- **[MEDIUM] Dead i18n keys = unimplemented empty states.** `presence.none` ("아직 기록된 위치가 없습니다" / "No presence recorded yet") and `presence.hidden` ("에이전트에 비공개" / "Hidden from agents") are declared in both languages but **never referenced** anywhere (verified by static scan). They were clearly meant for the 404 and 403 presence branches, but those branches instead fall into the generic catch and print the English server string. The localized copy exists and is simply not wired up.

- **[MEDIUM] `st.hidden` / line-299 hidden branch is unreachable.** `loadPresence` computes `st = p.privacy==='hidden' ? 'hidden' : p.status` (line 299), expecting a 200 response carrying `privacy:'hidden'`. But the API returns **HTTP 403** for the hidden case (`presence.ts:40`), so `api()` throws *before* that line runs. The hidden-presence UI path (icon 🙈, localized "Hidden") therefore never executes; the user gets the ❓/error-message path instead. Both the localized `st.hidden` label and the intended design are dead for this case.

- **[LOW] `ago()` and `fmtTime()` localize correctly.** `ago()` switches unit suffixes on `LANG` (line 262, 초/분/시간 vs s/m/h) and `fmtTime()` switches locale (`ko-KR`/`en-US`, line 390). Good — these dynamic strings *do* respect language.

- **Language toggle re-render: PASS.** The toggle (line 397) sets `LANG`, persists it, calls `applyI18n()` (re-translates all `[data-i18n]`/`[data-i18n-ph]`), re-runs `setConnected(!!TOKEN)` (re-renders the conn bar pill/button), and `if(TOKEN) loadAll()` which re-renders every dynamic table/badge with the new language. So static chrome *and* dynamic content both re-localize on toggle. The one thing it can't fix is the `newSecret` block and any already-shown toast, which are transient — acceptable.

---

## 3. XSS SAFETY

**PASS — no unescaped server values, no unquoted attribute sinks.** Traced every `innerHTML` write:

| Sink | Line(s) | Server values | Escaped? | Attr sinks quoted? |
|------|---------|---------------|----------|--------------------|
| conn bar pill | 289 | none (i18n only, still `esc()`'d) | yes | n/a |
| presence badges | 305–308 | `p.stale`, `p.motion`, `p.privacy` | `esc()` all | n/a |
| places rows | 328–329 | name, type, lat, lon, radiusM | `esc()` all | `data-del="…esc(p.name)…"` double-quoted ✔ |
| events rows | 344 | type, placeName, createdAt | `esc()` all | n/a |
| tokens rows | 355–356 | name, role, lastUsedAt, id | `esc()` all | `data-tok="…esc(tk.id)…"` double-quoted ✔ |
| webhooks rows | 370–371 | url, events[], active, id | `esc()` all | `data-wh="…esc(w.id)…"` double-quoted ✔ |
| dead-letters rows | 384 | eventType, error, createdAt | `esc()` all | n/a |
| new secret | 415 | `r.secret` | `esc()` ✔ | n/a |

`esc()` (line 260) escapes `& < > " '` — sufficient for both text and double-quoted attribute contexts. `p.motion` and `p.privacy` are passed through verbatim (not whitelisted) but they *are* `esc()`'d, so even a malicious/garbage value can only render as inert text. CSP (`script-src 'self' 'unsafe-inline'`) is a backstop but the escaping itself is complete. **No XSS regression.**

- **[NIT]** `b.getAttribute('data-del')` is re-`encodeURIComponent`'d into the DELETE URL (line 335) — correct; place names with slashes/spaces won't break the path. Token/webhook IDs are used raw in the path (lines 361, 377) but those are server-generated IDs, acceptable.

---

## 4. FUNCTIONAL PARITY

All previous capabilities are present and the post-`innerHTML` event wiring is correct (handlers are attached *after* `tb.innerHTML=...` in each loader, via `$$(...).forEach`, so re-render doesn't orphan listeners). `confirm()` guards all destructive actions.

| Feature | Status | Notes |
|---------|--------|-------|
| View presence | ✔ (happy path) | empty/hidden states degraded — see §1/§2 |
| Precise (map link) | ✔ | line 403; no popup-blocked handling (LOW) |
| Edit + save privacy | ✔ | load 319, save 405–408; checkboxes + retention round-trip |
| List places | ✔ | 323–338, empty state wired |
| Add/update place | ✔ | 409–412, resets `radiusM` to 150 after |
| Delete place | ✔ | confirm() + re-wired after render (333) |
| List events | ✔ | 339–349 |
| List tokens | ✔ | 350–364 |
| Create token (secret once) | ✔ | 413–418, secret shown in `#newSecret` |
| Revoke token | ✔ | confirm() (359) |
| List webhooks | ✔ | 365–379 |
| Add webhook | ✔ | 419–422, `events:['*']`, optional secret |
| Delete webhook | ✔ | confirm() (375) |
| Dead-letters | ✔ | 380–388, empty state wired |
| Connect / disconnect | ✔ | 393–394, gate↔app toggle |

- **[LOW] No empty state for tokens table.** `places`, `events`, `webhooks`, `deadLetters` all have a `[data-empty]` element toggled via `showEmpty()`, but the tokens card has none. With zero tokens you get a bare table header and no message. Minor inconsistency vs the other tables. (There's almost always ≥1 token since you connected with one, so low impact.)
- **[LOW] `newSecret` block is never cleared on language toggle or re-render.** Once a secret is shown, it persists (with its English-or-Korean label frozen at creation time) until page reload. It does re-translate? No — it's `innerHTML` set once at line 415 and `applyI18n` only touches `[data-i18n]` nodes, which this isn't. So after creating a token then toggling language, the "New secret (shown once)" label stays in the prior language. Edge cosmetic.
- **[NIT]** `disconnect()` clears `#gateToken` and TOKEN but leaves stale table bodies rendered behind the now-hidden `#app`. Hidden via `.hidden`, so invisible; re-connecting calls `loadAll()` which overwrites. Fine.

No feature dropped. No broken handler wiring.

---

## 5. ROBUSTNESS

- **Auto-refresh:** `setInterval(... loadPresence ..., 20000)` guarded by `if(TOKEN)` (line 429). Only refreshes the hero, not tables — reasonable (tables refresh on mutation). No interval leak risk in a single-page context.
- **localStorage keys:** `wherectx_admin_token` and `wherectx_lang` — consistent across read (256–257), write (393, 394, 397), and remove (394). ✔
- **Language detection:** `navigator.language.slice(0,2)==='ko'` fallback with `String(... || 'en')` null-guard (line 257). ✔ Persisted choice wins over auto-detect. ✔
- **Error handling:** `api()` (273–282) reads body as text, tolerates non-JSON (`{raw:text}`), flattens array `detail`, throws a useful `Error`. Solid. The weakness is *where* those errors surface (English passthrough — §2 HIGH).
- **[MEDIUM] Silent catch swallows load failures on all tables.** `loadPrivacy/Places/Events/Tokens/Webhooks` all `catch(e){}` (lines 321, 337, 348, 363, 379/388). A network blip or a 500 leaves the table silently empty with **no** error and (for tables with empty states) possibly a misleading "No places yet". The operator can't distinguish "empty" from "failed". At minimum, a one-line `toast(e.message,false)` (or a localized generic error) in those catches would prevent silent data loss from looking like real emptiness.
- **[LOW] No token-expiry / 401 recovery.** If the stored token is revoked server-side, every call 401s; presence shows the error, tables silently empty, but the app stays in "connected" state. A 401 could auto-bounce to the gate. Minor.
- **[NIT]** `toast` timeout is fixed at 2300ms; rapid successive toasts overwrite (single `#toast` node). Acceptable for this density of actions.

---

## Findings by severity

| # | Sev | Area | Finding | Line(s) |
|---|-----|------|---------|---------|
| 1 | HIGH | i18n | Server English error strings leak into UI in Korean mode (hero meta + all failure toasts); dynamic errors never pass through `t()` | 312, 335, 361, 377, 403, 407, 411, 417, 421 |
| 2 | MEDIUM | i18n / UX | `presence.none` & `presence.hidden` declared in both langs but never wired → no localized empty/hidden presence copy | 225 (decl), 296–313 |
| 3 | MEDIUM | i18n / func | Hidden-presence branch (`p.privacy==='hidden'`, `st.hidden`) unreachable: API returns 403, so `api()` throws first | 299 vs presence.ts:40 |
| 4 | MEDIUM | robustness | Silent `catch(e){}` on all table loaders hides fetch failures as fake-empty tables | 321,337,348,363,379,388 |
| 5 | MEDIUM | UX | Empty/error presence hero shows ❓/raw-error instead of a designed empty state | 309–312 |
| 6 | LOW | UX | `precise` has no in-app feedback; popup-block unhandled (`window.open` null) | 403 |
| 7 | LOW | func | Tokens table has no empty state (inconsistent w/ other tables) | 193 |
| 8 | LOW | i18n | `#newSecret` label doesn't re-localize on toggle (frozen `innerHTML`) | 415 |
| 9 | LOW | UX | Fixed-px-width inputs in place/webhook forms can overflow narrow cards | 182–186, 207–208 |
| 10 | LOW | robustness | No 401/revoked-token recovery; app stays "connected" | 280 |
| — | NIT | various | hero actions wrap spacing; two `<h2>` per webhook card; toast overwrite | — |

---

## MUST FIX (blocking)

**None.** No CRITICAL findings. XSS is fully preserved, key parity is perfect, all features work, both languages render and the toggle re-renders everything dynamic. The HIGH/MEDIUM items are correctness-and-polish gaps, not ship blockers for a self-hosted single-operator v0.1 dashboard.

### Strongly recommended before next iteration (non-blocking)
1. Wire `presence.none` / `presence.hidden` into the 404/403 presence branches and route error copy through `t()` so Korean mode stops leaking English (fixes #1, #2, #3, #5 together — they're one change to `loadPresence` plus a localized-error helper for toasts).
2. Add a localized `toast(e.message…)` (or generic localized error) to the silent table-loader catches (#4).

---

## Verdict

**SHIP** — visually strong, XSS-safe, feature-complete, perfect key parity; the English-leak-in-Korean-mode and empty-state gaps are real but non-blocking and fixable in a small follow-up.

---

## Resolution (applied post-review)

The reviewer verdict was SHIP (MUST-FIX empty), but since i18n is the headline feature the HIGH/MEDIUM i18n+robustness items were fixed anyway. Re-verified: typecheck clean, 129/129 tests, inline JS parses, i18n key parity 82/82.

- **#1 (HIGH) — error strings now localized.** `api()` attaches `err.status`; new `localizeError(e)` maps known server messages to localized copy (falls back to raw); all failure paths route through `fail(e)` (15 call sites) instead of raw `e.message`.
- **#2/#3/#5 (MEDIUM) — empty/hidden presence states wired.** `loadPresence` now branches on status: 404 → `presence.none` (❓ + "—"), 403 → `presence.hidden` (🙈 + localized "Hidden"/"비공개"), else localized error. The unreachable `p.privacy==='hidden'` happy-path branch was removed (`st.hidden` now actually renders via the 403 path).
- **#4/#10 (MEDIUM) — no more silent failures.** All table-loader `catch(e){}` now call `fail(e)`; a 401 triggers `onUnauthorized()` (one-shot) → disconnect to the gate + localized "session expired" toast. `connect()` resets the one-shot flag.
- **#6 (LOW) — precise popup-block handled** (`window.open` null → toast the map URL).
- **#7 (LOW) — tokens empty state** added (consistency with the other tables).
- **#9 (LOW) — narrow-screen overflow** fixed (`.actions-row input/select { max-width:100% }`).

Deferred (cosmetic, non-blocking): #8 (`#newSecret` label frozen at creation language) and the NIT items.
