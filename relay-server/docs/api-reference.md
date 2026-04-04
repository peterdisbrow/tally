# Tally Connect Relay Server — API Reference

**Version:** 1.1.0
**Base URL:** `https://your-relay.up.railway.app`
**OpenAPI spec:** `GET /api/docs`

---

## Table of Contents

1. [Authentication](#authentication)
2. [Common Error Responses](#common-error-responses)
3. [Billing Tiers & Feature Gates](#billing-tiers--feature-gates)
4. [Health & Status](#health--status)
5. [Admin Authentication](#admin-authentication)
6. [Church App Authentication & Onboarding](#church-app-authentication--onboarding)
7. [Email Verification & Password Reset](#email-verification--password-reset)
8. [Billing](#billing)
9. [Church Management (Admin)](#church-management-admin)
10. [Command Dispatch](#command-dispatch)
11. [Automation & Presets](#automation--presets)
12. [Sessions, Schedule & Reporting](#sessions-schedule--reporting)
13. [Chat](#chat)
14. [AI Onboarding Chat](#ai-onboarding-chat)
15. [Stream Platforms (YouTube & Facebook)](#stream-platforms-youtube--facebook)
16. [Slack Integration](#slack-integration)
17. [Telegram Integration](#telegram-integration)
18. [On-Call Rotation](#on-call-rotation)
19. [Maintenance Windows](#maintenance-windows)
20. [Guest Tokens](#guest-tokens)
21. [Events (Time-Limited Accounts)](#events-time-limited-accounts)
22. [Planning Center Integration](#planning-center-integration)
23. [Reseller API](#reseller-api)
24. [Support Tickets](#support-tickets)
25. [Real-Time: SSE & WebSocket](#real-time-sse--websocket)
26. [Internal / Operational](#internal--operational)

---

## Authentication

Four schemes are in use depending on the caller:

| Caller | Scheme | Header |
|--------|--------|--------|
| Admin dashboard / scripts | JWT Bearer | `Authorization: Bearer <token>` |
| Church Electron app | JWT Bearer | `Authorization: Bearer <token>` |
| Reseller integrations | API Key | `x-reseller-key: <key>` |
| Legacy / internal | API Key | `x-api-key: <key>` |

Admin JWTs are obtained from `POST /api/admin/login`.
Church app JWTs are obtained from `POST /api/church/app/login` or `POST /api/church/app/onboard`.

---

## Common Error Responses

All error responses share the same shape:

```json
{ "error": "Human-readable message" }
```

| Status | Meaning |
|--------|---------|
| `400` | Bad request — missing or invalid fields |
| `401` | Missing or invalid authentication |
| `402` | Feature requires a higher billing tier |
| `403` | Authenticated but not authorized |
| `404` | Resource not found |
| `409` | Conflict (e.g. email already registered) |
| `429` | Rate limit exceeded |
| `503` | Church not connected / service unavailable |

---

## Billing Tiers & Feature Gates

| Tier | Slug | Key Features |
|------|------|--------------|
| Basic | `connect` | Relay, chat, presets, Problem Finder |
| Plus | `plus` | AutoPilot, on-call rotation, command log, monthly reports |
| Pro | `pro` | Planning Center, advanced sessions |
| Enterprise | `managed` | Full-service, all features |
| Event | `event` | Time-limited, single-event access |

Endpoints that require a specific tier return **HTTP 402** with an upgrade suggestion when the church is on a lower tier.

---

## Health & Status

### `GET /`
Basic service liveness check — no auth required.

**Response**
```json
{
  "service": "tally-relay",
  "version": "1.1.0",
  "churches": 42,
  "controllers": 1
}
```

---

### `GET /api/health`
Detailed health including uptime and relay counters.

**Response**
```json
{
  "service": "tally-relay",
  "version": "1.1.0",
  "build": "production",
  "uptime": 86400,
  "registeredChurches": 42,
  "connectedChurches": 7,
  "controllers": 1,
  "totalMessagesRelayed": 18432
}
```

---

### `GET /api/status`
Machine-readable status suitable for uptime monitors.

Returns **HTTP 200** for `operational` and `degraded`, **HTTP 503** for outages.

**Response**
```json
{
  "status": "operational",
  "timestamp": "2026-03-21T14:00:00Z",
  "components": {
    "relay": "operational",
    "websocket": "operational",
    "message_relay": "operational"
  }
}
```

---

### `GET /api/status/components`
Lists all status page components and their current state.

---

### `GET /api/status/incidents`
Lists recent incidents.

| Query | Type | Default | Max |
|-------|------|---------|-----|
| `limit` | integer | 50 | 200 |

---

### `POST /api/status/run-checks`
Manually triggers status checks. **Requires admin auth.**

---

## Admin Authentication

### `POST /api/admin/login`
> Rate limited: 5 requests / 15 min

**Body**
```json
{ "email": "admin@example.com", "password": "secret" }
```

**Response**
```json
{
  "token": "<jwt>",
  "user": { "id": 1, "email": "admin@example.com", "name": "Tally Admin", "role": "super_admin" }
}
```

---

### `GET /api/admin/me`
Returns the currently authenticated admin user's profile.

---

### `PUT /api/admin/me/password`
Changes the authenticated admin's own password.

**Body**
```json
{ "currentPassword": "old", "newPassword": "new-min8chars" }
```

---

### `GET /api/admin/users` _(super_admin)_
Lists all admin users.

---

### `POST /api/admin/users` _(super_admin)_
Creates a new admin user. Role must be one of: `super_admin`, `admin`, `engineer`, `sales`.

**Body**
```json
{ "email": "...", "password": "min8chars", "name": "...", "role": "admin" }
```

---

### `PUT /api/admin/users/:userId` _(super_admin)_
Updates name, role, or active status. Prevents demoting/deactivating the last `super_admin`.

---

### `PUT /api/admin/users/:userId/password` _(super_admin)_
Resets another admin user's password.

---

### `DELETE /api/admin/users/:userId` _(super_admin)_
Soft-deactivates an admin user. Cannot delete self or last `super_admin`.

---

### `GET /api/admin/ai-usage`
AI usage analytics for the last 30 days, broken down by church and feature.

**Response**
```json
{
  "totals": {
    "total_requests": 1200,
    "input_tokens": 450000,
    "output_tokens": 120000,
    "cost_usd": 1.23,
    "cache_hits": 80
  },
  "byChurch": [...],
  "byFeature": [...]
}
```

---

## Church App Authentication & Onboarding

### `POST /api/church/app/onboard`
> Rate limited: 10 requests / 60 min

Self-service signup. Creates a new church account, optionally starts a Stripe checkout, and returns a JWT for immediate app use.

**Body**
```json
{
  "name": "Grace Chapel",
  "email": "tech@gracechapel.org",
  "password": "min8chars",
  "tier": "connect",
  "billingInterval": "monthly",
  "tosAcceptedAt": "2026-03-21T12:00:00Z",
  "referralCode": "FRIEND123"
}
```

**Response** (abbreviated)
```json
{
  "created": true,
  "churchId": "uuid",
  "token": "<jwt>",
  "tokenExpiresIn": "30d",
  "billing": { "required": false, "status": "trialing", "tier": "connect", "trialEndsAt": "2026-04-20T..." },
  "checkoutUrl": null
}
```

---

### `POST /api/church/app/login`
> Rate limited: 5 requests / 15 min

**Body**
```json
{ "email": "tech@gracechapel.org", "password": "secret" }
```

Returns **HTTP 402** if billing is required and the church's plan is not active.

**Response**
```json
{
  "token": "<jwt>",
  "tokenType": "church_app",
  "tokenExpiresIn": "30d",
  "church": { "churchId": "uuid", "name": "Grace Chapel", "email": "..." },
  "billing": { "status": "active", "tier": "plus", "billingInterval": "monthly", "bypassed": false }
}
```

---

### `GET /api/church/app/me`
Returns the church's profile, connection status, notification settings, TD list, timezone, and `audio_via_atem` flag.

---

### `PUT /api/church/app/me`
Updates profile fields. To change password, supply both `currentPassword` and `newPassword`.

---

### `POST /api/church/app/reset-password` _(admin)_
Admin-initiated password reset for a church by email.

---

### `POST /api/leads/capture`
> Rate limited: 5 requests / 60 s

Captures a marketing lead (no auth required).

---

### `GET /api/referral/:code`
> Rate limited: 20 requests / 60 s

Checks if a referral code is valid.

---

### `POST /api/pf/report`
Saves a Problem Finder run report from the church app and broadcasts it to any listening SSE clients.

---

## Email Verification & Password Reset

### `GET /api/church/verify-email?token=<token>`
Verifies an email address. On success, redirects to `/church-portal?verified=true`.

---

### `POST /api/church/resend-verification`
> Rate limited: 3 requests / 60 s

Resends the verification email. Returns `{ sent, alreadyVerified }`.

---

### `POST /api/church/forgot-password`
> Rate limited: 3 requests / 15 min

Initiates self-service password reset. Always returns `{ sent: true }` to prevent email enumeration.

---

### `POST /api/church/reset-password-token`
> Rate limited: 5 requests / 15 min

Completes the reset using the token from the email. Token expires in 1 hour.

**Body**
```json
{ "token": "...", "password": "newmin8chars" }
```

---

## Billing

### `POST /api/billing/checkout` _(admin)_
> Rate limited: 5 requests / 60 s

Creates a Stripe checkout session for a church.

**Body**
```json
{
  "tier": "plus",
  "churchId": "uuid",
  "email": "tech@gracechapel.org",
  "successUrl": "https://app.example.com/success",
  "cancelUrl": "https://app.example.com/cancel",
  "billingInterval": "monthly"
}
```

**Response**
```json
{ "url": "https://checkout.stripe.com/..." }
```

---

### `POST /api/billing/portal` _(admin)_
Creates a Stripe billing portal session so the church can manage their subscription.

---

### `POST /api/billing/webhook`
Stripe webhook receiver. Verifies `stripe-signature` header. Raw body must be preserved.

---

### `GET /api/billing/status/:churchId` _(admin)_
Returns the current billing status for a church.

---

### `GET /api/billing` _(admin)_
Lists all billing records.

---

### `PUT /api/churches/:churchId/billing` _(admin)_
Manually overrides billing tier or status (e.g. for comped accounts).

**Body**
```json
{ "tier": "pro", "status": "active", "billingInterval": "annual" }
```

---

## Church Management (Admin)

### `GET /api/churches`
Lists all registered churches with runtime status (connected, last seen, billing tier, etc.).

---

### `POST /api/churches/register`
Registers a new church directly (admin-initiated, bypasses self-service flow).

---

### `GET /api/churches/:churchId`
Returns full church details including registration code and WebSocket token.

---

### `GET /api/churches/:churchId/status`
Returns just the connection status: `{ name, connected, status, lastSeen }`.

---

### `DELETE /api/churches/:churchId`
Cascade-deletes a church and all associated data. Irreversible.

---

## Command Dispatch

### `POST /api/command` _(admin)_
> Rate limited: 10 commands / second
> Messages queued for 30 s if church is offline

Sends a command to a church's Electron app via the WebSocket relay.

**Body**
```json
{ "churchId": "uuid", "command": "cut", "params": {} }
```

**Response**
```json
{ "sent": true, "queued": false, "messageId": "msg_abc123" }
```

| Status | Meaning |
|--------|---------|
| `200 sent=true` | Command delivered over WebSocket |
| `200 queued=true` | Church offline; queued for delivery |
| `402` | Billing access denied |
| `429` | Rate limit exceeded |
| `503` | Not connected and queue full |

---

### `POST /api/broadcast` _(admin)_
Sends a command to **all** currently connected churches simultaneously.

**Response**
```json
{ "sent": 7, "total": 42 }
```

---

## Automation & Presets

### `GET /api/churches/:churchId/presets`
### `POST /api/churches/:churchId/presets`
### `GET /api/churches/:churchId/presets/:name`
### `DELETE /api/churches/:churchId/presets/:name`

CRUD for named presets (ATEM memory recalls, audio snapshots, etc.). Accessible by both admin and church app auth.

---

### `POST /api/churches/:churchId/presets/:name/recall`
Sends the preset to the church client for immediate execution. Requires church to be connected.

---

### `GET /api/churches/:churchId/automation` _(plus+)_
### `POST /api/churches/:churchId/automation` _(plus+)_
### `PUT /api/churches/:churchId/automation/:ruleId` _(plus+)_
### `DELETE /api/churches/:churchId/automation/:ruleId` _(plus+)_

AutoPilot rule management. Returns **HTTP 402** if below `plus` tier or if per-tier rule limit is reached on creation.

**Create body**
```json
{
  "name": "Auto cut to program at 10:59",
  "triggerType": "schedule",
  "triggerConfig": { "cron": "59 10 * * 0" },
  "actions": [{ "command": "cut" }]
}
```

---

### `POST /api/churches/:churchId/automation/:ruleId/test` _(plus+)_
Dry-runs an AutoPilot rule without executing real commands.

---

### `POST /api/churches/:churchId/automation/pause` _(plus+)_
### `POST /api/churches/:churchId/automation/resume` _(plus+)_
Pause or resume all AutoPilot rules for a church.

---

### `GET /api/churches/:churchId/command-log` _(plus+)_
Paginated command history.

| Query | Default | Max |
|-------|---------|-----|
| `limit` | 50 | 200 |
| `offset` | 0 | — |

---

## Sessions, Schedule & Reporting

### `GET /api/churches/:churchId/schedule`
### `PUT /api/churches/:churchId/schedule`
Manage recurring service schedule. Used by AutoPilot and the offline-detection cron.

---

### `PUT /api/churches/:churchId/td-contact`
Updates the church's primary TD contact for Telegram alerts.

---

### `POST /api/alerts/:alertId/acknowledge`
Acknowledges an active alert. Optionally supply a `responder` name.

---

### `GET /api/churches/:churchId/sessions`
Paginated list of past sessions.

---

### `GET /api/churches/:churchId/sessions/current`
Returns the currently active session, or `{ active: false }` if none.

---

### `GET /api/churches/:churchId/sessions/:sessionId/timeline`
Full timeline for a session: events, alerts, chat messages, and markers.

---

### `GET /api/churches/:churchId/sessions/:sessionId/debrief`
AI-generated debrief report for a session.

---

### `GET /api/churches/:churchId/report?month=2026-03` _(plus+)_
Monthly performance report. Defaults to the current month.

---

### `GET /api/digest/latest`
### `GET /api/digest/generate`
Retrieve or generate the weekly ops digest.

---

## Chat

### `POST /api/church/chat` · `GET /api/church/chat`
> Rate limited (POST): 20 requests / 60 s

Church app sends and retrieves chat messages. Supports file attachments (base64-encoded).

---

### `POST /api/churches/:churchId/chat` · `GET /api/churches/:churchId/chat`
> Rate limited (POST): 30 requests / 60 s

Admin side of the same chat thread. GET supports `since`, `limit`, and `sessionId` filters.

---

### `POST /api/chat` _(admin)_
> Rate limited: 30 requests / 60 s

AI-powered admin dashboard chat. Optionally pass `churchStates` and conversation `history`.

---

## AI Onboarding Chat

### `POST /api/church/onboarding/chat`
> Rate limited: 30 requests / 60 s

Sends a message to the AI onboarding assistant. Optionally include `scanResults` from a hardware scan.

---

### `POST /api/church/onboarding/confirm`
> Rate limited: 20 requests / 60 s

Executes an onboarding action that the AI proposed (e.g. saving ATEM IP, creating a preset).

---

### `GET /api/church/onboarding/state`
Returns the current onboarding state, collected data, and progress (completed vs. remaining steps).

---

## Stream Platforms (YouTube & Facebook)

### Facebook OAuth Flow

1. `GET /api/oauth/facebook/callback` — public redirect URL, stores auth code
2. `GET /api/church/app/oauth/facebook/pending?state=<state>` — poll until `{ ready: true, code }`
3. `POST /api/church/app/oauth/facebook/exchange` — exchange code for token + page list
4. `POST /api/church/app/oauth/facebook/select-page` — select page, creates live video + stream key
5. `POST /api/church/app/oauth/facebook/refresh-key` — refresh stream key before a service
6. `DELETE /api/church/app/oauth/facebook` — disconnect

### YouTube OAuth Flow

1. Exchange code: `POST /api/church/app/oauth/youtube/exchange`
2. Refresh key: `POST /api/church/app/oauth/youtube/refresh-key`
3. Disconnect: `DELETE /api/church/app/oauth/youtube`

### Combined Status

- `GET /api/church/app/oauth/status` — connection status for both platforms
- `GET /api/church/app/oauth/stream-keys` — current stream keys

---

## Slack Integration

### `GET /api/churches/:churchId/slack`
Returns Slack configuration (webhook URL is masked).

---

### `PUT /api/churches/:churchId/slack`
Saves a Slack incoming webhook URL. Must be an HTTPS `hooks.slack.com` URL.

**Body**
```json
{ "webhookUrl": "https://hooks.slack.com/services/...", "channel": "#av-alerts" }
```

---

### `DELETE /api/churches/:churchId/slack`
Removes the Slack integration.

---

### `POST /api/churches/:churchId/slack/test`
Sends a test alert to the configured Slack channel.

---

## Telegram Integration

### `POST /api/telegram-webhook`
Telegram Update receiver. Responds **HTTP 200** immediately (no auth if no secret configured).

---

### `POST /api/churches/:churchId/td-register`
Registers a TD by their Telegram user ID.

---

### `GET /api/churches/:churchId/tds`
### `DELETE /api/churches/:churchId/tds/:userId`
List or remove TDs.

---

### `POST /api/bot/set-webhook`
Configures the Telegram bot's webhook URL.

---

## On-Call Rotation

> Requires `plus` tier or higher.

### `GET /api/churches/:churchId/oncall`
Returns the current on-call TD and the full rotation list.

---

### `POST /api/churches/:churchId/oncall`
Sets the active on-call TD by name.

**Body**
```json
{ "tdName": "Marcus" }
```

---

### `POST /api/churches/:churchId/tds/add`
Adds a new TD to the rotation with optional primary designation.

---

## Maintenance Windows

### `GET /api/churches/:churchId/maintenance`
Lists scheduled maintenance windows.

---

### `POST /api/churches/:churchId/maintenance`
Schedules a maintenance window (suppresses alerts during window).

**Body**
```json
{
  "startTime": "2026-03-22T06:00:00Z",
  "endTime": "2026-03-22T08:00:00Z",
  "reason": "ATEM firmware upgrade"
}
```

---

### `DELETE /api/maintenance/:id`
Removes a maintenance window.

---

## Guest Tokens

### `POST /api/churches/:churchId/guest-token`
Generates a temporary access token for a guest operator or visitor.

---

### `GET /api/guest-tokens`
Lists all active guest tokens.

---

### `DELETE /api/guest-token/:token`
Revokes a guest token immediately.

---

## Events (Time-Limited Accounts)

### `GET /api/events`
Lists all event-type church accounts, including `timeRemaining` (ms) and `expired` flag.

---

### `POST /api/events/create`
Creates a temporary event church account.

**Body**
```json
{
  "name": "Easter 2026",
  "eventLabel": "Easter Service",
  "durationHours": 48,
  "tdName": "Jordan",
  "tdTelegramChatId": "123456789",
  "contactEmail": "jordan@example.com"
}
```

**Response**
```json
{
  "churchId": "uuid",
  "token": "<registration-token>",
  "expiresAt": "2026-03-23T12:00:00Z",
  "name": "Easter 2026"
}
```

---

## Planning Center Integration

> Requires `pro` tier or higher.

### `GET /api/churches/:churchId/planning-center`
Returns current integration status and last sync time.

---

### `PUT /api/churches/:churchId/planning-center`
Saves Planning Center credentials and service type ID.

**Body**
```json
{
  "appId": "abc123",
  "secret": "secret",
  "serviceTypeId": "987654",
  "syncEnabled": true
}
```

---

### `POST /api/churches/:churchId/planning-center/sync`
Triggers an immediate sync of upcoming services.

---

### `GET /api/churches/:churchId/planning-center/preview`
Returns upcoming services from Planning Center without saving anything.

---

## Reseller API

### Admin Management (`AdminBearer` required)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/resellers` | List all resellers |
| `POST` | `/api/resellers` | Create reseller (returns API key) |
| `GET` | `/api/resellers/:id` | Get reseller + their churches |
| `PUT` | `/api/resellers/:id` | Update reseller |
| `DELETE` | `/api/resellers/:id` | Deactivate reseller |
| `POST` | `/api/resellers/:id/password` | Set reseller portal password |

### Reseller Self-Service (`x-reseller-key` required)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/reseller/me` | Own profile + stats |
| `PUT` | `/api/reseller/me` | Update branding |
| `GET` | `/api/reseller/branding` | Branding config |
| `GET` | `/api/reseller/stats` | Usage statistics |
| `GET` | `/api/reseller/churches` | List own churches |
| `GET` | `/api/reseller/churches/:id` | Single church |
| `POST` | `/api/reseller/churches/register` | Register new church |
| `POST` | `/api/reseller/churches/token` | Create church with login credentials |

**Create church with credentials**
```json
{
  "churchName": "Riverside Community",
  "contactEmail": "av@riverside.org",
  "portalEmail": "portal@riverside.org",
  "password": "secure-pass"
}
```

---

## Support Tickets

### `POST /api/support/triage` _(admin)_
AI-assisted triage of a support issue. Pass diagnostics data.

---

### `GET /api/support/tickets` _(admin)_
Paginated ticket list. Filter by `status` and `category`.

---

### `POST /api/support/tickets` _(admin)_
> Rate limited: 5 requests / 60 s

Creates a new ticket.

---

### `GET /api/support/tickets/:ticketId` _(admin)_
Full ticket with timeline of updates.

---

### `PUT /api/support/tickets/:ticketId` _(admin)_
Updates ticket status, category, severity, or assignee.

---

### `POST /api/support/tickets/:ticketId/updates` _(admin)_
Appends a message or attachment to a ticket's timeline.

---

## Real-Time: SSE & WebSocket

### Server-Sent Events — `GET /api/dashboard/stream`

Opens an SSE connection for live dashboard updates. Requires admin auth (cookie or Bearer).

```
event: connected
data: {"churchId":null,"timestamp":"..."}

event: status
data: {"churchId":"uuid","connected":true,"status":"ok"}

event: alert
data: {"id":"alert_1","churchId":"uuid","message":"Signal lost"}

event: heartbeat
data: {"ts":"..."}
```

---

### WebSocket — `wss://<host>/`

The relay WebSocket shares the HTTP server port. No separate URL path is needed.

**Church client registration**
```json
{ "type": "register", "token": "<church_app_jwt>" }
```

**Controller registration**
```json
{ "type": "controller", "key": "<admin_api_key>" }
```

**Send command (controller → relay → church)**
```json
{ "type": "command", "churchId": "uuid", "command": "cut", "params": {} }
```

**Status update (church → relay → controllers)**
```json
{ "type": "status", "churchId": "uuid", "data": { "program": 2, "preview": 3 } }
```

Max message size: **256 KB**.

---

## Internal / Operational

### `POST /api/internal/backups/snapshot` _(admin)_
Triggers a manual SQLite database snapshot.

**Body** _(optional)_
```json
{ "label": "pre-upgrade" }
```

---

### `GET /api/docs`
Returns the full OpenAPI 3.0 specification as JSON. No authentication required.

---

### `POST /api/chat/stream`
Landing-page AI chat proxy (SSE). Requires `x-chat-secret` header matching `CHAT_PROXY_SECRET` env var. Not intended for external use.
