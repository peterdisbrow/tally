/**
 * Tests for src/routes/billing.js — setupBillingRoutes(app, ctx).
 *
 * Routes are captured via a mock app, then handler chains (including
 * middleware) are invoked directly with mock req/res objects. No HTTP
 * server or Stripe SDK is used.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const setupBillingRoutes = require('../src/routes/billing.js');

// ─── Test helpers ──────────────────────────────────────────────────────────────

function makeBilling(overrides = {}) {
  return {
    createCheckout: async (opts) => ({ url: 'https://checkout.stripe.com/test', opts }),
    createPortalSession: async (opts) => ({ url: 'https://billing.stripe.com/test' }),
    handleWebhook: async (body, sig) => ({ received: true }),
    getStatus: (churchId) => ({ churchId, tier: 'plus', active: true }),
    listAll: () => [],
    ...overrides,
  };
}

function makeCtx(overrides = {}) {
  return {
    db: null,
    requireAdmin: (_req, _res, next) => next(),
    rateLimit: () => (_req, _res, next) => next(),
    billing: makeBilling(),
    normalizeBillingInterval: (interval, tier, defaultInterval) => interval || defaultInterval,
    safeErrorMessage: (e) => e.message,
    log: () => {},
    ...overrides,
  };
}

function makeApp() {
  const routes = {};
  const app = {
    get: (path, ...handlers) => { routes[path] = handlers; },
    post: (path, ...handlers) => { routes[path] = handlers; },
  };
  return { app, routes };
}

async function callRoute(routes, path, { query = {}, body = {}, headers = {}, params = {} } = {}) {
  let sentJson = null;
  let sentStatus = 200;
  const res = {
    json: (data) => { sentJson = data; },
    status: (code) => { sentStatus = code; return { json: (data) => { sentJson = data; } }; },
  };
  const req = { query, body, headers, params };
  const handlers = routes[path];
  for (const handler of handlers) {
    let nextCalled = false;
    await new Promise((resolve) => {
      const next = () => { nextCalled = true; resolve(); };
      const result = handler(req, res, next);
      if (result && typeof result.then === 'function') {
        result.then(resolve).catch(resolve);
      } else if (!nextCalled && sentJson !== null) {
        // Synchronous handler responded without calling next — resolve immediately
        resolve();
      }
    });
    if (sentJson !== null) break;
  }
  return { body: sentJson, status: sentStatus };
}

// ─── POST /api/billing/checkout ───────────────────────────────────────────────

describe('POST /api/billing/checkout', () => {
  let routes;

  beforeEach(() => {
    const ctx = makeCtx();
    const { app, routes: r } = makeApp();
    setupBillingRoutes(app, ctx);
    routes = r;
  });

  it('returns 400 for missing tier', async () => {
    const { body, status } = await callRoute(routes, '/api/billing/checkout', {
      body: { churchId: 'ch1', email: 'test@example.com' },
    });
    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it('returns 400 for invalid tier', async () => {
    const { body, status } = await callRoute(routes, '/api/billing/checkout', {
      body: { tier: 'invalid-tier', churchId: 'ch1' },
    });
    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it('returns 400 when normalizeBillingInterval returns null', async () => {
    const ctx = makeCtx({ normalizeBillingInterval: () => null });
    const { app, routes: r } = makeApp();
    setupBillingRoutes(app, ctx);

    const { body, status } = await callRoute(r, '/api/billing/checkout', {
      body: { tier: 'plus', churchId: 'ch1', billingInterval: 'monthly' },
    });
    expect(status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it('calls billing.createCheckout with correct params for tier=plus + billingInterval=monthly', async () => {
    let capturedOpts = null;
    const ctx = makeCtx({
      billing: makeBilling({
        createCheckout: async (opts) => { capturedOpts = opts; return { url: 'https://checkout.stripe.com/test' }; },
      }),
    });
    const { app, routes: r } = makeApp();
    setupBillingRoutes(app, ctx);

    const { status } = await callRoute(r, '/api/billing/checkout', {
      body: {
        tier: 'plus',
        churchId: 'ch1',
        email: 'pastor@church.org',
        successUrl: 'https://church.org/success',
        cancelUrl: 'https://church.org/cancel',
        billingInterval: 'monthly',
      },
    });
    expect(status).toBe(200);
    expect(capturedOpts.tier).toBe('plus');
    expect(capturedOpts.churchId).toBe('ch1');
    expect(capturedOpts.email).toBe('pastor@church.org');
    expect(capturedOpts.successUrl).toBe('https://church.org/success');
    expect(capturedOpts.cancelUrl).toBe('https://church.org/cancel');
    expect(capturedOpts.billingInterval).toBe('monthly');
    expect(capturedOpts.isEvent).toBe(false);
  });

  it('sets isEvent=true when tier=event', async () => {
    let capturedOpts = null;
    const ctx = makeCtx({
      billing: makeBilling({
        createCheckout: async (opts) => { capturedOpts = opts; return { url: 'https://checkout.stripe.com/test' }; },
      }),
    });
    const { app, routes: r } = makeApp();
    setupBillingRoutes(app, ctx);

    await callRoute(r, '/api/billing/checkout', {
      body: { tier: 'event', churchId: 'ch1', billingInterval: 'one_time' },
    });
    expect(capturedOpts.isEvent).toBe(true);
  });

  it('uses one_time as default billingInterval for event tier', async () => {
    let capturedOpts = null;
    const ctx = makeCtx({
      billing: makeBilling({
        createCheckout: async (opts) => { capturedOpts = opts; return { url: 'https://checkout.stripe.com/test' }; },
      }),
      // pass through the default — no billingInterval supplied in body
      normalizeBillingInterval: (interval, tier, defaultInterval) => interval || defaultInterval,
    });
    const { app, routes: r } = makeApp();
    setupBillingRoutes(app, ctx);

    await callRoute(r, '/api/billing/checkout', {
      body: { tier: 'event', churchId: 'ch1' },
    });
    expect(capturedOpts.billingInterval).toBe('one_time');
  });

  it('uses monthly as default billingInterval for non-event tier', async () => {
    let capturedOpts = null;
    const ctx = makeCtx({
      billing: makeBilling({
        createCheckout: async (opts) => { capturedOpts = opts; return { url: 'https://checkout.stripe.com/test' }; },
      }),
      normalizeBillingInterval: (interval, tier, defaultInterval) => interval || defaultInterval,
    });
    const { app, routes: r } = makeApp();
    setupBillingRoutes(app, ctx);

    await callRoute(r, '/api/billing/checkout', {
      body: { tier: 'plus', churchId: 'ch1' },
    });
    expect(capturedOpts.billingInterval).toBe('monthly');
  });

  it('returns 500 on billing.createCheckout error', async () => {
    const ctx = makeCtx({
      billing: makeBilling({
        createCheckout: async () => { throw new Error('Stripe unavailable'); },
      }),
    });
    const { app, routes: r } = makeApp();
    setupBillingRoutes(app, ctx);

    const { body, status } = await callRoute(r, '/api/billing/checkout', {
      body: { tier: 'plus', churchId: 'ch1', billingInterval: 'monthly' },
    });
    expect(status).toBe(500);
    expect(body.error).toBe('Stripe unavailable');
  });
});

// ─── POST /api/billing/portal ─────────────────────────────────────────────────

describe('POST /api/billing/portal', () => {
  let routes;

  beforeEach(() => {
    const ctx = makeCtx();
    const { app, routes: r } = makeApp();
    setupBillingRoutes(app, ctx);
    routes = r;
  });

  it('returns 400 when churchId is missing', async () => {
    const { body, status } = await callRoute(routes, '/api/billing/portal', {
      body: { returnUrl: 'https://church.org/billing' },
    });
    expect(status).toBe(400);
    expect(body.error).toBe('churchId required');
  });

  it('returns portal URL on success', async () => {
    const { body, status } = await callRoute(routes, '/api/billing/portal', {
      body: { churchId: 'ch1', returnUrl: 'https://church.org/billing' },
    });
    expect(status).toBe(200);
    expect(body.url).toBe('https://billing.stripe.com/test');
  });

  it('returns 500 on error', async () => {
    const ctx = makeCtx({
      billing: makeBilling({
        createPortalSession: async () => { throw new Error('Portal session failed'); },
      }),
    });
    const { app, routes: r } = makeApp();
    setupBillingRoutes(app, ctx);

    const { body, status } = await callRoute(r, '/api/billing/portal', {
      body: { churchId: 'ch1' },
    });
    expect(status).toBe(500);
    expect(body.error).toBe('Portal session failed');
  });
});

// ─── POST /api/billing/webhook ────────────────────────────────────────────────

describe('POST /api/billing/webhook', () => {
  let routes;
  let savedSecret;

  beforeEach(() => {
    savedSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const ctx = makeCtx();
    const { app, routes: r } = makeApp();
    setupBillingRoutes(app, ctx);
    routes = r;
  });

  afterEach(() => {
    if (savedSecret === undefined) {
      delete process.env.STRIPE_WEBHOOK_SECRET;
    } else {
      process.env.STRIPE_WEBHOOK_SECRET = savedSecret;
    }
  });

  it('returns 503 when STRIPE_WEBHOOK_SECRET is not set', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const { body, status } = await callRoute(routes, '/api/billing/webhook', {
      headers: { 'stripe-signature': 'sig_test' },
      body: '{}',
    });
    expect(status).toBe(503);
    expect(body.error).toBe('Webhook endpoint not configured');
  });

  it('returns 400 when stripe-signature header is missing', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    const { body, status } = await callRoute(routes, '/api/billing/webhook', {
      headers: {},
      body: '{}',
    });
    expect(status).toBe(400);
    expect(body.error).toBe('Missing stripe-signature header');
  });

  it('returns result on success with valid stripe-signature header', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    const { body, status } = await callRoute(routes, '/api/billing/webhook', {
      headers: { 'stripe-signature': 'sig_valid' },
      body: '{"type":"checkout.session.completed"}',
    });
    expect(status).toBe(200);
    expect(body.received).toBe(true);
  });

  it('returns 400 on billing.handleWebhook error', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    const ctx = makeCtx({
      billing: makeBilling({
        handleWebhook: async () => { throw new Error('Invalid signature'); },
      }),
    });
    const { app, routes: r } = makeApp();
    setupBillingRoutes(app, ctx);

    const { body, status } = await callRoute(r, '/api/billing/webhook', {
      headers: { 'stripe-signature': 'sig_bad' },
      body: '{}',
    });
    expect(status).toBe(400);
    expect(body.error).toBe('Invalid signature');
  });
});

// ─── GET /api/billing/status/:churchId ────────────────────────────────────────

describe('GET /api/billing/status/:churchId', () => {
  it('returns billing status for the given churchId', async () => {
    const ctx = makeCtx();
    const { app, routes } = makeApp();
    setupBillingRoutes(app, ctx);

    const { body, status } = await callRoute(routes, '/api/billing/status/:churchId', {
      params: { churchId: 'ch-abc' },
    });

    expect(status).toBe(200);
    expect(body.churchId).toBe('ch-abc');
    expect(body.tier).toBe('plus');
    expect(body.active).toBe(true);
  });

  it('uses req.params.churchId to look up billing status', async () => {
    let capturedId = null;
    const ctx = makeCtx({
      billing: makeBilling({
        getStatus: (churchId) => { capturedId = churchId; return { churchId, tier: 'pro', active: false }; },
      }),
    });
    const { app, routes } = makeApp();
    setupBillingRoutes(app, ctx);

    const { body } = await callRoute(routes, '/api/billing/status/:churchId', {
      params: { churchId: 'specific-church' },
    });

    expect(capturedId).toBe('specific-church');
    expect(body.tier).toBe('pro');
  });
});

// ─── GET /api/billing ─────────────────────────────────────────────────────────

describe('GET /api/billing', () => {
  it('returns empty list when billing.listAll() returns []', async () => {
    const ctx = makeCtx();
    const { app, routes } = makeApp();
    setupBillingRoutes(app, ctx);

    const { body, status } = await callRoute(routes, '/api/billing');
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('returns list from billing.listAll()', async () => {
    const billingRecords = [
      { churchId: 'ch1', tier: 'plus', active: true },
      { churchId: 'ch2', tier: 'pro', active: false },
    ];
    const ctx = makeCtx({ billing: makeBilling({ listAll: () => billingRecords }) });
    const { app, routes } = makeApp();
    setupBillingRoutes(app, ctx);

    const { body } = await callRoute(routes, '/api/billing');
    expect(body).toEqual(billingRecords);
    expect(body.length).toBe(2);
  });
});
