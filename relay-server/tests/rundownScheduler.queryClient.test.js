import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import { createQueryClient } from '../src/db/queryClient.js';

const require = createRequire(import.meta.url);
const { RundownEngine } = require('../src/rundownEngine');
const { RundownScheduler } = require('../src/scheduler');

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
      email TEXT,
      token TEXT,
      registeredAt TEXT NOT NULL,
      billing_tier TEXT DEFAULT 'connect',
      billing_status TEXT DEFAULT 'inactive'
    )
  `);
  db.prepare(`
    INSERT INTO churches (churchId, name, email, token, registeredAt, billing_tier, billing_status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'church-1',
    'Grace Church',
    'church-1@test.local',
    'tok-church-1',
    new Date().toISOString(),
    'pro',
    'active',
  );
  return db;
}

describe('RundownScheduler query client mode', () => {
  let db;
  let queryClient;
  let rundownEngine;
  let scheduler;
  let billing;

  beforeEach(async () => {
    db = createDb();
    queryClient = createQueryClient({ config: SQLITE_CONFIG, sqliteDb: db });
    rundownEngine = new RundownEngine(queryClient);
    billing = {
      checkAccess: vi.fn(() => ({ allowed: true })),
    };
    scheduler = new RundownScheduler(queryClient, {
      rundownEngine,
      scheduleEngine: {},
      billing,
    });
    await Promise.all([rundownEngine.ready, scheduler.ready]);
  });

  afterEach(async () => {
    scheduler?.stop();
    await rundownEngine?.flushWrites?.();
    await queryClient?.close();
    db?.close();
    vi.restoreAllMocks();
  });

  it('checks scheduler auto-trigger access through the shared query client', async () => {
    const rundown = rundownEngine.createRundown('church-1', 'Auto Rundown', [
      { label: 'Cue 1', commands: [] },
    ]);
    rundownEngine.setSchedulerConfig(rundown.id, {
      autoActivate: true,
      serviceDay: new Date().getDay(),
    });
    await rundownEngine.flushWrites();

    await scheduler.onServiceWindowOpen('church-1');

    expect(billing.checkAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        churchId: 'church-1',
        billing_tier: 'pro',
        billing_status: 'active',
      }),
      'scheduler_auto',
    );
    expect(scheduler.getStatus('church-1')).toMatchObject({
      active: true,
      rundownName: 'Auto Rundown',
    });
  });

  it('evaluates time triggers without relying on raw sqlite reads', async () => {
    const fireSpy = vi.spyOn(scheduler, '_fireCue').mockResolvedValue({ cueIndex: 0, source: 'time_relative' });
    const rundown = rundownEngine.createRundown('church-1', 'Timed Rundown', [
      {
        label: 'Cue 1',
        trigger: { type: 'time_relative', offsetMinutes: 0 },
        commands: [],
      },
    ]);
    rundownEngine.activateRundownForScheduler('church-1', rundown.id, new Date().toISOString());
    await rundownEngine.flushWrites();

    await scheduler._tick();

    expect(fireSpy).toHaveBeenCalledWith('church-1', 0, 'time_relative');
  });
});
