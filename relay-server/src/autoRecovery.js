/**
 * Auto Recovery — Alert classification and recovery for known failure patterns
 *
 * Checks per-church auto_recovery_enabled flag. When enabled:
 * - Classifies alerts against the 24-type playbook
 * - Tracks attempt counts (max 3 per failure type per session)
 * - Returns enriched context to the alert engine for escalation
 * - Signal failover commands are handled by signalFailover.js (not here)
 */

const RECOVERY_PLAYBOOK = {
  'stream_stopped':            { onFail: 'escalate_to_td' },
  'fps_low':                   { onFail: 'alert_td_fps' },
  'bitrate_low':               { onFail: 'alert_td_bitrate' },
  'recording_not_started':     { onFail: 'alert_td_recording' },
  'atem_stream_stopped':       { onFail: 'escalate_to_td' },
  'atem_disconnected':         { onFail: 'escalate_to_td' },
  'obs_disconnected':          { onFail: 'alert_td_obs' },
  'vmix_disconnected':         { onFail: 'alert_td_vmix' },
  'vmix_stream_stopped':       { onFail: 'escalate_to_td' },
  'encoder_disconnected':      { onFail: 'alert_td_encoder' },
  'encoder_stream_stopped':    { onFail: 'escalate_to_td' },
  'companion_disconnected':    { onFail: 'alert_td_companion' },
  'hyperdeck_disconnected':    { onFail: 'alert_td_hyperdeck' },
  'mixer_disconnected':        { onFail: 'alert_td_mixer' },
  'ptz_disconnected':          { onFail: 'alert_td_ptz' },
  'propresenter_disconnected': { onFail: 'alert_td_propresenter' },
  'audio_silence':             { onFail: 'alert_td_audio' },
  'audio_muted':               { onFail: 'alert_td_audio' },
  'multiple_systems_down':     { onFail: 'escalate_to_td' },
  'stream_platform_health':    { onFail: 'escalate_to_td' },
  'failover_confirmed_outage': { onFail: 'execute_failover' },
  'failover_executed':         { onFail: 'escalate_to_td' },
  'failover_command_failed':   { onFail: 'escalate_to_td' },
};

class AutoRecovery {
  constructor(churches, alertEngine, db) {
    this.churches = churches;
    this.alertEngine = alertEngine;
    this.db = db || null;
    this.attemptCounts = new Map();
  }

  _key(churchId, failureType) {
    return `${churchId}:${failureType}`;
  }

  resetAttempts(churchId, failureType) {
    this.attemptCounts.delete(this._key(churchId, failureType));
  }

  /** Clear all attempt counts for a church (call on stream session end). */
  clearAllAttempts(churchId) {
    for (const key of this.attemptCounts.keys()) {
      if (key.startsWith(churchId + ':')) {
        this.attemptCounts.delete(key);
      }
    }
  }

  /**
   * Check per-church auto_recovery_enabled flag.
   * Defaults to enabled (fail-open — don't break alert flow).
   */
  _isEnabled(churchId) {
    try {
      const row = this.db?.prepare(
        'SELECT auto_recovery_enabled FROM churches WHERE churchId = ?'
      ).get(churchId);
      return row ? row.auto_recovery_enabled !== 0 : true;
    } catch {
      return true; // fail-open
    }
  }

  /**
   * Classify and attempt recovery for a failure.
   * @param {object} church — church runtime object
   * @param {string} failureType — alert type from client
   * @param {object} currentStatus — live status snapshot
   * @returns {{ attempted: boolean, success?: boolean, reason: string, command: string|null, event: string }}
   */
  async attempt(church, failureType, currentStatus) {
    const playbook = RECOVERY_PLAYBOOK[failureType];
    const event = playbook ? playbook.onFail : 'escalate_to_td';

    // Check per-church opt-in
    if (!this._isEnabled(church.churchId)) {
      return { attempted: false, reason: 'auto_recovery_disabled', command: null, event };
    }

    // Signal failover handles its own execution path — don't double-execute
    if (event === 'execute_failover') {
      return { attempted: false, reason: 'handled_by_failover', command: null, event };
    }

    // Track attempts per failure type to prevent loops
    const key = this._key(church.churchId, failureType);
    const count = (this.attemptCounts.get(key) || 0) + 1;
    this.attemptCounts.set(key, count);

    // Max 3 attempts per failure type per session — after that, always escalate
    if (count > 3) {
      return { attempted: true, success: false, reason: 'max_attempts_exceeded', command: null, event };
    }

    // Classified alert — escalate to TD with enriched playbook context
    return { attempted: true, success: false, reason: 'no_auto_command', command: null, event };
  }

  /** Dispatch a command to the church client via WebSocket. */
  async dispatchCommand(church, command, params) {
    const { WebSocket } = require('ws');
    if (!church.ws || church.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Church client not connected');
    }
    const { v4: uuidv4 } = require('uuid');
    const id = uuidv4();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Command timeout (15s)'));
      }, 15000);

      const handler = (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'command_result' && msg.id === id) {
            clearTimeout(timeout);
            church.ws.removeListener('message', handler);
            if (msg.error) reject(new Error(msg.error));
            else resolve(msg.result);
          }
        } catch { /* ignore parse errors */ }
      };

      church.ws.on('message', handler);
      church.ws.send(JSON.stringify({ type: 'command', command, params, id }));
    });
  }
}

module.exports = { AutoRecovery, RECOVERY_PLAYBOOK };
