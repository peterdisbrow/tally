/**
 * Auto Recovery — Alert classification and recovery for known failure patterns
 *
 * Checks per-church auto_recovery_enabled flag. When enabled:
 * - Classifies alerts against the 24-type playbook
 * - Tracks attempt counts (max 3 per failure type per session)
 * - Dispatches recovery commands to church clients via WebSocket
 * - Enforces cooldown (30s) between attempts for the same failure type
 * - Skips auto-recovery outside service hours unless explicitly enabled
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
  'audio_silence_sustained':   { onFail: 'alert_td_audio' },
};

/**
 * Maps failure types to the recovery command + params to dispatch.
 * Only failure types listed here get automatic recovery; all others escalate.
 */
const RECOVERY_COMMANDS = {
  'stream_stopped':         { command: 'recovery.restartStream',    params: {} },
  'atem_stream_stopped':    { command: 'recovery.restartStream',    params: { source: 'atem' } },
  'vmix_stream_stopped':    { command: 'recovery.restartStream',    params: { source: 'vmix' } },
  'encoder_stream_stopped': { command: 'recovery.restartStream',    params: { source: 'encoder' } },
  'encoder_disconnected':   { command: 'recovery.restartEncoder',   params: {} },
  'recording_not_started':  { command: 'recovery.restartRecording', params: {} },
  'audio_silence':          { command: 'recovery.resetAudio',       params: {} },
  'audio_silence_sustained':{ command: 'recovery.resetAudio',       params: {} },
  'connection_lost':        { command: 'recovery.reconnectDevice',  params: {} },
};

/** Minimum silence duration (ms) before audio_silence triggers auto-recovery. */
const AUDIO_SILENCE_THRESHOLD_MS = 60_000;

/** Cooldown between recovery attempts for the same failure type (ms). */
const COOLDOWN_MS = 30_000;

/** Maximum recovery attempts per failure type per session. */
const MAX_ATTEMPTS = 3;

class AutoRecovery {
  constructor(churches, alertEngine, db, options = {}) {
    this.churches = churches;
    this.alertEngine = alertEngine;
    this.db = db || null;
    this.attemptCounts = new Map();
    /** Tracks last attempt timestamp per key for cooldown enforcement. */
    this.lastAttemptTime = new Map();
    /** Optional schedule engine for service-hours gating. */
    this.scheduleEngine = options.scheduleEngine || null;
  }

  _key(churchId, failureType) {
    return `${churchId}:${failureType}`;
  }

  resetAttempts(churchId, failureType) {
    const key = this._key(churchId, failureType);
    this.attemptCounts.delete(key);
    this.lastAttemptTime.delete(key);
  }

