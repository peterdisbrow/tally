#!/usr/bin/env bash
set -u
cd /workspace/tally-linux
export DISPLAY=:2
id=${RED_ID:-hero-RED-appimage-7bd4acb}
bash scripts/cleanup-tally.sh
bash scripts/restart-relay.sh >/dev/null
mkdir -p results/$id
NODE_ENV=development TALLY_RUN_ID=$id TALLY_PACKAGED_BIN=/tmp/sim-appimage/squashfs-root/tally-connect PACES_RELAY_MODE=stop \
  node scripts/paces-e2e.mjs > results/$id/e2e.log 2>&1
echo "exit=$?"
bash scripts/cleanup-tally.sh
echo RED_DONE
