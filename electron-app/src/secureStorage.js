/**
 * SecureStorage — Electron-side credential storage
 *
 * Uses Electron's safeStorage API which delegates to:
 *   - macOS: Keychain
 *   - Windows: DPAPI (Data Protection API)
 *   - Linux: gnome-libsecret or kwallet
 *
 * Falls back to AES-256-GCM machine-key encryption if safeStorage
 * is not available (e.g., running outside Electron context).
 */

const crypto = require('crypto');
const os = require('os');

// Fields stored securely (never in plaintext config)
const SECURE_FIELDS = [
  'youtubeApiKey',
  'facebookAccessToken',
  'twitchStreamKey',
  'rtmpStreamKey',
  'obsPassword',
  'token',
  'churchToken',
  'adminApiKey',
  // OAuth tokens (stored locally as backup — primary storage is relay DB)
  'youtubeOAuthAccessToken',
  'youtubeOAuthRefreshToken',
  'facebookOAuthAccessToken',
  'youtubeStreamKey',
  'facebookStreamKey',
];

// ─── ELECTRON safeStorage ─────────────────────────────────────────────────────

let _safeStorage = null;
function getSafeStorage() {
  if (_safeStorage !== null) return _safeStorage;
  try {
    const { safeStorage } = require('electron');
    _safeStorage = safeStorage.isEncryptionAvailable() ? safeStorage : null;
  } catch {
    _safeStorage = null;
  }
  return _safeStorage;
}

// ─── FALLBACK: machine-key AES-256-GCM ───────────────────────────────────────

function getMachineKey() {
  const identifier = [os.hostname(), os.userInfo().username, os.platform(), os.homedir()].join('::tally::');
  return crypto.pbkdf2Sync(identifier, 'tally-by-atem-school-v1', 100_000, 32, 'sha256');
}

function aesEncrypt(plaintext) {
  const key = getMachineKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${Buffer.concat([iv, tag, enc]).toString('base64')}`;
}

function aesDecrypt(value) {
  if (!value || !String(value).startsWith('enc:')) return value;
  try {
    const key = getMachineKey();
    const packed = Buffer.from(String(value).slice(4), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, packed.slice(0, 12));
    decipher.setAuthTag(packed.slice(12, 28));
    return decipher.update(packed.slice(28), null, 'utf8') + decipher.final('utf8');
  } catch {
    return null;
  }
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

function encryptValue(plaintext) {
  if (!plaintext) return '';
  const ss = getSafeStorage();
  if (ss) {
    // Electron safeStorage — returns Buffer
    const buf = ss.encryptString(String(plaintext));
    return `es:${buf.toString('base64')}`; // 'es:' prefix = electron safeStorage
  }
  return aesEncrypt(plaintext);
}

function decryptValue(value) {
  if (!value) return '';
  const s = String(value);
  if (s.startsWith('es:')) {
    // Electron safeStorage
    const ss = getSafeStorage();
    if (!ss) return null; // can't decrypt without safeStorage
    try {
      const buf = Buffer.from(s.slice(3), 'base64');
      return ss.decryptString(buf);
    } catch {
      return null;
    }
  }
  if (s.startsWith('enc:')) return aesDecrypt(s);
  return value; // plaintext (legacy or not yet encrypted)
}

function isEncrypted(value) {
  if (!value) return false;
  const s = String(value);
  return s.startsWith('enc:') || s.startsWith('es:');
}

/**
 * Encrypt all secure fields in a config object before saving to disk.
 */
function encryptConfig(config) {
  const out = { ...config };
  for (const field of SECURE_FIELDS) {
    if (out[field] && !isEncrypted(out[field])) {
      out[field] = encryptValue(out[field]);
    }
  }
  // Nested credentials: PTZ cameras
  if (Array.isArray(out.ptz)) {
    out.ptz = out.ptz.map(cam => {
      const c = { ...cam };
      if (c.password && !isEncrypted(c.password)) c.password = encryptValue(c.password);
      if (c.username && !isEncrypted(c.username)) c.username = encryptValue(c.username);
      return c;
    });
  }
  // Nested credentials: encoders array
  if (Array.isArray(out.encoders)) {
    out.encoders = out.encoders.map(e => {
      if (e && e.password && !isEncrypted(e.password)) return { ...e, password: encryptValue(e.password) };
      return e;
    });
  }
  // Nested credentials: single encoder object
  if (out.encoder && out.encoder.password && !isEncrypted(out.encoder.password)) {
    out.encoder = { ...out.encoder, password: encryptValue(out.encoder.password) };
  }
  return out;
}

/**
 * Decrypt all secure fields in a config object after loading from disk.
 */
function decryptConfig(config) {
  const out = { ...config };
  for (const field of SECURE_FIELDS) {
    if (out[field] && isEncrypted(out[field])) {
      const val = decryptValue(out[field]);
      out[field] = val !== null ? val : '';
    }
  }
  // Nested credentials: PTZ cameras
  if (Array.isArray(out.ptz)) {
    out.ptz = out.ptz.map(cam => {
      const c = { ...cam };
      if (c.password && isEncrypted(c.password)) { const v = decryptValue(c.password); c.password = v !== null ? v : ''; }
      if (c.username && isEncrypted(c.username)) { const v = decryptValue(c.username); c.username = v !== null ? v : ''; }
      return c;
    });
  }
  // Nested credentials: encoders array
  if (Array.isArray(out.encoders)) {
    out.encoders = out.encoders.map(e => {
      if (e && e.password && isEncrypted(e.password)) { const v = decryptValue(e.password); return { ...e, password: v !== null ? v : '' }; }
      return e;
    });
  }
  // Nested credentials: single encoder object
  if (out.encoder && out.encoder.password && isEncrypted(out.encoder.password)) {
    const v = decryptValue(out.encoder.password);
    out.encoder = { ...out.encoder, password: v !== null ? v : '' };
  }
  return out;
}

module.exports = {
  encryptValue,
  decryptValue,
  isEncrypted,
  encryptConfig,
  decryptConfig,
  SECURE_FIELDS,
};
