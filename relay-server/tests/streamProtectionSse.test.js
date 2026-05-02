/**
 * Regression tests for stream-protection SSE propagation.
 *
 * Confirms that when a church-client emits stream_protection_status, the relay:
 *   1. Normalizes the payload (adds active+triggeredAt while preserving the
 *      raw fields the portal UI consumes).
 *   2. Persists it on church.status so portal SSE snapshots include it on
 *      initial connect.
 *   3. Pushes the change through the delta tracker so portal SSE clients
 *      see it as a status_update on the same channel they already consume.
 *   4. Still emits the dedicated stream_protection_status event for the
 *      portal's specialised handler.
 *
 * Spins up a real http.Server + WebSocketServer wired to the actual
 * createWebSocketHandlers factory (same pattern as websocket-routing.test.js)
 * so the test exercises production code paths, not a mock re-implementation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import http from 'http';

const require = createRequire(import.meta.url);
const { WebSocketServer, WebSocket } = require('ws');
const jwt = require('jsonwebtoken');
const { createWebSocketHandlers } = require('../src/websocketRouter');
const { createDeltaTracker } = require('../src/deltaUpdates');
const { normalizeStreamProtection } = require('../src/streamProtectionState');

const JWT_SECRET = 'sp-sse-test-secret';

function makeChurchEntry(id, name) {
  return {
    churchId: id,
    name,
    ws: null,
    sockets: new Map(),
    status: {},
    instanceStatus: {},
    roomInstanceMap: {},
    lastSeen: null,
    lastHeartbeat: null,
    disconnectedAt: null,
    _offlineAlertSent: false,
  };
}

function signToken(churchId) {
  return jwt.sign({ churchId }, JWT_SECRET, { expiresIn: '1h' });
}

function buildTestServer(overrides = {}) {
  const churches = new Map();
  const controllers = new Set();
  const portalEvents = []; // captured broadcastToPortal payloads
  const deltaTracker = createDeltaTracker();

  const handlers = createWebSocketHandlers({
    churches,
    controllers,
    jwt,
    jwtSecret: JWT_SECRET,
    wsOpen: WebSocket.OPEN,
    wsPingIntervalMs: 0,
    deltaTracker,
    broadcastToPortal: (churchId, data) => portalEvents.push({ churchId, data }),
    ...overrides,
  });

  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const role = url.pathname.replace(/^\//, '');
    if (role === 'church') {
      handlers.handleChurchConnection(ws, url, req.socket.remoteAddress || '127.0.0.1');
    } else {
      ws.close(1008, 'Unknown role');
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.removeListener('error', reject);
      const { port } = httpServer.address();
      resolve({
        url: `ws://127.0.0.1:${port}`,
        churches,
        portalEvents,
        deltaTracker,
        close: () => new Promise((res) => {
          for (const ws of wss.clients) ws.terminate();
          wss.close(() => httpServer.close(res));
        }),
      });
    });
  });
}

function connectChurch(url, churchId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}/church?token=${signToken(churchId)}&instance=_default`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('close', (code, reason) => {
      reject(new Error(`WS closed before open — code ${code} reason "${reason}"`));
    });
  });
}

function send(ws, obj) {
  ws.send(JSON.stringify(obj));
}

function closeWs(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once('close', resolve);
    ws.close();
  });
}

/**
 * Wait until `predicate(portalEvents)` is satisfied or timeout. Polls every
 * 10ms — broadcastToPortal is invoked synchronously during message handling
 * but the WS message itself arrives via the event loop.
 */
async function waitForPortal(portalEvents, predicate, timeoutMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate(portalEvents)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(
    `waitForPortal timeout — got ${portalEvents.length} events: ${JSON.stringify(portalEvents.map(e => e.data?.type))}`
  );
}

