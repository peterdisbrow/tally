/**
 * Signal Failover — Multi-signal failure detection state machine
 *
 * Correlates ATEM connection status and encoder bitrate to detect stream
 * outages and auto-failover to a configured safe source if the TD doesn't
 * acknowledge within a timeout window.
 *
 * States:
 *   HEALTHY          — both signals normal
 *   SUSPECTED_BLACK  — encoder bitrate dropped, 5s confirmation timer running
 *   ATEM_LOST        — ATEM disconnected, encoder still ok (network issue)
 *   CONFIRMED_OUTAGE — outage confirmed, waiting for TD ack (30s)
 *   FAILOVER_ACTIVE  — failover executed, manual recovery required
 */

const STATES = {
  HEALTHY: 'HEALTHY',
  SUSPECTED_BLACK: 'SUSPECTED_BLACK',
  ATEM_LOST: 'ATEM_LOST',
  CONFIRMED_OUTAGE: 'CONFIRMED_OUTAGE',
  FAILOVER_ACTIVE: 'FAILOVER_ACTIVE',
};

const DEFAULTS = {
  blackThresholdS: 5,
  ackTimeoutS: 30,
  bitrateDropRatio: 0.2,     // below 20% of baseline = loss
  bitrateRecoverRatio: 0.5,  // above 50% of baseline = recovered
  baselineSamples: 3,        // samples needed to establish baseline
};

class SignalFailover {
  /**
   * @param {Map} churches — live church map (churchId → church object with ws, status, etc.)
   * @param {object} alertEngine — AlertEngine instance (for sendTelegramMessage)
   * @param {object} autoRecovery — AutoRecovery instance (for dispatchCommand)
   * @param {object} db — better-sqlite3 database handle
   */
  constructor(churches, alertEngine, autoRecovery, db) {
    this.churches = churches;
    this.alertEngine = alertEngine;
    this.autoRecovery = autoRecovery;
    this.db = db;
    this._states = new Map(); // churchId → per-church failover state
  }

  // ─── Per-church config from DB ──────────────────────────────────────────────

  _getConfig(churchId) {
    try {
      const row = this.db.prepare(
        'SELECT failover_enabled, failover_black_threshold_s, failover_ack_timeout_s, failover_action FROM churches WHERE churchId = ?'
      ).get(churchId);
      if (!row || !row.failover_enabled) return null;

      let action = null;
      try { action = row.failover_action ? JSON.parse(row.failover_action) : null; } catch { /* invalid JSON */ }
      if (!action) return null; // must have a configured action

      return {
        enabled: true,
        blackThresholdS: row.failover_black_threshold_s || DEFAULTS.blackThresholdS,
        ackTimeoutS: row.failover_ack_timeout_s || DEFAULTS.ackTimeoutS,
        action,
      };
    } catch {
      return null;
    }
  }

  // ─── Per-church state management ────────────────────────────────────────────

  _getState(churchId) {
    if (!this._states.has(churchId)) {
      this._states.set(churchId, {
        state: STATES.HEALTHY,
        blackTimer: null,
        ackTimer: null,
        originalSource: null,    // source before failover (input ID or route)
        bitrateBaseline: null,
        bitrateSamples: [],
        bitrateInLoss: false,    // true when we've signaled bitrate_loss
        outageStartedAt: null,
        failoverAlertId: null,
        stateLog: [],
      });
    }
    return this._states.get(churchId);
  }

  _resetState(churchId) {
    const s = this._getState(churchId);
    if (s.blackTimer) clearTimeout(s.blackTimer);
    if (s.ackTimer) clearTimeout(s.ackTimer);
    s.state = STATES.HEALTHY;
    s.blackTimer = null;
    s.ackTimer = null;
    s.originalSource = null;
    s.outageStartedAt = null;
    s.failoverAlertId = null;
    s.bitrateInLoss = false;
    // keep bitrateBaseline and bitrateSamples across resets (same stream session)
  }

  // ─── Signal Events (from church client) ─────────────────────────────────────

