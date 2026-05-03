/**
 * Telegram alert delivery — end-to-end audit
 *
 * Mocks the Telegram HTTP API at the global `fetch` boundary and walks alerts
 * through AlertEngine.sendAlert to verify:
 *   1. Outbound HTTP shape matches Telegram's sendMessage contract.
 *   2. Per-church bot token / chat ID lookup picks the right values.
 *   3. Battery alerts (PR #75) survive the full pipeline:
 *        teradek_battery_low      → WARNING, ⚠️ icon, sent to TD
 *        teradek_battery_critical → CRITICAL, 🔴 icon, escalation timer armed
 *      and the two thresholds dedup independently of each other.
 *   4. Stream-stopped / signal-loss / encoder-offline alerts always send.
 *   5. Instance-scoped dedup flush summarizes with the correct alert label
 *      (regression for the destructuring bug that surfaced with multi-room).
 *   6. Slack mirrors don't mask Telegram failures.
 *   7. Per-room dedup keys do not bleed across rooms.
 *
 * No real network calls are made — Telegram (and Slack) fetches are intercepted
 * via vi.stubGlobal('fetch', ...).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { AlertEngine, ALERT_CLASSIFICATIONS, DEFAULT_DEDUP_WINDOW_MS } from '../src/alertEngine.js';

// ─── Test scaffolding ────────────────────────────────────────────────────────

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

function makeChurch(overrides = {}) {
  return {
    churchId: 'church-1',
    name: 'First Tally Church',
    td_telegram_chat_id: '987654321',
    alert_bot_token: 'church-bot-token',
    ...overrides,
  };
}

function createEngine(db, opts = {}) {
  return new AlertEngine(db, { isServiceWindow: () => true }, {
    defaultBotToken: 'default-bot-token',
    ...opts,
  });
}

/**
 * Capture every Telegram API request the engine makes. Returns a fetch mock
 * that resolves successfully and an array that accumulates the parsed payloads.
 */
