/**
 * Auto Recovery — Automatic fix execution for known failure patterns
 */

const RECOVERY_PLAYBOOK = {
  'stream_stopped': {
    waitMs: 10000,
    command: 'obs.startStream',
    params: {},
    maxAttempts: 2,
    onSuccess: 'stream_recovered',
    onFail: 'escalate_to_td',
  },
  'fps_low': {
    waitMs: 5000,
    command: 'obs.reduceBitrate',
    params: { reductionPercent: 20 },
    maxAttempts: 1,
    onSuccess: 'fps_stabilized',
    onFail: 'alert_td_fps',
  },
  'recording_not_started': {
    waitMs: 0,
    command: 'atem.startRecording',
    params: {},
    maxAttempts: 1,
    onSuccess: 'recording_auto_started',
    onFail: 'alert_td_recording',
  },
};

class AutoRecovery {
  constructor(churches, alertEngine) {
    this.churches = churches; // Map from server.js
    this.alertEngine = alertEngine;
    this.attemptCounts = new Map(); // `${churchId}:${failureType}` → count
  }

  _key(churchId, failureType) {
    return `${churchId}:${failureType}`;
  }

  resetAttempts(churchId, failureType) {
    this.attemptCounts.delete(this._key(churchId, failureType));
  }

  async attempt(church, failureType, currentStatus) {
    const playbook = RECOVERY_PLAYBOOK[failureType];
    if (!playbook) return { attempted: false, reason: 'no_playbook' };

    const key = this._key(church.churchId, failureType);
    const attempts = this.attemptCounts.get(key) || 0;
    if (attempts >= playbook.maxAttempts) {
      return { attempted: false, reason: 'max_attempts_reached', command: playbook.command };
    }

    this.attemptCounts.set(key, attempts + 1);

    if (playbook.waitMs > 0) {
      await new Promise(r => setTimeout(r, playbook.waitMs));
    }

    console.log(`[AutoRecovery] Attempting ${playbook.command} for ${church.name} (attempt ${attempts + 1}/${playbook.maxAttempts})`);

    try {
      const result = await this.dispatchCommand(church, playbook.command, { ...playbook.params, ...(currentStatus || {}) });
      console.log(`[AutoRecovery] ✅ ${playbook.onSuccess} — ${church.name}`);
      this.attemptCounts.delete(key);

      // Send Slack resolution message after successful auto-fix
      try {
        const dbChurch = this.alertEngine.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(church.churchId);
        if (dbChurch?.slack_webhook_url) {
          await this.alertEngine.sendSlackResolution({ ...church, ...dbChurch }, failureType);
        }
      } catch (e) {
        console.warn('[AutoRecovery] Slack resolution notify failed:', e.message);
      }

      return { attempted: true, success: true, command: playbook.command, result, event: playbook.onSuccess };
    } catch (e) {
      console.error(`[AutoRecovery] ❌ ${playbook.command} failed for ${church.name}: ${e.message}`);
      return { attempted: true, success: false, command: playbook.command, error: e.message, event: playbook.onFail };
    }
  }

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

      // Listen for response
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
