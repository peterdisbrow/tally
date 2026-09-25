/**
 * The e2e harness (including scenario 07) must not talk to production
 * unless someone sets an explicit opt-in. Default is the local lab relay.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('./config');

const TOUCHED = ['RELAY_URL', 'ADMIN_API_KEY', 'E2E_ALLOW_NONLOCAL_RELAY', 'DATABASE_URL', 'JWT_SECRET'];

function withEnv(env, fn) {
  const prev = {};
  for (const key of TOUCHED) {
    prev[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const key of TOUCHED) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

test('e2e defaults to the local lab relay and never to production', () => {
  withEnv({ ADMIN_API_KEY: 'lab-key' }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.relayUrl, 'http://127.0.0.1:3400');
    assert.equal(cfg.wsRelayUrl, 'ws://127.0.0.1:3400');
    assert.doesNotMatch(cfg.relayUrl, /tallyconnect\.app/);
  });
});

test('e2e refuses a non-local RELAY_URL, including production, unless the opt-in flag is set', () => {
  const refused = [
    'https://api.tallyconnect.app',
    'https://api.tallyconnect.app/',
    'http://192.168.1.20:3400',
    'https://example.com',
    'ws://10.0.0.5:3400',
  ];
  for (const relayUrl of refused) {
    withEnv({ ADMIN_API_KEY: 'lab-key', RELAY_URL: relayUrl }, () => {
      assert.throws(() => loadConfig(), /E2E_ALLOW_NONLOCAL_RELAY/, relayUrl);
    });
  }

  withEnv({
    ADMIN_API_KEY: 'lab-key',
    RELAY_URL: 'https://api.tallyconnect.app',
    E2E_ALLOW_NONLOCAL_RELAY: '1',
  }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.relayUrl, 'https://api.tallyconnect.app');
  });
});

test('e2e accepts loopback hosts on any port', () => {
  const ok = [
    ['http://127.0.0.1:3499', 'ws://127.0.0.1:3499'],
    ['http://localhost:3400/', 'ws://localhost:3400'],
    ['http://[::1]:3400', 'ws://[::1]:3400'],
  ];
  for (const [relayUrl, ws] of ok) {
    withEnv({ ADMIN_API_KEY: 'lab-key', RELAY_URL: relayUrl }, () => {
      const cfg = loadConfig();
      assert.equal(cfg.wsRelayUrl, ws, relayUrl);
    });
  }
});
