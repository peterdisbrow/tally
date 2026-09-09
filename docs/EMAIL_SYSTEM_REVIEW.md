# Tally Email System Review

**Audience:** Andrew (decide what to fix next without reading the whole codebase).  
**Repo:** `peterdisbrow/tally` @ `origin/main` (`864b6e2`)  
**Scope:** relay-server send paths. Landing (`tally-landing`) is not in this monorepo; live URLs on `tallyconnect.app` were probed 2026-09-09.  
**Method:** code + tests + live HTTP on GitHub release assets and marketing/portal URLs. No Resend dashboard, no Railway secret values, no Stripe Dashboard.  
**No secrets** in this doc.

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

There is **no Resend SDK** and **no nodemailer**. Every send is `fetch('https://api.resend.com/emails')` with `Authorization: Bearer`. No idempotency keys. 10s abort timeout. SDK `{ data, error }` pattern does not apply — HTTP status is checked.

```
Triggers (cron / webhook / HTTP)
        │
        ├─ LifecycleEmails.sendEmail()          ── primary path (dedup + throttle + opt-out + footer)
        ├─ LifecycleEmails.send* bypasses       ── password-reset, email-change, urgent-alert, sendManual
        └─ server.js sendOnboardingEmail()      ── verification + first-app-connection only
                │
                ▼
        Resend REST  →  FROM_EMAIL  →  one `to` address
                │
                ▼
        email_sends  (UNIQUE church_id + email_type)
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
| `FROM_EMAIL` | `Tally <noreply@tallyconnect.app>` | Used on every Resend call. **No `reply_to` field anywhere.** |
| `APP_URL` | `https://tallyconnect.app` | CTA host for most templates. |
| `RELAY_URL` | `https://api.tallyconnect.app` | Verification links + unsubscribe base. Production refuses verification send if this is not `https://`. |
| `UNSUBSCRIBE_SECRET` | falls back to `JWT_SECRET` | **Verifier** uses this. **Token signer** (`_buildUnsubscribeFooter`) uses `getJwtSecret()` = `JWT_SECRET` only. If `UNSUBSCRIBE_SECRET` is ever set to a *different* value, unsubscribe links 400. |
| Feature flags / dry-run | none | Missing API key is the only “don’t send” switch. No `DISABLE_EMAILS`. |

`FEATURE_AUDIT_2026-09-08.md` said Railway has `RESEND_API_KEY` and `FROM_EMAIL` / `UNSUBSCRIBE_SECRET` unset. **Not re-verified this session** (no Railway secret dump). Domain `tallyconnect.app` is treated as verified per product context; this review did not call Resend domains API.

### From / reply-to / compliance

- **From:** `FROM_EMAIL` only. Spoofable only by whoever can set Railway env (not per-request).
- **Reply-To:** unset. Many templates say “reply to this email” / “every response goes straight to our team.” Replies hit `noreply@…` unless the mailbox is forwarded in the email host (UNVERIFIED).
- **Physical address:** unsubscribe footer is `TallyConnect · support@tallyconnect.app`. **No postal address.** A unit test is named “CAN-SPAM physical-address line” but only asserts those two strings.
- **Unsubscribe:** injected for types that map to `EMAIL_CATEGORIES`. Transactional types (password reset, verification, most billing confirmations) skip footer. **Lead drip and several dynamic types do not map** — see P1.

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
| `invoice-upcoming-{YYYY-MM}` | Stripe `invoice.upcoming` | portal | Upcoming invoice: $X for Tally | `/portal` | **no** (prefix not mapped) | **PARTIAL** (date key bug — §5) |
| `cancellation-confirmation` | Stripe `customer.subscription.deleted` | portal | Your Tally subscription has been cancelled | `/portal` | no | **WORKS** |
| `cancellation-scheduled-{YYYY-MM}` | Portal self-serve cancel-at-period-end | portal | same subject, inline HTML | `/portal` | no | **WORKS** (second cancel mail possible when Stripe later deletes) |
| `upgrade-{old}-to-{new}` | Portal upgrade | portal | Plan upgraded to {Tier} | `/portal` | no | **WORKS** |
| `downgrade-{old}-to-{new}` | Portal downgrade | portal | Plan changed to {Tier} | `/portal` | no | **WORKS** |
| `reactivation-confirmation` | Checkout with `reactivation=true` | portal | Welcome back! Tally is monitoring again | `/portal` | no | **WORKS** |
| `grace-period-ending-early` | Hourly: ~5d left of grace | portal | Tally will be paused in N days… | `/portal` | yes | **WORKS** |
| `grace-period-ending` | Hourly: ~2d left | portal | same | `/portal` | yes | **WORKS** |
| `grace-expired` | `server.js` grace expiry job | portal | Tally monitoring paused — update payment… | `/portal` | no | **WORKS** |
| `annual-renewal-reminder-{date}` | Hourly: annual `current_period_end` in 28–30d | portal | Your annual Tally subscription renews in 30 days | `/portal` | **no** (dynamic) | **PARTIAL** |
| `dispute-alert-{id}` | Stripe `charge.dispute.created` | **church portal_email** | Payment dispute opened — action required | `/portal` | no | **PARTIAL** (should page Andrew, not only the church) |

