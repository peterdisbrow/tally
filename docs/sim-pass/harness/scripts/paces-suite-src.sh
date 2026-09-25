#!/usr/bin/env bash
# Per-fix/per-device full suite (source build). Usage: paces-suite-src.sh <tag>
# Units first (fast fail), then source booth runs. Local relay :3400 + MockLab only.
set -u
T=${1:?tag}
cd /workspace/tally-linux
export DISPLAY=:2
R=/workspace/tally-linux/results
bash scripts/cleanup-tally.sh
cd /workspace/tally/electron-app && npm test > $R/$T-electron.log 2>&1; echo "electron exit=$? $(grep -E '^# (pass|fail)' $R/$T-electron.log | tr '\n' ' ')"
cd /workspace/tally/church-client && npm run -s test:unit > $R/$T-church-unit.log 2>&1; echo "church-unit exit=$? $(grep -E '^# (pass|fail)' $R/$T-church-unit.log | tr '\n' ' ')"
cd /workspace/tally/church-client && TALLY_REQUIRE_RELAY_LOOP=1 npm run -s test:sim > $R/$T-church-sim.log 2>&1; echo "church-sim exit=$? $(grep -E '^# (pass|fail|skipped)' $R/$T-church-sim.log | tr '\n' ' ')"
cd /workspace/tally/relay-server && ( set -a; . /workspace/tally-linux/data/relay.env; set +a; npx vitest run ) > $R/$T-relay.log 2>&1; echo "relay exit=$? $(grep -E 'Test Files|Tests ' $R/$T-relay.log | tr '\n' ' ')"
cd /workspace/tally-linux
run() { # id, script
  local id=$T-$1 script=$2
  bash scripts/cleanup-tally.sh
  bash scripts/restart-relay.sh >/dev/null
  mkdir -p results/$id
  echo "=== $id ($script source) $(date +%T)"
  NODE_ENV=development TALLY_RUN_ID=$id TALLY_PACKAGED_BIN= PACES_RELAY_MODE=stop \
    node scripts/$script > results/$id/e2e.log 2>&1
  echo "=== $id exit=$? $(date +%T)"
  grep -E "^\S*(✓|✗)" results/$id/e2e.log | cut -c1-200
}
run src-e2e e2e-electron.mjs
run src-hard paces-e2e.mjs
run src-audio sim/booth-audio.mjs
run src-sq sim/booth-sq.mjs
AH_MODEL=dlive run src-dlive sim/booth-ah.mjs
AH_MODEL=avantis run src-avantis sim/booth-ah.mjs
YAMAHA_MODEL=CL5 run src-yamaha-cl5 sim/booth-yamaha.mjs
YAMAHA_MODEL=TF5 run src-yamaha-tf5 sim/booth-yamaha.mjs
run src-pp sim/booth-pp.mjs
run src-comp sim/booth-companion.mjs
run src-pco sim/booth-pco.mjs
bash scripts/cleanup-tally.sh
echo SUITE_DONE_$T
