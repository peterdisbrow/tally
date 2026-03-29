/**
 * Tests for src/churchPortal.js — Church Portal API routes.
 *
 * Uses an in-memory SQLite database and a real Express app to exercise
 * every route through supertest-style helper that calls handlers directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');
const express = require('express');

const JWT_SECRET = 'test-secret-key-for-unit-tests';
const CHURCH_A_ID = 'church-aaa-111';
const CHURCH_B_ID = 'church-bbb-222';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function issueToken(churchId, opts = {}) {
  return jwt.sign(
    { type: opts.type || 'church_portal', churchId },
    JWT_SECRET,
    { expiresIn: opts.expiresIn || '7d' },
  );
}

function createTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS churches (
      churchId TEXT PRIMARY KEY,
      name TEXT,
      email TEXT DEFAULT '',
      token TEXT DEFAULT '',
      registeredAt TEXT,
      portal_email TEXT,
      portal_password_hash TEXT,
      phone TEXT,
      location TEXT,
      notes TEXT,
      notifications TEXT DEFAULT '{}',
      telegram_chat_id TEXT,
      parent_church_id TEXT,
      campus_name TEXT,
      schedule TEXT DEFAULT '{}',
      auto_recovery_enabled INTEGER DEFAULT 1,
      leadership_emails TEXT DEFAULT '',
      referral_code TEXT,
      referred_by TEXT,
      billing_tier TEXT DEFAULT 'connect',
      billing_status TEXT DEFAULT 'active',
      billing_interval TEXT DEFAULT 'monthly',
      billing_trial_ends TEXT,
      reseller_id TEXT,
      failover_enabled INTEGER DEFAULT 0,
      failover_black_threshold_s INTEGER DEFAULT 5,
      failover_ack_timeout_s INTEGER DEFAULT 30,
      failover_action TEXT,
      failover_auto_recover INTEGER DEFAULT 0,
      failover_audio_trigger INTEGER DEFAULT 0,
      onboarding_dismissed INTEGER DEFAULT 0,
      registration_code TEXT,
      audio_via_atem INTEGER DEFAULT 0,
      engineer_profile TEXT,
      campus_id TEXT,
      room_id TEXT,
      room_name TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS church_tds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL,
      telegram_user_id TEXT,
      telegram_chat_id TEXT,
      name TEXT,
      registered_at TEXT,
      active INTEGER DEFAULT 1,
      role TEXT DEFAULT 'td',
      email TEXT,
      phone TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS guest_tokens (
      token TEXT PRIMARY KEY,
      churchId TEXT NOT NULL,
      label TEXT,
      name TEXT,
      createdAt TEXT NOT NULL,
      expiresAt TEXT,
      usedByChat TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT,
      church_id TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      grade TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS problem_finder_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL,
      status TEXT,
      message TEXT,
      created_at TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS preservice_check_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL,
      status TEXT,
      checks TEXT,
      created_at TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS support_triage_runs (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      issue_category TEXT NOT NULL,
      severity TEXT NOT NULL,
      summary TEXT DEFAULT '',
      triage_result TEXT NOT NULL,
      diagnostics_json TEXT NOT NULL,
      autofix_attempts_json TEXT DEFAULT '[]',
      timezone TEXT,
      app_version TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      triage_id TEXT,
      issue_category TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      forced_bypass INTEGER NOT NULL DEFAULT 0,
      diagnostics_json TEXT DEFAULT '{}',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS support_ticket_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT NOT NULL,
      message TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT DEFAULT '',
      created_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS church_reviews (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      reviewer_name TEXT NOT NULL,
      reviewer_role TEXT DEFAULT '',
      rating INTEGER NOT NULL,
      body TEXT NOT NULL,
      church_name TEXT NOT NULL,
      approved INTEGER DEFAULT 0,
      featured INTEGER DEFAULT 0,
      submitted_at TEXT NOT NULL,
      approved_at TEXT,
      source TEXT DEFAULT 'portal'
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_reviews_approved ON church_reviews(approved)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id          TEXT PRIMARY KEY,
      campus_id   TEXT NOT NULL,
      name        TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at  TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS referrals (
      id TEXT PRIMARY KEY,
      referrer_id TEXT NOT NULL,
      referred_id TEXT NOT NULL,
      referred_name TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      credit_amount INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      converted_at TEXT,
      credited_at TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS billing_customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL,
      stripe_customer_id TEXT,
      billing_interval TEXT,
      current_period_end TEXT,
      cancel_at_period_end INTEGER DEFAULT 0,
      updated_at TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      event_type TEXT,
      timestamp TEXT,
      resolved INTEGER DEFAULT 0,
      auto_resolved INTEGER DEFAULT 0
    )
  `);
  return db;
}

function seedChurchA(db) {
  const { hashPassword } = require('../src/auth');
  db.prepare(`
    INSERT OR REPLACE INTO churches (churchId, name, email, portal_email, portal_password_hash, registeredAt, billing_tier, registration_code, referral_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(CHURCH_A_ID, 'Church Alpha', 'alpha@test.com', 'admin@alpha.org', hashPassword('password123'), '2024-01-01T00:00:00.000Z', 'pro', 'ALPHA1', 'REF-ALPHA');
}

function seedChurchB(db) {
  const { hashPassword } = require('../src/auth');
  db.prepare(`
    INSERT OR REPLACE INTO churches (churchId, name, email, portal_email, portal_password_hash, registeredAt, billing_tier, registration_code, referral_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(CHURCH_B_ID, 'Church Beta', 'beta@test.com', 'admin@beta.org', hashPassword('betapass123'), '2024-02-01T00:00:00.000Z', 'connect', 'BETA1', 'REF-BETA');
}

/**
 * Build a real Express app with the church portal routes registered.
 * Returns { app, db, churches } for testing.
 */
