/**
 * Server-side RBAC on admin write routes, connection-token reveal,
 * and support ticket write path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { hashPassword } = require('../src/auth');
const createAuthMiddleware = require('../src/routes/authMiddleware');
const setupAdminChurchRoutes = require('../src/routes/adminChurches');
const setupResellerRoutes = require('../src/routes/reseller');
const setupSupportTicketRoutes = require('../src/routes/supportTickets');
const { setupAdminPanel } = require('../src/adminPanel');
const { createClient } = require('./helpers/expressTestClient');

const JWT_SECRET = 'test-admin-rbac-secret';
const ADMIN_API_KEY = 'rbac-admin-key';

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT,
      email TEXT DEFAULT '',
      token TEXT DEFAULT '',
      registeredAt TEXT DEFAULT '',
      billing_tier TEXT DEFAULT 'connect',
      billing_status TEXT DEFAULT 'inactive',
      billing_interval TEXT DEFAULT 'monthly',
      portal_email TEXT,
      registration_code TEXT,
      church_type TEXT DEFAULT 'recurring'
    );
    CREATE TABLE billing_customers (
      id TEXT PRIMARY KEY,
      church_id TEXT,
      tier TEXT,
      billing_interval TEXT,
      status TEXT,
      email TEXT DEFAULT '',
      created_at TEXT DEFAULT '',
      updated_at TEXT DEFAULT ''
    );
    CREATE TABLE admin_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_user_id TEXT,
      admin_email TEXT,
      action TEXT,
      target_type TEXT,
      target_id TEXT,
      details TEXT,
      ip_address TEXT,
      created_at TEXT
    );
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
    );
    CREATE TABLE support_ticket_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT NOT NULL,
      message TEXT,
      actor_type TEXT,
      actor_id TEXT,
      created_at TEXT
    );
    CREATE TABLE alerts (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      alert_type TEXT,
      severity TEXT,
      context TEXT,
      created_at TEXT,
      acknowledged_at TEXT,
      resolved INTEGER DEFAULT 0
    );
  `);
  return db;
}

function seedUser(db, { email, role }) {
  const id = uuidv4();
  db.prepare(
    'INSERT INTO admin_users (id, email, password_hash, name, role, active, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(id, email, hashPassword('Passw0rd!'), role, role, 1, new Date().toISOString());
  return id;
}

function issueToken(userId, role, email) {
  return jwt.sign({ type: 'admin', userId, role, email, name: role }, JWT_SECRET, { expiresIn: '8h' });
}

function seedChurch(db, churches, opts = {}) {
  const churchId = opts.churchId || 'ch-rbac-1';
  db.prepare(
    'INSERT INTO churches (churchId, name, token, registeredAt, billing_tier, billing_status, billing_interval) VALUES (?,?,?,?,?,?,?)'
  ).run(churchId, opts.name || 'Grace Chapel', opts.token || 'booth-secret-jwt', new Date().toISOString(), 'connect', 'active', 'monthly');
  churches.set(churchId, { churchId, name: opts.name || 'Grace Chapel', token: opts.token || 'booth-secret-jwt', status: {}, lastSeen: null });
  return churchId;
}

function buildApp(db, churches) {
  const app = express();
  app.use(express.json());
  const logAudit = vi.fn();
  const mw = createAuthMiddleware({
    db,
    JWT_SECRET,
    ADMIN_API_KEY,
    safeCompareKey: (a, b) => !!(a && b && a === b),
    resolveAdminKey: (req) => req.headers['x-api-key'],
  });

  const resellerSystem = {
    listResellers: () => [],
    getResellerById: (id) => (id === 'res-1' ? { id: 'res-1', name: 'AV Co', active: 1 } : null),
    createReseller: () => ({ id: 'res-new' }),
    updateReseller: () => ({ id: 'res-1' }),
    deactivateReseller: () => true,
    getResellerChurches: () => [],
  };

  setupAdminChurchRoutes(app, {
    db,
    churches,
    requireAdmin: mw.requireAdmin,
    requirePermission: mw.requirePermission,
    billing: { getStatus: () => ({}), listAll: () => [] },
    normalizeBillingInterval: (interval, _tier, def) => {
      if (!interval) return def;
      return ['monthly', 'annual', 'one_time'].includes(interval) ? interval : null;
    },
    messageQueues: new Map(),
    BILLING_TIERS: new Set(['connect', 'plus', 'pro', 'managed', 'event']),
    BILLING_STATUSES: new Set(['active', 'inactive', 'trial', 'canceled', 'past_due', 'trialing']),
    safeErrorMessage: (e) => e.message || 'Unknown error',
    log: () => {},
    logAudit,
  });

  setupAdminPanel(app, db, churches, resellerSystem, {
    jwt,
    JWT_SECRET,
    logAudit,
    requirePermission: mw.requirePermission,
  });

  setupResellerRoutes(app, {
    churches,
    requireAdmin: mw.requireAdmin,
    requirePermission: mw.requirePermission,
    requireReseller: mw.requireReseller,
    resellerSystem,
    hashPassword,
    safeErrorMessage: (e) => e.message || 'error',
    lifecycleEmails: null,
    log: () => {},
  });

  setupSupportTicketRoutes(app, {
    db,
    churches,
    requireAdminJwt: mw.requireAdminJwt,
    scheduleEngine: { isServiceWindow: () => false },
    JWT_SECRET,
    RELAY_VERSION: 'test',
    SUPPORT_TRIAGE_WINDOW_HOURS: 24,
    rateLimit: () => (_req, _res, next) => next(),
    broadcastToSSE: () => {},
    lifecycleEmails: null,
  });

  return { app, logAudit };
}

describe('admin write RBAC + token reveal + ticket writes', () => {
  let db;
  let churches;
  let client;
  let logAudit;
  let tokens;

  beforeEach(() => {
    db = createDb();
    churches = new Map();
    seedChurch(db, churches);
    const superId = seedUser(db, { email: 'super@test.com', role: 'super_admin' });
    const adminId = seedUser(db, { email: 'admin@test.com', role: 'admin' });
    const engId = seedUser(db, { email: 'eng@test.com', role: 'engineer' });
    const salesId = seedUser(db, { email: 'sales@test.com', role: 'sales' });
    tokens = {
      super_admin: issueToken(superId, 'super_admin', 'super@test.com'),
      admin: issueToken(adminId, 'admin', 'admin@test.com'),
      engineer: issueToken(engId, 'engineer', 'eng@test.com'),
      sales: issueToken(salesId, 'sales', 'sales@test.com'),
    };
    const built = buildApp(db, churches);
    logAudit = built.logAudit;
    client = createClient(built.app);
  });

  afterEach(() => client.close());

  describe('GET /api/churches token hygiene', () => {
    it('omits raw tokens for every admin role', async () => {
      const { status, body } = await client.get('/api/churches', { token: tokens.engineer });
      expect(status).toBe(200);
      expect(body[0].token).toBeUndefined();
      expect(body[0].hasToken).toBe(true);
    });
  });

  describe('403 for engineer/sales on writes', () => {
    it.each(['engineer', 'sales'])('%s cannot update billing', async (role) => {
      const { status, body } = await client.put('/api/churches/ch-rbac-1/billing', {
        token: tokens[role],
        body: { tier: 'plus', status: 'active' },
      });
      expect(status).toBe(403);
      expect(body.error).toMatch(/permission/i);
    });

    it.each(['engineer', 'sales'])('%s cannot delete a church', async (role) => {
      const { status } = await client.delete('/api/admin/churches/ch-rbac-1', { token: tokens[role] });
      expect(status).toBe(403);
      expect(db.prepare('SELECT churchId FROM churches WHERE churchId = ?').get('ch-rbac-1')).toBeTruthy();
    });

    it.each(['engineer', 'sales'])('%s cannot reveal a connection token', async (role) => {
      const { status, body } = await client.get('/api/admin/churches/ch-rbac-1/connection-token', {
        token: tokens[role],
      });
      expect(status).toBe(403);
      expect(body.token).toBeUndefined();
    });

    it.each(['engineer', 'sales'])('%s cannot regenerate a connection token', async (role) => {
      const { status } = await client.post('/api/admin/churches/ch-rbac-1/token', { token: tokens[role] });
      expect(status).toBe(403);
    });

    it.each(['engineer', 'sales'])('%s cannot reset a reseller password', async (role) => {
      const { status } = await client.post('/api/admin/resellers/res-1/password', {
        token: tokens[role],
        body: { password: 'NewReseller1' },
      });
      expect(status).toBe(403);
    });

    it.each(['engineer', 'sales'])('%s cannot deactivate a reseller', async (role) => {
      const { status } = await client.delete('/api/admin/resellers/res-1', { token: tokens[role] });
      expect(status).toBe(403);
    });
  });

  describe('admin and super_admin can write', () => {
    it.each(['admin', 'super_admin'])('%s can update billing', async (role) => {
      const { status, body } = await client.put('/api/churches/ch-rbac-1/billing', {
        token: tokens[role],
        body: { tier: 'plus', status: 'active' },
      });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    });

    it('admin can reveal a connection token and it is audited', async () => {
      const { status, body } = await client.get('/api/admin/churches/ch-rbac-1/connection-token', {
        token: tokens.admin,
      });
      expect(status).toBe(200);
      expect(body.token).toBe('booth-secret-jwt');
      expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'token_revealed',
        targetId: 'ch-rbac-1',
      }));
    });
  });

  describe('ticket write path', () => {
    it('admin can resolve a ticket and add a reply', async () => {
      const ticketId = uuidv4();
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO support_tickets
          (id, church_id, triage_id, issue_category, severity, title, description, status, forced_bypass, diagnostics_json, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(ticketId, 'ch-rbac-1', null, 'other', 'P3', 'Stream issue', 'Encoder dropped', 'open', 0, '{}', 'admin:x', now, now);

      const put = await client.put(`/api/support/tickets/${ticketId}`, {
        token: tokens.admin,
        body: { status: 'resolved' },
      });
      expect(put.status).toBe(200);
      expect(put.body.status).toBe('resolved');

      const reply = await client.post(`/api/support/tickets/${ticketId}/updates`, {
        token: tokens.admin,
        body: { message: 'Resolved after encoder reboot', status: 'resolved' },
      });
      expect(reply.status).toBe(200);
      expect(reply.body.ok).toBe(true);

      const row = db.prepare('SELECT status FROM support_tickets WHERE id = ?').get(ticketId);
      expect(row.status).toBe('resolved');
      const updates = db.prepare('SELECT message FROM support_ticket_updates WHERE ticket_id = ?').all(ticketId);
      expect(updates).toHaveLength(1);
      expect(updates[0].message).toMatch(/encoder reboot/i);
    });
  });
});
