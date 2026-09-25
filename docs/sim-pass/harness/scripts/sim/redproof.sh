#!/usr/bin/env bash
# Usage: redproof.sh <device> <test-file-rel-to-church-client> <BREAK_ENV> <old-commit|-> <mode...>
# Runs: green (current code+faithful mock), each mock mutation mode, and old Tally code.
# Writes results/sim/<device>-<stamp>/{summary.tsv,*.tap}
set -u
dev=$1; tf=$2; envv=$3; old=$4; shift 4
stamp=$(date +%Y%m%d-%H%M%S)
out=/workspace/tally-linux/results/sim/$dev-$stamp; mkdir -p "$out"
cd /workspace/tally/church-client
run() { # id env...
  local id=$1; shift
  env "$@" node --test --test-reporter=tap "$tf" > "$out/$id.tap" 2>&1
  local p f; p=$(grep -c '^ok ' "$out/$id.tap"); f=$(grep -c '^not ok ' "$out/$id.tap")
  local red; red=$(grep '^not ok ' "$out/$id.tap" | sed 's/^not ok \([0-9]*\).*/\1/' | tr '\n' ',' )
  printf '%s\t%s\tpass=%s\tfail=%s\tred_tests=%s\n' "$dev-$stamp/$id" "$*" "$p" "$f" "$red" | tee -a "$out/summary.tsv"
}
run green X=1
for m in "$@"; do run "break-$m" "$envv=$m"; done
if [ "$old" != "-" ]; then
  wt=/tmp/tally-old-$old
  [ -d "$wt" ] || git -C /workspace/tally worktree add --detach "$wt" "$old" >/dev/null 2>&1
  [ -e "$wt/church-client/node_modules" ] || ln -s /workspace/tally/church-client/node_modules "$wt/church-client/node_modules"
  run "old-$old" TALLY_AGENT_INDEX="$wt/church-client/src/index.js" TALLY_PTZ_MODULE="$wt/church-client/src/ptz.js"
fi
echo "OUT $out"
