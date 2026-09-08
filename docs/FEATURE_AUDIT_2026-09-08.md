# Tally Feature Audit — 2026-09-08

**Repos:** `peterdisbrow/tally` (this repo) + live `tallyconnect.app` / `api.tallyconnect.app`  
**Landing:** `peterdisbrow/tally-landing` (Vercel; not in this monorepo)  
**Method:** no assumptions. Repo + OpenAPI + live HTTP + Railway env *names* + GitHub releases.  
**Probe window:** 2026-09-08 22:59–23:08 UTC  
**Local HEAD:** `cedd192` (`main`)  
**Deployed relay:** `1.1.67` build `48a16e1f6afc5a5eceed2a01fbbeccf6fc78bba0` (Railway + Cloudflare)

This audit answers: *what would Andrew reasonably think ships, and what actually answers in production?*

---

## Status legend

| Status | Meaning |
|--------|---------|
| **WORKS** | Route/UI/code exists **and** a live probe or production config confirms the path is up |
| **PARTIAL** | Implemented, but env-gated, version-skewed, tier-gated, or missing a production dependency |
| **BROKEN** | Live evidence of failure, stale artifact, or a confirmed dead path |
| **CODE_ONLY** | Implemented in repo (often with tests) but not published, not configured, or not reachable in prod |
| **MARKETING_ONLY** | Claimed on tallyconnect.app (or README) without a shipped production path |

Device integrations that only run on a booth LAN are marked **WORKS (code + tests)** when the native stack is complete. They cannot be proven live while **0 churches are connected**.

---

## Production snapshot (live)