Stripe `customer.subscription.trial_will_end` is **logged only** — lifecycle trial mails already cover it.

### 2.3 Sunday ops reports

| Type | Trigger | To | Subject | CTA | Unsub? | Status |
|------|---------|----|---------|-----|--------|--------|
| `session-recap-{sessionId}` | Session end → `sessionRecap` | **leaders only** | Service Recap: {name} — {day} {date} | `/church-portal?church={id}` | yes (prefix) | **BROKEN** for 2nd+ leader (§5) |
| `service-report-{reportId}` | `postServiceReport.generate` after session | **leaders only** | Service Report — {name} · {date} | none in text (“view portal”) | no | **BROKEN** for 2nd+ leader; overlaps recap |
| `weekly-digest-{ISO week}` | Hourly Monday 13–16 UTC, Pro/managed, activity | **portal** | Weekly Report — {name} | `/portal` | yes | **WORKS** |
| `weekly-digest-email-{weekStr}` | `weeklyDigest.js` (separate job) | **leaders** | Your Week in Review — {name} | `/church-portal?church=` | yes | **BROKEN** for 2nd+ leader; **double weekly** if both jobs run |
| `monthly-report-email-{YYYY-MM}` | `monthlyReport.js` 1st-of-month path | portal **+** leaders | Monthly Production Report — {name} | `/church-portal?church=` | yes | **BROKEN** for 2nd+ recipient |
| `monthly-roi-summary-{YYYY-MM}` | `sendMonthlyROISummary` | portal | {month} at {name} — here's what Tally prevented | `/portal` | yes | **DEAD** — nothing calls it |

### 2.4 Alerts vs Slack / Telegram

Realtime alerts are **not** email-first.

| Channel | When | Code |
|---------|------|------|
| **DB log** | All classified alerts | `alertEngine.sendAlert` |
| **Telegram** | WARNING+ in service window (or EMERGENCY anytime), if bot token + TD chat (on-call wins) | `sendTelegramMessage` |
| **Slack** | Same class, if `slack_webhook_url` | `sendSlackAlert` (independent of Telegram) |
| **Push** | If `pushNotifications` configured | Firebase — **CODE_ONLY** per feature audit |
| **Email** | CRITICAL, **unacked after 5 minutes**, then `sendUrgentAlertEscalation` | portal_email |

| Type | Trigger | To | Subject | Status |
|------|---------|----|---------|--------|
| `urgent-alert-{alertId}` | Escalation timer | portal | URGENT: {alertType} at {name} | **PARTIAL** — body says “90 seconds”; timer is **300_000 ms**. Bypasses `sendEmail` (no footer, no category). No stream-down email for WARNING. |

**No ticket email.** `supportTickets.js` accepts `lifecycleEmails` and never calls it. Create/update notifies via **SSE** only (`support_ticket_update`). Church does not get mail when Andrew replies.

### 2.5 Password / profile / invites / admin

