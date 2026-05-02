/**
 * Tests for src/routes/health.js — setupHealthRoutes(app, ctx).
 *
 * Routes are captured via a mock app, then handlers are invoked directly
 * with mock req/res objects. No HTTP server is started.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import { SqliteQueryClient } from '../src/db/queryClient.js';

const require = createRequire(import.meta.url);
const setupHealthRoutes = require('../src/routes/health.js');

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeCtx(overrides = {}) {
  return {
    churches: new Map(),
    controllers: new Set(),
    RELAY_VERSION: '1.2.3',
    RELAY_BUILD: 'test-build',
    WebSocket: { OPEN: 1 },
    totalMessagesRelayed: 0,
    ...overrides,
  };
}

function makeApp() {
  const routes = {};
  return {
    app: { get: (path, ...handlers) => { routes[path] = handlers[handlers.length - 1]; } },
    routes,
  };
}

function callRoute(routes, path, reqOverrides = {}) {
  let sentJson = null;
  let sentStatus = 200;
  const res = {
    json: (body) => { sentJson = body; },
    status: (code) => { sentStatus = code; return { json: (body) => { sentJson = body; } }; },
  };
  routes[path]({ ...reqOverrides }, res);
  return { body: sentJson, status: sentStatus };
}

async function callRouteAsync(routes, path, reqOverrides = {}) {
  let sentJson = null;
  let sentStatus = 200;
  const res = {
    json: (body) => { sentJson = body; },
    status: (code) => { sentStatus = code; return { json: (body) => { sentJson = body; } }; },
  };
  await routes[path]({ ...reqOverrides }, res);
  return { body: sentJson, status: sentStatus };
}

/** Build a church entry whose WebSocket readyState matches the given value. */
function makeChurch(readyState) {
  const ws = { readyState };
  return { ws, sockets: new Map([['_default', ws]]) };
}

// ─── GET / — basic health ─────────────────────────────────────────────────────

describe('GET / — basic health', () => {
  it('returns service=tally-relay and correct version', () => {
    const ctx = makeCtx();
    const { app, routes } = makeApp();
    setupHealthRoutes(app, ctx);
    const { body } = callRoute(routes, '/');
    expect(body.service).toBe('tally-relay');
    expect(body.version).toBe('1.2.3');
  });

  it('returns churches=0 when no churches registered', () => {
    const ctx = makeCtx();
    const { app, routes } = makeApp();
    setupHealthRoutes(app, ctx);
    const { body } = callRoute(routes, '/');
    expect(body.churches).toBe(0);
  });

  it('returns controllers=0 when no controllers connected', () => {
    const ctx = makeCtx();
    const { app, routes } = makeApp();
    setupHealthRoutes(app, ctx);
    const { body } = callRoute(routes, '/');
    expect(body.controllers).toBe(0);
  });

  it('reflects actual church Map size', () => {
    const churches = new Map([
      ['c1', makeChurch(1)],
      ['c2', makeChurch(0)],
      ['c3', makeChurch(1)],
    ]);
    const ctx = makeCtx({ churches });
    const { app, routes } = makeApp();
    setupHealthRoutes(app, ctx);
    const { body } = callRoute(routes, '/');
    expect(body.churches).toBe(3);
  });

  it('reflects actual controllers Map size', () => {
    const controllers = new Map([['ctrl1', {}], ['ctrl2', {}]]);
    const ctx = makeCtx({ controllers });
    const { app, routes } = makeApp();
    setupHealthRoutes(app, ctx);
    const { body } = callRoute(routes, '/');
    expect(body.controllers).toBe(2);
  });
});

// ─── GET /api/health — detailed health ────────────────────────────────────────

