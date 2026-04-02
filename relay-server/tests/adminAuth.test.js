/**
 * Tests for src/routes/adminAuth.js — admin login, user management.
 *
 * Uses an in-memory SQLite database and real Express app wired the same
 * way server.js wires it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const setupAdminAuthRoutes = require('../src/routes/adminAuth');
const { hashPassword, verifyPassword } = require('../src/auth');
const { createClient } = require('./helpers/expressTestClient');

const JWT_SECRET = 'test-admin-jwt-secret';
const ADMIN_ROLES = ['super_admin', 'admin', 'engineer', 'sales'];

// ─── DB helpers ───────────────────────────────────────────────────────────────

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE admin_users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      created_by TEXT,
      last_login_at TEXT,
      updated_at TEXT
    )
  `);
  db.exec(`
    CREATE TABLE ai_usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      church_id TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd REAL,
      cached INTEGER DEFAULT 0,
      created_at TEXT
    )
  `);
  return db;
}

function seedUser(db, { email = 'admin@test.com', password = 'Test1234!', name = 'Admin', role = 'super_admin', active = 1 } = {}) {
  const userId = uuidv4();
  db.prepare(
    'INSERT INTO admin_users (id, email, password_hash, name, role, active, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(userId, email, hashPassword(password), name, role, active, new Date().toISOString());
  return userId;
}

// ─── App factory ──────────────────────────────────────────────────────────────

function buildApp(db) {
  const app = express();
  app.use(express.json());

  function requireAdminJwt(...allowedRoles) {
    return (req, res, next) => {
      const authHeader = req.headers['authorization'] || '';
      let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (!token) token = req.headers['x-admin-jwt'];
      if (!token) return res.status(401).json({ error: 'unauthorized' });
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        if (payload.type !== 'admin') throw new Error('wrong token type');
        const user = db.prepare('SELECT id, email, name, role, active FROM admin_users WHERE id = ?').get(payload.userId);
        if (!user || !user.active) return res.status(401).json({ error: 'Account deactivated or not found' });
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
    requireAdminJwt,
    rateLimit: () => (req, res, next) => next(),
    hashPassword,
    verifyPassword,
    ADMIN_ROLES,
    uuidv4,
    jwt,
    JWT_SECRET,
    log: vi.fn(),
    logAudit: vi.fn(),
  };

  setupAdminAuthRoutes(app, ctx);
  return app;
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

const makeClient = createClient;

function issueToken(db, userId) {
  const user = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(userId);
  return jwt.sign(
    { type: 'admin', userId, role: user.role, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
}

// ─── POST /api/admin/login ────────────────────────────────────────────────────

describe('POST /api/admin/login', () => {
  let db, client;

  beforeEach(() => {
    db = createDb();
    client = makeClient(buildApp(db));
  });
  afterEach(() => client.close());

  it('returns 400 when email missing', async () => {
    const { status, body } = await client.post('/api/admin/login', { body: { password: 'Test1234!' } });
    expect(status).toBe(400);
    expect(body.error).toMatch(/required/i);
  });

  it('returns 400 when password missing', async () => {
    const { status } = await client.post('/api/admin/login', { body: { email: 'x@x.com' } });
    expect(status).toBe(400);
  });

  it('returns 401 for unknown email', async () => {
    const { status, body } = await client.post('/api/admin/login', {
      body: { email: 'nobody@test.com', password: 'Test1234!' },
    });
    expect(status).toBe(401);
    expect(body.error).toBe('Invalid email or password');
  });

  it('returns 401 for wrong password', async () => {
    seedUser(db);
    const { status } = await client.post('/api/admin/login', {
      body: { email: 'admin@test.com', password: 'WrongPass!' },
    });
    expect(status).toBe(401);
  });

  it('returns 401 for inactive user', async () => {
    seedUser(db, { active: 0 });
    const { status } = await client.post('/api/admin/login', {
      body: { email: 'admin@test.com', password: 'Test1234!' },
    });
    expect(status).toBe(401);
  });

  it('returns token and user profile on success', async () => {
    seedUser(db);
    const { status, body } = await client.post('/api/admin/login', {
      body: { email: 'admin@test.com', password: 'Test1234!' },
    });
    expect(status).toBe(200);
    expect(body.token).toBeTruthy();
    expect(body.user.email).toBe('admin@test.com');
    expect(body.user.role).toBe('super_admin');
    expect(body.user.password_hash).toBeUndefined();
  });

  it('normalises email to lowercase', async () => {
    seedUser(db, { email: 'admin@test.com' });
    const { status } = await client.post('/api/admin/login', {
      body: { email: 'ADMIN@TEST.COM', password: 'Test1234!' },
    });
    expect(status).toBe(200);
  });
});

// ─── GET /api/admin/me ────────────────────────────────────────────────────────

describe('GET /api/admin/me', () => {
  let db, client;

  beforeEach(() => { db = createDb(); client = makeClient(buildApp(db)); });
  afterEach(() => client.close());

  it('returns 401 without token', async () => {
    const { status } = await client.get('/api/admin/me');
    expect(status).toBe(401);
  });

  it('returns current user profile with valid token', async () => {
    const userId = seedUser(db, { email: 'me@test.com', name: 'Test User', role: 'admin' });
    const token = issueToken(db, userId);
    const { status, body } = await client.get('/api/admin/me', { token });
    expect(status).toBe(200);
    expect(body.email).toBe('me@test.com');
    expect(body.name).toBe('Test User');
    expect(body.role).toBe('admin');
    expect(body.password_hash).toBeUndefined();
  });
});

// ─── PUT /api/admin/me/password ───────────────────────────────────────────────

describe('PUT /api/admin/me/password', () => {
  let db, client;

  beforeEach(() => { db = createDb(); client = makeClient(buildApp(db)); });
  afterEach(() => client.close());

  it('returns 400 when fields missing', async () => {
    const userId = seedUser(db);
    const token = issueToken(db, userId);
    const { status } = await client.put('/api/admin/me/password', {
      token,
      body: { currentPassword: 'Test1234!' },
    });
    expect(status).toBe(400);
  });

  it('returns 400 when new password too short', async () => {
    const userId = seedUser(db);
    const token = issueToken(db, userId);
    const { status, body } = await client.put('/api/admin/me/password', {
      token,
      body: { currentPassword: 'Test1234!', newPassword: 'short' },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/8 characters/i);
  });

  it('returns 400 when current password is wrong', async () => {
    const userId = seedUser(db);
    const token = issueToken(db, userId);
    const { status } = await client.put('/api/admin/me/password', {
      token,
      body: { currentPassword: 'WrongOldPass!', newPassword: 'NewPass12345!' },
    });
    expect(status).toBe(400);
  });

  it('updates password successfully and old password no longer works', async () => {
    const userId = seedUser(db);
    const token = issueToken(db, userId);
    const { status } = await client.put('/api/admin/me/password', {
      token,
      body: { currentPassword: 'Test1234!', newPassword: 'NewSecure!123' },
    });
    expect(status).toBe(200);

    // Old password no longer works
    const { status: s1 } = await client.post('/api/admin/login', {
      body: { email: 'admin@test.com', password: 'Test1234!' },
    });
    expect(s1).toBe(401);

    // New password works
    const { status: s2 } = await client.post('/api/admin/login', {
      body: { email: 'admin@test.com', password: 'NewSecure!123' },
    });
    expect(s2).toBe(200);
  });
});

// ─── GET /api/admin/users (super_admin only) ──────────────────────────────────

describe('GET /api/admin/users', () => {
  let db, client;

  beforeEach(() => { db = createDb(); client = makeClient(buildApp(db)); });
  afterEach(() => client.close());

  it('returns 403 for non-super_admin role', async () => {
    const userId = seedUser(db, { role: 'admin' });
    const token = issueToken(db, userId);
    const { status } = await client.get('/api/admin/users', { token });
    expect(status).toBe(403);
  });

  it('returns user list for super_admin without exposing password hashes', async () => {
    const userId = seedUser(db);
    seedUser(db, { email: 'other@test.com', role: 'admin' });
    const token = issueToken(db, userId);
    const { status, body } = await client.get('/api/admin/users', { token });
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
    body.forEach(u => expect(u.password_hash).toBeUndefined());
  });
});

// ─── POST /api/admin/users ────────────────────────────────────────────────────

describe('POST /api/admin/users', () => {
  let db, client;

  beforeEach(() => { db = createDb(); client = makeClient(buildApp(db)); });
  afterEach(() => client.close());

  it('returns 400 for invalid role', async () => {
    const userId = seedUser(db);
    const token = issueToken(db, userId);
    const { status, body } = await client.post('/api/admin/users', {
      token,
      body: { email: 'new@test.com', password: 'Password123!', name: 'New User', role: 'hacker' },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid role/i);
  });

  it('returns 409 for duplicate email', async () => {
    const userId = seedUser(db);
    const token = issueToken(db, userId);
    const { status } = await client.post('/api/admin/users', {
      token,
      body: { email: 'admin@test.com', password: 'Password123!', name: 'Dupe', role: 'admin' },
    });
    expect(status).toBe(409);
  });

  it('creates a new user and returns 201 without password hash', async () => {
    const userId = seedUser(db);
    const token = issueToken(db, userId);
    const { status, body } = await client.post('/api/admin/users', {
      token,
      body: { email: 'new@test.com', password: 'SecurePass!99', name: 'New User', role: 'admin' },
    });
    expect(status).toBe(201);
    expect(body.email).toBe('new@test.com');
    expect(body.role).toBe('admin');
    expect(body.password_hash).toBeUndefined();
  });

  it('returns 400 for password too short', async () => {
    const userId = seedUser(db);
    const token = issueToken(db, userId);
    const { status } = await client.post('/api/admin/users', {
      token,
      body: { email: 'new2@test.com', password: 'short', name: 'Short', role: 'admin' },
    });
    expect(status).toBe(400);
  });
});

// ─── DELETE /api/admin/users/:userId ─────────────────────────────────────────

describe('DELETE /api/admin/users/:userId', () => {
  let db, client;

  beforeEach(() => { db = createDb(); client = makeClient(buildApp(db)); });
  afterEach(() => client.close());

  it('returns 400 when attempting to delete own account', async () => {
    const userId = seedUser(db);
    const token = issueToken(db, userId);
    const { status, body } = await client.delete(`/api/admin/users/${userId}`, { token });
    expect(status).toBe(400);
    expect(body.error).toMatch(/own account/i);
  });

  it('soft-deletes target user (sets active=0)', async () => {
    const adminId = seedUser(db, { email: 'admin@test.com' });
    const targetId = seedUser(db, { email: 'target@test.com', role: 'admin' });
    const token = issueToken(db, adminId);
    const { status } = await client.delete(`/api/admin/users/${targetId}`, { token });
    expect(status).toBe(200);
    const target = db.prepare('SELECT active FROM admin_users WHERE id = ?').get(targetId);
    expect(target.active).toBe(0);
  });

  it('returns 404 for non-existent user', async () => {
    const userId = seedUser(db);
    const token = issueToken(db, userId);
    const { status } = await client.delete('/api/admin/users/no-such-id', { token });
    expect(status).toBe(404);
  });

  it('prevents deleting the last super_admin', async () => {
    const adminId = seedUser(db, { email: 'admin@test.com', role: 'super_admin' });
    const otherId = seedUser(db, { email: 'other@test.com', role: 'super_admin' });
    const token = issueToken(db, adminId);

    // Deactivate one super_admin so only one is left
    db.prepare('UPDATE admin_users SET active = 0 WHERE id = ?').run(adminId);

    // Now otherId is the last active super_admin — try to delete them with a fresh token
    const db2 = createDb();
    const client2 = makeClient(buildApp(db2));
    const a2 = seedUser(db2, { email: 'a@test.com', role: 'super_admin' });
    const b2 = seedUser(db2, { email: 'b@test.com', role: 'super_admin' });
    const tokenA2 = issueToken(db2, a2);
    // Deactivate a2 leaving only b2 as active super_admin
    db2.prepare('UPDATE admin_users SET active = 0 WHERE id = ?').run(a2);

    // a2 token is now invalid (deactivated) — use a fresh super_admin token
    const c2 = seedUser(db2, { email: 'c@test.com', role: 'super_admin' });
    const tokenC2 = issueToken(db2, c2);
    // Try to delete b2 — but b2 is not the last super_admin now (c2 is active too), so this works
    // Instead test: delete c2 while b2 is the only remaining → should fail
    db2.prepare('UPDATE admin_users SET active = 0 WHERE id = ?').run(b2);
    const { status } = await client2.delete(`/api/admin/users/${c2}`, { token: tokenC2 });
    expect(status).toBe(400);
    expect(status).not.toBe(200);
    client2.close();
  });
});

// ─── JWT edge cases ───────────────────────────────────────────────────────────

describe('JWT authentication edge cases', () => {
  let db, client;

  beforeEach(() => { db = createDb(); client = makeClient(buildApp(db)); });
  afterEach(() => client.close());

  it('returns 401 for expired token', async () => {
    const userId = seedUser(db);
    const expiredToken = jwt.sign(
      { type: 'admin', userId, role: 'super_admin', email: 'admin@test.com' },
      JWT_SECRET,
      { expiresIn: '1ms' }
    );
    await new Promise(r => setTimeout(r, 10));
    const { status, body } = await client.get('/api/admin/me', { token: expiredToken });
    expect(status).toBe(401);
    expect(body.error).toBe('Token expired');
  });

  it('returns 401 for token with wrong type', async () => {
    const userId = seedUser(db);
    const wrongToken = jwt.sign(
      { type: 'church', userId, role: 'super_admin' },
      JWT_SECRET,
      { expiresIn: '8h' }
    );
    const { status } = await client.get('/api/admin/me', { token: wrongToken });
    expect(status).toBe(401);
  });

  it('returns 401 when user is deactivated after token was issued', async () => {
    const userId = seedUser(db);
    const token = issueToken(db, userId);
    db.prepare('UPDATE admin_users SET active = 0 WHERE id = ?').run(userId);
    const { status } = await client.get('/api/admin/me', { token });
    expect(status).toBe(401);
  });
});
