'use strict';

const crypto = require('crypto');

/**
 * WebSocket routing factory for the Tally relay server.
 *
 * All external dependencies are injected so tests can stand up a real
 * WebSocket server with real routing logic — no mocked re-implementations.
 *
 * Usage in server.js (safeSend and broadcastToControllers stay as hoisted
 * function declarations so they're available throughout the module):
 *
 *   const { createWebSocketHandlers } = require('./src/websocketRouter');
 *   // ... after all subsystems are initialized ...
 *   const wsHandlers = createWebSocketHandlers({
 *     churches, controllers, jwt, jwtSecret: JWT_SECRET,
 *     wsOpen: WebSocket.OPEN,
 *     safeSend, broadcastToControllers,   // inject the hoisted versions
 *     checkPaidAccess: checkChurchPaidAccess,
 *     ...hooks
 *   });
 *   wss.on('connection', (ws, req) => {
 *     const url = new URL(req.url, 'http://localhost');
 *     const role = url.pathname.replace(/^\//, '');
 *     if (role === 'church') wsHandlers.handleChurchConnection(ws, url, clientIp);
 *     else if (role === 'controller') wsHandlers.handleControllerConnection(ws, url, req);
 *   });
 *
 * Usage in tests (no external safeSend needed — factory builds one from wsOpen):
 *
 *   const handlers = createWebSocketHandlers({
 *     churches, controllers, jwt, jwtSecret: 'test-secret',
 *   });
 */
