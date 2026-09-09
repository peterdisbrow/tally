/**
 * Tests for src/churchNameValidation.js — signup/onboard name hygiene.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  validateChurchName,
  normalizeChurchName,
  isLikelyTestOrSpamChurch,
  MAX_CHURCH_NAME_LENGTH,
} = require('../src/churchNameValidation');

describe('normalizeChurchName', () => {
  it('trims and collapses interior whitespace', () => {
    expect(normalizeChurchName('  First   Baptist  ')).toBe('First Baptist');
  });
});

describe('validateChurchName — allow real short and ordinary names', () => {
  const allowed = [
    'LCC',
    'Cogcomm',
    "St. Mary's",
    'Grace Chapel',
    'First Baptist',
    'Hope',
    'Église Nouvelle',
  ];

  for (const name of allowed) {
    it(`accepts "${name}"`, () => {
      const result = validateChurchName(name);
      expect(result.ok).toBe(true);
      expect(result.name).toBe(name);
    });
  }
});

describe('validateChurchName — reject URLs and shorteners', () => {
  const rejected = [
    'https://spam.example/join',
    'http://casino.example',
    'www.spam.example',
    'Visit bit.ly/abc123',
    'tinyurl.com/promo',
    'win.big.com/offer',
    'free-spins.xyz',
  ];

  for (const name of rejected) {
    it(`rejects "${name}"`, () => {
      const result = validateChurchName(name);
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });
  }
});

describe('validateChurchName — reject casino/spam patterns', () => {
  const rejected = [
    'Best Online Casino',
    'poker bonus tonight',
    'Free Spins 2026',
    'crypto airdrop now',
    'Claim bonus code',
    '<script>alert(1)</script>',
    'spam@example.com',
  ];

  for (const name of rejected) {
    it(`rejects "${name}"`, () => {
      expect(validateChurchName(name).ok).toBe(false);
    });
  }
});

describe('validateChurchName — boundaries', () => {
  it('rejects empty / whitespace-only names', () => {
    expect(validateChurchName('').ok).toBe(false);
    expect(validateChurchName('   ').error).toBe('name required');
  });

  it('rejects a single character', () => {
    expect(validateChurchName('A').ok).toBe(false);
  });

  it('rejects names over the max length', () => {
    const tooLong = `Grace ${'A'.repeat(MAX_CHURCH_NAME_LENGTH)}`;
    const result = validateChurchName(tooLong);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/too long/i);
  });

  it('rejects digit-only names', () => {
    expect(validateChurchName('12345').ok).toBe(false);
  });

  it('does not treat Bethel as betting spam', () => {
    expect(validateChurchName('Bethel').ok).toBe(true);
  });
});

describe('isLikelyTestOrSpamChurch', () => {
  it('flags Test Church and casino names', () => {
    expect(isLikelyTestOrSpamChurch({ name: 'Test Church', billing_status: 'active', lastSeen: '2026-01-01' })).toBe(true);
    expect(isLikelyTestOrSpamChurch({ name: 'Best Online Casino', billing_status: 'active', lastSeen: '2026-01-01' })).toBe(true);
  });

  it('flags never-seen inactive tenants', () => {
    expect(isLikelyTestOrSpamChurch({
      name: 'Grace Chapel',
      billing_status: 'inactive',
      lastSeen: null,
      connected: false,
    })).toBe(true);
  });

  it('keeps a live recurring church', () => {
    expect(isLikelyTestOrSpamChurch({
      name: 'Grace Chapel',
      billing_status: 'active',
      lastSeen: '2026-09-01T12:00:00.000Z',
      connected: true,
    })).toBe(false);
  });

  it('honors an explicit is_test flag', () => {
    expect(isLikelyTestOrSpamChurch({
      name: 'Grace Chapel',
      billing_status: 'active',
      lastSeen: '2026-09-01T12:00:00.000Z',
      is_test: 1,
    })).toBe(true);
  });
});
