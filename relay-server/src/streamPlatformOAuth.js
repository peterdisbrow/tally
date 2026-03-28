/**
 * Stream Platform OAuth — YouTube & Facebook integration
 *
 * Handles OAuth token exchange, refresh, and RTMP stream key retrieval
 * for YouTube Live and Facebook Live. Follows the same module pattern
 * as planningCenter.js: constructor(db), _ensureColumns(), background timer.
 *
 * Token exchange is server-side so client secrets never touch the desktop app.
 * Stream keys are returned to the Electron app for local encrypted storage.
 */

const crypto = require('crypto');

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const YT_TOKEN_URL   = 'https://oauth2.googleapis.com/token';
const YT_STREAMS_URL = 'https://www.googleapis.com/youtube/v3/liveStreams';
const YT_CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels';

const FB_GRAPH_URL   = 'https://graph.facebook.com/v19.0';

const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // check every 30 min
const YT_REFRESH_BUFFER_MS = 10 * 60 * 1000; // refresh YouTube 10 min before expiry
const FB_WARN_DAYS = 7; // warn 7 days before Facebook token expiry

// Temporary store for Facebook OAuth callback codes (state → code)
const _fbPendingCodes = new Map(); // state → { code, createdAt }
const _ytPendingCodes = new Map(); // state → { code, createdAt }
const FB_PENDING_TTL = 5 * 60 * 1000; // 5 min

class StreamPlatformOAuth {
  /**
   * @param {import('better-sqlite3').Database} db
   */
  constructor(db) {
    this.db = db;
    this._refreshTimer = null;
    this._ensureColumns();
  }

  // ─── SCHEMA ──────────────────────────────────────────────────────────────────

  _ensureColumns() {
    const cols = {
      // YouTube
      yt_access_token:    'TEXT',
      yt_refresh_token:   'TEXT',
      yt_token_expires_at: 'TEXT',
      yt_stream_key:      'TEXT',
      yt_stream_url:      'TEXT',
      yt_channel_name:    'TEXT',
      // Facebook
      fb_access_token:    'TEXT',
      fb_token_expires_at: 'TEXT',
      fb_page_id:         'TEXT',
      fb_page_name:       'TEXT',
      fb_stream_key:      'TEXT',
      fb_stream_url:      'TEXT',
    };
    for (const [col, type] of Object.entries(cols)) {
      try {
        this.db.prepare(`SELECT ${col} FROM churches LIMIT 1`).get();
      } catch {
        this.db.exec(`ALTER TABLE churches ADD COLUMN ${col} ${type}`);
      }
    }
  }

  // ─── YOUTUBE ─────────────────────────────────────────────────────────────────

  /**
   * Exchange a YouTube authorization code for tokens + fetch stream key.
   * @param {string} churchId
   * @param {string} code      Authorization code from Google OAuth consent
   * @param {string} redirectUri  Must match what was used in the auth URL
   * @returns {Promise<{success: boolean, streamKey?, streamUrl?, channelName?, error?}>}
   */
  async exchangeYouTubeCode(churchId, code, redirectUri) {
    const clientId = process.env.YOUTUBE_CLIENT_ID;
    const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
    if (!clientId || !clientSecret) return { success: false, error: 'YouTube OAuth not configured on server' };

    try {
      // Exchange code for tokens
      const tokenResp = await fetch(YT_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!tokenResp.ok) {
        const err = await tokenResp.json().catch(() => ({}));
        console.error('[StreamOAuth] YouTube token exchange failed:', err);
        return { success: false, error: err.error_description || 'Token exchange failed' };
      }

      const tokens = await tokenResp.json();
      const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();

      // Store tokens
      this.db.prepare(`
        UPDATE churches SET
          yt_access_token = ?,
          yt_refresh_token = COALESCE(?, yt_refresh_token),
          yt_token_expires_at = ?
        WHERE churchId = ?
      `).run(tokens.access_token, tokens.refresh_token || null, expiresAt, churchId);

      // Fetch channel name
      let channelName = '';
      try {
        const chResp = await fetch(`${YT_CHANNELS_URL}?part=snippet&mine=true`, {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
          signal: AbortSignal.timeout(8000),
        });
        if (chResp.ok) {
          const chData = await chResp.json();
          channelName = chData.items?.[0]?.snippet?.title || '';
          if (channelName) {
            this.db.prepare('UPDATE churches SET yt_channel_name = ? WHERE churchId = ?').run(channelName, churchId);
          }
        }
      } catch { /* non-fatal */ }

      // Fetch stream key
      const streamResult = await this.fetchYouTubeStreamKey(churchId, tokens.access_token);

      console.log(`[StreamOAuth] YouTube connected for church ${churchId} (${channelName})`);
      return {
        success: true,
        channelName,
        streamKey: streamResult.streamKey || null,
        streamUrl: streamResult.streamUrl || null,
      };
    } catch (e) {
      console.error('[StreamOAuth] YouTube exchange error:', e.message);
      return { success: false, error: process.env.NODE_ENV === 'production' ? 'OAuth exchange failed' : e.message };
    }
  }

