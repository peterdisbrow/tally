# Tally — Full-Booth Simulator Pass

Andrew approved at 6:09 PM ET on 2026-09-24 ("do it right"). Lab only: local relay :3400, MockLab ATEM :9910/:9911, mocks on free ports. Branch `linux-build`, local commits only, no push. Crewline ports are untouched.

## Rules applied to every device
1. **Mock must be stateful and able to say no.** Real auth, real error codes, refuses invalid commands, an actual socket drop on "unplug". Canned always-OK answers don't count. Each mock has **mutation modes** (`<DEV>_MOCK_BREAK=…`) that make it sloppy one way at a time, and the tests must go red under each mode.
2. **Integration tests run Tally's REAL agent process** (`church-client/src/index.js`) against the mock through `test/helpers/agentHarness.js`. The harness is a fake relay that rebuilds status exactly like the relay does (delta semantics), with timestamps for every frame.
3. **Booth UI e2e** runs the real Electron app (source + packaged AppImage/deb). Device config goes through the Equipment UI, and everything is read passively from the screen.
4. **Every new test was shown RED at least once**, against old Tally code (6d9da5c) or a mutated mock, before its green counted. Red run IDs are listed per device.
5. **Full suite green before the next device:** source e2e, paces hard, and all unit suites.

Tooling: `scripts/sim/redproof.sh` (green + each mock mutation + old code via git worktree), `scripts/sim/booth-lib.mjs` (paces helpers), `scripts/sim/booth-<device>.mjs`, `scripts/sim/all-units.sh`.

---

## 1. OBS Studio (obs-websocket v5)

### Mock fidelity (`church-client/test/mocks/obsServer.js`, rewritten)
Checked against the obs-websocket 5.x protocol doc (Hello/Identify/Identified, op codes, `RequestStatus`, `WebSocketCloseCode`):
- **Auth:** real challenge/salt, `base64(sha256(base64(sha256(pw+salt))+challenge))`. A wrong or missing password closes with **4009**; rpcVersion > 1 closes with **4010**; requests before Identify close with **4007**.
- **Requests:** real status codes. 204 unknown request type, 300 missing field, 500/501, **600 resource not found** (unknown scene), 506 studio mode off. Unknown requests are no longer fake successes.
- **State:** scenes (returned **bottom-up**, as real OBS does), program/preview scene, stream/record outputs, and GetStats. outputBytes grows while streaming.
- **Events** go to Identified clients only. STARTING→STARTED and STOPPING→STOPPED transitions, CurrentProgramSceneChanged, SceneListChanged, ExitStarted.
- **Unplug:** `crash` terminates sockets with no close frame (process death or cable pull). `quit` sends ExitStarted, then close 1001. `stop()` terminates clients; the old `wss.close()` left them connected.
- **Mutation modes (`OBS_MOCK_BREAK`):** accept-any-password, no-hello, no-events, crash-keeps-socket, always-ok.
- **Where the mock is still more forgiving than real OBS:**
  - No Reidentify (op 3) and no RequestBatch (op 8); Tally uses neither.
  - Event subscription bitmasks aren't filtered: the mock sends all events to every client (Tally subscribes to All).
  - No `outputReconnecting` behaviour on a flaky RTMP link.
  - Stream timecode/bytes are synthetic.
  - Real OBS can take seconds to start answering after launch; the mock answers instantly.

### Integration tests: `church-client/test/sim/obs.test.js` (11, real agent vs mock)
1. Password connect, version, event-driven streaming, `obs.setScene` changes mock state, unknown scene → error, and the connected change pushed < 1s after Identify.
2. Wrong password: never connected (every frame checked) and `obs.error` explains why.
3. Crash: disconnect ≤ 2s; restart on the same port recovers ≤ 12s with the error cleared.
4. Operator quits OBS: disconnect with no stale "streaming".
5. OBS started after Tally: keeps retrying and connects.
6. OBS already live and recording before Tally connects: both reported on connect.
7. Password required but none configured: "needs password" reason, never connected.
8. Scenes list and current scene follow operator changes and Tally changes; cleared on drop.
9. Equipment-UI config (`encoder.type:'obs'`): on drop, obs and encoder are both disconnected ≤ 2s, with no stale LIVE, and both recover.
10. Equipment-UI config with OBS started late: encoder connects and LIVE follows OBS.
11. OBS down 45s, then back: Tally reconnects ≤ 11s.

**Red proof** (`scripts/sim/redproof.sh`, final run `results/sim/obs-20260924-191112/`):

| Run | Result | Red tests |
|---|---|---|
| green (7bd4acb code, faithful mock) | 11/11 | none |
| mock `accept-any-password` | 9/11 | 2, 7 |
| mock `no-hello` | 0/11 | all |
| mock `no-events` | 6/11 | 1, 4, 8, 9, 10 |
| mock `crash-keeps-socket` | 7/11 | 3, 8, 9, 11 |
| mock `always-ok` | 8/11 | 1, 6, 8 |
| **old Tally agent 6d9da5c** | 1/11 | 1, 2, 3, 4, 6, 7, 8, 9, 10, 11 |

Every test is red in at least one run, and every mutation is caught. An earlier 8-test matrix is `results/sim/obs-20260924-182726/`. The backoff test (11) was also red on its own before the fix ("reconnected 30018ms after OBS came back").

### Booth UI e2e: `scripts/sim/booth-obs.mjs` (13 checks, read from the screen)
OBS is configured through the real Equipment UI: Devices → Advanced → Streaming Encoder → OBS Studio → host/port/password → Save → confirm "restart monitoring". The ATEM runs alongside.

**Stated windows:** OBS killed → honest disconnect ≤ 5s; OBS back → recovered ≤ 15s; wrong password → reason on the OBS card (in the viewport) ≤ 12s and never green during a 20s watch.

| Run | Build | Result | disconnect | recover | connect after Save |
|---|---|---|---|---|---|
| sim-obs-src-6 | source | **13/13** | 256 ms | 2791 ms | 4273 ms |
| sim-obs-appimage-7bd4acb | Tally-1.1.67.AppImage (7bd4acb) | **13/13** | 255 ms | 2542 ms | 4312 ms |
| sim-obs-deb-7bd4acb | tally-connect_1.1.67_amd64.deb (7bd4acb) | **13/13** | 255 ms | 2540 ms | 4341 ms |
| **sim-obs-RED-appimage-6d9da5c** | old shipped AppImage | **2/5 then fatal: signed out** | n/a | n/a | n/a |
| sim-obs-src-1…5 | source during fixing | red / harness fixes | n/a | n/a | n/a |

The 13 checks: booth up (ATEM+relay); no phantom OBS UI before config; wrong password keeps Tally signed in; wrong password is honest (reason on the card, never green); connected + LIVE + "OBS 30.0.0" on screen; labelled OBS; control action through the app's command path changes OBS, and a bad scene returns a real error; kill → honest disconnect; stays down with no flap (12s); restart → recovers; no stale LIVE; ATEM still green with no phantom chips; removing OBS in the UI makes its chip, card and section disappear.

Screenshots (Read-verified) are in `screenshots/sim-proof/obs/`: `{appimage,deb}-obs-01…07`, plus `RED-appimage-6d9da5c-wrong-password-signed-out.png`, which shows the shipped build dropping to Sign In, "Session was invalidated by the server", after a wrong OBS password.

