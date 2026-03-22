/**
 * Tests for relay-client helper functions.
 * Covers: enforceRelayPolicy, decodeChurchIdFromToken, and
 * additional edge cases not covered in relay-url.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_RELAY_URL,
  normalizeRelayUrl,
  isLocalRelayUrl,
  enforceRelayPolicy,
  relayHttpUrl,
  decodeChurchIdFromToken,
} = require('../src/relay-client');

// ─── enforceRelayPolicy ──────────────────────────────────────────────────────

test('enforceRelayPolicy returns default URL for null input', () => {
  assert.equal(enforceRelayPolicy(null), DEFAULT_RELAY_URL);
});

test('enforceRelayPolicy returns default URL for undefined input', () => {
  assert.equal(enforceRelayPolicy(undefined), DEFAULT_RELAY_URL);
});

test('enforceRelayPolicy normalizes http URL', () => {
  const result = enforceRelayPolicy('http://localhost:3000');
  assert.equal(result, 'ws://localhost:3000');
});

test('enforceRelayPolicy normalizes bare domain', () => {
  const result = enforceRelayPolicy('example.com');
  assert.equal(result, 'wss://example.com');
});

test('enforceRelayPolicy strips trailing slashes', () => {
  const result = enforceRelayPolicy('wss://example.com/');
  assert.equal(result, 'wss://example.com');
});

// ─── decodeChurchIdFromToken ─────────────────────────────────────────────────

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesig`;
}

test('decodeChurchIdFromToken returns churchId from token', () => {
  const token = makeJwt({ churchId: 'church-abc-123' });
  const result = decodeChurchIdFromToken(token);
  assert.equal(result, 'church-abc-123');
});

test('decodeChurchIdFromToken returns church_id (snake_case) field', () => {
  const token = makeJwt({ church_id: 'church-xyz-456' });
  const result = decodeChurchIdFromToken(token);
  assert.equal(result, 'church-xyz-456');
});

test('decodeChurchIdFromToken returns null when no churchId in payload', () => {
  const token = makeJwt({ sub: 'user-1', email: 'test@example.com' });
  const result = decodeChurchIdFromToken(token);
  assert.equal(result, null);
});

test('decodeChurchIdFromToken returns null for null token', () => {
  assert.equal(decodeChurchIdFromToken(null), null);
});

test('decodeChurchIdFromToken returns null for undefined token', () => {
  assert.equal(decodeChurchIdFromToken(undefined), null);
});

test('decodeChurchIdFromToken returns null for empty string', () => {
  assert.equal(decodeChurchIdFromToken(''), null);
});

test('decodeChurchIdFromToken returns null for malformed token (not 3 parts)', () => {
  assert.equal(decodeChurchIdFromToken('not.a.valid.jwt'), null);
});

test('decodeChurchIdFromToken returns null when base64 payload is not valid JSON', () => {
  const header = Buffer.from('{}').toString('base64');
  const badBody = 'not-base64-json!!!';
  const token = `${header}.${badBody}.sig`;
  // Should not throw — returns null on decode error
  assert.equal(decodeChurchIdFromToken(token), null);
});

test('decodeChurchIdFromToken handles standard base64 padding variants', () => {
  // Use standard base64url encoding (no padding)
  const payload = { churchId: 'test-church' };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64');
  const token = `header.${body}.sig`;
  const result = decodeChurchIdFromToken(token);
  assert.equal(result, 'test-church');
});

// ─── normalizeRelayUrl — additional cases ─────────────────────────────────────

test('normalizeRelayUrl handles ws:// already set', () => {
  assert.equal(normalizeRelayUrl('ws://localhost:3000'), 'ws://localhost:3000');
});

test('normalizeRelayUrl handles mixed case protocol', () => {
  assert.equal(normalizeRelayUrl('WSS://example.com'), 'WSS://example.com');
});

test('normalizeRelayUrl strips multiple trailing slashes on bare domain', () => {
  const result = normalizeRelayUrl('example.com///');
  assert.equal(result, 'wss://example.com');
});

// ─── isLocalRelayUrl — edge cases ─────────────────────────────────────────────

test('isLocalRelayUrl returns true for 127.0.0.1', () => {
  assert.ok(isLocalRelayUrl('ws://127.0.0.1:3000'));
});

test('isLocalRelayUrl returns false for production URL', () => {
  assert.ok(!isLocalRelayUrl(DEFAULT_RELAY_URL));
});

test('isLocalRelayUrl returns false for empty string', () => {
  // Empty string normalizes to default URL (production)
  assert.ok(!isLocalRelayUrl(''));
});

// ─── relayHttpUrl — edge cases ────────────────────────────────────────────────

test('relayHttpUrl converts wss to https', () => {
  assert.equal(relayHttpUrl('wss://api.example.com'), 'https://api.example.com');
});

test('relayHttpUrl converts ws to http', () => {
  assert.equal(relayHttpUrl('ws://localhost:3001'), 'http://localhost:3001');
});

test('relayHttpUrl with null uses default relay URL', () => {
  const result = relayHttpUrl(null);
  assert.ok(result.startsWith('https://') || result.startsWith('http://'));
});
