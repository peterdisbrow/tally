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
 *   vimeoAccessToken    - Vimeo OAuth2 access token (Enterprise accounts)
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

// Quality tier history retention (30 minutes)
const TIER_HISTORY_WINDOW_MS = 30 * 60_000;
// Duration threshold for critical alert (Poor tier for > 60s)
const POOR_TIER_CRITICAL_MS  = 60_000;

class StreamHealthMonitor {
  constructor() {
    this.agent = null;
    this._interval = null;
    this._lastAlertTimes = new Map(); // alertKey → timestamp

    // Bitrate fallback state
    this._baselineBitrate = null; // kbps baseline established early in stream
    this._bitrateKbps     = []; // rolling window of kbps samples
    this._lastBitrateSource = null; // which source provided the last reading

    // Quality tier tracking
    this._tierHistory = [];         // [{ tier, score, details, timestamp }]
    this._lastTier = null;          // most recent tier string
    this._poorTierSince = null;     // timestamp when Poor tier started (null if not Poor)
    this._criticalEmitted = false;  // whether critical alert was already emitted for current Poor streak

    // Viewer count tracking — snapshots sent to relay each check cycle
    this._viewerSnapshots = [];     // [{ platform, viewers, timestamp }]
    this._lastViewerReport = 0;     // timestamp of last relay report
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
    this._viewerSnapshots = [];
    this._lastViewerReport = 0;
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

    // ── Vimeo Live ────────────────────────────────────────────────────────────
    if (config.vimeoAccessToken) {
      await this._checkVimeo(config.vimeoAccessToken, streamSource).catch(e => {
        console.warn('[StreamHealthMonitor] Vimeo check failed:', e.message);
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
    const url = `https://www.googleapis.com/youtube/v3/liveBroadcasts?part=status,statistics&broadcastStatus=active&key=${encodeURIComponent(apiKey)}`;
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

    let totalViewers = 0;
    for (const broadcast of broadcasts) {
      const health = broadcast.status?.healthStatus?.status;
      const concurrent = parseInt(broadcast.statistics?.concurrentViewers);
      console.log(`[StreamHealthMonitor] YouTube broadcast health: ${health}, viewers: ${isNaN(concurrent) ? 'N/A' : concurrent}`);

      if (!isNaN(concurrent)) totalViewers += concurrent;

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

    // Record viewer snapshot
    if (totalViewers >= 0) {
      this._recordViewerSnapshot('youtube', totalViewers);
    }
  }

  // ─── Facebook ─────────────────────────────────────────────────────────────

  async _checkFacebook(accessToken, streamSource) {
    const url = `https://graph.facebook.com/v19.0/me/live_videos?status=LIVE&fields=id,title,live_views`;
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
      let totalViewers = 0;
      for (const video of liveVideos) {
        const viewers = parseInt(video.live_views);
        if (!isNaN(viewers)) totalViewers += viewers;
        console.log(`[StreamHealthMonitor] Facebook live video "${video.title || video.id}": ${isNaN(viewers) ? 'N/A' : viewers} viewers`);
      }
      this._recordViewerSnapshot('facebook', totalViewers);
    }
  }

  // ─── Vimeo ──────────────────────────────────────────────────────────────

  async _checkVimeo(accessToken, streamSource) {
    // Vimeo Live API — requires Enterprise account + OAuth2 token.
    // GET /me/live_events returns all live events for the authenticated user.
    // We then check each event's session status for ingest health.
    const url = 'https://api.vimeo.com/me/live_events?status=streaming&fields=uri,name,streaming_status';
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.vimeo.*+json;version=3.4',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) {
        console.warn('[StreamHealthMonitor] Vimeo API auth failed — check vimeoAccessToken');
      } else {
        console.warn(`[StreamHealthMonitor] Vimeo API ${resp.status}`);
      }
      return;
    }

    const data = await resp.json();
    const events = data.data || [];

    if (events.length === 0) {
      this._sendAlert(
        'vimeo_no_active_event',
        `Vimeo: No active live event found while ${streamSource} is streaming. The stream may not be reaching Vimeo — check your stream key and network.`
      );
      return;
    }

    // Check each active event's session for ingest health + viewer counts
    let totalVimeoViewers = 0;
    for (const event of events) {
      const eventUri = event.uri; // e.g. /live_events/12345
      if (!eventUri) continue;

      const sessionUrl = `https://api.vimeo.com${eventUri}/sessions?fields=status,ingest,viewer_count`;
      const sessionResp = await fetch(sessionUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.vimeo.*+json;version=3.4',
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!sessionResp.ok) continue;

      const sessionData = await sessionResp.json();
      const sessions = sessionData.data || [];

      let eventViewers = 0;
      for (const session of sessions) {
        const ingestStatus = parseInt(session.ingest?.status);
        const sessionStatus = session.status;
        const viewers = parseInt(session.viewer_count);

        console.log(`[StreamHealthMonitor] Vimeo event "${event.name || eventUri}" — status: ${sessionStatus}, ingest: ${ingestStatus}, viewers: ${isNaN(viewers) ? 'N/A' : viewers}`);

        if (!isNaN(viewers)) eventViewers += viewers;

        // Ingest status scale: 0=provisioning, 1=waiting, 2=receiving, 3=streaming, 4=ending, 5=ended
        if (sessionStatus === 'started' && (ingestStatus === 0 || ingestStatus === 1)) {
          this._sendAlert(
            'vimeo_ingest_waiting',
            `Vimeo event "${event.name}" is started but not receiving data (ingest status: ${ingestStatus}). ` +
            `The stream may not be reaching Vimeo — check your RTMP connection.`
          );
        }

        // Log resolution if available
        if (session.ingest?.width && session.ingest?.height) {
          console.log(`[StreamHealthMonitor] Vimeo ingest: ${session.ingest.width}x${session.ingest.height} via ${session.ingest.encoder_type || 'unknown'}`);
        }
      }
      if (eventViewers > 0) totalVimeoViewers += eventViewers;
    }

    // Record viewer snapshot (Vimeo viewer_count is Enterprise-only, may be 0)
    if (totalVimeoViewers > 0) {
      this._recordViewerSnapshot('vimeo', totalVimeoViewers);
    }
  }

  // ─── Viewer Snapshot Tracking ────────────────────────────────────────────

  /**
   * Record a viewer count snapshot and report to relay.
   * @param {string} platform - 'youtube' | 'facebook' | 'vimeo'
   * @param {number} viewers  - concurrent viewer count
   */
  _recordViewerSnapshot(platform, viewers) {
    const now = Date.now();
    this._viewerSnapshots.push({ platform, viewers, timestamp: now });

    // Keep last 60 snapshots (1 hour at 60s intervals)
    while (this._viewerSnapshots.length > 60) this._viewerSnapshots.shift();

    // Report to relay (batch all platforms per check cycle — debounce 2s)
    if (now - this._lastViewerReport > 2000) {
      this._lastViewerReport = now;
      // Collect latest snapshot per platform
      const latest = {};
      for (const snap of this._viewerSnapshots) {
        if (!latest[snap.platform] || snap.timestamp > latest[snap.platform].timestamp) {
          latest[snap.platform] = snap;
        }
      }

      const totalViewers = Object.values(latest).reduce((sum, s) => sum + s.viewers, 0);
      const breakdown = Object.fromEntries(
        Object.entries(latest).map(([p, s]) => [p, s.viewers])
      );

      if (this.agent) {
        this.agent.sendToRelay({
          type: 'viewer_snapshot',
          total: totalViewers,
          breakdown,
          timestamp: new Date(now).toISOString(),
        });
      }
    }
  }

  /**
   * Get the latest viewer counts per platform.
   * @returns {{ total: number, breakdown: Object<string, number>, snapshots: Array }}
   */
  getViewerCounts() {
    const latest = {};
    for (const snap of this._viewerSnapshots) {
      if (!latest[snap.platform] || snap.timestamp > latest[snap.platform].timestamp) {
        latest[snap.platform] = snap;
      }
    }
    const breakdown = Object.fromEntries(
      Object.entries(latest).map(([p, s]) => [p, s.viewers])
    );
    return {
      total: Object.values(latest).reduce((sum, s) => sum + s.viewers, 0),
      breakdown,
      snapshots: [...this._viewerSnapshots],
    };
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

  // ─── Quality Tier Classification ──────────────────────────────────────────

  /**
   * Classify the stream quality into a tier based on current metrics.
   * @param {number|null|undefined} bitrate   - Current bitrate in bps (bits per second)
   * @param {string|null|undefined} resolution - e.g. '1920x1080', '1280x720'
   * @param {number|null|undefined} fps        - Frames per second
   * @param {number|null|undefined} frameDropRate - Fraction of frames dropped (0.0 – 1.0)
   * @returns {{ tier: string, score: number, details: string }}
   */
  getStreamQualityTier(bitrate, resolution, fps, frameDropRate) {
    // Handle missing / invalid data
    if (bitrate == null || bitrate <= 0) {
      return { tier: 'poor', score: 0, details: 'No bitrate data available' };
    }

    const bitrateMbps = bitrate / 1_000_000;
    const dropPct = (frameDropRate != null && frameDropRate >= 0)
      ? frameDropRate * 100
      : 0;

    // Parse resolution height
    let height = 0;
    if (resolution && typeof resolution === 'string') {
      const parts = resolution.split('x');
      if (parts.length === 2) height = parseInt(parts[1], 10) || 0;
    }

    const effectiveFps = (fps != null && fps > 0) ? fps : 0;

    // ── Score components ──────────────────────────────────────────────────
    // Bitrate score (0-40)
    let bitrateScore;
    if (bitrateMbps >= 4)       bitrateScore = 40;
    else if (bitrateMbps >= 2.5) bitrateScore = 32;
    else if (bitrateMbps >= 2)   bitrateScore = 26;
    else if (bitrateMbps >= 1.5) bitrateScore = 20;
    else if (bitrateMbps >= 1)   bitrateScore = 14;
    else                         bitrateScore = Math.max(0, Math.round(bitrateMbps * 14));

    // Resolution score (0-25)
    let resolutionScore;
    if (height >= 1080)      resolutionScore = 25;
    else if (height >= 720)  resolutionScore = 18;
    else if (height >= 480)  resolutionScore = 10;
    else if (height > 0)     resolutionScore = 5;
    else                     resolutionScore = 0;

    // FPS score (0-15)
    let fpsScore;
    if (effectiveFps >= 60)      fpsScore = 15;
    else if (effectiveFps >= 30) fpsScore = 10;
    else if (effectiveFps > 0)   fpsScore = 5;
    else                         fpsScore = 0;

    // Frame drop penalty (0-20 points deducted)
    let dropPenalty;
    if (dropPct <= 1)       dropPenalty = 0;
    else if (dropPct <= 3)  dropPenalty = 6;
    else if (dropPct <= 10) dropPenalty = 14;
    else                    dropPenalty = 20;

    let rawScore = bitrateScore + resolutionScore + fpsScore - dropPenalty;

    // ── Tier determination based on spec rules ────────────────────────────
    // Apply the spec constraints — these override the score when metrics
    // clearly place the stream into a specific tier.
    let tier;

    if (dropPct >= 10 || bitrateMbps < 1) {
      // Poor: <1 Mbps OR >=10% frame drops
      tier = 'poor';
      rawScore = Math.min(rawScore, 39);
    } else if (
      dropPct < 1 &&
      (
        (bitrateMbps > 4 && height >= 1080 && effectiveFps >= 60) ||
        (bitrateMbps > 2.5 && height >= 720 && effectiveFps >= 30)
      )
    ) {
      tier = 'excellent';
      rawScore = Math.max(rawScore, 85);
    } else if (
      dropPct < 3 &&
      (
        (bitrateMbps > 2 && height >= 1080) ||
        (bitrateMbps > 1.5 && height >= 720)
      )
    ) {
      tier = 'good';
      rawScore = Math.max(rawScore, 65);
      rawScore = Math.min(rawScore, 84);
    } else if (bitrateMbps >= 1 && dropPct < 10) {
      tier = 'fair';
      rawScore = Math.max(rawScore, 40);
      rawScore = Math.min(rawScore, 64);
    } else {
      tier = 'poor';
      rawScore = Math.min(rawScore, 39);
    }

    const score = Math.max(0, Math.min(100, rawScore));

    // Build details string
    const details = `${bitrateMbps.toFixed(1)}Mbps ${resolution || 'unknown'}@${effectiveFps || '?'}fps, ${dropPct.toFixed(1)}% drops`;

    const result = { tier, score, details };

    // ── Track tier history and emit transition events ──────────────────────
    this._recordTierChange(result);

    return result;
  }

  /**
   * Record a tier result and emit events on significant transitions.
   */
  _recordTierChange(result) {
    const now = Date.now();
    const { tier } = result;

    // Add to history
    this._tierHistory.push({ ...result, timestamp: now });

    // Prune history older than 30 minutes
    const cutoff = now - TIER_HISTORY_WINDOW_MS;
    this._tierHistory = this._tierHistory.filter(e => e.timestamp >= cutoff);

    // ── Tier transition events ────────────────────────────────────────────
    const tierOrder = ['excellent', 'good', 'fair', 'poor'];
    const prevIndex = this._lastTier ? tierOrder.indexOf(this._lastTier) : -1;
    const currIndex = tierOrder.indexOf(tier);

    if (this._lastTier && prevIndex >= 0 && currIndex >= 0) {
      const tierDrop = currIndex - prevIndex; // positive = degradation
      if (tierDrop >= 2) {
        this._emitQualityEvent('stream_quality_degraded', {
          from: this._lastTier,
          to: tier,
          score: result.score,
          details: result.details,
        });
      }
    }

    // ── Poor-tier duration tracking ───────────────────────────────────────
    if (tier === 'poor') {
      if (this._poorTierSince === null) {
        this._poorTierSince = now;
        this._criticalEmitted = false;
      }
      const poorDuration = now - this._poorTierSince;
      if (poorDuration >= POOR_TIER_CRITICAL_MS && !this._criticalEmitted) {
        this._criticalEmitted = true;
        this._emitQualityEvent('stream_quality_critical', {
          tier,
          score: result.score,
          poorDurationMs: poorDuration,
          details: result.details,
        });
      }
    } else {
      this._poorTierSince = null;
      this._criticalEmitted = false;
    }

    this._lastTier = tier;
  }

  /**
   * Emit a quality event through the agent relay.
   */
  _emitQualityEvent(eventType, data) {
    console.log(`[StreamHealthMonitor] Quality event: ${eventType}`, JSON.stringify(data));
    if (this.agent) {
      this.agent.sendToRelay({
        type: 'alert',
        alertType: eventType,
        ...data,
        severity: eventType === 'stream_quality_critical' ? 'critical' : 'warning',
      });
    }
  }

  /**
   * Get tier history (last 30 minutes of tier changes).
   */
  getTierHistory() {
    return [...this._tierHistory];
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
    const lastTierEntry = this._tierHistory.length
      ? this._tierHistory[this._tierHistory.length - 1]
      : null;

    const viewerCounts = this.getViewerCounts();

    return {
      monitoring: !!this._interval,
      streamSource: this._lastBitrateSource,
      baselineBitrate: this._baselineBitrate ? `${this._baselineBitrate.toFixed(0)} kbps` : null,
      recentBitrate: this._bitrateKbps.length
        ? `${(this._bitrateKbps.reduce((a, b) => a + b, 0) / this._bitrateKbps.length).toFixed(0)} kbps`
        : null,
      qualityTier: lastTierEntry ? lastTierEntry.tier : null,
      qualityScore: lastTierEntry ? lastTierEntry.score : null,
      tierHistory: this._tierHistory.length,
      viewers: viewerCounts.total || null,
      viewerBreakdown: Object.keys(viewerCounts.breakdown).length ? viewerCounts.breakdown : null,
    };
  }
}

/**
 * Standalone convenience wrapper — creates a temporary monitor instance to
 * classify quality without needing the full monitoring lifecycle.
 */
function getStreamQualityTier(bitrate, resolution, fps, frameDropRate) {
  const monitor = new StreamHealthMonitor();
  return monitor.getStreamQualityTier(bitrate, resolution, fps, frameDropRate);
}

module.exports = { StreamHealthMonitor, getStreamQualityTier };
