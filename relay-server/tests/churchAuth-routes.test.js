/**
 * Tests for src/routes/churchAuth.js
 *
 * Focuses on: login, GET /me, PUT /me (profile update), and admin
 * password reset. The onboard flow is intentionally lighter-weight
 * here because it depends on billing integration.
 *
 * Uses in-memory SQLite + real Express.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import http from 'http';

const require = createRequire(import.meta.url);
const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { hashPassword, verifyPassword } = require('../src/auth');
const setupChurchAuthRoutes = require('../src/routes/churchAuth');

const JWT_SECRET = 'test-church-auth-secret';
const CHURCH_APP_TOKEN_TTL = '7d';

// ─── DB helpers ───────────────────────────────────────────────────────────────

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT DEFAULT '',
      token TEXT DEFAULT '',
      registeredAt TEXT NOT NULL,
      portal_email TEXT,
      portal_password_hash TEXT,
      email_verified INTEGER DEFAULT 0,
      email_verify_token TEXT,
      email_verify_sent_at TEXT,
      billing_tier TEXT DEFAULT 'connect',
      billing_status TEXT DEFAULT 'active',
      billing_trial_ends TEXT,
      billing_interval TEXT DEFAULT 'monthly',
      tos_accepted_at TEXT,
      referral_code TEXT,
      referred_by TEXT,
      notifications TEXT DEFAULT '{}',
      phone TEXT,
      location TEXT,
      notes TEXT,
      telegram_chat_id TEXT,
      engineer_profile TEXT,
      audio_via_atem INTEGER DEFAULT 0,
      campus_id TEXT,
      registration_code TEXT,
      reseller_id TEXT,
      failover_enabled INTEGER DEFAULT 0
    )
  `);
  db.exec(`
    CREATE TABLE church_tds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT NOT NULL,
      telegram_user_id TEXT,
      telegram_chat_id TEXT,
      name TEXT,
      registered_at TEXT,
      active INTEGER DEFAULT 1,
      role TEXT DEFAULT 'td'
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
    CREATE TABLE problem_finder_reports (
      id TEXT PRIMARY KEY,
      church_id TEXT,
      trigger_type TEXT,
      status TEXT,
      issue_count INTEGER,
      auto_fixed_count INTEGER,
      coverage_score REAL,
      blocker_count INTEGER,
      issues_json TEXT,
      blockers_json TEXT,
      auto_fixed_json TEXT,
      needs_attention_json TEXT,
      top_actions_json TEXT,
      created_at TEXT
    )
  `);
  return db;
}

function seedChurch(db, opts = {}) {
  const churchId = opts.churchId || uuidv4();
  const passwordHash = opts.password ? hashPassword(opts.password) : null;
  db.prepare(`
    INSERT INTO churches
      (churchId, name, email, token, registeredAt, portal_email, portal_password_hash, billing_status, billing_tier, billing_trial_ends)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    churchId,
    opts.name || 'Test Church',
    opts.email || 'test@church.com',
    'tok',
    new Date().toISOString(),
    opts.portal_email || null,
    passwordHash,
    opts.billing_status || 'active',
    opts.billing_tier || 'connect',
    opts.billing_trial_ends || null,
  );
  return churchId;
}

function seedAdmin(db, opts = {}) {
  const id = uuidv4();
  db.prepare(
    'INSERT INTO admin_users (id, email, password_hash, name, role, active, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(id, opts.email || 'admin@test.com', hashPassword(opts.password || 'Admin1234!'), opts.name || 'Admin', opts.role || 'super_admin', 1, new Date().toISOString());
  return id;
}

// ─── App factory ──────────────────────────────────────────────────────────────

function buildApp(db, overrides = {}) {
  const app = express();
  app.use(express.json());

  const churches = new Map();

  function requireChurchAppAuth(req, res, next) {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Authorization: Bearer <token> required' });
    try {
      const payload = jwt.verify(auth.slice(7), JWT_SECRET);
      if (payload.type !== 'church_app') throw new Error('wrong type');
      const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get(payload.churchId);
      if (!church) return res.status(404).json({ error: 'Church not found' });
      req.church = church;
      return next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  }

  function requireAdmin(req, res, next) {
    const authHeader = req.headers['authorization'] || '';
    let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : req.headers['x-admin-jwt'];
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (payload.type !== 'admin') throw new Error('wrong type');
      const user = db.prepare('SELECT id, email, name, role, active FROM admin_users WHERE id = ?').get(payload.userId);
      if (!user || !user.active) return res.status(401).json({ error: 'Account deactivated' });
      req.adminUser = user;
      return next();
    } catch {
      return res.status(401).json({ error: 'Invalid admin token' });
    }
  }

  function issueChurchAppToken(churchId, name) {
    return jwt.sign({ type: 'church_app', churchId, name }, JWT_SECRET, { expiresIn: CHURCH_APP_TOKEN_TTL });
  }

  function checkChurchPaidAccess(churchId) {
    const church = db.prepare('SELECT billing_status, billing_tier, billing_interval, billing_trial_ends FROM churches WHERE churchId = ?').get(churchId);
    if (!church) return { allowed: false, status: 'inactive', message: 'Church not found' };
    const status = church.billing_status || 'inactive';
    if (['active', 'trialing', 'grace'].includes(status)) {
      return { allowed: true, status, tier: church.billing_tier, billingInterval: church.billing_interval };
    }
    return { allowed: false, status, tier: church.billing_tier, billingInterval: church.billing_interval, message: `Billing status: ${status}` };
  }

  const sendOnboardingEmail = vi.fn().mockResolvedValue(undefined);
  const lifecycleEmails = {
    captureLead: vi.fn((data) => ({ id: 'lead-1', ...data })),
    sendLeadWelcome: vi.fn().mockResolvedValue(undefined),
    sendRegistrationConfirmation: vi.fn().mockResolvedValue(undefined),
    sendPasswordReset: vi.fn().mockResolvedValue(undefined),
  };

  const stmtInsert = db.prepare(
    'INSERT INTO churches (churchId, name, email, token, registeredAt) VALUES (?, ?, ?, ?, ?)'
  );
  const stmtFindByName = db.prepare('SELECT * FROM churches WHERE name = ?');
  const stmtUpdateRegistrationCode = db.prepare('UPDATE churches SET registration_code = ? WHERE churchId = ?');

  const billing = {
    isEnabled: () => false,
    createCheckout: vi.fn().mockResolvedValue({ url: null, sessionId: null }),
  };

  const ctx = {
    db,
    churches,
    requireAdmin,
    requireChurchAppAuth,
    rateLimit: () => (req, res, next) => next(),
    billing,
    hashPassword,
    verifyPassword,
    normalizeBillingInterval: (v, tier, defaultInterval) => defaultInterval || 'monthly',
    issueChurchAppToken,
    checkChurchPaidAccess,
    generateRegistrationCode: () => 'AABBCC',
    sendOnboardingEmail,
    lifecycleEmails,
    broadcastToSSE: vi.fn(),
    stmtInsert,
    stmtFindByName,
    stmtUpdateRegistrationCode,
    jwt,
    JWT_SECRET,
    CHURCH_APP_TOKEN_TTL,
    REQUIRE_ACTIVE_BILLING: false,
    TRIAL_PERIOD_DAYS: 14,
    uuidv4,
    safeErrorMessage: (e) => e.message,
    log: vi.fn(),
    ...overrides,
  };

  setupChurchAuthRoutes(app, ctx);
  return { app, churches, mocks: { sendOnboardingEmail, lifecycleEmails, billing } };
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function makeClient(app) {
  const server = app.listen(0);
  const port = server.address().port;

  function call(method, path, { body, token, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const opts = {
        method: method.toUpperCase(),
        hostname: '127.0.0.1',
        port,
        path,
        headers: { ...headers },
      };
      if (token) opts.headers['Authorization'] = `Bearer ${token}`;
      let payload;
      if (body !== undefined) {
        payload = JSON.stringify(body);
        opts.headers['Content-Type'] = 'application/json';
        opts.headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const req = http.request(opts, (res) => {
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => {
          let json;
          try { json = JSON.parse(data); } catch { json = data; }
          resolve({ status: res.statusCode, body: json });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  return {
    get: (path, opts) => call('GET', path, opts),
    post: (path, opts) => call('POST', path, opts),
    put: (path, opts) => call('PUT', path, opts),
    close: () => new Promise(r => server.close(r)),
  };
}

function issueChurchToken(churchId) {
  return jwt.sign({ type: 'church_app', churchId }, JWT_SECRET, { expiresIn: '1h' });
}

function issueAdminToken(userId, role = 'super_admin') {
  return jwt.sign({ type: 'admin', userId, role }, JWT_SECRET, { expiresIn: '8h' });
}

// ─── POST /api/church/app/login ───────────────────────────────────────────────

describe('POST /api/church/app/login', () => {
  let db, client;

  beforeEach(() => {
    db = createDb();
    client = makeClient(buildApp(db).app);
  });
  afterEach(() => client.close());

  it('returns 400 when email or password missing', async () => {
    const { status } = await client.post('/api/church/app/login', { body: { email: 'x@x.com' } });
    expect(status).toBe(400);
  });

  it('returns 401 for unknown email', async () => {
    const { status, body } = await client.post('/api/church/app/login', {
      body: { email: 'nobody@test.com', password: 'Test1234!' },
    });
    expect(status).toBe(401);
    expect(body.error).toMatch(/invalid/i);
  });

  it('returns 401 for wrong password', async () => {
    seedChurch(db, { portal_email: 'td@church.com', password: 'Correct1234!' });
    const { status } = await client.post('/api/church/app/login', {
      body: { email: 'td@church.com', password: 'Wrong1234!' },
    });
    expect(status).toBe(401);
  });

  it('returns 401 when church has no password hash', async () => {
    seedChurch(db, { portal_email: 'nopw@church.com' }); // password not set
    const { status } = await client.post('/api/church/app/login', {
      body: { email: 'nopw@church.com', password: 'Whatever1234!' },
    });
    expect(status).toBe(401);
  });

  it('returns token and church on valid credentials', async () => {
    const churchId = seedChurch(db, {
      name: 'Grace Church', portal_email: 'grace@church.com', password: 'Grace1234!', billing_status: 'active',
    });
    const { status, body } = await client.post('/api/church/app/login', {
      body: { email: 'grace@church.com', password: 'Grace1234!' },
    });
    expect(status).toBe(200);
    expect(body.token).toBeTruthy();
    expect(body.church.churchId).toBe(churchId);
    expect(body.church.name).toBe('Grace Church');
  });

  it('normalises email to lowercase before lookup', async () => {
    seedChurch(db, { portal_email: 'grace@church.com', password: 'Grace1234!', billing_status: 'active' });
    const { status } = await client.post('/api/church/app/login', {
      body: { email: 'GRACE@CHURCH.COM', password: 'Grace1234!' },
    });
    expect(status).toBe(200);
  });

  it('returns 402 when billing is not allowed', async () => {
    seedChurch(db, { portal_email: 'cancelled@church.com', password: 'Cancelled1234!', billing_status: 'cancelled' });
    const { status, body } = await client.post('/api/church/app/login', {
      body: { email: 'cancelled@church.com', password: 'Cancelled1234!' },
    });
    expect(status).toBe(402);
    expect(body.billing).toBeTruthy();
  });
});

// ─── GET /api/church/app/me ───────────────────────────────────────────────────

describe('GET /api/church/app/me', () => {
  let db, client;

  beforeEach(() => {
    db = createDb();
    client = makeClient(buildApp(db).app);
  });
  afterEach(() => client.close());

  it('returns 401 without token', async () => {
    const { status } = await client.get('/api/church/app/me');
    expect(status).toBe(401);
  });

  it('returns 401 for invalid token', async () => {
    const { status } = await client.get('/api/church/app/me', { token: 'not-a-jwt' });
    expect(status).toBe(401);
  });

  it('returns church profile for valid token (excludes password_hash and token)', async () => {
    const churchId = seedChurch(db, { name: 'Hope Church', portal_email: 'hope@church.com', password: 'Hope1234!' });
    const token = issueChurchToken(churchId);
    const { status, body } = await client.get('/api/church/app/me', { token });
    expect(status).toBe(200);
    expect(body.churchId).toBe(churchId);
    expect(body.name).toBe('Hope Church');
    expect(body.portal_password_hash).toBeUndefined();
    expect(body.token).toBeUndefined();
  });
});

// ─── PUT /api/church/app/me ───────────────────────────────────────────────────

describe('PUT /api/church/app/me', () => {
  let db, client;

  beforeEach(() => {
    db = createDb();
    client = makeClient(buildApp(db).app);
  });
  afterEach(() => client.close());

  it('returns 401 without token', async () => {
    const { status } = await client.put('/api/church/app/me', { body: { phone: '555-1234' } });
    expect(status).toBe(401);
  });

  it('updates phone and location', async () => {
    const churchId = seedChurch(db, { portal_email: 'hope@church.com', password: 'Hope1234!' });
    const token = issueChurchToken(churchId);
    const { status, body } = await client.put('/api/church/app/me', {
      token,
      body: { phone: '555-9999', location: 'New York' },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const row = db.prepare('SELECT phone, location FROM churches WHERE churchId = ?').get(churchId);
    expect(row.phone).toBe('555-9999');
    expect(row.location).toBe('New York');
  });

  it('updates password when currentPassword is correct', async () => {
    const churchId = seedChurch(db, { portal_email: 'pw@church.com', password: 'OldPass1234!' });
    const token = issueChurchToken(churchId);
    const { status } = await client.put('/api/church/app/me', {
      token,
      body: { currentPassword: 'OldPass1234!', newPassword: 'NewPass1234!' },
    });
    expect(status).toBe(200);
    const row = db.prepare('SELECT portal_password_hash FROM churches WHERE churchId = ?').get(churchId);
    expect(verifyPassword('NewPass1234!', row.portal_password_hash)).toBe(true);
  });

  it('returns 400 when newPassword is too short', async () => {
    const churchId = seedChurch(db, { portal_email: 'pw@church.com', password: 'OldPass1234!' });
    const token = issueChurchToken(churchId);
    const { status } = await client.put('/api/church/app/me', {
      token,
      body: { currentPassword: 'OldPass1234!', newPassword: 'short' },
    });
    expect(status).toBe(400);
  });

  it('returns 400 when currentPassword is missing but newPassword provided', async () => {
    const churchId = seedChurch(db, { portal_email: 'pw@church.com', password: 'OldPass1234!' });
    const token = issueChurchToken(churchId);
    const { status } = await client.put('/api/church/app/me', {
      token,
      body: { newPassword: 'NewPass1234!' },
    });
    expect(status).toBe(400);
  });

  it('returns 400 when currentPassword is incorrect', async () => {
    const churchId = seedChurch(db, { portal_email: 'pw@church.com', password: 'OldPass1234!' });
    const token = issueChurchToken(churchId);
    const { status } = await client.put('/api/church/app/me', {
      token,
      body: { currentPassword: 'WrongOldPass!', newPassword: 'NewPass1234!' },
    });
    expect(status).toBe(400);
  });

  it('returns 409 when updating to an already-used email', async () => {
    const churchId1 = seedChurch(db, { portal_email: 'first@church.com', password: 'First1234!' });
    const churchId2 = seedChurch(db, { portal_email: 'second@church.com', password: 'Second1234!' });
    const token = issueChurchToken(churchId1);
    const { status, body } = await client.put('/api/church/app/me', {
      token,
      body: { email: 'second@church.com' },
    });
    expect(status).toBe(409);
    expect(body.error).toMatch(/already in use/i);
  });
});

// ─── POST /api/church/app/reset-password (admin only) ─────────────────────────

describe('POST /api/church/app/reset-password', () => {
  let db, client;

  beforeEach(() => {
    db = createDb();
    client = makeClient(buildApp(db).app);
  });
  afterEach(() => client.close());

  it('returns 401 without admin token', async () => {
    const { status } = await client.post('/api/church/app/reset-password', {
      body: { email: 'x@x.com', password: 'NewPass1234!' },
    });
    expect(status).toBe(401);
  });

  it('returns 400 for missing email/password', async () => {
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status } = await client.post('/api/church/app/reset-password', {
      token,
      body: { email: 'x@x.com' },
    });
    expect(status).toBe(400);
  });

  it('returns 400 for short password', async () => {
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status } = await client.post('/api/church/app/reset-password', {
      token,
      body: { email: 'x@x.com', password: 'short' },
    });
    expect(status).toBe(400);
  });

  it('returns 404 for unknown church email', async () => {
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status } = await client.post('/api/church/app/reset-password', {
      token,
      body: { email: 'nobody@x.com', password: 'NewPass1234!' },
    });
    expect(status).toBe(404);
  });

  it('resets password successfully for known church', async () => {
    const adminId = seedAdmin(db);
    const churchId = seedChurch(db, { portal_email: 'reset@church.com', password: 'OldPass1234!' });
    const token = issueAdminToken(adminId);
    const { status, body } = await client.post('/api/church/app/reset-password', {
      token,
      body: { email: 'reset@church.com', password: 'AdminNewPass1234!' },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    const row = db.prepare('SELECT portal_password_hash FROM churches WHERE churchId = ?').get(churchId);
    expect(verifyPassword('AdminNewPass1234!', row.portal_password_hash)).toBe(true);
  });
});

// ─── POST /api/church/app/onboard (basic validation) ─────────────────────────

describe('POST /api/church/app/onboard', () => {
  let db, client;

  beforeEach(() => {
    db = createDb();
    // Need billing_customers table for cleanup logic
    db.exec('CREATE TABLE IF NOT EXISTS billing_customers (id INTEGER PRIMARY KEY, church_id TEXT)');
    db.exec('CREATE TABLE IF NOT EXISTS referrals (id TEXT PRIMARY KEY, referrer_id TEXT, referred_id TEXT, referred_name TEXT, status TEXT, created_at TEXT)');
    client = makeClient(buildApp(db).app);
  });
  afterEach(() => client.close());

  it('returns 400 when name is missing', async () => {
    const { status, body } = await client.post('/api/church/app/onboard', {
      body: { email: 'new@church.com', password: 'Pass1234!' },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/name/i);
  });

  it('returns 400 when email is missing', async () => {
    const { status } = await client.post('/api/church/app/onboard', {
      body: { name: 'New Church', password: 'Pass1234!' },
    });
    expect(status).toBe(400);
  });

  it('returns 400 when password is too short', async () => {
    const { status } = await client.post('/api/church/app/onboard', {
      body: { name: 'New Church', email: 'new@church.com', password: 'short' },
    });
    expect(status).toBe(400);
  });

  it('returns 400 for invalid tier', async () => {
    const { status } = await client.post('/api/church/app/onboard', {
      body: { name: 'New Church', email: 'new@church.com', password: 'Pass1234!', tier: 'diamond' },
    });
    expect(status).toBe(400);
  });

  it('creates church and returns 201 with token', async () => {
    const { status, body } = await client.post('/api/church/app/onboard', {
      body: { name: 'Brand New Church', email: 'brand@new.com', password: 'Pass1234!', tier: 'connect' },
    });
    expect(status).toBe(201);
    expect(body.created).toBe(true);
    expect(body.token).toBeTruthy();
    expect(body.churchId).toBeTruthy();
  });

  it('returns 409 for duplicate active church name', async () => {
    seedChurch(db, { name: 'Duplicate Church', portal_email: 'dup@church.com', billing_status: 'active' });
    const { status, body } = await client.post('/api/church/app/onboard', {
      body: { name: 'Duplicate Church', email: 'new@church.com', password: 'Pass1234!' },
    });
    expect(status).toBe(409);
    expect(body.error).toMatch(/already exists/i);
  });

  it('returns 409 for duplicate active portal email', async () => {
    seedChurch(db, { portal_email: 'taken@church.com', billing_status: 'active' });
    const { status, body } = await client.post('/api/church/app/onboard', {
      body: { name: 'Unique Church', email: 'taken@church.com', password: 'Pass1234!' },
    });
    expect(status).toBe(409);
    expect(body.error).toMatch(/email already exists/i);
  });
});

// ─── GET /api/referral/:code ──────────────────────────────────────────────────

describe('GET /api/referral/:code', () => {
  let db, client;

  beforeEach(() => {
    db = createDb();
    client = makeClient(buildApp(db).app);
  });
  afterEach(() => client.close());

  it('returns 400 for a code too short', async () => {
    const { status } = await client.get('/api/referral/AB');
    expect(status).toBe(400);
  });

  it('returns {valid:false} for unknown code', async () => {
    const { status, body } = await client.get('/api/referral/XXXXXX');
    expect(status).toBe(200);
    expect(body.valid).toBe(false);
  });

  it('returns {valid:true, referrerName} for known referral code', async () => {
    db.prepare('UPDATE churches SET referral_code = ? WHERE churchId = ?')
      .run('ABCDEF', seedChurch(db, { name: 'Referring Church' }));
    const { status, body } = await client.get('/api/referral/ABCDEF');
    expect(status).toBe(200);
    expect(body.valid).toBe(true);
    expect(body.referrerName).toBe('Referring Church');
  });
});
