# Polish pass — 2026-09-09

Small Sunday UX/copy only. No sales. No failover auto-recover re-enable.

Sources: `ALERTS_REVIEW.md`, `CHURCH_PORTAL_REVIEW.md`, `AI_SURFACES_REVIEW.md`, `BOOTH_DESKTOP_REVIEW.md`, `BILLING_STRIPE_REVIEW.md`.

## Changed

1. **Portal nav.** Alerts and Rundown are primary (Home → Equipment → Stream → **Alerts** → **Rundown** → Help). Network / Reports / Commands stay under More.
2. **Empty service windows.** Schedule tab, Home card, Alerts page, Triage “off hours”, and reports windows copy now say **“No service windows → alerts stay quiet on Sunday.”** Alerts shows a banner with a link to Equipment → Schedule until windows exist.
3. **Honest labels.** Heuristic recovery is **Auto-recovery / Triage**. Claude chat is **Engineer chat**. Stopped calling the rule engine “AI Assistant” / “AI failover” on those surfaces.
4. **Escalation clock.** Remaining operator copy that said **90 seconds** now says **5 minutes** (portal help, Telegram i18n, escalation email, engineer knowledge, SETUP-GUIDE, telegram-setup). Timer was already `300_000` ms.
5. **Failover auto-recover.** Left globally forced off in `server.js`. Not re-enabled.

## Parked

- **Annual “save 25%”.** Not in relay-server portal/signup. Live Stripe is 12× monthly (`BILLING_STRIPE_REVIEW.md`). Copy lives on **tally-landing** — separate PR.
- PCO OAuth, TD API RBAC (server still church-admin JWT), portal Sentry.
- Founding / limited-spots / Enterprise $499 landing copy.
- Historical review docs still mention the old 90s mismatch (snapshots, not operator copy).

## Follow-up P1s (booth-grade polish, same day)

- **CSP inline handlers.** Remaining `onclick`/`onchange` in `portal.js` → `data-action` / `data-action-change` (TD access, VideoHub, Companion, onboarding copy/invite, rundown retry, email prefs).
- **More crowding.** Network / Analytics / Reports stay hidden until a booth has connected (`onboarding_app_connected_at`). Deep-link shows “connect booth” empty.
- **TD privilege honesty.** Portal label is **Lead operator**, not Admin. Church-admin save paths (`church-admin-write`) hidden; schedule rows disabled for TD sessions.
- **Idle timeout.** 30 min of *visible* inactivity signs out (`/church-login?idle=1`). Cookie remains **7d** so a sleeping/closed booth laptop is not kicked.
- **Schedule copy.** Equipment → Schedule help-box now says empty windows keep Sunday alerts quiet (except emergencies). Banner was already there.

## Shipped later (alert-delivery leftover PR)

- Telegram chat ID duplicated onto **Alerts** (`#alerts-telegram-chat-id`), still on Profile.
- Onboarding checklist: **Set service windows** step (empty schedule = silent Sunday).
- `alert_delivery` status component + consecutive send-failure page (Sentry + Andrew Telegram).
- Explicit engine test: empty schedule → non-EMERGENCY alerts log-only (intentional).
