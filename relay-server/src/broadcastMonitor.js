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
const { SqliteQueryClient } = require('./db/queryClient');

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
 * @param {import('better-sqlite3').Database|{ query: Function, queryOne: Function, run: Function }} dbOrClient
 * @param {{ churches: Map<string, object> }} relay
 * @param {object} alertEngine - AlertEngine instance
 * @param {function} notifyUpdate - (churchId?) => void — push SSE update
 */
function setupBroadcastMonitor(dbOrClient, relay, alertEngine, notifyUpdate) {
  const queryClient = dbOrClient && typeof dbOrClient.query === 'function' && typeof dbOrClient.queryOne === 'function' && typeof dbOrClient.run === 'function'
    ? dbOrClient
    : (dbOrClient && typeof dbOrClient.prepare === 'function'
      ? new SqliteQueryClient(dbOrClient)
      : null);
  const sqliteDb = queryClient?.db && typeof queryClient.db.prepare === 'function'
    ? queryClient.db
    : (dbOrClient && typeof dbOrClient.prepare === 'function' ? dbOrClient : null);

  // Per-room state keyed by compositeKey = `${churchId}::${instanceName}`
  // (same pattern as signalFailover Phase 1)
  const state = new Map();
  let schemaNotReadyLogged = false;

  function _compositeKey(churchId, instanceName) {
    return instanceName ? `${churchId}::${instanceName}` : churchId;
  }

  function getState(churchId, instanceName) {
    const key = _compositeKey(churchId, instanceName);
    if (!state.has(key)) {
      state.set(key, {
        youtube: null,
        facebook: null,
        lastAlerts: { yt: 0, fb: 0 },
        prevYtHealth: null,
        prevFbHealth: null,
      });
    }
    return state.get(key);
  }

  async function qAll(sql, params = []) {
    if (queryClient) return queryClient.query(sql, params);
    if (sqliteDb) return sqliteDb.prepare(sql).all(...params);
    return [];
  }

  async function qOne(sql, params = []) {
    if (queryClient) return queryClient.queryOne(sql, params);
    if (sqliteDb) return sqliteDb.prepare(sql).get(...params) || null;
    return null;
  }

  async function qRun(sql, params = []) {
    if (queryClient) return queryClient.run(sql, params);
    if (sqliteDb) return sqliteDb.prepare(sql).run(...params);
    return { changes: 0, lastInsertRowid: null, rows: [] };
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
      await qRun('UPDATE churches SET yt_access_token = ?, yt_token_expires_at = ? WHERE churchId = ?', [tokens.access_token, expiresAt, churchId]);
      return tokens.access_token;
    } catch {
      return null;
    }
  }

  async function pollYouTube(churchId, church, instanceName, roomId) {
    const row = await qOne(
      'SELECT yt_access_token, yt_refresh_token, yt_token_expires_at, yt_channel_name FROM churches WHERE churchId = ?',
      [churchId]
    );
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

    const cs = getState(churchId, instanceName);
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
        await handleYouTubeTransition(churchId, church, cs, 'noData', instanceName, roomId);
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

      await handleYouTubeTransition(churchId, church, cs, healthStatus, instanceName, roomId);
    } catch (e) {
      cs.youtube = { status: 'error', error: e.message, checkedAt: new Date().toISOString() };
    }
  }

  async function handleYouTubeTransition(churchId, church, cs, newHealth, instanceName, roomId) {
    const prev = cs.prevYtHealth;
    cs.prevYtHealth = newHealth;
    const now = Date.now();
    const dbChurch = church || await qOne('SELECT * FROM churches WHERE churchId = ?', [churchId]);

    // Alert on transition to error
    if (newHealth === 'error' && prev !== 'error' && now - cs.lastAlerts.yt > ALERT_THROTTLE_MS) {
      cs.lastAlerts.yt = now;
      if (dbChurch) {
        alertEngine.sendAlert(dbChurch, 'yt_broadcast_unhealthy', {
          platform: 'YouTube',
          streamStatus: cs.youtube?.streamStatus,
          issues: cs.youtube?.configurationIssues,
          _instanceName: instanceName || null,
          _roomId: roomId || null,
        }).catch(e => console.error('[BroadcastMonitor] YT alert error:', e.message));
      }
    }
    // Alert on stream going offline (was live, now no broadcast)
    if (newHealth === 'noData' && prev === 'good' && now - cs.lastAlerts.yt > ALERT_THROTTLE_MS) {
      cs.lastAlerts.yt = now;
      if (dbChurch) {
        alertEngine.sendAlert(dbChurch, 'yt_broadcast_offline', {
          platform: 'YouTube',
          channelName: cs.youtube?.channelName || '',
          _instanceName: instanceName || null,
          _roomId: roomId || null,
        }).catch(e => console.error('[BroadcastMonitor] YT offline alert error:', e.message));
      }
    }
    // Recovery notification
    if (newHealth === 'good' && (prev === 'error' || prev === 'noData') && prev !== null) {
      console.log(`[BroadcastMonitor] YouTube broadcast recovered for ${churchId}${instanceName ? ' (' + instanceName + ')' : ''}`);
    }
  }

  // ── Facebook broadcast health polling ─────────────────────────────────────

  async function pollFacebook(churchId, church, instanceName, roomId) {
    const row = await qOne(
      'SELECT fb_access_token, fb_page_id, fb_page_name FROM churches WHERE churchId = ?',
      [churchId]
    );
    if (!row?.fb_access_token) return;

    const cs = getState(churchId, instanceName);
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
        await handleFacebookTransition(churchId, church, cs, 'noData', instanceName, roomId);
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

      await handleFacebookTransition(churchId, church, cs, healthStatus, instanceName, roomId);
    } catch (e) {
      cs.facebook = { status: 'error', error: e.message, checkedAt: new Date().toISOString() };
    }
  }

  async function handleFacebookTransition(churchId, church, cs, newHealth, instanceName, roomId) {
    const prev = cs.prevFbHealth;
    cs.prevFbHealth = newHealth;
    const now = Date.now();
    const dbChurch = church || await qOne('SELECT * FROM churches WHERE churchId = ?', [churchId]);

    if (newHealth === 'error' && prev !== 'error' && now - cs.lastAlerts.fb > ALERT_THROTTLE_MS) {
      cs.lastAlerts.fb = now;
      if (dbChurch) {
        alertEngine.sendAlert(dbChurch, 'fb_broadcast_unhealthy', {
          platform: 'Facebook',
          broadcastStatus: cs.facebook?.broadcastStatus,
          _instanceName: instanceName || null,
          _roomId: roomId || null,
        }).catch(e => console.error('[BroadcastMonitor] FB alert error:', e.message));
      }
    }
    if (newHealth === 'noData' && prev === 'good' && now - cs.lastAlerts.fb > ALERT_THROTTLE_MS) {
      cs.lastAlerts.fb = now;
      if (dbChurch) {
        alertEngine.sendAlert(dbChurch, 'fb_broadcast_offline', {
          platform: 'Facebook',
          pageName: cs.facebook?.pageName || '',
          _instanceName: instanceName || null,
          _roomId: roomId || null,
        }).catch(e => console.error('[BroadcastMonitor] FB offline alert error:', e.message));
      }
    }
    if (newHealth === 'good' && (prev === 'error' || prev === 'noData') && prev !== null) {
      console.log(`[BroadcastMonitor] Facebook broadcast recovered for ${churchId}${instanceName ? ' (' + instanceName + ')' : ''}`);
    }
  }

  // ── Main poll loop ────────────────────────────────────────────────────────

  async function pollAll() {
    const { churches } = relay;

    // Find churches with YouTube or Facebook tokens
    let connectedChurches = [];
    try {
      connectedChurches = await qAll(
        'SELECT churchId, room_id, room_name FROM churches WHERE yt_access_token IS NOT NULL OR fb_access_token IS NOT NULL'
      );
      schemaNotReadyLogged = false;
    } catch (error) {
      const message = String(error?.message || '');
      if (/column .* does not exist/i.test(message)) {
        if (!schemaNotReadyLogged) {
          console.warn(`[BroadcastMonitor] Skipping poll until stream token columns are available: ${message}`);
          schemaNotReadyLogged = true;
        }
        return;
      }
      throw error;
    }

    for (const row of connectedChurches) {
      const { churchId } = row;
      const church = churches.get(churchId);
      // Derive instanceName from the church runtime (the connected client's instance)
      const instanceName = church?.instanceName || null;
      const roomId = row.room_id || church?.roomId || null;

      try {
        await pollYouTube(churchId, church, instanceName, roomId);
      } catch (e) {
        console.error(`[BroadcastMonitor] YT poll error for ${churchId}:`, e.message);
      }
      try {
        await pollFacebook(churchId, church, instanceName, roomId);
      } catch (e) {
        console.error(`[BroadcastMonitor] FB poll error for ${churchId}:`, e.message);
      }

      // Attach health data to church runtime so portal can read it
      const cs = getState(churchId, instanceName);
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
    _compositeKey,
    // Exposed for unit testing
    _deriveYouTubeHealth: deriveYouTubeHealth,
    _deriveFacebookHealth: deriveFacebookHealth,
  };
}

module.exports = { setupBroadcastMonitor, deriveYouTubeHealth, deriveFacebookHealth };
