# Tally Church Portal Review

**Audience:** Andrew (platform operator / Chief of Staff) and anyone shipping portal UX. Church TDs see the product, not this doc.  
**Repo:** `peterdisbrow/tally` @ `origin/main` (`d21b662`) plus this PR.  
**Live probe:** 2026-09-09 ~01:22–01:40 UTC, read-only. No church credentials, no Railway secret values, no Stripe Dashboard.  
**Deployed relay:** `1.1.67` build `d21b66212866117ce50600e64a254fc7b853bd9d` (Railway + Cloudflare). Probe `/api/health`: **6 registered / 0 connected / 0 controllers / 0 messages relayed.**

This answers: *can a TD get from login to a calm Sunday — booth connected, service windows set, alerts paging, rundown on the displays — without competing nav or silent failures?*

Companion docs: [`FEATURE_AUDIT_2026-09-08.md`](FEATURE_AUDIT_2026-09-08.md), [`ALERTS_REVIEW.md`](ALERTS_REVIEW.md), [`ADMIN_DASHBOARD_REVIEW.md`](ADMIN_DASHBOARD_REVIEW.md), [`AI_SURFACES_REVIEW.md`](AI_SURFACES_REVIEW.md), [`EMAIL_SYSTEM_REVIEW.md`](EMAIL_SYSTEM_REVIEW.md), [`BOOTH_DESKTOP_REVIEW.md`](BOOTH_DESKTOP_REVIEW.md).

North star: **Sunday-indispensable.** Portal should get a TD to: **connect booth → set service window → configure alerts → run/view rundown** — calmly, one obvious path.

**Prepare mode.** No sales features proposed. Referral UI on Billing is noted as sales surface, not expanded.

---

## Status legend

| Status | Meaning |
|--------|---------|
| **WORKING** | UI + API exist; a live or test probe shows the path can fire |
| **PARTIAL** | Implemented, but env-gated, split across pages, or useless until a booth connects |
| **BROKEN** | Confirmed miss: 404, wrong link, silent no-op, or UI/API contract that prevents the job |
| **DECORATIVE** | UI or copy implies a capability that does not run (or is a different subsystem) |
| **UNPROVEN** | Code looks complete; **0 connected churches** so the live path has not been watched |

---

## Summary verdict

**Partial. Login and the SPA are real. The Sunday loop is still easy to miss, and live dogfood cannot be claimed while no booth is connected.**

Registered names from the Sep 8 feature audit included Cogcomm and LCC. This review **does not** claim they are live. Health at probe time: **0 connected**. Overview “Stream Protected” / live rundown / analytics stay empty or decorative until an agent is on the wire.