  /**
   * Handle a signal event from the church client.
   * @param {string} churchId
   * @param {string} signal — 'atem_lost' | 'atem_restored' | 'encoder_bitrate_loss' | 'encoder_bitrate_recovered'
   * @param {object} data — { bitrateKbps, baselineKbps, church }
   */
  onSignalEvent(churchId, signal, data) {
    const config = this._getConfig(churchId);
    if (!config) return; // failover not enabled or not configured

    const s = this._getState(churchId);
    const church = data.church || this.churches.get(churchId);
    if (!church) return;

    switch (signal) {
      case 'encoder_bitrate_loss':
        this._onEncoderLoss(churchId, s, config, church, data);
        break;
      case 'encoder_bitrate_recovered':
        this._onEncoderRecovered(churchId, s, config, church, data);
        break;
      case 'atem_lost':
        this._onAtemLost(churchId, s, config, church, data);
        break;
      case 'atem_restored':
        this._onAtemRestored(churchId, s, config, church);
        break;
    }
  }

  /**
   * Feed regular status updates for secondary bitrate monitoring.
   * Called from server.js on every status_update message.
   */
  onStatusUpdate(churchId, status) {
    const config = this._getConfig(churchId);
    if (!config) return;

    // Update bitrate baseline from regular polls
    const bitrateKbps = status?.encoder?.bitrateKbps || status?.atem?.streamingBitrate / 1000 || 0;
    if (bitrateKbps > 500) {
      const s = this._getState(churchId);
      s.bitrateSamples.push(bitrateKbps);
      if (s.bitrateSamples.length > 10) s.bitrateSamples.shift();
      if (s.bitrateSamples.length >= DEFAULTS.baselineSamples && !s.bitrateBaseline) {
        s.bitrateBaseline = s.bitrateSamples.reduce((a, b) => a + b, 0) / s.bitrateSamples.length;
      }
    }
  }

  /**
   * Reset bitrate baseline when a stream session ends.
   * Called when encoder goes from live → not live.
   */
  resetBaseline(churchId) {
    const s = this._getState(churchId);
    s.bitrateBaseline = null;
    s.bitrateSamples = [];
    s.bitrateInLoss = false;
    // Also reset the full state on stream end
    if (s.state !== STATES.HEALTHY) {
      this._logTransition(churchId, s.state, STATES.HEALTHY, 'stream_ended');
      this._resetState(churchId);
    }
  }

  // ─── State Transition Handlers ──────────────────────────────────────────────

  _onEncoderLoss(churchId, s, config, church, data) {
    switch (s.state) {
      case STATES.HEALTHY: {
        // Start suspected black timer
        this._logTransition(churchId, STATES.HEALTHY, STATES.SUSPECTED_BLACK, 'encoder_bitrate_loss');
        s.state = STATES.SUSPECTED_BLACK;
        s.outageStartedAt = Date.now();

        s.blackTimer = setTimeout(() => {
          s.blackTimer = null;
          if (s.state === STATES.SUSPECTED_BLACK) {
            this._escalateToConfirmed(churchId, s, config, church, 'black_timeout');
          }
        }, config.blackThresholdS * 1000);
        break;
      }

      case STATES.ATEM_LOST: {
        // ATEM already lost + encoder drops = correlated failure, skip timer
        this._logTransition(churchId, STATES.ATEM_LOST, STATES.CONFIRMED_OUTAGE, 'correlated_loss');
        this._escalateToConfirmed(churchId, s, config, church, 'correlated_atem_and_encoder');
        break;
      }
      // In other states (SUSPECTED_BLACK, CONFIRMED, FAILOVER) — no change needed
    }
  }

