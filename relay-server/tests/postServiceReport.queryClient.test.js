import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createQueryClient } from '../src/db/queryClient.js';
import PostServiceReport from '../src/postServiceReport.js';

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE alerts (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'WARNING',
      context TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      acknowledged_at TEXT,
      resolved INTEGER DEFAULT 0,
      session_id TEXT
    )
  `);
  return db;
}

function addAlert(db, id, churchId, alertType, createdAt, sessionId = null, resolved = 0) {
  db.prepare(`
    INSERT INTO alerts (id, church_id, alert_type, severity, context, created_at, resolved, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    churchId,
    alertType,
    'WARNING',
    '{}',
    createdAt,
    resolved,
    sessionId
  );
}

describe('PostServiceReport query client', () => {
  let db;
  let queryClient;
  let report;

  beforeEach(() => {
    db = createDb();
    queryClient = createQueryClient({
      config: { driver: 'sqlite', isSqlite: true, isPostgres: false, databaseUrl: '' },
      sqliteDb: db,
    });
    report = new PostServiceReport(queryClient);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await queryClient?.close();
    db?.close();
  });

  it('stores post-service reports through the shared query client', async () => {
    addAlert(db, 'alert-1', 'church-1', 'signal_loss', '2026-03-02T15:00:00.000Z', 'session-1', 1);
    addAlert(db, 'alert-2', 'church-1', 'audio_silence', '2026-03-02T15:05:00.000Z', 'session-1', 0);

    const created = await report.generate(
      { churchId: 'church-1', name: 'Grace Community', leadership_emails: 'leader@grace.church' },
      {
        sessionId: 'session-1',
        roomId: 'room-a',
        instanceName: 'Main Room',
        durationMinutes: 90,
        streamTotalMinutes: 84,
        grade: 'B+',
        autoRecovered: 1,
        escalated: 0,
        peakViewers: 180,
      }
    );

    const stored = await queryClient.queryOne('SELECT * FROM post_service_reports WHERE id = ?', [created.id]);
    expect(stored).not.toBeNull();
    expect(stored.church_id).toBe('church-1');
    expect(stored.session_id).toBe('session-1');
    expect(stored.room_id).toBe('room-a');
    expect(stored.instance_name).toBe('Main Room');
    expect(stored.failover_count).toBe(1);
    expect(stored.alert_count).toBe(2);
  });

  it('falls back to recent alerts when no session-specific rows exist', async () => {
    addAlert(db, 'alert-old', 'church-1', 'stream_offline', '2026-03-02T10:00:00.000Z', null, 0);
    const recentTimestamp = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    addAlert(db, 'alert-recent', 'church-1', 'network_failure', recentTimestamp, null, 0);

    const alerts = await report._getSessionAlerts('church-1', 'missing-session');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].id).toBe('alert-recent');
  });
});
