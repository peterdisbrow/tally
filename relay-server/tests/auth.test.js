/**
 * Tests for src/auth.js — password hashing, verification, and edge cases.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { hashPassword, verifyPassword } = require('../src/auth');

describe('hashPassword', () => {
  it('returns a string in salt:hash format', () => {
    const result = hashPassword('test-password');
    const parts = result.split(':');
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBeGreaterThan(0); // salt
    expect(parts[1].length).toBeGreaterThan(0); // hash
  });

  it('produces a 32-char hex salt (16 random bytes)', () => {
    const result = hashPassword('test-password');
    const salt = result.split(':')[0];
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
  });

  it('produces a 128-char hex hash (64 bytes from scrypt)', () => {
    const result = hashPassword('test-password');
    const hash = result.split(':')[1];
    expect(hash).toMatch(/^[0-9a-f]{128}$/);
  });

  it('produces different salts on each call', () => {
    const a = hashPassword('same-password');
    const b = hashPassword('same-password');
    const saltA = a.split(':')[0];
    const saltB = b.split(':')[0];
    expect(saltA).not.toBe(saltB);
  });

  it('produces different full hashes on each call (different salts)', () => {
    const a = hashPassword('same-password');
    const b = hashPassword('same-password');
    expect(a).not.toBe(b);
  });
});

describe('verifyPassword', () => {
  it('returns true for a correct password', () => {
    const stored = hashPassword('my-secret');
    expect(verifyPassword('my-secret', stored)).toBe(true);
  });

  it('returns false for a wrong password', () => {
    const stored = hashPassword('my-secret');
    expect(verifyPassword('wrong-password', stored)).toBe(false);
  });

  it('returns false when stored value is null', () => {
    expect(verifyPassword('anything', null)).toBe(false);
  });

  it('returns false when stored value is undefined', () => {
    expect(verifyPassword('anything', undefined)).toBe(false);
  });

  it('returns false when stored value is an empty string', () => {
    expect(verifyPassword('anything', '')).toBe(false);
  });

  it('returns false when stored value has no colon separator', () => {
    expect(verifyPassword('anything', 'noseparator')).toBe(false);
  });

  it('returns false when stored value has empty salt or hash parts', () => {
    expect(verifyPassword('anything', ':somehash')).toBe(false);
    expect(verifyPassword('anything', 'somesalt:')).toBe(false);
    expect(verifyPassword('anything', ':')).toBe(false);
  });

  it('returns false for a corrupted/truncated hash', () => {
    // A hash that is the wrong length will cause timingSafeEqual to throw
    expect(verifyPassword('test', 'abcd1234:tooshort')).toBe(false);
  });

  it('works correctly across multiple password/hash pairs', () => {
    const passwords = ['alpha', 'bravo', 'charlie', ''];
    for (const pw of passwords) {
      const stored = hashPassword(pw);
      expect(verifyPassword(pw, stored)).toBe(true);
      expect(verifyPassword(pw + 'x', stored)).toBe(false);
    }
  });
});
