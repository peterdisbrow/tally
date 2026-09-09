# Tally Admin Dashboard Review

**Audience:** Andrew (platform operator / Chief of Staff), not church TDs.  
**Repo:** `peterdisbrow/tally` @ `origin/main` (`8ffdb1a`)  
**Live probe:** 2026-09-09 00:16–00:17 UTC, read-only. No production credentials used.  
**Deployed relay:** `1.1.67` build `8ffdb1a9ee01d445a10346a27bb3b1a9df88c1ac` (Railway `iad1` + Cloudflare)

This answers: *what is the admin dashboard good for today, what is half-built, and what should we build next so Sunday ops stay calm?*

Companion audit: [`docs/FEATURE_AUDIT_2026-09-08.md`](FEATURE_AUDIT_2026-09-08.md) covers the whole product. This doc is **admin-only**.

---

## Status legend

| Status | Meaning |
|--------|---------|
| **WORKING** | UI + route exist, and a live probe or production config confirms the path is up |
| **PARTIAL** | Implemented, but env-gated, missing a write path, or useless until a church is connected |
| **BROKEN** | Live evidence of failure, or UI/API contract mismatch that prevents the feature from doing its job |
| **DEAD** | Code or API exists with no admin UI (or leftover redirect / unused permission matrix) |

---

## 1. What it is

The **Tally Admin** SPA is the **platform operator console** for Tally staff (Andrew and anyone he invites into `admin_users`). It is **not** the church portal and **not** the reseller portal.

| | |
|---|---|
| **Who** | Platform admin (`super_admin` / `admin` / `engineer` / `sales`). Church TDs do **not** log in here. |
| **Canonical URL** | `https://api.tallyconnect.app/admin/` |
| **Also** | `GET /admin` → 301 `/admin/`. `GET /dashboard` → 302 `/admin`. `GET /admin/login` serves the same SPA (client-side login). |
| **Not on marketing host** | `tallyconnect.app/admin` is not this app. Landing is a separate Vercel repo. |
| **Built how** | Vite React app in `relay-server/admin/` → `npm run build` → `relay-server/public/admin/` (gitignored). Docker stage in repo `Dockerfile` copies the build into the relay image. |

### Auth model

Three overlapping gates. The SPA uses **#1**. Legacy / CLI / Electron / synthetic checks use **#2**. Most `/api/admin/*` panel routes accept **#1 or #2** via `requireAdminSession`.

1. **Admin JWT (SPA)** — `POST /api/admin/login` (`relay-server/src/routes/adminAuth.js`). Rate-limited **5 / 15 min**. Returns `{ token, user }` with `type: 'admin'`, **8h** expiry. Browser stores token + user in **`sessionStorage`** (`tally_admin_token`, `tally_admin_user`). Subsequent calls send `Authorization: Bearer`. `GET /api/admin/me` re-validates.
2. **Legacy `x-api-key`** — `ADMIN_API_KEY` (Railway). Accepted by `requireAdmin` and `requireAdminSession`. Used by Production Smoke-adjacent internals, Electron preview snaps, and the **Admin API Proxy** synthetic check.
3. **HMAC cookie `tally_session`** — leftover in `adminPanel.js` for the **reseller** HTML portal. Admin SPA never sets this cookie. `requireAdminSession` no longer accepts `role === 'admin'` cookies (leftover polish). Treat as **DEAD** for the dashboard Andrew uses.

**First user:** if `admin_users` is empty, boot seeds a `super_admin` from `ADMIN_SEED_EMAIL` + `ADMIN_SEED_PASSWORD` (`server.js` ~1035). Railway also still has `ADMIN_EMAIL` / `ADMIN_PASSWORD` names — those are **not** what the SPA login form posts.

**Roles (UI):** `tabsForRole()` in `admin/src/components/adminStyles.js`.

| Role | Sees |
|------|------|
| `super_admin` | All tabs including Users |
| `admin` | All except Users |
| `engineer` | Churches, Rooms, Alerts, Monitor, Status, Logs |
| `sales` | Churches, Resellers, Outreach |

`canWrite` = `super_admin` or `admin` (hides Add/Delete/Ack/Save in the UI). **Server `ROLE_PERMISSIONS` is mostly unused** — `requireAdmin` / `requireAdminSession` do not check the permission matrix. An engineer JWT can hit write APIs if they know the URL. Only `/api/admin/users*` enforces `requireAdminJwt('super_admin')`.