  /**
   * Refresh the YouTube access token using the stored refresh token.
   * @param {string} churchId
   * @returns {Promise<boolean>}
   */
  async refreshYouTubeToken(churchId) {
    const church = this.db.prepare('SELECT yt_refresh_token FROM churches WHERE churchId = ?').get(churchId);
    if (!church?.yt_refresh_token) return false;

    const clientId = process.env.YOUTUBE_CLIENT_ID;
    const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
    if (!clientId || !clientSecret) return false;

    try {
      const resp = await fetch(YT_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: church.yt_refresh_token,
          grant_type: 'refresh_token',
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!resp.ok) return false;
      const tokens = await resp.json();
      const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();

      this.db.prepare(`
        UPDATE churches SET yt_access_token = ?, yt_token_expires_at = ? WHERE churchId = ?
      `).run(tokens.access_token, expiresAt, churchId);

      console.log(`[StreamOAuth] YouTube token refreshed for ${churchId}`);
      return true;
    } catch (e) {
      console.error(`[StreamOAuth] YouTube refresh failed for ${churchId}:`, e.message);
      return false;
    }
  }

  /**
   * Fetch RTMP stream key from YouTube Live API.
   * @param {string} churchId
   * @param {string} [accessToken]  Optional override; otherwise reads from DB
   * @returns {Promise<{streamKey?: string, streamUrl?: string}>}
   */
  async fetchYouTubeStreamKey(churchId, accessToken) {
    if (!accessToken) {
      const church = this.db.prepare('SELECT yt_access_token FROM churches WHERE churchId = ?').get(churchId);
      accessToken = church?.yt_access_token;
    }
    if (!accessToken) return {};

    try {
      const resp = await fetch(`${YT_STREAMS_URL}?part=cdn,snippet&mine=true`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8000),
      });

      if (!resp.ok) return {};
      const data = await resp.json();
      const stream = data.items?.[0];
      if (!stream) return {};

      const streamKey = stream.cdn?.ingestionInfo?.streamName || '';
      const streamUrl = stream.cdn?.ingestionInfo?.ingestionAddress || '';

      if (streamKey) {
        this.db.prepare('UPDATE churches SET yt_stream_key = ?, yt_stream_url = ? WHERE churchId = ?')
          .run(streamKey, streamUrl, churchId);
      }

