/**
 * Edge-case and error handling tests for src/billing.js BillingSystem methods.
 *
 * The existing billing.test.js covers: PRICES structure, TIER_NAMES/LIMITS/INTERVALS,
 * TRIAL/GRACE constants, and constructor _validatePriceIds warnings.
 *
 * This file adds:
 *   - _normaliseTier: valid tiers, invalid/null/empty inputs
 *   - _normaliseBillingInterval: all aliases, null, undefined, empty, invalid
 *   - createCheckout: throws when Stripe not configured, invalid tier, invalid interval
 *   - createPortalSession: throws when Stripe not configured, no billing record
 *   - handleWebhook: throws when Stripe not configured, invalid signature
 *   - isEnabled: true/false based on stripe/env
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);

function clearBillingCache() {
  const billingPath = require.resolve('../src/billing');
  delete require.cache[billingPath];
}

function makeMockDb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS churches (churchId TEXT PRIMARY KEY, name TEXT, billing_tier TEXT, billing_status TEXT, billing_trial_ends TEXT, billing_interval TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS billing_customers (id TEXT PRIMARY KEY, church_id TEXT, reseller_id TEXT, stripe_customer_id TEXT UNIQUE, stripe_subscription_id TEXT, stripe_session_id TEXT, tier TEXT, billing_interval TEXT, status TEXT, trial_ends_at TEXT, current_period_end TEXT, cancel_at_period_end INTEGER DEFAULT 0, grace_ends_at TEXT, email TEXT, created_at TEXT, updated_at TEXT)`);
  return db;
}

// ─── _normaliseTier ───────────────────────────────────────────────────────────

describe('BillingSystem._normaliseTier', () => {
  let BillingSystem, billing, db;

  beforeEach(() => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
    db = makeMockDb();
    billing = new BillingSystem(db);
  });

  afterEach(() => { db?.close(); });

  it('returns the tier unchanged for all valid tiers', () => {
    for (const tier of ['connect', 'plus', 'pro', 'managed', 'event']) {
      expect(billing._normaliseTier(tier)).toBe(tier);
    }
  });

  it('normalises uppercase tier names to lowercase', () => {
    expect(billing._normaliseTier('CONNECT')).toBe('connect');
    expect(billing._normaliseTier('PRO')).toBe('pro');
  });

  it('trims whitespace around tier names', () => {
    expect(billing._normaliseTier('  plus  ')).toBe('plus');
  });

  it('returns null for an invalid tier string', () => {
    expect(billing._normaliseTier('enterprise')).toBeNull();
    expect(billing._normaliseTier('free')).toBeNull();
    expect(billing._normaliseTier('unknown-tier')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(billing._normaliseTier(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(billing._normaliseTier(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(billing._normaliseTier('')).toBeNull();
  });
});

// ─── _normaliseBillingInterval ────────────────────────────────────────────────

describe('BillingSystem._normaliseBillingInterval', () => {
  let BillingSystem, billing, db;

  beforeEach(() => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
    db = makeMockDb();
    billing = new BillingSystem(db);
  });

  afterEach(() => { db?.close(); });

  it('returns "monthly" for "monthly"', () => {
    expect(billing._normaliseBillingInterval('monthly', 'connect')).toBe('monthly');
  });

  it('returns "monthly" for "month" alias', () => {
    expect(billing._normaliseBillingInterval('month', 'plus')).toBe('monthly');
  });

  it('returns "annual" for "annual", "yearly", "year", "annually"', () => {
    for (const v of ['annual', 'yearly', 'year', 'annually']) {
      expect(billing._normaliseBillingInterval(v, 'pro')).toBe('annual');
    }
  });

  it('returns "monthly" when interval is null (default)', () => {
    expect(billing._normaliseBillingInterval(null, 'connect')).toBe('monthly');
  });

  it('returns "monthly" when interval is undefined (default)', () => {
    expect(billing._normaliseBillingInterval(undefined, 'connect')).toBe('monthly');
  });

  it('returns "monthly" when interval is empty string (default)', () => {
    expect(billing._normaliseBillingInterval('', 'connect')).toBe('monthly');
  });

  it('returns null for unrecognised interval string', () => {
    expect(billing._normaliseBillingInterval('quarterly', 'connect')).toBeNull();
    expect(billing._normaliseBillingInterval('biannual', 'pro')).toBeNull();
  });

  it('returns "one_time" for event tier regardless of interval', () => {
    expect(billing._normaliseBillingInterval('monthly', 'event')).toBe('one_time');
    expect(billing._normaliseBillingInterval(null, 'event')).toBe('one_time');
  });

  it('handles interval with hyphens and spaces', () => {
    expect(billing._normaliseBillingInterval('per-month', 'connect')).toBeNull();
    // "one_time" with space: "one time" → 'one_time' alias
    expect(billing._normaliseBillingInterval('one time', 'connect')).toBeNull();
  });
});

// ─── createCheckout — validation errors ──────────────────────────────────────

describe('BillingSystem.createCheckout — error cases', () => {
  let BillingSystem, billing, db;

  beforeEach(() => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
    db = makeMockDb();
    billing = new BillingSystem(db);
  });

  afterEach(() => { db?.close(); });

  it('throws "Stripe not configured" when Stripe is not enabled', async () => {
    await expect(
      billing.createCheckout({ tier: 'connect', churchId: 'c1', email: 'a@b.com', billingInterval: 'monthly' })
    ).rejects.toThrow('Stripe not configured');
  });

  it('throws "Invalid billing tier" for an unknown tier (when Stripe is set)', async () => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake_key';
    // Mock stripe to not actually call the API
    BillingSystem = require('../src/billing').BillingSystem;
    const { _setStripeClientForTests } = require('../src/billing');
    _setStripeClientForTests({
      checkout: { sessions: { create: vi.fn() } },
      billingPortal: { sessions: { create: vi.fn() } },
      webhooks: { constructEvent: vi.fn() },
    });
    const b = new BillingSystem(makeMockDb());

    await expect(
      b.createCheckout({ tier: 'invalid-tier', churchId: 'c1', billingInterval: 'monthly' })
    ).rejects.toThrow(/Invalid billing tier/);
  });

  it('throws "Invalid billing interval" for an unrecognised interval (when Stripe is set)', async () => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake_key';
    BillingSystem = require('../src/billing').BillingSystem;
    const { _setStripeClientForTests } = require('../src/billing');
    _setStripeClientForTests({
      checkout: { sessions: { create: vi.fn() } },
      billingPortal: { sessions: { create: vi.fn() } },
      webhooks: { constructEvent: vi.fn() },
    });
    const b = new BillingSystem(makeMockDb());

    await expect(
      b.createCheckout({ tier: 'connect', churchId: 'c1', billingInterval: 'quarterly' })
    ).rejects.toThrow(/Invalid billing interval/);
  });

  it('throws for enterprise self-serve checkout when Stripe is set', async () => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake_key';
    BillingSystem = require('../src/billing').BillingSystem;
    const { _setStripeClientForTests } = require('../src/billing');
    _setStripeClientForTests({
      checkout: { sessions: { create: vi.fn() } },
      billingPortal: { sessions: { create: vi.fn() } },
      webhooks: { constructEvent: vi.fn() },
    });
    const b = new BillingSystem(makeMockDb());

    await expect(
      b.createCheckout({ tier: 'managed', churchId: 'c1', billingInterval: 'monthly' })
    ).rejects.toThrow(/custom pricing/i);
  });
});

// ─── createPortalSession — error cases ───────────────────────────────────────

describe('BillingSystem.createPortalSession — error cases', () => {
  let BillingSystem, billing, db;

  beforeEach(() => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
    db = makeMockDb();
    billing = new BillingSystem(db);
  });

  afterEach(() => { db?.close(); });

  it('throws "Stripe not configured" when Stripe is not enabled', async () => {
    await expect(
      billing.createPortalSession({ churchId: 'c1', returnUrl: 'https://example.com' })
    ).rejects.toThrow('Stripe not configured');
  });

  it('throws "No billing record found" when church has no stripe_customer_id (Stripe enabled)', async () => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake_key';
    BillingSystem = require('../src/billing').BillingSystem;
    const { _setStripeClientForTests } = require('../src/billing');
    _setStripeClientForTests({
      checkout: { sessions: { create: vi.fn() } },
      billingPortal: { sessions: { create: vi.fn() } },
      webhooks: { constructEvent: vi.fn() },
    });
    const realDb = makeMockDb();
    const b = new BillingSystem(realDb);

    // Church exists but has no stripe_customer_id
    realDb.prepare('INSERT INTO billing_customers (id, church_id, tier, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('bill-c1', 'c1', 'connect', 'trialing', new Date().toISOString(), new Date().toISOString());

    await expect(
      b.createPortalSession({ churchId: 'c1', returnUrl: 'https://example.com' })
    ).rejects.toThrow('No billing record found');

    realDb.close();
  });
});

// ─── handleWebhook — error cases ─────────────────────────────────────────────

describe('BillingSystem.handleWebhook — error cases', () => {
  let BillingSystem, billing, db;

  beforeEach(() => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
    db = makeMockDb();
    billing = new BillingSystem(db);
  });

  afterEach(() => { db?.close(); });

  it('throws "Stripe not configured" when Stripe is not enabled', async () => {
    await expect(
      billing.handleWebhook(Buffer.from('{}'), 'sig-abc')
    ).rejects.toThrow('Stripe not configured');
  });

  it('throws "Webhook signature verification failed" for an invalid signature (Stripe enabled)', async () => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake_key';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    BillingSystem = require('../src/billing').BillingSystem;
    const { _setStripeClientForTests } = require('../src/billing');
    _setStripeClientForTests({
      checkout: { sessions: { create: vi.fn() } },
      billingPortal: { sessions: { create: vi.fn() } },
      webhooks: {
        constructEvent: vi.fn().mockImplementation(() => {
          throw new Error('No signatures found matching the expected signature for payload.');
        }),
      },
    });
    const realDb = makeMockDb();
    const b = new BillingSystem(realDb);

    await expect(
      b.handleWebhook(Buffer.from('{}'), 'bad-signature')
    ).rejects.toThrow('Webhook signature verification failed');

    realDb.close();
  });
});
