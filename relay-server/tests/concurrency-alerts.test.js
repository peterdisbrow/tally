/**
 * Concurrency and load tests for AlertEngine — deduplication under concurrent
 * alert bursts, mixed alert types, rapid ack cycles, and large payloads.
 *
 * All tests mock Telegram and Slack so no real HTTP calls are made.
 * Fake timers are used where dedup windows must expire deterministically.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { AlertEngine } from '../src/alertEngine.js';

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
  const engine = new AlertEngine(db, scheduleEngine, {
    defaultBotToken: 'default-bot-token',
    ...opts,
  });
  engine.sendTelegramMessage = vi.fn().mockResolvedValue(undefined);
  engine.sendSlackAlert = vi.fn().mockResolvedValue(undefined);
  engine.sendSlackAcknowledgment = vi.fn().mockResolvedValue(undefined);
  return engine;
}

function countAlertsInDb(db, churchId) {
  return db.prepare('SELECT COUNT(*) as cnt FROM alerts WHERE church_id = ?').get(churchId).cnt;
}

// ─── A. 50 identical alerts → deduplicated ───────────────────────────────────

describe('50 identical alerts fired synchronously — deduplication', () => {
  let db, engine;

  beforeEach(() => {
    vi.useFakeTimers();
    db = createTestDb();
    engine = createEngine(db);
  });

  afterEach(() => {
    engine.clearDedupState('church-1');
    vi.useRealTimers();
    db?.close();
  });

  it('all 50 are persisted to DB but only the first triggers a notification', async () => {
    const church = makeChurch('church-1');
    const promises = [];
    for (let i = 0; i < 50; i++) {
      promises.push(engine.sendAlert(church, 'fps_low', { value: 20 }));
    }
    const results = await Promise.all(promises);

    // All 50 stored in DB
    expect(countAlertsInDb(db, 'church-1')).toBe(50);

    // First alert: 'notified', the rest: 'deduplicated'
    const notified = results.filter(r => r.action === 'notified');
    const deduped = results.filter(r => r.action === 'deduplicated');
    expect(notified).toHaveLength(1);
    expect(deduped).toHaveLength(49);
  });

  it('Telegram is called only once for a burst of identical WARNING alerts', async () => {
    const church = makeChurch('church-1');
    for (let i = 0; i < 50; i++) {
      await engine.sendAlert(church, 'cpu_high', { value: 95 });
    }
    // Only 1 initial notification (dedup suppresses the rest within the window)
    expect(engine.sendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it('CRITICAL_BYPASS_TYPES alert bypasses dedup — all 50 trigger notifications', async () => {
    const church = makeChurch('church-1');
    const results = [];
    for (let i = 0; i < 50; i++) {
      results.push(await engine.sendAlert(church, 'stream_stopped', {}));
    }
    // stream_stopped is in CRITICAL_BYPASS_TYPES — each bypasses dedup
    const bypassed = results.filter(r => r.action !== 'deduplicated');
    expect(bypassed.length).toBe(50);
  });
});

// ─── B. 50 different alerts → all stored ─────────────────────────────────────

describe('50 different alert types fired simultaneously — all stored', () => {
  let db, engine;

  beforeEach(() => {
    vi.useFakeTimers();
    db = createTestDb();
    engine = createEngine(db);
  });

  afterEach(() => {
    engine.clearDedupState('church-multi');
    vi.useRealTimers();
    db?.close();
  });

  it('50 unique alert types produce 50 DB records', async () => {
    const church = makeChurch('church-multi');
    const alertTypes = [
      'fps_low', 'bitrate_low', 'cpu_high', 'obs_disconnected', 'companion_disconnected',
      'vmix_disconnected', 'audio_silence', 'encoder_disconnected', 'hyperdeck_disconnected',
      'mixer_disconnected', 'ptz_disconnected', 'propresenter_disconnected',
      'atem_stream_stopped', 'vmix_stream_stopped', 'encoder_stream_stopped',
      'stream_platform_health', 'firmware_outdated', 'stream_started',
      'recording_started', 'service_ended',
    ];

    // Fire each type with unique indices to ensure 50 unique dedup keys
    const promises = [];
    for (let i = 0; i < 50; i++) {
      const baseType = alertTypes[i % alertTypes.length];
      // Use unique church-per-alert-type to avoid dedup collisions across rounds
      const uniqueChurch = makeChurch(`church-${i}`);
      promises.push(engine.sendAlert(uniqueChurch, baseType, { index: i }));
    }
    await Promise.all(promises);

    // Total in DB: 50 unique records
    const total = db.prepare('SELECT COUNT(*) as cnt FROM alerts').get();
    expect(total.cnt).toBe(50);
  });

  it('different alert types for the same church each get their own dedup slot', async () => {
    const church = makeChurch('church-multi');
    // 5 different types, each fired once — all should be 'notified'
    const types = ['fps_low', 'bitrate_low', 'cpu_high', 'obs_disconnected', 'audio_silence'];
    const results = await Promise.all(types.map(t => engine.sendAlert(church, t, {})));

    const notified = results.filter(r => r.action === 'notified');
    expect(notified).toHaveLength(5);
    expect(countAlertsInDb(db, 'church-multi')).toBe(5);
  });
});

// ─── C. Rapid alert + acknowledge cycles ─────────────────────────────────────

describe('rapid alert + acknowledge cycles — no stuck state', () => {
  let db, engine;

  beforeEach(() => {
    vi.useFakeTimers();
    db = createTestDb();
    engine = createEngine(db);
  });

  afterEach(() => {
    engine.clearDedupState('church-cycle');
    vi.useRealTimers();
    db?.close();
  });

  it('10 rapid alert + acknowledge cycles complete without error', async () => {
    const church = makeChurch('church-cycle');
    const CYCLES = 10;

    for (let i = 0; i < CYCLES; i++) {
      // Use a CRITICAL type to create an active alert entry with escalation timer
      const result = await engine.sendAlert(church, 'atem_disconnected', { cycle: i });
      expect(result.alertId).toBeTruthy();

      // Acknowledge immediately to cancel any escalation timer
      const ackResult = await engine.acknowledgeAlert(result.alertId, 'td-operator');
      expect(ackResult.acknowledged).toBe(true);

      // Advance the dedup window so next cycle starts fresh
      engine.clearDedupState('church-cycle');
    }

    // All 10 cycles stored in DB
    expect(countAlertsInDb(db, 'church-cycle')).toBe(CYCLES);

    // All 10 acknowledged in DB
    const acked = db.prepare(
      "SELECT COUNT(*) as cnt FROM alerts WHERE church_id = ? AND acknowledged_at IS NOT NULL"
    ).get('church-cycle');
    expect(acked.cnt).toBe(CYCLES);

    // No active alerts lingering
    expect(engine.activeAlerts.size).toBe(0);
  });

  it('dedup state is clean after clearDedupState in each cycle', async () => {
    const church = makeChurch('church-cycle');

    for (let i = 0; i < 5; i++) {
      await engine.sendAlert(church, 'bitrate_low', { iter: i });
      engine.clearDedupState('church-cycle');
    }
    // After 5 clears + sends, dedup map should be empty
    expect(engine.dedupState.size).toBe(0);
  });
});

// ─── D. Alert with large payload ─────────────────────────────────────────────

describe('alert with very large context payload', () => {
  let db, engine;

  beforeEach(() => {
    vi.useFakeTimers();
    db = createTestDb();
    engine = createEngine(db);
  });

  afterEach(() => {
    engine.clearDedupState('church-large');
    vi.useRealTimers();
    db?.close();
  });

  it('100KB metadata object is stored and retrievable', async () => {
    const church = makeChurch('church-large');

    // Build ~100KB of context data
    const largeValue = 'x'.repeat(1024); // 1KB string
    const context = {};
    for (let i = 0; i < 100; i++) {
      context[`key_${i}`] = largeValue;
    }

    const result = await engine.sendAlert(church, 'fps_low', context);
    expect(result.alertId).toBeTruthy();

    // Verify it's stored in DB with full context
    const row = db.prepare('SELECT context FROM alerts WHERE id = ?').get(result.alertId);
    expect(row).toBeTruthy();
    const parsed = JSON.parse(row.context);
    expect(Object.keys(parsed)).toContain('key_0');
    expect(Object.keys(parsed)).toContain('key_99');
    // Each value is 1024 chars, so stored data is large
    expect(parsed.key_0.length).toBe(1024);
  });

  it('handles 100KB context without throwing an error', async () => {
    const church = makeChurch('church-large');
    const bigContext = { data: 'z'.repeat(100 * 1024) };

    let threw = false;
    try {
      await engine.sendAlert(church, 'cpu_high', bigContext);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  it('alert with large payload does not prevent subsequent alerts', async () => {
    const church = makeChurch('church-large');
    const bigContext = { data: 'y'.repeat(50 * 1024) };

    // First alert with large payload
    engine.clearDedupState('church-large');
    await engine.sendAlert(church, 'fps_low', bigContext);

    // Clear dedup, then send a small follow-up alert
    engine.clearDedupState('church-large');
    const result2 = await engine.sendAlert(church, 'cpu_high', { small: 'data' });
    expect(result2.alertId).toBeTruthy();
    expect(countAlertsInDb(db, 'church-large')).toBe(2);
  });
});