### Product bugs found and fixed (commit **7bd4acb**, each with a test red on 6d9da5c)
| # | Severity | Bug | Fix | Proof of red |
|---|---|---|---|---|
| 1 | **Critical** | main.js scanned all agent output for `'Authentication failed'`, `'Unauthorized'`, `'1008'`. A wrong OBS password (or any device 401, or a port containing 1008) killed the agent and signed the operator out. | `agent-auth-detect.js`: only a relay `Relay disconnected (1008: token required / invalid token / church not registered / billing_*)` counts | `results/sim/authdetect-red/old-mainjs.tap`; booth RED run above |
| 2 | High | Tray menu counted device objects by truthiness: disconnected ATEM/OBS/Companion showed "✓ Connected" and "5 devices connected" | `tray-status.js` (connected only when `.connected===true`) | `results/sim/tray-red/` (old logic: 5 connected with all down) |
| 3 | High | Equipment-UI OBS (`encoder.type:'obs'`): `ObsEncoder` snapshotted "connected" once. A dead OBS stayed "connected" forever, a late OBS never connected, and LIVE never lit. | Connected is read live from the shared socket; OBS events drive `status.encoder` when the encoder is OBS | sim tests 9, 10 |
| 4 | High | `status.obs.connected=true` on socket open, before auth | Only `Identified` sets connected | sim test 2 |
| 5 | High | Wrong password: no reason anywhere | `obs.error` (4009/4010) on the OBS card and in the Encoder section | sim 2/7, booth |
| 6 | Med | `sendStatus` 100ms debounce dropped updates (relay up to 3s late) | Trailing coalesced send | sim test 1 (push lag < 1s) |
| 7 | Med | `--relay-status-mode` CLI default overrode config | No CLI default | harness |
| 8 | Med | GetVersion before Identify: version always null | After Identified | sim test 1 |
| 9 | Med | Already-live/recording OBS not reported on connect (rec never) | Read output state on Identified | sim test 6 |
| 10 | Med | Stale LIVE/REC/scene after OBS drop | Cleared on close | sim 4, booth |
| 11 | Med | Booth commands always "OK" (fire-and-forget) | Relay `send-command {wait:true}` returns the real `command_result`; booth uses it | booth `obs_control_action` red in sim-obs-src-4 |
| 12 | Med | OBS reconnect backoff up to 60s after OBS came back | Cap 10s (LAN) | sim test 11 (red: 30018 ms) |
| 13 | Low | Card said "Encoder" for obsUrl-only config; stale `agentStatus.obs` across restart | Label OBS; reset on start | booth |
| 14 | Low | Scenes/currentScene never in status (scene switcher always "No scenes") | GetSceneList + events | sim test 8 |
| 15 | Test infra | church-client `npm test` used `--test-force-exit`, which on Node 20 silently truncated 2–15% of tests per run (counts 2320–2348 with "0 fail"). Heavy parallelism also corrupted the runner protocol. | No force-exit; `--test-concurrency=4` (stable 2337 ×3, 40s); sim tests in `test/sim` via `test:sim` | `results/sim/perfile-{a,b}.tsv`, /tmp logs |

Note: the booth Commands tab is hidden in this build (`display:none !important`), so the scene switcher isn't operator-reachable. The scene state still serves portal/mobile through the relay.

### What only real OBS can prove
- A real OBS 28–31 handshake, with msgpack vs JSON negotiated by the real server.
- Real timing of STARTING→STARTED on a real RTMP connection, and `outputReconnecting` on a flaky uplink.
- Real GetStats numbers under load.
- OBS's own behaviour when the WebSocket server is disabled in settings: port closed → shown as disconnected, same as a crash.
- Scene names with unicode or odd characters.

### Gate: full suite on 7bd4acb (all green before moving to VISCA)
| Suite | Result |
|---|---|
| s1-obs-src-e2e-1 / -2 (source) | 9/9, 9/9 |
| s1-obs-src-hard (source, incl. auto-rejoin checks) | 21/21 |
| s1-obs-appimage-e2e / -hard (7bd4acb AppImage) | 9/9, 21/21 |
| s1-obs-deb-e2e / -hard (7bd4acb deb) | 9/9, 21/21 |
| electron-app unit | 395/395 |
| church-client unit (`test:unit`) + sim (`test:sim`) | 2337/2337 + 11/11 |
| relay-server (vitest) | 5324/5324 |

Logs: `results/s1-obs-suite.log`, `results/units-obs3-*.log`.

**Artifacts (7bd4acb):** `artifacts/Tally-1.1.67.AppImage` sha256 `18dbe4b194d8d7490845b54d5a2226f7a8c9972e2ac1f4d4fe0d24e2ceab9b86`; `artifacts/tally-connect_1.1.67_amd64.deb` sha256 `161c8560c74d61d9bc607731ea3988ea8378b63d4321a823603e59b83dd56c92` (`artifacts/SHA256SUMS-7bd4acb.txt`). The previous 6d9da5c build is in `artifacts/prev-6d9da5c/`. Payload check: both contain `isRelayAuthFailure`, `buildTrayDeviceSummary` and the agent's `_obsOwnsEncoderStatus`.

**CI note:** `.github/workflows/ci.yml` runs `test:coverage` (now fixed too) but not `test:sim`. I haven't changed CI here (local only); adding a `npm run test:sim` step is recommended.

---

## Core vs Beta (running table)
Andrew's direction (8:17 PM ET): Tally has two equal customers, the booth crew (monitor-only screen) and remote engineers (commands go through the relay/portal). A device counts as **CORE** only if it is fully proven: a stateful mock that can say no, the real agent, booth UI honesty, and **relay-sent commands end to end with real results**, including the device refusing and the device being offline.

| Device | Class | Reasons |
|---|---|---|
| ATEM | CORE (pending re-check) | Proven in PACES e2e/hard: ATEM up/down/recovery, auth, rejoin, picker. Relay-sent command E2E is not yet covered by the new relay-loop harness, so it gets re-checked in the full-church run. |
| OBS | CORE (pending relay-command check) | Section 1: stateful mock with 11 mutation modes, all red; booth OBS 13/13 on AppImage and deb. Relay-sent commands through the real relay are still to be added (same harness as audio). |
| Audio: Behringer X32 / Midas M32 + audio/silence monitoring | **CORE** (milestone gate g3A + g3B on 1fca257, both fully green, back to back) | Stateful OSC console mock that says no; 14 sims incl. a real-relay remote-engineer loop, all red on old code + 5 mutation modes; booth e2e 11/11 source, RED on old AppImage; every command confirmed by console read-back. Limits: X32 levels are not used for silence detection (see below); X-Air unsupported and no longer advertised. |
| Audio: Allen & Heath SQ-5/6/7 | **CORE** (milestone gate g4A + g4B on 6fa6c97, both fully green) | Section 3: the driver was rebuilt against the SQ MIDI Protocol Issue 5. Every set is confirmed by an NRPN GET; liveness is a GET round-trip. Stateful MIDI mock that says no; 14 sims incl. the real relay loop, all 14 red on old code + 4 mutation modes; booth e2e 13/13 from source, RED on the old AppImage. Limits: scene recall and SoftKeys can't be confirmed on an SQ (reported as "sent, not confirmed"); names/HPF/EQ/dynamics aren't reachable over SQ MIDI (refused honestly). |
| Audio: Allen & Heath dLive / Avantis | **CORE** (dLive) / **BETA** (Avantis): milestone gate g5A + g5B on 1d78676, both fully green | Section 4. dLive: every set confirmed by Get read-back → core quality. Avantis: its protocol has no mute/level read-back, so remote mutes/faders can only ever be "sent, not confirmed"; liveness is a real round-trip and surface changes are shown. BETA until A&H adds Get, or Andrew accepts sent-not-confirmed as core. |
| Audio: Yamaha CL/QL/TF | **CORE** (milestone gate g5A + g5B on 1d78676, both fully green) | Section 5. Rewritten to real Yamaha RCP (TCP 49280); every set confirmed by get read-back; scene recall confirmed by `sscurrent_ex`; stateful RCP mock that says no; 14 sims incl. the real relay loop, all red on old code + 6 mutations; booth CL5 and TF5 12/12 from source, AppImage and deb. |
| ProPresenter | **CORE** (full suite pp1 green; milestone gate g5A + g5B on 1d78676, both fully green) | Section 6. Rebuilt on the official PP7 API; read-back for everything PP reports; the rest honestly "accepted, not confirmed"; spec-built mock; conformance test; booth 14/14 source, AppImage and deb; booth RED on old AppImage 3/14. |
| Companion | **CORE candidate** (full suite comp1 green on daf7e82; milestone double gate pending) | Section 7. Driver rebuilt on the real Companion 5.0.6 HTTP API (verified on a real instance); honest press/variable results; real module statuses; booth 13/13, RED on old AppImage 2/13. Limit: a press confirms Companion ran the button, not what the downstream device did. |
| Planning Center | **CORE candidate** (booth 11/11; pco1 had a test-runner flake, fixed in bca42d7; milestone gate g6 pending) | Section 8. Every write-back was broken against real PCO (fixed); schedule times depended on the server timezone (fixed); sync failures were silent (now shown in booth + portal). Limits: OAuth round trip and the org's note categories can only be proven on a real PCO org. |
| BirdDog, Teradek, Resolume, Videohub, TriCaster | queued | |
| VISCA PTZ | **BETA / deferred** | Deferred by Andrew (8:21 PM ET). The work is parked on local branch `visca-wip` (3abe23f), not on linux-build: stateful mock; sim 14/14 green, 5× quiet reruns 14/14; old 576823f code 14/14 red (`results/sim/visca-20260924-200615`). The booth e2e was never run, nothing was built, and the relay-loop test is 2/3 green (the HTTP `wait:true` case was red on the unpatched relay). It resumes at the end of the device list. |

---

