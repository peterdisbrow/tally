/**
 * Auto Recovery — Alert classification for known failure patterns
 *
 * NOTE: Automatic command dispatch is DISABLED. All alerts go straight to
 * the alert engine escalation ladder (Telegram → TD → Andrew). The playbook
 * is retained for classification and future use when auto-recovery is
 * re-enabled per-church.
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

  /**
   * Auto-recovery is currently disabled globally.
   * All alerts pass through to the alert engine for TD notification.
   */
  async attempt(church, failureType, currentStatus) {
    const playbook = RECOVERY_PLAYBOOK[failureType];
    const event = playbook ? playbook.onFail : 'escalate_to_td';
    return { attempted: false, reason: 'auto_recovery_disabled', command: null, event };
  }

  /** Kept for future use when auto-recovery is re-enabled */
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
