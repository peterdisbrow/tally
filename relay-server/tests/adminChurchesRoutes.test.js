/**
 * Tests for src/routes/adminChurches.js — setupAdminChurchRoutes(app, ctx).
 *
 * Routes are captured via a mock app, then handler chains (including
 * middleware) are invoked directly with mock req/res objects. An in-memory
 * SQLite database is used in place of a real one.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const setupAdminChurchRoutes = require('../src/routes/adminChurches.js');

// ─── DB factory ────────────────────────────────────────────────────────────────

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT,
      email TEXT DEFAULT '',
      token TEXT DEFAULT '',
      registeredAt TEXT DEFAULT '',
      billing_tier TEXT DEFAULT 'connect',
      billing_status TEXT DEFAULT 'inactive',
      billing_interval TEXT DEFAULT 'monthly',
      portal_email TEXT,
      registration_code TEXT,
      slack_webhook_url TEXT
    );
    CREATE TABLE billing_customers (
      id TEXT PRIMARY KEY,
      church_id TEXT,
      tier TEXT,
      billing_interval TEXT,
      status TEXT,
      email TEXT DEFAULT '',
      created_at TEXT DEFAULT '',
      updated_at TEXT DEFAULT ''
    );
  `);
  return db;
}

// ─── Context factory ──────────────────────────────────────────────────────────

function makeCtx(db, churchesMap = new Map(), overrides = {}) {
  return {
    db,
    churches: churchesMap,
    requireAdmin: (_req, _res, next) => next(),
    stmtGet: db.prepare('SELECT * FROM churches WHERE churchId = ?'),
    stmtDelete: db.prepare('DELETE FROM churches WHERE churchId = ?'),
    billing: {
      getStatus: () => ({}),
      listAll: () => [],
    },
    normalizeBillingInterval: (interval, tier, def) => {
      if (!interval) return def;
      if (['monthly', 'annual', 'one_time'].includes(interval)) return interval;
      return null;
    },
    messageQueues: new Map(),
    BILLING_TIERS: new Set(['connect', 'plus', 'pro', 'managed', 'event']),
    BILLING_STATUSES: new Set(['active', 'inactive', 'trial', 'canceled', 'past_due']),
    safeErrorMessage: (e) => e.message || 'Unknown error',
    log: () => {},
    logAudit: null,
    ...overrides,
  };
}

// ─── App / route capture ──────────────────────────────────────────────────────

function makeApp() {
  const routes = {};
  const app = {
    get:    (path, ...handlers) => { routes[`GET:${path}`]  = handlers; },
    put:    (path, ...handlers) => { routes[`PUT:${path}`]  = handlers; },
    delete: (path, ...handlers) => { routes[`DEL:${path}`]  = handlers; },
    post:   (path, ...handlers) => { routes[`POST:${path}`] = handlers; },
  };
  return { app, routes };
}

// ─── Route caller ─────────────────────────────────────────────────────────────

async function callRoute(routes, key, { query = {}, body = {}, params = {}, headers = {} } = {}) {
  let sentJson = null;
  let sentStatus = 200;
  const res = {
    json: (data) => { sentJson = data; },
    status: (code) => { sentStatus = code; return { json: (data) => { sentJson = data; } }; },
  };
  const req = { query, body, params, headers };
  const handlers = routes[key];
  for (const handler of handlers) {
    let done = false;
    await new Promise((resolve) => {
      const result = handler(req, res, () => { done = true; resolve(); });
      if (result && typeof result.then === 'function') {
        result.then(() => { if (!done) resolve(); }).catch(resolve);
      } else if (!done && sentJson !== null) {
        resolve();
      }
    });
    if (sentJson !== null) break;
  }
  return { body: sentJson, status: sentStatus };
}

// ─── GET /api/churches ────────────────────────────────────────────────────────

describe('GET /api/churches', () => {
  let db;
  let routes;

  beforeEach(() => {
    db = makeDb();
    const churches = new Map();
    const ctx = makeCtx(db, churches);
    const { app, routes: r } = makeApp();
    setupAdminChurchRoutes(app, ctx);
    routes = r;
  });

  it('returns empty array when churches map is empty', async () => {
    const { body, status } = await callRoute(routes, 'GET:/api/churches');
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('returns church data when one church is in map', async () => {
    db.prepare("INSERT INTO churches (churchId, name) VALUES (?, ?)").run('ch1', 'Test Church');
    const churches = new Map([['ch1', { churchId: 'ch1', name: 'Test Church', status: 'ok', lastSeen: null }]]);
    const ctx = makeCtx(db, churches);
    const { app, routes: r } = makeApp();
    setupAdminChurchRoutes(app, ctx);

    const { body, status } = await callRoute(r, 'GET:/api/churches');
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].churchId).toBe('ch1');
    expect(body[0].name).toBe('Test Church');
  });

  it('church.connected is true when ws.readyState === 1 (WebSocket.OPEN)', async () => {
    db.prepare("INSERT INTO churches (churchId, name) VALUES (?, ?)").run('ch1', 'Connected Church');
    const churches = new Map([
      ['ch1', { churchId: 'ch1', name: 'Connected Church', status: 'ok', lastSeen: null, ws: { readyState: 1 }, sockets: new Map([['_default', { readyState: 1 }]]) }],
    ]);
    const ctx = makeCtx(db, churches);
    const { app, routes: r } = makeApp();
    setupAdminChurchRoutes(app, ctx);

    const { body } = await callRoute(r, 'GET:/api/churches');
    expect(body[0].connected).toBe(true);
  });

  it('church.connected is false when ws is null', async () => {
    db.prepare("INSERT INTO churches (churchId, name) VALUES (?, ?)").run('ch1', 'Disconnected Church');
    const churches = new Map([
      ['ch1', { churchId: 'ch1', name: 'Disconnected Church', status: 'ok', lastSeen: null, ws: null }],
    ]);
    const ctx = makeCtx(db, churches);
    const { app, routes: r } = makeApp();
    setupAdminChurchRoutes(app, ctx);

    const { body } = await callRoute(r, 'GET:/api/churches');
    expect(body[0].connected).toBe(false);
  });

  it('billing_tier from DB row is included in response', async () => {
    db.prepare("INSERT INTO churches (churchId, name, billing_tier) VALUES (?, ?, ?)").run('ch1', 'Plus Church', 'plus');
    const churches = new Map([
      ['ch1', { churchId: 'ch1', name: 'Plus Church', status: 'ok', lastSeen: null }],
    ]);
    const ctx = makeCtx(db, churches);
    const { app, routes: r } = makeApp();
    setupAdminChurchRoutes(app, ctx);

    const { body } = await callRoute(r, 'GET:/api/churches');
    expect(body[0].billing_tier).toBe('plus');
  });
});

// ─── PUT /api/churches/:churchId/billing ─────────────────────────────────────

describe('PUT /api/churches/:churchId/billing', () => {
  let db;
  let churches;
  let routes;

  beforeEach(() => {
    db = makeDb();
    db.prepare("INSERT INTO churches (churchId, name, billing_tier, billing_status, billing_interval) VALUES (?, ?, ?, ?, ?)")
      .run('ch1', 'Test Church', 'connect', 'inactive', 'monthly');
    churches = new Map([['ch1', { churchId: 'ch1', name: 'Test Church' }]]);
    const ctx = makeCtx(db, churches);
    const { app, routes: r } = makeApp();
    setupAdminChurchRoutes(app, ctx);
    routes = r;
  });

  it('returns 404 when church not in map', async () => {
    const { body, status } = await callRoute(routes, 'PUT:/api/churches/:churchId/billing', {
      params: { churchId: 'nonexistent' },
      body: { tier: 'plus' },
    });
    expect(status).toBe(404);
    expect(body.error).toBe('Church not found');
  });

  it('returns 400 when no tier/status/billingInterval provided', async () => {
    const { body, status } = await callRoute(routes, 'PUT:/api/churches/:churchId/billing', {
      params: { churchId: 'ch1' },
      body: {},
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/tier|status|billingInterval/);
  });

  it('updates billing_tier in database', async () => {
    await callRoute(routes, 'PUT:/api/churches/:churchId/billing', {
      params: { churchId: 'ch1' },
      body: { tier: 'plus' },
    });
    const row = db.prepare('SELECT billing_tier FROM churches WHERE churchId = ?').get('ch1');
    expect(row.billing_tier).toBe('plus');
  });

  it('returns { ok: true, churchId, billing: { tier, billingInterval, status } }', async () => {
    const { body, status } = await callRoute(routes, 'PUT:/api/churches/:churchId/billing', {
      params: { churchId: 'ch1' },
      body: { tier: 'pro', status: 'active', billingInterval: 'annual' },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.churchId).toBe('ch1');
    expect(body.billing.tier).toBe('pro');
    expect(body.billing.billingInterval).toBe('annual');
    expect(body.billing.status).toBe('active');
  });

  it('returns 400 for invalid tier', async () => {
    const { body, status } = await callRoute(routes, 'PUT:/api/churches/:churchId/billing', {
      params: { churchId: 'ch1' },
      body: { tier: 'superplan' },
    });
    expect(status).toBe(400);
    expect(body.error).toBe('invalid tier');
  });

  it('returns 400 for invalid status', async () => {
    const { body, status } = await callRoute(routes, 'PUT:/api/churches/:churchId/billing', {
      params: { churchId: 'ch1' },
      body: { status: 'invalid-status' },
    });
    expect(status).toBe(400);
    expect(body.error).toBe('invalid status');
  });

  it('creates billing_customers record when none exists', async () => {
    const before = db.prepare('SELECT * FROM billing_customers WHERE church_id = ?').get('ch1');
    expect(before).toBeUndefined();

    await callRoute(routes, 'PUT:/api/churches/:churchId/billing', {
      params: { churchId: 'ch1' },
      body: { tier: 'plus', status: 'active' },
    });

    const after = db.prepare('SELECT * FROM billing_customers WHERE church_id = ?').get('ch1');
    expect(after).toBeTruthy();
    expect(after.tier).toBe('plus');
    expect(after.status).toBe('active');
  });

  it('updates existing billing_customers record', async () => {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO billing_customers (id, church_id, tier, billing_interval, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run('existing_id', 'ch1', 'connect', 'monthly', 'inactive', now, now);

    await callRoute(routes, 'PUT:/api/churches/:churchId/billing', {
      params: { churchId: 'ch1' },
      body: { tier: 'managed', status: 'active' },
    });

    const row = db.prepare('SELECT * FROM billing_customers WHERE id = ?').get('existing_id');
    expect(row.tier).toBe('managed');
    expect(row.status).toBe('active');
  });
});

// ─── DELETE /api/churches/:churchId ──────────────────────────────────────────

describe('DELETE /api/churches/:churchId', () => {
  let db;
  let churches;
  let routes;

  beforeEach(() => {
    db = makeDb();
    db.prepare("INSERT INTO churches (churchId, name) VALUES (?, ?)").run('ch1', 'Grace Community');
    churches = new Map([['ch1', { churchId: 'ch1', name: 'Grace Community' }]]);
    const ctx = makeCtx(db, churches);
    const { app, routes: r } = makeApp();
    setupAdminChurchRoutes(app, ctx);
    routes = r;
  });

  it('returns 404 when church not in map', async () => {
    const { body, status } = await callRoute(routes, 'DEL:/api/churches/:churchId', {
      params: { churchId: 'nonexistent' },
    });
    expect(status).toBe(404);
    expect(body.error).toBe('Church not found');
  });

  it('returns { deleted: true, name } on success', async () => {
    const { body, status } = await callRoute(routes, 'DEL:/api/churches/:churchId', {
      params: { churchId: 'ch1' },
    });
    expect(status).toBe(200);
    expect(body.deleted).toBe(true);
    expect(body.name).toBe('Grace Community');
  });

  it('removes church from churches map', async () => {
    await callRoute(routes, 'DEL:/api/churches/:churchId', {
      params: { churchId: 'ch1' },
    });
    expect(churches.has('ch1')).toBe(false);
  });

  it('calls stmtDelete to remove church from DB', async () => {
    const before = db.prepare('SELECT * FROM churches WHERE churchId = ?').get('ch1');
    expect(before).toBeTruthy();

    await callRoute(routes, 'DEL:/api/churches/:churchId', {
      params: { churchId: 'ch1' },
    });

    const after = db.prepare('SELECT * FROM churches WHERE churchId = ?').get('ch1');
    expect(after).toBeUndefined();
  });
});
