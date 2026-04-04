import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { AlertEngine, CRITICAL_BYPASS_TYPES, DEFAULT_DEDUP_WINDOW_MS } from '../src/alertEngine.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      td_telegram_chat_id TEXT DEFAULT '',
      td_name TEXT DEFAULT '',
      alert_bot_token TEXT DEFAULT '',
      slack_webhook_url TEXT DEFAULT ''
    )
  `);
  return db;
}

function makeChurch(id = 'church-1', overrides = {}) {
  return {
    churchId: id,
    name: 'Test Church',
    td_telegram_chat_id: '12345',
    alert_bot_token: 'test-bot-token',
    ...overrides,
  };
}

function createEngine(db, opts = {}) {
  const scheduleEngine = opts.scheduleEngine || { isServiceWindow: () => true };
  return new AlertEngine(db, scheduleEngine, {
    defaultBotToken: 'default-bot-token',
    ...opts,
  });
}

// ─── A. Basic deduplication ──────────────────────────────────────────────────

describe('Alert deduplication', () => {
  let db, engine;

  beforeEach(() => {
    vi.useFakeTimers();
    db = createTestDb();
    engine = createEngine(db);
    // Stub Telegram so we don't make real HTTP calls
    engine.sendTelegramMessage = vi.fn().mockResolvedValue(undefined);
    engine.sendSlackAlert = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Clean up all dedup timers
    engine.clearDedupState('church-1');
    engine.clearDedupState('church-2');
    vi.useRealTimers();
    db?.close();
  });

  // ─── A1. Basic dedup: 3 same alerts → 1 immediate + 1 batched summary ────
  describe('basic dedup behavior', () => {
    it('first alert sends immediately', async () => {
      const church = makeChurch();
      const result = await engine.sendAlert(church, 'audio_silence', { level: -60 });
      expect(result.action).toBe('notified');
      expect(engine.sendTelegramMessage).toHaveBeenCalledTimes(1);
    });

    it('subsequent same alerts within window are deduplicated', async () => {
      const church = makeChurch();
      await engine.sendAlert(church, 'audio_silence', {});
      engine.sendTelegramMessage.mockClear();

      const r2 = await engine.sendAlert(church, 'audio_silence', {});
      const r3 = await engine.sendAlert(church, 'audio_silence', {});
      expect(r2.action).toBe('deduplicated');
      expect(r3.action).toBe('deduplicated');
      expect(engine.sendTelegramMessage).not.toHaveBeenCalled();
    });

    it('sends batched summary after window expires with count > 1', async () => {
      const church = makeChurch();
      await engine.sendAlert(church, 'audio_silence', {});
      engine.sendTelegramMessage.mockClear();

      await engine.sendAlert(church, 'audio_silence', {});
      await engine.sendAlert(church, 'audio_silence', {});

      // Advance past the 5-minute window
      await vi.advanceTimersByTimeAsync(DEFAULT_DEDUP_WINDOW_MS + 100);

      expect(engine.sendTelegramMessage).toHaveBeenCalledTimes(1);
      const summaryMsg = engine.sendTelegramMessage.mock.calls[0][2];
      expect(summaryMsg).toContain('3 occurrences');
      expect(summaryMsg).toContain('audio silence');
      expect(summaryMsg).toContain('5 min');
    });

    it('does not send summary when only 1 occurrence in window', async () => {
      const church = makeChurch();
      await engine.sendAlert(church, 'audio_silence', {});
      engine.sendTelegramMessage.mockClear();

      // Advance past window — count is 1, no summary needed
      await vi.advanceTimersByTimeAsync(DEFAULT_DEDUP_WINDOW_MS + 100);

      expect(engine.sendTelegramMessage).not.toHaveBeenCalled();
    });
  });

  // ─── A2. Critical alerts bypass dedup ──────────────────────────────────────
  describe('critical alert bypass', () => {
    it('stream_stopped always sends immediately', async () => {
      const church = makeChurch();
      await engine.sendAlert(church, 'stream_stopped', {});
      await engine.sendAlert(church, 'stream_stopped', {});
      await engine.sendAlert(church, 'stream_stopped', {});
      // All three should have sent (notified), not deduplicated
      expect(engine.sendTelegramMessage).toHaveBeenCalledTimes(3);
    });

    it('signal_loss always sends immediately', async () => {
      const church = makeChurch();
      const r1 = await engine.sendAlert(church, 'signal_loss', {});
      const r2 = await engine.sendAlert(church, 'signal_loss', {});
      // signal_loss is not in ALERT_CLASSIFICATIONS so severity defaults to WARNING
      // but it's in CRITICAL_BYPASS_TYPES, so it should bypass dedup
      expect(r1.action).toBe('notified');
      expect(r2.action).toBe('notified');
    });

    it('encoder_offline always sends immediately', async () => {
      const church = makeChurch();
      const r1 = await engine.sendAlert(church, 'encoder_offline', {});
      const r2 = await engine.sendAlert(church, 'encoder_offline', {});
      expect(r1.action).toBe('notified');
      expect(r2.action).toBe('notified');
    });

    it('EMERGENCY severity alerts bypass dedup', async () => {
      const church = makeChurch();
      engine.adminChatId = null; // suppress escalation for simplicity
      const r1 = await engine.sendAlert(church, 'multiple_systems_down', {});
      const r2 = await engine.sendAlert(church, 'multiple_systems_down', {});
      expect(r1.action).toBe('notified');
      expect(r2.action).toBe('notified');
    });

    it('CRITICAL_BYPASS_TYPES set contains expected entries', () => {
      expect(CRITICAL_BYPASS_TYPES.has('stream_stopped')).toBe(true);
      expect(CRITICAL_BYPASS_TYPES.has('signal_loss')).toBe(true);
      expect(CRITICAL_BYPASS_TYPES.has('encoder_offline')).toBe(true);
      expect(CRITICAL_BYPASS_TYPES.has('audio_silence')).toBe(false);
    });
  });

  // ─── A3. Different alert types tracked separately ──────────────────────────
  describe('separate tracking per alert type', () => {
    it('different alert types are not deduplicated against each other', async () => {
      const church = makeChurch();
      const r1 = await engine.sendAlert(church, 'audio_silence', {});
      const r2 = await engine.sendAlert(church, 'fps_low', {});
      const r3 = await engine.sendAlert(church, 'bitrate_low', {});
      expect(r1.action).toBe('notified');
      expect(r2.action).toBe('notified');
      expect(r3.action).toBe('notified');
      expect(engine.sendTelegramMessage).toHaveBeenCalledTimes(3);
    });

    it('dedup only affects matching type for same church', async () => {
      const church = makeChurch();
      await engine.sendAlert(church, 'audio_silence', {});
      await engine.sendAlert(church, 'fps_low', {});
      engine.sendTelegramMessage.mockClear();

      // Second audio_silence should be deduped, but fps_low entry is separate
      const r = await engine.sendAlert(church, 'audio_silence', {});
      expect(r.action).toBe('deduplicated');

      const r2 = await engine.sendAlert(church, 'fps_low', {});
      expect(r2.action).toBe('deduplicated');
    });
  });

  // ─── A4. Window expiration resets dedup ────────────────────────────────────
  describe('window expiration', () => {
    it('after window expires, next alert sends immediately again', async () => {
      const church = makeChurch();
      await engine.sendAlert(church, 'audio_silence', {});
      engine.sendTelegramMessage.mockClear();

      // Advance past window so the dedup entry is flushed
      await vi.advanceTimersByTimeAsync(DEFAULT_DEDUP_WINDOW_MS + 100);
      engine.sendTelegramMessage.mockClear();

      // Now a new alert should send immediately
      const r = await engine.sendAlert(church, 'audio_silence', {});
      expect(r.action).toBe('notified');
      expect(engine.sendTelegramMessage).toHaveBeenCalledTimes(1);
    });
  });

  // ─── A5. Per-church config ─────────────────────────────────────────────────
  describe('per-church dedup window config', () => {
    it('setDedupWindow configures custom window per church+type', async () => {
      const church = makeChurch();
      engine.setDedupWindow('church-1', 'audio_silence', 2); // 2 minutes

      await engine.sendAlert(church, 'audio_silence', {});
      engine.sendTelegramMessage.mockClear();

      await engine.sendAlert(church, 'audio_silence', {});

      // Advance 2 min + buffer
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 100);

      expect(engine.sendTelegramMessage).toHaveBeenCalledTimes(1);
      const msg = engine.sendTelegramMessage.mock.calls[0][2];
      expect(msg).toContain('2 occurrences');
      expect(msg).toContain('2 min');
    });

    it('different churches can have different windows', async () => {
      const church1 = makeChurch('church-1');
      const church2 = makeChurch('church-2', { name: 'Second Church' });
      engine.setDedupWindow('church-1', 'audio_silence', 1); // 1 minute
      // church-2 uses default 5 minutes

      await engine.sendAlert(church1, 'audio_silence', {});
      await engine.sendAlert(church2, 'audio_silence', {});
      engine.sendTelegramMessage.mockClear();

      await engine.sendAlert(church1, 'audio_silence', {});
      await engine.sendAlert(church2, 'audio_silence', {});

      // After 1.1 min: church-1 should flush, church-2 should not
      await vi.advanceTimersByTimeAsync(1 * 60 * 1000 + 100);

      expect(engine.sendTelegramMessage).toHaveBeenCalledTimes(1);
      const msg = engine.sendTelegramMessage.mock.calls[0][2];
      expect(msg).toContain('2 occurrences');
    });

    it('_getDedupWindowMs returns custom value when set', () => {
      engine.setDedupWindow('church-1', 'fps_low', 10);
      expect(engine._getDedupWindowMs('church-1', 'fps_low')).toBe(10 * 60 * 1000);
    });

    it('_getDedupWindowMs returns default when not set', () => {
      expect(engine._getDedupWindowMs('church-1', 'fps_low')).toBe(DEFAULT_DEDUP_WINDOW_MS);
    });
  });

  // ─── A6. Memory cleanup ───────────────────────────────────────────────────
  describe('memory cleanup', () => {
    it('clearDedupState removes all entries for a church', async () => {
      const church = makeChurch();
      await engine.sendAlert(church, 'audio_silence', {});
      await engine.sendAlert(church, 'fps_low', {});

      expect(engine.dedupState.size).toBe(2);

      engine.clearDedupState('church-1');

      expect(engine.dedupState.size).toBe(0);
    });

    it('clearDedupState does not affect other churches', async () => {
      const church1 = makeChurch('church-1');
      const church2 = makeChurch('church-2');

      await engine.sendAlert(church1, 'audio_silence', {});
      await engine.sendAlert(church2, 'audio_silence', {});
      expect(engine.dedupState.size).toBe(2);

      engine.clearDedupState('church-1');
      expect(engine.dedupState.size).toBe(1);
      expect(engine.dedupState.has('church-2::audio_silence')).toBe(true);
    });

    it('clearDedupState clears custom windows too', () => {
      engine.setDedupWindow('church-1', 'audio_silence', 10);
      engine.setDedupWindow('church-1', 'fps_low', 3);
      engine.setDedupWindow('church-2', 'audio_silence', 7);

      engine.clearDedupState('church-1');

      expect(engine.dedupWindows.size).toBe(1);
      expect(engine.dedupWindows.has('church-2::audio_silence')).toBe(true);
    });

    it('dedup entry is removed after window expires (no leak)', async () => {
      const church = makeChurch();
      await engine.sendAlert(church, 'audio_silence', {});
      expect(engine.dedupState.size).toBe(1);

      await vi.advanceTimersByTimeAsync(DEFAULT_DEDUP_WINDOW_MS + 100);

      expect(engine.dedupState.size).toBe(0);
    });

    it('clearDedupState cancels pending timers', async () => {
      const church = makeChurch();
      await engine.sendAlert(church, 'audio_silence', {});
      await engine.sendAlert(church, 'audio_silence', {});
      engine.sendTelegramMessage.mockClear();

      engine.clearDedupState('church-1');

      // Advance timers — should NOT trigger a flush since we cleared
      await vi.advanceTimersByTimeAsync(DEFAULT_DEDUP_WINDOW_MS + 100);

      expect(engine.sendTelegramMessage).not.toHaveBeenCalled();
    });
  });

  // ─── A7. DB logging still works for deduplicated alerts ────────────────────
  describe('DB logging', () => {
    it('deduplicated alerts are still logged to DB', async () => {
      const church = makeChurch();
      await engine.sendAlert(church, 'audio_silence', {});
      await engine.sendAlert(church, 'audio_silence', {});
      await engine.sendAlert(church, 'audio_silence', {});

      const rows = db.prepare('SELECT * FROM alerts WHERE alert_type = ?').all('audio_silence');
      expect(rows.length).toBe(3); // all logged
    });
  });

  // ─── A8. Rapid-fire alerts (100 in 1 second) ──────────────────────────────
  describe('rapid-fire alerts', () => {
    it('handles 100 rapid-fire alerts — first sends, rest are deduplicated', async () => {
      const church = makeChurch();
      const results = [];
      for (let i = 0; i < 100; i++) {
        results.push(await engine.sendAlert(church, 'bitrate_low', { iteration: i }));
      }

      // First should be notified
      expect(results[0].action).toBe('notified');

      // Rest should be deduplicated
      const dedupCount = results.filter(r => r.action === 'deduplicated').length;
      expect(dedupCount).toBe(99);

      // All 100 should be in the DB
      const rows = db.prepare('SELECT COUNT(*) as cnt FROM alerts WHERE alert_type = ?').get('bitrate_low');
      expect(rows.cnt).toBe(100);

      // Telegram should only have been called once (for the first alert)
      expect(engine.sendTelegramMessage).toHaveBeenCalledTimes(1);
    });

    it('batched summary shows correct count after 100 rapid alerts', async () => {
      const church = makeChurch();
      for (let i = 0; i < 100; i++) {
        await engine.sendAlert(church, 'bitrate_low', { iteration: i });
      }
      engine.sendTelegramMessage.mockClear();

      // Advance past window
      await vi.advanceTimersByTimeAsync(DEFAULT_DEDUP_WINDOW_MS + 100);

      expect(engine.sendTelegramMessage).toHaveBeenCalledTimes(1);
      const msg = engine.sendTelegramMessage.mock.calls[0][2];
      expect(msg).toContain('100 occurrences');
    });
  });

  // ─── A9. Cross-church isolation ─────────────────────────────────────────────
  describe('cross-church isolation', () => {
    it('church A alerts do not affect church B dedup', async () => {
      const churchA = makeChurch('church-A');
      const churchB = makeChurch('church-B');

      // Church A sends audio_silence
      const rA1 = await engine.sendAlert(churchA, 'audio_silence', {});
      expect(rA1.action).toBe('notified');

      // Church B sends same alert type — should NOT be deduplicated
      const rB1 = await engine.sendAlert(churchB, 'audio_silence', {});
      expect(rB1.action).toBe('notified');
      expect(engine.sendTelegramMessage).toHaveBeenCalledTimes(2);
    });

    it('church A second alert is deduplicated but church B second is not affected', async () => {
      const churchA = makeChurch('church-A');
      const churchB = makeChurch('church-B');

      await engine.sendAlert(churchA, 'audio_silence', {});
      await engine.sendAlert(churchB, 'audio_silence', {});
      engine.sendTelegramMessage.mockClear();

      // Church A second alert — deduplicated
      const rA2 = await engine.sendAlert(churchA, 'audio_silence', {});
      expect(rA2.action).toBe('deduplicated');

      // Church B second alert — also deduplicated (within its own window)
      const rB2 = await engine.sendAlert(churchB, 'audio_silence', {});
      expect(rB2.action).toBe('deduplicated');

      // No new telegram messages
      expect(engine.sendTelegramMessage).not.toHaveBeenCalled();
    });

    it('clearing church A dedup does not affect church B', async () => {
      const churchA = makeChurch('church-A');
      const churchB = makeChurch('church-B');

      await engine.sendAlert(churchA, 'audio_silence', {});
      await engine.sendAlert(churchB, 'audio_silence', {});

      engine.clearDedupState('church-A');

      // Church A should be able to send again
      engine.sendTelegramMessage.mockClear();
      const rA = await engine.sendAlert(churchA, 'audio_silence', {});
      expect(rA.action).toBe('notified');

      // Church B should still be deduplicated
      const rB = await engine.sendAlert(churchB, 'audio_silence', {});
      expect(rB.action).toBe('deduplicated');
    });
  });

  // ─── A10. Timer cleanup verification ────────────────────────────────────────
  describe('timer cleanup', () => {
    it('clearDedupState prevents timer from firing even with many entries', async () => {
      const church = makeChurch();
      // Create multiple dedup entries with pending timers
      await engine.sendAlert(church, 'audio_silence', {});
      await engine.sendAlert(church, 'audio_silence', {}); // increment count
      await engine.sendAlert(church, 'fps_low', {});
      await engine.sendAlert(church, 'fps_low', {}); // increment count
      await engine.sendAlert(church, 'bitrate_low', {});
      await engine.sendAlert(church, 'bitrate_low', {}); // increment count

      engine.sendTelegramMessage.mockClear();

      // Clear all timers
      engine.clearDedupState('church-1');

      // Advance well past window
      await vi.advanceTimersByTimeAsync(DEFAULT_DEDUP_WINDOW_MS * 2);

      // No batched summaries should have been sent
      expect(engine.sendTelegramMessage).not.toHaveBeenCalled();
    });
  });
});
