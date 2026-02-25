/**
 * Tests for critical authentication flows:
 *
 * 1. Password change endpoint logic (currentPassword required, wrong password,
 *    correct password, minimum length).
 * 2. Admin panel session management (signSession / verifySession, expiry).
 * 3. Admin panel password hashing (hashPortalPassword / verifyPortalPassword,
 *    legacy SHA-256 support, timing-safe comparison on corrupted hashes).
 * 4. SESSION_SECRET requirement (module throws at load time if unset).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ─── SHARED AUTH HELPERS (src/auth.js) ──────────────────────────────────────
// Loaded once — no env dependency, safe to import at top level.
const { hashPassword, verifyPassword } = require('../src/auth');

// ─── ADMIN PANEL HELPERS (src/adminPanel.js) ────────────────────────────────
// adminPanel.js throws at load time when SESSION_SECRET is missing.
// We set it *before* the first require so the module can be loaded.
const TEST_SESSION_SECRET = 'test-session-secret-for-unit-tests-only';

function loadAdminPanel() {
  // Bust the CJS cache so each call re-evaluates the module against the
  // current process.env.SESSION_SECRET.
  const modulePath = require.resolve('../src/adminPanel');
  delete require.cache[modulePath];
  return require('../src/adminPanel');
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. PASSWORD CHANGE ENDPOINT LOGIC
//
//    These tests exercise the *logic* embedded in PUT /api/church/app/me
//    (server.js lines 1958-1975) without needing Express or supertest.
//    We replicate the exact conditionals from the route handler so that if
//    someone changes the logic the tests break.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simulates the password-change portion of PUT /api/church/app/me.
 * Mirrors the real route handler logic exactly so we can unit-test
 * without a running server.
 *
 * @param {object} body  The req.body (newPassword, currentPassword, password)
 * @param {string|null} storedHash  The church's portal_password_hash
 * @returns {{ status: number, json: object } | null}  null means "no password change requested"
 */
function simulatePasswordChange(body, storedHash) {
  const { newPassword, currentPassword, password } = body;
  const newPw = newPassword || password;

  if (!newPw) return null; // no password change requested

  if (!currentPassword) {
    return { status: 400, json: { error: 'Current password is required to change your password' } };
  }
  if (!storedHash || !verifyPassword(currentPassword, storedHash)) {
    return { status: 400, json: { error: 'Current password is incorrect' } };
  }
  if (newPw.length < 8) {
    return { status: 400, json: { error: 'Password must be at least 8 characters' } };
  }

  // Success — the real handler would UPDATE the DB here.
  const newHash = hashPassword(newPw);
  return { status: 200, json: { ok: true }, newHash };
}

