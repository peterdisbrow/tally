import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const setupAdminAuthRoutes = require('../src/routes/adminAuth');
const createAuthMiddleware = require('../src/routes/authMiddleware');
const { SqliteQueryClient } = require('../src/db/queryClient');
const { hashPassword, verifyPassword } = require('../src/auth');
const { createClient } = require('./helpers/expressTestClient');

const JWT_SECRET = 'test-admin-query-client-secret';

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
      feature TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd REAL,
      cached INTEGER DEFAULT 0,
      created_at TEXT
    )
  `);
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      billing_tier TEXT DEFAULT 'connect',
      billing_status TEXT DEFAULT 'active'
    )
  `);
  return db;
}

function seedAdmin(db, { email = 'admin@test.com', password = 'Admin1234!', name = 'Admin', role = 'super_admin', active = 1 } = {}) {
  const id = uuidv4();
  db.prepare(
    'INSERT INTO admin_users (id, email, password_hash, name, role, active, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(id, email, hashPassword(password), name, role, active, new Date().toISOString());
  return id;
}

function poisonDb(realDb) {
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        throw new Error('adminAuth route should use queryClient, not db.prepare');
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function buildApp(realDb) {
  const app = express();
  app.use(express.json());

  const queryClient = new SqliteQueryClient(realDb);
  const authMiddleware = createAuthMiddleware({
    db: null,
    queryClient,
    JWT_SECRET,
    ADMIN_API_KEY: 'sk-admin',
    safeCompareKey: (a, b) => a === b,
    resolveAdminKey: (req) => req.headers['x-admin-api-key'] || '',
  });

  setupAdminAuthRoutes(app, {
    db: poisonDb(realDb),
    queryClient,
    requireAdminJwt: authMiddleware.requireAdminJwt,
    rateLimit: () => (req, res, next) => next(),
    hashPassword,
    verifyPassword,
    ADMIN_ROLES: ['super_admin', 'admin', 'engineer', 'sales'],
    uuidv4,
    jwt,
    JWT_SECRET,
    log: vi.fn(),
    logAudit: vi.fn(),
  });

  return app;
}

const makeClient = createClient;

describe('adminAuth queryClient path', () => {
  let db, client;

  beforeEach(() => {
    db = createDb();
    client = makeClient(buildApp(db));
  });

  afterEach(() => client.close());

  it('logs in without touching db.prepare', async () => {
    seedAdmin(db, { email: 'admin@test.com', password: 'Admin1234!' });
    const { status, body } = await client.post('/api/admin/login', {
      body: { email: 'ADMIN@TEST.COM', password: 'Admin1234!' },
    });
    expect(status).toBe(200);
    expect(body.token).toBeTruthy();
    expect(body.user.email).toBe('admin@test.com');
  });

  it('returns the current user through queryClient-backed auth', async () => {
    const userId = seedAdmin(db, { email: 'me@test.com', password: 'Admin1234!', role: 'admin' });
    const token = jwt.sign({ type: 'admin', userId }, JWT_SECRET, { expiresIn: '1h' });
    const { status, body } = await client.get('/api/admin/me', { token });
    expect(status).toBe(200);
    expect(body.email).toBe('me@test.com');
    expect(body.role).toBe('admin');
  });
});
