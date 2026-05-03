// @ts-check
/**
 * Playwright global setup — provisions a fresh test church before the
 * suite runs, IF the harness is configured to do so.
 *
 * Auto-provisioning kicks in when ADMIN_API_KEY is available and
 * PORTAL_E2E_SKIP_PROVISION is unset. Otherwise this no-ops and the
 * suite uses whatever credentials are already in portal-e2e/.env.
 *
 * The Playwright config also reads .env.provisioned (which provision.js
 * writes), so the just-created credentials are visible to every worker.
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { loadDotenvFile, ENV_FILE, STATE_FILE } = require('./scripts/lib');
const fs = require('node:fs');

module.exports = async function globalSetup() {
  // Reload .env into process.env so we can decide what to do.
  const envFromFile = loadDotenvFile(ENV_FILE);
  const env = { ...envFromFile, ...process.env };

  if (env.PORTAL_E2E_SKIP_PROVISION === '1') {
    console.log('[global-setup] PORTAL_E2E_SKIP_PROVISION=1 — using existing credentials.');
    return;
  }
  if (!env.ADMIN_API_KEY) {
    console.log('[global-setup] ADMIN_API_KEY not set — skipping auto-provisioning.');
    console.log('[global-setup] Tests will use credentials from portal-e2e/.env (if any).');
    return;
  }

  // If a previous run left state behind, clean it up before starting fresh.
  if (fs.existsSync(STATE_FILE)) {
    console.log('[global-setup] Found stale .provisioned.json — cleaning up before re-provisioning.');
    runScript('deprovision.js', env);
  }

  const result = runScript('provision.js', env);
  if (result.status !== 0) {
    throw new Error(`[global-setup] provisioning failed with exit code ${result.status}`);
  }

  // Re-import lib to read the freshly-written .env.provisioned and push
  // its values into process.env so any code path that reads creds before
  // playwright.config.js's dotenv loader runs in a worker still sees them.
  const provisioned = loadDotenvFile(path.join(__dirname, '.env.provisioned'));
  for (const [k, v] of Object.entries(provisioned)) {
    if (!process.env[k]) process.env[k] = v;
  }
};

function runScript(name, env) {
  const scriptPath = path.join(__dirname, 'scripts', name);
  return spawnSync(process.execPath, [scriptPath], {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
}