## 2. Audio: X32/M32 console + audio/silence monitoring (1fca257)
Andrew's direction (8:17 PM ET): audio is core, and remote engineers must get real results. Protocol facts come from the Unofficial X32/M32 OSC Remote Protocol (P-G. Maillot): the console never acks a SET, a GET echoes the current value, unknown addresses are ignored silently, `/info` replies `,ssss server_version server_name console_model console_version`, and scenes are recalled with `/-action/goscene ,i n`.

### Mock (`church-client/test/mocks/x32Server.js`)
Stateful UDP OSC console:
- 32 channels, main, 8 DCAs, 6 mute groups; 1024-step fader quantisation.
- 100 scenes with snapshot + `hasdata`; `/save`; `/-show/prepos/current`; `/xremote` push; `/info` `/status`.
- Silent on unknown addresses, out-of-range values and empty scenes. Unplug / power-off = silence.

Mutation modes (`X32_MOCK_BREAK`): drop-sets, no-reply, info-only, no-scene, stale-mute.

### Bugs found and fixed (each red first)
| # | Gap (old behaviour) | Fix |
|---|---|---|
| 1 | Every X32 command was fire-and-forget UDP: "OK" with the console unplugged or ignoring the set | `_setVerified`: send, then read back. No reply → "X32 is not responding"; wrong value → "did not confirm" |
| 2 | `recallScene` sent `/scene/recall`, which doesn't exist on X32/M32: silent no-op reported as success | `/-action/goscene`; empty scene refused; verified via `/-show/prepos/current` |
| 3 | `/info` parsed wrong: model "4.09", firmware "osc-server" | model = arg[2], firmware = arg[3] |
| 4 | DCA mute/fader and mute groups were `console.warn` stubs returning success (they exist in X32 OSC) | Implemented via `/dca/N/on|fader` and `/config/mute/N`, verified. Soft keys are refused honestly |
| 5 | `saveScene` sent unverified addresses ("save attempted") | `/save ,siss scene idx name ""`, then verified by name |
| 6 | `MixerBridge` had no `model`, so capability gating never ran in the real agent | `get model()`; X32C/Rack/Producer/Core → X32 family, M32C/R → M32; added missing X32 caps (dcaControl, muteGroup, softKey:false) |
| 7 | Mixer poll every 30 s (unplug or master mute noticed up to ~32 s late) | 5 s poll (`TALLY_MIXER_POLL_MS`), guarded against overlap |
| 8 | Muted console dropping off → false "✅ Audio master unmuted" alert | Offline mute state = unknown (null); transitions only between live readings |
| 9 | **Real ATEMs never gave Tally audio levels:** it read `state.audio.master`, which only Tally's own fakeAtem fills; Fairlight meters need `startFairlightMixerSendLevels()` + `levelChanged` | Subscribed on connect (switcher manager + legacy path), with a stale-meter guard (5 s) |
| 10 | The 15 s silence alert reset the silence clock, so the 30 s failover signal came at ~45 s | Clock keeps running; "audio restored" alert on recovery; dedup cleared after recovery |
| 11 | Live with nothing metering audio looked like "monitoring, fine" | `status.audio.coverage = 'none'`; booth shows "Not metered" (muted, not green) |
| 12 | **Booth hero Audio card read `status.audio.muted/.silence/.level`, which the agent never sends, so it was always green "Active"** | `getAudioSummary()`: Console offline / MUTED / Silence Ns / Active (dBFS · source) / Not metered / Console online. Counts as a hero issue; used for Details value too |
| 13 | Devices-list dots were hard-coded green for every device | Live dots (ok/warning/error/unknown); mixer muted = warning |
| 14 | A newly saved device didn't appear in the Devices list until reload | `_doSaveEquipment` re-renders the list + dots |
| 15 | Tray menu didn't list the audio console | "Audio console (X32): ✓ Online / ✗ Offline / ⚠ Master MUTED" |
| 16 | UI advertised "Behringer X32 / X-Air"; X-Air is port 10024 with an `/lr/...` tree the driver doesn't speak | Relabelled in booth, portal and setup CLI |
| 17 | Relay `/api/command` answered a blind `{sent:true}`, so a remote engineer or automation couldn't tell success from a device refusal | Opt-in `{wait:true}`: 200 result / **422 device error** / 504 timeout / 503 offline (never queued for later replay). Cross-runtime results resolve waiters too |
| 18 | CI would silently skip the relay-loop sims if relay deps were missing | CI installs relay-server deps and sets `TALLY_REQUIRE_RELAY_LOOP=1` (missing relay = failure) |

### Remote-engineer loop (new harness `test/helpers/relayLoop.js`)
Spawns the REAL relay-server from this repo on a free port with a temp SQLite DB and random secrets, registers a church, runs the REAL agent, and connects an engineer controller WS. It asserts what the engineer actually receives. Nothing touches production.

### Red proof
- `results/sim/x32-red/`: old 576823f code 14/14 red.
- Mutations: drop-sets → 2,6,8,10,14; no-reply → 1,2,6,8,10,12,13,14; info-only → 2,6,8,10,13,14; no-scene → 6,14; stale-mute → 2,14.
- Old relay (576823f) → test 14 red (`completed` undefined = blind "sent").
- `results/sim/audio-red/`: audio-silence-honesty 7/7 red on old src; audio-booth-honesty 1–8 red on old renderer, 9 (tray), 10 (dots), 11–12 (device list, name), 13 (X-Air label) each red before its fix.
- `results/sim/ci-relayloop-red.txt`: 2 red before the CI edit.
- **Booth RED on old AppImage** `results/sim-audio-RED-appimage-576823f`: with the console unplugged the booth said "All Systems Nominal" / Audio "Active". A remote `mixer.mute` to the unplugged console got **HTTP 200 "Channel 1 muted"**. Empty-scene recall got 200. Master mute was never shown.

### Green
- x32 sims 14/14 ×3 consecutive.
- Booth e2e from source `results/sim-audio-src-2` 11/11: mute visible 3.8 s, unplug → "Console offline" + hero issue + red dot 6.4 s, replug 0.5 s, no flap over 10 s. Remote engineer via lab relay: unmute 200 (applied), scene 4 200 (applied), empty scene 422 "Scene 51 is empty on the X32", soft key 422, console offline 422 "X32 is not responding".
- Units: church 2347/2347, electron 440/440.

### What only real hardware can prove
- Real X32/M32 firmware timing for read-back (the mock answers in <1 ms; the driver allows 3 tries over ~0.3 s).
- `/save` behaviour on older firmware.
- Real Fairlight FDLv cadence and the dB scaling (we assume hundredths of a dB, per atem-connection).
- Classic-audio ATEMs (e.g. TVS HD) have no level API in atem-connection 3.9: those churches get "Not metered" rather than a fake OK.

### Milestone gate on 1fca257: two consecutive green passes (`results/paces-suite-g3A.out`, `results/paces-suite-g3B.out`, zero ✗)
| Suite | g3A (21:02–21:24 ET) | g3B (21:24–21:48 ET) |
|---|---|---|
| source e2e / hard / booth-audio | 9/9, 23/23, 11/11 | 9/9, 23/23, 11/11 |
| AppImage e2e / hard / booth-OBS / booth-audio | 9/9, 23/23, 13/13, 11/11 | 9/9, 23/23, 13/13, 11/11 |
| deb e2e / hard / booth-OBS / booth-audio | 9/9, 23/23, 13/13, 11/11 | 9/9, 23/23, 13/13, 11/11 |
| electron-app unit | 443/443 | 443/443 |
| church-client unit | 2349/2349 | 2349/2349 |
| church-client sim (relay loop required, 0 skipped) | 25/25 | 25/25 |
| relay-server vitest | 5324/5324 | 5324/5324 |

**Not yet done (next):** X32 meters (`/meters`) as a silence source for OBS-only churches; OBS `InputVolumeMeters` as a source; the A&H SQ/dLive/Avantis and Yamaha drivers.


## 3. Audio: Allen & Heath SQ-5/6/7 (6fa6c97)
Protocol source: A&H *SQ MIDI Protocol, Issue 5* (firmware 1.5/1.6). The SQ has exactly one remote protocol: MIDI over TCP on **51325**. **It has no OSC.** The old driver, mock, booth hint, network scan and e2e scenario all assumed "OSC on 51326".

### Mock (`church-client/test/mocks/sqMixerServer.js`, rewritten)
- MIDI-only and stateful. Remote SETs are silent. A GET (`BN 63 MB BN 62 LB BN 60 7F`) answers with the full value message.
- Mute toggles work. Scene recall applies stored scenes, and blank scenes are ignored ("blank scenes cannot be recalled"). SoftKey Note On/Off are recorded.
- It says no:
  - messages on the wrong MIDI channel are ignored
  - parameters outside the SQ tables get no reply
  - `setReachable(false)` keeps a half-open socket that goes silent (a pulled cable behind a switch)
  - `dropClients` and `midiAcceptingClients:false` are available
