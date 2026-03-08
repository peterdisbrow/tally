# Relay Security Baseline Checklist

Last updated: 2026-03-08  
Baseline commit: `5fde127` (`Harden relay auth paths and remove duplicate backup route`)

Use this checklist before and after any relay auth/bot/deploy changes.

## 1) Secrets and Tokens

- [ ] `ADMIN_API_KEY` is set in Railway and not shared in chat/logs.
- [ ] `JWT_SECRET` is set (long random value) in Railway.
- [ ] `TALLY_BOT_TOKEN` is current (rotate in BotFather if exposed).
- [ ] `TALLY_BOT_WEBHOOK_SECRET` is set (long random value).
- [ ] `.env` files are not committed.

## 2) Admin/Auth Hardening

- [ ] Admin API uses JWT flow only (`Authorization: Bearer` or `x-admin-jwt`).
- [ ] No legacy admin elevation fallback from API key + cookie.
- [ ] No auth via query params (`?apikey=` / `?key=`) on admin surfaces.

## 3) Telegram + Slack Hardening

- [ ] `/api/telegram-webhook` rejects missing/invalid secret (`401`).
- [ ] `/api/bot/set-webhook` requires admin auth (`401` without key/JWT).
- [ ] Telegram `/setslack` only accepts valid `https://hooks.slack.com/...` URLs.

## 4) Route Hygiene

- [ ] No duplicate registrations for sensitive/internal endpoints.
- [ ] Internal backup snapshot route exists in one place only:
  - `POST /api/internal/backups/snapshot` in `src/routes/churchOps.js`

## 5) Live Smoke (Post-Deploy)

Replace `<relay>` with production URL.

```bash
# health
curl -i https://<relay>/api/health

# webhook should fail without secret
curl -i -X POST https://<relay>/api/telegram-webhook \
  -H "Content-Type: application/json" \
  -d '{"update_id":1}'

# set-webhook should fail without admin auth
curl -i -X POST https://<relay>/api/bot/set-webhook \
  -H "Content-Type: application/json" \
  -d '{}'

# optional platform component state
curl -s https://<relay>/api/status/components
```

Expected:
- `/api/health` = `200`
- `/api/telegram-webhook` (no secret) = `401`
- `/api/bot/set-webhook` (no admin auth) = `401`
- `telegram_bot_webhook`, `admin_api_proxy`, `relay_api` = `operational`

## 6) If a Token Was Exposed

- [ ] Rotate token immediately in provider (for Telegram: BotFather `/revoke` then `/token`).
- [ ] Update Railway env vars with new token.
- [ ] Redeploy relay.
- [ ] Verify old token returns unauthorized.

