/**
 * OAuth Flow — Desktop-side handler for YouTube & Facebook OAuth
 *
 * YouTube: uses loopback HTTP server (Google allows http://127.0.0.1)
 * Facebook: uses relay server as redirect target (FB blocks loopback),
 *           Electron polls for the auth code.
 *
 * Token exchange happens server-side (relay) — client secrets never
 * touch the desktop app binary.
 */

const http = require('http');
const crypto = require('crypto');
const { shell } = require('electron');

const YOUTUBE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const YOUTUBE_SCOPES = 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube';

const FACEBOOK_AUTH_URL = 'https://www.facebook.com/v19.0/dialog/oauth';
const FACEBOOK_SCOPES = 'pages_show_list,pages_manage_posts,publish_video';

// ─── MODULE STATE ────────────────────────────────────────────────────────────

let _loadConfig = null;
let _saveConfig = null;
let _relayHttpUrl = null;
let _getMainWindow = null;
let _defaultRelayUrl = '';

/**
 * Initialize the OAuth flow module with app dependencies.
 */
function init({ loadConfig, saveConfig, relayHttpUrl, getMainWindow, defaultRelayUrl }) {
  _loadConfig = loadConfig;
  _saveConfig = saveConfig;
  _relayHttpUrl = relayHttpUrl;
  _getMainWindow = getMainWindow;
  _defaultRelayUrl = defaultRelayUrl || '';
}

function _getRelayHttp() {
  const config = _loadConfig();
  return _relayHttpUrl(config.relay || _defaultRelayUrl);
}

function _getToken() {
  return _loadConfig().token;
}

