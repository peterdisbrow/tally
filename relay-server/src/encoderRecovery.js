/**
 * Encoder Recovery Manager — Intelligent encoder recovery with exponential backoff
 * and automatic failover to backup encoder.
 *
 * Recovery sequence per encoder:
 *   Attempt 1: restart encoder, wait 5s
 *   Attempt 2: restart encoder, wait 15s
 *   Attempt 3: restart encoder, wait 30s
 *   Attempt 4+: switch to backup encoder if configured, alert TD
 *
 * Safety:
 *   - Max 5 total attempts before giving up and escalating to TD
 *   - Minimum 5s between restart commands (prevent restart loops)
 *   - Requires 2 min stable before switching back to primary
 */

const EventEmitter = require('events');

/** Backoff delays per attempt (ms). Attempt 4+ triggers failover instead. */
const BACKOFF_DELAYS = [5000, 15000, 30000];

/** Maximum total recovery attempts before permanent escalation. */
const MAX_TOTAL_ATTEMPTS = 5;

/** Minimum interval between restart commands for the same encoder (ms). */
const MIN_RESTART_INTERVAL_MS = 5000;

/** Time primary must be stable before switching back from backup (ms). */
const STABLE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

class EncoderRecoveryManager extends EventEmitter {
  constructor(options = {}) {
    super();
    /** Map<"churchId:encoderId" → recoveryState> */
    this.recoveries = new Map();
    /** Map<"churchId:primaryId" → backupId> */
    this.backupMap = new Map();
    /** Array of all recovery history entries */
    this.history = [];
    /** Map<"churchId:encoderId" → timestamp> last restart command sent */
    this.lastRestartTime = new Map();
    /** Map<"churchId" → { backupActive, activeBackupId, primaryId, primaryStableAt }> */
    this.churchState = new Map();

    // Allow overriding timers for testing
    this._setTimeout = options.setTimeout || setTimeout;
    this._clearTimeout = options.clearTimeout || clearTimeout;
    this._now = options.now || (() => Date.now());
  }

  _key(churchId, encoderId) {
    return `${churchId}:${encoderId}`;
  }

  /**
   * Register a backup encoder mapping for a church.
   */
  registerBackupEncoder(churchId, primaryId, backupId) {
    const key = this._key(churchId, primaryId);
    this.backupMap.set(key, backupId);
    this.emit('backup_registered', { churchId, primaryId, backupId });
  }

  /**
   * Get the backup encoder ID for a primary, if configured.
   */
  _getBackupId(churchId, primaryId) {
    return this.backupMap.get(this._key(churchId, primaryId)) || null;
  }

  /**
   * Get or create recovery state for an encoder.
   */
  _getRecoveryState(churchId, encoderId) {
    const key = this._key(churchId, encoderId);
    if (!this.recoveries.has(key)) {
      this.recoveries.set(key, {
        churchId,
        encoderId,
        attemptCount: 0,
        attempts: [],
        startedAt: null,
        escalated: false,
        pendingTimer: null,
      });
    }
    return this.recoveries.get(key);
  }

  /**
   * Check if we can issue a restart (rate-limit: no more than once per 5s).
   */
  _canRestart(churchId, encoderId) {
    const key = this._key(churchId, encoderId);
    const last = this.lastRestartTime.get(key);
    if (!last) return true;
    return (this._now() - last) >= MIN_RESTART_INTERVAL_MS;
  }

  /**
   * Record a restart timestamp.
   */
  _recordRestart(churchId, encoderId) {
    this.lastRestartTime.set(this._key(churchId, encoderId), this._now());
  }

  /**
   * Add a history entry.
   */
  _addHistory(entry) {
    this.history.push({
      ...entry,
      timestamp: this._now(),
    });
  }

