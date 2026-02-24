# Tally Perf Baseline (k6)

Phase B baseline scripts for API and WebSocket reliability checks.

## 1) API baseline

```bash
k6 run \
  -e BASE_URL=https://tally-production-cde2.up.railway.app \
  -e VUS=10 \
  -e DURATION=2m \
  test/perf/baseline.js
```

Optional login checks (church app auth):

```bash
k6 run \
  -e BASE_URL=https://tally-production-cde2.up.railway.app \
  -e LOGIN_EMAIL=your-email@example.com \
  -e LOGIN_PASSWORD='your-password' \
  test/perf/baseline.js
```

## 2) WebSocket smoke

```bash
k6 run \
  -e BASE_WS=wss://tally-production-cde2.up.railway.app \
  -e ADMIN_API_KEY='your-admin-key' \
  -e VUS=5 \
  -e DURATION=60s \
  test/perf/ws-smoke.js
```

## Baseline pass criteria

- `http_req_failed < 1%`
- `http_req_duration p95 < 500ms`
- WebSocket connects with HTTP 101 and receives initial `church_list` payload

## Node fallback (no k6 required)

If `k6` is not installed in your environment, run the Node smoke baseline:

```bash
node test/perf/node-smoke.js
```

With admin + login probes:

```bash
BASE_URL=https://tally-production-cde2.up.railway.app \
BASE_WS=wss://tally-production-cde2.up.railway.app \
ADMIN_API_KEY='your-admin-key' \
LOGIN_EMAIL='your-email@example.com' \
LOGIN_PASSWORD='your-password' \
REQUESTS=80 \
CONCURRENCY=12 \
node test/perf/node-smoke.js
```