- Surface changes are transmitted to clients.
- Break modes (`SQ_MOCK_BREAK`): drop-sets, no-reply, stale, no-scene.

### Bugs found and fixed (each red first)
| # | Gap (old behaviour) | Fix |
|---|---|---|
| 1 | Every SQ command was fire-and-forget: "OK" with the console unplugged, ignoring sets, or on the wrong MIDI channel | `_setVerified`: SET, then NRPN GET. No reply → "did not confirm … (check power, network, MIDI channel N)"; wrong value → "did not apply" |
| 2 | "Online" meant the TCP socket was open. A half-open socket (cable pulled) stayed "online" forever, and the booth showed **All Systems Nominal** | Liveness = GET round-trip on LR mute (1.5 s). No second TCP connection to the desk |
| 3 | Mute changes made on the console were stored under `inputChannel:N` but read from `input:N`, so surface mutes never reached Tally | Keys unified |
| 4 | Channel names/HPF/EQ went to "OSC 51326" (nothing listens) and reported success. `saveScene` and `clearSolos` were silent no-ops returning OK | All refuse: "not available on SQ over MIDI — set it at the console". Capability table corrected (hpf/eq/channelName false, softKey partial) |
| 5 | Bad input silently hit the wrong thing: "channel abc" → channel 1; **"mute channel 60" → Group 12 mute** (NRPN 00 3B, confirmed on the old driver); scene 999 → scene 300; scene 0 → scene 1 | Strict validation for channels 1–48, DCA 1–8, mute groups 1–8, scenes 1–300, SoftKeys 8 (SQ-5) or 16 |
| 6 | Unknown mute read as `false` ("unmuted"); unknown fader read as 0 | `null` when unknown or offline |
| 7 | Scene recall and SoftKey claimed "done", but the SQ has no read-back for either | Returns `{confirmed:false}`. The engineer sees "Scene 4 recall sent — not confirmed by the console (…)" |
| 8 | Fader law differed from X32: "fader 0.75" was −24 dB on an SQ but 0 dB on an X32 | Same law on every console: 0.75 = 0 dB (SQ data 15196), 0.5 = −10 dB, 1.0 = +10 dB |
| 9 | Booth had no MIDI channel setting, so any SQ not on MIDI ch 1 was unreachable | "MIDI channel" selector for A&H consoles (config holds 0–15). Wrong channel reads **Console offline**, never online |
| 10 | Stored port 51326 (from the old hint) | Driver, bridge and equipment tester map 51326 → 51325. Hint, setup CLI defaults and e2e config say 51325 |
| 11 | Network scan probed UDP 51326 with an OSC packet, so it could never find an SQ | TCP connect on 51325 |
| 12 | Booth showed "ALLENHEATH Console" / "ALLENHEATH SQ" | "Allen & Heath SQ Console" / "Allen & Heath SQ" |
| 13 | e2e scenario 07 "SQ channel rename" wrote the name into the mock, then passed without checking Tally | Replaced by `07-sq-master-mute.js`: fails unless the relay shows master mute on and off. **Not run here:** that harness targets prod |
| 14 | Test infra: Node 20's runner stdout protocol is corrupted when a driver `console.log` lands between frames ("Unable to deserialize cloned data") | SQ sim routes driver chatter to stderr |

### Red proof (`results/sim/sq-red/`, `results/sim/sq-ui-red/`)
- Old driver: sim tests **1–14 all red**, run per test. Tests 4, 7 and 11 crash the runner on old code, so they were also run directly to show the assertion (`old-driver-direct-4-7-11.txt`).
- Mutations:
  - drop-sets → 1, 8, 11, 14
  - no-reply → 1, 5, 7, 8, 9, 10, 11, 12, 13, 14
  - stale → 1, 7, 8, 11, 13, 14
  - no-scene → 9, 14
- Electron `sq-console-config`: 1–3 and 5 red before the UI change; 4 (scanner) red against the HEAD scanner; equipment-tester legacy-port test red against the HEAD tester.
- **Booth RED on the old AppImage** `results/sim-sq-RED3-appimage-1fca257` (legacy mode, SQ on 51325 and MIDI ch 1):
  - console unplugged → still "Console online" / **All Systems Nominal**
  - remote `mixer.mute` to the unplugged SQ → **HTTP 200 "Channel 1 muted"**
  - remote "mute channel 60" → 200
  - rename → 200
  - device list said "ALLENHEATH Console"
- On the new layout, old build: `sim-sq-RED-appimage-1fca257` has no MIDI channel control at all.

### Green
- sq sims 14/14 ×3 consecutive (plus 2 more runs after the mock key-map tweak).
- Booth e2e from source `results/sim-sq-src-2` 13/13:
  - wrong MIDI channel reads offline, never online over 12 s
  - MIDI ch 3 chosen in the UI → online, config `midiChannel: 2`
  - surface master mute seen in 3.8 s; unplug → "Console offline" + hero issue + red dot in 6.3 s; replug 3.3 s; no flap
  - booth mute applied; channel 60 refused with nothing sent to channel 1
- Remote engineer through the lab relay:
  - unmute 200 (applied)
  - scene 4 → 200 "recall sent — not confirmed" (applied)
  - channel 60 → 422
  - rename → 422
  - unplugged → 422 "SQ not connected"

### What only a real SQ can prove
- GET reply latency on real firmware (the driver allows 1 s per GET, 1.5 s for the liveness probe).
- Read-back quantisation: the A&H forum reports pan read-back differing by about 0xDD. Tolerances are ≈1 dB for levels and 256 steps for pan.
- Whether the desk transmits a Program Change when a scene is recalled from its own screen (Tally would then show the current scene). Not assumed.
- Linear-taper accuracy near −∞ (forum formula, ~118.8 steps/dB).
- NRPN Fader Law must be **Linear Taper** on the desk (Utility › General › MIDI). With Audio Taper, levels are wrong and verification fails loudly rather than lying.

### Milestone gate on 6fa6c97: two consecutive green passes (`results/paces-suite-g4A.out`, `results/paces-suite-g4B.out`, zero ✗)
g4 = g3 plus the SQ booth run (`scripts/sim/booth-sq.mjs`) on source, AppImage and deb.
| Suite | g4A (22:05–22:27 ET) | g4B (23:16–23:38 ET) |
|---|---|---|
| source e2e / hard / booth-audio / booth-SQ | all exit 0 | all exit 0 |
| AppImage e2e / hard / booth-OBS / booth-audio / booth-SQ | all exit 0 | all exit 0 |
| deb e2e / hard / booth-OBS / booth-audio / booth-SQ | all exit 0 | all exit 0 |
| electron-app unit | 449/449 | 449/449 |
| church-client unit | 2352/2352 | 2352/2352 |
| church-client sim (relay loop required, 0 skipped) | 39/39 | 39/39 |
| relay-server vitest | 5324/5324 | 5324/5324 |

A first g4B attempt (started 22:27 ET) was cut off when the box stalled for about 40 minutes (22:37–23:14 ET). It got as far as appimage-audio, all green up to that point. It does **not** count; its log is kept as `results/paces-suite-g4B-STALLED-interrupted.out`. The g4B above is a fresh complete run. A stale `audio-silence-honesty` test process, hung since about 21:14 ET, was found and killed before the rerun.

---

## 4. Audio: Allen & Heath dLive + Avantis (d785dce)
Sources: A&H *dLive MIDI Over TCP/IP Protocol* (firmware V2.0) and *Avantis TCP/IP Protocol* (V1.10, same content as the V2.0 web edition). A&H support confirmed on their forum (June 2025) that **Avantis has no mute/level Get over TCP**; only names and colours can be read.

### Mock (`church-client/test/mocks/ahMidiServer.js`, new, stateful, says no)
- Five MIDI channels from the base N (default 12): inputs, groups, aux, matrix, then N+4 for FX sends/returns, Mains 30+, DCAs 36+ and mute groups (4E+ on dLive, 46+ on Avantis).
- Remote sets are applied silently. Velocity 00 and Note Off are ignored, as the protocol says.
- dLive answers Get Mute (`05 09`) and Get Fader/HPF (`05 0B pp`). Avantis ignores these and answers only name/colour requests.
- Names are max 8 characters. The wrong base channel is ignored. Blank scenes don't recall. The dLive Surface port ignores scene recall.
- Unplug is a half-open silent socket. Break modes: drop-sets, no-reply, stale, no-scene.

