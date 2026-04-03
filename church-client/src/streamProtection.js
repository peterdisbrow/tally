/**
 * StreamProtectionManager — Smart stream failure detection and auto-restart.
 *
 * Evaluates WHY a stream stopped and responds appropriately:
 *   1. TC command (portal/mobile/desktop/Companion) → intentional, no action
 *   2. Encoder disconnected simultaneously → infrastructure failure, auto-restart on reconnect
 *   3. Elevated cache / error state before drop → encoder failure, immediate auto-restart
 *   4. Clean stop, encoder still connected → probably intentional, alert only + manual restart
 *   5. CDN validation — after stream starts, verify CDN is actually receiving the stream
 */

const EventEmitter = require('events');

// Rolling window size for cache samples (sampled every 3s, keep ~60s worth)
const CACHE_WINDOW_SIZE = 20;
const CACHE_SAMPLE_INTERVAL_MS = 3000;
const CACHE_THRESHOLD_PERCENT = 60;
// Grace period after stream stops to check if encoder also disconnects (simultaneous failure)
const ENCODER_DISCONNECT_GRACE_MS = 3000;
// CDN validation: how long to wait after stream starts before checking CDN (let CDN stabilize)
const CDN_CHECK_DELAY_MS = 30000;
// CDN validation: how often to re-check CDN health while streaming
const CDN_CHECK_INTERVAL_MS = 20000;
// CDN validation: how many consecutive failures before alerting (20s * 2 = 40s > 30s threshold)
const CDN_MISMATCH_THRESHOLD = 2;

class StreamProtectionManager extends EventEmitter {
  constructor(agent) {
    super();
    this.agent = agent;
    this.enabled = true; // auto-enabled by default

    // State
    this._wasStreaming = false;          // previous streaming state
    this._tcCommandedStop = false;       // flag set when TC commands a stop
    this._tcCommandedStopAt = 0;         // timestamp of TC-commanded stop
    this._cacheSamples = [];             // rolling cache % samples
    this._cacheInterval = null;          // interval for sampling cache
    this._encoderConnectedAtDrop = null; // encoder connection state at moment of stream drop
    this._waitingForReconnect = false;   // waiting for encoder to reconnect (case 2)
    this._lastStreamStartAt = 0;        // when the stream last started
    this._restartInProgress = false;     // prevent overlapping restarts

    // CDN validation state
    this._cdnCheckTimer = null;          // initial delay timer
    this._cdnCheckInterval = null;       // periodic CDN check interval
    this._cdnMismatchAlerted = false;    // prevent duplicate CDN alerts per stream session
    this._cdnMismatchCount = 0;          // consecutive mismatch results (must reach threshold before alerting)
    this._cdnLastResult = null;          // last CDN verification result for health display

    // Public status
    this.status = {
      enabled: true,
      active: false,           // true when a stream is live and being protected
      state: 'idle',           // idle | protecting | encoder_disconnected | restarting | alert_sent | cdn_mismatch
      lastEvent: null,         // last protection event description
      lastEventAt: null,       // timestamp
      canManualRestart: false, // true when case 4 or CDN mismatch: manual restart available
      cdnHealth: null,         // null | 'checking' | 'healthy' | 'mismatch' — CDN health indicator
      cdnPlatforms: null,      // { youtube: { live, viewerCount }, facebook: { live, viewerCount } } — per-platform status
    };
  }

  /** Start cache sampling and monitoring. */
  start() {
    this._cacheInterval = setInterval(() => this._sampleCache(), CACHE_SAMPLE_INTERVAL_MS);
  }

  /** Clean shutdown. */
  destroy() {
    if (this._cacheInterval) clearInterval(this._cacheInterval);
    this._cacheInterval = null;
    this._stopCdnChecks();
  }

