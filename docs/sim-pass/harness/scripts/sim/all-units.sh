#!/usr/bin/env bash
# Runs every unit suite; writes results/<tag>-{electron,church,relay}.log + summary line.
tag=$1; R=/workspace/tally-linux/results
cd /workspace/tally/electron-app && npm test > $R/$tag-electron.log 2>&1; e=$?
cd /workspace/tally/church-client && npm test > $R/$tag-church.log 2>&1; c=$?
cd /workspace/tally/relay-server && ( set -a; . /workspace/tally-linux/data/relay.env; set +a; npx vitest run ) > $R/$tag-relay.log 2>&1; r=$?
sum() { grep -E "^# (tests|pass|fail)|Tests +[0-9]+ passed|Tests .*failed" "$1" | tr '\n' ' '; }
echo "electron exit=$e $(sum $R/$tag-electron.log)"
echo "church   exit=$c $(sum $R/$tag-church.log)"
echo "relay    exit=$r $(sum $R/$tag-relay.log)"