  /**
   * Attempt recovery for a failing encoder with exponential backoff.
   *
   * @param {string} churchId
   * @param {string} encoderId
   * @param {string} failureType — e.g. 'encoder_disconnected', 'encoder_stream_stopped'
   * @returns {Promise<{ attempted: boolean, success: boolean, action: string, attempt: number, reason: string }>}
   */
  async attemptRecovery(churchId, encoderId, failureType) {
    const state = this._getRecoveryState(churchId, encoderId);

    if (!state.startedAt) {
      state.startedAt = this._now();
    }

    // Already escalated — refuse further attempts
    if (state.escalated) {
      return {
        attempted: false,
        success: false,
        action: 'already_escalated',
        attempt: state.attemptCount,
        reason: 'Recovery already escalated to TD — no further automatic attempts',
      };
    }

    // Max total attempts exceeded — escalate permanently
    if (state.attemptCount >= MAX_TOTAL_ATTEMPTS) {
      state.escalated = true;
      const entry = {
        churchId,
        encoderId,
        failureType,
        attempt: state.attemptCount,
        action: 'escalated',
        success: false,
        reason: 'Max recovery attempts reached — escalating to TD',
      };
      this._addHistory(entry);
      state.attempts.push(entry);
      this.emit('escalated', { churchId, encoderId, failureType, attemptCount: state.attemptCount });
      return { attempted: true, ...entry };
    }

    // Rate-limit restarts
    if (!this._canRestart(churchId, encoderId)) {
      return {
        attempted: false,
        success: false,
        action: 'rate_limited',
        attempt: state.attemptCount,
        reason: 'Restart rate-limited — minimum 5s between restarts',
      };
    }

    state.attemptCount += 1;
    const attemptNum = state.attemptCount;

    // Attempts 1-3: restart with backoff
    if (attemptNum <= BACKOFF_DELAYS.length) {
      this._recordRestart(churchId, encoderId);
      const delay = BACKOFF_DELAYS[attemptNum - 1];

      const entry = {
        churchId,
        encoderId,
        failureType,
        attempt: attemptNum,
        action: 'restart',
        success: true,
        reason: `Restart command issued — backoff ${delay}ms before next attempt`,
        delay,
      };
      this._addHistory(entry);
      state.attempts.push(entry);

      this.emit('restart_issued', { churchId, encoderId, failureType, attempt: attemptNum, delay });

      return { attempted: true, ...entry };
    }

    // Attempt 4+: try failover to backup
    const backupId = this._getBackupId(churchId, encoderId);
    if (backupId) {
      const switchResult = await this.switchToBackup(churchId, encoderId);
      const entry = {
        churchId,
        encoderId,
        failureType,
        attempt: attemptNum,
        action: switchResult.switched ? 'switched_to_backup' : 'backup_switch_failed',
        success: switchResult.switched,
        reason: switchResult.reason,
        backupId: switchResult.backupId,
      };
      this._addHistory(entry);
      state.attempts.push(entry);

      if (!switchResult.switched && attemptNum >= MAX_TOTAL_ATTEMPTS) {
        state.escalated = true;
        this.emit('escalated', { churchId, encoderId, failureType, attemptCount: attemptNum });
      }

      this.emit('failover_attempted', { churchId, encoderId, backupId, switched: switchResult.switched });
      return { attempted: true, ...entry };
    }

    // No backup configured — escalate to TD
    state.escalated = true;
    const entry = {
      churchId,
      encoderId,
      failureType,
      attempt: attemptNum,
      action: 'escalated',
      success: false,
      reason: 'No backup encoder configured — escalating to TD',
    };
    this._addHistory(entry);
    state.attempts.push(entry);
    this.emit('escalated', { churchId, encoderId, failureType, attemptCount: attemptNum });
    return { attempted: true, ...entry };
  }

  /**
   * Switch to the backup encoder for a given primary.
   *
   * @param {string} churchId
   * @param {string} primaryId
   * @returns {{ switched: boolean, backupId: string|null, reason: string }}
   */
  async switchToBackup(churchId, primaryId) {
    const backupId = this._getBackupId(churchId, primaryId);

    if (!backupId) {
      return { switched: false, backupId: null, reason: 'No backup encoder configured' };
    }

    // Check if backup is already active
    const cs = this.churchState.get(churchId);
    if (cs && cs.backupActive && cs.activeBackupId === backupId) {
      return { switched: false, backupId, reason: 'Backup encoder already active' };
    }

    // Activate backup
    this.churchState.set(churchId, {
      backupActive: true,
      activeBackupId: backupId,
      primaryId,
      primaryStableAt: null,
    });

    this._addHistory({
      churchId,
      encoderId: primaryId,
      action: 'backup_activated',
      success: true,
      reason: `Switched from ${primaryId} to backup ${backupId}`,
      backupId,
    });

    this.emit('backup_activated', { churchId, primaryId, backupId });

    return { switched: true, backupId, reason: `Switched to backup encoder ${backupId}` };
  }