  _onEncoderRecovered(churchId, s, config, church, data) {
    switch (s.state) {
      case STATES.SUSPECTED_BLACK: {
        // Recovered within the threshold window — cancel
        if (s.blackTimer) { clearTimeout(s.blackTimer); s.blackTimer = null; }
        this._logTransition(churchId, STATES.SUSPECTED_BLACK, STATES.HEALTHY, 'encoder_recovered');
        s.state = STATES.HEALTHY;
        s.outageStartedAt = null;
        break;
      }

      case STATES.FAILOVER_ACTIVE: {
        // Source may be recovering — notify TD, don't auto-switch-back
        const elapsed = s.outageStartedAt ? Math.round((Date.now() - s.outageStartedAt) / 1000) : 0;
        this._sendAlert(church, 'failover_source_recovering',
          `✅ *Source Recovering* — ${church.name}\n` +
          `Encoder bitrate returning to normal (${data.bitrateKbps || '?'} kbps).\n` +
          `Source may be back online (outage lasted ${elapsed}s).\n\n` +
          `Reply /recover_${(s.failoverAlertId || '').slice(0, 8)} to switch back.`
        );
        this._logTransition(churchId, STATES.FAILOVER_ACTIVE, STATES.FAILOVER_ACTIVE, 'source_recovering');
        break;
      }
    }
  }

  _onAtemLost(churchId, s, config, church, data) {
    switch (s.state) {
      case STATES.HEALTHY: {
        // Check if encoder is also in loss (simultaneous)
        const encoderOk = this._isEncoderHealthy(church);
        if (encoderOk) {
          // ATEM-only loss — network issue
          this._logTransition(churchId, STATES.HEALTHY, STATES.ATEM_LOST, 'atem_lost');
          s.state = STATES.ATEM_LOST;
          s.outageStartedAt = Date.now();
          this._sendAlert(church, 'failover_atem_lost',
            `⚠️ *ATEM Connection Lost* — ${church.name}\n` +
            `Network issue between Tally and ATEM.\n` +
            `Encoder still streaming normally.\n\n` +
            `Check booth network connection.`
          );
        } else {
          // Simultaneous loss — skip timer, go straight to confirmed
          s.outageStartedAt = Date.now();
          this._logTransition(churchId, STATES.HEALTHY, STATES.CONFIRMED_OUTAGE, 'simultaneous_loss');
          this._escalateToConfirmed(churchId, s, config, church, 'simultaneous_atem_and_encoder');
        }
        break;
      }

      case STATES.SUSPECTED_BLACK: {
        // Already suspected black + ATEM drops = correlated, skip remaining timer
        if (s.blackTimer) { clearTimeout(s.blackTimer); s.blackTimer = null; }
        this._logTransition(churchId, STATES.SUSPECTED_BLACK, STATES.CONFIRMED_OUTAGE, 'atem_lost_during_black');
        this._escalateToConfirmed(churchId, s, config, church, 'correlated_atem_during_black');
        break;
      }
    }
  }

  _onAtemRestored(churchId, s, config, church) {
    switch (s.state) {
      case STATES.ATEM_LOST: {
        this._logTransition(churchId, STATES.ATEM_LOST, STATES.HEALTHY, 'atem_restored');
        s.state = STATES.HEALTHY;
        s.outageStartedAt = null;
        break;
      }
      // In other states (CONFIRMED, FAILOVER) — ATEM restore alone doesn't change state
    }
  }

  // ─── Escalation ─────────────────────────────────────────────────────────────

  _escalateToConfirmed(churchId, s, config, church, trigger) {
    s.state = STATES.CONFIRMED_OUTAGE;
    if (!s.outageStartedAt) s.outageStartedAt = Date.now();

    // Generate alert ID for ack tracking
    const { v4: uuidv4 } = require('uuid');
    s.failoverAlertId = uuidv4();

    const elapsed = Math.round((Date.now() - s.outageStartedAt) / 1000);
    const ackTimeout = config.ackTimeoutS;
    const actionDesc = this._describeAction(config.action);

    this._sendAlert(church, 'failover_confirmed_outage',
      `🔴 *Stream Outage Detected* — ${church.name}\n` +
      `Type: ${trigger.replace(/_/g, ' ')}\n` +
      `Duration: ${elapsed}s\n` +
      `Failover (${actionDesc}) in ${ackTimeout}s unless acknowledged.\n\n` +
      `Reply /ack_${s.failoverAlertId.slice(0, 8)} to take manual control.`
    );

    // Start ack countdown
    s.ackTimer = setTimeout(() => {
      s.ackTimer = null;
      if (s.state === STATES.CONFIRMED_OUTAGE) {
        this._executeFailover(churchId, s, config, church);
      }
    }, ackTimeout * 1000);
  }