| Check | Result | Evidence |
|-------|--------|----------|
| Marketing site | `200` Next.js on Vercel + Cloudflare | `GET https://tallyconnect.app/` title: *Tally \| Church Streaming Auto-Recovery & Production Monitoring* |
| Relay API | `200` Railway (`x-railway-edge: sjc1`) | `GET https://api.tallyconnect.app/api/health` |
| Relay version | `1.1.67` / healthy / DB ok (4 ms) | health JSON |
| Registered churches | **7** | health `registeredChurches` |
| Connected churches | **0** | health `connectedChurches`, `controllers: 0`, `totalMessagesRelayed: 0` |
| Redis coordination | enabled | health `realtime.coordination.enabled: true`, `instanceId` present |
| Public status JSON | operational, 0 connected | `GET /api/status` |
| Status components | all 6 operational | `GET /api/status/components` — relay, portal, admin proxy, Telegram webhook, password-reset email, Stripe webhook |
| Recent incidents | Telegram webhook flapping; admin proxy 404s against `tallyconnect.app` | `GET /api/status/incidents` (50 rows; latest ids 795–784) |
| WebSocket | **101 Switching Protocols** | `wss://api.tallyconnect.app/` with Origin `https://tallyconnect.app` |
| OpenAPI | live YAML `1.1.0` (doc version ≠ product version) | `GET /api/docs` → 103,012 bytes |
| Signup onboard | live validator | `POST /api/church/app/onboard {}` → `400 name required` |
| Stripe webhook | live + keys configured | `POST /api/billing/webhook` → `400 Missing stripe-signature header`; status component *Stripe keys configured* |
| Telegram bot | webhook OK | status component *Webhook OK (https://api.tallyconnect.app/api/telegram-webhook)* |
| Email provider | configured (Resend key present) | status component *Email provider configured*; Railway `RESEND_API_KEY` |
| RTMP public hostname | `api.tallyconnect.app:1935` **closed** | TCP probe timeout |
| RTMP Railway proxy | **open** | `gondola.proxy.rlwy.net:50201 → :1935` ACTIVE |
| Marketing `/status`, `/docs`, `/login`, `/pricing` | **404** | landing Next.js |
| Church portal | live on API host | `https://api.tallyconnect.app/church-login` `200`; `/church-portal` redirects to login |
| Admin | live | `https://api.tallyconnect.app/admin/` `200` |
| How-to | live on API host (21 slugs) | `https://api.tallyconnect.app/how-to` |
| Desktop downloads | page claims **1.1.67 Signed + Notarized** | `https://tallyconnect.app/download` |
| Windows installer | `Tally-Setup-1.1.67.exe` + `latest.yml` version **1.1.67** | GitHub release `v1.1.67` (published 22:57 UTC) |
| Mac updater metadata | `latest-mac.yml` version **1.1.66**, date **2026-05-05** | same `v1.1.67` release |
| Abuse record | spam church name in public health | `"🍀15.000 TL bonus seni bekler! https://bit.ly/bigtrspin 🎁"` |

**Church names in prod health:** `disbrow`, `Smoke UI 1771993963`, `LCC`, `Cogcomm`, `test`, `csrf-test3`, plus the spam row. None connected; none have `lastSeen`.

---

## Railway production env (names only)

Project `ATEMSchool-Tally` / service `tally` / env `production`. **70 variables.** Values were not read.

**Present (feature-relevant):** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, all `STRIPE_PRICE_*` including annual + event + managed, `RESEND_API_KEY`, `TALLY_BOT_TOKEN`, `TALLY_BOT_WEBHOOK_URL`, `TALLY_BOT_WEBHOOK_SECRET`, `YOUTUBE_CLIENT_ID/SECRET`, `FACEBOOK_APP_ID/SECRET`, `ANTHROPIC_API_KEY`, `REDIS_URL`, `UPSTASH_REDIS_REST_*`, `RTMP_ENABLED`, `RTMP_PORT`, `RTMP_PUBLIC_URL`, `RELAY_PUBLIC_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, `SESSION_SECRET`, `ADMIN_API_KEY`, `ADMIN_SEED_*`, `ANDREW_TELEGRAM_CHAT_ID`, `CHAT_PROXY_SECRET`.

**Absent (confirmed missing from the 70 names):**

| Variable | What it gates |
|----------|----------------|
| `SENTRY_DSN` | Relay error tracking (`server.js` only inits if set) |
| `FIREBASE_SERVICE_ACCOUNT` / `_PATH` | FCM / mobile push |
| `ALERT_BOT_TOKEN` | Alert engine, pre-service, health crons, offline detection, sync monitor |
| `FROM_EMAIL` | Falls back to `Tally <noreply@tallyconnect.app>` |
| `UNSUBSCRIBE_SECRET` | Unsubscribe token signing |
| `PCO_CLIENT_ID` / `PCO_CLIENT_SECRET` | Planning Center OAuth |
| `ADMIN_TELEGRAM_CHAT_ID` | Code also accepts `ANDREW_TELEGRAM_CHAT_ID` (present) |

`RTMP_ENABLED` exists as a name; public `:1935` on `api.tallyconnect.app` is closed. Ingest is only proven on the Railway TCP proxy hostname.

---

## 1. Auth / admin / church portal / TD roles / guest TD

| Feature | Status | Evidence |
|---------|--------|----------|
| Admin login + JWT RBAC | **WORKS** | `POST /api/admin/login` live `400 Email and password are required`; `src/routes/adminAuth.js`; roles `super_admin / admin / engineer / sales` in `src/routes/authMiddleware.js`; admin SPA `admin/src/` served at `/admin` |
| Admin user CRUD | **WORKS** | OpenAPI `/api/admin/users*`; `admin/src/components/UsersTab.jsx`; tests `tests/adminAuth.test.js` |
| Legacy `x-api-key` | **WORKS** | OpenAPI `AdminApiKey`; `ADMIN_API_KEY` set in Railway |
| Church portal login (admin + TD) | **WORKS** | Live `/church-login` `200`; `POST /api/church/login`; `src/churchPortal.js` dual path (church admin then TD); cookie session + CSRF |
| Church app / desktop / mobile auth | **WORKS** | Live `POST /api/church/app/login` `400 email and password required`; `POST /api/church/app/onboard` `400 name required`; `src/routes/churchAuth.js` |
| Email verification + password reset | **PARTIAL** | Routes live: `POST /api/church/forgot-password` `400 email required`; `/unsubscribe` `400 Invalid unsubscribe link`; Resend key present; `UNSUBSCRIBE_SECRET` **not** in Railway vars |
| TD roles / room scoping | **PARTIAL** | `church_tds.access_level`, portal nav hide, `tests/admin-td-credentials.test.js`, `tests/room-command-scoping.test.js`. Server enforces admin vs support vs TD on many routes; not a uniform per-permission matrix |
| Guest TD tokens (24h) | **PARTIAL** | `src/guestTdMode.js`; portal Team/Guests UI; Telegram `/start GUEST-…`; `tests/guest-tokens.test.js`. Telegram redemption needs bot (webhook operational). Legacy `gtd_*` tokens deleted on boot |
| Paid-access WS gate | **PARTIAL** | `checkChurchPaidAccess` in `server.js`; `TALLY_REQUIRE_ACTIVE_BILLING` unset (defaults **true** in production) + Stripe enabled |
| Public health church list | **BROKEN** (abuse) | Unauthenticated `/api/health` lists church names including a spam/gambling URL. Open onboard created a junk tenant |

---

## 2. Billing / Stripe trials / tiers / webhooks / portal

| Feature | Status | Evidence |
|---------|--------|----------|
| 30-day free trial, no CC on signup | **WORKS** | Homepage + `/signup` copy; `TRIAL_PERIOD_DAYS = 30` in `src/billing.js`; onboard live |
| Stripe Checkout | **WORKS** (API) | `POST /api/billing/checkout` in OpenAPI + `src/routes/billing.js`; all `STRIPE_PRICE_*` names present in Railway; tests `tests/billing*.test.js` |
| Stripe Customer Portal | **PARTIAL** | `POST /api/billing/portal`; church billing tab builds portal URL only if `stripe_customer_id` exists |
| Stripe webhooks | **WORKS** | Live `400 Missing stripe-signature header`; status component operational since 2026-05-02; `STRIPE_WEBHOOK_SECRET` present |
| Tiers `connect / plus / pro / managed(event)` | **WORKS** (code) | `TIER_LIMITS`: connect 1 room (ATEM/OBS/vMix only), plus 3, pro **5**, managed ∞, event 1 |
| Founding rate $49 Connect | **MARKETING_ONLY** vs code | Homepage: Connect ~~$79~~ **$49**/mo. Price IDs are env-only; not re-verified against Stripe Dashboard in this audit |
| Feature gates | **WORKS** | `requireFeature()` + `billing.checkAccess()`; tests `tests/regression-feature-gating.test.js`. Features: `multi_church`, `planning_center`, `monthly_report`, `autopilot`, `scheduler`, `scheduler_auto`, `reseller_api`, `propresenter`, `oncall_rotation`, `live_preview`, `device_access` |
| Annual billing (−25%) | **PARTIAL** | Signup UI + `STRIPE_PRICE_*_ANNUAL` env names present |
| Event / one-off accounts | **CODE_ONLY** until sold | `src/eventMode.js`; `STRIPE_PRICE_EVENT` present; OpenAPI `/api/events*` |
| Pro room-count copy | **PARTIAL** | Homepage: “5 on Pro”. `TIER_LIMITS.pro.rooms = 5`. Older notes claimed portal said 10; current `portal.js` shows “Up to 5 rooms” |

---

## 3. Desktop Electron (install, auto-update, allowlist, supervisor, agent)

| Feature | Status | Evidence |
|---------|--------|----------|
| Windows download | **WORKS** | `/download` → `Tally-Setup-1.1.67.exe`; `latest.yml` version `1.1.67` (2026-09-08 22:29Z) |
| Windows code signing | **PARTIAL** | `.github/workflows/build-win.yml` signs only if `WIN_CSC_LINK` secret exists; else unsigned + SmartScreen + updater signature failures (`electron-app/src/main.js` ~2562). Not independently verified on the `.exe` |
| Mac download page | **PARTIAL** | Page advertises **1.1.67 Signed + Notarized**. Assets on `v1.1.67` are `Tally-1.1.66-*.zip` + unversioned DMGs |
| Mac auto-update | **BROKEN** (skew) | `latest-mac.yml` **version 1.1.66**, `releaseDate: 2026-05-05`. A 1.1.66 Mac app will not see a 1.1.67 update. Download page version string is wrong |
| Mac CI | **CODE_ONLY** | No `build-mac.yml`. Manual per `.claude/skills/build-release.md` |
| Auto-update engine | **WORKS** (code) | `electron-updater` + GitHub provider `peterdisbrow/tally`; tray “Check for Updates”; `setupAutoUpdate()` in `electron-app/src/main.js` |
| Relay host allowlist | **WORKS** | `electron-app/src/relay-client.js` `ALLOWED_RELAY_HOSTS` includes `api.tallyconnect.app`; tests reject lookalikes |
| Agent supervisor | **WORKS** (code) | Spawn church-client, crash backoff (`MAX_AGENT_CRASHES=5`), 2-min relay disconnect restart; agent `uncaughtException` exits for supervisor |
| Setup wizard / tray / notifications / autostart | **WORKS** (code + tests) | `electron-app/src/{index.html,main.js,autostart.js}`; e2e `test/e2e/app.spec.js`; `test/autostart.test.js` |
| Electron Sentry | **CODE_ONLY** | No Sentry dependency under `electron-app/` |
| Renderer i18n | **PARTIAL** | `en` + `es` locales; tray translated; renderer dashboard still English |
| Lifecycle email Mac link | **BROKEN** | `relay-server/src/lifecycleEmails.js` hardcodes `https://github.com/peterdisbrow/tally/releases/download/v1.0.1/Tally-signed.dmg` (still `200`, but **1.0.1**, not 1.1.67) |

---

## 4. Church-client device integrations

Native stack lives in `church-client/` (bundled into Electron). **318 commands** inventoried in `church-client/docs/tally-available-commands-summary.md`. CI covers church-client tests. **None of these can be proven against a live booth today** (`connectedChurches: 0`).

| Integration | Status | Type | Evidence / caveat |
|-------------|--------|------|-------------------|
| ATEM | **WORKS** (code + tests) | Native `atem-connection` | `switchers/atemSwitcher.js`, `commands/atem.js` (~100 cmds), `test/atem-commands.test.js` |
| OBS | **WORKS** (code + tests) | Native `obs-websocket-js` v5 | `commands/obs.js`, `test/obs-commands.test.js` |
| ProPresenter 7 | **WORKS** (code + tests) | Native HTTP/WS | `propresenter.js`; QA P2: historic reconnect storms |
| Companion (local HTTP) | **WORKS** (code + tests) | Native to Companion 4.x `/api/location/*` | `companion.js`; hardware page still lists Companion **2.x / 3.x** |
| PTZ (ONVIF / VISCA) | **WORKS** (code + tests) | Native | `ptz.js`; changelog “PTZ moved to core” |
| HyperDeck | **WORKS** (code + tests) | Native BMD TCP | `hyperdeck.js` |
| Encoder bridge | **WORKS** (code + tests) | Native multi-vendor | obs, vmix, ecamm, tricaster, blackmagic, aja, epiphan, teradek, birddog, tally-encoder, ndi, rtmp-push, atem-streaming |
| Audio mixers | **WORKS** (code + tests) | Native OSC / TCP-MIDI | X32/M32, Allen & Heath **SQ native** (`mixers/allenheath.js` OSC+MIDI), Avantis, dLive, Yamaha. Hardware page says A&H is “via Companion” — **wrong**; native driver exists |
| Dante | **PARTIAL** | Companion passthrough only | `dante.scene` → `companion.pressNamed('Dante: …')`. Native Dante modules **removed** (`CHANGELOG`) |
| Failover | **PARTIAL** | Relay + client | `signalFailover.js` + `commands/failover.js`. **Auto-recover globally forced off** (`server.js` sets `failover_auto_recover = 0`) to stop bounce loops |
| Recovery / auto-recovery | **PARTIAL** | Relay playbook + client cmds | `src/autoRecovery.js` (24-type, 3 attempts); `commands/recovery.js`. Needs connected agent + per-church flag |
| vMix | **WORKS** (code + tests) | Native TCP | `vmix.js`, 27 commands |
| Resolume | **WORKS** (code + tests) | Native HTTP | `resolume.js` (hardware page says OSC) |
| VideoHub | **WORKS** (code + tests) | Native | `videohub.js` |
| Shelly smart plugs | **PARTIAL** | Native HTTP + mDNS | `shellyManager.js`; portal CRUD; **no dedicated command tests** |
| NDI | **PARTIAL** | Monitor-only | `encoders/ndi.js` needs `ffprobe` + `libndi_newtek` |
| YoloBox | **PARTIAL** | RTMP-push monitor | `encoders/rtmpPush.js`. Hardware page: “network API” — **overclaim**. No official control API (`equipment-tester.js`) |
| Ecamm | **PARTIAL** | Native HTTP | `encoders/ecamm.js`; Bonjour discovery **TODO** (hardcoded port 65194) |
| tally-encoder hardware | **CODE_ONLY** | Separate package | `tally-encoder/` Express `:7070`; no tests/CI; marketing “Tally Box” + Tailscale |

Homepage “23 integrations” is a marketing count. Several listed devices are monitor-only or Companion-indirect.

---

## 5. Relay realtime — WS, alerts, auto-recovery, pre-service, status

| Feature | Status | Evidence |
|---------|--------|----------|
| Church ↔ relay WebSocket | **WORKS** | Live `101`; `src/websocketRouter.js`; tests `tests/websocket-routing.test.js`. End-to-end idle: 0 sockets, 0 queued messages |
| Portal / dashboard SSE | **WORKS** (code) | `GET /api/dashboard/stream`, `GET /api/church/stream`; `src/portalStream.js` |
| Mobile WS | **WORKS** (code) | `src/mobileWebSocket.js` |
| Telegram interactive bot | **PARTIAL** | Webhook operational; `TALLY_BOT_*` set. Natural-language control + guest register implemented (`src/telegramBot.js`) |
| Telegram **alerts** | **PARTIAL** | `src/alertEngine.js` uses `ALERT_BOT_TOKEN` (or per-church token). **`ALERT_BOT_TOKEN` not in Railway vars.** Interactive bot token may not be the alert sender |
| Slack alerts | **PARTIAL** | Admin per-church webhook API `src/routes/slack.js`; tests exist. **No church-portal self-serve Slack UI** (`churchPortal.js` has no slack routes). Homepage sells “Slack + Telegram” as first-class |
| Escalation | **PARTIAL** | Code: **5 minutes** (`300_000` ms) then admin Telegram + email. `SETUP-GUIDE.md` still says **90 seconds**. Homepage says 5 minutes |
| Auto-recovery | **PARTIAL** | Engine + tests exist. Failover auto-switchback **disabled globally**. Needs a connected client — **none** |
| Pre-service check | **PARTIAL** | `src/preServiceCheck.js` T-30 poll; portal trigger; Telegram notify uses `ALERT_BOT_TOKEN`. QA: unguarded `JSON.parse` |
| Public status page | **PARTIAL** | **Works on API host:** `https://api.tallyconnect.app/status` `200`. **Marketing `/status` is 404.** `status.tallyconnect.app` does not resolve |
| Synthetic checks | **WORKS** | 60s `runStatusChecks()`; 6 components all operational at probe time |
| Message queue / rate limit | **WORKS** (code) | Token bucket; Redis present so multi-instance coordination is on |

---

## 6. Rundown (three stacks)

| Stack | Status | Evidence |
|-------|--------|----------|
| **A. Legacy scheduler** (device-command cues) | **PARTIAL** | `src/rundownEngine.js` + `src/scheduler.js`; portal `/api/church/rundowns`, `/api/church/scheduler/*`; gated `requireFeature('scheduler')` (Plus+). Tests `tests/rundown-scheduler.test.js` |
| **B. Manual plans + live sessions** | **PARTIAL** | `src/manualRundown.js`, `src/liveRundownManager.js`, `src/routes/liveRundown.js`; collaboration + CSV. **QA P0 (2026-04-08):** createPlan 500 / BIGINT — “needs deploy verification.” Not re-verified with an authenticated portal session in this audit |
| **C. Public outputs** | **WORKS** | Live: `/rundown/view/:token` serves HTML; `GET /api/public/rundown/invalid` → `404 Link not found or expired` (handler alive). Pages: view, timer, show, confidence, clock, prompter, report, join. WS endpoints + `rundown-sw.js` |
| AI import (PDF / text / image / CSV) | **PARTIAL** | `src/rundown-ai.js`; `ANTHROPIC_API_KEY` **is** set in Railway. Returns 500 if key missing. Untested live (auth required) |
| PCO-sourced rundowns | **CODE_ONLY** in prod | Portal UI treats `source === 'pco'`. **`PCO_CLIENT_*` missing** in Railway — OAuth cannot start |
| Multi-campus rundown | **MARKETING_ONLY** | `campus_id` deprecated (`server.js`); `rundown-multicampus.html` not in repo; plan text in `docs/rundown-fix-plan.md` |
| Homepage “7 output views” + “included in all plans” | **PARTIAL** | Public views exist. Scheduler/live planner is **Plus+ gated**, contradicting “included in all plans” |

---

## 7. Streaming — RTMP, YouTube/FB OAuth, broadcast monitor

| Feature | Status | Evidence |
|---------|--------|----------|
| RTMP ingest (node-media-server) | **PARTIAL** | `src/rtmpIngest.js`; `RTMP_*` env names present; Railway TCP proxy **open** `gondola.proxy.rlwy.net:50201→1935`. `api.tallyconnect.app:1935` **closed**. Churches must use the proxy URL, not the API hostname |
| HLS / signed preview | **PARTIAL** | Routes in `server.js` (`/api/admin/stream/:churchId/live.m3u8`); `live_preview` gated Plus+. Homepage: “requires Tally Box… **In development**” |
| YouTube OAuth | **PARTIAL** | Routes live (`GET /api/church/app/oauth/status` → `401 Bearer required`); `YOUTUBE_CLIENT_*` present; portal + Electron oauth bridge; tests `tests/streamPlatformOAuth*.test.js` |
| Facebook OAuth | **PARTIAL** | Same; `FACEBOOK_APP_*` present. Changelog: scopes reduced to avoid app review |
| Broadcast monitor (YT/FB health) | **PARTIAL** | `src/broadcastMonitor.js` always started; 60s poll; needs per-church OAuth tokens. No connected churches / no live broadcasts to observe |
| CDN “is it actually live” | **WORKS** (code) | Changelog “CDN stream verification”; encoder/RTMP analytics in church-client |

---

## 8. Mobile app (`tally-connect-mobile`)

| Feature | Status | Evidence |
|---------|--------|----------|
| Screens (dashboard, control, alerts, checks, rundown, rooms, analytics, reports) | **CODE_ONLY** | Expo Router app; **not in CI**; no store artifacts |
| Auth | **WORKS** (API) | `POST /api/church/mobile/login` in `src/routes/mobile.js`; client `src/stores/authStore.ts` |
| WebSocket + command queue | **CODE_ONLY** | `src/ws/TallySocket.ts` |
| Push notifications | **CODE_ONLY** | Expo token → `/api/church/mobile/register-device`; relay Firebase **unset** → `[Push] … disabled` |
| EAS / OTA | **PARTIAL** | `eas.json` production profile; `appleTeamId: HVSJPZDLZF`; `versionCode: 1`; projectId present. **No App Store / Play listing found** |
| Sentry | **BROKEN** | `src/lib/sentry.ts` `DSN = 'https://placeholder@sentry.io/0'` — crashes silently dropped (`QA-CHECKLIST` P3) |
| Homepage “from your phone” | **MARKETING_ONLY** as a shipped store app | Church **portal** is mobile-responsive (real). Native app is unpublished |

---

## 9. Resellers / multi-room / multi-campus

| Feature | Status | Evidence |
|---------|--------|----------|
| Reseller admin + API | **PARTIAL** | `src/reseller.js`, `src/routes/reseller.js`; `x-reseller-key`; admin `ResellersTab.jsx`; feature `reseller_api` = **managed only** |
| Reseller self-serve portal | **WORKS** (pages) | Live `https://api.tallyconnect.app/reseller` `200`; `/reseller-portal` → `/reseller-login`. **Landing `/reseller` 302s to Railway** `tally-production-cde2.up.railway.app` |
| Multi-room | **WORKS** (code + tests) | Rooms table, portal Rooms UI, per-room stream keys, TD assignments; `tests/multiroom-*.test.js`; tier caps 1/3/5/∞ |
| Multi-campus / satellite churches | **MARKETING_ONLY** | Homepage “BEST FOR MULTI-SITE” (Tally Box NUC). DB `campus_id` **deprecated**. Today = rooms inside one church tenant |
| Portable config export (multi-campus deploy) | **CODE_ONLY** | Changelog 1.1.1 Electron export/import — not a campus-link product |

---

## 10. Emails (Resend), push (Firebase), Sentry

| Feature | Status | Evidence |
|---------|--------|----------|
| Resend lifecycle sequences | **PARTIAL** | `src/lifecycleEmails.js` (~15 sequence types, hourly cron). `RESEND_API_KEY` present. Status: email provider configured. **Mac download URL in those emails is v1.0.1**. `FROM_EMAIL` / `UNSUBSCRIBE_SECRET` unset (defaults / weak signing) |
| Weekly digest / monthly report | **PARTIAL** | `src/weeklyDigest.js`, `src/monthlyReport.js`; `GET /api/digest/latest` live `401 unauthorized` (route exists). Needs paid/active churches + cron |
| Lead capture | **WORKS** | Live `POST /api/leads/capture` `400 Valid email required` |
| Referral codes | **WORKS** (handler) | `GET /api/referral/TEST` → `{"valid":false}` |
| Firebase / FCM push | **CODE_ONLY** | `src/pushNotifications.js`; Railway has **no** Firebase env |
| Relay Sentry | **CODE_ONLY** | `@sentry/node` in `package.json`; `SENTRY_DSN` **absent** in Railway |
| Mobile Sentry | **BROKEN** | Placeholder DSN |
| Electron Sentry | **CODE_ONLY** | Not integrated |

---

## 11. Marketed on tallyconnect.app and not fully covered above

Probed from `GET /`, `/signup`, `/download`, `/hardware`, `/help`, `/blog`, `/tools/*`, nav, footer.

| Claim / surface | Status | Evidence |
|-----------------|--------|----------|
| “Your stream crashed. Tally already fixed it.” | **MARKETING_ONLY** in prod | 0 connected churches, 0 relayed messages — no live recovery to show |
| Testimonials (Grace Community / Harvest / New Life) | **MARKETING_ONLY** | Named churches are **not** in the 7 registered tenants. Social proof is not backed by this prod DB |
| Signal failover “switches instantly” | **PARTIAL** | Code exists; auto-recover **disabled globally** after bounce loops |
| AI natural-language control | **PARTIAL** | `ANTHROPIC_API_KEY` set; `src/ai-parser.js` + Tally Engineer + Telegram. Needs connected agent |
| AI Autopilot / setup assistant (patch list → mixer/ATEM labels) | **PARTIAL** | `src/onboardingChat.js`, AutoPilot rules; Plus+ gate; vision/CSV parsing needs Anthropic (present) |
| Safety gates for live commands | **WORKS** (code) | `src/stream-guard.js` used by Telegram + scheduler |
| On-call TD rotation | **PARTIAL** | OpenAPI + `telegramBot` swap commands; Plus+ `oncall_rotation` |
| Monthly health reports | **PARTIAL** | Code + 1st-of-month copy; needs email + active churches |
| Post-service debrief → PCO write-back | **CODE_ONLY** in prod | Session debrief routes exist; **PCO env missing** |
| Guest TD 24h tokens | **PARTIAL** | See §1 |
| Live video preview / Tally Box | **PARTIAL** / **CODE_ONLY** | Homepage itself says **in development** + hardware encoder. `tally-encoder/` + HLS routes exist |
| Blackmagic authorized reseller / exclusive pricing | **MARKETING_ONLY** | No reseller-store integration in this repo |
| 15 how-to guides | **WORKS** (undercount) | Live how-to index: **16 article slugs + 5 category pages** |
| Help center | **WORKS** | `https://tallyconnect.app/help` `200` (static articles; some link to API how-to) |
| Blog | **WORKS** | `/blog` + sample post `200` |
| Free tools: Broadcast Clock | **WORKS** | `/clock` `200` (same clock as API `/tools/clock/clock`) |
| Free tools: Checklist | **WORKS** | `/tools/checklist/` `200` |
| Free tools: Production Health Check | **WORKS** | `/tools/healthcheck/` `200` |
| Spanish locale `/es` | **WORKS** | `200` |
| Hardware compatibility matrix | **PARTIAL** | Live `/hardware`. Overclaims: YoloBox “network API”, Companion 2.x/3.x, A&H “via Companion”, Resolume “OSC” |
| Docs at `tallyconnect.app/docs` | **BROKEN** | Marketing **404**. Real docs: `https://api.tallyconnect.app/docs` (HTML) + `/api/docs` (OpenAPI) |
| Status at `tallyconnect.app/status` | **BROKEN** | Marketing **404**. Real: `https://api.tallyconnect.app/status` |
| Companion module in Bitfocus store | **MARKETING_ONLY** | `companion-module-tallyconnect/README.md` “search the store”; `manifest.json` version `0.0.0`; **zero tests, not in CI**; Bitfocus public API not enumerable from this probe |
| Planning Center (homepage logo + sync) | **CODE_ONLY** in prod | Full module + portal cards; **PCO credentials unset** |
| ROI calculator | **WORKS** | Homepage interactive widget (marketing math, not product) |
| Chat proxy / landing AI | **PARTIAL** | `CHAT_PROXY_SECRET` present; `POST /api/chat/stream` in `server.js` |

---

## OpenAPI vs live route inventory

OpenAPI (`/api/docs`, 3.0.3, info.version `1.1.0`) documents the admin/church-app/reseller surface. It is **incomplete** vs the real server:

- **In OpenAPI and live:** health, status, admin auth, church app onboard/login, billing checkout/portal/webhook, churches CRUD, automation, sessions, chat, Slack, Telegram, guest tokens, events, resellers, support tickets, dashboard SSE.
- **Live, mostly missing from OpenAPI:** entire church portal (`/api/church/*` cookie session — rooms, failover, rundowns, scheduler, PCO, OAuth, smart plugs, macros, billing tab, mobile), public rundown, how-to, docs HTML, reseller portal HTML, RTMP/HLS, unsubscribe, leads, referrals.
- **Live validators used in this audit:** see Production snapshot + POST probes (`onboard`, `login`, `leads/capture`, `billing/webhook`, `forgot-password`).

---

## Top 10 reliability gaps (ranked)

1. **Zero connected churches — the product’s core loop is unproven in this production.** Health: 7 registered, 0 connected, 0 controllers, 0 messages. Auto-recovery, failover, pre-service, Telegram alerts, broadcast monitor, and “Tally already fixed it” cannot fire. Several tenants look like smoke/CSRF tests, not Sunday booths.

2. **Mac release is stale and the download page lies.** `latest-mac.yml` is **1.1.66 (2026-05-05)** attached to GitHub `v1.1.67`. `/download` says 1.1.67 Signed/Notarized. Installed Mac apps will not auto-update to 1.1.67. Zip artifacts are still named `Tally-1.1.66-*.zip`.

3. **Onboarding emails ship a 1.0.1 Mac DMG.** `lifecycleEmails.js` `DOWNLOAD_MAC_URL` → `releases/download/v1.0.1/Tally-signed.dmg` (still downloadable). New trials can install a four-month-old (or older) build while the site advertises 1.1.67.

4. **No error tracking in production.** Railway has **no** `SENTRY_DSN`. Mobile DSN is a placeholder. Electron has no Sentry. Sunday-morning crashes will not page anyone.

5. **Push notifications are off.** No `FIREBASE_SERVICE_ACCOUNT`. Mobile register-device can succeed; FCM delivery cannot.

6. **Alert Telegram is likely miswired.** Interactive bot webhook is healthy (`TALLY_BOT_*` set). Alert engine, pre-service, offline detection, and health crons read **`ALERT_BOT_TOKEN`**, which is **not** in Railway. Critical alerts / T-30 checks may silently no-op.

7. **Open signup + public church list = abuse.** Unauthenticated `/api/health` exposes tenant names. One registered church is a Turkish casino spam string. No connected-church filter on the public health payload.

8. **Planning Center is sold and cannot OAuth.** Homepage, help, portal cards, and rundown `source: pco` all exist. `PCO_CLIENT_ID/SECRET` are unset. “Session recaps push into Planning Center automatically” cannot run.

9. **RTMP ingest is on a hidden Railway TCP hostname.** Proxy `gondola.proxy.rlwy.net:50201` is open to `:1935`. `api.tallyconnect.app:1935` is closed. Unless `RTMP_PUBLIC_URL` is that proxy and the portal shows it, churches will fail to publish. Homepage encoder story depends on this.

10. **Failover auto-recover is globally disabled; Slack is not self-serve.** `server.js` forces `failover_auto_recover = 0` after bounce loops. Homepage still leads with instant failover. Slack is admin-API-only while marketing pairs it with Telegram. Combined with gap 1, the “fixes itself” promise is code + copy, not a watched production system.

**Honorable mentions:** unsigned-Win risk (workflow default); JWT fallbacks if seed env ever missing (`QA-CHECKLIST` P0); marketing `/docs` and `/status` 404s; Companion store unpublished (`0.0.0`); multi-campus sold as NUC “multi-site” while campus mode is deprecated; hardware page protocol inaccuracies (YoloBox, Companion version, A&H, Resolume).

---

## What this audit did **not** do

- Log into admin/portal or run Stripe Checkout (no credentials used).
- Install the Windows/Mac binaries or verify Apple notarization / Authenticode on disk.
- Drive ATEM/OBS/etc. on a LAN.
- Read Railway **values** (only names).
- Confirm Bitfocus module-store listing beyond repo claims.
- Confirm App Store / Play Store listings beyond repo `versionCode: 1` and missing CI.
- Re-create a manual rundown to close the April P0 500.

Those are the next proofs after a church actually connects.

---

## Probe appendix (selected)

```
GET  https://tallyconnect.app/                         200  (Vercel HIT, age ~9d cache at first probe)
GET  https://tallyconnect.app/signup                   200
GET  https://tallyconnect.app/download                 200  claims 1.1.67 signed/notarized
GET  https://tallyconnect.app/hardware                 200
GET  https://tallyconnect.app/help                     200
GET  https://tallyconnect.app/blog                     200
GET  https://tallyconnect.app/docs                     404
GET  https://tallyconnect.app/status                   404
GET  https://tallyconnect.app/tools/checklist/         200
GET  https://tallyconnect.app/tools/healthcheck/       200
GET  https://tallyconnect.app/clock                    200
GET  https://api.tallyconnect.app/api/health           200  v1.1.67, 7/0 churches
GET  https://api.tallyconnect.app/api/status           200  operational
GET  https://api.tallyconnect.app/api/status/components 200  6 operational
GET  https://api.tallyconnect.app/api/docs             200  OpenAPI YAML
GET  https://api.tallyconnect.app/status               200  HTML status page
GET  https://api.tallyconnect.app/church-login         200
GET  https://api.tallyconnect.app/admin                200
GET  https://api.tallyconnect.app/how-to               200  16 guides
GET  https://api.tallyconnect.app/reseller             200
WS   wss://api.tallyconnect.app/                       101
POST /api/church/app/onboard                           400 name required
POST /api/church/app/login                             400 email and password required
POST /api/admin/login                                  400 Email and password are required
POST /api/billing/webhook                              400 Missing stripe-signature header
POST /api/leads/capture                                400 Valid email required
TCP  api.tallyconnect.app:1935                         CLOSED
TCP  gondola.proxy.rlwy.net:50201                      OPEN
```

---

*Audit date: 2026-09-08. Docs-only; no product code changed.*