### Bugs found and fixed (each red first)
| # | Bug (old driver) | Effect | Fix |
|---|---|---|---|
| 1 | Master mute = Note 0 on N+2 | muted **Mono Aux 1**, not the mains | Main 1 = N+4 note 30 |
| 2 | DCA n = N+4 note n−1 | muted **FX sends** | DCA = 36+n−1 |
| 3 | Unmute = velocity 00 | ignored by the desk; unmute never happened | 3F then 00 (mute = 7F then 00) |
| 4 | Driver read `baseMidiChannel`; bridge passes `midiChannel` | booth MIDI setting ignored, always ch 12 | reads `midiChannel` (0-based); 13–16 refused (base must be 1–12) |
| 5 | Fader `norm × 127` | 0.75 = −5 dB, not unity like X32/SQ | X32 law → A&H LV table (0.75 = 6B = 0 dB) |
| 6 | Pan sent NRPN 0x18 | **0x18 is Channel → Main-mix assign**: pan left removed the channel from the mains | pan refused (not in either protocol) |
| 7 | Name/colour SysEx used the type offset as the channel byte | sent on MIDI ch 1; rename "succeeded" while doing nothing | real channel byte; read back via name/colour Get |
| 8 | Mute groups "not available" | a real feature was missing | notes 4E+/46+ |
| 9 | Online = socket open | unplugged desk read "Console online" | round-trip (dLive Get Mute Main 1; Avantis name request) |
| 10 | Every command reported success | fake OKs to the booth and remote engineers | dLive: set then Get, fails with "did not confirm/apply"; Avantis: live round-trip first, then "sent — not confirmed" |
| 11 | `mainMuted || false`, fader 0 when unknown | unknown shown as unmuted | null |
| 12 | Velocity-00 note-off parsed as "unmuted" | console mute flickered to unmuted in Tally | ignored |
| 13 | HPF on Avantis, EQ/dynamics warn-only | silent no-ops reported as done | HPF on dLive only (read back); the rest throw |
| 14 | No validation (`parseInt`, `Math.max(0,…)`) | "abc" or 200 went to channel 1 | strict 1–128 (dLive) / 1–64 (Avantis), DCA 24/16, scenes 1–500 |
| 15 | Scene recall "recalled" | blank scenes and Surface-port recalls claimed done | "sent, not confirmed"; the dLive Surface port (51328) refuses |

Also fixed, from gaps found in the SQ pass:
- **Portal audio card:** unknown master mute now shows **Unknown**, not "✓ Unmuted"/"✓ OK", in all three branches. The silence tile shows "Not metered" when nothing is monitoring.
- **Booth card:** now says "master mute not reported" when the desk can't report it.
- **Portal port tooltip:** SQ corrected to 51325.
- **Relay engineer knowledge:** A&H is described as TCP MIDI only.
- **Relay command results:** `command_result` now carries the command name, so portal live errors say which command failed.
- **Commands layer:** `{confirmed:false}` now reads "… sent — not confirmed by the console (reason)" for mute, master, fader, DCA and mute groups. Channel strip lists skipped and unconfirmed parts. Caps: dLive has mute groups, HPF and names; no pan. Avantis has no HPF and no pan; its fader, mute, DCA and mute groups are "partial".
- **Booth MIDI selector:** the default names both defaults; channels 13–16 are marked "SQ only".

### Red proof (`results/sim/ah-red/`)
- Old driver: `ah.test.js` 16/16 red (`old-driver-all.tap`).
- Wire test (rewritten): 12 of 13 red on old code. Scene bank/program bytes were already right.
- Command tests: 4/4 red. Electron `ah-console-config`: 2/2 red. Relay `portal-audio-honesty`: 4/4 red, plus the `command_result` name test red.
- Mutations against the new driver: drop-sets turns 1, 2, 3, 6–11, 15, 16 red; no-reply turns 1–3, 6–16 red; stale turns 1–3, 6–8, 11, 15 red; no-scene turns 12 and 15 red.
- **Booth RED on the old AppImage** (6fa6c97), dLive and Avantis (`results/sim-ah-RED-*-appimage-6fa6c97`):
  - main mute at the desk never shown;
  - unplugged desk stays "Console online"/"All Systems Nominal";
  - remote mute to the unplugged desk gives 200 "Channel 1 muted";
  - ch 200 gives 200; pan gives 200; rename gives 200 but nothing was renamed; HPF on Avantis gives 200.

### Green
- `ah.test.js` 16/16.
- Booth from source, `results/sim-ah-dlive-src-1` 13/13 and `results/sim-ah-avantis-src-1` 13/13:
  - the default base channel reads offline; picking MIDI ch 3 brings it online (cfg midiChannel 2);
  - main mute seen in 3.8 s; unplug seen offline in 6.1 s; replug back in 3.3 s;
  - remote: dLive unmute confirmed, scene "not confirmed", ch 200 → 422, pan → 422, rename 200 and applied, HPF 200 and applied;
  - Avantis: mute/unmute "sent — not confirmed", HPF → 422;
  - unplugged → 422 "not connected", nothing applied.

### Full suite once on d785dce (`results/paces-suite-ah1.out`, 23:50–00:01 ET, zero ✗)
- electron 451/451, church unit 2347/2347, church sim 55/55 (0 skipped), relay 5329/5329.
- Source e2e, hard, booth-audio, booth-SQ, booth-dLive and booth-Avantis: all exit 0.
- Church unit is 5 lower than g4: the 19 old Avantis wire tests (which asserted the wrong bytes) were replaced by 13 correct ones; 2 wrong dLive mute-group refusal tests were replaced by 4 correct ones.

### What only a real desk can prove
- Get reply latency.
- Whether a remote scene recall is echoed back.
- LV quantisation (±1 step allowed).
- The HPF formula at the extremes.
- dLive name length on newer firmware (the driver enforces 8).
- TLS ports 51327/51329, which need auth and are not supported.

---

## 5. Audio: Yamaha CL/QL/TF (cfc2744)
Source: Yamaha's RCP (Remote Control Protocol): plain-text lines over TCP 49280 (`set`/`get`/`sscurrent_ex`/`devinfo`/`devstatus`, with `NOTIFY` pushes). The old driver spoke a made-up OSC dialect on 8765/9765 that no Yamaha desk understands.

### Mock (`church-client/test/mocks/yamahaRcpServer.js`, new, stateful, says no)
- Answers the RCP `OK`/`ERROR`/`NOTIFY` grammar with per-model limits (CL5/CL3/CL1/QL5/QL1/TF5/TF3/TF1), a scene library and current scene.
- Surface changes send NOTIFY. Scene numbers that aren't stored refuse. Names are cut to the model's limit.
- Break modes: drop-sets, no-reply, stale, no-scene. It also has unplug (`setReachable`), `dropClients`, `delayNext` (late replies) and an `afterSet` hook.

### Bugs found and fixed (each red first)
| # | Bug (old driver) | Effect | Fix |
|---|---|---|---|
| 1 | Made-up OSC on 8765/9765 | nothing reached a real desk; every command still "succeeded" | real RCP on TCP 49280; legacy ports map to 49280 |
| 2 | No read-back | fake OKs | every set is checked with a `get` read-back (level ±100, ±500 below −40 dB) |
| 3 | Online = socket open | unplugged desk "online" | `devstatus runmode` round-trip; reconnect every 2 s |
| 4 | Scene recall "recalled" | blank scenes claimed done | confirmed by `sscurrent_ex`; CL/QL scenes 1–300, TF `scene_a/b` 0–99 (accepts "B05") |
| 5 | Replies matched by arrival order | a late reply confirmed the wrong command | FIFO queue; a reply only resolves a request if action, address and index match |
| 6 | Surface changes ignored | booth showed stale mutes | NOTIFY updates the cache |
| 7 | Fixed limits | TF DCA 9–16 / mute groups 7–8 "worked" | model auto-detected with `devinfo productname`; CL/QL 16 DCA/8 MG, TF 8 DCA/6 MG |
| 8 | HPF/EQ/dynamics/scene save/solo/SoftKeys/colour/gain/sends/meters "done" | silent no-ops | refused with a clear error |
| 9 | Pan rounding asymmetric | −31 instead of −32 at full left | symmetric rounding (±0.5 → ±32) |
| 10 | Unknown → 0 / unmuted | unknown shown as a value | null |

Other fixes in this pass:
- **Electron:** the network scanner and equipment tester use a real RCP probe (`devinfo productname` on TCP 49280) instead of the fake OSC packet. The device hint reads "Yamaha CL/QL/TF=49280 (RCP)".
- **Relay:** engineer knowledge, tally-engineer, the AI setup assistant and the portal tooltip now say Yamaha is RCP on 49280, list the correct `mixer.type` values, and say **Behringer Wing has no driver** (it was described as supported).
- **Setup:** default port 49280. Commands caps: CL/QL/TF full for fader, name, master, pan, DCA and mute groups.

