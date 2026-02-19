# Tally Multi-Pass Review

**Date:** 2026-02-18
**Reviewer:** Automated multi-pass code review

---

## Critical Issues (fix before launch)

### 1. ✅ FIXED — PreServiceCheck completely broken (constructor/init mismatch)
**File:** `relay-server/src/preServiceCheck.js`
**Problem:** Constructor took no args but server.js passed `{db, scheduleEngine, churches, ...}`. `start()` expected `(db, churches, tallyBot, sendCommand)` but was called with no args. `this.db` was always `null` — every DB call would crash. Also `onCommandResult()` was called from server.js but didn't exist on the class.
**Fix:** Rewrote constructor to accept the options object server.js passes. Added `onCommandResult()` method. Changed command execution to use WS directly instead of a missing callback. Changed Telegram sending to use raw API instead of depending on tallyBot reference.

### 2. ✅ FIXED — OnCallRotation constructor mismatch
**File:** `relay-server/src/onCallRotation.js`
**Problem:** Constructor took no args. server.js calls `new OnCallRotation(db)` but `db` was ignored. `this.db` was `null` — all rotation queries would crash with `Cannot read properties of null`.
**Fix:** Constructor now accepts `db` parameter and runs `_ensureTable()` immediately.

### 3. ✅ FIXED — MonthlyReport constructor mismatch
**File:** `relay-server/src/monthlyReport.js`
**Problem:** Same pattern — constructor took no args, server.js passed `{db, defaultBotToken, andrewChatId}`. `start()` expected `(db, tallyBot)` but called with no args. `_sendReport` depended on `this.tallyBot` which was never set. Also server.js calls `generateReport()` and `formatReport()` which didn't exist (only `generate()` existed).
**Fix:** Constructor now accepts the options object. Added `generateReport()` and `formatReport()` aliases. `_sendReport` now uses direct Telegram API.

### 4. ✅ FIXED — Electron IPC leaks all decrypted secrets to renderer
**File:** `electron-app/src/main.js`
**Problem:** `ipcMain.handle('get-config', () => loadConfig())` returned fully decrypted config including JWT tokens, API keys, and passwords to the renderer process. Even with `contextIsolation: true`, this violates principle of least privilege.
**Fix:** Changed to use `loadConfigForUI()` which strips sensitive fields and returns boolean flags instead.

### 5. ✅ FIXED — Alert engine uses invalid Telegram Markdown
**File:** `relay-server/src/alertEngine.js`
**Problem:** Used `**bold**` syntax but Telegram's Markdown mode uses `*bold*`. All alert messages rendered with literal asterisks instead of bold text.
**Fix:** Changed `**` to `*`.

### 6. ✅ FIXED — SQL LIKE injection in `findAlertByPrefix`
**File:** `relay-server/src/alertEngine.js`
**Problem:** User-supplied prefix from `/ack_XXXXXXXX` Telegram commands passed directly to SQL `LIKE` operator. A crafted prefix with `%` could match unintended alerts.
**Fix:** Sanitize prefix to hex chars only.

### 7. ✅ FIXED — `getAllTDs()` method doesn't exist
**File:** `relay-server/server.js`
**Problem:** `/api/churches/:churchId/oncall` endpoint called `onCallRotation.getAllTDs()` which doesn't exist.
**Fix:** Replaced with direct DB query.

### 8. ✅ FIXED — No request body size limit
**File:** `relay-server/server.js`
**Problem:** `express.json()` with no size limit allows arbitrarily large request bodies, enabling DoS.
**Fix:** Added `{ limit: '1mb' }`.

---

## Important Issues (fix before first paying customer)

### 9. Duplicate guest token implementations
**Files:** `relay-server/src/guestTokens.js` vs `relay-server/src/guestTdMode.js`
**Problem:** Two separate implementations of guest tokens exist. `guestTokens.js` (GuestTokens class) uses a plugin architecture calling `tallyBot.addAdminPlugin()` and `tallyBot.setGuestRegisterHandler()` which don't exist on TallyBot. It's dead code. Both create `guest_tokens` table with different schemas (`guestName` vs `name`, `telegramChatId` vs `usedByChat`). If both run, schema conflicts could corrupt the table.
**Recommendation:** Delete `guestTokens.js` — server.js only uses `GuestTdMode`.

### 10. CORS wildcard allows any origin
**File:** `relay-server/server.js`
**Problem:** `Access-Control-Allow-Origin: *` means any website can make authenticated API requests if it knows the admin API key. Combined with API key in query strings (dashboard, SSE), this is risky.
**Recommendation:** Restrict to known origins or remove wildcard for admin endpoints.

### 11. Admin API key exposed in URLs
**Files:** `relay-server/server.js`, dashboard SSE
**Problem:** Dashboard and SSE endpoints accept API key via `?key=` query param. Query params appear in server logs, browser history, proxy logs, and Referer headers.
**Recommendation:** Use only `x-api-key` header or cookie-based auth for dashboard.

