# Tally Connect Relay Server — Deployment Guide

This guide covers deploying the relay server via Railway (recommended), Docker, or bare Node.js.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Environment Variables](#environment-variables)
3. [Railway Deployment](#railway-deployment)
4. [Docker Deployment](#docker-deployment)
5. [Bare Node.js / VPS](#bare-nodejs--vps)
6. [Database Setup (SQLite)](#database-setup-sqlite)
7. [Redis Setup (Optional — Rate Limiting)](#redis-setup-optional--rate-limiting)
8. [First-Run Checklist](#first-run-checklist)
9. [Upgrading](#upgrading)

---

## Prerequisites

- **Node.js 18+** (specified in `engines` field of `package.json`)
- A reachable HTTPS hostname (Railway provides one automatically; for Docker you need a reverse proxy with TLS)
- A Stripe account if billing is enabled
- A Telegram bot token if using the Telegram alert integration

---

## Environment Variables

Create a `.env` file (or configure secrets in your hosting provider). Every variable is optional unless marked **required**.

### Core

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | | `3000` | HTTP server port |
| `NODE_ENV` | | `development` | Set to `production` in prod |
| `ADMIN_API_KEY` | **Yes** | — | Shared secret for admin/controller access |
| `JWT_SECRET` | **Yes** | — | Secret used to sign church app JWTs |
| `DATABASE_PATH` | | `./data/churches.db` | Path to the SQLite database file |
| `APP_URL` | **Yes** | — | Public base URL (e.g. `https://relay.example.com`) |
| `ALLOWED_ORIGINS` | | — | Comma-separated CORS origins |

### Email (Resend)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RESEND_API_KEY` | | — | [Resend](https://resend.com) API key for transactional email |
| `FROM_EMAIL` | | — | Sender address (e.g. `noreply@tallyhq.com`) |

### Telegram Bot

| Variable | Required | Description |
|----------|----------|-------------|
| `TALLY_BOT_TOKEN` | | Telegram bot token from @BotFather |
| `TALLY_BOT_WEBHOOK_URL` | | Full webhook URL (e.g. `https://relay.example.com/api/telegram-webhook`) |
| `TALLY_BOT_WEBHOOK_SECRET` | | Optional secret token for webhook verification |
| `ANDREW_TELEGRAM_CHAT_ID` | | Chat ID for admin-level bot commands |

### Stripe Billing

| Variable | Description |
|----------|-------------|
| `STRIPE_SECRET_KEY` | Stripe API secret key |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret from Stripe Dashboard |
| `STRIPE_PRICE_CONNECT` | Price ID for Connect tier (monthly) |
| `STRIPE_PRICE_PLUS` | Price ID for Plus tier (monthly) |
| `STRIPE_PRICE_PRO` | Price ID for Pro tier (monthly) |
| `STRIPE_PRICE_MANAGED` | Price ID for Enterprise tier (monthly) |
| `STRIPE_PRICE_EVENT` | Price ID for Event tier (one-time) |
| `STRIPE_PRICE_CONNECT_ANNUAL` | Annual variant |
| `STRIPE_PRICE_PLUS_ANNUAL` | Annual variant |
| `STRIPE_PRICE_PRO_ANNUAL` | Annual variant |
| `TALLY_REQUIRE_ACTIVE_BILLING` | Set to `true` to enforce billing before app connects |
| `TALLY_CHURCH_APP_TOKEN_TTL` | JWT TTL (default `30d`) |

### Monitoring & Logging

| Variable | Description |
|----------|-------------|
| `SENTRY_DSN` | Sentry error tracking DSN |
| `LOG_FORMAT` | Set to `json` for structured (production) logging |

### Rate Limiting (Redis / Upstash)

| Variable | Description |
|----------|-------------|
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST token |
| `KV_REST_API_URL` | Alternative: Vercel KV REST URL |
| `KV_REST_API_TOKEN` | Alternative: Vercel KV REST token |
| `RATE_LIMIT_KEY_PREFIX` | Prefix for rate-limit Redis keys (default: `rl`) |

Without Redis, rate limiting falls back to in-process memory (not suitable for multi-instance deployments).

### Database Backup

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_BACKUP_INTERVAL_MINUTES` | `0` (disabled) | How often to auto-snapshot the database |
| `BACKUP_DIR` | `./backups` | Where backups are written |
| `BACKUP_RETAIN_COUNT` | `5` | Number of snapshots to keep |
| `BACKUP_ENCRYPTION_KEY` | — | AES key for encrypting backup files |

### Miscellaneous

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key (AI chat features) |
| `CHAT_PROXY_SECRET` | Shared secret for landing-page chat proxy |
| `SUPPORT_TRIAGE_WINDOW_HOURS` | Hours before a ticket can be re-triaged |

---

## Railway Deployment

Railway is the recommended deployment platform. It handles TLS, port assignment, and environment management automatically.

### 1. Create a new Railway project

```bash
# Install Railway CLI (optional but helpful)
npm install -g @railway/cli
railway login
```

Or use the Railway web dashboard: [railway.app](https://railway.app)

### 2. Connect your repository

In the Railway dashboard:
1. **New Project → Deploy from GitHub repo**
2. Select the `church-av` repository
3. Set the **Root Directory** to `relay-server`
4. Railway will detect `package.json` and use `npm start`

### 3. Set environment variables

In **Project → Variables**, add all required variables from the table above. At minimum:

```
ADMIN_API_KEY=<strong-random-secret>
JWT_SECRET=<strong-random-secret>
APP_URL=https://<your-project>.up.railway.app
NODE_ENV=production
LOG_FORMAT=json
```

### 4. Configure the Stripe webhook

Once your Railway URL is known:

1. Go to [Stripe Dashboard → Webhooks](https://dashboard.stripe.com/webhooks)
2. Add endpoint: `https://<your-project>.up.railway.app/api/billing/webhook`
3. Select events: `checkout.session.completed`, `customer.subscription.*`, `invoice.*`
4. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`

### 5. Configure the Telegram webhook

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<your-project>.up.railway.app/api/telegram-webhook","secret_token":"<your-secret>"}'
```

Or use the API: `POST /api/bot/set-webhook` with admin auth.

### 6. Verify

```bash
curl https://<your-project>.up.railway.app/api/health
```

Expected: `{ "service": "tally-relay", ... }`

---

## Docker Deployment

A `Dockerfile` is included in `relay-server/`. It uses Node 20 Alpine and exposes port 3000.

### Build and run

```bash
cd relay-server

# Build
docker build -t tally-relay .

# Run (pass env vars via --env-file)
docker run -d \
  --name tally-relay \
  -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  --env-file .env \
  tally-relay
```

### docker-compose example

```yaml
version: '3.8'
services:
  relay:
    build: ./relay-server
    ports:
      - "3000:3000"
    volumes:
      - relay_data:/app/data
      - relay_backups:/app/backups
    env_file:
      - ./relay-server/.env
    restart: unless-stopped

volumes:
  relay_data:
  relay_backups:
```

### TLS in Docker

The server does not terminate TLS itself. Use a reverse proxy:

**nginx example:**
```nginx
server {
    listen 443 ssl;
    server_name relay.example.com;

    ssl_certificate /etc/letsencrypt/live/relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Set `app.set('trust proxy', 1)` is already configured in `server.js` for one proxy hop.

---

## Bare Node.js / VPS

```bash
# Clone and install
git clone <repo-url>
cd church-av/relay-server
npm ci --production

# Set environment
cp .env.example .env
# Edit .env

# Start (production)
NODE_ENV=production node server.js

# Or with PM2 for process management
npm install -g pm2
pm2 start server.js --name tally-relay
pm2 save
pm2 startup
```

---

## Database Setup (SQLite)

The relay server uses **SQLite** via `better-sqlite3`. No separate database server is required.

### File location

Defaults to `./data/churches.db` — override with `DATABASE_PATH`. The `data/` directory is created automatically on first start.

### Persistence

- **Railway**: Use a Railway Volume attached at `/app/data`
- **Docker**: Mount a named volume or host directory at `/app/data`
- **VPS**: The `data/` directory persists between process restarts by default

### Backups

Automated backups (WAL checkpoints + file copy) are enabled via:

```
DB_BACKUP_INTERVAL_MINUTES=60
BACKUP_DIR=./backups
BACKUP_RETAIN_COUNT=10
```

For on-demand backups: `POST /api/internal/backups/snapshot`

To restore a backup:
```bash
npm run restore:db
```

---

## Redis Setup (Optional — Rate Limiting)

Without Redis, rate limiting is in-process only (resets on restart, not shared across instances).

### Upstash (recommended for Railway)

1. Create a free Redis database at [upstash.com](https://upstash.com)
2. Copy the **REST URL** and **REST Token**
3. Set in Railway Variables:
   ```
   UPSTASH_REDIS_REST_URL=https://...upstash.io
   UPSTASH_REDIS_REST_TOKEN=...
   ```

### Self-hosted Redis

The current rate limiter uses the Upstash REST API format. To use a standard Redis instance, you would need to adapt `src/rateLimit.js` to use `ioredis`.

---

## First-Run Checklist

- [ ] `ADMIN_API_KEY` and `JWT_SECRET` set to strong random values (32+ chars)
- [ ] `APP_URL` set to the public HTTPS URL
- [ ] `NODE_ENV=production` set
- [ ] `LOG_FORMAT=json` set for structured logging
- [ ] Database directory writable (`./data/`)
- [ ] `GET /api/health` returns HTTP 200
- [ ] Stripe webhook configured (if billing enabled)
- [ ] Telegram webhook configured (if bot enabled)
- [ ] Initial admin user exists (seed or create via DB)

---

## Upgrading

```bash
# Pull latest changes
git pull

# Install any new dependencies
npm ci --production

# Restart the server
pm2 restart tally-relay   # if using PM2
# or redeploy on Railway / rebuild Docker image
```

Schema migrations are applied automatically on startup via `better-sqlite3` (inline `ALTER TABLE` guards in the database init code). No separate migration runner is needed.
