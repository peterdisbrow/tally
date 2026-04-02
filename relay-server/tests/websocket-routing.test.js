/**
 * Integration tests for relay WebSocket routing.
 *
 * These tests import the REAL createWebSocketHandlers factory from
 * src/websocketRouter.js and spin up an actual http.Server + WebSocketServer,
 * then connect real WebSocket clients to exercise the real routing code.
 *
 * If server.js diverges from the factory, these tests WILL catch it — because
 * they test the same code path that runs in production.
 *
 * Pattern: church-portal.test.js (build a minimal real server, test it via
 *           the actual protocol — no mocked re-implementations of routing).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import http from 'http';

const require = createRequire(import.meta.url);
const { WebSocketServer, WebSocket } = require('ws');
const jwt = require('jsonwebtoken');
const { createWebSocketHandlers } = require('../src/websocketRouter');

const JWT_SECRET    = 'test-ws-routing-secret';
const ADMIN_API_KEY = 'test-admin-key-12345';

// ─── Test church factory ───────────────────────────────────────────────────────

function makeChurchEntry(id, name, overrides = {}) {
  return {
    churchId:         id,
    name,
    ws:               null,
    sockets:          new Map(),
    status:           {},
    lastSeen:         null,
    lastHeartbeat:    null,
    disconnectedAt:   null,
    _offlineAlertSent: false,
    ...overrides,
  };
}

function signToken(churchId, opts = {}) {
  return jwt.sign({ churchId }, JWT_SECRET, { expiresIn: opts.expiresIn || '1h' });
}

// ─── Minimal test server ───────────────────────────────────────────────────────
//
// Builds an http.Server + WebSocketServer wired to the real routing factory.
// Returns { url, churches, controllers, handlers, close }.

function buildTestServer(overrides = {}) {
  const churches    = new Map();
  const controllers = new Set();

  const handlers = createWebSocketHandlers({
    churches,
    controllers,
    jwt,
    jwtSecret: JWT_SECRET,
    wsOpen: WebSocket.OPEN,
    adminApiKey: ADMIN_API_KEY,
    wsPingIntervalMs: 0,  // disable 25s pings so tests finish quickly
    ...overrides,
  });

  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws, req) => {
    const url  = new URL(req.url, 'http://localhost');
    const role = url.pathname.replace(/^\//, '');

    if (role === 'church') {
      handlers.handleChurchConnection(ws, url, req.socket.remoteAddress || '127.0.0.1');
    } else if (role === 'controller') {
      handlers.handleControllerConnection(ws, url, req);
    } else {
      ws.close(1008, 'Unknown role');
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.removeListener('error', reject);
      const { port } = httpServer.address();
      const url = `ws://127.0.0.1:${port}`;

      resolve({
        url,
        churches,
        controllers,
        handlers,
        close: () => new Promise((res) => {
          for (const ws of wss.clients) ws.terminate();
          wss.close(() => httpServer.close(res));
        }),
      });
    });
  });
}

// ─── WebSocket client helpers ─────────────────────────────────────────────────

/**
 * Open a WebSocket and wait for it to be connected (readyState === OPEN).
 * Rejects on close-before-open (gives you the close code/reason).
 *
 * Attaches a single internal 'message' router on the socket so that messages
 * arriving before nextMessage() registers a listener (a common race on
 * localhost where the server sends synchronously on 'connection') are queued
 * and delivered in order.  nextMessage / nextMessages drain this queue.
 */
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    // Queue: pending buffers for messages not yet consumed; waiters for callers
    // already waiting.  The router delivers to a waiter immediately if one
    // exists, otherwise buffers so the message is not lost.
    const q = { pending: [], waiters: [] };
    ws._q = q;
    ws.on('message', (data) => {
      if (q.waiters.length > 0) {
        q.waiters.shift()(data);
      } else {
        q.pending.push(data);
      }
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('close', (code, reason) => {
      reject(new Error(`WS closed before open — code ${code} reason "${reason}"`));
    });
  });
}

/**
 * Open a WebSocket and collect the first close event (for auth-rejection tests).
 * Resolves with { code, reason } when the server closes the connection.
 */