### 12. No graceful shutdown
**File:** `relay-server/server.js`
**Problem:** No `SIGTERM`/`SIGINT` handlers. On Railway deployments, active WebSocket connections and DB writes could be interrupted mid-operation.
**Recommendation:** Add graceful shutdown that closes WS connections, flushes DB, and stops timers.

### 13. WebSocket reconnection creates unbounded connections
**File:** `church-client/src/index.js`
**Problem:** `connectRelay()` creates a new WebSocket on each call but never closes the old one if it's in CONNECTING state. The `on('close')` handler calls `connectRelay()` again, but if the old socket is still connecting, you get duplicate connections.
**Recommendation:** Close existing socket before creating new one in `connectRelay()`.

### 14. OBS reconnection calls `connectOBS()` which re-registers all event listeners
**File:** `church-client/src/index.js`
**Problem:** Each reconnection adds duplicate event handlers. After N reconnections, `StreamStateChanged` fires N times per event.
**Recommendation:** Create OBS instance once, only call `connect()` on reconnect.

### 15. API keys logged in streamHealthMonitor URLs
**File:** `church-client/src/streamHealthMonitor.js`
**Problem:** YouTube API key and Facebook access token are embedded in fetch URLs. If any error logging includes the URL, keys are leaked to logs.
**Recommendation:** Use headers for auth where possible, or redact URLs in error messages.

---

## Minor Issues

### 16. `loadConfig()` sets duplicate defaults
**File:** `church-client/src/index.js`
**Problem:** `config.youtubeApiKey` is set twice to `''` (lines ~80 and ~83). Harmless but confusing.

### 17. Dashboard HTML is defined in both `dashboard.js` and `dashboard.html`
**Files:** `relay-server/src/dashboard.js`, `relay-server/src/dashboard.html`
**Problem:** `dashboard.js` exports `setupDashboard()` with embedded HTML, but server.js serves `dashboard.html` from disk. `dashboard.js` is imported nowhere — dead code or an older implementation.

### 18. `_atemLevelToDb` edge case
**File:** `church-client/src/audioMonitor.js`
**Problem:** Values > 65535 return 0 dB which could suppress silence detection. Should return `null` or handle gracefully.

### 19. vMix XML parsing uses regex
**File:** `church-client/src/vmix.js`
**Problem:** Regex-based XML parsing is fragile. Self-closing `<input ... />` works but `<input ...>...</input>` wouldn't be captured. For a monitoring system this is acceptable but a proper XML parser would be more robust.

### 20. ProPresenter connection check has logic error
**File:** `church-client/src/index.js`
**Problem:** `if (!ppConfig.host && ppConfig.host !== 'localhost')` — this condition is always true when host is falsy (empty string, null, undefined) because `'' !== 'localhost'` is true. Should be `if (!ppConfig.host)`.

---

## What's Working Well

1. **Solid architecture** — Clean separation between relay server, client agent, and Electron wrapper. The WebSocket relay pattern is well-suited for NAT traversal in church environments.

2. **Comprehensive command system** — The regex-based natural language parser in `telegramBot.js` is excellent. Covers ATEM, OBS, Companion, VideoHub, ProPresenter, vMix, Resolume, Dante, and mixer control with natural phrasing.

3. **Alert escalation ladder** — The 90-second escalation from TD → Andrew with auto-recovery attempts is production-grade.

4. **Secure credential storage** — `secureStorage.js` uses proper AES-256-GCM with PBKDF2-derived machine keys. Handles encryption/decryption failures gracefully.

5. **OSC implementation** — Pure Node.js OSC encoder/decoder is correct and handles all standard types. Clean subscribe/query pattern with timeouts.

6. **Mixer abstraction** — `MixerBridge` properly normalizes the mute convention difference between Behringer (0=muted) and Allen & Heath (1=muted) behind a unified API.

7. **Watchdog deduplication** — Both client-side watchdog and audio monitor use 5-minute dedup windows to prevent alert storms.

8. **Rate limiting** — Token bucket rate limiter on command endpoints prevents abuse.

9. **Message queuing** — 30-second message queue for briefly-offline churches prevents command loss during reconnection.

10. **Electron security** — `contextIsolation: true`, `nodeIntegration: false`, and proper `preload.js` pattern.

---

## Fixes Applied

| # | File | Fix |
|---|------|-----|
| 1 | `relay-server/src/preServiceCheck.js` | Rewrote constructor to match server.js usage, added `onCommandResult()`, fixed command sending |
| 2 | `relay-server/src/onCallRotation.js` | Constructor now accepts `db` parameter |
| 3 | `relay-server/src/monthlyReport.js` | Constructor accepts options object, added `generateReport()`/`formatReport()` aliases, fixed Telegram sending |
| 4 | `electron-app/src/main.js` | Changed `get-config` IPC to use `loadConfigForUI()` instead of leaking secrets |
| 5 | `relay-server/src/alertEngine.js` | Fixed Telegram markdown (`**` → `*`) |
| 6 | `relay-server/src/alertEngine.js` | Sanitized SQL LIKE prefix input |
| 7 | `relay-server/server.js` | Fixed missing `getAllTDs()` with direct DB query |
| 8 | `relay-server/server.js` | Added `{ limit: '1mb' }` to `express.json()` |