| Type | Trigger | To | Subject | CTA | Status |
|------|---------|----|---------|-----|--------|
| `password-reset` | `POST /api/church/forgot-password` | portal | Reset your Tally password | **`/reset-password?token=`** (fixed this PR; was `/portal/reset-password` **404**) | **WORKS** after fix. Bypass dedup. 1h expiry. Enumeration-safe API. |
| `email-change-confirmation` | Portal profile email change | **new** email only | Your Tally email has been updated | `/portal` | **PARTIAL** — old address not notified |
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
https://github.com/peterdisbrow/tally/releases/latest/download/Tally-Setup-1.1.67.exe
```

`DOWNLOAD_MAC_URL` (primary button) = **Apple Silicon only**.

Live probe 2026-09-09 (GitHub `latest` = **v1.1.67**):

| Asset | HEAD follow | Notes |
|-------|-------------|--------|
| `Tally-arm64.dmg` | **200** | Versionless name — survives next tag |
| `Tally-x64.dmg` | **200** | Same |
| `Tally-Setup-1.1.67.exe` | **200** | **Versioned filename.** Next Windows ship **must** bump `DOWNLOAD_WIN_URL` or the email 404s |
| `Tally-signed.dmg` on latest | **404** | Old hardcoded name; **no longer referenced** |
| Linux `.AppImage` | **404** | **No Linux installer** on this release. Emails correctly omit Linux |

Release also carries `Tally-1.1.66-*-mac.zip` (auto-update channel). Emails do not link zips.

Tests: `lifecycle-emails.test.js` asserts latest URLs and **no** `v1.0.1` / `Tally-signed.dmg` in setup / registration / activation / welcome-verified preview.

---

## 4. What’s working

- Single Resend REST wrapper with timeout, tagging (`category` = emailType), and console logging.
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

### P0 — broken path, small blast radius

| ID | Issue | Evidence | Fix shape |
|----|--------|----------|-----------|
| P0-1 | **Password reset CTA 404.** Mail used `${APP_URL}/portal/reset-password`. Live `tallyconnect.app/portal/reset-password` **404**. Real page: `https://tallyconnect.app/reset-password` **200**. | Probe 2026-09-09; `emailVerification.js`; landing `/forgot-password` **200** | **Fixed in this PR:** CTA → `/reset-password?token=`. Preview + test updated. |

### P1 — churches / Andrew will feel this

| ID | Issue | Evidence | Fix shape |
|----|--------|----------|-----------|
| P1-1 | **Multi-recipient reports send once.** `email_sends` is UNIQUE `(church_id, email_type)`. Recap / weekly-leadership / monthly / post-service use one type per session/week/month, then loop leaders. Second address → `already-sent`. | `sendSessionRecapEmail`, `sendWeeklyDigestEmail`, `sendMonthlyReportEmail`, `postServiceReport._sendReportEmail` | Include normalized recipient in `emailType` (or drop unique and dedupe in code). |
| P1-2 | **No support-ticket email.** Open / admin reply / resolve = SSE only. `lifecycleEmails` unused in the route module. | `supportTickets.js` | Add church + Andrew mail on P1 open and on admin reply. |
| P1-3 | **No stream-down / outage email.** Email only after CRITICAL + 5 min no Telegram ack. Booths without Telegram/Slack get **nothing**. | `alertEngine.js` | Optional email for EMERGENCY/CRITICAL to portal + leaders (respect prefs). |
| P1-4 | **NPS buttons 404.** | Live `tallyconnect.app/nps` **404** | Landing route or switch CTA to mailto / portal. Until then, **do not send**. |
| P1-5 | **Lead drip has no unsubscribe category.** Marketing to captured emails. Footer not injected. | `_getCategoryForType` returns null for `lead-*` | Add `lead-nurture` category **or disable `_checkLeadNurture` + capture welcome** in prepare-mode. |
| P1-6 | **“Reply to this email” with `noreply@`.** | All Resend bodies omit `reply_to` | Set `reply_to: support@tallyconnect.app` (or Andrew) on Resend payloads. |
| P1-7 | **Unsubscribe secret split-brain.** Signer = `JWT_SECRET`; verifier = `UNSUBSCRIBE_SECRET \|\| JWT_SECRET`. | `lifecycleEmails.js` vs `server.js` | Sign with the same secret the verifier uses. |
| P1-8 | **Dispute mail goes to the church, not ops.** | `sendDisputeAlert` → `portal_email` | Also send to Andrew / admin list. |
| P1-9 | **Email-change notice skips the old inbox.** | `sendEmailChangeConfirmation` | Send to old + new. |
| P1-10 | **Two weekly digest engines.** Portal gets `weekly-digest-*` Monday UTC; leaders get `weekly-digest-email-*` from `weeklyDigest.js` with a **different week-id formula**. | both files | One job, one week key, recipient in dedup key. |
| P1-11 | **`invoice-upcoming` month key.** `monthKey = new Date(dueDate)` treats Stripe unix **seconds** as ms → epoch month; builder then does `dueDate * 1000`. Dedup / date can be wrong. | `sendInvoiceUpcoming` vs `_buildInvoiceUpcomingEmail` | Use seconds consistently. |

### P2 — polish / prepare-mode / drift

