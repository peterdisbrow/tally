/**
 * Relay Client — communication with the Tally relay server
 *
 * Extracted from main.js. Handles relay URL normalization, token validation,
 * HTTP helpers, login, and preview WebSocket control.
 */

const WebSocket = require('ws');

const DEFAULT_RELAY_URL = 'wss://api.tallyconnect.app';

// ─── URL HELPERS ──────────────────────────────────────────────────────────────

function normalizeRelayUrl(url) {
  const raw = String(url || DEFAULT_RELAY_URL).trim();
  if (!raw) return DEFAULT_RELAY_URL;

  if (/^wss?:\/\//i.test(raw)) {
    return raw.replace(/\/+$/, '');
  }

  if (/^https?:\/\//i.test(raw)) {
    return raw
      .replace(/^https:\/\//i, 'wss://')
      .replace(/^http:\/\//i, 'ws://')
      .replace(/\/+$/, '');
  }

  return `wss://${raw.replace(/\/+$/, '')}`;
}

function isLocalRelayUrl(url) {
  try {
    const normalized = normalizeRelayUrl(url);
    const httpUrl = normalized
      .replace(/^wss:\/\//i, 'https://')
      .replace(/^ws:\/\//i, 'http://');
    const parsed = new URL(httpUrl);
    const host = (parsed.hostname || '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function enforceRelayPolicy(url) {
  const normalized = normalizeRelayUrl(url || DEFAULT_RELAY_URL);
  if (isLocalRelayUrl(normalized)) return normalized;
  return normalizeRelayUrl(DEFAULT_RELAY_URL);
}

function relayHttpUrl(url) {
  return enforceRelayPolicy(url).replace(/^wss?:\/\//i, (m) => (m.toLowerCase() === 'wss://' ? 'https://' : 'http://'));
}

// ─── JWT DECODE ───────────────────────────────────────────────────────────────

function decodeChurchIdFromToken(token) {
  try {
    const parts = token?.split('.') || [];
    if (!parts[1]) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    return payload.churchId || payload.church_id || null;
  } catch {
    return null;
  }
}

// ─── TOKEN VALIDATION ─────────────────────────────────────────────────────────

function checkTokenWithRelay(token, relayUrl, ms = 5000) {
  const baseWsUrl = normalizeRelayUrl(relayUrl).replace(/\/$/, '') + '/church';
  const AUTH_STABILITY_MS = 1200;

  function runHandshake({ useUrlToken }) {
    return new Promise((resolve) => {
      const wsUrl = useUrlToken
        ? `${baseWsUrl}?token=${encodeURIComponent(token || '')}`
        : baseWsUrl;
      const socket = new WebSocket(wsUrl);
      let opened = false;
      let authTimer = null;
      let done = false;

      const finish = (result) => {
        if (done) return;
        done = true;
        if (authTimer) clearTimeout(authTimer);
        try { socket.removeAllListeners(); } catch {}
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          try { socket.close(); } catch {}
        }
        resolve(result);
      };

      const timer = setTimeout(() => finish({ success: false, error: 'Token validation timed out' }), ms);

      socket.once('open', () => {
        opened = true;
        if (!useUrlToken) {
          socket.send(JSON.stringify({ type: 'auth', token }));
        }
        // If socket remains open briefly after auth step, treat as valid.
        authTimer = setTimeout(() => {
          clearTimeout(timer);
          finish({ success: true, message: 'Token handshake succeeded' });
        }, AUTH_STABILITY_MS);
      });

      socket.once('error', (err) => {
        clearTimeout(timer);
        finish({ success: false, error: err.message || 'Token validation failed' });
      });

      socket.once('close', (code, reasonBuffer) => {
        clearTimeout(timer);
        const reason = String(reasonBuffer || '').trim();
        if (code === 1008) {
          finish({ success: false, error: reason ? `Auth failed: ${reason}` : 'Invalid token for this relay' });
          return;
        }
        if (!opened) {
          finish({ success: false, error: `Connection closed before auth (${code})` });
          return;
        }
        finish({ success: false, error: `Relay closed connection (${code})` });
      });
    });
  }

  return runHandshake({ useUrlToken: false }).then((firstAttempt) => {
    if (firstAttempt.success) return firstAttempt;
    const msg = String(firstAttempt.error || '').toLowerCase();
    const needsUrlTokenFallback =
      msg.includes('token required') ||
      msg.includes('first message must be auth');
    if (!needsUrlTokenFallback) return firstAttempt;
    // Compatibility fallback for older relay builds that require token in URL.
    return runHandshake({ useUrlToken: true });
  });
}

// ─── HTTP HELPERS ─────────────────────────────────────────────────────────────

async function testConnection({ url, token } = {}) {
  const relayUrl = enforceRelayPolicy(url);

  if (token) {
    const tokenCheck = await checkTokenWithRelay(token, relayUrl);
    if (!tokenCheck.success) return tokenCheck;
  }

  return new Promise((resolve) => {
    const endpoint = relayHttpUrl(relayUrl);
    const lib = endpoint.startsWith('https') ? require('https') : require('http');
    const req = lib.get(endpoint, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ success: true, service: json.service, churches: json.churches });
        } catch {
          resolve({ success: true, message: 'Server responded' });
        }
      });
    });

    req.on('error', (e) => resolve({ success: false, error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'Timeout' });
    });
  });
}

