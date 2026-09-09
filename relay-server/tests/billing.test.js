/**
 * Tests for src/billing.js — PRICES structure and _validatePriceIds behavior.
 *
 * These tests verify the static billing configuration without requiring
 * a Stripe API key or database connection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

describe('PRICES structure', () => {
  let PRICES, TIER_NAMES, TIER_LIMITS, TIER_MONTHLY_CENTS, BILLING_INTERVALS, TRIAL_PERIOD_DAYS, GRACE_PERIOD_DAYS;

  beforeEach(() => {
    // Clear the module from Node's CJS cache so env changes take effect
    const billingPath = require.resolve('../src/billing');
    delete require.cache[billingPath];

    // Also clear the stripe module cache to avoid stale state
    try {
      const stripePath = require.resolve('stripe');
      delete require.cache[stripePath];
    } catch { /* stripe may not resolve */ }

    // Ensure Stripe does not throw during import
    process.env.STRIPE_SECRET_KEY = '';

    const billing = require('../src/billing');
    PRICES = billing.PRICES;
    TIER_NAMES = billing.TIER_NAMES;
    TIER_LIMITS = billing.TIER_LIMITS;
    TIER_MONTHLY_CENTS = billing.TIER_MONTHLY_CENTS;
    BILLING_INTERVALS = billing.BILLING_INTERVALS;
    TRIAL_PERIOD_DAYS = billing.TRIAL_PERIOD_DAYS;
    GRACE_PERIOD_DAYS = billing.GRACE_PERIOD_DAYS;
  });

  it('has all expected tiers', () => {
    const expectedTiers = ['connect', 'plus', 'pro', 'managed', 'event'];
    expect(Object.keys(PRICES)).toEqual(expect.arrayContaining(expectedTiers));
    expect(Object.keys(PRICES)).toHaveLength(expectedTiers.length);
  });

  it('subscription tiers have monthly and annual intervals', () => {
    const subscriptionTiers = ['connect', 'plus', 'pro', 'managed'];
    for (const tier of subscriptionTiers) {
      expect(PRICES[tier]).toHaveProperty('monthly');
      expect(PRICES[tier]).toHaveProperty('annual');
    }
  });

  it('event tier has one_time interval only', () => {
    expect(PRICES.event).toHaveProperty('one_time');
    expect(Object.keys(PRICES.event)).toEqual(['one_time']);
  });

  it('TIER_NAMES maps every PRICES tier to a display name', () => {
    for (const tier of Object.keys(PRICES)) {
      expect(TIER_NAMES).toHaveProperty(tier);
      expect(typeof TIER_NAMES[tier]).toBe('string');
      expect(TIER_NAMES[tier].length).toBeGreaterThan(0);
    }
  });

  it('TIER_LIMITS maps every PRICES tier', () => {
    for (const tier of Object.keys(PRICES)) {
      expect(TIER_LIMITS).toHaveProperty(tier);
      expect(TIER_LIMITS[tier]).toHaveProperty('rooms');
      expect(TIER_LIMITS[tier]).toHaveProperty('devices');
    }
  });

  it('BILLING_INTERVALS is a Set with expected values', () => {
    expect(BILLING_INTERVALS).toBeInstanceOf(Set);
    expect(BILLING_INTERVALS.has('monthly')).toBe(true);
    expect(BILLING_INTERVALS.has('annual')).toBe(true);
    expect(BILLING_INTERVALS.has('one_time')).toBe(true);
  });

  it('TRIAL_PERIOD_DAYS is a positive number', () => {
    expect(typeof TRIAL_PERIOD_DAYS).toBe('number');
    expect(TRIAL_PERIOD_DAYS).toBeGreaterThan(0);
  });

  it('GRACE_PERIOD_DAYS is a positive number', () => {
    expect(typeof GRACE_PERIOD_DAYS).toBe('number');
    expect(GRACE_PERIOD_DAYS).toBeGreaterThan(0);
  });

  it('referral free-month credits match live list prices, not the old $79/$149/$199 ladder', () => {
    expect(TIER_MONTHLY_CENTS).toEqual({
      connect: 4900,
      plus: 9900,
      pro: 14900,
      managed: null,
      event: 9900,
    });
  });
});

