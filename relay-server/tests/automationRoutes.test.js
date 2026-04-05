/**
 * Tests for src/routes/automation.js — setupAutomationRoutes(app, ctx).
 *
 * Focuses on preset CRUD routes:
 *   GET    /api/churches/:churchId/presets
 *   POST   /api/churches/:churchId/presets
 *   GET    /api/churches/:churchId/presets/:name
 *   DELETE /api/churches/:churchId/presets/:name
 *
 * Routes are captured via a mock app, then handler chains are invoked
 * directly with mock req/res objects. An in-memory SQLite database is used.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import { PresetLibrary } from '../src/presetLibrary.js';

const require = createRequire(import.meta.url);
const setupAutomationRoutes = require('../src/routes/automation.js');

// ─── DB / PresetLibrary factory ───────────────────────────────────────────────

function makeDb() {
  return new Database(':memory:');
}

function makePresetLibrary(db) {
  return new PresetLibrary(db);
}

// ─── Context factory ──────────────────────────────────────────────────────────

function makeCtx(db, churches, overrides = {}) {
  const presetLibrary = makePresetLibrary(db);
  return {
    churches,
    requireChurchOrAdmin: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => next(),
    requireFeature: () => (_req, _res, next) => next(),
    presetLibrary,
    autoPilot: {
      getStatus: () => ({}),
      getCommandLog: () => [],
      setEnabled: () => {},
    },
    safeErrorMessage: (e) => e.message,
    safeSend: () => {},
    log: () => {},
    ...overrides,
  };
}

// ─── App / route capture ──────────────────────────────────────────────────────

function makeApp() {
  const routes = {};
  const app = {
    get:    (path, ...handlers) => { routes[`GET:${path}`]  = handlers; },
    post:   (path, ...handlers) => { routes[`POST:${path}`] = handlers; },
    put:    (path, ...handlers) => { routes[`PUT:${path}`]  = handlers; },
    delete: (path, ...handlers) => { routes[`DEL:${path}`]  = handlers; },
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

// ─── GET /api/churches/:churchId/presets ─────────────────────────────────────

describe('GET /api/churches/:churchId/presets', () => {
  let db;
  let churches;
  let routes;
  let presetLibrary;

  beforeEach(() => {
    db = makeDb();
    churches = new Map([['ch1', { churchId: 'ch1', name: 'Test Church' }]]);
    const ctx = makeCtx(db, churches);
    presetLibrary = ctx.presetLibrary;
    const { app, routes: r } = makeApp();
    setupAutomationRoutes(app, ctx);
    routes = r;
  });

  it('returns 404 when church not in map', async () => {
    const { body, status } = await callRoute(routes, 'GET:/api/churches/:churchId/presets', {
      params: { churchId: 'unknown' },
    });
    expect(status).toBe(404);
    expect(body.error).toBe('Church not found');
  });

  it('returns empty array when no presets exist', async () => {
    const { body, status } = await callRoute(routes, 'GET:/api/churches/:churchId/presets', {
      params: { churchId: 'ch1' },
    });
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('returns presets after saving some', async () => {
    await presetLibrary.save('ch1', 'Morning Scene', 'mixer_scene', { scene: 'morning' });
    await presetLibrary.save('ch1', 'Evening Scene', 'obs_scene', { sceneName: 'Evening' });

    const { body, status } = await callRoute(routes, 'GET:/api/churches/:churchId/presets', {
      params: { churchId: 'ch1' },
    });
    expect(status).toBe(200);
    expect(body).toHaveLength(2);
    const names = body.map(p => p.name);
    expect(names).toContain('Morning Scene');
    expect(names).toContain('Evening Scene');
  });
});

// ─── POST /api/churches/:churchId/presets ────────────────────────────────────

describe('POST /api/churches/:churchId/presets', () => {
  let db;
  let churches;
  let routes;
  let ctx;

  beforeEach(() => {
    db = makeDb();
    churches = new Map([['ch1', { churchId: 'ch1', name: 'Test Church' }]]);
    ctx = makeCtx(db, churches);
    const { app, routes: r } = makeApp();
    setupAutomationRoutes(app, ctx);
    routes = r;
  });

  it('returns 404 when church not in map', async () => {
    const { body, status } = await callRoute(routes, 'POST:/api/churches/:churchId/presets', {
      params: { churchId: 'unknown' },
      body: { name: 'Scene 1', type: 'mixer_scene', data: { scene: 'main' } },
    });
    expect(status).toBe(404);
    expect(body.error).toBe('Church not found');
  });

  it('returns 400 when name is missing', async () => {
    const { body, status } = await callRoute(routes, 'POST:/api/churches/:churchId/presets', {
      params: { churchId: 'ch1' },
      body: { type: 'mixer_scene', data: { scene: 'main' } },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/name/);
  });

  it('returns 400 when type is missing', async () => {
    const { body, status } = await callRoute(routes, 'POST:/api/churches/:churchId/presets', {
      params: { churchId: 'ch1' },
      body: { name: 'Scene 1', data: { scene: 'main' } },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/type/);
  });

  it('returns 400 when data is missing', async () => {
    const { body, status } = await callRoute(routes, 'POST:/api/churches/:churchId/presets', {
      params: { churchId: 'ch1' },
      body: { name: 'Scene 1', type: 'mixer_scene' },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/data/);
  });

  it('saves preset and returns { id, name, type, saved: true }', async () => {
    const { body, status } = await callRoute(routes, 'POST:/api/churches/:churchId/presets', {
      params: { churchId: 'ch1' },
      body: { name: 'Worship Scene', type: 'mixer_scene', data: { scene: 'worship' } },
    });
    expect(status).toBe(200);
    expect(body.saved).toBe(true);
    expect(body.name).toBe('Worship Scene');
    expect(body.type).toBe('mixer_scene');
    expect(typeof body.id).toBe('string');
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns 500 on presetLibrary.save error', async () => {
    const brokenPresetLibrary = {
      save: () => { throw new Error('DB write failed'); },
    };
    const brokenCtx = makeCtx(db, churches, { presetLibrary: brokenPresetLibrary });
    const { app: brokenApp, routes: brokenRoutes } = makeApp();
    setupAutomationRoutes(brokenApp, brokenCtx);

    const { body, status } = await callRoute(brokenRoutes, 'POST:/api/churches/:churchId/presets', {
      params: { churchId: 'ch1' },
      body: { name: 'Scene 1', type: 'mixer_scene', data: { scene: 'main' } },
    });
    expect(status).toBe(500);
    expect(body.error).toBe('DB write failed');
  });
});

// ─── GET /api/churches/:churchId/presets/:name ───────────────────────────────

describe('GET /api/churches/:churchId/presets/:name', () => {
  let db;
  let churches;
  let routes;
  let presetLibrary;

  beforeEach(() => {
    db = makeDb();
    churches = new Map([['ch1', { churchId: 'ch1', name: 'Test Church' }]]);
    const ctx = makeCtx(db, churches);
    presetLibrary = ctx.presetLibrary;
    const { app, routes: r } = makeApp();
    setupAutomationRoutes(app, ctx);
    routes = r;
  });

  it('returns 404 when church not in map', async () => {
    const { body, status } = await callRoute(routes, 'GET:/api/churches/:churchId/presets/:name', {
      params: { churchId: 'unknown', name: 'Scene 1' },
    });
    expect(status).toBe(404);
    expect(body.error).toBe('Church not found');
  });

  it('returns 404 when preset not found', async () => {
    const { body, status } = await callRoute(routes, 'GET:/api/churches/:churchId/presets/:name', {
      params: { churchId: 'ch1', name: 'NonExistentPreset' },
    });
    expect(status).toBe(404);
    expect(body.error).toBe('Preset not found');
  });

  it('returns preset when found', async () => {
    await presetLibrary.save('ch1', 'Sunday Morning', 'obs_scene', { sceneName: 'Wide Shot' });

    const { body, status } = await callRoute(routes, 'GET:/api/churches/:churchId/presets/:name', {
      params: { churchId: 'ch1', name: 'Sunday Morning' },
    });
    expect(status).toBe(200);
    expect(body.name).toBe('Sunday Morning');
    expect(body.type).toBe('obs_scene');
    expect(body.church_id).toBe('ch1');
    expect(body.data).toEqual({ sceneName: 'Wide Shot' });
  });
});

// ─── DELETE /api/churches/:churchId/presets/:name ────────────────────────────

describe('DELETE /api/churches/:churchId/presets/:name', () => {
  let db;
  let churches;
  let routes;
  let presetLibrary;

  beforeEach(() => {
    db = makeDb();
    churches = new Map([['ch1', { churchId: 'ch1', name: 'Test Church' }]]);
    const ctx = makeCtx(db, churches);
    presetLibrary = ctx.presetLibrary;
    const { app, routes: r } = makeApp();
    setupAutomationRoutes(app, ctx);
    routes = r;
  });

  it('returns 404 when church not in map', async () => {
    const { body, status } = await callRoute(routes, 'DEL:/api/churches/:churchId/presets/:name', {
      params: { churchId: 'unknown', name: 'Scene 1' },
    });
    expect(status).toBe(404);
    expect(body.error).toBe('Church not found');
  });

  it('returns 404 when preset not found', async () => {
    const { body, status } = await callRoute(routes, 'DEL:/api/churches/:churchId/presets/:name', {
      params: { churchId: 'ch1', name: 'NonExistentPreset' },
    });
    expect(status).toBe(404);
    expect(body.error).toBe('Preset not found');
  });

  it('returns { deleted: true } when deleted', async () => {
    await presetLibrary.save('ch1', 'Preset To Delete', 'atem_macro', { macroIndex: 7 });

    const { body, status } = await callRoute(routes, 'DEL:/api/churches/:churchId/presets/:name', {
      params: { churchId: 'ch1', name: 'Preset To Delete' },
    });
    expect(status).toBe(200);
    expect(body.deleted).toBe(true);

    // Verify the preset is actually gone
    const gone = await presetLibrary.get('ch1', 'Preset To Delete');
    expect(gone).toBeNull();
  });
});