async function _relayPost(path, body = {}) {
  const resp = await fetch(`${_getRelayHttp()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${_getToken()}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  return resp.json();
}

async function _relayGet(path) {
  const resp = await fetch(`${_getRelayHttp()}${path}`, {
    headers: { Authorization: `Bearer ${_getToken()}` },
    signal: AbortSignal.timeout(10000),
  });
  return resp.json();
}

async function _relayDelete(path) {
  const resp = await fetch(`${_getRelayHttp()}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${_getToken()}` },
    signal: AbortSignal.timeout(10000),
  });
  return resp.json();
}

// ─── YOUTUBE OAUTH (loopback) ────────────────────────────────────────────────

/**
 * Start YouTube OAuth flow.
 * Opens browser → user approves → loopback captures code → relay exchanges.
 * @returns {Promise<{success, streamKey?, streamUrl?, channelName?, error?}>}
 */
async function startYouTubeOAuth() {
  const config = _loadConfig();
  const clientId = process.env.YOUTUBE_CLIENT_ID || config.youtubeClientId;
  if (!clientId) {
    // Client ID can come from env or we let the relay handle it — just need it for the auth URL.
    // If not available locally, ask relay for the client ID.
    // For now, use a well-known approach: relay provides its own.
  }

  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(16).toString('hex');

    // Start local HTTP server to receive redirect
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://127.0.0.1`);
        if (!url.pathname.startsWith('/callback')) {
          res.writeHead(404);
          res.end();
          return;
        }

        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        res.writeHead(200, { 'Content-Type': 'text/html' });

        if (error || !code || returnedState !== state) {
          res.end('<html><body><h2>Authorization failed</h2><p>You can close this window.</p></body></html>');
          server.close();
          resolve({ success: false, error: error || 'Invalid response' });
          return;
        }

        res.end('<html><body><h2>&#10003; Connected to YouTube</h2><p>You can close this window and return to Tally.</p></body></html>');
        server.close();

        // Exchange code with relay server
        const port = server.address()?.port;
        const redirectUri = `http://127.0.0.1:${port}/callback`;
        const result = await _relayPost('/api/church/app/oauth/youtube/exchange', { code, redirectUri });

        if (result.success && result.streamKey) {
          _saveStreamKeys('youtube', result.streamUrl, result.streamKey);
        }

        _notifyRenderer('youtube', result.success ? 'connected' : 'error');
        resolve(result);
      } catch (e) {
        server.close();
        resolve({ success: false, error: e.message });
      }
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}/callback`;

      // Build Google OAuth URL
      // Client ID comes from relay server env — we fetch it or use a shared constant
      const authUrl = `${YOUTUBE_AUTH_URL}?` + new URLSearchParams({
        client_id: process.env.YOUTUBE_CLIENT_ID || '',
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: YOUTUBE_SCOPES,
        access_type: 'offline',
        prompt: 'consent',
        state,
      });

      shell.openExternal(authUrl);

      // Timeout after 5 minutes
      setTimeout(() => {
        server.close();
        resolve({ success: false, error: 'OAuth timed out (5 min)' });
      }, 5 * 60 * 1000);
    });

    server.on('error', (e) => {
      resolve({ success: false, error: `Local server error: ${e.message}` });
    });
  });
}

// ─── FACEBOOK OAUTH (relay redirect + polling) ──────────────────────────────

/**
 * Start Facebook OAuth flow.
 * Opens browser → user approves → redirect goes to relay → Electron polls.
 * @returns {Promise<{success, pages?: Array, error?}>}
 */
async function startFacebookOAuth() {
  const state = crypto.randomBytes(16).toString('hex');
  const relayHttp = _getRelayHttp();
  const redirectUri = `${relayHttp}/api/oauth/facebook/callback`;

  const authUrl = `${FACEBOOK_AUTH_URL}?` + new URLSearchParams({
    client_id: process.env.FACEBOOK_APP_ID || '',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: FACEBOOK_SCOPES,
    state,
  });

  shell.openExternal(authUrl);

  // Poll relay for the auth code (Facebook redirects to relay, not localhost)
  const maxPolls = 60; // 2s × 60 = 120 seconds
  for (let i = 0; i < maxPolls; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const pending = await _relayGet(`/api/church/app/oauth/facebook/pending?state=${state}`);
      if (pending.ready && pending.code) {
        // Exchange code with relay
        const result = await _relayPost('/api/church/app/oauth/facebook/exchange', {
          code: pending.code,
          redirectUri,
        });
        _notifyRenderer('facebook', result.success ? 'pages_ready' : 'error');
        return result;
      }
    } catch { /* keep polling */ }
  }

  return { success: false, error: 'Facebook OAuth timed out (2 min)' };
}

/**
 * After user picks a Facebook Page in the UI.
 * @param {string} pageId
 * @returns {Promise<{success, streamKey?, streamUrl?, pageName?, error?}>}
 */
async function selectFacebookPage(pageId) {
  const result = await _relayPost('/api/church/app/oauth/facebook/select-page', { pageId });
  if (result.success && result.streamKey) {
    _saveStreamKeys('facebook', result.streamUrl, result.streamKey);
  }
  _notifyRenderer('facebook', result.success ? 'connected' : 'error');
  return result;
}

// ─── DISCONNECT ──────────────────────────────────────────────────────────────

async function disconnectPlatform(platform) {
  const result = await _relayDelete(`/api/church/app/oauth/${platform}`);
  // Clear local keys
  const config = _loadConfig();
  if (platform === 'youtube') {
    delete config.youtubeOAuthAccessToken;
    delete config.youtubeOAuthRefreshToken;
    delete config.youtubeStreamKey;
    delete config.youtubeStreamUrl;
  } else if (platform === 'facebook') {
    delete config.facebookOAuthAccessToken;
    delete config.facebookStreamKey;
    delete config.facebookStreamUrl;
    delete config.facebookPageName;
  }
  _saveConfig(config);
  _notifyRenderer(platform, 'disconnected');
  return result;
}

// ─── STATUS & STREAM KEYS ────────────────────────────────────────────────────

async function getOAuthStatus() {
  return _relayGet('/api/church/app/oauth/status');
}

async function getStreamKeys() {
  return _relayGet('/api/church/app/oauth/stream-keys');
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function _saveStreamKeys(platform, url, key) {
  const config = _loadConfig();
  if (platform === 'youtube') {
    config.youtubeStreamUrl = url;
    config.youtubeStreamKey = key;
  } else if (platform === 'facebook') {
    config.facebookStreamUrl = url;
    config.facebookStreamKey = key;
  }
  // Also update the generic RTMP fields for encoder auto-push
  config.rtmpUrl = url;
  config.rtmpStreamKey = key;
  _saveConfig(config);
}

function _notifyRenderer(platform, status) {
  try {
    _getMainWindow()?.webContents.send('oauth-update', { platform, status });
  } catch { /* window may not exist */ }
}

module.exports = {
  init,
  startYouTubeOAuth,
  startFacebookOAuth,
  selectFacebookPage,
  disconnectPlatform,
  getOAuthStatus,
  getStreamKeys,
};
