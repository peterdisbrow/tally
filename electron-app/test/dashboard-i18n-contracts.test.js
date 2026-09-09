'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { t, setLocale, LOCALES } = require('../src/i18n');

const RENDERER = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');

const SUNDAY_KEYS = [
  'status.connected',
  'status.disconnected',
  'status.noInternet',
  'status.offlineMode',
  'status.relayOffline',
  'status.online',
  'status.relayConnected',
  'status.relayOfflineShort',
  'status.monitoring',
  'status.stopped',
  'dashboard.noInternetConnection',
  'dashboard.relayUnreachable',
  'dashboard.reconnected',
  'dashboard.reconnectingIn',
  'dashboard.reconnecting',
  'dashboard.lastRelayConnection',
  'dashboard.noRelaySinceStart',
  'errors.relayLostReconnecting',
  'errors.sessionInvalidated',
  'tray.offlineLocal',
  'tray.agentStopped',
  'tray.clientPortal',
  'notifications.relayOffline',
  'notifications.relayOfflineBody',
];

function lookup(dict, key) {
  let obj = dict;
  for (const p of key.split('.')) obj = obj && typeof obj === 'object' ? obj[p] : undefined;
  return obj;
}

test('Sunday offline/status keys exist in en and es', () => {
  for (const key of SUNDAY_KEYS) {
    assert.equal(typeof lookup(LOCALES.en, key), 'string', `en missing ${key}`);
    assert.equal(typeof lookup(LOCALES.es, key), 'string', `es missing ${key}`);
  }
});

test('i18n.t resolves Spanish offline banner copy', () => {
  setLocale('es');
  assert.match(t('dashboard.relayUnreachable'), /Relay inalcanzable/);
  assert.match(t('dashboard.reconnected'), /Reconectado/);
  assert.equal(t('dashboard.reconnectingIn', { seconds: 8 }), 'Reconectando en 8s...');
  setLocale('en');
  assert.match(t('dashboard.relayUnreachable'), /Relay unreachable/);
});

test('renderer loads locale data and uses t() for offline banner + reconnect toast', () => {
  assert.match(RENDERER, /async function initI18n\(/);
  assert.match(RENDERER, /await initI18n\(\)/);
  assert.match(RENDERER, /t\('dashboard\.relayUnreachable'\)/);
  assert.match(RENDERER, /t\('dashboard\.noInternetConnection'\)/);
  assert.match(RENDERER, /t\('dashboard\.reconnected'\)/);
  assert.match(RENDERER, /t\('status\.offlineMode'\)/);
  assert.match(RENDERER, /t\('errors\.relayLostReconnecting'\)/);
});
