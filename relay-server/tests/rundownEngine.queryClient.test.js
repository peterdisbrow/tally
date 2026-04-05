import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { RundownEngine } from '../src/rundownEngine.js';
import { createQueryClient } from '../src/db/queryClient.js';

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
    .run('ch1', 'Test Church', new Date().toISOString());
  return db;
}

describe('RundownEngine query client mode', () => {
  let db;
  let queryClient;
  let engine;

  beforeEach(async () => {
    db = createDb();
    queryClient = createQueryClient({ config: SQLITE_CONFIG, sqliteDb: db });
    engine = new RundownEngine(queryClient);
    await engine.ready;
  });

  afterEach(async () => {
    await queryClient?.close();
    db?.close();
  });

  it('creates rundowns, updates scheduler metadata, and persists through flushWrites', async () => {
    const created = engine.createRundown('ch1', 'Sunday Service', [{ label: 'Welcome' }], { instanceName: 'main' });
    engine.setSchedulerConfig(created.id, { serviceDay: 0, autoActivate: true });

    expect(engine.getRundown(created.id)).toMatchObject({
      id: created.id,
      church_id: 'ch1',
      instance_name: 'main',
      service_day: 0,
      auto_activate: 1,
    });

    await engine.flushWrites();

    const row = db.prepare(
      'SELECT church_id, instance_name, service_day, auto_activate FROM rundowns WHERE id = ?'
    ).get(created.id);
    expect(row).toEqual({
      church_id: 'ch1',
      instance_name: 'main',
      service_day: 0,
      auto_activate: 1,
    });
  });

  it('tracks active rundown state from cache and persists scheduler updates', async () => {
    const created = engine.createRundown('ch1', 'Live Service', [{ label: 'A' }, { label: 'B' }]);
    await engine.flushWrites();

    const active = engine.activateRundownForScheduler('ch1', created.id, '2026-04-05T10:00:00.000Z');
    engine.updateActiveState('ch1', {
      currentStep: 1,
      state: 'paused',
      lastCueFiredAt: '2026-04-05T10:05:00.000Z',
      cuesFired: ['cue-1'],
    });

    const current = engine.getActiveRundownFull('ch1');
    expect(active.rundownId).toBe(created.id);
    expect(current).toMatchObject({
      churchId: 'ch1',
      currentStep: 1,
      state: 'paused',
      cuesFired: ['cue-1'],
    });

    await engine.flushWrites();

    const row = db.prepare(
      'SELECT current_step, state, last_cue_fired_at, cues_fired FROM active_rundowns WHERE church_id = ?'
    ).get('ch1');
    expect(row.current_step).toBe(1);
    expect(row.state).toBe('paused');
    expect(row.last_cue_fired_at).toBe('2026-04-05T10:05:00.000Z');
    expect(JSON.parse(row.cues_fired)).toEqual(['cue-1']);
  });
});
