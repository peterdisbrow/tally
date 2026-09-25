#!/usr/bin/env bash
# Paces suite on fixed build. Local relay :3400 + MockLab :9910/:9911 only.
set -u
cd /workspace/tally-linux
export DISPLAY=:2
run() { # id, script, [packaged bin], [relay mode]
  local id=$1 script=$2 bin=${3:-} mode=${4:-stop}
  bash scripts/cleanup-tally.sh
  bash scripts/restart-relay.sh >/dev/null
  mkdir -p results/$id
  echo "=== $id ($script ${bin:-source}) $(date +%T)"
  NODE_ENV=development TALLY_RUN_ID=$id TALLY_PACKAGED_BIN=$bin PACES_RELAY_MODE=$mode \
    node scripts/$script > results/$id/e2e.log 2>&1
  echo "=== $id exit=$? $(date +%T)"
  grep -E "^\S*(✓|✗)" results/$id/e2e.log | cut -c1-200
}
run v-src-e2e-1 e2e-electron.mjs
run v-src-e2e-2 e2e-electron.mjs
run v-src-hard paces-e2e.mjs "" stop
run v-appimage-e2e e2e-electron.mjs /tmp/paces-appimage/squashfs-root/tally-connect
run v-appimage-hard paces-e2e.mjs /tmp/paces-appimage/squashfs-root/tally-connect kill
run v-deb-e2e e2e-electron.mjs /tmp/paces-deb/opt/Tally/tally-connect
run v-deb-hard paces-e2e.mjs /tmp/paces-deb/opt/Tally/tally-connect stop
bash scripts/cleanup-tally.sh
echo SUITE_DONE
