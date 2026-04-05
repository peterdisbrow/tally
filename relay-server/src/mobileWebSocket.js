/**
 * Mobile WebSocket endpoint — battery-friendly, JWT-authenticated WebSocket
 * for iOS/Android mobile clients.
 *
 * Key differences from the portal SSE and church agent WebSocket:
 * - JWT auth via query param (no cookies)
 * - Full status updates (instanceStatus + roomInstanceMap)
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
 * @param {Function} [opts.checkCommandRateLimit] - Rate limiter for commands
 * @returns {{ handleMobileConnection, broadcastToMobile, getMobileClientCount, getMobileSubprotocol }}
 */
function createMobileWebSocketHandler({
  churches,
  db,
  queryClient = null,
  jwtSecret,
  pushNotifications = null,
  log = console.log,
  checkCommandRateLimit = async () => ({ ok: true }),
}) {
  // Track mobile clients: Map<churchId, Set<ws>>
  const mobileClients = new Map();
  const hasQueryClient = queryClient
    && typeof queryClient.queryOne === 'function';

  async function resolveChurch(churchId) {
    const runtimeChurch = churches?.get(churchId);
    if (runtimeChurch?.name) {
      return { churchId, name: runtimeChurch.name };
    }

    if (hasQueryClient) {
      return queryClient.queryOne('SELECT churchId, name FROM churches WHERE churchId = ?', [churchId]);
    }

    if (db && typeof db.prepare === 'function') {
      return db.prepare('SELECT churchId, name FROM churches WHERE churchId = ?').get(churchId);
    }

    return runtimeChurch || null;
  }


  /**
   * Extract the auth token from a mobile upgrade request.
   * Prefers the Sec-WebSocket-Protocol subprotocol (token.<JWT>) over the
   * legacy query string (?token=<JWT>) for security — tokens in URLs appear
   * in server logs.
   *
   * @param {URL} url - Parsed request URL
   * @param {object} req - Raw HTTP upgrade request (has headers)
   * @returns {string|null} Raw JWT string, or null if absent
   */
  function _extractToken(url, req) {
    // Prefer subprotocol header: "token.<JWT>"
    const protocolHeader = req?.headers?.['sec-websocket-protocol'] || '';
    for (const proto of protocolHeader.split(',').map(p => p.trim())) {
      if (proto.startsWith('token.')) {
        return proto.slice('token.'.length);
      }
    }
    // Fall back to query string for backward compatibility
    return url.searchParams.get('token');
  }

  /**
   * Return the subprotocol to echo back for a mobile upgrade request.
   * The WebSocket spec requires the server to echo the chosen subprotocol.
   * Called from the WebSocketServer handleProtocols callback.
   *
   * @param {Set<string>} protocols - Requested subprotocols
   * @returns {string|false} The chosen protocol, or false if none
   */
  function getMobileSubprotocol(protocols) {
    for (const p of protocols) {
      if (p.startsWith('token.')) return p;
    }
    return false;
  }

  /**
   * Handle a new mobile WebSocket connection.
   * Accepts token via Sec-WebSocket-Protocol (preferred) or ?token= query string.
   *
   * @param {object} ws - WebSocket instance
   * @param {URL} url - Parsed request URL
   * @param {object} req - Raw HTTP upgrade request
   */
  async function handleMobileConnection(ws, url, req) {
    try {
      const token = _extractToken(url, req);
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
      const church = await resolveChurch(churchId);
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
        Promise.resolve(pushNotifications.touchDevice(deviceToken)).catch((e) => {
          log(`[MobileWS] Failed to touch device token: ${e.message}`);
        });
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
      ws.on('message', async (raw) => {
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
            // Route command from mobile client to the correct church instance
            if (!msg.command) break;

            const runtime = churches.get(churchId);
            if (!runtime) {
              _safeSend(ws, { type: 'command_result', messageId: msg.messageId, error: 'Church not connected' });
              break;
            }

            // Rate limit
            const rateCheck = await checkCommandRateLimit(churchId);
            if (!rateCheck.ok) {
              _safeSend(ws, { type: 'command_result', messageId: msg.messageId, error: 'Rate limit exceeded' });
              break;
            }

            // Build the command payload matching what controllers send.
            // The church-client extracts `id` (not `messageId`) from the message,
            // so we must send both fields so the result round-trip works.
            const cmdPayload = {
              type: 'command',
              command: msg.command,
              params: msg.params || {},
              id: msg.messageId,        // church-client uses msg.id in executeCommand
              messageId: msg.messageId, // keep for any listener that uses messageId
            };

            // If roomId is specified, find the instance serving that room
            const roomId = msg.roomId;
            let sent = false;
            if (roomId && runtime.roomInstanceMap) {
              const targetInstance = runtime.roomInstanceMap[roomId];
              const targetSocket = targetInstance && runtime.sockets?.get(targetInstance);
              if (targetSocket?.readyState === 1) {
                _safeSend(targetSocket, cmdPayload);
                sent = true;
              }
            }

            // Fallback: broadcast to all instances (same as controller behavior)
            if (!sent) {
              if (runtime.sockets?.size) {
                for (const sock of runtime.sockets.values()) {
                  if (sock.readyState === 1) {
                    _safeSend(sock, cmdPayload);
                    sent = true;
                  }
                }
              }
            }

            if (!sent) {
              _safeSend(ws, { type: 'command_result', messageId: msg.messageId, error: 'Church not connected' });
            }

            log(`[MobileWS] Command ${msg.command} routed for ${church.name}${roomId ? ` room=${roomId}` : ''} (sent=${sent})`);
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
        log(`[MobileWS] Client disconnected for ${church.name} (${churchId})`);
      });

      ws.on('error', (err) => {
        log(`[MobileWS] Error for ${church.name}: ${err.message}`);
      });
    } catch (err) {
      log(`[MobileWS] Connection error: ${err.message}`);
      try {
        ws.close(1011, 'Internal error');
      } catch {}
    }
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
   * Send a full status_update to mobile clients.
   * Sends instanceStatus and roomInstanceMap so the mobile app can render
   * per-room device status.
   *
   * @param {object} church - Runtime church object with instanceStatus, roomInstanceMap, etc.
   */
  function sendStatusUpdate(church) {
    broadcastToMobile(church.churchId, {
      type: 'status_update',
      churchId: church.churchId,
      name: church.name,
      instanceStatus: church.instanceStatus || {},
      roomInstanceMap: church.roomInstanceMap || {},
      timestamp: new Date().toISOString(),
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
   * Sends church_connected or church_disconnected with the data shape
   * the mobile app expects.
   *
   * @param {object} church - Runtime church object
   * @param {string|null} roomId - Room ID (unused currently, reserved)
   * @param {boolean} connected - Whether the church client connected or disconnected
   */
  function sendConnectionChange(church, roomId, connected) {
    if (connected) {
      // Determine the instance name — use the first key in instanceStatus if available
      const instanceKeys = Object.keys(church.instanceStatus || {});
      const instance = instanceKeys[0] || church.name;

      broadcastToMobile(church.churchId, {
        type: 'church_connected',
        churchId: church.churchId,
        name: church.name,
        instance,
        roomId: roomId || null,
        timestamp: new Date().toISOString(),
        connected: true,
        status: church.instanceStatus?.[instance] || church.status || {},
        roomInstanceMap: church.roomInstanceMap || {},
      });
    } else {
      broadcastToMobile(church.churchId, {
        type: 'church_disconnected',
        churchId: church.churchId,
        name: church.name,
        connected: false,
        status: church.status || {},
      });
    }
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
    sendStatusUpdate,
    sendAlertToMobile,
    sendConnectionChange,
    getMobileClientCount,
    getMobileSubprotocol,
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


module.exports = { createMobileWebSocketHandler };
