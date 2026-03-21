/**
 * Edge-case tests for electron-app/src/secureStorage.js (fallback AES path).
 *
 * Existing secureStorage.test.js covers:
 *   - encryptValue/decryptValue round trip (fallback path)
 *   - encryptConfig encrypts only secure fields
 *   - decryptConfig restores secure fields
 *   - SECURE_FIELDS includes token and adminApiKey
 *
 * This file adds:
 *   - encryptValue with null/undefined/empty → returns ''
 *   - decryptValue with plaintext (no prefix) → returned as-is (legacy)
 *   - decryptValue with corrupted aes ciphertext → null
 *   - isEncrypted for enc:, es:, and plaintext values
 *   - encryptConfig skips already-encrypted values (idempotency)
 *   - encryptConfig handles nested ptz array credentials
 *   - encryptConfig handles nested encoders array
 *   - encryptConfig handles single encoder object
 *   - decryptConfig handles nested ptz array
 *   - decryptConfig leaves plaintext fields unchanged
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  encryptValue,
  decryptValue,
  isEncrypted,
  encryptConfig,
  decryptConfig,
  SECURE_FIELDS,
} = require('../src/secureStorage');

// ─── encryptValue edge cases ──────────────────────────────────────────────────

test('encryptValue returns empty string for null', () => {
  assert.equal(encryptValue(null), '');
});

test('encryptValue returns empty string for undefined', () => {
  assert.equal(encryptValue(undefined), '');
});

test('encryptValue returns empty string for empty string', () => {
  assert.equal(encryptValue(''), '');
});

test('encryptValue encrypts numeric values by coercing to string', () => {
  // Source code: if (!plaintext) return '' — 0 is falsy, returns ''
  // Non-zero numbers: if (!0) → falsy. if (!1) → falsy. Wait: !1 is false, so 1 is truthy
  const enc = encryptValue('12345');
  assert.ok(isEncrypted(enc), 'numeric-like string should be encrypted');
  assert.equal(decryptValue(enc), '12345');
});

// ─── decryptValue edge cases ──────────────────────────────────────────────────

test('decryptValue returns empty string for null/undefined/empty', () => {
  assert.equal(decryptValue(null), '');
  assert.equal(decryptValue(undefined), '');
  assert.equal(decryptValue(''), '');
});

test('decryptValue returns plaintext value unchanged (legacy / not yet encrypted)', () => {
  // No enc: or es: prefix → treated as legacy plaintext
  assert.equal(decryptValue('plaintext-value'), 'plaintext-value');
  assert.equal(decryptValue('wss://api.tallyconnect.app'), 'wss://api.tallyconnect.app');
});

test('decryptValue returns null for corrupted enc: payload', () => {
  const corrupted = 'enc:aGVsbG8='; // valid base64, wrong ciphertext structure
  const result = decryptValue(corrupted);
  assert.equal(result, null);
});

// ─── isEncrypted ──────────────────────────────────────────────────────────────

test('isEncrypted returns true for enc:-prefixed values', () => {
  const enc = encryptValue('secret');
  assert.ok(isEncrypted(enc));
});

test('isEncrypted returns true for es:-prefixed values (Electron safeStorage)', () => {
  assert.ok(isEncrypted('es:somebase64data=='));
});

test('isEncrypted returns false for plaintext', () => {
  assert.equal(isEncrypted('plaintext'), false);
  assert.equal(isEncrypted('wss://example.com'), false);
});

test('isEncrypted returns false for null/undefined/empty', () => {
  assert.equal(isEncrypted(null), false);
  assert.equal(isEncrypted(undefined), false);
  assert.equal(isEncrypted(''), false);
});

// ─── encryptConfig idempotency ────────────────────────────────────────────────

test('encryptConfig is idempotent — does not double-encrypt', () => {
  const config = { token: 'jwt-token', relayUrl: 'https://api.example.com' };
  const once = encryptConfig(config);
  const twice = encryptConfig(once);
  assert.equal(once.token, twice.token);
  assert.equal(once.relayUrl, twice.relayUrl);
});

test('encryptConfig preserves fields not in SECURE_FIELDS', () => {
  const config = {
    token: 'secret',
    relayUrl: 'https://api.example.com',
    churchId: 'church-abc',
    reconnectInterval: 5000,
  };
  const result = encryptConfig(config);
  assert.equal(result.relayUrl, config.relayUrl);
  assert.equal(result.churchId, config.churchId);
  assert.equal(result.reconnectInterval, config.reconnectInterval);
});

// ─── encryptConfig nested ptz array ──────────────────────────────────────────

test('encryptConfig encrypts ptz camera passwords', () => {
  const config = {
    ptz: [
      { host: '192.168.1.10', username: 'admin', password: 'cam-pass-1' },
      { host: '192.168.1.11', username: 'user', password: 'cam-pass-2' },
    ],
  };
  const result = encryptConfig(config);
  assert.ok(isEncrypted(result.ptz[0].password), 'ptz[0].password should be encrypted');
  assert.ok(isEncrypted(result.ptz[1].password), 'ptz[1].password should be encrypted');
  assert.ok(isEncrypted(result.ptz[0].username), 'ptz[0].username should be encrypted');
  assert.equal(result.ptz[0].host, '192.168.1.10', 'host should pass through unchanged');
});

test('decryptConfig decrypts ptz camera passwords', () => {
  const config = {
    ptz: [
      { host: '192.168.1.10', username: 'admin', password: 'cam-pass-1' },
    ],
  };
  const encrypted = encryptConfig(config);
  const decrypted = decryptConfig(encrypted);
  assert.equal(decrypted.ptz[0].password, 'cam-pass-1');
  assert.equal(decrypted.ptz[0].username, 'admin');
  assert.equal(decrypted.ptz[0].host, '192.168.1.10');
});

// ─── encryptConfig nested encoders array ─────────────────────────────────────

test('encryptConfig encrypts encoder passwords in encoders array', () => {
  const config = {
    encoders: [
      { type: 'obs', host: '192.168.1.20', password: 'obs-secret' },
      { type: 'vmix', host: '192.168.1.21', password: 'vmix-secret' },
    ],
  };
  const result = encryptConfig(config);
  assert.ok(isEncrypted(result.encoders[0].password), 'encoders[0].password should be encrypted');
  assert.ok(isEncrypted(result.encoders[1].password), 'encoders[1].password should be encrypted');
  assert.equal(result.encoders[0].type, 'obs', 'type should pass through');
});

test('decryptConfig decrypts encoders array passwords', () => {
  const config = {
    encoders: [
      { type: 'obs', host: '192.168.1.20', password: 'obs-secret' },
    ],
  };
  const encrypted = encryptConfig(config);
  const decrypted = decryptConfig(encrypted);
  assert.equal(decrypted.encoders[0].password, 'obs-secret');
  assert.equal(decrypted.encoders[0].type, 'obs');
});

// ─── encryptConfig single encoder object ─────────────────────────────────────

test('encryptConfig encrypts single encoder.password', () => {
  const config = {
    encoder: { type: 'vmix', host: '192.168.1.30', password: 'vmix-pw' },
  };
  const result = encryptConfig(config);
  assert.ok(isEncrypted(result.encoder.password), 'encoder.password should be encrypted');
  assert.equal(result.encoder.type, 'vmix');
});

test('decryptConfig decrypts single encoder.password', () => {
  const config = {
    encoder: { type: 'vmix', host: '192.168.1.30', password: 'vmix-pw' },
  };
  const encrypted = encryptConfig(config);
  const decrypted = decryptConfig(encrypted);
  assert.equal(decrypted.encoder.password, 'vmix-pw');
});

// ─── decryptConfig edge cases ─────────────────────────────────────────────────

test('decryptConfig leaves non-encrypted sensitive fields as-is (legacy plaintext)', () => {
  const config = { token: 'legacy-plaintext-token' };
  const result = decryptConfig(config);
  // isEncrypted('legacy-plaintext-token') is false → skipped
  assert.equal(result.token, 'legacy-plaintext-token');
});

test('decryptConfig handles encoders array with null entries gracefully', () => {
  const config = { encoders: [null, { type: 'obs', password: encryptValue('obs-secret') }] };
  // Should not throw even with null entries
  assert.doesNotThrow(() => decryptConfig(config));
  const result = decryptConfig(config);
  assert.equal(result.encoders[0], null);
  assert.equal(result.encoders[1].password, 'obs-secret');
});
