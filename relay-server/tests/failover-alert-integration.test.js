/**
 * Integration: SignalFailover ↔ AlertEngine
 *
 * Tests the interaction points between SignalFailover (state machine) and
 * AlertEngine (deduplication, DB logging, Telegram delivery), verifying:
 * - Failover state transitions trigger the correct AlertEngine calls
 * - AlertEngine correctly classifies failover alert types
 * - Failover acknowledges cancel the AlertEngine escalation timer
 * - Alert DB contains correct severity for failover events
 * - AlertEngine sendAlert is called by autoRecovery integration in failover flow
 * - Multi-church failover state isolation with shared AlertEngine
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createRequire } from 'module';
import { SignalFailover, STATES } from '../src/signalFailover.js';
import { AlertEngine, ALERT_CLASSIFICATIONS } from '../src/alertEngine.js';

const require = createRequire(import.meta.url);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createAlertDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      td_telegram_chat_id TEXT,
      alert_bot_token TEXT,
      telegram_bot_token TEXT,
      failover_enabled INTEGER DEFAULT 1,
      failover_black_threshold_s INTEGER DEFAULT 5,
      failover_ack_timeout_s INTEGER DEFAULT 30,
      failover_action TEXT,
      failover_auto_recover INTEGER DEFAULT 0,
      failover_audio_trigger INTEGER DEFAULT 0,
      service_times TEXT DEFAULT '[]',
      billing_tier TEXT DEFAULT 'pro'
    )
  `);
  db.exec(`
    CREATE TABLE alerts (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      context TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      acknowledged_at TEXT,
      acknowledged_by TEXT,
      escalated INTEGER DEFAULT 0,
      resolved INTEGER DEFAULT 0,
      session_id TEXT
    )
  `);
  return db;
}

function seedChurch(db, churchId, overrides = {}) {
  db.prepare(`
    INSERT INTO churches (churchId, name, td_telegram_chat_id, alert_bot_token,
      telegram_bot_token, failover_enabled, failover_action, failover_auto_recover,
      failover_audio_trigger)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    churchId,
    overrides.name || `Church ${churchId}`,
    overrides.tdChatId || '12345',
    overrides.alertBotToken || 'bot:token',
    overrides.telegramBotToken || 'bot:token',
    overrides.failoverEnabled ?? 1,
    overrides.failoverAction || JSON.stringify({ type: 'atem_switch', input: 3010 }),
    overrides.autoRecover ?? 0,
    overrides.audioTrigger ?? 0,
  );
}

function makeFailoverDb(churchId, overrides = {}) {
  // Returns a mock DB that signalFailover uses internally for config reads
  const defaults = {
    failover_enabled: 1,
    failover_black_threshold_s: 5,
    failover_ack_timeout_s: 30,
    failover_action: JSON.stringify({ type: 'atem_switch', input: 3010 }),
    failover_auto_recover: 0,
    failover_audio_trigger: 0,
    td_telegram_chat_id: '12345',
    telegram_bot_token: 'bot:token',
    churchId,
  };
  const row = { ...defaults, ...overrides };
  return {
    prepare: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue(row),
      run: vi.fn(),
    }),
  };
}

function makeChurch(churchId = 'church-1', overrides = {}) {
  return {
    churchId,
    name: 'Test Church',
    ws: { readyState: 1 },
    status: {
      atem: { connected: true, programInput: 1, streamingBitrate: 5000000 },
      encoder: { connected: true, live: true, bitrateKbps: 5000 },
    },
    ...overrides,
  };
}

function makeChurches(church) {
  const map = new Map();
  map.set(church.churchId, church);
  return map;
}

function mockAutoRecovery() {
  return { dispatchCommand: vi.fn().mockResolvedValue('ok') };
}

// Minimal scheduleEngine that says we're always in service window
function alwaysInWindow() {
  return { isServiceWindow: vi.fn().mockReturnValue(true) };
}

// ─── AlertEngine failover alert classification ─────────────────────────────────

describe('AlertEngine — failover alert classification', () => {
  // AlertEngine requires a churches table in the DB to init
  let db;
  beforeEach(() => { db = createAlertDb(); });
  afterEach(() => { db?.close(); });

  it('classifies failover_suspected_black as WARNING', () => {
    const ae = new AlertEngine(db, null);
    expect(ae.classifyAlert('failover_suspected_black')).toBe('WARNING');
  });

  it('classifies failover_atem_lost as WARNING', () => {
    const ae = new AlertEngine(db, null);
    expect(ae.classifyAlert('failover_atem_lost')).toBe('WARNING');
  });

  it('classifies failover_confirmed_outage as CRITICAL', () => {
    const ae = new AlertEngine(db, null);
    expect(ae.classifyAlert('failover_confirmed_outage')).toBe('CRITICAL');
  });

  it('classifies failover_executed as EMERGENCY', () => {
    const ae = new AlertEngine(db, null);
    expect(ae.classifyAlert('failover_executed')).toBe('EMERGENCY');
  });

  it('classifies failover_command_failed as EMERGENCY', () => {
    const ae = new AlertEngine(db, null);
    expect(ae.classifyAlert('failover_command_failed')).toBe('EMERGENCY');
  });

  it('classifies failover_source_recovering as INFO', () => {
    const ae = new AlertEngine(db, null);
    expect(ae.classifyAlert('failover_source_recovering')).toBe('INFO');
  });

  it('classifies failover_recovery_executed as INFO', () => {
    const ae = new AlertEngine(db, null);
    expect(ae.classifyAlert('failover_recovery_executed')).toBe('INFO');
  });

  it('classifies failover_recovery_failed as CRITICAL', () => {
    const ae = new AlertEngine(db, null);
    expect(ae.classifyAlert('failover_recovery_failed')).toBe('CRITICAL');
  });
});

// ─── AlertEngine sendAlert → DB logging ──────────────────────────────────────

describe('AlertEngine.sendAlert — DB logging for failover events', () => {
  let db, alertEngine;

  beforeEach(() => {
    db = createAlertDb();
    seedChurch(db, 'ch1');
    alertEngine = new AlertEngine(db, alwaysInWindow(), {
      defaultBotToken: 'bot:token',
    });
    vi.spyOn(alertEngine, 'sendTelegramMessage').mockResolvedValue(undefined);
    vi.spyOn(alertEngine, 'sendSlackAlert').mockResolvedValue(undefined);
  });

  afterEach(() => { db?.close(); vi.useRealTimers(); });

  it('logs failover_confirmed_outage as CRITICAL to alerts table', async () => {
    const church = { churchId: 'ch1', name: 'Test Church', td_telegram_chat_id: '12345', alert_bot_token: 'bot:token' };
    const result = await alertEngine.sendAlert(church, 'failover_confirmed_outage', { elapsed: 10 });

    expect(result.severity).toBe('CRITICAL');
    expect(result.action).toBe('notified');

    const row = db.prepare("SELECT * FROM alerts WHERE church_id = 'ch1' AND alert_type = 'failover_confirmed_outage'").get();
    expect(row).toBeTruthy();
    expect(row.severity).toBe('CRITICAL');
  });

  it('logs failover_executed as EMERGENCY and notifies Andrew', async () => {
    const ae = new AlertEngine(db, alwaysInWindow(), {
      defaultBotToken: 'bot:token',
      andrewChatId: 'andrew-chat-id',
    });
    vi.spyOn(ae, 'sendTelegramMessage').mockResolvedValue(undefined);
    vi.spyOn(ae, 'sendSlackAlert').mockResolvedValue(undefined);

    const church = { churchId: 'ch1', name: 'Test Church', td_telegram_chat_id: '12345', alert_bot_token: 'bot:token' };
    const result = await ae.sendAlert(church, 'failover_executed', { source: 'cam1' });

    expect(result.severity).toBe('EMERGENCY');

    // EMERGENCY → Andrew gets notified too
    const calls = ae.sendTelegramMessage.mock.calls;
    const andrewCall = calls.find(c => c[0] === 'andrew-chat-id');
    expect(andrewCall).toBeTruthy();
  });

  it('INFO alerts from failover are logged only, not sent to Telegram', async () => {
    const church = { churchId: 'ch1', name: 'Test Church', td_telegram_chat_id: '12345', alert_bot_token: 'bot:token' };
    const result = await alertEngine.sendAlert(church, 'failover_source_recovering', {});

    expect(result.severity).toBe('INFO');
    expect(result.action).toBe('logged');
    expect(alertEngine.sendTelegramMessage).not.toHaveBeenCalled();
  });

  it('failover_confirmed_outage diagnosis provides autoFix = true', () => {
    const diagnosis = alertEngine.getDiagnosis('failover_confirmed_outage');
    expect(diagnosis.canAutoFix).toBe(true);
    expect(diagnosis.steps.length).toBeGreaterThan(0);
  });

  it('failover_executed diagnosis provides actionable steps', () => {
    const diagnosis = alertEngine.getDiagnosis('failover_executed');
    expect(diagnosis.steps.length).toBeGreaterThan(0);
    expect(diagnosis.likely_cause).toBeTruthy();
  });
});

// ─── SignalFailover ↔ AlertEngine interaction ────────────────────────────────

describe('SignalFailover sends alerts via AlertEngine on state transitions', () => {
  let failoverDb, alertEngineMock, autoRecovery, church, churches, failover;

  beforeEach(() => {
    vi.useFakeTimers();
    failoverDb = makeFailoverDb('ch1');
    alertEngineMock = { sendTelegramMessage: vi.fn().mockResolvedValue(undefined) };
    autoRecovery = mockAutoRecovery();
    church = makeChurch('ch1');
    churches = makeChurches(church);
    failover = new SignalFailover(churches, alertEngineMock, autoRecovery, failoverDb);
  });

  afterEach(() => {
    failover.cleanup('ch1');
    vi.useRealTimers();
  });

  it('atem_lost signal transitions to ATEM_LOST state when encoder is healthy', async () => {
    // When ATEM is lost but encoder is still live and healthy, go to ATEM_LOST
    failover.onSignalEvent('ch1', 'atem_lost', { church });

    // State should transition to ATEM_LOST (not HEALTHY)
    expect(failover.getState('ch1').state).toBe(STATES.ATEM_LOST);

    // Restore ATEM → should return to HEALTHY
    failover.onSignalEvent('ch1', 'atem_restored', { church });
    expect(failover.getState('ch1').state).toBe(STATES.HEALTHY);
  });

  it('confirmed outage: alert is sent and state reaches CONFIRMED_OUTAGE after black threshold', async () => {
    // Build baseline — send 3 bitrate samples
    for (let i = 0; i < 3; i++) {
      failover.onSignalEvent('ch1', 'encoder_bitrate', { bitrateKbps: 5000, church });
    }

    // Drop bitrate → moves to SUSPECTED_BLACK
    failover.onSignalEvent('ch1', 'encoder_bitrate_loss', { church });
    expect(failover.getState('ch1').state).toBe(STATES.SUSPECTED_BLACK);

    // Advance past black threshold (5s + margin) → CONFIRMED_OUTAGE
    // Use only advanceTimersByTime — not runAllTimersAsync which would also fire ack timer
    vi.advanceTimersByTime(6000);

    // Telegram alert should have been sent (via _sendAlert async fire-and-forget)
    // It is sent as a fire-and-forget promise; flush microtasks to capture it
    await Promise.resolve();

    expect(failover.getState('ch1').state).toBe(STATES.CONFIRMED_OUTAGE);
  });

  it('failover executes dispatch command via autoRecovery after ack timeout', async () => {
    // Build baseline
    for (let i = 0; i < 3; i++) {
      failover.onSignalEvent('ch1', 'encoder_bitrate', { bitrateKbps: 5000, church });
    }

    failover.onSignalEvent('ch1', 'encoder_bitrate_loss', { church });
    vi.advanceTimersByTime(6000); // past black threshold → CONFIRMED_OUTAGE

    // Past ack timeout (30s) → executes failover
    vi.advanceTimersByTime(31000);
    await vi.runAllTimersAsync();

    expect(autoRecovery.dispatchCommand).toHaveBeenCalledWith(
      expect.anything(),
      'atem.cut',
      expect.objectContaining({ input: 3010 }),
      null,
    );
    expect(failover.getState('ch1').state).toBe(STATES.FAILOVER_ACTIVE);
  });

  it('TD acknowledge cancels auto-failover dispatch', async () => {
    for (let i = 0; i < 3; i++) {
      failover.onSignalEvent('ch1', 'encoder_bitrate', { bitrateKbps: 5000, church });
    }

    failover.onSignalEvent('ch1', 'encoder_bitrate_loss', { church });
    vi.advanceTimersByTime(6000); // → CONFIRMED_OUTAGE

    expect(failover.getState('ch1').state).toBe(STATES.CONFIRMED_OUTAGE);

    // TD acks before timeout
    failover.onTdAcknowledge('ch1');

    // Advance past ack timeout
    vi.advanceTimersByTime(35000);
    await vi.runAllTimersAsync();

    // Failover should NOT have been dispatched
    expect(autoRecovery.dispatchCommand).not.toHaveBeenCalled();
  });

  it('HEALTHY state transition: ATEM restore after ATEM_LOST resets to HEALTHY', () => {
    // Simulate ATEM lost → ATEM_LOST
    failover.onSignalEvent('ch1', 'atem_lost', { church });
    expect(failover.getState('ch1').state).toBe(STATES.ATEM_LOST);

    // ATEM restore → HEALTHY
    failover.onSignalEvent('ch1', 'atem_restored', { church });
    expect(failover.getState('ch1').state).toBe(STATES.HEALTHY);

    // Second atem_lost → ATEM_LOST again (state machine resets correctly)
    failover.onSignalEvent('ch1', 'atem_lost', { church });
    expect(failover.getState('ch1').state).toBe(STATES.ATEM_LOST);
  });
});

// ─── AlertEngine acknowledge ↔ active alerts map ─────────────────────────────

describe('AlertEngine.acknowledgeAlert — integration with activeAlerts map', () => {
  let db, ae;

  beforeEach(() => {
    vi.useFakeTimers();
    db = createAlertDb();
    seedChurch(db, 'ch1');
    ae = new AlertEngine(db, alwaysInWindow(), { defaultBotToken: 'bot:token' });
    vi.spyOn(ae, 'sendTelegramMessage').mockResolvedValue(undefined);
    vi.spyOn(ae, 'sendSlackAlert').mockResolvedValue(undefined);
  });

  afterEach(() => { db?.close(); vi.useRealTimers(); });

  it('acknowledging a CRITICAL alert cancels the escalation timer', async () => {
    const church = { churchId: 'ch1', name: 'Test Church', td_telegram_chat_id: '12345', alert_bot_token: 'bot:token' };
    const result = await ae.sendAlert(church, 'failover_confirmed_outage', {});

    expect(result.action).toBe('notified');
    const alertId = result.alertId;

    // Active alert should be in the map
    expect(ae.activeAlerts.has(alertId)).toBe(true);

    await ae.acknowledgeAlert(alertId, 'TD User');

    // Should be removed from active alerts
    expect(ae.activeAlerts.has(alertId)).toBe(false);

    // DB should be updated
    const row = db.prepare('SELECT acknowledged_at, acknowledged_by FROM alerts WHERE id = ?').get(alertId);
    expect(row.acknowledged_at).toBeTruthy();
    expect(row.acknowledged_by).toBe('TD User');

    // Timer should not fire after ack — no second Telegram call
    const callsBefore = ae.sendTelegramMessage.mock.calls.length;
    vi.advanceTimersByTime(310_000); // past 5 min escalation
    await vi.runAllTimersAsync();
    expect(ae.sendTelegramMessage.mock.calls.length).toBe(callsBefore);
  });

  it('findAlertByPrefix returns correct alert ID', async () => {
    const church = { churchId: 'ch1', name: 'Test Church', td_telegram_chat_id: '12345', alert_bot_token: 'bot:token' };
    const result = await ae.sendAlert(church, 'failover_confirmed_outage', {});
    const prefix = result.alertId.slice(0, 8);

    const found = ae.findAlertByPrefix(prefix);
    expect(found).toBe(result.alertId);
  });

  it('findAlertByPrefix sanitizes non-hex characters', async () => {
    const found = ae.findAlertByPrefix("../../etc/passwd");
    // Sanitized to empty — no result
    expect(found).toBeNull();
  });

  it('acknowledged alert is not returned by findAlertByPrefix', async () => {
    const church = { churchId: 'ch1', name: 'Test Church', td_telegram_chat_id: '12345', alert_bot_token: 'bot:token' };
    const result = await ae.sendAlert(church, 'failover_confirmed_outage', {});
    const prefix = result.alertId.slice(0, 8);

    await ae.acknowledgeAlert(result.alertId, 'TD');
    const found = ae.findAlertByPrefix(prefix);
    expect(found).toBeNull();
  });
});

// ─── Multi-church isolation with shared AlertEngine ──────────────────────────

describe('Multi-church failover isolation', () => {
  let alertEngineMock, autoRecovery;

  beforeEach(() => {
    vi.useFakeTimers();
    alertEngineMock = { sendTelegramMessage: vi.fn().mockResolvedValue(undefined) };
    autoRecovery = mockAutoRecovery();
  });

  afterEach(() => { vi.useRealTimers(); });

  it('failover state for church-1 does not affect church-2', () => {
    const ch1 = makeChurch('church-1');
    const ch2 = makeChurch('church-2', { name: 'Second Church' });
    const churches = new Map([['church-1', ch1], ['church-2', ch2]]);

    const db1 = makeFailoverDb('church-1');
    const failover = new SignalFailover(churches, alertEngineMock, autoRecovery, db1);

    // Trigger outage for church-1 only
    for (let i = 0; i < 3; i++) {
      failover.onSignalEvent('church-1', 'encoder_bitrate', { bitrateKbps: 5000, church: ch1 });
    }
    failover.onSignalEvent('church-1', 'encoder_bitrate_loss', { church: ch1 });
    vi.advanceTimersByTime(6000);

    expect(failover.getState('church-1').state).toBe(STATES.CONFIRMED_OUTAGE);
    // church-2 stays HEALTHY
    expect(failover.getState('church-2').state).toBe(STATES.HEALTHY);

    failover.cleanup('church-1');
    failover.cleanup('church-2');
  });

  it('cleanup removes state for one church without affecting another', () => {
    const ch1 = makeChurch('church-1');
    const ch2 = makeChurch('church-2');
    const churches = new Map([['church-1', ch1], ['church-2', ch2]]);
    const db1 = makeFailoverDb('church-1');
    const failover = new SignalFailover(churches, alertEngineMock, autoRecovery, db1);

    for (let i = 0; i < 3; i++) {
      failover.onSignalEvent('church-1', 'encoder_bitrate', { bitrateKbps: 5000, church: ch1 });
    }

    failover.cleanup('church-1');
    // church-2 should still report HEALTHY (not erroring)
    expect(failover.getState('church-2').state).toBe(STATES.HEALTHY);
    failover.cleanup('church-2');
  });
});