describe('Stream protection SSE propagation', () => {
  let server;

  beforeEach(async () => {
    server = await buildTestServer();
    server.churches.set('church-1', makeChurchEntry('church-1', 'First Baptist'));
  });

  afterEach(async () => {
    await server.close();
  });

  it('persists normalized streamProtection on church.status when triggered', async () => {
    const churchWs = await connectChurch(server.url, 'church-1');
    server.portalEvents.length = 0; // ignore any connect-time events

    const triggeredAt = '2026-05-02T10:15:00.000Z';
    send(churchWs, {
      type: 'stream_protection_status',
      streamProtection: {
        enabled: true,
        active: true,
        state: 'encoder_disconnected',
        lastEvent: 'Encoder disconnected — stream down. Monitoring for reconnection.',
        lastEventAt: triggeredAt,
        canManualRestart: false,
        cdnHealth: null,
        cdnPlatforms: null,
      },
    });

    await waitForPortal(
      server.portalEvents,
      (events) => events.some((e) => e.data?.type === 'stream_protection_status')
    );

    const church = server.churches.get('church-1');
    expect(church.status.streamProtection).toBeTruthy();
    expect(church.status.streamProtection.active).toBe(true);
    expect(church.status.streamProtection.state).toBe('encoder_disconnected');
    expect(church.status.streamProtection.triggeredAt).toBe(triggeredAt);
    expect(church.status.streamProtection.lastEvent).toContain('Encoder disconnected');
    // raw fields preserved for the portal UI handler
    expect(church.status.streamProtection.enabled).toBe(true);
    expect(church.status.streamProtection.canManualRestart).toBe(false);

    await closeWs(churchWs);
  });

  it('broadcasts a status_update with streamProtection in the delta', async () => {
    const churchWs = await connectChurch(server.url, 'church-1');
    server.portalEvents.length = 0;

    // Seed the delta tracker with a baseline status_update so the next
    // change shows up as a non-trivial delta.
    send(churchWs, { type: 'status_update', status: { obs: { connected: true } } });
    await waitForPortal(
      server.portalEvents,
      (events) => events.some((e) => e.data?.type === 'status_update')
    );
    server.portalEvents.length = 0;

    const triggeredAt = '2026-05-02T10:15:30.000Z';
    send(churchWs, {
      type: 'stream_protection_status',
      streamProtection: {
        enabled: true,
        active: true,
        state: 'cdn_mismatch',
        lastEvent: 'Stream not reaching YouTube',
        lastEventAt: triggeredAt,
        canManualRestart: true,
        cdnHealth: 'mismatch',
        cdnPlatforms: { youtube: { live: false, viewerCount: 0 } },
      },
    });

    await waitForPortal(
      server.portalEvents,
      (events) => events.some(
        (e) => e.data?.type === 'status_update' && e.data?.statusDelta?.streamProtection
      )
    );

    const statusUpdate = server.portalEvents.find(
      (e) => e.data?.type === 'status_update' && e.data?.statusDelta?.streamProtection
    );
    expect(statusUpdate).toBeTruthy();
    expect(statusUpdate.churchId).toBe('church-1');
    expect(statusUpdate.data.statusDelta.streamProtection.active).toBe(true);
    expect(statusUpdate.data.statusDelta.streamProtection.state).toBe('cdn_mismatch');
    expect(statusUpdate.data.statusDelta.streamProtection.triggeredAt).toBe(triggeredAt);
    expect(statusUpdate.data.statusMode).toBe('delta');

    // Dedicated event also fired (portal's specialised handler still works)
    const spEvent = server.portalEvents.find(
      (e) => e.data?.type === 'stream_protection_status'
    );
    expect(spEvent).toBeTruthy();
    expect(spEvent.data.streamProtection.active).toBe(true);
    expect(spEvent.data.streamProtection.triggeredAt).toBe(triggeredAt);

    await closeWs(churchWs);
  });

  it('clears triggeredAt when stream protection returns to idle', async () => {
    const churchWs = await connectChurch(server.url, 'church-1');
    server.portalEvents.length = 0;

    // Trigger
    send(churchWs, {
      type: 'stream_protection_status',
      streamProtection: {
        enabled: true,
        active: true,
        state: 'encoder_disconnected',
        lastEvent: 'Encoder down',
        lastEventAt: '2026-05-02T10:15:00.000Z',
        canManualRestart: false,
        cdnHealth: null,
        cdnPlatforms: null,
      },
    });
    await waitForPortal(
      server.portalEvents,
      (events) => events.some((e) => e.data?.type === 'stream_protection_status')
    );

    // Clear
    server.portalEvents.length = 0;
    send(churchWs, {
      type: 'stream_protection_status',
      streamProtection: {
        enabled: true,
        active: false,
        state: 'idle',
        lastEvent: 'Stream stopped via Tally Connect.',
        lastEventAt: '2026-05-02T10:20:00.000Z',
        canManualRestart: false,
        cdnHealth: null,
        cdnPlatforms: null,
      },
    });
    await waitForPortal(
      server.portalEvents,
      (events) => events.some((e) => e.data?.type === 'stream_protection_status')
    );

    const church = server.churches.get('church-1');
    expect(church.status.streamProtection.active).toBe(false);
    expect(church.status.streamProtection.state).toBe('idle');
    expect(church.status.streamProtection.triggeredAt).toBeNull();

    await closeWs(churchWs);
  });

  it('preserves the original triggeredAt across substate transitions while active', async () => {
    const churchWs = await connectChurch(server.url, 'church-1');
    server.portalEvents.length = 0;

    const firstTriggeredAt = '2026-05-02T10:15:00.000Z';
    send(churchWs, {
      type: 'stream_protection_status',
      streamProtection: {
        enabled: true, active: true, state: 'protecting',
        lastEvent: 'Stream started — protection active.',
        lastEventAt: firstTriggeredAt,
        canManualRestart: false, cdnHealth: 'checking', cdnPlatforms: null,
      },
    });
    await waitForPortal(
      server.portalEvents,
      (events) => events.some((e) => e.data?.type === 'stream_protection_status')
    );
    server.portalEvents.length = 0;

    // Substate transition: protecting → encoder_disconnected (still active)
    send(churchWs, {
      type: 'stream_protection_status',
      streamProtection: {
        enabled: true, active: true, state: 'encoder_disconnected',
        lastEvent: 'Encoder disconnected — monitoring for reconnection.',
        lastEventAt: '2026-05-02T10:17:30.000Z',
        canManualRestart: false, cdnHealth: null, cdnPlatforms: null,
      },
    });
    await waitForPortal(
      server.portalEvents,
      (events) => events.some((e) => e.data?.type === 'stream_protection_status')
    );

    const church = server.churches.get('church-1');
    // triggeredAt should still be the first trigger time, not the new lastEventAt
    expect(church.status.streamProtection.triggeredAt).toBe(firstTriggeredAt);
    expect(church.status.streamProtection.state).toBe('encoder_disconnected');

    await closeWs(churchWs);
  });
});

