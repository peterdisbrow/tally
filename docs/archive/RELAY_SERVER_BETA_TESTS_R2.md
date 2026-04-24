# TallyConnect Relay Server — Beta Persona Test Report R2

**Date:** 2026-03-26
**Commit:** 398a795 feat: viewer analytics hardening, portal refactor, UX improvements
**Tester:** Automated persona simulation (Claude)

---

## Executive Summary

The TallyConnect relay server is a well-architected, feature-rich Node.js/Express/WebSocket platform targeting church AV production teams. The codebase demonstrates strong security fundamentals (scrypt password hashing, timing-safe comparisons, CSRF double-submit cookies, helmet CSP headers, startup secret validation, webhook idempotency guards, circuit breakers for external APIs) and a genuinely impressive feature surface — AI-driven onboarding, signal failover, autopilot automation, multi-campus support, Planning Center integration, post-service reports, and a full support ticket system. The refactored route structure, separating concerns into `src/routes/*.js`, is clean and maintainable.

The most significant issues discovered are not security holes but operational and UX gaps. The most critical single issue is a **trial duration inconsistency**: `billing.js` declares `TRIAL_PERIOD_DAYS = 30` and sends Stripe a 30-day trial, but the welcome email and verification email both tell users "14-day trial." This mismatch will confuse customers and undermine trust on day 15. A secondary operational risk is the **in-memory rate limiter** running in production without Redis: on any multi-instance (e.g., Railway horizontal scaling) deployment, the in-process `Map`-based store resets on every restart and is per-process, making signup brute-force and abuse limits ineffective. Several personas also encounter missing or incomplete features in the portal UI (campus mode, readonly roles, mobile layout) that are backed server-side but not fully surfaced.

Overall the platform is beta-ready with known limitations documented below. No high-severity authentication bypasses were found. The code is thoughtfully written with safety checks throughout.

---

## Test Methodology

Each persona was traced through the full user journey by reading actual code paths across `server.js`, all `src/routes/*.js` files, key service modules (`billing.js`, `auth.js`, `rateLimit.js`, `circuitBreaker.js`, `csrf.js`, etc.), and the portal front-end (`portal.html`, `portal.js`, `portal.css`). Issues are grounded in specific file/line references observed in the source. No server was run live; this is a static code review simulating user interactions against the API contract.

---

## Persona 1: New Church Signup

**Profile:** A worship pastor at a 200-seat church with no technical background. She found Tally through a Google ad, wants to try it before paying, and signs up from her laptop.

**Journey:**
1. Lands on signup/wizard (Next.js frontend, not in this repo).
2. Frontend POSTs to `POST /api/church/app/onboard` with `name`, `email`, `password`, `tier`, `billingInterval`, optional `referralCode`.
3. `src/routes/churchAuth.js:19` handles the request: validates fields, checks for duplicate name/email, creates church record, generates `registrationCode`, issues `church_app` JWT.
4. If billing enabled, calls `billing.createCheckout()` → returns `checkoutUrl` for Stripe.
5. Sends verification email via `sendOnboardingEmail` (Resend API) — see `churchAuth.js:147–166`.
6. Sends registration confirmation via `lifecycleEmails.sendRegistrationConfirmation()` — `churchAuth.js:168–171`.
7. Pastor receives email, clicks verification link → `GET /api/church/verify-email?token=...` → `emailVerification.js:14–33`.
8. On verify success: redirect to `/church-portal?verified=true`, welcome email sent via `lifecycleEmails.sendWelcomeVerified()`.

**Works Well:**
- Duplicate-name and duplicate-email checks prevent collisions (`churchAuth.js:43–62`). Pending/inactive accounts are cleaned up automatically, reducing ghost accounts.
- Trial abuse prevention via `billing_trial_ends` column check (`churchAuth.js:53–55`).
- Referral tracking is idempotent with `SELECT id FROM referrals WHERE referred_id = ?` guard (`churchAuth.js:104`).
- Email verification token uses `crypto.randomBytes(32)` — strong entropy (`churchAuth.js:85`).
- Verification endpoint nullifies the token on use: `email_verify_token = NULL` (`emailVerification.js:25`).
- Forgot-password flow exists and is rate-limited at 3 req/15 min (`emailVerification.js:83`); token expires in 1 hour (`emailVerification.js:94`).
- Password reset always returns `{ sent: true }` to prevent email enumeration (`emailVerification.js:90`).
- Onboarding rate-limited at 10 req/hour per IP (`churchAuth.js:19`).
- Self-service resend verification at `POST /api/church/resend-verification` (`emailVerification.js:37`).

**Issues Found:**

- **[HIGH]** **Trial duration mismatch.** `billing.js:83` sets `TRIAL_PERIOD_DAYS = 30` and passes it to Stripe's `subscription_data.trial_period_days` at `billing.js:270`. However, the welcome email in `lifecycleEmails.js:1664`, `1688`, and the verification email in `churchAuth.js:157,165` and `emailVerification.js:67,75` all say "14-day free trial." The `engineer-knowledge.js:319` also says "30-day free trial." Users will see their Stripe trial run for 30 days while their welcome email told them 14 days, causing unnecessary support tickets and potential chargeback disputes on day 15.

- **[MEDIUM]** **`registrationCode` generated before `stmtUpdateRegistrationCode` is called.** In `churchAuth.js:75`, `generateRegistrationCode()` is called without passing the DB instance (`const registrationCode = generateRegistrationCode();`). Looking at `auth.js:40`, `generateRegistrationCode(db)` requires the DB as a parameter. The `ctx` object passes the function reference — if the function reference was bound without `db`, this would silently generate a non-unique code. Verify that `ctx.generateRegistrationCode` is a bound version with `db` pre-applied.

