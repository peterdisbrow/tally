/**
 * Room ID scoping tests for POST /api/admin/church/:churchId/send-command
 *
 * When a roomId is supplied in the request body, the handler must route the
 * command ONLY to the WebSocket for that room's instance — not to other rooms.
 *
 * The runtime structure:
 *   runtime.roomInstanceMap = { roomId → instanceName }
 *   runtime.sockets         = Map<instanceName, ws>  where ws.instanceName === instanceName
 *
 * The response includes `instanceCount` (number of sockets targeted), which is
 * what we assert on — a clean proxy for "did it actually scope to the right room?"
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import { setupAdminPanel } from '../src/adminPanel.js';

// ─── Test infrastructure (minimal, focused on what this suite needs) ──────────

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT DEFAULT '',
      token TEXT, registeredAt TEXT, church_type TEXT DEFAULT 'recurring',
      reseller_id TEXT, audio_via_atem INTEGER DEFAULT 0,
      registration_code TEXT, plan TEXT DEFAULT 'pro',
      billing_status TEXT DEFAULT 'active', timezone TEXT,
      setup_complete INTEGER DEFAULT 1, portal_email TEXT
    )
  `);
  db.exec(`
    CREATE TABLE alerts (
      id TEXT PRIMARY KEY, church_id TEXT NOT NULL, alert_type TEXT NOT NULL,
      severity TEXT NOT NULL, context TEXT DEFAULT '{}', created_at TEXT NOT NULL,
      acknowledged_at TEXT, acknowledged_by TEXT, escalated INTEGER DEFAULT 0,
      resolved INTEGER DEFAULT 0, session_id TEXT
    )
  `);
  db.exec(`
    CREATE TABLE service_sessions (
      id TEXT PRIMARY KEY, church_id TEXT NOT NULL, started_at TEXT NOT NULL,
      ended_at TEXT, duration_minutes INTEGER, stream_ran INTEGER DEFAULT 0,
      stream_runtime_minutes INTEGER DEFAULT 0, recording_confirmed INTEGER DEFAULT 0,
      alert_count INTEGER DEFAULT 0, auto_recovered_count INTEGER DEFAULT 0,
      escalated_count INTEGER DEFAULT 0, audio_silence_count INTEGER DEFAULT 0,
      peak_viewers INTEGER, td_name TEXT, grade TEXT, notes TEXT
    )
  `);
  db.exec(`CREATE TABLE support_tickets (id TEXT PRIMARY KEY, church_id TEXT NOT NULL, triage_id TEXT, issue_category TEXT, severity TEXT, title TEXT, description TEXT, status TEXT DEFAULT 'open', forced_bypass INTEGER DEFAULT 0, diagnostics_json TEXT DEFAULT '{}', created_by TEXT, created_at TEXT, updated_at TEXT)`);
  db.exec(`CREATE TABLE chat_messages (id TEXT PRIMARY KEY, church_id TEXT NOT NULL, session_id TEXT, timestamp TEXT NOT NULL, sender_name TEXT NOT NULL, sender_role TEXT NOT NULL, source TEXT NOT NULL, message TEXT NOT NULL)`);
  db.exec(`CREATE TABLE service_events (id INTEGER PRIMARY KEY AUTOINCREMENT, church_id TEXT NOT NULL, timestamp TEXT NOT NULL, event_type TEXT NOT NULL, details TEXT DEFAULT '', resolved INTEGER DEFAULT 0, resolved_at TEXT, auto_resolved INTEGER DEFAULT 0, session_id TEXT)`);
  db.exec(`CREATE TABLE preservice_check_results (id TEXT PRIMARY KEY, church_id TEXT NOT NULL, session_id TEXT, pass INTEGER DEFAULT 0, checks_json TEXT DEFAULT '[]', trigger_type TEXT DEFAULT 'auto', created_at TEXT NOT NULL)`);
  return db;
}

function seedChurch(db, churchId, name = 'Test Church') {
  db.prepare(`INSERT INTO churches (churchId, name, email, token, registeredAt, plan, billing_status, setup_complete)
    VALUES (?, ?, 'test@test.com', 'tok', '2024-01-01T00:00:00Z', 'pro', 'active', 1)`).run(churchId, name);
}

function createMockApp() {
  const routes = {};
  const handler = (method) => (pathOrArr, ...args) => {
    const paths = Array.isArray(pathOrArr) ? pathOrArr : [pathOrArr];
    for (const path of paths) {
      if (!routes[method]) routes[method] = {};
      routes[method][path] = args;
    }
  };
  return { get: handler('get'), post: handler('post'), put: handler('put'), delete: handler('delete'), patch: handler('patch'), all: handler('all'), routes };
}

function buildRes() {
  const res = {
    _status: 200, _json: null,
    status(code) { res._status = code; return res; },
    json(data) { res._json = data; return res; },
    setHeader() { return res; },
    send(data) { res._json = data; return res; },
  };
  return res;
}

function buildReq(overrides = {}) {
  return { params: {}, body: {}, query: {}, headers: {}, cookies: {}, ip: '127.0.0.1', path: '/api/test', ...overrides };
}

/** Mock WebSocket with an instanceName property for room scoping. */
function makeSocket(instanceName, open = true) {
  return {
    readyState: open ? WebSocket.OPEN : WebSocket.CLOSED,
    instanceName,
    send: () => {},
    close: () => {},
  };
}

