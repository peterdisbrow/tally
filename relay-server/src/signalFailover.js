/**
 * Signal Failover — Multi-signal failure detection state machine
 *
 * Thinks like a real AV engineer: correlates multiple signals (encoder bitrate,
 * ATEM connection, audio levels) to diagnose failures before acting. Takes the
 * safest action first, verifies stability before switching back.
 *
 * States:
 *   HEALTHY          — all signals normal
 *   SUSPECTED_BLACK  — encoder bitrate dropped, confirmation timer running
 *   ATEM_LOST        — ATEM disconnected, encoder still ok (network issue)
 *   CONFIRMED_OUTAGE — outage confirmed, waiting for TD ack
 *   FAILOVER_ACTIVE  — failover executed, waiting for recovery
 *
 * Diagnosis types (multi-signal correlation):
 *   source_dead   — encoder loss + ATEM connected → camera/feed died → switch to safe source
 *   network_outage — encoder loss + ATEM disconnected → network/power issue → alert only
 *   cascading      — encoder loss + audio silence → multiple systems failing → switch immediately
 *   audio_only     — audio silence alone → mic/mixer issue → alert TD
 *   atem_only      — ATEM disconnect alone → network issue → alert TD
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
  stabilityTimerS: 10,       // seconds to verify source is stable before auto-recover
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
    this._transitionListeners = []; // fn(churchId, from, to, trigger, snapshot) — fire-and-forget
  }

  // ─── Per-church config from DB ──────────────────────────────────────────────

  _getConfig(churchId) {
    try {
      const row = this.db.prepare(
        `SELECT failover_enabled, failover_black_threshold_s, failover_ack_timeout_s,
                failover_action, failover_auto_recover, failover_audio_trigger
         FROM churches WHERE churchId = ?`
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
        autoRecover: !!row.failover_auto_recover,
        audioTrigger: !!row.failover_audio_trigger,
      };
    } catch (e) {
      console.warn('[SignalFailover] Failed to load config for church', churchId, ':', e.message);
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
        stabilityTimer: null,      // auto-recover: verify source is stable before switching back
        originalSource: null,      // source before failover (input ID or route)
        bitrateBaseline: null,
        bitrateSamples: [],
        bitrateInLoss: false,      // true when we've signaled bitrate_loss
        audioSilence: false,       // true when sustained audio silence is active
        outageStartedAt: null,
        failoverAlertId: null,
        diagnosis: null,           // { type, confidence, signals } — current failure diagnosis
        stateLog: [],
      });
    }
    return this._states.get(churchId);
  }

  _resetState(churchId) {
    const s = this._getState(churchId);
    if (s.blackTimer) clearTimeout(s.blackTimer);
    if (s.ackTimer) clearTimeout(s.ackTimer);
    if (s.stabilityTimer) clearTimeout(s.stabilityTimer);
    s.state = STATES.HEALTHY;
    s.blackTimer = null;
    s.ackTimer = null;
    s.stabilityTimer = null;
    s.originalSource = null;
    s.outageStartedAt = null;
    s.failoverAlertId = null;
    s.bitrateInLoss = false;
    s.audioSilence = false;
    s.diagnosis = null;
    // keep bitrateBaseline and bitrateSamples across resets (same stream session)
  }

  // ─── Multi-Signal Diagnosis ─────────────────────────────────────────────────

  /**
   * Diagnose the failure by correlating all available signals.
   * A real AV engineer checks multiple things before deciding what to do.
   *
   * Uses both the live status AND the state machine's tracked signal events,
   * because signal_events arrive before the church status is updated.
   *
   * @param {object} opts — { encoderLost, atemLost } override flags from signal events
   * @returns {{ type: string, confidence: number, signals: string[], switchWillHelp: boolean }}
   */
  _diagnoseFailure(churchId, church, opts = {}) {
    const status = church.status || {};
    const s = this._getState(churchId);
    const signals = [];

    // Use signal event flags (from state machine) OR live status, whichever shows a problem
    const encoderDead = opts.encoderLost || !this._isEncoderHealthy(church);
    const atemConnected = opts.atemLost ? false : (status.atem?.connected !== false);
    const audioSilent = s.audioSilence;

    if (encoderDead) signals.push('encoder_loss');
    if (!atemConnected) signals.push('atem_disconnected');
    if (audioSilent) signals.push('audio_silence');

    // ── Cascading failure: encoder + audio both dead ──
    // Multiple systems failing = high confidence something upstream died
    if (encoderDead && audioSilent && atemConnected) {
      return {
        type: 'cascading',
        confidence: 0.95,
        signals,
        switchWillHelp: true,
        message: 'Video and audio both went dead — likely a source or input failure',
      };
    }

    // ── Network/power outage: encoder + ATEM both dead ──
    // If both ATEM and encoder are gone, switching inputs won't help
    if (encoderDead && !atemConnected) {
      return {
        type: 'network_outage',
        confidence: 0.85,
        signals,
        switchWillHelp: false,
        message: 'Both the switcher and encoder are unreachable — likely a network or power issue',
      };
    }

    // ── Source dead: encoder gone but ATEM still connected ──
    // The switcher is fine, so a camera or feed source died — switching will help
    if (encoderDead && atemConnected) {
      return {
        type: 'source_dead',
        confidence: audioSilent ? 0.9 : 0.75,
        signals,
        switchWillHelp: true,
        message: audioSilent
          ? 'Video feed and audio are both down — source likely died'
          : 'Video feed dropped but the switcher is fine — source likely died',
      };
    }

    // ── ATEM-only: switcher disconnected but encoder is fine ──
    if (!atemConnected && !encoderDead) {
      return {
        type: 'atem_only',
        confidence: 0.8,
        signals,
        switchWillHelp: false,
        message: 'Lost connection to the switcher but the stream is still going — network issue at the booth',
      };
    }

    // ── Audio-only: silence with everything else OK ──
    if (audioSilent && !encoderDead && atemConnected) {
      return {
        type: 'audio_only',
        confidence: 0.6,
        signals,
        switchWillHelp: false,
        message: 'Audio went silent but video looks fine — check the mic and mixer',
      };
    }

    // ── Unknown / healthy ──
    return {
      type: 'unknown',
      confidence: 0,
      signals,
      switchWillHelp: false,
      message: 'No clear failure pattern detected',
    };
  }

  // ─── Signal Events (from church client) ─────────────────────────────────────

  /**
   * Handle a signal event from the church client.
   * @param {string} churchId
   * @param {string} signal — signal type
   * @param {object} data — { bitrateKbps, baselineKbps, church, durationSec }
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
      case 'encoder_disconnected':
        this._onEncoderDisconnected(churchId, s, config, church, data);
        break;
      case 'atem_lost':
        this._onAtemLost(churchId, s, config, church, data);
        break;
      case 'atem_restored':
        this._onAtemRestored(churchId, s, config, church);
        break;
      case 'audio_silence_sustained':
        this._onAudioSilence(churchId, s, config, church, data);
        break;
      case 'audio_silence_cleared':
        this._onAudioSilenceCleared(churchId, s, config, church);
        break;
      case 'backup_encoder_failed':
        this._onBackupEncoderFailed(churchId, s, config, church, data);
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
        // Diagnose before acting — like a real engineer, check all signals
        const diagnosis = this._diagnoseFailure(churchId, church, { encoderLost: true });
        s.diagnosis = diagnosis;

        // Audio silence + encoder loss = cascading → skip timer, escalate fast
        if (diagnosis.type === 'cascading') {
          s.outageStartedAt = Date.now();
          this._logTransition(churchId, STATES.HEALTHY, STATES.CONFIRMED_OUTAGE, 'cascading_failure');
          this._escalateToConfirmed(churchId, s, config, church, 'cascading_failure');
          return;
        }

        // Start suspected black timer
        this._logTransition(churchId, STATES.HEALTHY, STATES.SUSPECTED_BLACK, 'encoder_bitrate_loss');
        s.state = STATES.SUSPECTED_BLACK;
        s.outageStartedAt = Date.now();

        s.blackTimer = setTimeout(() => {
          s.blackTimer = null;
          if (s.state === STATES.SUSPECTED_BLACK) {
            // Re-diagnose at timeout — signals may have changed
            const freshDiagnosis = this._diagnoseFailure(churchId, church, { encoderLost: true });
            s.diagnosis = freshDiagnosis;

            if (freshDiagnosis.switchWillHelp) {
              this._escalateToConfirmed(churchId, s, config, church, 'black_timeout');
            } else {
              // Network outage — switching won't help, alert TD instead
              this._logTransition(churchId, STATES.SUSPECTED_BLACK, STATES.CONFIRMED_OUTAGE, 'black_timeout_no_switch');
              this._escalateToConfirmed(churchId, s, config, church, 'black_timeout_network_issue');
            }
          }
        }, config.blackThresholdS * 1000);
        break;
      }

      case STATES.ATEM_LOST: {
        // ATEM already lost + encoder drops = correlated failure, skip timer
        s.diagnosis = this._diagnoseFailure(churchId, church, { encoderLost: true, atemLost: true });
        this._logTransition(churchId, STATES.ATEM_LOST, STATES.CONFIRMED_OUTAGE, 'correlated_loss');
        this._escalateToConfirmed(churchId, s, config, church, 'correlated_atem_and_encoder');
        break;
      }
      // In other states (SUSPECTED_BLACK, CONFIRMED, FAILOVER) — no change needed
    }
  }

  /**
   * Encoder fully disconnected (hardware gone, not just bitrate drop).
   * This is more severe than bitrate loss — skip the SUSPECTED_BLACK timer
   * and go straight to CONFIRMED_OUTAGE since the device is unreachable.
   */
  _onEncoderDisconnected(churchId, s, config, church, data) {
    switch (s.state) {
      case STATES.HEALTHY:
      case STATES.ATEM_LOST: {
        const atemLost = s.state === STATES.ATEM_LOST;
        // Cancel any pending black timer from a prior bitrate loss
        if (s.blackTimer) { clearTimeout(s.blackTimer); s.blackTimer = null; }

        const diagnosis = this._diagnoseFailure(churchId, church, { encoderLost: true, atemLost });
        s.diagnosis = diagnosis;
        s.outageStartedAt = s.outageStartedAt || Date.now();

        const fromState = s.state;
        this._logTransition(churchId, fromState, STATES.CONFIRMED_OUTAGE, 'encoder_disconnected');
        this._escalateToConfirmed(churchId, s, config, church, 'encoder_disconnected');
        break;
      }

      case STATES.SUSPECTED_BLACK: {
        // Already suspected — encoder disconnect confirms it, skip remaining timer
        if (s.blackTimer) { clearTimeout(s.blackTimer); s.blackTimer = null; }
        s.diagnosis = this._diagnoseFailure(churchId, church, { encoderLost: true });
        this._logTransition(churchId, STATES.SUSPECTED_BLACK, STATES.CONFIRMED_OUTAGE, 'encoder_disconnected_during_black');
        this._escalateToConfirmed(churchId, s, config, church, 'encoder_disconnected_confirmed');
        break;
      }
      // In CONFIRMED_OUTAGE or FAILOVER_ACTIVE — already handling, no change needed
    }
  }

  _onEncoderRecovered(churchId, s, config, church, data) {
    switch (s.state) {
      case STATES.SUSPECTED_BLACK: {
        // Recovered within the threshold window — cancel (brief glitch, like a real engineer would ignore)
        if (s.blackTimer) { clearTimeout(s.blackTimer); s.blackTimer = null; }
        this._logTransition(churchId, STATES.SUSPECTED_BLACK, STATES.HEALTHY, 'encoder_recovered');
        s.state = STATES.HEALTHY;
        s.outageStartedAt = null;
        s.diagnosis = null;
        break;
      }

      case STATES.FAILOVER_ACTIVE: {
        const elapsed = s.outageStartedAt ? Math.round((Date.now() - s.outageStartedAt) / 1000) : 0;

        if (config.autoRecover) {
          // Auto-recover: start stability timer — watch it for 10s like a real engineer would
          // before trusting that the source is actually back
          if (s.stabilityTimer) clearTimeout(s.stabilityTimer);

          this._sendAlert(church, 'failover_source_recovering_auto',
            `✅ *Source Looks Like It's Back* — ${church.name}\n` +
            `Outage lasted about ${elapsed}s.\n` +
            `Watching for 10 seconds to make sure it's stable before switching back...`
          );
          this._logTransition(churchId, STATES.FAILOVER_ACTIVE, STATES.FAILOVER_ACTIVE, 'source_recovering_auto');

          s.stabilityTimer = setTimeout(() => {
            s.stabilityTimer = null;
            // Re-read church from map — status may have changed during the stability window
            const currentChurch = this.churches.get(churchId);
            if (s.state === STATES.FAILOVER_ACTIVE && currentChurch && this._isEncoderHealthy(currentChurch)) {
              // Source stayed healthy for 10s — auto-recover
              const currentConfig = this._getConfig(churchId);
              if (currentConfig) this._autoRecover(churchId, s, currentConfig, currentChurch);
            }
          }, DEFAULTS.stabilityTimerS * 1000);
        } else {
          // Manual recover: notify TD, stay on safe source
          this._sendAlert(church, 'failover_source_recovering',
            `✅ *Looks Like It's Back* — ${church.name}\n` +
            `The video source seems to be working again.\n` +
            `Outage lasted about ${elapsed}s.\n\n` +
            `When you're ready, reply /recover_${(s.failoverAlertId || '').slice(0, 8)} to switch back to the main source.`
          );
          this._logTransition(churchId, STATES.FAILOVER_ACTIVE, STATES.FAILOVER_ACTIVE, 'source_recovering');
        }
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
          // ATEM-only loss — network issue, alert but don't switch
          s.diagnosis = { type: 'atem_only', confidence: 0.8, signals: ['atem_disconnected'], switchWillHelp: false,
            message: 'Lost connection to the switcher but the stream is still going' };
          this._logTransition(churchId, STATES.HEALTHY, STATES.ATEM_LOST, 'atem_lost');
          s.state = STATES.ATEM_LOST;
          s.outageStartedAt = Date.now();
          this._sendAlert(church, 'failover_atem_lost',
            `⚠️ *Lost Connection to the Switcher* — ${church.name}\n` +
            `Tally can't reach the ATEM, but the stream is still going.\n` +
            `This is usually a network issue.\n\n` +
            `Check the network cable at the booth.`
          );
        } else {
          // Simultaneous loss — diagnose and skip timer
          s.outageStartedAt = Date.now();
          s.diagnosis = this._diagnoseFailure(churchId, church, { encoderLost: true, atemLost: true });
          this._logTransition(churchId, STATES.HEALTHY, STATES.CONFIRMED_OUTAGE, 'simultaneous_loss');
          this._escalateToConfirmed(churchId, s, config, church, 'simultaneous_atem_and_encoder');
        }
        break;
      }

      case STATES.SUSPECTED_BLACK: {
        // Already suspected black + ATEM drops = correlated, skip remaining timer
        if (s.blackTimer) { clearTimeout(s.blackTimer); s.blackTimer = null; }
        s.diagnosis = this._diagnoseFailure(churchId, church, { encoderLost: true, atemLost: true });
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
        s.diagnosis = null;
        break;
      }
      // In other states (CONFIRMED, FAILOVER) — ATEM restore alone doesn't change state
    }
  }

  // ─── Audio Silence Handlers ─────────────────────────────────────────────────

  _onAudioSilence(churchId, s, config, church, data) {
    s.audioSilence = true;

    // Only act on audio if this church opted in
    if (!config.audioTrigger) return;

    switch (s.state) {
      case STATES.HEALTHY: {
        // Audio silence alone — alert TD, don't auto-switch
        // (could be a quiet moment, a prayer, etc.)
        const diagnosis = this._diagnoseFailure(churchId, church);
        if (diagnosis.type === 'audio_only') {
          this._sendAlert(church, 'failover_audio_silence',
            `🔇 *Audio Went Silent* — ${church.name}\n` +
            `No audio detected for ${data.durationSec || 30}+ seconds.\n` +
            `Video looks fine — check the mic and mixer levels.`
          );
        }
        break;
      }

      case STATES.SUSPECTED_BLACK: {
        // Encoder already suspected + audio dies = cascading, escalate immediately
        if (s.blackTimer) { clearTimeout(s.blackTimer); s.blackTimer = null; }
        s.diagnosis = this._diagnoseFailure(churchId, church, { encoderLost: true });
        this._logTransition(churchId, STATES.SUSPECTED_BLACK, STATES.CONFIRMED_OUTAGE, 'audio_silence_during_black');
        this._escalateToConfirmed(churchId, s, config, church, 'cascading_encoder_and_audio');
        break;
      }
    }
  }

  _onAudioSilenceCleared(churchId, s, config, church) {
    s.audioSilence = false;
  }

  /**
   * Backup encoder failed while in FAILOVER_ACTIVE — switch back to primary.
   * Only relevant for backup_encoder action type. The primary may have recovered
   * by now, so we attempt recovery (switch back to primary encoder).
   */
  _onBackupEncoderFailed(churchId, s, config, church, data) {
    if (s.state !== STATES.FAILOVER_ACTIVE) return;
    if (config.action?.type !== 'backup_encoder') return;

    const elapsed = s.outageStartedAt ? Math.round((Date.now() - s.outageStartedAt) / 1000) : 0;

    this._sendAlert(church, 'failover_backup_failed',
      `⚠️ *Backup Encoder Also Failed* — ${church.name}\n` +
      `The backup encoder stopped streaming after ${elapsed}s on failover.\n` +
      `Switching back to the primary encoder...`
    );

    this._logTransition(churchId, STATES.FAILOVER_ACTIVE, STATES.FAILOVER_ACTIVE, 'backup_encoder_failed');

    // Attempt recovery back to primary — reuse the existing recovery path
    (async () => {
      try {
        await this._executeRecovery(churchId, s, config, church);
        this._logTransition(churchId, STATES.FAILOVER_ACTIVE, STATES.HEALTHY, 'switched_back_to_primary');
        this._sendAlert(church, 'failover_switched_back',
          `🔄 *Switched Back to Primary* — ${church.name}\n` +
          `Backup encoder failed, so Tally switched back to the primary encoder.`
        );
        this._resetState(churchId);
      } catch (e) {
        console.error(`[SignalFailover] Recovery to primary failed for ${churchId}:`, e.message);
        this._sendAlert(church, 'failover_recovery_failed',
          `❌ *Both Encoders Down* — ${church.name}\n` +
          `Backup failed and Tally couldn't switch back to primary: ${e.message}\n` +
          `Someone needs to check the equipment immediately.`
        );
        this._resetState(churchId);
      }
    })();
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
    const diagnosis = s.diagnosis || this._diagnoseFailure(churchId, church);
    s.diagnosis = diagnosis;

    // If diagnosis says switching won't help (network outage), don't auto-switch
    if (!diagnosis.switchWillHelp) {
      this._sendAlert(church, 'failover_confirmed_no_switch',
        `🔴 *Stream Problem* — ${church.name}\n` +
        `${diagnosis.message}.\n` +
        `Auto-switching won't help here — someone needs to check the physical setup.\n\n` +
        `Outage started ${elapsed}s ago.`
      );
      this._logTransition(churchId, s.state, STATES.CONFIRMED_OUTAGE, 'no_switch_available');
      // No ack timer — we won't auto-switch for network outages
      return;
    }

    this._sendAlert(church, 'failover_confirmed_outage',
      `🔴 *Stream Problem* — ${church.name}\n` +
      `${diagnosis.message}.\n` +
      `Tally will automatically switch to a safe source in ${ackTimeout}s.\n\n` +
      `If you're handling it, reply /ack_${s.failoverAlertId.slice(0, 8)} and Tally will stand by.`
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

    // Cancel any pending auto-recover stability timer
    if (s.stabilityTimer) { clearTimeout(s.stabilityTimer); s.stabilityTimer = null; }

    try {
      await this._executeRecovery(churchId, s, config, church);
      this._logTransition(churchId, STATES.FAILOVER_ACTIVE, STATES.HEALTHY, 'td_confirmed_recovery');
      const origDesc = this._describeSource(s.originalSource, config.action);
      this._sendAlert(church, 'failover_recovery_executed',
        `✅ *All Good* — ${church.name}\nSwitched back to ${origDesc}. You're back to normal.`
      );
      this._resetState(churchId);
    } catch (e) {
      console.error(`[SignalFailover] Recovery command failed for ${churchId}:`, e.message);
      this._sendAlert(church, 'failover_recovery_failed',
        `❌ *Couldn't Switch Back* — ${church.name}\nSomething went wrong: ${e.message}\nYou'll need to switch it back manually at the booth.`
      );
    }
  }

  // ─── Auto-Recovery ──────────────────────────────────────────────────────────

  /**
   * Automatically switch back after the stability timer confirms the source is stable.
   * Like a real engineer: watch the source for a few seconds before trusting it.
   */
  async _autoRecover(churchId, s, config, church) {
    try {
      await this._executeRecovery(churchId, s, config, church);
      this._logTransition(churchId, STATES.FAILOVER_ACTIVE, STATES.HEALTHY, 'auto_recovered');
      const origDesc = this._describeSource(s.originalSource, config.action);
      this._sendAlert(church, 'failover_auto_recovered',
        `✅ *Switched Back Automatically* — ${church.name}\n` +
        `Source was stable for 10 seconds, so Tally switched back to ${origDesc}.\n` +
        `Everything looks good.`
      );
      this._resetState(churchId);
    } catch (e) {
      console.error(`[SignalFailover] Auto-recovery command failed for ${churchId}:`, e.message);
      this._sendAlert(church, 'failover_auto_recovery_failed',
        `⚠️ *Auto Switch-Back Failed* — ${church.name}\n` +
        `Source recovered but Tally couldn't switch back: ${e.message}\n` +
        `Reply /recover_${(s.failoverAlertId || '').slice(0, 8)} to try again, or switch manually.`
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
        `🔄 *Switched to Backup* — ${church.name}\n` +
        `The stream went down for ${elapsed}s, so Tally switched to a safe source.\n` +
        `The stream is still live.\n\n` +
        (config.autoRecover
          ? `Tally will automatically switch back when the source is stable.`
          : `When things look good, reply /recover_${(s.failoverAlertId || '').slice(0, 8)} to switch back.`)
      );
    } catch (e) {
      console.error(`[SignalFailover] ❌ Failover command failed for ${churchId}:`, e.message);
      this._sendAlert(church, 'failover_command_failed',
        `❌ *Couldn't Switch Automatically* — ${church.name}\n` +
        `Tally tried to switch to the backup but it didn't work.\n` +
        `Error: ${e.message}\n\n` +
        `Someone needs to switch it manually at the booth right away.`
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
      case 'backup_encoder':
        return { command: 'failover.switchToBackupEncoder', params: {} };
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
      case 'backup_encoder':
        return { command: 'failover.switchToPrimaryEncoder', params: {} };
      default:
        throw new Error(`Unknown failover action type: ${action.type}`);
    }
  }

  _captureCurrentSource(church, action) {
    switch (action.type) {
      case 'atem_switch':
        return church.status?.atem?.programInput || null;
      case 'videohub_route': {
        const hubs = church.status?.videoHubs || [];
        const hub = hubs[action.hubIndex || 0];
        if (hub?.routes && action.output !== undefined) {
          return hub.routes[String(action.output)] ?? null;
        }
        return null;
      }
      case 'backup_encoder':
        return 'primary';
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
      case 'backup_encoder':
        return 'Switch to backup encoder';
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
      case 'backup_encoder':
        return 'primary encoder';
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
    const entry = { ts: new Date().toISOString(), from, to, trigger, diagnosis: s.diagnosis?.type || null };
    s.stateLog.push(entry);
    // Keep log bounded
    if (s.stateLog.length > 50) s.stateLog.shift();
    console.log(`[SignalFailover] ${churchId}: ${from} → ${to} (${trigger})${s.diagnosis ? ` [${s.diagnosis.type}]` : ''}`);

    // Fire-and-forget: notify listeners (never block state machine)
    const snapshot = { state: to, diagnosis: s.diagnosis, outageStartedAt: s.outageStartedAt, stateLog: s.stateLog.slice(-10) };
    for (const fn of this._transitionListeners) {
      try {
        Promise.resolve(fn(churchId, from, to, trigger, snapshot)).catch(e =>
          console.error(`[SignalFailover] Transition listener error:`, e.message)
        );
      } catch (e) {
        console.error(`[SignalFailover] Transition listener sync error:`, e.message);
      }
    }
  }

  // ─── Status / Debug ─────────────────────────────────────────────────────────

  getState(churchId) {
    const s = this._states.get(churchId);
    if (!s) return { state: STATES.HEALTHY };
    return {
      state: s.state,
      diagnosis: s.diagnosis,
      outageStartedAt: s.outageStartedAt,
      bitrateBaseline: s.bitrateBaseline,
      stateLog: s.stateLog.slice(-10),
    };
  }

  /**
   * Register a listener for state transitions. Called fire-and-forget —
   * listener errors are caught and logged, never propagate.
   * @param {function(churchId, from, to, trigger, stateSnapshot): void} fn
   */
  onTransition(fn) {
    this._transitionListeners.push(fn);
  }

  /** Clean up timers for a disconnecting church */
  cleanup(churchId) {
    const s = this._states.get(churchId);
    if (s) {
      if (s.blackTimer) clearTimeout(s.blackTimer);
      if (s.ackTimer) clearTimeout(s.ackTimer);
      if (s.stabilityTimer) clearTimeout(s.stabilityTimer);
      this._states.delete(churchId);
    }
  }
}

module.exports = { SignalFailover, STATES, DEFAULTS };