- **[MEDIUM]** **No email format validation beyond `includes('@')`.** `churchAuth.js:203` only checks `!cleanEmail.includes('@')` for lead capture, and the onboard flow doesn't validate email format at all beyond trusting the frontend. Malformed emails will silently fail at Resend delivery time, leaving the church unnotified.

- **[LOW]** **No TOS acceptance timestamp stored server-side.** The `tosAcceptedAt` field is passed from the client and stored verbatim (`churchAuth.js:92`). A client could submit a past date or `null`. There is no server-side enforcement that a value is present or recent.

- **[LOW]** **Password reset URL uses `APP_URL` not `RELAY_URL`.** `emailVerification.js:98` builds `resetUrl = ${APP_URL}/portal/reset-password?token=...`. The reset page must live at the frontend app URL, not the relay, which is correct — but if `APP_URL` is not set, it falls back to `https://tallyconnect.app` which may not match the deployed environment.

**Persona Score: 7.5/10**

---

## Persona 2: Admin Managing Volunteers (Tech Directors)

**Profile:** The church's volunteer coordinator wants to add three tech directors to Telegram notifications, assign a primary TD, and set up a guest token for a visiting TD this weekend.

**Journey:**
1. Logs into the portal → `POST /api/church/login` (handled in `churchPortal.js`).
2. Navigates to "Tech Directors" page in portal (`portal.html:37–39`).
3. Adds TDs via `POST /api/churches/:churchId/tds/add` → `churchOps.js:127–132`.
4. Sets on-call rotation via `POST /api/churches/:churchId/oncall` → `churchOps.js:120–125`.
5. Creates guest token via `POST /api/churches/:churchId/guest-token` → `churchOps.js:136–141`.
6. Shares token with visiting TD; TD registers in Telegram with `GUEST-XXXXXX` code.

**Works Well:**
- `OnCallRotation` and `GuestTdMode` modules are well-encapsulated with their own schema and expiry logic (`guestTdMode.js:57–63`).
- Guest tokens expire after 24 hours and are auto-cleaned on startup (`guestTdMode.js:58–63`).
- Guest TD registers exactly once per token — `usedByChat` column prevents reuse.
- Legacy `gtd_` prefix tokens are auto-cleaned on startup (`guestTdMode.js:46–53`).
- On-call rotation requires `requireFeature('oncall_rotation')` gating (`churchOps.js:114`), so lower-tier plans correctly can't access it.

**Issues Found:**

- **[HIGH]** **Reseller-created churches skip the TD registration registration code flow entirely.** `reseller.js:85–120` (`POST /api/reseller/churches/register`) and `reseller.js:181–234` (`POST /api/reseller/churches/token`) create churches without triggering the lifecycle email sequence. TDs at reseller-created churches receive no welcome email and no guidance on how to set up Telegram alerts. The `registrationCode` is stored, but no notification path is established.

- **[MEDIUM]** **`tdTelegramChatId` required check is inconsistent.** `churchOps.js:129` requires `name` and `telegramChatId` for `tds/add`. However, the `td_register` endpoint in `telegram.js:28–32` requires `telegram_user_id` and `name` but marks `telegram_chat_id` as optional (defaults to `telegram_user_id`). A TD can be registered with a `telegram_chat_id` of `0` or empty string, making alerts undeliverable with no error.

- **[MEDIUM]** **No confirmation or audit trail when a guest token is revoked mid-service.** `churchOps.js:143–146` (`DELETE /api/guest-token/:token`) hard-deletes the token with no notification to the guest TD. If a guest TD is mid-service and their token is revoked, they will silently stop receiving alerts without warning. There is no `guestTdMode.botToken` being set before use is confirmed.

- **[LOW]** **On-call rotation primary/secondary flag not surfaced in portal UI.** `churchOps.js:116` returns `isPrimary` from the DB, and the `add` endpoint accepts `isPrimary` (`churchOps.js:128`). The portal's TD page (`portal.html:37`) shows the TD list but there is no UI control observed for designating primary vs. secondary TD.

**Persona Score: 7/10**

---

## Persona 3: AV Tech Monitoring Live Service

**Profile:** The AV tech director (TD) runs sound and video during Sunday service. They have Tally's desktop app connected and are watching the church portal on a second monitor for status.

**Journey:**
1. Desktop app connects via WebSocket with JWT token.
2. Portal loads overview page showing health score, device status, current session.
3. At T-30min, `PreServiceCheck` fires automatically (`preServiceCheck.js:8–33`), sends `system.preServiceCheck` to the desktop app, results come back and are stored in `preservice_check_results`.
4. During service: `AlertEngine` classifies any incoming status events, dispatches to Telegram and portal chat.
5. `AutoRecovery` attempts up to 3 recovery commands per failure type with 30s cooldown.
6. Post-service: `PostServiceReport` generates and stores a report; `ScheduleEngine` fires `close` callback.

**Works Well:**
- Health score is a sophisticated 5-factor weighted model (uptime 30%, alertRate 20%, streamStability 20%, recoveryRate 15%, preServicePassRate 15%) — `healthScore.js:6–12`.
- Null sub-scores are excluded and weights redistributed gracefully (`healthScore.js:68–76`).
- New churches with no data get `{ score: null, status: 'new' }` rather than misleading zeros (`healthScore.js:62–65`).
- Alert deduplication with a 5-minute window prevents notification storms (`alertEngine.js:14`).
- `CRITICAL_BYPASS_TYPES` (`stream_stopped`, `signal_loss`, `encoder_offline`) skip dedup and fire immediately (`alertEngine.js:8–12`).
- Auto-recovery enforces 30s cooldown and max 3 attempts per failure type per session (`autoRecovery.js:57–64`).
- `AutoPilot` has a 50-rule-per-session hard cap with TD notification on pause (`autoPilot.js` + `botI18n.js:47–49`).
- `SignalFailover` implements a proper state machine (HEALTHY → SUSPECTED_BLACK → CONFIRMED_OUTAGE → FAILOVER_ACTIVE) with configurable thresholds per church (`signalFailover.js:23–38`).
- Pre-service check timestamps are restored from DB on relay restart, preventing duplicate checks after a deploy (`preServiceCheck.js:41–62`).
- WebSocket heartbeat/pong mechanism detects zombie connections within 40 seconds (`server.js:93–107`).

