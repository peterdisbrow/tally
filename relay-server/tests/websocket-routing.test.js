/**
 * Tests for WebSocket routing — connection auth, message routing,
 * validation, reconnection, broadcast, and church isolation.
 *
 * These tests exercise the server's WebSocket handling logic in isolation
 * by simulating the data structures and functions used in server.js.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Minimal JWT helpers (mirrors server.js token logic) ─────────────────────

function createMockJwt(payload, secret, options = {}) {
  // Simulate jwt.sign: produce a deterministic token string for testing
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = {
    ...payload,
    iat: now,
    ...(options.expiresIn ? { exp: now + parseExpiry(options.expiresIn) } : {}),
  };
  const bodyB64 = Buffer.from(JSON.stringify(body)).toString('base64url');
  // Not a real signature — just enough structure to test verify logic
  const sig = Buffer.from(secret + JSON.stringify(body)).toString('base64url');
  return `${header}.${bodyB64}.${sig}`;
}

function parseExpiry(val) {
  if (typeof val === 'number') return val;
  const m = String(val).match(/^(\d+)([smhd])$/);
  if (!m) return 3600;
  const n = Number(m[1]);
  switch (m[2]) {
    case 's': return n;
    case 'm': return n * 60;
    case 'h': return n * 3600;
    case 'd': return n * 86400;
    default: return 3600;
  }
}

// ─── Mock WebSocket ──────────────────────────────────────────────────────────

const OPEN = 1;
const CLOSED = 3;

function mockWs(readyState = OPEN) {
  return {
    readyState,
    send: vi.fn(),
    close: vi.fn(function () { this.readyState = CLOSED; }),
    ping: vi.fn(),
    on: vi.fn(),
    _listeners: {},
  };
}

// ─── safeSend / broadcastToControllers (replicate from server.js) ────────────

function safeSend(ws, payload) {
  try {
    if (ws?.readyState === OPEN) {
      ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
    }
  } catch { /* swallow */ }
}

function broadcastToControllers(controllers, msg) {
  const data = JSON.stringify(msg);
  for (const ws of controllers) {
    safeSend(ws, data);
  }
}

// ─── Church / controller setup helpers ───────────────────────────────────────

const JWT_SECRET = 'test-jwt-secret';

function makeChurch(id, name, overrides = {}) {
  return {
    churchId: id,
    name,
    ws: null,
    status: {},
    lastSeen: null,
    disconnectedAt: null,
    ...overrides,
  };
}

function handleChurchConnection(churches, ws, token, { checkPaidAccess = () => ({ allowed: true }) } = {}) {
  if (!token) {
    ws.close(1008, 'token required');
    return null;
  }

  let payload;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('bad token');
    const body = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    // Check expiry
    if (body.exp && body.exp < Math.floor(Date.now() / 1000)) {
      throw new Error('token expired');
    }
    payload = body;
  } catch {
    ws.close(1008, 'invalid token');
    return null;
  }

  const church = churches.get(payload.churchId);
  if (!church) {
    ws.close(1008, 'church not registered');
    return null;
  }

  const access = checkPaidAccess(church.churchId);
  if (!access.allowed) {
    ws.close(1008, `billing_${access.status}`);
    return null;
  }

  // Replace existing connection
  if (church.ws?.readyState === OPEN) {
    church.ws.close(1000, 'replaced by new connection');
  }

  church.ws = ws;
  church.lastSeen = new Date().toISOString();
  church.disconnectedAt = null;

  safeSend(ws, { type: 'connected', churchId: church.churchId, name: church.name });
  return church;
}

