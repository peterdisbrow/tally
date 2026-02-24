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

describe('Billing webhook contracts (signed fixtures)', () => {
  let db;
  let billing;
  const webhookSecret = 'whsec_test_billing_webhook';

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock_billing_key';
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

  it('processes checkout.session.completed and activates church billing state', async () => {
    const churchId = 'church_webhook_1';
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO churches (churchId, name, email, token, registeredAt)
      VALUES (?, ?, ?, ?, ?)
    `).run(churchId, 'Webhook Church', 'billing@test.local', 'token-1', now);

    db.prepare(`
      INSERT INTO billing_customers
      (id, church_id, stripe_session_id, tier, billing_interval, status, email, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(`billing_${churchId}`, churchId, 'cs_test_checkout_1', 'connect', 'monthly', 'pending', 'billing@test.local', now, now);

    const event = {
      id: 'evt_checkout_completed_1',
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_test_checkout_1',
          object: 'checkout.session',
          customer: 'cus_test_1',
          subscription: 'sub_test_1',
          metadata: {
            churchId,
            tier: 'plus',
            billingInterval: 'annual',
          },
        },
      },
    };

    const { payload, signature } = signEvent(event, webhookSecret);
    const result = await billing.handleWebhook(payload, signature);
    expect(result).toEqual({ received: true });

    const billingRow = db.prepare(`
      SELECT stripe_customer_id, stripe_subscription_id, tier, billing_interval, status
      FROM billing_customers
      WHERE church_id = ?
    `).get(churchId);
    expect(billingRow.stripe_customer_id).toBe('cus_test_1');
    expect(billingRow.stripe_subscription_id).toBe('sub_test_1');
    expect(billingRow.status).toBe('active');
    expect(billingRow.billing_interval).toBe('annual');

    const churchRow = db.prepare(`
      SELECT billing_tier, billing_status, billing_interval
      FROM churches
      WHERE churchId = ?
    `).get(churchId);
    expect(churchRow.billing_tier).toBe('plus');
    expect(churchRow.billing_status).toBe('active');
    expect(churchRow.billing_interval).toBe('annual');
  });

  it('processes invoice.payment_failed and marks church as past_due', async () => {
    const churchId = 'church_webhook_2';
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO churches (churchId, name, email, token, registeredAt, billing_tier, billing_status)
      VALUES (?, ?, ?, ?, ?, 'pro', 'active')
    `).run(churchId, 'Past Due Church', 'pastdue@test.local', 'token-2', now);

    db.prepare(`
      INSERT INTO billing_customers
      (id, church_id, stripe_subscription_id, tier, billing_interval, status, email, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(`billing_${churchId}`, churchId, 'sub_payment_failed_1', 'pro', 'monthly', 'active', 'pastdue@test.local', now, now);

    const event = {
      id: 'evt_invoice_failed_1',
      object: 'event',
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: 'in_test_failed_1',
          object: 'invoice',
          subscription: 'sub_payment_failed_1',
        },
      },
    };

    const { payload, signature } = signEvent(event, webhookSecret);
    const result = await billing.handleWebhook(payload, signature);
    expect(result).toEqual({ received: true });

    const billingRow = db.prepare(`
      SELECT status, grace_ends_at
      FROM billing_customers
      WHERE church_id = ?
    `).get(churchId);
    expect(billingRow.status).toBe('past_due');
    expect(typeof billingRow.grace_ends_at).toBe('string');
    expect(billingRow.grace_ends_at.length).toBeGreaterThan(0);

    const churchRow = db.prepare('SELECT billing_status FROM churches WHERE churchId = ?').get(churchId);
    expect(churchRow.billing_status).toBe('past_due');
  });

  it('rejects invalid webhook signature', async () => {
    const event = {
      id: 'evt_invalid_signature_1',
      object: 'event',
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_1', subscription: 'sub_missing' } },
    };
    const payload = JSON.stringify(event);
    const invalidSignature = 't=12345,v1=not-a-real-signature';

    await expect(billing.handleWebhook(payload, invalidSignature))
      .rejects
      .toThrow(/Webhook signature verification failed/i);
  });
});
