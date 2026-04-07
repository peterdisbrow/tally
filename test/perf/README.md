# Tally Perf Baseline (k6)

Phase B baseline scripts for API and WebSocket reliability checks.

## 1) API baseline

```bash
k6 run \
  -e BASE_URL=https://api.tallyconnect.app \
  -e VUS=10 \
  -e DURATION=2m \
  test/perf/baseline.js
```

Optional login checks (church app auth):

```bash
k6 run \
  -e BASE_URL=https://api.tallyconnect.app \
  -e LOGIN_EMAIL=your-email@example.com \
  -e LOGIN_PASSWORD='your-password' \
  test/perf/baseline.js
```

## 2) WebSocket smoke

```bash
k6 run \
  -e BASE_WS=wss://api.tallyconnect.app \
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
BASE_URL=https://api.tallyconnect.app \
BASE_WS=wss://api.tallyconnect.app \
ADMIN_API_KEY='your-admin-key' \
LOGIN_EMAIL='your-email@example.com' \
LOGIN_PASSWORD='your-password' \
REQUESTS=80 \
CONCURRENCY=12 \
node test/perf/node-smoke.js
```

## WebSocket load harness

`test/perf/ws-load.js` simulates many church clients connecting to `/church`, sending periodic `status_update` traffic, and optionally adds controller clients that observe fan-out and status lag.
It can also simulate preview publishers and preview subscribers so you can measure the new pull-based preview path instead of only the status heartbeat path.

The recommended input is a token file with one JWT per church:

```json
[
  { "churchId": "church-1", "token": "eyJ...", "name": "First Church" },
  { "churchId": "church-2", "token": "eyJ...", "name": "Second Church" }
]
```

You can also use a pipe-delimited text file with `churchId|token|name` per line.

### 1000-church run

```bash
ulimit -n 8192

BASE_WS=wss://api.tallyconnect.app \
CHURCH_TOKENS_FILE=/path/to/church-tokens.json \
CHURCH_COUNT=1000 \
INSTANCES_PER_CHURCH=1 \
CONTROLLER_CLIENTS=5 \
STATUS_INTERVAL_MS=10000 \
PREVIEW_PUBLISHER_RATIO=0.05 \
PREVIEW_SUBSCRIBER_CONTROLLERS=2 \
PREVIEW_INTERVAL_MS=5000 \
WARMUP_MS=5000 \
DURATION_MS=60000 \
CONNECT_BATCH_SIZE=25 \
CONNECT_BATCH_INTERVAL_MS=250 \
ADMIN_API_KEY='your-controller-api-key' \
node test/perf/ws-load.js
```

Useful knobs:

- `CHURCH_COUNT` selects how many churches from the token file to activate.
- `INSTANCES_PER_CHURCH` creates multiple `/church` sockets for the same church, which is useful for multi-room churches.
- `CONTROLLER_CLIENTS` adds controller sockets so you can measure relay fan-out.
- `STATUS_INTERVAL_MS` controls how often each church client sends `status_update`.
- `PREVIEW_PUBLISHER_COUNT` or `PREVIEW_PUBLISHER_RATIO` selects how many churches also publish `preview_frame` traffic.
- `PREVIEW_SUBSCRIBER_CONTROLLERS` tells the first N controller clients to subscribe to all preview publishers and fetch `/api/admin/churches/:churchId/preview/latest`.
- `PREVIEW_INTERVAL_MS` controls how often preview publishers send frames.
- `PREVIEW_FRAME_PAYLOAD_BYTES` adjusts the synthetic preview payload size before base64 encoding.
- `HEALTH_BASE_URL` overrides which relay HTTP base URL should be polled for `/api/health`. By default it is derived from `BASE_WS`.
- `HEALTH_POLL_MS` enables periodic health polling during the run so the harness captures event-loop lag, queue depth, and preview subscription counts from the relay.
- `MAX_PREVIEW_FETCH_FAIL_RATE` and `MAX_PREVIEW_LAG_P95_MS` add optional fail thresholds for preview fetch reliability and lag.
- `MAX_HEALTH_EVENT_LOOP_P95_MS` and `MAX_HEALTH_QUEUE_MESSAGES` add optional fail thresholds for the sampled health telemetry.
- `DRY_RUN=1` parses the token file and prints the connection plan without opening sockets.

Baseline expectations:

- Church connection failure rate should stay below `1%`.
- Controller connection failure rate should stay below `1%`.
- Status send failure rate should stay below `1%`.
- Controller-observed status lag p95 should stay under `1000ms` for a healthy relay.
- If preview simulation is enabled, preview fetch failure rate should stay low and preview lag p95 should stay within your chosen budget.
- When health polling is enabled, event-loop lag p95 and queued message depth should stay comfortably below your chosen thresholds.