  /** Clear all attempt counts for a church (call on stream session end). */
  clearAllAttempts(churchId) {
    for (const key of this.attemptCounts.keys()) {
      if (key.startsWith(churchId + ':')) {
        this.attemptCounts.delete(key);
      }
    }
    for (const key of this.lastAttemptTime.keys()) {
      if (key.startsWith(churchId + ':')) {
        this.lastAttemptTime.delete(key);
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
   * Check whether recovery should be allowed based on service hours.
   * Returns true if:
   *   - No schedule engine is configured (fail-open)
   *   - Currently inside a service window
   *   - Church has recovery_outside_service_hours enabled
   */
  _isServiceHoursAllowed(churchId) {
    if (!this.scheduleEngine) return true;
    try {
      if (this.scheduleEngine.isServiceWindow(churchId)) return true;
      // Check per-church opt-in for off-hours recovery
      const row = this.db?.prepare(
        'SELECT recovery_outside_service_hours FROM churches WHERE churchId = ?'
      ).get(churchId);
      return row?.recovery_outside_service_hours === 1;
    } catch {
      return true; // fail-open
    }
  }

  /**
   * Check cooldown — returns true if enough time has passed since last attempt.
   */
  _isCooldownElapsed(key, now) {
    const last = this.lastAttemptTime.get(key);
    if (!last) return true;
    return (now - last) >= COOLDOWN_MS;
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

    // When SignalFailover is actively handling an outage (not HEALTHY), skip
    // encoder_disconnected recovery — failover to backup is the right action,
    // not restarting the same dead encoder.
    if (failureType === 'encoder_disconnected' && this.signalFailover) {
      const fState = this.signalFailover.getState(church.churchId);
      if (fState.state && fState.state !== 'HEALTHY') {
        return { attempted: false, reason: 'deferred_to_signal_failover', command: null, event };
      }
    }

    const key = this._key(church.churchId, failureType);

    // Max attempts per failure type per session — after that, always escalate
    const currentCount = this.attemptCounts.get(key) || 0;
    if (currentCount >= MAX_ATTEMPTS) {
      return { attempted: false, success: false, reason: 'max_attempts_exceeded', command: null, event };
    }

    // Look up the recovery command for this failure type
    const recoveryDef = RECOVERY_COMMANDS[failureType];
    if (!recoveryDef) {
      // No auto-recovery command mapped — escalate to TD
      // Don't consume an attempt since no command was available
      return { attempted: false, reason: 'no_auto_command', command: null, event };
    }

    // Service hours gate — don't auto-recover outside service windows
    // unless the church has explicitly opted in
    if (!this._isServiceHoursAllowed(church.churchId)) {
      return { attempted: false, reason: 'outside_service_hours', command: null, event };
    }

    // Cooldown gate — prevent hammering the same recovery in rapid succession
    const now = Date.now();
    if (!this._isCooldownElapsed(key, now)) {
      return { attempted: false, reason: 'cooldown_active', command: null, event };
    }

    // Audio silence requires sustained duration before auto-recovery
    if (failureType === 'audio_silence') {
      const silenceDuration = currentStatus?.silenceDurationMs || currentStatus?.silence_duration_ms || 0;
      if (silenceDuration < AUDIO_SILENCE_THRESHOLD_MS) {
        return { attempted: false, reason: 'silence_not_sustained', command: null, event };
      }
    }

    // Record attempt count and timestamp for cooldown tracking
    // Only increment here — after all gates have passed
    this.attemptCounts.set(key, currentCount + 1);
    this.lastAttemptTime.set(key, now);

    // Build params — merge any status-derived context into command params
    const params = { ...recoveryDef.params };
    if (failureType === 'connection_lost' && currentStatus?.deviceId) {
      params.deviceId = currentStatus.deviceId;
    }

    // Dispatch the recovery command to the church client
    try {
      await this.dispatchCommand(church, recoveryDef.command, params);
      return { attempted: true, success: true, reason: 'command_dispatched', command: recoveryDef.command, event };
    } catch (err) {
      return { attempted: true, success: false, reason: `dispatch_failed: ${err.message}`, command: recoveryDef.command, event };
    }
  }

  /**
   * Dispatch a command to the church client via WebSocket.
   * When instanceName is provided, targets only that specific instance's socket.
   * Falls back to all sockets for backward compatibility.
   */
  async dispatchCommand(church, command, params, instanceName) {
    const { WebSocket } = require('ws');
    const openSockets = [];

    if (instanceName && church.sockets?.has(instanceName)) {
      // Target specific instance socket
      const sock = church.sockets.get(instanceName);
      if (sock?.readyState === WebSocket.OPEN) {
        openSockets.push(sock);
      }
    }

    // Fallback: gather all open sockets if no specific instance or instance socket not found
    if (openSockets.length === 0 && church.sockets?.size) {
      for (const sock of church.sockets.values()) {
        if (sock.readyState === WebSocket.OPEN) openSockets.push(sock);
      }
    }
    if (openSockets.length === 0) {
      throw new Error('Church client not connected');
    }
    const { v4: uuidv4 } = require('uuid');
    const id = uuidv4();

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        for (const sock of openSockets) {
          try { sock.removeListener('message', handler); } catch { /* ignore */ }
        }
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Command timeout (15s)'));
      }, 15000);

      const handler = (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'command_result' && msg.id === id) {
            clearTimeout(timeout);
            cleanup();
            if (msg.error) reject(new Error(msg.error));
            else resolve(msg.result);
          }
        } catch { /* ignore parse errors */ }
      };

      const payload = JSON.stringify({ type: 'command', command, params, id });
      for (const sock of openSockets) {
        sock.on('message', handler);
        sock.send(payload);
      }
    });
  }
}

module.exports = { AutoRecovery, RECOVERY_PLAYBOOK, RECOVERY_COMMANDS, COOLDOWN_MS, MAX_ATTEMPTS, AUDIO_SILENCE_THRESHOLD_MS };