### Red proof (`results/sim/yamaha-red/`)
- Old driver: `yamaha.test.js` 13/13 red (`old-driver-all.tap`). The NOTIFY test and late-reply test were also red on their own.
- Mutations against the new driver (each red): M1 no read-back → tests 4, 11; M2 `mainMuted || false` → 5; M3 scene recall without read-back → 8; M4 socket-open = online → 5, 6; M5 no reply matching and M5b no index matching → 12; M6 RCP ERROR ignored → 8.
- Unit tests on old code: 17 red. Relay knowledge: 6 red. Electron console-config: 3 red.
- **Booth RED on the old 6fa6c97 AppImage** (`results/sim-yamaha-RED-cl5-appimage-6fa6c97.log`): 5/12 passed. It claimed "Channel 3 muted" and "Scene 4 recalled" while the console was offline.

### Green
- `yamaha.test.js` 14/14, three times in a row. Booth from source: `sim-yamaha-cl5-src-2` 12/12 and `sim-yamaha-tf5-src-1` 12/12. The first source run failed only on pan −31 vs −32, which was fixed (bug 9).
- **Full suite once on cfc2744** (`results/paces-suite-yam1.out`, 00:15–00:34 ET, zero ✗): electron 454, church unit 2296, church sim 69 (0 skipped), relay 5337. All source booths exit 0, including yamaha-cl5 and yamaha-tf5. Church unit is lower than before because 59 wire tests that asserted the fictional OSC protocol were replaced.

