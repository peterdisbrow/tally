import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EncoderRecoveryManager,
  BACKOFF_DELAYS,
  MAX_TOTAL_ATTEMPTS,
  MIN_RESTART_INTERVAL_MS,
  STABLE_THRESHOLD_MS,
} from '../src/encoderRecovery.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createManager(nowFn) {
  let time = 1000000;
  const now = nowFn || (() => time);
  const mgr = new EncoderRecoveryManager({ now });
  // Expose time control for tests
  mgr._time = { get: () => time, set: (t) => { time = t; }, advance: (ms) => { time += ms; } };
  return mgr;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EncoderRecoveryManager', () => {

  describe('attemptRecovery — exponential backoff', () => {
    it('attempt 1 restarts with 5s backoff', async () => {
      const mgr = createManager();
      const result = await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');

      expect(result.attempted).toBe(true);
      expect(result.success).toBe(true);
      expect(result.action).toBe('restart');
      expect(result.attempt).toBe(1);
      expect(result.delay).toBe(5000);
    });

    it('attempt 2 restarts with 15s backoff', async () => {
      const mgr = createManager();
      await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');
      mgr._time.advance(MIN_RESTART_INTERVAL_MS); // respect rate limit
      const result = await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');

      expect(result.attempt).toBe(2);
      expect(result.action).toBe('restart');
      expect(result.delay).toBe(15000);
    });

    it('attempt 3 restarts with 30s backoff', async () => {
      const mgr = createManager();
      await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');
      mgr._time.advance(MIN_RESTART_INTERVAL_MS);
      await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');
      mgr._time.advance(MIN_RESTART_INTERVAL_MS);
      const result = await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');

      expect(result.attempt).toBe(3);
      expect(result.action).toBe('restart');
      expect(result.delay).toBe(30000);
    });

    it('attempt 4 escalates when no backup configured', async () => {
      const mgr = createManager();
      for (let i = 0; i < 3; i++) {
        await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');
        mgr._time.advance(MIN_RESTART_INTERVAL_MS);
      }
      const result = await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');

      expect(result.attempt).toBe(4);
      expect(result.action).toBe('escalated');
      expect(result.success).toBe(false);
      expect(result.reason).toContain('No backup encoder configured');
    });

    it('attempt 4 switches to backup when configured', async () => {
      const mgr = createManager();
      mgr.registerBackupEncoder('church-1', 'enc-1', 'enc-backup');

      for (let i = 0; i < 3; i++) {
        await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');
        mgr._time.advance(MIN_RESTART_INTERVAL_MS);
      }
      const result = await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');

      expect(result.attempt).toBe(4);
      expect(result.action).toBe('switched_to_backup');
      expect(result.success).toBe(true);
      expect(result.backupId).toBe('enc-backup');
    });
  });

  describe('max attempts safety', () => {
    it('stops after MAX_TOTAL_ATTEMPTS and escalates', async () => {
      const mgr = createManager();
      mgr.registerBackupEncoder('church-1', 'enc-1', 'enc-backup');

      for (let i = 0; i < MAX_TOTAL_ATTEMPTS; i++) {
        mgr._time.advance(MIN_RESTART_INTERVAL_MS);
        await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');
      }

      // Next attempt should be refused
      mgr._time.advance(MIN_RESTART_INTERVAL_MS);
      const result = await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');

      expect(result.attempted).toBe(false);
      expect(result.action).toBe('already_escalated');
    });

    it('escalates at attempt 5 when backup already active', async () => {
      const mgr = createManager();
      mgr.registerBackupEncoder('church-1', 'enc-1', 'enc-backup');

      // Run through all 5 attempts
      const results = [];
      for (let i = 0; i < MAX_TOTAL_ATTEMPTS; i++) {
        mgr._time.advance(MIN_RESTART_INTERVAL_MS);
        results.push(await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected'));
      }

      // Attempts 1-3 are restarts, 4 is backup switch, 5 is backup switch (already active) → escalate
      expect(results[0].action).toBe('restart');
      expect(results[1].action).toBe('restart');
      expect(results[2].action).toBe('restart');
      expect(results[3].action).toBe('switched_to_backup');
      // Attempt 5: backup already active → switch fails → escalated
      expect(results[4].action).toBe('backup_switch_failed');
    });
  });

  describe('rate limiting', () => {
    it('prevents restarts faster than 5s apart', async () => {
      const mgr = createManager();
      await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');

      // Try again immediately (no time advance)
      const result = await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');

      expect(result.attempted).toBe(false);
      expect(result.action).toBe('rate_limited');
      expect(result.reason).toContain('5s');
    });

    it('allows restart after 5s cooldown', async () => {
      const mgr = createManager();
      await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');

      mgr._time.advance(MIN_RESTART_INTERVAL_MS);
      const result = await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');

      expect(result.attempted).toBe(true);
      expect(result.action).toBe('restart');
      expect(result.attempt).toBe(2);
    });

    it('rate limits per encoder independently', async () => {
      const mgr = createManager();
      await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');

      // Different encoder should not be rate limited
      const result = await mgr.attemptRecovery('church-1', 'enc-2', 'encoder_disconnected');
      expect(result.attempted).toBe(true);
      expect(result.action).toBe('restart');
    });
  });

  describe('registerBackupEncoder', () => {
    it('registers a backup and emits event', () => {
      const mgr = createManager();
      const events = [];
      mgr.on('backup_registered', (e) => events.push(e));

      mgr.registerBackupEncoder('church-1', 'enc-1', 'enc-backup');

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ churchId: 'church-1', primaryId: 'enc-1', backupId: 'enc-backup' });
    });
  });

  describe('switchToBackup', () => {
    it('switches to backup when configured', async () => {
      const mgr = createManager();
      mgr.registerBackupEncoder('church-1', 'enc-1', 'enc-backup');

      const result = await mgr.switchToBackup('church-1', 'enc-1');

      expect(result.switched).toBe(true);
      expect(result.backupId).toBe('enc-backup');
      expect(result.reason).toContain('enc-backup');
    });

    it('returns false when no backup configured', async () => {
      const mgr = createManager();
      const result = await mgr.switchToBackup('church-1', 'enc-1');

      expect(result.switched).toBe(false);
      expect(result.backupId).toBeNull();
      expect(result.reason).toContain('No backup');
    });

    it('returns false when backup already active', async () => {
      const mgr = createManager();
      mgr.registerBackupEncoder('church-1', 'enc-1', 'enc-backup');

      await mgr.switchToBackup('church-1', 'enc-1');
      const result = await mgr.switchToBackup('church-1', 'enc-1');

      expect(result.switched).toBe(false);
      expect(result.reason).toContain('already active');
    });

    it('emits backup_activated event', async () => {
      const mgr = createManager();
      mgr.registerBackupEncoder('church-1', 'enc-1', 'enc-backup');
      const events = [];
      mgr.on('backup_activated', (e) => events.push(e));

      await mgr.switchToBackup('church-1', 'enc-1');

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ churchId: 'church-1', primaryId: 'enc-1', backupId: 'enc-backup' });
    });
  });

  describe('switchBack', () => {
    it('requires backup to be active', () => {
      const mgr = createManager();
      const result = mgr.switchBack('church-1', 'enc-1');

      expect(result.switchedBack).toBe(false);
      expect(result.reason).toContain('not currently active');
    });

    it('marks primary stable on first call, requires 2 min wait', async () => {
      const mgr = createManager();
      mgr.registerBackupEncoder('church-1', 'enc-1', 'enc-backup');
      await mgr.switchToBackup('church-1', 'enc-1');

      const result = mgr.switchBack('church-1', 'enc-1');

      expect(result.switchedBack).toBe(false);
      expect(result.reason).toContain('2 min');
    });

    it('rejects switchback before 2 min stable', async () => {
      const mgr = createManager();
      mgr.registerBackupEncoder('church-1', 'enc-1', 'enc-backup');
      await mgr.switchToBackup('church-1', 'enc-1');

      mgr.switchBack('church-1', 'enc-1'); // marks stable
      mgr._time.advance(60_000); // only 1 min

      const result = mgr.switchBack('church-1', 'enc-1');
      expect(result.switchedBack).toBe(false);
      expect(result.reason).toContain('remaining');
    });

    it('allows switchback after 2 min stable', async () => {
      const mgr = createManager();
      mgr.registerBackupEncoder('church-1', 'enc-1', 'enc-backup');
      await mgr.switchToBackup('church-1', 'enc-1');

      mgr.switchBack('church-1', 'enc-1'); // marks stable
      mgr._time.advance(STABLE_THRESHOLD_MS); // 2 min

      const result = mgr.switchBack('church-1', 'enc-1');
      expect(result.switchedBack).toBe(true);
      expect(result.reason).toContain('primary');
    });

    it('emits backup_deactivated event on switchback', async () => {
      const mgr = createManager();
      mgr.registerBackupEncoder('church-1', 'enc-1', 'enc-backup');
      await mgr.switchToBackup('church-1', 'enc-1');
      const events = [];
      mgr.on('backup_deactivated', (e) => events.push(e));

      mgr.switchBack('church-1', 'enc-1');
      mgr._time.advance(STABLE_THRESHOLD_MS);
      mgr.switchBack('church-1', 'enc-1');

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ churchId: 'church-1', primaryId: 'enc-1', backupId: 'enc-backup' });
    });

    it('resets recovery state for primary after switchback', async () => {
      const mgr = createManager();
      mgr.registerBackupEncoder('church-1', 'enc-1', 'enc-backup');

      // Run through some recovery attempts
      await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');
      mgr._time.advance(MIN_RESTART_INTERVAL_MS);

      await mgr.switchToBackup('church-1', 'enc-1');
      mgr.switchBack('church-1', 'enc-1');
      mgr._time.advance(STABLE_THRESHOLD_MS);
      mgr.switchBack('church-1', 'enc-1');

      // Recovery state should be cleared — next attempt starts at 1
      const result = await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');
      expect(result.attempt).toBe(1);
    });

    it('rejects mismatched primary ID', async () => {
      const mgr = createManager();
      mgr.registerBackupEncoder('church-1', 'enc-1', 'enc-backup');
      await mgr.switchToBackup('church-1', 'enc-1');

      const result = mgr.switchBack('church-1', 'enc-wrong');
      expect(result.switchedBack).toBe(false);
      expect(result.reason).toContain('does not match');
    });
  });

  describe('getRecoveryStatus', () => {
    it('returns empty status for unknown church', () => {
      const mgr = createManager();
      const status = mgr.getRecoveryStatus('church-unknown');

      expect(status.activeRecoveries).toEqual([]);
      expect(status.backupActive).toBe(false);
      expect(status.primaryStable).toBe(false);
    });

    it('shows active recoveries', async () => {
      const mgr = createManager();
      await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');

      const status = mgr.getRecoveryStatus('church-1');

      expect(status.activeRecoveries).toHaveLength(1);
      expect(status.activeRecoveries[0].encoderId).toBe('enc-1');
      expect(status.activeRecoveries[0].attemptCount).toBe(1);
      expect(status.activeRecoveries[0].escalated).toBe(false);
    });

    it('shows backup active status', async () => {
      const mgr = createManager();
      mgr.registerBackupEncoder('church-1', 'enc-1', 'enc-backup');
      await mgr.switchToBackup('church-1', 'enc-1');

      const status = mgr.getRecoveryStatus('church-1');
      expect(status.backupActive).toBe(true);
    });

    it('shows primary stable after threshold', async () => {
      const mgr = createManager();
      mgr.registerBackupEncoder('church-1', 'enc-1', 'enc-backup');
      await mgr.switchToBackup('church-1', 'enc-1');
      mgr.switchBack('church-1', 'enc-1'); // marks stable

      expect(mgr.getRecoveryStatus('church-1').primaryStable).toBe(false);

      mgr._time.advance(STABLE_THRESHOLD_MS);
      expect(mgr.getRecoveryStatus('church-1').primaryStable).toBe(true);
    });

    it('isolates churches from each other', async () => {
      const mgr = createManager();
      await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');
      mgr._time.advance(MIN_RESTART_INTERVAL_MS);
      await mgr.attemptRecovery('church-2', 'enc-2', 'encoder_disconnected');

      expect(mgr.getRecoveryStatus('church-1').activeRecoveries).toHaveLength(1);
      expect(mgr.getRecoveryStatus('church-1').activeRecoveries[0].encoderId).toBe('enc-1');
      expect(mgr.getRecoveryStatus('church-2').activeRecoveries).toHaveLength(1);
      expect(mgr.getRecoveryStatus('church-2').activeRecoveries[0].encoderId).toBe('enc-2');
    });
  });

  describe('getRecoveryHistory', () => {
    it('returns empty array for unknown church', () => {
      const mgr = createManager();
      expect(mgr.getRecoveryHistory('church-unknown')).toEqual([]);
    });

    it('returns history newest first', async () => {
      const mgr = createManager();
      await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');
      mgr._time.advance(MIN_RESTART_INTERVAL_MS);
      await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');

      const history = mgr.getRecoveryHistory('church-1');
      expect(history).toHaveLength(2);
      expect(history[0].attempt).toBe(2);
      expect(history[1].attempt).toBe(1);
    });

    it('respects limit parameter', async () => {
      const mgr = createManager();
      for (let i = 0; i < 5; i++) {
        mgr._time.advance(MIN_RESTART_INTERVAL_MS);
        await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');
      }

      const history = mgr.getRecoveryHistory('church-1', 3);
      expect(history).toHaveLength(3);
    });

    it('filters by church', async () => {
      const mgr = createManager();
      await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');
      mgr._time.advance(MIN_RESTART_INTERVAL_MS);
      await mgr.attemptRecovery('church-2', 'enc-2', 'encoder_disconnected');

      const history = mgr.getRecoveryHistory('church-1');
      expect(history).toHaveLength(1);
      expect(history[0].churchId).toBe('church-1');
    });

    it('records timestamps', async () => {
      const mgr = createManager();
      await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');

      const history = mgr.getRecoveryHistory('church-1');
      expect(history[0].timestamp).toBeDefined();
      expect(typeof history[0].timestamp).toBe('number');
    });
  });

  describe('tracking metrics', () => {
    it('tracks time to recovery (startedAt on first attempt)', async () => {
      const mgr = createManager();
      const startTime = mgr._time.get();
      await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');

      const status = mgr.getRecoveryStatus('church-1');
      expect(status.activeRecoveries[0].startedAt).toBe(startTime);
    });

    it('tracks success and failure per attempt in history', async () => {
      const mgr = createManager();
      mgr.registerBackupEncoder('church-1', 'enc-1', 'enc-backup');

      // Restarts (successes)
      for (let i = 0; i < 3; i++) {
        mgr._time.advance(MIN_RESTART_INTERVAL_MS);
        await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');
      }
      // Backup switch
      mgr._time.advance(MIN_RESTART_INTERVAL_MS);
      await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');

      const history = mgr.getRecoveryHistory('church-1');
      // All restarts marked success (command issued successfully)
      const restarts = history.filter(h => h.action === 'restart');
      expect(restarts.every(r => r.success === true)).toBe(true);
      // Backup switch
      const backupSwitch = history.find(h => h.action === 'switched_to_backup');
      expect(backupSwitch.success).toBe(true);
    });

    it('records backup activation/deactivation events in history', async () => {
      const mgr = createManager();
      mgr.registerBackupEncoder('church-1', 'enc-1', 'enc-backup');

      await mgr.switchToBackup('church-1', 'enc-1');
      mgr.switchBack('church-1', 'enc-1');
      mgr._time.advance(STABLE_THRESHOLD_MS);
      mgr.switchBack('church-1', 'enc-1');

      const history = mgr.getRecoveryHistory('church-1');
      const actions = history.map(h => h.action);
      expect(actions).toContain('backup_activated');
      expect(actions).toContain('switched_back_to_primary');
    });
  });

  describe('events', () => {
    it('emits restart_issued on restart attempt', async () => {
      const mgr = createManager();
      const events = [];
      mgr.on('restart_issued', (e) => events.push(e));

      await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');

      expect(events).toHaveLength(1);
      expect(events[0].attempt).toBe(1);
      expect(events[0].delay).toBe(5000);
    });

    it('emits escalated when max attempts hit', async () => {
      const mgr = createManager();
      const events = [];
      mgr.on('escalated', (e) => events.push(e));

      for (let i = 0; i < 4; i++) {
        mgr._time.advance(MIN_RESTART_INTERVAL_MS);
        await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');
      }

      expect(events).toHaveLength(1);
      expect(events[0].churchId).toBe('church-1');
      expect(events[0].encoderId).toBe('enc-1');
    });

    it('emits failover_attempted when switching to backup', async () => {
      const mgr = createManager();
      mgr.registerBackupEncoder('church-1', 'enc-1', 'enc-backup');
      const events = [];
      mgr.on('failover_attempted', (e) => events.push(e));

      for (let i = 0; i < 3; i++) {
        mgr._time.advance(MIN_RESTART_INTERVAL_MS);
        await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');
      }
      mgr._time.advance(MIN_RESTART_INTERVAL_MS);
      await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');

      expect(events).toHaveLength(1);
      expect(events[0].switched).toBe(true);
      expect(events[0].backupId).toBe('enc-backup');
    });
  });

  describe('resetChurch', () => {
    it('clears all state for a church', async () => {
      const mgr = createManager();
      mgr.registerBackupEncoder('church-1', 'enc-1', 'enc-backup');
      await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');
      await mgr.switchToBackup('church-1', 'enc-1');

      mgr.resetChurch('church-1');

      const status = mgr.getRecoveryStatus('church-1');
      expect(status.activeRecoveries).toEqual([]);
      expect(status.backupActive).toBe(false);
    });

    it('does not affect other churches', async () => {
      const mgr = createManager();
      await mgr.attemptRecovery('church-1', 'enc-1', 'encoder_disconnected');
      mgr._time.advance(MIN_RESTART_INTERVAL_MS);
      await mgr.attemptRecovery('church-2', 'enc-2', 'encoder_disconnected');

      mgr.resetChurch('church-1');

      expect(mgr.getRecoveryStatus('church-1').activeRecoveries).toEqual([]);
      expect(mgr.getRecoveryStatus('church-2').activeRecoveries).toHaveLength(1);
    });
  });

  describe('exported constants', () => {
    it('BACKOFF_DELAYS matches spec', () => {
      expect(BACKOFF_DELAYS).toEqual([5000, 15000, 30000]);
    });

    it('MAX_TOTAL_ATTEMPTS is 5', () => {
      expect(MAX_TOTAL_ATTEMPTS).toBe(5);
    });

    it('MIN_RESTART_INTERVAL_MS is 5000', () => {
      expect(MIN_RESTART_INTERVAL_MS).toBe(5000);
    });

    it('STABLE_THRESHOLD_MS is 2 minutes', () => {
      expect(STABLE_THRESHOLD_MS).toBe(120000);
    });
  });
});
