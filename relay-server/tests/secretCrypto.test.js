import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Load fresh with a known key so tests are deterministic.
function loadCrypto(key = '0'.repeat(64)) {
  const mod = require('../src/secretCrypto.js');
  process.env.ENCRYPTION_KEY = key;
  mod._resetForTest();
  return mod;
}

describe('secretCrypto', () => {
  const savedKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => { loadCrypto(); });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = savedKey;
    require('../src/secretCrypto.js')._resetForTest();
  });

  it('round-trips a value through encrypt/decrypt', () => {
    const { encryptSecret, decryptSecret } = require('../src/secretCrypto.js');
    const plain = 'ya29.super-secret-oauth-token';
    const enc = encryptSecret(plain);
    expect(enc).not.toBe(plain);
    expect(enc.startsWith('enc:v1:')).toBe(true);
    expect(decryptSecret(enc)).toBe(plain);
  });

  it('produces different ciphertext each call (random IV) but same plaintext', () => {
    const { encryptSecret, decryptSecret } = require('../src/secretCrypto.js');
    const a = encryptSecret('same-input');
    const b = encryptSecret('same-input');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe('same-input');
    expect(decryptSecret(b)).toBe('same-input');
  });

  it('is idempotent — will not double-encrypt', () => {
    const { encryptSecret } = require('../src/secretCrypto.js');
    const once = encryptSecret('k');
    expect(encryptSecret(once)).toBe(once);
  });

  it('passes through null, undefined, and empty string', () => {
    const { encryptSecret, decryptSecret } = require('../src/secretCrypto.js');
    for (const v of [null, undefined, '']) {
      expect(encryptSecret(v)).toBe(v);
      expect(decryptSecret(v)).toBe(v);
    }
  });

  it('returns legacy plaintext unchanged on decrypt (backward compatible)', () => {
    const { decryptSecret } = require('../src/secretCrypto.js');
    expect(decryptSecret('legacy-plaintext-stream-key')).toBe('legacy-plaintext-stream-key');
  });

  it('isEncrypted detects the prefix', () => {
    const { encryptSecret, isEncrypted } = require('../src/secretCrypto.js');
    expect(isEncrypted(encryptSecret('x'))).toBe(true);
    expect(isEncrypted('plain')).toBe(false);
    expect(isEncrypted(null)).toBe(false);
  });

  it('fails closed (returns null) when ciphertext is tampered', () => {
    const { encryptSecret, decryptSecret } = require('../src/secretCrypto.js');
    const enc = encryptSecret('authentic');
    // Flip a character in the base64 body to break the GCM auth tag.
    const body = enc.slice('enc:v1:'.length);
    const tampered = 'enc:v1:' + (body[0] === 'A' ? 'B' : 'A') + body.slice(1);
    expect(decryptSecret(tampered)).toBe(null);
  });

  it('lookupHash is deterministic for the same input and key', () => {
    const { lookupHash } = require('../src/secretCrypto.js');
    const a = lookupHash('reseller-api-key-123');
    const b = lookupHash('reseller-api-key-123');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(lookupHash('different')).not.toBe(a);
  });

  it('accepts a hex, base64, and arbitrary-string ENCRYPTION_KEY', () => {
    for (const key of ['a'.repeat(64), Buffer.alloc(32, 7).toString('base64'), 'any passphrase here']) {
      const mod = loadCrypto(key);
      const enc = mod.encryptSecret('payload');
      expect(mod.decryptSecret(enc)).toBe('payload');
    }
  });
});
