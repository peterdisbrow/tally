// @ts-check
/**
 * Playwright global teardown — deletes the test church that
 * global-setup.js provisioned, so each run leaves no residue.
 *
 * No-op if .provisioned.json is missing (i.e. nothing was provisioned)
 * or if PORTAL_E2E_KEEP_PROVISIONED=1 is set (handy when debugging a
 * failed run and you want to log into the test account by hand).
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const { loadDotenvFile, ENV_FILE, STATE_FILE } = require('./scripts/lib');

module.exports = async function globalTeardown() {
  const envFromFile = loadDotenvFile(ENV_FILE);
  const env = { ...envFromFile, ...process.env };

  if (env.PORTAL_E2E_KEEP_PROVISIONED === '1') {
    console.log('[global-teardown] PORTAL_E2E_KEEP_PROVISIONED=1 — leaving test church in place.');
    return;
  }
  if (!fs.existsSync(STATE_FILE)) {
    return; // Nothing was auto-provisioned this run.
  }

  const scriptPath = path.join(__dirname, 'scripts', 'deprovision.js');
  const result = spawnSync(process.execPath, [scriptPath], {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    console.warn(`[global-teardown] deprovision exited with code ${result.status}`);
    // Don't throw — we don't want teardown failure to mask test results.
  }
};