  // ─── TD Interaction ─────────────────────────────────────────────────────────

  /**
   * TD acknowledged the alert — cancel auto-failover but stay in CONFIRMED.
   */
  onTdAcknowledge(churchId) {
    const s = this._getState(churchId);
    if (s.state === STATES.CONFIRMED_OUTAGE && s.ackTimer) {
      clearTimeout(s.ackTimer);
      s.ackTimer = null;
      this._logTransition(churchId, STATES.CONFIRMED_OUTAGE, STATES.CONFIRMED_OUTAGE, 'td_acknowledged');
      console.log(`[SignalFailover] TD acknowledged outage for ${churchId} — auto-failover cancelled`);
    }
  }

  /**
   * TD confirms recovery — switch back to original source.
   */
  async onTdConfirmRecovery(churchId) {
    const s = this._getState(churchId);
    if (s.state !== STATES.FAILOVER_ACTIVE) return;

    const church = this.churches.get(churchId);
    if (!church) return;

    const config = this._getConfig(churchId);
    if (!config) return;

    try {
      await this._executeRecovery(churchId, s, config, church);
      this._logTransition(churchId, STATES.FAILOVER_ACTIVE, STATES.HEALTHY, 'td_confirmed_recovery');
      const origDesc = this._describeSource(s.originalSource, config.action);
      this._sendAlert(church, 'failover_recovery_executed',
        `✅ *Recovery Executed* — ${church.name}\nSwitched back to ${origDesc}.`
      );
      this._resetState(churchId);
    } catch (e) {
      console.error(`[SignalFailover] Recovery command failed for ${churchId}:`, e.message);
      this._sendAlert(church, 'failover_recovery_failed',
        `❌ *Recovery Failed* — ${church.name}\n${e.message}\nManual intervention required.`
      );
    }
  }

  // ─── Failover Execution ─────────────────────────────────────────────────────

  async _executeFailover(churchId, s, config, church) {
    this._logTransition(churchId, STATES.CONFIRMED_OUTAGE, STATES.FAILOVER_ACTIVE, 'failover_executed');
    s.state = STATES.FAILOVER_ACTIVE;

    // Store original source for recovery
    s.originalSource = this._captureCurrentSource(church, config.action);

    const actionDesc = this._describeAction(config.action);
    const elapsed = s.outageStartedAt ? Math.round((Date.now() - s.outageStartedAt) / 1000) : 0;

    try {
      const { command, params } = this._buildFailoverCommand(config.action);
      await this.autoRecovery.dispatchCommand(church, command, params);
      console.log(`[SignalFailover] ✅ Failover executed for ${churchId}: ${actionDesc}`);

      this._sendAlert(church, 'failover_executed',
        `🔄 *Failover Executed* — ${church.name}\n` +
        `${actionDesc}\n` +
        `Outage duration: ${elapsed}s. Stream maintained.\n\n` +
        `When source recovers, reply /recover_${(s.failoverAlertId || '').slice(0, 8)} to switch back.`
      );
    } catch (e) {
      console.error(`[SignalFailover] ❌ Failover command failed for ${churchId}:`, e.message);
      this._sendAlert(church, 'failover_command_failed',
        `❌ *Failover Failed* — ${church.name}\n` +
        `Command error: ${e.message}\n` +
        `Manual intervention required immediately.`
      );
    }
  }

  async _executeRecovery(churchId, s, config, church) {
    const { command, params } = this._buildRecoveryCommand(config.action, s.originalSource);
    await this.autoRecovery.dispatchCommand(church, command, params);
    console.log(`[SignalFailover] ✅ Recovery executed for ${churchId}`);
  }

  // ─── Command Builders ───────────────────────────────────────────────────────

