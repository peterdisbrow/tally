'use strict';

/**
 * secretCrypto.js — authenticated encryption (AES-256-GCM) for sensitive
 * columns at rest: OAuth access/refresh tokens, stream keys, reseller API keys.
 *
 * Wire format:  enc:v1:<base64( iv[12] || authTag[16] || ciphertext )>
 *
 * Backward compatible by design so it can roll out lazily against existing
 * plaintext data:
 *   - decryptSecret() returns any value WITHOUT the enc:v1: prefix unchanged
 *     (legacy plaintext, null, undefined) — reads keep working before backfill.
 *   - encryptSecret() is idempotent: it won't double-encrypt an already-encrypted
 *     value, and returns null/undefined/'' untouched.
 * Values get upgraded to ciphertext the next time they're written.
 *
 * Key source (priority order), mirroring how server.js derives ADMIN_API_KEY /
 * SESSION_SECRET so the feature is always-on without a mandatory new env var:
 *   1. ENCRYPTION_KEY  (64 hex chars → raw 32 bytes; 32-byte base64 → raw;
 *                       any other string → scrypt-derived 32 bytes)
 *   2. JWT_SECRET      (scrypt-derived; warns once in production — set an
 *                       explicit ENCRYPTION_KEY to decouple from JWT rotation)
 *   3. dev/test        (fixed dev key)
 *   4. none            → passthrough (store/return plaintext)
 */

const crypto = require('node:crypto');

const ALGO = 'aes-256-gcm';
const PREFIX = 'enc:v1:';
const IV_LEN = 12;
const TAG_LEN = 16;
const KDF_SALT = 'tallyconnect:secretCrypto:v1';

let _key;          // Buffer(32) | null
let _resolved = false;
let _warned = false;

function _deriveKeyFromString(str) {
  if (/^[0-9a-fA-F]{64}$/.test(str)) return Buffer.from(str, 'hex');
  try {
    const b = Buffer.from(str, 'base64');
    if (b.length === 32) return b;
  } catch { /* not base64 — fall through to scrypt */ }
  return crypto.scryptSync(str, KDF_SALT, 32);
}

function _resolveKey() {
  if (_resolved) return _key;
  _resolved = true;
  const isDev = process.env.NODE_ENV === 'development'
    || process.env.NODE_ENV === 'test'
    || !!process.env.VITEST;

  if (process.env.ENCRYPTION_KEY) {
    _key = _deriveKeyFromString(process.env.ENCRYPTION_KEY);
  } else if (process.env.JWT_SECRET) {
    if (!isDev && !_warned) {
      console.warn('⚠️  ENCRYPTION_KEY not set — deriving at-rest encryption key from JWT_SECRET. Set ENCRYPTION_KEY in env to decouple secret encryption from JWT rotation.');
      _warned = true;
    }
    _key = crypto.scryptSync(process.env.JWT_SECRET, KDF_SALT, 32);
  } else if (isDev) {
    _key = crypto.scryptSync('tally-dev-encryption-key', KDF_SALT, 32);
  } else {
    _key = null;
  }
  return _key;
}

/** True when key material is available (encryption is active). */
function isConfigured() {
  return !!_resolveKey();
}

/** True when value is an enc:v1: ciphertext produced by encryptSecret(). */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** Encrypt a value for storage. Idempotent; passes through null/''/already-encrypted. */
function encryptSecret(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;
  if (isEncrypted(plaintext)) return plaintext;
  const key = _resolveKey();
  if (!key) return plaintext;
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

/** Decrypt a stored value. Returns non-prefixed values unchanged (legacy plaintext). */
function decryptSecret(value) {
  if (!isEncrypted(value)) return value;
  const key = _resolveKey();
  if (!key) return value;
  try {
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
    const iv = raw.subarray(0, IV_LEN);
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = raw.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    console.error('[secretCrypto] Failed to decrypt a secret value:', e.message);
    return null;
  }
}

/**
 * Deterministic keyed hash (HMAC-SHA256) for columns that must stay
 * equality-searchable while the plaintext is encrypted — e.g. resellers.api_key
 * is looked up by value but must not be stored in the clear. Same plaintext
 * always yields the same hash, so it can back a unique/indexed lookup column.
 */
function lookupHash(value) {
  if (value === null || value === undefined || value === '') return value;
  const key = _resolveKey();
  if (!key) return null;
  return crypto.createHmac('sha256', key).update(String(value)).digest('hex');
}

/**
 * Decrypt the named secret fields on a row object, in place, and return it.
 * Safe on null rows and missing/empty fields. Use right after a SELECT so all
 * downstream consumers see plaintext (truthiness checks keep working either way).
 */
function decryptFields(row, fields) {
  if (!row) return row;
  for (const f of fields) {
    if (row[f] !== null && row[f] !== undefined && row[f] !== '') {
      row[f] = decryptSecret(row[f]);
    }
  }
  return row;
}

module.exports = {
  encryptSecret,
  decryptSecret,
  decryptFields,
  isEncrypted,
  isConfigured,
  lookupHash,
  // test-only: clears the cached key so tests can vary env
  _resetForTest() { _resolved = false; _key = undefined; _warned = false; },
};
