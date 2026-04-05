import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import { createQueryClient } from '../src/db/queryClient.js';

const require = createRequire(import.meta.url);
const { ScheduleEngine } = require('../src/scheduleEngine');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      service_times TEXT DEFAULT '[]',
      timezone TEXT,
      church_type TEXT,
      event_expires_at TEXT
    )
  `);
  return db;
}

describe('ScheduleEngine query client', () => {
  let db;
  let queryClient;
  let engine;

  beforeEach(async () => {
    db = createDb();
    db.prepare(`
      INSERT INTO churches (churchId, name, service_times, timezone, church_type, event_expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'church-1',
      'Grace Community',
      JSON.stringify([{ day: 0, startHour: 9, startMin: 30, durationHours: 2 }]),
      'America/New_York',
      'standard',
      null
    );
    db.prepare(`
      INSERT INTO churches (churchId, name, service_times, timezone, church_type, event_expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'event-1',
      'Conference Campus',
      '[]',
      'America/New_York',
      'event',
      new Date(Date.now() + 60 * 60 * 1000).toISOString()
    );

    queryClient = createQueryClient({
      config: { driver: 'sqlite', isSqlite: true, isPostgres: false, databaseUrl: '' },
      sqliteDb: db,
    });
    engine = new ScheduleEngine(queryClient);
    await engine.ready;
  });

  afterEach(async () => {
    if (engine?._pollTimer) clearInterval(engine._pollTimer);
    await queryClient?.close();
    db?.close();
  });

  it('hydrates schedules from the shared query client cache', () => {
    expect(engine.getSchedule('church-1')).toEqual([
      { day: 0, startHour: 9, startMin: 30, durationHours: 2 },
    ]);
  });

  it('treats active event churches as in-window from cached church metadata', () => {
    expect(engine.isServiceWindow('event-1')).toBe(true);
  });

  it('updates cache and persisted schedule through setSchedule', async () => {
    const nextSchedule = [
      { day: 2, startHour: 19, startMin: 0, durationHours: 1.5 },
    ];

    await engine.setSchedule('church-1', nextSchedule);

    expect(engine.getSchedule('church-1')).toEqual(nextSchedule);
    const stored = db.prepare('SELECT service_times FROM churches WHERE churchId = ?').get('church-1');
    expect(JSON.parse(stored.service_times)).toEqual(nextSchedule);
  });
});