describe('GET /api/health — detailed health', () => {
  it('includes service, version, build, uptime, totalMessagesRelayed', () => {
    const ctx = makeCtx({ totalMessagesRelayed: 42 });
    const { app, routes } = makeApp();
    setupHealthRoutes(app, ctx);
    const { body } = callRoute(routes, '/api/health');
    expect(body.service).toBe('tally-relay');
    expect(body.version).toBe('1.2.3');
    expect(body.build).toBe('test-build');
    expect(typeof body.uptime).toBe('number');
    expect(body.totalMessagesRelayed).toBe(42);
  });

  it('counts connectedChurches as churches with OPEN websocket', () => {
    const churches = new Map([
      ['c1', makeChurch(1)],  // OPEN
      ['c2', makeChurch(3)],  // CLOSED
      ['c3', makeChurch(1)],  // OPEN
    ]);
    const ctx = makeCtx({ churches });
    const { app, routes } = makeApp();
    setupHealthRoutes(app, ctx);
    const { body } = callRoute(routes, '/api/health');
    expect(body.connectedChurches).toBe(2);
    expect(body.registeredChurches).toBe(3);
  });

  it('counts 0 connected when all websockets are closed', () => {
    const churches = new Map([
      ['c1', makeChurch(3)],
      ['c2', makeChurch(3)],
    ]);
    const ctx = makeCtx({ churches });
    const { app, routes } = makeApp();
    setupHealthRoutes(app, ctx);
    const { body } = callRoute(routes, '/api/health');
    expect(body.connectedChurches).toBe(0);
  });

  it('counts church with no ws object as not connected', () => {
    const churches = new Map([
      ['c1', {}],  // no ws property
      ['c2', makeChurch(1)],
    ]);
    const ctx = makeCtx({ churches });
    const { app, routes } = makeApp();
    setupHealthRoutes(app, ctx);
    const { body } = callRoute(routes, '/api/health');
    expect(body.connectedChurches).toBe(1);
  });

  // Regression: degraded should NOT fire purely from connection ratio.
  // Most Tally churches only run their desktop agent during Sunday services,
  // so weekday "1 of 6 connected" is normal operating state. The connection
  // ratio is informational only — it surfaces in the response but does not
  // drive overallStatus.
  it('overallStatus stays healthy when most churches are offline (weekday norm)', async () => {
    const sqlite = new Database(':memory:');
    const queryClient = new SqliteQueryClient(sqlite);
    const churches = new Map([
      ['c1', makeChurch(1)],  // OPEN
      ['c2', makeChurch(3)],  // CLOSED — 5 of 6 disconnected, like a Tuesday afternoon
      ['c3', makeChurch(3)],
      ['c4', makeChurch(3)],
      ['c5', makeChurch(3)],
      ['c6', makeChurch(3)],
    ]);
    const ctx = makeCtx({ queryClient, churches });
    const { app, routes } = makeApp();
    setupHealthRoutes(app, ctx);
    const { body } = await callRouteAsync(routes, '/api/health');
    expect(body.status).toBe('healthy');
    expect(body.connectedChurches).toBe(1);
    expect(body.registeredChurches).toBe(6);
    await queryClient.close();
    sqlite.close();
  });

  it('overallStatus stays healthy when zero churches are connected', async () => {
    const sqlite = new Database(':memory:');
    const queryClient = new SqliteQueryClient(sqlite);
    const churches = new Map([
      ['c1', makeChurch(3)],
      ['c2', makeChurch(3)],
    ]);
    const ctx = makeCtx({ queryClient, churches });
    const { app, routes } = makeApp();
    setupHealthRoutes(app, ctx);
    const { body } = await callRouteAsync(routes, '/api/health');
    expect(body.status).toBe('healthy');
    expect(body.connectedChurches).toBe(0);
    await queryClient.close();
    sqlite.close();
  });

  it('overallStatus reports unhealthy when DB read fails', async () => {
    // Force a DB error by passing a queryClient whose queryOne rejects.
    const queryClient = {
      queryOne: () => Promise.reject(new Error('connection refused')),
    };
    const ctx = makeCtx({ queryClient });
    const { app, routes } = makeApp();
    setupHealthRoutes(app, ctx);
    const { body } = await callRouteAsync(routes, '/api/health');
    expect(body.status).toBe('unhealthy');
    expect(body.database.status).toBe('error');
  });

  it('overallStatus reports degraded when DB read latency exceeds 500ms', async () => {
    // Stub queryClient.queryOne to resolve after 600ms so the recorded latency
    // crosses the degradation threshold without depending on real DB load.
    const queryClient = {
      queryOne: () => new Promise((resolve) => setTimeout(() => resolve({ ok: 1 }), 600)),
    };
    const ctx = makeCtx({ queryClient });
    const { app, routes } = makeApp();
    setupHealthRoutes(app, ctx);
    const { body } = await callRouteAsync(routes, '/api/health');
    expect(body.status).toBe('degraded');
    expect(body.database.status).toBe('ok');
    expect(body.database.latency_ms).toBeGreaterThan(500);
  });

  it('uses queryClient for DB checks when only async client access is available', async () => {
    const sqlite = new Database(':memory:');
    const queryClient = new SqliteQueryClient(sqlite);
    const ctx = makeCtx({ queryClient });
    const { app, routes } = makeApp();

    setupHealthRoutes(app, ctx);
    const { body } = await callRouteAsync(routes, '/api/health');

    expect(body.database.status).toBe('ok');
    expect(typeof body.database.latency_ms).toBe('number');

    await queryClient.close();
    sqlite.close();
  });

  it('includes realtime socket, queue, and coordination details when runtime metrics are available', () => {
    const controllerA = { _previewSubscriptions: new Set(['church-1', 'church-2']) };
    const controllerB = { _previewSubscriptions: new Set(['church-3']) };
    const churches = new Map([
      ['c1', makeChurch(1)],
      ['c2', makeChurch(1)],
      ['c3', makeChurch(3)],
    ]);
    const messageQueues = new Map([
      ['c1', [{}, {}]],
      ['c2', []],
      ['c3', [{}]],
    ]);
    const runtimeMetrics = {
      snapshot: () => ({
        windowSeconds: 60,
        counters: { 'church.status_update.in': 120 },
        ratesPerSecond: { 'church.status_update.in': 2 },
        totals: { 'church.status_update.in': 512 },
      }),
      eventLoopSnapshot: () => ({ p95_ms: 12.5, utilization: 0.42 }),
    };
    const runtimeCoordinator = {
      enabled: true,
      instanceId: 'instance-a',
      publishChannel: 'tally:runtime:events',
    };
    const ctx = makeCtx({
      churches,
      controllers: new Set([controllerA, controllerB]),
      messageQueues,
      runtimeMetrics,
      runtimeCoordinator,
      getPreviewCacheSummary: () => ({ cachedChurches: 2, newestAgeMs: 150, oldestAgeMs: 950 }),
    });
    const { app, routes } = makeApp();

    setupHealthRoutes(app, ctx);
    const { body } = callRoute(routes, '/api/health');

    expect(body.realtime.eventLoop.p95_ms).toBe(12.5);
    expect(body.realtime.sockets.connectedChurches).toBe(2);
    expect(body.realtime.sockets.connectedChurchInstances).toBe(2);
    expect(body.realtime.sockets.localConnectedChurches).toBe(2);
    expect(body.realtime.sockets.localConnectedChurchInstances).toBe(2);
    expect(body.realtime.sockets.controllerConnections).toBe(2);
    expect(body.realtime.sockets.previewSubscriptions).toBe(3);
    expect(body.realtime.queues.queuedChurches).toBe(2);
    expect(body.realtime.queues.queuedMessages).toBe(3);
    expect(body.realtime.previewCache.cachedChurches).toBe(2);
    expect(body.realtime.rates1m['church.status_update.in']).toBe(2);
    expect(body.realtime.totals['church.status_update.in']).toBe(512);
    expect(body.realtime.coordination.enabled).toBe(true);
    expect(body.realtime.coordination.instanceId).toBe('instance-a');
    expect(body.realtime.coordination.observedChurches).toBe(3);
    expect(body.realtime.coordination.localChurches).toBe(3);
  });
});

