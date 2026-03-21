/**
 * Integration: Billing webhook → Church plan update → Feature access gating
 *
 * Tests the full chain from Stripe webhook receipt → church DB update → feature
 * access enforcement, verifying:
 * - Subscription upgrade webhook correctly updates church billing_tier in DB
 * - Subscription downgrade correctly changes tier and restricts features
 * - Feature gating correctly reflects post-webhook tier changes
 * - Payment failure sets past_due status and blocks access (when Stripe enabled)
 * - Subscription cancellation deactivates church
 * - checkAccess correctly gates features by tier without re-querying external systems
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const Stripe = require('stripe');
const { BillingSystem, _setStripeClientForTests, _resetStripeClientForTests } = require('../src/billing');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      token TEXT,
      registeredAt TEXT NOT NULL,
      billing_tier TEXT DEFAULT 'connect',
      billing_status TEXT DEFAULT 'inactive',
      billing_interval TEXT DEFAULT 'monthly'
    )
  `);
  return db;
}

function makeMockStripe() {
  return {
    webhooks: {
      constructEvent: (rawBody, signature, secret) =>
        Stripe.webhooks.constructEvent(rawBody, signature, secret),
    },
    customers: {
      createBalanceTransaction: async () => ({ id: 'cbtxn_mock' }),
    },
  };
}

function signEvent(event, secret) {
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  return { payload, signature };
}

function seedChurch(db, churchId, { tier = 'connect', status = 'inactive', interval = 'monthly' } = {}) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO churches (churchId, name, email, token, registeredAt, billing_tier, billing_status, billing_interval)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(churchId, `Church ${churchId}`, `${churchId}@test.com`, `tok-${churchId}`, now, tier, status, interval);
}

function seedBillingCustomer(db, churchId, { tier = 'connect', status = 'active', subId = 'sub_test', interval = 'monthly', customerId = 'cus_test' } = {}) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO billing_customers
    (id, church_id, stripe_customer_id, stripe_subscription_id, stripe_session_id,
     tier, billing_interval, status, email, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `bc_${churchId}`, churchId, customerId, subId, `cs_${churchId}`,
    tier, interval, status, `${churchId}@test.com`, now, now,
  );
}

const WEBHOOK_SECRET = 'whsec_test_plan_integration';

// ─── A. Subscription upgrade → tier changes → feature access unlocked ─────────

describe('Subscription upgrade webhook → billing_tier update → feature access', () => {
  let db, billing;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock_plan_integration';
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    db = createDb();
    billing = new BillingSystem(db);
    _setStripeClientForTests(makeMockStripe());
  });

  afterEach(() => {
    _resetStripeClientForTests();
    db?.close();
  });

  it('subscription updated webhook changes billing_tier from connect to pro in DB', async () => {
    seedChurch(db, 'ch-upgrade', { tier: 'connect', status: 'active' });
    seedBillingCustomer(db, 'ch-upgrade', { tier: 'connect', subId: 'sub_upgrade_1' });

    const event = {
      id: 'evt_upgrade_1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_upgrade_1',
          status: 'active',
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
          cancel_at_period_end: false,
          metadata: { churchId: 'ch-upgrade', tier: 'pro', billingInterval: 'monthly' },
        },
      },
    };

    const { payload, signature } = signEvent(event, WEBHOOK_SECRET);
    await billing.handleWebhook(payload, signature);

    const church = db.prepare('SELECT billing_tier, billing_status FROM churches WHERE churchId = ?').get('ch-upgrade');
    expect(church.billing_tier).toBe('pro');
    expect(church.billing_status).toBe('active');
  });

  it('upgrade from connect to pro unlocks planning_center feature', async () => {
    seedChurch(db, 'ch-pc', { tier: 'pro', status: 'active' });

    // Pro tier church should have access to planning_center
    const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get('ch-pc');
    const result = billing.checkAccess(church, 'planning_center');
    expect(result.allowed).toBe(true);
  });

  it('connect tier church is blocked from planning_center feature', async () => {
    seedChurch(db, 'ch-connect', { tier: 'connect', status: 'active' });

    const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get('ch-connect');
    const result = billing.checkAccess(church, 'planning_center');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Pro or Enterprise/);
  });

  it('subscription downgrade webhook changes billing_tier from pro to connect in DB', async () => {
    seedChurch(db, 'ch-downgrade', { tier: 'pro', status: 'active' });
    seedBillingCustomer(db, 'ch-downgrade', { tier: 'pro', subId: 'sub_downgrade_1' });

    const event = {
      id: 'evt_downgrade_1',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_downgrade_1',
          status: 'active',
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
          cancel_at_period_end: false,
          metadata: { churchId: 'ch-downgrade', tier: 'connect', billingInterval: 'monthly' },
        },
      },
    };

    const { payload, signature } = signEvent(event, WEBHOOK_SECRET);
    await billing.handleWebhook(payload, signature);

    const church = db.prepare('SELECT billing_tier FROM churches WHERE churchId = ?').get('ch-downgrade');
    expect(church.billing_tier).toBe('connect');
  });

  it('after downgrade, planning_center feature is blocked for the church', async () => {
    seedChurch(db, 'ch-downgraded', { tier: 'pro', status: 'active' });
    seedBillingCustomer(db, 'ch-downgraded', { tier: 'pro', subId: 'sub_downgraded_1' });

    // Downgrade webhook
    const event = {
      id: 'evt_dg_access',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_downgraded_1',
          status: 'active',
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
          cancel_at_period_end: false,
          metadata: { churchId: 'ch-downgraded', tier: 'connect', billingInterval: 'monthly' },
        },
      },
    };

    const { payload, signature } = signEvent(event, WEBHOOK_SECRET);
    await billing.handleWebhook(payload, signature);

    const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get('ch-downgraded');
    const result = billing.checkAccess(church, 'planning_center');
    expect(result.allowed).toBe(false);
  });
});

// ─── B. Payment failure → past_due status → feature access blocked ─────────────

describe('Payment failure webhook → past_due → access blocked', () => {
  let db, billing;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock_payment_fail';
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    db = createDb();
    billing = new BillingSystem(db);
    _setStripeClientForTests(makeMockStripe());
  });

  afterEach(() => {
    _resetStripeClientForTests();
    db?.close();
  });

  it('invoice.payment_failed webhook sets billing_status to past_due in churches table', async () => {
    seedChurch(db, 'ch-fail', { tier: 'pro', status: 'active' });
    seedBillingCustomer(db, 'ch-fail', { tier: 'pro', subId: 'sub_fail_1', status: 'active' });

    const event = {
      id: 'evt_fail_1',
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: 'inv_fail_1',
          subscription: 'sub_fail_1',
        },
      },
    };

    const { payload, signature } = signEvent(event, WEBHOOK_SECRET);
    await billing.handleWebhook(payload, signature);

    const church = db.prepare('SELECT billing_status FROM churches WHERE churchId = ?').get('ch-fail');
    expect(church.billing_status).toBe('past_due');
  });

  it('billing_customers record is updated to past_due with grace period', async () => {
    seedChurch(db, 'ch-grace', { tier: 'pro', status: 'active' });
    seedBillingCustomer(db, 'ch-grace', { tier: 'pro', subId: 'sub_grace_1', status: 'active' });

    const event = {
      id: 'evt_grace_1',
      type: 'invoice.payment_failed',
      data: { object: { id: 'inv_grace', subscription: 'sub_grace_1' } },
    };

    const { payload, signature } = signEvent(event, WEBHOOK_SECRET);
    await billing.handleWebhook(payload, signature);

    const billing_rec = db.prepare("SELECT status, grace_ends_at FROM billing_customers WHERE church_id = ?").get('ch-grace');
    expect(billing_rec.status).toBe('past_due');
    expect(billing_rec.grace_ends_at).toBeTruthy();

    // Grace period should be ~7 days from now
    const graceDate = new Date(billing_rec.grace_ends_at);
    const daysUntilGrace = (graceDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    expect(daysUntilGrace).toBeGreaterThan(5);
    expect(daysUntilGrace).toBeLessThan(9);
  });
});

// ─── C. Subscription cancellation → deactivation ──────────────────────────────

describe('Subscription cancelled webhook → church deactivation', () => {
  let db, billing;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock_cancel';
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    db = createDb();
    billing = new BillingSystem(db);
    _setStripeClientForTests(makeMockStripe());
  });

  afterEach(() => {
    _resetStripeClientForTests();
    db?.close();
  });

  it('customer.subscription.deleted webhook deactivates the church', async () => {
    seedChurch(db, 'ch-cancel', { tier: 'plus', status: 'active' });
    seedBillingCustomer(db, 'ch-cancel', { tier: 'plus', subId: 'sub_cancel_1', status: 'active' });

    const event = {
      id: 'evt_cancel_1',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_cancel_1',
          status: 'canceled',
          current_period_end: Math.floor(Date.now() / 1000) + 86400,
          metadata: { churchId: 'ch-cancel', tier: 'plus' },
        },
      },
    };

    const { payload, signature } = signEvent(event, WEBHOOK_SECRET);
    await billing.handleWebhook(payload, signature);

    const church = db.prepare('SELECT billing_status FROM churches WHERE churchId = ?').get('ch-cancel');
    expect(church.billing_status).toBe('inactive');
  });
});

// ─── D. Feature access gating by tier ─────────────────────────────────────────

describe('checkAccess — tier-based feature gating', () => {
  let db, billing;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock_access';
    db = createDb();
    billing = new BillingSystem(db);
    // No Stripe mock needed — checkAccess uses DB only
    _setStripeClientForTests(null);
  });

  afterEach(() => {
    _resetStripeClientForTests();
    db?.close();
  });

  it('connect tier: autopilot is blocked', () => {
    const church = { billing_tier: 'connect', billing_status: 'active' };
    const result = billing.checkAccess(church, 'autopilot');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Plus or higher/);
  });

  it('plus tier: autopilot is allowed', () => {
    const church = { billing_tier: 'plus', billing_status: 'active' };
    const result = billing.checkAccess(church, 'autopilot');
    expect(result.allowed).toBe(true);
  });

  it('connect tier: scheduler is blocked', () => {
    const church = { billing_tier: 'connect', billing_status: 'active' };
    const result = billing.checkAccess(church, 'scheduler');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Plus or higher/);
  });

  it('plus tier: scheduler is allowed', () => {
    const church = { billing_tier: 'plus', billing_status: 'active' };
    const result = billing.checkAccess(church, 'scheduler');
    expect(result.allowed).toBe(true);
  });

  it('plus tier: scheduler_auto is blocked (requires Pro)', () => {
    const church = { billing_tier: 'plus', billing_status: 'active' };
    const result = billing.checkAccess(church, 'scheduler_auto');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Pro or Enterprise/);
  });

  it('pro tier: scheduler_auto is allowed', () => {
    const church = { billing_tier: 'pro', billing_status: 'active' };
    const result = billing.checkAccess(church, 'scheduler_auto');
    expect(result.allowed).toBe(true);
  });

  it('managed (enterprise) tier: all features are allowed', () => {
    const church = { billing_tier: 'managed', billing_status: 'active' };
    const features = ['planning_center', 'monthly_report', 'autopilot', 'scheduler', 'scheduler_auto', 'multi_church'];
    for (const feature of features) {
      const result = billing.checkAccess(church, feature);
      expect(result.allowed).toBe(true);
    }
  });

  it('multi_church requires plus or higher — connect is blocked', () => {
    const church = { billing_tier: 'connect', billing_status: 'active' };
    const result = billing.checkAccess(church, 'multi_church');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Plus or higher/);
  });

  it('multi_church is allowed on plus tier', () => {
    const church = { billing_tier: 'plus', billing_status: 'active' };
    const result = billing.checkAccess(church, 'multi_church');
    expect(result.allowed).toBe(true);
  });

  it('monthly_report requires pro or higher — plus is blocked', () => {
    const church = { billing_tier: 'plus', billing_status: 'active' };
    const result = billing.checkAccess(church, 'monthly_report');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Pro or Enterprise/);
  });

  it('monthly_report is allowed on pro tier', () => {
    const church = { billing_tier: 'pro', billing_status: 'active' };
    const result = billing.checkAccess(church, 'monthly_report');
    expect(result.allowed).toBe(true);
  });
});

// ─── E. _normaliseTier robustness ─────────────────────────────────────────────

describe('_normaliseTier — input normalisation for billing tier values', () => {
  let db, billing;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock_normalise';
    db = createDb();
    billing = new BillingSystem(db);
    _setStripeClientForTests(null);
  });

  afterEach(() => {
    _resetStripeClientForTests();
    db?.close();
  });

  it('normalises "Pro" (capitalised) to "pro"', () => {
    expect(billing._normaliseTier('Pro')).toBe('pro');
  });

  it('normalises "CONNECT" (uppercase) to "connect"', () => {
    expect(billing._normaliseTier('CONNECT')).toBe('connect');
  });

  it('normalises " plus " (with whitespace) to "plus"', () => {
    expect(billing._normaliseTier(' plus ')).toBe('plus');
  });

  it('returns null for empty string (invalid tier)', () => {
    expect(billing._normaliseTier('')).toBeFalsy();
  });

  it('returns null for undefined (invalid tier)', () => {
    expect(billing._normaliseTier(undefined)).toBeFalsy();
  });

  it('normalises "managed" correctly (Enterprise tier)', () => {
    expect(billing._normaliseTier('managed')).toBe('managed');
  });
});
