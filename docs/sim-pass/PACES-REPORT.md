# Tally booth (Linux) — "paces" hard lab pass

**Date:** Thu Sep 24, 2026 (ET) · **Branch:** `linux-build` (local only — **not pushed**, no PR)
**Scope:** Lab only — ATEM is **SIMULATED** (MockLab UDP :9910 / control :9911), relay is **local** (:3400, SQLite).
No prod relay, no live Railway, no real ATEM. Crewline ports :3000/:3100/:7880/:8000 untouched.

## Verdict

**PASS (lab scope)** — on final build `2aa9e65`: source e2e 9/9 ×2, source hard 15/15, AppImage e2e 9/9 + hard 15/15,
.deb e2e 9/9 + hard 15/15 (run set `v3-*`), units electron-app 367/367, relay-server 5320/5320, church-client 2337/2337.

This took **ten product bugs fixed across seven commits** to get there. The first attempts at this pass were red, and part of the prior
pass's green was hollow (see "Retractions"). Nothing below is a harness-only pass: every UI claim is asserted on the
visible DOM and screenshotted.

## Results table (final verification suites)

`v3` = final build `2aa9e65` (release candidate). `v2` = `45d86e5` (before Stream Protection fix). `v` = `cd646e6`.

| Check | v3 src #1 | v3 src #2 | v3 AppImage | v3 .deb | v2 (src×2/AppImage/deb) | v (src×2/AppImage/deb) |
|---|---|---|---|---|---|---|
| **9-check e2e** (`e2e-electron.mjs`) | **9/9** | **9/9** | **9/9** | **9/9** | 9/9 ×4 | 9/9 ×4 |

| Hard check (`paces-e2e.mjs`) | v3 src (SIGSTOP relay) | v3 AppImage (kill relay) | v3 .deb (SIGSTOP relay) | v2 src/AppImage/deb | v src/AppImage/deb |
|---|---|---|---|---|---|
| **Total** | **15/15** | **15/15** | **15/15** | 15/15 ×3 | 15/15 ×3 (weaker ui_clean) |
| cold_start_launch | PASS | PASS | PASS | PASS | PASS |
| sign_in_room | PASS | PASS | PASS | PASS | PASS |
| atem_sim_connect | PASS | PASS | PASS | PASS | PASS |
| pgm_pvw_visible (UI "Camera 5 / Camera 3", never `--`) | PASS | PASS | PASS | PASS | PASS |
| ui_clean_atem_only_booth (no phantom chips/cards/sections, no "Issue", no banner) | PASS | PASS | PASS | PASS* | PASS* |
| no_false_relay_offline_on_agent_restart | PASS | PASS | PASS | PASS | PASS |
| dead_ip_then_recover (dead IP → honest disconnect → back to sim, PGM/PVW) | PASS | PASS | PASS | PASS | PASS |
| rapid_atem_disconnect_reconnect_x5 (5/5 disc+rec each) | PASS | PASS | PASS | PASS | PASS |
| relay_down_ui_consistent (banner/pill/hero/network agree) | PASS | PASS | PASS | PASS | PASS |
| relay_down_offline_banner (40s outage) | PASS | PASS | PASS | PASS | PASS |
| relay_down_local_mode_honesty (ATEM stays live locally) | PASS | PASS | PASS | PASS | PASS |
| config_persist_kill9 (kill -9 app, config + equipment survive) | PASS | PASS | PASS | PASS | PASS |
| restart_after_kill9_reconnect | PASS | PASS | PASS | PASS | PASS |
| two_sequential_sessions (no lock/port collisions) | PASS | PASS | PASS | PASS | PASS |
| relay_health_end | PASS | PASS | PASS | PASS | PASS |

\* `ui_clean` was tightened twice during the pass (sections, then Stream Protection). The same check **fails on older
builds**: `results/before-encsection-appimage-cd646e6` (cd646e6 AppImage: 14/15, Encoder section visible) and
`results/paces-before-uifix-appimage213591b` (phantom pills/cards, false banner).

