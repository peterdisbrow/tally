/**
 * Shared authentication utilities — password hashing, verification,
 * and registration code generation.
 *
 * Used by both server.js and churchPortal.js to eliminate duplicate code.
 */

const crypto = require('crypto');

/**
 * Hash a password with a random salt using scrypt.
 * Returns "salt:hash" string.
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify a password against a stored "salt:hash" string.
 * Uses timing-safe comparison to prevent timing attacks.
 */
function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored || '').split(':');
    if (!salt || !hash) return false;
    const check = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Generate a unique 6-character uppercase hex registration code.
 * Retries if the code already exists in the DB.
 * @param {import('better-sqlite3').Database} db
 */
function generateRegistrationCode(db) {
  let code;
  do {
    code = crypto.randomBytes(3).toString('hex').toUpperCase();
  } while (db.prepare('SELECT 1 FROM churches WHERE registration_code = ?').get(code));
  return code;
}

/**
 * Timing-safe comparison for API keys / tokens.
 * Prevents timing-attack side-channels on secret comparisons.
 */
function safeCompareKey(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Escape HTML special characters to prevent XSS.
 * Shared utility — imported by churchPortal, adminPanel, resellerPortal.
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { hashPassword, verifyPassword, generateRegistrationCode, safeCompareKey, escapeHtml };
