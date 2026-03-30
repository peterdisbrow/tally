/**
 * Edge-case tests for church-client/src/secureStorage.js
 *
 * Existing secureStorage.test.js covers:
 *   - encrypt/decrypt round trip
 *   - encryptConfig encrypts only sensitive fields
 *   - decryptConfig restores encrypted fields
 *   - findUnencryptedFields flags plaintext sensitive keys
 *
 * This file adds:
 *   - encrypt of null/undefined/empty → passthrough
 *   - decrypt of non-enc: value → passthrough
 *   - decrypt of corrupted ciphertext → null
 *   - encryptConfig skips already-encrypted values (no double-encryption)
 *   - decryptConfig passes through plaintext values for non-sensitive fields
 *   - findUnencryptedFields with empty config
 *   - findUnencryptedFields ignores already-encrypted values
 *   - findUnencryptedFields with all fields missing
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  encrypt,
  decrypt,
  isEncrypted,
  encryptConfig,
  decryptConfig,
  findUnencryptedFields,
  SENSITIVE_FIELDS,
} = require('../src/secureStorage');

// ─── encrypt edge cases ───────────────────────────────────────────────────────

test('encrypt returns the original value unchanged when given null', () => {
  // The source code says: if (!plaintext) return plaintext;
  assert.equal(encrypt(null), null);
});

test('encrypt returns the original value unchanged when given undefined', () => {
  assert.equal(encrypt(undefined), undefined);
});

test('encrypt returns empty string unchanged when given empty string', () => {
  assert.equal(encrypt(''), '');
});

test('encrypt returns the original value unchanged when given 0 (falsy)', () => {
  assert.equal(encrypt(0), 0);
});

// ─── decrypt edge cases ───────────────────────────────────────────────────────

test('decrypt returns the value unchanged when it does not start with "enc:"', () => {
  assert.equal(decrypt('plaintext-value'), 'plaintext-value');
  assert.equal(decrypt('wss://api.tallyconnect.app'), 'wss://api.tallyconnect.app');
});

test('decrypt returns the value unchanged for empty string', () => {
  // if (!value) return value — '' is falsy
  assert.equal(decrypt(''), '');
});

test('decrypt returns null for a corrupted enc: payload', () => {
  // Not a valid base64+AES-GCM pack — should return null (not throw)
  const corrupted = 'enc:aGVsbG93b3JsZA=='; // valid base64 but wrong ciphertext length
  const result = decrypt(corrupted);
  assert.equal(result, null);
});

test('decrypt returns null for truncated ciphertext', () => {
  // Only 4 bytes — too short for iv(12) + tag(16) + ciphertext
  const truncated = 'enc:' + Buffer.from([0x01, 0x02, 0x03, 0x04]).toString('base64');
  const result = decrypt(truncated);
  assert.equal(result, null);
});

// ─── isEncrypted ──────────────────────────────────────────────────────────────

test('isEncrypted returns true for enc:-prefixed values', () => {
  const enc = encrypt('hello');
  assert.ok(isEncrypted(enc));
});

test('isEncrypted returns false for plaintext values', () => {
  assert.equal(isEncrypted('plaintext'), false);
  assert.equal(isEncrypted('wss://api.example.com'), false);
});

test('isEncrypted returns false for null/undefined', () => {
  assert.equal(isEncrypted(null), false);
  assert.equal(isEncrypted(undefined), false);
});

test('isEncrypted returns false for empty string', () => {
  assert.equal(isEncrypted(''), false);
});

// ─── encryptConfig idempotency ────────────────────────────────────────────────

test('encryptConfig does not double-encrypt already-encrypted values', () => {
  const config = { token: 'my-token', relay: 'https://example.com' };
  const once = encryptConfig(config);
  const twice = encryptConfig(once);
  // Encrypting twice should produce the same enc: value (not nested)
  assert.equal(once.token, twice.token);
  assert.equal(once.relay, twice.relay);
});

test('encryptConfig preserves non-sensitive fields exactly', () => {
  const config = {
    token: 'secret',
    relay: 'wss://api.tallyconnect.app',
    churchName: 'First Baptist',
    reconnectInterval: 5000,
  };
  const result = encryptConfig(config);
  assert.equal(result.relay, config.relay);
  assert.equal(result.churchName, config.churchName);
  assert.equal(result.reconnectInterval, config.reconnectInterval);
});

test('encryptConfig skips undefined sensitive fields (does not add them)', () => {
  const config = { relay: 'wss://api.example.com' };
  const result = encryptConfig(config);
  // No token was present — it should not appear in output
  assert.equal(result.token, undefined);
});

// ─── decryptConfig edge cases ─────────────────────────────────────────────────

test('decryptConfig leaves plaintext sensitive fields unchanged (not encrypted = not decrypted)', () => {
  // If a field was not encrypted (e.g., legacy plaintext), decryptConfig should not touch it
  const config = { token: 'plaintext-token', relay: 'wss://api.example.com' };
  const result = decryptConfig(config);
  // Since token does not start with enc:, isEncrypted is false → decryptConfig skips it
  assert.equal(result.token, 'plaintext-token');
});

test('decryptConfig round-trips all SENSITIVE_FIELDS correctly', () => {
  const config = {};
  for (const field of SENSITIVE_FIELDS) {
    config[field] = `test-value-for-${field}`;
  }
  const encrypted = encryptConfig(config);
  const decrypted = decryptConfig(encrypted);
  for (const field of SENSITIVE_FIELDS) {
    assert.equal(decrypted[field], config[field], `Field ${field} should round-trip`);
  }
});

test('decryptConfig blanks a field when decrypt returns null (wrong machine / corruption)', () => {
  // Simulate an encrypted value that cannot be decrypted on this machine:
  // enc: prefix followed by garbage base64 that will fail GCM auth
  const config = { token: 'enc:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
  const result = decryptConfig(config);
  assert.equal(result.token, '', 'corrupted encrypted field should be blanked');
});

// ─── findUnencryptedFields edge cases ────────────────────────────────────────

test('findUnencryptedFields returns empty array for an empty config', () => {
  const flagged = findUnencryptedFields({});
  assert.deepEqual(flagged, []);
});

test('findUnencryptedFields returns empty array when all sensitive fields are missing', () => {
  const config = { relay: 'wss://api.tallyconnect.app', reconnectInterval: 5000 };
  const flagged = findUnencryptedFields(config);
  assert.deepEqual(flagged, []);
});

test('findUnencryptedFields does not flag already-encrypted values', () => {
  const config = { token: encrypt('my-token') };
  const flagged = findUnencryptedFields(config);
  assert.ok(!flagged.includes('token'), 'encrypted token should not be flagged');
});

test('findUnencryptedFields flags all plaintext sensitive fields', () => {
  const config = {};
  for (const field of SENSITIVE_FIELDS) {
    config[field] = 'plaintext-secret';
  }
  const flagged = findUnencryptedFields(config);
  assert.deepEqual(flagged.sort(), [...SENSITIVE_FIELDS].sort());
});

test('SENSITIVE_FIELDS includes expected credential types', () => {
  assert.ok(SENSITIVE_FIELDS.includes('token'), 'should include token');
  assert.ok(SENSITIVE_FIELDS.includes('obsPassword'), 'should include obsPassword');
  assert.ok(SENSITIVE_FIELDS.includes('rtmpStreamKey'), 'should include rtmpStreamKey');
  assert.ok(SENSITIVE_FIELDS.includes('adminApiKey'), 'should include adminApiKey');
});
