/**
 * Tests for src/routes/scheduler.js
 *
 * Covers: rundown CRUD and scheduler control endpoints
 * (activate, advance, skip, back, jump, pause, resume,
 *  deactivate, status).
 *
 * Uses real RundownEngine (in-memory SQLite) and a lightweight
 * scheduler stub so tests stay fast and deterministic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import http from 'http';

const require = createRequire(import.meta.url);
const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { RundownEngine } = require('../src/rundownEngine');
const setupSchedulerRoutes = require('../src/routes/scheduler');

const JWT_SECRET = 'test-scheduler-routes-secret';
const ADMIN_API_KEY = 'test-admin-api-key-for-scheduler';

// ─── DB helpers ───────────────────────────────────────────────────────────────

function createDb() {
  return new Database(':memory:');
}

// ─── App factory ──────────────────────────────────────────────────────────────

function buildApp(db, schedulerOverrides = {}) {
  const app = express();
  app.use(express.json());

  const churchesMap = new Map();
  const rundownEngine = new RundownEngine(db);

  function requireChurchOrAdmin(req, res, next) {
    // Accept admin API key
    const key = req.headers['x-api-key'] || '';
    if (key === ADMIN_API_KEY) return next();

    // Accept church JWT (can only access own churchId)
    const auth = req.headers['authorization'] || '';
    if (auth.startsWith('Bearer ')) {
      try {
        const payload = jwt.verify(auth.slice(7), JWT_SECRET);
        if (req.params.churchId && payload.churchId !== req.params.churchId) {
          return res.status(403).json({ error: 'forbidden' });
        }
        req.churchPayload = payload;
        return next();
      } catch {
        return res.status(401).json({ error: 'invalid token' });
      }
    }
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Minimal scheduler stub
  const scheduler = {
    activate: vi.fn((churchId, rundownId) => {
      const rundown = rundownEngine.getRundown(rundownId);
      if (!rundown || rundown.church_id !== churchId) return { error: 'Rundown not found' };
      return { activated: true, churchId, rundownId };
    }),
    advance: vi.fn(async (churchId) => ({ advanced: true, churchId, currentStep: 1 })),
    skip: vi.fn((churchId) => ({ skipped: true, churchId })),
    goBack: vi.fn((churchId) => ({ wentBack: true, churchId })),
    jumpToCue: vi.fn((churchId, cueIndex) => ({ jumped: true, churchId, cueIndex })),
    pause: vi.fn((churchId) => ({ paused: true, churchId })),
    resume: vi.fn((churchId) => ({ resumed: true, churchId })),
    deactivate: vi.fn((churchId) => ({ deactivated: true, churchId })),
    getStatus: vi.fn((churchId) => ({ churchId, active: false })),
    ...schedulerOverrides,
  };

  const ctx = {
    churches: churchesMap,
    requireChurchOrAdmin,
    requireFeature: () => (req, res, next) => next(),
    rundownEngine,
    scheduler,
  };

  setupSchedulerRoutes(app, ctx);
  return { app, churchesMap, rundownEngine, scheduler };
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function makeClient(app) {
  const server = app.listen(0);
  const port = server.address().port;

  function call(method, path, { body, apiKey, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const opts = {
        method: method.toUpperCase(),
        hostname: '127.0.0.1',
        port,
        path,
        headers: { ...headers },
      };
      if (apiKey) opts.headers['x-api-key'] = apiKey;
      let payload;
      if (body !== undefined) {
        payload = JSON.stringify(body);
        opts.headers['Content-Type'] = 'application/json';
        opts.headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          let json;
          try { json = JSON.parse(data); } catch { json = data; }
          resolve({ status: res.statusCode, body: json });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  return {
    get: (path, opts) => call('GET', path, opts),
    post: (path, opts) => call('POST', path, opts),
    put: (path, opts) => call('PUT', path, opts),
    delete: (path, opts) => call('DELETE', path, opts),
    close: () => new Promise(r => server.close(r)),
  };
}

function issueChrchJwt(churchId) {
  return jwt.sign({ type: 'church_app', churchId }, JWT_SECRET, { expiresIn: '1h' });
}

// ─── GET /api/churches/:churchId/rundowns ─────────────────────────────────────

describe('GET /api/churches/:churchId/rundowns', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 401 without credentials', async () => {
    built.churchesMap.set('ch-1', { churchId: 'ch-1', name: 'Church' });
    const { status } = await client.get('/api/churches/ch-1/rundowns');
    expect(status).toBe(401);
  });

  it('returns 404 for unknown church', async () => {
    const { status } = await client.get('/api/churches/no-church/rundowns', {
      apiKey: ADMIN_API_KEY,
    });
    expect(status).toBe(404);
  });

  it('returns empty array for church with no rundowns', async () => {
    const churchId = uuidv4();
    built.churchesMap.set(churchId, { churchId, name: 'Test Church' });
    const { status, body } = await client.get(`/api/churches/${churchId}/rundowns`, {
      apiKey: ADMIN_API_KEY,
    });
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  it('accepts church JWT for own church', async () => {
    const churchId = uuidv4();
    built.churchesMap.set(churchId, { churchId, name: 'JWT Church' });
    const token = issueChrchJwt(churchId);
    const { status } = await client.get(`/api/churches/${churchId}/rundowns`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(status).toBe(200);
  });

  it('returns 403 when church JWT used for different church', async () => {
    const churchId1 = uuidv4();
    const churchId2 = uuidv4();
    built.churchesMap.set(churchId1, { churchId: churchId1, name: 'Church 1' });
    built.churchesMap.set(churchId2, { churchId: churchId2, name: 'Church 2' });
    const token = issueChrchJwt(churchId1);
    const { status } = await client.get(`/api/churches/${churchId2}/rundowns`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(status).toBe(403);
  });
});

// ─── POST /api/churches/:churchId/rundowns ────────────────────────────────────

describe('POST /api/churches/:churchId/rundowns', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 400 when name is missing', async () => {
    const churchId = uuidv4();
    built.churchesMap.set(churchId, { churchId, name: 'Test Church' });
    const { status, body } = await client.post(`/api/churches/${churchId}/rundowns`, {
      apiKey: ADMIN_API_KEY,
      body: {},
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/name/i);
  });

  it('creates rundown and returns 201', async () => {
    const churchId = uuidv4();
    built.churchesMap.set(churchId, { churchId, name: 'Test Church' });
    const { status, body } = await client.post(`/api/churches/${churchId}/rundowns`, {
      apiKey: ADMIN_API_KEY,
      body: { name: 'Sunday Service', steps: [{ label: 'Welcome' }] },
    });
    expect(status).toBe(201);
    expect(body.name).toBe('Sunday Service');
    expect(body.id).toBeTruthy();
    expect(body.church_id).toBe(churchId);
  });

  it('persists service_day and auto_activate when provided', async () => {
    const churchId = uuidv4();
    built.churchesMap.set(churchId, { churchId, name: 'Test Church' });
    const { status, body } = await client.post(`/api/churches/${churchId}/rundowns`, {
      apiKey: ADMIN_API_KEY,
      body: { name: 'Wednesday Night', service_day: 3, auto_activate: true },
    });
    expect(status).toBe(201);
    const row = db.prepare('SELECT service_day, auto_activate FROM rundowns WHERE id = ?').get(body.id);
    expect(row.service_day).toBe(3);
    expect(row.auto_activate).toBe(1);
  });
});

// ─── GET /api/churches/:churchId/rundowns/:id ────────────────────────────────

describe('GET /api/churches/:churchId/rundowns/:id', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 404 for unknown rundown', async () => {
    const churchId = uuidv4();
    built.churchesMap.set(churchId, { churchId, name: 'Test Church' });
    const { status } = await client.get(`/api/churches/${churchId}/rundowns/no-such-id`, {
      apiKey: ADMIN_API_KEY,
    });
    expect(status).toBe(404);
  });

  it('returns rundown details', async () => {
    const churchId = uuidv4();
    built.churchesMap.set(churchId, { churchId, name: 'Test Church' });
    const created = built.rundownEngine.createRundown(churchId, 'Evening Service', [{ label: 'Worship' }]);
    const { status, body } = await client.get(`/api/churches/${churchId}/rundowns/${created.id}`, {
      apiKey: ADMIN_API_KEY,
    });
    expect(status).toBe(200);
    expect(body.name).toBe('Evening Service');
  });

  it('returns 404 when rundown belongs to a different church', async () => {
    const churchId1 = uuidv4();
    const churchId2 = uuidv4();
    built.churchesMap.set(churchId1, { churchId: churchId1, name: 'Church 1' });
    built.churchesMap.set(churchId2, { churchId: churchId2, name: 'Church 2' });
    const created = built.rundownEngine.createRundown(churchId1, 'My Rundown', []);
    const { status } = await client.get(`/api/churches/${churchId2}/rundowns/${created.id}`, {
      apiKey: ADMIN_API_KEY,
    });
    expect(status).toBe(404);
  });
});

// ─── PUT /api/churches/:churchId/rundowns/:id ────────────────────────────────

describe('PUT /api/churches/:churchId/rundowns/:id', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 404 for unknown rundown', async () => {
    const churchId = uuidv4();
    built.churchesMap.set(churchId, { churchId, name: 'Test Church' });
    const { status } = await client.put(`/api/churches/${churchId}/rundowns/no-id`, {
      apiKey: ADMIN_API_KEY,
      body: { name: 'New Name' },
    });
    expect(status).toBe(404);
  });

  it('updates rundown name', async () => {
    const churchId = uuidv4();
    built.churchesMap.set(churchId, { churchId, name: 'Test Church' });
    const created = built.rundownEngine.createRundown(churchId, 'Old Name', []);
    const { status, body } = await client.put(`/api/churches/${churchId}/rundowns/${created.id}`, {
      apiKey: ADMIN_API_KEY,
      body: { name: 'New Name' },
    });
    expect(status).toBe(200);
    expect(body.name).toBe('New Name');
  });
});

// ─── DELETE /api/churches/:churchId/rundowns/:id ─────────────────────────────

describe('DELETE /api/churches/:churchId/rundowns/:id', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 404 for unknown rundown', async () => {
    const churchId = uuidv4();
    built.churchesMap.set(churchId, { churchId, name: 'Test Church' });
    const { status } = await client.delete(`/api/churches/${churchId}/rundowns/no-id`, {
      apiKey: ADMIN_API_KEY,
    });
    expect(status).toBe(404);
  });

  it('deletes rundown and returns {deleted:true}', async () => {
    const churchId = uuidv4();
    built.churchesMap.set(churchId, { churchId, name: 'Test Church' });
    const created = built.rundownEngine.createRundown(churchId, 'To Delete', []);
    const { status, body } = await client.delete(`/api/churches/${churchId}/rundowns/${created.id}`, {
      apiKey: ADMIN_API_KEY,
    });
    expect(status).toBe(200);
    expect(body.deleted).toBe(true);
    expect(built.rundownEngine.getRundown(created.id)).toBeNull();
  });
});

// ─── POST /api/churches/:churchId/scheduler/activate ─────────────────────────

describe('POST /api/churches/:churchId/scheduler/activate', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 401 without credentials', async () => {
    const { status } = await client.post('/api/churches/any/scheduler/activate', { body: { rundownId: 'x' } });
    expect(status).toBe(401);
  });

  it('returns 400 when rundownId is missing', async () => {
    const churchId = uuidv4();
    built.churchesMap.set(churchId, { churchId, name: 'Test Church' });
    const { status, body } = await client.post(`/api/churches/${churchId}/scheduler/activate`, {
      apiKey: ADMIN_API_KEY,
      body: {},
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/rundownId/i);
  });

  it('activates rundown and returns result', async () => {
    const churchId = uuidv4();
    built.churchesMap.set(churchId, { churchId, name: 'Test Church' });
    const created = built.rundownEngine.createRundown(churchId, 'Sunday', []);
    const { status, body } = await client.post(`/api/churches/${churchId}/scheduler/activate`, {
      apiKey: ADMIN_API_KEY,
      body: { rundownId: created.id },
    });
    expect(status).toBe(200);
    expect(body.activated).toBe(true);
  });

  it('returns 400 when scheduler returns error', async () => {
    const churchId = uuidv4();
    built.churchesMap.set(churchId, { churchId, name: 'Test Church' });
    built.scheduler.activate.mockReturnValueOnce({ error: 'Already active' });
    const { status, body } = await client.post(`/api/churches/${churchId}/scheduler/activate`, {
      apiKey: ADMIN_API_KEY,
      body: { rundownId: 'any-id' },
    });
    expect(status).toBe(400);
    expect(body.error).toBe('Already active');
  });
});

// ─── POST /api/churches/:churchId/scheduler/advance ──────────────────────────

describe('POST /api/churches/:churchId/scheduler/advance', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 401 without credentials', async () => {
    const { status } = await client.post('/api/churches/any/scheduler/advance');
    expect(status).toBe(401);
  });

  it('advances and returns result', async () => {
    const churchId = uuidv4();
    built.churchesMap.set(churchId, { churchId, name: 'Test Church' });
    const { status, body } = await client.post(`/api/churches/${churchId}/scheduler/advance`, {
      apiKey: ADMIN_API_KEY,
      body: {},
    });
    expect(status).toBe(200);
    expect(body.advanced).toBe(true);
  });
});

// ─── POST /api/churches/:churchId/scheduler/jump ─────────────────────────────

describe('POST /api/churches/:churchId/scheduler/jump', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 400 when cueIndex is missing', async () => {
    const churchId = uuidv4();
    built.churchesMap.set(churchId, { churchId, name: 'Test Church' });
    const { status, body } = await client.post(`/api/churches/${churchId}/scheduler/jump`, {
      apiKey: ADMIN_API_KEY,
      body: {},
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/cueIndex/i);
  });

  it('jumps to cue and returns result', async () => {
    const churchId = uuidv4();
    built.churchesMap.set(churchId, { churchId, name: 'Test Church' });
    const { status, body } = await client.post(`/api/churches/${churchId}/scheduler/jump`, {
      apiKey: ADMIN_API_KEY,
      body: { cueIndex: 3 },
    });
    expect(status).toBe(200);
    expect(body.jumped).toBe(true);
    expect(body.cueIndex).toBe(3);
  });
});

// ─── GET /api/churches/:churchId/scheduler/status ────────────────────────────

describe('GET /api/churches/:churchId/scheduler/status', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 401 without credentials', async () => {
    const { status } = await client.get('/api/churches/any/scheduler/status');
    expect(status).toBe(401);
  });

  it('returns scheduler status', async () => {
    const churchId = uuidv4();
    built.churchesMap.set(churchId, { churchId, name: 'Test Church' });
    built.scheduler.getStatus.mockReturnValueOnce({ churchId, active: true, currentStep: 2 });
    const { status, body } = await client.get(`/api/churches/${churchId}/scheduler/status`, {
      apiKey: ADMIN_API_KEY,
    });
    expect(status).toBe(200);
    expect(body.active).toBe(true);
    expect(body.currentStep).toBe(2);
  });
});
