# Tally: handoff (branch `linux-build`, 25 Sep 2026)

This is for whoever picks up the work next and can only see this GitHub repo. It sums up the
Linux lab pass. The full detail is in `docs/sim-pass/` (reports, evidence and the lab harness that
used to live outside the repo).

---

## 1. What Tally is

Tally (Tally Connect) watches the production gear in a church or venue booth (video switcher,
streaming encoder, audio console, presentation software, Companion, PTZ cameras) and tells people
the truth about it: in the booth, and to a remote engineer anywhere.

It has four parts:

- **Booth app** (`electron-app/`): Electron desktop app plus the device agent (`church-client/`)
  that talks to the gear.
- **Portal**: the web portal served by the relay. Churches and remote engineers use it.
- **Relay** (`relay-server/`): the cloud server (production runs on Railway). Booth agents connect
  to it; the portal, mobile app and Companion module talk to it.
- **AI engineer**: the relay's assistant, which knows the devices and can run commands through
  the relay.

**It has two customers, and they count equally:**
1. **Churches**, meaning the volunteer booth crew.
2. **Remote engineers and AV companies** looking after many churches from somewhere else.

Product rules that must not be broken:
- **The booth screen only monitors.** One obvious path, zero footguns. The **Commands tab stays
  hidden** (`display:none !important`), and the booth's own command path refuses device commands by
  design.
- **Remote commands live in the portal**, going through the relay (`/api/command`, `{wait:true}`
  gives the real device result: 200 applied, 422 the device refused, 504 timeout, 503 church offline,
  and nothing is ever queued for later).