| Sunday step | Intent | As built | Sunday-usable? |
|-------------|--------|----------|----------------|
| **Sign in** | Church admin or TD reaches `/church-portal` | Cookie JWT (7d), CSRF, dual login (portal email then TD email). Forgot-password CTA on marketing is **200**. | **WORKING** |
| **Connect booth** | Desktop app online; Home shows kit | Home empty-state + Stream (YouTube/Facebook/PCO). Zero-rooms gate is real. Live kit cards need SSE. | **UNPROVEN** (0 booths) |
| **Set service window** | Alerts/autopilot know Sunday | Equipment → **Schedule** tab. Copy is honest that empty windows silence alerts. Portal save used to skip the engine cache (**fixed in this PR**). | **WORKING (code)** after this PR; still **silent Sunday if left empty** (by design) |
| **Configure alerts** | Telegram + Slack page the TD | Slack is on **More → Alerts** (#148). Telegram chat ID lives on **Profile** (Settings). Onboarding checklist has Telegram, **not** “set windows.” | **PARTIAL** — split UX |
| **Run / view rundown** | Calm operator surface + display shares | **More → Rundown** (Sprint 1 / #147 / #150). Shares are dedicated routes. PCO import cannot OAuth (`PCO_CLIENT_*` missing). | **PARTIAL** — buried nav; PCO **DECORATIVE** in prod |
| **Stay live** | Status updates without refresh | `GET /api/church/stream` cookie SSE. Church-admin-only check used to **401 every TD** (**fixed in this PR**). | **WORKING (code)**; live **UNPROVEN** |

**Do not invent secrets.** `PCO_CLIENT_ID` / `PCO_CLIENT_SECRET` stay unset until Andrew puts them in Railway. This PR does not add them.

---

## North-star scorecard

Scores are 1–5 against *Sunday-indispensable*, not feature count. **Honesty over live proof:** nothing below 5 can be claimed as watched in production while `connectedChurches: 0`.

Pre-fix → post-fix where this PR changed the number.

| Pillar | Score | Why this number |
|--------|-------|-----------------|
| **Reliability** | **2 → 3 / 5** | Schedule save now hydrates `ScheduleEngine` so “Schedule saved” is not a silent no-op until restart. TDs get SSE. Empty windows still log-only (except EMERGENCY). Alerts + Rundown still live under **More**. 0 booths. |
| **Trust** | **2 / 5** | AI Triage / Diagnostics is heuristics, not Claude ([`AI_SURFACES_REVIEW.md`](AI_SURFACES_REVIEW.md)). Billing copy lists Connect **$79** (or $49 founding) while marketing sells founding $49 — Stripe IDs are env-only, not re-checked here. PCO cards exist without OAuth. Home can read “protected” with no booth. |
| **Security** | **3 / 5** | httpOnly `SameSite=Strict` cookie, CSRF double-submit, Helmet `script-src-attr 'none'`. Remaining inline `onclick`/`onchange` in `portal.js` are **dead under CSP** (P1). TD `access_level` is mostly UI-hide; writes use church-admin JWT. Guest TD tokens are 24h Telegram, not portal login. No idle timeout. |
| **Polish** | **2 → 3 / 5** | Rundown calm UX (#150), Slack self-serve (#148), display shares (#147). Profile was unreachable from nav (**fixed**). Simple view hid the schedule card (**fixed**). Competing **More** menu still buries the Sunday path. Mobile hamburger exists; many cards are dense. |
| **Observability** | **2 / 5** | Relay Sentry exists; **no portal browser Sentry**. SSE failures are silent in the EventSource client. Status page watches Telegram **interactive** webhook, not “did this church get paged.” |

**Overall: ~2.6 / 5 — shippable as a supervised setup tool, not yet a one-path Sunday console.**

---

## 1. What it is

The **Church Portal** is the **self-service SPA for a church** (admin password or TD login). It is **not** the admin dashboard and **not** the reseller portal.

| | |
|---|---|
| **Who** | Church `portal_email` (church admin) or `church_tds` with `portal_enabled` + password. |
| **Canonical URL** | `https://api.tallyconnect.app/church-login` → `/church-portal` |
| **Assets** | `relay-server/public/portal/` (`login.html` / `portal.html` + css/js), served by `src/churchPortal.js` |
| **API** | Cookie session `/api/church/*` (and a few `/api/td/*`) |
| **Not on marketing host** | `tallyconnect.app/portal` **404s**. Password reset lives at `tallyconnect.app/reset-password` (#152). Login “Forgot password?” already points there. |

### Auth model

| Path | What happens |
|------|----------------|
| **Church admin** | `POST /api/church/login` matches `churches.portal_email` + hash → JWT `{ type: 'church_portal', churchId }` **7d** |
| **TD** | Same form; then `church_tds.email` + hash → `{ type: 'td_portal', tdId, churchId, accessLevel, roomId? }` **7d**. One assigned room auto-scopes; several rooms → `?pickRoom=1` |
| **Cookie** | `tally_church_session` **httpOnly**, `SameSite=Strict`, `Secure` in production |
| **CSRF** | `tally_csrf` readable cookie + `x-csrf-token` header (`src/csrf.js`) |
| **Idle timeout** | **None.** Session lasts until cookie expiry or Sign out |
| **Email verify** | `GET /api/church/verify-email?token=` → redirect `/church-portal?verified=true` ([`EMAIL_SYSTEM_REVIEW.md`](EMAIL_SYSTEM_REVIEW.md)) |
| **Forgot / reset** | Marketing `tallyconnect.app/forgot-password` **200**; `tallyconnect.app/reset-password` **200**. Legacy `tallyconnect.app/portal/reset-password` still **404** (emails no longer use it) |

**TD roles (UI):** `viewer` / `operator` / `admin` via `applyTdAccessRestrictions` in `portal.js`.

| Level | Nav hide (client) | Server writes |
|-------|-------------------|---------------|
| **viewer** | Almost everything except Home (+ Alerts/Rundown/Network/Analytics still visible) | `requirePortalAuth` for reads; `requireAdminAuth` rejects all TD JWTs |
| **operator** | Hides Profile, Equipment, Team, Stream, Billing, Help | Same: **cannot** save schedule, Slack, billing, TDs |
| **admin** (TD) | Hides Billing only | **Still not church admin.** `PUT /api/church/schedule`, `PUT /api/church/me`, Team, Slack → **403 Admin access required** |

Church-admin vs TD-admin is the #1 footgun: a TD labeled Admin can **see** Equipment/Team and then fail on save.

**Guest TD:** Team page can mint 24h Telegram `GUEST-…` tokens (`guestTdMode`). That is booth/Telegram, **not** a portal cookie.

---

## 2. Surface map

Client-side pages only (no URL routes). Primary nav: Home, Equipment, Stream, Help. Everything else is **More** or **Settings**.

### Primary nav

| Nav | Page id | Status | Notes |
|-----|---------|--------|-------|
| **Home** | `overview` | **PARTIAL / UNPROVEN** | Kit cards, protection banner, live rundown CTA, schedule card. Empty-state “Connect the Desktop App” is the honest Sunday start. “Stream Protected” with 0 booths is a trust leak. |
| **Equipment** | `rooms` | **WORKING** (code) | Rooms + Roles + **Schedule** tab. Zero-rooms gate blocks the rest until one room exists. |
| **Stream** | `connections` | **PARTIAL** | YouTube / Facebook OAuth (env present per feature audit). **PCO** card: OAuth default redirect `https://relay.tallyconnect.com/api/admin/pco/callback`; **`PCO_CLIENT_*` missing** → cannot start. |
| **Help** | `support` | **WORKING** (code) | How-tos + tickets. Hidden from TD operator/viewer. |

### More

| Nav | Page id | Status | Notes |
|-----|---------|--------|-------|
| **Team** | `team` | **WORKING** (code) | TDs, portal access, guest tokens. Church-admin API. |
| **Alerts** | `alerts` | **PARTIAL** | Slack webhook (#148). Telegram **chat ID is on Profile**, not here. Empty schedule → silent Sunday ([`ALERTS_REVIEW.md`](ALERTS_REVIEW.md)). |
| **Network** | `network-topology` | **UNPROVEN** | Needs booth telemetry. |
| **Analytics** | `analytics` | **UNPROVEN** | Viewer trends need OAuth + live session. |
| **Reports** | `reports` | **PARTIAL** | Post-service / recap; empty without sessions. |
| **Automation** | `automation` | **PARTIAL** | AutoPilot Pro+ gate. Uses service windows. |
| **AI Assistant** | `engineer` | **PARTIAL** | Engineer profile + Claude chat. Copy overlaps Diagnostics. |
| **Diagnostics** | `ai-triage` | **DECORATIVE** as “AI” | Weighted heuristics, **not Claude**. Empty-schedule CTA used to link **Profile** (**fixed** → Equipment Schedule). |
| **Rundown** | `rundown` | **PARTIAL** | Sprint 1 + display shares + calm UX. Buried under More. PCO-sourced plans cannot sync. |
| **Commands** | `commands` | **PARTIAL** | Catalog / send; needs connected agent. |
| **Billing** | `billing` | **PARTIAL** | Stripe Checkout / Customer Portal / tiers. Copy vs founding rate. Referrals = sales. Reactivate/return URLs used marketing `/portal` **404** (**fixed**). Enterprise (`managed`) is custom — code refuses self-serve reactivate. **Event** tier exists in Stripe, barely named in the help box. |

### Settings (sidebar footer)

| Control | Status | Notes |
|---------|--------|-------|
| Theme / language | **PARTIAL** | `en` / `es`. Many strings still English-only. |
| **Church Profile** | **WORKING** after this PR | Was `page-profile` with **no nav**. Timezone, Telegram chat ID, password, email prefs, church vs one-time event. |
| Simple / Advanced | **WORKING** | Schedule overview card is no longer `advanced-only`. |
| Sign out | **WORKING** | `POST /api/church/logout` |

---

## 3. Sunday path vs competing nav

Desired path:

```
Login → Home (connect booth) → Equipment / Schedule → Alerts (Slack) + Profile (Telegram)
      → Rundown (Go Live / shares)
```

What a new church actually sees:

1. **Onboarding checklist:** download app, Telegram `/register`, test alert, invite team. **No “set service windows” step.**
2. **Home** is a dashboard of kit, not a wizard. Schedule card helps after this PR.
3. **Alerts** and **Rundown** sit behind **More** (same rank as Network, Reports, Commands, Billing).
4. **Telegram chat ID** is on Profile (Settings), while Slack is on Alerts. Two channels, two rooms.
5. **Simple view** used to hide the schedule card entirely (operators who stay on Simple never saw windows).

Footguns:

- Saving schedule **looked** successful while `ScheduleEngine` kept the **boot-time empty cache** → `isServiceWindow() === false` → non-EMERGENCY alerts logged only until process restart. **Fixed:** `applyPortalSchedule` dual-writes `schedule` + `service_times` and hydrates the cache. Engine still **prefers `service_times`** if both exist.
- TD EventSource **401** because SSE required `church_portal` only. Operators (the people on Sunday) got a stale Home. **Fixed.**
- AI Triage “Set up your schedule” → Profile, which has **no schedule UI**. **Fixed.**
- Empty windows remain **silent Sunday by design**. Portal help on the Schedule tab is honest; onboarding is not.

---

## 4. Billing UX vs Stripe

Code tiers (`src/billing.js`): **connect / plus / pro / managed (Enterprise) / event**.

| Portal says | Stripe / code |
|-------------|---------------|
| Connect $79/mo or $49 founding | Price IDs from `STRIPE_PRICE_*`. Founding $49 is **marketing vs env** — not verified against Dashboard this session |
| Plus $149 / Pro $199 / Enterprise custom | Matches `TIER_NAMES`. Enterprise self-serve reactivate **throws** (contact support) — correct |
| Event | `STRIPE_PRICE_EVENT` one-time; Profile can mark `church_type=event`. Help box barely mentions Event as a product |
| Stripe Customer Portal | Built if `stripe_customer_id` exists. Return used to be origin **or marketing homepage**; now `/church-portal` |
| Reactivate after cancel | Checkout `success_url` / `cancel_url` were `tallyconnect.app/portal` (**live 404**). **Fixed** to `RELAY_URL/church-portal` |
| Referrals on Billing | “Give a month, get a month” — **sales**. Leave in place; do not grow in prepare mode |

Trial / webhook / `TALLY_REQUIRE_ACTIVE_BILLING` are covered in the feature audit. This review did not open Stripe.

---

## 5. Alerts (Telegram / Slack) and service windows

See [`ALERTS_REVIEW.md`](ALERTS_REVIEW.md) for engine truth.

Portal-specific:

| Control | Where | Who can write |
|---------|-------|----------------|
| Telegram chat ID + notification toggles | **Profile** | Church admin (`PUT /api/church/me`) |
| Slack incoming webhook | **Alerts** | Church admin (`PUT /api/church/slack`) |
| Service windows | **Equipment → Schedule** | Church admin (`PUT /api/church/schedule`) |
| On-call / TD Telegram | **Team** (TD records) | Church admin |

Empty `schedule` / `service_times` → `isServiceWindow === false` → non-EMERGENCY **logged only**. That is the product rule, not a bug. The bug was **telling the church the schedule was saved when the engine never saw it.**

Timezone / event-church window: Profile save now calls `applyChurchWindowConfig` so cache matches DB without restart.

---

## 6. Security

| Area | Verdict |
|------|---------|
| Session storage | **WORKING** — httpOnly cookie, not `localStorage` (unlike admin SPA `sessionStorage`) |
| CSRF | **WORKING** — double-submit on cookie mutating routes |
| XSS | **PARTIAL** — `escapeHtml` used in many renders; CSP `script-src-attr 'none'` **blocks** remaining inline `onclick`/`onchange` (TD access dropdown, VideoHub confirm, Companion fields, onboarding copy, rundown retry, print). Those controls **do not work** until converted to `data-action` |
| SSE token | **WORKING** after this PR — cookie, not query string (admin HLS still differs) |
| TD privilege | **PARTIAL** — UI hide ≠ API. TD admin cannot mutate church-admin routes (safe). TD viewer can still **open** Alerts/Rundown by URL/`showPage` if they know the page id |
| Guest tokens | **PARTIAL** — 24h, Telegram redeem; listed in Team |
| Helmet | `script-src` includes `'unsafe-inline'` (legacy tools pages). Portal JS is an external file (`?v=` hash) |

No secrets in this doc. No portal browser Sentry DSN wired.

---

## 7. Mobile / polish / empty states

| Surface | Notes |
|---------|-------|
| Viewport | `viewport-fit=cover`, hamburger + overlay. Usable; not a native app. |
| Zero rooms | Full-screen gate — **WORKING** and correct (mirrors Electron). |
| Never connected | Home “Connect the Tally Desktop App” — **WORKING** empty state. |
| Empty schedule | Schedule tab + (now) overview card + Diagnostics link. |
| Empty Slack | Alerts card “Not connected.” |
| Network / Analytics / Reports | Empty copy until a booth + sessions exist — honest, but they still occupy **More**. |
| i18n | Toggle exists; large share of Rundown/Alerts/PCO strings are English-only. |

Authenticated portal clicks were **not** run (no church session). HTML + API tests cover the P0 patches.

---

## 8. Inventory — BROKEN vs PARTIAL vs WORKING vs DECORATIVE

| Surface | Status |
|---------|--------|
| Login + cookie session | **WORKING** |
| Forgot password (marketing) | **WORKING** (#152) |
| Legacy `/portal/reset-password` | **BROKEN** (404, unused by current emails) |
| Email verification redirect | **WORKING** (code) |
| Home kit / protection | **UNPROVEN** |
| Equipment rooms | **WORKING** (code) |
| Schedule save → alert windows | **BROKEN → WORKING** (this PR) |
| Profile (timezone, Telegram ID) | **BROKEN (unreachable) → WORKING** |
| SSE for TDs | **BROKEN → WORKING** |
| Slack self-serve | **WORKING** (code, #148) |
| Telegram from Alerts page | **DECORATIVE** (wrong room; real control is Profile) |
| Rundown + display shares | **PARTIAL** (buried; PCO dead) |
| PCO OAuth / PCO rundowns | **DECORATIVE** in prod |
| AI Assistant chat | **PARTIAL** (Claude; unproven) |
| AI Triage / Diagnostics | **DECORATIVE** as AI (heuristics) |
| Billing checkout | **PARTIAL** (copy vs founding; Enterprise custom) |
| Billing return / reactivate URLs | **BROKEN → WORKING** (this PR) |
| Referrals | **DECORATIVE** in prepare mode (sales) |
| Commands / Network / Analytics | **UNPROVEN** |
| Guest TD portal login | **DECORATIVE** (Telegram only) |
| Idle timeout | **DECORATIVE** (does not exist) |
| Portal Sentry | **DECORATIVE** (does not exist) |

---

## 9. Prioritized improvements

Aligned with prepare mode: reliability, trust, calm — not sales.

### P0 — Sunday-critical (shipped here unless noted)

1. **Hydrate `ScheduleEngine` on portal schedule (and timezone) save.** Empty cache = silent Sunday after a cheerful toast. **Done.**
2. **Allow `td_portal` on `GET /api/church/stream`.** Operators must see live status. **Done.**
3. **Reachable Profile + Schedule links that open Equipment → Schedule.** **Done.**
4. **Show schedule card in Simple view.** **Done.**
5. **Stripe return / reactivate URLs → `/church-portal`, not marketing `/portal`.** **Done.**
6. **Connect one dogfood booth** (Cogcomm or LCC) and leave it up. Portal Home/SSE/alerts cannot be proven at `connectedChurches: 0`. **Andrew — not code.**
7. **Do not leave service windows empty** on dogfood. Empty = silent by design. **Andrew.**

**Not re-fixed:** password-reset 404 (already #152). `PCO_CLIENT_*` (needs real OAuth app). AI Triage is not Claude (honesty is #157).

### P1 — same week, not during service

1. **Promote Alerts + Rundown out of More** (primary nav). Network/Reports/Commands can stay collapsed.
2. **Onboarding checklist step: set service windows** (link to Schedule tab).
3. **Put Telegram chat ID (or a deep link to Profile) on the Alerts page** so both channels live together.
4. **Replace remaining inline `onclick`/`onchange`** with `data-action` so CSP `script-src-attr 'none'` does not kill TD access, VideoHub, Companion, rundown retry.
5. **Enforce TD `access_level` on the API** *or* stop calling TD-admin “Admin” in the UI. Today a TD Admin sees Team/Equipment and gets 403.
6. **PCO:** set `PCO_CLIENT_*` + `PCO_REDIRECT_URI` on `api.tallyconnect.app`, or hide the Connect card until then.
7. **Portal browser Sentry** (admin SPA already has a path).
8. **Idle timeout** (e.g. 30 min) for shared booth laptops; keep 7d cookie for “I left it open at church.”
9. **Billing copy:** print the price Stripe will actually charge (founding vs $79).
10. Dual columns `schedule` vs `service_times`: engine prefers `service_times`. This PR dual-writes; a later cleanup should make one source of truth.

### P2 — later

1. Deep-link URLs (`/church-portal?page=rundown`) so Telegram/email can skip More.
2. Viewer/operator nav: hide Alerts/Rundown from viewer if that is the policy, or document that viewers may watch rundown.
3. Complete `es` i18n for Rundown/Alerts.
4. Commands catalog polish; hide Network/Analytics until `connected`.
5. Guest TD portal (if ever needed) — today Telegram-only is fine.
6. Remove or gate referrals on Billing until GTM is allowed.

---

## 10. Fixed in this PR

| Fix | Why |
|-----|-----|
| `ScheduleEngine.applyPortalSchedule` + `applyChurchWindowConfig` | Portal `PUT /schedule` / `PUT /me` now update the in-memory window cache **and** `service_times`, so Sunday pages can fire without a relay restart. |
| `churchIdFromPortalSession` on `GET /api/church/stream` | TDs (`td_portal`) subscribe to the same live snapshot as church admins. |
| Settings → **Church Profile** | Timezone, Telegram chat ID, password, event mode were stranded on a page with no nav. |
| Overview Edit + AI Triage “Set up your schedule” → `rooms` + `tab-schedule` | Profile has no schedule UI. `showPage` honors `data-tab`. |
| Overview schedule card not `advanced-only` | Simple view is the default; hiding windows hid the Sunday path. |
| Stripe Customer Portal `return_url`, reactivate Checkout URLs, cancel-email CTA | Marketing `tallyconnect.app/portal` is a live **404**. Canonical app is `/church-portal` on the API host. |
| Tests | `scheduleEngine.queryClient`, `church-portal` (schedule + HTML + reactivate URLs), `portalStream` (admin vs TD). |

**Still out of scope:** nav IA (Alerts/Rundown out of More), PCO secrets, TD API RBAC, inline-handler CSP, portal Sentry, idle timeout, connecting a booth.

---

## 11. What a church should use today

**Good for today (even with 0 booths):**

- Sign in at `https://api.tallyconnect.app/church-login`
- Create the first room (gate)
- Set **Equipment → Schedule** windows (required for alerts)
- Settings → **Church Profile**: timezone + Telegram chat ID
- **More → Alerts**: Slack webhook if they asked (not sales)
- **More → Team**: TD passwords / guest Telegram tokens
- **More → Billing**: manage Stripe (after this PR, return lands on the portal)

**Need a connected booth to mean anything:**

- Home kit / Stream Protected / live SSE
- Rundown Go Live that talks to the switcher
- Network, Analytics, Commands, Diagnostics events

**Do not trust yet:**

- PCO “Connect” as a Sunday rundown source
- Diagnostics as “the AI will fix it”
- Billing dollar amounts without checking Stripe
- A TD account labeled Admin for schedule/Slack/profile writes — use the church portal email

**Do not use portal for:**

- Platform ops (that is `/admin/`)
- Dealer fleet (that is `/reseller-portal`)
- Claiming Cogcomm/LCC are live until `connectedChurches ≥ 1`

---

## 12. Validation

Unauthenticated live HTTP (2026-09-09):

```
GET  https://api.tallyconnect.app/api/health              200  6 registered / 0 connected  build d21b662
GET  https://api.tallyconnect.app/church-login            200
GET  https://api.tallyconnect.app/church-portal           302 → /church-login
GET  https://tallyconnect.app/forgot-password             200
GET  https://tallyconnect.app/reset-password              200
GET  https://tallyconnect.app/portal/reset-password       404  (legacy)
CSP  script-src-attr 'none' on church-login
```

Relay unit tests in this PR: `tests/scheduleEngine.queryClient.test.js`, `tests/church-portal.test.js`, `tests/portalStream.test.js`.

Authenticated portal UI and a connected booth were **not** exercised.

---

*Review date: 2026-09-09. Relies on repo + unauthenticated live HTTP + Railway **variable names** from prior audits (no values). No secrets invented. Authenticated church clicks were not run.*
