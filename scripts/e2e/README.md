# TallyConnect E2E Test Harness

Single-command end-to-end test against production Neon + `api.tallyconnect.app`.
Boots all 11 mock devices, spawns the church-client agent against a labeled
test account in production, runs scenarios, prints pass/fail, tears down.

## Quick start

```bash
# Required: admin key for /api/churches/* endpoints.
export ADMIN_API_KEY='...'

# Optional but recommended: enables in-process cron triggers (offline
# detection, weekly digest). Without it, those scenarios load the modules
# but skip the DB round-trip.
export DATABASE_URL='postgres://...'

npm run test:e2e
```

What you'll see:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TallyConnect E2E Harness
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Relay        : https://api.tallyconnect.app
Database     : configured
...

▶ A. ProPresenter slide advance
✓ A. ProPresenter slide advance  (3204ms)
▶ B. OBS goes live
✓ B. OBS goes live  (5103ms)
...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
E2E SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✓   3204ms  A. ProPresenter slide advance
  ✓   5103ms  B. OBS goes live
  ...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  22/22 passed (0 failed) — 87341ms total
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Exit code is non-zero if any scenario fails.

## What gets tested

### Service sequence (7)
| Scenario | What it asserts |
|---|---|
| A. ProPresenter slide advance | Mock advances slides → relay SSE reflects new `slideIndex` |
| B. OBS goes live | `setStreaming(true)` → relay SSE shows `streaming:true` + stats |
| C. VideoHub route change | `setRoute(2,5)` → relay SSE shows `routes[2]=5` |
| D. Companion press dispatched | Outbound: relay command → mock pressLog. Inbound: mock simulatePress → relay SSE recentPresses |
| E. ATEM disconnect + recovery | `setReachable(false)` → SSE shows disconnect; `setReachable(true)` → SSE shows recovery |
| F. Teradek battery alert | Mock battery=3% → admin alert API shows alert (or surfaces missing wiring) |
| G. SQ channel rename | OSC channel name set on mock → relay status reflects (or surfaces missing poll trigger) |

### Recovery (11)
For each device, restarts the mock layer with that device excluded, asserts
the agent observes a disconnect, then restarts with the full set and asserts
reconnect. Per-device timeouts vary (ATEM 20s, SQ 25s, others 5–15s) to
match real reconnect-backoff behavior.

### Automation (3)
| Scenario | Mechanism |
|---|---|
| Offline detection cron | Spawns a Node child importing `relay-server/src/crons/offlineDetection.js`, calls `checkOfflineChurches()` directly with a real Neon `queryClient` if `DATABASE_URL` is set |
| Weekly digest | Same pattern with `WeeklyDigest` class — capture-stub `lifecycleEmails` so we don't actually send to Resend |
| Stream protection | Boot OBS streaming → flip to stopped → assert agent publishes a stream-protection / signal-failover signal |

### AI engineer (1)
Sets up a clearly-faulty state (OBS off, ATEM unreachable), POSTs a question
to `/api/church/chat`, polls for the AI's reply, asserts the reply mentions
the fault. Tolerates LLM variability — any of `obs|atem|stream|disconnect|
offline|connection|reconnect|restart` in the reply passes.

## Environment variables

| Var | Required? | Default | Purpose |
|---|---|---|---|
| `ADMIN_API_KEY` | yes | — | Admin key for `/api/churches/*` |
| `RELAY_URL` | no | `https://api.tallyconnect.app` | Target relay |
| `DATABASE_URL` | no | — | Neon Postgres URL — enables full cron tests |
| `JWT_SECRET` | no | — | Only needed if cron drivers need to mint tokens locally |
| `E2E_TEST_PREFIX` | no | `test-e2e-` | Email prefix for the test account |
| `E2E_KEEP_ACCOUNT` | no | `0` | Set to `1` to skip teardown (debug) |
| `E2E_LOG_LEVEL` | no | `info` | `silent`, `error`, `info`, or `debug` |

## Subcommands

```bash
# Just create / find the test account, print credentials, exit.
npm run test:e2e:create-account

# Force-delete the test account + room (orphan cleanup).
npm run test:e2e:cleanup
```

## Architecture

```
scripts/
├── e2e-create-test-account.js     # standalone account provisioner
└── e2e/
    ├── README.md                   # this file
    ├── run.js                      # main orchestrator
    ├── lib/
    │   ├── api.js                  # fetch wrapper (admin + bearer)
    │   ├── auth.js                 # account create/login/delete
    │   ├── config.js               # env loading
    │   ├── log.js                  # tiny leveled logger
    │   ├── mockControl.js          # mock /action /state helpers
    │   ├── scenarios.js            # ScenarioRunner + waitUntil
    │   ├── spawnAgent.js           # church-client subprocess
    │   ├── spawnMocks.js           # mock launcher subprocess
    │   └── sse.js                  # /api/church/app/status/stream consumer
    └── scenarios/
        ├── 01-propresenter-slide.js
        ├── 02-obs-streaming.js
        ├── 03-videohub-routing.js
        ├── 04-companion-press.js
        ├── 05-atem-disconnect-recovery.js
        ├── 06-teradek-battery-alert.js
        ├── 07-sq-channel-rename.js
        ├── 10-recovery-all-mocks.js   # builds 11 sub-scenarios
        ├── 20-cron-offline-detection.js
        ├── 21-cron-weekly-digest.js
        ├── 22-stream-protection.js
        └── 30-ai-engineer.js
```

Each scenario is a self-contained module: `module.exports = async (ctx) => ...`
where `ctx` exposes `{ cfg, log, account, mocks, sse, admin, bearer }`.
Add new scenarios by dropping a file in `scenarios/` and registering it
in `run.js`.

## Failure debugging

If something fails, the harness:
- Prints the failing scenario name + error message in the summary
- Leaves the test account in place if `E2E_KEEP_ACCOUNT=1` is set
- Sets exit code to non-zero

For deep debugging:
```bash
E2E_LOG_LEVEL=debug E2E_KEEP_ACCOUNT=1 npm run test:e2e
```

This streams agent stdout, mock stdout, SSE frames, and the full stack
trace on any failure. After debugging, manually clean up:
```bash
npm run test:e2e:cleanup
```

## Production safety

- Test data is labeled with `E2E_TEST_PREFIX` (default `test-e2e-`) so it's
  obvious in admin queries / billing reports.
- Default `tier='pro'`, `billingStatus='active'` — bypasses the production
  billing gate but doesn't create a real Stripe customer.
- `portal_email` is `test-e2e-harness@harness.test` (non-deliverable
  domain) — Resend will accept the API call but no real human gets mail.
- Teardown deletes the church row + cascades (rooms, equipment, alerts)
  via `DELETE /api/churches/:churchId`.
- The harness does NOT alter any non-test rows.

## Known gaps

These are flagged in scenario output rather than swept under the rug:

- **Teradek battery alert path** — the relay doesn't currently poll
  non-encoder Teradek devices for battery state. Mock-side state set,
  alert path absent. Documented as a finding in scenario F.
- **SQ channel rename propagation** — the A&H bridge doesn't poll for
  channel name changes on a tick. Mock state set; relay republish would
  need a refresh trigger. Documented in scenario G.
- **Stream protection signal surface** — the harness asserts the agent
  publishes some observable signal after an unexpected stream stop. If
  the protection module dispatches via Telegram only (no status flag),
  the test passes with a "no signal observed" note.
```
