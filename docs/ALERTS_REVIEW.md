# Tally Alerts review (Sunday-saving notifications)

**Audience:** Andrew (platform operator). Church TDs see the *effects* of this system, not this doc.  
**Repo:** `peterdisbrow/tally` @ `origin/main` (`d0cc9fb`) plus this PR.  
**Live probe:** 2026-09-09 ~00:49 UTC, read-only. No production credentials used.  
**Deployed relay:** `1.1.67` build `d0cc9fb84e2d754f04abf0b78c242e8c3da63457` (Railway + Cloudflare)

This answers: *which alerts actually protect Sunday, which create booth noise, what is silently dropped, and what Andrew must provide next.*

Companion docs: [`FEATURE_AUDIT_2026-09-08.md`](FEATURE_AUDIT_2026-09-08.md) (whole product), [`ADMIN_DASHBOARD_REVIEW.md`](ADMIN_DASHBOARD_REVIEW.md) (ops console). Slack self-serve shipped in [#148](https://github.com/peterdisbrow/tally/pull/148).

North star: **Sunday-indispensable — alerts should save the stream, not spam the booth.**

---

## Status legend

| Status | Meaning |
|--------|---------|
| **WORKING** | Code + tests, and a live or config probe shows the path can fire |
| **PARTIAL** | Implemented, but env-gated, bypassed, or unused on the Sunday path |
| **BROKEN** | Confirmed miss: Sunday event never pages, or ack/resolve does not do what copy says |
| **DEAD** | Code or docs describe a surface that does not exist (or is never called) |

---

## Summary verdict

**Partial. The engine is real. Several Sunday-critical booth events never reached it.**

| Path | Booth intent | As built (before this PR) | Sunday-usable? |
|------|--------------|---------------------------|----------------|
| **Watchdog disconnects** (ATEM / OBS / encoder / mixer / ProPresenter / multi-down) | Page the TD when kit drops | `alertType` set. Engine classifies, dedups, Slack + Telegram | **Yes, if a token + chat ID + service window exist** |
| **Stream stopped** (OBS / ATEM / encoder / vMix) | Page immediately — stream is the product | Client `sendAlert()` sent `{ message, severity }` **with no `alertType`**. Relay `onAlert` **ignored the event** for Telegram/Slack/push/DB | **No → fixed in this PR** (client types + server infer for old booth builds) |
| **Audio muted / silence** | Page before the congregation notices | Mute used `sendAlert()` (no type). Silence monitor *does* send `audio_silence` | **Silence: yes. Mute: no → fixed** |
| **Auto-recovery success** | “Tally already fixed it” | Success path logged + recap only. `sendSlackResolution` existed and was **never called** | **No → fixed** (Telegram + Slack resolve) |
| **Telegram `/ack_XXXXXXXX`** | Stop the 5‑min escalation | Handler only told **failover** to stand by. Engine timer kept running. Admin ack wrote DB only | **No → fixed** |
| **Dedicated alerts bot** | Separate bot from `@TallyConnectBot` | Engine / pre-service / offline / health crons read **`ALERT_BOT_TOKEN` only**. That var is **still absent in Railway**. Interactive webhook is healthy | **No-op in prod → this PR falls back to `TALLY_BOT_TOKEN`** |
| **Slack** | Same class of alerts as Telegram, self-serve | Portal + admin CRUD. Engine sends if `slack_webhook_url` is set. Failover **bypasses** the engine (Telegram-only) | **Yes for engine alerts. No for failover** |
| **Push / email** | Phone banner + escalation backup | Push needs Firebase (not in Railway). Immediate email if no Telegram dest **and** no Slack (EMERGENCY/CRITICAL). Escalation email after **5 min** only when a Telegram dest existed (copy still says 90s) | **Email: fallback + escalation. Push: dark** |
| **Health / offline crons** | Andrew sees churn / 2h+ booth down | Admin Telegram only. Same missing `ALERT_BOT_TOKEN` | **Andrew-only; now uses Tally bot fallback** |

**Do not invent `ALERT_BOT_TOKEN`.** If Andrew wants a *second* bot, he must create it, put the token in Railway, and have every TD `/start` that bot (Telegram will not deliver otherwise). Until then, this PR pages through `@TallyConnectBot`.

Dogfood (Cogcomm, LCC) cannot be proven live while `connectedChurches: 0`.

---

## 1. Architecture

```
Booth (church-client / Electron)
  ├─ watchdogTick()          → { type:'alert', alertType, message }     ✓ typed
  ├─ audioMonitor            → alertType: audio_silence                 ✓ typed
  ├─ streamHealthMonitor     → stream_platform_health / token_expired   ✓ typed
  ├─ Teradek battery         → teradek_battery_low / _critical          ✓ typed
  └─ sendAlert(msg, sev)     → { type:'alert', message, severity }      ✗ untyped (fixed)
           │
           ▼
Relay websocketRouter case 'alert'
           │
           ▼
server.onAlert  ── if no alertType: drop  (fixed: infer known copy)
           │
           ├─ autoRecovery.attempt
           │     success → recap only          (fixed: notifyAutoRecovery)
           │     fail/skip → AlertEngine.sendAlert
           ├─ weeklyDigest / sessionRecap / AI triage / AutoPilot
           └─ mobile WS (in-app), not FCM

AlertEngine.sendAlert
  ├─ INSERT alerts (always)
  ├─ INFO → logged only
  ├─ not EMERGENCY and outside service window → logged only
  ├─ 5‑min in-memory dedup (except stream_stopped / signal_loss / encoder_offline / EMERGENCY)
  ├─ Telegram  (ALERT_BOT_TOKEN || TALLY_BOT_TOKEN || church.alert_bot_token)
  ├─ Slack     (churches.slack_webhook_url, secretCrypto enc:v1 at rest; plaintext still readable until next save)
  ├─ Push      (if Firebase wired)
  ├─ Email     EMERGENCY/CRITICAL if no Telegram dest AND no Slack webhook (sendCriticalAlertEmail)
  └─ CRITICAL → 5‑min timer → admin Telegram + lifecycle email (email skipped if no Telegram dest)

Bypass paths (not the engine)
  ├─ SignalFailover._sendAlert     Telegram only, own copy, no Slack/push/DB
  ├─ PreServiceCheck               Telegram to church_tds, ALERT/TALLY token
  ├─ HealthAlertMonitor            daily 07:00, admin Telegram, 7‑day dedup
  └─ OfflineDetection              2h / 24h, admin Telegram, night 23–06 local
```

Two Telegram bots in the product:

| Env | Role | Railway (names, 2026-09-08 audit) |
|-----|------|-----------------------------------|
| `TALLY_BOT_TOKEN` + webhook URL/secret | Interactive `@TallyConnectBot` — `/start`, `/register`, commands | **Present.** Status component: webhook OK |
| `ALERT_BOT_TOKEN` | Outbound Sunday / cron / failover pages | **Absent.** Do not invent |
| `ANDREW_TELEGRAM_CHAT_ID` | Admin escalation + health/offline | **Present** (`ADMIN_TELEGRAM_CHAT_ID` also accepted, unset) |
| Per-church `alert_bot_token` / `td_telegram_chat_id` | Override sender / default TD | Columns exist; on-call rotation wins when set |

Slack webhooks live in `churches.slack_webhook_url` encrypted at rest with `secretCrypto` (`enc:v1:…`, same AES-256-GCM / `ENCRYPTION_KEY` as YouTube and Facebook tokens). `decryptSecret()` still accepts legacy plaintext; the next portal/admin/Telegram save re-encrypts. Portal and admin GET return a mask only — never `webhookUrlFull` or ciphertext.

---

## 2. Trigger inventory

Sources: `ALERT_CLASSIFICATIONS` + `DIAGNOSIS_TEMPLATES` in `relay-server/src/alertEngine.js`, church-client watchdog / monitors, `broadcastMonitor.js`, `signalFailover.js`, crons.

### 2.1 Engine taxonomy (what `sendAlert(type)` would do)

| Type | Severity | Dedup | Diagnosis / 5‑second action | Who actually fires it |
|------|----------|-------|-----------------------------|------------------------|
| `stream_started` / `recording_started` / `service_ended` | INFO | n/a (logged) | — | Rarely typed; INFO never pages |
| `stream_stopped` | CRITICAL | **bypass** | Restart stream / check encoder / check internet | **Was dropped** (untyped OBS copy). This PR types + infers |
| `atem_stream_stopped` | CRITICAL | 5 min | ATEM stream settings / key / internet | **Was dropped.** This PR types |
| `vmix_stream_stopped` | CRITICAL | 5 min | Restart vMix stream | **Was dropped.** This PR types |
| `encoder_stream_stopped` | CRITICAL | 5 min | Encoder lights / key / internet | **Was dropped.** This PR types |
| `atem_disconnected` | CRITICAL | 5 min | Cable / ping / power cycle | Watchdog (typed). Event `sendAlert('ATEM disconnected')` still untyped (watchdog covers within 30s) |
| `audio_muted` | CRITICAL | 5 min | Unmute console | **Was dropped.** This PR types |
| `audio_silence` | WARNING | 5 min | Fader / route / cable | `audioMonitor` (typed). Auto-fix claimed |
| `encoder_disconnected` | WARNING | 5 min | Power / IP / power cycle | Watchdog. Also bridges into failover |
| `obs_disconnected` / `vmix_disconnected` / `companion_disconnected` | WARNING | 5 min | App + plugin / Web Controller | Watchdog |
| `hyperdeck_disconnected` / `mixer_disconnected` / `ptz_disconnected` / `propresenter_disconnected` | WARNING | 5 min | Cable / IP / Network API | Watchdog |
| `fps_low` / `bitrate_low` / `cpu_high` | WARNING | 5 min | CPU / bitrate / close apps | Watchdog (fps/bitrate). `cpu_high` classified, **never sent** |
| `multiple_systems_down` | EMERGENCY | bypass | Switch / power / get on site | Watchdog when ≥3 issue classes |
| `no_td_response` | EMERGENCY | bypass | — | Classified, **never sent** as a type (escalation is a different message) |
| `recording_failed` | CRITICAL | 5 min | Disk / drive | Classified; client recording stops are often INFO/untyped |
| `firmware_outdated` | WARNING | 5 min | Do **not** update during service | `_checkDeviceVersions` once per session |
| `stream_platform_health` | WARNING | 5 min | YouTube Studio / FB Live / key | Client health monitor (many YT/FB keys collapse to this one type) |
| `yt_broadcast_unhealthy` / `yt_broadcast_offline` | WARNING / CRITICAL | 5 min | Encoder → YT RTMP / key | `broadcastMonitor` (needs YT OAuth) |
| `fb_broadcast_unhealthy` / `fb_broadcast_offline` | WARNING / CRITICAL | 5 min | FB key is per-video | `broadcastMonitor` |
| `teradek_battery_low` / `_critical` | WARNING / CRITICAL | 5 min (independent keys) | Plug in / swap battery | `_checkTeradekBattery` |
| `failover_confirmed_outage` | CRITICAL | 5 min | Check source; failover may engage | Taxonomy only — failover **does not** call `sendAlert` |
| `failover_executed` | EMERGENCY | bypass | Restore source; `/recover` | Taxonomy only |
| `failover_command_failed` / `failover_recovery_failed` | EMERGENCY / CRITICAL | — | Switch manually | Taxonomy only |
| `failover_source_recovering` / `failover_recovery_executed` | INFO | logged | — | Taxonomy only |
| `encoder_offline` / `signal_loss` | **WARNING** (default) | **bypass** | Generic “Unknown issue” | In `CRITICAL_BYPASS_TYPES` but **not classified**. **Nothing in booth sends these strings** |
| `test_alert` | WARNING | 5 min | Slack test copy | Portal / admin Slack test |

### 2.2 Failover (own Telegram, not the engine)

`signalFailover._sendAlert` sends a human sentence to the TD chat. Types include `failover_suspected_black`, `failover_atem_lost`, `failover_audio_silence`, `failover_confirmed_outage`, `failover_executed`, `failover_command_failed`, `failover_recovery_*`, `failover_auto_recovered`, `backup_encoder_available`, `failover_confirmed_no_switch`.

**Gaps:** no Slack, no `alerts` row, no push, no service-window gate, no engine dedup. Token list now includes `TALLY_BOT_TOKEN` (this PR). Still no page if `td_telegram_chat_id` is empty.

### 2.3 Pre-service / post-service / health (not the same inbox)

| Trigger | Channel | Noise risk | Sunday value |
|---------|---------|------------|--------------|
| T‑30 pre-service check | Telegram to **all active `church_tds`** | Pass = “All systems go” **every service** | High if it fails; pass pings are booth noise |
| Pre-service fail (2+ in a row) | Health cron → **Andrew only** | Low (7‑day dedup) | Prep-mode, not during service |
| Health score &lt; 70 / drop ≥ 15 / &lt; 50 | Andrew Telegram | Low | Prep-mode |
| Recurring same failure 3 weeks | Andrew | Low | Prep-mode |
| Churn (no sessions 2+ weeks) | Andrew INFO | Low | Sales-adjacent but **active/trialing only** — not marketing |
| Missed scheduled services | Andrew | Low | Needs a real schedule |
| Booth offline 2h (not night, not in window) | Andrew | Medium if agent flaky | Prep-mode |
| Booth offline 24h | Andrew CRITICAL | Low | Ops |
| Weekly / monthly digest | Email + optional Telegram | Leadership, not booth | Not a Sunday page |
| Urgent escalation email | `portal_email` after **5 min** unacked CRITICAL, **only if Telegram dest existed** | Copy says **90s** | Backup if Telegram is muted |
| Unreachable-channel email | `portal_email` + `leadership_emails` on EMERGENCY/CRITICAL when no Telegram dest and no Slack | 5-min recipient-scoped dedup | Backup when paging channels were never set |

Sales/marketing alerts: **none in the engine.** Health cron excludes non-active/trialing. Feature-tip emails are a separate lifecycle sequence — do not mix them into this inbox.

---

## 3. Routing

| Channel | Default | Config | Live? |
|---------|---------|--------|-------|
| **Telegram (interactive)** | `@TallyConnectBot` | `TALLY_BOT_*` | Webhook **operational** |
| **Telegram (alerts)** | Same bot after this PR; dedicated bot if Andrew sets `ALERT_BOT_TOKEN` | Railway + optional `churches.alert_bot_token` | **Was dark** (missing token) |
| **TD target** | `churches.td_telegram_chat_id` | On-call rotation overrides | Needs a registered TD |
| **Admin escalate** | `ANDREW_TELEGRAM_CHAT_ID` | Immediate on EMERGENCY; +5 min on unacked CRITICAL | Chat ID present |
| **Slack** | Off | Portal Alerts card + admin church modal + Telegram `set slack` | [#148](https://github.com/peterdisbrow/tally/pull/148) self-serve. SSRF allowlist `hooks.slack.com` |
| **Email** | Escalation + unreachable-channel backup + digests | Resend (`RESEND_API_KEY` present). `FROM_EMAIL` unset → `noreply@tallyconnect.app`. Unreachable-channel: `sendCriticalAlertEmail` for EMERGENCY/CRITICAL when Telegram dest and Slack webhook are both unset (portal + leaders, `alerts` prefs, 5-min recipient dedup) | Not a primary Sunday channel |
| **Push** | Off | `FIREBASE_SERVICE_ACCOUNT*` **absent**. Quiet hours + severity prefs exist in code | Dark |
| **Portal / admin inbox** | DB `alerts` | Portal Alerts page; admin Alerts tab | Empty until engine fires |
| **Mobile tab** | WS + local store | Expo app **CODE_ONLY** (not in CI / stores) | Dark |

**Defaults that surprise people**

1. **No service windows → no pages** except EMERGENCY. `isServiceWindow()` returns `false` on an empty schedule (±30 min buffer when set). Portal copy is honest; churches that never set Schedule get a silent Sunday.
2. **INFO never leaves the DB.**
3. **Auto-recovery success used to skip the engine** (now a resolve ping).
4. **Dedup flush** (e.g. “audio silence (4 occurrences in last 5 min)”) is **Telegram-only**. Slack never gets the summary.
5. Docs (`telegram-setup.md`) claim **Settings → Alerts** preferences. **That page does not exist.** Mobile push prefs are the only severity/quiet-hours UI, and push is dark.

---

## 4. Noise control

| Control | Where | Notes |
|---------|-------|-------|
| Service window | `ScheduleEngine.isServiceWindow` | The real quiet hours for Telegram/Slack |
| Dedup 5 min | In-memory `AlertEngine.dedupState` | Lost on relay restart. Per church + type + optional room |
| Critical bypass | `stream_stopped`, `signal_loss`, `encoder_offline`, any EMERGENCY | Last two types are unused by the booth |
| Client watchdog 5 min | `_lastAlerts` | Second line of defense |
| Health 7‑day dedup | `health_alerts` table | Andrew only |
| Offline once-per-incident flags | `_offlineAlertSent` | In-memory; reset on reconnect |
| Ack | Telegram `/ack_`, admin button, `POST /api/alerts/:id/acknowledge` | Telegram + admin **did not stop the timer** (fixed) |
| Resolve / clear | Slack `sendSlackResolution` | Dead code until this PR. **No Telegram resolve** for manual recover except failover copy |
| Grouping | Dedup flush one-liner | Not a thread; not Slack |
| Quiet hours | Push prefs only | Telegram/Slack ignore them |
| Sales gate | Health cron `billing_status IN ('active','trialing')` | Engine itself does not check plan |

---

## 5. Failure modes

| Failure | What the booth sees | Evidence |
|---------|---------------------|----------|
| Missing `ALERT_BOT_TOKEN` | Nothing on Telegram | Railway names (audit). **This PR falls back to `TALLY_BOT_TOKEN`** |
| Second bot without `/start` | Telegram 403, logged, TD hears silence | Telegram rule: you can only message users who started *that* bot |
| Empty `td_telegram_chat_id` + no on-call | Slack may still fire; Telegram skip | `sendAlert` continues |
| Bad Slack webhook | Was **silent success** (no `resp.ok` check) | This PR logs status + body |
| Empty schedule | Alerts logged only | `scheduleEngine.js` |
| Untyped `sendAlert` | Controllers/SSE only | `onAlert` required `msg.alertType` |
| Failover without engine | Slack/portal inbox miss the outage | `_sendAlert` bypass |
| `/ack_` | Copy said escalation cancelled; timer kept running | `telegramBot.js` vs `acknowledgeAlert` |
| Admin Acknowledge | Row marked ack; **escalation still sent** | `adminPanel.js` SQL-only (fixed to call engine) |
| Slack context dump | Attachment fields include raw `status` object / `_instanceName` | Polish / leak risk |
| Markdown parse errors | `_` in church names can break Telegram `parse_mode: Markdown` | Logged `Telegram API error` |
| Rate limits | 5s abort; error logged; no retry | Both Slack and Telegram |
| `connectedChurches: 0` | Entire Sunday loop unproven | Live health 2026-09-09: **6 registered / 0 connected** |

---

## 6. UX copy (5 seconds during service)

**Good enough (action + cause):** ATEM cable, Teradek battery %, “multiple devices offline — check switch and power”, failover “manually switch to backup”.

**Too slow / too engineering:**

- Titles are `STREAM_STOPPED` / `AUDIO_SILENCE` (underscores uppercased), not “YouTube is down”.
- Slack test and first page may include raw context keys (`_instanceName`, `[object Object]` if `status` is fielded).
- Escalation email and portal help say **90 seconds**. Code is **300_000 ms (5 minutes)**. Telegram-setup says 90s. Homepage (audit) says 5 minutes. Pick one number and print it everywhere.
- `/ack_` reply was failover-only (“stand by… `/recover_`”) even for a stream-down page. This PR acknowledges + mentions recover only as a standby option.
- Pre-service **pass** texts “All systems go” — fine at T‑30, spam if it also hits Slack (it does not today).
- `telegram-setup.md` “Settings → Alerts” is fiction. Portal Alerts is an inbox + Slack card.

---

## 7. Tests (Sunday-critical)

| Area | Coverage | Gap |
|------|----------|-----|
| Dedup / bypass / rooms | `alert-dedup.test.js`, `telegram-alert-delivery.test.js` | Strong |
| Slack-only / no token | telegram-alert-delivery | Strong |
| Failover Telegram token columns | `signal-failover-telegram.test.js` | Regex for `/ack_`; did not assert engine ack |
| Health cron | `health-alerts.test.js` | Strong for detection; Telegram gated |
| Offline night/TZ | `offlineDetection.test.js` | Strong |
| Client watchdog / battery / silence | church-client tests | Strong for *typed* paths |
| Client `sendAlert` stream-down | Was untyped; **this PR adds type tests** | Electron packaging still must ship the client |
| `/ack_` → `acknowledgeAlert` | Engine unit tests exist; bot wiring is new | No full `handleUpdate` e2e |
| Empty schedule = no page | Indirect via schedule tests | **Shipped:** explicit engine test — empty `service_times` → non-EMERGENCY `logged_outside_window` (intentional silent Sunday) |
| Live Sunday | **None** | 0 connected churches |

---

## 8. North-star scorecard

Scored for **Cogcomm / LCC on a Sunday**, not for feature count.

| Pillar | Score | Why |
|--------|-------|-----|
| **Reliability** | **2 → 3 / 5** | Engine + Slack + watchdog were real, but stream-down/mute never paged and Telegram had no token. Fallback + typing + resolve close the worst holes. Still: empty schedule silences everything; failover skips Slack; two-bot `/start` trap remains if Andrew adds `ALERT_BOT_TOKEN` without onboarding TDs. |
| **Trust** | **2 / 5** | 90s vs 5 min; `/ack_` lied; “Settings → Alerts” does not exist; “Tally already fixed it” never left the booth computer. After this PR, ack/resolve match the copy better. Remaining: snake_case titles, failover inbox split. |
| **Security** | **3 → 4 / 5** | Slack URL allowlisted. Stored with `secretCrypto` like YT/FB (legacy plaintext readable until next save). Portal + admin GET mask only. Telegram tokens in env (correct). |
| **Polish** | **2 / 5** | Admin severity filter was case-mismatched (`CRITICAL` vs `critical`) — fixed. Slack fields dump internals. No quiet hours on the channels churches actually use. |
| **Observability** | **2 / 5** | Console lines + Slack/Telegram HTTP errors (Slack 4xx now logged). **Last successful send** is now a status component (`alert_delivery`) plus Sentry/Andrew page after 3 consecutive HTTP failures. Status still also watches the interactive webhook. |

---

## 9. What Andrew must provide

1. **Do not invent `ALERT_BOT_TOKEN`.**  
   - **Now:** leave it unset. This PR pages via `TALLY_BOT_TOKEN` (`@TallyConnectBot`) — the bot TDs already `/start`.  
   - **Later (optional):** create a dedicated alerts bot in BotFather, set `ALERT_BOT_TOKEN` in Railway, and send every TD a `/start` link for *that* bot. Until they start it, pages 403.
2. **Confirm Cogcomm + LCC:** service windows set, at least one TD with `telegram_chat_id`, Slack webhook only if they asked (not sales).
3. **Connect one real booth** and keep it connected. Alerts cannot be dogfooded at `connectedChurches: 0`.
4. **Decide the escalation clock:** 90s (docs/email) or 5 min (code). Change one side.
5. **Never put `ALERT_BOT_TOKEN` in repo secrets or sample env files as a fake value.**

---

## 10. Dogfood checklist (Cogcomm / LCC)

Run on a weekday rehearsal first, then Sunday.

- [ ] Church has **Schedule** windows (or expect silence).
- [ ] TD can `/status` `@TallyConnectBot` (proves chat ID + interactive bot).
- [ ] Slack card (if used): Save & Test → message in the church channel, not `#general` by accident.
- [ ] Pull Ethernet on the encoder **during a window** → Telegram/Slack `encoder_disconnected` or stream-stopped within ~30s (watchdog) or immediately (typed stream-down after desktop update).
- [ ] Mute the console master → `audio_muted` page (after desktop update) or `audio_silence` after 15s.
- [ ] Reply `/ack_` on the page → **no** admin escalation 5 min later.
- [ ] If auto-recovery fires → “auto-recovered” resolve, not a second CRITICAL.
- [ ] Failover (if enabled): Telegram sentence arrives; **do not expect Slack** until P1.
- [ ] T‑30: fail check pages TDs; pass “All systems go” is acceptable once, not a thread.
- [ ] Andrew: weekday health/offline pages only if `ALERT`/`TALLY` token + his chat ID — no church spam.
- [ ] Confirm **no** marketing/lifecycle tip landed in the Slack/Telegram alert channel.

---

## 11. P0 / P1 / P2

### P0 — Sunday / this PR

Shipped here (small, high-confidence only):

| Fix | Why |
|-----|-----|
| Infer + send `alertType` on stream-down / mute | Untyped booth alerts never reached Telegram/Slack |
| `ALERT_BOT_TOKEN` → fall back to `TALLY_BOT_TOKEN` | Prod had no alerts-bot token; interactive bot is healthy |
| `/ack_` calls `alertEngine.acknowledgeAlert` | Escalation kept firing after “ack” |
| Admin Acknowledge uses the engine | Same timer leak |
| `notifyAutoRecovery` | “Tally already fixed it” never left the relay log |
| Log Slack HTTP status | 4xx looked like success |
| Admin severity filter case-insensitive | `CRITICAL` rows looked like INFO |

**Still P0, Andrew-side (not code):** connect a real church; set schedules; pick 90s vs 5 min; do not add a second bot until TDs can `/start` it.

### P1 — same week, not during service

1. Route failover through `AlertEngine.sendAlert` (or at least Slack + `alerts` insert) so the portal inbox matches the phone.
2. Dedup flush → Slack as well as Telegram.
3. Unify escalation copy to one duration; consider 90s if Andrew wants “save the stream,” 5 min if he wants less noise.
4. Encrypt `slack_webhook_url` at rest (`secretCrypto`); stop returning `webhookUrlFull` on admin GET. **Shipped** — encrypt on write, decrypt on send; GET mask only.
5. Empty schedule: either page WARNING+ anyway, or banner the portal “Alerts are off until you set a schedule.”
6. Classify `encoder_offline` / `signal_loss` as CRITICAL **or** remove them from bypass (they are unused and mis-labeled WARNING).
7. Stop dumping `church.status` into Slack fields.
8. Pre-service **pass** only if a TD asked; fail always.
9. Metric + status component: “last successful alert send” (not just webhook getMe). **Shipped** — `alert_delivery` status component + Sentry/Andrew page after 3 consecutive Telegram or Slack HTTP failures.
10. Delete or rewrite `telegram-setup.md` Settings → Alerts.
11. **Unreachable-channel email** — **Shipped:** EMERGENCY/CRITICAL emails `portal_email` (+ leaders) when Telegram dest and Slack webhook are both unset. Empty schedule still log-only.

### P2 — later

1. Real Settings → Alerts (severity, categories, quiet hours) that the engine honors — not just push prefs.
2. Grouped Slack threads / Telegram message edit on resolve.
3. Firebase push for the mobile app, or drop the dark UI.
4. Taxonomy rewrite (human titles, drop unused types). Not this PR.
5. Persist dedup across relay restarts.
6. Sales-safe: keep health cron off `inactive` / spam tenants (already mostly true).

---

## 12. Fixed in this PR

Small reliability fixes only. No taxonomy rewrite. No `ALERT_BOT_TOKEN` invented or required in secrets.

| Change | Files |
|--------|-------|
| `resolveAlertBotToken()` / `inferAlertTypeFromMessage()` / `notifyAutoRecovery()` / Slack `resp.ok` | `relay-server/src/alertEngine.js` |
| Untyped alert infer; recovery notify; token fallback wiring | `relay-server/server.js` |
| `/ack_` acknowledges engine alerts | `relay-server/src/telegramBot.js` |
| Admin ack stops escalation | `relay-server/src/adminPanel.js` |
| Token fallback on crons / failover / pre-service / reports | `healthAlerts.js`, `offlineDetection.js`, `preServiceCheck.js`, `preServiceRundown.js`, `signalFailover.js`, `monthlyReport.js`, `syncMonitor.js`, `incidentSummarizer.js` |
| Stream-down / mute carry `alertType` | `church-client/src/index.js` |
| Admin severity filter/color | `relay-server/admin/src/components/AlertsTab.jsx` |
| Encrypt `slack_webhook_url` at rest; GET mask only (no `webhookUrlFull`) | `secretCrypto.js`, `slackWebhook.js`, `churchPortal.js`, `routes/slack.js`, `alertEngine.js`, `telegramBot.js` |

Desktop/Electron must ship the church-client change for **new** typed stream-down. Old booths still get inference on the known English strings.

**Shipped leftover (P1-4):** `slack_webhook_url` is encrypted at rest like YT/FB tokens. Portal and admin GET never return the full webhook. Unreachable-channel email already shipped — see [`EMAIL_SYSTEM_REVIEW.md`](EMAIL_SYSTEM_REVIEW.md).

---

## 13. Live probe (read-only)

**Target:** `https://api.tallyconnect.app`  
No church or admin login.

| Check | Result |
|-------|--------|
| `GET /api/health` | `healthy`, v`1.1.67`, build `d0cc9fb…`, **6 registered / 0 connected** |
| `GET /api/status/components` | All 6 operational. Telegram component = **interactive webhook**, not alert delivery |
| Slack / Telegram send | Not invoked (would page dogfood) |

---

*Review date: 2026-09-09. Relies on repo + unauthenticated live HTTP + Railway **variable names** from the 2026-09-08 audit (no values). Authenticated portal clicks and real Sunday pages were not run.*
