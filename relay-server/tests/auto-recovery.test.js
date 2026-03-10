import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { AutoRecovery, RECOVERY_PLAYBOOK } from '../src/autoRecovery.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createTestDb(opts = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      auto_recovery_enabled INTEGER DEFAULT 1
    )
  `);
  return db;
}

function addChurch(db, churchId, enabled = 1) {
  db.prepare('INSERT INTO churches (churchId, name, auto_recovery_enabled) VALUES (?, ?, ?)')
    .run(churchId, 'Test Church', enabled);
}

function makeChurch(churchId = 'church-1') {
  return { churchId, name: 'Test Church', ws: null, status: {} };
}

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
    const r1 = await recovery.attempt(church, 'stream_stopped', {});
    const r2 = await recovery.attempt(church, 'stream_stopped', {});
    const r3 = await recovery.attempt(church, 'stream_stopped', {});
    expect(r1.attempted).toBe(true);
    expect(r2.attempted).toBe(true);
    expect(r3.attempted).toBe(true);
    expect(r3.reason).toBe('no_auto_command');
  });

  it('returns max_attempts_exceeded after 3', async () => {
    const church = makeChurch();
    await recovery.attempt(church, 'atem_disconnected', {});
    await recovery.attempt(church, 'atem_disconnected', {});
    await recovery.attempt(church, 'atem_disconnected', {});
    const r4 = await recovery.attempt(church, 'atem_disconnected', {});
    expect(r4.attempted).toBe(true);
    expect(r4.success).toBe(false);
    expect(r4.reason).toBe('max_attempts_exceeded');
  });

  it('tracks different failure types independently', async () => {
    const church = makeChurch();
    // 3 atem_disconnected
    await recovery.attempt(church, 'atem_disconnected', {});
    await recovery.attempt(church, 'atem_disconnected', {});
    await recovery.attempt(church, 'atem_disconnected', {});
    const r4 = await recovery.attempt(church, 'atem_disconnected', {});
    expect(r4.reason).toBe('max_attempts_exceeded');

    // stream_stopped still at 0 attempts
    const rStream = await recovery.attempt(church, 'stream_stopped', {});
    expect(rStream.reason).toBe('no_auto_command');
  });

  it('resetAttempts clears specific failure type', async () => {
    const church = makeChurch();
    await recovery.attempt(church, 'stream_stopped', {});
    await recovery.attempt(church, 'stream_stopped', {});
    await recovery.attempt(church, 'stream_stopped', {});
    const r4 = await recovery.attempt(church, 'stream_stopped', {});
    expect(r4.reason).toBe('max_attempts_exceeded');

    recovery.resetAttempts('church-1', 'stream_stopped');
    const r5 = await recovery.attempt(church, 'stream_stopped', {});
    expect(r5.reason).toBe('no_auto_command');
  });

  it('clearAllAttempts clears all failure types for a church', async () => {
    const church = makeChurch();
    await recovery.attempt(church, 'stream_stopped', {});
    await recovery.attempt(church, 'atem_disconnected', {});

    recovery.clearAllAttempts('church-1');

    // Both should be reset — first attempt again
    const r1 = await recovery.attempt(church, 'stream_stopped', {});
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
    expect(result.attempted).toBe(true);
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

  it('has exactly 23 playbook entries', () => {
    expect(Object.keys(RECOVERY_PLAYBOOK)).toHaveLength(23);
  });

  it('only failover_confirmed_outage uses execute_failover', () => {
    const failoverEntries = Object.entries(RECOVERY_PLAYBOOK).filter(
      ([, v]) => v.onFail === 'execute_failover'
    );
    expect(failoverEntries).toHaveLength(1);
    expect(failoverEntries[0][0]).toBe('failover_confirmed_outage');
  });
});