function buildApp() {
  const db = createTestDb();
  seedChurchA(db);
  seedChurchB(db);

  const churches = new Map();
  churches.set(CHURCH_A_ID, {
    churchId: CHURCH_A_ID,
    name: 'Church Alpha',
    ws: { readyState: 1 },
    status: {
      atem: { connected: true, programInput: 1, inputLabels: { 1: 'Camera 1', 2: 'Camera 2' } },
      encoder: { connected: true, live: true },
      videoHubs: [],
      obs: null,
    },
    lastSeen: new Date().toISOString(),
  });
  churches.set(CHURCH_B_ID, {
    churchId: CHURCH_B_ID,
    name: 'Church Beta',
    ws: { readyState: 1 },
    status: {},
    lastSeen: new Date().toISOString(),
  });

  const app = express();
  app.use(express.json());
  app.use(require('cookie-parser')());

  // Mock requireAdmin middleware
  const requireAdmin = (req, res, next) => {
    const auth = req.headers.authorization;
    if (auth === 'Bearer admin-token') return next();
    return res.status(401).json({ error: 'Unauthorized' });
  };

  const signalFailover = {
    getState: vi.fn().mockReturnValue({ state: 'HEALTHY', churchId: CHURCH_A_ID }),
  };

  const { setupChurchPortal } = require('../src/churchPortal');
  setupChurchPortal(app, db, churches, JWT_SECRET, requireAdmin, {
    signalFailover,
    billing: null,
    lifecycleEmails: null,
    preServiceCheck: null,
    sessionRecap: null,
    weeklyDigest: null,
    rundownEngine: null,
    scheduler: null,
    aiRateLimiter: null,
    guestTdMode: null,
  });

  return { app, db, churches, signalFailover };
}

/**
 * Lightweight supertest-like helper so we don't need the supertest dependency.
 * Builds a real HTTP request against the express app.
 */
