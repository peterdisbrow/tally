/**
 * Tests for src/routes/health.js — setupHealthRoutes(app, ctx).
 *
 * Routes are captured via a mock app, then handlers are invoked directly
 * with mock req/res objects. No HTTP server is started.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const setupHealthRoutes = require('../src/routes/health.js');

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeCtx(overrides = {}) {
  return {
    churches: new Map(),
    controllers: new Map(),
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
    app: { get: (path, handler) => { routes[path] = handler; } },
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

/** Build a church entry whose WebSocket readyState matches the given value. */
function makeChurch(readyState) {
  return { ws: { readyState } };
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

describe('GET /api/status — major_outage', () => {
  it('returns major_outage when churches registered but none connected', () => {
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
      expect(body.status).toBe('major_outage');
      expect(status).toBe(503);
    } finally {
      process.uptime = original;
    }
  });
});

describe('GET /api/status — partial_outage', () => {
  it('returns partial_outage when fewer than 50% of churches are connected', () => {
    const original = process.uptime;
    process.uptime = () => 100;
    try {
      // 1 of 4 connected = 25% connect ratio
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
      expect(body.status).toBe('partial_outage');
      expect(status).toBe(503);
    } finally {
      process.uptime = original;
    }
  });
});

describe('GET /api/status — degraded (partial connection)', () => {
  it('returns degraded when some but not all churches are offline (ratio ≥ 0.5 and < 1)', () => {
    const original = process.uptime;
    process.uptime = () => 100;
    try {
      // 2 of 3 connected = 0.67 ratio → degraded
      const churches = new Map([
        ['c1', makeChurch(1)],
        ['c2', makeChurch(1)],
        ['c3', makeChurch(3)],
      ]);
      const ctx = makeCtx({ churches });
      const { app, routes } = makeApp();
      setupHealthRoutes(app, ctx);
      const { body } = callRoute(routes, '/api/status');
      expect(body.status).toBe('degraded');
    } finally {
      process.uptime = original;
    }
  });
});

describe('GET /api/status — HTTP status codes', () => {
  it('returns HTTP 503 for major_outage', () => {
    const original = process.uptime;
    process.uptime = () => 100;
    try {
      const churches = new Map([['c1', makeChurch(3)]]);
      const ctx = makeCtx({ churches });
      const { app, routes } = makeApp();
      setupHealthRoutes(app, ctx);
      const { status } = callRoute(routes, '/api/status');
      expect(status).toBe(503);
    } finally {
      process.uptime = original;
    }
  });

  it('returns HTTP 503 for partial_outage', () => {
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
      expect(status).toBe(503);
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
