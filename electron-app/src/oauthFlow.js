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


const crypto = require('crypto');
const { shell } = require('electron');

const YOUTUBE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const YOUTUBE_SCOPES = 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube';

const FACEBOOK_AUTH_URL = 'https://www.facebook.com/v21.0/dialog/oauth';
const FACEBOOK_SCOPES = 'pages_show_list,pages_read_engagement';

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
  // Client ID comes from relay server (it's public, not secret)
  let clientId = process.env.YOUTUBE_CLIENT_ID || _loadConfig().youtubeClientId;
  if (!clientId) {
    try {
      const ids = await _relayGet('/api/church/app/oauth/client-ids');
      clientId = ids.youtubeClientId;
    } catch { /* ignore */ }
  }
  if (!clientId) {
    return { success: false, error: 'YouTube OAuth not configured on relay server (missing client ID)' };
  }

  // Use relay server as redirect target (same pattern as Facebook).
  // Register this URL in Google Cloud Console as an authorized redirect URI.
  const state = crypto.randomBytes(16).toString('hex');
  const relayHttp = _getRelayHttp();
  const redirectUri = `${relayHttp}/api/oauth/youtube/callback`;

  const authUrl = `${YOUTUBE_AUTH_URL}?` + new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: YOUTUBE_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });

  shell.openExternal(authUrl);

  // Poll relay for the auth code (Google redirects to relay, not localhost)
  const maxPolls = 150; // 2s x 150 = 5 minutes
  for (let i = 0; i < maxPolls; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const pending = await _relayGet(`/api/church/app/oauth/youtube/pending?state=${state}`);
      if (pending.ready && pending.code) {
        const result = await _relayPost('/api/church/app/oauth/youtube/exchange', {
          code: pending.code,
          redirectUri,
        });
        if (result.success && result.streamKey) {
          _saveStreamKeys('youtube', result.streamUrl, result.streamKey);
        }
        _notifyRenderer('youtube', result.success ? 'connected' : 'error');
        return result;
      }
    } catch { /* keep polling */ }
  }

  return { success: false, error: 'YouTube OAuth timed out (5 min)' };
}

// ─── FACEBOOK OAUTH (relay redirect + polling) ──────────────────────────────

/**
 * Start Facebook OAuth flow.
 * Opens browser → user approves → redirect goes to relay → Electron polls.
 * @returns {Promise<{success, pages?: Array, error?}>}
 */
async function startFacebookOAuth() {
  // App ID comes from relay server (it's public, not secret)
  let appId = process.env.FACEBOOK_APP_ID || _loadConfig().facebookAppId;
  if (!appId) {
    try {
      const ids = await _relayGet('/api/church/app/oauth/client-ids');
      appId = ids.facebookAppId;
    } catch { /* ignore */ }
  }
  if (!appId) {
    return { success: false, error: 'Facebook OAuth not configured on relay server (missing app ID)' };
  }

  const state = crypto.randomBytes(16).toString('hex');
  const relayHttp = _getRelayHttp();
  const redirectUri = `${relayHttp}/api/oauth/facebook/callback`;

  const authUrl = `${FACEBOOK_AUTH_URL}?` + new URLSearchParams({
    client_id: appId,
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
