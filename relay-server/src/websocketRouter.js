'use strict';

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

  // ─── WebSocket-level ping intervals (keepalive through reverse proxies) ───
  // Interval in ms between WS-level pings. Set to 0 to disable.
  wsPingIntervalMs = 25_000,

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

  // ─── handleChurchConnection ───────────────────────────────────────────────
  /**
   * Called when a WebSocket at /church connects.
   * @param {WebSocket} ws
   * @param {URL}       url  — already parsed, contains ?token=
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

    // Replace any existing WebSocket for this church
    if (church.ws?.readyState === wsOpen) {
      const oldRemote = church.ws._socket?.remoteAddress + ':' + church.ws._socket?.remotePort;
      const newRemote = ws._socket?.remoteAddress + ':' + ws._socket?.remotePort;
      console.log(`[WS] Replacing church ${church.churchId} connection: old=${oldRemote} new=${newRemote}`);
      church.ws.close(1000, 'replaced by new connection');
    }

    church.ws = ws;
    church.lastSeen = new Date().toISOString();
    church.disconnectedAt = null;

    // Acknowledge the connection to the church client
    safeSend(ws, { type: 'connected', churchId: church.churchId, name: church.name });

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
      timestamp: church.lastSeen,
      connected: true,
      status:    church.status,
    };
    broadcastToControllers(connectedEvent);
    broadcastToSSE(connectedEvent);

    // ── Message handler ────────────────────────────────────────────────────
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleChurchMessage(church, msg);
      } catch {
        // Malformed JSON — drop silently (ws library already rate-limits payload size)
      }
    });

    // ── Disconnect handler ─────────────────────────────────────────────────
    ws.on('close', () => {
      if (wsPingInterval) clearInterval(wsPingInterval);
      // Guard: if this socket was already replaced by a newer connection, skip state
      // reset. Without this, the stale close fires after replacement and incorrectly
      // broadcasts church_disconnected even though the church is still connected.
      if (church.ws !== ws) return;
      church.lastSeen = new Date().toISOString();
      church.disconnectedAt = Date.now();
      // Reset device status so the dashboard doesn't show stale connected states
      church.status = { connected: false, atem: null, obs: null };

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
    });

    ws.on('error', () => {}); // errors surface as 'close' — no separate handling needed
  }

  // ─── handleChurchMessage ──────────────────────────────────────────────────
  /**
   * Route a message that arrived on a church WebSocket.
   * @param {object} church — the church runtime object from the churches Map
   * @param {object} msg    — parsed JSON from the church client
   */
  function handleChurchMessage(church, msg) {
    church.lastSeen = new Date().toISOString();

    switch (msg.type) {

      case 'status_update': {
        church.status = { ...church.status, ...msg.status };
        church.lastHeartbeat = Date.now();
        church._offlineAlertSent = false;

        const statusEvent = {
          type:          'status_update',
          churchId:      church.churchId,
          name:          church.name,
          status:        church.status,
          timestamp:     church.lastSeen,
          lastHeartbeat: church.lastHeartbeat,
        };
        broadcastToControllers(statusEvent);
        broadcastToSSE(statusEvent);
        broadcastToPortal(church.churchId, { type: 'status_update', status: church.status, lastSeen: church.lastSeen });
        onStatusUpdate(church, msg, statusEvent);
        break;
      }

      case 'alert': {
        const alertEvent = {
          type:      'alert',
          churchId:  church.churchId,
          name:      church.name,
          severity:  msg.severity || 'warning',
          message:   msg.message,
          timestamp: church.lastSeen,
        };
        broadcastToControllers(alertEvent);
        broadcastToSSE(alertEvent);
        onAlert(church, msg, alertEvent);
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
        safeSend(church.ws, { type: 'pong', ts: msg.ts });
        break;

      // The following types are handled entirely by hooks — the routing layer
      // does not broadcast them directly (they're heavy subsystem concerns).
      case 'signal_event':
      case 'viewer_snapshot':
      case 'propresenter_slide_change':
      case 'chat':
      case 'preview_frame':
        onChurchMessage(church, msg);
        break;

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
      connected: c.ws?.readyState === wsOpen,
      status:    c.status,
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
      if (church?.ws?.readyState === wsOpen) {
        safeSend(church.ws, msg);
      } else {
        safeSend(ws, { type: 'error', error: 'Church not connected', churchId: msg.churchId });
      }
    }
    onControllerMessage(ws, msg);
  }

  return {
    safeSend,
    broadcastToControllers,
    handleChurchConnection,
    handleControllerConnection,
    handleChurchMessage,
    handleControllerMessage,
  };
}

module.exports = { createWebSocketHandlers };
