#!/usr/bin/env bash
set -euo pipefail
ROOT=/workspace/tally-linux
REPO=/workspace/tally
export DISPLAY="${DISPLAY:-:2}"
export NODE_ENV=development
RUN_ID="${1:-run1}"
export TALLY_RUN_ID="$RUN_ID"
mkdir -p "$ROOT/logs" "$ROOT/results/$RUN_ID" "$ROOT/screenshots/$RUN_ID" "$ROOT/data/$RUN_ID"

log() { echo "[$(date -Iseconds)] $*"; }

if ! curl -sf http://127.0.0.1:3400/api/health >/dev/null; then
  log "Starting local relay on :3400"
  set -a; source "$ROOT/data/relay.env"; set +a
  nice -n 5 node "$REPO/relay-server/server.js" >"$ROOT/logs/relay.log" 2>&1 &
  echo $! >"$ROOT/data/relay.pid"
  for i in $(seq 1 40); do curl -sf http://127.0.0.1:3400/api/health >/dev/null && break; sleep 1; done
fi

if ! curl -sf http://127.0.0.1:9911/api/state >/dev/null; then
  log "Starting MockLab"
  nice -n 5 node "$ROOT/sims/start-mocklab.js" >"$ROOT/logs/mocklab.log" 2>&1 &
  echo $! >"$ROOT/data/mocklab.pid"
  sleep 3
fi

log "Unit: electron-app"
(
  cd "$REPO/electron-app"
  nice -n 10 npm run test:unit 2>&1 || nice -n 10 npx vitest run --exclude '**/e2e/**' 2>&1 || nice -n 10 node --test 'test/**/*.test.js' 2>&1 || true
) | tee "$ROOT/results/$RUN_ID/unit-electron.log" | tail -40

log "Unit: church-client"
(
  cd "$REPO/church-client"
  nice -n 10 npm test 2>&1 || true
) | tee "$ROOT/results/$RUN_ID/unit-church-client.log" | tail -30

log "Unit: relay-server"
(
  cd "$REPO/relay-server"
  nice -n 10 npm test 2>&1 || true
) | tee "$ROOT/results/$RUN_ID/unit-relay.log" | tail -30

pkill -f 'electron.*main.js' 2>/dev/null || true
pkill -f 'linux-unpacked/tally-connect' 2>/dev/null || true
sleep 1

log "E2E Electron run=$RUN_ID"
cd "$ROOT"
set +e
nice -n 5 node scripts/e2e-electron.mjs 2>&1 | tee "$ROOT/results/$RUN_ID/e2e.log"
E2E_RC=${PIPESTATUS[0]}
set -e
log "Harness $RUN_ID done (e2e rc=$E2E_RC)"
exit 0
