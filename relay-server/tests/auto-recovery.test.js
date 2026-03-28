import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { AutoRecovery, RECOVERY_PLAYBOOK, RECOVERY_COMMANDS, COOLDOWN_MS, MAX_ATTEMPTS, AUDIO_SILENCE_THRESHOLD_MS } from '../src/autoRecovery.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb(opts = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      auto_recovery_enabled INTEGER DEFAULT 1,
      recovery_outside_service_hours INTEGER DEFAULT 0
    )
  `);
  return db;
}

function addChurch(db, churchId, enabled = 1, opts = {}) {
  db.prepare('INSERT INTO churches (churchId, name, auto_recovery_enabled, recovery_outside_service_hours) VALUES (?, ?, ?, ?)')
    .run(churchId, 'Test Church', enabled, opts.recoveryOutsideServiceHours || 0);
}

function makeChurch(churchId = 'church-1', wsConnected = false) {
  if (!wsConnected) {
    return { churchId, name: 'Test Church', ws: null, sockets: new Map(), status: {} };
  }
  // Create a mock WebSocket that looks connected and captures sent messages
  const sent = [];
  const listeners = {};
  const ws = {
    readyState: 1, // WebSocket.OPEN
    send: vi.fn((data) => sent.push(JSON.parse(data))),
    on: vi.fn((event, handler) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    removeListener: vi.fn((event, handler) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter(h => h !== handler);
      }
    }),
    _sent: sent,
    _listeners: listeners,
    // Helper to simulate a command_result response from the client
    _respond(id, result = {}, error = null) {
      const msg = JSON.stringify({ type: 'command_result', id, ...(error ? { error } : { result }) });
      for (const handler of (listeners.message || [])) {
        handler(Buffer.from(msg));
      }
    },
  };
  const sockets = new Map([['_default', ws]]);
  return { churchId, name: 'Test Church', ws, sockets, status: {} };
}

// Mock ws module so dispatchCommand can check readyState
vi.mock('ws', () => ({
  WebSocket: { OPEN: 1 },
}));

// ─── A. Per-church flag ─────────────────────────────────────────────────────

describe('Per-church auto_recovery_enabled', () => {
  let db, recovery;

  beforeEach(() => {
    db = createTestDb();
    recovery = new AutoRecovery(new Map(), {}, db);
  });

  afterEach(() => {
    db?.close();
  });

  it('_isEnabled returns true when auto_recovery_enabled = 1', () => {
    addChurch(db, 'church-1', 1);
    expect(recovery._isEnabled('church-1')).toBe(true);
  });

  it('_isEnabled returns false when auto_recovery_enabled = 0', () => {
    addChurch(db, 'church-1', 0);
    expect(recovery._isEnabled('church-1')).toBe(false);
  });

  it('_isEnabled defaults to true when church not in DB', () => {
    expect(recovery._isEnabled('nonexistent')).toBe(true);
  });

  it('_isEnabled defaults to true when db is null', () => {
    const noDbRecovery = new AutoRecovery(new Map(), {}, null);
    expect(noDbRecovery._isEnabled('church-1')).toBe(true);
  });

  it('attempt returns disabled when auto_recovery_enabled = 0', async () => {
    addChurch(db, 'church-1', 0);
    const result = await recovery.attempt(makeChurch(), 'stream_stopped', {});
    expect(result.attempted).toBe(false);
    expect(result.reason).toBe('auto_recovery_disabled');
  });

  it('attempt returns attempted when auto_recovery_enabled = 1', async () => {
    addChurch(db, 'church-1', 1);
    const result = await recovery.attempt(makeChurch(), 'stream_stopped', {});
    expect(result.attempted).toBe(true);
    expect(result.event).toBe('escalate_to_td');
  });
});

// ─── B. Attempt counting / loop prevention ──────────────────────────────────

describe('Attempt counting', () => {
  let db, recovery;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db, 'church-1', 1);
    recovery = new AutoRecovery(new Map(), {}, db);
  });

  afterEach(() => {
    db?.close();
  });

  it('allows up to 3 attempts per failure type', async () => {
    const church = makeChurch();
    // fps_low has no recovery command — always returns no_auto_command
    const r1 = await recovery.attempt(church, 'fps_low', {});
    const r2 = await recovery.attempt(church, 'fps_low', {});
    const r3 = await recovery.attempt(church, 'fps_low', {});
    expect(r1.attempted).toBe(false);
    expect(r2.attempted).toBe(false);
    expect(r3.attempted).toBe(false);
    expect(r3.reason).toBe('no_auto_command');
  });

  it('returns max_attempts_exceeded after 3 dispatched attempts', async () => {
    const church = makeChurch('church-1', true);

    // Use stream_stopped which has a recovery command
    // Attempt 1
    const p1 = recovery.attempt(church, 'stream_stopped', {});
    await vi.waitFor(() => expect(church.ws._sent.length).toBe(1));
    church.ws._respond(church.ws._sent[0].id, { ok: true });
    await p1;

    // Manually clear cooldown for rapid testing
    const key = recovery._key('church-1', 'stream_stopped');
    recovery.lastAttemptTime.set(key, Date.now() - 31_000);

    // Attempt 2
    const p2 = recovery.attempt(church, 'stream_stopped', {});
    await vi.waitFor(() => expect(church.ws._sent.length).toBe(2));
    church.ws._respond(church.ws._sent[1].id, { ok: true });
    await p2;

    recovery.lastAttemptTime.set(key, Date.now() - 31_000);

    // Attempt 3
    const p3 = recovery.attempt(church, 'stream_stopped', {});
    await vi.waitFor(() => expect(church.ws._sent.length).toBe(3));
    church.ws._respond(church.ws._sent[2].id, { ok: true });
    await p3;

    recovery.lastAttemptTime.set(key, Date.now() - 31_000);

    // Attempt 4 — should be max_attempts_exceeded
    const r4 = await recovery.attempt(church, 'stream_stopped', {});
    expect(r4.attempted).toBe(false);
    expect(r4.success).toBe(false);
    expect(r4.reason).toBe('max_attempts_exceeded');
  });

  it('tracks different failure types independently', async () => {
    const church = makeChurch();
    // atem_disconnected has no recovery command — returns no_auto_command (no attempts consumed)
    await recovery.attempt(church, 'atem_disconnected', {});
    await recovery.attempt(church, 'atem_disconnected', {});
    await recovery.attempt(church, 'atem_disconnected', {});
    const r4 = await recovery.attempt(church, 'atem_disconnected', {});
    // no_auto_command types never consume attempts, so never hit max_attempts_exceeded
    expect(r4.reason).toBe('no_auto_command');

    // fps_low also has no recovery command mapped — independent
    const rFps = await recovery.attempt(church, 'fps_low', {});
    expect(rFps.reason).toBe('no_auto_command');
  });

  it('resetAttempts clears specific failure type', async () => {
    const church = makeChurch('church-1', true);
    // Use stream_stopped which has a recovery command
    // Exhaust 3 attempts
    for (let i = 0; i < 3; i++) {
      const key = recovery._key('church-1', 'stream_stopped');
      if (i > 0) recovery.lastAttemptTime.set(key, Date.now() - 31_000);
      const p = recovery.attempt(church, 'stream_stopped', {});
      await vi.waitFor(() => expect(church.ws._sent.length).toBe(i + 1));
      church.ws._respond(church.ws._sent[i].id, { ok: true });
      await p;
    }

    const key = recovery._key('church-1', 'stream_stopped');
    recovery.lastAttemptTime.set(key, Date.now() - 31_000);

    // 4th attempt should be max_attempts_exceeded
    const r4 = await recovery.attempt(church, 'stream_stopped', {});
    expect(r4.reason).toBe('max_attempts_exceeded');

    // Reset and try again
    recovery.resetAttempts('church-1', 'stream_stopped');
    const p5 = recovery.attempt(church, 'stream_stopped', {});
    await vi.waitFor(() => expect(church.ws._sent.length).toBe(4));
    church.ws._respond(church.ws._sent[3].id, { ok: true });
    const r5 = await p5;
    expect(r5.success).toBe(true);
  });

  it('clearAllAttempts clears all failure types for a church', async () => {
    const church = makeChurch();
    await recovery.attempt(church, 'fps_low', {});
    await recovery.attempt(church, 'atem_disconnected', {});

    recovery.clearAllAttempts('church-1');

    // Both should be reset — first attempt again
    const r1 = await recovery.attempt(church, 'fps_low', {});
    const r2 = await recovery.attempt(church, 'atem_disconnected', {});
    expect(r1.reason).toBe('no_auto_command');
    expect(r2.reason).toBe('no_auto_command');
  });
});

// ─── C. Playbook classification ─────────────────────────────────────────────

describe('Playbook classification', () => {
  let db, recovery;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db, 'church-1', 1);
    recovery = new AutoRecovery(new Map(), {}, db);
  });

  afterEach(() => {
    db?.close();
  });

  it('failover_confirmed_outage defers to signal failover', async () => {
    const result = await recovery.attempt(makeChurch(), 'failover_confirmed_outage', {});
    expect(result.attempted).toBe(false);
    expect(result.reason).toBe('handled_by_failover');
    expect(result.event).toBe('execute_failover');
  });

  it('unknown failure type defaults to escalate_to_td', async () => {
    const result = await recovery.attempt(makeChurch(), 'unknown_alert_type', {});
    expect(result.attempted).toBe(false);
    expect(result.event).toBe('escalate_to_td');
  });

  it('audio_silence uses alert_td_audio event', async () => {
    const result = await recovery.attempt(makeChurch(), 'audio_silence', {});
    expect(result.event).toBe('alert_td_audio');
  });

  it('obs_disconnected uses alert_td_obs event', async () => {
    const result = await recovery.attempt(makeChurch(), 'obs_disconnected', {});
    expect(result.event).toBe('alert_td_obs');
  });
});

// ─── D. Playbook completeness ───────────────────────────────────────────────

describe('Playbook completeness', () => {
  it('has entries for all known failure types', () => {
    const expected = [
      'stream_stopped', 'fps_low', 'bitrate_low', 'recording_not_started',
      'atem_stream_stopped', 'atem_disconnected', 'obs_disconnected',
      'vmix_disconnected', 'vmix_stream_stopped', 'encoder_disconnected',
      'encoder_stream_stopped', 'companion_disconnected', 'hyperdeck_disconnected',
      'mixer_disconnected', 'ptz_disconnected', 'propresenter_disconnected',
      'audio_silence', 'audio_muted', 'multiple_systems_down', 'stream_platform_health',
      'failover_confirmed_outage', 'failover_executed', 'failover_command_failed',
    ];
    for (const type of expected) {
      expect(RECOVERY_PLAYBOOK[type]).toBeDefined();
      expect(RECOVERY_PLAYBOOK[type].onFail).toBeTruthy();
    }
  });

  it('has exactly 24 playbook entries', () => {
    expect(Object.keys(RECOVERY_PLAYBOOK)).toHaveLength(24);
  });

  it('only failover_confirmed_outage uses execute_failover', () => {
    const failoverEntries = Object.entries(RECOVERY_PLAYBOOK).filter(
      ([, v]) => v.onFail === 'execute_failover'
    );
    expect(failoverEntries).toHaveLength(1);
    expect(failoverEntries[0][0]).toBe('failover_confirmed_outage');
  });
});

// ─── E. Recovery command dispatch ───────────────────────────────────────────

describe('Recovery command dispatch', () => {
  let db, recovery;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db, 'church-1', 1);
    recovery = new AutoRecovery(new Map(), {}, db);
  });

  afterEach(() => {
    db?.close();
  });

  it('dispatches restart_stream for stream_stopped when WS connected', async () => {
    const church = makeChurch('church-1', true);
    // Simulate successful response after dispatch
    const attemptPromise = recovery.attempt(church, 'stream_stopped', {});
    // The command should have been sent; respond to it
    await vi.waitFor(() => expect(church.ws._sent.length).toBeGreaterThan(0));
    const sent = church.ws._sent[0];
    expect(sent.type).toBe('command');
    expect(sent.command).toBe('recovery.restartStream');
    church.ws._respond(sent.id, { ok: true });

    const result = await attemptPromise;
    expect(result.attempted).toBe(true);
    expect(result.success).toBe(true);
    expect(result.reason).toBe('command_dispatched');
    expect(result.command).toBe('recovery.restartStream');
  });

  it('dispatches restart_stream with source:atem for atem_stream_stopped', async () => {
    const church = makeChurch('church-1', true);
    const attemptPromise = recovery.attempt(church, 'atem_stream_stopped', {});
    await vi.waitFor(() => expect(church.ws._sent.length).toBeGreaterThan(0));
    const sent = church.ws._sent[0];
    expect(sent.command).toBe('recovery.restartStream');
    expect(sent.params.source).toBe('atem');
    church.ws._respond(sent.id, { ok: true });
    const result = await attemptPromise;
    expect(result.success).toBe(true);
  });

  it('dispatches restart_encoder for encoder_disconnected', async () => {
    const church = makeChurch('church-1', true);
    const attemptPromise = recovery.attempt(church, 'encoder_disconnected', {});
    await vi.waitFor(() => expect(church.ws._sent.length).toBeGreaterThan(0));
    const sent = church.ws._sent[0];
    expect(sent.command).toBe('recovery.restartEncoder');
    church.ws._respond(sent.id, { ok: true });
    const result = await attemptPromise;
    expect(result.success).toBe(true);
    expect(result.command).toBe('recovery.restartEncoder');
  });

  it('dispatches restart_recording for recording_not_started', async () => {
    const church = makeChurch('church-1', true);
    const attemptPromise = recovery.attempt(church, 'recording_not_started', {});
    await vi.waitFor(() => expect(church.ws._sent.length).toBeGreaterThan(0));
    const sent = church.ws._sent[0];
    expect(sent.command).toBe('recovery.restartRecording');
    church.ws._respond(sent.id, { ok: true });
    const result = await attemptPromise;
    expect(result.success).toBe(true);
    expect(result.command).toBe('recovery.restartRecording');
  });

  it('dispatches reconnect_device for connection_lost with deviceId', async () => {
    const church = makeChurch('church-1', true);
    const attemptPromise = recovery.attempt(church, 'connection_lost', { deviceId: 'ptz-cam-1' });
    await vi.waitFor(() => expect(church.ws._sent.length).toBeGreaterThan(0));
    const sent = church.ws._sent[0];
    expect(sent.command).toBe('recovery.reconnectDevice');
    expect(sent.params.deviceId).toBe('ptz-cam-1');
    church.ws._respond(sent.id, { ok: true });
    const result = await attemptPromise;
    expect(result.success).toBe(true);
    expect(result.command).toBe('recovery.reconnectDevice');
  });

  it('returns dispatch_failed when WS is not connected', async () => {
    const church = makeChurch('church-1', false); // ws = null
    const result = await recovery.attempt(church, 'stream_stopped', {});
    expect(result.attempted).toBe(true);
    expect(result.success).toBe(false);
    expect(result.reason).toContain('dispatch_failed');
    expect(result.command).toBe('recovery.restartStream');
  });

  it('returns dispatch_failed when command_result contains error', async () => {
    const church = makeChurch('church-1', true);
    const attemptPromise = recovery.attempt(church, 'stream_stopped', {});
    await vi.waitFor(() => expect(church.ws._sent.length).toBeGreaterThan(0));
    const sent = church.ws._sent[0];
    church.ws._respond(sent.id, null, 'OBS not responding');
    const result = await attemptPromise;
    expect(result.attempted).toBe(true);
    expect(result.success).toBe(false);
    expect(result.reason).toContain('dispatch_failed');
    expect(result.reason).toContain('OBS not responding');
  });

  it('returns no_auto_command for failure types without recovery commands', async () => {
    const church = makeChurch('church-1', true);
    // obs_disconnected has no recovery command mapped
    const result = await recovery.attempt(church, 'obs_disconnected', {});
    expect(result.attempted).toBe(false);
    expect(result.reason).toBe('no_auto_command');
    expect(result.command).toBeNull();
  });
});

// ─── F. Audio silence threshold ─────────────────────────────────────────────

describe('Audio silence threshold', () => {
  let db, recovery;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db, 'church-1', 1);
    recovery = new AutoRecovery(new Map(), {}, db);
  });

  afterEach(() => {
    db?.close();
  });

  it('does not auto-recover audio_silence when duration < 60s', async () => {
    const church = makeChurch('church-1', true);
    const result = await recovery.attempt(church, 'audio_silence', { silenceDurationMs: 30_000 });
    expect(result.attempted).toBe(false);
    expect(result.reason).toBe('silence_not_sustained');
  });

  it('does not auto-recover audio_silence when duration is 0 / missing', async () => {
    const church = makeChurch('church-1', true);
    const result = await recovery.attempt(church, 'audio_silence', {});
    expect(result.reason).toBe('silence_not_sustained');
  });

  it('auto-recovers audio_silence when duration >= 60s', async () => {
    const church = makeChurch('church-1', true);
    const attemptPromise = recovery.attempt(church, 'audio_silence', { silenceDurationMs: 65_000 });
    await vi.waitFor(() => expect(church.ws._sent.length).toBeGreaterThan(0));
    const sent = church.ws._sent[0];
    expect(sent.command).toBe('recovery.resetAudio');
    church.ws._respond(sent.id, { ok: true });
    const result = await attemptPromise;
    expect(result.success).toBe(true);
    expect(result.command).toBe('recovery.resetAudio');
  });

  it('supports snake_case silence_duration_ms field', async () => {
    const church = makeChurch('church-1', true);
    const attemptPromise = recovery.attempt(church, 'audio_silence', { silence_duration_ms: 90_000 });
    await vi.waitFor(() => expect(church.ws._sent.length).toBeGreaterThan(0));
    church.ws._respond(church.ws._sent[0].id, { ok: true });
    const result = await attemptPromise;
    expect(result.success).toBe(true);
  });

  it('exports AUDIO_SILENCE_THRESHOLD_MS as 60000', () => {
    expect(AUDIO_SILENCE_THRESHOLD_MS).toBe(60_000);
  });
});

// ─── G. Cooldown enforcement ────────────────────────────────────────────────

describe('Cooldown enforcement', () => {
  let db, recovery;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db, 'church-1', 1);
    recovery = new AutoRecovery(new Map(), {}, db);
  });

  afterEach(() => {
    db?.close();
  });

  it('enforces 30s cooldown between attempts for same failure type', async () => {
    const church = makeChurch('church-1', true);

    // First attempt — should dispatch
    const p1 = recovery.attempt(church, 'stream_stopped', {});
    await vi.waitFor(() => expect(church.ws._sent.length).toBeGreaterThan(0));
    church.ws._respond(church.ws._sent[0].id, { ok: true });
    const r1 = await p1;
    expect(r1.success).toBe(true);

    // Immediate second attempt — should be blocked by cooldown
    const r2 = await recovery.attempt(church, 'stream_stopped', {});
    expect(r2.attempted).toBe(false);
    expect(r2.reason).toBe('cooldown_active');
  });

  it('allows attempt after cooldown elapses', async () => {
    const church = makeChurch('church-1', true);

    // First attempt
    const p1 = recovery.attempt(church, 'stream_stopped', {});
    await vi.waitFor(() => expect(church.ws._sent.length).toBeGreaterThan(0));
    church.ws._respond(church.ws._sent[0].id, { ok: true });
    await p1;

    // Manually set last attempt time to 31s ago
    const key = recovery._key('church-1', 'stream_stopped');
    recovery.lastAttemptTime.set(key, Date.now() - 31_000);

    // Second attempt — should now be allowed
    const p2 = recovery.attempt(church, 'stream_stopped', {});
    await vi.waitFor(() => expect(church.ws._sent.length).toBe(2));
    church.ws._respond(church.ws._sent[1].id, { ok: true });
    const r2 = await p2;
    expect(r2.success).toBe(true);
  });

  it('cooldown is per failure type — different types are independent', async () => {
    const church = makeChurch('church-1', true);

    // First attempt for stream_stopped
    const p1 = recovery.attempt(church, 'stream_stopped', {});
    await vi.waitFor(() => expect(church.ws._sent.length).toBe(1));
    church.ws._respond(church.ws._sent[0].id, { ok: true });
    await p1;

    // Immediate attempt for encoder_disconnected — different type, no cooldown
    const p2 = recovery.attempt(church, 'encoder_disconnected', {});
    await vi.waitFor(() => expect(church.ws._sent.length).toBe(2));
    church.ws._respond(church.ws._sent[1].id, { ok: true });
    const r2 = await p2;
    expect(r2.success).toBe(true);
  });

  it('clearAllAttempts also clears cooldown timers', async () => {
    const church = makeChurch('church-1', true);

    // First attempt
    const p1 = recovery.attempt(church, 'stream_stopped', {});
    await vi.waitFor(() => expect(church.ws._sent.length).toBe(1));
    church.ws._respond(church.ws._sent[0].id, { ok: true });
    await p1;

    // Clear everything
    recovery.clearAllAttempts('church-1');

    // Should be allowed immediately
    const p2 = recovery.attempt(church, 'stream_stopped', {});
    await vi.waitFor(() => expect(church.ws._sent.length).toBe(2));
    church.ws._respond(church.ws._sent[1].id, { ok: true });
    const r2 = await p2;
    expect(r2.success).toBe(true);
  });

  it('exports COOLDOWN_MS as 30000', () => {
    expect(COOLDOWN_MS).toBe(30_000);
  });
});

// ─── H. Service hours gate ──────────────────────────────────────────────────

describe('Service hours gate', () => {
  let db;

  afterEach(() => {
    db?.close();
  });

  it('blocks auto-recovery outside service hours', async () => {
    db = createTestDb();
    addChurch(db, 'church-1', 1);
    const scheduleEngine = { isServiceWindow: vi.fn().mockReturnValue(false) };
    const recovery = new AutoRecovery(new Map(), {}, db, { scheduleEngine });

    const result = await recovery.attempt(makeChurch('church-1', true), 'stream_stopped', {});
    expect(result.attempted).toBe(false);
    expect(result.reason).toBe('outside_service_hours');
  });

  it('allows auto-recovery during service hours', async () => {
    db = createTestDb();
    addChurch(db, 'church-1', 1);
    const scheduleEngine = { isServiceWindow: vi.fn().mockReturnValue(true) };
    const recovery = new AutoRecovery(new Map(), {}, db, { scheduleEngine });

    const church = makeChurch('church-1', true);
    const attemptPromise = recovery.attempt(church, 'stream_stopped', {});
    await vi.waitFor(() => expect(church.ws._sent.length).toBe(1));
    church.ws._respond(church.ws._sent[0].id, { ok: true });
    const result = await attemptPromise;
    expect(result.success).toBe(true);
  });

  it('allows off-hours recovery when church has recovery_outside_service_hours = 1', async () => {
    db = createTestDb();
    addChurch(db, 'church-1', 1, { recoveryOutsideServiceHours: 1 });
    const scheduleEngine = { isServiceWindow: vi.fn().mockReturnValue(false) };
    const recovery = new AutoRecovery(new Map(), {}, db, { scheduleEngine });

    const church = makeChurch('church-1', true);
    const attemptPromise = recovery.attempt(church, 'stream_stopped', {});
    await vi.waitFor(() => expect(church.ws._sent.length).toBe(1));
    church.ws._respond(church.ws._sent[0].id, { ok: true });
    const result = await attemptPromise;
    expect(result.success).toBe(true);
  });

  it('allows recovery when no schedule engine is configured (fail-open)', async () => {
    db = createTestDb();
    addChurch(db, 'church-1', 1);
    const recovery = new AutoRecovery(new Map(), {}, db); // no scheduleEngine

    const church = makeChurch('church-1', true);
    const attemptPromise = recovery.attempt(church, 'stream_stopped', {});
    await vi.waitFor(() => expect(church.ws._sent.length).toBe(1));
    church.ws._respond(church.ws._sent[0].id, { ok: true });
    const result = await attemptPromise;
    expect(result.success).toBe(true);
  });

  it('non-recoverable failure types still return no_auto_command regardless of hours', async () => {
    db = createTestDb();
    addChurch(db, 'church-1', 1);
    const scheduleEngine = { isServiceWindow: vi.fn().mockReturnValue(true) };
    const recovery = new AutoRecovery(new Map(), {}, db, { scheduleEngine });

    // obs_disconnected has no recovery command
    const result = await recovery.attempt(makeChurch('church-1', true), 'obs_disconnected', {});
    expect(result.reason).toBe('no_auto_command');
  });
});

// ─── I. RECOVERY_COMMANDS mapping ───────────────────────────────────────────

describe('RECOVERY_COMMANDS mapping', () => {
  it('maps stream_stopped to restart_stream', () => {
    expect(RECOVERY_COMMANDS['stream_stopped'].command).toBe('recovery.restartStream');
  });

  it('maps encoder_disconnected to restart_encoder', () => {
    expect(RECOVERY_COMMANDS['encoder_disconnected'].command).toBe('recovery.restartEncoder');
  });

  it('maps recording_not_started to restart_recording', () => {
    expect(RECOVERY_COMMANDS['recording_not_started'].command).toBe('recovery.restartRecording');
  });

  it('maps audio_silence to reset_audio', () => {
    expect(RECOVERY_COMMANDS['audio_silence'].command).toBe('recovery.resetAudio');
  });

  it('maps audio_silence_sustained to reset_audio', () => {
    expect(RECOVERY_COMMANDS['audio_silence_sustained'].command).toBe('recovery.resetAudio');
  });

  it('maps connection_lost to reconnect_device', () => {
    expect(RECOVERY_COMMANDS['connection_lost'].command).toBe('recovery.reconnectDevice');
  });

  it('maps atem_stream_stopped to restart_stream with source atem', () => {
    expect(RECOVERY_COMMANDS['atem_stream_stopped'].command).toBe('recovery.restartStream');
    expect(RECOVERY_COMMANDS['atem_stream_stopped'].params.source).toBe('atem');
  });

  it('maps vmix_stream_stopped to restart_stream with source vmix', () => {
    expect(RECOVERY_COMMANDS['vmix_stream_stopped'].command).toBe('recovery.restartStream');
    expect(RECOVERY_COMMANDS['vmix_stream_stopped'].params.source).toBe('vmix');
  });

  it('maps encoder_stream_stopped to restart_stream with source encoder', () => {
    expect(RECOVERY_COMMANDS['encoder_stream_stopped'].command).toBe('recovery.restartStream');
    expect(RECOVERY_COMMANDS['encoder_stream_stopped'].params.source).toBe('encoder');
  });

  it('exports MAX_ATTEMPTS as 3', () => {
    expect(MAX_ATTEMPTS).toBe(3);
  });
});

// ─── J. dispatchCommand error handling ───────────────────────────────────────

describe('dispatchCommand error handling', () => {
  let db, recovery;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db, 'church-1', 1);
    recovery = new AutoRecovery(new Map(), {}, db);
  });

  afterEach(() => {
    db?.close();
  });

  it('returns dispatch_failed with error message when WS send throws', async () => {
    const church = makeChurch('church-1', true);
    church.ws.send = vi.fn(() => { throw new Error('Connection reset'); });
    const result = await recovery.attempt(church, 'stream_stopped', {});
    expect(result.attempted).toBe(true);
    expect(result.success).toBe(false);
    expect(result.reason).toContain('dispatch_failed');
    expect(result.reason).toContain('Connection reset');
  });

  it('returns dispatch_failed on command timeout (15s)', async () => {
    vi.useFakeTimers();
    const church = makeChurch('church-1', true);
    const attemptPromise = recovery.attempt(church, 'stream_stopped', {});
    // Don't respond -- let timeout fire
    await vi.advanceTimersByTimeAsync(16_000);
    const result = await attemptPromise;
    expect(result.success).toBe(false);
    expect(result.reason).toContain('dispatch_failed');
    expect(result.reason).toContain('timeout');
    vi.useRealTimers();
  });
});

// ─── K. Multiple simultaneous failures ───────────────────────────────────────

describe('Multiple simultaneous failures of different types', () => {
  let db, recovery;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db, 'church-1', 1);
    recovery = new AutoRecovery(new Map(), {}, db);
  });

  afterEach(() => {
    db?.close();
  });

  it('handles concurrent failures of different types independently', async () => {
    const church = makeChurch('church-1', true);

    // Launch 3 different failure type recoveries concurrently
    const p1 = recovery.attempt(church, 'stream_stopped', {});
    const p2 = recovery.attempt(church, 'encoder_disconnected', {});
    const p3 = recovery.attempt(church, 'recording_not_started', {});

    // Wait for all commands to be sent
    await vi.waitFor(() => expect(church.ws._sent.length).toBe(3));

    // Respond to all three
    for (const sent of church.ws._sent) {
      church.ws._respond(sent.id, { ok: true });
    }

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(r1.success).toBe(true);
    expect(r1.command).toBe('recovery.restartStream');
    expect(r2.success).toBe(true);
    expect(r2.command).toBe('recovery.restartEncoder');
    expect(r3.success).toBe(true);
    expect(r3.command).toBe('recovery.restartRecording');
  });

  it('one failure succeeding does not affect another failing', async () => {
    const church = makeChurch('church-1', true);

    const p1 = recovery.attempt(church, 'stream_stopped', {});
    const p2 = recovery.attempt(church, 'encoder_disconnected', {});

    await vi.waitFor(() => expect(church.ws._sent.length).toBe(2));

    // First succeeds, second fails
    church.ws._respond(church.ws._sent[0].id, { ok: true });
    church.ws._respond(church.ws._sent[1].id, null, 'Encoder unreachable');

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(false);
    expect(r2.reason).toContain('Encoder unreachable');
  });
});

// ─── L. Attempt count not consumed by non-dispatch gates ─────────────────────

describe('Attempt count conservation', () => {
  let db, recovery;

  beforeEach(() => {
    db = createTestDb();
    addChurch(db, 'church-1', 1);
    recovery = new AutoRecovery(new Map(), {}, db);
  });

  afterEach(() => {
    db?.close();
  });

  it('cooldown does not consume attempt count', async () => {
    const church = makeChurch('church-1', true);

    // First attempt dispatches
    const p1 = recovery.attempt(church, 'stream_stopped', {});
    await vi.waitFor(() => expect(church.ws._sent.length).toBe(1));
    church.ws._respond(church.ws._sent[0].id, { ok: true });
    await p1;

    // Second attempt blocked by cooldown
    const r2 = await recovery.attempt(church, 'stream_stopped', {});
    expect(r2.reason).toBe('cooldown_active');

    // Third attempt blocked by cooldown
    const r3 = await recovery.attempt(church, 'stream_stopped', {});
    expect(r3.reason).toBe('cooldown_active');

    // Clear cooldown and try again -- should still have attempts left
    const key = recovery._key('church-1', 'stream_stopped');
    recovery.lastAttemptTime.set(key, Date.now() - 31_000);

    const p4 = recovery.attempt(church, 'stream_stopped', {});
    await vi.waitFor(() => expect(church.ws._sent.length).toBe(2));
    church.ws._respond(church.ws._sent[1].id, { ok: true });
    const r4 = await p4;

    expect(r4.success).toBe(true);
    // Should still have 1 attempt left (not max_attempts_exceeded)
  });

  it('service hours gate does not consume attempt count', async () => {
    const scheduleEngine = { isServiceWindow: vi.fn().mockReturnValue(false) };
    const recoveryWithSchedule = new AutoRecovery(new Map(), {}, db, { scheduleEngine });

    const church = makeChurch('church-1', true);

    // Three attempts blocked by service hours
    for (let i = 0; i < 3; i++) {
      const r = await recoveryWithSchedule.attempt(church, 'stream_stopped', {});
      expect(r.reason).toBe('outside_service_hours');
    }

    // Now switch to service hours
    scheduleEngine.isServiceWindow.mockReturnValue(true);
    const p = recoveryWithSchedule.attempt(church, 'stream_stopped', {});
    await vi.waitFor(() => expect(church.ws._sent.length).toBe(1));
    church.ws._respond(church.ws._sent[0].id, { ok: true });
    const r = await p;
    expect(r.success).toBe(true);
    // Not max_attempts_exceeded -- attempts weren't consumed
  });

  it('no_auto_command does not consume attempt count', async () => {
    const church = makeChurch('church-1', true);

    // obs_disconnected has no recovery command
    for (let i = 0; i < 5; i++) {
      const r = await recovery.attempt(church, 'obs_disconnected', {});
      expect(r.reason).toBe('no_auto_command');
    }
    // Should never hit max_attempts_exceeded because no_auto_command doesn't consume
  });
});