**CSRF:** church/reseller cookie sessions use double-submit CSRF (`src/csrf.js`). Admin SPA uses Bearer, so CSRF is skipped. That is correct for header auth; it is **not** a cookie session.

**Landing / admin-proxy:** comments mention `x-admin-jwt` for a tally-landing proxy. Railway now has `ADMIN_PROXY_URL`. The **Admin API Proxy** status component probes `GET /api/churches` with `x-api-key` against `ADMIN_PROXY_URL` / `APP_URL` / `api.<APP_URL>`. Live: **operational** via `https://api.tallyconnect.app`. Recent incidents still show brief **404s against `tallyconnect.app`** when the check tries the marketing host first.

**Electron:** does **not** embed this dashboard. `electron-app/src/relay-client.js` uses `adminApiKey` (`x-api-key`) only for `GET /api/admin/churches/:id/preview/latest` and preview commands. That is booth-side preview, not Andrew’s ops UI.

---

## 2. Surface map

Client-side tabs only (no URL routes). Sidebar: `Sidebar.jsx` + `NAV_GROUPS` in `adminStyles.js`. Church drill-down is a modal (`ChurchDetailModal.jsx`).

### Accounts

| Nav | What it does |
|-----|----------------|
| **Churches** | Fleet table: name, portal email, **registration code**, **connection token** (reveal/copy), plan + billing status editors, online/ATEM/encoder/stream chips, last seen, delete. **+ Add Church** registers via `POST /api/churches/register` (name, contact email, portal login, tier, status). Click a name → detail modal. |
| **Resellers** | Integrator accounts: brand, slug, email, church limit, color, activate/deactivate, set portal password, one-time API key reveal. `GET/POST /api/resellers` + `/api/admin/resellers/:id*`. |
| **Users** | Platform staff CRUD (`super_admin` only). `GET/POST/PUT/DELETE /api/admin/users*`. Soft-delete (sets `active=0`). Protects last super_admin. |
| **Rooms** | Cross-church room list (still keyed by `rooms.campus_id` = church id). Add / edit / soft-delete, per-room equipment **Roles**. `/api/admin/rooms*`. |

### Church detail modal (click a church)

| Section | What it does |
|---------|----------------|
| **Overview** | Connection, health score, billing chips, Stripe customer link, equipment, integrations (PCO/YT/FB), onboarding checklist, recent alerts/sessions/tickets/chat. `/api/admin/church/:id/support-view` + `/api/churches/:id/status`. |
| **Rooms** | Per-church rooms + instance/equipment from support-view. |
| **Chat** | Poll church chat (`/api/churches/:id/chat`). |
| **TDs** | Create TDs, set password, portal access, access level, room assignments, on-call. `/api/admin/church/:id/tds*` + `/api/churches/:id/oncall`. |
| **Schedule** | Weekly service windows. `GET/PUT /api/churches/:id/schedule`. |
| **Slack** | Incoming webhook + test. `/api/churches/:id/slack*`. This is the **only** Slack self-serve UI in the product (church portal has none). |
| **Sessions** | Last 20 sessions, timeline, debrief. `/api/churches/:id/sessions*`. |
| **Automation** | Autopilot rules (ProPresenter / timer / equipment match). `/api/churches/:id/automation*`. |
| **Billing** | Tier / status / interval + Stripe ids from support-view. `PUT /api/churches/:id/billing`. |

### Operations

| Nav | What it does |
|-----|----------------|
| **Alerts** | Paginated alert inbox, severity/ack filters, Acknowledge. `/api/admin/alerts`, `POST .../acknowledge`. |
| **Tickets** | Read-only support ticket list + detail modal. `/api/admin/tickets`. No resolve / comment UI (those APIs live under `/api/support/tickets*`). |
| **Emails** | Send history, stats, template catalog/preview/override, resend, custom send. `/api/admin/emails*`. |
| **Monitor** | Live SSE fleet (`GET /api/dashboard/stream?token=`), expand row → HLS preview, RTMP URL/key, regenerate key, equipment tree. `/api/admin/streams`, `/api/admin/stream/:id/key`, support-view. |
| **Status** | Synthetic components + incidents + “Run Checks”. `/api/status/components`, `/incidents`, `POST /api/status/run-checks`, `/api/health`. |
| **Logs** | Per-church agent logs (level + 1h/6h/24h/7d), 30s refresh. `/api/admin/churches/:id/logs`. Empty until a desktop agent ships `church_agent_logs`. |