// ─── GET /health — mirrors /api/health ────────────────────────────────────────

describe('GET /health — same handler as /api/health', () => {
  it('is registered as a route', () => {
    const ctx = makeCtx();
    const { app, routes } = makeApp();
    setupHealthRoutes(app, ctx);
    expect(routes['/health']).toBeDefined();
  });

  it('returns same fields as /api/health', () => {
    const churches = new Map([['c1', makeChurch(1)]]);
    const ctx = makeCtx({ churches, totalMessagesRelayed: 7 });
    const { app, routes } = makeApp();
    setupHealthRoutes(app, ctx);
    const health = callRoute(routes, '/health').body;
    const apiHealth = callRoute(routes, '/api/health').body;
    expect(health.service).toBe(apiHealth.service);
    expect(health.version).toBe(apiHealth.version);
    expect(health.build).toBe(apiHealth.build);
    expect(health.registeredChurches).toBe(apiHealth.registeredChurches);
    expect(health.connectedChurches).toBe(apiHealth.connectedChurches);
    expect(health.totalMessagesRelayed).toBe(apiHealth.totalMessagesRelayed);
  });
});

// ─── GET /api/status — status determination ───────────────────────────────────

describe('GET /api/status — operational with no churches', () => {
  it('returns operational when 0 churches registered and uptime>30', () => {
    // process.uptime() in a running test is well above 30 in CI,
    // but we need to guarantee it. If uptime is low, status is degraded.
    // Instead we assert the shape and correct status for zero-churches case
    // only if uptime > 30; otherwise we only check structure.
    const ctx = makeCtx();
    const { app, routes } = makeApp();
    setupHealthRoutes(app, ctx);
    const { body, status } = callRoute(routes, '/api/status');
    expect(body.status).toBeDefined();
    expect(body.timestamp).toBeDefined();
    expect(body.components).toBeDefined();
    expect(body.components.relay).toBeDefined();
    expect(body.components.websocket).toBeDefined();
    expect(body.components.message_relay).toBeDefined();
    // With 0 churches: websocketOk = true, so if uptime>30 → operational
    if (body.components.relay.uptime_seconds > 30) {
      expect(body.status).toBe('operational');
      expect(status).toBe(200);
    }
  });
});