  /**
   * Switch back to primary encoder when it is stable again.
   * Requires the primary to have been stable for at least 2 minutes.
   *
   * @param {string} churchId
   * @param {string} primaryId
   * @returns {{ switchedBack: boolean, reason: string }}
   */
  switchBack(churchId, primaryId) {
    const cs = this.churchState.get(churchId);

    if (!cs || !cs.backupActive) {
      return { switchedBack: false, reason: 'Backup is not currently active' };
    }

    if (cs.primaryId !== primaryId) {
      return { switchedBack: false, reason: 'Primary ID does not match active failover' };
    }

    // Check stability requirement
    if (!cs.primaryStableAt) {
      // Mark as stable now, but require waiting
      cs.primaryStableAt = this._now();
      return { switchedBack: false, reason: 'Primary marked as stable — requires 2 min before switchback' };
    }

    const stableDuration = this._now() - cs.primaryStableAt;
    if (stableDuration < STABLE_THRESHOLD_MS) {
      const remaining = Math.ceil((STABLE_THRESHOLD_MS - stableDuration) / 1000);
      return { switchedBack: false, reason: `Primary not stable long enough — ${remaining}s remaining` };
    }

    // Primary is stable long enough — switch back
    const backupId = cs.activeBackupId;
    this.churchState.set(churchId, {
      backupActive: false,
      activeBackupId: null,
      primaryId,
      primaryStableAt: null,
    });

    // Reset recovery state for primary
    const key = this._key(churchId, primaryId);
    this.recoveries.delete(key);
    this.lastRestartTime.delete(key);

    this._addHistory({
      churchId,
      encoderId: primaryId,
      action: 'switched_back_to_primary',
      success: true,
      reason: `Switched back from backup ${backupId} to primary ${primaryId}`,
      backupId,
    });

    this.emit('backup_deactivated', { churchId, primaryId, backupId });

    return { switchedBack: true, reason: `Switched back to primary encoder ${primaryId}` };
  }

  /**
   * Get current recovery status for a church.
   *
   * @param {string} churchId
   * @returns {{ activeRecoveries: Array, backupActive: boolean, primaryStable: boolean }}
   */
  getRecoveryStatus(churchId) {
    const activeRecoveries = [];
    for (const [key, state] of this.recoveries.entries()) {
      if (key.startsWith(churchId + ':')) {
        activeRecoveries.push({
          encoderId: state.encoderId,
          attemptCount: state.attemptCount,
          escalated: state.escalated,
          startedAt: state.startedAt,
        });
      }
    }

    const cs = this.churchState.get(churchId);
    const backupActive = cs?.backupActive || false;
    const primaryStable = cs?.primaryStableAt
      ? (this._now() - cs.primaryStableAt) >= STABLE_THRESHOLD_MS
      : false;

    return { activeRecoveries, backupActive, primaryStable };
  }

  /**
   * Get recovery history for a church.
   *
   * @param {string} churchId
   * @param {number} limit — max entries to return (default 20)
   * @returns {Array} — past recovery attempts with outcomes, newest first
   */
  getRecoveryHistory(churchId, limit = 20) {
    return this.history
      .filter(h => h.churchId === churchId)
      .slice(-limit)
      .reverse();
  }

  /**
   * Reset all recovery state for a church (e.g. on session end).
   */
  resetChurch(churchId) {
    for (const key of [...this.recoveries.keys()]) {
      if (key.startsWith(churchId + ':')) {
        const state = this.recoveries.get(key);
        if (state.pendingTimer) this._clearTimeout(state.pendingTimer);
        this.recoveries.delete(key);
      }
    }
    for (const key of [...this.lastRestartTime.keys()]) {
      if (key.startsWith(churchId + ':')) {
        this.lastRestartTime.delete(key);
      }
    }
    this.churchState.delete(churchId);
  }
}

module.exports = {
  EncoderRecoveryManager,
  BACKOFF_DELAYS,
  MAX_TOTAL_ATTEMPTS,
  MIN_RESTART_INTERVAL_MS,
  STABLE_THRESHOLD_MS,
};