  _buildFailoverCommand(action) {
    switch (action.type) {
      case 'atem_switch':
        return { command: 'atem.cut', params: { input: action.input } };
      case 'videohub_route':
        return { command: 'videohub.route', params: { output: action.output, input: action.input, hubIndex: action.hubIndex || 0 } };
      default:
        throw new Error(`Unknown failover action type: ${action.type}`);
    }
  }

  _buildRecoveryCommand(action, originalSource) {
    switch (action.type) {
      case 'atem_switch':
        return { command: 'atem.cut', params: { input: originalSource } };
      case 'videohub_route':
        return { command: 'videohub.route', params: { output: action.output, input: originalSource, hubIndex: action.hubIndex || 0 } };
      default:
        throw new Error(`Unknown failover action type: ${action.type}`);
    }
  }

  _captureCurrentSource(church, action) {
    switch (action.type) {
      case 'atem_switch':
        return church.status?.atem?.programInput || null;
      case 'videohub_route':
        // Can't easily capture current VideoHub route from status — store the action's output
        // The recovery will route back to whatever was there (TD confirms this is correct)
        return null;
      default:
        return null;
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  _isEncoderHealthy(church) {
    const status = church.status || {};
    const encoder = status.encoder || {};
    const isLive = encoder.live || encoder.streaming;
    if (!isLive) return false;
    // If we have bitrate data, check it's non-trivial
    if (encoder.bitrateKbps !== undefined && encoder.bitrateKbps !== null) {
      return encoder.bitrateKbps > 200;
    }
    // ATEM streaming bitrate fallback
    if (status.atem?.streaming && status.atem.streamingBitrate > 0) {
      return status.atem.streamingBitrate > 200000; // bps
    }
    return isLive; // assume healthy if live but no bitrate data
  }

  _describeAction(action) {
    switch (action.type) {
      case 'atem_switch':
        return `Switch ATEM to input ${action.input}`;
      case 'videohub_route':
        return `Route VideoHub output ${action.output} to input ${action.input}`;
      default:
        return 'Unknown action';
    }
  }

  _describeSource(source, action) {
    if (source === null || source === undefined) return 'original source';
    switch (action.type) {
      case 'atem_switch':
        return `ATEM input ${source}`;
      case 'videohub_route':
        return `VideoHub input ${source}`;
      default:
        return `source ${source}`;
    }
  }

  async _sendAlert(church, alertType, message) {
    try {
      // Send directly via Telegram (bypass full alert engine escalation — failover has its own)
      const dbChurch = this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(church.churchId);
      const botToken = dbChurch?.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN;
      const tdChatId = dbChurch?.td_telegram_chat_id;

      if (botToken && tdChatId) {
        await this.alertEngine.sendTelegramMessage(tdChatId, botToken, message);
      }

      console.log(`[SignalFailover] Alert (${alertType}): ${church.name}`);
    } catch (e) {
      console.error(`[SignalFailover] Alert send failed:`, e.message);
    }
  }

  _logTransition(churchId, from, to, trigger) {
    const s = this._getState(churchId);
    const entry = { ts: new Date().toISOString(), from, to, trigger };
    s.stateLog.push(entry);
    // Keep log bounded
    if (s.stateLog.length > 50) s.stateLog.shift();
    console.log(`[SignalFailover] ${churchId}: ${from} → ${to} (${trigger})`);
  }

  // ─── Status / Debug ─────────────────────────────────────────────────────────

  getState(churchId) {
    const s = this._states.get(churchId);
    if (!s) return { state: STATES.HEALTHY };
    return {
      state: s.state,
      outageStartedAt: s.outageStartedAt,
      bitrateBaseline: s.bitrateBaseline,
      stateLog: s.stateLog.slice(-10),
    };
  }

  /** Clean up timers for a disconnecting church */
  cleanup(churchId) {
    const s = this._states.get(churchId);
    if (s) {
      if (s.blackTimer) clearTimeout(s.blackTimer);
      if (s.ackTimer) clearTimeout(s.ackTimer);
      this._states.delete(churchId);
    }
  }
}

module.exports = { SignalFailover, STATES, DEFAULTS };