**Issues Found:**

- **[HIGH]** **Pre-service check fires 25–35 min before service but `REQUIRE_ACTIVE_BILLING` may block the WebSocket connection for expired trials.** The pre-service check sends a command over WebSocket, but if billing has just expired (e.g., trial expired at midnight), the church client is disconnected. The check will silently fail with no notification to the TD that the pre-service check couldn't run, because there's no fallback notification path for disconnected churches.

- **[MEDIUM]** **Health score `_computeUptime` uses a rough proxy (5 min per unresolved critical event, 2 min per resolved event) rather than actual connection telemetry.** `healthScore.js:193–216`. This means a church with frequent minor disconnects between services (which never generate service_events) shows a perfect uptime score. The estimate also doesn't account for event duration or overlap.

- **[MEDIUM]** **`autoRecovery.js` recovery commands are dispatched via `dispatchCommand` but there is no confirmation loop.** `RECOVERY_COMMANDS` entries like `recovery.restartStream` are sent fire-and-forget. If the church client is momentarily lagged or the command is dropped, the relay marks the attempt as "tried" and moves to escalation without knowing whether the command was executed. The desktop app's `command_result` feedback loop used in `supportTickets.js:227–254` is not applied to auto-recovery.

- **[LOW]** **`MonthlyReport.generate()` fires at "1st of month at 9 AM" checked via a 15-minute polling interval (`monthlyReport.js:29–30`).** If the server restarts between 9:00 and 9:14 on the 1st, the report for that month is skipped entirely and never regenerated. No catch-up logic exists.

**Persona Score: 8/10**

---

## Persona 4: Spanish-Speaking Pastor

**Profile:** A Spanish-speaking pastor who is also the church's primary technical contact. Their TD communicates in Spanish on Telegram. They want to interact with the bot in Spanish.

**Journey:**
1. TD registers via Telegram: `/register XXXXXX` → bot looks up church, sends `welcome.registered` string.
2. Bot uses `churchLocale(church)` from `botI18n.js:155–159` to detect locale from `churches.locale` column.
3. All subsequent alert messages use `bt(key, locale, vars)` — `botI18n.js:139–148`.
4. Pastor accesses church portal (web), which has a language toggle button (`portal.html:80`).

**Works Well:**
- `botI18n.js` implements a clean, complete Spanish locale covering registration, authentication, status, alerts, autopilot, pre-service, macros, and error messages — `botI18n.js:72–129`.
- Fallback to English is graceful: missing keys fall back to English first, then to the key name (`botI18n.js:141–143`).
- `churchLocale()` handles null/undefined church gracefully (`botI18n.js:155`).
- Template variable interpolation is XSS-safe (plain string replace, Telegram messages use MarkdownV2 not HTML).
- Portal has a language toggle button with `data-i18n` attributes on nav items (`portal.html:29–79`).

**Issues Found:**

- **[HIGH]** **Locale is never stored in the DB from the self-service signup flow.** `churchAuth.js:onboard` has no `locale` field in the request body processing, no `locale` column write in the `UPDATE churches SET ... WHERE churchId = ?` at line 87–92, and no ALLOWED_PROFILE_COLUMNS entry in the profile update at `churchAuth.js:366`. The `church.locale` column is read in `botI18n.js:157` but there is no way for a church to set it through any documented API endpoint. The portal language toggle (`portal.html:80`) likely changes client-side display but cannot persist the preference server-side for Telegram alerts.

- **[MEDIUM]** **Spanish strings cover Telegram bot messages but the portal UI i18n is incomplete.** `portal.html` nav items show `data-i18n` keys for some items (`nav.overview`, `nav.profile`, etc.) but not all — `Referrals` at line 71 has no `data-i18n` attribute. Page-level content (overview cards, billing section, session debrief text) does not appear to have i18n keys, meaning Spanish-preferring users get a mixed Spanish/English experience.

- **[MEDIUM]** **No language-specific content in lifecycle emails.** `lifecycleEmails.js` sends all transactional emails in English only. A Spanish-speaking pastor will receive trial-ending, payment-failed, and weekly digest emails in English regardless of any locale preference.

- **[LOW]** **The `/fix preservice` command referenced in `botI18n.js:55` (and Spanish equivalent `botI18n.js:114`) does not appear to be implemented in the Telegram bot command router.** If a TD types `/fix preservice` after a pre-service failure, they will likely receive an unknown-command response.

**Persona Score: 5.5/10**

---

## Persona 5: Multi-Campus Admin

**Profile:** A large church with three campuses — a main campus and two satellites. The admin wants to link them for unified monitoring and shared room management.

**Journey:**
1. Main campus generates a `campus_link_code` via the portal.
2. Satellite churches enter the code via the portal to join.
3. Campus-aware APIs aggregate data across linked churches.
4. `GET /api/church/app/rooms` returns rooms across all campuses (`churchAuth.js:264–280`).

**Works Well:**
- Migration `001_campus_mode.sql` adds `campus_id` and `campus_link_code` with proper indexes including a `UNIQUE` index on `campus_link_code`.
- `GET /api/church/app/rooms` correctly queries satellite and parent campus IDs in a single query using `IN (...)` placeholders (`churchAuth.js:264–280`).
- Room assignment via `POST /api/church/app/room-assign` validates room existence and updates `room_id`/`room_name` (`churchAuth.js:284–300`).
- Campus mode appears in the portal sidebar navigation (`portal.html:34–36`).

