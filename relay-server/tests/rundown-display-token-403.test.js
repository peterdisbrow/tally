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
  return originalLoad.apply(this, arguments);
};
const { ManualRundownStore } = require('../src/manualRundown');
const { LiveRundownManager } = require('../src/liveRundown');
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

describe('display-token 403 on public live mutate + item PUT', () => {
  let db;
  let queryClient;
  let store;
  let app;
  let client;
  let liveRundown;

  beforeEach(async () => {
    db = createDb();
    queryClient = createQueryClient({ config: SQLITE_CONFIG, sqliteDb: db });
    store = new ManualRundownStore({ queryClient, log: () => {} });
    await store.ready;
    liveRundown = new LiveRundownManager({
      broadcastToMobile: () => {},
      broadcastToPortal: () => {},
      broadcastToControllers: () => {},
      broadcastToChurch: () => {},
    });

    const churches = new Map([
      ['church-1', { churchId: 'church-1', name: 'Test Church' }],
    ]);
    app = express();
    app.use(express.json());
    setupLiveRundownRoutes(app, {
      db,
      churches,
      requireChurchOrAdmin: (req, res, next) => {
        const churchId = req.params.churchId || 'church-1';
        const church = churches.get(churchId);
        if (!church) return res.status(404).json({ error: 'Church not found' });
        req.church = church;
        req.churchPayload = {
          churchId,
          name: String(req.headers['x-test-user'] || 'TD'),
          readonly: false,
        };
        return next();
      },
      requireFeature: () => (_req, _res, next) => next(),
      planningCenter: {
        getCachedPlans: () => [],
        getCachedPlan: () => null,
      },
      liveRundown,
      manualRundown: store,
      safeErrorMessage: (error) => error?.message || 'Internal error',
      uuidv4: require('uuid').v4,
      broadcastToPortal: vi.fn(),
      broadcastPublicRundownTimer: vi.fn(),
      rundownPresence: new Map(),
      log: () => {},
    });
    client = createClient(app);
  });

  afterEach(async () => {
    liveRundown?.shutdown();
    await queryClient?.close();
    db?.close();
  });

  async function seedPlanWithShares() {
    const createRes = await client.post('/api/churches/church-1/rundown-plans', {
      body: { title: 'Sunday Service', roomId: 'sanctuary' },
      headers: { 'x-test-user': 'Taylor', 'x-session-id': 'owner-session' },
    });
    expect(createRes.status).toBe(200);
    const planId = createRes.body.id;
    await client.post(`/api/churches/church-1/rundown-plans/${planId}/items`, {
      body: { title: 'Welcome', itemType: 'other', lengthSeconds: 90 },
      headers: { 'x-test-user': 'Taylor', 'x-session-id': 'owner-session' },
    });
    await client.post(`/api/churches/church-1/rundown-plans/${planId}/items`, {
      body: { title: 'Message', itemType: 'other', lengthSeconds: 1200 },
      headers: { 'x-test-user': 'Taylor', 'x-session-id': 'owner-session' },
    });
    const shareRes = await client.post(`/api/churches/church-1/rundown-plans/${planId}/share`, {
      body: { role: 'both' },
      headers: { 'x-test-user': 'Taylor', 'x-session-id': 'owner-session' },
    });
    expect(shareRes.status).toBe(200);
    expect(shareRes.body.display?.token).toBeTruthy();
    expect(shareRes.body.operator?.token).toBeTruthy();
    expect(shareRes.body.display.role).toBe('display');
    expect(shareRes.body.operator.role).toBe('operator');
    const plan = await store.getPlan(planId);
    return {
      plan,
      displayToken: shareRes.body.display.token,
      operatorToken: shareRes.body.operator.token,
    };
  }

  it('creates independent display and operator shares', async () => {
    const { displayToken, operatorToken } = await seedPlanWithShares();
    expect(displayToken).not.toBe(operatorToken);
  });

  it('returns 403 when a display token mutates public live or items', async () => {
    const { displayToken, plan } = await seedPlanWithShares();
    const itemId = plan.items[0].id;

    const mutatePaths = [
      { method: 'post', path: `/api/public/rundown/${displayToken}/live/start` },
      { method: 'post', path: `/api/public/rundown/${displayToken}/live/go` },
      { method: 'post', path: `/api/public/rundown/${displayToken}/live/back` },
      { method: 'post', path: `/api/public/rundown/${displayToken}/live/goto/0` },
      { method: 'post', path: `/api/public/rundown/${displayToken}/live/pause` },
      { method: 'post', path: `/api/public/rundown/${displayToken}/live/resume` },
      { method: 'post', path: `/api/public/rundown/${displayToken}/live/add-time`, body: { seconds: 15 } },
      { method: 'post', path: `/api/public/rundown/${displayToken}/live/stop` },
      { method: 'put', path: `/api/public/rundown/${displayToken}/items/${itemId}`, body: { title: 'Hacked' } },
    ];

    for (const entry of mutatePaths) {
      const res = await client[entry.method](entry.path, { body: entry.body || {} });
      expect(res.status, `${entry.method.toUpperCase()} ${entry.path}`).toBe(403);
      expect(res.body.code).toBe('display_token_forbidden');
      expect(res.body.shareRole).toBe('display');
    }

    const unchanged = await store.getPlan(plan.id);
    expect(unchanged.items[0].title).toBe('Welcome');
  });

  it('lets an operator token start and GO on the canonical LiveRundownManager session', async () => {
    const { operatorToken, displayToken, plan } = await seedPlanWithShares();

    const startRes = await client.post(`/api/public/rundown/${operatorToken}/live/start`, { body: {} });
    expect(startRes.status).toBe(200);
    expect(startRes.body.isLive).toBe(true);
    expect(startRes.body.planId).toBe(plan.id);
    expect(liveRundown.findSessionByPlanId(plan.id)).toEqual({
      churchId: 'church-1',
      roomId: 'sanctuary',
    });

    const goRes = await client.post(`/api/public/rundown/${operatorToken}/live/go`, { body: {} });
    expect(goRes.status).toBe(200);
    expect(goRes.body.currentCueIndex).toBeGreaterThan(startRes.body.currentCueIndex);

    const displayGo = await client.post(`/api/public/rundown/${displayToken}/live/go`, { body: {} });
    expect(displayGo.status).toBe(403);
    expect(liveRundown.getState('church-1', 'sanctuary').currentIndex).toBe(goRes.body.currentCueIndex);
  });

  it('ignores leftover rundown_live_state so public timer follows only LiveRundownManager', async () => {
    const { displayToken, operatorToken, plan } = await seedPlanWithShares();
    await store.startLive(plan.id, 'church-1');
    expect((await store.getLiveState(plan.id))?.isLive).toBe(true);

    const leftoverTimer = await client.get(`/api/public/rundown/${displayToken}/timer`);
    expect(leftoverTimer.status).toBe(200);
    expect(leftoverTimer.body.is_live).toBeFalsy();
    expect(liveRundown.findSessionByPlanId(plan.id)).toBeNull();

    const startRes = await client.post(`/api/public/rundown/${operatorToken}/live/start`, { body: {} });
    expect(startRes.status).toBe(200);
    expect(await store.getLiveState(plan.id)).toBeNull();

    const liveTimer = await client.get(`/api/public/rundown/${displayToken}/timer`);
    expect(liveTimer.body.is_live).toBe(true);
    expect(liveTimer.body.plan_id).toBe(plan.id);
    expect(liveTimer.body.cue_title).toBe('Welcome');

    const stopRes = await client.post(`/api/public/rundown/${operatorToken}/live/stop`, { body: {} });
    expect(stopRes.status).toBe(200);

    const endedTimer = await client.get(`/api/public/rundown/${displayToken}/timer`);
    expect(endedTimer.body.is_live).toBeFalsy();
    expect(await store.getLiveState(plan.id)).toBeNull();
    expect(liveRundown.findSessionByPlanId(plan.id)).toBeNull();
  });
});