describe('hasPaidBillingAccess (shared WS + feature-API rule)', () => {
  let hasPaidBillingAccess;

  beforeEach(() => {
    const billingPath = require.resolve('../src/billing');
    delete require.cache[billingPath];
    process.env.STRIPE_SECRET_KEY = '';
    hasPaidBillingAccess = require('../src/billing').hasPaidBillingAccess;
  });

  it('allows active and trialing', () => {
    expect(hasPaidBillingAccess({ billing_status: 'active' }).allowed).toBe(true);
    expect(hasPaidBillingAccess({ billing_status: 'trialing' }).allowed).toBe(true);
  });

  it('allows past_due while grace is still in the future', () => {
    const now = new Date('2026-09-09T12:00:00.000Z');
    const result = hasPaidBillingAccess({
      billing_status: 'past_due',
      billing_grace_ends_at: '2026-09-16T12:00:00.000Z',
    }, now);
    expect(result.allowed).toBe(true);
    expect(result.inGracePeriod).toBe(true);
  });

  it('denies past_due when grace has expired or is missing', () => {
    const now = new Date('2026-09-09T12:00:00.000Z');
    expect(hasPaidBillingAccess({ billing_status: 'past_due' }, now).allowed).toBe(false);
    expect(hasPaidBillingAccess({
      billing_status: 'past_due',
      billing_grace_ends_at: '2026-09-09T11:59:59.000Z',
    }, now).allowed).toBe(false);
  });

  it('denies inactive, canceled, and unknown statuses', () => {
    expect(hasPaidBillingAccess({ billing_status: 'inactive' }).allowed).toBe(false);
    expect(hasPaidBillingAccess({ billing_status: 'canceled' }).allowed).toBe(false);
    expect(hasPaidBillingAccess({ billing_status: 'trial_expired' }).allowed).toBe(false);
  });
});

describe('_validatePriceIds (via BillingSystem constructor)', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    // Clear billing module cache between tests
    const billingPath = require.resolve('../src/billing');
    delete require.cache[billingPath];
    try {
      const stripePath = require.resolve('stripe');
      delete require.cache[stripePath];
    } catch { /* stripe may not resolve */ }
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('warns on placeholder prices when Stripe is configured', () => {
    // Set a fake Stripe key so stripe initializes
    process.env.NODE_ENV = 'test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake_key_for_unit_testing';

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { BillingSystem } = require('../src/billing');

    // BillingSystem requires a db; mock the minimum it needs
    const mockDb = {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn(), get: vi.fn(), all: vi.fn() }),
    };

    new BillingSystem(mockDb);

    // With placeholder prices and Stripe configured, console.warn should be called
    const warnCalls = warnSpy.mock.calls.flat().join(' ');
    expect(warnCalls).toContain('placeholder');

    warnSpy.mockRestore();
  });

  it('throws in production-like env when Stripe prices are placeholders', () => {
    process.env.NODE_ENV = 'production';
    process.env.STRIPE_SECRET_KEY = 'sk_live_fake_for_validation';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fake_for_validation';
    delete process.env.VITEST;

    const { BillingSystem } = require('../src/billing');

    const mockDb = {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn(), get: vi.fn(), all: vi.fn() }),
    };

    expect(() => new BillingSystem(mockDb)).toThrow(/STRIPE_PRICE_CONNECT/);
  });

  it('does not warn about placeholders when Stripe is not configured', () => {
    // No STRIPE_SECRET_KEY means stripe init will fail gracefully
    process.env.STRIPE_SECRET_KEY = '';

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { BillingSystem } = require('../src/billing');

    const mockDb = {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn(), get: vi.fn(), all: vi.fn() }),
    };

    new BillingSystem(mockDb);

    // _validatePriceIds returns early if stripe is not configured,
    // so no placeholder warnings should appear
    const warnCalls = warnSpy.mock.calls.flat().join(' ');
    expect(warnCalls).not.toContain('placeholder');

    warnSpy.mockRestore();
  });
});