### Intelligence / Growth

| Nav | What it does |
|-----|----------------|
| **AI Usage** | 30-day token/cost by church and feature. `GET /api/admin/ai-usage`. |
| **Outreach** | AI ghostwriter for DMs/emails. `POST /api/admin/generate` (needs `ANTHROPIC_API_KEY`). |
| **AI drawer** (FAB, all roles) | “Ask Tally” over church state. `POST /api/admin/chat`. |

### Not in the sidebar (APIs exist)

| Capability | Where |
|------------|--------|
| Overview KPIs / MRR | `GET /api/admin/overview` — **DEAD** (no tab) |
| Audit log | `GET /api/admin/audit-log` — **DEAD** |
| Onboarding funnel + nudge | `GET /api/admin/onboarding/funnel`, `POST .../nudge` — **DEAD** |
| Billing analytics | `GET /api/admin/billing`, `/api/admin/billing/analytics` — **DEAD** (billing is inline on Churches) |
| Remote command | `POST /api/admin/church/:id/send-command` — **DEAD** in UI (AI chat may invoke; no Sunday “do this now” button) |
| Support overview | `GET /api/admin/churches/support-overview` — **DEAD** |
| Change-password (self) | `PUT /api/admin/me/password` — **DEAD** in UI |
| Reviews moderation | `/api/admin/reviews*` in `churchPortal.js` — **DEAD** in this SPA |
| AI triage stream | `/api/admin/ai-triage/*` — church portal has a page; admin SPA does not |
| Spam / abuse queue | **Does not exist** |

---

## 3. As built vs intended

| Capability | Status | Evidence |
|------------|--------|----------|
| Login + session | **WORKING** | Live `POST /api/admin/login` `{}` → `400 Email and password are required`; fake creds → `401 Invalid email or password`; 4th dummy → `429`. SPA served `200`. e2e `portal-e2e/tests/07-admin.spec.js`. |
| Role-gated nav | **PARTIAL** | UI hides tabs. Most write APIs accept any admin JWT or API key. |
| Churches list + register + billing + delete | **WORKING** | `ChurchesTab` → `/api/churches`, `/register`, `PUT .../billing`, `DELETE /api/admin/churches/:id`. Smoke workflow also hits `GET /api/churches`. Boot loads all DB churches into memory (`server.js` ~924). |
| Connection tokens in the table | **WORKING** (footgun) | Reveal/copy of the church JWT in the fleet table. Anyone with an admin session can copy a booth token. |
| Church support-view (overview / rooms / health) | **PARTIAL** | Routes + UI exist. Live value is empty until `connectedChurches > 0`. |
| TD onboarding | **WORKING** (code + tests) | `adminPanel.js` TD CRUD; `tests/admin-td-credentials.test.js`. |
| Slack per church | **WORKING** (code) | Admin Slack tab is the product’s Slack config UI. |
| Resellers | **WORKING** (code) | Tab + `/api/resellers`. Self-serve portal is a different surface (`/reseller`). |
| Users | **WORKING** | Super-admin only; last-super-admin guards. |
| Rooms CRUD + roles | **WORKING** (code) | `campus_id` is still the church FK (campus product is deprecated; rooms are not). |
| Alerts inbox + ack | **WORKING** (code) | Empty until alert engine fires. `ALERT_BOT_TOKEN` still **absent** in Railway — Telegram *alerts* may no-op even when the interactive bot is healthy. |
| Tickets | **PARTIAL** | List/detail only. No status change, no reply. Write APIs are `/api/support/tickets/:id`. |
| Emails | **WORKING** | e2e asserts catalog + Preview. `RESEND_API_KEY` present. |
| Monitor SSE | **WORKING** | JWT accepted as `?token=` (`server.js` ~4660). Unauth → live `401`. |
| Monitor HLS / RTMP keys | **PARTIAL** | Routes live. Preview needs an ingest. Empty fleet shows a calm no-booths card (not a black player). `api.tallyconnect.app:1935` is closed; Railway TCP proxy is the real ingest (see feature audit). **0 connected / 0 streams** at original probe time. |
| Status components | **WORKING** | Live: relay, portal, admin proxy, password-reset email, Stripe, Telegram — all operational. |
| Status health stat cards | **BROKEN** → **fixed in this PR** | UI read `health.churches` / `health.connected` / `health.memory`. API returns `registeredChurches` / `connectedChurches` / `memoryUsage`. Cards showed **0 / 0 / —**. |
| `/api/admin/me` profile refresh | **BROKEN** → **fixed in this PR** | API returns a flat user (`tests/adminAuth.test.js`). SPA expected `profile.user`, so role never refreshed after login. Login itself still worked. |
| Agent logs | **PARTIAL** | UI + route. Needs a connected agent shipping logs. Retention copy: 7d / 10k rows. |
| AI usage | **WORKING** (code) | Needs `ai_usage_log` rows. Anthropic key is set. |
| Outreach generate | **BROKEN** → **fixed in this PR** | UI sent `introduction` / `follow_up` / … Server only accepts `cold-dm`, `healthcheck-followup`, `group-reply`, `email` (`server.js` `OUTREACH_TYPE_PROMPTS`). Every Generate clicked **Invalid messageType**. |
| AI chat drawer | **PARTIAL** | Needs Anthropic (present). Useful once churches have state. |
| Spam / junk tenants | **DEAD** | No queue, no hide, no delete-from-health. Public `/api/health` **no longer lists church names** (fixed vs 2026-09-08 audit). Count today: **6 registered, 0 connected**. |
| Sunday command / send-command | **DEAD** | API exists; no ops button. |
| Audit / funnel / overview KPIs | **DEAD** | APIs only. |
| Self password change | **DEAD** | API only. |
| Browser Sentry on this SPA | **WORKING** (code) | `@sentry/react` inits from `VITE_SENTRY_DSN` or `GET /api/admin/client-config`. Confirmed still wired in leftover polish. |

