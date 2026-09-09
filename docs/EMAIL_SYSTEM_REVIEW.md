# Tally Email System Review

**Audience:** Andrew (decide what to fix next without reading the whole codebase).  
**Repo:** `peterdisbrow/tally` @ `origin/main` (`864b6e2`)  
**Scope:** relay-server send paths. Landing (`tally-landing`) is not in this monorepo; live URLs on `tallyconnect.app` were probed 2026-09-09.  
**Method:** code + tests + live HTTP on GitHub release assets and marketing/portal URLs. No Resend dashboard, no Railway secret values, no Stripe Dashboard.  
**No secrets** in this doc.

### Shipped after this review (prepare-mode, no GTM)

Code landed in a follow-up PR (this note). Does **not** need Andrew secrets or Stripe Dashboard:

| ID | What |
|----|------|
| **P1-1** | Multi-recipient reports (session recap / weekly-leadership / monthly / post-service) now UNIQUE on `(church_id, email_type)` **including normalized recipient**. 2nd leader gets mail. Tests in `lifecycle-emails.test.js`, `weekly-digest-email.test.js`, `postServiceReport.test.js`. |
| **P1-2** | Support-ticket closed loop: open / admin reply / resolve now email church `portal_email` + Andrew/ops (`ADMIN_EMAIL` / `ADMIN_SEED_EMAIL`). Transactional (not lead drip). Recipient-scoped `email_sends` types. SSE still fires. Tests in `lifecycle-emails.test.js`, `supportTickets-routes.test.js`, `church-portal.test.js`. |
| **P1-5 + §9 + P1-4** | `runCheck` skips lead drip, NPS, reviews, referral, win-back, multi-cam/viewer nudges, anniversary. `sendLeadWelcome` / `sendFeatureAnnouncement` no-op. NPS stays off even if `ENABLE_LIFECYCLE_MARKETING=1` (`/nps` still 404; no landing page in this repo). Re-enable GTM with that env when selling is allowed. |
| **P1-7** | Unsubscribe sign + verify both use `UNSUBSCRIBE_SECRET \|\| JWT_SECRET` (`getUnsubscribeSecret()`). |
| **P1-8** | `sendDisputeAlert` now also notifies Andrew/ops via `ADMIN_EMAIL` (fallback `ADMIN_SEED_EMAIL`). Church `portal_email` still gets the mail. No new env product. |
| **P1-9** | `sendEmailChangeConfirmation` notifies **old inbox + new inbox**. |
| **P1-11** | `invoice-upcoming` month key treats Stripe unix **seconds** (and ms) consistently. |
| **P1-3** | EMERGENCY/CRITICAL with **no Telegram chat ID and no Slack webhook** now emails `portal_email` (+ `leadership_emails` if set) via `sendEmail`. Recipient-scoped 5-min window dedup. Prefs category `alerts` + suppressions honored. Empty schedule still log-only for non-EMERGENCY. |
| **P1-10** | One weekly digest job (`WeeklyDigest.sendChurchDigests`). ISO week key `weekly-digest-email-{YYYY-Www}:{email}`. Recipients = unique(`portal_email` + `leadership_emails`). Lifecycle `_checkWeeklyDigest` no longer sends. |
| **P2-17 (small)** | Lifecycle CTAs `${appUrl}/portal` → `/church-portal` (church portal, not reseller). |

Still deferred (needs ops / larger work): Railway `EMAIL_REPLY_TO` / `RESEND_WEBHOOK_SECRET` / key-team check; P1-6 env value; `/nps` landing in tally-landing; Stripe Dashboard; dedicated ALERT_BOT_TOKEN.

