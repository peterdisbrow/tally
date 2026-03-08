/**
 * Stream Platform Health Monitor
 *
 * Checks the health of the stream on its destination platform (YouTube / Facebook)
 * every 60 seconds while ANY source is actively streaming (OBS, ATEM, vMix, encoder, etc.).
 *
 * If no platform API keys are configured, falls back to bitrate analysis using
 * whatever source is providing bitrate data (OBS, ATEM encoder, hardware encoder).
 * If bitrate drops >50% from baseline, alerts that the stream may be failing.
 *
 * Config keys (in ~/.church-av/config.json):
 *   youtubeApiKey       - YouTube Data API v3 key
 *   facebookAccessToken - Facebook Graph API access token
 *
 * Class: StreamHealthMonitor
 *   start(agent)  — begin monitoring
 *   stop()        — stop monitoring
 *   check()       — run one check cycle (exposed for testing / manual trigger)
 *   getStatus()   — current state for watchdog reporting
 */

const CHECK_INTERVAL_MS      = 60_000;     // check every 60 seconds
const DEDUP_WINDOW_MS        = 5 * 60_000; // don't re-alert same issue within 5 min
const BITRATE_DROP_THRESHOLD = 0.5;        // 50% drop from baseline triggers alert
const BASELINE_SAMPLES       = 3;          // samples needed before baseline is set

class StreamHealthMonitor {
  constructor() {
    this.agent = null;
    this._interval = null;
    this._lastAlertTimes = new Map(); // alertKey → timestamp

    // Bitrate fallback state
    this._baselineBitrate = null; // kbps baseline established early in stream
    this._bitrateKbps     = []; // rolling window of kbps samples
    this._lastBitrateSource = null; // which source provided the last reading
  }

  /** Start monitoring. Must be called with the ChurchAVAgent instance. */
  start(agent) {
    if (this._interval) return;
    this.agent = agent;
    this._interval = setInterval(() => {
      this.check().catch(e => console.error('[StreamHealthMonitor] check error:', e.message));
    }, CHECK_INTERVAL_MS);
    console.log('[StreamHealthMonitor] Started (60s check interval)');
  }