---

## 4. Live probe (read-only)

**Target:** `https://api.tallyconnect.app`  
**No stolen credentials.** Dummy `probe@example.invalid` only.

| Check | Result |
|-------|--------|
| `GET /admin/` | **200** HTML `Tally Admin`, asset `/admin/assets/index-BwQ7C4lB.js`, CSP present, `x-railway-edge: iad1` |
| `GET /admin` | **301** → `/admin/` |
| `GET /admin/login` | **200** same SPA (client login, not a separate HTML form) |
| `GET /dashboard` | **302** → `/admin` |
| `GET /church-login` | **200** “Church Portal — Tally” (different product) |
| `GET /church-portal` | **302** → `/church-login` |
| `GET /reseller` | **200** reseller sales/sign-in (different product) |
| `GET /reseller-login` | **200** |
| `GET /api/health` | **200** `healthy`, v`1.1.67`, build `8ffdb1a…`, **6 / 0** churches, DB 49 ms, Redis coordination on, **no tenant names** |
| `GET /api/status` | **200** operational |
| `GET /api/status/components` | **200** 6 components operational; admin proxy `HTTP 200 via https://api.tallyconnect.app` (101 ms) |
| `GET /api/status/incidents?limit=5` | **200** latest: admin-proxy 404 via `tallyconnect.app` (resolved 2026-09-07); Telegram webhook flaps |
| `GET /api/admin/me` | **401** `unauthorized` |
| `GET /api/churches` | **401** |
| `GET /api/admin/churches` | **401** |
| `GET /api/dashboard/stream` | **401** |
| `POST /api/admin/login` `{}` | **400** `Email and password are required` |
| Dummy password | **401** `Invalid email or password` |
| 4th dummy in a row | **429** (rate limit alive) |

### Production Smoke / `RELAY_ADMIN_*`

Documented in `.github/workflows/production-smoke.yml`:

- Cron every 6 hours + `workflow_dispatch`.
- Public: `GET /api/health`, `GET /api/status/components`.
- If repo secrets **`RELAY_ADMIN_EMAIL`** and **`RELAY_ADMIN_PASSWORD`** are set: `POST /api/admin/login` → `GET /api/churches` + `GET /api/billing` with the JWT.
- If secrets missing: authenticated steps **SKIPPED** (workflow still greens).
- If login fails: warning only (`continue-on-error: true`).

This review did **not** read those secrets and did not run an authenticated production login.

---

