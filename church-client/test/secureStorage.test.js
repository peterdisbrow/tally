const test = require('node:test');
const assert = require('node:assert/strict');

const {
  encrypt,
  decrypt,
  encryptConfig,
  decryptConfig,
  findUnencryptedFields,
  SENSITIVE_FIELDS,
} = require('../src/secureStorage');

test('secureStorage encrypt/decrypt round trip', () => {
  const plain = 'super-secret-value';
  const encrypted = encrypt(plain);
  assert.match(encrypted, /^enc:/);
  assert.notEqual(encrypted, plain);
  assert.equal(decrypt(encrypted), plain);
});

test('encryptConfig encrypts only sensitive fields', () => {
  const config = {
    token: 'abc123',
    obsPassword: 'pw',
    relay: 'wss://api.tallyconnect.app',
  };
  const encrypted = encryptConfig(config);
  assert.match(encrypted.token, /^enc:/);
  assert.match(encrypted.obsPassword, /^enc:/);
  assert.equal(encrypted.relay, config.relay);
});

test('decryptConfig restores encrypted sensitive fields', () => {
  const source = {
    token: 'church-app-token',
    facebookAccessToken: 'fb-token',
    relay: 'wss://api.tallyconnect.app',
  };
  const encrypted = encryptConfig(source);
  const decrypted = decryptConfig(encrypted);
  assert.equal(decrypted.token, source.token);
  assert.equal(decrypted.facebookAccessToken, source.facebookAccessToken);
  assert.equal(decrypted.relay, source.relay);
});

test('findUnencryptedFields flags plaintext sensitive keys', () => {
  const raw = { token: 'plaintext-token', relay: 'wss://example.com' };
  const flagged = findUnencryptedFields(raw);
  assert.ok(Array.isArray(flagged));
  assert.ok(flagged.includes('token'));
  assert.ok(!flagged.includes('relay'));
  assert.ok(SENSITIVE_FIELDS.includes('token'));
});