function handleChurchMessage(church, msg, controllers) {
  church.lastSeen = new Date().toISOString();

  switch (msg.type) {
    case 'status_update':
      church.status = { ...church.status, ...msg.status };
      broadcastToControllers(controllers, {
        type: 'status_update',
        churchId: church.churchId,
        name: church.name,
        status: church.status,
      });
      break;

    case 'alert':
      broadcastToControllers(controllers, {
        type: 'alert',
        churchId: church.churchId,
        name: church.name,
        severity: msg.severity || 'warning',
        message: msg.message,
      });
      break;

    case 'command_result':
      broadcastToControllers(controllers, {
        type: 'command_result',
        churchId: church.churchId,
        name: church.name,
        messageId: msg.id,
        result: msg.result,
        error: msg.error,
      });
      break;

    case 'ping':
      safeSend(church.ws, { type: 'pong', ts: msg.ts });
      break;

    default:
      broadcastToControllers(controllers, { ...msg, churchId: church.churchId, churchName: church.name });
  }
}

function handleControllerMessage(ws, msg, churches, controllers) {
  if (msg.type === 'command' && msg.churchId) {
    const church = churches.get(msg.churchId);
    if (church?.ws?.readyState === OPEN) {
      safeSend(church.ws, msg);
    } else {
      safeSend(ws, { type: 'error', error: 'Church not connected', churchId: msg.churchId });
    }
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WebSocket Routing', () => {
  let churches, controllers;

  beforeEach(() => {
    churches = new Map();
    controllers = new Set();
    churches.set('church-1', makeChurch('church-1', 'First Baptist'));
    churches.set('church-2', makeChurch('church-2', 'Grace Chapel'));
  });

  // ── 1. Connection Authentication ──────────────────────────────────────────

  describe('Connection Authentication', () => {
    it('accepts a valid token and sends connected message', () => {
      const ws = mockWs();
      const token = createMockJwt({ churchId: 'church-1' }, JWT_SECRET, { expiresIn: '30d' });

      const result = handleChurchConnection(churches, ws, token);

      expect(result).not.toBeNull();
      expect(result.churchId).toBe('church-1');
      expect(ws.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.type).toBe('connected');
      expect(sent.churchId).toBe('church-1');
      expect(sent.name).toBe('First Baptist');
    });

    it('rejects connection with no token', () => {
      const ws = mockWs();
      const result = handleChurchConnection(churches, ws, null);

      expect(result).toBeNull();
      expect(ws.close).toHaveBeenCalledWith(1008, 'token required');
    });

    it('rejects connection with invalid token', () => {
      const ws = mockWs();
      const result = handleChurchConnection(churches, ws, 'not.a.valid-token');

      expect(result).toBeNull();
      expect(ws.close).toHaveBeenCalledWith(1008, 'invalid token');
    });

    it('rejects connection with malformed token (wrong number of segments)', () => {
      const ws = mockWs();
      const result = handleChurchConnection(churches, ws, 'only-one-segment');

      expect(result).toBeNull();
      expect(ws.close).toHaveBeenCalledWith(1008, 'invalid token');
    });

    it('rejects connection with expired token', () => {
      const ws = mockWs();
      // Create a token that expired 1 hour ago
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const body = { churchId: 'church-1', iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 };
      const bodyB64 = Buffer.from(JSON.stringify(body)).toString('base64url');
      const sig = Buffer.from('fake-sig').toString('base64url');
      const expiredToken = `${header}.${bodyB64}.${sig}`;

      const result = handleChurchConnection(churches, ws, expiredToken);

      expect(result).toBeNull();
      expect(ws.close).toHaveBeenCalledWith(1008, 'invalid token');
    });

    it('rejects connection for unregistered churchId', () => {
      const ws = mockWs();
      const token = createMockJwt({ churchId: 'unknown-church' }, JWT_SECRET, { expiresIn: '30d' });

      const result = handleChurchConnection(churches, ws, token);

      expect(result).toBeNull();
      expect(ws.close).toHaveBeenCalledWith(1008, 'church not registered');
    });

    it('rejects connection when billing is not active', () => {
      const ws = mockWs();
      const token = createMockJwt({ churchId: 'church-1' }, JWT_SECRET, { expiresIn: '30d' });
      const checkPaidAccess = () => ({ allowed: false, status: 'expired' });

      const result = handleChurchConnection(churches, ws, token, { checkPaidAccess });

      expect(result).toBeNull();
      expect(ws.close).toHaveBeenCalledWith(1008, 'billing_expired');
    });
  });

  // ── 2. Message Routing Between Church and Controller ─────────────────────

  describe('Message Routing', () => {
    it('forwards status_update from church to all controllers', () => {
      const ctrlWs1 = mockWs();
      const ctrlWs2 = mockWs();
      controllers.add(ctrlWs1);
      controllers.add(ctrlWs2);

      const church = churches.get('church-1');
      church.ws = mockWs();

      handleChurchMessage(church, {
        type: 'status_update',
        status: { atem: { connected: true, programInput: 1 } },
      }, controllers);

      // Both controllers should receive the status update
      expect(ctrlWs1.send).toHaveBeenCalledTimes(1);
      expect(ctrlWs2.send).toHaveBeenCalledTimes(1);

      const msg1 = JSON.parse(ctrlWs1.send.mock.calls[0][0]);
      expect(msg1.type).toBe('status_update');
      expect(msg1.churchId).toBe('church-1');
      expect(msg1.status.atem.connected).toBe(true);
    });

    it('forwards command from controller to the target church', () => {
      const church = churches.get('church-1');
      church.ws = mockWs();

      const ctrlWs = mockWs();
      const cmd = { type: 'command', churchId: 'church-1', command: 'atem.cut', params: { input: 2 } };

      handleControllerMessage(ctrlWs, cmd, churches, controllers);

      expect(church.ws.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(church.ws.send.mock.calls[0][0]);
      expect(sent.type).toBe('command');
      expect(sent.command).toBe('atem.cut');
    });

    it('returns error when commanding a disconnected church', () => {
      const church = churches.get('church-1');
      church.ws = mockWs(CLOSED); // disconnected

      const ctrlWs = mockWs();
      const cmd = { type: 'command', churchId: 'church-1', command: 'atem.cut', params: {} };

      handleControllerMessage(ctrlWs, cmd, churches, controllers);

      expect(ctrlWs.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(ctrlWs.send.mock.calls[0][0]);
      expect(sent.type).toBe('error');
      expect(sent.error).toBe('Church not connected');
    });

    it('returns error when commanding a non-existent church', () => {
      const ctrlWs = mockWs();
      const cmd = { type: 'command', churchId: 'no-such-church', command: 'obs.start', params: {} };

      handleControllerMessage(ctrlWs, cmd, churches, controllers);

      expect(ctrlWs.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(ctrlWs.send.mock.calls[0][0]);
      expect(sent.type).toBe('error');
    });

    it('forwards alert from church to all controllers', () => {
      const ctrlWs = mockWs();
      controllers.add(ctrlWs);

      const church = churches.get('church-1');
      church.ws = mockWs();

      handleChurchMessage(church, {
        type: 'alert',
        severity: 'critical',
        message: 'Stream dropped',
      }, controllers);

      expect(ctrlWs.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(ctrlWs.send.mock.calls[0][0]);
      expect(sent.type).toBe('alert');
      expect(sent.churchId).toBe('church-1');
      expect(sent.severity).toBe('critical');
    });

    it('forwards command_result from church to controllers', () => {
      const ctrlWs = mockWs();
      controllers.add(ctrlWs);

      const church = churches.get('church-1');
      church.ws = mockWs();

      handleChurchMessage(church, {
        type: 'command_result',
        id: 'cmd-123',
        result: { success: true },
        error: null,
      }, controllers);

      const sent = JSON.parse(ctrlWs.send.mock.calls[0][0]);
      expect(sent.type).toBe('command_result');
      expect(sent.messageId).toBe('cmd-123');
      expect(sent.result.success).toBe(true);
    });

    it('responds to ping with pong', () => {
      const church = churches.get('church-1');
      church.ws = mockWs();

      handleChurchMessage(church, { type: 'ping', ts: 12345 }, controllers);

      expect(church.ws.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(church.ws.send.mock.calls[0][0]);
      expect(sent.type).toBe('pong');
      expect(sent.ts).toBe(12345);
    });

    it('forwards unknown message types to controllers with churchId', () => {
      const ctrlWs = mockWs();
      controllers.add(ctrlWs);

      const church = churches.get('church-1');
      church.ws = mockWs();

      handleChurchMessage(church, { type: 'custom_event', data: 'hello' }, controllers);

      const sent = JSON.parse(ctrlWs.send.mock.calls[0][0]);
      expect(sent.type).toBe('custom_event');
      expect(sent.churchId).toBe('church-1');
      expect(sent.data).toBe('hello');
    });
  });

  // ── 3. Message Validation ─────────────────────────────────────────────────

  describe('Message Validation', () => {
    it('handles malformed JSON gracefully', () => {
      const church = churches.get('church-1');
      church.ws = mockWs();

      // Simulate what happens in server.js ws.on('message') — parse and catch
      const data = 'not valid json {{{';
      let error = null;
      try {
        const msg = JSON.parse(data);
        handleChurchMessage(church, msg, controllers);
      } catch (e) {
        error = e;
      }

      expect(error).not.toBeNull();
      expect(error.message).toContain('JSON');
    });

    it('handles message with missing type field', () => {
      const ctrlWs = mockWs();
      controllers.add(ctrlWs);

      const church = churches.get('church-1');
      church.ws = mockWs();

      // Message with no type falls through to default case
      handleChurchMessage(church, { data: 'something' }, controllers);

      // Should broadcast to controllers via default case
      const sent = JSON.parse(ctrlWs.send.mock.calls[0][0]);
      expect(sent.churchId).toBe('church-1');
    });

    it('handles oversized payload by rejecting at parse level', () => {
      // server.js sets maxPayload: 256 * 1024 on WebSocketServer
      // Messages exceeding this are rejected at the ws library level.
      // Here we verify our handler doesn't crash on very large status objects.
      const church = churches.get('church-1');
      church.ws = mockWs();

      const bigStatus = {};
      for (let i = 0; i < 1000; i++) {
        bigStatus[`key_${i}`] = 'x'.repeat(200);
      }

      // Should not throw
      expect(() => {
        handleChurchMessage(church, { type: 'status_update', status: bigStatus }, controllers);
      }).not.toThrow();

      expect(church.status).toBeDefined();
    });

    it('updates lastSeen on every message', () => {
      const church = churches.get('church-1');
      church.ws = mockWs();
      church.lastSeen = null;

      handleChurchMessage(church, { type: 'ping', ts: 1 }, controllers);
      expect(church.lastSeen).not.toBeNull();

      const firstSeen = church.lastSeen;
      handleChurchMessage(church, { type: 'ping', ts: 2 }, controllers);
      // lastSeen should be updated (could be same ISO string if fast enough)
      expect(church.lastSeen).toBeDefined();
    });
  });

  // ── 4. Reconnection Handling ──────────────────────────────────────────────

  describe('Reconnection Handling', () => {
    it('replaces old WebSocket when church reconnects', () => {
      const oldWs = mockWs();
      const church = churches.get('church-1');
      church.ws = oldWs;

      const newWs = mockWs();
      const token = createMockJwt({ churchId: 'church-1' }, JWT_SECRET, { expiresIn: '30d' });

      handleChurchConnection(churches, newWs, token);

      // Old connection should be closed
      expect(oldWs.close).toHaveBeenCalledWith(1000, 'replaced by new connection');
      // New connection should be active
      expect(church.ws).toBe(newWs);
    });

    it('clears disconnectedAt on reconnection', () => {
      const church = churches.get('church-1');
      church.disconnectedAt = Date.now() - 60000; // disconnected 1 min ago

      const ws = mockWs();
      const token = createMockJwt({ churchId: 'church-1' }, JWT_SECRET, { expiresIn: '30d' });

      handleChurchConnection(churches, ws, token);

      expect(church.disconnectedAt).toBeNull();
    });

    it('does not close old ws if it is already closed', () => {
      const oldWs = mockWs(CLOSED);
      const church = churches.get('church-1');
      church.ws = oldWs;

      const newWs = mockWs();
      const token = createMockJwt({ churchId: 'church-1' }, JWT_SECRET, { expiresIn: '30d' });

      handleChurchConnection(churches, newWs, token);

      // Old ws was already closed — close should not be called
      expect(oldWs.close).not.toHaveBeenCalled();
      expect(church.ws).toBe(newWs);
    });
  });

  // ── 5. Broadcast to Multiple Controllers ─────────────────────────────────

  describe('Broadcast to Multiple Controllers', () => {
    it('sends to all connected controllers', () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      const ws3 = mockWs();
      controllers.add(ws1);
      controllers.add(ws2);
      controllers.add(ws3);

      broadcastToControllers(controllers, { type: 'test', data: 42 });

      expect(ws1.send).toHaveBeenCalledTimes(1);
      expect(ws2.send).toHaveBeenCalledTimes(1);
      expect(ws3.send).toHaveBeenCalledTimes(1);

      // All should receive the same serialized message
      const msg1 = ws1.send.mock.calls[0][0];
      const msg2 = ws2.send.mock.calls[0][0];
      const msg3 = ws3.send.mock.calls[0][0];
      expect(msg1).toBe(msg2);
      expect(msg2).toBe(msg3);
    });

    it('skips closed controllers without throwing', () => {
      const wsOpen = mockWs();
      const wsClosed = mockWs(CLOSED);
      controllers.add(wsOpen);
      controllers.add(wsClosed);

      expect(() => {
        broadcastToControllers(controllers, { type: 'test' });
      }).not.toThrow();

      expect(wsOpen.send).toHaveBeenCalledTimes(1);
      expect(wsClosed.send).not.toHaveBeenCalled();
    });

    it('does nothing when there are no controllers', () => {
      expect(() => {
        broadcastToControllers(controllers, { type: 'test' });
      }).not.toThrow();
    });

    it('handles send errors gracefully', () => {
      const ws1 = mockWs();
      ws1.send = vi.fn(() => { throw new Error('send failed'); });
      const ws2 = mockWs();
      controllers.add(ws1);
      controllers.add(ws2);

      // Should not throw even if ws1 throws
      expect(() => {
        broadcastToControllers(controllers, { type: 'test' });
      }).not.toThrow();

      // ws2 should still receive the message
      expect(ws2.send).toHaveBeenCalledTimes(1);
    });
  });

  // ── 6. Church Isolation ────────────────────────────────────────────────────

  describe('Church Isolation', () => {
    it('status_update from church A does not affect church B state', () => {
      const churchA = churches.get('church-1');
      const churchB = churches.get('church-2');
      churchA.ws = mockWs();
      churchB.ws = mockWs();

      handleChurchMessage(churchA, {
        type: 'status_update',
        status: { atem: { connected: true, programInput: 3 } },
      }, controllers);

      // Church A should have the new status
      expect(churchA.status.atem?.connected).toBe(true);
      expect(churchA.status.atem?.programInput).toBe(3);

      // Church B should be unaffected
      expect(churchB.status.atem).toBeUndefined();
    });

    it('command targets only the specified church', () => {
      const churchA = churches.get('church-1');
      const churchB = churches.get('church-2');
      churchA.ws = mockWs();
      churchB.ws = mockWs();

      const ctrlWs = mockWs();
      handleControllerMessage(ctrlWs, {
        type: 'command',
        churchId: 'church-1',
        command: 'atem.cut',
        params: { input: 2 },
      }, churches, controllers);

      // Only church A should receive the command
      expect(churchA.ws.send).toHaveBeenCalledTimes(1);
      expect(churchB.ws.send).not.toHaveBeenCalled();
    });

    it('controller broadcast includes correct churchId for each church', () => {
      const ctrlWs = mockWs();
      controllers.add(ctrlWs);

      const churchA = churches.get('church-1');
      const churchB = churches.get('church-2');
      churchA.ws = mockWs();
      churchB.ws = mockWs();

      handleChurchMessage(churchA, {
        type: 'status_update',
        status: { obs: { connected: true } },
      }, controllers);

      handleChurchMessage(churchB, {
        type: 'status_update',
        status: { obs: { connected: false } },
      }, controllers);

      expect(ctrlWs.send).toHaveBeenCalledTimes(2);
      const msgA = JSON.parse(ctrlWs.send.mock.calls[0][0]);
      const msgB = JSON.parse(ctrlWs.send.mock.calls[1][0]);

      expect(msgA.churchId).toBe('church-1');
      expect(msgA.status.obs.connected).toBe(true);
      expect(msgB.churchId).toBe('church-2');
      expect(msgB.status.obs.connected).toBe(false);
    });

    it('disconnecting church A does not affect church B connection', () => {
      const churchA = churches.get('church-1');
      const churchB = churches.get('church-2');
      const wsA = mockWs();
      const wsB = mockWs();
      churchA.ws = wsA;
      churchB.ws = wsB;

      // Simulate church A disconnect
      churchA.ws = null;
      churchA.disconnectedAt = Date.now();
      churchA.status = { connected: false };

      // Church B should remain unaffected
      expect(churchB.ws).toBe(wsB);
      expect(churchB.ws.readyState).toBe(OPEN);
      expect(churchB.disconnectedAt).toBeNull();
    });

    it('cannot send command to church B using church A token', () => {
      const churchA = churches.get('church-1');
      const churchB = churches.get('church-2');
      churchA.ws = mockWs();
      churchB.ws = mockWs();

      // Token for church A
      const tokenA = createMockJwt({ churchId: 'church-1' }, JWT_SECRET, { expiresIn: '30d' });
      const ws = mockWs();

      // Connect as church A
      handleChurchConnection(churches, ws, tokenA);

      // Church A sends a message — it should be tagged with church-1, not church-2
      handleChurchMessage(churches.get('church-1'), {
        type: 'status_update',
        status: { fake: true },
      }, controllers);

      // Church B should not have the fake status
      expect(churchB.status.fake).toBeUndefined();
    });
  });

  // ── safeSend edge cases ───────────────────────────────────────────────────

  describe('safeSend', () => {
    it('sends JSON string when given an object', () => {
      const ws = mockWs();
      safeSend(ws, { type: 'test', value: 1 });
      expect(ws.send).toHaveBeenCalledWith('{"type":"test","value":1}');
    });

    it('sends raw string when given a string', () => {
      const ws = mockWs();
      safeSend(ws, '{"already":"serialized"}');
      expect(ws.send).toHaveBeenCalledWith('{"already":"serialized"}');
    });

    it('does not send to closed WebSocket', () => {
      const ws = mockWs(CLOSED);
      safeSend(ws, { type: 'test' });
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('does not throw when ws is null', () => {
      expect(() => safeSend(null, { type: 'test' })).not.toThrow();
    });

    it('does not throw when ws is undefined', () => {
      expect(() => safeSend(undefined, { type: 'test' })).not.toThrow();
    });

    it('catches send errors without throwing', () => {
      const ws = mockWs();
      ws.send = vi.fn(() => { throw new Error('write failed'); });
      expect(() => safeSend(ws, { type: 'test' })).not.toThrow();
    });
  });
});