## 5. Three portals (do not mix these up)

| | **Admin dashboard** | **Church portal** | **Reseller portal** |
|---|---|---|---|
| **Who** | Andrew / Tally staff | Church admin + TDs | Integrator / AV dealer |
| **URL** | `https://api.tallyconnect.app/admin/` | `…/church-login` → `/church-portal` | `…/reseller` or `/reseller-login` → `/reseller-portal` |
| **Auth** | JWT in `sessionStorage`, 8h | Cookie `tally_church_session` + CSRF, 7d | Cookie `tally_reseller_session` + CSRF, 7d |
| **Job** | Tenant CRUD, billing overrides, TD rescue, Slack, emails, status, logs | Run Sunday: rooms, rundown, alerts, engineer, billing self-serve | Fleet of *their* churches, add church, API key |
| **Nav** | Churches / Resellers / Users / Rooms / Alerts / Tickets / Emails / Monitor / Status / Logs / AI / Outreach | Overview, Rooms, Connections, Support, Team, Alerts, Network, Analytics, Reports, Automation, Engineer, AI triage, Rundown, Commands, Billing | Fleet / Add Church / Account (server-rendered HTML in `adminPanel.js` + `resellerPortal.js`) |
| **Tenant isolation** | Cross-tenant by design | Scoped to one `churchId` | Scoped to `reseller_id` |

If a church emails “I can’t get into admin,” they mean the **church portal**. This dashboard is yours.

---

## 6. Gaps & risks

### Security

- **Authz is UI-deep, not API-deep.** `ROLE_PERMISSIONS` in `authMiddleware.js` is unused on almost every church/billing/delete/command route. Treat every admin JWT as full-power until that is wired.
- **Connection tokens on the Churches table.** A leaked admin session (XSS, shared laptop, screenshot) is a leaked booth credential. Tokens should be reveal-on-demand behind a second click *and* omitted from the default list payload.
- **SSE JWT in the query string** (`/api/dashboard/stream?token=`). EventSource cannot set headers; proxies and Cloudflare logs will see the token. Prefer a short-lived stream ticket.
- **HLS `?token=`** on `/api/admin/stream/:id/live.m3u8` — same class of leak; preview URLs are shareable.
- **`sessionStorage` JWT** survives the tab until close; no idle timeout beyond 8h JWT. No step-up for delete-church / regenerate-key.
- **Cookie CSRF vs Bearer.** Fine for the SPA. Dangerous if anyone later “simplifies” login to a cookie without CSRF.
- **Legacy API key is god-mode** and is what Electron preview and the status proxy use. Rotate if it ever hits chat/logs.
- **Open CORS on some HTML routes** (`access-control-allow-origin: *` on church-login). Admin API JSON still 401s without a token.

### UX footguns

- **Two church-list APIs.** Fleet uses `/api/churches` (runtime map). Logs/Rooms use `/api/admin/churches` (DB, max **200** even if UI asks for 500). They can disagree after a bad deploy.
- **Delete church** is one `confirm()` from cascade-delete (`adminChurches.js` allowlist). No recycle bin. Fine for spam; fatal for LCC.
- **Tickets look actionable** (toolbar, “Actions”) but you can only View.
- **Outreach (before this PR)** looked finished and always failed.
- **Status health cards (before this PR)** always showed 0 churches.
- **Monitor** (before the leftover polish PR) said “Waiting for data…” until SSE connected — easy to read as “broken” on a weekday with 0 agents. Now: connecting / no-booths copy, not a black player.
- **Outreach / Growth** sits next to Sunday ops. North star is prepare-mode, not sales.

### Observability

- **`SENTRY_DSN` is now in Railway** (71 vars vs 70 on 2026-09-08). Relay `@sentry/node` will init (`server.js`). **This admin SPA still has no browser Sentry** — a white-screen in `/admin/` will not page anyone.
- Status page covers relay/portal/proxy/email/Stripe/Telegram. It does **not** cover “is Andrew’s JWT login working?” — that is Production Smoke’s job, and only if `RELAY_ADMIN_*` secrets are set.
- No admin audit *viewer*. Writes may hit `audit_log`; you cannot read them in the UI.
- `ALERT_BOT_TOKEN` still missing — offline / pre-service / health-cron Telegram alerts may silently no-op.

### Ops workflows Andrew needs (and does not have)

