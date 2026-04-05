import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import { createQueryClient } from '../src/db/queryClient.js';

const require = createRequire(import.meta.url);
const { PlanningCenter } = require('../src/planningCenter');
const { ScheduleEngine } = require('../src/scheduleEngine');

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
      service_times TEXT DEFAULT '[]',
      timezone TEXT DEFAULT '',
      church_type TEXT DEFAULT '',
      event_expires_at TEXT
    )
  `);
  db.prepare('INSERT INTO churches (churchId, name) VALUES (?, ?)').run('church-1', 'Grace Church');
  return db;
}

function makePlansResponse(plans) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: plans }),
    text: async () => JSON.stringify({ data: plans }),
  };
}

describe('PlanningCenter query client mode', () => {
  let db;
  let queryClient;
  let planningCenter;
  let scheduleEngine;

  beforeEach(async () => {
    db = createDb();
    queryClient = createQueryClient({ config: SQLITE_CONFIG, sqliteDb: db });
    planningCenter = new PlanningCenter(queryClient);
    scheduleEngine = new ScheduleEngine(queryClient);
    await Promise.all([planningCenter.ready, scheduleEngine.ready]);
    planningCenter.setScheduleEngine(scheduleEngine);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    planningCenter?.stop();
    scheduleEngine?.stop?.();
    await queryClient?.close();
    db?.close();
  });

  it('persists credentials through the shared query client and updates status from cache', async () => {
    planningCenter.setCredentials('church-1', {
      appId: 'app-123',
      secret: 'secret-456',
      serviceTypeIds: ['stype-1', 'stype-2'],
      syncEnabled: true,
      writebackEnabled: true,
    });
    await planningCenter.flushWrites();

    const row = db.prepare(`
      SELECT pc_app_id, pc_secret, pc_service_type_ids, pc_sync_enabled, pc_writeback_enabled
      FROM churches
      WHERE churchId = ?
    `).get('church-1');
    const status = planningCenter.getStatus('church-1');

    expect(row).toMatchObject({
      pc_app_id: 'app-123',
      pc_secret: 'secret-456',
      pc_service_type_ids: JSON.stringify(['stype-1', 'stype-2']),
      pc_sync_enabled: 1,
      pc_writeback_enabled: 1,
    });
    expect(status.authType).toBe('pat');
    expect(status.syncEnabled).toBe(true);
    expect(status.writebackEnabled).toBe(true);
    expect(status.serviceTypeIds).toEqual(['stype-1', 'stype-2']);
  });

  it('syncs schedules through the query-client path and updates cached status fields', async () => {
    planningCenter.setCredentials('church-1', {
      appId: 'app-123',
      secret: 'secret-456',
      serviceTypeId: 'stype-1',
      syncEnabled: true,
    });
    await planningCenter.flushWrites();

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(10, 0, 0, 0);

    vi.stubGlobal('fetch', vi.fn(async () => makePlansResponse([
      {
        id: 'plan-1',
        type: 'Plan',
        attributes: {
          sort_date: tomorrow.toISOString(),
          title: 'Sunday Service',
        },
      },
    ])));

    const result = await planningCenter.syncChurch('church-1');
    const stored = db.prepare('SELECT service_times, pc_last_synced FROM churches WHERE churchId = ?').get('church-1');
    const schedule = scheduleEngine.getSchedule('church-1');
    const status = planningCenter.getStatus('church-1');

    expect(result.synced).toBe(1);
    expect(schedule).toHaveLength(1);
    expect(schedule[0]).toMatchObject({
      day: tomorrow.getDay(),
      startHour: 10,
      startMin: 0,
      source: 'planning_center',
    });
    expect(JSON.parse(stored.service_times)).toHaveLength(1);
    expect(stored.pc_last_synced).toBeTruthy();
    expect(status.lastSynced).toBe(stored.pc_last_synced);
  });

  it('disconnect clears cached plans and oauth status through the shared query client', async () => {
    await queryClient.run(`
      UPDATE churches
      SET pc_oauth_access_token = ?, pc_oauth_refresh_token = ?, pc_oauth_token_expires = ?, pc_oauth_connected_at = ?, pc_oauth_org_name = ?, pc_sync_enabled = 1
      WHERE churchId = ?
    `, ['access', 'refresh', new Date(Date.now() + 3600000).toISOString(), new Date().toISOString(), 'Grace Org', 'church-1']);
    await queryClient.run(`
      INSERT INTO pc_plans (id, church_id, service_type_id, title, sort_date, items_json, team_json, times_json, notes_json, last_fetched, pco_updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, ['plan-1', 'church-1', 'stype-1', 'Sunday Service', new Date().toISOString(), '[]', '[]', '[]', '[]', new Date().toISOString(), new Date().toISOString()]);
    await planningCenter._loadCache();

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));

    const result = await planningCenter.disconnect('church-1');
    const row = db.prepare(`
      SELECT pc_oauth_access_token, pc_oauth_refresh_token, pc_oauth_connected_at, pc_oauth_org_name
      FROM churches
      WHERE churchId = ?
    `).get('church-1');

    expect(result).toEqual({ disconnected: true });
    expect(row.pc_oauth_access_token).toBeNull();
    expect(row.pc_oauth_refresh_token).toBeNull();
    expect(row.pc_oauth_connected_at).toBeNull();
    expect(row.pc_oauth_org_name).toBeNull();
    expect(planningCenter.getCachedPlan('plan-1')).toBeNull();
    expect(planningCenter.getStatus('church-1').connected).toBe(false);
  });
});
