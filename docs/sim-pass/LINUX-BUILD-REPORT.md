# Tally Linux booth — readiness report (post-fix)

**Date:** Thu Sep 24, 2026 (America/New_York)  
**Branch:** `linux-build` (local only — **not pushed**)  
**Host:** Ubuntu-like box, `DISPLAY=:2`, Crewline soak ports 3000/3100/7880/8000 avoided; CPU via `nice` until ~4:05 PM ET  

## ⚠️ Paces pass (later Sep 24) — supersedes parts of this report

A harder lab pass followed. Full report: [`PACES-REPORT.md`](PACES-REPORT.md).

- **Verdict: PASS (lab scope)** on build `2aa9e65`: source e2e 9/9 ×2, source hard 15/15, AppImage 9/9 + 15/15,
  .deb 9/9 + 15/15. Units: electron 367/367, relay 5320/5320, church-client 2337/2337.
- **Retraction:** the eeef357 results below (runA/B/C 9/9, AppImage 9/9) **do not prove the agent path**. The harness's
  relay-drop check was hollow, and device_connect didn't require the agent↔relay link. With `NODE_PATH` set the agent
  **never spawned**, and the UI could show ATEM/PGM from a stale relay snapshot. Fixed in `213591b`; harness hardened.
- Ten product bugs fixed in total across seven commits (agent spawn, stale-snapshot fake status, --config-path, phantom device pills/cards/sections, inconsistent relay offline surfaces, analytics >100%,
  Linux WM_CLASS mismatch, Stream Protection "OFF" vs "ON"). Commits `213591b`…`2aa9e65`, local only.
- **Current artifacts** are rebuilt from `2aa9e65` (sha256 in `artifacts/SHA256SUMS-2aa9e65.txt`). Artifact hashes and
  extract paths mentioned below refer to the older eeef357 build (`artifacts/prev-eeef357/`).

## Executive summary (after fixes)

| Area | Result |
|------|--------|
| Linux AppImage (rebuilt with fixes) | **PASS** — builds, launches, full e2e green against packaged binary |
| `.deb` | **PASS** — built after installing `xz-utils`; `dpkg -x` + binary launch OK |
| Unit electron-app | **PASS** (prior 348) |
| Unit church-client | **PASS** (prior 2336) |
| Unit relay-server | **PASS** — unsubscribe JWT failure was **env pollution** (`JWT_SECRET` set by harness); test now isolates secrets → 91/91 in `lifecycle-emails.test.js` |
| E2E source ×3 (runA/B/C) | **3/3 all green** (9/9 each) |
| E2E packaged AppImage | **PASS** 9/9 (`appimage2`) — UI shows **Camera 5 / Camera 3** |
| Production touch | **None** (no push, no prod relay, no live ATEM) |

Honest caveats:

- ATEM / disconnect / reconnect are **SIMULATED** (MockLab on `:9910`/`:9911`), not real Blackmagic hardware.
- Packaged e2e launches the **extracted AppImage payload** (`squashfs-root/tally-connect`) so Playwright argv (`--config-path`, `--relay-url`) is reliable; bits are identical to the AppImage. Raw AppImage via FUSE/`APPIMAGE_EXTRACT_AND_RUN` also works for manual launch.
- Local relay login is rate-limited (5 / 15 min). Many consecutive harness runs can trip “Too many sign-in attempts” until the window expires or the relay process is restarted (in-memory limiter).

## Results table — 3 consecutive source harness runs

| Check | runA | runB | runC |
|-------|------|------|------|
| app_launch | PASS | PASS | PASS |
| sign_in_local_relay | PASS | PASS | PASS |
| room_select | PASS | PASS | PASS |
| device_connect_atem_sim | PASS | PASS | PASS |
| tally_program_preview_sim | PASS | PASS | PASS |
| alert_disconnect_reconnect_sim | PASS | PASS | PASS |
| relay_health_local | PASS | PASS | PASS |
| app_restart_persistence | PASS | PASS | PASS |
| relay_drop_reconnect_agent | PASS | PASS | PASS |

Packaged AppImage (`appimage2`): **same 9/9 PASS**, including `tally_program_preview_sim` with UI `pgm="Camera 5" pvw="Camera 3"`.

## Root causes fixed

### 1. PGM/PVW UI showed `--` while status had program 5 — **NOT a PASS**

**Root cause (app):** `updateControlRoom()` read legacy `status.program` / `status.preview`, but the agent/main populate `status.atem.programInput` / `previewInput` (stdout + `/local-status`). Compact strip `#cr-pgm-source` / `#cr-pvw-source` never mapped those fields.

**Secondary lag:** local-status polling only ran when relay `/health` was offline. Agent WS can be down while HTTP health is up → sparse stdout-only updates.

**Fix:**
- Renderer maps `atem.programInput` / `previewInput` via `getInputName()` (handles string or `{longName,shortName}` labels).
- Always start local-status polling when the agent advertises `[LOCAL_STATUS_PORT]`; keep polling even if `/health` is online; poll every 2s.
- E2E asserts **visible** UI matches sim (PGM 5 / PVW 3) within 20s — never status-only; rejects `--`.