**Issues Found:**

- **[HIGH]** **Campus linking code generation endpoint is not present in any of the read route files.** The `campus_link_code` column exists and is readable, but no `POST /api/church/app/campus/link` or equivalent endpoint was found in the routes. The portal "Campuses" page (`portal.html:34–36`) presumably calls something, but the server-side handler for generating a link code and accepting satellite join requests is absent from all `src/routes/*.js` files reviewed. This makes campus mode non-functional for self-service setup.

- **[HIGH]** **Room assignment does not verify that the room belongs to the church's campus group.** `churchAuth.js:289–291` only checks `rooms WHERE id = ?` without verifying `campus_id IN (campusIds)`. A church could assign itself to a room belonging to a completely unrelated church if they happen to know the room's UUID.

- **[MEDIUM]** **`GET /api/church/app/rooms` uses `campus_id` field on churches both for "this church's campus parent" and "the rooms that belong to this campus."** The query at `churchAuth.js:275` queries `rooms WHERE campus_id IN (campusIds)` — the `rooms.campus_id` foreign key must point to a `churches.churchId`, not to a dedicated `campuses` table. If a satellite's `campus_id` is `null` (not yet linked), it still queries `rooms WHERE campus_id IN ([churchId, null])` which is fine for SQLite, but verifying this edge case is important.

- **[LOW]** **The campus feature is currently Pro/Enterprise-tier but no `requireFeature('campus_mode')` middleware guards the campus-related room endpoints.** Any tier can call `GET /api/church/app/rooms` and `POST /api/church/app/room-assign`.

**Persona Score: 5/10**

---

## Persona 6: Readonly Staff Member

**Profile:** An office manager who needs to see the church's monitoring status and past session reports, but should not be able to change settings, add TDs, or trigger commands.

**Journey:**
1. Tries to log into the church portal.
2. The portal provides a single-user login — whoever knows the church's email and password gets full access.

**Works Well:**
- The admin panel (`authMiddleware.js:16–28`) has four distinct roles: `super_admin`, `admin`, `engineer`, `sales` with scoped permissions.
- `engineer` role is correctly read-only: `churches:read`, `commands:send`, `sessions:read`, `alerts:read`, `alerts:ack`, `settings:read` — no write permissions.
- `sales` role has `churches:read`, `billing:read`, `resellers:read`/`write` only.
- `requireAdminJwt(...allowedRoles)` factory allows per-endpoint role scoping.

**Issues Found:**

- **[CRITICAL]** **The church portal (the self-service portal used by churches themselves) has no role system at all.** `churchAuth.js` issues a single `church_app` JWT that grants full read/write access to all church settings. There is no concept of a "readonly staff member" at the church level. Any user with the church's email and password can change notification settings, add TDs, modify schedules, trigger guest tokens, and update billing. The `ALLOWED_PROFILE_COLUMNS` pattern in `churchAuth.js:366` only prevents SQL injection, not privilege separation.

- **[HIGH]** **The church portal login at `POST /api/church/app/login` has no account lockout.** `churchAuth.js:215` applies `rateLimit(5, 15 * 60 * 1000)` (5 attempts per 15 minutes per IP). This is IP-based only — an attacker who rotates IPs can brute-force church passwords without limit. With the in-memory rate limiter (no Redis configured), this limit also resets on every server restart.

- **[MEDIUM]** **Session debrief at `GET /api/churches/:churchId/sessions/:sessionId/debrief` is admin-only (`requireAdmin`).** If a church's office manager wants to review post-service reports from the portal, they can't — the endpoint requires an admin JWT, not a church app JWT. The `GET /api/church/service-reports` endpoint that would serve the portal's "Sessions" page must exist in `churchPortal.js` (not fully read), but the debrief and timeline endpoints in `sessions.js` are admin-only.

**Persona Score: 4/10**

---

## Persona 7: Mobile User

**Profile:** A tech director checking in on the church's status from their iPhone during a week-day service rehearsal, using Safari mobile.

**Journey:**
1. Navigates to the portal URL on mobile Safari.
2. Portal loads (`portal.html`), hamburger menu appears.
3. Taps hamburger → mobile nav slides open.
4. Navigates to Overview → sees health score, device status cards.
5. Navigates to Sessions → views session history.

**Works Well:**
- `portal.html:5` includes `<meta name="viewport" content="width=device-width, initial-scale=1.0">` — correct viewport.
- Hamburger button exists with proper `aria-label` and `onclick` handler (`portal.html:11`).
- Sidebar overlay (`portal.html:12`) allows tap-to-close behavior.
- Sidebar navigation uses `data-page` pattern, not anchor links, so deep-link state doesn't confuse mobile browsers.
- All SVG icons have `aria-hidden="true"` for accessibility.

**Issues Found:**

