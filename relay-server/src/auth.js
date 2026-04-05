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

function generateRandomRegistrationCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function generateRegistrationCodeSync(db) {
  let code;
  do {
    code = generateRandomRegistrationCode();
  } while (
    db.prepare('SELECT 1 FROM churches WHERE registration_code = ? OR referral_code = ?').get(code, code)
  );
  return code;
}

async function generateRegistrationCodeAsync(queryClient) {
  let code;
  do {
    code = generateRandomRegistrationCode();
  } while (
    await queryClient.queryOne(
      'SELECT 1 FROM churches WHERE registration_code = ? OR referral_code = ?',
      [code, code]
    )
  );
  return code;
}

/**
 * Generate a unique 6-character uppercase hex registration code.
 * Retries if the code already exists in the DB.
 * Supports both sync `better-sqlite3` databases and async query clients.
 */
function generateRegistrationCode(dbOrClient) {
  if (dbOrClient?.queryOne) {
    return generateRegistrationCodeAsync(dbOrClient);
  }
  if (dbOrClient?.prepare) {
    return generateRegistrationCodeSync(dbOrClient);
  }
  throw new Error('generateRegistrationCode requires a database handle or query client');
}

module.exports = { hashPassword, verifyPassword, generateRegistrationCode };