      return { streamKey, streamUrl };
    } catch (e) {
      console.error(`[StreamOAuth] YouTube stream key fetch failed for ${churchId}:`, e.message);
      return {};
    }
  }

  /**
   * Disconnect YouTube — clear all yt_* columns.
   */
  disconnectYouTube(churchId) {
    this.db.prepare(`
      UPDATE churches SET
        yt_access_token = NULL, yt_refresh_token = NULL, yt_token_expires_at = NULL,
        yt_stream_key = NULL, yt_stream_url = NULL, yt_channel_name = NULL
      WHERE churchId = ?
    `).run(churchId);
    console.log(`[StreamOAuth] YouTube disconnected for ${churchId}`);
  }

  // ─── FACEBOOK ────────────────────────────────────────────────────────────────

  /**
   * Exchange a Facebook authorization code for tokens.
   * Automatically swaps short-lived token for long-lived (60-day) token.
   * @param {string} churchId
   * @param {string} code
   * @param {string} redirectUri
   * @returns {Promise<{success: boolean, pages?: Array, error?}>}
   */
  async exchangeFacebookCode(churchId, code, redirectUri) {
    const appId = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;
    if (!appId || !appSecret) return { success: false, error: 'Facebook OAuth not configured on server' };

    try {
      // Exchange code for short-lived token
      const tokenUrl = `${FB_GRAPH_URL}/oauth/access_token?` + new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri,
        code,
      });

      const tokenResp = await fetch(tokenUrl, { signal: AbortSignal.timeout(10000) });
      if (!tokenResp.ok) {
        const err = await tokenResp.json().catch(() => ({}));
        return { success: false, error: err.error?.message || 'Facebook token exchange failed' };
      }
      const shortToken = (await tokenResp.json()).access_token;

      // Swap for long-lived token (60 days)
      const longUrl = `${FB_GRAPH_URL}/oauth/access_token?` + new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: shortToken,
      });

      const longResp = await fetch(longUrl, { signal: AbortSignal.timeout(10000) });
      if (!longResp.ok) {
        return { success: false, error: 'Failed to get long-lived token' };
      }
      const longData = await longResp.json();
      const expiresAt = new Date(Date.now() + (longData.expires_in || 5184000) * 1000).toISOString();

      // Store token
      this.db.prepare(`
        UPDATE churches SET fb_access_token = ?, fb_token_expires_at = ? WHERE churchId = ?
      `).run(longData.access_token, expiresAt, churchId);

      // Fetch pages the user manages
      const pages = await this._listFacebookPages(longData.access_token);

      console.log(`[StreamOAuth] Facebook connected for church ${churchId} (${pages.length} pages)`);
      return { success: true, pages };
    } catch (e) {
      console.error('[StreamOAuth] Facebook exchange error:', e.message);
      return { success: false, error: process.env.NODE_ENV === 'production' ? 'OAuth exchange failed' : e.message };
    }
  }

  /**
   * List Facebook Pages the user manages.
   * @param {string} accessToken
   * @returns {Promise<Array<{id: string, name: string, access_token: string}>>}
   */
  async _listFacebookPages(accessToken) {
    try {
      const resp = await fetch(`${FB_GRAPH_URL}/me/accounts?fields=id,name,access_token`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.data || []).map(p => ({ id: p.id, name: p.name, access_token: p.access_token }));
    } catch {
      return [];
    }
  }

  /**
   * After user picks a Facebook Page, store it and create a live video.
   * @param {string} churchId
   * @param {string} pageId
   * @returns {Promise<{success: boolean, streamKey?, streamUrl?, pageName?, error?}>}
   */
  async selectFacebookPage(churchId, pageId) {
    const church = this.db.prepare('SELECT fb_access_token FROM churches WHERE churchId = ?').get(churchId);
    if (!church?.fb_access_token) return { success: false, error: 'Not connected to Facebook' };

    try {
      // Get page token from the user token
      const pages = await this._listFacebookPages(church.fb_access_token);
      const page = pages.find(p => p.id === pageId);
      if (!page) return { success: false, error: 'Page not found or no access' };

      // Store page selection
      this.db.prepare('UPDATE churches SET fb_page_id = ?, fb_page_name = ? WHERE churchId = ?')
        .run(pageId, page.name, churchId);

      // Create a live video to get the stream key
      const streamResult = await this._createFacebookLiveVideo(churchId, page.access_token, pageId);

      console.log(`[StreamOAuth] Facebook page selected: ${page.name} for church ${churchId}`);
      return {
        success: true,
        pageName: page.name,
        streamKey: streamResult.streamKey || null,
        streamUrl: streamResult.streamUrl || null,
      };
    } catch (e) {
      console.error('[StreamOAuth] Facebook page selection error:', e.message);
      return { success: false, error: process.env.NODE_ENV === 'production' ? 'OAuth exchange failed' : e.message };
    }
  }

  /**
   * Create a Facebook Live Video to get a fresh RTMP stream key.
   * Facebook keys are per-live-video (not persistent like YouTube).
   */
  async _createFacebookLiveVideo(churchId, pageToken, pageId) {
    try {
      const resp = await fetch(`${FB_GRAPH_URL}/${pageId}/live_videos`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pageToken}`,
        },
        body: JSON.stringify({
          status: 'UNPUBLISHED',
          title: 'Live Service',
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        console.error('[StreamOAuth] Facebook live_videos create failed:', err);
        return {};
      }

      const data = await resp.json();
      const streamUrl = data.stream_url || data.secure_stream_url || '';
      // stream_url format: "rtmps://live-api-s.facebook.com:443/rtmp/FB-1234567890-0-AbCdEfGh"
      // Split into server + key at the last slash segment
      let rtmpServer = '';
      let streamKey = '';
      if (streamUrl) {
        const lastSlash = streamUrl.lastIndexOf('/');
        rtmpServer = streamUrl.slice(0, lastSlash);
        streamKey = streamUrl.slice(lastSlash + 1);
      }

      if (streamKey) {
        this.db.prepare('UPDATE churches SET fb_stream_key = ?, fb_stream_url = ? WHERE churchId = ?')
          .run(streamKey, rtmpServer, churchId);
      }

      return { streamKey, streamUrl: rtmpServer };
    } catch (e) {
      console.error(`[StreamOAuth] Facebook live video create error:`, e.message);
      return {};
    }
  }

  /**
   * Refresh Facebook stream key by creating a new live video.
   * Called before each service since Facebook keys are per-video.
   * @param {string} churchId
   * @returns {Promise<{streamKey?: string, streamUrl?: string}>}
   */
  async refreshFacebookStreamKey(churchId) {
    const church = this.db.prepare(
      'SELECT fb_access_token, fb_page_id FROM churches WHERE churchId = ?'
    ).get(churchId);
    if (!church?.fb_access_token || !church?.fb_page_id) return {};

    // Get page token
    const pages = await this._listFacebookPages(church.fb_access_token);
    const page = pages.find(p => p.id === church.fb_page_id);
    if (!page) return {};

    return this._createFacebookLiveVideo(churchId, page.access_token, church.fb_page_id);
  }

  /**
   * Disconnect Facebook — clear all fb_* columns.
   */
  disconnectFacebook(churchId) {
    this.db.prepare(`
      UPDATE churches SET
        fb_access_token = NULL, fb_token_expires_at = NULL,
        fb_page_id = NULL, fb_page_name = NULL,
        fb_stream_key = NULL, fb_stream_url = NULL
      WHERE churchId = ?
    `).run(churchId);
    console.log(`[StreamOAuth] Facebook disconnected for ${churchId}`);
  }

  // ─── FACEBOOK CALLBACK HANDLING ──────────────────────────────────────────────
  // Facebook doesn't allow loopback redirects, so the relay receives the callback
  // and the Electron app polls for the code.

  /**
   * Store a Facebook auth code received at the public callback endpoint.
   * @param {string} state  Random nonce generated by the Electron app
   * @param {string} code   Authorization code from Facebook
   */
  storeFacebookPendingCode(state, code) {
    _fbPendingCodes.set(state, { code, createdAt: Date.now() });
    // Cleanup old entries
    for (const [k, v] of _fbPendingCodes) {
      if (Date.now() - v.createdAt > FB_PENDING_TTL) _fbPendingCodes.delete(k);
    }
  }

  /**
   * Poll for a pending Facebook auth code.
   * @param {string} state
   * @returns {{code: string}|null}
   */
  getFacebookPendingCode(state) {
    const entry = _fbPendingCodes.get(state);
    if (!entry) return null;
    _fbPendingCodes.delete(state);
    return { code: entry.code };
  }

  // ─── YOUTUBE CALLBACK HANDLING ────────────────────────────────────────────────
  // Same relay-redirect + polling pattern as Facebook.

  storeYouTubePendingCode(state, code) {
    _ytPendingCodes.set(state, { code, createdAt: Date.now() });
    for (const [k, v] of _ytPendingCodes) {
      if (Date.now() - v.createdAt > FB_PENDING_TTL) _ytPendingCodes.delete(k);
    }
  }

  getYouTubePendingCode(state) {
    const entry = _ytPendingCodes.get(state);
    if (!entry) return null;
    _ytPendingCodes.delete(state);
    return { code: entry.code };
  }

  // ─── STATUS & STREAM KEYS ───────────────────────────────────────────────────

  /**
   * Get connection status for both platforms. Never exposes tokens.
   * @param {string} churchId
   */
  getStatus(churchId) {
    const church = this.db.prepare(`
      SELECT yt_access_token, yt_channel_name, yt_token_expires_at, yt_stream_key,
             fb_access_token, fb_page_name, fb_token_expires_at, fb_stream_key
      FROM churches WHERE churchId = ?
    `).get(churchId);

    if (!church) return { youtube: { connected: false }, facebook: { connected: false } };

    return {
      youtube: {
        connected: !!church.yt_access_token,
        channelName: church.yt_channel_name || '',
        streamKeySet: !!church.yt_stream_key,
        expiresAt: church.yt_token_expires_at || null,
      },
      facebook: {
        connected: !!church.fb_access_token,
        pageName: church.fb_page_name || '',
        streamKeySet: !!church.fb_stream_key,
        expiresAt: church.fb_token_expires_at || null,
      },
    };
  }

  /**
   * Get stream keys for both platforms.
   * @param {string} churchId
   * @returns {{ youtube: {url, key}|null, facebook: {url, key}|null }}
   */
  getStreamKeys(churchId) {
    const church = this.db.prepare(`
      SELECT yt_stream_key, yt_stream_url, fb_stream_key, fb_stream_url
      FROM churches WHERE churchId = ?
    `).get(churchId);

    if (!church) return { youtube: null, facebook: null };

    return {
      youtube: church.yt_stream_key ? { url: church.yt_stream_url, key: church.yt_stream_key } : null,
      facebook: church.fb_stream_key ? { url: church.fb_stream_url, key: church.fb_stream_key } : null,
    };
  }

  // ─── BACKGROUND REFRESH ──────────────────────────────────────────────────────

  start() {
    this._refreshTimer = setInterval(
      () => this._refreshAll().catch(e => console.error('[StreamOAuth] refresh error:', e.message)),
      REFRESH_INTERVAL_MS
    );
    console.log('[StreamOAuth] Started — token refresh every 30 min');
  }

  stop() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  async _refreshAll() {
    const now = new Date();

    // YouTube: refresh tokens expiring within 10 minutes
    const ytChurches = this.db.prepare(
      'SELECT churchId FROM churches WHERE yt_refresh_token IS NOT NULL AND yt_token_expires_at IS NOT NULL'
    ).all();

    for (const { churchId } of ytChurches) {
      const church = this.db.prepare('SELECT yt_token_expires_at FROM churches WHERE churchId = ?').get(churchId);
      if (!church?.yt_token_expires_at) continue;

      const expiresAt = new Date(church.yt_token_expires_at);
      if (expiresAt.getTime() - now.getTime() < YT_REFRESH_BUFFER_MS) {
        await this.refreshYouTubeToken(churchId);
      }
    }

    // Facebook: warn if token expires within 7 days
    const fbChurches = this.db.prepare(
      'SELECT churchId, name, fb_token_expires_at FROM churches WHERE fb_access_token IS NOT NULL AND fb_token_expires_at IS NOT NULL'
    ).all();

    for (const church of fbChurches) {
      const expiresAt = new Date(church.fb_token_expires_at);
      const daysLeft = Math.floor((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
      if (daysLeft <= FB_WARN_DAYS && daysLeft > 0) {
        console.warn(`[StreamOAuth] ⚠️ Facebook token for ${church.name || church.churchId} expires in ${daysLeft} days`);
      }
    }
  }
}

module.exports = { StreamPlatformOAuth };