**Measured (v2/v3):** offline banner appears **26–33 s** after the relay dies (designed health-probe window) and is still
up at 40 s. ATEM stays connected locally for the whole outage. Relay link back **<1 s** after the relay returns.
After an app kill -9 and relaunch: ATEM 8 ms–1.1 s, relay 0.5–1.1 s. Agent→ATEM connect ~1 s (it was 25 s+ before fix #1).

**Units (final code):** electron-app **367/367** (348 baseline + 19 new honesty tests) · relay-server **5320/5320**
(with harness `JWT_SECRET`) · church-client **2337/2337** (×2 clean). Logs: `results/v3-units/`.

v3 dashboard audit (ATEM-only booth): the only visible sections are ATEM Switcher, Device Identity (collapsed), and Rundown ("No active rundown" prompt). No phantom device sections.

## Root causes fixed this pass (all on `linux-build`, tests red on old code)

| Commit | Bug (user-visible) | Root cause | Fix |
|---|---|---|---|
| `213591b` | Agent **never started** on boxes with `NODE_PATH` set; UI still showed ATEM "connected" + PGM 5/PVW 3 | `resolveNodeBinary` treated `NODE_PATH` (a module dir) as the node binary → EACCES. Relay SSE merged stale `status_snapshot` (`connected:false` mirror) and status while no agent was running → **faked** ATEM/PGM | Drop NODE_PATH, `isExecutableFile` check; ignore stale/agentless snapshots |
| `213591b` | Booth config edits ignored by agent | Agent ignored `--config-path`, read `~/.church-av/config.json` | `startAgent` passes `--config CONFIG_PATH` |
| `f717c5b` | Phantom Encoder/Companion/ProPresenter/Resolume pills + "1 Issue Detected" on ATEM-only booth | `_mergeLocalStatus` overwrote `null` (unconfigured) devices. Regression from eeef357's always-on local polling | Preserve null |
| `f717c5b` | Hung relay showed **"Connected"** under a "Relay unreachable" banner; agent restart with healthy relay showed a **false** "Relay unreachable" | Each surface derived relay state differently | Single `getRelayUiState()` (online/connecting/offline/no-internet, 20 s grace) drives banner, pill, hero, network card, footer. New i18n `status.relayConnecting` (en/es) |
| `f4512e3` | ATEM analytics could show **>100 %** on-air share (flaky unit ~1 in 3) | `percentOfTotal` divided by the wall-clock window | Share of on-air time. The reconnect test budget was raised 10→18 s (backoff is 5 s ±20 %; test-only) |
| `cd646e6` | Red "Encoder Disconnected" card on booths with no encoder | `agentStatus.obs` defaulted to `false` without an obsUrl | `obs = null` when unconfigured (start + exit) |
| `e85a501` | Empty "Streaming Encoder" section (Stream Health/FPS "—") on ATEM-only booth | Section never hidden | Shared `isEncoderUnconfigured()` drives card + section |
| `45d86e5` | Linux docks/taskbars couldn't link the window to its launcher | Measured WM_CLASS `tally-connect` but .desktop had `StartupWMClass=Tally`; `desktopName` unset | `desktopName` + `syncDesktopName` + `StartupWMClass=tally-connect` (verified via `xprop`) |
| `2aa9e65` | Stream Protection badge **"OFF"** next to **"Protection: ON"**; section shown with no encoder | `idle` state was badged "OFF" even when enabled | enabled+idle → "ARMED"; section hidden when no encoder/OBS |

Harness hardening (in `/workspace/tally-linux/scripts/`, not product): device_connect now requires relay=true **and**
relay `connectedChurches>=1`. relay_drop_reconnect_agent now really checks cleared→back. ui_clean checks
chips+cards+sections. Relay secrets are stripped from the app env. `cleanup-tally.sh` is ancestor/shell-safe.
`restart-relay.sh` clears the in-memory login rate limiter (5/15 min).

## Retractions (no greenwash)

- **Prior pass (eeef357) 9/9 ×3 + AppImage 9/9:** that harness's `relay_drop_reconnect_agent` was hollow, and
  `device_connect` didn't require the agent↔relay link. With the NODE_PATH bug present, those runs **do not prove the
  agent path**. Superseded by the runs above.
- **Early runs of this pass `pacesD2` / `pacesE` "9/9":** hollow. The agent wasn't running, relay=false, and PGM/PVW came
  from the stale relay snapshot. Discarded; this is what led to fix `213591b`.
- The `f717c5b`/`v` hard 15/15 runs predate the section/Stream-Protection checks. They're kept for history, not as final proof.

## Honest remaining gaps (cannot be closed in this lab)

1. **Live Blackmagic ATEM** — untested. MockLab only (ATEM protocol sim, Mini Extreme ISO model).
2. **Live/prod relay** — untested by rule. Local relay only.
3. **Mac rebuild** — not done (no macOS host). The fixes are in cross-platform `main.js`/`renderer.js`. **Shipped Mac
   1.1.67 very likely has** the stale-snapshot fake status, the phantom pills/cards/Encoder section, the inconsistent
   relay surfaces and the Stream Protection badge contradiction. A Mac build + smoke from this branch is needed before any release.
4. **Linux auto-update** — no `latest-linux.yml` is published. Updater 404 at launch (expected, harmless).
5. **Design note for Andrew:** after a crash/kill -9 the booth **requires a room re-pick** (intentional, commit 30f33d5
   clears roomId each launch). Config and equipment restore fine after the pick. That's a Sunday-recovery UX call, not a bug.
6. `.deb` is verified via `dpkg-deb -x` + launch of `/opt/Tally/tally-connect` (full e2e + hard), not `dpkg -i` system install.
   The AppImage runs its extracted payload (identical `app.asar`, `cmp`-verified).

## Paths

- **Commits (local `linux-build`):** `eeef357` → `213591b` → `f717c5b` → `f4512e3` → `cd646e6` → `e85a501` → `45d86e5` → **`2aa9e65`** (HEAD)
- **Artifacts (built from 2aa9e65):** `/workspace/tally-linux/artifacts/Tally-1.1.67.AppImage`,
  `/workspace/tally-linux/artifacts/tally-connect_1.1.67_amd64.deb`, checksums `artifacts/SHA256SUMS-2aa9e65.txt`
  - AppImage sha256 `0110bb852eab9465212a3b274fead91c58e84e9db6efb25e12e90d8c6714dac1`
  - .deb sha256 `6f2fd6e35f37dd8e1a3c42485ccf4ad0affa8424ed4eeba00298319fcce5dbf9`
  - Older builds: `artifacts/prev-*/`
- **Proof screenshots:** `/workspace/tally-linux/screenshots/paces-proof/` (from v3 AppImage + .deb hard runs):
  `*-04-pgm-pvw.png` (PGM Camera 5 / PVW Camera 3, All Systems Nominal, no phantom cards),
  `*-05-dead-atem-ip.png` (honest ATEM disconnected, relay Connected, no false banner),
  `*-09-offline-banner.png` / `*-09b-offline-banner-40s.png` (Offline Mode + "Relay unreachable — running in local mode", ATEM still live),
  `*-10-relay-restored.png`, `*-11b-after-kill9-monitoring.png`
- **Full screenshot sets:** `screenshots/v3-{src,appimage,deb}-hard/`, `screenshots/v3-*-e2e*/`
- **Results/logs:** `results/v3-suite.log`, `results/v3-*/e2e-results.json` + `e2e.log`; earlier `results/v2-*`, `results/v-*`;
  before-fix proofs `results/before-encsection-appimage-cd646e6`, `results/paces-before-uifix-appimage213591b`;
  build logs `logs/build-paces5.log`, `logs/build-paces6.log`
- **Harness:** `scripts/e2e-electron.mjs`, `scripts/paces-e2e.mjs`, `scripts/paces-suite-v3.sh`, `scripts/restart-relay.sh`, `scripts/cleanup-tally.sh`

## Auto-rejoin last room (commit 6d9da5c, decided by Andrew 6:02 PM ET, 2026-09-24)

**Policy and why:** after a crash, kill -9, power loss or a clean quit/OS-update restart, Tally rejoins the last room with no clicks. Booth PCs restart unattended (Windows/Ubuntu updates, power blips), so a volunteer should never walk in to a room picker. Leaving is always deliberate: **Change Room** (= Leave) or **Sign out** clear the record. The old 30f33d5 "wrong room" risk is avoided because the rejoin record is bound to the church ID and the relay re-validates access (assign-room) before the room is trusted. A deleted room, no access (403) or an expired token (401) drops to the picker or sign-in with a clear message, never a relaunch loop.

**Mechanics:** a main-process-only `rejoinRoom` record `{roomId, roomName, churchId, savedAt, cleanExit}` (not writable from the renderer). New pure module `electron-app/src/room-rejoin.js`. If the relay is unreachable at launch, Tally rejoins locally, shows the "relay offline" banner and starts the ATEM agent. It then re-validates every 10s and either confirms or falls back to the picker.

**Tests:** `electron-app/test/auto-rejoin.test.js` has 18 tests. The 8 main/renderer integration tests (a VM running the real main.js block) are red on 2aa9e65 and green on 6d9da5c. electron-app total: 385/385.

**E2E (v4 suite, started 18:16 ET, `results/v4-suite.log`), all green:**

| Run | Target | Result |
|---|---|---|
| v4-src-e2e-1 / -2 | source | 9/9, 9/9 |
| v4-src-hard | source | 21/21 |
| v4-appimage-e2e / -hard | Tally-1.1.67.AppImage (6d9da5c) | 9/9, 21/21 |
| v4-deb-e2e / -hard | tally-connect_1.1.67_amd64.deb (6d9da5c) | 9/9, 21/21 |

The 7 new hard checks are: kill9_auto_rejoin_same_room, clean_quit_auto_rejoin, relay_down_relaunch_local_rejoin, leave_room_relaunch_shows_picker, signout_relaunch_shows_picker, deleted_room_relaunch_picker_message, plus restart_after_kill9_reconnect (no manual Start).

**Measured time from relaunch (ms; the room, ATEM, relay and PGM/PVW are all read passively from the screen):**

| Case | Build | Dashboard | ATEM | Relay | PGM/PVW on screen | Room confirmed after relay back |
|---|---|---|---|---|---|---|
| kill -9 | AppImage / deb / src | 2727 / 2833 / 2825 | 2736 / 2844 / 2834 | 2741 / 2851 / 2840 | 2786 / 2902 / 2882 | n/a |
| clean quit | AppImage / deb / src | 2722 / 2708 / 2718 | 2729 / 2717 / 2729 | 2734 / 2722 / 2736 | 2775 / 2761 / 2789 | n/a |
| relay down at launch | AppImage / deb / src | 2665 / 2723 / 2729 | 2672 / 2728 / 2735 | not claimed | 2717 / 2769 / 2802 | 3055 / 3054 / 2039 |

**Screenshots** (`screenshots/paces-proof/rejoin-{appimage,deb}-*.png`, Read-verified): 11 (kill -9: banner "Reconnected to Sanctuary Linux … closed unexpectedly", Cam 5/Cam 3), 11c (clean quit), 11d (relay offline: local banner, ATEM live, relay shown as "Connecting…"), 11e (confirmed), 11f (Leave → picker), 11g (sign out → picker), 13 (deleted room → picker message).

**Artifacts (6d9da5c):** AppImage `2b880a8faa2c80bea6a35260df38c2834924cb7170f62b035e6d2f9b97318746`, deb `7a1cd282eaf41509ccc6a524f737b97f60396fafd99bd9ba3cf509b9cbbfa5df` (`artifacts/SHA256SUMS-6d9da5c.txt`).

**Gaps:**
- **FIXED in 576823f.** The picker path (`fullRoomSwitch`/`switch-room`) wiped equipment when the fetch returned null, and null also meant a transient failure. It now uses `fetchRoomEquipment()` (discriminated) plus `decideRoomEquipment()`: a failed or partial fetch never overwrites the room's equipment, the previous room's devices never leak in, and a warning is shown. Proof: unit tests red on 7bd4acb; e2e `picker_relay_down_keeps_equipment` RED on the 7bd4acb AppImage (`results/picker-RED2-appimage-7bd4acb`: atemIp wiped, roomId lost, ATEM never up) and green on 576823f. Details in SIM-PASS-REPORT.md, "Pre-VISCA fixes".
- With the relay unreachable at launch, the room is only confirmed once the relay returns. Until then the banner says "relay offline" and nothing is claimed.
- **FIXED in 576823f.** The headline read "All Systems Nominal" while the relay was offline. It now says "Monitoring Locally" (calm info icon) when offline, "Connecting to Relay…" while connecting and "Monitoring Stopped" when stopped. Nominal is claimed only when the relay is online and there are no issues. Proof: e2e `hero_honest_relay_down` RED on the 7bd4acb AppImage and green on 576823f.
