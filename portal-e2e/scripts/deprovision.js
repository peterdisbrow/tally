#!/usr/bin/env node
// @ts-check
/**
 * Tear down the test church created by provision.js. Deletes the church
 * via the admin endpoint DELETE /api/churches/:churchId, then removes
 * the local state files.
 *
 * Reads the churchId from portal-e2e/.provisioned.json and the admin
 * key from ADMIN_API_KEY (env or portal-e2e/.env). Idempotent: a missing
 * state file is treated as "nothing to do" and exits 0.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const {
  loadEnv,
  readState,
  removeState,
  removeProvisionedEnv,
  callRelay,
} = require('./lib');

async function main() {
  const env = { ...loadEnv(), ...process.env };
  const adminKey = env.ADMIN_API_KEY;
  const state = readState();

  if (!state) {
    console.log('[deprovision] No .provisioned.json found — nothing to clean up.');
    return;
  }

  if (!adminKey) {
    console.error('[deprovision] ADMIN_API_KEY is required to delete the church.');
    console.error('[deprovision] State file kept so you can retry once the key is available.');
    process.exit(2);
  }

  const baseUrl = state.baseUrl || env.PORTAL_BASE_URL || 'https://api.tallyconnect.app';
  console.log(`[deprovision] Deleting church ${state.churchId} (${state.name}) on ${baseUrl}…`);

  const resp = await callRelay(baseUrl, 'DELETE', `/api/churches/${encodeURIComponent(state.churchId)}`, {
    adminApiKey: adminKey,
  });

  if (resp.ok || resp.status === 404) {
    if (resp.status === 404) {
      console.log('[deprovision] Church already gone (404) — clearing local state anyway.');
    } else {
      console.log('[deprovision] ✓ Church deleted');
    }
    removeState();
    removeProvisionedEnv();
    return;
  }

  console.error(`[deprovision] Failed: HTTP ${resp.status}`);
  console.error(`[deprovision] ${typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body)}`);
  console.error('[deprovision] State file kept so you can retry.');
  process.exit(1);
}

main().catch((e) => {
  console.error('[deprovision] Unexpected error:', e);
  process.exit(1);
});
