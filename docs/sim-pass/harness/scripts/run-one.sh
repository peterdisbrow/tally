#!/usr/bin/env bash
# run-one.sh <id> <script> [packaged bin] [relay mode] — single lab run, same as suite run()
set -u
cd /workspace/tally-linux
export DISPLAY=:2
id=$1 script=$2 bin=${3:-} mode=${4:-stop}
bash scripts/cleanup-tally.sh
bash scripts/restart-relay.sh >/dev/null
mkdir -p results/$id
echo "=== $id ($script ${bin:-source}) $(date +%T)"
NODE_ENV=development TALLY_RUN_ID=$id TALLY_PACKAGED_BIN=$bin PACES_RELAY_MODE=$mode node scripts/$script > results/$id/e2e.log 2>&1
echo "=== $id exit=$? $(date +%T)"
grep -E "^\S*(✓|✗)" results/$id/e2e.log | cut -c1-260
