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
- Telegram chat ID still on Profile, not Alerts.
- Onboarding checklist still has no “set service windows” step.
- PCO OAuth, TD API RBAC, portal Sentry, idle timeout.
- Founding / limited-spots / Enterprise $499 landing copy.
- Historical review docs still mention the old 90s mismatch (snapshots, not operator copy).