function connectAndGetClose(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('close', (code, buf) => {
      resolve({ code, reason: buf ? buf.toString() : '' });
    });
    ws.once('error', reject);
  });
}

/**
 * Wait for the next message on an open WebSocket.
 * Drains the internal queue populated by connect() before waiting for a live
 * event, so messages sent synchronously on connection are never missed.
 * Rejects after `timeoutMs` if no message arrives.
 */
function nextMessage(ws, timeoutMs = 2000) {
  const q = ws._q;
  if (q?.pending.length > 0) {
    return Promise.resolve(JSON.parse(q.pending.shift().toString()));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (q) {
        const i = q.waiters.indexOf(waiter);
        if (i !== -1) q.waiters.splice(i, 1);
      }
      reject(new Error('nextMessage timeout'));
    }, timeoutMs);
    function waiter(data) {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    }
    if (q) {
      q.waiters.push(waiter);
    } else {
      ws.once('message', waiter);
    }
  });
}

/**
 * Collect the next N messages on an open WebSocket.
 * Drains the internal queue before waiting for live events.
 */
function nextMessages(ws, n, timeoutMs = 2000) {
  const q = ws._q;
  const msgs = q ? q.pending.splice(0).map(d => JSON.parse(d.toString())) : [];
  if (msgs.length >= n) return Promise.resolve(msgs.slice(0, n));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`nextMessages(${n}) timeout — got ${msgs.length}`)), timeoutMs);
    function waiter(data) {
      msgs.push(JSON.parse(data.toString()));
      if (msgs.length >= n) {
        clearTimeout(timer);
        resolve(msgs);
      } else if (q) {
        q.waiters.push(waiter);
      }
    }
    if (q) {
      q.waiters.push(waiter);
    } else {
      ws.on('message', (data) => {
        msgs.push(JSON.parse(data.toString()));
        if (msgs.length >= n) { clearTimeout(timer); resolve(msgs); }
      });
    }
  });
}

/** Send a JSON message over a WebSocket. */
function send(ws, obj) {
  ws.send(JSON.stringify(obj));
}

