/**
 * Tests for src/routes/statusComponents.js — setupStatusComponentRoutes(app, ctx).
 *
 * Routes are captured via a mock app, then handlers are invoked directly
 * with mock req/res objects. An in-memory SQLite database is used for
 * realistic query execution without a running server.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const setupStatusComponentRoutes = require('../src/routes/statusComponents.js');

// ─── Test helpers ──────────────────────────────────────────────────────────────

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE status_components (
      component_id TEXT, name TEXT, state TEXT, latency_ms INTEGER,
      detail TEXT, last_checked_at TEXT, last_changed_at TEXT
    );
    CREATE TABLE status_incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      component_id TEXT, previous_state TEXT, new_state TEXT,
      message TEXT, started_at TEXT, resolved_at TEXT
    );
  `);
  return db;
}

function makeCtx(db, overrides = {}) {
  return {
    db,
    requireAdmin: (_req, _res, next) => next(),
    runStatusChecks: async () => {},
    lastStatusCheckAt: () => new Date().toISOString(),
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

// ─── GET /api/status/components ───────────────────────────────────────────────

describe('GET /api/status/components', () => {
  let db;
  let routes;

  beforeEach(() => {
    db = makeDb();
    const ctx = makeCtx(db);
    const { app, routes: r } = makeApp();
    setupStatusComponentRoutes(app, ctx);
    routes = r;
  });

  it('returns empty components array when no rows', async () => {
    const { body, status } = await callRoute(routes, '/api/status/components');
    expect(status).toBe(200);
    expect(body.components).toEqual([]);
  });

  it('returns updatedAt field as ISO string from lastStatusCheckAt', async () => {
    const fixedTime = '2026-03-22T10:00:00.000Z';
    const ctx = makeCtx(db, { lastStatusCheckAt: () => fixedTime });
    const { app, routes: r } = makeApp();
    setupStatusComponentRoutes(app, ctx);
    const { body } = await callRoute(r, '/api/status/components');
    expect(body.updatedAt).toBe(fixedTime);
  });

  it('returns components sorted by name ASC', async () => {
    db.prepare(`
      INSERT INTO status_components (component_id, name, state, latency_ms, detail, last_checked_at, last_changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('c3', 'Zebra', 'operational', 10, null, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    db.prepare(`
      INSERT INTO status_components (component_id, name, state, latency_ms, detail, last_checked_at, last_changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('c1', 'Alpha', 'operational', 5, null, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    db.prepare(`
      INSERT INTO status_components (component_id, name, state, latency_ms, detail, last_checked_at, last_changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('c2', 'Mango', 'degraded', 20, null, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

    const { body } = await callRoute(routes, '/api/status/components');
    expect(body.components.map((c) => c.name)).toEqual(['Alpha', 'Mango', 'Zebra']);
  });

  it('returns all component fields', async () => {
    db.prepare(`
      INSERT INTO status_components (component_id, name, state, latency_ms, detail, last_checked_at, last_changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('comp-1', 'StreamEncoder', 'operational', 42, 'All good', '2026-03-01T08:00:00Z', '2026-02-01T08:00:00Z');

    const { body } = await callRoute(routes, '/api/status/components');
    const comp = body.components[0];
    expect(comp.component_id).toBe('comp-1');
    expect(comp.name).toBe('StreamEncoder');
    expect(comp.state).toBe('operational');
    expect(comp.latency_ms).toBe(42);
    expect(comp.detail).toBe('All good');
    expect(comp.last_checked_at).toBe('2026-03-01T08:00:00Z');
    expect(comp.last_changed_at).toBe('2026-02-01T08:00:00Z');
  });

  it('returns multiple components sorted correctly', async () => {
    const insert = db.prepare(`
      INSERT INTO status_components (component_id, name, state, latency_ms, detail, last_checked_at, last_changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run('id-c', 'Camera', 'operational', 1, null, null, null);
    insert.run('id-a', 'Audio', 'degraded', 2, null, null, null);
    insert.run('id-b', 'Broadcast', 'operational', 3, null, null, null);

    const { body } = await callRoute(routes, '/api/status/components');
    expect(body.components.length).toBe(3);
    expect(body.components[0].name).toBe('Audio');
    expect(body.components[1].name).toBe('Broadcast');
    expect(body.components[2].name).toBe('Camera');
  });
});

// ─── GET /api/status/incidents ────────────────────────────────────────────────

describe('GET /api/status/incidents', () => {
  let db;
  let routes;

  beforeEach(() => {
    db = makeDb();
    const ctx = makeCtx(db);
    const { app, routes: r } = makeApp();
    setupStatusComponentRoutes(app, ctx);
    routes = r;
  });

  it('returns empty array when no incidents', async () => {
    const { body, status } = await callRoute(routes, '/api/status/incidents');
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('returns incidents in reverse id order', async () => {
    const insert = db.prepare(`
      INSERT INTO status_incidents (component_id, previous_state, new_state, message, started_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insert.run('c1', 'operational', 'degraded', 'First incident', '2026-01-01T00:00:00Z', null);
    insert.run('c1', 'degraded', 'operational', 'Second incident', '2026-01-02T00:00:00Z', '2026-01-02T01:00:00Z');

    const { body } = await callRoute(routes, '/api/status/incidents');
    expect(body[0].message).toBe('Second incident');
    expect(body[1].message).toBe('First incident');
  });

  it('default limit is 50 — inserts 60 rows, returns only 50', async () => {
    const insert = db.prepare(`
      INSERT INTO status_incidents (component_id, previous_state, new_state, message, started_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (let i = 1; i <= 60; i++) {
      insert.run('c1', 'operational', 'degraded', `Incident ${i}`, '2026-01-01T00:00:00Z', null);
    }

    const { body } = await callRoute(routes, '/api/status/incidents');
    expect(body.length).toBe(50);
  });

  it('respects custom limit via query.limit parameter', async () => {
    const insert = db.prepare(`
      INSERT INTO status_incidents (component_id, previous_state, new_state, message, started_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (let i = 1; i <= 20; i++) {
      insert.run('c1', 'operational', 'degraded', `Incident ${i}`, '2026-01-01T00:00:00Z', null);
    }

    const { body } = await callRoute(routes, '/api/status/incidents', { query: { limit: '5' } });
    expect(body.length).toBe(5);
  });

  it('clamps limit to 200 max', async () => {
    const insert = db.prepare(`
      INSERT INTO status_incidents (component_id, previous_state, new_state, message, started_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (let i = 1; i <= 250; i++) {
      insert.run('c1', 'operational', 'degraded', `Incident ${i}`, '2026-01-01T00:00:00Z', null);
    }

    const { body } = await callRoute(routes, '/api/status/incidents', { query: { limit: '999' } });
    expect(body.length).toBe(200);
  });

  it('clamps limit to minimum 1 when limit=0', async () => {
    const insert = db.prepare(`
      INSERT INTO status_incidents (component_id, previous_state, new_state, message, started_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insert.run('c1', 'operational', 'degraded', 'Only incident', '2026-01-01T00:00:00Z', null);
    insert.run('c1', 'degraded', 'operational', 'Second incident', '2026-01-02T00:00:00Z', null);

    const { body } = await callRoute(routes, '/api/status/incidents', { query: { limit: '0' } });
    expect(body.length).toBe(1);
  });

  it('returns all incident fields', async () => {
    db.prepare(`
      INSERT INTO status_incidents (component_id, previous_state, new_state, message, started_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('comp-1', 'operational', 'major_outage', 'Total failure', '2026-03-01T08:00:00Z', '2026-03-01T09:00:00Z');

    const { body } = await callRoute(routes, '/api/status/incidents');
    const incident = body[0];
    expect(typeof incident.id).toBe('number');
    expect(incident.component_id).toBe('comp-1');
    expect(incident.previous_state).toBe('operational');
    expect(incident.new_state).toBe('major_outage');
    expect(incident.message).toBe('Total failure');
    expect(incident.started_at).toBe('2026-03-01T08:00:00Z');
    expect(incident.resolved_at).toBe('2026-03-01T09:00:00Z');
  });
});

// ─── POST /api/status/run-checks ──────────────────────────────────────────────

describe('POST /api/status/run-checks', () => {
  let db;

  beforeEach(() => {
    db = makeDb();
  });

  it('returns { ok: true, checkedAt: ... } on success', async () => {
    const fixedTime = '2026-03-22T10:00:00.000Z';
    const ctx = makeCtx(db, { lastStatusCheckAt: () => fixedTime });
    const { app, routes } = makeApp();
    setupStatusComponentRoutes(app, ctx);

    const { body, status } = await callRoute(routes, '/api/status/run-checks');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.checkedAt).toBe(fixedTime);
  });

  it('calls runStatusChecks()', async () => {
    let called = false;
    const ctx = makeCtx(db, { runStatusChecks: async () => { called = true; } });
    const { app, routes } = makeApp();
    setupStatusComponentRoutes(app, ctx);

    await callRoute(routes, '/api/status/run-checks');
    expect(called).toBe(true);
  });

  it('returns 500 with { ok: false, error } when runStatusChecks throws', async () => {
    const ctx = makeCtx(db, {
      runStatusChecks: async () => { throw new Error('Check failed'); },
    });
    const { app, routes } = makeApp();
    setupStatusComponentRoutes(app, ctx);

    const { body, status } = await callRoute(routes, '/api/status/run-checks');
    expect(status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('Check failed');
  });
});
