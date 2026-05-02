/**
 * Loads + validates the environment the E2E harness needs to run against
 * production Neon and api.tallyconnect.app.
 *
 * Required:
 *   RELAY_URL          — defaults to https://api.tallyconnect.app
 *   ADMIN_API_KEY      — for creating + deleting the test church
 *   DATABASE_URL       — Neon Postgres URL (only used by cron-trigger scenarios)
 *   JWT_SECRET         — only needed if minting tokens locally (we don't, but
 *                        cron scenarios may need it for queryClient bootstrapping)
 *
 * Optional:
 *   E2E_TEST_PREFIX    — defaults to 'test-e2e-'; all generated rows use this
 *   E2E_KEEP_ACCOUNT   — '1' to skip teardown (debug after a failure)
 *   E2E_LOG_LEVEL      — 'debug' for verbose, 'info' (default), 'silent'
 */

'use strict';

function envOr(name, fallback, { required = false } = {}) {
  const value = process.env[name];
  if (value !== undefined && String(value).length > 0) return value;
  if (required) {
    throw new Error(`[e2e] missing required env ${name}`);
  }
  return fallback;
}

function loadConfig({ requireDatabase = false } = {}) {
  const cfg = {
    relayUrl: envOr('RELAY_URL', 'https://api.tallyconnect.app').replace(/\/+$/, ''),
    adminApiKey: envOr('ADMIN_API_KEY', null, { required: true }),
    databaseUrl: envOr('DATABASE_URL', null, { required: requireDatabase }),
    jwtSecret: envOr('JWT_SECRET', null),
    testPrefix: envOr('E2E_TEST_PREFIX', 'test-e2e-'),
    keepAccount: envOr('E2E_KEEP_ACCOUNT', '0') === '1',
    logLevel: envOr('E2E_LOG_LEVEL', 'info'),
  };
  cfg.wsRelayUrl = cfg.relayUrl.replace(/^http/, 'ws');
  return cfg;
}

module.exports = { loadConfig };