describe('normalizeStreamProtection', () => {
  it('returns null for missing input', () => {
    expect(normalizeStreamProtection(null)).toBeNull();
    expect(normalizeStreamProtection(undefined)).toBeNull();
  });

  it('sets triggeredAt to lastEventAt when first becoming active', () => {
    const out = normalizeStreamProtection({
      enabled: true, active: true, state: 'encoder_disconnected',
      lastEvent: 'Encoder down', lastEventAt: '2026-05-02T10:15:00.000Z',
      canManualRestart: false, cdnHealth: null, cdnPlatforms: null,
    });
    expect(out.active).toBe(true);
    expect(out.triggeredAt).toBe('2026-05-02T10:15:00.000Z');
  });

  it('falls back to a fresh ISO timestamp when lastEventAt is missing', () => {
    const out = normalizeStreamProtection({
      enabled: true, active: true, state: 'protecting',
    });
    expect(out.active).toBe(true);
    expect(typeof out.triggeredAt).toBe('string');
    expect(Number.isNaN(Date.parse(out.triggeredAt))).toBe(false);
  });

  it('clears triggeredAt when active is false', () => {
    const out = normalizeStreamProtection(
      { enabled: true, active: false, state: 'idle', lastEventAt: '2026-05-02T10:20:00Z' },
      { active: true, triggeredAt: '2026-05-02T10:15:00Z' }
    );
    expect(out.active).toBe(false);
    expect(out.triggeredAt).toBeNull();
  });

  it('preserves prev.triggeredAt when active stays true across substates', () => {
    const prev = { active: true, triggeredAt: '2026-05-02T10:15:00.000Z' };
    const out = normalizeStreamProtection(
      {
        enabled: true, active: true, state: 'restarting',
        lastEvent: 'Auto-restart', lastEventAt: '2026-05-02T10:18:00.000Z',
      },
      prev
    );
    expect(out.triggeredAt).toBe('2026-05-02T10:15:00.000Z');
    expect(out.state).toBe('restarting');
  });

  it('preserves all raw fields the portal UI consumes', () => {
    const raw = {
      enabled: true, active: true, state: 'cdn_mismatch',
      lastEvent: 'Not reaching YouTube',
      lastEventAt: '2026-05-02T10:15:00.000Z',
      canManualRestart: true,
      cdnHealth: 'mismatch',
      cdnPlatforms: { youtube: { live: false, viewerCount: 0 } },
    };
    const out = normalizeStreamProtection(raw);
    expect(out.enabled).toBe(true);
    expect(out.canManualRestart).toBe(true);
    expect(out.cdnHealth).toBe('mismatch');
    expect(out.cdnPlatforms.youtube.live).toBe(false);
    expect(out.lastEvent).toBe('Not reaching YouTube');
  });
});