| ID | Issue | Notes |
|----|--------|------|
| P2-1 | Windows exe name pinned to `1.1.67` | Bump on every Windows ship or publish a versionless name. |
| P2-2 | Primary Download button is ARM64 only | Intel Macs must use the text link. |
| P2-3 | No Linux email link | Correct today (no asset). Don’t advertise until an AppImage exists. |
| P2-4 | `sendMonthlyROISummary` **DEAD** | Monthly already sends `sendMonthlyReportEmail`. Delete or wire one. |
| P2-5 | Registry / preview drift | Day-7 vs Day-5 check-in; win-back window; missing `getPreview` types. |
| P2-6 | Escalation copy “90 seconds” vs 5 min timer | Align copy or timer. |
| P2-7 | `church.name` often unescaped in HTML | `_esc` exists; many builders skip it. |
| P2-8 | Feature-announcement `body` is raw HTML | Admin XSS into every active church. |
| P2-9 | Signup sends **two** emails immediately | Verify + registration. Consider one. |
| P2-10 | No Resend webhooks / bounce handling | Relies on Resend suppression list only. |
| P2-11 | No send idempotency keys | Stripe retries + cron overlap can duplicate on bypass paths. |
| P2-12 | `sendOnboardingEmail` not in `email_sends` | Admin history misses verification + connection-success. |
| P2-13 | `no-api-key` still records send | Adding a key later will not backfill. |
| P2-14 | Admin nudge ignores `result.sent` | UI can lie. |
| P2-15 | Telegram nudge ignores Slack-only setup | Day-5 mail is wrong if they already have Slack. |
| P2-16 | `pre-service-friday-*` / `annual-renewal-reminder-*` uncategorized | No unsub footer. |
| P2-17 | Mixed portal URLs | `/portal` (redirects) vs `/church-portal?church=` (church id in query is unnecessary after login). |
| P2-18 | Lead “case study” + trial length inconsistency | Don’t ship as proof. |
| P2-19 | PII in logs | `sendEmail` / password-reset / leads log full recipient email. |
| P2-20 | Rate limits | Resend default ~2 req/s; hourly cron can burst. No backoff. |
| P2-21 | `getPreview` setup-reminder subject ≠ live subject | Admin preview lies. |

---

## 6. Test coverage

| Area | File | What it proves | Missing |
|------|------|----------------|---------|
| Engine | `tests/lifecycle-emails.test.js` | Builders, **#141 URLs**, send/dedup/throttle, overrides, footer inject, opt-out | Multi-recipient, reset URL (covered in emailVerification after this PR), most sequence HTML, Linux |
| Engine + PG cache | `tests/lifecycle-emails.query-client.test.js` | Dedup/prefs/unsub on query client | — |
| Weekly / monthly HTML | `tests/weekly-digest-email.test.js` | Subjects, metrics, week/month keys | Dual-engine collision |
| Verify / reset API | `tests/emailVerification*.test.js` | Verify, resend, forgot, reset token | Live landing URL (added assertion this PR) |
| Recap / report send | `tests/postServiceReport.test.js`, `weeklyDigest.test.js` | Calls `sendEmail` / digest when leaders set | Does **not** assert second recipient |
| Tickets | `tests/supportTickets-routes.test.js` | CRUD / triage | No email assertions (none exist) |

No test hits Resend. No test asserts `reply_to` or Linux assets.

---

## 7. Sunday / church onboarding gaps

Already present and useful in prepare-mode: verification, welcome, connection-success, setup reminder, first-Sunday prep, Friday checklist, first-service recap, Telegram/schedule nudges, billing dunning.

**Missing or weak for a real booth:**

1. **Ticket closed-loop email** (you wrote us / we replied / resolved).
2. **Stream-down / encoder-down email** when Telegram/Slack unset (or as a 10-min digest after service).
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
| Rate limit | Cron + admin blast + lead drip can 429; errors are logged, not retried with backoff. |
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

1. **Ship P0-1** (this PR) — reset link lands on `/reset-password`.
2. **P1-1** — recipient-scoped dedup so leadership lists work.
3. **P1-6** — `reply_to` support@.
4. **P1-2 / P1-3** — ticket reply + optional critical email (Sunday closed loop).
5. **P1-5 + §9 pause** — stop lead/NPS/referral/win-back in `runCheck`.
6. **P1-4** — don’t send NPS until `/nps` exists.
7. **P1-7 / P1-11** — unsubscribe secret + invoice dates.
8. **P2-1** — Windows filename strategy before the next `.exe`.

Do **not** refactor `lifecycleEmails.js` into a framework until the P1 list is smaller. The file is large but the send surface is one function.

---

## 11. What this review did not verify

- Resend domain DNS, bounce/complaint webhooks, or production send volume.
- Whether `noreply@tallyconnect.app` is forwarded.
- Stripe Dashboard “email customers” receipts.
- Railway current values of `FROM_EMAIL` / `UNSUBSCRIBE_SECRET` / `APP_URL` (code defaults assumed; prior audit said key present, FROM unset).
- Landing implementation of `/reset-password` (only that it returns 200 HTML).
- Whether `runCheck` has ever succeeded against production Postgres (no metrics invented).
)
