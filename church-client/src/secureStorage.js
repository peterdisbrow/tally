/**
 * SecureStorage — Encrypted credential storage for Tally CLI client
 *
 * Uses AES-256-GCM with a machine-derived key.
 * No npm dependencies — pure Node.js crypto module.
 *
 * Sensitive fields encrypted at rest in ~/.church-av/config.json:
 *   youtubeApiKey, facebookAccessToken, twitchStreamKey,
 *   rtmpStreamKey, obsPassword, churchToken
 *
 * The machine key is derived from stable system identifiers.
 * Not as strong as a hardware keychain, but exponentially better
 * than plaintext — a stolen config file is useless without the machine.
 */

const crypto = require('crypto');
const os = require('os');

// Fields that should be encrypted at rest
const SENSITIVE_FIELDS = [
  'youtubeApiKey',
  'facebookAccessToken',
  'twitchStreamKey',
  'rtmpStreamKey',
  'obsPassword',
  'token',           // church JWT token
  'adminApiKey',
];

// ─── MACHINE KEY DERIVATION ───────────────────────────────────────────────────

function getMachineIdentifier() {
  // Combine stable OS identifiers — hostname + username + platform + homedir
  // Stable across reboots, unique per machine
  const parts = [
    os.hostname(),
    os.userInfo().username,
    os.platform(),
    os.homedir(),
  ].join('::tally::');
  return parts;
}

function deriveMachineKey() {
  const identifier = getMachineIdentifier();
  // PBKDF2 with a fixed app-specific salt
  return crypto.pbkdf2Sync(
    identifier,
    'tally-by-atem-school-v1',  // fixed app salt
    100_000,
    32,  // 256-bit key
    'sha256'
  );
}

// Cache the derived key for the session (expensive to derive)
let _cachedKey = null;
function getMachineKey() {
  if (!_cachedKey) _cachedKey = deriveMachineKey();
  return _cachedKey;
}

// ─── ENCRYPTION / DECRYPTION ──────────────────────────────────────────────────

function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  const key = getMachineKey();
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  // Pack: iv(12) + authTag(16) + ciphertext, encode as base64
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return `enc:${packed.toString('base64')}`;
}

function decrypt(value) {
  if (!value || !String(value).startsWith('enc:')) return value;
  try {
    const key = getMachineKey();
    const packed = Buffer.from(String(value).slice(4), 'base64');
    const iv = packed.slice(0, 12);
    const authTag = packed.slice(12, 28);
    const ciphertext = packed.slice(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(ciphertext, null, 'utf8') + decipher.final('utf8');
  } catch {
    // Decryption failed (wrong machine, corruption) — return null so caller can re-prompt
    return null;
  }
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith('enc:');
}

// ─── CONFIG ENCRYPT / DECRYPT ─────────────────────────────────────────────────

/**
 * Encrypt all sensitive fields in a config object before saving.
 * Non-sensitive fields pass through unchanged.
 * Already-encrypted values are not re-encrypted.
 */
function encryptConfig(config) {
  const out = { ...config };
  for (const field of SENSITIVE_FIELDS) {
    if (out[field] && !isEncrypted(out[field])) {
      out[field] = encrypt(out[field]);
    }
  }
  return out;
}

/**
 * Decrypt all sensitive fields in a config object after loading.
 * Returns plaintext values for use by the agent.
 */
function decryptConfig(config) {
  const out = { ...config };
  for (const field of SENSITIVE_FIELDS) {
    if (out[field] && isEncrypted(out[field])) {
      const decrypted = decrypt(out[field]);
      if (decrypted === null) {
        console.warn(`⚠️  Could not decrypt ${field} — was this config copied from another machine?`);
        out[field] = '';
      } else {
        out[field] = decrypted;
      }
    }
  }
  return out;
}

/**
 * Check whether a config object has any unencrypted sensitive fields.
 * Returns array of field names that need encrypting.
 */
function findUnencryptedFields(config) {
  return SENSITIVE_FIELDS.filter(f => config[f] && !isEncrypted(config[f]));
}

module.exports = {
  encrypt,
  decrypt,
  isEncrypted,
  encryptConfig,
  decryptConfig,
  findUnencryptedFields,
  SENSITIVE_FIELDS,
};
