import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createQueryClient } from '../src/db/queryClient.js';
import { AITriageEngine, AI_MODES, TIME_CONTEXT } from '../src/aiTriage.js';

const SQLITE_CONFIG = {
  driver: 'sqlite',
  isSqlite: true,
  isPostgres: false,
  databaseUrl: '',
};

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      timezone TEXT DEFAULT '',
      service_times TEXT DEFAULT '[]',
      church_type TEXT DEFAULT 'recurring',
      event_expires_at TEXT
    );
    CREATE TABLE service_sessions (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      grade TEXT
    );
    CREATE TABLE support_tickets (
      id TEXT PRIMARY KEY,
      church_id TEXT,
      triage_id TEXT,
      issue_category TEXT,
      severity TEXT,
      title TEXT,
      description TEXT,
      status TEXT,
      forced_bypass INTEGER DEFAULT 0,
      diagnostics_json TEXT DEFAULT '{}',
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE support_ticket_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT,
      message TEXT,
      actor_type TEXT,
      actor_id TEXT,
      created_at TEXT
    );
  `);
  return db;
}

function addChurch(db, churchId, opts = {}) {
  db.prepare(`
    INSERT INTO churches (churchId, name, timezone, service_times, church_type, event_expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    churchId,
    opts.name || 'Test Church',
    opts.timezone !== undefined ? opts.timezone : 'America/Chicago',
    JSON.stringify(opts.serviceTimes || []),
    opts.churchType || 'recurring',
    opts.eventExpiresAt || null,
  );
}

function createMockScheduleEngine(db) {
  return {
    getSchedule(churchId) {
      const row = db.prepare('SELECT service_times FROM churches WHERE churchId = ?').get(churchId);
      if (!row?.service_times) return [];
      try { return JSON.parse(row.service_times); } catch { return []; }
    },
    isServiceWindow() { return false; },
  };
}

function createQueryEngine(db, opts = {}) {
  const queryClient = createQueryClient({ config: SQLITE_CONFIG, sqliteDb: db });
  const engine = new AITriageEngine(queryClient, opts.scheduleEngine || createMockScheduleEngine(db), {
    churches: opts.churches || new Map(),
    autoRecovery: opts.autoRecovery || null,
    broadcastToSSE: opts.broadcastToSSE || vi.fn(),
    createTicket: opts.createTicket || null,
  });
  return { engine, queryClient };
}