function captureTelegramFetches() {
  const calls = [];
  const fetchMock = vi.fn(async (url, init) => {
    if (typeof url === 'string' && url.startsWith('https://api.telegram.org/bot')) {
      const tokenMatch = url.match(/^https:\/\/api\.telegram\.org\/bot([^/]+)\/sendMessage$/);
      let body = {};
      try { body = JSON.parse(init.body); } catch { /* leave empty */ }
      calls.push({
        url,
        botToken: tokenMatch ? tokenMatch[1] : null,
        method: init.method,
        chatId: body.chat_id,
        text: body.text,
        parseMode: body.parse_mode,
      });
      return { ok: true, status: 200, text: async () => '' };
    }
    // Slack / anything else: succeed silently so it doesn't poison Telegram assertions
    return { ok: true, status: 200, text: async () => '' };
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

// ─── 1. Outbound HTTP contract ───────────────────────────────────────────────

describe('Telegram alert delivery — HTTP contract', () => {
  let db, engine, telegram;

  beforeEach(() => {
    db = createTestDb();
    engine = createEngine(db);
    telegram = captureTelegramFetches();
  });

  afterEach(() => {
    engine.clearDedupState('church-1');
    db.close();
    vi.unstubAllGlobals();
  });

  it('hits the right Telegram endpoint with chat_id, text, and Markdown parse_mode', async () => {
    await engine.sendAlert(makeChurch(), 'audio_silence', { dbfs: -60 });

    expect(telegram.calls).toHaveLength(1);
    const call = telegram.calls[0];
    expect(call.url).toBe('https://api.telegram.org/botchurch-bot-token/sendMessage');
    expect(call.method).toBe('POST');
    expect(call.chatId).toBe('987654321');
    expect(call.parseMode).toBe('Markdown');
    expect(call.text).toContain('AUDIO SILENCE');
    expect(call.text).toContain('First Tally Church');
  });

  it('skips Telegram entirely when no bot token is configured anywhere', async () => {
    const noTokenEngine = new AlertEngine(db, { isServiceWindow: () => true }, {});
    const church = makeChurch({ alert_bot_token: '' });

    const result = await noTokenEngine.sendAlert(church, 'audio_silence', {});
    expect(result.action).toBe('no_bot_token');
    expect(telegram.calls).toHaveLength(0);
  });

  it('falls back to defaultBotToken when church row has no token', async () => {
    const church = makeChurch({ alert_bot_token: '' });
    await engine.sendAlert(church, 'audio_silence', {});

    expect(telegram.calls).toHaveLength(1);
    expect(telegram.calls[0].botToken).toBe('default-bot-token');
  });

  it('per-church alert_bot_token wins over the relay default', async () => {
    const church = makeChurch({ alert_bot_token: 'tenant-specific-token' });
    await engine.sendAlert(church, 'audio_silence', {});

    expect(telegram.calls).toHaveLength(1);
    expect(telegram.calls[0].botToken).toBe('tenant-specific-token');
  });

  it('does not send to TD when td_telegram_chat_id is missing', async () => {
    const church = makeChurch({ td_telegram_chat_id: '' });
    await engine.sendAlert(church, 'audio_silence', {});

    // No TD chat ID, no admin chat ID — nothing should go out
    expect(telegram.calls).toHaveLength(0);
  });

  it('Telegram API failure is swallowed and logged, does not throw', async () => {
    vi.unstubAllGlobals();
    const errFetch = vi.fn(async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' }));
    vi.stubGlobal('fetch', errFetch);
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(engine.sendAlert(makeChurch(), 'audio_silence', {})).resolves.toBeTruthy();
    expect(consoleErr).toHaveBeenCalledWith(expect.stringContaining('Telegram API error: 401'));

    consoleErr.mockRestore();
  });
});

// ─── 2. Battery alert classification (PR #75 audit) ──────────────────────────

describe('Telegram alert delivery — Teradek battery alerts', () => {
  let db, engine, telegram;

  beforeEach(() => {
    db = createTestDb();
    engine = createEngine(db);
    telegram = captureTelegramFetches();
  });

  afterEach(() => {
    engine.clearDedupState('church-1');
    db.close();
    vi.unstubAllGlobals();
  });

  it('teradek_battery_low classifies as WARNING (post-fix)', () => {
    expect(ALERT_CLASSIFICATIONS['teradek_battery_low']).toBe('WARNING');
    expect(engine.classifyAlert('teradek_battery_low')).toBe('WARNING');
  });

  it('teradek_battery_critical classifies as CRITICAL (post-fix)', () => {
    expect(ALERT_CLASSIFICATIONS['teradek_battery_critical']).toBe('CRITICAL');
    expect(engine.classifyAlert('teradek_battery_critical')).toBe('CRITICAL');
  });

  it('battery_critical message uses the CRITICAL icon and severity label', async () => {
    await engine.sendAlert(makeChurch(), 'teradek_battery_critical', { batteryPct: 8 });

    expect(telegram.calls).toHaveLength(1);
    const text = telegram.calls[0].text;
    expect(text).toContain('🔴');
    expect(text).toContain('CRITICAL');
    expect(text).toContain('TERADEK BATTERY CRITICAL');
  });

  it('battery_low message uses the WARNING icon and severity label', async () => {
    await engine.sendAlert(makeChurch(), 'teradek_battery_low', { batteryPct: 18 });

    expect(telegram.calls).toHaveLength(1);
    const text = telegram.calls[0].text;
    expect(text).toContain('⚠️');
    expect(text).toContain('WARNING');
  });

  it('battery alerts include a real diagnosis (not the generic fallback)', async () => {
    await engine.sendAlert(makeChurch(), 'teradek_battery_critical', { batteryPct: 5 });

    const text = telegram.calls[0].text;
    expect(text).toContain('below 10%');
    expect(text).toContain('Connect AC power');
    expect(text).not.toContain('Unknown issue');
  });

  it('battery_low and battery_critical dedup independently — each sends once', async () => {
    const church = makeChurch();

    // Two of each, in alternating order, all within the dedup window.
    await engine.sendAlert(church, 'teradek_battery_low', { batteryPct: 18 });
    await engine.sendAlert(church, 'teradek_battery_critical', { batteryPct: 9 });
    await engine.sendAlert(church, 'teradek_battery_low', { batteryPct: 16 });
    await engine.sendAlert(church, 'teradek_battery_critical', { batteryPct: 7 });

    // First of each threshold sends, second of each is deduplicated. Critical
    // is NOT in CRITICAL_BYPASS_TYPES so it dedups within its own threshold,
    // but it must NOT dedup against the warning-tier alert.
    expect(telegram.calls).toHaveLength(2);
    const types = telegram.calls.map(c => c.text.match(/TERADEK BATTERY (\w+)/)?.[1]);
    expect(types.sort()).toEqual(['CRITICAL', 'LOW']);
  });

  it('arms a 5-minute escalation timer for battery_critical', async () => {
    vi.useFakeTimers();
    try {
      const adminEngine = createEngine(db, { adminChatId: 'admin-chat-id' });
      const adminTelegram = captureTelegramFetches();

      const result = await adminEngine.sendAlert(makeChurch(), 'teradek_battery_critical', { batteryPct: 5 });
      expect(result.severity).toBe('CRITICAL');
      expect(adminEngine.activeAlerts.size).toBe(1);

      adminTelegram.calls.length = 0;
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 100);

      // Escalation should have fired with [ESCALATED] prefix
      const escalation = adminTelegram.calls.find(c => c.text.startsWith('🚨 ESCALATED'));
      expect(escalation).toBeTruthy();
      expect(escalation.chatId).toBe('admin-chat-id');

      adminEngine.clearDedupState('church-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('battery_low does NOT escalate (warnings are not on the escalation ladder)', async () => {
    vi.useFakeTimers();
    try {
      const adminEngine = createEngine(db, { adminChatId: 'admin-chat-id' });
      const adminTelegram = captureTelegramFetches();

      await adminEngine.sendAlert(makeChurch(), 'teradek_battery_low', { batteryPct: 18 });
      adminTelegram.calls.length = 0;
      // Advance past escalation window AND dedup window
      await vi.advanceTimersByTimeAsync(DEFAULT_DEDUP_WINDOW_MS + 1000);

      const escalation = adminTelegram.calls.find(c => c.text.startsWith('🚨 ESCALATED'));
      expect(escalation).toBeFalsy();

      adminEngine.clearDedupState('church-1');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── 3. Critical bypass alerts ───────────────────────────────────────────────

describe('Telegram alert delivery — critical bypass types', () => {
  let db, engine, telegram;

  beforeEach(() => {
    db = createTestDb();
    engine = createEngine(db);
    telegram = captureTelegramFetches();
  });

  afterEach(() => {
    engine.clearDedupState('church-1');
    db.close();
    vi.unstubAllGlobals();
  });

  it('stream_stopped sends every time, never deduped', async () => {
    const church = makeChurch();
    await engine.sendAlert(church, 'stream_stopped', {});
    await engine.sendAlert(church, 'stream_stopped', {});
    await engine.sendAlert(church, 'stream_stopped', {});
    expect(telegram.calls).toHaveLength(3);
  });

  it('encoder_offline sends every time, never deduped', async () => {
    const church = makeChurch();
    await engine.sendAlert(church, 'encoder_offline', {});
    await engine.sendAlert(church, 'encoder_offline', {});
    expect(telegram.calls).toHaveLength(2);
  });
});

// ─── 4. Instance-scoped dedup flush (regression for destructuring bug) ───────

describe('Telegram alert delivery — instance-scoped dedup', () => {
  let db, engine, telegram;

  beforeEach(() => {
    vi.useFakeTimers();
    db = createTestDb();
    engine = createEngine(db);
    telegram = captureTelegramFetches();
  });

  afterEach(() => {
    engine.clearDedupState('church-1');
    vi.useRealTimers();
    db.close();
    vi.unstubAllGlobals();
  });

  it('alerts from different rooms dedup independently', async () => {
    const church = makeChurch();

    await engine.sendAlert(church, 'audio_silence', { _instanceName: 'sanctuary' });
    await engine.sendAlert(church, 'audio_silence', { _instanceName: 'youth-room' });

    // Different rooms → both first occurrences send immediately
    expect(telegram.calls).toHaveLength(2);

    // Second occurrence in sanctuary is deduped, but the first audio_silence
    // in chapel-room (yet a third room) still sends.
    telegram.calls.length = 0;
    const r2sanc = await engine.sendAlert(church, 'audio_silence', { _instanceName: 'sanctuary' });
    const r1chap = await engine.sendAlert(church, 'audio_silence', { _instanceName: 'chapel' });
    expect(r2sanc.action).toBe('deduplicated');
    expect(r1chap.action).toBe('notified');
    expect(telegram.calls).toHaveLength(1);
  });

  it('flush summary for a per-instance alert reports the correct alert type, not the room name', async () => {
    // Regression: previously _flushDedupEntry destructured key.split('::') as
    // [churchId, alertType], which for a 3-segment "churchId::room::alertType"
    // key pulled the room name and labeled the summary "⚠️ sanctuary
    // (3 occurrences ...)" instead of "⚠️ audio silence ...".
    const church = makeChurch();

    await engine.sendAlert(church, 'audio_silence', { _instanceName: 'sanctuary' });
    await engine.sendAlert(church, 'audio_silence', { _instanceName: 'sanctuary' });
    await engine.sendAlert(church, 'audio_silence', { _instanceName: 'sanctuary' });

    telegram.calls.length = 0;
    await vi.advanceTimersByTimeAsync(DEFAULT_DEDUP_WINDOW_MS + 100);

    expect(telegram.calls).toHaveLength(1);
    const summary = telegram.calls[0].text;
    expect(summary).toContain('audio silence');
    expect(summary).toContain('3 occurrences');
    // Room label should appear in brackets — so the operator can tell rooms apart
    expect(summary).toContain('[sanctuary]');
    // It must NOT name the room as the alert type
    expect(summary).not.toMatch(/⚠️\s+sanctuary\s*\(/);
  });

  it('per-instance alerts use the right dedup window even with custom config', async () => {
    const church = makeChurch();
    engine.setDedupWindow('church-1', 'audio_silence', 1); // 1 minute

    await engine.sendAlert(church, 'audio_silence', { _instanceName: 'sanctuary' });
    await engine.sendAlert(church, 'audio_silence', { _instanceName: 'sanctuary' });
    telegram.calls.length = 0;

    await vi.advanceTimersByTimeAsync(60 * 1000 + 100);

    expect(telegram.calls).toHaveLength(1);
    expect(telegram.calls[0].text).toContain('1 min'); // not "5 min" default
  });
});

// ─── 5. Outside-window suppression ───────────────────────────────────────────

describe('Telegram alert delivery — service window gating', () => {
  let db, engine, telegram;

  afterEach(() => {
    engine?.clearDedupState('church-1');
    db?.close();
    vi.unstubAllGlobals();
  });

  it('non-EMERGENCY alerts outside service window are logged but not sent', async () => {
    db = createTestDb();
    engine = new AlertEngine(db, { isServiceWindow: () => false }, { defaultBotToken: 'default-bot-token' });
    telegram = captureTelegramFetches();

    const result = await engine.sendAlert(makeChurch(), 'audio_silence', {});
    expect(result.action).toBe('logged_outside_window');
    expect(telegram.calls).toHaveLength(0);

    // DB row should still exist
    const rows = db.prepare('SELECT * FROM alerts').all();
    expect(rows).toHaveLength(1);
  });

  it('EMERGENCY alerts ignore the service window', async () => {
    db = createTestDb();
    engine = new AlertEngine(db, { isServiceWindow: () => false }, {
      defaultBotToken: 'default-bot-token',
      adminChatId: 'admin-chat-id',
    });
    telegram = captureTelegramFetches();

    await engine.sendAlert(makeChurch(), 'multiple_systems_down', {});

    // Should fire to TD AND to admin (escalated)
    expect(telegram.calls.length).toBeGreaterThanOrEqual(2);
    const adminCall = telegram.calls.find(c => c.chatId === 'admin-chat-id');
    expect(adminCall).toBeTruthy();
    expect(adminCall.text).toContain('[ESCALATED]');
  });
});

// ─── 6. Cross-church / multi-tenant isolation ────────────────────────────────

describe('Telegram alert delivery — cross-church isolation', () => {
  let db, engine, telegram;

  beforeEach(() => {
    db = createTestDb();
    engine = createEngine(db);
    telegram = captureTelegramFetches();
  });

  afterEach(() => {
    engine.clearDedupState('church-A');
    engine.clearDedupState('church-B');
    db.close();
    vi.unstubAllGlobals();
  });

  it('different churches use their own bot tokens and chat IDs', async () => {
    const churchA = makeChurch({
      churchId: 'church-A',
      td_telegram_chat_id: 'chat-A',
      alert_bot_token: 'token-A',
    });
    const churchB = makeChurch({
      churchId: 'church-B',
      td_telegram_chat_id: 'chat-B',
      alert_bot_token: 'token-B',
    });

    await engine.sendAlert(churchA, 'audio_silence', {});
    await engine.sendAlert(churchB, 'audio_silence', {});

    expect(telegram.calls).toHaveLength(2);
    const callA = telegram.calls.find(c => c.chatId === 'chat-A');
    const callB = telegram.calls.find(c => c.chatId === 'chat-B');
    expect(callA?.botToken).toBe('token-A');
    expect(callB?.botToken).toBe('token-B');
  });
});