- **[HIGH]** **CSP `scriptSrc: ["'self'", "'unsafe-inline'"]` weakens mobile browser security.** `server.js:53–54` permits `unsafe-inline` scripts and `unsafe-inline` for `scriptSrcAttr`. On a mobile browser (especially in Safari's strict mode for form submissions), this is a meaningful downgrade. The comment explains it's needed for "portal uses inline onclick handlers" — but the portal uses `onclick="showPage(..."` attributes throughout `portal.html:28–79`. These should be migrated to event listeners to allow dropping `unsafe-inline`.

- **[MEDIUM]** **Portal CSS is not read in this review** (portal.css was in the file list but its content was not reviewed in detail). However, based on `portal.html`'s sidebar structure with `class="sidebar"` and `class="sidebar-overlay"`, if the CSS breakpoints do not hide the sidebar by default on small screens and show the hamburger, the layout will be broken. The hamburger button has `class="hamburger"` which requires corresponding CSS; without confirming the CSS, mobile layout correctness is uncertain.

- **[MEDIUM]** **Inline `onclick` attributes throughout portal.html do not pass `event` for touch handling nuances.** Functions like `toggleMobileNav()` are called with no context, but on iOS Safari, certain touch events differ from click events. If the touch event fires twice (tap-then-click), the overlay may open/close in rapid succession.

- **[LOW]** **No service worker or offline capability.** If a TD is in a building with spotty connectivity and navigates away from the portal, they lose state. Not a beta blocker, but affects real-world church tech usage.

- **[LOW]** **The language toggle button in the sidebar footer (`portal.html:80`) is implemented inline with `style="width:100%;..."`. It will render on mobile but the font-size 11px text may be too small for comfortable tap targets on smaller phones (below WCAG 2.5.5 recommended 44x44px target).**

**Persona Score: 6.5/10**

---

## Persona 8: Billing/Subscription Explorer

**Profile:** A church administrator who wants to understand the plan tiers, select the right plan, complete checkout, then later manage their subscription.

**Journey:**
1. Selects tier and billing interval during onboarding (`POST /api/church/app/onboard`).
2. Receives `checkoutUrl` in response, redirected to Stripe Checkout.
3. Completes Stripe Checkout → Stripe fires `checkout.session.completed` webhook to `POST /api/billing/webhook`.
4. `billing.handleWebhook()` activates the church in the DB.
5. Church admin later wants to upgrade → self-service via `POST /api/billing/portal`.
6. Views current billing status in portal "Billing" page.

**Works Well:**
- Webhook idempotency guard prevents double-processing on Stripe retry (`billing.js:336–347`).
- Circuit breaker wraps outbound Stripe API calls (`billing.js:102–105`) with 5-failure threshold, 60s cooldown.
- Webhook secret validation is enforced; missing `STRIPE_WEBHOOK_SECRET` returns 503 immediately (`routes/billing.js:50–53`).
- `STRIPE_SECRET_KEY` + missing `STRIPE_WEBHOOK_SECRET` causes startup crash in production (`server.js:202–208`).
- Placeholder price IDs trigger explicit startup warnings but don't crash (`billing.js:109–131`).
- Grace period of 7 days after payment failure before deactivation is implemented (`billing.js:84`).
- Annual billing is supported alongside monthly for all tiers (`billing.js:53–73`).
- `REQUIRE_ACTIVE_BILLING` defaults to `true` in production, `false` in dev — safe default (`server.js:165`).

**Issues Found:**

- **[HIGH]** **Trial duration inconsistency (re-stated from Persona 1): Stripe receives 30 days, user emails say 14 days.** `billing.js:83` vs `churchAuth.js:157`, `lifecycleEmails.js:1664,1688,2275`. This is the most operationally damaging inconsistency in the codebase.

- **[HIGH]** **`POST /api/billing/portal` (Stripe Customer Portal) requires `requireAdmin` — it is not accessible to church users via the portal.** `routes/billing.js:37`. The church portal's "Billing" page would need to call this to let churches manage their subscription, but only an admin JWT can call it. There must be a parallel church-portal-authenticated billing portal endpoint in `churchPortal.js` (not fully read) — if not, churches cannot self-manage subscriptions without contacting support.

- **[MEDIUM]** **No webhook handler for `customer.subscription.trial_will_end`** — Stripe sends this 3 days before trial expiry. The lifecycle email system has `sendTrialEndingSoon` emails, but they are scheduled by polling `billing_trial_ends` in the DB, not by webhook. If the relay was down when the poll was supposed to fire, the trial warning emails may be skipped.

- **[MEDIUM]** **`normalizeBillingInterval` in `billing.js:221` returns `null` for `one_time` passed for non-event tiers.** If a UI bug sends `billingInterval: 'one_time'` for a `pro` plan, the normalization returns `null`, which then fails validation with "Invalid billingInterval." The error message does not suggest valid values to the user.

- **[LOW]** **`POST /api/billing/checkout` also requires `requireAdmin` (`routes/billing.js:12`).** Church self-service checkout is handled through the onboard flow, which embeds checkout inline. However, if a church user wants to upgrade from Connect to Pro mid-trial via the portal, there is no church-user-accessible upgrade endpoint. They would need admin assistance.

**Persona Score: 6.5/10**

---

## Persona 9: Power User with Many Devices

**Profile:** A sophisticated TD at a megachurch running ATEM, OBS, ProPresenter, a Blackmagic encoder, a VideoHub, and Companion. They push Tally heavily and want to see all device statuses simultaneously.

**Journey:**
1. Desktop app connects to WebSocket with JWT.
2. App sends status updates for all connected devices.
3. Portal overview shows device health cards.
4. TD uses Telegram bot for quick commands during service.
5. Tests AutoPilot rules for automatic OBS recording start/stop.

**Works Well:**
- `RECOVERY_COMMANDS` covers: `stream_stopped`, `atem_stream_stopped`, `vmix_stream_stopped`, `encoder_stream_stopped`, `encoder_disconnected`, `recording_not_started`, `audio_silence`, `audio_silence_sustained`, `connection_lost` — broad coverage (`autoRecovery.js:45–55`).
- `MAX_RULES_PER_TIER` enforces `plus: 5`, `pro: 10`, `managed: 25` AutoPilot rule caps (`autoPilot.js:27`).
- WebSocket max payload is capped at 256 KB (`server.js:84`) preventing large payloads from crashing the relay.
- Per-IP WebSocket limit of 5 concurrent connections (`server.js:222`).
- Command rate limit of 10 commands/second per church (`churchOps.js:21–25`).
- `session.js:157` paginates session queries with `LIMIT` and `OFFSET`, max 100 per page.

**Issues Found:**

- **[HIGH]** **AutoPilot `connect` tier gets `MAX_RULES_PER_TIER.connect = 0` but there's no clear error message if a Connect church somehow has rules stored from a plan upgrade downgrade cycle.** `autoPilot.js:27` sets `connect: 0` and `event: 0`. If a church downgrades from Plus to Connect, existing rules are not deleted — they just stop evaluating. However, if `getMaxRules()` returns 0 and the church tries to create a rule, the error experience is not documented.

- **[MEDIUM]** **The session timeline at `sessions.js:181–214` queries three separate tables (`service_events`, `alerts`, `chat_messages`) and merges/sorts in-application.** For a power user with years of session history and hundreds of alerts per session, this in-memory sort could produce large result sets. There is no `LIMIT` on the event/alert queries within a single session timeline, only the session-list query is paginated.

- **[MEDIUM]** **`POST /api/command` rate check calls `checkCommandRateLimit(churchId)` (`churchOps.js:22`).** This function uses `consumeRateLimit` from `rateLimit.js`, which falls back to in-memory store without Redis. With the in-memory store, the 10-command/second limit per church is per-process and resets on every deploy — meaning a brief deploy window allows unlimited command flooding.

- **[LOW]** **`TIER_LIMITS.connect.devices` is `['atem', 'obs', 'vmix']` (`billing.js:86`).** A Connect-tier church with a Blackmagic encoder or Companion cannot use those devices. The error when attempting to send a command to a non-allowed device type is surfaced at `checkBillingAccessForCommand` but the error text may not be clear about which plan upgrade is required.

**Persona Score: 7/10**

---

## Persona 10: User Troubleshooting Connection Issues

**Profile:** A TD whose ATEM keeps disconnecting during services. They want to diagnose why, run auto-recovery tests, and submit a support ticket if needed.

**Journey:**
1. TD notices ATEM alert in Telegram.
2. Opens portal → Alerts page → sees `atem_disconnected` CRITICAL alert with diagnosis.
3. Alert includes `DIAGNOSIS_TEMPLATES['atem_disconnected']` steps: check ethernet, ping ATEM, power cycle (`alertEngine.js:63–68`).
4. If unresolved, TD submits diagnostic bundle: `POST /api/church/:churchId/diagnostic-bundle` → `supportTickets.js:207–276`.
5. Runs triage: `POST /api/support/triage` → `supportTickets.js:311–368`.
6. Creates ticket: `POST /api/support/tickets` → requires `triageId` from step 5.

**Works Well:**
- `buildDiagnosticContext()` provides a rich snapshot: device status, recent alerts (15-min window), session info, failover state, and church memory — `diagnostic-context.js`.
- Diagnostic bundle waits for church client response with 10-second timeout and stores result in DB (`supportTickets.js:227–265`).
- Triage system auto-checks relevant systems by category (`stream_down`, `no_audio_stream`, `atem_connectivity`, `recording_issue`) — `supportTickets.js:101–159`.
- Support ticket requires a recent `triageId` (max `SUPPORT_TRIAGE_WINDOW_HOURS` = 24h old by default) forcing users to go through triage first (`supportTickets.js:382–399`).
- `P1` force-bypass exists for urgent tickets (`supportTickets.js:381–387`).
- Church users can only close/wait on their own tickets; they can't change metadata — proper permission scoping (`supportTickets.js:576–580`).
- `IncidentSummarizer` generates plain-English transition narratives for failover state changes (`incidentSummarizer.js:30–51`) with AI fallback when `ANTHROPIC_API_KEY` is set.

**Issues Found:**

- **[HIGH]** **`POST /api/church/:churchId/diagnostic-bundle` requires `requireSupportAccess` which accepts either a church JWT or admin JWT (`supportTickets.js:162–185`).** However, there is a subtlety: a church user at `req.params.churchId` vs `req.supportActor.churchId` enforcement only works if `:churchId` in the URL is verified against the JWT's churchId. Line 215 checks this: `if (req.supportActor?.type === 'church' && req.supportActor.churchId !== churchId)` — this is correct. But the `resolveSupportChurchId` function at `supportTickets.js:187–192` for church actors returns `req.supportActor.churchId`, ignoring `req.params.churchId`. On `POST /api/support/triage`, there is no URL param — `churchId` comes from body/query. A church user could submit a triage for a *different* church by putting another churchId in the request body and having a `church_app` JWT for church A while body contains churchId of church B. The `resolveSupportChurchId` call at line 312 returns `req.supportActor.churchId` for church actors, which correctly forces their own ID — but this is worth confirming is consistent throughout all ticket endpoints.

- **[MEDIUM]** **The diagnostic bundle waits for a `command_result` message with the matching `commandId` on the WebSocket** (`supportTickets.js:227–254`). This attaches a `message` event listener to the WebSocket. If multiple diagnostic bundle requests are made concurrently for the same church (e.g., a support agent and the TD both clicking simultaneously), both listeners will compete for the same `command_result` response, and one will timeout unnecessarily.

- **[MEDIUM]** **There is no notification back to the church user when an admin updates a support ticket.** `supportTickets.js` has no SSE push, WebSocket push, or email send when ticket status changes. The church user must poll `GET /api/support/tickets` to see updates.

- **[LOW]** **`DIAGNOSIS_TEMPLATES` in `alertEngine.js` have `canAutoFix: false` for all templates** (lines 58–100). This means even when `AutoRecovery` successfully sends a recovery command, the template shown to the TD still says "cannot auto-fix." This is a UX inconsistency — the system auto-recovers but tells the user it can't.

**Persona Score: 7.5/10**

---

## Persona 11 (BONUS): Reseller/Partner

**Profile:** An AV integrator who installs Tally at 15 client churches and wants to manage them all from a white-label portal branded as "ProAV Connect."

**Journey:**
1. Admin creates reseller via `POST /api/resellers` → `reseller.js:15–25`.
2. Admin sets reseller portal credentials via `POST /api/resellers/:id/password` → `reseller.js:66–81`.
3. Reseller logs into `POST /api/reseller-portal/login` → `resellerPortal.js`.
4. Reseller creates churches via `POST /api/reseller/churches/token` → `reseller.js:181–234`.
5. Reseller views their churches via `GET /api/reseller/churches` → `reseller.js:123–136`.
6. Reseller updates branding (`brand_name`, `logo_url`, `primary_color`, `custom_domain`) via `PUT /api/reseller/me`.

**Works Well:**
- `church_limit` enforcement via `resellerSystem.canAddChurch()` before creating new churches (`reseller.js:90–93`).
- `church_limit = NULL` means unlimited (the migration at `reseller.js:52–53` corrects the old default of 10 to NULL, demonstrating forward-thinking migration).
- Reseller portal uses JWT cookie with 7-day expiry and a separate `tally_reseller_session` cookie name, properly isolated from church sessions.
- CSRF double-submit cookie is applied to the reseller portal login flow via `setCsrfCookie` import (`resellerPortal.js:26`).
- `requireReseller` middleware validates `x-reseller-key` header against DB and checks `active = 1` (`authMiddleware.js:88–95`).
- Reseller `api_key` is stripped from `/api/reseller/me` response (`reseller.js:159`).
- Commission rate is stored but not yet computed — appropriate for an MVP.

**Issues Found:**

- **[HIGH]** **Admin password endpoint `POST /api/resellers/:resellerId/password` allows minimum 6 characters** (`reseller.js:70`). All other password endpoints in the codebase enforce 8 characters minimum. This inconsistency means reseller portal passwords can be weaker, which is a higher-risk surface since resellers have access to multiple church accounts.

- **[HIGH]** **Reseller-created churches are never added to the `email_sends` or lifecycle email sequence.** `reseller.js:104` calls `stmtInsert.run(...)` and `resellerSystem.registerChurch(...)` but does not trigger `lifecycleEmails.sendRegistrationConfirmation()` or the lifecycle sequence. A church created by a reseller will never receive the setup nudge email, first Sunday prep email, or trial ending soon emails.

- **[MEDIUM]** **`resellerPortal.js` defines its own `hashPassword` and `verifyPassword` functions** (lines 30–44) that are local duplicates of `auth.js`. The local `verifyPassword` does not have the `try/catch` with `String(stored || '')` guard that `auth.js:verifyPassword` has. If `stored` is `null` (reseller with no portal password set yet), the destructure `const [salt, hash] = stored.split(':')` will throw a TypeError, potentially crashing the login handler.

- **[MEDIUM]** **Custom domain support (`custom_domain` column) is stored but there is no middleware to actually serve portal content at the custom domain.** The column exists, the update endpoint stores it, but no routing logic in `resellerPortal.js` or `server.js` checks `req.hostname` against stored custom domains and routes accordingly.

- **[LOW]** **`PUT /api/reseller/me` accepts `logo_url` without URL validation.** An arbitrary string (including a local file path) can be stored. While this is low-risk in a server-side stored field, it could cause broken image rendering in the white-label portal.

**Persona Score: 6/10**

---

## Cross-Cutting Issues

1. **In-memory rate limiting in production.** `rateLimit.js:170–173` warns about this at startup but accepts it. All rate limits (login: 5/15min, onboard: 10/hr, chat: 30/min, etc.) are per-process and reset on restart. On Railway with multiple instances or any zero-downtime redeploy, these limits provide weak protection. This affects Personas 1, 6, 9.

2. **Trial duration inconsistency (30 days in Stripe, 14 days in all user-facing text).** Affects Personas 1 and 8 critically.

3. **No church-level role system.** The admin panel has 4 roles, but the church portal (used by the church team) is all-or-nothing. This affects Personas 2, 6.

4. **Reseller-created churches lack lifecycle email integration.** Affects Personas 2 and 11.

5. **`safeErrorMessage` returns full error message in non-production environments but could be toggled to `'production'` mode in staging, accidentally hiding real errors during QA.** Worth confirming the `NODE_ENV` value across environments.

6. **`portal.html:25` renders `{{CHURCH_NAME}}` as a literal placeholder string.** This is a server-side template placeholder that must be replaced before serving. If the portal is served as a static file (e.g., via `express.static`) without server-side substitution, users will see `{{CHURCH_NAME}}` in the sidebar. The portal's JS presumably replaces this on load, but it flashes briefly on initial render.

---

## Security Observations

**Strengths:**

- **Password hashing:** scrypt with random salt and timing-safe comparison everywhere (`auth.js:14–33`). No SHA-1 or bcrypt shortcuts.
- **CSRF protection:** Double-submit cookie pattern with constant-time comparison, correctly scoped to session-cookie-bearing requests only, with appropriate exemptions for login/logout/webhook (`csrf.js`).
- **JWT secrets validation at startup:** Production servers crash immediately if `ADMIN_API_KEY`, `JWT_SECRET`, or `SESSION_SECRET` are missing or still defaults (`server.js:183–213`).
- **Stripe webhook integrity:** Signature verification is required; missing secret returns 503 not 200 (`routes/billing.js:50–53`).
- **SSRF prevention for Slack:** `isValidSlackWebhookUrl()` enforces `https://hooks.slack.com` only (`server.js:324–329`).
- **Admin API key comparison:** Constant-time with length padding (`server.js:306–318`).
- **Sentry scrubs auth headers** before sending events (`server.js:36–39`).
- **Helmet headers:** Full CSP, HSTS with preload, referrer policy (`server.js:49–65`).
- **WebSocket limits:** 256KB max payload, 5 connections per IP, 20 max controllers, 50 max SSE clients.
- **Circuit breakers** on Stripe and Telegram prevent cascade failures from external API outages.

**Concerns:**

- **`unsafe-inline` in CSP scriptSrc** (`server.js:53`) is the most significant remaining XSS vector. All inline `onclick` attributes in `portal.html` must be migrated to event listeners before this can be removed.
- **In-memory rate limiting** (see Cross-Cutting issue #1).
- **Reseller admin password minimum 6 chars vs. 8 elsewhere** (`reseller.js:70`).
- **`resellerPortal.js` local `verifyPassword` lacks null guard** (see Persona 11).
- **`x-csrf-token` header is not listed in `Access-Control-Allow-Headers`** (`server.js:260`). If the portal is served from a different origin than the API, the CSRF header will be stripped by the browser's CORS preflight check, causing all state-changing portal requests to fail with 403 CSRF errors. Review whether `ALLOWED_ORIGINS` configuration covers the deployed setup.

---

## Overall Assessment

The codebase is impressively feature-complete for a beta. The security fundamentals are solid — this is not a system with credential-in-plaintext or SQL injection problems. The architecture is clean with well-separated route files, consistent context injection, and thoughtful error handling. The most meaningful pre-launch risk is the **trial duration messaging inconsistency** (Stripe vs. emails), followed by the **campus mode missing core server endpoint**, **church-level role system absence**, and **reseller portal password minimum** inconsistency.

**Overall Score: 7.1/10**

| Category | Score |
|---|---|
| Security fundamentals | 8.5/10 |
| Feature completeness | 7.5/10 |
| Data integrity & consistency | 6.5/10 |
| UX / Portal experience | 6.0/10 |
| i18n / Spanish support | 5.5/10 |
| Operational hardening | 7.0/10 |
| API design & validation | 7.5/10 |

---

## Prioritized Action Items

### P0 — Critical (Fix Before Launch)

1. **Fix trial duration inconsistency.** Choose one value (recommend 30 days to match Stripe) and update all email templates in `lifecycleEmails.js` (lines 1664, 1688, 2275, 2285, 2396), `churchAuth.js` (lines 157, 165), and `emailVerification.js` (lines 67, 75). Also align `engineer-knowledge.js:319`.

2. **Add church-level role system or at minimum a read-only access token.** The absence of any role scoping in `churchAuth.js`/`requireChurchAppAuth` means any staff member with credentials can make destructive changes. At minimum, add a `readonly` flag on the `church_app` JWT and enforce it on write endpoints.

3. **Add CSRF header to `Access-Control-Allow-Headers` in CORS config.** `server.js:260` must include `x-csrf-token` if the portal is served cross-origin, otherwise CSRF protection effectively blocks all portal writes.

### P1 — High (Fix This Week)

4. **Implement campus link-code generation and satellite join endpoints.** The campus_mode migration exists, the DB schema is set, but the API endpoints to generate and redeem campus link codes are missing. Without them, the Campuses portal page is non-functional.

5. **Fix room assignment to validate campus ownership.** `churchAuth.js:289` must verify `rooms.campus_id IN (campusIds)` before allowing assignment, preventing cross-church room hijacking.

6. **Raise reseller admin password minimum to 8 characters.** `reseller.js:70` — single-line change.

7. **Fix `resellerPortal.js` local `verifyPassword` null guard.** Add `if (!stored || typeof stored !== 'string') return false;` before the split.

8. **Add Redis/Upstash to production deployment.** Document this as a launch requirement. The in-memory rate limiter is insufficient for production at any scale.

9. **Add `x-csrf-token` to `Access-Control-Allow-Headers`** in `server.js:260`.

### P2 — Medium (Fix This Sprint)

10. **Implement locale persistence for churches.** Add `locale` to the onboard request schema, to `ALLOWED_PROFILE_COLUMNS` in `churchAuth.js:366`, and write it in the `UPDATE churches SET ...` statement at line 87. This is required for Spanish Telegram alerts to work.

11. **Validate the `generateRegistrationCode` function in `ctx` is properly bound with `db`.** Verify at the server.js context assembly point that `ctx.generateRegistrationCode = generateRegistrationCode.bind(null, db)` or equivalent.

12. **Add lifecycle email integration for reseller-created churches.** `reseller.js:181–234` should call `lifecycleEmails.sendRegistrationConfirmation()` after church creation.

13. **Implement `/fix preservice` Telegram bot command** referenced in `botI18n.js:55,114`.

14. **Add pagination/LIMIT to session timeline event and alert queries.** `sessions.js:181–184` fetches all events for a session unbounded.

15. **Notify church users when support ticket status changes.** Add SSE push or email when ticket is updated.

### P3 — Low (Backlog)

16. **Migrate portal inline `onclick` handlers to event listeners** to allow removing `unsafe-inline` from CSP.

17. **Complete portal i18n coverage** — add `data-i18n` to Referrals nav item, all page content sections, and connect the language toggle to a server-side locale preference.

18. **Add `DIAGNOSIS_TEMPLATES.canAutoFix: true`** for failure types that are in `RECOVERY_COMMANDS` so the alert UI accurately reflects auto-recovery capability.

19. **Add catch-up logic for monthly reports** when the relay restarts on the 1st of the month between 9:00 and 9:14 AM.

20. **Validate `logo_url` field** in reseller settings before storage.

21. **Add email format validation** on the onboard endpoint (not just `includes('@')`).

22. **Consider `requireFeature('campus_mode')` middleware** on campus-specific endpoints to enforce tier gating.

23. **Custom domain routing logic** for reseller portals — store is working, but serving content at the custom domain requires hostname-based routing middleware.
