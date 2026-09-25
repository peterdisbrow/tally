# Tally Linux booth testing harness

Local-only Linux packaging + e2e for the Tally Connect Electron booth app.
**Does not talk to production** (no Railway, no prod DB, no emails/Slack, no GitHub push).

## What this is

| Piece | Location |
|-------|----------|
| Repo checkout | `/workspace/tally` on branch `linux-build` |
| Harness / results | `/workspace/tally-linux` |
| Local relay | `ws://127.0.0.1:3400` (SQLite under `data/`) |
| Simulated ATEM | MockLab UDP `127.0.0.1:9910` + control HTTP `:9911` |

## Prerequisites

- Ubuntu-like Linux with X display (this box uses `DISPLAY=:2`, 1280×800)
- Node 20+, `ffmpeg` (screenshots), optional `Xvfb`
- Free ports: **3400**, **9910**, **9911** (do not use 3000/3100/7880/8000 — Crewline soak)

## Quick start

```bash
# 1) Local relay (SQLite, no Stripe)
export NODE_ENV=development
set -a; source /workspace/tally-linux/data/relay.env; set +a
nice -n 5 node /workspace/tally/relay-server/server.js \
  >/workspace/tally-linux/logs/relay.log 2>&1 &

# 2) MockLab ATEM/OBS/mixer sim (SIMULATED gear)
nice -n 5 node /workspace/tally-linux/sims/start-mocklab.js \
  >/workspace/tally-linux/logs/mocklab.log 2>&1 &

# 3) Full harness (unit + e2e). Pass run id: run1 | run2
bash /workspace/tally-linux/scripts/run-harness.sh run1
```

Or e2e only:

```bash
DISPLAY=:2 TALLY_RUN_ID=run1 node /workspace/tally-linux/scripts/e2e-electron.mjs
```

## Build Linux packages (from repo)

```bash
cd /workspace/tally/electron-app
# Debian npm 9 chokes on file: overrides for extract-zip — already worked around on this branch
NODE_ENV=development npm install --include=dev
# Unpacked dir + AppImage (deb currently fails fpm/tar on this box — see REPORT)
CSC_IDENTITY_AUTO_DISCOVERY=false nice -n 10 npm run build:linux:dir
CSC_IDENTITY_AUTO_DISCOVERY=false nice -n 10 npm run build:linux:appimage
```

Artifacts:

- `electron-app/dist/linux-unpacked/tally-connect`
- `electron-app/dist/Tally-1.1.67.AppImage` (also copied to `tally-linux/artifacts/`)

Launch packaged app against local relay:

```bash
DISPLAY=:2 \
  /workspace/tally/electron-app/dist/linux-unpacked/tally-connect \
  --relay-url=ws://127.0.0.1:3400 \
  --config-path=/workspace/tally-linux/data/run1/config.json \
  --no-sandbox
```

Test account (local SQLite only): see `data/test-credentials.json`.

## Branding

Pulse logo + palette `#09090B` / `#22c55e` / `#F8FAFC` unchanged.

## Safety

- Never point at `api.tallyconnect.app` / Railway for these tests
- Never push/merge/release from this harness
- Keep CPU moderate (`nice`) while Crewline soak owns 3000/3100/7880/8000
