#!/usr/bin/env bash
# per-file test counts for church-client, N rounds → results/sim/perfile-<round>.tsv
cd /workspace/tally/church-client
for round in "$@"; do
  out=/workspace/tally-linux/results/sim/perfile-$round.tsv; : > $out
  for f in test/*.test.js; do
    r=$(node --test --test-timeout=60000 --test-force-exit "$f" 2>&1 | grep -E "^# (tests|pass|fail)" | awk '{print $3}' | tr '\n' ' ')
    echo -e "$f\t$r" >> $out
  done
done
echo DONE
