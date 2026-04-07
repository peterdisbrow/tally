/**
 * relay-client.js — Relay communication (URL normalisation, auth, preview, login).
 *
 * Extracted from main.js — pure refactoring, no behaviour changes.
 */

const WebSocket = require('ws');

const DEFAULT_RELAY_URL = process.env.TALLY_DEFAULT_RELAY_URL || 'wss://api.tallyconnect.app';

// Injected dependencies — set via init()
let _loadConfig = () => ({});
let _getMainWindow = () => null;

// Module-level state (moved from main.js)
let previewControllerSocket = null;
let previewFetchState = {
  sessionId: 0,
  churchId: null,
  lastDeliveredFrameId: null,
  pending: null,
  inFlight: false,
};

/**
 * Wire external dependencies that live in main.js.
 */
function init({ loadConfig, getMainWindow }) {
  if (typeof loadConfig === 'function') _loadConfig = loadConfig;
  if (typeof getMainWindow === 'function') _getMainWindow = getMainWindow;
}

// ─── URL helpers ──────────────────────────────────────────────────────────────

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
  return normalizeRelayUrl(url || DEFAULT_RELAY_URL);
}

function relayHttpUrl(url) {
  return enforceRelayPolicy(url).replace(/^wss?:\/\//i, (m) => (m.toLowerCase() === 'wss://' ? 'https://' : 'http://'));
}

// ─── Token helpers ────────────────────────────────────────────────────────────

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

async function checkTokenWithRelay(token, relayUrl, ms = 5000) {
  // Validate token via HTTP (GET /api/church/app/me) instead of WebSocket.
  // The old WebSocket approach connected to /church which REPLACED the agent's
  // active relay connection, causing an infinite reconnect storm.
  try {
    const httpUrl = relayHttpUrl(relayUrl).replace(/\/+$/, '');
    const resp = await fetch(`${httpUrl}/api/church/app/me`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: AbortSignal.timeout(ms),
    });
    if (resp.ok) {
      return { success: true, message: 'Token validated via HTTP' };
    }
    if (resp.status === 401 || resp.status === 403) {
      return { success: false, error: 'Invalid token for this relay' };
    }
    return { success: false, error: `Relay returned ${resp.status}` };
  } catch (e) {
    return { success: false, error: e.message || 'Token validation failed' };
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

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

// ─── Preview controller ───────────────────────────────────────────────────────

function sendPreviewSubscription(socket, type, churchId) {
  if (!socket || !churchId) return;
  if (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING) return;
  socket.send(JSON.stringify({ type, churchId }));
}

function resetPreviewFetchState(churchId = null) {
  previewFetchState = {
    sessionId: previewFetchState.sessionId + 1,
    churchId,
    lastDeliveredFrameId: null,
    pending: null,
    inFlight: false,
  };
  return previewFetchState.sessionId;
}

async function fetchLatestPreviewFrame({ relay, adminKey, churchId, knownFrameId }) {
  const base = relayHttpUrl(relay).replace(/\/+$/, '');
  const headers = { 'x-api-key': adminKey };
  if (previewFetchState.lastDeliveredFrameId) {
    headers['if-none-match'] = previewFetchState.lastDeliveredFrameId;
  }

  const resp = await fetch(`${base}/api/admin/churches/${encodeURIComponent(churchId)}/preview/latest`, {
    headers,
    signal: AbortSignal.timeout(8000),
  });

  if (resp.status === 304) return null;
  if (!resp.ok) {
    throw new Error(`Preview fetch failed (${resp.status})`);
  }

  return resp.json();
}

async function drainPreviewFetchQueue({ relay, adminKey, churchId, mainWindow, sessionId }) {
  if (previewFetchState.inFlight) return;
  previewFetchState.inFlight = true;
  try {
    while (previewFetchState.pending) {
      const next = previewFetchState.pending;
      previewFetchState.pending = null;

      let frame = null;
      try {
        frame = await fetchLatestPreviewFrame({ relay, adminKey, churchId, knownFrameId: next.frameId });
      } catch (err) {
        if (sessionId !== previewFetchState.sessionId || previewFetchState.churchId !== churchId) return;
        mainWindow?.webContents?.send?.('log', `[Preview] fetch failed: ${err.message || err}`);
        continue;
      }

      if (!frame) continue;
      if (sessionId !== previewFetchState.sessionId || previewFetchState.churchId !== churchId) return;

      previewFetchState.lastDeliveredFrameId = frame.frameId || next.frameId || previewFetchState.lastDeliveredFrameId;
      mainWindow?.webContents.send('preview-frame', {
        timestamp: frame.timestamp,
        width: frame.width,
        height: frame.height,
        format: frame.format,
        data: frame.data,
      });
    }
  } finally {
    previewFetchState.inFlight = false;
    if (previewFetchState.pending && sessionId === previewFetchState.sessionId && previewFetchState.churchId === churchId) {
      drainPreviewFetchQueue({ relay, adminKey, churchId, mainWindow, sessionId }).catch(() => {});
    }
  }
}

function queuePreviewFetch({ relay, adminKey, churchId, frameId, mainWindow, sessionId }) {
  if (!frameId || previewFetchState.churchId !== churchId || sessionId !== previewFetchState.sessionId) return;
  if (previewFetchState.lastDeliveredFrameId === frameId) return;
  previewFetchState.pending = { frameId };
  if (!previewFetchState.inFlight) {
    drainPreviewFetchQueue({ relay, adminKey, churchId, mainWindow, sessionId }).catch(() => {});
  }
}

function sendPreviewCommand(command, params = {}) {
  const config = _loadConfig();
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

  return new Promise((resolve, reject) => {
    const mainWindow = _getMainWindow();
    let previewSessionId = previewFetchState.sessionId;

    // Keep one controller socket while preview stream is active so frames can flow.
    if (command === 'preview.start' && previewControllerSocket) {
      try { sendPreviewSubscription(previewControllerSocket, 'preview_unsubscribe', churchId); } catch {}
      try { previewControllerSocket.send(JSON.stringify({ type: 'command', churchId, command: 'preview.stop', params: {} })); } catch {}
      try { previewControllerSocket.terminate(); } catch {}
      previewControllerSocket = null;
    }

    if (command === 'preview.stop' && previewControllerSocket) {
      try { sendPreviewSubscription(previewControllerSocket, 'preview_unsubscribe', churchId); } catch {}
      try { previewControllerSocket.close(); } catch {}
      previewControllerSocket = null;
      resetPreviewFetchState();
    }

    if (command === 'preview.start') {
      previewSessionId = resetPreviewFetchState(churchId);
    }

    const socket = new WebSocket(`${relay.replace(/\/$/, '')}/controller?apikey=${encodeURIComponent(adminKey)}`);
    const isStart = command === 'preview.start';
    const timeout = setTimeout(() => {
      try { socket.terminate(); } catch {}
      if (isStart && previewControllerSocket === socket) previewControllerSocket = null;
      if (isStart) resetPreviewFetchState();
      reject(new Error('Preview command timed out'));
    }, 8000);

    const done = (result) => {
      clearTimeout(timeout);
      resolve(result);
      if (!isStart) {
        try { if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(); } catch {}
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

        if (msg.type === 'preview_available' && msg.churchId === churchId) {
          queuePreviewFetch({
            relay,
            adminKey,
            churchId,
            frameId: msg.frameId,
            mainWindow,
            sessionId: previewSessionId,
          });
          return;
        }

        if (msg.type === 'command_result' && msg.command === command && msg.churchId === churchId) {
          if (msg.error) {
            if (isStart && socket === previewControllerSocket) {
              try { socket.close(); } catch {}
              previewControllerSocket = null;
              resetPreviewFetchState();
            }
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
      if (isStart) {
        sendPreviewSubscription(socket, 'preview_subscribe', churchId);
      }

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
      if (isStart) resetPreviewFetchState();
      done({ success: true });
    });
  });
}

// ─── Problem Finder report push ──────────────────────────────────────────────

/**
 * Push a Problem Finder analysis report to the relay server.
 * Fire-and-forget: does not block on response.
 */
async function sendProblemFinderReport(report) {
  try {
    const config = _loadConfig();
    const token = config.token;
    const relayUrl = config.relay || DEFAULT_RELAY_URL;
    if (!token || !relayUrl) return { success: false, error: 'No token or relay URL' };

    const endpoint = `${relayHttpUrl(relayUrl).replace(/\/+$/, '')}/api/pf/report`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(report),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      return { success: response.ok, status: response.status, data };
    } catch (e) {
      return { success: false, error: e.message || 'Network error' };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return { success: false, error: e.message || 'sendProblemFinderReport failed' };
  }
}

// ─── Room management ─────────────────────────────────────────────────────────

async function fetchRooms() {
  const config = _loadConfig();
  if (!config.token) return { success: false, error: 'No token' };
  const base = relayHttpUrl(config.relay).replace(/\/+$/, '');
  try {
    const resp = await fetch(`${base}/api/church/app/rooms`, {
      headers: { 'Authorization': `Bearer ${config.token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return { success: false, error: `Server returned ${resp.status}` };
    const data = await resp.json();
    return { success: true, rooms: data.rooms || [], currentRoomId: data.currentRoomId || null };
  } catch (e) {
    return { success: false, error: e.message || 'Failed to fetch rooms' };
  }
}

async function createRoom(name, description) {
  const config = _loadConfig();
  if (!config.token) return { success: false, error: 'No token' };
  const base = relayHttpUrl(config.relay).replace(/\/+$/, '');
  try {
    const resp = await fetch(`${base}/api/church/app/rooms`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description: description || '' }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await resp.json();
    if (!resp.ok) return { success: false, error: data.error || `Server returned ${resp.status}` };
    return { success: true, room: data };
  } catch (e) {
    return { success: false, error: e.message || 'Failed to create room' };
  }
}

async function assignRoom(roomId) {
  const config = _loadConfig();
  if (!config.token) return { success: false, error: 'No token' };
  const base = relayHttpUrl(config.relay).replace(/\/+$/, '');
  try {
    const resp = await fetch(`${base}/api/church/app/room-assign`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await resp.json();
    if (!resp.ok) return { success: false, error: data.error || `Server returned ${resp.status}` };
    return { success: true, roomId: data.roomId, roomName: data.roomName };
  } catch (e) {
    return { success: false, error: e.message || 'Failed to assign room' };
  }
}

// ─── Room equipment sync ─────────────────────────────────────────────────────

async function syncEquipmentToRelay(roomId, equipment) {
  const config = _loadConfig();
  if (!config.token || !roomId) return { success: false, error: 'No token or roomId' };
  const base = relayHttpUrl(config.relay).replace(/\/+$/, '');
  try {
    const resp = await fetch(`${base}/api/church/app/rooms/${encodeURIComponent(roomId)}/equipment`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ equipment }),
      signal: AbortSignal.timeout(10000),
    });
    return { success: resp.ok };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function fetchEquipmentFromRelay(roomId) {
  const config = _loadConfig();
  if (!config.token || !roomId) return null;
  const base = relayHttpUrl(config.relay).replace(/\/+$/, '');
  try {
    const resp = await fetch(`${base}/api/church/app/rooms/${encodeURIComponent(roomId)}/equipment`, {
      headers: { 'Authorization': `Bearer ${config.token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.equipment && Object.keys(data.equipment).length > 0 ? data.equipment : null;
  } catch {
    return null;
  }
}

module.exports = {
  init,
  DEFAULT_RELAY_URL,
  normalizeRelayUrl,
  isLocalRelayUrl,
  enforceRelayPolicy,
  relayHttpUrl,
  decodeChurchIdFromToken,
  checkTokenWithRelay,
  postJson,
  loginChurchWithCredentials,
  testConnection,
  sendPreviewCommand,
  sendProblemFinderReport,
  syncEquipmentToRelay,
  fetchEquipmentFromRelay,
  fetchRooms,
  createRoom,
  assignRoom,
};
