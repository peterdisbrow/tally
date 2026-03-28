'use strict';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function createTestDb() {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT DEFAULT '',
      token TEXT,
      registeredAt TEXT,
      church_type TEXT DEFAULT 'recurring',
      reseller_id TEXT,
      audio_via_atem INTEGER DEFAULT 0,
      registration_code TEXT,
      plan TEXT,
      billing_status TEXT,
      timezone TEXT,
      setup_complete INTEGER DEFAULT 0,
      portal_email TEXT
    )
  `);

  db.exec(`
    CREATE TABLE alerts (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      alert_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      context TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      acknowledged_at TEXT,
      acknowledged_by TEXT,
      escalated INTEGER DEFAULT 0,
      resolved INTEGER DEFAULT 0,
      session_id TEXT
    )
  `);

  db.exec(`
    CREATE TABLE service_sessions (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_minutes INTEGER,
      stream_ran INTEGER DEFAULT 0,
      stream_runtime_minutes INTEGER DEFAULT 0,
      recording_confirmed INTEGER DEFAULT 0,
      alert_count INTEGER DEFAULT 0,
      auto_recovered_count INTEGER DEFAULT 0,
      escalated_count INTEGER DEFAULT 0,
      audio_silence_count INTEGER DEFAULT 0,
      peak_viewers INTEGER,
      td_name TEXT,
      grade TEXT,
      notes TEXT
    )
  `);

  db.exec(`
    CREATE TABLE support_tickets (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      triage_id TEXT,
      issue_category TEXT,
      severity TEXT,
      title TEXT,
      description TEXT,
      status TEXT DEFAULT 'open',
      forced_bypass INTEGER DEFAULT 0,
      diagnostics_json TEXT DEFAULT '{}',
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT
    )
  `);

  db.exec(`
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      session_id TEXT,
      timestamp TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      sender_role TEXT NOT NULL,
      source TEXT NOT NULL,
      message TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE service_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL,
      details TEXT DEFAULT '',
      resolved INTEGER DEFAULT 0,
      resolved_at TEXT,
      auto_resolved INTEGER DEFAULT 0,
      session_id TEXT
    )
  `);

  db.exec(`
    CREATE TABLE preservice_check_results (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      session_id TEXT,
      pass INTEGER DEFAULT 0,
      checks_json TEXT DEFAULT '[]',
      trigger_type TEXT DEFAULT 'auto',
      created_at TEXT NOT NULL
    )
  `);

  return db;
}

function seedChurch(db, churchId = 'church-1', name = 'Test Church') {
  db.prepare(
    `INSERT INTO churches (churchId, name, email, token, registeredAt, plan, billing_status, timezone, setup_complete)
     VALUES (?, ?, 'test@example.com', 'tok123', '2024-01-01T00:00:00Z', 'pro', 'active', 'America/New_York', 1)`
  ).run(churchId, name);
}

function seedAlerts(db, churchId, count = 5, opts = {}) {
  const severity = opts.severity || 'warning';
  const resolved = opts.resolved ? 1 : 0;
  for (let i = 0; i < count; i++) {
    db.prepare(
      `INSERT INTO alerts (id, church_id, alert_type, severity, created_at, resolved)
       VALUES (?, ?, 'test_alert', ?, datetime('now', ?), ?)`
    ).run(`alert-${churchId}-${i}`, churchId, severity, `-${i} minutes`, resolved);
  }
}

function seedSessions(db, churchId, count = 3) {
  for (let i = 0; i < count; i++) {
    db.prepare(
      `INSERT INTO service_sessions (id, church_id, started_at, ended_at, duration_minutes, alert_count, grade)
       VALUES (?, ?, datetime('now', ?), datetime('now', ?), 60, ?, ?)`
    ).run(`session-${churchId}-${i}`, churchId, `-${(i + 1) * 120} minutes`, `-${i * 120 + 60} minutes`, i, 'A');
  }
}

function seedTickets(db, churchId, count = 3) {
  for (let i = 0; i < count; i++) {
    db.prepare(
      `INSERT INTO support_tickets (id, church_id, title, status, severity, issue_category, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'P2', 'other', datetime('now', ?), datetime('now', ?))`
    ).run(`ticket-${churchId}-${i}`, churchId, `Ticket ${i}`, i === 0 ? 'open' : 'resolved', `-${i} hours`, `-${i} hours`);
  }
}

function seedChatMessages(db, churchId, count = 5) {
  for (let i = 0; i < count; i++) {
    db.prepare(
      `INSERT INTO chat_messages (id, church_id, session_id, timestamp, sender_name, sender_role, source, message)
       VALUES (?, ?, NULL, datetime('now', ?), 'Admin', 'admin', 'dashboard', ?)`
    ).run(`msg-${churchId}-${i}`, churchId, `-${i} minutes`, `Test message ${i}`);
  }
}

// Mock WebSocket
function createMockWs(open = true) {
  return { readyState: open ? WebSocket.OPEN : WebSocket.CLOSED, send: vi.fn(), close: vi.fn() };
}
/** Build a mock church entry with both ws and sockets (multi-instance compat). */
function mockChurchEntry(wsOrOpen, extra = {}) {
  const ws = typeof wsOrOpen === 'object' ? wsOrOpen : createMockWs(wsOrOpen);
  return { ws, sockets: new Map([['_default', ws]]), status: {}, ...extra };
}

// Minimal app mock that captures route registrations
function createMockApp() {
  const routes = {};
  const handler = (method) => (pathOrArr, ...args) => {
    const paths = Array.isArray(pathOrArr) ? pathOrArr : [pathOrArr];
    for (const path of paths) {
      if (!routes[method]) routes[method] = {};
      routes[method][path] = args;
    }
  };
  return {
    get: handler('get'),
    post: handler('post'),
    put: handler('put'),
    delete: handler('delete'),
    all: handler('all'),
    routes,
  };
}

function buildReq(overrides = {}) {
  return {
    params: {},
    body: {},
    query: {},
    headers: {},
    cookies: {},
    ip: '127.0.0.1',
    path: '/api/test',
    ...overrides,
  };
}

function buildRes() {
  const res = {
    _status: 200,
    _json: null,
    _headers: {},
    _redirectUrl: null,
    _sent: null,
    status(code) { res._status = code; return res; },
    json(data) { res._json = data; return res; },
    setHeader(k, v) { res._headers[k] = v; return res; },
    redirect(a, b) { res._redirectUrl = b || a; return res; },
    send(data) { res._sent = data; return res; },
  };
  return res;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

// We test by importing setupAdminPanel and calling it with mocked dependencies,
// then extracting the registered route handlers.

const { setupAdminPanel } = await import('../src/adminPanel.js');

describe('Admin Support View (Quick Actions)', () => {
  let db, churches, app, resellerSystem;

  beforeEach(() => {
    db = createTestDb();
    churches = new Map();
    resellerSystem = {
      getResellerById: () => null,
      getResellerBySlug: () => null,
      getResellerStats: () => ({}),
      getResellers: () => [],
    };
    app = createMockApp();

    // Set env vars for auth bypass
    process.env.ADMIN_API_KEY = 'test-key';

    setupAdminPanel(app, db, churches, resellerSystem, {
      jwt: { verify: () => ({ type: 'admin', userId: 'u1', email: 'a@b.com', name: 'Admin', role: 'super_admin' }) },
      JWT_SECRET: 'test-secret',
      lifecycleEmails: null,
      logAudit: () => {},
      chatEngine: null,
    });
  });

  afterEach(() => {
    db.close();
    delete process.env.ADMIN_API_KEY;
  });

  // Helper to call a route handler, bypassing auth middleware (first arg is requireAdminSession)
  function callRoute(method, path, req) {
    const args = app.routes[method]?.[path];
    if (!args) throw new Error(`Route not found: ${method} ${path}`);
    // The last arg is the handler, preceding args are middlewares
    const handler = args[args.length - 1];
    const res = buildRes();
    handler(req, res);
    return res;
  }

  // ── Support View Tests ──────────────────────────────────────────────────────

  describe('GET /api/admin/church/:churchId/support-view', () => {
    const routePath = '/api/admin/church/:churchId/support-view';

    it('returns all expected sections for a valid church', () => {
      seedChurch(db, 'c1', 'Grace Church');
      seedAlerts(db, 'c1', 3);
      seedSessions(db, 'c1', 2);
      seedTickets(db, 'c1', 2);
      seedChatMessages(db, 'c1', 3);

      const req = buildReq({ params: { churchId: 'c1' } });
      const res = callRoute('get', routePath, req);

      expect(res._status).toBe(200);
      const data = res._json;
      expect(data).toHaveProperty('church');
      expect(data).toHaveProperty('status');
      expect(data).toHaveProperty('healthScore');
      expect(data).toHaveProperty('recentAlerts');
      expect(data).toHaveProperty('recentSessions');
      expect(data).toHaveProperty('recentTickets');
      expect(data).toHaveProperty('lastDiagnosticBundle');
      expect(data).toHaveProperty('chatHistory');
      expect(data).toHaveProperty('config');
    });

    it('returns church info fields correctly', () => {
      seedChurch(db, 'c1', 'Grace Church');
      const req = buildReq({ params: { churchId: 'c1' } });
      const res = callRoute('get', routePath, req);

      expect(res._json.church.id).toBe('c1');
      expect(res._json.church.name).toBe('Grace Church');
      expect(res._json.church.plan).toBe('pro');
      expect(res._json.church.timezone).toBe('America/New_York');
      expect(res._json.church.setup_complete).toBe(true);
    });

    it('includes health score in the response', () => {
      seedChurch(db, 'c1', 'Grace Church');
      const req = buildReq({ params: { churchId: 'c1' } });
      const res = callRoute('get', routePath, req);

      expect(res._json.healthScore).toHaveProperty('score');
      // Score can be null (new church with no data) or a number 0-100
      if (res._json.healthScore.score !== null) {
        expect(typeof res._json.healthScore.score).toBe('number');
        expect(res._json.healthScore.score).toBeGreaterThanOrEqual(0);
        expect(res._json.healthScore.score).toBeLessThanOrEqual(100);
      } else {
        expect(res._json.healthScore.score).toBeNull();
      }
    });

    it('limits recent alerts to 20', () => {
      seedChurch(db, 'c1', 'Grace Church');
      seedAlerts(db, 'c1', 30);
      const req = buildReq({ params: { churchId: 'c1' } });
      const res = callRoute('get', routePath, req);

      expect(res._json.recentAlerts.length).toBeLessThanOrEqual(20);
    });

    it('limits chat history to 20', () => {
      seedChurch(db, 'c1', 'Grace Church');
      seedChatMessages(db, 'c1', 30);
      const req = buildReq({ params: { churchId: 'c1' } });
      const res = callRoute('get', routePath, req);

      expect(res._json.chatHistory.length).toBeLessThanOrEqual(20);
    });

    it('handles missing church gracefully', () => {
      const req = buildReq({ params: { churchId: 'nonexistent' } });
      const res = callRoute('get', routePath, req);

      expect(res._status).toBe(404);
      expect(res._json.error).toMatch(/not found/i);
    });

    it('shows online status when church client is connected', () => {
      seedChurch(db, 'c1', 'Grace Church');
      churches.set('c1', mockChurchEntry(true, {
        status: { atem: { connected: true }, obs: { connected: true } },
        lastSeen: new Date().toISOString(),
        lastHeartbeat: Date.now(),
      }));

      const req = buildReq({ params: { churchId: 'c1' } });
      const res = callRoute('get', routePath, req);

      expect(res._json.status.online).toBe(true);
      expect(res._json.status.connectedDevices.atem).toBe(true);
      expect(res._json.status.connectedDevices.obs).toBe(true);
    });

    it('shows offline status when church client is disconnected', () => {
      seedChurch(db, 'c1', 'Grace Church');
      // No runtime entry means offline
      const req = buildReq({ params: { churchId: 'c1' } });
      const res = callRoute('get', routePath, req);

      expect(res._json.status.online).toBe(false);
    });
  });

  // ── Send Command Tests ──────────────────────────────────────────────────────

  describe('POST /api/admin/church/:churchId/send-command', () => {
    const routePath = '/api/admin/church/:churchId/send-command';

    it('validates allowed commands and sends via WebSocket', () => {
      seedChurch(db, 'c1', 'Grace Church');
      const ws = createMockWs(true);
      churches.set('c1', { ws, sockets: new Map([['_default', ws]]), status: {}, lastSeen: null, lastHeartbeat: null });

      const req = buildReq({ params: { churchId: 'c1' }, body: { command: 'restart_stream' } });
      const res = callRoute('post', routePath, req);

      expect(res._status).toBe(200);
      expect(res._json.sent).toBe(true);
      expect(res._json.commandId).toBeTruthy();
      expect(ws.send).toHaveBeenCalledOnce();

      const sentPayload = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sentPayload.type).toBe('command');
      expect(sentPayload.command).toBe('restart_stream');
    });

    it('rejects unknown commands', () => {
      seedChurch(db, 'c1', 'Grace Church');
      churches.set('c1', mockChurchEntry(true));

      const req = buildReq({ params: { churchId: 'c1' }, body: { command: 'delete_everything' } });
      const res = callRoute('post', routePath, req);

      expect(res._status).toBe(400);
      expect(res._json.error).toMatch(/Unknown command/i);
    });

    it('rejects when no command provided', () => {
      seedChurch(db, 'c1', 'Grace Church');
      churches.set('c1', mockChurchEntry(true));

      const req = buildReq({ params: { churchId: 'c1' }, body: {} });
      const res = callRoute('post', routePath, req);

      expect(res._status).toBe(400);
      expect(res._json.error).toMatch(/command required/i);
    });

    it('returns 409 when church client is not connected', () => {
      seedChurch(db, 'c1', 'Grace Church');
      // Church exists but no runtime / offline WebSocket
      const req = buildReq({ params: { churchId: 'c1' }, body: { command: 'restart_stream' } });
      const res = callRoute('post', routePath, req);

      expect(res._status).toBe(409);
      expect(res._json.error).toMatch(/not connected/i);
    });

    it('returns 404 for nonexistent church', () => {
      const req = buildReq({ params: { churchId: 'fake' }, body: { command: 'restart_stream' } });
      const res = callRoute('post', routePath, req);

      expect(res._status).toBe(404);
    });

    it('accepts all allowed command types', () => {
      seedChurch(db, 'c1', 'Grace Church');
      const ws = createMockWs(true);
      churches.set('c1', { ws, sockets: new Map([['_default', ws]]), status: {} });

      const allowed = [
        'restart_stream', 'stop_stream', 'start_recording', 'stop_recording',
        'reconnect_obs', 'reconnect_atem', 'reconnect_encoder', 'restart_encoder',
        'system.diagnosticBundle', 'system.preServiceCheck',
      ];

      for (const cmd of allowed) {
        ws.send.mockClear();
        const req = buildReq({ params: { churchId: 'c1' }, body: { command: cmd } });
        const res = callRoute('post', routePath, req);
        expect(res._status).toBe(200);
        expect(res._json.sent).toBe(true);
      }
    });
  });

  // ── Send Message Tests ──────────────────────────────────────────────────────

  describe('POST /api/admin/church/:churchId/send-message', () => {
    const routePath = '/api/admin/church/:churchId/send-message';

    it('sends a message and returns success', () => {
      seedChurch(db, 'c1', 'Grace Church');
      churches.set('c1', mockChurchEntry(true));

      const req = buildReq({ params: { churchId: 'c1' }, body: { message: 'Try restarting OBS', targets: ['app'] } });
      const res = callRoute('post', routePath, req);

      expect(res._status).toBe(200);
      expect(res._json.sent).toBe(true);
      expect(res._json.targets).toContain('app');
    });

    it('rejects empty message', () => {
      seedChurch(db, 'c1', 'Grace Church');

      const req = buildReq({ params: { churchId: 'c1' }, body: { message: '' } });
      const res = callRoute('post', routePath, req);

      expect(res._status).toBe(400);
      expect(res._json.error).toMatch(/message required/i);
    });

    it('rejects missing message', () => {
      seedChurch(db, 'c1', 'Grace Church');

      const req = buildReq({ params: { churchId: 'c1' }, body: {} });
      const res = callRoute('post', routePath, req);

      expect(res._status).toBe(400);
    });

    it('returns 404 for nonexistent church', () => {
      const req = buildReq({ params: { churchId: 'fake' }, body: { message: 'hello' } });
      const res = callRoute('post', routePath, req);

      expect(res._status).toBe(404);
    });

    it('dispatches to chat engine when available', () => {
      const mockChatEngine = {
        saveMessage: vi.fn().mockReturnValue({ id: 'msg-1', church_id: 'c1', source: 'dashboard', message: 'hello' }),
        broadcastChat: vi.fn(),
        getMessages: vi.fn().mockReturnValue([]),
      };

      // Re-setup with chatEngine
      const app2 = createMockApp();
      setupAdminPanel(app2, db, churches, resellerSystem, {
        jwt: { verify: () => ({ type: 'admin', userId: 'u1', email: 'a@b.com', name: 'Admin', role: 'super_admin' }) },
        JWT_SECRET: 'test-secret',
        lifecycleEmails: null,
        logAudit: () => {},
        chatEngine: mockChatEngine,
      });

      seedChurch(db, 'c2', 'Another Church');
      const args = app2.routes.post[routePath];
      const handler = args[args.length - 1];
      const req = buildReq({ params: { churchId: 'c2' }, body: { message: 'Check your OBS', targets: ['app', 'telegram'] } });
      const res = buildRes();
      handler(req, res);

      expect(res._status).toBe(200);
      expect(mockChatEngine.saveMessage).toHaveBeenCalledOnce();
      expect(mockChatEngine.broadcastChat).toHaveBeenCalledOnce();
      expect(mockChatEngine.saveMessage.mock.calls[0][0]).toMatchObject({
        churchId: 'c2',
        senderRole: 'admin',
        source: 'dashboard',
        message: 'Check your OBS',
      });
    });
  });

  // ── Support Overview Tests ──────────────────────────────────────────────────

  describe('GET /api/admin/churches/support-overview', () => {
    const routePath = '/api/admin/churches/support-overview';

    it('returns churches array', () => {
      seedChurch(db, 'c1', 'Grace Church');
      seedChurch(db, 'c2', 'Hope Church');

      const req = buildReq();
      const res = callRoute('get', routePath, req);

      expect(res._status).toBe(200);
      expect(res._json.churches).toBeInstanceOf(Array);
      expect(res._json.churches).toHaveLength(2);
    });

    it('sorts by attention needed: offline first, then lowest health, then most alerts', () => {
      seedChurch(db, 'c1', 'Online Church');
      seedChurch(db, 'c2', 'Offline Church');

      // c1 is online
      churches.set('c1', mockChurchEntry(true, { lastSeen: new Date().toISOString() }));
      // c2 has no runtime (offline)

      const req = buildReq();
      const res = callRoute('get', routePath, req);

      const names = res._json.churches.map(c => c.name);
      expect(names[0]).toBe('Offline Church');
      expect(names[1]).toBe('Online Church');
    });

    it('marks needsAttention for offline churches', () => {
      seedChurch(db, 'c1', 'Offline Church');
      // No runtime entry at all -> offline, no lastSeen -> offlineTooLong = true

      const req = buildReq();
      const res = callRoute('get', routePath, req);

      const c = res._json.churches.find(ch => ch.name === 'Offline Church');
      expect(c.needsAttention).toBe(true);
      expect(c.attentionReason).toMatch(/offline/i);
    });

    it('marks needsAttention for churches with critical alerts', () => {
      seedChurch(db, 'c1', 'Alerting Church');
      seedAlerts(db, 'c1', 2, { severity: 'critical', resolved: false });
      churches.set('c1', mockChurchEntry(true, { lastSeen: new Date().toISOString() }));

      const req = buildReq();
      const res = callRoute('get', routePath, req);

      const c = res._json.churches.find(ch => ch.name === 'Alerting Church');
      expect(c.needsAttention).toBe(true);
      expect(c.attentionReason).toMatch(/critical/i);
    });

    it('marks needsAttention for churches with open tickets', () => {
      seedChurch(db, 'c1', 'Ticket Church');
      seedTickets(db, 'c1', 1);
      churches.set('c1', mockChurchEntry(true, { lastSeen: new Date().toISOString() }));

      const req = buildReq();
      const res = callRoute('get', routePath, req);

      const c = res._json.churches.find(ch => ch.name === 'Ticket Church');
      expect(c.needsAttention).toBe(true);
      expect(c.attentionReason).toMatch(/ticket/i);
    });

    it('includes healthScore and activeAlerts per church', () => {
      seedChurch(db, 'c1', 'Grace Church');
      seedAlerts(db, 'c1', 3, { resolved: false });

      const req = buildReq();
      const res = callRoute('get', routePath, req);

      const c = res._json.churches[0];
      // healthScore can be null (new church) or a number
      expect(c.healthScore === null || typeof c.healthScore === 'number').toBe(true);
      expect(typeof c.activeAlerts).toBe('number');
      expect(c.activeAlerts).toBe(3);
    });
  });

  // ── Auth Tests ──────────────────────────────────────────────────────────────

  describe('Auth required on all endpoints', () => {
    it('registers support-view route with requireAdminSession', () => {
      const args = app.routes.get['/api/admin/church/:churchId/support-view'];
      expect(args).toBeDefined();
      // First arg should be the middleware (requireAdminSession), second is the handler
      expect(args.length).toBe(2);
    });

    it('registers send-command route with requireAdminSession', () => {
      const args = app.routes.post['/api/admin/church/:churchId/send-command'];
      expect(args).toBeDefined();
      expect(args.length).toBe(2);
    });

    it('registers send-message route with requireAdminSession', () => {
      const args = app.routes.post['/api/admin/church/:churchId/send-message'];
      expect(args).toBeDefined();
      expect(args.length).toBe(2);
    });

    it('registers support-overview route with requireAdminSession', () => {
      const args = app.routes.get['/api/admin/churches/support-overview'];
      expect(args).toBeDefined();
      expect(args.length).toBe(2);
    });

    it('requireAdminSession rejects unauthorized requests', () => {
      // Call the middleware directly (first arg in route registration)
      const args = app.routes.get['/api/admin/church/:churchId/support-view'];
      const middleware = args[0];
      const req = buildReq({ path: '/api/admin/church/c1/support-view', headers: {}, cookies: {} });
      const res = buildRes();
      let nextCalled = false;
      // Remove ADMIN_API_KEY so auth fails
      delete process.env.ADMIN_API_KEY;
      middleware(req, res, () => { nextCalled = true; });
      expect(nextCalled).toBe(false);
      expect(res._status).toBe(401);
    });
  });
});