- Honesty over green: when something is unknown, say so ("Unknown", "Not metered", "sent — not
  confirmed"). Never show a fake OK.

## 2. Repo layout

| Path | What |
|---|---|
| `electron-app/` | booth desktop app (main.js, renderer.js, preload, MockLab manager, Linux/Mac/Win packaging) |
| `church-client/` | device agent (`src/index.js`), drivers (`src/*`, `src/commands/*`), tests (`test/*.test.js` unit, `test/sim/*.test.js` device sims, `test/mocks/*` stateful device mocks, `test/helpers/agentHarness.js` + `relayLoop.js`) |
| `relay-server/` | relay + portal + AI engineer (`server.js`, `src/`, vitest `tests/`) |
| `shared/` | code shared between packages |
| `tally-connect-mobile/` | mobile app |
| `companion-module-tallyconnect/` | Bitfocus Companion module for Tally |
| `tally-encoder/`, `problem-finder-lab/` | side projects (not touched in this pass) |
| `scripts/e2e/` | older e2e runner. **Warning: it defaults to PRODUCTION** (`RELAY_URL` defaults to `https://api.tallyconnect.app`). See the open decisions |
| `docs/sim-pass/` | **this pass**: `SIM-PASS-REPORT.md` (per device), `PACES-REPORT.md` (booth hard pass), `LINUX-BUILD-REPORT.md`, `evidence/`, `research/`, `harness/` (lab scripts and how to run them) |
| `.github/workflows/ci.yml` | CI (runs church-client `test:sim` too) |

## 3. How to run things

Everything runs locally. **Never point tests at production** (api.tallyconnect.app, Railway, Neon,
the real Planning Center API). Don't send email or Slack. Don't deploy.

**Unit and sim suites**
```bash
cd church-client && npm ci
npm run test:unit                              # ~2200 unit tests
TALLY_REQUIRE_RELAY_LOOP=1 npm run test:sim    # device sims vs stateful mocks, incl. REAL relay loop (needs relay-server deps)
# or from repo root: npm run test:sim
cd ../electron-app && npm ci && npm test       # ~465
cd ../relay-server && npm ci && npx vitest run # ~5370 (needs JWT_SECRET etc. in env; any random lab values)
```
`test:sim` spawns the real relay from this repo on a free port with a temporary SQLite DB, registers a
church, runs the real agent against a mock device, and checks what the engineer actually gets back.
The ATEM sims bind 127.0.x.y:9910, so don't run MockLab at the same time (or accept the fallback).

**Booth lab (real Electron UI against mocks)**: see `docs/sim-pass/harness/README.md`. In short: local relay on
:3400 (SQLite), MockLab (simulated ATEM) on UDP :9910 + control :9911, an X display, then
`scripts/sim/booth-<device>.mjs`, `scripts/e2e-electron.mjs`, `scripts/paces-e2e.mjs`.
- **Milestone gate** = `scripts/paces-suite-g6.sh A` followed by `... B`: every booth on source +
  AppImage + deb, then all unit suites and the sims. A gate only counts if both passes are fully green,
  back to back.
- **Red proof**: `scripts/sim/redproof.sh <device> <test-file> <BREAK_ENV> <old-commit> <modes...>` runs
  green, then each mock mutation mode, then old Tally code (git worktree), and writes a summary.tsv.

**Linux packages**
```bash
cd electron-app && NODE_ENV=development npm install --include=dev
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:linux:appimage   # dist/Tally-1.1.67.AppImage
CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:linux:deb        # needs xz-utils
```
For e2e, run the extracted payload (`--appimage-extract` → `squashfs-root/tally-connect`;
`dpkg-deb -x` → `opt/Tally/tally-connect`) with `--relay-url=ws://127.0.0.1:3400 --config-path=... --no-sandbox`.
Don't publish, release or tag anything.

## 4. Core vs Beta (as of 25 Sep 2026)

CORE means fully proven: a stateful mock that can refuse, the real agent, an honest booth UI, and
**relay-sent commands end to end with real results**, including when the device refuses and when it is
offline. All of it was shown red first.

| Device | Status | Notes |
|---|---|---|
| Behringer X32 / Midas M32 + audio/silence monitoring | **CORE** | gate g3A+g3B. X-Air not supported (no longer advertised) |
| Allen & Heath SQ-5/6/7 | **CORE** | gate g4A+g4B. MIDI/TCP 51325 only. Scene recall + SoftKeys = "sent, not confirmed" |
| Allen & Heath dLive | **CORE** | gate g5A+g5B. Every set confirmed by Get read-back |
| Yamaha CL/QL/TF | **CORE** | gate g5A+g5B. Real RCP on TCP 49280 |
| ProPresenter 7 | **CORE** | gate g5A+g5B. Official PP7 API, conformance test |
| Bitfocus Companion 5.x | **CORE candidate**: needs the milestone double gate | g6A and g6B on bca42d7 were both fully green (logs in `docs/sim-pass/evidence/`), but the code has changed since (ATEM/OBS commit), and Andrew has not promoted it. Confirm in the next double gate |
| Planning Center | **CORE candidate**: needs the milestone double gate | same as Companion. OAuth and real org note categories can only be proven on a real PCO org |
| Blackmagic ATEM | **pending relay-command e2e** | booth monitoring proven (PACES). Relay-command sims written, green, red on old code, but **WIP** (see next steps) |
| OBS Studio | **pending relay-command e2e** | booth 13/13 on AppImage + deb. Relay-command sims green, but **WIP** (see next steps) |
| Allen & Heath Avantis | **BETA** | its protocol has no mute/level read-back, so remote mutes/faders can only be "sent, not confirmed" |
| VISCA PTZ | **BETA / deferred** | parked on branch `visca-wip` (3abe23f, based on 576823f): sim 14/14, red on old code; booth e2e never run, relay-loop test 2/3 |
| BirdDog, Teradek, Resolume, Videohub, TriCaster | not started | BirdDog read-ahead: `docs/sim-pass/research/birddog-readahead.md` |

## 5. Next steps (in this order)

Run the full suite after each item. At milestones and before any push, you need two consecutive fully
green passes.

1. **Finish the ATEM/OBS relay-command checks** (commit `WIP (not proven): ATEM/OBS relay-command checks`).
   - Current state: `church-client/test/sim/atem.test.js` 7/7 and `test/sim/obs-relay.test.js` 6/6 are
     green. On old code (bca42d7), ATEM tests 1–4 and OBS tests 2, 4, 5 were red. ATEM 5, 6, 7 were red
     under mutations or before their fix. Evidence is in `docs/sim-pass/evidence/atem-obs-relay-2026-09-25/`.
   - **Blocking: `npm run test:unit` is red (4 failures)** in `church-client/test/obs-commands.test.js`
     (startStream/stopStream/startRecording/stopRecording). The OBS commands now wait for OBS's
     STARTED/STOPPED output events, and that test's fake OBS always answers OK and has no `.on/.off`.
     Make the fake stateful (emit `StreamStateChanged`/`RecordStateChanged`, able to fail: STARTING →
     STOPPED). Don't loosen the product code.
   - Still to do: show OBS sim tests 1, 3 and 6 red on old code (the redproof matrix was interrupted;
     run `redproof.sh obs-relay test/sim/obs-relay.test.js OBS_MOCK_BREAK bca42d7 accept-any-password
     no-hello no-events crash-keeps-socket always-ok`) and the ATEM equivalent with its mock break modes.
   - Then: booth e2e for ATEM + OBS remote commands through the relay, and the full suite.
2. **Milestone double gate for Companion + Planning Center** (g7 = g6 + ATEM/OBS relay checks), two
   consecutive fully green passes, then promote both to CORE.
3. **Full-church run**: every CORE device at once in one booth, plus **crash-all / unplug-all recovery**
   (every mock killed and unplugged together, relay down, app kill -9). The booth has to stay honest and
   everything has to recover without anyone touching it.
4. **Milestone double gate + rebuild** of the AppImage and deb from the gated commit (record sha256s).
5. **Mac 1.1.67 rebuild + smoke** carrying the Linux fixes. They're in cross-platform main.js/renderer.js/
   agent code. The shipped Mac build (1.1.66 in the lab carry folder) very likely still has the
   stale-snapshot fake status, phantom device pills/cards, inconsistent relay-offline surfaces, the wrong
   OBS password signing the booth out, and the fake-OK device commands. This needs a macOS host. No release.

## 6. Open decisions for Andrew

- **Avantis**: accept "sent, not confirmed" as CORE, or keep it BETA until A&H adds a Get?
- **A&H Linear Taper**: the SQ's NRPN fader law must be set to Linear Taper on the desk (Utility ›
  General › MIDI). With Audio Taper, levels are wrong and verification fails loudly. Should that be a
  documented setup requirement (and a booth hint)?
