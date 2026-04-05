import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createQueryClient } from '../src/db/queryClient.js';
import { AutoRecovery } from '../src/autoRecovery.js';

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      auto_recovery_enabled INTEGER DEFAULT 1,
      recovery_outside_service_hours INTEGER DEFAULT 1
    )
  `);
  return db;
}

function makeChurch(churchId = 'church-1') {
  return {
    churchId,
    sockets: new Map(),
  };
}

describe('AutoRecovery query client', () => {
  let db;
  let queryClient;

  beforeEach(() => {
    db = createDb();
    queryClient = createQueryClient({
      config: { driver: 'sqlite', isSqlite: true, isPostgres: false, databaseUrl: '' },
      sqliteDb: db,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await queryClient?.close();
    db?.close();
  });

  it('respects disabled auto-recovery from the shared query client', async () => {
    db.prepare(`
      INSERT INTO churches (churchId, name, auto_recovery_enabled, recovery_outside_service_hours)
      VALUES (?, ?, ?, ?)
    `).run('church-1', 'Grace Community', 0, 1);

    const recovery = new AutoRecovery(new Map(), {}, queryClient);
    recovery.dispatchCommand = vi.fn();

    const result = await recovery.attempt(makeChurch('church-1'), 'stream_stopped', {});
    expect(result.attempted).toBe(false);
    expect(result.reason).toBe('auto_recovery_disabled');
    expect(recovery.dispatchCommand).not.toHaveBeenCalled();
  });

  it('blocks recovery outside service hours when the church has not opted in', async () => {
    db.prepare(`
      INSERT INTO churches (churchId, name, auto_recovery_enabled, recovery_outside_service_hours)
      VALUES (?, ?, ?, ?)
    `).run('church-2', 'North Campus', 1, 0);

    const scheduleEngine = { isServiceWindow: vi.fn().mockReturnValue(false) };
    const recovery = new AutoRecovery(new Map(), {}, queryClient, { scheduleEngine });
    recovery.dispatchCommand = vi.fn();

    const result = await recovery.attempt(makeChurch('church-2'), 'stream_stopped', {});
    expect(result.attempted).toBe(false);
    expect(result.reason).toBe('outside_service_hours');
    expect(recovery.dispatchCommand).not.toHaveBeenCalled();
  });
});