describe('AITriageEngine query client mode', () => {
  let db;
  let queryClient;
  let engine;

  beforeEach(async () => {
    db = createTestDb();
    addChurch(db, 'c1', { name: 'Alpha Church', serviceTimes: [] });
    addChurch(db, 'c2', { name: 'Beta Church', serviceTimes: [] });
    db.prepare(`
      INSERT INTO service_sessions (id, church_id, started_at, ended_at, grade)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      's1',
      'c1',
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString(),
      'A',
    );
    db.prepare(`
      INSERT INTO service_sessions (id, church_id, started_at, ended_at, grade)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      's2',
      'c1',
      new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
      new Date(Date.now() - 14 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString(),
      'A',
    );
    db.prepare(`
      INSERT INTO service_sessions (id, church_id, started_at, ended_at, grade)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      's3',
      'c1',
      new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString(),
      new Date(Date.now() - 21 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString(),
      'A',
    );

    const churches = new Map();
    churches.set('c1', { churchId: 'c1', status: {}, sockets: new Map() });
    churches.set('c2', { churchId: 'c2', status: {}, sockets: new Map() });

    const result = createQueryEngine(db, { churches });
    engine = result.engine;
    queryClient = result.queryClient;
    await engine.ready;
  });

  afterEach(async () => {
    if (engine?.flushWrites) {
      await engine.flushWrites().catch(() => {});
    }
    await queryClient?.close();
    db?.close();
    engine = null;
    queryClient = null;
    db = null;
  });

  it('keeps settings reads sync-shaped and flushes updates later', async () => {
    const defaults = engine.getChurchSettings('c1');
    expect(defaults).toMatchObject({
      church_id: 'c1',
      ai_mode: AI_MODES.RECOMMEND_ONLY,
      sensitivity_threshold: 50,
    });
    expect(defaults.then).toBeUndefined();

    const updated = engine.updateChurchSettings('c1', {
      ai_mode: 'monitor_only',
      sensitivity_threshold: 80,
      pre_service_window_minutes: 45,
      custom_settings: { notes: 'hybrid mode' },
    }, 'admin@example.com');

    expect(updated).toMatchObject({
      church_id: 'c1',
      ai_mode: 'monitor_only',
      sensitivity_threshold: 80,
      pre_service_window_minutes: 45,
      updated_by: 'admin@example.com',
    });
    expect(engine.getChurchSettings('c1')).toMatchObject({
      ai_mode: 'monitor_only',
      custom_settings: { notes: 'hybrid mode' },
    });

    await engine.flushWrites();

    const persisted = db.prepare('SELECT * FROM church_ai_settings WHERE church_id = ?').get('c1');
    expect(persisted).toMatchObject({
      church_id: 'c1',
      ai_mode: 'monitor_only',
      sensitivity_threshold: 80,
      pre_service_window_minutes: 45,
      updated_by: 'admin@example.com',
    });
  });

  it('records triage events through the cache and keeps recent reads sync-shaped', async () => {
    engine.updateChurchSettings('c1', { ai_mode: 'monitor_only' });

    const result = await engine.processAlert('c1', 'stream_stopped', 'CRITICAL', { message: 'stream dropped' });
    expect(result.action).toBe('monitored');
    expect(result.eventId).toBeTruthy();

    const events = engine.getRecentEvents({ churchId: 'c1' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      church_id: 'c1',
      alert_type: 'stream_stopped',
    });
    expect(events[0].details).toMatchObject({
      message: 'stream dropped',
    });

    const stats = engine.getStats({ churchId: 'c1' });
    expect(stats.total_events).toBe(1);
    expect(Array.isArray(stats.top_alert_types)).toBe(true);
    expect(Array.isArray(stats.daily_trend)).toBe(true);

    await engine.flushWrites();

    const persisted = db.prepare('SELECT * FROM ai_triage_events WHERE id = ?').get(result.eventId);
    expect(persisted).toMatchObject({
      id: result.eventId,
      church_id: 'c1',
      alert_type: 'stream_stopped',
    });
  });

  it('hydrates time context and church mode views from cached rows', async () => {
    const ctx = engine.getTimeContext('c1');
    expect(ctx.context).toBe(TIME_CONTEXT.IN_SERVICE);
    expect(ctx.details.reason).toBe('inferred_from_history');

    engine.updateChurchSettings('c1', { ai_mode: 'full_auto' }, 'admin@example.com');
    const modes = engine.getAllChurchModes();
    expect(modes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          church_id: 'c1',
          ai_mode: 'full_auto',
          church_name: 'Alpha Church',
        }),
      ]),
    );
  });

  it('cleans up old events through the async client path', async () => {
    db.prepare(`
      INSERT INTO ai_triage_events (id, church_id, alert_type, original_severity, triage_score, triage_severity, time_context, created_at)
      VALUES ('old1', 'c1', 'test', 'WARNING', 50, 'medium', 'off_hours', datetime('now', '-100 days'))
    `).run();
    db.prepare(`
      INSERT INTO ai_triage_events (id, church_id, alert_type, original_severity, triage_score, triage_severity, time_context, created_at)
      VALUES ('new1', 'c1', 'test', 'WARNING', 50, 'medium', 'off_hours', datetime('now'))
    `).run();

    await engine.ready;
    engine.cleanup(90);
    await engine.flushWrites();

    const remaining = db.prepare('SELECT COUNT(*) as cnt FROM ai_triage_events').get();
    expect(remaining.cnt).toBe(1);
  });
});