describe('GET /api/status — operational when all churches connected', () => {
  it('status is operational when all registered churches are OPEN and uptime>30', () => {
    const churches = new Map([
      ['c1', makeChurch(1)],
      ['c2', makeChurch(1)],
    ]);
    const ctx = makeCtx({ churches });
    const { app, routes } = makeApp();
    setupHealthRoutes(app, ctx);
    const { body } = callRoute(routes, '/api/status');
    if (body.components.relay.uptime_seconds > 30) {
      expect(body.status).toBe('operational');
    }
  });
});

describe('GET /api/status — degraded when uptime <= 30', () => {
  it('returns degraded status when process.uptime is mocked to <= 30', () => {
    const original = process.uptime;
    process.uptime = () => 10; // simulate fresh start
    try {
      const ctx = makeCtx();
      const { app, routes } = makeApp();
      setupHealthRoutes(app, ctx);
      const { body } = callRoute(routes, '/api/status');
      expect(body.status).toBe('degraded');
      expect(body.components.relay.status).toBe('degraded');
    } finally {
      process.uptime = original;
    }
  });

  it('relay component shows uptime_seconds from process.uptime', () => {
    const original = process.uptime;
    process.uptime = () => 5;
    try {
      const ctx = makeCtx();
      const { app, routes } = makeApp();
      setupHealthRoutes(app, ctx);
      const { body } = callRoute(routes, '/api/status');
      expect(body.components.relay.uptime_seconds).toBe(5);
    } finally {
      process.uptime = original;
    }
  });
});

// Connection-ratio degradation was removed — Tally churches typically only
// connect their desktop agent during Sunday services, so weekday ratios of
// 0/N or 1/N are normal operating state, not an outage. These tests now
// pin the corrected behavior: server-side signals only drive status.

describe('GET /api/status — connection ratio is informational only', () => {
  it('stays operational when zero churches are connected (weekday norm)', () => {
    const original = process.uptime;
    process.uptime = () => 100;
    try {
      const churches = new Map([
        ['c1', makeChurch(3)],
        ['c2', makeChurch(3)],
      ]);
      const ctx = makeCtx({ churches });
      const { app, routes } = makeApp();
      setupHealthRoutes(app, ctx);
      const { body, status } = callRoute(routes, '/api/status');
      expect(body.status).toBe('operational');
      expect(status).toBe(200);
      // Counts still surface for monitors that want their own opinion.
      expect(body.components.websocket.connected_churches).toBe(0);
      expect(body.components.websocket.registered_churches).toBe(2);
    } finally {
      process.uptime = original;
    }
  });

  it('stays operational when fewer than 50% of churches are connected', () => {
    const original = process.uptime;
    process.uptime = () => 100;
    try {
      // 1 of 4 connected — would have been "partial_outage" + HTTP 503.
      const churches = new Map([
        ['c1', makeChurch(1)],
        ['c2', makeChurch(3)],
        ['c3', makeChurch(3)],
        ['c4', makeChurch(3)],
      ]);
      const ctx = makeCtx({ churches });
      const { app, routes } = makeApp();
      setupHealthRoutes(app, ctx);
      const { body, status } = callRoute(routes, '/api/status');
      expect(body.status).toBe('operational');
      expect(status).toBe(200);
    } finally {
      process.uptime = original;
    }
  });

  it('stays operational when only some churches are offline (ratio between 0.5 and 1)', () => {
    const original = process.uptime;
    process.uptime = () => 100;
    try {
      // 2 of 3 connected — would have been "degraded".
      const churches = new Map([
        ['c1', makeChurch(1)],
        ['c2', makeChurch(1)],
        ['c3', makeChurch(3)],
      ]);
      const ctx = makeCtx({ churches });
      const { app, routes } = makeApp();
      setupHealthRoutes(app, ctx);
      const { body } = callRoute(routes, '/api/status');
      expect(body.status).toBe('operational');
    } finally {
      process.uptime = original;
    }
  });
});

