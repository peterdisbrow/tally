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

test('secureStorage fallback encryption round trip works outside Electron runtime', () => {
  const plain = 'relay-admin-key';
  const encrypted = encryptValue(plain);
  assert.equal(isEncrypted(encrypted), true);
  assert.equal(decryptValue(encrypted), plain);
});

test('encryptConfig only encrypts secure fields', () => {
  const config = {
    token: 'jwt-token',
    obsPassword: 'obs-pass',
    relayUrl: 'https://api.tallyconnect.app',
  };
  const encrypted = encryptConfig(config);
  assert.equal(isEncrypted(encrypted.token), true);
  assert.equal(isEncrypted(encrypted.obsPassword), true);
  assert.equal(encrypted.relayUrl, config.relayUrl);
});

test('decryptConfig restores secure fields', () => {
  const source = {
    adminApiKey: 'admin-secret',
    twitchStreamKey: 'stream-key',
    relayUrl: 'https://api.tallyconnect.app',
  };
  const encrypted = encryptConfig(source);
  const decrypted = decryptConfig(encrypted);
  assert.equal(decrypted.adminApiKey, source.adminApiKey);
  assert.equal(decrypted.twitchStreamKey, source.twitchStreamKey);
  assert.equal(decrypted.relayUrl, source.relayUrl);
});

test('SECURE_FIELDS includes token and adminApiKey', () => {
  assert.ok(SECURE_FIELDS.includes('token'));
  assert.ok(SECURE_FIELDS.includes('adminApiKey'));
});
