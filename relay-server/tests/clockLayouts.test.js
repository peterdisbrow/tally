/**
 * Tests for src/routes/clockLayouts.js
 *
 * requireChurchAppAuth sets req.church.churchId (not req.churchId).
 * routeCtx.log is a function, not a logger object with .error().
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const setupClockLayoutRoutes = require('../src/routes/clockLayouts.js');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE clock_layouts (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      name TEXT NOT NULL,
      layout_mode TEXT NOT NULL,
      cells TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    )
  `);
  return db;
}

function makeApp() {
  const routes = {};
  const app = {
    get: (path, ...handlers) => { routes[`GET:${path}`] = handlers; },
    post: (path, ...handlers) => { routes[`POST:${path}`] = handlers; },
    delete: (path, ...handlers) => { routes[`DEL:${path}`] = handlers; },
  };
  return { app, routes };
}

async function callRoute(routes, key, { body = {}, params = {}, church, churchId, churchReadonly = false } = {}) {
  let sentJson = null;
  let sentStatus = 200;
  const res = {
    json: (data) => { sentJson = data; return res; },
    status: (code) => { sentStatus = code; return res; },
  };
  const req = { body, params, church, churchId, churchReadonly };
  const handlers = routes[key];
  for (const handler of handlers) {
    let nextCalled = false;
    await handler(req, res, () => { nextCalled = true; });
    if (!nextCalled && handler !== handlers[handlers.length - 1]) {
      // auth/rate-limit short-circuited
      break;
    }
  }
  return { status: sentStatus, body: sentJson };
}

describe('clockLayouts routes', () => {
  let db;
  let routes;
  let log;

  beforeEach(() => {
    db = makeDb();
    log = vi.fn();
    const { app, routes: captured } = makeApp();
    setupClockLayoutRoutes(app, {
      db,
      requireChurchAppAuth: (req, _res, next) => next(),
      rateLimit: () => (_req, _res, next) => next(),
      uuidv4: () => 'layout-1',
      log,
    });
    routes = captured;
  });

  it('lists layouts for req.church.churchId (not req.churchId)', async () => {
    db.prepare(
      `INSERT INTO clock_layouts (id, church_id, name, layout_mode, cells, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('a', 'church-a', 'Booth', '2x2', '[{"mode":"clock"}]', '2026-09-08T00:00:00.000Z');
    db.prepare(
      `INSERT INTO clock_layouts (id, church_id, name, layout_mode, cells, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('b', 'church-b', 'Other', '2x1', '[]', '2026-09-08T00:00:00.000Z');

    const res = await callRoute(routes, 'GET:/api/church/app/clock-layouts', {
      church: { churchId: 'church-a' },
    });

    expect(res.status).toBe(200);
    expect(res.body.layouts).toHaveLength(1);
    expect(res.body.layouts[0]).toMatchObject({
      id: 'a',
      name: 'Booth',
      layoutMode: '2x2',
      cells: [{ mode: 'clock' }],
    });
  });

  it('saves a layout under the authenticated church id', async () => {
    const res = await callRoute(routes, 'POST:/api/church/app/clock-layouts', {
      church: { churchId: 'church-a' },
      body: { name: '  Sunday  ', layoutMode: '2x2', cells: [{ mode: 'countdown' }] },
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 'layout-1',
      name: 'Sunday',
      layoutMode: '2x2',
      cells: [{ mode: 'countdown' }],
    });

    const row = db.prepare('SELECT church_id, name FROM clock_layouts WHERE id = ?').get('layout-1');
    expect(row).toEqual({ church_id: 'church-a', name: 'Sunday' });
  });

  it('rejects missing name / cells and read-only tokens', async () => {
    const missing = await callRoute(routes, 'POST:/api/church/app/clock-layouts', {
      church: { churchId: 'church-a' },
      body: { layoutMode: '2x2', cells: [] },
    });
    expect(missing.status).toBe(400);

    const readonly = await callRoute(routes, 'POST:/api/church/app/clock-layouts', {
      church: { churchId: 'church-a' },
      churchReadonly: true,
      body: { name: 'X', layoutMode: '2x2', cells: [] },
    });
    expect(readonly.status).toBe(403);
  });

  it('does not delete another church’s layout', async () => {
    db.prepare(
      `INSERT INTO clock_layouts (id, church_id, name, layout_mode, cells, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('a', 'church-a', 'Booth', '2x2', '[]', '2026-09-08T00:00:00.000Z');

    const res = await callRoute(routes, 'DEL:/api/church/app/clock-layouts/:id', {
      church: { churchId: 'church-b' },
      params: { id: 'a' },
    });
    expect(res.status).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS n FROM clock_layouts').get().n).toBe(1);
  });

  it('logs with a function-style log() and still returns 500 on query failure', async () => {
    const { app, routes: brokenRoutes } = makeApp();
    setupClockLayoutRoutes(app, {
      db: {
        prepare() {
          throw new Error('db down');
        },
      },
      requireChurchAppAuth: (_req, _res, next) => next(),
      rateLimit: () => (_req, _res, next) => next(),
      uuidv4: () => 'x',
      log,
    });

    const res = await callRoute(brokenRoutes, 'GET:/api/church/app/clock-layouts', {
      church: { churchId: 'church-a' },
    });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to load layouts' });
    expect(log).toHaveBeenCalled();
    expect(typeof log.mock.calls[0][0]).toBe('string');
  });
});
