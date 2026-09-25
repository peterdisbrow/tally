#!/usr/bin/env bash
# Restart LOCAL relay (:3400) only — clears in-memory login rate limiter (5/15min).
# relay.env is sourced in a subshell so its secrets never leak into Electron launches.
set -u
PID=$(ss -tlnp 2>/dev/null | grep ':3400 ' | grep -oP 'pid=\K[0-9]+' | head -1)
[ -n "${PID:-}" ] && kill "$PID" 2>/dev/null && sleep 2
( set -a; source /workspace/tally-linux/data/relay.env; set +a
  nice -n 5 node /workspace/tally/relay-server/server.js >>/workspace/tally-linux/logs/relay.log 2>&1 &
  echo $! > /workspace/tally-linux/data/relay.pid )
for i in $(seq 1 60); do curl -sf http://127.0.0.1:3400/api/health >/dev/null && echo "relay up" && exit 0; sleep 0.25; done
echo "relay FAILED to start"; exit 1