/** Close a WebSocket and wait for it to finish. */
function closeWs(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once('close', resolve);
    ws.close();
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WebSocket routing — real integration tests against createWebSocketHandlers', () => {
  let server;

  beforeEach(async () => {
    server = await buildTestServer();
    // Pre-register two churches
    server.churches.set('church-1', makeChurchEntry('church-1', 'First Baptist'));
    server.churches.set('church-2', makeChurchEntry('church-2', 'Grace Chapel'));
  });

  afterEach(async () => {
    await server.close();
  });

  // ── 1. Connection auth ─────────────────────────────────────────────────────

  describe('Connection authentication', () => {
    it('accepts a valid token and sends a connected message', async () => {
      const token = signToken('church-1');
      const ws = await connect(`${server.url}/church?token=${token}`);

      const msg = await nextMessage(ws);
      expect(msg.type).toBe('connected');
      expect(msg.churchId).toBe('church-1');
      expect(msg.name).toBe('First Baptist');

      await closeWs(ws);
    });

    it('rejects connection with no token — code 1008', async () => {
      const { code, reason } = await connectAndGetClose(`${server.url}/church`);
      expect(code).toBe(1008);
      expect(reason).toBe('token required');
    });

    it('rejects connection with an invalid (non-JWT) token', async () => {
      const { code, reason } = await connectAndGetClose(`${server.url}/church?token=not.a.real.token`);
      expect(code).toBe(1008);
      expect(reason).toBe('invalid token');
    });

    it('rejects connection with an expired token', async () => {
      const token = jwt.sign({ churchId: 'church-1' }, JWT_SECRET, { expiresIn: -1 });
      const { code, reason } = await connectAndGetClose(`${server.url}/church?token=${token}`);
      expect(code).toBe(1008);
      expect(reason).toBe('invalid token');
    });

    it('rejects connection for an unregistered churchId', async () => {
      const token = signToken('does-not-exist');
      const { code, reason } = await connectAndGetClose(`${server.url}/church?token=${token}`);
      expect(code).toBe(1008);
      expect(reason).toBe('church not registered');
    });

    it('rejects connection when billing access is denied', async () => {
      const server2 = await buildTestServer({
        checkPaidAccess: () => ({ allowed: false, status: 'expired' }),
      });
      server2.churches.set('church-1', makeChurchEntry('church-1', 'First Baptist'));

      const token = signToken('church-1');
      const { code, reason } = await connectAndGetClose(`${server2.url}/church?token=${token}`);
      await server2.close();

      expect(code).toBe(1008);
      expect(reason).toBe('billing_expired');
    });

    it('rejects unknown WebSocket role', async () => {
      const { code } = await connectAndGetClose(`${server.url}/unknown-role`);
      expect(code).toBe(1008);
    });
  });

  // ── 2. Church registration on connect ─────────────────────────────────────

  describe('Church registration via WebSocket', () => {
    it('sets church.ws and clears disconnectedAt on successful connection', async () => {
      const church = server.churches.get('church-1');
      church.disconnectedAt = Date.now() - 60_000;

      const token = signToken('church-1');
      const ws = await connect(`${server.url}/church?token=${token}`);
      await nextMessage(ws);  // consume 'connected'

      expect(church.ws).toBeTruthy();
      expect(church.ws.readyState).toBe(WebSocket.OPEN);
      expect(church.disconnectedAt).toBeNull();
      expect(church.lastSeen).toBeTruthy();

      await closeWs(ws);
    });

    it('updates church.status and disconnectedAt on disconnect', async () => {
      const token = signToken('church-1');
      const ws = await connect(`${server.url}/church?token=${token}`);
      await nextMessage(ws); // consume 'connected'

      const church = server.churches.get('church-1');
      expect(church.ws?.readyState).toBe(WebSocket.OPEN);

      // Close from client side and let server handler run
      const disconnectSeen = new Promise((res) => {
        const orig = ws.onclose;
        ws.once('close', res);
      });
      ws.close();
      await disconnectSeen;

      // Give the server's 'close' handler a tick to run
      await new Promise(r => setTimeout(r, 50));

      expect(church.disconnectedAt).toBeTruthy();
      expect(church.status.connected).toBe(false);
    });
  });

  // ── 3. Controller connection ───────────────────────────────────────────────

  describe('Controller connection', () => {
    it('accepts a valid admin API key and sends church_list', async () => {
      const ws = await connect(`${server.url}/controller?apikey=${ADMIN_API_KEY}`);
      const msg = await nextMessage(ws);

      expect(msg.type).toBe('church_list');
      expect(Array.isArray(msg.churches)).toBe(true);
      expect(msg.churches.some(c => c.churchId === 'church-1')).toBe(true);
      expect(msg.churches.some(c => c.churchId === 'church-2')).toBe(true);

      await closeWs(ws);
    });

    it('rejects connection with wrong api key', async () => {
      const { code, reason } = await connectAndGetClose(`${server.url}/controller?apikey=wrong-key`);
      expect(code).toBe(1008);
      expect(reason).toBe('invalid api key');
    });

    it('adds controller to the controllers Set on connect and removes on disconnect', async () => {
      expect(server.controllers.size).toBe(0);

      const ws = await connect(`${server.url}/controller?apikey=${ADMIN_API_KEY}`);
      await nextMessage(ws); // consume church_list

      expect(server.controllers.size).toBe(1);

      await closeWs(ws);
      await new Promise(r => setTimeout(r, 30));

      expect(server.controllers.size).toBe(0);
    });
  });

  // ── 4. Message routing: church → controllers ──────────────────────────────

  describe('Message routing: church → controllers', () => {
    it('forwards status_update to all connected controllers with churchId', async () => {
      // Connect two controllers
      const ctrl1 = await connect(`${server.url}/controller?apikey=${ADMIN_API_KEY}`);
      const ctrl2 = await connect(`${server.url}/controller?apikey=${ADMIN_API_KEY}`);
      await nextMessage(ctrl1); // consume church_list
      await nextMessage(ctrl2);

      // Connect church
      const token = signToken('church-1');
      const churchWs = await connect(`${server.url}/church?token=${token}`);
      // Consume the 'connected' ack AND the 'church_connected' broadcast to controllers
      await nextMessage(churchWs);
      await nextMessage(ctrl1); // church_connected broadcast
      await nextMessage(ctrl2);

      // Now send status update
      const msg1Promise = nextMessage(ctrl1);
      const msg2Promise = nextMessage(ctrl2);

      send(churchWs, { type: 'status_update', status: { atem: { connected: true, programInput: 2 } } });

      const [m1, m2] = await Promise.all([msg1Promise, msg2Promise]);

      expect(m1.type).toBe('status_update');
      expect(m1.churchId).toBe('church-1');
      expect(m1.name).toBe('First Baptist');
      expect(m1.status.atem.connected).toBe(true);
      expect(m1.status.atem.programInput).toBe(2);

      // Both controllers receive the same payload
      expect(m2.type).toBe('status_update');
      expect(m2.churchId).toBe('church-1');

      await closeWs(churchWs);
      await closeWs(ctrl1);
      await closeWs(ctrl2);
    });

    it('updates church.status in memory on status_update', async () => {
      const ctrl = await connect(`${server.url}/controller?apikey=${ADMIN_API_KEY}`);
      await nextMessage(ctrl); // church_list

      const token = signToken('church-1');
      const churchWs = await connect(`${server.url}/church?token=${token}`);
      await nextMessage(churchWs);   // connected
      await nextMessage(ctrl);        // church_connected

      send(churchWs, { type: 'status_update', status: { obs: { connected: true, streaming: false } } });
      await nextMessage(ctrl); // wait for the broadcast

      const church = server.churches.get('church-1');
      expect(church.status.obs?.connected).toBe(true);
      expect(church.lastHeartbeat).toBeTruthy();

      await closeWs(churchWs);
      await closeWs(ctrl);
    });

    it('forwards alert to all controllers', async () => {
      const ctrl = await connect(`${server.url}/controller?apikey=${ADMIN_API_KEY}`);
      await nextMessage(ctrl);

      const token = signToken('church-1');
      const churchWs = await connect(`${server.url}/church?token=${token}`);
      await nextMessage(churchWs);
      await nextMessage(ctrl); // church_connected

      send(churchWs, { type: 'alert', severity: 'critical', message: 'Stream dropped' });

      const alert = await nextMessage(ctrl);
      expect(alert.type).toBe('alert');
      expect(alert.churchId).toBe('church-1');
      expect(alert.severity).toBe('critical');
      expect(alert.message).toBe('Stream dropped');

      await closeWs(churchWs);
      await closeWs(ctrl);
    });

    it('defaults alert severity to "warning" when not specified', async () => {
      const ctrl = await connect(`${server.url}/controller?apikey=${ADMIN_API_KEY}`);
      await nextMessage(ctrl);

      const token = signToken('church-1');
      const churchWs = await connect(`${server.url}/church?token=${token}`);
      await nextMessage(churchWs);
      await nextMessage(ctrl);

      send(churchWs, { type: 'alert', message: 'Something happened' });

      const alert = await nextMessage(ctrl);
      expect(alert.severity).toBe('warning');

      await closeWs(churchWs);
      await closeWs(ctrl);
    });

    it('forwards command_result to controllers with normalized shape', async () => {
      const ctrl = await connect(`${server.url}/controller?apikey=${ADMIN_API_KEY}`);
      await nextMessage(ctrl);

      const token = signToken('church-1');
      const churchWs = await connect(`${server.url}/church?token=${token}`);
      await nextMessage(churchWs);
      await nextMessage(ctrl);

      send(churchWs, { type: 'command_result', id: 'cmd-abc', result: { success: true }, error: null });

      const result = await nextMessage(ctrl);
      expect(result.type).toBe('command_result');
      expect(result.churchId).toBe('church-1');
      expect(result.messageId).toBe('cmd-abc');
      expect(result.result.success).toBe(true);
      expect(result.error).toBeNull();

      await closeWs(churchWs);
      await closeWs(ctrl);
    });

    it('responds to ping with pong (same ts)', async () => {
      const token = signToken('church-1');
      const churchWs = await connect(`${server.url}/church?token=${token}`);
      await nextMessage(churchWs); // connected

      send(churchWs, { type: 'ping', ts: 99999 });

      const pong = await nextMessage(churchWs);
      expect(pong.type).toBe('pong');
      expect(pong.ts).toBe(99999);

      await closeWs(churchWs);
    });

    it('forwards unknown message types to controllers with churchId tag', async () => {
      const ctrl = await connect(`${server.url}/controller?apikey=${ADMIN_API_KEY}`);
      await nextMessage(ctrl);

      const token = signToken('church-1');
      const churchWs = await connect(`${server.url}/church?token=${token}`);
      await nextMessage(churchWs);
      await nextMessage(ctrl);

      send(churchWs, { type: 'custom_event', payload: { x: 42 } });

      const forwarded = await nextMessage(ctrl);
      expect(forwarded.type).toBe('custom_event');
      expect(forwarded.churchId).toBe('church-1');
      expect(forwarded.churchName).toBe('First Baptist');
      expect(forwarded.payload.x).toBe(42);

      await closeWs(churchWs);
      await closeWs(ctrl);
    });

    it('broadcasts church_connected event to controllers when church connects', async () => {
      const ctrl = await connect(`${server.url}/controller?apikey=${ADMIN_API_KEY}`);
      await nextMessage(ctrl); // church_list

      const token = signToken('church-1');
      const churchWs = await connect(`${server.url}/church?token=${token}`);
      await nextMessage(churchWs); // connected

      const evt = await nextMessage(ctrl);
      expect(evt.type).toBe('church_connected');
      expect(evt.churchId).toBe('church-1');
      expect(evt.connected).toBe(true);

      await closeWs(churchWs);
      await closeWs(ctrl);
    });

    it('broadcasts church_disconnected event to controllers when church disconnects', async () => {
      const ctrl = await connect(`${server.url}/controller?apikey=${ADMIN_API_KEY}`);
      await nextMessage(ctrl);

      const token = signToken('church-1');
      const churchWs = await connect(`${server.url}/church?token=${token}`);
      await nextMessage(churchWs);
      await nextMessage(ctrl); // church_connected

      const disconnectEvt = nextMessage(ctrl);
      churchWs.close();

      const evt = await disconnectEvt;
      expect(evt.type).toBe('church_disconnected');
      expect(evt.churchId).toBe('church-1');
      expect(evt.connected).toBe(false);

      await closeWs(ctrl);
    });

    it('drops malformed JSON from church without crashing', async () => {
      const ctrl = await connect(`${server.url}/controller?apikey=${ADMIN_API_KEY}`);
      await nextMessage(ctrl);

      const token = signToken('church-1');
      const churchWs = await connect(`${server.url}/church?token=${token}`);
      await nextMessage(churchWs);
      await nextMessage(ctrl); // church_connected

      // Send bad JSON — server should swallow it, not crash
      churchWs.send('not valid json {{{');

      // Verify the connection is still alive (send a valid ping)
      send(churchWs, { type: 'ping', ts: 1 });
      const pong = await nextMessage(churchWs);
      expect(pong.type).toBe('pong');

      await closeWs(churchWs);
      await closeWs(ctrl);
    });
  });

  // ── 5. Message routing: controllers → church ──────────────────────────────

  describe('Message routing: controllers → church', () => {
    it('forwards command from controller to the target church', async () => {
      // Connect church first
      const token = signToken('church-1');
      const churchWs = await connect(`${server.url}/church?token=${token}`);
      await nextMessage(churchWs); // connected

      const ctrl = await connect(`${server.url}/controller?apikey=${ADMIN_API_KEY}`);
      await nextMessage(ctrl); // church_list (church-1 already connected — no separate church_connected)

      // Church waits for a command
      const cmdPromise = nextMessage(churchWs);
      send(ctrl, { type: 'command', churchId: 'church-1', command: 'atem.cut', params: { input: 2 } });

      const cmd = await cmdPromise;
      expect(cmd.type).toBe('command');
      expect(cmd.command).toBe('atem.cut');
      expect(cmd.params.input).toBe(2);

      await closeWs(churchWs);
      await closeWs(ctrl);
    });

    it('returns error to controller when target church is not connected', async () => {
      const ctrl = await connect(`${server.url}/controller?apikey=${ADMIN_API_KEY}`);
      await nextMessage(ctrl);

      // church-1 has never connected — .ws is null
      send(ctrl, { type: 'command', churchId: 'church-1', command: 'obs.start', params: {} });

      const err = await nextMessage(ctrl);
      expect(err.type).toBe('error');
      expect(err.error).toBe('Church not connected');
      expect(err.churchId).toBe('church-1');

      await closeWs(ctrl);
    });

    it('returns error for command to a non-existent church', async () => {
      const ctrl = await connect(`${server.url}/controller?apikey=${ADMIN_API_KEY}`);
      await nextMessage(ctrl);

      send(ctrl, { type: 'command', churchId: 'ghost-church', command: 'obs.start', params: {} });

      const err = await nextMessage(ctrl);
      expect(err.type).toBe('error');
      expect(err.error).toBe('Church not connected');

      await closeWs(ctrl);
    });

    it('returns error when rate limit is exceeded', async () => {
      const server2 = await buildTestServer({
        checkCommandRateLimit: async () => ({ ok: false }),
      });
      server2.churches.set('church-1', makeChurchEntry('church-1', 'First Baptist'));

      const churchToken = signToken('church-1');
      const churchWs = await connect(`${server2.url}/church?token=${churchToken}`);
      await nextMessage(churchWs);

      const ctrl = await connect(`${server2.url}/controller?apikey=${ADMIN_API_KEY}`);
      await nextMessage(ctrl); // church_list (church already connected, no separate church_connected)

      send(ctrl, { type: 'command', churchId: 'church-1', command: 'atem.cut', params: {} });

      const err = await nextMessage(ctrl);
      expect(err.type).toBe('error');
      expect(err.error).toBe('Rate limit exceeded');

      await server2.close();
    });
  });

  // ── 6. Reconnection handling ───────────────────────────────────────────────

  describe('Reconnection handling', () => {
    it('replaces the old WebSocket when the church reconnects', async () => {
      const token = signToken('church-1');

      // First connection
      const ws1 = await connect(`${server.url}/church?token=${token}`);
      await nextMessage(ws1); // connected

      const church = server.churches.get('church-1');
      const firstWs = church.ws;
      expect(firstWs.readyState).toBe(WebSocket.OPEN);

      // Second connection — old one should be closed
      const ws1Closed = new Promise((res) => ws1.once('close', (code) => res(code)));
      const ws2 = await connect(`${server.url}/church?token=${token}`);
      await nextMessage(ws2); // connected

      const closeCode = await ws1Closed;
      expect(closeCode).toBe(1000); // 'replaced by new connection'
      expect(church.ws).not.toBe(firstWs);
      expect(church.ws?.readyState).toBe(WebSocket.OPEN);

      await closeWs(ws2);
    });

    it('clears disconnectedAt on reconnect', async () => {
      const church = server.churches.get('church-1');
      church.disconnectedAt = Date.now() - 30_000;

      const token = signToken('church-1');
      const ws = await connect(`${server.url}/church?token=${token}`);
      await nextMessage(ws);

      expect(church.disconnectedAt).toBeNull();

      await closeWs(ws);
    });

    it('does not close old ws if it is already closed', async () => {
      // Pre-assign a closed WebSocket stub for church-1
      const fakeClosedWs = {
        readyState: WebSocket.CLOSED,
        close: () => { throw new Error('Should not be called on an already-closed socket'); },
      };
      server.churches.get('church-1').ws = fakeClosedWs;

      const token = signToken('church-1');
      // Should NOT throw — verifies the readyState guard
      const ws = await connect(`${server.url}/church?token=${token}`);
      await nextMessage(ws);

      expect(server.churches.get('church-1').ws).not.toBe(fakeClosedWs);

      await closeWs(ws);
    });
  });

  // ── 7. Church isolation ────────────────────────────────────────────────────

  describe('Church isolation', () => {
    it('status_update from church-1 does not change church-2 status', async () => {
      const ctrl = await connect(`${server.url}/controller?apikey=${ADMIN_API_KEY}`);
      await nextMessage(ctrl);

      const tok1 = signToken('church-1');
      const tok2 = signToken('church-2');

      const ws1 = await connect(`${server.url}/church?token=${tok1}`);
      const ws2 = await connect(`${server.url}/church?token=${tok2}`);
      await nextMessage(ws1);
      await nextMessage(ws2);
      await nextMessage(ctrl); // church_connected #1
      await nextMessage(ctrl); // church_connected #2

      send(ws1, { type: 'status_update', status: { atem: { connected: true } } });
      await nextMessage(ctrl); // status_update from church-1

      const church2 = server.churches.get('church-2');
      expect(church2.status.atem).toBeUndefined();

      await closeWs(ws1);
      await closeWs(ws2);
      await closeWs(ctrl);
    });

    it('command targets only the specified church', async () => {
      const tok1 = signToken('church-1');
      const tok2 = signToken('church-2');

      const ws1 = await connect(`${server.url}/church?token=${tok1}`);
      const ws2 = await connect(`${server.url}/church?token=${tok2}`);
      await nextMessage(ws1);
      await nextMessage(ws2);

      const ctrl = await connect(`${server.url}/controller?apikey=${ADMIN_API_KEY}`);
      await nextMessage(ctrl); // church_list (both churches already connected — no separate church_connected events)

      // Only ws1 should get the command
      const cmdPromise = nextMessage(ws1);
      send(ctrl, { type: 'command', churchId: 'church-1', command: 'atem.cut', params: {} });

      const cmd = await cmdPromise;
      expect(cmd.type).toBe('command');
      expect(cmd.command).toBe('atem.cut');

      // ws2 should receive nothing — give it a moment to confirm silence
      const silence = await Promise.race([
        nextMessage(ws2),
        new Promise(r => setTimeout(() => r('silence'), 200)),
      ]);
      expect(silence).toBe('silence');

      await closeWs(ws1);
      await closeWs(ws2);
      await closeWs(ctrl);
    });

    it('church_list shows correct connected state per church', async () => {
      // Connect church-1 only
      const tok1 = signToken('church-1');
      const ws1 = await connect(`${server.url}/church?token=${tok1}`);
      await nextMessage(ws1);

      const ctrl = await connect(`${server.url}/controller?apikey=${ADMIN_API_KEY}`);
      const list = await nextMessage(ctrl); // church_list (church-1 already connected; controller joined after, so no separate church_connected)

      const c1 = list.churches.find(c => c.churchId === 'church-1');
      const c2 = list.churches.find(c => c.churchId === 'church-2');
      expect(c1.connected).toBe(true);
      expect(c2.connected).toBe(false);

      await closeWs(ws1);
      await closeWs(ctrl);
    });
  });

  // ── 8. broadcastToControllers ─────────────────────────────────────────────

  describe('broadcastToControllers direct helper', () => {
    it('sends to all connected controllers', async () => {
      const c1 = await connect(`${server.url}/controller?apikey=${ADMIN_API_KEY}`);
      const c2 = await connect(`${server.url}/controller?apikey=${ADMIN_API_KEY}`);
      await nextMessage(c1);
      await nextMessage(c2);

      const m1 = nextMessage(c1);
      const m2 = nextMessage(c2);

      server.handlers.broadcastToControllers({ type: 'test_broadcast', value: 7 });

      const [msg1, msg2] = await Promise.all([m1, m2]);
      expect(msg1.type).toBe('test_broadcast');
      expect(msg1.value).toBe(7);
      expect(msg2.type).toBe('test_broadcast');

      await closeWs(c1);
      await closeWs(c2);
    });

    it('skips closed controllers without throwing', async () => {
      const ctrl = await connect(`${server.url}/controller?apikey=${ADMIN_API_KEY}`);
      await nextMessage(ctrl);

      // Force-close without the server knowing, then inject a closed-state stub
      const closedStub = { readyState: WebSocket.CLOSED, send: () => { throw new Error('should not be called'); } };
      server.controllers.add(closedStub);

      expect(() => {
        server.handlers.broadcastToControllers({ type: 'test' });
      }).not.toThrow();

      server.controllers.delete(closedStub);
      await closeWs(ctrl);
    });

    it('does nothing with no controllers', () => {
      expect(() => {
        server.handlers.broadcastToControllers({ type: 'noop' });
      }).not.toThrow();
    });
  });

  // ── 9. safeSend edge cases ────────────────────────────────────────────────

  describe('safeSend helper', () => {
    it('does not throw when ws is null or undefined', () => {
      expect(() => server.handlers.safeSend(null,      { type: 'test' })).not.toThrow();
      expect(() => server.handlers.safeSend(undefined, { type: 'test' })).not.toThrow();
    });

    it('does not throw when ws is closed', () => {
      const stub = { readyState: WebSocket.CLOSED, send: () => { throw new Error('boom'); } };
      expect(() => server.handlers.safeSend(stub, { type: 'test' })).not.toThrow();
    });

    it('catches send errors without throwing', () => {
      const stub = { readyState: WebSocket.OPEN, send: () => { throw new Error('write failed'); } };
      expect(() => server.handlers.safeSend(stub, { type: 'test' })).not.toThrow();
    });
  });

  // ── 10. onChurchMessage hook for subsystem message types ──────────────────

  describe('Subsystem message hook', () => {
    it('fires onChurchMessage for signal_event without broadcasting to controllers', async () => {
      const received = [];

      const server3 = await buildTestServer({
        onChurchMessage: (church, msg) => received.push({ church: church.churchId, msg }),
      });
      server3.churches.set('church-1', makeChurchEntry('church-1', 'First Baptist'));

      const ctrl = await connect(`${server3.url}/controller?apikey=${ADMIN_API_KEY}`);
      await nextMessage(ctrl);

      const churchToken = signToken('church-1');
      const churchWs = await connect(`${server3.url}/church?token=${churchToken}`);
      await nextMessage(churchWs);
      await nextMessage(ctrl); // church_connected

      send(churchWs, { type: 'signal_event', signal: 'stream_drop' });

      // Give handler a tick to run
      await new Promise(r => setTimeout(r, 50));

      // Hook should have fired
      expect(received.length).toBe(1);
      expect(received[0].church).toBe('church-1');
      expect(received[0].msg.type).toBe('signal_event');

      // Controller should NOT have received signal_event directly
      const silence = await Promise.race([
        nextMessage(ctrl),
        new Promise(r => setTimeout(() => r('silence'), 150)),
      ]);
      expect(silence).toBe('silence');

      await server3.close();
    });

    it('fires onStatusUpdate hook after broadcasting status to controllers', async () => {
      const hookCalls = [];
      const server4 = await buildTestServer({
        onStatusUpdate: (church, msg, statusEvent) => hookCalls.push({ church: church.churchId, statusEvent }),
      });
      server4.churches.set('church-1', makeChurchEntry('church-1', 'First Baptist'));

      const ctrl = await connect(`${server4.url}/controller?apikey=${ADMIN_API_KEY}`);
      await nextMessage(ctrl);

      const churchWs = await connect(`${server4.url}/church?token=${signToken('church-1')}`);
      await nextMessage(churchWs);
      await nextMessage(ctrl);

      send(churchWs, { type: 'status_update', status: { obs: { streaming: true } } });
      await nextMessage(ctrl); // wait for controller to get it

      expect(hookCalls.length).toBe(1);
      expect(hookCalls[0].church).toBe('church-1');
      expect(hookCalls[0].statusEvent.type).toBe('status_update');

      await server4.close();
    });
  });
});
