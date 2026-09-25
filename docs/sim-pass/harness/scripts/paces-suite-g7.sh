#!/usr/bin/env bash
# Milestone gate: g6 (every booth on source + AppImage + deb, then unit suites)
# plus the full-church crash/unplug run on each package, twice (A then B).
# Local relay :3400 + MockLab only. Never production. Does not publish.
set -u
cd /workspace/tally-linux
export PATH="/home/ubuntu/.nvm/versions/node/v20.20.2/bin:${PATH:-}"
FAILS=0
AI=/tmp/g6-appimage/squashfs-root/tally-connect
DEB=/tmp/g6-deb/opt/Tally/tally-connect
if [ ! -x "$AI" ] || [ ! -x "$DEB" ]; then
  echo "missing packaged binaries ($AI / $DEB)"
  exit 1
fi
run_full() {
  local pass=$1 kind=$2 bin=${3:-}
  local id=g7${pass}-fullchurch-${kind}
  bash scripts/cleanup-tally.sh
  bash scripts/restart-relay.sh >/dev/null
  if ! curl -sf http://127.0.0.1:9911/api/state >/dev/null; then
    node sims/start-mocklab.js >>logs/mocklab.log 2>&1 &
    for i in $(seq 1 40); do curl -sf http://127.0.0.1:9911/api/state >/dev/null && break; sleep 0.25; done
  fi
  mkdir -p results/$id
  echo "=== $id bin=${bin:-source} $(date +%T)"
  DISPLAY=:1 NODE_ENV=development TALLY_RUN_ID=$id TALLY_PACKAGED_BIN=$bin \
    node scripts/sim/booth-full-church.mjs > results/$id/e2e.log 2>&1
  local rc=$?
  echo "=== $id exit=$rc $(date +%T)"
  if [ "$rc" -ne 0 ]; then FAILS=$((FAILS + 1)); fi
  grep -E '\[(PASS|FAIL)\]' results/$id/e2e.log | cut -c1-220
}

PASS=${1:-both}
if [ "$PASS" = "A" ] || [ "$PASS" = "both" ]; then
  bash scripts/paces-suite-g6.sh A || FAILS=$((FAILS + 1))
  cd /workspace/tally-linux
  # g6 skips OBS on source. Run it.
  bash scripts/cleanup-tally.sh
  bash scripts/restart-relay.sh >/dev/null
  mkdir -p results/g7A-src-obs
  echo "=== g7A-src-obs $(date +%T)"
  DISPLAY=:2 NODE_ENV=development TALLY_RUN_ID=g7A-src-obs \
    node scripts/sim/booth-obs.mjs > results/g7A-src-obs/e2e.log 2>&1
  rc=$?
  echo "=== g7A-src-obs exit=$rc $(date +%T)"
  if [ "$rc" -ne 0 ]; then FAILS=$((FAILS + 1)); fi
  run_full A src ""
  run_full A appimage "$AI"
  run_full A deb "$DEB"
fi
if [ "$PASS" = "B" ] || [ "$PASS" = "both" ]; then
  bash scripts/paces-suite-g6.sh B || FAILS=$((FAILS + 1))
  cd /workspace/tally-linux
  bash scripts/cleanup-tally.sh
  bash scripts/restart-relay.sh >/dev/null
  mkdir -p results/g7B-src-obs
  echo "=== g7B-src-obs $(date +%T)"
  DISPLAY=:2 NODE_ENV=development TALLY_RUN_ID=g7B-src-obs \
    node scripts/sim/booth-obs.mjs > results/g7B-src-obs/e2e.log 2>&1
  rc=$?
  echo "=== g7B-src-obs exit=$rc $(date +%T)"
  if [ "$rc" -ne 0 ]; then FAILS=$((FAILS + 1)); fi
  run_full B src ""
  run_full B appimage "$AI"
  run_full B deb "$DEB"
fi
echo GATE_DONE fails=$FAILS
if [ "$FAILS" -ne 0 ]; then exit 1; fi