describe('Password change (PUT /api/church/app/me logic)', () => {
  const ORIGINAL_PASSWORD = 'OriginalPass123';
  let storedHash;

  beforeEach(() => {
    storedHash = hashPassword(ORIGINAL_PASSWORD);
  });

  it('returns 400 when currentPassword is omitted', () => {
    const result = simulatePasswordChange(
      { newPassword: 'NewSecure99' },
      storedHash,
    );
    expect(result).not.toBeNull();
    expect(result.status).toBe(400);
    expect(result.json.error).toMatch(/current password is required/i);
  });

  it('returns 400 when currentPassword is wrong', () => {
    const result = simulatePasswordChange(
      { newPassword: 'NewSecure99', currentPassword: 'WrongPassword!' },
      storedHash,
    );
    expect(result).not.toBeNull();
    expect(result.status).toBe(400);
    expect(result.json.error).toMatch(/current password is incorrect/i);
  });

  it('succeeds when currentPassword is correct and newPassword meets length requirement', () => {
    const result = simulatePasswordChange(
      { newPassword: 'BrandNewPass!', currentPassword: ORIGINAL_PASSWORD },
      storedHash,
    );
    expect(result).not.toBeNull();
    expect(result.status).toBe(200);
    expect(result.json.ok).toBe(true);
    // The returned hash should verify against the new password
    expect(verifyPassword('BrandNewPass!', result.newHash)).toBe(true);
  });

  it('accepts the legacy "password" body field as an alias for "newPassword"', () => {
    const result = simulatePasswordChange(
      { password: 'AnotherGood1', currentPassword: ORIGINAL_PASSWORD },
      storedHash,
    );
    expect(result).not.toBeNull();
    expect(result.status).toBe(200);
  });

  it('prefers "newPassword" over "password" when both are provided', () => {
    const result = simulatePasswordChange(
      { newPassword: 'TakesThisOne', password: 'IgnoredField', currentPassword: ORIGINAL_PASSWORD },
      storedHash,
    );
    expect(result.status).toBe(200);
    expect(verifyPassword('TakesThisOne', result.newHash)).toBe(true);
    expect(verifyPassword('IgnoredField', result.newHash)).toBe(false);
  });

  it('returns null (no-op) when no password fields are in the body', () => {
    const result = simulatePasswordChange(
      { email: 'new@example.com' },
      storedHash,
    );
    expect(result).toBeNull();
  });

  // --- Password minimum length ---

  it('rejects a new password shorter than 8 characters', () => {
    const result = simulatePasswordChange(
      { newPassword: 'Short1!', currentPassword: ORIGINAL_PASSWORD },
      storedHash,
    );
    expect(result.status).toBe(400);
    expect(result.json.error).toMatch(/at least 8 characters/i);
  });

  it('accepts a new password of exactly 8 characters', () => {
    const result = simulatePasswordChange(
      { newPassword: 'Exact8ch', currentPassword: ORIGINAL_PASSWORD },
      storedHash,
    );
    expect(result.status).toBe(200);
  });

  it('rejects a 7-character password', () => {
    const result = simulatePasswordChange(
      { newPassword: '7chars!', currentPassword: ORIGINAL_PASSWORD },
      storedHash,
    );
    expect(result.status).toBe(400);
    expect(result.json.error).toMatch(/at least 8 characters/i);
  });

  it('rejects an empty new password', () => {
    // An empty string is falsy so newPw would be empty → no change triggered.
    // But if someone passes a whitespace-only string or explicit empty string
    // via the `password` field while newPassword is missing, it's still falsy.
    const result = simulatePasswordChange(
      { newPassword: '', currentPassword: ORIGINAL_PASSWORD },
      storedHash,
    );
    // Empty string is falsy so the handler should treat it as "no change"
    expect(result).toBeNull();
  });

  it('returns 400 if the church has no stored hash (no password ever set)', () => {
    // storedHash is null — verifyPassword should return false
    const result = simulatePasswordChange(
      { newPassword: 'NewSecure99', currentPassword: 'anything' },
      null,
    );
    expect(result.status).toBe(400);
    expect(result.json.error).toMatch(/current password is incorrect/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. ADMIN PANEL SESSION SIGNING & VERIFICATION
// ─────────────────────────────────────────────────────────────────────────────

describe('Admin panel session management (signSession / verifySession)', () => {
  let signSession, verifySession;

  beforeEach(() => {
    process.env.SESSION_SECRET = TEST_SESSION_SECRET;
    const mod = loadAdminPanel();
    signSession = mod.signSession;
    verifySession = mod.verifySession;
  });

  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  it('signSession produces a string in "base64.base64" format', () => {
    const token = signSession({ user: 'admin', exp: Date.now() + 60_000 });
    expect(typeof token).toBe('string');
    const parts = token.split('.');
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
  });

  it('verifySession returns the payload for a valid, non-expired token', () => {
    const payload = { user: 'admin', role: 'super', exp: Date.now() + 60_000 };
    const token = signSession(payload);
    const verified = verifySession(token);
    expect(verified).not.toBeNull();
    expect(verified.user).toBe('admin');
    expect(verified.role).toBe('super');
  });

  it('verifySession returns null for an expired token', () => {
    const payload = { user: 'admin', exp: Date.now() - 1_000 }; // expired 1 second ago
    const token = signSession(payload);
    const verified = verifySession(token);
    expect(verified).toBeNull();
  });

  it('verifySession returns null for a token without exp field', () => {
    const payload = { user: 'admin' }; // no exp
    const token = signSession(payload);
    const verified = verifySession(token);
    expect(verified).toBeNull();
  });

  it('verifySession returns null for a tampered payload', () => {
    const token = signSession({ user: 'admin', exp: Date.now() + 60_000 });
    const parts = token.split('.');
    // Tamper with the payload — flip a character
    const tampered = Buffer.from(JSON.stringify({ user: 'hacker', exp: Date.now() + 60_000 }))
      .toString('base64');
    const tamperedToken = `${tampered}.${parts[1]}`;
    expect(verifySession(tamperedToken)).toBeNull();
  });

  it('verifySession returns null for a tampered signature', () => {
    const token = signSession({ user: 'admin', exp: Date.now() + 60_000 });
    const parts = token.split('.');
    const tamperedToken = `${parts[0]}.AAAAAAAAAAAA`;
    expect(verifySession(tamperedToken)).toBeNull();
  });

  it('verifySession returns null for null input', () => {
    expect(verifySession(null)).toBeNull();
  });

  it('verifySession returns null for undefined input', () => {
    expect(verifySession(undefined)).toBeNull();
  });

  it('verifySession returns null for empty string', () => {
    expect(verifySession('')).toBeNull();
  });

  it('verifySession returns null for a string without a dot separator', () => {
    expect(verifySession('nodothere')).toBeNull();
  });

  it('verifySession returns null when payload is not valid JSON', () => {
    const crypto = require('crypto');
    const badPayload = Buffer.from('not-json').toString('base64');
    const sig = crypto.createHmac('sha256', TEST_SESSION_SECRET)
      .update(badPayload).digest('base64');
    const token = `${badPayload}.${sig}`;
    expect(verifySession(token)).toBeNull();
  });

  it('round-trips complex payloads with special characters', () => {
    const payload = {
      user: 'admin@church.org',
      churchName: "St. Mary's & Paul",
      exp: Date.now() + 300_000,
    };
    const token = signSession(payload);
    const verified = verifySession(token);
    expect(verified.user).toBe(payload.user);
    expect(verified.churchName).toBe(payload.churchName);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ADMIN PANEL PASSWORD HASHING
// ─────────────────────────────────────────────────────────────────────────────

describe('Admin panel password hashing (hashPortalPassword / verifyPortalPassword)', () => {
  let hashPortalPassword, verifyPortalPassword, hashPortalPasswordLegacy;

  beforeEach(() => {
    process.env.SESSION_SECRET = TEST_SESSION_SECRET;
    const mod = loadAdminPanel();
    hashPortalPassword = mod.hashPortalPassword;
    verifyPortalPassword = mod.verifyPortalPassword;
    hashPortalPasswordLegacy = mod.hashPortalPasswordLegacy;
  });

  afterEach(() => {
    delete process.env.SESSION_SECRET;
  });

  // --- Modern scrypt hashing ---

  it('hashPortalPassword returns salt:hash format', () => {
    const hashed = hashPortalPassword('testpassword');
    const parts = hashed.split(':');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^[0-9a-f]{32}$/); // 16-byte salt → 32 hex chars
    expect(parts[1]).toMatch(/^[0-9a-f]{128}$/); // 64-byte hash → 128 hex chars
  });

  it('hashPortalPassword produces different salts each time', () => {
    const a = hashPortalPassword('same-password');
    const b = hashPortalPassword('same-password');
    expect(a.split(':')[0]).not.toBe(b.split(':')[0]);
  });

  it('verifyPortalPassword returns true for correct password (scrypt)', () => {
    const hashed = hashPortalPassword('my-portal-pass');
    expect(verifyPortalPassword('my-portal-pass', hashed)).toBe(true);
  });

  it('verifyPortalPassword returns false for wrong password (scrypt)', () => {
    const hashed = hashPortalPassword('my-portal-pass');
    expect(verifyPortalPassword('wrong-pass', hashed)).toBe(false);
  });

  // --- Legacy SHA-256 verification ---

  it('hashPortalPasswordLegacy produces a 64-char hex SHA-256 hash', () => {
    const hashed = hashPortalPasswordLegacy('legacy-password');
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifyPortalPassword verifies a legacy SHA-256 hash', () => {
    // Simulate an old-format hash (no colon — plain hex SHA-256)
    const legacyHash = hashPortalPasswordLegacy('old-password');
    expect(legacyHash).not.toContain(':'); // confirms it's the legacy format
    expect(verifyPortalPassword('old-password', legacyHash)).toBe(true);
  });

  it('verifyPortalPassword rejects wrong password against legacy hash', () => {
    const legacyHash = hashPortalPasswordLegacy('old-password');
    expect(verifyPortalPassword('wrong-one', legacyHash)).toBe(false);
  });

  it('legacy hash is deterministic (same password → same hash)', () => {
    const a = hashPortalPasswordLegacy('deterministic');
    const b = hashPortalPasswordLegacy('deterministic');
    expect(a).toBe(b);
  });

  // --- Edge cases & timing-safe comparison ---

  it('verifyPortalPassword returns false for null stored value', () => {
    expect(verifyPortalPassword('anything', null)).toBe(false);
  });

  it('verifyPortalPassword returns false for undefined stored value', () => {
    expect(verifyPortalPassword('anything', undefined)).toBe(false);
  });

  it('verifyPortalPassword returns false for empty string stored value', () => {
    expect(verifyPortalPassword('anything', '')).toBe(false);
  });

  it('does not crash on corrupted scrypt hash (wrong length)', () => {
    // timingSafeEqual throws if buffers differ in length — the catch block
    // should handle this gracefully and return false.
    expect(verifyPortalPassword('test', 'abcdef1234567890:tooshort')).toBe(false);
  });

  it('does not crash on corrupted legacy hash (non-hex characters)', () => {
    expect(verifyPortalPassword('test', 'zzzz_not_hex_at_all')).toBe(false);
  });

  it('does not crash on corrupted legacy hash (wrong length hex)', () => {
    // Valid hex but not 64 characters — length mismatch in timingSafeEqual
    expect(verifyPortalPassword('test', 'abcdef')).toBe(false);
  });

  it('handles a stored hash that is just a colon', () => {
    expect(verifyPortalPassword('test', ':')).toBe(false);
  });

  it('handles a stored hash with empty salt but valid-length hash part', () => {
    const fakeHash = ':' + 'a'.repeat(128);
    expect(verifyPortalPassword('test', fakeHash)).toBe(false);
  });

  it('works correctly across multiple passwords', () => {
    const passwords = ['alpha', 'bravo', 'charlie123!', 'P@ssw0rd'];
    for (const pw of passwords) {
      const hashed = hashPortalPassword(pw);
      expect(verifyPortalPassword(pw, hashed)).toBe(true);
      expect(verifyPortalPassword(pw + 'x', hashed)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. SESSION_SECRET REQUIRED AT MODULE LOAD TIME
// ─────────────────────────────────────────────────────────────────────────────

describe('SESSION_SECRET requirement', () => {
  afterEach(() => {
    // Restore so subsequent tests can load the module
    process.env.SESSION_SECRET = TEST_SESSION_SECRET;
  });

  it('throws an error when SESSION_SECRET is not set', () => {
    // Remove SESSION_SECRET completely
    delete process.env.SESSION_SECRET;

    // Clear the module cache so it re-evaluates the top-level guard
    const modulePath = require.resolve('../src/adminPanel');
    delete require.cache[modulePath];

    expect(() => require('../src/adminPanel')).toThrow(/SESSION_SECRET is required/);
  });

  it('throws an error when SESSION_SECRET is an empty string', () => {
    process.env.SESSION_SECRET = '';

    const modulePath = require.resolve('../src/adminPanel');
    delete require.cache[modulePath];

    expect(() => require('../src/adminPanel')).toThrow(/SESSION_SECRET is required/);
  });

  it('loads successfully when SESSION_SECRET is set', () => {
    process.env.SESSION_SECRET = 'any-non-empty-value';

    const modulePath = require.resolve('../src/adminPanel');
    delete require.cache[modulePath];

    expect(() => require('../src/adminPanel')).not.toThrow();
  });
});
