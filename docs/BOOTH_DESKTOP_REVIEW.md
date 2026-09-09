# Tally Booth Desktop Review

**Audience:** Andrew (platform operator / Chief of Staff) and booth-release owners.  
**Repo:** `peterdisbrow/tally` @ `origin/main` (`d23139d`) plus this PR.  
**Live probe:** 2026-09-09 ~00:59 UTC, read-only. No production credentials used. No signing secrets invented.  
**Deployed relay:** `1.1.67` build `d23139dafca9521816d1773ef2e0bc192ac55581` (Railway + Cloudflare)

This answers: *can a church leave Booth running on Saturday and trust it through Sunday — reconnect, alert, and update without babysitting?*

Companion docs: [`FEATURE_AUDIT_2026-09-08.md`](FEATURE_AUDIT_2026-09-08.md), [`ALERTS_REVIEW.md`](ALERTS_REVIEW.md) (#153), [`ADMIN_DASHBOARD_REVIEW.md`](ADMIN_DASHBOARD_REVIEW.md).

North star: **Sunday-indispensable.** Booth must reconnect, alert, and update without a TD watching the tray.

**Prepare mode.** This review does not propose sales features.

---

## Status legend

| Status | Meaning |
|--------|---------|
| **WORKING** | Code + tests, and a live or release probe shows the path can fire |
| **PARTIAL** | Implemented, but env-gated, version-skewed, or unused until a booth connects |
| **BROKEN** | Confirmed miss: reconnect / update / alert / tray does not do what Sunday needs |
| **UNPROVEN** | Code looks complete; **0 connected churches** so the live path has not been watched |
| **DEAD** | Code or copy describes a surface that is not used by Electron first-run |

---

## Summary verdict

**Partial. The supervisor is real. The Sunday loop is unproven, and two release paths need Andrew.**

Live `/api/health` at probe time: **6 registered / 0 connected / 0 controllers / 0 messages relayed.** Dogfood (Cogcomm, LCC, disbrow) cannot prove connect, watchdog, failover, or auto-update against a real booth.

| Path | Sunday intent | As built | Sunday-usable? |
|------|---------------|----------|----------------|
| **Connect / reconnect** | Stay on the relay; come back after wifi blips | JWT login → spawn church-client → WS `/church?token` + exponential backoff + 2-min Electron restart watchdog | **Code yes. Live UNPROVEN** |
| **Offline detection** | Tray + dashboard tell the truth; local kit still visible | Health probe 10s × 3 failures; local `/local-status` poll. Dashboard emit was missing (fixed in this PR) | **PARTIAL → dashboard P0 fixed in this PR** |
| **Token auth** | Booth stays authorized across a month of Sundays | Desktop login issues `church_app` JWT (**30d**), not the 365d `churches.token`. WS accepts any JWT with `churchId` | **PARTIAL** — month-old autostart can 1008 and stop |
| **Auto-update** | Quiet patch between services | `electron-updater` + GitHub. Win `latest.yml` = **1.1.67** unsigned. Mac `latest-mac.yml` = **1.1.66** (2026-05-05) by design | **Win PARTIAL. Mac stuck until Mac Studio** |
| **First-run / tray / autostart** | Volunteer can install, sign in, hide to tray | Wizard + login items + hide-to-tray. Tray Start/Stop was bound to relay (fixed in this PR) | **WORKING (code); tray P0 fixed** |
| **Watchdog (ATEM/OBS/encoder/mixer/PP)** | Page when kit drops | 30s tick + typed `alertType`. #153 types stream-down/mute | **UNPROVEN** — needs a connected booth |
| **Failover auto-recover** | Switch to backup, then switch back | State machine exists. **`failover_auto_recover` forced 0 on every relay boot** | **Manual only — leave off until bounce-loop is gone** |
| **Crash recovery** | Agent dies, supervisor brings it back | `uncaughtException` → exit 1; Electron backoff, never gives up after 5 crashes (re-alerts every 10 min) | **WORKING (code)** |
| **Observability** | Andrew sees why Sunday failed | File log + log shipper + diagnostic bundle. **No Electron Sentry** | **PARTIAL** |

**Do not invent signing secrets.** Mac 1.1.67 signed/notarized builds need Andrew’s Mac Studio (Developer ID team **HVSJPZDLZF**). Windows Authenticode needs `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` in GitHub Actions — currently absent, so CI ships unsigned.

---

## North-star scorecard

Scores are 1–5 against *Sunday-indispensable*, not feature count. **Honesty over live proof:** nothing below 5 can be claimed as watched in production while `connectedChurches: 0`.

| Pillar | Score | Why this number |
|--------|-------|-----------------|
| **Reliability** | **3 / 5** | Reconnect, crash backoff, and SSE status are designed for unattended booths. Failover will not auto-switch-back. `recovery.reconnectDevice` called methods the agent does not have (fixed in this PR). Live reconnect is **unproven**. |
| **Trust** | **2 / 5** | Download/marketing can read as “1.1.67 signed Mac.” Release notes correctly say Mac is carry-forward **1.1.66**. Tray used to claim “Local monitoring active” when the agent was stopped (fixed). Unsigned Windows = SmartScreen. Failover homepage copy vs globally forced-off auto-recover. |
| **Security** | **3 / 5** | Relay host allowlist, `safeStorage` / DPAPI, secrets via env not `ps`. Deep links reject `relayUrl`. Token is a 30-day app JWT reused for WS. Unsigned Win installer. Electron has no Sentry (also means no crash PII leak — tradeoff). |
| **Polish** | **3 / 5** | Sign-in, room picker every launch, onboarding chat, hide-to-tray, login items, tray i18n (`en`/`es`). Renderer dashboard Sunday offline/status strings now use i18n; the rest of the dashboard is still English. Registration-code sign-in is **not** in Electron (Telegram/admin only). |
| **Observability** | **2 / 5** | `~/.church-av/logs/tally-app.log` (10 MB rotate) + agent `agent_log` over WS + `system.diagnosticBundle`. No Electron Sentry. No protocol-version handshake. Fleet Monitor is dark with 0 connected booths. |

**Overall: 2.6 / 5 — shippable as a supervised install, not yet Sunday-invisible.**

---

## 1. Inventory

Two processes, one install.

```
Electron (electron-app 1.1.67)
  ├─ main.js          supervisor, tray, auto-update, IPC
  ├─ renderer         sign-in, room picker, wizard, dashboard
  ├─ relay-client     login / token check / host allowlist
  └─ spawns node → church-client (bundled extraResource)
        ├─ WS wss://api.tallyconnect.app/church?token&instance[&room_id]
        ├─ ATEM / OBS / encoder / mixer / ProPresenter / Companion / …
        ├─ watchdog 30s + status_update 3s
        └─ GET 127.0.0.1:{port}/local-status  (Electron fallback)
```

| Piece | Version in repo | What ships today |
|-------|-----------------|------------------|
| `electron-app/package.json` | **1.1.67** | Windows CI installer |
| `church-client/package.json` | **1.1.67** | Bundled inside Electron via `extraResources` + `afterPack` `npm ci` |
| `relay-server/package.json` | **1.1.67** | Live Railway `1.1.67` / `d23139d` |
| GitHub `v1.1.67` Win | `latest.yml` **1.1.67** (2026-09-08 22:29Z) | `Tally-Setup-1.1.67.exe` **unsigned** |
| GitHub `v1.1.67` Mac | `latest-mac.yml` **1.1.66** (date **2026-05-05**) | Zips named `Tally-1.1.66-*.zip`; versionless DMGs are 1.1.66 carry-forward |

There is **no** `build-mac.yml`. Mac is manual on the Studio (`.claude/skills/build-release.md`). Windows is `.github/workflows/build-win.yml` (`workflow_dispatch` only).

---

## 2. Connect / reconnect / offline / token

### How a booth authenticates

1. Electron UI: email + password → `POST /api/church/app/login`.
2. Relay returns `issueChurchAppToken` — JWT `{ type: 'church_app', churchId, name }`, TTL **`TALLY_CHURCH_APP_TOKEN_TTL` default 30d**.
3. Token stored in `~/.church-av/config.json` via `secureStorage` (Keychain / DPAPI / AES-GCM fallback).
4. Agent spawn: `TALLY_TOKEN` in env (not argv). WS: `{relay}/church?token=…&instance={name}[::{roomId}]`.
5. Relay `handleChurchConnection`: `jwt.verify` + `churches.get(churchId)` + paid-access gate. **Does not check `type === 'church_app'`** — so the 30d app token works on WS.

The 365-day `churches.token` (admin “connection token”) is **not** what Electron login stores. Registration codes are Telegram `/register`, not desktop sign-in.

On startup Electron `validate-token` decodes `exp` locally, then `GET /api/church/app/me`. **Auth failure in agent stdout** (`1008`, `jwt expired`, …) kills the process and **stops the crash-restart loop** (`_detectAgentAuthFailure`). That is correct (avoid a Sunday storm) and also means an expired 30d token leaves the booth dark until a human signs in again.

### Reconnect layers

| Layer | Behavior | Citation |
|-------|----------|----------|
| Church-client WS | 5s start, ×2 backoff, cap 5 min, ±20% jitter. No reconnect on `room_limit` 1008 or “replaced by new connection” | `church-client/src/index.js` |
| Electron watchdog | If stdout saw `Relay disconnected` for **≥2 min**, restart agent | `electron-app/src/main.js` |
| SSE status | Retry 3s → 30s | `main.js` `startRelayStatusSSE` |
| Agent crash | `MAX_AGENT_CRASHES=5` then keep restarting at 60s cap; notify every 10 min | `main.js` |
| Relay WS heartbeat | Native ping 30s / 10s pong kill; plus per-socket ~25s | `server.js`, `websocketRouter.js` |
| Offline cron | 10 min; uses **`lastHeartbeat`** (only `status_update`), skips if any socket OPEN | `offlineDetection.js` |

**Connected** on `/api/health` = any church WS `readyState === OPEN`. Not heartbeat. Weekday 0/6 is called out in health code as normal.

### Offline / local fallback

`relayHealthMonitor` polls `{relay}/health` every 10s, timeout 5s, **3 consecutive failures (~30s)** before OFFLINE. Then Electron polls `127.0.0.1:{port}/local-status` every 5s.

**P0 (fixed here):** `pollLocalStatus` merged into `agentStatus` and emitted `local:status`, but the renderer dashboard listens on `status` and treated `onLocalStatus` as a no-op. Offline device pills would freeze unless leftover stdout parsing happened to fire.

**P0 (fixed here):** Tray Start/Stop used `agentStatus.relay`. Relay down + agent still running → menu said **Start Monitoring** → `startAgent()` no-op (`if (agentProcess) return`) → TD could not stop from tray.

### Billing gate

Production `TALLY_REQUIRE_ACTIVE_BILLING` defaults **true**. Trial expired / past-due after grace → WS close `billing_<status>`. Electron should surface this (stdout + auth-invalid patterns include `1008` but not a dedicated billing toast).

---

## 3. Auto-update, signing, tray check

`setupAutoUpdate()`: `autoDownload=true`, `autoInstallOnAppQuit=true`, first `checkForUpdatesAndNotify()`, then every `prefs.updateCheckIntervalHours` (default 24, clamp 1–168). Tray **Check for Updates** calls `autoUpdater.checkForUpdates()` or opens GitHub if updater missing.

Signature errors map to a readable string (`ERR_UPDATER_INVALID_SIGNATURE`). There is **no** `quitAndInstall` IPC — install is on quit.

### What the v1.1.67 release actually contains (live assets)

| Asset | Version | Signed? | Updater feed |
|-------|---------|---------|--------------|
| `Tally-Setup-1.1.67.exe` | 1.1.67 | **Unsigned** (no `WIN_CSC_LINK`) | `latest.yml` **1.1.67** |
| `Tally-1.1.66-arm64-mac.zip` / `Tally-1.1.66-mac.zip` | 1.1.66 | Carry-forward (release notes: Studio offline) | `latest-mac.yml` **1.1.66**, `releaseDate: 2026-05-05` |
| `Tally-arm64.dmg` / `Tally-x64.dmg` | 1.1.66 bits, versionless names | Same carry-forward | Listed in `latest-mac.yml` |

Release body is explicit: *Mac clients should remain on 1.1.66 via carried `latest-mac.yml`.* A 1.1.66 Mac **will not** be offered 1.1.67. That is safer than a broken notarized jump; it is **not** “everyone is on 1.1.67.”

`release-readiness-check.js` requires `CSC_LINK`/`CSC_NAME`, Apple notarize env, and `WIN_CSC_LINK`. CI Win job **does not** run that check; it builds unsigned when the secret is empty.

**Andrew must provide:**

1. **Mac Studio** — Developer ID Application: Andrew Disbrow (**HVSJPZDLZF**). Env: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`. Then `npm run build:mac:signed` + `codesign` / `spctl` / `stapler` per build-release skill. Upload real 1.1.67 zips + **new** `latest-mac.yml`.
2. **Windows cert** — GitHub secrets `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD`. Re-run `build-win.yml`. Until then: SmartScreen; if a later signed build is published, **already-installed unsigned clients may fail updater signature checks** and need a one-time manual install.

This PR does **not** invent or request those secrets.

---

## 4. First-run / wizard / autostart / notifications

```
Launch → token? → validate → room picker (every session)
                      ↓ invalid
                   email/password
                      ↓
              setupComplete? → no: onboarding chat wizard
                             → yes: dashboard; start agent if autoStartMonitoring
```

- `validate-token` **clears `roomId`** every launch (and `before-quit` clears it). Volunteer picks a room every time. Intentional after crash/stale-room bugs.
- First launch: `autostart.applyDefaultOnFirstLaunch()` turns **OS login item ON** (macOS/Windows).
- Close window = hide to tray + one-time “still running” notification (`hasSeenTrayNotice`).
- OS notifications: ATEM drop, stream stop, low FPS (60s cooldown), persistent relay failure, agent crash escalation, update available/ready.
- **No** OS notification on generic relay health OFFLINE (banner/toast only).

CLI `church-client` `setup` wizard (`src/setup.js`) is **DEAD** for Electron first-run. Desktop uses renderer onboarding. Setup still probes ProPresenter at `/v1/version`; runtime uses `/version` — CLI detect can miss PP.

---

## 5. Watchdog integrations

Agent `watchdogTick` every **30s** (unless `--no-watchdog`). Dedup 5 minutes per `alertType`. After #153, stream-down / mute send `alertType`; relay also infers from old copy.

| Integration | Health path | On drop | Proven live? |
|-------------|-------------|---------|--------------|
| ATEM | Event + SwitcherManager; `atem_disconnected` | `reconnectATEM` / AtemSwitcher backoff | **UNPROVEN** |
| OBS | WS v5; `obs_disconnected` | `connectOBS` backoff 5s→60s | **UNPROVEN** |
| Encoder | 15s idle / **3s live**; `encoder_disconnected` + `signal_event` | Bridge poll | **UNPROVEN** |
| Mixer | 30s; `mixer_disconnected` + mute `audio_muted` | Poll only | **UNPROVEN** |
| ProPresenter | **1s** rich status + **2s** slide poll (~8 HTTP/s when healthy) | Backoff 5s→60s | **UNPROVEN**; historic reconnect storms |
| Companion | 30s HTTP | Poll only | **UNPROVEN** |
| vMix | 30s | Poll only (no reconnect helper) | **UNPROVEN** |
| HyperDeck / PTZ | 15s / 30s | Poll / refresh | **UNPROVEN** |

`obsHealthCheck.js` is **not** wired into `index.js` (library + tests only).

`recovery.reconnectDevice` (relay AutoRecovery `connection_lost`) called `reconnectAtem` / `reconnectObs` / `reconnectEncoder`. The agent exposes **`reconnectATEM`**, **`connectOBS`**, **`encoderBridge.connect`**. Command was a silent no-op. **Fixed in this PR** (aliases + real names). When SwitcherManager owns ATEM, `reconnectATEM()` now kicks `AtemSwitcher.reconnect()` (cancels pending backoff). Also aliases `connectVMix` / `connectCompanion`.

---

## 6. Failover — why auto-recover is globally off

Relay boot, every start, not a one-time migration:

```755:757:relay-server/server.js
// Disable auto-recover globally — TD should manually switch back after failover
// (auto-recover caused bounce loops when the source was still intermittent)
try { db.exec("UPDATE churches SET failover_auto_recover = 0 WHERE failover_auto_recover = 1"); } catch { /* ok */ }
```

Portal `PUT /api/church/failover` can persist `autoRecover: 1`. **Next Railway restart clears it.**

| Leave off (current) | Turn on |
|---------------------|---------|
| After failover, stay on safe source until TD `/recover_*` or manual switch | 10s stability timer then `_autoRecover` |
| Avoids ping-pong on a flaky encoder/ATEM (the incident that caused the force-off) | Bounce loops if the “recovered” source is still intermittent |
| Matches Telegram “reply /recover_…” copy | Would emit `failover_auto_recovered` / `_failed` |

**Recommendation:** keep the global force-off. Do not flip it in this PR. Re-enable only behind a per-church flag that **survives boot**, plus a longer stability window and a bounce cap, after a connected booth can drill it.

Client still emits `signal_event` (`encoder_disconnected`, `atem_lost`, bitrate loss). Stream protection (auto-restart stream) is a **separate** path and is **on by default**.

Electron failover UI talks to `/api/church/failover*` with the app JWT. State in the dashboard is also parsed from agent stdout `[SignalFailover]`.

---

## 7. Resources / crash / logging

| Item | Behavior |
|------|----------|
| Agent `uncaughtException` | Log, `stop()`, `exit(1)` — supervisor restarts |
| Agent `unhandledRejection` | Log, process continues |
| Electron uncaught | Log, process continues |
| Logs | `~/.church-av/logs/tally-app.log`, 2000-line ring, 10 MB rotate to `.1` |
| Quit | `clearAllLogs()` wipes file + memory |
| Shipper | Redacted warn/error (+ curated info) as `agent_log` on WS |
| Diagnostics | `system.diagnosticBundle` |
| Node runtime | System `node` or `ELECTRON_RUN_AS_NODE` fallback |
| Memory | No hard cap. Steady timers: status 3s, watchdog 30s, PP **1s**. Idle Electron + Chromium is the usual 200–400 MB class |

ProPresenter poll rate is the main resource risk on a weak booth PC / busy LAN. Not changed here (not a small safe P0).

---

## 8. Version skew / protocol

| Pair | Skew | Risk |
|------|------|------|
| Repo Electron 1.1.67 vs bundled church-client 1.1.67 | Aligned in git | A Mac **binary** on 1.1.66 still runs **old** church-client until Studio ships |
| Repo vs live relay 1.1.67 `d23139d` | Aligned | OK |
| Win updater 1.1.67 vs Mac updater 1.1.66 | **Intentional carry-forward** | Mac misses #153 booth-side `alertType` until rebuilt; **relay infers** stream-down/mute for old copy |
| WS protocol | **No version field** | Compatibility is implicit JSON (`status_update`, `isDelta`, `alert`, `command`) |
| OpenAPI `/ws` `{type:register}` | Stale vs `/church?token=` | Integrator trap, not Electron |
| Electron stdout `ProPresenter WebSocket connected` | Agent logs `ProPresenter connected (REST API)` | Tray/PP detection from stdout may miss |
| Electron does not pass `--room-id` | Relies on shared `config.json` after room picker | OK if picker always runs first |

`RELAY_VERSION` is HTTP `/health` only. Device `protocolVersion` in status is **ATEM firmware**, not app↔relay.

---

## 9. P0 – P2

### P0 — Sunday-critical

| # | Item | Status |
|---|------|--------|
| P0-1 | Local-status fallback never emitted `status` IPC — offline dashboard froze | **Fixed in this PR** |
| P0-2 | Tray Start/Stop bound to relay, not `agentProcess` — cannot stop when offline | **Fixed in this PR** |
| P0-3 | `recovery.reconnectDevice` called `reconnectAtem` (agent has `reconnectATEM`) | **Fixed in this PR** |
| P0-4 | **Get one real church connected and keep it connected** | Open — Andrew / dogfood. Nothing else is live-proven |
| P0-5 | Mac 1.1.67 signed + notarized + new `latest-mac.yml` from Studio **HVSJPZDLZF** | Open — Andrew |
| P0-6 | Windows Authenticode (`WIN_CSC_LINK`) so SmartScreen + updater trust | Open — Andrew; do not invent secrets |
| P0-7 | 30d `church_app` token on autostart — expired JWT stops the agent with no silent refresh | Open (not a one-line fix; needs refresh or 365d connection token for WS) |

### P1 — same week, not during service

1. Keep failover auto-recover **off**; if re-enabled, persist across boot + bounce cap (do not just delete the `UPDATE`).
2. SwitcherManager ATEM: `reconnectATEM()` no-ops — wire AutoRecovery into `AtemSwitcher` reconnect. **Fixed in leftover polish PR** — `reconnectATEM()` now calls `SwitcherManager.reconnectByType('atem')`, which cancels pending backoff and retries immediately.
3. ProPresenter ~8 HTTP/s — raise poll interval; historic storm risk.
4. Tray/OS notify on relay health OFFLINE (not only agent stdout). **Fixed in leftover polish PR** (`_notifyOnce` on health probe OFFLINE, 10 min cooldown).
5. Surface `billing_*` WS close in the dashboard (not just generic 1008).
6. Electron Sentry (or at least crash report upload) — dark Sunday crashes are invisible.
7. Pass `--room-id` on spawn (CLI already exists) so config-file races cannot bind the wrong room.
8. Renderer i18n for the dashboard (tray already translated). **Partial in leftover polish PR** — Sunday offline/status strings (banner, toast, connectivity chip, tray offline copy) now use existing `en`/`es` i18n. Rest of dashboard still English.
9. Marketing/download page: stop saying Mac 1.1.67 signed until Studio uploads.
10. `obsHealthCheck` unused; vMix/Companion have no reconnect helpers.

### P2 — later

1. Protocol version on WS `connected` ack (Electron + church-client + relay).
2. Fix CLI setup PP `/v1/version` vs runtime `/version`.
3. Duplicate-instance log uses unset `this.instanceName` (prints `_default`).
4. Window bounds clamp already exists; keep testing multi-monitor upgrades.
5. Registration-code desktop sign-in (or stop mentioning it in booth emails).
6. Localhost fallback UI when relay is down for hours (true offline dashboard).
7. Mac CI (`build-mac.yml`) so Studio is not a single point of failure — still needs the cert on a Mac runner.

---

## 10. Fixed in this PR

Small, high-confidence P0s only. No signing changes. No failover flip.

| Fix | Why |
|-----|-----|
| `pollLocalStatus` emits `status` + `updateTray()` | Offline fallback actually refreshes the dashboard |
| Tray Start/Stop + copy use `!!agentProcess` | TD can stop a running agent when relay is down; no false “Local monitoring active” |
| `recovery.reconnectDevice` resolves `reconnectATEM` / `connectOBS` / `encoderBridge.connect` | AutoRecovery `connection_lost` can actually poke devices |

### Leftover polish (code-only follow-up)

| Fix | Why |
|-----|-----|
| `reconnectATEM()` kicks `AtemSwitcher.reconnect()` via `SwitcherManager.reconnectByType('atem')` | Tray / AutoRecovery reconnect is no longer a silent no-op when SwitcherManager owns ATEM; pending 60s backoff is cancelled |
| `AtemSwitcher` connect-failure clears `_reconnecting` before reschedule | Failed reconnect attempts can queue the next try instead of stalling the loop |
| `recovery.reconnectDevice` aliases `connectVMix` / `connectCompanion` | Same silent-no-op class as the ATEM/OBS naming miss |
| Renderer dashboard + tray offline/status copy use existing i18n | TDs on `es` locale see Sunday banner/toast/connectivity strings in Spanish |
| OS notify on relay health OFFLINE | Probe flip is visible even if agent stdout never printed persistent-failure |

---

## 11. Validation

| Check | Result |
|-------|--------|
| Live `GET https://api.tallyconnect.app/api/health` | `1.1.67` / `d23139d` / **6 registered / 0 connected** / 0 messages |
| Live `GET /api/status` | operational; websocket `connected_churches: 0` |
| `latest.yml` | version **1.1.67**, `Tally-Setup-1.1.67.exe` |
| `latest-mac.yml` | version **1.1.66**, date 2026-05-05 |
| church-client recovery unit tests | **35/35 pass** (includes `reconnectATEM` / `connectOBS` / `encoderBridge.connect`) |
| electron-app unit tests | **322/322 pass** including tray/offline source contracts |
| church-client SwitcherManager ATEM reconnect | Covered in `test/switcher-reconnect.test.js` + recovery aliases |
| electron-app dashboard i18n contracts | Sunday offline/status keys in `en`/`es`; renderer uses `t()` |

**Not verified (and not claimed):** signed Mac Gatekeeper, Windows SmartScreen, a connected booth WS, hardware watchdog, failover drill, or auto-update on a real install.

---

## 12. What Andrew should do next

1. **Connect one dogfood booth** (Cogcomm or LCC) on a known-good token and leave it up through a mid-week practice. Until `connectedChurches ≥ 1`, Monitor / alerts / failover / log shipper stay dark.
2. **Mac Studio:** build/notarize 1.1.67 (team **HVSJPZDLZF**), replace carry-forward 1.1.66 assets, publish a real `latest-mac.yml`. Until then, tell Mac churches they are on **1.1.66**.
3. **Windows cert** into `WIN_CSC_LINK` when ready; expect a one-time manual reinstall if jumping unsigned → signed.
4. **Do not** turn failover auto-recover back on globally.
5. Plan a **token refresh** so autostart survives past 30 days without a human at the sign-in form.