function createWebSocketHandlers({
  // Core runtime state — shared Maps/Sets passed by reference
  churches,     // Map<churchId, churchObject>
  controllers,  // Set<ws>

  // JWT — the real jsonwebtoken module (or a compatible stub)
  jwt,
  jwtSecret,

  // WebSocket.OPEN constant (= 1). Defaults to 1 (the ws library constant).
  wsOpen = 1,

  // ─── Optional: inject pre-built send helpers ───────────────────────────────
  // In server.js these stay as hoisted `function` declarations so they remain
  // available before the factory call. Leave undefined in tests — the factory
  // builds minimal versions from wsOpen.
  safeSend: _injectedSafeSend,
  broadcastToControllers: _injectedBroadcast,

  // ─── Billing ───────────────────────────────────────────────────────────────
  // (churchId) => { allowed: bool, status: string, message?: string }
  checkPaidAccess = () => ({ allowed: true }),

  // ─── Controller auth ───────────────────────────────────────────────────────
  // (untrusted: string, trusted: string) => bool   — constant-time in production
  safeCompareKey = (a, b) => a === b,
  adminApiKey = '',

  // ─── Connection limits ─────────────────────────────────────────────────────
  wsConnectionsByIp = new Map(),  // IP -> active count
  maxConnectionsPerIp = 5,
  maxControllers = 20,

  // ─── Queued-message drain ──────────────────────────────────────────────────
  // Called right after a church reconnects; delivers any buffered messages.
  // (churchId: string, ws: WebSocket) => void
  drainQueue = () => {},

  // ─── Rate limiting for commands ────────────────────────────────────────────
  // async (churchId) => { ok: bool }
  checkCommandRateLimit = async () => ({ ok: true }),

  // ─── Broadcast side-channels (SSE dashboard, church portal) ───────────────
  broadcastToSSE    = () => {},
  broadcastToPortal = () => {},  // (churchId, data) => void
  streamOAuth       = null,      // StreamPlatformOAuth instance for CDN verification

  // ─── WebSocket-level ping intervals (keepalive through reverse proxies) ───
  // Interval in ms between WS-level pings. Set to 0 to disable.
  wsPingIntervalMs = 25_000,

  // ─── Room validation ────────────────────────────────────────────────────
  // (roomId: string, churchId: string) => bool — checks room exists and belongs to church
  validateRoomId = () => true,

  // ─── Lifecycle hooks (fired AFTER the routing action, no-op by default) ───
  // Use these in production to attach subsystem side-effects without embedding
  // heavy dependencies inside the routing layer.
  //
  // (church, ws) — fired after a successful church WebSocket connection
  onChurchConnected    = () => {},
  // (church) — fired after a church WebSocket closes
  onChurchDisconnected = () => {},
  // (ws) — fired after a controller successfully connects
  onControllerConnected    = () => {},
  // (ws) — fired after a controller disconnects
  onControllerDisconnected = () => {},
  // (church, msg, statusEvent) — fired after status_update is broadcast
  onStatusUpdate       = () => {},
  // (church, msg, alertEvent) — fired after alert is broadcast
  onAlert              = () => {},
  // (church, cmdResultMsg) — fired after command_result is broadcast
  onCommandResult      = () => {},
  // (church, msg) — catch-all for message types with no direct routing output
  //   (signal_event, viewer_snapshot, propresenter_slide_change, chat,
  //    preview_frame — handled entirely by production subsystem hooks)
  onChurchMessage      = () => {},
  // (ws, msg) — called for every controller message (after command routing)
  onControllerMessage  = () => {},
} = {}) {

  // ─── safeSend ─────────────────────────────────────────────────────────────
  // Use the injected version (server.js's hoisted declaration) when provided;
  // otherwise build a minimal version for tests.
  const safeSend = _injectedSafeSend || function safeSendLocal(ws, payload) {
    try {
      if (ws?.readyState === wsOpen) {
        ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
      }
    } catch {
      // Connection may have closed between the readyState check and send()
    }
  };

  // ─── broadcastToControllers ───────────────────────────────────────────────
  // Send a message to every connected controller WebSocket.
  const broadcastToControllers = _injectedBroadcast || function broadcastLocal(msg) {
    const data = JSON.stringify(msg);
    for (const ws of controllers) {
      safeSend(ws, data);
    }
  };

  // ─── Multi-instance helpers ──────────────────────────────────────────────
  // church.sockets is a Map<instanceName, ws> that tracks all connected Tally
  // agents for this church (multi-room).  church.ws is kept as
  // a backward-compat reference pointing to the most-recently-connected socket.

  /** Ensure church.sockets exists (lazy-init for churches created before this feature). */
  function ensureSockets(church) {
    if (!church.sockets) church.sockets = new Map();
  }

  /** Send a message to ALL connected instances of a church. */
  function sendToAllInstances(church, payload) {
    ensureSockets(church);
    for (const sock of church.sockets.values()) {
      safeSend(sock, payload);
    }
  }

  /** Return true if the church has at least one open WebSocket. */
  function hasOpenSocket(church) {
    ensureSockets(church);
    for (const sock of church.sockets.values()) {
      if (sock.readyState === wsOpen) return true;
    }
    return false;
  }

  // ─── handleChurchConnection ───────────────────────────────────────────────
  /**
   * Called when a WebSocket at /church connects.
   * @param {WebSocket} ws
   * @param {URL}       url  — already parsed, contains ?token=&instance=
   * @param {string}    clientIp
   */
  function handleChurchConnection(ws, url, clientIp) {  // eslint-disable-line no-unused-vars
    const token = url.searchParams.get('token');
    if (!token) return ws.close(1008, 'token required');

    let payload;
    try {
      payload = jwt.verify(token, jwtSecret);
    } catch {
      return ws.close(1008, 'invalid token');
    }

    const church = churches.get(payload.churchId);
    if (!church) return ws.close(1008, 'church not registered');

    const access = checkPaidAccess(church.churchId);
    if (!access.allowed) {
      return ws.close(1008, `billing_${access.status}`);
    }

    // Instance name — allows multiple Tally agents per church (multi-room).
    // Updated clients include roomId in the instance name (e.g. "Sanctuary::room_abc").
    // For legacy clients that send a bare instance + room_id, append room_id so
    // two agents on the same host for different rooms don't collide.
    const rawInstance = url.searchParams.get('instance') || '_default';
    const roomIdFromConnect = url.searchParams.get('room_id') || null;
    // Only append room_id if the client didn't already embed it in the instance name
    const instance = (roomIdFromConnect && !rawInstance.includes('::'))
      ? `${rawInstance}::${roomIdFromConnect}`
      : rawInstance;
    ws._tallyInstance = instance; // stash on the socket for disconnect lookup

    // Assign a unique connection ID so replaced clients can identify themselves
    const connectionId = crypto.randomUUID();
    ws._tallyConnectionId = connectionId;

    ensureSockets(church);

    // ── Rapid-reconnection loop detection ───────────────────────────────
    if (!church._instanceConnectTimes) church._instanceConnectTimes = {};
    const now = Date.now();
    const times = church._instanceConnectTimes[instance] || [];
    // Keep only timestamps within the last 30 seconds
    const recent = times.filter(t => now - t < 30_000);
    recent.push(now);
    church._instanceConnectTimes[instance] = recent;
    if (recent.length > 3) {
      console.warn(`[WS] ⚠️  Reconnection loop detected: church ${church.churchId} instance="${instance}" connected ${recent.length} times in 30s. Two machines may share the same instance name.`);
    }

    // ── Room limit enforcement ───────────────────────────────────────────
    // checkPaidAccess returns maxRooms (from TIER_LIMITS). Connect = 1 room.
    const maxRooms = access.maxRooms ?? Infinity;
    const existingWs = church.sockets.get(instance);
    const isReplacement = existingWs?.readyState === wsOpen;

    if (!isReplacement) {
      // Count currently open sockets (different instances)
      let openCount = 0;
      for (const sock of church.sockets.values()) {
        if (sock.readyState === wsOpen) openCount++;
      }
      if (openCount >= maxRooms) {
        console.log(`[WS] Church ${church.churchId} instance="${instance}" rejected: ${openCount}/${maxRooms} rooms in use (tier: ${access.tier || 'connect'})`);
        return ws.close(1008, `room_limit:${maxRooms}`);
      }
    }

    // Only replace the socket for the SAME instance name.
    // Different instances coexist — this is the key multi-room fix.
    if (isReplacement) {
      const oldRemote = existingWs._socket?.remoteAddress + ':' + existingWs._socket?.remotePort;
      const newRemote = ws._socket?.remoteAddress + ':' + ws._socket?.remotePort;
      const oldConnectionId = existingWs._tallyConnectionId || 'unknown';
      console.log(`[WS] Replacing church ${church.churchId} instance="${instance}": old=${oldRemote}(${oldConnectionId}) new=${newRemote}(${connectionId})`);
      existingWs.close(1000, `replaced by new connection|${oldConnectionId}`);
    }

    // Track in instance map and keep backward-compat church.ws
    church.sockets.set(instance, ws);
    church.ws = ws;
    church.lastSeen = new Date().toISOString();
    church.disconnectedAt = null;

    // Immediately restore room mapping so the portal never loses track of which
    // room this instance belongs to (no gap between connect and first status_update).
    // Validate the room_id actually exists for this church (I1).
    if (roomIdFromConnect) {
      if (validateRoomId(roomIdFromConnect, church.churchId)) {
        if (!church.roomInstanceMap) church.roomInstanceMap = {};
        church.roomInstanceMap[roomIdFromConnect] = instance;
      } else {
        console.log(`[WS] Church ${church.churchId} instance="${instance}" connected with invalid room_id="${roomIdFromConnect}" — ignoring room mapping`);
      }
    }

    console.log(`[WS] Church ${church.churchId} instance="${instance}" connected (${church.sockets.size} instance(s) total${roomIdFromConnect ? `, room=${roomIdFromConnect}` : ''})`);

    // Acknowledge the connection to the church client
    safeSend(ws, { type: 'connected', churchId: church.churchId, name: church.name, instance, connectionId });

    // Deliver queued messages from while the church was offline
    drainQueue(church.churchId, ws);

    // Fire the post-connect hook (onboarding tracking, branding, portal broadcast)
    onChurchConnected(church, ws);

    // WebSocket-level ping every wsPingIntervalMs to keep alive through reverse proxies
    const wsPingInterval = wsPingIntervalMs > 0
      ? setInterval(() => { if (ws.readyState === wsOpen) ws.ping(); }, wsPingIntervalMs)
      : null;

    // Notify controllers and SSE dashboard
    const connectedEvent = {
      type:      'church_connected',
      churchId:  church.churchId,
      name:      church.name,
      instance,
      roomId:    roomIdFromConnect || null,
      timestamp: church.lastSeen,
      connected: true,
      status:    church.status,
      roomInstanceMap: church.roomInstanceMap || {},
    };
    broadcastToControllers(connectedEvent);
    broadcastToSSE(connectedEvent);

    // ── Message handler ────────────────────────────────────────────────────
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleChurchMessage(church, msg, ws);
      } catch {
        // Malformed JSON — drop silently (ws library already rate-limits payload size)
      }
    });

    // ── Disconnect handler ─────────────────────────────────────────────────
    ws.on('close', () => {
      if (wsPingInterval) clearInterval(wsPingInterval);

      // Remove this instance from the sockets map
      ensureSockets(church);
      if (church.sockets.get(instance) === ws) {
        church.sockets.delete(instance);
      }

      // Find the roomId(s) this instance was serving before cleanup
      const disconnectedRoomIds = [];
      if (church.roomInstanceMap) {
        for (const [rid, inst] of Object.entries(church.roomInstanceMap)) {
          if (inst === instance) {
            disconnectedRoomIds.push(rid);
            delete church.roomInstanceMap[rid];
          }
        }
      }
      if (church.instanceStatus) {
        delete church.instanceStatus[instance];
      }

      console.log(`[WS] Church ${church.churchId} instance="${instance}" disconnected (${church.sockets.size} instance(s) remaining)`);

      // I6: Broadcast per-room disconnect when a single instance drops
      // (even if other instances are still connected)
      if (disconnectedRoomIds.length > 0) {
        const instanceDisconnectEvent = {
          type: 'instance_disconnected',
          churchId: church.churchId,
          name: church.name,
          instance,
          roomIds: disconnectedRoomIds,
          remainingInstances: church.sockets.size,
          timestamp: new Date().toISOString(),
        };
        broadcastToControllers(instanceDisconnectEvent);
        broadcastToSSE(instanceDisconnectEvent);
        broadcastToPortal(church.churchId, {
          type: 'instance_disconnected',
          instance,
          roomIds: disconnectedRoomIds,
          instanceStatus: church.instanceStatus,
          roomInstanceMap: church.roomInstanceMap,
        });
      }

      // Update church.ws to another open socket (or null)
      if (church.ws === ws) {
        church.ws = null;
        for (const sock of church.sockets.values()) {
          if (sock.readyState === wsOpen) { church.ws = sock; break; }
        }
      }

      // Rebuild church.status from remaining instances (same primary-instance logic)
      const remainingKeys = Object.keys(church.instanceStatus || {});
      if (remainingKeys.length === 1) {
        church.status = { ...church.instanceStatus[remainingKeys[0]] };
      } else if (remainingKeys.length > 1) {
        const primaryKey = remainingKeys.sort()[0];
        church.status = { ...church.instanceStatus[primaryKey] };
      }
      // If remainingKeys.length === 0, we'll handle in the full-disconnect block below

      // Only broadcast church_disconnected if ALL instances are gone
      if (!hasOpenSocket(church)) {
        church.lastSeen = new Date().toISOString();
        church.disconnectedAt = Date.now();
        // M4: Preserve last-known device status instead of wiping to null.
        // Mark as disconnected but keep device data so the portal can show
        // "last known state" after the booth computer goes offline.
        church.status = { ...church.status, connected: false, _disconnectedAt: church.disconnectedAt };
        // Keep instanceStatus/roomInstanceMap empty since all instances are gone
        church.instanceStatus = {};
        church.roomInstanceMap = {};

        const disconnectEvent = {
          type:      'church_disconnected',
          churchId:  church.churchId,
          name:      church.name,
          connected: false,
          status:    church.status,
        };
        broadcastToControllers(disconnectEvent);
        broadcastToSSE(disconnectEvent);
        broadcastToPortal(church.churchId, { type: 'disconnected', status: church.status });
        onChurchDisconnected(church);
      }
    });

    ws.on('error', () => {}); // errors surface as 'close' — no separate handling needed
  }

  // ─── handleChurchMessage ──────────────────────────────────────────────────
  /**
   * Route a message that arrived on a church WebSocket.
   * @param {object} church — the church runtime object from the churches Map
   * @param {object} msg    — parsed JSON from the church client
   */
  function handleChurchMessage(church, msg, senderWs) {
    church.lastSeen = new Date().toISOString();

    switch (msg.type) {

      case 'status_update': {
        church.lastHeartbeat = Date.now();
        if (!church.instanceStatus) church.instanceStatus = {};
        if (!church.roomInstanceMap) church.roomInstanceMap = {};

        // Store status per-instance so multi-room churches don't clobber each other
        let senderInstance = null;
        for (const [inst, sock] of church.sockets.entries()) {
          if (sock === senderWs) {
            senderInstance = inst;
            church.instanceStatus[inst] = { ...msg.status, _updatedAt: Date.now() };
            // Build roomId → instance mapping from the system.roomId the Electron app reports
            // Validate the room actually belongs to this church (I1)
            const roomId = msg.status?.system?.roomId;
            if (roomId && validateRoomId(roomId, church.churchId)) {
              church.roomInstanceMap[roomId] = inst;
            }
            break;
          }
        }

        // Rebuild church.status from the "primary" instance for backward compat
        // with single-room churches and legacy controller consumers.
        // Primary = first connected instance (alphabetically by key) so the
        // value is stable and doesn't flip-flop as different rooms send updates.
        const instanceKeys = Object.keys(church.instanceStatus);
        if (instanceKeys.length === 1) {
          // Single-room: identical to old behaviour
          church.status = { ...church.instanceStatus[instanceKeys[0]] };
        } else if (instanceKeys.length > 1) {
          // Multi-room: use the first instance alphabetically as primary
          const primaryKey = instanceKeys.sort()[0];
          church.status = { ...church.instanceStatus[primaryKey] };
        } else {
          church.status = { ...msg.status };
        }

        church._offlineAlertSent = false;

        const statusEvent = {
          type:          'status_update',
          churchId:      church.churchId,
          name:          church.name,
          status:        church.status,
          instance:      senderInstance,
          instanceStatus: church.instanceStatus,
          roomInstanceMap: church.roomInstanceMap,
          timestamp:     church.lastSeen,
          lastHeartbeat: church.lastHeartbeat,
        };
        broadcastToControllers(statusEvent);
        broadcastToSSE(statusEvent);
        broadcastToPortal(church.churchId, {
          type: 'status_update',
          status: church.status,
          instance: senderInstance,
          instanceStatus: church.instanceStatus,
          roomInstanceMap: church.roomInstanceMap,
          lastSeen: church.lastSeen,
        });
        onStatusUpdate(church, msg, statusEvent);
        break;
      }

      case 'alert': {
        // Resolve sender instance so alert handlers can scope per-room
        let alertInstance = null;
        let alertRoomId = null;
        if (church.sockets?.size) {
          for (const [inst, sock] of church.sockets.entries()) {
            if (sock === senderWs) { alertInstance = inst; break; }
          }
        }
        if (alertInstance && church.roomInstanceMap) {
          for (const [rid, inst] of Object.entries(church.roomInstanceMap)) {
            if (inst === alertInstance) { alertRoomId = rid; break; }
          }
        }
        const alertEvent = {
          type:      'alert',
          churchId:  church.churchId,
          name:      church.name,
          severity:  msg.severity || 'warning',
          message:   msg.message,
          instance:  alertInstance,
          roomId:    alertRoomId,
          timestamp: church.lastSeen,
        };
        broadcastToControllers(alertEvent);
        broadcastToSSE(alertEvent);
        onAlert(church, msg, alertEvent);
        break;
      }

      case 'stream_verification_request': {
        // Church agent requests CDN verification — check immediately (church-client
        // already applies its own 30s initial delay before the first request)
        if (streamOAuth) {
          (async () => {
            try {
              const verification = await streamOAuth.verifyStreamOnPlatforms(church.churchId);
              if (!verification || (!verification.youtube && !verification.facebook)) return;

              // Store in church status for SSE clients
              church.status = { ...church.status, streamVerification: verification };

              // Push result back to the church agent (for stream protection CDN validation)
              safeSend(senderWs || church.ws, JSON.stringify({ type: 'stream_verification_result', verification }));

              // Broadcast to controllers + portal
              broadcastToControllers({ type: 'stream_verification', churchId: church.churchId, verification });
              broadcastToPortal(church.churchId, { type: 'stream_verification', verification });

              // Send alert only on first check or status changes (not every 20s poll)
              const prevVerification = church._lastStreamVerification;
              const allLive = (!verification.youtube?.checked || verification.youtube.live) &&
                              (!verification.facebook?.checked || verification.facebook.live);
              const prevAllLive = prevVerification &&
                (!prevVerification.youtube?.checked || prevVerification.youtube.live) &&
                (!prevVerification.facebook?.checked || prevVerification.facebook.live);

              // Only alert when status changes or on first check
              if (!prevVerification || allLive !== prevAllLive) {
                const parts = [];
                if (verification.youtube?.checked) {
                  parts.push(verification.youtube.live
                    ? `YouTube: LIVE${verification.youtube.viewerCount ? ` (${verification.youtube.viewerCount} viewers)` : ''}`
                    : 'YouTube: NOT receiving stream');
                }
                if (verification.facebook?.checked) {
                  parts.push(verification.facebook.live
                    ? `Facebook: LIVE${verification.facebook.viewerCount ? ` (${verification.facebook.viewerCount} viewers)` : ''}`
                    : 'Facebook: NOT receiving stream');
                }
                if (parts.length > 0) {
                  const alertMsg = `CDN Check: ${parts.join(' · ')}`;
                  const alertEvent = {
                    type: 'alert', churchId: church.churchId, name: church.name,
                    severity: allLive ? 'info' : 'critical',
                    message: alertMsg, timestamp: new Date().toISOString(),
                  };
                  broadcastToControllers(alertEvent);
                  broadcastToSSE(alertEvent);
                  onAlert(church, { message: alertMsg, severity: allLive ? 'info' : 'critical' }, alertEvent);
                }
              }
              church._lastStreamVerification = verification;
            } catch (e) {
              console.warn(`[StreamVerify] Error checking platforms for ${church.churchId}:`, e.message);
            }
          })();
        }
        break;
      }

      case 'command_result': {
        const cmdResultMsg = {
          type:      'command_result',
          churchId:  church.churchId,
          name:      church.name,
          messageId: msg.id,
          result:    msg.result,
          error:     msg.error,
        };
        broadcastToControllers(cmdResultMsg);
        onCommandResult(church, cmdResultMsg);
        break;
      }

      case 'ping':
        safeSend(senderWs || church.ws, { type: 'pong', ts: msg.ts });
        break;

      case 'stream_protection_status': {
        // Broadcast stream protection status to all controllers and portal clients
        const spEvent = {
          type: 'stream_protection_status',
          churchId: church.churchId,
          name: church.name,
          streamProtection: msg.streamProtection,
          timestamp: church.lastSeen,
        };
        broadcastToControllers(spEvent);
        broadcastToPortal(church.churchId, {
          type: 'stream_protection_status',
          streamProtection: msg.streamProtection,
        });
        break;
      }

      // The following types are handled entirely by hooks — the routing layer
      // does not broadcast them directly (they're heavy subsystem concerns).
      case 'signal_event':
      case 'viewer_snapshot':
      case 'propresenter_slide_change':
      case 'chat':
      case 'preview_frame':
      case 'smart_plug_result': {
        // Resolve sender instance so subsystems can scope per-room
        let msgInstance = null;
        let msgRoomId = null;
        if (church.sockets?.size) {
          for (const [inst, sock] of church.sockets.entries()) {
            if (sock === senderWs) { msgInstance = inst; break; }
          }
        }
        if (msgInstance && church.roomInstanceMap) {
          for (const [rid, inst] of Object.entries(church.roomInstanceMap)) {
            if (inst === msgInstance) { msgRoomId = rid; break; }
          }
        }
        onChurchMessage(church, { ...msg, _instance: msgInstance, _roomId: msgRoomId });
        break;
      }

      default:
        // Forward unknown types to all controllers, tagged with church identity
        broadcastToControllers({ ...msg, churchId: church.churchId, churchName: church.name });
        onChurchMessage(church, msg);
    }
  }

  // ─── handleControllerConnection ───────────────────────────────────────────
  /**
   * Called when a WebSocket at /controller connects.
   * @param {WebSocket} ws
   * @param {URL}       url — contains ?apikey=
   * @param {object}    req — http.IncomingMessage
   */
  function handleControllerConnection(ws, url, req) {
    const apiKey = url.searchParams.get('apikey') || req.headers['x-api-key'];
    if (!safeCompareKey(apiKey, adminApiKey)) return ws.close(1008, 'invalid api key');

    const clientIp = req.socket?.remoteAddress || 'unknown';
    const currentCount = wsConnectionsByIp.get(clientIp) || 0;
    if (currentCount >= maxConnectionsPerIp) {
      ws.close(1008, 'Too many connections from this IP');
      return;
    }
    if (controllers.size >= maxControllers) {
      ws.close(1008, 'Maximum controller connections reached');
      return;
    }
    wsConnectionsByIp.set(clientIp, currentCount + 1);

    controllers.add(ws);

    // Send the current church list so the controller can populate its UI
    const churchList = Array.from(churches.values()).map(c => ({
      churchId:  c.churchId,
      name:      c.name,
      connected: hasOpenSocket(c),
      status:    c.status,
      instances: c.sockets ? Array.from(c.sockets.keys()).filter(k => c.sockets.get(k)?.readyState === wsOpen) : [],
    }));
    safeSend(ws, { type: 'church_list', churches: churchList });

    onControllerConnected(ws);

    // WebSocket-level ping every wsPingIntervalMs to keep alive through reverse proxies
    const wsPingInterval = wsPingIntervalMs > 0
      ? setInterval(() => { if (ws.readyState === wsOpen) ws.ping(); }, wsPingIntervalMs)
      : null;

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        await handleControllerMessage(ws, msg);
      } catch {
        // Malformed JSON — drop silently
      }
    });

    ws.on('close', () => {
      if (wsPingInterval) clearInterval(wsPingInterval);
      controllers.delete(ws);
      const prev = wsConnectionsByIp.get(clientIp) || 1;
      const next = Math.max(0, prev - 1);
      if (next === 0) {
        wsConnectionsByIp.delete(clientIp);
      } else {
        wsConnectionsByIp.set(clientIp, next);
      }
      onControllerDisconnected(ws);
    });

    ws.on('error', () => {});
  }

  // ─── handleControllerMessage ──────────────────────────────────────────────
  /**
   * Route a message that arrived on a controller WebSocket.
   * @param {WebSocket} ws
   * @param {object}    msg
   */
  async function handleControllerMessage(ws, msg) {
    if (msg.type === 'command' && msg.churchId) {
      const rateLimit = await checkCommandRateLimit(msg.churchId);
      if (!rateLimit.ok) {
        safeSend(ws, { type: 'error', error: 'Rate limit exceeded', churchId: msg.churchId });
        return;
      }
      const church = churches.get(msg.churchId);
      if (!church) {
        safeSend(ws, { type: 'error', error: 'Church not connected', churchId: msg.churchId });
      } else if (msg.instance && church.sockets?.get(msg.instance)?.readyState === wsOpen) {
        // Target a specific instance if requested
        safeSend(church.sockets.get(msg.instance), msg);
      } else if (hasOpenSocket(church)) {
        // Broadcast to ALL connected instances — each agent handles only its own devices
        sendToAllInstances(church, msg);
      } else {
        safeSend(ws, { type: 'error', error: 'Church not connected', churchId: msg.churchId });
      }
    }
    onControllerMessage(ws, msg);
  }

  return {
    safeSend,
    broadcastToControllers,
    sendToAllInstances,
    hasOpenSocket,
    handleChurchConnection,
    handleControllerConnection,
    handleChurchMessage,
    handleControllerMessage,
  };
}

module.exports = { createWebSocketHandlers };
