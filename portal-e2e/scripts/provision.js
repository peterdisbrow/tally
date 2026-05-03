#!/usr/bin/env node
// @ts-check
/**
 * Provision a fresh, dedicated E2E test church on the relay so the
 * Playwright suite always runs against a clean account.
 *
 * Calls the admin endpoint POST /api/churches/register with an x-api-key
 * header. The admin endpoint sets billing_status='active' by default and
 * skips the email-verification flow, so the resulting account can log in
 * to /church-portal immediately — no email click required.
 *
 * Output: writes credentials to portal-e2e/.env.provisioned and tracks
 * the churchId in portal-e2e/.provisioned.json so the deprovision script
 * (and Playwright global teardown) can clean it up afterward.
 *
 * Required env vars:
 *   ADMIN_API_KEY     — the relay's admin key (matches relay's process.env)
 *
 * Optional env vars:
 *   PORTAL_BASE_URL              — default https://api.tallyconnect.app
 *   PORTAL_E2E_EMAIL_DOMAIN      — default tallyconnect.app (plus-addressed)
 *   PORTAL_E2E_EMAIL_USER        — local-part prefix (default "e2e-test")
 *   PORTAL_E2E_TIER              — billing tier (default "connect")
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const {
  loadEnv,
  writeProvisionedEnv,
  writeState,
  buildTestAccount,
  callRelay,
} = require('./lib');

async function main() {
  const env = { ...loadEnv(), ...process.env };
  const baseUrl = env.PORTAL_BASE_URL || 'https://api.tallyconnect.app';
  const adminKey = env.ADMIN_API_KEY;
  const tier = env.PORTAL_E2E_TIER || 'connect';
  const emailDomain = env.PORTAL_E2E_EMAIL_DOMAIN;

  if (!adminKey) {
    console.error('[provision] ADMIN_API_KEY is required.');
    console.error('[provision] Set it in portal-e2e/.env or your shell environment.');
    console.error('[provision] See portal-e2e/.env.example for details.');
    process.exit(2);
  }

  const account = buildTestAccount(emailDomain);
  console.log(`[provision] Creating test church "${account.name}" on ${baseUrl}…`);

  const resp = await callRelay(baseUrl, 'POST', '/api/churches/register', {
    adminApiKey: adminKey,
    body: {
      name: account.name,
      email: account.email,
      portalEmail: account.email,
      password: account.password,
      tier,
      billingStatus: 'active',
    },
  });

  if (!resp.ok) {
    console.error(`[provision] Failed: HTTP ${resp.status}`);
    console.error(`[provision] ${typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body)}`);
    process.exit(1);
  }

  const { churchId, name, portalEmail } = resp.body;
  if (!churchId) {
    console.error('[provision] Response missing churchId:', resp.body);
    process.exit(1);
  }

  writeState({
    provisionedAt: new Date().toISOString(),
    baseUrl,
    churchId,
    name,
    portalEmail: portalEmail || account.email,
  });

  writeProvisionedEnv({
    PORTAL_BASE_URL: baseUrl,
    PORTAL_EMAIL: portalEmail || account.email,
    PORTAL_PASSWORD: account.password,
    PORTAL_CHURCH_ID: churchId,
  });

  console.log(`[provision] ✓ Church created`);
  console.log(`[provision]   churchId : ${churchId}`);
  console.log(`[provision]   name     : ${name}`);
  console.log(`[provision]   email    : ${portalEmail || account.email}`);
  console.log(`[provision] Credentials written to portal-e2e/.env.provisioned`);
}

main().catch((e) => {
  console.error('[provision] Unexpected error:', e);
  process.exit(1);
});
