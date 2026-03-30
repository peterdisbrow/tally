'use strict';
/**
 * Broadcast Monitor — polls YouTube Live Streaming API and Facebook Graph API
 * to monitor active broadcast/stream health for connected churches.
 *
 * Follows the same pattern as syncMonitor.js:
 *   setupBroadcastMonitor(db, relay, alertEngine, notifyUpdate)
 *
 * Surfaces health data on church runtime objects so the portal can display
 * green/yellow/red status indicators alongside other equipment.
 */

const YT_BROADCASTS_URL = 'https://www.googleapis.com/youtube/v3/liveBroadcasts';
const YT_STREAMS_URL    = 'https://www.googleapis.com/youtube/v3/liveStreams';
const YT_TOKEN_URL      = 'https://oauth2.googleapis.com/token';
const FB_GRAPH_URL      = 'https://graph.facebook.com/v19.0';

const POLL_INTERVAL_MS  = 60_000;  // poll every 60s (API quota friendly)
const ALERT_THROTTLE_MS = 5 * 60 * 1000; // 5 min between repeated alerts

/**
 * Derive a health status from YouTube stream health data.
 * @param {object} streamHealth - YouTube liveStream healthStatus object
 * @returns {'good'|'warning'|'error'|'noData'}
 */
function deriveYouTubeHealth(streamHealth) {
  if (!streamHealth) return 'noData';
  const status = streamHealth.status || '';
  // YouTube health status values: good, ok, bad, noData, revoked
  if (status === 'good' || status === 'ok') return 'good';
  if (status === 'bad' || status === 'revoked') return 'error';
  if (status === 'noData') return 'noData';
  return 'warning';
}

/**
 * Derive a health status from Facebook live video status.
 * @param {string} fbStatus - Facebook live_video status field
 * @returns {'good'|'warning'|'error'|'noData'}
 */
function deriveFacebookHealth(fbStatus) {
  if (!fbStatus) return 'noData';
  const s = fbStatus.toUpperCase();
  if (s === 'LIVE') return 'good';
  if (s === 'UNPUBLISHED' || s === 'SCHEDULED_UNPUBLISHED') return 'warning';
  if (s === 'VOD' || s === 'PROCESSING') return 'noData';
  return 'error'; // SCHEDULED_CANCELED, ERROR states
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ churches: Map<string, object> }} relay
 * @param {object} alertEngine - AlertEngine instance
 * @param {function} notifyUpdate - (churchId?) => void — push SSE update
 */