Companion audits: [`FEATURE_AUDIT_2026-09-08.md`](FEATURE_AUDIT_2026-09-08.md) (whole product; **stale** on Mac email URLs — #141 landed after it), [`ADMIN_DASHBOARD_REVIEW.md`](ADMIN_DASHBOARD_REVIEW.md) (Emails tab).

This answers: *every email Tally can send, what actually fires, which links work, and what to fix in prepare-mode (no sales spam).*

---

## Status legend

| Status | Meaning |
|--------|---------|
| **WORKS** | Code path exists; template + trigger wired; no live 404 on its primary CTA (or CTA is portal login, which redirects) |
| **PARTIAL** | Implemented but env-gated, dedup-broken for multi-recipient, copy/trigger mismatch, or marketing-only |
| **BROKEN** | Live 404 / wrong asset / unused injection / church never gets the mail |
| **DEAD** | Builder or method exists; nothing calls it in production wiring |
| **UNVERIFIED** | Cannot confirm without Resend/Stripe/Railway dashboards |

---

## 1. Architecture

There is **no Resend SDK** and **no nodemailer**. Every send goes through `relay-server/src/resendClient.js` → `fetch('https://api.resend.com/emails')` with `Authorization: Bearer` and `Idempotency-Key`. 10s abort timeout. SDK `{ data, error }` pattern does not apply — HTTP status is checked. 429 / 5xx / network retry up to 3 attempts with the **same** key. 4xx is not retried (except Resend `concurrent_idempotent_requests`).

```
Triggers (cron / webhook / HTTP)
        │
        ├─ LifecycleEmails.sendEmail()          ── primary path (dedup + throttle + opt-out + suppress + footer)
        ├─ LifecycleEmails.send* bypasses       ── password-reset, email-change, urgent-alert, sendManual
        ├─ LifecycleEmails.sendCriticalAlertEmail() ── EMERGENCY/CRITICAL, no Telegram dest + no Slack (via sendEmail)
        └─ server.js sendOnboardingEmail()      ── verification + first-app-connection only
                │
                ▼
        resendClient.sendResendEmail()  →  FROM_EMAIL + optional EMAIL_REPLY_TO
                │
                ▼
        email_sends  (UNIQUE church_id + email_type)
                │
                ▼
        POST /api/resend/webhook (Svix)  →  email_suppressions on bounce/complaint
```

| Piece | Where | Notes |
|-------|--------|--------|
| Engine | `relay-server/src/lifecycleEmails.js` (~4.6k lines) | Templates inline (HTML + some text). Admin overrides in `email_template_overrides`. |
| Onboarding bypass | `relay-server/server.js` `sendOnboardingEmail` / `buildConnectionEmailHtml` | Verification + “Tally is live”. Injects unsubscribe footer via `lifecycleEmails.injectUnsubscribeFooter` when `churchId` + `tag` present. **Does not write `email_sends`.** |
| Hourly cron | `server.js` `setInterval(..., 60 * 60 * 1000)` → `lifecycleEmails.runCheck()` | First tick is **one hour after boot**, not on startup. |
| Admin UI | `admin/src/components/EmailsTab.jsx` | History, stats, catalog, preview, override, resend, custom send. |
| Admin API | `src/adminPanel.js` `/api/admin/emails*` + `/api/admin/onboarding/nudge` | `sendManual` prefixes type `manual:…` (bypasses normal dedup). |
| Church prefs | `src/churchPortal.js` `/api/church/email-preferences` | Category on/off. |
| Unsubscribe | `GET /unsubscribe?token=` + `POST /unsubscribe/resubscribe` | JWT. Legacy `GET /api/notifications/unsubscribe` 302s to the new path. Live `GET /unsubscribe` without token → **400** (expected). |

### Env / config

| Env | Default in code | Effect |
|-----|-----------------|--------|
| `RESEND_API_KEY` | `''` | Empty → log “would send”, still **records** `email_sends` on the main path (so retries never go out later if the key is added). Startup **warns**, does not crash. |
| `FROM_EMAIL` | `Tally <noreply@tallyconnect.app>` | Used on every Resend call. |
| `EMAIL_REPLY_TO` | unset | Optional `reply_to`. Suggested: `support@tallyconnect.app`. If unset, Resend payloads omit `reply_to`. |
| `RESEND_WEBHOOK_SECRET` | unset | Svix `whsec_…` for `POST /api/resend/webhook`. Startup warns (not fatal) if the API key is set without this. |
| `TALLY_WIN_INSTALLER_URL` | derived from `relay-server/package.json` version | Emergency override for the Windows `.exe` in email CTAs. |
| `APP_URL` | `https://tallyconnect.app` | CTA host for most templates. |
| `RELAY_URL` | `https://api.tallyconnect.app` | Verification links + unsubscribe base. Production refuses verification send if this is not `https://`. |
| `UNSUBSCRIBE_SECRET` | falls back to `JWT_SECRET` | **Signer and verifier** both use `getUnsubscribeSecret()` = `UNSUBSCRIBE_SECRET \|\| JWT_SECRET`. |
| Feature flags / dry-run | `ENABLE_LIFECYCLE_MARKETING` | Default **off** (prepare-mode). Missing API key is still the “don’t deliver” switch. Set `=1` to re-enable lead drip / win-back / reviews / referral / feature nudges. **NPS stays off** until `/nps` exists. |

`FEATURE_AUDIT_2026-09-08.md` said Railway has `RESEND_API_KEY` and `FROM_EMAIL` / `UNSUBSCRIBE_SECRET` unset. **Not re-verified this session** (no Railway secret dump). Domain `tallyconnect.app` is treated as verified per product context; this review did not call Resend domains API.

**Ops note (Resend OAuth, this session):** connected Resend account shows domain `tallyconnect.app` **verified** and API keys named `tally-production` / `TallyConnect`, but **zero** recent sends, metrics, contacts, or webhooks. Before the next real send, confirm Railway `RESEND_API_KEY` belongs to **this same Resend team** (Dashboard → API Keys — do not print the key). A key from a different team would send from a different project (or fail) while this dashboard stays empty.

### From / reply-to / compliance

- **From:** `FROM_EMAIL` only. Spoofable only by whoever can set Railway env (not per-request).
- **Reply-To:** `EMAIL_REPLY_TO` when set. Many templates still say “reply to this email.” Set the env to `support@tallyconnect.app` (or Andrew) so replies do not depend on `noreply@` forwarding.
- **Physical address:** unsubscribe footer is `TallyConnect · support@tallyconnect.app`. **No postal address.** A unit test is named “CAN-SPAM physical-address line” but only asserts those two strings.
- **Unsubscribe:** injected for types that map to `EMAIL_CATEGORIES`. Transactional types (password reset, verification, most billing confirmations) skip footer. **Do not add a footer to those.** Lead drip and several dynamic types still do not map — see P1.
- **Suppression:** hard bounce (`email.bounced`) and complaint (`email.complained`) write `email_suppressions` and block **all** further sends to that address, including transactional. Soft bounce is `email.delivery_delayed` — Resend retries; we do not suppress.

---

## 2. Inventory

Recipient **portal** = `churches.portal_email`. **Leaders** = comma-split `churches.leadership_emails`. **Lead** = `sales_leads.email`.

CTA **portal** = `${APP_URL}/portal`. Live: `https://tallyconnect.app/portal` **307 →** `https://api.tallyconnect.app/church-portal` → login (**200**). Same for `/church-portal`.  
**Do not** use `https://api.tallyconnect.app/portal/` — that is the **reseller** login.

### 2.1 Auth / onboarding (transactional + setup)

| Type | Trigger | To | Subject (code) | Template | Primary CTA | Unsub? | Status |
|------|---------|----|----------------|----------|-------------|--------|--------|
| `email-verification` | Signup `churchAuth` + `POST /api/church/resend-verification` | portal | Confirm your email to activate your trial | Inline HTML in `churchAuth.js` / `emailVerification.js` via `sendOnboardingEmail` | `${RELAY_URL}/api/church/verify-email?token=` | no (exempt) | **WORKS** |
| `registration-confirmation` | Same signup, immediately after verify mail | portal | `{name} is registered — let's get started` | `_buildRegistrationEmail` | `/portal` + Mac/Win downloads | no | **WORKS** (two emails at once) |
| `welcome-verified` | `GET /api/church/verify-email` success | portal | Welcome to Tally, {name}! | `sendWelcomeVerified` | `/portal` + downloads + Telegram | no | **WORKS** |
| `connection-success` | First desktop WS connect (`onChurchConnected`) | portal | Tally is live at {name}! | `buildConnectionEmailHtml` | `/portal`; Telegram `/register {code}` | yes (onboarding) | **WORKS** |
| `setup-reminder` | Hourly: 24h–7d, app **not** connected, trial/active | portal | Your booth computer isn't connected yet… | `_buildSetupReminderEmail` | Download (ARM64 CTA) + OS links | yes | **WORKS** |
| `first-sunday-prep` | Hourly: 3–7d after signup, app **is** connected | portal | Get ready for your first Sunday with Tally | `_buildFirstSundayEmail` | `/portal` | yes | **WORKS** |
| `week-one-checkin` | Hourly: 5–10d after signup (any connect state) | portal | How's Tally working for you? | `_buildCheckinEmail` | reply / portal | yes | **WORKS** (registry still says Day 7) |
| `activation-escalation` | Hourly: Day 10–14, never connected | portal | Your Tally setup isn't complete — want us to help? | `_buildActivationEscalationEmail` | Download + reply | yes | **WORKS** |
| `telegram-setup-nudge` | Hourly: Day 5–10, connected, empty `telegram_chat_id` | portal | You're missing the best part of Tally | `_buildTelegramSetupNudgeEmail` | `/portal#notifications` | yes | **PARTIAL** (does not check Slack-only churches) |
| `schedule-setup-nudge` | Hourly: Day 7–14, connected, no `service_schedules` | portal | Tally works best when it knows your schedule | inline in checker | `/portal` | yes | **WORKS** |
| `pre-service-friday-*` | Hourly: service_time in 24–48h window | portal | Two days to Sunday — Tally is watching | `_buildPreServiceFridayEmail` | `/portal` | **no** (dynamic type not categorized) | **PARTIAL** |
| `first-service-completed` | Session recap: first non-test ended session | portal | First service in the books… | `_buildFirstServiceCompletedEmail` | `/portal` | no | **WORKS** |
| `trial-to-paid-onboarding` | Hourly: `subscribed_at` 24–48h ago, active | portal | 3 things to configure now that you're on {tier} | `_buildTrialToPaidOnboardingEmail` | portal hash links | yes | **WORKS** (paid-only) |

### 2.2 Trial / billing (Tally-sent)

Stripe **Checkout / Customer invoices** are **UNVERIFIED** here (Dashboard “successful payments” emails). Tally does **not** send a receipt PDF or `invoice.payment_succeeded` mail.

| Type | Trigger | To | Subject | CTA | Unsub? | Status |
|------|---------|----|---------|-----|--------|--------|
| `trial-ending-7days` | Hourly: trial ends ≤7d | portal | Your Tally trial ends in N day(s) — here's what you'll lose | `/portal` | yes (billing) | **WORKS** |
| `trial-ending-soon` | Hourly: ≤5d | portal | 3 days left… / ends in N days | `/portal` | yes | **WORKS** |
| `trial-ending-tomorrow` | Hourly: ≤24h | portal | Your Tally trial ends tomorrow | `/portal` | yes | **WORKS** |
| `trial-expired` | `checkExpiredTrials` in `server.js` | portal | Your Tally trial has ended | `/portal` | yes | **WORKS** (`urgent`) |
| `payment-failed` | Stripe `invoice.payment_failed` | portal | Action needed: payment failed for Tally | `/portal` | yes | **WORKS** (`urgent`) |
| `payment-confirmed` | Stripe `checkout.session.completed` (not reactivation) | portal | Payment confirmed — {name} is on {tier} | `/portal` | no | **WORKS** (not a receipt) |
| `invoice-upcoming-{YYYY-MM}` | Stripe `invoice.upcoming` | portal | Upcoming invoice: $X for Tally | `/church-portal` | **no** (prefix not mapped) | **WORKS** (P1-11 seconds/ms date key) |
| `cancellation-confirmation` | Stripe `customer.subscription.deleted` | portal | Your Tally subscription has been cancelled | `/portal` | no | **WORKS** |
| `cancellation-scheduled-{YYYY-MM}` | Portal self-serve cancel-at-period-end | portal | same subject, inline HTML | `/portal` | no | **WORKS** (second cancel mail possible when Stripe later deletes) |
| `upgrade-{old}-to-{new}` | Portal upgrade | portal | Plan upgraded to {Tier} | `/portal` | no | **WORKS** |
| `downgrade-{old}-to-{new}` | Portal downgrade | portal | Plan changed to {Tier} | `/portal` | no | **WORKS** |
| `reactivation-confirmation` | Checkout with `reactivation=true` | portal | Welcome back! Tally is monitoring again | `/portal` | no | **WORKS** |
| `grace-period-ending-early` | Hourly: ~5d left of grace | portal | Tally will be paused in N days… | `/portal` | yes | **WORKS** |
| `grace-period-ending` | Hourly: ~2d left | portal | same | `/portal` | yes | **WORKS** |
| `grace-expired` | `server.js` grace expiry job | portal | Tally monitoring paused — update payment… | `/portal` | no | **WORKS** |
| `annual-renewal-reminder-{date}` | Hourly: annual `current_period_end` in 28–30d | portal | Your annual Tally subscription renews in 30 days | `/portal` | **no** (dynamic) | **PARTIAL** |
| `dispute-alert-{id}` | Stripe `charge.dispute.created` | **church portal_email + Andrew/ops (`ADMIN_EMAIL`)** | Payment dispute opened — action required | `/portal` | no | **WORKS** (P1-8; church + ops, recipient-scoped dedup) |

Stripe `customer.subscription.trial_will_end` is **logged only** — lifecycle trial mails already cover it.

### 2.3 Sunday ops reports

| Type | Trigger | To | Subject | CTA | Unsub? | Status |
|------|---------|----|---------|-----|--------|--------|
| `session-recap-{sessionId}:{email}` | Session end → `sessionRecap` | **leaders only** | Service Recap: {name} — {day} {date} | `/church-portal?church={id}` | yes (prefix) | **WORKS** (P1-1 recipient-scoped dedup) |
| `service-report-{reportId}:{email}` | `postServiceReport.generate` after session | **leaders only** | Service Report — {name} · {date} | none in text (“view portal”) | no | **WORKS** for 2nd+ leader (P1-1); still overlaps recap |
| `weekly-digest-email-{ISO week}:{email}` | `weeklyDigest.js` Monday ~8am local; plus/pro/managed | **portal + leaders** (unique) | Your Week in Review — {name} | `/church-portal?church=` | yes | **WORKS** (P1-10 one job / ISO week / recipient dedup). Portal-only churches still mailed. |
| `monthly-report-email-{YYYY-MM}:{email}` | `monthlyReport.js` 1st-of-month path | portal **+** leaders | Monthly Production Report — {name} | `/church-portal?church=` | yes | **WORKS** for 2nd+ recipient (P1-1) |
| `monthly-roi-summary-{YYYY-MM}` | `sendMonthlyROISummary` | portal | {month} at {name} — here's what Tally prevented | `/portal` | yes | **DEAD** — nothing calls it |

### 2.4 Alerts vs Slack / Telegram

Realtime alerts are **not** email-first.

| Channel | When | Code |
|---------|------|------|
| **DB log** | All classified alerts | `alertEngine.sendAlert` |
| **Telegram** | WARNING+ in service window (or EMERGENCY anytime), if bot token + TD chat (on-call wins) | `sendTelegramMessage` |
| **Slack** | Same class, if `slack_webhook_url` | `sendSlackAlert` (independent of Telegram) |
| **Push** | If `pushNotifications` configured | Firebase — **CODE_ONLY** per feature audit |
| **Email** | (1) EMERGENCY/CRITICAL **immediately** if no Telegram dest **and** no Slack webhook → `sendCriticalAlertEmail`. (2) CRITICAL unacked after 5 min **and** a Telegram dest existed → `sendUrgentAlertEscalation` | portal_email (+ leaders on path 1) |
| **Email** | Support ticket opened / admin reply / resolved | portal_email + ops |

| Type | Trigger | To | Subject | Status |
|------|---------|----|---------|--------|
| `critical-alert-{type}-{window}:{email}` | EMERGENCY/CRITICAL, no Telegram chat ID, no Slack webhook | portal + `leadership_emails` | `{CRITICAL\|EMERGENCY}: {alertType} at {name}` | **WORKS** (P1-3). Uses `sendEmail` (`alerts` category, suppressions, recipient-scoped 5-min window). |
| `urgent-alert-{alertId}` | Escalation timer (only if Telegram dest existed) | portal | URGENT: {alertType} at {name} | **PARTIAL** — body says “90 seconds”; timer is **300_000 ms**. Bypasses `sendEmail` (no footer, no category). No stream-down email for WARNING. |
| `support-ticket-opened-{ticketId}:{email}` | Ticket create (`supportTickets.js` + church portal) | **church portal_email + Andrew/ops (`ADMIN_EMAIL`)** | Support ticket opened — {title} | **WORKS** (P1-2; transactional; recipient-scoped dedup) |
| `support-ticket-reply-{ticketId}-{updateId}:{email}` | Admin POST update (not church replies) | same | Tally support replied — {title} | **WORKS** (P1-2) |
| `support-ticket-resolved-{ticketId}:{email}` | Admin reply/PUT to resolved or closed | same | Support ticket resolved — {title} | **WORKS** (P1-2) |


### 2.5 Password / profile / invites / admin

| Type | Trigger | To | Subject | CTA | Status |
|------|---------|----|---------|-----|--------|
| `password-reset` | `POST /api/church/forgot-password` | portal | Reset your Tally password | **`/reset-password?token=`** (fixed this PR; was `/portal/reset-password` **404**) | **WORKS** after fix. Bypass dedup. 1h expiry. Enumeration-safe API. |
| `email-change-confirmation` | Portal profile email change | **old + new** email | Your Tally email has been updated | `/portal` | **WORKS** (P1-9) |
| `rundown-invite-{inviteId}` | Rundown collaborator invite | invitee email | {inviter} invited you to a rundown on {church} | `${APP_URL}/rundown/join?token=&plan=` | **WORKS** (`urgent`) |
| `manual:onboarding_nudge` | Admin `POST /api/admin/onboarding/nudge` | portal | Continue setting up {name} on Tally | none (plain HTML) | **PARTIAL** — handler returns `{sent:true}` even if Resend failed |
| `manual:{type}` / `custom` | Admin Emails tab send/resend | chosen | preview or custom | n/a | **WORKS** if API key set |
| `feature-announcement-{key}` | `sendFeatureAnnouncement` (admin-triggered if wired) | all active portals | caller subject | caller CTA | **PARTIAL** — `body` HTML **not escaped**; blast to every active church |

Portal team “invites” (TD accounts) are **not** an email type in this repo — only rundown collaborator invites send mail.

### 2.6 Lifecycle / GTM (pause in prepare-mode)

| Type | Trigger | To | Subject | Status |
|------|---------|----|---------|--------|
| `lead-welcome` | `POST /api/leads/capture` | lead | Here's how churches are running stress-free services | **PARTIAL** — sales drip. `churchId` stored as `lead:{email}` |
| `lead-day3-value` | Hourly, lead age 3–7d | lead | 3 problems Tally solves before Sunday | **PARTIAL** — CTA says “14 days” trial; signup copy says 30 |
| `lead-day7-casestudy` | Hourly, 7–14d | lead | How one church eliminated stream failures | **PARTIAL** — “300-member church in Texas” is **not** sourced in this repo (same class as marketing testimonials) |
| `lead-day14-offer` | Hourly, 14–30d | lead | Ready to try Tally? Start your free trial | **PARTIAL** — last drip; no list-unsub category |
| `review-request` | Hourly: 30–90d active, 4+ sessions, 2+ Clean, no `church_reviews` | portal | {name} is crushing it — mind sharing a quick review? | **PARTIAL** — `/church-portal?action=review` |
| `nps-survey` | Hourly: Day 60–65 active | portal | Quick question — how likely are you to recommend Tally? | **BROKEN** CTA — `https://tallyconnect.app/nps?…` live **404** |
| `referral-invite` | Hourly: Day 90–95, 4+ sessions | portal | Know another church production team… | **PARTIAL** — honor-system “mention our church”; one month free is billing-side |
| `early-win-back` | Hourly: cancel 7–14d | portal | How'd Sunday go without Tally? | **PARTIAL** (sales/retention) |
| `win-back` | Hourly: cancel 14–30d | portal | We miss you at Tally… | **PARTIAL** (registry says 30–60d — **wrong**) |
| `cancellation-survey` | Hourly: cancel 3–10d | portal | Quick question — what could we have done better? | **PARTIAL** |
| `inactivity-alert` | Hourly: active, connected, registered ≥30d, no session in 30d | portal | We haven't seen any services lately… | **WORKS** (ops, not spam) |
| `multi-cam-nudge` | Hourly: Day 21–28, Plus+, ≤1 room | portal | Did you know Tally can monitor multiple cameras? | **PARTIAL** (GTM) |
| `viewer-analytics-nudge` | Hourly: Day 30–40, paid, no stream platform | portal | See how many people are watching your stream | **PARTIAL** (GTM) |
| `first-year-anniversary` | Hourly: Day 365–368 active | portal | {name} just completed one year with Tally | **PARTIAL** |

`EMAIL_REGISTRY` in the same file is what the admin Templates UI shows. It is **incomplete vs live types** (`trial-ending-7days`, `connection-success` preview missing, `schedule-setup-nudge` / `multi-cam-nudge` / `viewer-analytics-nudge` not in `getPreview` map → “Unknown email type”). Several **trigger strings are stale**.

---

## 3. Download / asset URLs (#141)

#141 is **merged**. Current constants:

```
https://github.com/peterdisbrow/tally/releases/latest/download/Tally-arm64.dmg
https://github.com/peterdisbrow/tally/releases/latest/download/Tally-x64.dmg
https://github.com/peterdisbrow/tally/releases/latest/download/Tally-Setup-<relay-server/package.json version>.exe
```

`DOWNLOAD_MAC_URL` (primary button) = **Apple Silicon only**.

Windows filename is **versioned by electron-builder**. There is no versionless `Tally-Setup.exe` on GitHub `latest/download`, and resolving via the GitHub API at send time is not safe (timeout / rate-limit). Emails now derive `Tally-Setup-${version}.exe` from `relay-server/package.json` (currently **1.1.67**). Keep Electron `package.json` on the same version when you cut a release. Emergency override: `TALLY_WIN_INSTALLER_URL`.

Live probe 2026-09-09 (GitHub `latest` = **v1.1.67**):

| Asset | HEAD follow | Notes |
|-------|-------------|--------|
| `Tally-arm64.dmg` | **200** | Versionless name — survives next tag |
| `Tally-x64.dmg` | **200** | Same |
| `Tally-Setup-1.1.67.exe` | **200** | Matches current `package.json`. Next Windows ship: bump relay + Electron version together |
| `Tally-signed.dmg` on latest | **404** | Old hardcoded name; **no longer referenced** |
| Linux `.AppImage` | **404** | **No Linux installer** on this release. Emails correctly omit Linux |

Release also carries `Tally-1.1.66-*-mac.zip` (auto-update channel). Emails do not link zips.

Tests: `lifecycle-emails.test.js` asserts latest URLs and **no** `v1.0.1` / `Tally-signed.dmg` in setup / registration / activation / welcome-verified preview.

---

## 4. What’s working

- Shared Resend REST helper (`resendClient.js`) with timeout, sanitized tags, `Idempotency-Key`, `reply_to`, and 429/5xx/network retry.
- Dedup + 5-minute per-church throttle (bypass with `urgent`) on the main path.
- Church-level category prefs + per-recipient unsubscribe table + JWT unsubscribe page + resubscribe.
- Signup → verify → welcome → connection → setup / first-Sunday / Telegram / schedule nudges is a real onboarding spine.
- Billing webhooks cover failed payment, checkout confirm, cancel, dispute, upcoming invoice, reactivation.
- Admin can preview, override HTML, and send/resend without a deploy.
- Password reset API is rate-limited and does not enumerate accounts.
- #141 download links match current GitHub latest (Mac + Win 1.1.67).
- Alerts that matter on Sunday go to **Telegram / Slack**, not an inbox the TD is not watching.

---

## 5. Gaps and bugs (prioritized)

### P0 — broken path / reliability / compliance (this PR)

| ID | Issue | Evidence | Fix shape |
|----|--------|----------|-----------|
| P0-1 | **Password reset CTA 404.** Mail used `${APP_URL}/portal/reset-password`. Live `tallyconnect.app/portal/reset-password` **404**. Real page: `https://tallyconnect.app/reset-password` **200**. | Probe 2026-09-09; `emailVerification.js`; landing `/forgot-password` **200** | **Fixed:** CTA → `/reset-password?token=`. Preview + test updated. |
| P0-2 | **No Idempotency-Key** on Resend POST | All five fetch sites | **Fixed:** `tally/${churchId}/${emailType}`; password-reset / verify use token (`requestId`). |
| P0-3 | **No retry** on 429 / 5xx / network | Single fetch, 10s abort | **Fixed:** max 3 attempts, same key, exponential backoff. 4xx not retried. |
| P0-4 | **No Resend webhooks** | Account had zero webhooks | **Fixed:** signed `POST /api/resend/webhook`. Bounce/complaint → `email_suppressions`. |
| P0-5 | **Unsanitized tags** | `category` = raw `emailType` (`manual:…`, weekly keys) | **Fixed:** alphanumeric / underscore / dash only. |
| P0-6 | **No `reply_to`** | Templates say “reply to this email” | **Fixed:** `EMAIL_REPLY_TO` (optional). Set on Railway to `support@tallyconnect.app`. |
| P0-7 | **Win exe pin** | Hardcoded `Tally-Setup-1.1.67.exe` | **Fixed:** derived from `relay-server/package.json` version; `TALLY_WIN_INSTALLER_URL` override. |

### P1 — churches / Andrew will feel this

| ID | Issue | Evidence | Fix shape |
|----|--------|----------|-----------|
| P1-1 | **Multi-recipient reports send once.** `email_sends` is UNIQUE `(church_id, email_type)`. Recap / weekly-leadership / monthly / post-service use one type per session/week/month, then loop leaders. Second address → `already-sent`. | `sendSessionRecapEmail`, `sendWeeklyDigestEmail`, `sendMonthlyReportEmail`, `postServiceReport._sendReportEmail` | **Fixed:** `emailType` includes normalized recipient; reports send `urgent` so the 5-min church throttle does not drop the 2nd leader. |
| P1-2 | **No support-ticket email.** Open / admin reply / resolve = SSE only. `lifecycleEmails` unused in the route module. | `supportTickets.js` | **Fixed:** church + ops mail on open; church + ops on admin reply and resolve/close. SSE kept. Not marketing. |
| P1-3 | **No stream-down / outage email.** Email only after CRITICAL + 5 min no Telegram ack. Booths without Telegram/Slack get **nothing**. | `alertEngine.js` | **Fixed:** `sendCriticalAlertEmail` on EMERGENCY/CRITICAL when Telegram dest and Slack webhook are both unset. Portal + leaders. `alerts` prefs + suppressions. Windowed recipient-scoped dedup. Empty schedule still log-only. |
| P1-4 | **NPS buttons 404.** | Live `tallyconnect.app/nps` **404** | **Don't send** until landing exists. `isNpsSurveyEnabled()` is hard-false. Do **not** invent `/nps` in this repo. |
| P1-5 | **Lead drip has no unsubscribe category.** Marketing to captured emails. Footer not injected. | `_getCategoryForType` returns null for `lead-*` | **Fixed (prepare-mode):** `_checkLeadNurture` + `sendLeadWelcome` gated off. Capture still stores the lead. Re-enable with `ENABLE_LIFECYCLE_MARKETING=1` (then add `lead-nurture` category before sending). |
| P1-6 | **“Reply to this email” with `noreply@`.** | Code now sends `reply_to` when `EMAIL_REPLY_TO` is set | **Code done.** Still need the Railway env value. |
| P1-7 | **Unsubscribe secret split-brain.** Signer = `JWT_SECRET`; verifier = `UNSUBSCRIBE_SECRET \|\| JWT_SECRET`. | `lifecycleEmails.js` vs `server.js` | **Fixed:** both use `getUnsubscribeSecret()`. |
| P1-8 | **Dispute mail goes to the church, not ops.** | `sendDisputeAlert` → `portal_email` | **Fixed:** also send to `ADMIN_EMAIL` (fallback `ADMIN_SEED_EMAIL`). |
| P1-9 | **Email-change notice skips the old inbox.** | `sendEmailChangeConfirmation` | **Fixed:** send to old + new. |
| P1-10 | **Two weekly digest engines.** Portal `weekly-digest-*` Monday UTC vs leaders `weekly-digest-email-*` with a different week-id. | both files | **Fixed:** one job (`sendChurchDigests`), ISO week key, recipient in dedup key. Portal-only churches still get the leadership report. |
| P1-11 | **`invoice-upcoming` month key.** `monthKey = new Date(dueDate)` treats Stripe unix **seconds** as ms → epoch month; builder then does `dueDate * 1000`. Dedup / date can be wrong. | `sendInvoiceUpcoming` vs `_buildInvoiceUpcomingEmail` | **Fixed:** `stripeTimestampToDate` accepts seconds or ms. |

### P2 — polish / prepare-mode / drift

| ID | Issue | Notes |
|----|--------|------|
| P2-1 | Windows exe name follows `package.json` | Keep Electron version in sync; override with `TALLY_WIN_INSTALLER_URL` if a release is mis-tagged. |
| P2-2 | Primary Download button is ARM64 only | Intel Macs must use the text link. |
| P2-3 | No Linux email link | Correct today (no asset). Don’t advertise until an AppImage exists. |
| P2-4 | `sendMonthlyROISummary` **DEAD** | Monthly already sends `sendMonthlyReportEmail`. Delete or wire one. |
| P2-5 | Registry / preview drift | Day-7 vs Day-5 check-in; win-back window; missing `getPreview` types. |
| P2-6 | Escalation copy “90 seconds” vs 5 min timer | Align copy or timer. |
| P2-7 | `church.name` often unescaped in HTML | `_esc` exists; many builders skip it. |
| P2-8 | Feature-announcement `body` is raw HTML | Admin XSS into every active church. |
| P2-9 | Signup sends **two** emails immediately | Verify + registration. Consider one. |
| P2-10 | Resend webhooks | **Done** — bounce/complaint suppress. Opened/clicked accepted, ignored. |
| P2-11 | Send idempotency keys | **Done** on all five send paths. |
| P2-12 | `sendOnboardingEmail` not in `email_sends` | Admin history misses verification + connection-success. |
| P2-13 | `no-api-key` still records send | Adding a key later will not backfill. |
| P2-14 | Admin nudge ignores `result.sent` | UI can lie. |
| P2-15 | Telegram nudge ignores Slack-only setup | Day-5 mail is wrong if they already have Slack. |
| P2-16 | `pre-service-friday-*` / `annual-renewal-reminder-*` uncategorized | No unsub footer. |
| P2-17 | Mixed portal URLs | **Lifecycle CTAs** now `/church-portal`. Marketing `/portal` still 307s. |
| P2-18 | Lead “case study” + trial length inconsistency | Don’t ship as proof. |
| P2-19 | PII in logs | `sendEmail` / password-reset / leads log full recipient email. |
| P2-20 | Rate limits | Helper now backs off on 429 (max 3). Cron can still burst across churches. |
| P2-21 | `getPreview` setup-reminder subject ≠ live subject | Admin preview lies. |

---

## 6. Test coverage

| Area | File | What it proves | Missing |
|------|------|----------------|---------|
| Engine | `tests/lifecycle-emails.test.js` | Builders, **#141 URLs**, send/dedup/throttle, overrides, footer inject, opt-out, retry/idempotency, suppression | Multi-recipient, most sequence HTML, Linux |
| Resend helper | `tests/resendClient.test.js` | Tags, keys, 429 retry, 4xx no-retry, Svix verify | — |
| Resend webhook | `tests/resendWebhook.test.js` | 503 / 400 / bounce+complaint suppress | — |
| Engine + PG cache | `tests/lifecycle-emails.query-client.test.js` | Dedup/prefs/unsub on query client | — |
| Weekly / monthly HTML | `tests/weekly-digest-email.test.js`, `weeklyDigest.test.js` | Subjects, ISO week key, portal+leader union, month keys | — |
| Verify / reset API | `tests/emailVerification*.test.js` | Verify, resend, forgot, reset token | Live landing URL (added assertion this PR) |
| Recap / report send | `tests/postServiceReport.test.js`, `weeklyDigest.test.js` | Calls `sendEmail` / digest when leaders set | Does **not** assert second recipient |
| Unreachable-channel alert email | `tests/lifecycle-emails.test.js`, `tests/telegram-alert-delivery.test.js` | P1-3: portal+leaders, windowed recipient dedup, prefs/suppress, no email when Telegram/Slack dest exists, empty-schedule still log-only | Live Resend |
| Tickets | `tests/supportTickets-routes.test.js` | CRUD / triage + open/reply/resolve email wiring | Telegram / AI-triage open paths |

No test hits the live Resend API. `reply_to` and sanitized tags are asserted against mocked fetch. No Linux assets.

---

## 7. Sunday / church onboarding gaps

Already present and useful in prepare-mode: verification, welcome, connection-success, setup reminder, first-Sunday prep, Friday checklist, first-service recap, Telegram/schedule nudges, billing dunning.

**Missing or weak for a real booth:**

1. **Ticket closed-loop email** — **done (P1-2).** Open / admin reply / resolve go to portal_email + ops.
2. **Stream-down / encoder-down email** when Telegram/Slack unset — **done** for EMERGENCY/CRITICAL (`sendCriticalAlertEmail`). WARNING stays Telegram/Slack/log-only.
3. **Registration code in setup-reminder** (connection-success has `/register CODE`; setup-reminder does not repeat the code).
4. **One first-Sunday packet** (gear green, Telegram, schedule, who gets recaps) instead of four overlapping Day 3–7 mails + trial-ending-7d on the same week.
5. **Post-service follow-up that is one email**, not recap + AI report + (maybe) weekly.
6. **Working reply path** to a human (`reply_to`).
7. **Linux booth** download when/if you ship it.

---

## 8. Risk notes

| Risk | Detail |
|------|--------|
| PII in logs | Recipient email + church name on success and failure. Password reset logs church name after token create. Leads log email + source. |
| Tokens in email | Verify, reset, rundown invite, unsubscribe JWT (365d). Reset is 1h. Unsubscribe JWT is long-lived; treat `UNSUBSCRIBE_SECRET` rotation as a breaking change (and fix signer first). |
| Reset token in query string | Standard; landing must stay HTTPS. |
| From spoof | Only via env. Per-request `from` is not user-controlled. |
| Admin HTML override / feature body | Stored HTML sent as-is. |
| Rate limit | Cron + admin blast + lead drip can 429; helper retries the same send 3×. Still do not blast. |
| Dedup vs “no key” | Silent “sent” in DB without delivery. |
| `churchId` for leads | `lead:user@domain` in `email_sends.church_id`. |

---

## 9. Prepare-mode sequence (no sales spam)

Sales/GTM is paused. Keep **trust + setup + Sunday + money**. Turn **off** nurture/review/NPS/referral/win-back blasts until you are allowed to sell.

### Keep (reliability / onboarding)

| When | Type | Why |
|------|------|-----|
| T+0 | `email-verification` only (drop simultaneous `registration-confirmation` if you want one inbox hit) | Account exists |
| Verify click | `welcome-verified` | Downloads + Telegram + schedule |
| First app connect | `connection-success` | “You’re live” + `/register CODE` |
| T+24h if not connected | `setup-reminder` | Correct download URLs |
| T+3d if connected | `first-sunday-prep` | Booth checklist |
| T+5d if no Telegram **and** no Slack | `telegram-setup-nudge` (after Slack check) | Alerts that actually page |
| T+7d if no schedule | `schedule-setup-nudge` | Pre-flight needs times |
| 24–48h before first service | `pre-service-friday-*` | Friday calm |
| First real session | `first-service-completed` | Proof |
| Each service | **one** of recap **or** post-service report to leaders (fix P1-1) | Leadership trust |
| Trial 7 / 3 / 1 / expired | existing trial set | Honest clock |
| Payment fail / grace / upcoming invoice | existing billing set | Don’t lose Sunday monitoring |
| Password reset / email change (both addresses) | transactional | Security |
| CRITICAL unacked | urgent email **plus** Telegram/Slack | Backup page |
| CRITICAL/EMERGENCY, no Telegram dest, no Slack | `critical-alert-*` to portal (+ leaders) | Backup page when paging channels are unset |

### Pause (code stays; don’t fire)

Disable in `runCheck()` and/or lead capture until GTM is allowed:

- `_checkLeadNurture` + `sendLeadWelcome` (`POST /api/leads/capture` can store the lead without mailing)
- `_checkReviewRequest`, `_checkNPSSurvey`, `_checkReferralInvite`
- `_checkEarlyWinBack`, `_checkWinBack`, `_checkCancellationSurvey`
- `_checkMultiCamNudge`, `_checkViewerAnalyticsNudge`, `_checkFirstYearAnniversary`
- `sendFeatureAnnouncement` (manual blast)

Keep **inactivity-alert** — that is ops (“is the booth offline?”), not a campaign.

### Admin

Use Emails tab for **one-off** human notes (onboarding nudge, custom). Do not “resend catalog” lead/NPS templates.

---

## 10. Recommended next fixes (order)

P0 reliability/compliance in this PR is done. Remaining, in order:

1. **Railway:** set `EMAIL_REPLY_TO` and `RESEND_WEBHOOK_SECRET`; confirm `RESEND_API_KEY` is the same team as the verified `tallyconnect.app` domain (§11).
2. **P1-2 / P1-3 done** — ticket closed-loop email and unreachable-channel CRITICAL/EMERGENCY email.
3. **P1-4** — `/nps` landing in tally-landing (send path already gated off).
4. **P1-8 / P1-9** — **done:** dispute→Andrew (`ADMIN_EMAIL`); email-change notice to old + new inbox.
5. **P1-10** — **done:** one weekly digest job.

**Done in code (no Railway):** P1-1 recipient dedup, P1-2 ticket closed-loop email, P1-3 unreachable-channel critical email, P1-5/§9 prepare-mode pause, P1-7 unsub secret, P1-8 dispute→ops, P1-9 email-change both inboxes, P1-10 one weekly job, P1-11 invoice month key, lifecycle `/church-portal` CTAs.

Do **not** build Resend Broadcasts / Automations (sales gated). Do **not** mass-email existing churches. Do **not** move everything to dashboard templates — code templates + admin overrides are fine.

---

## 11. Best-practices scorecard + Railway / Resend setup

Scored against Resend sending + webhook guidance (idempotency, retry, Svix, tags, reply-to, suppression). Not a marketing scorecard.

| Practice | Score | Notes |
|----------|-------|-------|
| Idempotency-Key on every send | **Done** | `tally/${churchId}/${emailType}`; token/request id for reset + verify |
| Retry 429/5xx/network only | **Done** | Max 3, same key. No 4xx retry except concurrent 409 |
| Signed delivery webhooks | **Done in code** | Needs Railway secret + Resend endpoint (below) |
| Suppress hard bounce / complaint | **Done** | `email_suppressions`; blocks lifecycle + bypass + onboarding |
| Tag charset | **Done** | `[A-Za-z0-9_-]` |
| Reply-To | **Code done** | Set `EMAIL_REPLY_TO` on Railway |
| CAN-SPAM unsub on marketing/lifecycle | **Kept** | Categorized types still get footer |
| Transactional footer-free | **Kept** | password-reset, verify, billing-action / uncategorized unchanged |
| From on verified domain | **Ops** | Domain verified in Resend; confirm Railway key is that team |
| Webhooks actually created | **Ops** | Zero webhooks in the connected account at review time |
| Recent send metrics | **Ops** | Zero — either unused key or key/team mismatch |
| Dashboard templates / Broadcasts | **Won’t do** | Sales gated; code templates stay |
| Postal address | **Open (P2)** | Footer has support@ only |

### Create the webhook (once)

1. Resend Dashboard → **Webhooks** → Add endpoint  
   **URL:** `https://api.tallyconnect.app/api/resend/webhook`  
   **Events:** `email.bounced`, `email.complained`, `email.delivered`, `email.failed`  
   (optional: `email.opened`, `email.clicked` — accepted, ignored)
2. Copy the signing secret (`whsec_…`). It is shown **once**.
3. Railway → relay service → Variables:
   - `RESEND_WEBHOOK_SECRET` = that `whsec_…` value (do not commit it)
   - `EMAIL_REPLY_TO` = `support@tallyconnect.app` (or Andrew’s inbox)
   - Confirm `RESEND_API_KEY` is from **this** Resend team (keys named `tally-production` / `TallyConnect` in the connected account). Do not paste the key into chat or docs.
   - `FROM_EMAIL` can stay `Tally <noreply@tallyconnect.app>`
4. Redeploy. Health check `resend_webhook` should go from degraded → operational.
5. Resend → Webhooks → send a test, or use `bounced@resend.dev` / `complained@resend.dev` on a **single** test send. Confirm `email_suppressions` gets a row. Do **not** mail the church list.

cURL equivalent (run locally with your key; secret is only in the create response):

```bash
curl -X POST 'https://api.resend.com/webhooks' \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "endpoint": "https://api.tallyconnect.app/api/resend/webhook",
    "events": ["email.bounced","email.complained","email.delivered","email.failed"]
  }'
```

Then store `signing_secret` as Railway `RESEND_WEBHOOK_SECRET`.

### Win installer bump

1. Bump `relay-server/package.json` **and** the Electron app version to the same `x.y.z`.
2. Publish GitHub release assets including `Tally-Setup-x.y.z.exe`.
3. Emails pick up the new filename from `package.json` on deploy. No hardcoded constant.
4. If a release is published under a different filename, set `TALLY_WIN_INSTALLER_URL` temporarily.

---

## 12. What this review did not verify

- Whether Railway `RESEND_API_KEY` is the same team as the connected Resend OAuth (zero sends is the clue — do not print the key).
- Whether `noreply@tallyconnect.app` is forwarded.
- Stripe Dashboard “email customers” receipts.
- Railway current values of `FROM_EMAIL` / `EMAIL_REPLY_TO` / `UNSUBSCRIBE_SECRET` / `APP_URL` (code defaults assumed; prior audit said key present, FROM unset).
- Landing implementation of `/reset-password` (only that it returns 200 HTML).
- Whether `runCheck` has ever succeeded against production Postgres (no metrics invented).
)
