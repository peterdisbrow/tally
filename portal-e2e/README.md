# Portal E2E (Playwright)

End-to-end browser tests for the TallyConnect portal UI. Runs against
production by default (`https://api.tallyconnect.app`).

The existing harness at [`test/integration.js`](../test/integration.js)
exercises the relay/church-client pipeline against an in-memory server but
never touches the portal UI; this suite fills that gap.

## Setup

From the repo root:

```bash
npm install                     # installs @playwright/test + dotenv
npm run test:portal:install     # installs Playwright's bundled Chromium
cp portal-e2e/.env.example portal-e2e/.env
# edit portal-e2e/.env and fill in PORTAL_EMAIL / PORTAL_PASSWORD
# (and ADMIN_EMAIL / ADMIN_PASSWORD if you want to run admin-panel tests)
```

Use a **dedicated test church account** for `PORTAL_EMAIL` — tests create
and delete rooms and write equipment configs under that account.

## Running

```bash
npm run test:portal              # full suite, headless
npm run test:portal:headed       # watch the browser drive the UI
npm run test:portal:ui           # interactive Playwright UI mode
npx playwright test 01-auth      # single spec
```

## What's covered

| Spec | Coverage |
| --- | --- |
| `01-auth.spec.js` | Login / logout / bad creds, session cookie lifecycle |
| `02-dashboard.spec.js` | Overview page, equipment status card, SSE stream |
| `03-rooms.spec.js` | Create / edit / list / delete room (UI + API) |
| `04-equipment.spec.js` | Round-trip equipment config across all device types |
| `05-engineer.spec.js` | Engineer page renders without blank screen (PR #60 regression) |
| `06-stream-protection.spec.js` | Stream-protection card present in DOM |
| `07-admin.spec.js` | Admin login, Emails catalog renders templates |

## Configuration

| Env var | Default | Required for |
| --- | --- | --- |
| `PORTAL_BASE_URL` | `https://api.tallyconnect.app` | All tests |
| `PORTAL_EMAIL` | — | All authenticated portal tests |
| `PORTAL_PASSWORD` | — | All authenticated portal tests |
| `ADMIN_EMAIL` | — | `07-admin.spec.js` only |
| `ADMIN_PASSWORD` | — | `07-admin.spec.js` only |

## Notes

- Tests run serially (`workers: 1`) because they hit a single shared
  account — parallel rooms named `e2e-test-room-...` would collide on
  cleanup.
- Cleanup uses an `e2e-test-` prefix on room names. After each room or
  equipment test, every room with that prefix on the test account is
  deleted via `DELETE /api/church/rooms/:id`.
- Failures retain a screenshot, video, and trace under
  `portal-e2e/test-results/`.
- The full HTML report writes to `portal-e2e/playwright-report/` —
  open with `npx playwright show-report portal-e2e/playwright-report`.

## Adding a test

1. Drop a new file in `tests/` named `NN-<topic>.spec.js`.
2. `const { test, expect, loginToPortal } = require('../fixtures/auth');`
3. For state-changing API calls, use `callPortalApi(page, ...)` from
   `fixtures/portalApi.js` — it handles cookies + the CSRF header
   automatically by running `fetch` inside the page context.
4. Prefix any data your test creates with `e2e-test-` so the shared
   cleanup picks it up.
