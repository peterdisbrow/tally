import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SessionRecap } from '../src/sessionRecap.js';
import { createQueryClient } from '../src/db/queryClient.js';

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      room_id TEXT,
      billing_tier TEXT DEFAULT 'connect',
      alert_bot_token TEXT,
      td_telegram_chat_id TEXT,
      leadership_emails TEXT,
      engineer_profile TEXT DEFAULT '{}'
    )
  `);

  db.prepare(`
    INSERT INTO churches (churchId, name, room_id, billing_tier, alert_bot_token, td_telegram_chat_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('church-1', 'Grace Community', 'room-main', 'connect', 'bot-token', 'td-chat');

  return db;
}

describe('SessionRecap', () => {
  let db;
  let queryClient;
  let recap;

  beforeEach(async () => {
    db = createDb();
    queryClient = createQueryClient({
      config: { driver: 'sqlite', isSqlite: true, isPostgres: false, databaseUrl: '' },
      sqliteDb: db,
    });
    recap = new SessionRecap(queryClient);
    await recap.ready;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await queryClient?.close();
    db?.close();
  });

  it('supports query-client session lifecycle updates', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '' }));

    recap.setRoomResolver(() => 'room-main');

    await recap.startSession('church-1', 'Taylor', 'main-instance');
    expect(recap.getActiveSessionId('church-1', 'main-instance')).toBeTruthy();

    await recap.recordAlert('church-1', 'audio_silence', true, false, 'main-instance');
    await recap.recordAudioSilence('church-1', 'main-instance');
    await recap.recordStreamStatus('church-1', true, 'main-instance');
    await recap.recordPeakViewers('church-1', 42, 'main-instance');
    await recap.recordRecordingConfirmed('church-1', 'main-instance');

    const ended = await recap.endSession('church-1', 'main-instance');
    expect(ended).toBeTruthy();
    expect(global.fetch).toHaveBeenCalledOnce();

    const row = db.prepare(`
      SELECT ended_at, alert_count, auto_recovered_count, audio_silence_count,
             peak_viewers, recording_confirmed, instance_name, room_id
      FROM service_sessions
      WHERE id = ?
    `).get(ended.sessionId);

    expect(row.ended_at).toBeTruthy();
    expect(row.alert_count).toBe(1);
    expect(row.auto_recovered_count).toBe(1);
    expect(row.audio_silence_count).toBe(1);
    expect(row.peak_viewers).toBe(42);
    expect(row.recording_confirmed).toBe(1);
    expect(row.instance_name).toBe('main-instance');
    expect(row.room_id).toBe('room-main');
  });

  it('recovers active sessions through the query client', async () => {
    const startedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO service_sessions (id, church_id, started_at, td_name, instance_name, room_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('sess-recover', 'church-1', startedAt, 'Taylor', 'main-instance', 'room-main');

    recap.activeSessions.clear();
    await recap.recoverActiveSessions();

    expect(recap.getActiveSessionId('church-1', 'main-instance')).toBe('sess-recover');
  });
});
