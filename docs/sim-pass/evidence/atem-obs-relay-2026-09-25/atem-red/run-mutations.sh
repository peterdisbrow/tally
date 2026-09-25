#!/usr/bin/env bash
# ATEM relay-loop red proof: each mock break mode + a stale-switcher-object agent mutation.
cd /workspace/tally/church-client
D=/workspace/tally-linux/results/sim/atem-red
for mode in ack-no-apply accept-any-source no-state-push no-init-complete; do
  ATEM_MOCK_BREAK=$mode nice -n 10 node --require ./test/_stdout-guard.cjs --test --test-timeout=180000 --test-concurrency=1 test/sim/atem.test.js > $D/mock-$mode.tap 2>&1
  echo "$mode exit=$? $(grep -E '^not ok' $D/mock-$mode.tap | cut -c1-12 | tr '\n' ' ')"
done
# M-stale: old command handlers (agent.atem) + switcherManager no longer refreshing agent.atem on reconnect
cp src/commands/atem.js /tmp/atem.js.new; cp src/switcherManager.js /tmp/switcherManager.js.new
git show bca42d7:church-client/src/commands/atem.js > src/commands/atem.js
sed -i 's/^\(\s*\)this.agent.atem = sw.raw;/\1\/\/ MUTATION: stale agent.atem/' src/switcherManager.js
grep -n "MUTATION" src/switcherManager.js
nice -n 10 node --require ./test/_stdout-guard.cjs --test --test-timeout=180000 --test-concurrency=1 --test-name-pattern="power-cycled" test/sim/atem.test.js > $D/mutation-stale-agent-atem.tap 2>&1
echo "stale exit=$? $(grep -E '^not ok' $D/mutation-stale-agent-atem.tap | cut -c1-12 | tr '\n' ' ')"
cp /tmp/atem.js.new src/commands/atem.js; cp /tmp/switcherManager.js.new src/switcherManager.js
git diff --stat src/switcherManager.js
echo MUT_DONE
