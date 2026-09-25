/**
 * Loads the environment the E2E harness needs. Scenario 07 and every other
 * scenario in this folder go through loadConfig().
 *
 * The relay defaults to the local lab (http://127.0.0.1:3400). A RELAY_URL
 * whose host is not loopback is refused, so a shell that still has the old
 * production URL cannot hit api.tallyconnect.app by accident. The only way
 * past that is E2E_ALLOW_NONLOCAL_RELAY=1, set on purpose.
 *
 * Required:
 *   ADMIN_API_KEY      — for creating + deleting the test church
 *
 * Optional:
 *   RELAY_URL          — defaults to http://127.0.0.1:3400. Loopback only
 *                        unless E2E_ALLOW_NONLOCAL_RELAY=1
 *   DATABASE_URL       — only used by cron-trigger scenarios
 *   JWT_SECRET         — only needed if minting tokens locally
 *   E2E_TEST_PREFIX    — defaults to 'test-e2e-'; all generated rows use this
 *   E2E_KEEP_ACCOUNT   — '1' to skip teardown (debug after a failure)
 *   E2E_LOG_LEVEL      — 'debug' for verbose, 'info' (default), 'silent'
 *   E2E_ALLOW_NONLOCAL_RELAY — '1' to allow a RELAY_URL that is not loopback
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

const LOCAL_RELAY_DEFAULT = 'http://127.0.0.1:3400';

function relayHostname(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`[e2e] RELAY_URL is not a URL: ${url}`);
  }
  return String(parsed.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
}

function isLoopbackHost(host) {
  if (host === 'localhost' || host === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function assertLocalRelay(url) {
  const host = relayHostname(url);
  if (isLoopbackHost(host)) return;
  if (process.env.E2E_ALLOW_NONLOCAL_RELAY === '1') return;
  throw new Error(
    `[e2e] refusing non-local RELAY_URL ${url} (host ${host || '(none)'}). ` +
    'This harness talks to a real relay. It only runs against 127.0.0.1, localhost, or ::1. ' +
    'Set E2E_ALLOW_NONLOCAL_RELAY=1 if you really mean a different relay. ' +
    'Do not point it at production (api.tallyconnect.app).'
  );
}

function loadConfig({ requireDatabase = false } = {}) {
  const relayUrl = envOr('RELAY_URL', LOCAL_RELAY_DEFAULT).replace(/\/+$/, '');
  assertLocalRelay(relayUrl);
  const cfg = {
    relayUrl,
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
