import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import Database from 'better-sqlite3';
import { createRequire } from 'module';
import { createQueryClient } from '../src/db/queryClient.js';
import { createClient } from './helpers/expressTestClient.js';

const require = createRequire(import.meta.url);
const Module = require('module');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'multer') {
    const multer = function multer() {
      return {
        single: () => (_req, _res, next) => next(),
      };
    };
    multer.diskStorage = () => ({});
    return multer;
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { ManualRundownStore } = require('../src/manualRundown');
const setupLiveRundownRoutes = require('../src/routes/liveRundown');
Module._load = originalLoad;

const SQLITE_CONFIG = {
  driver: 'sqlite',
  isSqlite: true,
  isPostgres: false,
  databaseUrl: '',
};

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      registeredAt TEXT NOT NULL
    )
  `);
  db.prepare('INSERT INTO churches (churchId, name, registeredAt) VALUES (?, ?, ?)')
    .run('church-1', 'Test Church', new Date().toISOString());
  return db;
}

describe('rundown collaboration routes', () => {
  let db;
  let queryClient;
  let store;
  let app;
  let client;
  let broadcastToPortal;
  let churches;

  beforeEach(async () => {
    db = createDb();
    queryClient = createQueryClient({ config: SQLITE_CONFIG, sqliteDb: db });
    store = new ManualRundownStore({ queryClient, log: () => {} });
    await store.ready;

    churches = new Map([
      ['church-1', { churchId: 'church-1', name: 'Test Church' }],
    ]);
    broadcastToPortal = vi.fn();
    app = express();
    app.use(express.json());
    setupLiveRundownRoutes(app, {
      db,
      churches,
      requireChurchOrAdmin: (req, res, next) => {
        const churchId = req.params.churchId || req.body?.churchId || 'church-1';
        const church = churches.get(churchId);
        if (!church) return res.status(404).json({ error: 'Church not found' });
        req.church = church;
        req.churchPayload = {
          churchId,
          name: String(req.headers['x-test-user'] || req.headers['x-user-name'] || church.name || 'TD'),
          readonly: String(req.headers['x-readonly'] || '') === '1',
        };
        return next();
      },
      requireFeature: () => (_req, _res, next) => next(),
      planningCenter: {
        getCachedPlans: () => [],
        getCachedPlan: () => null,
      },
      liveRundown: {
        findSessionByPlanId: () => null,
        getTimerState: () => null,
        startSession: () => ({}),
        advance: () => null,
        back: () => null,
        goTo: () => null,
        endSession: () => null,
        setAutoAdvance: () => null,
        getState: () => null,
        setItemActions: () => {},
      },
      manualRundown: store,
      safeErrorMessage: (error) => error?.message || 'Internal error',
      uuidv4: require('uuid').v4,
      broadcastToPortal,
      broadcastPublicRundownTimer: vi.fn(),
      rundownPresence: new Map(),
      log: () => {},
    });
    client = createClient(app);
  });

  afterEach(async () => {
    await queryClient?.close();
    db?.close();
  });

  it('persists owner/editor/viewer roles and blocks viewer writes', async () => {
    const createRes = await client.post('/api/churches/church-1/rundown-plans', {
      body: { title: 'Sunday Service' },
      headers: {
        'x-test-user': 'Taylor',
        'x-session-id': 'owner-session',
      },
    });
    expect(createRes.status).toBe(200);
    expect(createRes.body.collaborators).toEqual(expect.arrayContaining([
      expect.objectContaining({ collaboratorKey: 'owner-session', role: 'owner' }),
    ]));

    const planId = createRes.body.id;
    await client.post(`/api/churches/church-1/rundown-plans/${planId}/collaborators`, {
      body: {
        collaboratorKey: 'viewer-session',
        displayName: 'Sam',
        role: 'viewer',
      },
      headers: {
        'x-test-user': 'Taylor',
        'x-session-id': 'owner-session',
      },
    });

    const viewerUpdate = await client.put(`/api/churches/church-1/rundown-plans/${planId}`, {
      body: { title: 'Should not save' },
      headers: {
        'x-test-user': 'Sam',
        'x-session-id': 'viewer-session',
      },
    });

    expect(viewerUpdate.status).toBe(403);
    expect(String(viewerUpdate.body.error || '')).toMatch(/view-only/i);

    const roster = await client.get(`/api/churches/church-1/rundown-plans/${planId}/collaborators`, {
      headers: {
        'x-test-user': 'Taylor',
        'x-session-id': 'owner-session',
      },
    });

    expect(roster.status).toBe(200);
    expect(roster.body.collaborators).toEqual(expect.arrayContaining([
      expect.objectContaining({ collaboratorKey: 'owner-session', role: 'owner' }),
      expect.objectContaining({ collaboratorKey: 'viewer-session', role: 'viewer' }),
    ]));
  });

  it('refreshes presence with heartbeat and keeps offline collaborators in the roster', async () => {
    const createRes = await client.post('/api/churches/church-1/rundown-plans', {
      body: { title: 'Wednesday Rehearsal' },
      headers: {
        'x-test-user': 'Taylor',
        'x-session-id': 'owner-session',
      },
    });
    const planId = createRes.body.id;

    const subscribeRes = await client.post(`/api/churches/church-1/rundown-plans/${planId}/subscribe`, {
      body: {
        userName: 'Jordan',
        sessionId: 'editor-session',
        role: 'editor',
      },
      headers: {
        'x-test-user': 'Jordan',
        'x-session-id': 'editor-session',
      },
    });

    expect(subscribeRes.status).toBe(200);
    expect(subscribeRes.body).toMatchObject({
      sessionId: 'editor-session',
      heartbeatIntervalMs: 30_000,
      staleAfterMs: 300_000,
    });
    expect(subscribeRes.body.editors).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: 'editor-session', userName: 'Jordan', role: 'editor', status: 'active' }),
    ]));

    const heartbeatRes = await client.post(`/api/churches/church-1/rundown-plans/${planId}/heartbeat`, {
      body: {
        sessionId: 'editor-session',
        userName: 'Jordan',
      },
      headers: {
        'x-test-user': 'Jordan',
        'x-session-id': 'editor-session',
      },
    });

    expect(heartbeatRes.status).toBe(200);
    expect(heartbeatRes.body).toMatchObject({
      sessionId: 'editor-session',
      heartbeatIntervalMs: 30_000,
    });

    const unsubscribeRes = await client.post(`/api/churches/church-1/rundown-plans/${planId}/unsubscribe`, {
      body: { sessionId: 'editor-session' },
      headers: {
        'x-test-user': 'Jordan',
        'x-session-id': 'editor-session',
      },
    });
    expect(unsubscribeRes.status).toBe(200);

    const roster = await client.get(`/api/churches/church-1/rundown-plans/${planId}/collaborators`, {
      headers: {
        'x-test-user': 'Taylor',
        'x-session-id': 'owner-session',
      },
    });
    const collaborator = roster.body.collaborators.find((entry) => entry.collaboratorKey === 'editor-session');
    expect(collaborator).toMatchObject({
      role: 'editor',
      status: 'offline',
    });
    expect(broadcastToPortal).toHaveBeenCalled();
  });
});