- **SQ scene recall and SoftKeys can't be confirmed** (the SQ has no read-back for them). Is "sent, not
  confirmed" acceptable?
- **Scenario 07 (`scripts/e2e/scenarios/07-sq-master-mute.js`)**: the `scripts/e2e` harness targets
  PRODUCTION by default. It must not. It needs a local-only default or a hard refusal to run against
  prod. It was never run in this pass.
- Also noted: after a crash or kill -9 the booth needs a room re-pick (intentional, commit 30f33d5). This
  is a Sunday-recovery UX call.

## 7. Parked (don't work on these)

- **White-label reseller portal** (`relay-server/src/reseller.js`, `resellerPortal.js`): parked until
  Tally itself is proven.
- **Rundown extraction**: later.
- **Blog** stays affiliate-free.
- **No GTM / sales / marketing work.**

## 8. Rules (they apply to every change)

- **Mocks must be stateful and able to refuse**: real auth, real error codes, invalid commands refused,
  an actual socket drop on "unplug". Each mock has mutation modes (`<DEV>_MOCK_BREAK=...`) and the tests
  must go red under them. A canned always-OK fake doesn't count.
- **A test only counts if it was shown red first** (against old Tally code or a mutated mock). Record
  the red run.
- **No stubs, no greenwash**: no `console.warn` + return success, no loosening assertions, no
  rerun-until-green. Flakes get root-caused (see bca42d7).
- **Run the full suite after each item**, and get **two consecutive green passes** at milestones and before any push.
- Git: work on `linux-build`. Never force-push, never touch `main`, no releases or tags, no deploys.
- Never touch production or the other project's ports on the shared lab box (3000, 3100, 4100, 4180,
  7880, 8000, 8001). Lab ports are 3400 (relay) and 9910/9911 (MockLab).

## 9. Commit trail on linux-build (newest first)

- `WIP (not proven): ATEM/OBS relay-command checks …`: this handoff's first commit (see step 1)
- `bca42d7` test runner stdout guard (fixes the "Unable to deserialize cloned data" flake)
- `10653db` Planning Center real API · `daf7e82` Companion 5.x real HTTP API
- `1d78676` ProPresenter · `cfc2744` Yamaha RCP · `d785dce` A&H dLive/Avantis · `6fa6c97` A&H SQ ·
  `1fca257` X32/M32 + audio · `576823f` hero/room-picker/CI · `7bd4acb` OBS · earlier PACES fixes
  `213591b`…`2aa9e65`
