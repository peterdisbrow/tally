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
      leadership_emails TEXT
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
    'INSERT INTO churches (churchId, name, billing_tier, leadership_emails) VALUES (?, ?, ?, ?)'
  ).run('church-1', 'Grace Community', 'pro', 'leader@grace.church');

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
  });
});
