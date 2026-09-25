#!/usr/bin/env bash
# Milestone gate g6 on bca42d7 (Companion + Planning Center, on top of X32/SQ/OBS/dLive/Avantis/Yamaha/PP).
# Usage: paces-suite-g6.sh <pass-tag A|B>. Local relay :3400 + MockLab :9910/:9911 only.
# Sequential (shared :2 display + relay). Packages from the fresh bca42d7 build.
set -u
P=${1:-A}
cd /workspace/tally-linux
export DISPLAY=:2
AI=/tmp/g6-appimage/squashfs-root/tally-connect
DEB=/tmp/g6-deb/opt/Tally/tally-connect
run() { # id, script, [packaged bin], [relay mode]
  local id=g6$P-$1 script=$2 bin=${3:-} mode=${4:-stop}
  bash scripts/cleanup-tally.sh
  bash scripts/restart-relay.sh >/dev/null
  mkdir -p results/$id
  echo "=== $id ($script ${bin:-source}) $(date +%T)"
  NODE_ENV=development TALLY_RUN_ID=$id TALLY_PACKAGED_BIN=$bin PACES_RELAY_MODE=$mode \
    node scripts/$script > results/$id/e2e.log 2>&1
  echo "=== $id exit=$? $(date +%T)"
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
cd /workspace/tally/electron-app && npm test > /workspace/tally-linux/$R/$T-electron.log 2>&1; echo "electron exit=$? $(grep -E '^# (pass|fail)' /workspace/tally-linux/$R/$T-electron.log | tr '\n' ' ')"
cd /workspace/tally/church-client && npm run -s test:unit > /workspace/tally-linux/$R/$T-church-unit.log 2>&1; echo "church-unit exit=$? $(grep -E '^# (pass|fail)' /workspace/tally-linux/$R/$T-church-unit.log | tr '\n' ' ')"
cd /workspace/tally/church-client && TALLY_REQUIRE_RELAY_LOOP=1 npm run -s test:sim > /workspace/tally-linux/$R/$T-church-sim.log 2>&1; echo "church-sim exit=$? $(grep -E '^# (pass|fail|skipped)' /workspace/tally-linux/$R/$T-church-sim.log | tr '\n' ' ')"
cd /workspace/tally/relay-server && ( set -a; . /workspace/tally-linux/data/relay.env; set +a; npx vitest run ) > /workspace/tally-linux/$R/$T-relay.log 2>&1; echo "relay exit=$? $(grep -E 'Test Files|Tests ' /workspace/tally-linux/$R/$T-relay.log | tr '\n' ' ')"
echo SUITE_DONE_$P