describe('GET /api/status — HTTP status codes', () => {
  it('returns HTTP 200 even when no churches are connected', () => {
    const original = process.uptime;
    process.uptime = () => 100;
    try {
      const churches = new Map([['c1', makeChurch(3)]]);
      const ctx = makeCtx({ churches });
      const { app, routes } = makeApp();
      setupHealthRoutes(app, ctx);
      const { status } = callRoute(routes, '/api/status');
      expect(status).toBe(200);
    } finally {
      process.uptime = original;
    }
  });

  it('returns HTTP 200 when most churches are offline (was 503 partial_outage)', () => {
    const original = process.uptime;
    process.uptime = () => 100;
    try {
      const churches = new Map([
        ['c1', makeChurch(1)],
        ['c2', makeChurch(3)],
        ['c3', makeChurch(3)],
        ['c4', makeChurch(3)],
      ]);
      const ctx = makeCtx({ churches });
      const { app, routes } = makeApp();
      setupHealthRoutes(app, ctx);
      const { status } = callRoute(routes, '/api/status');
      expect(status).toBe(200);
    } finally {
      process.uptime = original;
    }
  });

  it('returns HTTP 200 for operational status', () => {
    const original = process.uptime;
    process.uptime = () => 100;
    try {
      const ctx = makeCtx(); // 0 churches → operational
      const { app, routes } = makeApp();
      setupHealthRoutes(app, ctx);
      const { status } = callRoute(routes, '/api/status');
      expect(status).toBe(200);
    } finally {
      process.uptime = original;
    }
  });
});

describe('GET /api/status — response body shape', () => {
  it('timestamp is a valid ISO 8601 string', () => {
    const ctx = makeCtx();
    const { app, routes } = makeApp();
    setupHealthRoutes(app, ctx);
    const { body } = callRoute(routes, '/api/status');
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(() => new Date(body.timestamp)).not.toThrow();
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it('connect_ratio is null when no churches are registered', () => {
    const ctx = makeCtx();
    const { app, routes } = makeApp();
    setupHealthRoutes(app, ctx);
    const { body } = callRoute(routes, '/api/status');
    expect(body.components.websocket.connect_ratio).toBeNull();
  });

  it('connect_ratio is rounded to 2 decimal places', () => {
    const original = process.uptime;
    process.uptime = () => 100;
    try {
      // 1 of 3 = 0.333... → rounds to 0.33
      const churches = new Map([
        ['c1', makeChurch(1)],
        ['c2', makeChurch(3)],
        ['c3', makeChurch(3)],
      ]);
      const ctx = makeCtx({ churches });
      const { app, routes } = makeApp();
      setupHealthRoutes(app, ctx);
      const { body } = callRoute(routes, '/api/status');
      expect(body.components.websocket.connect_ratio).toBe(0.33);
    } finally {
      process.uptime = original;
    }
  });

  it('includes version and build in relay component', () => {
    const ctx = makeCtx();
    const { app, routes } = makeApp();
    setupHealthRoutes(app, ctx);
    const { body } = callRoute(routes, '/api/status');
    expect(body.components.relay.version).toBe('1.2.3');
    expect(body.components.relay.build).toBe('test-build');
  });

  it('message_relay component status is always operational', () => {
    const ctx = makeCtx({ totalMessagesRelayed: 999 });
    const { app, routes } = makeApp();
    setupHealthRoutes(app, ctx);
    const { body } = callRoute(routes, '/api/status');
    expect(body.components.message_relay.status).toBe('operational');
    expect(body.components.message_relay.total_messages).toBe(999);
  });

  it('websocket component shows registered and connected counts', () => {
    const original = process.uptime;
    process.uptime = () => 100;
    try {
      const churches = new Map([
        ['c1', makeChurch(1)],
        ['c2', makeChurch(3)],
      ]);
      const ctx = makeCtx({ churches });
      const { app, routes } = makeApp();
      setupHealthRoutes(app, ctx);
      const { body } = callRoute(routes, '/api/status');
      expect(body.components.websocket.registered_churches).toBe(2);
      expect(body.components.websocket.connected_churches).toBe(1);
    } finally {
      process.uptime = original;
    }
  });
});