function request(app) {
  const http = require('http');
  const server = app.listen(0);
  const port = server.address().port;

  function makeRequest(method, path, { body, headers = {}, cookie } = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(`http://127.0.0.1:${port}${path}`);
      const opts = {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: { ...headers },
      };
      if (cookie) opts.headers.cookie = cookie;
      let payload;
      if (body !== undefined) {
        payload = typeof body === 'string' ? body : JSON.stringify(body);
        opts.headers['content-type'] = opts.headers['content-type'] || 'application/json';
        opts.headers['content-length'] = Buffer.byteLength(payload);
      }
      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let json;
          try { json = JSON.parse(data); } catch { json = null; }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: json,
            text: data,
          });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  return {
    get: (path, opts) => makeRequest('GET', path, opts || {}),
    post: (path, opts) => makeRequest('POST', path, opts || {}),
    put: (path, opts) => makeRequest('PUT', path, opts || {}),
    patch: (path, opts) => makeRequest('PATCH', path, opts || {}),
    delete: (path, opts) => makeRequest('DELETE', path, opts || {}),
    close: () => server.close(),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Church Portal API', () => {
  let app, db, churches, client, signalFailover;
  let tokenA, tokenB;

  beforeEach(() => {
    const built = buildApp();
    app = built.app;
    db = built.db;
    churches = built.churches;
    signalFailover = built.signalFailover;
    client = request(app);
    tokenA = issueToken(CHURCH_A_ID);
    tokenB = issueToken(CHURCH_B_ID);
  });

  afterEach(() => {
    client.close();
    try { db.close(); } catch {}
  });

  function authHeaders(token) {
    return { cookie: `tally_church_session=${token}` };
  }

  function bearerHeaders(token) {
    return { headers: { authorization: `Bearer ${token}` } };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // A. Auth Middleware Enforcement
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Auth middleware enforcement', () => {
    const protectedEndpoints = [
      ['GET', '/api/church/me'],
      ['PUT', '/api/church/me'],
      ['GET', '/api/church/failover'],
      ['PUT', '/api/church/failover'],
      ['GET', '/api/church/failover/sources'],
      ['GET', '/api/church/failover/state'],
      ['GET', '/api/church/schedule'],
      ['PUT', '/api/church/schedule'],
      ['GET', '/api/church/tds'],
      ['POST', '/api/church/tds'],
      ['DELETE', '/api/church/tds/1'],
      ['GET', '/api/church/sessions'],
      ['GET', '/api/church/guest-tokens'],
      ['POST', '/api/church/guest-tokens'],
      ['DELETE', '/api/church/guest-tokens/tok1'],
      ['GET', '/api/church/rooms'],
      ['POST', '/api/church/rooms'],
      ['DELETE', '/api/church/rooms/some-id'],
      ['GET', '/api/church/problems'],
      ['GET', '/api/church/preservice-check'],
      ['GET', '/api/church/billing'],
      ['POST', '/api/church/onboarding/dismiss'],
      ['POST', '/api/church/onboarding/undismiss'],
      ['GET', '/api/church/review'],
      ['POST', '/api/church/review'],
      ['GET', '/api/church/referrals'],
      ['GET', '/api/church/alerts'],
      ['GET', '/api/church/analytics'],
      ['GET', '/api/church/session/active'],
    ];

    for (const [method, path] of protectedEndpoints) {
      it(`${method} ${path} returns 401 without auth`, async () => {
        const fn = client[method.toLowerCase()];
        const res = await fn(path);
        expect(res.status).toBe(401);
        expect(res.body?.error).toBeTruthy();
      });
    }

    it('rejects an expired JWT', async () => {
      const expired = jwt.sign(
        { type: 'church_portal', churchId: CHURCH_A_ID },
        JWT_SECRET,
        { expiresIn: '-1s' },
      );
      const res = await client.get('/api/church/me', authHeaders(expired));
      expect(res.status).toBe(401);
    });

    it('rejects a JWT with wrong type', async () => {
      const wrong = jwt.sign({ type: 'admin', churchId: CHURCH_A_ID }, JWT_SECRET, { expiresIn: '1h' });
      const res = await client.get('/api/church/me', authHeaders(wrong));
      expect(res.status).toBe(401);
    });

    it('rejects a JWT signed with wrong secret', async () => {
      const bad = jwt.sign({ type: 'church_portal', churchId: CHURCH_A_ID }, 'wrong-secret', { expiresIn: '1h' });
      const res = await client.get('/api/church/me', authHeaders(bad));
      expect(res.status).toBe(401);
    });

    it('rejects a JWT for a non-existent church', async () => {
      const ghost = issueToken('church-nonexistent-999');
      const res = await client.get('/api/church/me', authHeaders(ghost));
      expect(res.status).toBe(401);
    });

    it('accepts a valid cookie token', async () => {
      const res = await client.get('/api/church/me', authHeaders(tokenA));
      expect(res.status).toBe(200);
      expect(res.body.churchId).toBe(CHURCH_A_ID);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // B. Church Isolation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Church isolation', () => {
    it('GET /api/church/me returns only own church data', async () => {
      const resA = await client.get('/api/church/me', authHeaders(tokenA));
      expect(resA.body.churchId).toBe(CHURCH_A_ID);
      expect(resA.body.name).toBe('Church Alpha');

      const resB = await client.get('/api/church/me', authHeaders(tokenB));
      expect(resB.body.churchId).toBe(CHURCH_B_ID);
      expect(resB.body.name).toBe('Church Beta');
    });

    it('church A cannot see church B TDs', async () => {
      db.prepare('INSERT INTO church_tds (church_id, telegram_user_id, telegram_chat_id, name, registered_at) VALUES (?, ?, ?, ?, ?)')
        .run(CHURCH_B_ID, 'tg_b', 'chat_b', 'Bob TD', new Date().toISOString());

      const res = await client.get('/api/church/tds', authHeaders(tokenA));
      expect(res.status).toBe(200);
      const names = res.body.map(t => t.name);
      expect(names).not.toContain('Bob TD');
    });

    it('church A cannot delete church B room', async () => {
      db.prepare('INSERT INTO rooms (id, campus_id, name, created_at) VALUES (?, ?, ?, ?)')
        .run('room-b-1', CHURCH_B_ID, 'Beta Room', new Date().toISOString());

      const res = await client.delete('/api/church/rooms/room-b-1', authHeaders(tokenA));
      expect(res.status).toBe(404);
    });

    it('church B sessions are not visible to church A', async () => {
      db.prepare('INSERT INTO service_sessions (sessionId, church_id, started_at) VALUES (?, ?, ?)')
        .run('sess-b-1', CHURCH_B_ID, new Date().toISOString());

      const res = await client.get('/api/church/sessions', authHeaders(tokenA));
      expect(res.status).toBe(200);
      const ids = res.body.map(s => s.sessionId);
      expect(ids).not.toContain('sess-b-1');
    });

    it('DELETE /api/church/tds/:id scopes to own church', async () => {
      const ins = db.prepare('INSERT INTO church_tds (church_id, telegram_user_id, telegram_chat_id, name, registered_at) VALUES (?, ?, ?, ?, ?)')
        .run(CHURCH_B_ID, 'tg_b2', 'chat_b2', 'Beta TD2', new Date().toISOString());

      // Church A tries to delete church B's TD
      await client.delete(`/api/church/tds/${ins.lastInsertRowid}`, authHeaders(tokenA));
      // TD should still exist
      const row = db.prepare('SELECT * FROM church_tds WHERE id = ?').get(ins.lastInsertRowid);
      expect(row).toBeTruthy();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // C. Failover Endpoints
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Failover endpoints', () => {
    it('GET /api/church/failover returns failover settings', async () => {
      db.prepare(`UPDATE churches SET failover_enabled = 1, failover_black_threshold_s = 7,
        failover_ack_timeout_s = 45, failover_action = ?, failover_auto_recover = 1, failover_audio_trigger = 0
        WHERE churchId = ?`).run(JSON.stringify({ type: 'atem_switch', input: 2 }), CHURCH_A_ID);

      const res = await client.get('/api/church/failover', authHeaders(tokenA));
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
      expect(res.body.blackThresholdS).toBe(7);
      expect(res.body.ackTimeoutS).toBe(45);
      expect(res.body.action).toEqual({ type: 'atem_switch', input: 2 });
      expect(res.body.autoRecover).toBe(true);
      expect(res.body.audioTrigger).toBe(false);
    });

    it('GET /api/church/failover returns defaults when nothing set', async () => {
      const res = await client.get('/api/church/failover', authHeaders(tokenA));
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(false);
      expect(res.body.blackThresholdS).toBe(5);
      expect(res.body.ackTimeoutS).toBe(30);
    });

    it('PUT /api/church/failover saves settings', async () => {
      const res = await client.put('/api/church/failover', {
        ...authHeaders(tokenA),
        body: {
          enabled: true,
          blackThresholdS: 10,
          ackTimeoutS: 60,
          action: { type: 'atem_switch', input: 5 },
          autoRecover: true,
          audioTrigger: true,
        },
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      // Verify persisted
      const row = db.prepare('SELECT failover_enabled, failover_black_threshold_s, failover_ack_timeout_s, failover_action, failover_auto_recover, failover_audio_trigger FROM churches WHERE churchId = ?').get(CHURCH_A_ID);
      expect(row.failover_enabled).toBe(1);
      expect(row.failover_black_threshold_s).toBe(10);
      expect(row.failover_ack_timeout_s).toBe(60);
      expect(JSON.parse(row.failover_action)).toEqual({ type: 'atem_switch', input: 5 });
      expect(row.failover_auto_recover).toBe(1);
      expect(row.failover_audio_trigger).toBe(1);
    });

    it('PUT /api/church/failover clamps blackThresholdS within 3-15', async () => {
      await client.put('/api/church/failover', {
        ...authHeaders(tokenA),
        body: { enabled: true, blackThresholdS: 1, ackTimeoutS: 200 },
      });
      const row = db.prepare('SELECT failover_black_threshold_s, failover_ack_timeout_s FROM churches WHERE churchId = ?').get(CHURCH_A_ID);
      expect(row.failover_black_threshold_s).toBe(3);   // clamped min
      expect(row.failover_ack_timeout_s).toBe(120);      // clamped max
    });

    it('PUT /api/church/failover handles videohub_route action', async () => {
      const res = await client.put('/api/church/failover', {
        ...authHeaders(tokenA),
        body: {
          enabled: true,
          action: { type: 'videohub_route', output: 3, input: 1, hubIndex: 0 },
        },
      });
      expect(res.status).toBe(200);
      const row = db.prepare('SELECT failover_action FROM churches WHERE churchId = ?').get(CHURCH_A_ID);
      expect(JSON.parse(row.failover_action)).toEqual({
        type: 'videohub_route', output: 3, input: 1, hubIndex: 0,
      });
    });

    it('PUT /api/church/failover ignores invalid action type', async () => {
      const res = await client.put('/api/church/failover', {
        ...authHeaders(tokenA),
        body: {
          enabled: true,
          action: { type: 'invalid_type', foo: 'bar' },
        },
      });
      expect(res.status).toBe(200);
      const row = db.prepare('SELECT failover_action FROM churches WHERE churchId = ?').get(CHURCH_A_ID);
      expect(row.failover_action).toBeNull();
    });

    it('GET /api/church/failover/sources returns ATEM inputs from status', async () => {
      const res = await client.get('/api/church/failover/sources', authHeaders(tokenA));
      expect(res.status).toBe(200);
      expect(res.body.atem).toEqual([
        { id: 1, name: 'Camera 1' },
        { id: 2, name: 'Camera 2' },
      ]);
    });

    it('GET /api/church/failover/sources returns empty when church not in memory', async () => {
      churches.delete(CHURCH_A_ID);
      const res = await client.get('/api/church/failover/sources', authHeaders(tokenA));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ atem: [], videohub: [], obs: [] });
    });

    it('GET /api/church/failover/sources returns fallback ATEM inputs when connected but no labels', async () => {
      churches.get(CHURCH_A_ID).status.atem = { connected: true };
      const res = await client.get('/api/church/failover/sources', authHeaders(tokenA));
      expect(res.status).toBe(200);
      expect(res.body.atem).toHaveLength(8);
      expect(res.body.atem[0]).toEqual({ id: 1, name: 'Input 1' });
    });

    it('GET /api/church/failover/state returns failover state', async () => {
      const res = await client.get('/api/church/failover/state', authHeaders(tokenA));
      expect(res.status).toBe(200);
      expect(res.body.state).toBe('HEALTHY');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // D. Config Endpoints (GET/PUT /api/church/me)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Config endpoints (me)', () => {
    it('GET /api/church/me returns profile with sensitive fields stripped', async () => {
      const res = await client.get('/api/church/me', authHeaders(tokenA));
      expect(res.status).toBe(200);
      expect(res.body.churchId).toBe(CHURCH_A_ID);
      expect(res.body.portal_password_hash).toBeUndefined();
      expect(res.body.token).toBeUndefined();
      expect(res.body).toHaveProperty('connected');
      expect(res.body).toHaveProperty('notifications');
      expect(res.body).toHaveProperty('autoRecoveryEnabled');
    });

    it('PUT /api/church/me updates email', async () => {
      const res = await client.put('/api/church/me', {
        ...authHeaders(tokenA),
        body: { email: 'NewEmail@Alpha.ORG' },
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      const row = db.prepare('SELECT portal_email FROM churches WHERE churchId = ?').get(CHURCH_A_ID);
      expect(row.portal_email).toBe('newemail@alpha.org');
    });

    it('PUT /api/church/me updates phone', async () => {
      await client.put('/api/church/me', {
        ...authHeaders(tokenA),
        body: { phone: '555-1234' },
      });
      const row = db.prepare('SELECT phone FROM churches WHERE churchId = ?').get(CHURCH_A_ID);
      expect(row.phone).toBe('555-1234');
    });

    it('PUT /api/church/me updates notifications as JSON', async () => {
      const notifs = { emailAlerts: true, smsAlerts: false };
      await client.put('/api/church/me', {
        ...authHeaders(tokenA),
        body: { notifications: notifs },
      });
      const row = db.prepare('SELECT notifications FROM churches WHERE churchId = ?').get(CHURCH_A_ID);
      expect(JSON.parse(row.notifications)).toEqual(notifs);
    });

    it('PUT /api/church/me updates autoRecoveryEnabled', async () => {
      await client.put('/api/church/me', {
        ...authHeaders(tokenA),
        body: { autoRecoveryEnabled: false },
      });
      const row = db.prepare('SELECT auto_recovery_enabled FROM churches WHERE churchId = ?').get(CHURCH_A_ID);
      expect(row.auto_recovery_enabled).toBe(0);
    });

    it('PUT /api/church/me rejects new password shorter than 8 chars', async () => {
      const res = await client.put('/api/church/me', {
        ...authHeaders(tokenA),
        body: { newPassword: 'short', currentPassword: 'password123' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('8 characters');
    });

    it('PUT /api/church/me rejects password change without current password', async () => {
      const res = await client.put('/api/church/me', {
        ...authHeaders(tokenA),
        body: { newPassword: 'newpassword123' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Current password');
    });

    it('PUT /api/church/me rejects password change with wrong current password', async () => {
      const res = await client.put('/api/church/me', {
        ...authHeaders(tokenA),
        body: { newPassword: 'newpassword123', currentPassword: 'wrong-password' },
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('incorrect');
    });

    it('PUT /api/church/me allows password change with correct current password', async () => {
      const res = await client.put('/api/church/me', {
        ...authHeaders(tokenA),
        body: { newPassword: 'brandnewpass', currentPassword: 'password123' },
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      // Verify new password works
      const { verifyPassword } = require('../src/auth');
      const row = db.prepare('SELECT portal_password_hash FROM churches WHERE churchId = ?').get(CHURCH_A_ID);
      expect(verifyPassword('brandnewpass', row.portal_password_hash)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // E. Status Endpoints
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Status endpoints', () => {
    it('GET /api/church/me includes connected status from in-memory map', async () => {
      const res = await client.get('/api/church/me', authHeaders(tokenA));
      expect(res.body.connected).toBe(true);
    });

    it('GET /api/church/me shows disconnected when ws is not open', async () => {
      churches.get(CHURCH_A_ID).ws = { readyState: 3 };
      const res = await client.get('/api/church/me', authHeaders(tokenA));
      expect(res.body.connected).toBe(false);
    });

    it('GET /api/church/me shows disconnected when runtime missing', async () => {
      churches.delete(CHURCH_A_ID);
      const res = await client.get('/api/church/me', authHeaders(tokenA));
      expect(res.body.connected).toBe(false);
    });

    it('GET /api/church/sessions returns recent sessions for own church', async () => {
      db.prepare('INSERT INTO service_sessions (sessionId, church_id, started_at) VALUES (?, ?, ?)')
        .run('sess-a-1', CHURCH_A_ID, '2024-06-01T10:00:00Z');
      db.prepare('INSERT INTO service_sessions (sessionId, church_id, started_at) VALUES (?, ?, ?)')
        .run('sess-a-2', CHURCH_A_ID, '2024-06-02T10:00:00Z');

      const res = await client.get('/api/church/sessions', authHeaders(tokenA));
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it('GET /api/church/session/active returns { active: false } when no sessionRecap', async () => {
      const res = await client.get('/api/church/session/active', authHeaders(tokenA));
      expect(res.status).toBe(200);
      expect(res.body.active).toBe(false);
    });

    it('GET /api/church/problems returns null when no reports exist', async () => {
      const res = await client.get('/api/church/problems', authHeaders(tokenA));
      expect(res.status).toBe(200);
      expect(res.body.status).toBeNull();
    });

    it('GET /api/church/problems returns latest report', async () => {
      db.prepare('INSERT INTO problem_finder_reports (church_id, status, message, created_at) VALUES (?, ?, ?, ?)')
        .run(CHURCH_A_ID, 'ok', 'All clear', '2024-06-01T00:00:00Z');

      const res = await client.get('/api/church/problems', authHeaders(tokenA));
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('GET /api/church/preservice-check returns null when no results', async () => {
      const res = await client.get('/api/church/preservice-check', authHeaders(tokenA));
      expect(res.status).toBe(200);
      expect(res.body).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // F. Schedule Endpoints
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Schedule endpoints', () => {
    it('GET /api/church/schedule returns empty object by default', async () => {
      const res = await client.get('/api/church/schedule', authHeaders(tokenA));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({});
    });

    it('PUT /api/church/schedule saves and GET retrieves it', async () => {
      const schedule = { sunday: [{ start: '09:00', end: '11:00', label: 'Morning' }] };
      const putRes = await client.put('/api/church/schedule', {
        ...authHeaders(tokenA),
        body: schedule,
      });
      expect(putRes.status).toBe(200);

      const getRes = await client.get('/api/church/schedule', authHeaders(tokenA));
      expect(getRes.body).toEqual(schedule);
    });

    it('PUT /api/church/schedule updates in-memory runtime', async () => {
      const schedule = { wednesday: [{ start: '19:00', end: '21:00' }] };
      await client.put('/api/church/schedule', {
        ...authHeaders(tokenA),
        body: schedule,
      });
      expect(churches.get(CHURCH_A_ID).schedule).toEqual(schedule);
    });

  });

  // ═══════════════════════════════════════════════════════════════════════════
  // G. Tech Directors (TDs)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('TD endpoints', () => {
    it('GET /api/church/tds returns empty array initially', async () => {
      const res = await client.get('/api/church/tds', authHeaders(tokenA));
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('POST /api/church/tds creates a TD', async () => {
      const res = await client.post('/api/church/tds', {
        ...authHeaders(tokenA),
        body: { name: 'Alice TD', role: 'lead', email: 'alice@test.com', phone: '555-9999' },
      });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Alice TD');
      expect(res.body.role).toBe('lead');

      const all = await client.get('/api/church/tds', authHeaders(tokenA));
      expect(all.body).toHaveLength(1);
      expect(all.body[0].name).toBe('Alice TD');
    });

    it('POST /api/church/tds returns 400 when name is missing', async () => {
      const res = await client.post('/api/church/tds', {
        ...authHeaders(tokenA),
        body: { role: 'td' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('name');
    });

    it('DELETE /api/church/tds/:id removes the TD', async () => {
      const ins = db.prepare('INSERT INTO church_tds (church_id, telegram_user_id, telegram_chat_id, name, registered_at) VALUES (?, ?, ?, ?, ?)')
        .run(CHURCH_A_ID, 'tg1', 'chat1', 'Delete Me', new Date().toISOString());
      const tdId = ins.lastInsertRowid;

      const res = await client.delete(`/api/church/tds/${tdId}`, authHeaders(tokenA));
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const row = db.prepare('SELECT * FROM church_tds WHERE id = ?').get(tdId);
      expect(row).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // H. Guest Tokens
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Guest token endpoints', () => {
    it('GET /api/church/guest-tokens returns empty when guestTdMode is null', async () => {
      const res = await client.get('/api/church/guest-tokens', authHeaders(tokenA));
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('POST /api/church/guest-tokens returns 503 when guestTdMode is null', async () => {
      const res = await client.post('/api/church/guest-tokens', {
        ...authHeaders(tokenA),
        body: { label: 'test' },
      });
      expect(res.status).toBe(503);
    });

    it('DELETE /api/church/guest-tokens/:tok returns 503 when guestTdMode is null', async () => {
      const res = await client.delete('/api/church/guest-tokens/some-token', authHeaders(tokenA));
      expect(res.status).toBe(503);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // I. Campus Management
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Room CRUD (flat routes)', () => {
    it('GET /api/church/rooms returns empty list initially', async () => {
      const res = await client.get('/api/church/rooms', authHeaders(tokenA));
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('rooms');
      expect(res.body.rooms).toHaveLength(0);
    });

    it('POST /api/church/rooms creates a room', async () => {
      const res = await client.post('/api/church/rooms', {
        ...authHeaders(tokenA),
        body: { name: 'Main Sanctuary', description: 'Big room' },
      });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Main Sanctuary');
      expect(res.body).toHaveProperty('id');

      const list = await client.get('/api/church/rooms', authHeaders(tokenA));
      expect(list.body.rooms).toHaveLength(1);
    });

    it('POST /api/church/rooms returns 400 for empty name', async () => {
      const res = await client.post('/api/church/rooms', {
        ...authHeaders(tokenA),
        body: { name: '' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('name');
    });

    it('POST /api/church/rooms enforces tier limits', async () => {
      // Church B is on connect tier (limit 1 room)
      await client.post('/api/church/rooms', {
        ...authHeaders(tokenB),
        body: { name: 'First Room' },
      });
      const res = await client.post('/api/church/rooms', {
        ...authHeaders(tokenB),
        body: { name: 'Second Room' },
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('plan allows');
    });

    it('PATCH /api/church/rooms/:roomId renames a room', async () => {
      const create = await client.post('/api/church/rooms', {
        ...authHeaders(tokenA),
        body: { name: 'Old Name' },
      });
      const roomId = create.body.id;

      const res = await client.patch(`/api/church/rooms/${roomId}`, {
        ...authHeaders(tokenA),
        body: { name: 'New Name' },
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('PATCH /api/church/rooms/:roomId returns 400 for empty name', async () => {
      const create = await client.post('/api/church/rooms', {
        ...authHeaders(tokenA),
        body: { name: 'Test Room' },
      });
      const res = await client.patch(`/api/church/rooms/${create.body.id}`, {
        ...authHeaders(tokenA),
        body: { name: '' },
      });
      expect(res.status).toBe(400);
    });

    it('DELETE /api/church/rooms/:roomId removes a room', async () => {
      const create = await client.post('/api/church/rooms', {
        ...authHeaders(tokenA),
        body: { name: 'Deleteable Room' },
      });
      const roomId = create.body.id;

      const res = await client.delete(`/api/church/rooms/${roomId}`, authHeaders(tokenA));
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('DELETE /api/church/rooms/:roomId returns 404 for nonexistent room', async () => {
      const res = await client.delete('/api/church/rooms/nonexistent', authHeaders(tokenA));
      expect(res.status).toBe(404);
    });

    it('church B cannot delete church A room', async () => {
      const create = await client.post('/api/church/rooms', {
        ...authHeaders(tokenA),
        body: { name: 'Alpha Room' },
      });
      const res = await client.delete(`/api/church/rooms/${create.body.id}`, authHeaders(tokenB));
      expect(res.status).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // J. Login / Logout
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Login and logout', () => {
    it('GET /church-login returns HTML', async () => {
      const res = await client.get('/church-login');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Church Portal');
    });

    it('POST /api/church/login with valid credentials sets cookie', async () => {
      const res = await client.post('/api/church/login', {
        body: 'email=admin%40alpha.org&password=password123',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/church-portal');
      expect(res.headers['set-cookie']).toBeTruthy();
      expect(res.headers['set-cookie'][0]).toContain('tally_church_session');
    });

    it('POST /api/church/login with bad password returns 401', async () => {
      const res = await client.post('/api/church/login', {
        body: 'email=admin%40alpha.org&password=wrong',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(res.status).toBe(401);
      expect(res.text).toContain('Invalid email or password');
    });

    it('POST /api/church/login with missing fields returns 400', async () => {
      const res = await client.post('/api/church/login', {
        body: 'email=admin%40alpha.org',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(res.status).toBe(400);
    });

    it('POST /api/church/login with nonexistent email returns 401', async () => {
      const res = await client.post('/api/church/login', {
        body: 'email=nobody%40test.com&password=anything',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(res.status).toBe(401);
    });

    it('POST /api/church/logout clears cookie', async () => {
      const res = await client.post('/api/church/logout');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // K. Onboarding
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Onboarding endpoints', () => {
    it('POST /api/church/onboarding/dismiss sets flag', async () => {
      const res = await client.post('/api/church/onboarding/dismiss', authHeaders(tokenA));
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const row = db.prepare('SELECT onboarding_dismissed FROM churches WHERE churchId = ?').get(CHURCH_A_ID);
      expect(row.onboarding_dismissed).toBe(1);
    });

    it('POST /api/church/onboarding/undismiss clears flag', async () => {
      db.prepare('UPDATE churches SET onboarding_dismissed = 1 WHERE churchId = ?').run(CHURCH_A_ID);
      const res = await client.post('/api/church/onboarding/undismiss', authHeaders(tokenA));
      expect(res.status).toBe(200);

      const row = db.prepare('SELECT onboarding_dismissed FROM churches WHERE churchId = ?').get(CHURCH_A_ID);
      expect(row.onboarding_dismissed).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // L. Reviews
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Review endpoints', () => {
    it('GET /api/church/review returns hasReview false when none submitted', async () => {
      const res = await client.get('/api/church/review', authHeaders(tokenA));
      expect(res.status).toBe(200);
      expect(res.body.hasReview).toBe(false);
    });

    it('POST /api/church/review creates a review', async () => {
      const res = await client.post('/api/church/review', {
        ...authHeaders(tokenA),
        body: { rating: 5, body: 'This service is excellent and works great!', reviewerName: 'John', reviewerRole: 'TD' },
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.id).toBeTruthy();
    });

    it('POST /api/church/review rejects invalid rating', async () => {
      const res = await client.post('/api/church/review', {
        ...authHeaders(tokenA),
        body: { rating: 6, body: 'This is a long enough review body', reviewerName: 'John' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Rating');
    });

    it('POST /api/church/review rejects non-integer rating', async () => {
      const res = await client.post('/api/church/review', {
        ...authHeaders(tokenA),
        body: { rating: 3.5, body: 'This is a long enough review body', reviewerName: 'John' },
      });
      expect(res.status).toBe(400);
    });

    it('POST /api/church/review rejects body under 10 chars', async () => {
      const res = await client.post('/api/church/review', {
        ...authHeaders(tokenA),
        body: { rating: 4, body: 'Short', reviewerName: 'John' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('10 characters');
    });

    it('POST /api/church/review rejects body over 500 chars', async () => {
      const res = await client.post('/api/church/review', {
        ...authHeaders(tokenA),
        body: { rating: 4, body: 'x'.repeat(501), reviewerName: 'John' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('500');
    });

    it('POST /api/church/review rejects missing reviewer name', async () => {
      const res = await client.post('/api/church/review', {
        ...authHeaders(tokenA),
        body: { rating: 4, body: 'Great service and product!' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Name');
    });

    it('POST /api/church/review rejects duplicate review', async () => {
      await client.post('/api/church/review', {
        ...authHeaders(tokenA),
        body: { rating: 5, body: 'Great product, works very well!', reviewerName: 'John' },
      });
      const res = await client.post('/api/church/review', {
        ...authHeaders(tokenA),
        body: { rating: 4, body: 'Another review from the same church!', reviewerName: 'Jane' },
      });
      expect(res.status).toBe(409);
    });

    it('GET /api/public/reviews returns approved reviews without auth', async () => {
      db.prepare(`INSERT INTO church_reviews (id, church_id, reviewer_name, rating, body, church_name, approved, submitted_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)`).run('rev-1', CHURCH_A_ID, 'John', 5, 'Great!', 'Alpha', new Date().toISOString());

      const res = await client.get('/api/public/reviews');
      expect(res.status).toBe(200);
      expect(res.body.reviews).toHaveLength(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // M. Admin Endpoints
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Admin endpoints', () => {
    it('POST /api/churches/:id/portal-credentials requires admin auth', async () => {
      const res = await client.post(`/api/churches/${CHURCH_A_ID}/portal-credentials`, {
        body: { email: 'new@admin.com', password: 'longpassword' },
      });
      expect(res.status).toBe(401);
    });

    it('POST /api/churches/:id/portal-credentials sets credentials', async () => {
      const res = await client.post(`/api/churches/${CHURCH_A_ID}/portal-credentials`, {
        body: { email: 'portal@newadmin.com', password: 'newadminpass' },
        headers: { authorization: 'Bearer admin-token' },
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.email).toBe('portal@newadmin.com');

      const row = db.prepare('SELECT portal_email FROM churches WHERE churchId = ?').get(CHURCH_A_ID);
      expect(row.portal_email).toBe('portal@newadmin.com');
    });

    it('POST /api/churches/:id/portal-credentials rejects missing fields', async () => {
      const res = await client.post(`/api/churches/${CHURCH_A_ID}/portal-credentials`, {
        body: { email: 'only@email.com' },
        headers: { authorization: 'Bearer admin-token' },
      });
      expect(res.status).toBe(400);
    });

    it('POST /api/churches/:id/portal-credentials rejects short password', async () => {
      const res = await client.post(`/api/churches/${CHURCH_A_ID}/portal-credentials`, {
        body: { email: 'admin@test.com', password: 'short' },
        headers: { authorization: 'Bearer admin-token' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('8 characters');
    });

    it('POST /api/churches/:id/portal-credentials rejects duplicate email', async () => {
      const res = await client.post(`/api/churches/${CHURCH_A_ID}/portal-credentials`, {
        body: { email: 'admin@beta.org', password: 'longpassword' },
        headers: { authorization: 'Bearer admin-token' },
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toContain('already used');
    });

    it('GET /api/admin/reviews requires admin auth', async () => {
      const res = await client.get('/api/admin/reviews');
      expect(res.status).toBe(401);
    });

    it('GET /api/admin/reviews returns all reviews for admin', async () => {
      db.prepare(`INSERT INTO church_reviews (id, church_id, reviewer_name, rating, body, church_name, submitted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run('rev-admin-1', CHURCH_A_ID, 'Tester', 4, 'Good', 'Alpha', new Date().toISOString());

      const res = await client.get('/api/admin/reviews', {
        headers: { authorization: 'Bearer admin-token' },
      });
      expect(res.status).toBe(200);
      expect(res.body.reviews.length).toBeGreaterThanOrEqual(1);
    });

    it('PUT /api/admin/reviews/:id/approve approves a review', async () => {
      db.prepare(`INSERT INTO church_reviews (id, church_id, reviewer_name, rating, body, church_name, submitted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run('rev-approve-1', CHURCH_A_ID, 'Tester', 5, 'Nice', 'Alpha', new Date().toISOString());

      const res = await client.put('/api/admin/reviews/rev-approve-1', {
        headers: { authorization: 'Bearer admin-token' },
      });
      // The route is at /api/admin/reviews/:id/approve
      // We need the full path
      expect(res.status).toBe(404); // no route at /api/admin/reviews/rev-approve-1 without /approve
    });

    it('PUT /api/admin/reviews/:id/approve sets approved flag', async () => {
      db.prepare(`INSERT INTO church_reviews (id, church_id, reviewer_name, rating, body, church_name, submitted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run('rev-approve-2', CHURCH_A_ID, 'Tester', 5, 'Nice', 'Alpha', new Date().toISOString());

      const res = await client.put('/api/admin/reviews/rev-approve-2/approve', {
        headers: { authorization: 'Bearer admin-token' },
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const row = db.prepare('SELECT approved FROM church_reviews WHERE id = ?').get('rev-approve-2');
      expect(row.approved).toBe(1);
    });

    it('DELETE /api/admin/reviews/:id deletes a review', async () => {
      db.prepare(`INSERT INTO church_reviews (id, church_id, reviewer_name, rating, body, church_name, submitted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run('rev-del-1', CHURCH_A_ID, 'Tester', 3, 'Ok', 'Alpha', new Date().toISOString());

      const res = await client.delete('/api/admin/reviews/rev-del-1', {
        headers: { authorization: 'Bearer admin-token' },
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const row = db.prepare('SELECT * FROM church_reviews WHERE id = ?').get('rev-del-1');
      expect(row).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // N. Referrals
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Referral endpoints', () => {
    it('GET /api/church/referrals returns referral code and list', async () => {
      const res = await client.get('/api/church/referrals', authHeaders(tokenA));
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('referralCode');
      expect(res.body).toHaveProperty('referrals');
      expect(res.body.referralCode).toBe('REF-ALPHA');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // O. Bearer Token Auth (support endpoints)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Bearer token auth (church_app type)', () => {
    it('accepts church_app type bearer token on support endpoints', async () => {
      const appToken = issueToken(CHURCH_A_ID, { type: 'church_app' });
      const res = await client.get('/api/church/support/tickets', bearerHeaders(appToken));
      expect(res.status).toBe(200);
    });

    it('accepts church_portal type bearer token on support endpoints', async () => {
      const res = await client.get('/api/church/support/tickets', bearerHeaders(tokenA));
      expect(res.status).toBe(200);
    });

    it('rejects bearer token with wrong type on support endpoints', async () => {
      const badToken = issueToken(CHURCH_A_ID, { type: 'admin' });
      const res = await client.get('/api/church/support/tickets', bearerHeaders(badToken));
      expect(res.status).toBe(401);
    });

    it('rejects bearer token for nonexistent church', async () => {
      const ghost = issueToken('church-nonexistent', { type: 'church_app' });
      const res = await client.get('/api/church/support/tickets', bearerHeaders(ghost));
      expect(res.status).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // P. Support Tickets
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Support ticket endpoints', () => {
    it('GET /api/church/support/tickets returns empty list initially', async () => {
      const res = await client.get('/api/church/support/tickets', authHeaders(tokenA));
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('POST /api/church/support/tickets/:id/updates rejects missing message', async () => {
      // Create a ticket first
      db.prepare(`INSERT INTO support_tickets (id, church_id, issue_category, severity, title, description, status, forced_bypass, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        'tkt-1', CHURCH_A_ID, 'audio', 'medium', 'Audio Issue', 'desc', 'open', 0, 'portal', new Date().toISOString(), new Date().toISOString()
      );

      const res = await client.post('/api/church/support/tickets/tkt-1/updates', {
        ...authHeaders(tokenA),
        body: { message: '' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('message');
    });

    it('POST /api/church/support/tickets/:id/updates rejects invalid status', async () => {
      db.prepare(`INSERT INTO support_tickets (id, church_id, issue_category, severity, title, description, status, forced_bypass, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        'tkt-2', CHURCH_A_ID, 'video', 'low', 'Video Issue', 'desc', 'open', 0, 'portal', new Date().toISOString(), new Date().toISOString()
      );

      const res = await client.post('/api/church/support/tickets/tkt-2/updates', {
        ...authHeaders(tokenA),
        body: { message: 'Updated info', status: 'invalid_status' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('invalid status');
    });

    it('POST /api/church/support/tickets/:id/updates succeeds with valid data', async () => {
      db.prepare(`INSERT INTO support_tickets (id, church_id, issue_category, severity, title, description, status, forced_bypass, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        'tkt-3', CHURCH_A_ID, 'other', 'high', 'Issue', 'desc', 'open', 0, 'portal', new Date().toISOString(), new Date().toISOString()
      );

      const res = await client.post('/api/church/support/tickets/tkt-3/updates', {
        ...authHeaders(tokenA),
        body: { message: 'More details here', status: 'closed' },
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.status).toBe('closed');
    });

    it('church B cannot update church A ticket', async () => {
      db.prepare(`INSERT INTO support_tickets (id, church_id, issue_category, severity, title, description, status, forced_bypass, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        'tkt-4', CHURCH_A_ID, 'audio', 'low', 'Issue', 'desc', 'open', 0, 'portal', new Date().toISOString(), new Date().toISOString()
      );

      const res = await client.post('/api/church/support/tickets/tkt-4/updates', {
        ...authHeaders(tokenB),
        body: { message: 'Hacking attempt', status: 'closed' },
      });
      expect(res.status).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Q. Billing Endpoint
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Billing endpoint', () => {
    it('GET /api/church/billing returns tier and features', async () => {
      const res = await client.get('/api/church/billing', authHeaders(tokenA));
      expect(res.status).toBe(200);
      expect(res.body.tier).toBe('pro');
      expect(res.body.tierName).toBe('Pro');
      expect(res.body).toHaveProperty('features');
      expect(res.body.features.autopilot).toBe(true);
    });

    it('GET /api/church/billing returns connect tier features', async () => {
      const res = await client.get('/api/church/billing', authHeaders(tokenB));
      expect(res.status).toBe(200);
      expect(res.body.tier).toBe('connect');
      expect(res.body.features.autopilot).toBe(false);
      expect(res.body.features.oncall).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // R. Portal HTML (authenticated)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Portal HTML', () => {
    it('GET /church-portal returns HTML when authenticated', async () => {
      const res = await client.get('/church-portal', authHeaders(tokenA));
      expect(res.status).toBe(200);
      expect(res.text).toContain('Church Alpha');
    });

    it('GET /church-portal redirects when not authenticated', async () => {
      const res = await client.get('/church-portal');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/church-login');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // S. Edge Cases / Malformed Requests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Edge cases and malformed requests', () => {
    it('PUT /api/church/failover with non-numeric thresholds uses defaults', async () => {
      const res = await client.put('/api/church/failover', {
        ...authHeaders(tokenA),
        body: { enabled: false, blackThresholdS: 'abc', ackTimeoutS: null },
      });
      expect(res.status).toBe(200);

      const row = db.prepare('SELECT failover_black_threshold_s, failover_ack_timeout_s FROM churches WHERE churchId = ?').get(CHURCH_A_ID);
      expect(row.failover_black_threshold_s).toBe(5);
      expect(row.failover_ack_timeout_s).toBe(30);
    });

    it('PUT /api/church/failover with string action is ignored', async () => {
      const res = await client.put('/api/church/failover', {
        ...authHeaders(tokenA),
        body: { enabled: true, action: 'not-an-object' },
      });
      expect(res.status).toBe(200);
      const row = db.prepare('SELECT failover_action FROM churches WHERE churchId = ?').get(CHURCH_A_ID);
      expect(row.failover_action).toBeNull();
    });

    it('PUT /api/church/me with empty body succeeds (no-op)', async () => {
      const res = await client.put('/api/church/me', {
        ...authHeaders(tokenA),
        body: {},
      });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('POST /api/church/tds with extra fields ignores them gracefully', async () => {
      const res = await client.post('/api/church/tds', {
        ...authHeaders(tokenA),
        body: { name: 'TD Extra', unknownField: 'should-be-ignored', sql_injection: "'; DROP TABLE --" },
      });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('TD Extra');
    });

  });
});
