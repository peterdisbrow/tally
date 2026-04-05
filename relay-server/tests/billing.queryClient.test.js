import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import Stripe from 'stripe';
import { createQueryClient } from '../src/db/queryClient.js';

const require = createRequire(import.meta.url);

function clearBillingCache() {
  const billingPath = require.resolve('../src/billing');
  delete require.cache[billingPath];
}

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      portal_email TEXT,
      token TEXT,
      registeredAt TEXT NOT NULL
    )
  `);
  db.prepare(`
    INSERT INTO churches (churchId, name, email, portal_email, token, registeredAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('church-1', 'Grace Church', 'grace@test.local', 'grace@test.local', 'tok-1', new Date().toISOString());
  return db;
}

function makeMockStripe(secret) {
  return {
    checkout: {
      sessions: {
        create: async () => ({ id: 'cs_query_1', url: 'https://checkout.stripe.test/session' }),
      },
    },
    billingPortal: {
      sessions: {
        create: async () => ({ url: 'https://billing.stripe.test/session' }),
      },
    },
    webhooks: {
      constructEvent: (rawBody, signature, webhookSecret) =>
        Stripe.webhooks.constructEvent(rawBody, signature, webhookSecret),
    },
    customers: {
      createBalanceTransaction: async () => ({ id: 'cbtxn_mock' }),
    },
    __secret: secret,
  };
}

function signEvent(event, secret) {
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  return { payload, signature };
}

describe('BillingSystem query client mode', () => {
  let BillingSystem;
  let _setStripeClientForTests;
  let _resetStripeClientForTests;
  let db;
  let queryClient;
  let billing;
  const webhookSecret = 'whsec_query_client_billing';

  beforeEach(async () => {
    clearBillingCache();
    process.env.NODE_ENV = 'test';
    process.env.STRIPE_SECRET_KEY = 'sk_test_query_client';
    process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
    process.env.STRIPE_PRICE_CONNECT = 'price_connect_test';
    process.env.STRIPE_PRICE_CONNECT_ANNUAL = 'price_connect_annual_test';
    process.env.STRIPE_PRICE_PLUS = 'price_plus_test';
    process.env.STRIPE_PRICE_PLUS_ANNUAL = 'price_plus_annual_test';
    process.env.STRIPE_PRICE_PRO = 'price_pro_test';
    process.env.STRIPE_PRICE_PRO_ANNUAL = 'price_pro_annual_test';
    process.env.STRIPE_PRICE_MANAGED = 'price_managed_test';
    process.env.STRIPE_PRICE_MANAGED_ANNUAL = 'price_managed_annual_test';
    process.env.STRIPE_PRICE_EVENT = 'price_event_test';
    process.env.APP_URL = 'https://tallyconnect.app';

    ({ BillingSystem, _setStripeClientForTests, _resetStripeClientForTests } = require('../src/billing'));
    db = createDb();
    queryClient = createQueryClient({
      config: { driver: 'sqlite', isSqlite: true, isPostgres: false, databaseUrl: '' },
      sqliteDb: db,
    });
    billing = new BillingSystem(queryClient);
    _setStripeClientForTests(makeMockStripe(webhookSecret));
    await billing.ready;
  });

  afterEach(async () => {
    _resetStripeClientForTests?.();
    await queryClient?.close();
    db?.close();
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_PRICE_CONNECT;
    delete process.env.STRIPE_PRICE_CONNECT_ANNUAL;
    delete process.env.STRIPE_PRICE_PLUS;
    delete process.env.STRIPE_PRICE_PLUS_ANNUAL;
    delete process.env.STRIPE_PRICE_PRO;
    delete process.env.STRIPE_PRICE_PRO_ANNUAL;
    delete process.env.STRIPE_PRICE_MANAGED;
    delete process.env.STRIPE_PRICE_MANAGED_ANNUAL;
    delete process.env.STRIPE_PRICE_EVENT;
    delete process.env.APP_URL;
  });

  it('creates checkout sessions and exposes status/list output through the shared query client', async () => {
    const result = await billing.createCheckout({
      tier: 'connect',
      churchId: 'church-1',
      email: 'grace@test.local',
      billingInterval: 'monthly',
    });

    const status = await billing.getStatus('church-1');
    const rows = await billing.listAll();
    const stored = db.prepare(`
      SELECT stripe_session_id, tier, billing_interval, status
      FROM billing_customers
      WHERE church_id = ?
    `).get('church-1');

    expect(result.url).toBe('https://checkout.stripe.test/session');
    expect(stored).toMatchObject({
      stripe_session_id: 'cs_query_1',
      tier: 'connect',
      billing_interval: 'monthly',
      status: 'pending',
    });
    expect(status).toMatchObject({
      tier: 'connect',
      billingInterval: 'monthly',
      status: 'pending',
      configured: true,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].church_name).toBe('Grace Church');
  });

  it('processes checkout webhook events through the shared query client', async () => {
    await billing.createCheckout({
      tier: 'plus',
      churchId: 'church-1',
      email: 'grace@test.local',
      billingInterval: 'annual',
    });

    const event = {
      id: 'evt_query_checkout_1',
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_query_1',
          object: 'checkout.session',
          customer: 'cus_query_1',
          subscription: 'sub_query_1',
          metadata: {
            churchId: 'church-1',
            tier: 'plus',
            billingInterval: 'annual',
          },
        },
      },
    };

    const { payload, signature } = signEvent(event, webhookSecret);
    const result = await billing.handleWebhook(payload, signature);
    const status = await billing.getStatus('church-1');
    const church = db.prepare(`
      SELECT billing_tier, billing_status, billing_interval
      FROM churches
      WHERE churchId = ?
    `).get('church-1');

    expect(result).toEqual({ received: true });
    expect(status).toMatchObject({
      tier: 'plus',
      billingInterval: 'annual',
      status: 'active',
    });
    expect(church).toMatchObject({
      billing_tier: 'plus',
      billing_status: 'active',
      billing_interval: 'annual',
    });
  });
});
