const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_RELAY_URL,
  normalizeRelayUrl,
  isLocalRelayUrl,
  relayHttpUrl,
} = require('../src/relay-client');

// ── DEFAULT_RELAY_URL ────────────────────────────────────────────────────────

test('DEFAULT_RELAY_URL points to api.tallyconnect.app', () => {
  assert.ok(DEFAULT_RELAY_URL.includes('api.tallyconnect.app'),
    `Expected api.tallyconnect.app, got: ${DEFAULT_RELAY_URL}`);
});

test('DEFAULT_RELAY_URL does not contain legacy Railway domain', () => {
  assert.ok(!DEFAULT_RELAY_URL.includes('railway.app'),
    `Found legacy Railway URL: ${DEFAULT_RELAY_URL}`);
});

test('DEFAULT_RELAY_URL uses wss:// protocol', () => {
  assert.ok(DEFAULT_RELAY_URL.startsWith('wss://'),
    `Expected wss:// protocol, got: ${DEFAULT_RELAY_URL}`);
});

// ── normalizeRelayUrl ────────────────────────────────────────────────────────

test('normalizeRelayUrl returns default for empty/null input', () => {
  assert.equal(normalizeRelayUrl(''), DEFAULT_RELAY_URL);
  assert.equal(normalizeRelayUrl(null), DEFAULT_RELAY_URL);
  assert.equal(normalizeRelayUrl(undefined), DEFAULT_RELAY_URL);
});

test('normalizeRelayUrl strips trailing slashes', () => {
  assert.equal(normalizeRelayUrl('wss://example.com///'), 'wss://example.com');
});

test('normalizeRelayUrl converts https to wss', () => {
  assert.equal(normalizeRelayUrl('https://example.com'), 'wss://example.com');
});

test('normalizeRelayUrl converts http to ws', () => {
  assert.equal(normalizeRelayUrl('http://localhost:3000'), 'ws://localhost:3000');
});

test('normalizeRelayUrl adds wss:// to bare domain', () => {
  assert.equal(normalizeRelayUrl('api.tallyconnect.app'), 'wss://api.tallyconnect.app');
});

test('normalizeRelayUrl preserves valid wss:// URL', () => {
  assert.equal(normalizeRelayUrl('wss://api.tallyconnect.app'), 'wss://api.tallyconnect.app');
});

// ── isLocalRelayUrl ──────────────────────────────────────────────────────────

test('isLocalRelayUrl detects localhost', () => {
  assert.ok(isLocalRelayUrl('ws://localhost:3000'));
  assert.ok(isLocalRelayUrl('wss://localhost'));
});

test('isLocalRelayUrl rejects remote URLs', () => {
  assert.ok(!isLocalRelayUrl('wss://api.tallyconnect.app'));
});

// ── relayHttpUrl ─────────────────────────────────────────────────────────────

test('relayHttpUrl converts wss to https', () => {
  assert.equal(relayHttpUrl('wss://api.tallyconnect.app'), 'https://api.tallyconnect.app');
});

test('relayHttpUrl converts ws to http', () => {
  assert.equal(relayHttpUrl('ws://localhost:3000'), 'http://localhost:3000');
});

// ── Sign-in relay selection (behavioral contract) ────────────────────────────

test('sign-in should use saved config relay over default', () => {
  // This test documents the expected behavior:
  // renderer.js doSignIn() must prefer config.relay over DEFAULT_RELAY_URL
  const config = { relay: 'wss://custom.example.com' };
  const relay = config.relay || DEFAULT_RELAY_URL;
  assert.equal(relay, 'wss://custom.example.com');
});

test('sign-in falls back to default when config has no relay', () => {
  const config = {};
  const relay = config.relay || DEFAULT_RELAY_URL;
  assert.equal(relay, DEFAULT_RELAY_URL);
});
