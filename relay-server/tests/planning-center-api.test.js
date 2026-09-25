/**
 * Planning Center against a mock that mirrors the real PCO Services v2 API
 * (church-client/test/mocks/planningCenterServer.js — see its header for the doc sources).
 * No request may leave 127.0.0.1: the real PCO API is never called from tests.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const pcoMock = require('../../church-client/test/mocks/planningCenterServer.js');

let mock;
let PlanningCenter;
const realFetch = globalThis.fetch;
const offBox = [];

beforeAll(async () => {
  mock = await pcoMock.start({ port: 0, controlPort: 0 });
  process.env.PCO_API_ORIGIN = mock.url;
  globalThis.fetch = (url, opts) => {
    const u = String(url);
    if (!u.startsWith('http://127.0.0.1:')) {
      offBox.push(u);
      return Promise.reject(new Error(`test guard: refused off-box request to ${u}`));
    }
    return realFetch(url, opts);
  };
  ({ PlanningCenter } = require('../src/planningCenter'));
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  delete process.env.PCO_API_ORIGIN;
  await mock?.stop();
});

function makePc({ writeback = true, serviceTypeId = '1001', appId = 'lab-app-id', secret = 'lab-secret' } = {}) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE churches (churchId TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, token TEXT,
    registeredAt TEXT NOT NULL, service_times TEXT DEFAULT '[]', timezone TEXT DEFAULT '')`);
  const pc = new PlanningCenter(db);
  db.prepare('INSERT INTO churches (churchId, name, registeredAt) VALUES (?, ?, ?)').run('c1', 'Lab Church', new Date().toISOString());
  db.prepare('UPDATE churches SET pc_app_id = ?, pc_secret = ?, pc_service_type_id = ?, pc_sync_enabled = 1, pc_writeback_enabled = ? WHERE churchId = ?')
    .run(appId, secret, serviceTypeId, writeback ? 1 : 0, 'c1');
  return { db, pc };
}

describe('Planning Center against the real-API mock', () => {
  let db, pc;
  beforeEach(() => { mock.reset(); offBox.length = 0; ({ db, pc } = makePc()); });
  afterEach(() => { pc.stop(); db.close(); });

  it('talks only to PCO_API_ORIGIN (lab override), never the real API', async () => {
    const types = await pc.getServiceTypes('c1');
    expect(offBox).toEqual([]);
    expect(types.map((t) => t.name)).toContain('Sunday Morning');
  });

  it('schedule sync keeps PCO wall-clock times (sort_date is org-local with a fake Z) whatever the server TZ', async () => {
    const oldTz = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      const r = await pc.syncChurch('c1');
      const times = r.services.map((s) => `${s.day}@${s.startHour}:${String(s.startMin).padStart(2, '0')}`).sort();
      expect(times).toEqual(['0@11:00', '0@9:00']);
    } finally {
      if (oldTz === undefined) delete process.env.TZ; else process.env.TZ = oldTz;
    }
  });

  it('revoked credentials fail the sync loudly (not "no upcoming services") and show in status', async () => {
    mock.revoke();
    await expect(pc.syncChurch('c1')).rejects.toThrow(/401|credentials|reconnect/i);
    const st = pc.getStatus('c1');
    expect(st.lastSyncError).toMatch(/401|credentials|reconnect/i);
    mock.unrevoke();
    await pc.syncChurch('c1');
    expect(pc.getStatus('c1').lastSyncError).toBeNull();
  });

  it('PCO down (503) fails the sync with the reason', async () => {
    mock.setMode({ mode: 'down' });
    await expect(pc.syncChurch('c1')).rejects.toThrow(/503|unavailable/i);
  });

  it('a 429 with Retry-After is waited out and retried once', async () => {
    mock.rateLimit({ count: 1, retryAfter: 1 });
    const t0 = Date.now();
    const types = await pc.getServiceTypes('c1');
    expect(types.length).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });

  it('production notes are written with the required plan_note_category (real PCO 422s without it)', async () => {
    const r = await pc.pushSessionRecap('c1', '9001', { grade: 'A', durationMinutes: 60 });
    expect(r).toMatchObject({ written: true, planId: '9001' });
    const notes = mock.state.notes['9001'];
    expect(notes.length).toBe(1);
    expect(notes[0].attributes.category_name).toBe('Production');
    expect(notes[0].attributes.content).toMatch(/Grade: A/);
  });

  it('service times + session notes also land in the Production category', async () => {
    const r1 = await pc.updateServiceTimes('c1', '9001', { actualStart: '2026-09-27T13:02:00Z', actualEnd: '2026-09-27T14:31:00Z' });
    expect(r1).toMatchObject({ updated: true });
    expect(mock.state.notes['9001'].at(-1).attributes.category_name).toBe('Production');
  });

  it('no "Production" note category → refused with instructions, nothing written', async () => {
    mock.setNoteCategories({ serviceTypeId: '1001', categories: [{ id: '502', name: 'Pastor' }] });
    const r = await pc.pushSessionRecap('c1', '9001', { grade: 'B' });
    expect(r.written).toBe(false);
    expect(r.reason).toMatch(/Production.*note category/i);
    expect(mock.state.notes['9001'] || []).toEqual([]);
  });

  it('read-only PCO user (403) → refused with the permission reason', async () => {
    mock.setWriteAllowed({ allowed: false });
    const r = await pc.pushSessionRecap('c1', '9001', { grade: 'B' });
    expect(r.written).toBe(false);
    expect(r.reason).toMatch(/403|permission/i);
  });

  it('deleted plan (404) → refused', async () => {
    mock.deletePlan({ planId: '9001' });
    const r = await pc.pushSessionRecap('c1', '9001', { grade: 'B' });
    expect(r.written).toBe(false);
    expect(r.reason).toMatch(/404|not found/i);
  });

  it('volunteer attendance uses the real PlanPerson route and exact names only', async () => {
    const r = await pc.syncVolunteerAttendance('c1', '9001', [
      { churchId: 'c1', name: 'Andrew Disbrow' },
      { churchId: 'c1', name: 'Al' }, // must NOT confirm "Alice Cooper"
    ]);
    expect(r).toMatchObject({ synced: true, matched: 1, total: 2 });
    const team = mock.state.plans['1001'][0].team;
    expect(team.find((t) => t.name === 'Andrew Disbrow').status).toBe('C');
    expect(team.find((t) => t.name === 'Alice Cooper').status).toBe('U');
  });

  it('"upcoming services" works for an OAuth-connected church (not only Personal Access Tokens)', async () => {
    db.prepare('UPDATE churches SET pc_app_id = NULL, pc_secret = NULL, pc_oauth_access_token = ?, pc_oauth_refresh_token = ?, pc_oauth_token_expires = ?, pc_oauth_connected_at = ? WHERE churchId = ?')
      .run('mock-access-token-1234', 'r', new Date(Date.now() + 3600e3).toISOString(), new Date().toISOString(), 'c1');
    const services = await pc.getUpcomingServicesForChurch('c1');
    expect(services.map((x) => x.startTime)).toEqual(['09:00', '11:00']);
  });

  it('"next service" stays the plan that starts in 30 min for a church west of UTC (sort_date is wall time)', async () => {
    db.prepare('UPDATE churches SET timezone = ? WHERE churchId = ?').run('America/Los_Angeles', 'c1');
    mock.setOrgTimezone({ tz: 'America/Los_Angeles' });
    const fmt = (ms) => {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date(Date.now() + ms)).map((x) => [x.type, x.value]));
      return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`;
    };
    mock.setPlans({ serviceTypeId: '1001', plans: [
      { id: 'soon', title: 'Starts in 30 min', sortDate: fmt(30 * 60e3), items: [], team: [], times: [] },
      { id: 'later', title: 'Next week', sortDate: fmt(7 * 86400e3), items: [], team: [], times: [] },
    ] });
    await pc.syncFullPlans('c1');
    expect(pc.getNextPlanCached('c1')?.title).toBe('Starts in 30 min');
  });

  it('same, in query-client mode (the production Postgres code path)', async () => {
    const { createQueryClient } = await import('../src/db/queryClient.js');
    const qdb = new Database(':memory:');
    qdb.exec(`CREATE TABLE churches (churchId TEXT PRIMARY KEY, name TEXT NOT NULL, service_times TEXT DEFAULT '[]', timezone TEXT DEFAULT '')`);
    qdb.prepare('INSERT INTO churches (churchId, name, timezone) VALUES (?, ?, ?)').run('q1', 'West Church', 'America/Los_Angeles');
    const qpc = new PlanningCenter(createQueryClient({ config: { driver: 'sqlite', isSqlite: true, isPostgres: false, databaseUrl: '' }, sqliteDb: qdb }));
    await qpc.ready;
    qpc.setCredentials('q1', { appId: 'lab-app-id', secret: 'lab-secret', serviceTypeId: '1001', syncEnabled: true });
    await qpc.flushWrites();
    const fmt = (ms) => {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date(Date.now() + ms)).map((x) => [x.type, x.value]));
      return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`;
    };
    mock.setOrgTimezone({ tz: 'America/Los_Angeles' });
    mock.setPlans({ serviceTypeId: '1001', plans: [
      { id: 'soon', title: 'Starts in 30 min', sortDate: fmt(30 * 60e3), items: [], team: [], times: [] },
      { id: 'later', title: 'Next week', sortDate: fmt(7 * 86400e3), items: [], team: [], times: [] },
    ] });
    await qpc.syncFullPlans('q1');
    await qpc.flushWrites();
    try {
      expect(qpc.getNextPlanCached('q1')?.title).toBe('Starts in 30 min');
    } finally { qpc.stop(); qdb.close(); }
  });

  it('Disconnect really disconnects a Personal-Access-Token connection too (and stops syncing)', async () => {
    expect(pc.getStatus('c1').connected).toBe(true);
    await pc.disconnect('c1');
    const st = pc.getStatus('c1');
    expect(st.connected).toBe(false);
    expect(st.syncEnabled).toBe(false);
  });

  it('PCO hanging does not hang the sync forever', async () => {
    mock.setMode({ mode: 'hang' });
    const t0 = Date.now();
    await expect(pc.syncChurch('c1')).rejects.toThrow(/timed out|timeout|abort/i);
    expect(Date.now() - t0).toBeLessThan(25000);
  }, 30000);
});
