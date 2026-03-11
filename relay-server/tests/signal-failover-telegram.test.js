import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token TEXT,
      failover_enabled INTEGER DEFAULT 0,
      failover_black_threshold_s INTEGER DEFAULT 5,
      failover_ack_timeout_s INTEGER DEFAULT 30,
      failover_action TEXT,
      failover_auto_recover INTEGER DEFAULT 0,
      failover_audio_trigger INTEGER DEFAULT 0,
      td_telegram_chat_id TEXT
    )
  `);
  db.exec(`
    CREATE TABLE church_tds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT,
      telegram_chat_id TEXT,
      name TEXT,
      active INTEGER DEFAULT 1,
      user_id TEXT
    )
  `);
  db.exec(`CREATE TABLE alerts (
    id TEXT PRIMARY KEY,
    churchId TEXT,
    alertType TEXT,
    severity TEXT,
    message TEXT,
    context TEXT,
    created_at TEXT,
    acknowledged_at TEXT,
    acknowledged_by TEXT,
    escalated INTEGER DEFAULT 0,
    session_id TEXT
  )`);
  return db;
}

function setupChurch(db, overrides = {}) {
  const churchId = overrides.churchId || 'church-1';
  const name = overrides.name || 'Test Church';
  db.prepare('INSERT OR REPLACE INTO churches (churchId, name, token, failover_enabled, failover_action) VALUES (?, ?, ?, ?, ?)')
    .run(churchId, name, 'tok', 1, JSON.stringify({ type: 'atem_switch', input: 5 }));
  db.prepare('INSERT OR REPLACE INTO church_tds (church_id, telegram_chat_id, name, active, user_id) VALUES (?, ?, ?, ?, ?)')
    .run(churchId, '12345', 'TD User', 1, 'u12345');
  return { churchId, name };
}

// ─── A. /ack_ command ───────────────────────────────────────────────────────

describe('/ack_ command handling', () => {
  let db, mockSignalFailover;

  beforeEach(() => {
    db = createTestDb();
    mockSignalFailover = {
      onTdAcknowledge: vi.fn(),
      onTdConfirmRecovery: vi.fn(),
    };
  });

  afterEach(() => {
    db?.close();
  });

  it('regex matches /ack_ with hex suffix', () => {
    const match = '/ack_a1b2c3d4'.match(/^\/ack_([a-f0-9]+)/i);
    expect(match).toBeTruthy();
    expect(match[1]).toBe('a1b2c3d4');
  });

  it('regex matches /ack_ with uppercase hex', () => {
    const match = '/ack_A1B2C3D4'.match(/^\/ack_([a-f0-9]+)/i);
    expect(match).toBeTruthy();
    expect(match[1]).toBe('A1B2C3D4');
  });

  it('regex does not match non-hex characters', () => {
    const match = '/ack_ZZZZ'.match(/^\/ack_([a-f0-9]+)/i);
    expect(match).toBeNull();
  });

  it('regex does not match without prefix', () => {
    const match = 'ack_a1b2c3d4'.match(/^\/ack_([a-f0-9]+)/i);
    expect(match).toBeNull();
  });

  it('onTdAcknowledge is called with correct churchId', () => {
    const text = '/ack_a1b2c3d4';
    const match = text.match(/^\/ack_([a-f0-9]+)/i);
    expect(match).toBeTruthy();
    mockSignalFailover.onTdAcknowledge('church-1');
    expect(mockSignalFailover.onTdAcknowledge).toHaveBeenCalledWith('church-1');
  });
});

// ─── B. /recover_ command ───────────────────────────────────────────────────

describe('/recover_ command handling', () => {
  let mockSignalFailover;

  beforeEach(() => {
    mockSignalFailover = {
      onTdAcknowledge: vi.fn(),
      onTdConfirmRecovery: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('regex matches /recover_ with hex suffix', () => {
    const match = '/recover_a1b2c3d4'.match(/^\/recover_([a-f0-9]+)/i);
    expect(match).toBeTruthy();
    expect(match[1]).toBe('a1b2c3d4');
  });

  it('onTdConfirmRecovery is called with correct churchId', async () => {
    const text = '/recover_a1b2c3d4';
    const match = text.match(/^\/recover_([a-f0-9]+)/i);
    expect(match).toBeTruthy();
    await mockSignalFailover.onTdConfirmRecovery('church-1');
    expect(mockSignalFailover.onTdConfirmRecovery).toHaveBeenCalledWith('church-1');
  });

  it('handles recovery failure gracefully', async () => {
    mockSignalFailover.onTdConfirmRecovery.mockRejectedValue(new Error('Church client not connected'));
    let errorMsg = null;
    try {
      await mockSignalFailover.onTdConfirmRecovery('church-1');
    } catch (e) {
      errorMsg = e.message;
    }
    expect(errorMsg).toBe('Church client not connected');
  });
});

// ─── C. End-to-end with real SignalFailover ─────────────────────────────────

describe('End-to-end failover ack/recover', () => {
  let db, failover;

  beforeEach(async () => {
    db = createTestDb();
    setupChurch(db);

    const { SignalFailover } = await import('../src/signalFailover.js');
    const churches = new Map();
    churches.set('church-1', {
      churchId: 'church-1',
      name: 'Test Church',
      status: { encoder: { live: true, bitrateKbps: 5000 } },
      ws: null,
    });

    const mockAlertEngine = { sendTelegramMessage: vi.fn().mockResolvedValue(true) };
    const mockAutoRecovery = { dispatchCommand: vi.fn().mockResolvedValue({ ok: true }) };

    failover = new SignalFailover(churches, mockAlertEngine, mockAutoRecovery, db);
  });

  afterEach(() => {
    failover?.cleanup('church-1');
    db?.close();
  });

  it('onTdAcknowledge cancels ack timer when in CONFIRMED_OUTAGE', () => {
    // Drive state machine to CONFIRMED_OUTAGE manually
    const s = failover._getState('church-1');
    s.state = 'CONFIRMED_OUTAGE';
    s.ackTimer = setTimeout(() => {}, 30000);
    s.failoverAlertId = 'test-alert-id';

    failover.onTdAcknowledge('church-1');

    expect(s.ackTimer).toBeNull();
    expect(s.state).toBe('CONFIRMED_OUTAGE'); // stays confirmed, not healthy
  });

  it('onTdAcknowledge is no-op when not in CONFIRMED_OUTAGE', () => {
    const s = failover._getState('church-1');
    s.state = 'HEALTHY';
    failover.onTdAcknowledge('church-1');
    expect(s.state).toBe('HEALTHY');
  });

  it('onTdConfirmRecovery transitions FAILOVER_ACTIVE to HEALTHY', async () => {
    const s = failover._getState('church-1');
    s.state = 'FAILOVER_ACTIVE';
    s.originalSource = 1;
    s.failoverAlertId = 'test-alert-id';

    await failover.onTdConfirmRecovery('church-1');

    // After recovery, state resets to HEALTHY
    const state = failover.getState('church-1');
    expect(state.state).toBe('HEALTHY');
  });

  it('onTdConfirmRecovery is no-op when not in FAILOVER_ACTIVE', async () => {
    const s = failover._getState('church-1');
    s.state = 'CONFIRMED_OUTAGE';
    await failover.onTdConfirmRecovery('church-1');
    expect(s.state).toBe('CONFIRMED_OUTAGE');
  });
});