async function postJson(url, payload, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        success: false,
        error: data.error || `Request failed (${response.status})`,
        status: response.status,
        data,
      };
    }

    return { success: true, status: response.status, data };
  } catch (e) {
    return { success: false, error: e.message || 'Network error' };
  } finally {
    clearTimeout(timer);
  }
}

async function loginChurchWithCredentials({ relay, email, password }) {
  const relayUrl = enforceRelayPolicy(relay);
  const endpoint = `${relayHttpUrl(relayUrl).replace(/\/+$/, '')}/api/church/app/login`;
  return postJson(endpoint, { email, password });
}

// ─── PREVIEW CONTROL ──────────────────────────────────────────────────────────

// Persistent socket for preview frame streaming — lives in this module
let previewControllerSocket = null;

/**
 * Send a preview command to the relay controller.
 *
 * @param {string} command - e.g. 'preview.start', 'preview.stop', 'preview.snap'
 * @param {object} params - extra params for the command
 * @param {object} deps - injected dependencies:
 *   { loadConfig, getMainWindow } — avoids circular dependency with config-manager
 */
function sendPreviewCommand(command, params = {}, deps = {}) {
  const { loadConfig, getMainWindow } = deps;
  const config = loadConfig();
  if (!config.token) throw new Error('No church token configured');

  const relay = enforceRelayPolicy(config.relay || DEFAULT_RELAY_URL);
  const churchId = decodeChurchIdFromToken(config.token);
  const adminKey = config.adminApiKey;

  if (!adminKey) {
    throw new Error('No adminApiKey stored for preview control');
  }

  if (!churchId) {
    throw new Error('Unable to parse churchId from token');
  }

  const mainWindow = getMainWindow ? getMainWindow() : null;

  return new Promise((resolve, reject) => {
    // Keep one controller socket while preview stream is active so frames can flow.
    if (command === 'preview.start' && previewControllerSocket) {
      try { previewControllerSocket.send(JSON.stringify({ type: 'command', churchId, command: 'preview.stop', params: {} })); } catch {}
      try { previewControllerSocket.terminate(); } catch {}
      previewControllerSocket = null;
    }

    const socket = new WebSocket(`${relay.replace(/\/$/, '')}/controller`);
    const isStart = command === 'preview.start';
    const timeout = setTimeout(() => {
      try { socket.terminate(); } catch {}
      if (isStart && previewControllerSocket === socket) previewControllerSocket = null;
      reject(new Error('Preview command timed out'));
    }, 8000);

    const done = (result) => {
      clearTimeout(timeout);
      resolve(result);
      if (!isStart) {
        try { if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(); } catch {}
      }
      if (socket === previewControllerSocket) {
        previewControllerSocket = null;
      }
    };

    const onMessage = (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'preview_frame' && msg.churchId === churchId) {
          mainWindow?.webContents.send('preview-frame', {
            timestamp: msg.timestamp,
            width: msg.width,
            height: msg.height,
            format: msg.format,
            data: msg.data,
          });
          return;
        }

        if (msg.type === 'command_result' && msg.command === command && msg.churchId === churchId) {
          if (msg.error) {
            done({ success: false, error: msg.error });
          } else {
            done({ success: true, result: msg.result });
          }
        }
      } catch (e) {
        done({ success: true });
      }
    };

    socket.once('open', () => {
      // Authenticate via first message (keeps apikey out of URL/server logs)
      socket.send(JSON.stringify({ type: 'auth', apikey: adminKey }));

      socket.send(JSON.stringify({
        type: 'command',
        churchId,
        command,
        params,
      }));

      if (command === 'preview.stop') {
        done({ success: true });
      } else if (command === 'preview.start') {
        previewControllerSocket = socket;
        socket.on('message', onMessage);
        mainWindow?.webContents.send('log', '[Preview] Started preview stream from relay controller');
      } else {
        socket.on('message', onMessage);
      }
    });

    socket.on('message', (raw) => {
      if (isStart) return; // handled above once open
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'command_result' && msg.command === command && msg.churchId === churchId) {
          if (msg.error) {
            done({ success: false, error: msg.error });
          } else {
            done({ success: true, result: msg.result });
          }
        }
      } catch (e) {
        done({ success: true });
      }
    });

    socket.once('error', (err) => done({ success: false, error: err.message || 'Relay socket error' }));
    socket.once('close', () => {
      if (socket === previewControllerSocket) previewControllerSocket = null;
      done({ success: true });
    });
  });
}

module.exports = {
  DEFAULT_RELAY_URL,
  normalizeRelayUrl,
  isLocalRelayUrl,
  enforceRelayPolicy,
  relayHttpUrl,
  decodeChurchIdFromToken,
  checkTokenWithRelay,
  testConnection,
  postJson,
  loginChurchWithCredentials,
  sendPreviewCommand,
};
