# Tally Observability review (Sunday ops visibility)

**Audience:** Andrew (platform operator). Church TDs see effects, not this doc.  
**Repo:** `peterdisbrow/tally` @ `origin/main` (`df363df`) plus this PR.  
**Live probe:** 2026-09-09 ~01:44 UTC, read-only. No production credentials used. No secret values printed.  
**Deployed relay:** `1.1.67` build `df363df4fa685d1ca2c81d14f2bbe7d144413a9f` (Railway + Cloudflare). Probe `/api/health`: **6 registered / 0 connected / 0 controllers / 0 messages relayed.** Uptime at probe was **117s** (fresh deploy of #159).

This answers: *if Sunday breaks, does Andrew see it in time — Sentry, health/status, smoke, logs, and a page to his phone — or does it fail silently?*

Companion docs: [`FEATURE_AUDIT_2026-09-08.md`](FEATURE_AUDIT_2026-09-08.md), [`ALERTS_REVIEW.md`](ALERTS_REVIEW.md), [`EMAIL_SYSTEM_REVIEW.md`](EMAIL_SYSTEM_REVIEW.md), [`AI_SURFACES_REVIEW.md`](AI_SURFACES_REVIEW.md), [`CHURCH_PORTAL_REVIEW.md`](CHURCH_PORTAL_REVIEW.md), [`BOOTH_DESKTOP_REVIEW.md`](BOOTH_DESKTOP_REVIEW.md), [`ADMIN_DASHBOARD_REVIEW.md`](ADMIN_DASHBOARD_REVIEW.md), [`BILLING_STRIPE_REVIEW.md`](BILLING_STRIPE_REVIEW.md).

North star: **Sunday-indispensable.** Observability should tell Andrew *the stream is down / pages did not send / Claude is dark* without leaking keys or paging on weekday 0/6 booths.

**Prepare mode.** No sales dashboards proposed. Dogfood (Cogcomm, LCC) cannot be proven live while `connectedChurches: 0`.

---

## Status legend

| Status | Meaning |
|--------|---------|
| **WORKING** | Code + tests, and a live or config probe shows the path can fire |
| **PARTIAL** | Implemented, but env-gated, swallowed, or unused on the Sunday path |
| **BROKEN** | Confirmed miss: silent swallow, CSP block, or UI that cannot show an outage |
| **DEAD** | Code or docs describe a surface that does not emit |
| **UNPROVEN** | Code looks complete; **0 connected churches** / **0 Sentry events** so the live path has not been watched |

---

## Summary verdict

**Partial. The pipes exist. Sunday still fails quietly in several places Andrew would look first.**

Relay Node Sentry is initialized (`SENTRY_DSN` present on Railway). The Sentry org `disbrow-productions-llc` project `tally-relay` has **zero error events in 90 days** — not because the booth is calm (nothing is connected), but because almost every Sunday path `catch`es and logs instead of capturing, and the admin SPA’s Sentry init was **CSP-blocked**. Status components are green on “keys present,” not “did a page arrive.” Telegram “outage” incidents are 60-second `fetch failed` flaps. Health did not say whether Claude was configured.

| Surface | Intent | As built (before this PR) | Sunday-usable? |
|---------|--------|---------------------------|----------------|
| **Relay Sentry** | Crash / unhandled Express errors in Andrew’s inbox | `@sentry/node` init + `setupExpressErrorHandler`. Safety-net handlers logged only. **0 events / 90d** | **UNPROVEN** → captureException on safety net **this PR** |
| **Admin SPA Sentry** | Dashboard JS errors | Init via `/api/admin/client-config` (#151). Helmet `connect-src` had no ingest host → browser envelopes dropped | **BROKEN → fixed** (CSP) |
| **Portal / Electron / church-client Sentry** | Booth + TD browser errors | Portal: no SDK. Booth: **`tally-booth`** + `@sentry/node` this PR (`ELECTRON_SENTRY_DSN`). Mobile placeholder DSN | Portal **DEAD**. Booth **UNPROVEN** until the DSN is baked into an installer |
| **`GET /api/health`** | Load-balancer + Andrew glance | Counts, DB, realtime. **No AI chip.** No tenant names (good) | **WORKING**; AI boolean **this PR** |
| **`GET /api/status` + `/status` page** | Uptime monitor + public HTML | Operational even at 0/6 booths (correct). Components = keys/HTTP, not delivery | **PARTIAL** |
| **Status components** | Synthetic 1-min checks | 7 components. Telegram = interactive webhook. Resend = secret present (webhook created **today**). Admin Status tab mapped `outage` → Unknown | **PARTIAL → P0s this PR** |
| **Production Smoke** | GitHub every 6h | Public health + components **PASS**. Authenticated login/churches/billing **must pass** (secrets required; login failure fails the job). Asserts `aiConfigured` is boolean. Does not assert connected booths | **WORKING** (shallow, honest) |
| **Logs / metrics** | Railway search + `/api/health.realtime` | `LOG_FORMAT=json` on Railway. In-process `runtimeMetrics` on health. No BetterUptime. **Alert delivery** status component + last-success timestamps **this leftover PR** | **PARTIAL → last-send chip shipped** |
| **Page Andrew** | Sunday fail → Telegram | `ANDREW_TELEGRAM_CHAT_ID` set. Health/offline crons + AlertEngine escalation. **No “send failed” page.** Empty service windows = log-only (except EMERGENCY) | **PARTIAL** — see [`ALERTS_REVIEW.md`](ALERTS_REVIEW.md) |

**Do not invent secrets.** `ALERT_BOT_TOKEN` stays unset (falls back to `TALLY_BOT_TOKEN`). This PR does not print `SENTRY_DSN`.

---

## North-star scorecard

Scores are 1–5 against *Andrew can see a Sunday failure without opening Railway logs*. Honesty over live proof: **0 connected churches**; Sentry `tally-relay` error count is **0**.

Pre-fix → post-fix where this PR changed the number.

| Pillar | Score | Why this number |
|--------|-------|-----------------|
| **Reliability** | **3 / 5** | Health/status stay up with 0 booths (correct). Smoke is green. Telegram flaps were false outages (softened). Still no “page delivered” signal. |
| **Trust** | **2 → 3 / 5** | Admin Status tab showed Telegram `outage` as **Unknown**. Health hid AI readiness. Status “operational” means *process/keys*, not *Sunday protected*. |
| **Security** | **4 / 5** | Public health has no tenant names. `aiConfigured` is boolean only. Client-config DSN is designed-public. Helmet now allowlists Sentry ingest (needed for #151 to work). |
| **Polish** | **2 → 3 / 5** | Portal SSE reconnect was silent. Electron tray leftover `/portal` (marketing now **307s**, not 404). Checkout `/billing/success` leftover already fixed in #159. |
| **Observability** | **2 → 3 / 5** | Sentry org is real; events are not. Status page is real; it watches the wrong questions. This PR adds AI chip, CSP, outage color, SSE banner, Resend last-event detail. |

**Overall: ~3.2 / 5 after this PR — Andrew can see process health and AI-configured. Booth JS crashes can reach `tally-booth` once `ELECTRON_SENTRY_DSN` is in the next installer and a Sentry alert pages Andrew. He still cannot prove a Telegram page left.**

---

## 1. Architecture

```
Booth (church-client / Electron)     Portal SPA              Admin SPA
  @sentry/node if ELECTRON_SENTRY_DSN  no Sentry               @sentry/react
  watchdog → WS alert                  EventSource SSE         /api/admin/client-config DSN
           │                              │                         │
           ▼                              ▼                         ▼
Relay (@sentry/node if SENTRY_DSN)
  Express error handler
  unhandledRejection / uncaughtException  → log (+ capture this PR)
  runStatusChecks every 60s → status_components / status_incidents
  AlertEngine → Telegram / Slack / DB
  HealthAlertMonitor / OfflineDetection → Andrew Telegram
           │
           ├─ GET /api/health          public JSON (counts, DB, realtime, aiConfigured)
           ├─ GET /api/status          uptime-monitor enum
           ├─ GET /api/status/components
           ├─ GET /status              HTML
           └─ GitHub Production Smoke  every 6h
```

Sentry org (live): `disbrow-productions-llc`. Projects: **`tally-relay`** (relay), **`tally-booth`** (Electron main + renderer IPC + church-client agent), **`electron`** (leftover sample `ELECTRON-1` / `views.js` — **not** Tally; do not send booth events there).

---

## 2. Sentry coverage

### 2.1 What is initialized

| App | SDK | DSN source | Init | What actually arrives |
|-----|-----|------------|------|------------------------|
| **Relay** | `@sentry/node` ^10 | Railway `SENTRY_DSN` (name confirmed) | `Sentry.init` + `setupExpressErrorHandler` after routes | **UNPROVEN.** 0 error events / 90d. Express handler only sees *unhandled* middleware errors. Business `catch` blocks log and swallow. Safety-net handlers did not `captureException` (**fixed**). |
| **Admin SPA** | `@sentry/react` ^10 | `VITE_SENTRY_DSN` at Docker build, else `GET /api/admin/client-config` | `main.jsx` + ErrorBoundary | **BROKEN** before this PR: Helmet `connect-src` was `'self' wss: ws: worldtimeapi.org`. Browser POSTs to `*.ingest.us.sentry.io` were CSP-blocked. **Fixed.** |
| **Church portal** | none | — | — | **DEAD.** Vanilla JS. Not a one-liner (needs SDK + CSP + a public DSN endpoint). SSE `onerror` was silent (**banner this PR**). |
| **Electron / church-client** | `@sentry/node` ^10 | `ELECTRON_SENTRY_DSN` (preferred) or `SENTRY_DSN`; packaged builds bake via `beforePack` | Main + agent init if DSN set; renderer `window.onerror` → IPC (sandbox / no bundler, so not `@sentry/electron`). Unset DSN = no-op. | **UNPROVEN** until a packaged build with the GitHub/Mac Studio secret ships. `electron` project is leftover noise. |
| **Mobile** | `@sentry/react-native` | Hard-coded `https://placeholder@sentry.io/0` | `initSentry()` in `_layout.tsx` | **DEAD** in prod. `enabled: !__DEV__` but placeholder DSN. |

`GET /api/admin/client-config` is **public** by design (DSN is a client key). Live probe returned a US ingest DSN for project `4512053482422272`. **Do not copy DSNs into docs or tickets.**

### 2.2 Silent-catch inventory (Sunday-relevant)

These are representative, not exhaustive. Pattern: `catch { }` / `catch (e) { log/console }` **without** Sentry.

| Where | What is swallowed | Sunday risk |
|-------|-------------------|-------------|
| `alertEngine.sendTelegramMessage` | Non-OK Telegram HTTP → `console.error` only | **Page did not arrive; Andrew is not paged about the miss** |
| `alertEngine.sendSlackResolution` | fetch throw → console | Resolution never hits Slack |
| Portal `es.onerror` | Reconnect with no UI | TD thinks kit is live while SSE is dead |
| Portal `es.onmessage` inner `catch {}` | Malformed SSE JSON | Live cards freeze |
| `server.js` scheduler Telegram `.catch(() => {})` | TD notify fail | Rundown ping dropped |
| `runStatusChecks().catch(console.error)` | Synthetic monitor fail | **Shipped leftover:** `reportStatusCheckFailure` → `Sentry.captureException`. Per-check fetch flaps stay **degraded** on `/status` (Telegram #160). Admin `POST /api/status/run-checks` also captures. |
| church-client / Electron | Uncaught + renderer IPC → `tally-booth` when DSN set | Sunday booth crash can page Andrew once `ELECTRON_SENTRY_DSN` is in the installer secret and a Sentry alert exists |
| `healthAlerts._getActiveChurches` | SQL throw → `[]` | Daily churn cron silently no-ops |

Relay Sentry will still stay quiet on booth/portal SDK-less paths and other business catches. Status-check throws, AlertEngine send failures (#164), and Resend failure webhooks now capture.

---

## 3. Health, status, smoke

### 3.1 `GET /api/health` (and `/health`)

Live (01:44 UTC): `healthy`, v`1.1.67`, build `df363df…`, **6 / 0**, DB 41 ms, Redis coordination on, **no tenant names**.

`overallStatus` correctly **ignores** weekday 0/6 connected ratio (see `healthRoutes.test.js`).

**Missing (before this PR):** whether Claude can run. Clients learned that only when a feature 503’d. **This PR** adds `aiConfigured: boolean` (trim of `ANTHROPIC_API_KEY`; never the value). Railway **has** the key → expect `true` after deploy.

`/health/deep` writes `_health_probe` then deletes. Fine for a 5-min monitor; not a k8s liveness probe.

`GET /api/status`: `operational` with `connected_churches: 0`. Fresh restart (`uptime ≤ 30`) is `degraded`. Outage HTTP 503 is documented but **not** driven by booth count.

### 3.2 Status components (1-minute cron)

Live at probe (all **operational**):

| Id | What it actually checks | Honesty |
|----|-------------------------|---------|
| `relay_api` | Process is up | True tautology |
| `church_portal` | `GET http://127.0.0.1:$PORT/church-login` | Login HTML, not SSE |
| `admin_api_proxy` | `GET {APP_URL,api.*}/api/churches` + admin key | Historic **404 via tallyconnect.app** incidents; now 200 via `api.tallyconnect.app` |
| `telegram_bot_webhook` | Telegram `getWebhookInfo` URL vs `TALLY_BOT_WEBHOOK_URL` | **Interactive** webhook only. Not AlertEngine send. Flaps were `fetch failed` → **outage** for 60s |
| `password_reset_email` | `RESEND_API_KEY` present | Not a send probe |
| `resend_webhook` | `RESEND_WEBHOOK_SECRET` present | Webhook **created 2026-09-09 00:59 UTC** (Resend API). Incident 796: secret missing then set. **No last-event** until this PR |
| `stripe_webhook` | Secret + webhook secret present | Not last Stripe event |

**This PR adds** `ai_assistant` (key present → operational / else degraded) and Resend detail `last event …` / `no events since process start`. Telegram: retry once, **degraded** on API unreachable, **degraded** if `last_error_date` < 10 min.

Public `/status` HTML already styles `outage`. **Admin `StatusTab.jsx` did not** — it looked for `down`, so Telegram outages rendered **Unknown / muted**. **Fixed.**

### 3.3 Production Smoke

`.github/workflows/production-smoke.yml`: cron `17 */6 * * *` + `workflow_dispatch`.

Latest run `34288236425` (2026-09-08 22:55 UTC): **success** in ~14s. Logs show `RELAY_ADMIN_PASSWORD` set and authenticated `login` / `churches` / `billing` **PASS**. Public health + components **PASS**.

**Honesty (follow-up):** missing `RELAY_ADMIN_*` secrets or a failed admin login **fails the job** (no `continue-on-error`, no silent skip). Public health asserts `aiConfigured` is a boolean — never the key, and not “must be true.” Password and JWT are not logged.

**Gaps:** still does not fail on `aiConfigured: false`, `connectedChurches`, Telegram state, or Resend last event.

CI (`.github/workflows/ci.yml`) is unit coverage on PR paths — **WORKING**. No Sentry/uptime job.

---

## 4. Logs, metrics, paging Andrew

| Channel | Reality |
|---------|---------|
| **Railway logs** | `LOG_FORMAT` **is set** (`json`). `createLogger` emits `{ ts, level, scope, msg, ...ctx }`. Searchable if Andrew uses Railway. |
| **`/api/health.realtime`** | Event-loop, socket counts, 1m rates, Redis coordination. **WORKING** as a scrape target. Nothing pages on it. |
| **BetterUptime / Pingdom** | **Not in repo.** `/api/status` is built for them; no evidence they are wired. |
| **Sentry alerts** | No issues to fire on `tally-relay`. Admin browser events never arrived (CSP). |
| **Andrew Telegram** | `ANDREW_TELEGRAM_CHAT_ID` **set**. Also accepted: `ADMIN_TELEGRAM_CHAT_ID` (unset). Used by AlertEngine escalation, `healthAlerts` daily 07:00, `offlineDetection` 2h/24h, `syncMonitor`, monthly report. |
| **Church TD Telegram** | AlertEngine + failover bypass. Needs service window + chat id. **0 connected** → cannot prove. |
| **“Did the page arrive?”** | **No.** `sendTelegramMessage` logs HTTP errors and returns. No status component, no Sentry, no Andrew ping on send failure. [`ALERTS_REVIEW.md`](ALERTS_REVIEW.md) P1-9. |

Empty service windows still make non-EMERGENCY alerts **log-only**. That is by design and will look like “observability is fine” while Sunday is unprotected.

---

## 5. Named gaps (from the recipe)

| Gap | Finding | This PR? |
|-----|---------|----------|
| **Portal SSE silent fail** | `EventSource.onerror` closed + backoff, no UI | **Yes** — `Reconnecting…` / amber staleness (skip when `document.hidden`) |
| **“Did the page arrive?”** | AlertEngine send is fire-and-forget | **Leftover PR** — `alert_delivery` status component (last Telegram/Slack HTTP ok) + Sentry + Andrew Telegram after 3 consecutive failures |
| **AI readiness chip** | Health/status silent on Anthropic | **Yes** — `aiConfigured` + status component `ai_assistant` (boolean / “key configured” only) |
| **Resend webhook health** | Secret check only; webhook exists in Resend as of today | **Yes** — detail includes last verified event since boot. Zero volume still **operational** (prepare mode) |
| **`/billing/success` leftover** | Live marketing **404**. Checkout fallback already `/church-portal` in #159 | **No extra** — already shipped |
| **`/portal` leftover** | Live `tallyconnect.app/portal` is **307 → api…/church-portal** (EMAIL review was right; portal review “404” is stale). `api.tallyconnect.app/portal` is **reseller** login | **Trivial leftovers:** Electron tray, first-connect email, `quick-start.md`. Lifecycle catalog still uses `${appUrl}/portal` (307 works; mass rewrite is P1) |

---

## 6. P0 – P2

### P0 — Sunday / this PR

| Fix | Why |
|-----|-----|
| `aiConfigured` on `/api/health` + `/health` + `/health/deep` | Andrew (and smoke, later) can see Claude is keyed without leaking the key |
| Status component `ai_assistant` | Same chip on `/status` and admin Status |
| Admin Status tab maps `outage` | Synthetic state is `outage`; tab looked for `down` → Unknown |
| Helmet `connect-src` Sentry ingest | Admin Sentry init was a no-op in the browser |
| `Sentry.captureException` on process safety net | Unhandled rejection / crash now has a chance to reach `tally-relay` |
| Telegram check: retry + degraded + `last_error_date` | Stop 60s false **outages**; surface Telegram’s own last_error |
| Resend last-event detail | Secret-set ≠ receiving; boot-relative honesty |
| Portal SSE reconnect copy | TD can see live updates dropped |
| Electron tray + onboard email + quick-start `/church-portal` | Leftover `/portal` (307, but booth tray should be canonical) |

**Still P0, Andrew-side (not code):** connect a dogfood booth on a practice night; confirm one Sentry test event after deploy (admin refresh is enough if CSP shipped); do not treat 0/6 connected as an outage.

### P1 — same week, not during service

1. **Last successful alert send** status component (Telegram HTTP `ok` + Slack `ok`). Page Andrew after N consecutive failures. ([`ALERTS_REVIEW.md`](ALERTS_REVIEW.md) P1-9.) **Shipped** — `alert_delivery` component; `Sentry.captureException` + existing Andrew Telegram path after 3 consecutive send failures (`ALERT_SEND_FAILURE_THRESHOLD`).
2. `Sentry.captureException` on AlertEngine send failure, `runStatusChecks` throw, Resend `email.failed`. **Shipped:** AlertEngine (#164); `runStatusChecks` throw + Resend `email.failed` / bounce / complaint (this leftover).
3. Portal Sentry (SDK + CSP + public DSN). Booth/Electron Sentry **shipped** this PR (`tally-booth`; DSN via `ELECTRON_SENTRY_DSN`).
4. Production Smoke: assert `aiConfigured === true` in prod (type-is-boolean **shipped**; still not a hard `true`); optional `telegram_bot_webhook.state != outage`.
5. Lifecycle emails: `${appUrl}/church-portal` (tests pin `/portal` today). Marketing 307s; reseller collision if anyone uses `RELAY_URL/portal`.
6. Soften `admin_api_proxy` to skip marketing host when `ADMIN_PROXY_URL` is set (historic 404 flaps).
7. Sentry alert rule: first event on `tally-relay` **and** `tally-booth` → Andrew Telegram/email. Org had no booth issues to hang a rule on until a packaged DSN ships.
8. Replace mobile placeholder DSN or disable the SDK until a real project exists.

### P2 — later

1. ~~Booth crash reporting against project `electron`~~ — **verified leftover** (`ELECTRON-1` is a Sentry sample event, `sample_event: yes`). Dedicated project **`tally-booth`** + SDK **this PR**. Andrew still needs GitHub secret `ELECTRON_SENTRY_DSN` (and the same env on Mac Studio) plus an issue alert to page his phone.
2. Persist Resend last-event in DB so restarts don’t look like “never received.”
3. Uptime vendor (BetterUptime) on `/api/status` + `/status`.
4. Trace sample of WS `alert` → Telegram latency.
5. Admin Monitor SSE “fleet live” is empty at 0 connected — keep it, don’t fake data.
6. QA checklist still says `api.tallyconnect.app/portal` (reseller). Archive/update separately.

### Booth crash reporting (this PR)

Verified Sentry project `electron` is **not** Tally (sample `ELECTRON-1`). Created **`tally-booth`**. SDK is `@sentry/node` in Electron main and church-client (renderer is sandboxed with no bundler; errors go over IPC). DSN from env only — never committed.

| How the DSN gets there | What to set |
|------------------------|-------------|
| **Local / tests** | Unset. Init is a no-op; app and CLI still run. |
| **Windows installer** | GitHub Actions secret `ELECTRON_SENTRY_DSN` (from Sentry → `tally-booth` → Client Keys). `beforePack` bakes it into the asar. |
| **Mac Studio signed build** | Export `ELECTRON_SENTRY_DSN` in the shell before `electron-builder`. Same bake. |
| **Railway** | Keep existing `SENTRY_DSN` for **`tally-relay` only**. Do not point the booth at it. Railway does not run the desktop agent. |
| **church-client CLI** | Same `ELECTRON_SENTRY_DSN` (Electron copies it into the child env). |

Do not print the DSN. Scrubber strips JWTs, `Authorization`, tokens, Slack/Telegram webhook URLs, and user email. After the first packaged build, add a Sentry issue alert on `tally-booth` so Sunday crashes page Andrew.

---

## 7. Fixed in this PR

Small high-confidence ops visibility only. No Sentry project created. No secrets added.

| Change | Files |
|--------|-------|
| `aiConfigured` boolean on health | `src/routes/health.js`, `tests/healthRoutes.test.js`, `docs/api-reference.md` |
| `ai_assistant` status component | `server.js` |
| Status tab `outage` | `admin/src/components/StatusTab.jsx` |
| CSP Sentry ingest + safety-net `captureException` | `server.js` |
| Telegram retry / degraded / last_error | `server.js` |
| Resend last verified event | `src/routes/resendWebhook.js`, `tests/resendWebhook.test.js` |
| Portal SSE reconnect UI | `public/portal/portal.js`, `tests/church-portal.test.js` |
| Leftover `/portal` | `server.js` onboard email, `electron-app/src/main.js`, `docs/quick-start.md` |
| Pins | `tests/observability-p0.test.js`, `electron-app/test/portal-url.test.js` |

### Leftover P1-2 after #160 / #164 (this PR)

Silent failures on the named status + Resend paths. No new products. Telegram fetch flaps stay **degraded** (not Sentry).

| Change | Files |
|--------|-------|
| `runStatusChecks` scheduled/initial throw → `Sentry.captureException` | `server.js` (`reportStatusCheckFailure`) |
| Admin `POST /api/status/run-checks` throw → capture | `src/routes/statusComponents.js`, `tests/statusComponentsRoutes.test.js` |
| Resend `email.failed` / `email.bounced` / `email.complained` → capture (no recipient PII) | `src/routes/resendWebhook.js`, `tests/resendWebhook.test.js` |
| Status detail includes last Resend failure type (still operational) | `server.js` resend_webhook component |
| Pins | `tests/observability-p0.test.js` |

### Booth crash reporting (this leftover PR)

`electron` project is leftover sample noise. Dedicated `tally-booth`. No DSN committed.

| Change | Files |
|--------|-------|
| Electron main + renderer IPC + DSN bake | `electron-app/src/sentry.js`, `main.js`, `preload.js`, `renderer.js`, `scripts/beforePack.js`, `.github/workflows/build-win.yml` |
| church-client uncaught / rejection capture | `church-client/src/sentry.js`, `church-client/src/index.js` |
| Init guards + scrub tests | `electron-app/test/sentry.test.js`, `church-client/test/sentry.test.js` |
| DSN docs (no secret values) | `docs/OBSERVABILITY_REVIEW.md`, `electron-app/.env.example`, `relay-server/docs/deployment.md` |

---

## 8. Live probe (read-only)

**Target:** `https://api.tallyconnect.app`  
No church or admin login. Railway **variable names** only (OAuth app cannot read values).

| Check | Result |
|-------|--------|
| `GET /api/health` | `healthy`, v`1.1.67`, build `df363df…`, **6 / 0**, no names, no `aiConfigured` yet (pre-this-PR deploy) |
| `GET /api/status` | `operational`, websocket `connected_churches: 0` |
| `GET /api/status/components` | 7 operational. Telegram = interactive webhook URL OK. Resend = secret configured. No `ai_assistant` yet |
| `GET /api/status/incidents?limit=8` | 796 Resend secret (resolved 01:00). 794/793/792 Telegram `fetch failed` 60s outages. 795 admin proxy 404 via marketing host |
| `GET /status` | **200** HTML |
| `GET /api/admin/client-config` | DSN present (not printed) |
| `GET tallyconnect.app/portal` | **307** → `api.tallyconnect.app/church-portal` |
| `GET tallyconnect.app/church-portal` | **307** → API church-portal |
| `GET tallyconnect.app/billing/success` | **404** (Checkout fallback already `/church-portal` in #159) |
| Sentry `tally-relay` errors 90d | **0** |
| Resend webhooks | 1 enabled → `/api/resend/webhook` (bounced, complained, delivered, failed) created 00:59 UTC |
| Railway `tally` production | `SENTRY_DSN`, `ANTHROPIC_API_KEY`, `RESEND_WEBHOOK_SECRET`, `ANDREW_TELEGRAM_CHAT_ID`, `TALLY_BOT_*`, `LOG_FORMAT` **names present**. No `ALERT_BOT_TOKEN` |
| Production Smoke | Latest **success**; admin auth secrets **used** |

---

*Review date: 2026-09-09. Relies on repo + unauthenticated live HTTP + Sentry MCP aggregates + Railway variable **names** + Resend webhook list. Authenticated admin UI, a connected booth, and a real Telegram page were not exercised.*
