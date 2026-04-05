import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createQueryClient } from '../src/db/queryClient.js';
import { MonthlyReport } from '../src/monthlyReport.js';

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      billing_tier TEXT DEFAULT 'pro',
      portal_email TEXT,
      leadership_emails TEXT
    );

    CREATE TABLE service_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL,
      resolved INTEGER DEFAULT 0,
      auto_resolved INTEGER DEFAULT 0
    );

    CREATE TABLE alerts (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      escalated INTEGER DEFAULT 0
    );

    CREATE TABLE church_tds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL,
      telegram_chat_id TEXT,
      active INTEGER DEFAULT 1
    );
  `);

  db.prepare(`
    INSERT INTO churches (churchId, name, billing_tier, portal_email, leadership_emails)
    VALUES (?, ?, ?, ?, ?)
  `).run('church-1', 'Grace Community', 'pro', 'portal@grace.church', 'leader@grace.church');

  db.prepare(`
    INSERT INTO service_events (church_id, timestamp, event_type, resolved, auto_resolved)
    VALUES (?, ?, ?, ?, ?)
  `).run('church-1', '2026-02-05T10:00:00Z', 'audio_silence', 1, 1);

  db.prepare(`
    INSERT INTO service_events (church_id, timestamp, event_type, resolved, auto_resolved)
    VALUES (?, ?, ?, ?, ?)
  `).run('church-1', '2026-02-12T10:00:00Z', 'stream_stopped', 0, 0);

  db.prepare(`
    INSERT INTO alerts (id, church_id, created_at, escalated)
    VALUES (?, ?, ?, ?)
  `).run('alert-1', 'church-1', '2026-02-12T10:05:00Z', 1);

  db.prepare(`
    INSERT INTO church_tds (church_id, telegram_chat_id, active)
    VALUES (?, ?, 1)
  `).run('church-1', 'td-chat');

  return db;
}

describe('MonthlyReport', () => {
  let db;
  let queryClient;
  let report;

  beforeEach(() => {
    db = createDb();
    queryClient = createQueryClient({
      config: { driver: 'sqlite', isSqlite: true, isPostgres: false, databaseUrl: '' },
      sqliteDb: db,
    });
    report = new MonthlyReport({ db: queryClient, defaultBotToken: 'bot-token', adminChatId: 'admin-chat' });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await queryClient?.close();
    db?.close();
  });

  it('generates monthly report data through the query client', async () => {
    const generated = await report.generateReport('church-1', '2026-02');
    expect(generated.month).toBe('2026-02');
    expect(generated.text).toContain('Grace Community');
    expect(generated.text).toContain('Services monitored: 2');
    expect(generated.text).toContain('Alerts triggered: 1');
    expect(generated.text).toContain('Auto-recovered: 1');
  });

  it('sends telegram and lifecycle email deliveries through the query client', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const sendMonthlyReportEmail = vi.fn().mockResolvedValue({ sent: true });
    report.setLifecycleEmails({ sendMonthlyReportEmail });

    await report._sendReport('church-1', '2026-02');

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(sendMonthlyReportEmail).toHaveBeenCalledTimes(2);
  });
});