A Chief-of-Staff Sunday desk is roughly:

1. **Who is live / who should be live?** Monitor + schedule. Today: Monitor works; schedule is buried in the church modal; no “service window now” filter.
2. **What is on fire?** Alerts + tickets + status incidents. Today: three separate tabs, tickets are read-only, no join to a church’s support-view.
3. **Can I talk to the booth / push a command?** send-command + chat exist as APIs. No “cut to input 2” button. AI drawer is the closest thing.
4. **Is this tenant real or spam?** No abuse queue. Delete is the only tool (and it is irreversible).
5. **Did we email them / are they billed?** Emails tab works. Billing is a dropdown on the fleet table — easy to mis-save `managed` + `active` on a smoke church.
6. **Post-mortem.** Sessions + logs exist but need a connected agent and a past session.

Until a church is connected, items 1–3 cannot be proven in production. That is still the product’s core loop.

---

## 7. Prioritized improvements

Aligned with Tally’s north star: **reliability, calm, prepare-mode — not sales.**

### P0 — Sunday / ops-critical

1. **Get one real church connected and keep it connected.** Admin cannot be “proven” while `connectedChurches: 0`. Everything Andrew cares about (Monitor, logs, alerts, HLS, TD rescue) is dark.
2. **Wire `ALERT_BOT_TOKEN` (or point alert engine at `TALLY_BOT_TOKEN`).** Interactive bot is healthy; alert/offline/pre-service paths likely are not. Sunday pages nobody.
3. **Enforce `ROLE_PERMISSIONS` on write routes** (delete church, billing, regenerate stream key, send-command). UI hiding is not enough if a laptop with an engineer JWT is open.
4. **Stop showing connection tokens in the default fleet table.** Reveal behind an explicit “show secret” that hits a dedicated endpoint; omit `token` from `GET /api/churches`.
5. **Confirm Production Smoke secrets** `RELAY_ADMIN_EMAIL` / `RELAY_ADMIN_PASSWORD` are set and the authenticated job is not silently SKIPPED. That is the only automated “can Andrew still log in?” check.
6. **Tickets: add resolve / in-progress / note** using existing `PUT /api/support/tickets/:id`. A read-only inbox is not triage.
7. **Sentry on the admin SPA** (browser) now that relay DSN exists. A blank `/admin/` on Sunday is otherwise invisible.

### P1 — polish (same week, not during service)

1. **Sunday strip:** “in service window now” + open alerts + connected count on Churches (or a thin top bar). Reuse `/api/admin/overview` instead of leaving it dead.
2. **Spam / test tenant filter:** flag `church_type`, name heuristics, or `billing_status=inactive` + never-seen. Soft-hide from public status forever (already done for names).
3. **Audit log tab** (`/api/admin/audit-log`) — who changed billing, who deleted a church.
4. **Short-lived SSE/HLS tickets** instead of the 8h JWT in the query string.
5. **Self-serve “change my password”** (`PUT /api/admin/me/password`) so seed passwords do not live forever.
6. **Idle timeout** (e.g. 30 min) on the SPA; keep 8h JWT only for smoke/API.
7. **Move Outreach out of the default ops nav** (or hide it for `admin`/`engineer`). Sales can keep it.

### P2 — later

1. Deep-link URLs (`/admin/churches/:id?tab=tds`) so Telegram/email can open the right modal.
2. send-command palette with stream-guard (the API already exists).
3. Onboarding funnel + nudge UI (API exists).
4. Unify `/api/churches` vs `/api/admin/churches` so Logs/Rooms/Churches cannot diverge.
5. Browser tests for Monitor SSE + Status cards (e2e today only covers login + Emails catalog).
6. ~~Retire HMAC `tally_session` + `/admin/login` redirect language in `requireAdminSession`.~~ Done in leftover polish: cookie path no longer grants admin; HTML redirects to `/admin/`. Reseller HMAC cookies unchanged.

---

## 8. Fixed in this PR

Small UI/API contract fixes from the original review, plus the P0/P1 admin dashboard work below.

| Fix | Why |
|-----|-----|
| `StatusTab.jsx` reads `registeredChurches` / `connectedChurches` / `memoryUsage` | Health cards always showed 0 / 0 / — against live `/api/health`. |
| `AdminPage.jsx` accepts flat `/api/admin/me` | Tests and `adminAuth.js` return `{ id, email, name, role }`. Role never refreshed after login. |
| `OutreachTab.jsx` dropdowns match `OUTREACH_TYPE_PROMPTS` | Generate always returned `Invalid messageType`. |

