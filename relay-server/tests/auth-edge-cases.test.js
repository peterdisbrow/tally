/**
 * Edge-case tests for src/auth.js — inputs not covered by auth.test.js.
 *
 * auth.test.js already covers:
 *   - hashPassword format (salt:hash, hex lengths, uniqueness)
 *   - verifyPassword basic correct/incorrect, null, undefined, empty, no-colon,
 *     empty-salt/hash parts, corrupted/truncated hash, multiple pairs
 *
 * This file adds:
 *   - verifyPassword with non-string types coerced via stored param
 *   - hashPassword with special characters, unicode, very long passwords
 *   - generateRegistrationCode uniqueness and format
 */

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const { hashPassword, verifyPassword, generateRegistrationCode } = require('../src/auth');

// ─── hashPassword edge cases ──────────────────────────────────────────────────

describe('hashPassword — additional edge cases', () => {
  it('handles a password with special characters and spaces', () => {
    const pw = 'P@$$w0rd! with spaces & <symbols>';
    const stored = hashPassword(pw);
    expect(verifyPassword(pw, stored)).toBe(true);
    expect(verifyPassword('P@$$w0rd!', stored)).toBe(false);
  });

  it('handles a unicode/emoji password', () => {
    const pw = '🎛️churchAV🔒';
    const stored = hashPassword(pw);
    expect(verifyPassword(pw, stored)).toBe(true);
  });

  it('handles a very long password (512 chars)', () => {
    const pw = 'a'.repeat(512);
    const stored = hashPassword(pw);
    expect(verifyPassword(pw, stored)).toBe(true);
    expect(verifyPassword('a'.repeat(511), stored)).toBe(false);
  });

  it('hashing an empty string produces a valid salt:hash format', () => {
    const stored = hashPassword('');
    const parts = stored.split(':');
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
  });
});

// ─── verifyPassword edge cases ────────────────────────────────────────────────

describe('verifyPassword — additional edge cases', () => {
  it('returns false when password argument is null', () => {
    const stored = hashPassword('real-password');
    // scryptSync will throw when given null — should return false, not throw
    expect(() => verifyPassword(null, stored)).not.toThrow();
    expect(verifyPassword(null, stored)).toBe(false);
  });

  it('returns false when stored is a number (not a valid hash)', () => {
    expect(verifyPassword('anything', 42)).toBe(false);
  });

  it('returns false when stored is an object', () => {
    expect(verifyPassword('anything', { salt: 'x', hash: 'y' })).toBe(false);
  });

  it('returns false when stored is an array', () => {
    expect(verifyPassword('anything', ['salt', 'hash'])).toBe(false);
  });

  it('returns false for a completely fabricated salt:hash (not from hashPassword)', () => {
    // A manually constructed "salt:hash" where the hash is wrong length/content
    // 'deadbeef' is a valid salt but 'tooshortfake' will fail timingSafeEqual
    expect(verifyPassword('correct', 'deadbeef:tooshortfake')).toBe(false);
  });

  it('is case-sensitive — uppercase password does not match lowercase hash', () => {
    const stored = hashPassword('password');
    expect(verifyPassword('Password', stored)).toBe(false);
    expect(verifyPassword('PASSWORD', stored)).toBe(false);
  });
});

// ─── generateRegistrationCode ─────────────────────────────────────────────────

describe('generateRegistrationCode', () => {
  function makeDb(existingCodes = []) {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE churches (
        churchId TEXT PRIMARY KEY,
        registration_code TEXT,
        referral_code TEXT
      )
    `);
    for (const code of existingCodes) {
      db.prepare('INSERT INTO churches (churchId, registration_code, referral_code) VALUES (?, ?, ?)')
        .run(`church_${code}`, code, `ref_${code}`);
    }
    return db;
  }

  it('returns a 6-character uppercase hex string', () => {
    const db = makeDb();
    const code = generateRegistrationCode(db);
    expect(code).toMatch(/^[0-9A-F]{6}$/);
    db.close();
  });

  it('generates a different code when first attempt already exists', () => {
    // Seed every possible 3-byte hex value except one by mocking randomBytes
    // Instead: seed a single known code and verify it retries
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE churches (
        churchId TEXT PRIMARY KEY,
        registration_code TEXT,
        referral_code TEXT
      )
    `);

    // Insert codes for all values 000000 through FFFFFE — that's too many.
    // Instead, capture calls: the first randomBytes call returns a code that exists,
    // the second returns a fresh code.
    const crypto = require('crypto');
    let callCount = 0;
    const original = crypto.randomBytes;
    // Mock randomBytes to return a colliding code first, then unique
    const collisionCode = Buffer.from([0xAB, 0xCD, 0xEF]);
    const freshCode    = Buffer.from([0x12, 0x34, 0x56]);

    // Seed the collision code into DB
    db.exec(`
      CREATE TABLE churches2 AS SELECT * FROM churches WHERE 0
    `);
    db.exec(`DROP TABLE churches2`);
    db.prepare('INSERT INTO churches (churchId, registration_code, referral_code) VALUES (?, ?, ?)')
      .run('existing', 'ABCDEF', 'REF123');

    vi.spyOn(crypto, 'randomBytes').mockReturnValueOnce(collisionCode).mockReturnValueOnce(freshCode);

    const code = generateRegistrationCode(db);
    // After the retry the result should be 123456 (no collision)
    expect(code).toBe('123456');

    vi.restoreAllMocks();
    db.close();
  });

  it('produces unique codes across multiple calls with an empty DB', () => {
    const db = makeDb();
    const codes = new Set();
    for (let i = 0; i < 20; i++) {
      const code = generateRegistrationCode(db);
      // Insert so subsequent calls see it as taken (tests true uniqueness logic)
      db.prepare('INSERT INTO churches (churchId, registration_code, referral_code) VALUES (?, ?, ?)')
        .run(`church_${i}`, code, `ref_${i}`);
      codes.add(code);
    }
    expect(codes.size).toBe(20);
    db.close();
  });
});
