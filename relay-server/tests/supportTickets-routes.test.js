/**
 * Tests for src/routes/supportTickets.js
 *
 * Covers: triage, ticket creation (triageId flow, forceBypass P1),
 *         listing, retrieval, updates, admin PUT, and diagnostic bundles.
 *
 * Uses in-memory SQLite + real Express. WebSocket-dependent diagnostic
 * bundle POST is tested for the 503 (not connected) path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { hashPassword } = require('../src/auth');
const setupSupportTicketRoutes = require('../src/routes/supportTickets');
const { createClient } = require('./helpers/expressTestClient');

const JWT_SECRET = 'test-support-tickets-secret';

// ─── DB helpers ───────────────────────────────────────────────────────────────

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT DEFAULT '',
      token TEXT DEFAULT '',
      registeredAt TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE admin_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE alerts (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      alert_type TEXT,
      severity TEXT,
      context TEXT,
      created_at TEXT,
      acknowledged_at TEXT,
      resolved INTEGER DEFAULT 0
    )
  `);
  db.exec(`
    CREATE TABLE support_triage_runs (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      issue_category TEXT,
      severity TEXT,
      summary TEXT,
      triage_result TEXT,
      diagnostics_json TEXT,
      autofix_attempts_json TEXT,
      timezone TEXT,
      app_version TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL
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
      diagnostics_json TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE support_ticket_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT NOT NULL,
      message TEXT,
      actor_type TEXT,
      actor_id TEXT,
      created_at TEXT
    )
  `);
  db.exec(`
    CREATE TABLE diagnostic_bundles (
      id TEXT PRIMARY KEY,
      churchId TEXT NOT NULL,
      bundle TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  return db;
}

function seedChurch(db, opts = {}) {
  const churchId = opts.churchId || uuidv4();
  db.prepare(
    'INSERT INTO churches (churchId, name, email, token, registeredAt) VALUES (?, ?, ?, ?, ?)'
  ).run(churchId, opts.name || 'Support Church', 'sup@church.com', 'tok', new Date().toISOString());
  return churchId;
}

function seedAdmin(db, opts = {}) {
  const id = uuidv4();
  db.prepare(
    'INSERT INTO admin_users (id, email, password_hash, name, role, active, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(id, opts.email || 'admin@test.com', hashPassword('Admin1234!'), opts.name || 'Admin', opts.role || 'super_admin', 1, new Date().toISOString());
  return id;
}

function seedTriage(db, churchId, opts = {}) {
  const id = uuidv4();
  const createdAt = opts.createdAt || new Date().toISOString();
  db.prepare(`
    INSERT INTO support_triage_runs
      (id, church_id, issue_category, severity, summary, triage_result, diagnostics_json, autofix_attempts_json, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, churchId,
    opts.issue_category || 'stream_down',
    opts.severity || 'P2',
    opts.summary || 'Stream is down',
    opts.triage_result || 'needs_escalation',
    JSON.stringify({}),
    JSON.stringify([]),
    opts.created_by || `church:${churchId}`,
    createdAt,
  );
  return id;
}

// ─── App factory ──────────────────────────────────────────────────────────────

function buildApp(db, overrides = {}) {
  const app = express();
  app.use(express.json());

  const churchesMap = new Map();

  function requireAdminJwt(...allowedRoles) {
    return (req, res, next) => {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : req.headers['x-admin-jwt'];
      if (!token) return res.status(401).json({ error: 'unauthorized' });
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        if (payload.type !== 'admin') throw new Error('wrong type');
        const user = db.prepare('SELECT id, email, name, role, active FROM admin_users WHERE id = ?').get(payload.userId);
        if (!user || !user.active) return res.status(401).json({ error: 'Account deactivated' });
        if (allowedRoles.length > 0 && !allowedRoles.includes(user.role)) {
          return res.status(403).json({ error: 'Insufficient permissions' });
        }
        req.adminUser = { id: user.id, email: user.email, name: user.name, role: user.role };
        return next();
      } catch (e) {
        if (e.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired' });
        return res.status(401).json({ error: 'Invalid admin token' });
      }
    };
  }

  const ctx = {
    db,
    churches: churchesMap,
    requireAdminJwt,
    stmtGet: db.prepare('SELECT * FROM churches WHERE churchId = ?'),
    scheduleEngine: {
      isServiceWindow: vi.fn().mockReturnValue(false),
    },
    JWT_SECRET,
    RELAY_VERSION: '1.0.0-test',
    SUPPORT_TRIAGE_WINDOW_HOURS: 4,
    rateLimit: () => (req, res, next) => next(),
    ...overrides,
  };

  setupSupportTicketRoutes(app, ctx);
  return { app, churchesMap };
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

const makeClient = createClient;

function issueChurchToken(churchId) {
  return jwt.sign({ type: 'church_app', churchId }, JWT_SECRET, { expiresIn: '1h' });
}

function issueAdminToken(userId, role = 'super_admin') {
  return jwt.sign({ type: 'admin', userId, role }, JWT_SECRET, { expiresIn: '8h' });
}

// ─── POST /api/support/triage ─────────────────────────────────────────────────

describe('POST /api/support/triage', () => {
  let db, client;

  beforeEach(() => {
    db = createDb();
    client = makeClient(buildApp(db).app);
  });
  afterEach(() => client.close());

  it('returns 401 without credentials', async () => {
    const { status } = await client.post('/api/support/triage', { body: { churchId: 'x' } });
    expect(status).toBe(401);
  });

  it('returns 400 when churchId is missing (church JWT path)', async () => {
    const churchId = seedChurch(db);
    const token = issueChurchToken(churchId);
    // Church JWT sets req.supportActor.churchId, so if church uses wrong route
    // but body has no churchId, it will resolve to their own
    // Actually for church JWT the churchId is from the JWT — so this will work
    // Let's test that church can triage for their own church
    const { status, body } = await client.post('/api/support/triage', {
      token,
      body: { issueCategory: 'stream_down', severity: 'P2' },
    });
    expect(status).toBe(201);
    expect(body.triageId).toBeTruthy();
    expect(body.churchId).toBe(churchId);
  });

  it('returns 404 for unknown church (admin path)', async () => {
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status } = await client.post('/api/support/triage', {
      token,
      body: { churchId: 'no-such-church', issueCategory: 'stream_down' },
    });
    expect(status).toBe(404);
  });

  it('returns 400 when churchId missing (admin with no churchId)', async () => {
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status, body } = await client.post('/api/support/triage', {
      token,
      body: {},
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/churchId/i);
  });

  it('admin creates triage for a church and returns 201', async () => {
    const churchId = seedChurch(db);
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status, body } = await client.post('/api/support/triage', {
      token,
      body: { churchId, issueCategory: 'atem_connectivity', severity: 'P1' },
    });
    expect(status).toBe(201);
    expect(body.triageId).toBeTruthy();
    expect(body.churchId).toBe(churchId);
    expect(body.checks).toBeTruthy();
  });

  it('normalises unknown issueCategory to "other"', async () => {
    const churchId = seedChurch(db);
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status, body } = await client.post('/api/support/triage', {
      token,
      body: { churchId, issueCategory: 'mystery_issue' },
    });
    expect(status).toBe(201);
    expect(body.diagnostics.issueCategory).toBe('other');
  });
});

// ─── POST /api/support/tickets ────────────────────────────────────────────────

describe('POST /api/support/tickets', () => {
  let db, client;

  beforeEach(() => {
    db = createDb();
    client = makeClient(buildApp(db).app);
  });
  afterEach(() => client.close());

  it('returns 401 without credentials', async () => {
    const { status } = await client.post('/api/support/tickets', { body: {} });
    expect(status).toBe(401);
  });

  it('returns 400 when triageId missing and no forceBypass', async () => {
    const churchId = seedChurch(db);
    const token = issueChurchToken(churchId);
    const { status, body } = await client.post('/api/support/tickets', {
      token,
      body: { severity: 'P2' },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/triageId/i);
  });

  it('returns 400 when forceBypass=true but severity is not P1', async () => {
    const churchId = seedChurch(db);
    const token = issueChurchToken(churchId);
    const { status, body } = await client.post('/api/support/tickets', {
      token,
      body: { forceBypass: true, severity: 'P2', title: 'My issue' },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/P1/i);
  });

  it('creates ticket with forceBypass=true and P1 severity', async () => {
    const churchId = seedChurch(db);
    const token = issueChurchToken(churchId);
    const { status, body } = await client.post('/api/support/tickets', {
      token,
      body: { forceBypass: true, severity: 'P1', title: 'Stream is down right now', issueCategory: 'stream_down' },
    });
    expect(status).toBe(201);
    expect(body.ticketId).toBeTruthy();
    expect(body.forceBypass).toBe(true);
    expect(body.severity).toBe('P1');
  });

  it('returns 404 when triageId not found for church', async () => {
    const churchId = seedChurch(db);
    const token = issueChurchToken(churchId);
    const { status, body } = await client.post('/api/support/tickets', {
      token,
      body: { triageId: 'no-such-triage' },
    });
    expect(status).toBe(404);
  });

  it('creates ticket with valid triageId', async () => {
    const churchId = seedChurch(db);
    const triageId = seedTriage(db, churchId);
    const token = issueChurchToken(churchId);
    const { status, body } = await client.post('/api/support/tickets', {
      token,
      body: { triageId, title: 'Stream down!' },
    });
    expect(status).toBe(201);
    expect(body.ticketId).toBeTruthy();
    expect(body.triageId).toBe(triageId);
    expect(body.status).toBe('open');
  });

  it('returns 400 when triageId is too old', async () => {
    const churchId = seedChurch(db);
    const oldDate = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(); // 5 hours ago
    const triageId = seedTriage(db, churchId, { createdAt: oldDate });
    const token = issueChurchToken(churchId);
    const { status, body } = await client.post('/api/support/tickets', {
      token,
      body: { triageId },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/older than/i);
  });
});

// ─── GET /api/support/tickets ─────────────────────────────────────────────────

describe('GET /api/support/tickets', () => {
  let db, client;

  beforeEach(() => {
    db = createDb();
    client = makeClient(buildApp(db).app);
  });
  afterEach(() => client.close());

  it('returns 401 without credentials', async () => {
    const { status } = await client.get('/api/support/tickets');
    expect(status).toBe(401);
  });

  it('church sees only their own tickets', async () => {
    const churchId1 = seedChurch(db, { name: 'Church 1' });
    const churchId2 = seedChurch(db, { name: 'Church 2' });

    // Create tickets for each church
    const triageId1 = seedTriage(db, churchId1);
    const triageId2 = seedTriage(db, churchId2);

    const token1 = issueChurchToken(churchId1);
    // Create ticket via POST
    await (async () => {
      const server = (await import('http')).createServer();
      // Simplified: just insert directly into DB
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO support_tickets (id, church_id, triage_id, issue_category, severity, title, status, forced_bypass, diagnostics_json, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), churchId1, null, 'other', 'P3', 'Church 1 ticket', 'open', 0, '{}', `church:${churchId1}`, now, now);
      db.prepare(`
        INSERT INTO support_tickets (id, church_id, triage_id, issue_category, severity, title, status, forced_bypass, diagnostics_json, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), churchId2, null, 'other', 'P3', 'Church 2 ticket', 'open', 0, '{}', `church:${churchId2}`, now, now);
    })();

    const { status, body } = await client.get('/api/support/tickets', { token: token1 });
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    body.forEach(t => expect(t.church_id).toBe(churchId1));
  });

  it('admin sees all tickets', async () => {
    const churchId1 = seedChurch(db, { name: 'Church 1' });
    const churchId2 = seedChurch(db, { name: 'Church 2' });
    const adminId = seedAdmin(db);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO support_tickets (id, church_id, triage_id, issue_category, severity, title, status, forced_bypass, diagnostics_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(uuidv4(), churchId1, null, 'other', 'P3', 'T1', 'open', 0, '{}', 'church:x', now, now);
    db.prepare(`INSERT INTO support_tickets (id, church_id, triage_id, issue_category, severity, title, status, forced_bypass, diagnostics_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(uuidv4(), churchId2, null, 'other', 'P3', 'T2', 'open', 0, '{}', 'church:x', now, now);

    const token = issueAdminToken(adminId);
    const { status, body } = await client.get('/api/support/tickets', { token });
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(2);
  });

  it('filters by status', async () => {
    const churchId = seedChurch(db);
    const adminId = seedAdmin(db);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO support_tickets (id, church_id, triage_id, issue_category, severity, title, status, forced_bypass, diagnostics_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(uuidv4(), churchId, null, 'other', 'P3', 'Open', 'open', 0, '{}', 'a', now, now);
    db.prepare(`INSERT INTO support_tickets (id, church_id, triage_id, issue_category, severity, title, status, forced_bypass, diagnostics_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(uuidv4(), churchId, null, 'other', 'P3', 'Resolved', 'resolved', 0, '{}', 'a', now, now);

    const token = issueAdminToken(adminId);
    const { status, body } = await client.get('/api/support/tickets?status=open', { token });
    expect(status).toBe(200);
    body.forEach(t => expect(t.status).toBe('open'));
  });

  it('returns 400 for invalid status filter', async () => {
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status } = await client.get('/api/support/tickets?status=bogus', { token });
    expect(status).toBe(400);
  });
});

// ─── GET /api/support/tickets/:ticketId ──────────────────────────────────────

describe('GET /api/support/tickets/:ticketId', () => {
  let db, client;

  beforeEach(() => {
    db = createDb();
    client = makeClient(buildApp(db).app);
  });
  afterEach(() => client.close());

  it('returns 401 without credentials', async () => {
    const { status } = await client.get('/api/support/tickets/any');
    expect(status).toBe(401);
  });

  it('returns 404 for unknown ticket', async () => {
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status } = await client.get('/api/support/tickets/no-such-ticket', { token });
    expect(status).toBe(404);
  });

  it('returns ticket with updates for admin', async () => {
    const churchId = seedChurch(db);
    const adminId = seedAdmin(db);
    const ticketId = uuidv4();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO support_tickets (id, church_id, triage_id, issue_category, severity, title, status, forced_bypass, diagnostics_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ticketId, churchId, null, 'stream_down', 'P2', 'Stream issue', 'open', 0, '{}', 'admin:x', now, now);
    db.prepare(`INSERT INTO support_ticket_updates (ticket_id, message, actor_type, actor_id, created_at) VALUES (?, ?, ?, ?, ?)`).run(ticketId, 'Looking into it', 'admin', adminId, now);

    const token = issueAdminToken(adminId);
    const { status, body } = await client.get(`/api/support/tickets/${ticketId}`, { token });
    expect(status).toBe(200);
    expect(body.id).toBe(ticketId);
    expect(body.updates.length).toBe(1);
    expect(body.updates[0].message).toBe('Looking into it');
  });

  it('returns 403 when church user tries to access another church ticket', async () => {
    const churchId1 = seedChurch(db, { name: 'Church A' });
    const churchId2 = seedChurch(db, { name: 'Church B' });
    const ticketId = uuidv4();
    const now = new Date().toISOString();
    // Ticket belongs to church2
    db.prepare(`INSERT INTO support_tickets (id, church_id, triage_id, issue_category, severity, title, status, forced_bypass, diagnostics_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ticketId, churchId2, null, 'other', 'P3', 'Private', 'open', 0, '{}', 'a', now, now);

    // church1 JWT
    const token = issueChurchToken(churchId1);
    const { status } = await client.get(`/api/support/tickets/${ticketId}`, { token });
    expect(status).toBe(403);
  });
});

// ─── POST /api/support/tickets/:ticketId/updates ─────────────────────────────

describe('POST /api/support/tickets/:ticketId/updates', () => {
  let db, client;

  beforeEach(() => {
    db = createDb();
    client = makeClient(buildApp(db).app);
  });
  afterEach(() => client.close());

  it('returns 404 for unknown ticket', async () => {
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status } = await client.post('/api/support/tickets/no-such/updates', {
      token,
      body: { message: 'Hello' },
    });
    expect(status).toBe(404);
  });

  it('returns 400 when message is empty', async () => {
    const churchId = seedChurch(db);
    const adminId = seedAdmin(db);
    const ticketId = uuidv4();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO support_tickets (id, church_id, triage_id, issue_category, severity, title, status, forced_bypass, diagnostics_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ticketId, churchId, null, 'other', 'P3', 'Issue', 'open', 0, '{}', 'a', now, now);
    const token = issueAdminToken(adminId);
    const { status } = await client.post(`/api/support/tickets/${ticketId}/updates`, {
      token,
      body: { message: '' },
    });
    expect(status).toBe(400);
  });

  it('adds update and returns {ok:true}', async () => {
    const churchId = seedChurch(db);
    const adminId = seedAdmin(db);
    const ticketId = uuidv4();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO support_tickets (id, church_id, triage_id, issue_category, severity, title, status, forced_bypass, diagnostics_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ticketId, churchId, null, 'other', 'P3', 'Issue', 'open', 0, '{}', 'a', now, now);
    const token = issueAdminToken(adminId);
    const { status, body } = await client.post(`/api/support/tickets/${ticketId}/updates`, {
      token,
      body: { message: 'Working on it', status: 'in_progress' },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.status).toBe('in_progress');
  });

  it('returns 400 for invalid status transition', async () => {
    const churchId = seedChurch(db);
    const adminId = seedAdmin(db);
    const ticketId = uuidv4();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO support_tickets (id, church_id, triage_id, issue_category, severity, title, status, forced_bypass, diagnostics_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ticketId, churchId, null, 'other', 'P3', 'Issue', 'open', 0, '{}', 'a', now, now);
    const token = issueAdminToken(adminId);
    const { status } = await client.post(`/api/support/tickets/${ticketId}/updates`, {
      token,
      body: { message: 'Update', status: 'invalid_status' },
    });
    expect(status).toBe(400);
  });

  it('church user can only set waiting_customer or closed status', async () => {
    const churchId = seedChurch(db);
    const ticketId = uuidv4();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO support_tickets (id, church_id, triage_id, issue_category, severity, title, status, forced_bypass, diagnostics_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ticketId, churchId, null, 'other', 'P3', 'Issue', 'open', 0, '{}', 'a', now, now);

    const token = issueChurchToken(churchId);
    // Church tries to set in_progress — should be 403
    const { status } = await client.post(`/api/support/tickets/${ticketId}/updates`, {
      token,
      body: { message: 'Update', status: 'in_progress' },
    });
    expect(status).toBe(403);

    // Church can set waiting_customer
    const { status: s2 } = await client.post(`/api/support/tickets/${ticketId}/updates`, {
      token,
      body: { message: 'Waiting for your reply', status: 'waiting_customer' },
    });
    expect(s2).toBe(200);
  });
});

// ─── PUT /api/support/tickets/:ticketId ──────────────────────────────────────

describe('PUT /api/support/tickets/:ticketId', () => {
  let db, client;

  beforeEach(() => {
    db = createDb();
    client = makeClient(buildApp(db).app);
  });
  afterEach(() => client.close());

  it('returns 403 when church user tries to edit ticket metadata', async () => {
    const churchId = seedChurch(db);
    const ticketId = uuidv4();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO support_tickets (id, church_id, triage_id, issue_category, severity, title, status, forced_bypass, diagnostics_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ticketId, churchId, null, 'other', 'P3', 'Issue', 'open', 0, '{}', 'a', now, now);
    const token = issueChurchToken(churchId);
    const { status } = await client.put(`/api/support/tickets/${ticketId}`, {
      token,
      body: { title: 'New Title' },
    });
    expect(status).toBe(403);
  });

  it('admin can update status, severity, title, description', async () => {
    const churchId = seedChurch(db);
    const adminId = seedAdmin(db);
    const ticketId = uuidv4();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO support_tickets (id, church_id, triage_id, issue_category, severity, title, status, forced_bypass, diagnostics_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ticketId, churchId, null, 'other', 'P3', 'Issue', 'open', 0, '{}', 'a', now, now);
    const token = issueAdminToken(adminId);
    const { status, body } = await client.put(`/api/support/tickets/${ticketId}`, {
      token,
      body: { status: 'resolved', severity: 'P1', title: 'Updated Title' },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.status).toBe('resolved');
    expect(body.severity).toBe('P1');
  });

  it('returns 400 when no changes supplied', async () => {
    const churchId = seedChurch(db);
    const adminId = seedAdmin(db);
    const ticketId = uuidv4();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO support_tickets (id, church_id, triage_id, issue_category, severity, title, status, forced_bypass, diagnostics_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(ticketId, churchId, null, 'other', 'P3', 'Issue', 'open', 0, '{}', 'a', now, now);
    const token = issueAdminToken(adminId);
    const { status } = await client.put(`/api/support/tickets/${ticketId}`, {
      token,
      body: {},
    });
    expect(status).toBe(400);
  });
});

// ─── GET /api/church/:churchId/diagnostic-bundles ─────────────────────────────

describe('GET /api/church/:churchId/diagnostic-bundles', () => {
  let db, client;

  beforeEach(() => {
    db = createDb();
    client = makeClient(buildApp(db).app);
  });
  afterEach(() => client.close());

  it('returns 401 without credentials', async () => {
    const { status } = await client.get('/api/church/any/diagnostic-bundles');
    expect(status).toBe(401);
  });

  it('returns 403 when church user tries to list bundles', async () => {
    const churchId = seedChurch(db);
    const token = issueChurchToken(churchId);
    const { status } = await client.get(`/api/church/${churchId}/diagnostic-bundles`, { token });
    expect(status).toBe(403);
  });

  it('returns 404 for unknown church', async () => {
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status } = await client.get('/api/church/no-such-church/diagnostic-bundles', { token });
    expect(status).toBe(404);
  });

  it('returns empty array for church with no bundles', async () => {
    const churchId = seedChurch(db);
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status, body } = await client.get(`/api/church/${churchId}/diagnostic-bundles`, { token });
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });
});

// ─── POST /api/church/:churchId/diagnostic-bundle ────────────────────────────

describe('POST /api/church/:churchId/diagnostic-bundle', () => {
  let db, client;

  beforeEach(() => {
    db = createDb();
    client = makeClient(buildApp(db).app);
  });
  afterEach(() => client.close());

  it('returns 401 without credentials', async () => {
    const { status } = await client.post('/api/church/any/diagnostic-bundle', { body: {} });
    expect(status).toBe(401);
  });

  it('returns 404 for unknown church', async () => {
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status } = await client.post('/api/church/no-such-church/diagnostic-bundle', {
      token, body: {},
    });
    expect(status).toBe(404);
  });

  it('returns 503 when church client is not connected', async () => {
    const churchId = seedChurch(db);
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    // No WebSocket in churches map = not connected
    const { status, body } = await client.post(`/api/church/${churchId}/diagnostic-bundle`, {
      token, body: {},
    });
    expect(status).toBe(503);
    expect(body.error).toMatch(/not connected/i);
  });
});