### P0 + P1 landed (2026-09-09)

| Item | What shipped |
|------|----------------|
| **Server-side RBAC** | `requirePermission()` now gates church delete, billing PUT, token reveal/regenerate, reseller writes/password/deactivate, stream-key regenerate, send-command. Engineer/sales JWTs get **403**. Legacy `x-api-key` stays god-mode. Sales no longer has `resellers:write` in `ROLE_PERMISSIONS` (matches `canWrite`). |
| **Connection token hygiene** | `GET /api/churches` and `GET /api/admin/churches` return `hasToken` only. Reveal is `GET /api/admin/churches/:id/connection-token` (`churches:write` + `token_revealed` audit). |
| **Tickets resolve/reply** | Tickets detail can change status (`PUT /api/support/tickets/:id`) and send a note (`POST .../updates`). |
| **Sentry on admin SPA** | `@sentry/react` inits when `VITE_SENTRY_DSN` is set at Docker build, or at runtime from `GET /api/admin/client-config` (`SENTRY_DSN`). No DSN = local admin still works. |
| **Sunday strip** | Top-of-dashboard KPIs from `GET /api/admin/overview`: connected, open unacked alerts, in service window now. |
| **Spam/test filter** | Fleet table soft-hides junk (`isJunk` via name heuristics + never-seen/inactive + `is_test`/`is_spam`). Toggle **Show test/spam**. |
| **Audit log tab** | Sidebar item for `admin` / `super_admin` → `GET /api/admin/audit-log`. |
| **Idle timeout** | 30 min SPA idle clears `sessionStorage` and returns to login. JWT remains 8h. |
| **Change password** | Sidebar → `PUT /api/admin/me/password`. |
| **Outreach nav** | Hidden for `admin` / `engineer`. Kept for `sales` and `super_admin`. |

**Still out of scope:** `ALERT_BOT_TOKEN`, P2 deep links / send-command palette.

### Leftovers closed in a follow-up PR (2026-09-09)

| Item | What shipped |
|------|----------------|
| **Monitor HLS empty state** | Fleet with 0 booths / 0 streams shows a calm empty card (`No booths online`), not “Waiting for data…”. Expanded preview is a dashed idle panel, not a black player. |
| **0 connected copy** | Sunday strip + Churches list say the fleet is dark until a booth runs Tally Connect. Logs empty copy matches. |
| **HMAC `tally_session` admin path** | `requireAdminSession` no longer grants access from leftover `role === 'admin'` cookies. SPA stays Bearer JWT; reseller HMAC cookies unchanged. Unauth HTML redirects to `/admin/` (SPA login). |
| **SPA Sentry** | Confirmed still inits from `VITE_SENTRY_DSN` or public `GET /api/admin/client-config`. No code change. |

Admin SPA is built in Docker at deploy time (`public/admin/` is gitignored). These source fixes ship on the next relay image build. To get browser Sentry from the same Railway DSN without a rebuild, `/api/admin/client-config` reads `SENTRY_DSN` at runtime. Optional Docker build-args: `VITE_SENTRY_DSN` or `SENTRY_DSN`.

---

## 9. What Andrew should use today

**Good for today (even with 0 churches connected):**

- Log in at `https://api.tallyconnect.app/admin/`
- See Status (components + incidents) — this is the “is Tally itself up?” page
- List churches, fix billing, delete junk tenants, copy a registration code
- Create a TD + portal password when a church is locked out
- Set Slack webhooks (church portal cannot)
- Preview / resend lifecycle emails
- Confirm relay health pill in the top bar

**Not good for today (need a connected booth):**

- Monitor live preview, encoder bitrate, ATEM PGM
- Agent logs
- Alerts that mean anything
- Session debriefs

**Do not use admin for:**

- A church running their own service (that is `/church-portal`)
- A dealer managing their fleet (that is `/reseller-portal`)
- Writing sales copy as if it were Sunday prep (Outreach is Growth, and it was broken until this PR)

---

*Review date: 2026-09-09. Relies on repo + unauthenticated live HTTP + Railway **variable names** (no values). Authenticated admin clicks were not run.*
