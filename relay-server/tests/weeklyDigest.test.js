import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import { createQueryClient } from '../src/db/queryClient.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { WeeklyDigest } = require('../src/weeklyDigest');

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      billing_tier TEXT DEFAULT 'pro',
      leadership_emails TEXT,
      portal_email TEXT
    );

    CREATE TABLE service_sessions (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      duration_minutes INTEGER DEFAULT 0,
      grade TEXT,
      instance_name TEXT
    );

    CREATE TABLE church_tds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL,
      telegram_chat_id TEXT,
      active INTEGER DEFAULT 1
    );
  `);

  db.prepare(
    'INSERT INTO churches (churchId, name, billing_tier, leadership_emails, portal_email) VALUES (?, ?, ?, ?, ?)'
  ).run('church-1', 'Grace Community', 'pro', 'leader@grace.church', null);

  db.prepare(
    'INSERT INTO service_sessions (id, church_id, started_at, duration_minutes, grade) VALUES (?, ?, ?, ?, ?)'
  ).run('session-1', 'church-1', new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), 90, 'A');

  db.prepare(
    'INSERT INTO church_tds (church_id, telegram_chat_id, active) VALUES (?, ?, 1)'
  ).run('church-1', 'td-chat-1');

  return db;
}

describe('WeeklyDigest', () => {
  let db;
  let queryClient;
  let digest;

  beforeEach(async () => {
    db = createDb();
    queryClient = createQueryClient({
      config: { driver: 'sqlite', isSqlite: true, isPostgres: false, databaseUrl: '' },
      sqliteDb: db,
    });
    digest = new WeeklyDigest(queryClient);
    await digest.ready;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await queryClient?.close();
    db?.close();
  });

  it('supports query-client event writes and digest reads', async () => {
    const eventId = await digest.addEvent('church-1', 'audio_silence', 'Stream muted unexpectedly');
    expect(eventId).toBeTruthy();

    await digest.resolveEvent(eventId, true);

    const coaching = await digest.getChurchDigest('church-1');
    expect(coaching.totalEvents).toBe(1);
    expect(coaching.autoResolved).toBe(1);
    expect(coaching.reliability).toBe(100);

    const markdown = await digest.generateDigest();
    expect(markdown).toContain('Grace Community');
    expect(markdown).toContain('audio silence');
  });

  it('sends per-church digests through the query client path', async () => {
    await digest.addEvent('church-1', 'audio_silence', 'Stream muted unexpectedly');
    digest.setNotificationConfig('test-bot-token');
    digest.churchMemory = { writeWeeklyMemories: vi.fn().mockResolvedValue(undefined) };
    digest.setLifecycleEmails({
      sendWeeklyDigestEmail: vi.fn().mockResolvedValue({ sent: true }),
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

    await digest.sendChurchDigests();

    expect(global.fetch).toHaveBeenCalledOnce();
    expect(digest.churchMemory.writeWeeklyMemories).toHaveBeenCalledOnce();
    expect(digest.lifecycleEmails.sendWeeklyDigestEmail).toHaveBeenCalledOnce();
    expect(digest.lifecycleEmails.sendWeeklyDigestEmail.mock.calls[0][2]).toBe('leader@grace.church');
    expect(digest.lifecycleEmails.sendWeeklyDigestEmail.mock.calls[0][1].weekId).toMatch(/^\d{4}-W\d{2}$/);
  });

  it('emails portal_email when a church has no leadership list (P1-10)', async () => {
    db.prepare(
      'INSERT INTO churches (churchId, name, billing_tier, leadership_emails, portal_email) VALUES (?, ?, ?, ?, ?)'
    ).run('church-portal-only', 'Portal Only', 'pro', null, 'pastor@portal.church');

    digest.setLifecycleEmails({
      sendWeeklyDigestEmail: vi.fn().mockResolvedValue({ sent: true }),
    });

    await digest.sendChurchDigests();

    const recipients = digest.lifecycleEmails.sendWeeklyDigestEmail.mock.calls.map((call) => call[2]).sort();
    expect(recipients).toEqual(['leader@grace.church', 'pastor@portal.church']);
  });

  it('emails unique union of portal_email and leadership_emails', async () => {
    db.prepare(
      'UPDATE churches SET portal_email = ?, leadership_emails = ? WHERE churchId = ?'
    ).run('pastor@grace.church', 'leader@grace.church, PASTOR@grace.church', 'church-1');

    digest.setLifecycleEmails({
      sendWeeklyDigestEmail: vi.fn().mockResolvedValue({ sent: true }),
    });

    await digest.sendChurchDigests();

    const recipients = digest.lifecycleEmails.sendWeeklyDigestEmail.mock.calls.map((call) => call[2]).sort();
    expect(recipients).toEqual(['leader@grace.church', 'pastor@grace.church']);
  });

  it('sends digest email even when no Telegram bot token is set', async () => {
    digest.setLifecycleEmails({
      sendWeeklyDigestEmail: vi.fn().mockResolvedValue({ sent: true }),
    });

    await digest.sendChurchDigests();

    expect(digest.lifecycleEmails.sendWeeklyDigestEmail).toHaveBeenCalledOnce();
    expect(digest.lifecycleEmails.sendWeeklyDigestEmail.mock.calls[0][2]).toBe('leader@grace.church');
  });
});
