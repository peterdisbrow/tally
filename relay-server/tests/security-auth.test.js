/**
 * Security tests — authentication bypass, token misuse, and session security.
 *
 * Tests the authMiddleware (requireAdminJwt, requireChurchAppAuth,
 * requireChurchOrAdmin) and the churchPortal requireChurchPortalAuth directly,
 * without spinning up a full HTTP server.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');

const JWT_SECRET = 'test-security-secret-xyz';
const OTHER_SECRET = 'different-secret-entirely';

// ─── Minimal DB helpers ────────────────────────────────────────────────────────

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT,
      email TEXT DEFAULT '',
      token TEXT DEFAULT '',
      registeredAt TEXT DEFAULT '',
      portal_email TEXT DEFAULT '',
      portal_password_hash TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      location TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      notifications TEXT DEFAULT '{}',
      billing_tier TEXT DEFAULT 'connect',
      billing_status TEXT DEFAULT 'active',
      billing_interval TEXT DEFAULT 'monthly',
      registration_code TEXT DEFAULT '',
      referral_code TEXT DEFAULT '',
      auto_recovery_enabled INTEGER DEFAULT 1,
      onboarding_dismissed INTEGER DEFAULT 0
    )
  `);
  db.exec(`
    CREATE TABLE admin_users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      name TEXT,
      role TEXT DEFAULT 'admin',
      password_hash TEXT,
      active INTEGER DEFAULT 1,
      last_login_at TEXT
    )
  `);
  db.exec(`
    CREATE TABLE resellers (
      id TEXT PRIMARY KEY,
      name TEXT,
      api_key TEXT UNIQUE,
      active INTEGER DEFAULT 1
    )
  `);
  return db;
}

function seedChurch(db, churchId = 'church-sec-001') {
  db.prepare(`
    INSERT OR REPLACE INTO churches (churchId, name, email, registeredAt, billing_tier)
    VALUES (?, ?, ?, ?, ?)
  `).run(churchId, 'Security Test Church', 'sec@test.com', '2024-01-01T00:00:00.000Z', 'pro');
  return churchId;
}

function seedAdmin(db, opts = {}) {
  const { hashPassword } = require('../src/auth');
  const id = opts.id || 'admin-sec-001';
  const role = opts.role || 'admin';
  db.prepare(`
    INSERT OR REPLACE INTO admin_users (id, email, name, role, password_hash, active)
    VALUES (?, ?, ?, ?, ?, 1)
  `).run(id, opts.email || 'sec@admin.com', opts.name || 'Sec Admin', role, hashPassword('password'));
  return id;
}

function makeCtx(db) {
  const ADMIN_API_KEY = 'sk-test-admin-key-123';
  return {
    db,
    JWT_SECRET,
    ADMIN_API_KEY,
    safeCompareKey: (a, b) => a === b,
    resolveAdminKey: (req) => req.headers['x-admin-api-key'] || '',
  };
}

function buildMiddleware(db) {
  const createAuthMiddleware = require('../src/routes/authMiddleware');
  return createAuthMiddleware(makeCtx(db));
}

// Minimal mock req/res/next pattern
function makeReq(headers = {}, params = {}) {
  return { headers, params, path: '/api/test', cookies: {} };
}

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    send(payload) { this.body = payload; return this; },
  };
  return res;
}

// ─── requireAdminJwt ──────────────────────────────────────────────────────────

describe('requireAdminJwt — auth bypass attempts', () => {
  let mw, db;

  beforeEach(() => {
    db = makeDb();
    seedAdmin(db);
    mw = buildMiddleware(db);
  });

  it('rejects request with no Authorization header', () => {
    const req = makeReq({});
    const res = makeRes();
    const next = () => { throw new Error('next() should not be called'); };
    mw.requireAdminJwt()(req, res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBeTruthy();
  });

  it('rejects Bearer token signed with a different secret', () => {
    const adminId = seedAdmin(db, { id: 'admin-x1', email: 'x1@admin.com' });
    const badToken = jwt.sign({ type: 'admin', userId: adminId, role: 'admin' }, OTHER_SECRET, { expiresIn: '1h' });
    const req = makeReq({ authorization: `Bearer ${badToken}` });
    const res = makeRes();
    mw.requireAdminJwt()(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });

  it('rejects an expired admin JWT', () => {
    const adminId = seedAdmin(db, { id: 'admin-exp', email: 'exp@admin.com' });
    const expiredToken = jwt.sign(
      { type: 'admin', userId: adminId, role: 'admin' },
      JWT_SECRET,
      { expiresIn: -1 } // already expired
    );
    const req = makeReq({ authorization: `Bearer ${expiredToken}` });
    const res = makeRes();
    mw.requireAdminJwt()(req, res, () => {});
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/expired/i);
  });

  it('rejects a church_portal JWT used as admin token', () => {
    const churchToken = jwt.sign(
      { type: 'church_portal', churchId: 'church-x' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    const req = makeReq({ authorization: `Bearer ${churchToken}` });
    const res = makeRes();
    mw.requireAdminJwt()(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });

  it('rejects "Bearer " with no token after the space', () => {
    const req = makeReq({ authorization: 'Bearer ' });
    const res = makeRes();
    mw.requireAdminJwt()(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });

  it('rejects Authorization header without "Bearer " prefix', () => {
    const adminId = seedAdmin(db, { id: 'admin-nobearer', email: 'nobearer@admin.com' });
    const token = jwt.sign({ type: 'admin', userId: adminId, role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
    // Send raw token without "Bearer "
    const req = makeReq({ authorization: token });
    const res = makeRes();
    mw.requireAdminJwt()(req, res, () => {});
    // Without the Bearer prefix the middleware sees no valid token
    expect(res.statusCode).toBe(401);
  });

  it('rejects Authorization: "null" string', () => {
    const req = makeReq({ authorization: 'null' });
    const res = makeRes();
    mw.requireAdminJwt()(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });

  it('rejects Authorization: "undefined" string', () => {
    const req = makeReq({ authorization: 'undefined' });
    const res = makeRes();
    mw.requireAdminJwt()(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });

  it('rejects Authorization: empty string', () => {
    const req = makeReq({ authorization: '' });
    const res = makeRes();
    mw.requireAdminJwt()(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });

  it('rejects a valid admin JWT for a deactivated user', () => {
    const adminId = seedAdmin(db, { id: 'admin-disabled', email: 'disabled@admin.com' });
    // Deactivate the user
    db.prepare('UPDATE admin_users SET active = 0 WHERE id = ?').run(adminId);
    const token = jwt.sign({ type: 'admin', userId: adminId, role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
    const req = makeReq({ authorization: `Bearer ${token}` });
    const res = makeRes();
    mw.requireAdminJwt()(req, res, () => {});
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/deactivated|not found/i);
  });

  it('rejects a JWT referencing a userId that does not exist in DB', () => {
    const token = jwt.sign(
      { type: 'admin', userId: 'ghost-user-99999', role: 'admin' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
    const req = makeReq({ authorization: `Bearer ${token}` });
    const res = makeRes();
    mw.requireAdminJwt()(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });

  it('rejects an engineer token attempting access to super_admin-only endpoint', () => {
    const adminId = seedAdmin(db, { id: 'eng-user', email: 'eng@admin.com', role: 'engineer' });
    const token = jwt.sign({ type: 'admin', userId: adminId, role: 'engineer' }, JWT_SECRET, { expiresIn: '1h' });
    const req = makeReq({ authorization: `Bearer ${token}` });
    const res = makeRes();
    // requireAdminJwt('super_admin') only allows super_admin
    mw.requireAdminJwt('super_admin')(req, res, () => {});
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/permission/i);
  });

  it('rejects a sales token attempting access to engineer-only endpoint', () => {
    const adminId = seedAdmin(db, { id: 'sales-user', email: 'sales@admin.com', role: 'sales' });
    const token = jwt.sign({ type: 'admin', userId: adminId, role: 'sales' }, JWT_SECRET, { expiresIn: '1h' });
    const req = makeReq({ authorization: `Bearer ${token}` });
    const res = makeRes();
    mw.requireAdminJwt('engineer')(req, res, () => {});
    expect(res.statusCode).toBe(403);
  });

  it('allows a valid admin JWT with correct role', () => {
    const adminId = seedAdmin(db, { id: 'admin-valid', email: 'valid@admin.com', role: 'admin' });
    const token = jwt.sign({ type: 'admin', userId: adminId, role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
    const req = makeReq({ authorization: `Bearer ${token}` });
    const res = makeRes();
    let nextCalled = false;
    mw.requireAdminJwt()(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBeNull();
  });
});

describe('requireAdmin — legacy admin API key fallback', () => {
  let mw, db;

  beforeEach(() => {
    db = makeDb();
    seedAdmin(db);
    mw = buildMiddleware(db);
  });

  it('allows the configured admin API key without requiring a JWT', () => {
    const req = makeReq({ 'x-admin-api-key': 'sk-test-admin-key-123' });
    const res = makeRes();
    let nextCalled = false;

    mw.requireAdmin(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBeNull();
  });
});

// ─── requireChurchAppAuth ─────────────────────────────────────────────────────

describe('requireChurchAppAuth — token type enforcement', () => {
  let mw, db;

  beforeEach(() => {
    db = makeDb();
    seedChurch(db, 'church-sec-app-001');
    mw = buildMiddleware(db);
  });

  it('rejects no Authorization header', () => {
    const req = makeReq({});
    const res = makeRes();
    mw.requireChurchAppAuth(req, res, () => {});
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toMatch(/Bearer/);
  });

  it('rejects a church_portal token (wrong type) for church_app endpoint', () => {
    const portalToken = jwt.sign(
      { type: 'church_portal', churchId: 'church-sec-app-001' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    const req = makeReq({ authorization: `Bearer ${portalToken}` });
    const res = makeRes();
    mw.requireChurchAppAuth(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });

  it('rejects an admin token used as church_app token', () => {
    const adminId = seedAdmin(db);
    const adminToken = jwt.sign(
      { type: 'admin', userId: adminId, role: 'admin' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
    const req = makeReq({ authorization: `Bearer ${adminToken}` });
    const res = makeRes();
    mw.requireChurchAppAuth(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });

  it('rejects a token with correct type but non-existent churchId', () => {
    const token = jwt.sign(
      { type: 'church_app', churchId: 'ghost-church-xyz' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
    const req = makeReq({ authorization: `Bearer ${token}` });
    const res = makeRes();
    mw.requireChurchAppAuth(req, res, () => {});
    expect(res.statusCode).toBe(404);
  });

  it('rejects a completely fabricated/random JWT string', () => {
    const req = makeReq({ authorization: 'Bearer not.a.valid.jwt' });
    const res = makeRes();
    mw.requireChurchAppAuth(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });

  it('allows a valid church_app token for an existing church', () => {
    const token = jwt.sign(
      { type: 'church_app', churchId: 'church-sec-app-001' },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
    const req = makeReq({ authorization: `Bearer ${token}` });
    const res = makeRes();
    let nextCalled = false;
    mw.requireChurchAppAuth(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBeNull();
  });

  it('marks readonly church_app tokens on the request', () => {
    const token = jwt.sign(
      { type: 'church_app', churchId: 'church-sec-app-001', readonly: true },
      JWT_SECRET,
      { expiresIn: '1h' }
    );
    const req = makeReq({ authorization: `Bearer ${token}` });
    const res = makeRes();
    let nextCalled = false;

    mw.requireChurchAppAuth(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(true);
    expect(req.churchReadonly).toBe(true);
  });
});

// ─── requireChurchOrAdmin — cross-church isolation ────────────────────────────

describe('requireChurchOrAdmin — cross-church data isolation', () => {
  let mw, db;

  beforeEach(() => {
    db = makeDb();
    seedChurch(db, 'church-A');
    seedChurch(db, 'church-B');
    mw = buildMiddleware(db);
  });

  it('rejects church-A token accessing church-B data (params.churchId mismatch)', () => {
    const tokenA = jwt.sign({ type: 'church_portal', churchId: 'church-A' }, JWT_SECRET, { expiresIn: '7d' });
    const req = makeReq(
      { authorization: `Bearer ${tokenA}` },
      { churchId: 'church-B' }
    );
    const res = makeRes();
    mw.requireChurchOrAdmin(req, res, () => {});
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });

  it('allows church-A token accessing church-A data (same churchId)', () => {
    const tokenA = jwt.sign({ type: 'church_portal', churchId: 'church-A' }, JWT_SECRET, { expiresIn: '7d' });
    const req = makeReq(
      { authorization: `Bearer ${tokenA}` },
      { churchId: 'church-A' }
    );
    const res = makeRes();
    let nextCalled = false;
    mw.requireChurchOrAdmin(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  it('allows admin API key to bypass the church token check', () => {
    const req = makeReq(
      { 'x-admin-api-key': 'sk-test-admin-key-123' },
      { churchId: 'church-B' }
    );
    const res = makeRes();
    let nextCalled = false;
    mw.requireChurchOrAdmin(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });

  it('rejects an expired church JWT', () => {
    const expiredToken = jwt.sign(
      { type: 'church_portal', churchId: 'church-A' },
      JWT_SECRET,
      { expiresIn: -1 }
    );
    const req = makeReq(
      { authorization: `Bearer ${expiredToken}` },
      { churchId: 'church-A' }
    );
    const res = makeRes();
    mw.requireChurchOrAdmin(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });

  it('rejects a JWT with no churchId field accessing a church resource', () => {
    // Token with no churchId — might match because params.churchId is set but payload.churchId is undefined
    const weirdToken = jwt.sign({ type: 'church_portal' }, JWT_SECRET, { expiresIn: '1h' });
    const req = makeReq(
      { authorization: `Bearer ${weirdToken}` },
      { churchId: 'church-A' }
    );
    const res = makeRes();
    mw.requireChurchOrAdmin(req, res, () => {});
    // payload.churchId (undefined) !== req.params.churchId ('church-A'), so should be forbidden
    expect(res.statusCode).toBe(403);
  });
});

// ─── requireReseller ──────────────────────────────────────────────────────────

describe('requireReseller — key validation', () => {
  let mw, db;

  beforeEach(() => {
    db = makeDb();
    db.prepare('INSERT INTO resellers (id, name, api_key, active) VALUES (?, ?, ?, ?)')
      .run('res-001', 'Test Reseller', 'rk-valid-key-abc', 1);
    mw = buildMiddleware(db);
  });

  it('rejects request with no x-reseller-key header', () => {
    const req = makeReq({});
    const res = makeRes();
    mw.requireReseller(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });

  it('rejects an invalid/unknown reseller key', () => {
    const req = makeReq({ 'x-reseller-key': 'rk-totally-wrong-key' });
    const res = makeRes();
    mw.requireReseller(req, res, () => {});
    expect(res.statusCode).toBe(403);
  });

  it('rejects a deactivated reseller key', () => {
    db.prepare('UPDATE resellers SET active = 0 WHERE id = ?').run('res-001');
    const req = makeReq({ 'x-reseller-key': 'rk-valid-key-abc' });
    const res = makeRes();
    mw.requireReseller(req, res, () => {});
    expect(res.statusCode).toBe(403);
  });

  it('allows a valid active reseller key', () => {
    const req = makeReq({ 'x-reseller-key': 'rk-valid-key-abc' });
    const res = makeRes();
    let nextCalled = false;
    mw.requireReseller(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(req.reseller).toBeDefined();
    expect(req.reseller.id).toBe('res-001');
  });
});

// ─── CSRF middleware ──────────────────────────────────────────────────────────

describe('csrfMiddleware — CSRF protection', () => {
  const { csrfMiddleware, generateCsrfToken } = require('../src/csrf');

  function makeReqWithCookies(method, path, cookies = {}, headers = {}) {
    return { method, path, cookies, headers };
  }

  it('passes GET requests without checking CSRF token', () => {
    const req = makeReqWithCookies('GET', '/api/church/me', { tally_church_session: 'tok' });
    const res = makeRes();
    let called = false;
    csrfMiddleware(req, res, () => { called = true; });
    expect(called).toBe(true);
  });

  it('passes exempt POST paths (login) without CSRF check', () => {
    const req = makeReqWithCookies('POST', '/api/church/login', { tally_church_session: 'tok' });
    const res = makeRes();
    let called = false;
    csrfMiddleware(req, res, () => { called = true; });
    expect(called).toBe(true);
  });

  it('blocks POST with session cookie but missing CSRF token header', () => {
    const csrfToken = generateCsrfToken();
    const req = makeReqWithCookies(
      'POST', '/api/church/me',
      { tally_church_session: 'tok', tally_csrf: csrfToken },
      {} // no x-csrf-token header
    );
    const res = makeRes();
    csrfMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/CSRF/i);
  });

  it('blocks POST with session cookie but mismatched CSRF tokens', () => {
    const tokenA = generateCsrfToken();
    const tokenB = generateCsrfToken();
    const req = makeReqWithCookies(
      'POST', '/api/church/me',
      { tally_church_session: 'tok', tally_csrf: tokenA },
      { 'x-csrf-token': tokenB }
    );
    const res = makeRes();
    csrfMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it('allows POST with matching CSRF token in cookie and header', () => {
    const token = generateCsrfToken();
    const req = makeReqWithCookies(
      'POST', '/api/church/me',
      { tally_church_session: 'tok', tally_csrf: token },
      { 'x-csrf-token': token }
    );
    const res = makeRes();
    let called = false;
    csrfMiddleware(req, res, () => { called = true; });
    expect(called).toBe(true);
  });

  it('skips CSRF check for API-key authenticated requests (no session cookie)', () => {
    const req = makeReqWithCookies(
      'POST', '/api/church/me',
      {}, // no session cookie
      { 'x-admin-api-key': 'sk-test-key', 'x-csrf-token': 'whatever' }
    );
    const res = makeRes();
    let called = false;
    csrfMiddleware(req, res, () => { called = true; });
    expect(called).toBe(true);
  });

  it('blocks POST with a valid cookie token but wrong header token', () => {
    // Use a properly-formed cookie token and a different (also valid hex) header token
    const cookieToken = generateCsrfToken(); // 64-char hex
    const wrongToken  = generateCsrfToken(); // different 64-char hex
    const req = makeReqWithCookies(
      'POST', '/api/church/me',
      { tally_church_session: 'tok', tally_csrf: cookieToken },
      { 'x-csrf-token': wrongToken }
    );
    const res = makeRes();
    csrfMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it('blocks PUT method with mismatched CSRF tokens', () => {
    const tokenA = generateCsrfToken();
    const req = makeReqWithCookies(
      'PUT', '/api/church/schedule',
      { tally_church_session: 'tok', tally_csrf: tokenA },
      { 'x-csrf-token': 'completely-wrong' }
    );
    const res = makeRes();
    csrfMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(403);
  });

  it('blocks DELETE method with no CSRF token', () => {
    const csrfToken = generateCsrfToken();
    const req = makeReqWithCookies(
      'DELETE', '/api/church/tds/1',
      { tally_church_session: 'tok', tally_csrf: csrfToken },
      {} // no header
    );
    const res = makeRes();
    csrfMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(403);
  });
});

// ─── hasPermission role model ─────────────────────────────────────────────────

describe('hasPermission — role-based access control', () => {
  let mw, db;

  beforeEach(() => {
    db = makeDb();
    mw = buildMiddleware(db);
  });

  it('super_admin has all permissions via wildcard', () => {
    expect(mw.hasPermission('super_admin', 'churches:delete')).toBe(true);
    expect(mw.hasPermission('super_admin', 'billing:write')).toBe(true);
    expect(mw.hasPermission('super_admin', 'any:made:up:permission')).toBe(true);
  });

  it('engineer cannot delete churches', () => {
    expect(mw.hasPermission('engineer', 'churches:delete')).toBe(false);
  });

  it('engineer cannot write billing', () => {
    expect(mw.hasPermission('engineer', 'billing:write')).toBe(false);
  });

  it('sales cannot send commands', () => {
    expect(mw.hasPermission('sales', 'commands:send')).toBe(false);
  });

  it('sales cannot delete resellers', () => {
    expect(mw.hasPermission('sales', 'resellers:delete')).toBe(false);
  });

  it('unknown role has no permissions', () => {
    expect(mw.hasPermission('hacker', 'churches:read')).toBe(false);
    expect(mw.hasPermission('guest', '*')).toBe(false);
    expect(mw.hasPermission(undefined, 'churches:read')).toBe(false);
  });

  it('admin can write billing', () => {
    expect(mw.hasPermission('admin', 'billing:write')).toBe(true);
  });

  it('engineer can read churches', () => {
    expect(mw.hasPermission('engineer', 'churches:read')).toBe(true);
  });
});