  /** Stop monitoring */
  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this.agent = null;
    this._baselineBitrate = null;
    this._bitrateKbps     = [];
    this._lastBitrateSource = null;
    console.log('[StreamHealthMonitor] Stopped');
  }

  /**
   * Detect if ANY source is actively streaming.
   * Returns the streaming source name or null.
   */
  _getActiveStreamSource() {
    if (!this.agent) return null;
    const { status } = this.agent;
    if (status.obs?.streaming)                             return 'obs';
    if (status.atem?.streaming)                            return 'atem';
    if (status.vmix?.streaming)                            return 'vmix';
    if (status.encoder?.live || status.encoder?.streaming) return status.encoder?.type || 'encoder';
    return null;
  }

  /**
   * Get the current bitrate from whatever source is streaming.
   * Returns { bitrateKbps, source } or null.
   */
  _getCurrentBitrate() {
    if (!this.agent) return null;
    const { status } = this.agent;

    // OBS — bitrate in kbps directly
    if (status.obs?.streaming && status.obs.bitrate > 0)
      return { bitrateKbps: status.obs.bitrate, source: 'OBS' };

    // ATEM built-in encoder — bitrate in bps, convert to kbps
    if (status.atem?.streaming && status.atem.streamingBitrate > 0)
      return { bitrateKbps: Math.round(status.atem.streamingBitrate / 1000), source: 'ATEM' };

    // Hardware/software encoder via EncoderBridge
    if ((status.encoder?.live || status.encoder?.streaming) && status.encoder.bitrateKbps > 0)
      return { bitrateKbps: status.encoder.bitrateKbps, source: status.encoder.type || 'Encoder' };

    // vMix — doesn't expose bitrate, can't monitor
    return null;
  }

  /** Main check cycle — runs every 60 seconds */
  async check() {
    if (!this.agent) return;
    const { config } = this.agent;

    // Check if ANY source is streaming (not just OBS)
    const streamSource = this._getActiveStreamSource();
    if (!streamSource) {
      // No active stream — reset baseline
      this._baselineBitrate = null;
      this._bitrateKbps     = [];
      this._lastBitrateSource = null;
      return;
    }

    let platformChecked = false;

    // ── YouTube Live ─────────────────────────────────────────────────────────
    if (config.youtubeApiKey) {
      await this._checkYouTube(config.youtubeApiKey, streamSource).catch(e => {
        console.warn('[StreamHealthMonitor] YouTube check failed:', e.message);
      });
      platformChecked = true;
    }

    // ── Facebook Live ────────────────────────────────────────────────────────
    if (config.facebookAccessToken) {
      await this._checkFacebook(config.facebookAccessToken, streamSource).catch(e => {
        console.warn('[StreamHealthMonitor] Facebook check failed:', e.message);
      });
      platformChecked = true;
    }

    // ── Fallback: bitrate analysis from any source ───────────────────────────
    if (!platformChecked) {
      await this._checkBitrate().catch(e => {
        console.warn('[StreamHealthMonitor] Bitrate check failed:', e.message);
      });
    }
  }

  // ─── YouTube ───────────────────────────────────────────────────────────────

  async _checkYouTube(apiKey, streamSource) {
    const url = `https://www.googleapis.com/youtube/v3/liveBroadcasts?part=status&broadcastStatus=active&key=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });

    if (!resp.ok) {
      console.warn(`[StreamHealthMonitor] YouTube API ${resp.status}`);
      return;
    }

    const data = await resp.json();
    const broadcasts = data.items || [];

    if (broadcasts.length === 0) {
      this._sendAlert(
        'youtube_no_active_broadcast',
        `YouTube: No active broadcast found while ${streamSource} is streaming. The stream may not be reaching YouTube — check your stream key and network.`
      );
      return;
    }

    for (const broadcast of broadcasts) {
      const health = broadcast.status?.healthStatus?.status;
      console.log(`[StreamHealthMonitor] YouTube broadcast health: ${health}`);

      if (health === 'bad') {
        this._sendAlert(
          'youtube_stream_health_bad',
          `YouTube stream health is BAD. Viewers are likely experiencing issues. Check your encoder settings and network connection.`
        );
      } else if (health === 'noData') {
        this._sendAlert(
          'youtube_stream_no_data',
          `YouTube reports no data received. The stream may have dropped — check ${streamSource} and your internet connection.`
        );
      }
    }
  }

  // ─── Facebook ─────────────────────────────────────────────────────────────

  async _checkFacebook(accessToken, streamSource) {
    const url = `https://graph.facebook.com/v18.0/me/live_videos?status=LIVE`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      console.warn(`[StreamHealthMonitor] Facebook API ${resp.status}`);
      return;
    }

    const data = await resp.json();
    const liveVideos = data.data || [];

    if (liveVideos.length === 0) {
      this._sendAlert(
        'facebook_no_live_video',
        `Facebook: No active LIVE video found while ${streamSource} is streaming. The stream may not be reaching Facebook — check your stream key.`
      );
    } else {
      console.log(`[StreamHealthMonitor] Facebook: ${liveVideos.length} live video(s) active`);
    }
  }

  // ─── Bitrate Fallback (source-agnostic) ─────────────────────────────────

  async _checkBitrate() {
    const reading = this._getCurrentBitrate();
    if (!reading) return; // no bitrate data available from any source

    const { bitrateKbps, source } = reading;

    // If source changed (e.g. switched from OBS to ATEM encoder), reset baseline
    if (this._lastBitrateSource && this._lastBitrateSource !== source) {
      console.log(`[StreamHealthMonitor] Stream source changed (${this._lastBitrateSource} → ${source}), resetting baseline`);
      this._baselineBitrate = null;
      this._bitrateKbps = [];
    }
    this._lastBitrateSource = source;

    this._bitrateKbps.push(bitrateKbps);

    // Keep rolling window: last 5 samples
    if (this._bitrateKbps.length > 5) this._bitrateKbps.shift();

    // Establish baseline from first BASELINE_SAMPLES samples
    if (!this._baselineBitrate && this._bitrateKbps.length >= BASELINE_SAMPLES) {
      this._baselineBitrate = this._bitrateKbps.reduce((a, b) => a + b, 0) / this._bitrateKbps.length;
      console.log(`[StreamHealthMonitor] Baseline bitrate (${source}): ${this._baselineBitrate.toFixed(0)} kbps`);
    }

    // Check for drop > threshold
    if (this._baselineBitrate && this._bitrateKbps.length >= BASELINE_SAMPLES) {
      const avgRecent = this._bitrateKbps.reduce((a, b) => a + b, 0) / this._bitrateKbps.length;
      const dropFraction = 1 - (avgRecent / this._baselineBitrate);

      if (dropFraction > BITRATE_DROP_THRESHOLD) {
        const dropPct = Math.round(dropFraction * 100);
        this._sendAlert(
          'stream_bitrate_drop',
          `Stream may be failing — ${source} bitrate dropped ${dropPct}% ` +
          `(from ${this._baselineBitrate.toFixed(0)}kbps to ${avgRecent.toFixed(0)}kbps). ` +
          `Check your internet connection and platform dashboard.`
        );
      }
    }
  }

  // ─── Alert helper ─────────────────────────────────────────────────────────

  _sendAlert(alertKey, message) {
    const now = Date.now();
    const lastSent = this._lastAlertTimes.get(alertKey) || 0;
    if (now - lastSent < DEDUP_WINDOW_MS) return;

    this._lastAlertTimes.set(alertKey, now);
    console.log(`[StreamHealthMonitor] ⚠️ ${message}`);

    if (this.agent) {
      this.agent.sendToRelay({
        type: 'alert',
        alertType: 'stream_platform_health',
        message,
        severity: 'warning',
      });
    }
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  getStatus() {
    return {
      monitoring: !!this._interval,
      streamSource: this._lastBitrateSource,
      baselineBitrate: this._baselineBitrate ? `${this._baselineBitrate.toFixed(0)} kbps` : null,
      recentBitrate: this._bitrateKbps.length
        ? `${(this._bitrateKbps.reduce((a, b) => a + b, 0) / this._bitrateKbps.length).toFixed(0)} kbps`
        : null,
    };
  }
}

module.exports = { StreamHealthMonitor };
