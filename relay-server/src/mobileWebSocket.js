/**
 * Mobile WebSocket endpoint — battery-friendly, JWT-authenticated WebSocket
 * for iOS/Android mobile clients.
 *
 * Key differences from the portal SSE and church agent WebSocket:
 * - JWT auth via query param (no cookies)
 * - Delta updates only (not full status objects)
 * - Configurable heartbeat interval
 * - Receives alerts, status changes, chat, and command results
 */

'use strict';

const jwt = require('jsonwebtoken');

/**
 * Create the mobile WebSocket handler.
 *
 * @param {object} opts
 * @param {Map} opts.churches - Runtime church map
 * @param {object} opts.db - SQLite database
 * @param {string} opts.jwtSecret - JWT signing secret
 * @param {object} [opts.pushNotifications] - PushNotificationService instance
 * @param {Function} [opts.log] - Logging function
 * @returns {{ handleMobileConnection, broadcastToMobile, getMobileClientCount }}
 */
function createMobileWebSocketHandler({
  churches,
  db,
  jwtSecret,
  pushNotifications = null,
  log = console.log,
}) {
  // Track mobile clients: Map<churchId, Set<ws>>
  const mobileClients = new Map();

  // Track last status per church for delta computation
  const lastStatus = new Map();

  /**
   * Handle a new mobile WebSocket connection.
   * URL: /mobile?token=<JWT>
   */
  function handleMobileConnection(ws, url) {
    const token = url.searchParams.get('token');
    if (!token) {
      ws.close(4001, 'Token required');
      return;
    }

    let payload;
    try {
      payload = jwt.verify(token, jwtSecret);
      if (payload.type !== 'church_app') throw new Error('wrong token type');
    } catch (e) {
      ws.close(4003, 'Invalid token');
      return;
    }

    const churchId = payload.churchId;
    const church = db.prepare('SELECT churchId, name FROM churches WHERE churchId = ?').get(churchId);
    if (!church) {
      ws.close(4004, 'Church not found');
      return;
    }

    // Register this mobile client
    if (!mobileClients.has(churchId)) {
      mobileClients.set(churchId, new Set());
    }
    mobileClients.get(churchId).add(ws);

    ws._churchId = churchId;
    ws._churchName = church.name;
    ws._connectedAt = Date.now();

    log(`[MobileWS] Client connected for ${church.name} (${churchId})`);

    // Touch device token if provided
    const deviceToken = url.searchParams.get('deviceToken');
    if (deviceToken && pushNotifications) {
      pushNotifications.touchDevice(deviceToken);
    }

    // Send initial state
    const runtime = churches.get(churchId);
    _safeSend(ws, {
      type: 'connected',
      churchId,
      churchName: church.name,
      status: runtime?.status || {},
      timestamp: Date.now(),
    });

    // Heartbeat — configurable via query param (default 30s, min 15s, max 120s)
    const heartbeatMs = Math.max(15000, Math.min(120000,
      parseInt(url.searchParams.get('heartbeat') || '30000', 10) || 30000
    ));
    const heartbeatTimer = setInterval(() => {
      if (ws.readyState === 1) {
        _safeSend(ws, { type: 'heartbeat', ts: Date.now() });
      }
    }, heartbeatMs);

    // Handle incoming messages from mobile client
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      switch (msg.type) {
        case 'ping':
          _safeSend(ws, { type: 'pong', ts: Date.now() });
          break;

        case 'subscribe_room':
          // Client wants updates for a specific room only
          ws._subscribedRooms = ws._subscribedRooms || new Set();
          if (msg.roomId) ws._subscribedRooms.add(msg.roomId);
          break;

        case 'unsubscribe_room':
          if (ws._subscribedRooms) ws._subscribedRooms.delete(msg.roomId);
          break;

        case 'ack_alert':
          // Acknowledge an alert from mobile
          if (msg.alertId) {
            _safeSend(ws, { type: 'ack_received', alertId: msg.alertId });
          }
          break;

        case 'command': {
          // Route commands from mobile to the church agent instance
          const targetChurch = churches.get(churchId);
          if (targetChurch && targetChurch.sockets?.size) {
            const fwd = { type: 'command', command: msg.command, params: msg.params || {}, id: msg.messageId };
            // If roomId specified, target the instance for that room
            if (msg.roomId && targetChurch.roomInstanceMap) {
              const inst = targetChurch.roomInstanceMap[msg.roomId];
              const sock = inst && targetChurch.sockets.get(inst);
              if (sock?.readyState === 1) {
                _safeSend(sock, fwd);
              }
            } else {
              // Broadcast to all instances
              for (const sock of targetChurch.sockets.values()) {
                if (sock.readyState === 1) _safeSend(sock, fwd);
              }
            }
          }
          break;
        }

        case 'stream_protection_command': {
          // Route stream protection commands from mobile to church agent
          const spChurch = churches.get(churchId);
          if (spChurch && spChurch.sockets?.size) {
            const fwd = { type: 'stream_protection_command', action: msg.action };
            for (const sock of spChurch.sockets.values()) {
              if (sock.readyState === 1) _safeSend(sock, fwd);
            }
          }
          break;
        }

        default:
          break;
      }
    });

    ws.on('close', () => {
      clearInterval(heartbeatTimer);
      const clients = mobileClients.get(churchId);
      if (clients) {
        clients.delete(ws);
        if (clients.size === 0) mobileClients.delete(churchId);
      }
      log(`[MobileWS] Client disconnected for ${church.name}`);
    });

    ws.on('error', (err) => {
      log(`[MobileWS] Error for ${church.name}: ${err.message}`);
    });
  }

  /**
   * Broadcast a message to all mobile clients for a church.
   * Supports room filtering — if the message has a roomId, only send to
   * clients subscribed to that room (or clients with no room filter).
   */
  function broadcastToMobile(churchId, message) {
    const clients = mobileClients.get(churchId);
    if (!clients || clients.size === 0) return 0;

    let sent = 0;
    const roomId = message.roomId || null;

    for (const ws of clients) {
      if (ws.readyState !== 1) continue;

      // Room filtering: if client subscribed to specific rooms, check match
      if (roomId && ws._subscribedRooms && ws._subscribedRooms.size > 0) {
        if (!ws._subscribedRooms.has(roomId)) continue;
      }

      _safeSend(ws, message);
      sent++;
    }
    return sent;
  }

  /**
   * Send a status delta to mobile clients.
   * Computes diff from last known status and sends only changed fields.
   */
  function sendStatusDelta(churchId, newStatus, roomId = null) {
    const key = roomId ? `${churchId}::${roomId}` : churchId;
    const prev = lastStatus.get(key) || {};
    const delta = _computeDelta(prev, newStatus);

    if (Object.keys(delta).length === 0) return;

    lastStatus.set(key, { ...newStatus });

    broadcastToMobile(churchId, {
      type: 'status_delta',
      roomId,
      delta,
      timestamp: Date.now(),
    });
  }

  /**
   * Send an alert to mobile clients.
   */
  function sendAlertToMobile(churchId, alertEvent) {
    broadcastToMobile(churchId, {
      type: 'alert',
      alert: {
        id: alertEvent.alertId,
        alertType: alertEvent.alertType,
        severity: alertEvent.severity,
        roomId: alertEvent.context?._roomId || null,
        roomName: alertEvent.context?._instanceName || null,
        likelyCause: alertEvent.diagnosis?.likely_cause || null,
        canAutoFix: alertEvent.diagnosis?.canAutoFix || false,
        timestamp: alertEvent.timestamp || Date.now(),
      },
    });
  }

  /**
   * Send a connection state change to mobile clients.
   */
  function sendConnectionChange(churchId, roomId, connected) {
    broadcastToMobile(churchId, {
      type: 'connection',
      roomId,
      connected,
      timestamp: Date.now(),
    });
  }

  /**
   * Get count of connected mobile clients for a church (or all).
   */
  function getMobileClientCount(churchId = null) {
    if (churchId) return mobileClients.get(churchId)?.size || 0;
    let total = 0;
    for (const clients of mobileClients.values()) total += clients.size;
    return total;
  }

  return {
    handleMobileConnection,
    broadcastToMobile,
    sendStatusDelta,
    sendAlertToMobile,
    sendConnectionChange,
    getMobileClientCount,
  };
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function _safeSend(ws, data) {
  if (ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(data));
  } catch {
    // Connection may have closed between readyState check and send
  }
}

/**
 * Compute a shallow delta between two status objects.
 * Returns only keys that differ (added, changed, or removed).
 */
function _computeDelta(prev, next) {
  const delta = {};
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(next)]);

  for (const key of allKeys) {
    const prevVal = prev[key];
    const nextVal = next[key];

    if (prevVal === undefined && nextVal !== undefined) {
      delta[key] = nextVal;
    } else if (nextVal === undefined && prevVal !== undefined) {
      delta[key] = null; // Signal removal
    } else if (typeof nextVal === 'object' && nextVal !== null) {
      // Deep compare for device sub-objects (atem, obs, mixer, etc.)
      if (JSON.stringify(prevVal) !== JSON.stringify(nextVal)) {
        delta[key] = nextVal;
      }
    } else if (prevVal !== nextVal) {
      delta[key] = nextVal;
    }
  }

  return delta;
}

module.exports = { createMobileWebSocketHandler };
