import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const Stripe = require('stripe');

const billingModule = require('../src/billing');
const {
  BillingSystem,
  _setStripeClientForTests,
  _resetStripeClientForTests,
} = billingModule;

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      token TEXT,
      registeredAt TEXT NOT NULL
    )
  `);
  return db;
}

function makeMockStripeLayer() {
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

/** Insert a church with active billing into the test DB. */
function seedChurch(db, churchId, { tier = 'pro', status = 'active', subId = 'sub_test_1', interval = 'monthly' } = {}) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO churches (churchId, name, email, token, registeredAt, billing_tier, billing_status, billing_interval)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(churchId, `Church ${churchId}`, `${churchId}@test.local`, `token-${churchId}`, now, tier, status, interval);

  db.prepare(`
    INSERT INTO billing_customers
    (id, church_id, stripe_customer_id, stripe_subscription_id, stripe_session_id, tier, billing_interval, status, email, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `billing_${churchId}`, churchId, `cus_${churchId}`, subId, `cs_${churchId}`,
    tier, interval, status, `${churchId}@test.local`, now, now
  );
}

describe('Stripe webhook edge cases', () => {
  let db;
  let billing;
  const webhookSecret = 'whsec_test_edge_cases';

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock_edge_key';
    process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
    db = createDb();
    billing = new BillingSystem(db);
    _setStripeClientForTests(makeMockStripeLayer());
  });

  afterEach(() => {
    _resetStripeClientForTests();
    if (db) db.close();
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  // ── 1. Duplicate webhook delivery (idempotency) ───────────────────────────

  it('handles duplicate checkout.session.completed delivery without corrupting state', async () => {
    const churchId = 'church_dup_1';
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO churches (churchId, name, email, token, registeredAt)
      VALUES (?, ?, ?, ?, ?)
    `).run(churchId, 'Dup Church', 'dup@test.local', 'tok', now);

    db.prepare(`
      INSERT INTO billing_customers
      (id, church_id, stripe_session_id, tier, billing_interval, status, email, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(`billing_${churchId}`, churchId, 'cs_dup_1', 'connect', 'monthly', 'pending', 'dup@test.local', now, now);

    const event = {
      id: 'evt_dup_checkout_1',
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_dup_1',
          object: 'checkout.session',
          customer: 'cus_dup_1',
          subscription: 'sub_dup_1',
          metadata: { churchId, tier: 'plus', billingInterval: 'annual' },
        },
      },
    };

    const { payload, signature } = signEvent(event, webhookSecret);

    // First delivery
    const result1 = await billing.handleWebhook(payload, signature);
    expect(result1).toEqual({ received: true });

    // Second (duplicate) delivery with a fresh signature
    const { payload: p2, signature: s2 } = signEvent(event, webhookSecret);
    const result2 = await billing.handleWebhook(p2, s2);
    expect(result2).toEqual({ received: true });

    // Verify only one billing row exists — no duplicate inserts
    const rows = db.prepare('SELECT * FROM billing_customers WHERE church_id = ?').all(churchId);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('active');
    expect(rows[0].stripe_customer_id).toBe('cus_dup_1');
  });

  // ── 2. Out-of-order events ─────────────────────────────────────────────────

  it('handles invoice.paid arriving before checkout.session.completed gracefully', async () => {
    const churchId = 'church_ooo_1';
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO churches (churchId, name, email, token, registeredAt)
      VALUES (?, ?, ?, ?, ?)
    `).run(churchId, 'OOO Church', 'ooo@test.local', 'tok', now);

    db.prepare(`
      INSERT INTO billing_customers
      (id, church_id, stripe_session_id, stripe_subscription_id, tier, billing_interval, status, email, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(`billing_${churchId}`, churchId, 'cs_ooo_1', 'sub_ooo_1', 'plus', 'monthly', 'pending', 'ooo@test.local', now, now);

    // invoice.payment_succeeded arrives first (before checkout)
    const invoiceEvent = {
      id: 'evt_invoice_ooo_1',
      object: 'event',
      type: 'invoice.payment_succeeded',
      data: {
        object: {
          id: 'in_ooo_1',
          object: 'invoice',
          subscription: 'sub_ooo_1',
        },
      },
    };

    const { payload: p1, signature: s1 } = signEvent(invoiceEvent, webhookSecret);
    const r1 = await billing.handleWebhook(p1, s1);
    expect(r1).toEqual({ received: true });

    // Status should still be pending since payment_succeeded only updates past_due -> active
    const beforeCheckout = db.prepare('SELECT status FROM billing_customers WHERE church_id = ?').get(churchId);
    expect(beforeCheckout.status).toBe('pending');

    // Now checkout.session.completed arrives
    const checkoutEvent = {
      id: 'evt_checkout_ooo_1',
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_ooo_1',
          object: 'checkout.session',
          customer: 'cus_ooo_1',
          subscription: 'sub_ooo_1',
          metadata: { churchId, tier: 'plus', billingInterval: 'monthly' },
        },
      },
    };

    const { payload: p2, signature: s2 } = signEvent(checkoutEvent, webhookSecret);
    const r2 = await billing.handleWebhook(p2, s2);
    expect(r2).toEqual({ received: true });

    const afterCheckout = db.prepare('SELECT status, stripe_customer_id FROM billing_customers WHERE church_id = ?').get(churchId);
    expect(afterCheckout.status).toBe('active');
    expect(afterCheckout.stripe_customer_id).toBe('cus_ooo_1');
  });

  // ── 3. Webhook signature verification failure ──────────────────────────────

  it('rejects a webhook with completely wrong signature', async () => {
    const event = {
      id: 'evt_bad_sig_1',
      object: 'event',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', metadata: {} } },
    };
    const payload = JSON.stringify(event);
    const badSignature = 't=9999999,v1=aaaaaabbbbbbcccccc';

    await expect(billing.handleWebhook(payload, badSignature))
      .rejects
      .toThrow(/Webhook signature verification failed/i);
  });

  it('rejects a webhook signed with the wrong secret', async () => {
    const event = {
      id: 'evt_wrong_secret_1',
      object: 'event',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', metadata: {} } },
    };
    const { payload, signature } = signEvent(event, 'whsec_wrong_secret');

    await expect(billing.handleWebhook(payload, signature))
      .rejects
      .toThrow(/Webhook signature verification failed/i);
  });

  it('rejects a webhook with empty signature header', async () => {
    const event = {
      id: 'evt_empty_sig',
      object: 'event',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', metadata: {} } },
    };
    const payload = JSON.stringify(event);

    await expect(billing.handleWebhook(payload, ''))
      .rejects
      .toThrow(/Webhook signature verification failed/i);
  });

  // ── 4. Malformed event payloads ────────────────────────────────────────────

  it('handles checkout event with missing metadata gracefully', async () => {
    const event = {
      id: 'evt_no_meta_1',
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_no_meta_1',
          object: 'checkout.session',
          customer: 'cus_no_meta',
          subscription: 'sub_no_meta',
          metadata: {},
        },
      },
    };

    const { payload, signature } = signEvent(event, webhookSecret);
    // Should not crash, just process with empty metadata
    const result = await billing.handleWebhook(payload, signature);
    expect(result).toEqual({ received: true });
  });

  it('handles invoice.payment_failed for a subscription not in our DB', async () => {
    const event = {
      id: 'evt_unknown_sub_1',
      object: 'event',
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: 'in_unknown_1',
          object: 'invoice',
          subscription: 'sub_does_not_exist',
        },
      },
    };

    const { payload, signature } = signEvent(event, webhookSecret);
    // Should not throw, just acknowledge
    const result = await billing.handleWebhook(payload, signature);
    expect(result).toEqual({ received: true });
  });

  it('handles an unrecognized event type without error', async () => {
    const event = {
      id: 'evt_unknown_type_1',
      object: 'event',
      type: 'source.chargeable',
      data: { object: { id: 'src_1' } },
    };

    const { payload, signature } = signEvent(event, webhookSecret);
    const result = await billing.handleWebhook(payload, signature);
    expect(result).toEqual({ received: true });
  });

  // ── 5. Subscription upgrade/downgrade mid-cycle ────────────────────────────

  it('processes subscription update from connect to pro (upgrade)', async () => {
    const churchId = 'church_upgrade_1';
    seedChurch(db, churchId, { tier: 'connect', status: 'active', subId: 'sub_upgrade_1' });

    const event = {
      id: 'evt_sub_upgrade_1',
      object: 'event',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_upgrade_1',
          object: 'subscription',
          status: 'active',
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
          cancel_at_period_end: false,
          metadata: { churchId, tier: 'pro', billingInterval: 'monthly' },
        },
      },
    };

    const { payload, signature } = signEvent(event, webhookSecret);
    const result = await billing.handleWebhook(payload, signature);
    expect(result).toEqual({ received: true });

    const church = db.prepare('SELECT billing_tier, billing_status FROM churches WHERE churchId = ?').get(churchId);
    expect(church.billing_tier).toBe('pro');
    expect(church.billing_status).toBe('active');
  });

  it('processes subscription downgrade from pro to connect', async () => {
    const churchId = 'church_downgrade_1';
    seedChurch(db, churchId, { tier: 'pro', status: 'active', subId: 'sub_downgrade_1' });

    const event = {
      id: 'evt_sub_downgrade_1',
      object: 'event',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_downgrade_1',
          object: 'subscription',
          status: 'active',
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
          cancel_at_period_end: false,
          metadata: { churchId, tier: 'connect', billingInterval: 'annual' },
        },
      },
    };

    const { payload, signature } = signEvent(event, webhookSecret);
    const result = await billing.handleWebhook(payload, signature);
    expect(result).toEqual({ received: true });

    const church = db.prepare('SELECT billing_tier, billing_status FROM churches WHERE churchId = ?').get(churchId);
    expect(church.billing_tier).toBe('connect');
    expect(church.billing_status).toBe('active');
  });

  it('processes subscription interval change from monthly to annual', async () => {
    const churchId = 'church_interval_1';
    seedChurch(db, churchId, { tier: 'plus', status: 'active', subId: 'sub_interval_1', interval: 'monthly' });

    const event = {
      id: 'evt_sub_interval_1',
      object: 'event',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_interval_1',
          object: 'subscription',
          status: 'active',
          current_period_end: Math.floor(Date.now() / 1000) + 365 * 86400,
          cancel_at_period_end: false,
          metadata: { churchId, tier: 'plus', billingInterval: 'annual' },
        },
      },
    };

    const { payload, signature } = signEvent(event, webhookSecret);
    await billing.handleWebhook(payload, signature);

    const billingRow = db.prepare('SELECT billing_interval FROM billing_customers WHERE church_id = ?').get(churchId);
    expect(billingRow.billing_interval).toBe('annual');
  });

  // ── 6. Failed payment retry handling ───────────────────────────────────────

  it('recovers from past_due when retry payment succeeds', async () => {
    const churchId = 'church_retry_1';
    seedChurch(db, churchId, { tier: 'pro', status: 'active', subId: 'sub_retry_1' });

    // First: payment fails
    const failEvent = {
      id: 'evt_fail_retry_1',
      object: 'event',
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: 'in_retry_fail_1',
          object: 'invoice',
          subscription: 'sub_retry_1',
        },
      },
    };

    const { payload: p1, signature: s1 } = signEvent(failEvent, webhookSecret);
    await billing.handleWebhook(p1, s1);

    let billingRow = db.prepare('SELECT status, grace_ends_at FROM billing_customers WHERE church_id = ?').get(churchId);
    expect(billingRow.status).toBe('past_due');
    expect(billingRow.grace_ends_at).toBeTruthy();

    // Then: retry succeeds
    const succeedEvent = {
      id: 'evt_succeed_retry_1',
      object: 'event',
      type: 'invoice.payment_succeeded',
      data: {
        object: {
          id: 'in_retry_succeed_1',
          object: 'invoice',
          subscription: 'sub_retry_1',
        },
      },
    };

    const { payload: p2, signature: s2 } = signEvent(succeedEvent, webhookSecret);
    await billing.handleWebhook(p2, s2);

    billingRow = db.prepare('SELECT status FROM billing_customers WHERE church_id = ?').get(churchId);
    expect(billingRow.status).toBe('active');
  });

  it('sets a grace period on payment failure with correct future date', async () => {
    const churchId = 'church_grace_1';
    seedChurch(db, churchId, { tier: 'plus', status: 'active', subId: 'sub_grace_1' });

    const event = {
      id: 'evt_grace_1',
      object: 'event',
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: 'in_grace_1',
          object: 'invoice',
          subscription: 'sub_grace_1',
        },
      },
    };

    const beforeTime = Date.now();
    const { payload, signature } = signEvent(event, webhookSecret);
    await billing.handleWebhook(payload, signature);

    const billingRow = db.prepare('SELECT grace_ends_at FROM billing_customers WHERE church_id = ?').get(churchId);
    const graceEnd = new Date(billingRow.grace_ends_at).getTime();

    // Grace period should be ~7 days in the future (within a 10-second tolerance)
    const expectedMin = beforeTime + (7 * 24 * 60 * 60 * 1000) - 10000;
    const expectedMax = Date.now() + (7 * 24 * 60 * 60 * 1000) + 10000;
    expect(graceEnd).toBeGreaterThan(expectedMin);
    expect(graceEnd).toBeLessThan(expectedMax);
  });

  // ── 7. Webhook timeout behavior (Stripe not configured) ────────────────────

  it('throws when Stripe is not configured', async () => {
    _resetStripeClientForTests();
    delete process.env.STRIPE_SECRET_KEY;

    const billing2 = new BillingSystem(db);

    await expect(billing2.handleWebhook('{}', 'sig'))
      .rejects
      .toThrow(/Stripe not configured/i);
  });

  it('handles customer.subscription.deleted and deactivates church', async () => {
    const churchId = 'church_cancel_1';
    seedChurch(db, churchId, { tier: 'pro', status: 'active', subId: 'sub_cancel_1' });

    const event = {
      id: 'evt_cancel_1',
      object: 'event',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          id: 'sub_cancel_1',
          object: 'subscription',
          status: 'canceled',
          metadata: { churchId },
        },
      },
    };

    const { payload, signature } = signEvent(event, webhookSecret);
    const result = await billing.handleWebhook(payload, signature);
    expect(result).toEqual({ received: true });

    const billingRow = db.prepare('SELECT status FROM billing_customers WHERE church_id = ?').get(churchId);
    expect(billingRow.status).toBe('canceled');
  });
});
