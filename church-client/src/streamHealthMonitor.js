/**
 * Stream Platform Health Monitor
 *
 * Checks the health of the stream on its destination platform (YouTube / Facebook)
 * every 60 seconds while OBS is actively streaming.
 *
 * If no platform API keys are configured, falls back to OBS bitrate analysis:
 * if bitrate drops >50% from baseline within 30 seconds, alerts that the stream
 * may be failing at the platform level.
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

    // OBS bitrate fallback state
    this._bitrateHistory  = []; // [{ bytes, time }] for differential calculation
    this._baselineBitrate = null; // kbps baseline established early in stream
    this._bitrateKbps     = []; // rolling window of kbps samples
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
    this._bitrateHistory  = [];
    this._bitrateKbps     = [];
    console.log('[StreamHealthMonitor] Stopped');
  }

  /** Main check cycle — runs every 60 seconds */
  async check() {
    if (!this.agent) return;
    const { status, config } = this.agent;

    // Only check during active OBS streaming
    if (!status.obs?.streaming) {
      this._baselineBitrate = null;
      this._bitrateHistory  = [];
      this._bitrateKbps     = [];
      return;
    }

    let platformChecked = false;

    // ── YouTube Live ─────────────────────────────────────────────────────────
    if (config.youtubeApiKey) {
      await this._checkYouTube(config.youtubeApiKey).catch(e => {
        console.warn('[StreamHealthMonitor] YouTube check failed:', e.message);
      });
      platformChecked = true;
    }

    // ── Facebook Live ────────────────────────────────────────────────────────
    if (config.facebookAccessToken) {
      await this._checkFacebook(config.facebookAccessToken).catch(e => {
        console.warn('[StreamHealthMonitor] Facebook check failed:', e.message);
      });
      platformChecked = true;
    }

    // ── Fallback: OBS bitrate analysis ───────────────────────────────────────
    if (!platformChecked) {
      await this._checkOBSBitrate().catch(e => {
        console.warn('[StreamHealthMonitor] OBS bitrate check failed:', e.message);
      });
    }
  }

  // ─── YouTube ───────────────────────────────────────────────────────────────

  async _checkYouTube(apiKey) {
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
        'YouTube: No active broadcast found while OBS is streaming. The stream may not be reaching YouTube — check your stream key and network.'
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
          `YouTube reports no data received. The stream may have dropped — check OBS and your internet connection.`
        );
      }
    }
  }

  // ─── Facebook ─────────────────────────────────────────────────────────────

  async _checkFacebook(accessToken) {
    const url = `https://graph.facebook.com/v18.0/me/live_videos?status=LIVE&access_token=${encodeURIComponent(accessToken)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });

    if (!resp.ok) {
      console.warn(`[StreamHealthMonitor] Facebook API ${resp.status}`);
      return;
    }

    const data = await resp.json();
    const liveVideos = data.data || [];

    if (liveVideos.length === 0) {
      this._sendAlert(
        'facebook_no_live_video',
        'Facebook: No active LIVE video found while OBS is streaming. The stream may not be reaching Facebook — check your stream key.'
      );
    } else {
      console.log(`[StreamHealthMonitor] Facebook: ${liveVideos.length} live video(s) active`);
    }
  }

  // ─── OBS Bitrate Fallback ─────────────────────────────────────────────────

  async _checkOBSBitrate() {
    const { agent } = this;
    if (!agent.obs || !agent.status.obs?.connected) return;

    const streamStatus = await agent.obs.call('GetStreamStatus');
    if (!streamStatus.outputActive) {
      this._bitrateHistory = [];
      return;
    }

    const currentBytes = streamStatus.outputBytes || 0;
    const now = Date.now();

    if (this._bitrateHistory.length > 0) {
      const prev = this._bitrateHistory[this._bitrateHistory.length - 1];
      const elapsed = (now - prev.time) / 1000;

      if (elapsed > 0) {
        const bytesDiff = currentBytes - prev.bytes;
        if (bytesDiff >= 0) {
          const currentKbps = (bytesDiff * 8) / elapsed / 1000;
          this._bitrateKbps.push(currentKbps);

          // Keep rolling window: last 5 samples
          if (this._bitrateKbps.length > 5) this._bitrateKbps.shift();

          // Establish baseline from first BASELINE_SAMPLES samples
          if (!this._baselineBitrate && this._bitrateKbps.length >= BASELINE_SAMPLES) {
            this._baselineBitrate = this._bitrateKbps.reduce((a, b) => a + b, 0) / this._bitrateKbps.length;
            console.log(`[StreamHealthMonitor] Baseline bitrate: ${this._baselineBitrate.toFixed(0)} kbps`);
          }

          // Check for drop > threshold
          if (this._baselineBitrate && this._bitrateKbps.length >= BASELINE_SAMPLES) {
            const avgRecent = this._bitrateKbps.reduce((a, b) => a + b, 0) / this._bitrateKbps.length;
            const dropFraction = 1 - (avgRecent / this._baselineBitrate);

            if (dropFraction > BITRATE_DROP_THRESHOLD) {
              const dropPct = Math.round(dropFraction * 100);
              this._sendAlert(
                'stream_bitrate_drop',
                `Stream may be failing at platform — bitrate dropped ${dropPct}% ` +
                `(from ${this._baselineBitrate.toFixed(0)}kbps to ${avgRecent.toFixed(0)}kbps). ` +
                `Check your internet connection and platform dashboard.`
              );
            }
          }
        }
      }
    }

    // Always store current sample
    this._bitrateHistory.push({ bytes: currentBytes, time: now });
    if (this._bitrateHistory.length > 10) this._bitrateHistory.shift();
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
      baselineBitrate: this._baselineBitrate ? `${this._baselineBitrate.toFixed(0)} kbps` : null,
      recentBitrate: this._bitrateKbps.length
        ? `${(this._bitrateKbps.reduce((a, b) => a + b, 0) / this._bitrateKbps.length).toFixed(0)} kbps`
        : null,
    };
  }
}

module.exports = { StreamHealthMonitor };