// ─── Suite setup ──────────────────────────────────────────────────────────────

const ROUTE = '/api/admin/church/:churchId/send-command';
let db, churches, app;

beforeEach(() => {
  db = createTestDb();
  churches = new Map();
  app = createMockApp();
  process.env.ADMIN_API_KEY = 'test-key';
  setupAdminPanel(app, db, churches, {
    getResellerById: () => null,
    getResellerBySlug: () => null,
    getResellerStats: () => ({}),
    getResellers: () => [],
  }, {
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

async function callRoute(req) {
  const args = app.routes.post?.[ROUTE];
  if (!args) throw new Error(`Route not registered: ${ROUTE}`);
  const handler = args[args.length - 1];
  const res = buildRes();
  await Promise.resolve(handler(req, res));
  return res;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('send-command — room ID scoping', () => {
  it('with roomId targets only the matching instance socket (instanceCount=1)', async () => {
    seedChurch(db, 'c1', 'Grace Church');

    const mainSock  = makeSocket('main-instance');
    const youthSock = makeSocket('youth-instance');
    churches.set('c1', {
      roomInstanceMap: { 'room-main': 'main-instance', 'room-youth': 'youth-instance' },
      sockets: new Map([['main-instance', mainSock], ['youth-instance', youthSock]]),
      status: {},
    });

    const req = buildReq({ params: { churchId: 'c1' }, body: { command: 'restart_stream', roomId: 'room-main' } });
    const res = await callRoute(req);

    expect(res._status).toBe(200);
    expect(res._json.sent).toBe(true);
    expect(res._json.instanceCount).toBe(1);
    expect(res._json.targetedRoom).toBe('room-main');
  });

  it('does NOT route to the other room socket (room-youth stays untouched)', async () => {
    seedChurch(db, 'c1', 'Grace Church');

    const mainSock  = makeSocket('main-instance');
    const youthSock = makeSocket('youth-instance');
    churches.set('c1', {
      roomInstanceMap: { 'room-main': 'main-instance', 'room-youth': 'youth-instance' },
      sockets: new Map([['main-instance', mainSock], ['youth-instance', youthSock]]),
      status: {},
    });

    // Target main — youth must not appear in instanceCount
    const req = buildReq({ params: { churchId: 'c1' }, body: { command: 'restart_stream', roomId: 'room-main' } });
    const res = await callRoute(req);

    expect(res._json.instanceCount).toBe(1);  // only main, not youth
    expect(res._json.targetedRoom).toBe('room-main');
  });

  it('without roomId broadcasts to all open instances (instanceCount=2)', async () => {
    seedChurch(db, 'c1', 'Grace Church');

    const mainSock  = makeSocket('main-instance');
    const youthSock = makeSocket('youth-instance');
    churches.set('c1', {
      roomInstanceMap: { 'room-main': 'main-instance', 'room-youth': 'youth-instance' },
      sockets: new Map([['main-instance', mainSock], ['youth-instance', youthSock]]),
      status: {},
    });

    const req = buildReq({ params: { churchId: 'c1' }, body: { command: 'restart_stream' } });
    const res = await callRoute(req);

    expect(res._status).toBe(200);
    expect(res._json.instanceCount).toBe(2);
    expect(res._json.targetedRoom).toBeNull();
  });

  it('returns 409 when the targeted room instance socket is not open', async () => {
    seedChurch(db, 'c1', 'Grace Church');

    const closedSock = makeSocket('main-instance', false); // CLOSED
    churches.set('c1', {
      roomInstanceMap: { 'room-main': 'main-instance' },
      sockets: new Map([['main-instance', closedSock]]),
      status: {},
    });

    const req = buildReq({ params: { churchId: 'c1' }, body: { command: 'restart_stream', roomId: 'room-main' } });
    const res = await callRoute(req);

    expect(res._status).toBe(409);
    expect(res._json.error).toMatch(/not connected/i);
  });

  it('unknown roomId falls back to broadcast (not an error)', async () => {
    seedChurch(db, 'c1', 'Grace Church');

    const mainSock = makeSocket('main-instance');
    churches.set('c1', {
      roomInstanceMap: { 'room-main': 'main-instance' },
      sockets: new Map([['main-instance', mainSock]]),
      status: {},
    });

    // 'room-unknown' is not in roomInstanceMap → falls through to broadcast
    const req = buildReq({ params: { churchId: 'c1' }, body: { command: 'restart_stream', roomId: 'room-unknown' } });
    const res = await callRoute(req);

    expect(res._status).toBe(200);
    expect(res._json.instanceCount).toBe(1); // broadcast hit main-instance
    // Route echoes back the requested roomId even when falling through to broadcast
    expect(res._json.targetedRoom).toBe('room-unknown');
  });
});
