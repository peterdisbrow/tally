#!/usr/bin/env bash
# Milestone gate g6 on bca42d7 (Companion + Planning Center, on top of X32/SQ/OBS/dLive/Avantis/Yamaha/PP).
# Usage: paces-suite-g6.sh <pass-tag A|B>. Local relay :3400 + MockLab :9910/:9911 only.
# Sequential (shared :2 display + relay). Packages from the fresh bca42d7 build.
set -u
P=${1:-A}
cd /workspace/tally-linux
export DISPLAY=:2
export PATH="/home/ubuntu/.nvm/versions/node/v20.20.2/bin:${PATH:-}"
AI=/tmp/g6-appimage/squashfs-root/tally-connect
DEB=/tmp/g6-deb/opt/Tally/tally-connect
FAILS=0
note_rc() {
  if [ "$1" -ne 0 ]; then FAILS=$((FAILS + 1)); fi
}
# The lab MockLab is a long-lived process. Restart it from this tree so a
# panel cut is pushed to clients that are already connected.
reload_mocklab() {
  local pids i
  pids=$(lsof -tiTCP:9911 -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null || true
    sleep 1
  fi
  node sims/start-mocklab.js >>logs/mocklab.log 2>&1 &
  for i in $(seq 1 40); do
    curl -sf http://127.0.0.1:9911/api/state >/dev/null && return 0
    sleep 0.25
  done
  echo "mocklab did not listen on 127.0.0.1:9911" >&2
  return 1
}
if ! reload_mocklab; then
  echo "SUITE_DONE_$P fails=mocklab"
  exit 1
fi
run() { # id, script, [packaged bin], [relay mode]
  local id=g6$P-$1 script=$2 bin=${3:-} mode=${4:-stop} rc
  bash scripts/cleanup-tally.sh
  bash scripts/restart-relay.sh >/dev/null
  # Each scenario starts from an empty room. A previous booth's saved mixer/OBS
  # would otherwise show up as issues on the next ATEM-only check.
  python3 - <<'PY'
import sqlite3
db = sqlite3.connect("/workspace/tally-linux/data/relay.db")
db.execute("update room_equipment set equipment='{}'")
db.commit()
PY
  mkdir -p results/$id
  echo "=== $id ($script ${bin:-source}) $(date +%T)"
  NODE_ENV=development TALLY_RUN_ID=$id TALLY_PACKAGED_BIN=$bin PACES_RELAY_MODE=$mode \
    node scripts/$script > results/$id/e2e.log 2>&1
  rc=$?
  echo "=== $id exit=$rc $(date +%T)"
  note_rc "$rc"
  grep -E "^\S*(✓|✗)" results/$id/e2e.log | cut -c1-200
}
booths() { # prefix, bin, hard-mode
  local pre=$1 bin=$2 hm=$3
  run $pre-e2e e2e-electron.mjs "$bin"
  run $pre-hard paces-e2e.mjs "$bin" $hm
  [ -n "$bin" ] && run $pre-obs sim/booth-obs.mjs "$bin"
  run $pre-audio sim/booth-audio.mjs "$bin"
  run $pre-sq sim/booth-sq.mjs "$bin"
  AH_MODEL=dlive run $pre-dlive sim/booth-ah.mjs "$bin"
  AH_MODEL=avantis run $pre-avantis sim/booth-ah.mjs "$bin"
  YAMAHA_MODEL=CL5 run $pre-yamaha-cl5 sim/booth-yamaha.mjs "$bin"
  YAMAHA_MODEL=TF5 run $pre-yamaha-tf5 sim/booth-yamaha.mjs "$bin"
  run $pre-pp sim/booth-pp.mjs "$bin"
  run $pre-comp sim/booth-companion.mjs "$bin"
  run $pre-pco sim/booth-pco.mjs "$bin"
}
booths src "" stop
booths appimage $AI kill
booths deb $DEB stop
bash scripts/cleanup-tally.sh
R=results; T=g6$P
cd /workspace/tally/electron-app && npm test > /workspace/tally-linux/$R/$T-electron.log 2>&1; rc=$?; echo "electron exit=$rc $(grep -E '^# (pass|fail)' /workspace/tally-linux/$R/$T-electron.log | tr '\n' ' ')"; note_rc "$rc"
cd /workspace/tally/church-client && npm run -s test:unit > /workspace/tally-linux/$R/$T-church-unit.log 2>&1; rc=$?; echo "church-unit exit=$rc $(grep -E '^# (pass|fail)' /workspace/tally-linux/$R/$T-church-unit.log | tr '\n' ' ')"; note_rc "$rc"
cd /workspace/tally/church-client && TALLY_REQUIRE_RELAY_LOOP=1 npm run -s test:sim > /workspace/tally-linux/$R/$T-church-sim.log 2>&1; rc=$?; echo "church-sim exit=$rc $(grep -E '^# (pass|fail|skipped)' /workspace/tally-linux/$R/$T-church-sim.log | tr '\n' ' ')"; note_rc "$rc"
cd /workspace/tally/relay-server && ( set -a; . /workspace/tally-linux/data/relay.env; set +a; npx vitest run ) > /workspace/tally-linux/$R/$T-relay.log 2>&1; rc=$?; echo "relay exit=$rc $(grep -E 'Test Files|Tests ' /workspace/tally-linux/$R/$T-relay.log | tr '\n' ' ')"; note_rc "$rc"
echo SUITE_DONE_$P fails=$FAILS
if [ "$FAILS" -ne 0 ]; then exit 1; fi