**macOS:** Yes — same renderer + main paths. Shipped Mac **1.1.67** has the same field-mapping bug if it shows the compact tally strip.

### 2. Disconnect/reconnect flake

**Root cause (app + test):**
- `stopAgent()` left stale `agentStatus.atem = { connected: true }` when the new agent never printed `ATEM disconnected` (failed connect to dead IP never emits disconnect).
- E2E passed if **either** disconnect **or** reconnect succeeded; reconnect wait (≤15s) was shorter than cold ATEM connect after restart.

**Fix:**
- On start with `atemIp`: initialize `atem: { connected: false, ip }`.
- On stop: force `atem.connected = false`, clear relay, push status.
- E2E requires **both** disconnect and reconnect; reconnect poll up to 50s; 1.5s settle between stop/start.

**macOS:** Yes — same `stopAgent`/`startAgent` status lifecycle.

### 3. Relay unit: unsubscribe JWT “invalid signature”

**Root cause:** **Environment-only**, not a product bug. Harness sets `JWT_SECRET=<redacted lab secret>`. `getUnsubscribeSecret()` prefers `JWT_SECRET` over the `NODE_ENV=test` default `test-jwt-secret`, but the test verified with the hard-coded default.

**Fix:** Test saves/restores `JWT_SECRET` / `UNSUBSCRIBE_SECRET` and clears them for the default-secret assertion. With harness env set: **91/91 PASS**.

### 4. `.deb` fpm `tar -J` failure

**Root cause:** missing **`xz-utils`** on the box (`tar -J` needs `xz`).

**Fix:** `apt-get install xz-utils`, rebuild. Artifact:  
`/workspace/tally-linux/artifacts/tally-connect_1.1.67_amd64.deb`  
Verified: `dpkg-deb -c`, `dpkg -x` → `/tmp/tally-deb-root/opt/Tally/tally-connect`, launched ~12s (updater 404 for missing linux release is expected).

### 5. AppImage rebuild + packaged harness

Rebuilt with all fixes:  
`/workspace/tally-linux/artifacts/Tally-1.1.67.AppImage`  
E2E against extracted payload: **9/9 PASS** (see above).

### 6. `updateTray` TDZ (from earlier) — macOS note

**Code path:** `startAgent()` → `updateTray()`. A later main commit used `t('tray.offlineLocal')` in `statusLine` **before** `const { t } = i18n` → TDZ crash.

**Shipped Mac 1.1.67:** **does NOT have this TDZ**. Tag `v1.1.67` declares `const { t } = i18n` before any `t()` in `updateTray`. The buggy ordering landed in later main (`acadd72` / Sunday tray copy). Our branch keeps `const { t } = i18n` at the top of `updateTray` — required for post-1.1.67 main, cross-platform.

## Screenshots

| Path | Notes |
|------|-------|
| `screenshots/final/06-pgm-pvw-camera5-camera3.png` | Packaged run — real PGM/PVW labels |
| `screenshots/final/06-pgm-pvw-source-runA.png` | Source harness runA |
| `screenshots/final/05-agent-started.png` | Agent connected |
| `screenshots/appimage2/` | Full packaged run set |
| `screenshots/runA|runB|runC/` | Three green source runs |

## Artifact paths

| Artifact | Path |
|----------|------|
| AppImage | `/workspace/tally-linux/artifacts/Tally-1.1.67.AppImage` |
| `.deb` | `/workspace/tally-linux/artifacts/tally-connect_1.1.67_amd64.deb` |
| Unpacked (build) | `/workspace/tally/electron-app/dist/linux-unpacked/` |
| Extracted AppImage (e2e) | `/tmp/tally-appimage-extract/squashfs-root/tally-connect` |
| Deb extract verify | `/tmp/tally-deb-root/opt/Tally/tally-connect` |
| Harness | `/workspace/tally-linux/scripts/e2e-electron.mjs` |
| Results | `/workspace/tally-linux/results/{runA,runB,runC,appimage2}/` |

## Repo commits on `linux-build` (local)

See `git log` on `/workspace/tally` after commit. Key files:

- `electron-app/src/renderer.js` — PGM/PVW mapping + label objects
- `electron-app/src/main.js` — stop/start status clear; always poll local-status; tray TDZ guard
- `electron-app/src/preload.js` — default relay URL
- `electron-app/package.json` / `afterPack.js` / `assets/icon.png` — Linux packaging
- `relay-server/tests/lifecycle-emails.test.js` — deterministic unsubscribe JWT test
- `church-client/package.json` — `jsonwebtoken`

## What still is not claimed

- Real ATEM / real production relay
- Auto-update channel for Linux (no `latest-linux.yml` on GitHub yet)
- macOS / Windows rebuild of this branch (code is cross-platform where noted; not re-tested here)
