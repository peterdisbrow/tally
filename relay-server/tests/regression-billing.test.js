/**
 * Regression-prevention tests: billing business logic
 *
 * Covers:
 *   - Trial period constant is 30 days
 *   - Grace period constant is 7 days
 *   - checkAccess: trialing status allows access (when Stripe enabled)
 *   - checkAccess: past_due / inactive / canceled statuses block access (Stripe enabled)
 *   - checkAccess: null billing_tier falls back to 'connect' limits
 *   - checkAccess: unknown feature returns allowed:true (safe default)
 *   - Boundary: billing_status === 'trialing' is treated as active
 *   - Grace period: past_due church within grace period — billing record shows past_due
 *   - Plan limits: multi_church blocked on connect (rooms <= 1), allowed on plus+
 *   - planning_center blocked on connect and plus, allowed on pro and managed
 *   - monthly_report blocked on connect and plus, allowed on pro and managed
 *   - scheduler blocked on connect, allowed on plus+
 *   - scheduler_auto blocked on connect and plus, allowed on pro and managed
 *   - reseller_api only allowed on managed
 *   - propresenter blocked on connect, allowed on plus+
 *   - oncall_rotation blocked on connect, allowed on plus+
 *   - live_preview blocked on connect, allowed on plus+
 *   - autopilot blocked on connect, allowed on plus+
 *   - Device access: connect tier restricted to atem/obs/vmix
 *   - Device access: all non-connect tiers allow all devices
 *   - checkDeviceAccess: unknown device type blocked on connect
 *   - _normaliseBillingInterval: event tier always returns one_time
 *   - _normaliseBillingInterval: null/undefined defaults to monthly for subscriptions
 *   - _normaliseBillingInterval: 'yearly' alias maps to annual
 *   - _normaliseBillingInterval: 'annually' alias maps to annual
 *   - getStatus: no billing record returns no_billing status
 *   - _onPaymentFailed: sets past_due and grace_ends_at 7 days in future
 *   - _onPaymentSucceeded: restores past_due → active
 *   - _onSubscriptionCancelled: sets billing_status to inactive on church
 *   - Tier room limits: connect=1, plus=3, pro=5, managed=Infinity
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

function clearBillingCache() {
  const billingPath = require.resolve('../src/billing');
  delete require.cache[billingPath];
}

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      email TEXT,
      token TEXT,
      portal_email TEXT,
      registeredAt TEXT NOT NULL DEFAULT (datetime('now')),
      billing_tier TEXT DEFAULT 'connect',
      billing_status TEXT DEFAULT 'inactive',
      billing_interval TEXT DEFAULT 'monthly'
    )
  `);
  return db;
}

function seedChurch(db, churchId, { tier = 'connect', status = 'inactive', interval = 'monthly' } = {}) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO churches (churchId, name, email, portal_email, token, registeredAt, billing_tier, billing_status, billing_interval)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(churchId, `Church ${churchId}`, `${churchId}@test.com`, `${churchId}@test.com`, `tok-${churchId}`, now, tier, status, interval);
}

function seedBillingCustomer(db, churchId, {
  tier = 'connect', status = 'active', subId = 'sub_test',
  interval = 'monthly', customerId = 'cus_test', graceEndsAt = null
} = {}) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO billing_customers
      (id, church_id, stripe_customer_id, stripe_subscription_id, stripe_session_id,
       tier, billing_interval, status, grace_ends_at, email, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `bc_${churchId}`, churchId, customerId, subId, `cs_${churchId}`,
    tier, interval, status, graceEndsAt,
    `${churchId}@test.com`, now, now
  );
}

// ─── Constants ────────────────────────────────────────────────────────────────

describe('Billing constants', () => {
  let TRIAL_PERIOD_DAYS, GRACE_PERIOD_DAYS;

  beforeEach(() => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = '';
    const m = require('../src/billing');
    TRIAL_PERIOD_DAYS = m.TRIAL_PERIOD_DAYS;
    GRACE_PERIOD_DAYS = m.GRACE_PERIOD_DAYS;
  });

  it('TRIAL_PERIOD_DAYS is 30', () => {
    expect(TRIAL_PERIOD_DAYS).toBe(30);
  });

  it('GRACE_PERIOD_DAYS is 7', () => {
    expect(GRACE_PERIOD_DAYS).toBe(7);
  });
});

// ─── checkAccess — billing status enforcement (Stripe disabled) ───────────────

describe('checkAccess — Stripe NOT enabled (billing status not enforced)', () => {
  let BillingSystem, billing;

  beforeEach(() => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
    const db = makeDb();
    billing = new BillingSystem(db);
  });

  it('allows access even when billing_status is inactive (Stripe not configured)', () => {
    const result = billing.checkAccess({ billing_tier: 'plus', billing_status: 'inactive' }, 'autopilot');
    expect(result.allowed).toBe(true);
  });

  it('allows access when billing_status is past_due (Stripe not configured)', () => {
    const result = billing.checkAccess({ billing_tier: 'pro', billing_status: 'past_due' }, 'planning_center');
    expect(result.allowed).toBe(true);
  });

  it('tier feature gating is still enforced even without Stripe', () => {
    const result = billing.checkAccess({ billing_tier: 'connect', billing_status: 'inactive' }, 'autopilot');
    expect(result.allowed).toBe(false);
  });
});

// ─── checkAccess — billing status enforcement (Stripe enabled) ────────────────

describe('checkAccess — Stripe IS enabled (billing status enforced)', () => {
  let BillingSystem, billing;

  beforeEach(() => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
    const db = makeDb();
    billing = new BillingSystem(db);
    // Simulate Stripe being enabled
    billing.isEnabled = () => true;
  });

  it('active status allows access', () => {
    const result = billing.checkAccess({ billing_tier: 'pro', billing_status: 'active' }, 'planning_center');
    expect(result.allowed).toBe(true);
  });

  it('trialing status allows access (boundary: trial counts as active)', () => {
    const result = billing.checkAccess({ billing_tier: 'pro', billing_status: 'trialing' }, 'planning_center');
    expect(result.allowed).toBe(true);
  });

  it('past_due status blocks access', () => {
    const result = billing.checkAccess({ billing_tier: 'pro', billing_status: 'past_due' }, 'planning_center');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/past_due/);
  });

  it('inactive status blocks access', () => {
    const result = billing.checkAccess({ billing_tier: 'pro', billing_status: 'inactive' }, 'planning_center');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/inactive/);
  });

  it('canceled status blocks access', () => {
    const result = billing.checkAccess({ billing_tier: 'pro', billing_status: 'canceled' }, 'planning_center');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/canceled/);
  });

  it('null billing_tier falls back to connect limits', () => {
    // null tier → falls back to 'connect' → autopilot blocked
    const result = billing.checkAccess({ billing_tier: null, billing_status: 'active' }, 'autopilot');
    expect(result.allowed).toBe(false);
  });

  it('unknown feature returns allowed:true (safe default)', () => {
    const result = billing.checkAccess({ billing_tier: 'connect', billing_status: 'active' }, 'totally_unknown_feature_xyz');
    expect(result.allowed).toBe(true);
  });
});

// ─── Feature gating: multi_church / rooms ─────────────────────────────────────

describe('checkAccess — multi_church feature', () => {
  let BillingSystem, billing;

  beforeEach(() => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
    const db = makeDb();
    billing = new BillingSystem(db);
  });

  it('connect: multi_church is blocked (rooms=1)', () => {
    expect(billing.checkAccess({ billing_tier: 'connect', billing_status: 'active' }, 'multi_church').allowed).toBe(false);
  });

  it('plus: multi_church is allowed (rooms=3)', () => {
    expect(billing.checkAccess({ billing_tier: 'plus', billing_status: 'active' }, 'multi_church').allowed).toBe(true);
  });

  it('pro: multi_church is allowed (rooms=5)', () => {
    expect(billing.checkAccess({ billing_tier: 'pro', billing_status: 'active' }, 'multi_church').allowed).toBe(true);
  });

  it('managed: multi_church is allowed (rooms=Infinity)', () => {
    expect(billing.checkAccess({ billing_tier: 'managed', billing_status: 'active' }, 'multi_church').allowed).toBe(true);
  });
});

// ─── Feature gating: planning_center ──────────────────────────────────────────

describe('checkAccess — planning_center feature', () => {
  let BillingSystem, billing;

  beforeEach(() => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
    const db = makeDb();
    billing = new BillingSystem(db);
  });

  it('connect: planning_center is blocked', () => {
    expect(billing.checkAccess({ billing_tier: 'connect', billing_status: 'active' }, 'planning_center').allowed).toBe(false);
  });

  it('plus: planning_center is blocked', () => {
    expect(billing.checkAccess({ billing_tier: 'plus', billing_status: 'active' }, 'planning_center').allowed).toBe(false);
  });

  it('pro: planning_center is allowed', () => {
    expect(billing.checkAccess({ billing_tier: 'pro', billing_status: 'active' }, 'planning_center').allowed).toBe(true);
  });

  it('managed: planning_center is allowed', () => {
    expect(billing.checkAccess({ billing_tier: 'managed', billing_status: 'active' }, 'planning_center').allowed).toBe(true);
  });
});

// ─── Feature gating: monthly_report ───────────────────────────────────────────

describe('checkAccess — monthly_report feature', () => {
  let BillingSystem, billing;

  beforeEach(() => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
    const db = makeDb();
    billing = new BillingSystem(db);
  });

  it('connect: monthly_report is blocked', () => {
    expect(billing.checkAccess({ billing_tier: 'connect', billing_status: 'active' }, 'monthly_report').allowed).toBe(false);
  });

  it('plus: monthly_report is blocked', () => {
    expect(billing.checkAccess({ billing_tier: 'plus', billing_status: 'active' }, 'monthly_report').allowed).toBe(false);
  });

  it('pro: monthly_report is allowed', () => {
    expect(billing.checkAccess({ billing_tier: 'pro', billing_status: 'active' }, 'monthly_report').allowed).toBe(true);
  });

  it('managed: monthly_report is allowed', () => {
    expect(billing.checkAccess({ billing_tier: 'managed', billing_status: 'active' }, 'monthly_report').allowed).toBe(true);
  });
});

// ─── Feature gating: scheduler / scheduler_auto ───────────────────────────────

describe('checkAccess — scheduler feature', () => {
  let BillingSystem, billing;

  beforeEach(() => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
    const db = makeDb();
    billing = new BillingSystem(db);
  });

  it('connect: scheduler is blocked', () => {
    expect(billing.checkAccess({ billing_tier: 'connect', billing_status: 'active' }, 'scheduler').allowed).toBe(false);
  });

  it('plus: scheduler is allowed', () => {
    expect(billing.checkAccess({ billing_tier: 'plus', billing_status: 'active' }, 'scheduler').allowed).toBe(true);
  });

  it('connect: scheduler_auto is blocked', () => {
    expect(billing.checkAccess({ billing_tier: 'connect', billing_status: 'active' }, 'scheduler_auto').allowed).toBe(false);
  });

  it('plus: scheduler_auto is blocked', () => {
    expect(billing.checkAccess({ billing_tier: 'plus', billing_status: 'active' }, 'scheduler_auto').allowed).toBe(false);
  });

  it('pro: scheduler_auto is allowed', () => {
    expect(billing.checkAccess({ billing_tier: 'pro', billing_status: 'active' }, 'scheduler_auto').allowed).toBe(true);
  });

  it('managed: scheduler_auto is allowed', () => {
    expect(billing.checkAccess({ billing_tier: 'managed', billing_status: 'active' }, 'scheduler_auto').allowed).toBe(true);
  });
});

// ─── Feature gating: reseller_api ────────────────────────────────────────────

describe('checkAccess — reseller_api feature', () => {
  let BillingSystem, billing;

  beforeEach(() => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
    const db = makeDb();
    billing = new BillingSystem(db);
  });

  it('connect: reseller_api is blocked', () => {
    expect(billing.checkAccess({ billing_tier: 'connect', billing_status: 'active' }, 'reseller_api').allowed).toBe(false);
  });

  it('plus: reseller_api is blocked', () => {
    expect(billing.checkAccess({ billing_tier: 'plus', billing_status: 'active' }, 'reseller_api').allowed).toBe(false);
  });

  it('pro: reseller_api is blocked', () => {
    expect(billing.checkAccess({ billing_tier: 'pro', billing_status: 'active' }, 'reseller_api').allowed).toBe(false);
  });

  it('managed: reseller_api is allowed (only managed gets it)', () => {
    expect(billing.checkAccess({ billing_tier: 'managed', billing_status: 'active' }, 'reseller_api').allowed).toBe(true);
  });
});

// ─── Feature gating: plus-exclusive features ─────────────────────────────────

describe('checkAccess — plus-exclusive features (propresenter, oncall_rotation, live_preview)', () => {
  let BillingSystem, billing;

  beforeEach(() => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
    const db = makeDb();
    billing = new BillingSystem(db);
  });

  const plusOnlyFeatures = ['propresenter', 'oncall_rotation', 'live_preview'];

  for (const feature of plusOnlyFeatures) {
    it(`connect: ${feature} is blocked`, () => {
      expect(billing.checkAccess({ billing_tier: 'connect', billing_status: 'active' }, feature).allowed).toBe(false);
    });

    it(`plus: ${feature} is allowed`, () => {
      expect(billing.checkAccess({ billing_tier: 'plus', billing_status: 'active' }, feature).allowed).toBe(true);
    });

    it(`pro: ${feature} is allowed`, () => {
      expect(billing.checkAccess({ billing_tier: 'pro', billing_status: 'active' }, feature).allowed).toBe(true);
    });

    it(`managed: ${feature} is allowed`, () => {
      expect(billing.checkAccess({ billing_tier: 'managed', billing_status: 'active' }, feature).allowed).toBe(true);
    });
  }
});

// ─── Device access gating ────────────────────────────────────────────────────

describe('checkDeviceAccess — device tier gating', () => {
  let BillingSystem, billing;

  beforeEach(() => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
    const db = makeDb();
    billing = new BillingSystem(db);
  });

  const connectAllowedDevices = ['atem', 'obs', 'vmix'];
  const connectBlockedDevices = ['propresenter', 'companion', 'epiphan', 'aja', 'teradek', 'birddog', 'blackmagic'];

  for (const dev of connectAllowedDevices) {
    it(`connect: ${dev} is allowed`, () => {
      expect(billing.checkDeviceAccess({ billing_tier: 'connect' }, dev).allowed).toBe(true);
    });
  }

  for (const dev of connectBlockedDevices) {
    it(`connect: ${dev} is blocked`, () => {
      const result = billing.checkDeviceAccess({ billing_tier: 'connect' }, dev);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/Connect|Plus/);
    });
  }

  for (const tier of ['plus', 'pro', 'managed', 'event']) {
    it(`${tier}: all devices allowed`, () => {
      for (const dev of [...connectAllowedDevices, ...connectBlockedDevices]) {
        expect(billing.checkDeviceAccess({ billing_tier: tier }, dev).allowed).toBe(true);
      }
    });
  }

  it('connect: unknown device type is blocked (not in allowed list)', () => {
    expect(billing.checkDeviceAccess({ billing_tier: 'connect' }, 'completely_unknown_device').allowed).toBe(false);
  });
});

// ─── Tier room limits ─────────────────────────────────────────────────────────

describe('TIER_LIMITS — room counts', () => {
  let TIER_LIMITS;

  beforeEach(() => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = '';
    TIER_LIMITS = require('../src/billing').TIER_LIMITS;
  });

  it('connect has 1 room', () => { expect(TIER_LIMITS.connect.rooms).toBe(1); });
  it('plus has 3 rooms', () => { expect(TIER_LIMITS.plus.rooms).toBe(3); });
  it('pro has 5 rooms', () => { expect(TIER_LIMITS.pro.rooms).toBe(5); });
  it('managed has unlimited rooms (Infinity)', () => { expect(TIER_LIMITS.managed.rooms).toBe(Infinity); });
  it('event has 1 room', () => { expect(TIER_LIMITS.event.rooms).toBe(1); });
});

// ─── _normaliseBillingInterval edge cases ─────────────────────────────────────

describe('BillingSystem._normaliseBillingInterval', () => {
  let BillingSystem, billing;

  beforeEach(() => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
    const db = makeDb();
    billing = new BillingSystem(db);
  });

  it('event tier always returns one_time regardless of interval input', () => {
    expect(billing._normaliseBillingInterval('monthly', 'event')).toBe('one_time');
    expect(billing._normaliseBillingInterval('annual', 'event')).toBe('one_time');
    expect(billing._normaliseBillingInterval(null, 'event')).toBe('one_time');
    expect(billing._normaliseBillingInterval(undefined, 'event')).toBe('one_time');
  });

  it('null interval defaults to monthly for subscription tiers', () => {
    expect(billing._normaliseBillingInterval(null, 'connect')).toBe('monthly');
    expect(billing._normaliseBillingInterval(undefined, 'pro')).toBe('monthly');
    expect(billing._normaliseBillingInterval('', 'plus')).toBe('monthly');
  });

  it('"yearly" alias maps to annual', () => {
    expect(billing._normaliseBillingInterval('yearly', 'connect')).toBe('annual');
  });

  it('"year" alias maps to annual', () => {
    expect(billing._normaliseBillingInterval('year', 'connect')).toBe('annual');
  });

  it('"annually" alias maps to annual', () => {
    expect(billing._normaliseBillingInterval('annually', 'connect')).toBe('annual');
  });

  it('"month" alias maps to monthly', () => {
    expect(billing._normaliseBillingInterval('month', 'connect')).toBe('monthly');
  });

  it('"monthly" maps to monthly', () => {
    expect(billing._normaliseBillingInterval('monthly', 'connect')).toBe('monthly');
  });

  it('"annual" maps to annual', () => {
    expect(billing._normaliseBillingInterval('annual', 'connect')).toBe('annual');
  });

  it('unknown interval returns null', () => {
    expect(billing._normaliseBillingInterval('quarterly', 'connect')).toBeNull();
    expect(billing._normaliseBillingInterval('weekly', 'plus')).toBeNull();
  });
});

// ─── getStatus ────────────────────────────────────────────────────────────────

describe('BillingSystem.getStatus', () => {
  let BillingSystem, billing, db;

  beforeEach(() => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
    db = makeDb();
    billing = new BillingSystem(db);
  });

  afterEach(() => { db?.close(); });

  it('returns no_billing when church has no billing record', () => {
    const status = billing.getStatus('nonexistent_church');
    expect(status.status).toBe('no_billing');
    expect(status.tier).toBeNull();
  });

  it('returns correct tier and status from billing_customers', () => {
    seedChurch(db, 'ch1', { tier: 'pro', status: 'active' });
    seedBillingCustomer(db, 'ch1', { tier: 'pro', status: 'active' });
    const status = billing.getStatus('ch1');
    expect(status.tier).toBe('pro');
    expect(status.status).toBe('active');
  });

  it('returns tierName display name', () => {
    seedChurch(db, 'ch2', { tier: 'managed', status: 'active' });
    seedBillingCustomer(db, 'ch2', { tier: 'managed', status: 'active' });
    const status = billing.getStatus('ch2');
    expect(status.tierName).toBe('Enterprise');
  });
});

// ─── Payment failed — grace period ────────────────────────────────────────────

describe('BillingSystem._onPaymentFailed — grace period behavior', () => {
  let BillingSystem, billing, db;

  beforeEach(() => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
    db = makeDb();
    billing = new BillingSystem(db);
  });

  afterEach(() => { db?.close(); });

  it('sets billing_customers.status to past_due', async () => {
    seedChurch(db, 'ch1', { tier: 'pro', status: 'active' });
    seedBillingCustomer(db, 'ch1', { tier: 'pro', status: 'active', subId: 'sub_grace_test' });

    await billing._onPaymentFailed({ subscription: 'sub_grace_test' });

    const record = db.prepare('SELECT * FROM billing_customers WHERE church_id = ?').get('ch1');
    expect(record.status).toBe('past_due');
  });

  it('sets grace_ends_at approximately 7 days in the future', async () => {
    seedChurch(db, 'ch2', { tier: 'pro', status: 'active' });
    seedBillingCustomer(db, 'ch2', { tier: 'pro', status: 'active', subId: 'sub_grace2' });

    const before = Date.now();
    await billing._onPaymentFailed({ subscription: 'sub_grace2' });
    const after = Date.now();

    const record = db.prepare('SELECT * FROM billing_customers WHERE church_id = ?').get('ch2');
    const graceTime = new Date(record.grace_ends_at).getTime();

    // grace_ends_at should be ~7 days in the future
    const expectedMin = before + 6.9 * 24 * 60 * 60 * 1000;
    const expectedMax = after + 7.1 * 24 * 60 * 60 * 1000;
    expect(graceTime).toBeGreaterThanOrEqual(expectedMin);
    expect(graceTime).toBeLessThanOrEqual(expectedMax);
  });

  it('updates churches table to past_due status', async () => {
    seedChurch(db, 'ch3', { tier: 'plus', status: 'active' });
    seedBillingCustomer(db, 'ch3', { tier: 'plus', status: 'active', subId: 'sub_ch3' });

    await billing._onPaymentFailed({ subscription: 'sub_ch3' });

    const church = db.prepare('SELECT billing_status FROM churches WHERE churchId = ?').get('ch3');
    expect(church.billing_status).toBe('past_due');
  });

  it('no-op when subscription ID does not match any billing record', async () => {
    // Should not throw
    await billing._onPaymentFailed({ subscription: 'sub_nonexistent_xyz' });
  });
});

// ─── Payment succeeded — recovery from past_due ────────────────────────────────

describe('BillingSystem._onPaymentSucceeded — recovery', () => {
  let BillingSystem, billing, db;

  beforeEach(() => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
    db = makeDb();
    billing = new BillingSystem(db);
  });

  afterEach(() => { db?.close(); });

  it('restores past_due billing record to active', async () => {
    seedChurch(db, 'ch1', { tier: 'pro', status: 'past_due' });
    seedBillingCustomer(db, 'ch1', { tier: 'pro', status: 'past_due', subId: 'sub_recovery' });

    await billing._onPaymentSucceeded({ subscription: 'sub_recovery' });

    const record = db.prepare('SELECT status FROM billing_customers WHERE church_id = ?').get('ch1');
    expect(record.status).toBe('active');
  });

  it('does not change status when record is already active', async () => {
    seedChurch(db, 'ch2', { tier: 'pro', status: 'active' });
    seedBillingCustomer(db, 'ch2', { tier: 'pro', status: 'active', subId: 'sub_already_active' });

    await billing._onPaymentSucceeded({ subscription: 'sub_already_active' });

    const record = db.prepare('SELECT status FROM billing_customers WHERE church_id = ?').get('ch2');
    // Should stay active
    expect(record.status).toBe('active');
  });

  it('no-op when subscription ID does not match', async () => {
    await billing._onPaymentSucceeded({ subscription: 'sub_unknown_xyz' });
  });
});

// ─── Subscription cancelled ────────────────────────────────────────────────────

describe('BillingSystem._onSubscriptionCancelled', () => {
  let BillingSystem, billing, db;

  beforeEach(() => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
    db = makeDb();
    billing = new BillingSystem(db);
  });

  afterEach(() => { db?.close(); });

  it('sets billing_status to inactive on the church', async () => {
    seedChurch(db, 'ch1', { tier: 'pro', status: 'active' });
    seedBillingCustomer(db, 'ch1', { tier: 'pro', status: 'active', subId: 'sub_cancel_test' });

    await billing._onSubscriptionCancelled({ id: 'sub_cancel_test', metadata: { churchId: 'ch1' } });

    const church = db.prepare('SELECT billing_status FROM churches WHERE churchId = ?').get('ch1');
    expect(church.billing_status).toBe('inactive');
  });

  it('sets billing_customers.status to canceled', async () => {
    seedChurch(db, 'ch2', { tier: 'plus', status: 'active' });
    seedBillingCustomer(db, 'ch2', { tier: 'plus', status: 'active', subId: 'sub_cancel2' });

    await billing._onSubscriptionCancelled({ id: 'sub_cancel2', metadata: { churchId: 'ch2' } });

    const record = db.prepare('SELECT status FROM billing_customers WHERE church_id = ?').get('ch2');
    expect(record.status).toBe('canceled');
  });
});

// ─── _deactivateChurch / _activateChurch helpers ──────────────────────────────

describe('BillingSystem._activateChurch and _deactivateChurch', () => {
  let BillingSystem, billing, db;

  beforeEach(() => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
    db = makeDb();
    billing = new BillingSystem(db);
    seedChurch(db, 'ch1', { tier: 'connect', status: 'inactive' });
  });

  afterEach(() => { db?.close(); });

  it('_activateChurch sets billing_tier and billing_status on church', () => {
    billing._activateChurch('ch1', 'pro', 'active', 'monthly');
    const church = db.prepare('SELECT billing_tier, billing_status FROM churches WHERE churchId = ?').get('ch1');
    expect(church.billing_tier).toBe('pro');
    expect(church.billing_status).toBe('active');
  });

  it('_deactivateChurch sets billing_status to inactive', () => {
    billing._activateChurch('ch1', 'pro', 'active', 'monthly');
    billing._deactivateChurch('ch1', 'test_reason');
    const church = db.prepare('SELECT billing_status FROM churches WHERE churchId = ?').get('ch1');
    expect(church.billing_status).toBe('inactive');
  });

  it('_activateChurch defaults to connect when tier is null', () => {
    billing._activateChurch('ch1', null, 'trialing', 'monthly');
    const church = db.prepare('SELECT billing_tier FROM churches WHERE churchId = ?').get('ch1');
    expect(church.billing_tier).toBe('connect');
  });
});

// ─── _getChurchTier / _getChurchBillingInterval ───────────────────────────────

describe('BillingSystem._getChurchTier', () => {
  let BillingSystem, billing, db;

  beforeEach(() => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
    db = makeDb();
    billing = new BillingSystem(db);
  });

  afterEach(() => { db?.close(); });

  it('returns connect when no billing record exists for church', () => {
    expect(billing._getChurchTier('nonexistent_ch')).toBe('connect');
  });

  it('returns correct tier from billing_customers', () => {
    seedChurch(db, 'ch1', { tier: 'managed', status: 'active' });
    seedBillingCustomer(db, 'ch1', { tier: 'managed', status: 'active' });
    expect(billing._getChurchTier('ch1')).toBe('managed');
  });
});

// ─── reactivate — only for allowed statuses ───────────────────────────────────

describe('BillingSystem.reactivate — status validation', () => {
  let BillingSystem, billing, db;

  beforeEach(() => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
    db = makeDb();
    billing = new BillingSystem(db);
    // Simulate Stripe enabled
    billing.isEnabled = () => true;
  });

  afterEach(() => { db?.close(); });

  it('throws when church is active (not eligible for reactivation)', async () => {
    seedChurch(db, 'ch_active', { tier: 'pro', status: 'active' });
    await expect(billing.reactivate({ churchId: 'ch_active', tier: 'pro', billingInterval: 'monthly' }))
      .rejects.toThrow(/reactivation only available/);
  });

  it('throws when church does not exist', async () => {
    await expect(billing.reactivate({ churchId: 'nonexistent', tier: 'pro', billingInterval: 'monthly' }))
      .rejects.toThrow(/Church not found/);
  });
});

// ─── listAll ──────────────────────────────────────────────────────────────────

describe('BillingSystem.listAll', () => {
  let BillingSystem, billing, db;

  beforeEach(() => {
    clearBillingCache();
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
    db = makeDb();
    billing = new BillingSystem(db);
  });

  afterEach(() => { db?.close(); });

  it('returns empty array when no billing records exist', () => {
    expect(billing.listAll()).toEqual([]);
  });

  it('returns all billing records with church_name joined', () => {
    seedChurch(db, 'ch1', { tier: 'pro', status: 'active' });
    seedBillingCustomer(db, 'ch1', { tier: 'pro', status: 'active' });
    const all = billing.listAll();
    expect(all).toHaveLength(1);
    expect(all[0].church_id).toBe('ch1');
    expect(all[0].church_name).toBe('Church ch1');
  });
});