### What only a real desk can prove
- RCP reply latency and NOTIFY rate under load.
- Exact fader dB table rounding at the extremes.
- Whether older CL firmware answers `sscurrent_ex` (the driver refuses to claim a recall it can't confirm).
- RIVAGE/DM7 are not covered (different address maps).

---

## 6. ProPresenter (1d78676)
Source: the official ProPresenter 7 OpenAPI spec (`https://openapi.propresenter.com/swagger.json`). A method+path snapshot is committed as `church-client/test/fixtures/propresenter-openapi-paths.txt`, and a unit test fails if the driver ever sends a request that isn't in it.

### Mock (`church-client/test/mocks/propresenterServer.js`, rewritten from the spec, stateful, says no)
- Libraries, playlists, presentations with groups, the focused and active presentation, the slide on screen, looks, timers (lowercase states such as `running`/`overrunning`, as PP sends them), messages, props, macros, groups, stage screens and layouts, audience/stage booleans, layers, transport, capture, video inputs, and audio/media playlists.
- Unknown ids and cues past the end get 404. Next on the last slide does not move.
- Modes: ok / offline (connections dropped) / hang / not-pp (a 404 web server). Runtime break modes: ignore-triggers (204 but nothing changes) and http-500.

### Bugs found and fixed (each red first)
| # | Bug (old driver / app) | Effect | Fix |
|---|---|---|---|
| 1 | `_fire` results ignored | every command "succeeded", even with PP down (booth RED: remote `next` with PP quit → 200 "Next slide") | `_req` throws on HTTP error ("refused … (HTTP n / not found in ProPresenter)") or no connection ("not reachable") |
| 2 | No read-back | "Jumped to slide 99" on a 12-slide show; ignored triggers reported done | slides, looks, timers, props, messages, stage layouts, screens, video input, transport play/pause, capture, presentation/playlist/library triggers confirmed by reading PP's state back (1.5 s) |
| 3 | Wrong or fictional endpoints: `/v1/looks/current`, `PUT /v1/timers/{id}`, `/v1/timers/{id}/increment`, `POST /v1/libraries/…`, `GET` message trigger, stage toggle, group path, audio/media playlist, transport/timeline/capture, clear announcements | commands 404'd on a real PP (and were reported done) | spec paths only, enforced by the conformance test |
| 4 | `isRunning` = any HTTP answer | a router/NAS web page on 1025 counted as ProPresenter | GET `/version` must answer like PP (`api_version`/`host_description`) |
| 5 | Timer state compared to "Running" | PP sends lowercase: running timers never showed as running | states normalised |
| 6 | Audience status from `/v1/status/screens` | screens always unknown/wrong | boolean `/v1/status/audience_screens` + `stage_screens` |
| 7 | Status fell back to stale slide data when PP stopped answering | booth kept showing the last slide while PP was down | poll disconnects after 2 misses; `toStatus` returns nulls while disconnected; `index.js` now copies the blank status when disconnected (it used to leave the old slide in place) |
| 8 | Backup mirror fire-and-forget; `agent.proPresenterBackup` dead code | a backup PP that didn't follow was never reported | mirror awaited; "⚠️ Backup ProPresenter did not follow: …" appended to the result |
| 9 | Group trigger accepted if anything was on screen | "Group triggered" when nothing changed | confirmed only when the cue on screen belongs to that group; a group not in the focused presentation gives PP's 404 → refused |
| 10 | Commands without read-back said "done" (macros, announcement next/prev, audio/media playlists, timer reset/increment/update, transport skip/end, timeline) | overclaiming | results say "accepted by ProPresenter (not confirmed: ProPresenter does not report this back)" |
| 11 | Booth PP card read `status.ppPresentation`/`ppSlide` (never sent) | card always said just "Connected" | card shows the presentation and "Slide N of M", or "Nothing on screen", or "ProPresenter not reachable" |
| 12 | Hero ignored ProPresenter | "All Systems Nominal" with PP down | a configured PP that isn't answering counts as an issue |
| 13 | Details section: audience `null` → "OFF"; offline kept the last slide/look | unknown shown as a value; stale show data | "Unknown"; offline shows "Not reachable" and blanks the rest |
| 14 | Network scan and Test button: `/v1/version` (not in spec), any HTTP answer = found | a 404 web server read "ProPresenter running" (booth RED) | GET `/version` fingerprint; Test says "Something answered … but it is not ProPresenter" |
| 15 | Mock Lab's PP served a made-up API | the real driver could not connect to Mock Lab | Mock Lab PP speaks the real API subset |
| 16 | Portal card: `'Slide ' + sIdx` with a 0-based index; hidden when offline; timers never "running" | off by one for remote engineers; PP down just vanished | 1-based; "ProPresenter not reachable"; Running/Overrun shown, overrun in red |
| 17 | Relay knowledge: "REST API + WebSocket", "Remote must be enabled with a password" | the AI engineer gave wrong setup advice | official /v1 REST API, polled, Network enabled, no password; confirmed vs accepted commands listed; full command list |

### Red proof (`results/sim/pp-red/`)
- Old driver: new unit suite 11/11 red (`old-driver-unit.tap`). The conformance test lists the fictional endpoints. Sim 11/11 red (`old-driver-sim.tap` 9/9 driver tests; `old-agent-remote.tap` for the agent and relay loops with the old agent).
- New driver with the old `index.js`: the agent status test is red (`new-driver-old-index-agent.tap`).
- Mutations against the new driver: M1 HTTP errors ignored → unit 3, 4, 6 + sim 2, 4, 7; M2 read-back always ok → unit 5, 7 + sim 2, 3; M3 any answer = running → unit 2 + sim 1, 8; M4 group check off → unit 7; M5 `toStatus` stale → unit 8; M6 mirror not awaited → unit 11 + sim 9. The M0 control copy was green.
- Electron probe test 2/2 red on old code. The old tester reported `{"success":true,"details":"ProPresenter running"}` for a 404 web server. Mock Lab test red on the old handler. Relay knowledge 3/3 red. Portal card 5/5 red.
- **Booth RED on the old 6fa6c97 AppImage** (`results/sim-pp-RED-appimage-6fa6c97.log`): 3/14. The Test button said "ProPresenter running" for a non-PP server. The card never showed the slide. Remote go-to-slide 99 → 200. `next` with PP quit → 200 "Next slide". The hero stayed "All Systems Nominal" with PP down.

### Green
- Unit `propresenter-api.test.js` 11/11; sim `propresenter.test.js` 11/11 (incl. the agent and real-relay loops); church unit 2246 (61 fictional tests replaced by 11 spec tests).
- Booth from source `results/sim-pp-src-1.log` 14/14:
  - the Test button tells a non-PP server apart;
  - the card follows an operator slide change in 0.8 s and shows "Nothing on screen" on clear;
  - remote next gives "now slide 4 of "Worship Set""; slide 99 → 422 refused; unknown look → 422; look confirmed and visible in the booth; macro "accepted … not confirmed"; ignored trigger → 422 "did not change"; HTTP 500 → 422 refused;
  - PP quit seen in 2.3 s with "1 Issue Detected"; remote next → 422 "not reachable", nothing changed; no flap; back in 6.9 s.
- The booth screen's own command path refuses PP commands ("Unknown command"): the booth is monitor-only by design (relay allowlist). That is recorded, not changed.

### What only a real ProPresenter can prove
- Response times on a busy show machine.
- Whether older PP7 builds (before 7.9) have every endpoint used (they 404 → refused, honestly).
- Chunked `/v1/status/updates` streaming is not used (Tally polls every 2 s).

### Milestone gate on 1d78676: two consecutive green passes (`results/paces-suite-g5A.out` 02:58–03:37 ET, `results/paces-suite-g5B.out` 03:37–04:16 ET, zero ✗)
Freshly rebuilt packages (`artifacts/SHA256SUMS-1d78676.txt`: AppImage 371d42f9…, deb d55739b3…). Each pass (`scripts/paces-suite-g5.sh`): 9 source booths (e2e, hard, audio, SQ, dLive, Avantis, Yamaha CL5, Yamaha TF5, ProPresenter), the same 9 + OBS on the AppImage (hard in kill mode) and on the deb (hard in stop mode), then electron 457, church unit 2246, church sim 80 (relay loop required), relay 5345. Both passes: `SUITE_DONE`, all 33 steps exit=0, zero fail lines. Result: dLive, Yamaha CL/QL/TF and ProPresenter are CORE; Avantis stays BETA (protocol limit).

---

## 7. Bitfocus Companion (daf7e82)
Source: a REAL Companion 5.0.6 run on this box (my own throwaway instance on :18000, config `/tmp/tally-companion-lab`, stopped afterwards; the Crewline Companion instances on 8000/8001 were never touched). Findings: `wip/companion/REAL-COMPANION-5.0.6-FINDINGS.md`, driver check against the real instance: `wip/companion/real-5.0.6-driver-check.txt`. A captured HTTP API fixture is committed as `church-client/test/fixtures/companion-5.0.6-http-api.json`.

### What real Companion 5.0.6 does (and the old driver got wrong)
- The HTTP API default port is **8000** (8888 was Companion 2.x). The old driver, setup wizard, network scanner and UI all defaulted to 8888.
- `POST /api/location/P/R/C/press` on an empty slot answers **204** (no button), not an error. The old driver reported "pressed".
- Button labels are the `b_text_P_R_C` variables (`/api/variable/internal/b_text_P_R_C/value`). `style?text=` does not change a layered button's text in 5.x.
- `GET /api/connections` (5.x) returns `[{id,label,moduleId,enabled,status:{category:'good'|'warning'|'error'|null, level, message}|null}]`. The old driver did `String(status)` → "[object Object]", so module errors never showed. 4.x has no such route (404).
- Custom variables must exist before `?value=` sets them (otherwise 404). With the HTTP API switched off, every request gets **403**.

### Fixes (commit daf7e82)
| # | Severity | Bug | Fix | Red proof |
|---|---|---|---|---|
| 1 | **Critical** | The booth's Companion **Test** button always said "Enter a URL" (the form has host/port fields, the tester read a `url` field) | Tester builds the URL from host/port; real fingerprint probe | booth RED on 1d78676 AppImage |
| 2 | High | Empty-slot press (204) reported "pressed" | 204 → "No button at page P row R column C" (refused) | unit, sim, booth |
| 3 | High | Companion down → card blank / hero "All Systems Nominal"; status flapped (30 s timer vs events) | Event-driven status (3 s polling, `connected`/`disconnected`/`connectionsChanged`/`stateChanged`), card "Disconnected", hero issue, red dot, no flap | booth RED; stateChanged fix shown red first |
| 4 | High | Module (connection) errors invisible | Real statuses ok/warning/error/disabled with detail on the card, section list, preflight, Telegram | unit, booth |
| 5 | High | Any web server on the port counted as Companion | Fingerprint (`internal:time_hms`), "not Companion" / "HTTP API switched off" named | unit, booth Test button |
| 6 | High | `pressNamed` fuzzy-matched and could press the wrong button | Exact/unique label match over pages 1–10 (index refresh on miss); ambiguous → refused with the candidates | unit, sim, booth |
| 7 | Med | Set custom variable reported OK when the variable didn't exist | Read-back; missing variable refused with "create it in Companion first" | unit, booth |
| 8 | Med | 8888 defaults everywhere | 8000 default; 8888 still probed for 2.x | booth `ui_default_port_8000` |
| 9 | Med | `_request` could hang forever | Hard timer, always settles | unit |
| 10 | Med | Stale module list shown while Companion is down | List only when connected | booth `companion_quit_honest` (red in `sim-comp-src-1.log`: secList "atem" while down) |
| 11 | Low | Duplicate companion commands in `system.js`; Dante "pressed" implied the Dante change happened | One implementation; Dante says "pressed, not confirmed" | relay/unit |
| 12 | Low | Fictional tests (`companion-buttons`, `companion-additional`) tested the invented API | Removed; replaced by tests against the real-API fixture | n/a |

### Tests (all shown red on old code first)
- `church-client/test/companion-api.test.js` 12: old driver 10/12 red (`results/sim/comp-red/unit-old-driver.tap`); conformance test red against the OLD mock (`mock-conformance-old-mock.tap`).
- `church-client/test/sim/companion.test.js` 3 (agent, not-companion, real-relay remote): old agent 3/3 red (`sim-old-agent.tap`).
- `electron-app/test/companion-booth.test.js` 7: old 7/7 red (`electron-old.tap`). `relay-server/tests/companion-knowledge.test.js` 7: old 7/7 red (`relay-old.txt`).
- Booth `scripts/sim/booth-companion.mjs` 13 checks: **RED on the old 1d78676 AppImage 2/13** (`results/sim-comp-RED-appimage-1d78676.log`); from source **13/13** (`results/sim-comp-src-3.log`; runs 1–2 were a booth-script regex bug and the stale-list fix #10).
- Remote engineer via the lab relay (`wait:true`): press → "pressed" with the label; empty slot refused; ambiguous name refused, nothing pressed; exact name pressed; custom variable set (confirmed); missing variable refused; getVariable value; HTTP API off → refused; Companion offline → refused, nothing pressed.

### What only real Companion can prove
- Live module error statuses (no modules were installed on the throwaway instance, so `/api/connections` returned `[]`; the item shape comes from the 5.0.6 source).
- Performance of the b_text index on a large install (10 pages × 32 buttons = 320 variable reads on a miss).
- Companion 3.x/4.x: 4.x has no status API → "Modules not reported by this Companion version" (mock mode `v4`), not verified on a real 4.x.

### Full suite
- **comp1 (source, daf7e82) GREEN, 04:24–04:39 ET**: `SUITE_DONE_comp1`, 14/14 steps exit=0, zero fail lines (`results/paces-suite-comp1.out`). Units: electron exit=0 # pass 464 # fail 0; church-unit exit=0 # pass 2197 # fail 0; church-sim exit=0 # pass 83 # fail 0 # skipped 0; relay exit=0  Test Files  165 passed (165)       Tests  5352 passed (5352). Booths: e2e, hard, audio 11/11, SQ 13/13, dLive 13/13, Avantis 13/13, CL5 12/12, TF5 12/12, PP 14/14, Companion 13/13.

## 8. Planning Center (10653db)
Planning Center is a relay-side cloud integration (`relay-server/src/planningCenter.js`); the booth only shows its status and offers Connect/Disconnect. Sources: the official PCO Services API docs (`api.planningcenteronline.com/docs/apps/services/versions/2018-11-01`, vertices `plan_note`, `plan_note_category`, `plan_person`, `plan`, `plan_time`) plus Planning Center's own answers in `planningcenter/developers` #961 (PlanNote needs a category relationship) and #1198 (`sort_date` is org-local time with a fake "Z"). **The real PCO API was never called**: the relay now has a `PCO_API_ORIGIN` override (unset in production), the lab relay points it at the mock, the unit tests reject any off-box request, and the booth refuses to run unless both the env and the relay build use the override.

### Mock (`church-client/test/mocks/planningCenterServer.js`, rewritten to the real API)
Nested Services v2 routes only (the old mock served `/services/v2/plans/:id/items`, which doesn't exist); Basic (PAT) / Bearer (OAuth) auth, otherwise 401; JSON:API error bodies; `sort_date` as org wall time + fake Z, `starts_at` real UTC; PlanNote POST 422 "must exist" without a valid `plan_note_category`; PlanPerson PATCH only at `/people/:id/plan_people/:id`; pagination with `links.next`; 429 + Retry-After. Modes: ok / down (503) / hang; revoke; read-only user (403); delete plan; org timezone.

### Bugs found and fixed (each shown red first)
| # | Severity | Bug | Fix | Red proof |
|---|---|---|---|---|
| 1 | **Critical** | **Every write-back failed on real PCO.** Notes were POSTed with `category_name` (read-only) and no `plan_note_category`, so real PCO answers 422. The session-end production notes (`writeServiceNotes`, the only write-back actually wired) never landed. | `_postPlanNote` looks up the service type's "Production" note category and sends the relationship; no such category → refused with instructions, nothing written | unit (`pco-red/1-override-only.txt`) |
| 2 | **High** | Schedule times depended on the relay server's timezone: `sort_date` is wall time with a fake Z, parsed as UTC then read with local getters. On this ET box a 9:00 service became **5:00**. (Railway is probably UTC, which hides it.) | Read the wall clock from the string (`pcoWallTime`) everywhere (sync, upcoming, AI context) | unit (TZ=LA: 2:00/4:00), **booth RED** (5:00/7:00) |
| 3 | **High** | "Next service" dropped the plan hours BEFORE it started for churches west of UTC (Postgres/production path compared wall time with UTC now; ET: gone 2 h before start, PT: 5 h) | Compare with the church's wall clock (`wallClockZ(church.timezone)`) | unit, query-client path red |
| 4 | **High** | Token revoked / PCO down → sync "succeeded" with 0 services; the booth and portal kept a green "Connected" forever | Sync fails loudly when every service type fails; `lastSyncError` in status; booth shows "sync failing: <reason>" in amber; portal badge "Sync failing" + reason | unit, portal test, **booth RED** (4/10 on old logic) |
| 5 | High | "Disconnect" left a Personal-Access-Token connection in place (UI still "Connected", syncing continued) | Disconnect clears PAT + OAuth, stops sync, clears the error | unit red, booth `booth_disconnect_really_disconnects` |
| 6 | Med | Telegram "upcoming services" only worked for PAT churches ("credentials not configured" for OAuth-connected ones) | Uses whichever auth the church has | unit red |
| 7 | Med | 429 was a hard failure | Wait out `Retry-After` (≤ 20 s) and retry once | unit red |
| 8 | Med | Volunteer attendance (not wired anywhere yet): wrong route (PATCH under `plans/:id/team_members`, not a real route), wrong type, and **substring matching** ("Al" would mark "Alice Cooper" Confirmed) | Real PlanPerson route, exact full-name match, failures reported | unit red |
| 9 | Low | Error messages: "auth failure (401): {raw}" | Plain reasons: "rejected the credentials (401) — reconnect", "no permission (403)", "timed out", JSON:API detail extracted | tests updated |

### Tests
- `relay-server/tests/planning-center-api.test.js` 17 against the real-API mock (never off-box). Red: old code 12/12 red (all blocked off-box calls, `0-old-code.txt`); with only the lab override added 9/12 red (`1-override-only.txt`); upcoming-for-OAuth, next-service (query-client path) and Disconnect each red on the old function (`2-…`, `3-…`, `5-…`).
- `relay-server/tests/portal-pco-card.test.js` 3: old portal 1/3 red (`4-portal-old.txt`).
- Existing PC tests (writeback, sync, query-client) encoded the invented behaviour (category_name, `TeamMember` PATCH route, substring names, UTC sort_date, silent sync failure) and were corrected to the documented API.
- Booth `scripts/sim/booth-pco.mjs` 11 checks (Electron + lab relay + mock): **RED 4/10 on old logic** (`results/sim-pco-RED-oldlogic.log`, relay with only the override seam); from source **11/11** (`results/sim-pco-src-3.log`).
- Relay API commands end to end: connect (PAT) + service types; sync; next-service; revoked → refused with the reason; PCO down → refused; recovery; booth Disconnect.

### What only real Planning Center can prove
- OAuth round trip (needs Tally's PCO OAuth app credentials and a real org); token refresh against real PCO.
- That the org actually has a "Production" plan note category (most won't by default; see decisions).
- Real rate-limit behaviour on large orgs (full plan sync = 4 requests per plan).

### Full suite
- **pco1 (source, 10653db): NOT GREEN.** All 10 booths passed (PC 11/11) and relay 5372/5372, electron 464/464, church-sim 83/83, but church-unit had **1 failure**: `integration-mocks.test.js` died with `Unable to deserialize cloned data due to invalid or unsupported version` (a node:test runner error, not an assertion). Treated as a flake → fixed, not rerun-until-green:
  - Cause: node:test multiplexes each test child's stdout with its v8-serialized result frames; product code logging emoji banners ("✅ Video Hub connected") to stdout can corrupt the framing under concurrency (nodejs/node#56802, #64061). 1 in 16 church-unit runs in this lab.
  - Red: a noisy fixture (8 files printing emoji, concurrency 4) fails **5/5** without a guard, **0/5** with it (`results/sim/stdout-guard/`). New `stdout-guard.test.js` (church-client + electron-app) is red without the guard.
  - Fix (commit bca42d7): `test/_stdout-guard.cjs`, loaded with `node --require` by the test scripts in both packages, sends console.log/info/debug to stderr (separate pipe; nothing hidden). Church unit 2198/2198 ×2, sim 83/83, electron 465/465 afterwards.
  - The milestone gate g6 (A+B) runs on bca42d7 and serves as the fresh full suite for Planning Center.

## Pre-VISCA fixes (576823f): gaps Andrew asked to fix, not list
| # | Gap | Fix | Red proof | Green |
|---|---|---|---|---|
| 1 | Hero headline said "All Systems Nominal" with the relay offline | Pure `getHeroState()`: offline → "Monitoring Locally" (calm muted icon), connecting → "Connecting to Relay…", stopped → "Monitoring Stopped". Green only when the relay is online with no issues. | Unit `hero-headline-honesty` 9/9 red on 7bd4acb (`results/sim/hero-red/`). E2E `results/hero-RED-appimage-7bd4acb` (headline "All Systems Nominal" seen with the relay down). | e2e `hero_honest_relay_down` ✓ on source/AppImage/deb |
| 2 | Room picker could wipe equipment config when one fetch failed | `fetchRoomEquipment()` returns ok/fail. `decideRoomEquipment()` picks apply/keep/clear; a failed fetch never wipes. Assign refused → not started; network failure → local mode, room saved consistently; the warning is shown in the booth. | Unit `room-switch-equipment-guard` 11 red on old code + 4 by mutation; `room-equipment-fetch` red (`results/sim/roomswitch-red/`). E2E `results/picker-RED2-appimage-7bd4acb` (atemIp wiped, roomId lost, ATEM never up). | e2e `picker_relay_down_keeps_equipment` ✓ on source/AppImage/deb |
| 3 | CI didn't run the sim tests | Root + church `test:sim`; ci.yml church-client step "Run church-client device sim tests" (job timeout 10→20 min). Committed only, not pushed. | `ci-sim-wiring` 2/3 red before the edit, 3/3 red on 6d9da5c (`results/sim/ci-wiring-red*.txt`) | 3/3 |

**Build 576823f:** `artifacts/Tally-1.1.67.AppImage` sha256 `44fbfaf462fc6991a977c0af38d670277eb3da28b19b154be6e0c4afc9badac9`, deb `503e3965f69fb17c7b7f1c30ffabe9ff18ead89a5c8f72056b9274930b508a97` (`artifacts/SHA256SUMS-576823f.txt`).

**Gate on 576823f** (`results/paces-suite-g2.out`, SUITE_DONE, zero ✗):
| Suite | Result |
|---|---|
| g2-src-e2e-1 / -2 | 9/9, 9/9 |
| g2-src-hard | 23/23 (21 + 2 new) |
| g2-appimage-e2e / -hard | 9/9, 23/23 |
| g2-deb-e2e / -hard | 9/9, 23/23 |
| g2-booth-obs-appimage / -deb | 13/13, 13/13 (disconnect ~257ms, recover ~2.5s) |
| electron-app unit | 430/430 |
| church-client unit + sim | 2340/2340 + 11/11 |
| relay-server vitest | 5324/5324 (quiet rerun `results/g2-576823f-relay-rerun.log`; the first run under load lost 7 files to vitest worker-start timeouts, with no relay code change) |

---

## VISCA PTZ: DEFERRED (BETA), parked on `visca-wip`; read-ahead kept for when it resumes
Read-ahead findings to verify red-first:
1. **TCP "connected" means only that the port opened.** There's no VISCA inquiry, so any listener counts as a camera.
2. **UDP/Sony VISCA-over-IP are "connected" if the local `send()` succeeds,** which means always, even with no camera present.
3. **VISCA replies are ignored,** so camera errors (`90 6y 02 FF` syntax, `41` not executable, e.g. powered off) are reported as success.
4. **PTZ status refreshes every 30s.**
5. **The booth UI has no PTZ live status at all:** the Devices list dot never gets a state, and there's no dashboard chip or card.
6. **The mock acks unknown commands, has no inquiries or power state, and "unreachable" doesn't drop existing sockets.**