  /** Toggle stream protection on/off. */
  setEnabled(enabled) {
    this.enabled = !!enabled;
    this.status.enabled = this.enabled;
    if (!this.enabled) {
      this.status.active = false;
      this.status.state = 'idle';
      this._waitingForReconnect = false;
      this._restartInProgress = false;
      this.status.canManualRestart = false;
      this.status.cdnHealth = null;
      this.status.cdnPlatforms = null;
      this._cdnMismatchCount = 0;
      this._stopCdnChecks();
    }
    this._emitStatus();
  }

  /**
   * Called when a stream stop command is processed through Tally Connect.
   * Sets a flag so we know the upcoming stream-stop is intentional.
   */
  markTCCommandedStop() {
    this._tcCommandedStop = true;
    this._tcCommandedStopAt = Date.now();
    // Auto-clear after 10s in case the stream doesn't actually stop
    setTimeout(() => { this._tcCommandedStop = false; }, 10_000);
  }

  /**
   * Called every time streaming state changes.
   * @param {boolean} isStreaming — current streaming state
   * @param {object} context — { encoderConnected, atemConnected, cacheUsed }
   */
  onStreamingStateChange(isStreaming, context = {}) {
    const wasStreaming = this._wasStreaming;
    this._wasStreaming = isStreaming;

    if (!wasStreaming && isStreaming) {
      // Stream just started — activate protection
      this._onStreamStarted();
      return;
    }

    if (wasStreaming && !isStreaming) {
      // Stream just stopped — evaluate why
      this._onStreamStopped(context);
    }
  }

  /**
   * Called when encoder connection state changes.
   * @param {boolean} connected
   */
  onEncoderConnectionChange(connected) {
    if (connected && this._waitingForReconnect && this.enabled) {
      // Encoder reconnected after infrastructure failure — auto-restart
      this._waitingForReconnect = false;
      this._autoRestart('Encoder reconnected — auto-restarting stream.');
    }
  }

  /**
   * Called when CDN verification results arrive (from relay stream_verification_result).
   * Used for case 5: CDN health validation.
   * @param {object} verification — { youtube: { live, viewerCount }, facebook: { live, viewerCount } }
   */
  onCdnVerificationResult(verification) {
    if (!this.enabled || !this.status.active) return;
    if (!verification) return;

    // Store last result for health display
    this._cdnLastResult = verification;

    // Build per-platform status for UI
    const cdnPlatforms = {};
    if (verification.youtube?.checked) {
      cdnPlatforms.youtube = { live: !!verification.youtube.live, viewerCount: verification.youtube.viewerCount || 0 };
    }
    if (verification.facebook?.checked) {
      cdnPlatforms.facebook = { live: !!verification.facebook.live, viewerCount: verification.facebook.viewerCount || 0 };
    }
    this.status.cdnPlatforms = Object.keys(cdnPlatforms).length > 0 ? cdnPlatforms : null;

    // Only evaluate mismatch if still in protecting state
    if (this.status.state !== 'protecting') {
      // Even in non-protecting states, update health display if we get results
      if (this.status.cdnPlatforms) {
        const allLive = Object.values(cdnPlatforms).every(p => p.live);
        this.status.cdnHealth = allLive ? 'healthy' : 'mismatch';
      }
      this._emitStatus();
      return;
    }

    if (this._cdnMismatchAlerted) return;

    // Only check after sufficient time has passed since stream started
    const elapsed = Date.now() - this._lastStreamStartAt;
    if (elapsed < CDN_CHECK_DELAY_MS) return;

    // Check if any platform was checked and reports NOT live
    const failedPlatforms = [];
    if (verification.youtube?.checked && !verification.youtube.live) {
      failedPlatforms.push('YouTube');
    }
    if (verification.facebook?.checked && !verification.facebook.live) {
      failedPlatforms.push('Facebook');
    }

    if (failedPlatforms.length > 0) {
      // Increment consecutive mismatch counter — only alert after threshold
      this._cdnMismatchCount++;
      this.status.cdnHealth = 'mismatch';

      if (this._cdnMismatchCount >= CDN_MISMATCH_THRESHOLD) {
        this._cdnMismatchAlerted = true;
        this.status.state = 'cdn_mismatch';
        this.status.canManualRestart = true;
        const platformStr = failedPlatforms.join(' and ');
        this._setEvent(`Stream appears active locally but not reaching ${platformStr}. Check network connection to streaming service.`);
        this._emitAlert('warning', `Stream appears active locally but not reaching ${platformStr}. Check network connection to streaming service.`);
      }
    } else {
      // CDN confirms stream is live — reset mismatch counter
      this._cdnMismatchCount = 0;
      this.status.cdnHealth = 'healthy';
    }

    this._emitStatus();
  }