function setupBroadcastMonitor(db, relay, alertEngine, notifyUpdate) {
  // Per-church state
  // churchId → { youtube: {...}, facebook: {...}, lastAlerts: { yt, fb } }
  const state = new Map();

  function getState(churchId) {
    if (!state.has(churchId)) {
      state.set(churchId, {
        youtube: null,
        facebook: null,
        lastAlerts: { yt: 0, fb: 0 },
        prevYtHealth: null,
        prevFbHealth: null,
      });
    }
    return state.get(churchId);
  }

  // ── YouTube broadcast health polling ──────────────────────────────────────

  async function refreshYouTubeToken(churchId, refreshToken) {
    const clientId = process.env.YOUTUBE_CLIENT_ID;
    const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
    if (!clientId || !clientSecret || !refreshToken) return null;

    try {
      const resp = await fetch(YT_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) return null;
      const tokens = await resp.json();
      const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();
      db.prepare('UPDATE churches SET yt_access_token = ?, yt_token_expires_at = ? WHERE churchId = ?')
        .run(tokens.access_token, expiresAt, churchId);
      return tokens.access_token;
    } catch {
      return null;
    }
  }

  async function pollYouTube(churchId, church) {
    const row = db.prepare(
      'SELECT yt_access_token, yt_refresh_token, yt_token_expires_at, yt_channel_name FROM churches WHERE churchId = ?'
    ).get(churchId);
    if (!row?.yt_access_token) return;

    let accessToken = row.yt_access_token;

    // Refresh token if expired or expiring within 2 min
    if (row.yt_token_expires_at) {
      const expiresAt = new Date(row.yt_token_expires_at);
      if (expiresAt.getTime() - Date.now() < 2 * 60 * 1000) {
        const refreshed = await refreshYouTubeToken(churchId, row.yt_refresh_token);
        if (refreshed) accessToken = refreshed;
        else return; // can't refresh, skip this cycle
      }
    }

    const cs = getState(churchId);
    try {
      // 1. Get active broadcasts
      const bcResp = await fetch(
        `${YT_BROADCASTS_URL}?part=status,snippet,statistics,contentDetails&broadcastStatus=active&mine=true`,
        { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10000) }
      );
      if (!bcResp.ok) {
        cs.youtube = { status: 'api_error', error: `HTTP ${bcResp.status}`, checkedAt: new Date().toISOString() };
        return;
      }
      const bcData = await bcResp.json();
      const broadcast = bcData.items?.[0];

      if (!broadcast) {
        cs.youtube = { status: 'no_broadcast', live: false, checkedAt: new Date().toISOString() };
        handleYouTubeTransition(churchId, church, cs, 'noData');
        return;
      }

      // 2. Get the bound stream's health details
      const streamId = broadcast.contentDetails?.boundStreamId;
      let streamHealth = null;
      let resolution = null;
      let framerate = null;
      let ingestionInfo = null;

      if (streamId) {
        const stResp = await fetch(
          `${YT_STREAMS_URL}?part=status,cdn,snippet&id=${streamId}`,
          { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(8000) }
        );
        if (stResp.ok) {
          const stData = await stResp.json();
          const stream = stData.items?.[0];
          if (stream) {
            streamHealth = stream.status?.healthStatus || null;
            resolution = stream.cdn?.resolution || null;
            framerate = stream.cdn?.frameRate || null;
            ingestionInfo = stream.cdn?.ingestionInfo || null;
          }
        }
      }

      const lifecycleStatus = broadcast.status?.lifeCycleStatus || 'unknown';
      const concurrentViewers = parseInt(broadcast.statistics?.concurrentViewers || '0', 10) || 0;
      const healthStatus = deriveYouTubeHealth(streamHealth);

      cs.youtube = {
        status: healthStatus,
        live: lifecycleStatus === 'live',
        lifecycleStatus,
        title: broadcast.snippet?.title || '',
        concurrentViewers,
        streamStatus: streamHealth?.status || null,
        resolution,
        framerate,
        configurationIssues: streamHealth?.configurationIssues || [],
        ingestionAddress: ingestionInfo?.ingestionAddress || null,
        channelName: row.yt_channel_name || '',
        checkedAt: new Date().toISOString(),
      };

      handleYouTubeTransition(churchId, church, cs, healthStatus);
    } catch (e) {
      cs.youtube = { status: 'error', error: e.message, checkedAt: new Date().toISOString() };
    }
  }

  function handleYouTubeTransition(churchId, church, cs, newHealth) {
    const prev = cs.prevYtHealth;
    cs.prevYtHealth = newHealth;
    const now = Date.now();

    // Alert on transition to error
    if (newHealth === 'error' && prev !== 'error' && now - cs.lastAlerts.yt > ALERT_THROTTLE_MS) {
      cs.lastAlerts.yt = now;
      const dbChurch = db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId);
      if (dbChurch) {
        alertEngine.sendAlert(dbChurch, 'yt_broadcast_unhealthy', {
          platform: 'YouTube',
          streamStatus: cs.youtube?.streamStatus,
          issues: cs.youtube?.configurationIssues,
        }).catch(e => console.error('[BroadcastMonitor] YT alert error:', e.message));
      }
    }
    // Alert on stream going offline (was live, now no broadcast)
    if (newHealth === 'noData' && prev === 'good' && now - cs.lastAlerts.yt > ALERT_THROTTLE_MS) {
      cs.lastAlerts.yt = now;
      const dbChurch = db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId);
      if (dbChurch) {
        alertEngine.sendAlert(dbChurch, 'yt_broadcast_offline', {
          platform: 'YouTube',
          channelName: cs.youtube?.channelName || '',
        }).catch(e => console.error('[BroadcastMonitor] YT offline alert error:', e.message));
      }
    }
    // Recovery notification
    if (newHealth === 'good' && (prev === 'error' || prev === 'noData') && prev !== null) {
      console.log(`[BroadcastMonitor] YouTube broadcast recovered for ${churchId}`);
    }
  }

  // ── Facebook broadcast health polling ─────────────────────────────────────

  async function pollFacebook(churchId, church) {
    const row = db.prepare(
      'SELECT fb_access_token, fb_page_id, fb_page_name FROM churches WHERE churchId = ?'
    ).get(churchId);
    if (!row?.fb_access_token) return;

    const cs = getState(churchId);
    const target = row.fb_page_id || 'me';

    try {
      // Get recent live videos for this page/account
      const resp = await fetch(
        `${FB_GRAPH_URL}/${target}/live_videos?fields=status,title,live_views,dash_ingest_url,ingest_streams,embed_html&limit=1`,
        { headers: { Authorization: `Bearer ${row.fb_access_token}` }, signal: AbortSignal.timeout(10000) }
      );

      if (!resp.ok) {
        cs.facebook = { status: 'api_error', error: `HTTP ${resp.status}`, checkedAt: new Date().toISOString() };
        return;
      }

      const data = await resp.json();
      const video = data.data?.[0];

      if (!video) {
        cs.facebook = { status: 'no_broadcast', live: false, checkedAt: new Date().toISOString() };
        handleFacebookTransition(churchId, church, cs, 'noData');
        return;
      }

      const fbStatus = video.status || 'UNKNOWN';
      const healthStatus = deriveFacebookHealth(fbStatus);
      const isLive = fbStatus === 'LIVE';

      // Parse ingest stream health if available
      let ingestHealth = null;
      if (video.ingest_streams && Array.isArray(video.ingest_streams.data)) {
        const stream = video.ingest_streams.data[0];
        if (stream) {
          ingestHealth = {
            streamHealth: stream.stream_health || null,
            videoCodec: stream.video_codec || null,
            audioCodec: stream.audio_codec || null,
            width: stream.stream_width || null,
            height: stream.stream_height || null,
            bitrate: stream.video_bitrate || null,
          };
        }
      }

      cs.facebook = {
        status: healthStatus,
        live: isLive,
        broadcastStatus: fbStatus,
        title: video.title || '',
        liveViews: video.live_views || 0,
        ingestHealth,
        pageName: row.fb_page_name || '',
        checkedAt: new Date().toISOString(),
      };

      handleFacebookTransition(churchId, church, cs, healthStatus);
    } catch (e) {
      cs.facebook = { status: 'error', error: e.message, checkedAt: new Date().toISOString() };
    }
  }

  function handleFacebookTransition(churchId, church, cs, newHealth) {
    const prev = cs.prevFbHealth;
    cs.prevFbHealth = newHealth;
    const now = Date.now();

    if (newHealth === 'error' && prev !== 'error' && now - cs.lastAlerts.fb > ALERT_THROTTLE_MS) {
      cs.lastAlerts.fb = now;
      const dbChurch = db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId);
      if (dbChurch) {
        alertEngine.sendAlert(dbChurch, 'fb_broadcast_unhealthy', {
          platform: 'Facebook',
          broadcastStatus: cs.facebook?.broadcastStatus,
        }).catch(e => console.error('[BroadcastMonitor] FB alert error:', e.message));
      }
    }
    if (newHealth === 'noData' && prev === 'good' && now - cs.lastAlerts.fb > ALERT_THROTTLE_MS) {
      cs.lastAlerts.fb = now;
      const dbChurch = db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId);
      if (dbChurch) {
        alertEngine.sendAlert(dbChurch, 'fb_broadcast_offline', {
          platform: 'Facebook',
          pageName: cs.facebook?.pageName || '',
        }).catch(e => console.error('[BroadcastMonitor] FB offline alert error:', e.message));
      }
    }
    if (newHealth === 'good' && (prev === 'error' || prev === 'noData') && prev !== null) {
      console.log(`[BroadcastMonitor] Facebook broadcast recovered for ${churchId}`);
    }
  }

  // ── Main poll loop ────────────────────────────────────────────────────────

  async function pollAll() {
    const { churches } = relay;

    // Find churches with YouTube or Facebook tokens
    const connectedChurches = db.prepare(
      'SELECT churchId FROM churches WHERE yt_access_token IS NOT NULL OR fb_access_token IS NOT NULL'
    ).all();

    for (const { churchId } of connectedChurches) {
      const church = churches.get(churchId);
      try {
        await pollYouTube(churchId, church);
      } catch (e) {
        console.error(`[BroadcastMonitor] YT poll error for ${churchId}:`, e.message);
      }
      try {
        await pollFacebook(churchId, church);
      } catch (e) {
        console.error(`[BroadcastMonitor] FB poll error for ${churchId}:`, e.message);
      }

      // Attach health data to church runtime so portal can read it
      const cs = getState(churchId);
      if (church) {
        church.broadcastHealth = {
          youtube: cs.youtube,
          facebook: cs.facebook,
        };
      }

      // Notify dashboard SSE
      try { notifyUpdate(churchId); } catch { /* ignore */ }
    }
  }

  setInterval(pollAll, POLL_INTERVAL_MS);
  // Initial poll after a short delay
  setTimeout(pollAll, 5000);

  console.log('[BroadcastMonitor] YouTube/Facebook broadcast monitor started (poll interval: 60s)');

  // Return handle for testing and cleanup
  return {
    state,
    pollAll,
    pollYouTube,
    pollFacebook,
    getState,
    // Exposed for unit testing
    _deriveYouTubeHealth: deriveYouTubeHealth,
    _deriveFacebookHealth: deriveFacebookHealth,
  };
}

module.exports = { setupBroadcastMonitor, deriveYouTubeHealth, deriveFacebookHealth };
