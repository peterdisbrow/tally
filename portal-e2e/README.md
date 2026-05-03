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
# edit portal-e2e/.env — fill in ADMIN_API_KEY for auto-provisioning
# (or PORTAL_EMAIL / PORTAL_PASSWORD if you want to use a pre-existing account)
```

## Running

```bash
npm run test:portal              # full suite, headless
npm run test:portal:headed       # watch the browser drive the UI
npm run test:portal:ui           # interactive Playwright UI mode
npx playwright test 01-auth      # single spec
```

A test church is provisioned automatically before each run when
`ADMIN_API_KEY` is set, and deleted afterward. See the next section.

## Auto-provisioning

The suite's preferred mode is to **create a fresh, dedicated test church
on each run** — that way no state from previous runs (rooms, equipment
configs) ever leaks across tests, and there's no shared password to
manage.

How it works:

- `playwright.config.js` runs [`global-setup.js`](global-setup.js) before
  the first test.
- If `ADMIN_API_KEY` is set, global-setup invokes
  [`scripts/provision.js`](scripts/provision.js), which POSTs to the
  admin endpoint `/api/churches/register` with a unique
  `e2e-test+<timestamp>@tallyconnect.app` portal email and a generated
  password. The admin endpoint creates the church with
  `billing_status='active'` and skips the email-verification flow, so
  the account can immediately log in.
- The new credentials are written to `portal-e2e/.env.provisioned`
  (git-ignored) and the playwright config loads them with override
  precedence over `.env`.
- After the suite finishes, [`global-teardown.js`](global-teardown.js)
  invokes [`scripts/deprovision.js`](scripts/deprovision.js), which
  hits `DELETE /api/churches/:churchId` and removes the local state
  files.

You can also run the provisioning step on its own:

```bash
npm run test:portal:provision      # create a test church, write .env.provisioned
npm run test:portal:deprovision    # delete that church + state files
```

If `ADMIN_API_KEY` is not set, global-setup is a no-op and the suite
falls back to whatever `PORTAL_EMAIL` / `PORTAL_PASSWORD` is in
`portal-e2e/.env`.

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
| `ADMIN_API_KEY` | — | Auto-provisioning (recommended) |
| `PORTAL_EMAIL` | — | Manual fallback (when not auto-provisioning) |
| `PORTAL_PASSWORD` | — | Manual fallback (when not auto-provisioning) |
| `ADMIN_EMAIL` | — | `07-admin.spec.js` only |
| `ADMIN_PASSWORD` | — | `07-admin.spec.js` only |
| `PORTAL_E2E_EMAIL_USER` | `e2e-test` | Local-part of provisioned email |
| `PORTAL_E2E_EMAIL_DOMAIN` | `tallyconnect.app` | Domain of provisioned email |
| `PORTAL_E2E_TIER` | `connect` | Billing tier seeded on the church |
| `PORTAL_E2E_SKIP_PROVISION` | — | `=1` to disable auto-provisioning for one run |
| `PORTAL_E2E_KEEP_PROVISIONED` | — | `=1` to skip teardown (debug a failed run) |

## Notes

- Tests run serially (`workers: 1`) because they hit a single shared
  account during a run.
- Cleanup on a per-test basis still uses an `e2e-test-` prefix on room
  names — that protects the manual-fallback account from accumulating
  rooms in the rare case the church-level teardown is skipped.
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