  /**
   * Handle manual restart request from any client.
   */
  manualRestart() {
    if (!this.status.canManualRestart) return;
    this.status.canManualRestart = false;
    this._autoRestart('Manual stream restart requested.');
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _onStreamStarted() {
    this._lastStreamStartAt = Date.now();
    this._tcCommandedStop = false;
    this._waitingForReconnect = false;
    this._restartInProgress = false;
    this._cacheSamples = [];
    this._cdnMismatchAlerted = false;
    this._cdnMismatchCount = 0;
    this._cdnLastResult = null;
    this.status.active = true;
    this.status.state = 'protecting';
    this.status.canManualRestart = false;
    this.status.cdnHealth = 'checking';
    this.status.cdnPlatforms = null;
    this._setEvent('Stream started — protection active.');
    this._emitStatus();

    // Start CDN validation checks after delay
    this._startCdnChecks();
  }

  _onStreamStopped(context) {
    this._stopCdnChecks();
    this.status.cdnHealth = null;
    this.status.cdnPlatforms = null;
    this._cdnMismatchCount = 0;

    if (!this.enabled) {
      this.status.active = false;
      this.status.state = 'idle';
      this._emitStatus();
      return;
    }

    const { encoderConnected, atemConnected } = context;
    this._encoderConnectedAtDrop = encoderConnected;

    // Case 1: TC-commanded stop
    if (this._tcCommandedStop) {
      this._tcCommandedStop = false;
      this.status.active = false;
      this.status.state = 'idle';
      this.status.canManualRestart = false;
      this.status.cdnHealth = null;
      this.status.cdnPlatforms = null;
      this._setEvent('Stream stopped via Tally Connect.');
      this._emitAlert('info', 'Stream stopped.');
      this._emitStatus();
      return;
    }

    // Case 3: Elevated cache / error state before drop (check before case 2)
    if (this._wasCacheElevated()) {
      this.status.state = 'restarting';
      this._setEvent('Stream failed — elevated cache detected. Auto-restarting.');
      this._emitAlert('critical', 'Stream failed — auto-restarting.');
      this._autoRestart('Encoder cache was elevated before stream drop.');
      return;
    }

    // Case 2: Encoder disconnected (check with grace period)
    if (!encoderConnected || !atemConnected) {
      this._handleInfrastructureFailure(encoderConnected, atemConnected);
      return;
    }

    // Use grace period: encoder might disconnect slightly after stream
    setTimeout(() => {
      const encoderNow = this._getEncoderConnected();
      const atemNow = this._getAtemConnected();
      if (!encoderNow || !atemNow) {
        this._handleInfrastructureFailure(encoderNow, atemNow);
      } else {
        // Case 4: Clean stop, encoder still connected — probably intentional
        this.status.state = 'alert_sent';
        this.status.canManualRestart = true;
        this._setEvent('Stream stopped — encoder still connected. Likely intentional.');
        this._emitAlert('warning', 'Stream stopped — encoder still connected. Likely intentional.');
        this._emitStatus();
      }
    }, ENCODER_DISCONNECT_GRACE_MS);
  }

  _handleInfrastructureFailure(encoderConnected, atemConnected) {
    this._waitingForReconnect = true;
    this.status.state = 'encoder_disconnected';
    this.status.canManualRestart = false;
    const device = !encoderConnected && !atemConnected
      ? 'Encoder and ATEM disconnected'
      : !atemConnected
        ? 'ATEM disconnected'
        : 'Encoder disconnected';
    this._setEvent(`${device} — stream down. Monitoring for reconnection.`);
    this._emitAlert('critical', `${device} — stream down. Monitoring for reconnection.`);
    this._emitStatus();
  }

  _wasCacheElevated() {
    if (this._cacheSamples.length < 2) return false;
    // Check if any of the last 5 samples exceeded the threshold
    const recent = this._cacheSamples.slice(-5);
    return recent.some(s => s >= CACHE_THRESHOLD_PERCENT);
  }

  _sampleCache() {
    // Sample from ATEM streaming cache
    const cache = this.agent?.status?.atem?.streamingCacheUsed;
    if (cache != null && this.status.active) {
      this._cacheSamples.push(cache);
      while (this._cacheSamples.length > CACHE_WINDOW_SIZE) {
        this._cacheSamples.shift();
      }
    }
  }

  // ── CDN validation (case 5) ────────────────────────────────────────────────

  _startCdnChecks() {
    this._stopCdnChecks();
    // Request CDN verification after initial delay, then periodically
    this._cdnCheckTimer = setTimeout(() => {
      this._requestCdnVerification();
      this._cdnCheckInterval = setInterval(() => {
        if (this.status.active && this.status.state === 'protecting') {
          this._requestCdnVerification();
        }
      }, CDN_CHECK_INTERVAL_MS);
    }, CDN_CHECK_DELAY_MS);
  }

  _stopCdnChecks() {
    if (this._cdnCheckTimer) { clearTimeout(this._cdnCheckTimer); this._cdnCheckTimer = null; }
    if (this._cdnCheckInterval) { clearInterval(this._cdnCheckInterval); this._cdnCheckInterval = null; }
  }

  _requestCdnVerification() {
    // Ask the relay to verify stream on CDN platforms
    this.agent?.sendToRelay?.({ type: 'stream_verification_request' });
  }

  // ── Auto restart ───────────────────────────────────────────────────────────

  async _autoRestart(reason) {
    if (this._restartInProgress) return;
    this._restartInProgress = true;
    this.status.state = 'restarting';
    this._emitStatus();

    this.agent.log?.(`[StreamProtection] Auto-restart: ${reason}`);

    try {
      await this._restartStream();
      this._restartInProgress = false;
      // Stream state change will be picked up by onStreamingStateChange
    } catch (err) {
      this._restartInProgress = false;
      this.status.state = 'alert_sent';
      this.status.canManualRestart = true;
      this._setEvent(`Auto-restart failed: ${err.message}`);
      this._emitAlert('critical', `Stream auto-restart failed: ${err.message}`);
      this._emitStatus();
    }
  }

  async _restartStream() {
    const agent = this.agent;

    // Try ATEM streaming first
    if (agent.atem?.startStreaming && agent.status?.atem?.connected) {
      await agent.atem.startStreaming();
      return;
    }

    // Try encoder bridge
    if (agent.encoderBridge) {
      const result = await agent.encoderBridge.startStream();
      if (result != null) return;
    }

    // Try OBS
    if (agent.obs && agent.status?.obs?.connected) {
      await agent.obs.call('StartStream');
      return;
    }

    throw new Error('No streaming source available for restart');
  }

  _getEncoderConnected() {
    const s = this.agent?.status;
    return !!(s?.atem?.connected || s?.obs?.connected || s?.encoder?.connected || s?.vmix?.connected);
  }

  _getAtemConnected() {
    return !!this.agent?.status?.atem?.connected;
  }

  _setEvent(message) {
    this.status.lastEvent = message;
    this.status.lastEventAt = new Date().toISOString();
  }

  _emitStatus() {
    this.emit('status', { ...this.status });
    // Also push through relay
    this.agent?.sendToRelay?.({
      type: 'stream_protection_status',
      streamProtection: { ...this.status },
    });
  }

  _emitAlert(severity, message) {
    this.emit('alert', { severity, message });
    this.agent?.sendAlert?.(message, severity);
  }
}

module.exports = { StreamProtectionManager };
