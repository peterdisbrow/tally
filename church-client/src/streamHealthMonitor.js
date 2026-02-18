'use strict';

/**
 * StreamHealthMonitor — Feature 9
 * Checks YouTube Live and Facebook Live APIs every 60 seconds while streaming.
 * Also monitors OBS bitrate for sharp drops that suggest platform rejection.
 *
 * Requires Node 18+ for native fetch().
 */

const CHECK_INTERVAL_MS    = 60_000;       // 60 seconds
const DEDUP_WINDOW_MS      = 10 * 60_000;  // 10-minute alert dedup
const BITRATE_DROP_RATIO   = 0.40;         // alert if drops below 40% of previous (>60% drop)
const BITRATE_MIN_KBPS     = 500;          // only alert if previous bitrate was above this

class StreamHealthMonitor {
  constructor() {
    this._interval   = null;
    this._agent      = null;
    this._lastAlerts = new Map(); // alertKey → timestamp of last send
    this._lastBitrate = null;    // kbps from previous check window
  }

  /** Begin monitoring. Call from agent start(). */
  start(agent) {
    this._agent = agent;
    console.log('📡 StreamHealthMonitor started (60s interval)');
    this._interval = setInterval(() => this.check(), CHECK_INTERVAL_MS);
  }

  /** Stop monitoring. */
  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    console.log('📡 StreamHealthMonitor stopped');
  }

  /**
   * Called every 60 seconds.
   * Runs all health checks; no-ops when not streaming.
   */
  async check() {
    const agent = this._agent;
    if (!agent) return;

    // Only check while OBS reports streaming
    if (!agent.status?.obs?.streaming) {
      // Reset bitrate baseline when not streaming
      this._lastBitrate = null;
      return;
    }

    console.log('📡 Running stream platform health checks...');

    // Run checks concurrently where possible
    await Promise.allSettled([
      this._checkYouTube(agent),
      this._checkFacebook(agent),
    ]);

    // Bitrate check is synchronous — run after
    this._checkBitrate(agent);
  }

  // ── YouTube Live API ───────────────────────────────────────────────────────

  async _checkYouTube(agent) {
    const apiKey = agent.config?.youtubeApiKey;
    if (!apiKey) return;

    try {
      const url = `https://www.googleapis.com/youtube/v3/liveBroadcasts?part=status&broadcastStatus=active&key=${encodeURIComponent(apiKey)}`;
      const resp = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        console.log(`📡 YouTube API error ${resp.status}: ${body.slice(0, 200)}`);
        return;
      }

      const data = await resp.json();

      if (!data.items || data.items.length === 0) {
        this._dedupAlert(
          'youtube_no_broadcast',
          '⚠️ No active YouTube broadcast found — stream may not be reaching YouTube',
          agent
        );
        return;
      }

      const healthStatus = data.items[0]?.status?.healthStatus?.status;
      if (healthStatus === 'bad' || healthStatus === 'noData') {
        this._dedupAlert(
          'youtube_bad_health',
          `⚠️ YouTube stream health: ${healthStatus}. Check stream settings.`,
          agent
        );
      } else {
        console.log(`📡 YouTube stream health: ${healthStatus || 'unknown'}`);
      }
    } catch (e) {
      console.log(`📡 YouTube health check failed: ${e.message}`);
    }
  }

  // ── Facebook Live API ──────────────────────────────────────────────────────

  async _checkFacebook(agent) {
    const accessToken = agent.config?.facebookAccessToken;
    if (!accessToken) return;

    try {
      const url = `https://graph.facebook.com/v18.0/me/live_videos?status=LIVE&fields=status&access_token=${encodeURIComponent(accessToken)}`;
      const resp = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        console.log(`📡 Facebook API error ${resp.status}: ${body.slice(0, 200)}`);
        return;
      }

      const data = await resp.json();

      if (!data.data || data.data.length === 0) {
        this._dedupAlert(
          'facebook_no_stream',
          '⚠️ No active Facebook Live stream found',
          agent
        );
      } else {
        console.log(`📡 Facebook Live: ${data.data.length} active stream(s)`);
      }
    } catch (e) {
      console.log(`📡 Facebook health check failed: ${e.message}`);
    }
  }

  // ── Bitrate Drop Check ─────────────────────────────────────────────────────

  _checkBitrate(agent) {
    const currentBitrate = agent.status?.obs?.bitrate;

    if (typeof currentBitrate !== 'number' || currentBitrate === null) {
      return;
    }

    if (this._lastBitrate !== null) {
      const wasAboveThreshold = this._lastBitrate > BITRATE_MIN_KBPS;
      const droppedSignificantly = currentBitrate < this._lastBitrate * BITRATE_DROP_RATIO;

      if (wasAboveThreshold && droppedSignificantly) {
        const dropPct = Math.round((1 - currentBitrate / this._lastBitrate) * 100);
        console.log(
          `📡 ⚠️  Bitrate dropped ${dropPct}%: ${this._lastBitrate}kbps → ${currentBitrate}kbps`
        );
        this._dedupAlert(
          'bitrate_drop',
          '⚠️ Stream bitrate dropped sharply — possible platform rejection',
          agent
        );
        // Reset baseline to current (post-drop) level to avoid re-alerting on the same event
        this._lastBitrate = currentBitrate;
        return;
      }
    }

    // Update baseline for next window
    this._lastBitrate = currentBitrate;
  }

  // ── Dedup Alert Helper ─────────────────────────────────────────────────────

  /**
   * Send an alert via the agent only if the same key hasn't been sent
   * within the 10-minute dedup window.
   */
  _dedupAlert(key, message, agent) {
    const now  = Date.now();
    const last = this._lastAlerts.get(key) || 0;

    if (now - last < DEDUP_WINDOW_MS) {
      // Within dedup window — skip
      return;
    }

    this._lastAlerts.set(key, now);
    console.log(`📡 ${message}`);
    agent.sendAlert(message, 'warning');
  }
}

module.exports = { StreamHealthMonitor };
