#!/usr/bin/env bash
# Gate on 1fca257 (audio pass). Usage: paces-suite-g3.sh <pass-tag A|B>
# Local relay :3400 + MockLab :9910/:9911 only. Sequential (shared :2 display + relay).
set -u
P=${1:-A}
cd /workspace/tally-linux
export DISPLAY=:2
AI=/tmp/g3-appimage/squashfs-root/tally-connect
DEB=/tmp/g3-deb/opt/Tally/tally-connect
run() { # id, script, [packaged bin], [relay mode]
  local id=g3$P-$1 script=$2 bin=${3:-} mode=${4:-stop}
  bash scripts/cleanup-tally.sh
  bash scripts/restart-relay.sh >/dev/null
  mkdir -p results/$id
  echo "=== $id ($script ${bin:-source}) $(date +%T)"
  NODE_ENV=development TALLY_RUN_ID=$id TALLY_PACKAGED_BIN=$bin PACES_RELAY_MODE=$mode \
    node scripts/$script > results/$id/e2e.log 2>&1
  echo "=== $id exit=$? $(date +%T)"
  grep -E "^\S*(✓|✗)" results/$id/e2e.log | cut -c1-200
}
run src-e2e e2e-electron.mjs
run src-hard paces-e2e.mjs "" stop
run src-audio sim/booth-audio.mjs
run appimage-e2e e2e-electron.mjs $AI
run appimage-hard paces-e2e.mjs $AI kill
run appimage-obs sim/booth-obs.mjs $AI
run appimage-audio sim/booth-audio.mjs $AI
run deb-e2e e2e-electron.mjs $DEB
run deb-hard paces-e2e.mjs $DEB stop
run deb-obs sim/booth-obs.mjs $DEB
run deb-audio sim/booth-audio.mjs $DEB
bash scripts/cleanup-tally.sh
R=results; T=g3$P
cd /workspace/tally/electron-app && npm test > /workspace/tally-linux/$R/$T-electron.log 2>&1; echo "electron exit=$? $(grep -E '^# (pass|fail)' /workspace/tally-linux/$R/$T-electron.log | tr '\n' ' ')"
cd /workspace/tally/church-client && npm run -s test:unit > /workspace/tally-linux/$R/$T-church-unit.log 2>&1; echo "church-unit exit=$? $(grep -E '^# (pass|fail)' /workspace/tally-linux/$R/$T-church-unit.log | tr '\n' ' ')"
cd /workspace/tally/church-client && TALLY_REQUIRE_RELAY_LOOP=1 npm run -s test:sim > /workspace/tally-linux/$R/$T-church-sim.log 2>&1; echo "church-sim exit=$? $(grep -E '^# (pass|fail|skipped)' /workspace/tally-linux/$R/$T-church-sim.log | tr '\n' ' ')"
cd /workspace/tally/relay-server && ( set -a; . /workspace/tally-linux/data/relay.env; set +a; npx vitest run ) > /workspace/tally-linux/$R/$T-relay.log 2>&1; echo "relay exit=$? $(grep -E 'Test Files|Tests ' /workspace/tally-linux/$R/$T-relay.log | tr '\n' ' ')"
echo SUITE_DONE_$P
