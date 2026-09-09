/**
 * HMAC tally_session with role=admin must not authorize admin APIs.
 * Admin SPA uses Bearer JWT; the cookie path is leftover (reseller-only).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { hashPassword } = require('../src/auth');
const { setupAdminPanel } = require('../src/adminPanel');
const { createClient } = require('./helpers/expressTestClient');

const JWT_SECRET = 'test-hmac-cookie-secret';
const SESSION_SECRET = 'test-session-hmac-secret';

function signTallySession(payload) {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payloadB64).digest('base64');
  return `${payloadB64}.${sig}`;
}

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE churches (
      churchId TEXT PRIMARY KEY,
      name TEXT,
      registeredAt TEXT DEFAULT ''
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
    CREATE TABLE resellers (
      id TEXT PRIMARY KEY,
      brand_name TEXT,
      support_email TEXT,
      portal_password TEXT,
      active INTEGER DEFAULT 1
    );
  `);
  return db;
}

function buildApp(db) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  setupAdminPanel(app, db, new Map(), {
    getResellerById: () => null,
    getResellerStats: () => ({}),
    getResellers: () => [],
  }, { jwt, JWT_SECRET, logAudit: () => {} });
  return app;
}

describe('HMAC tally_session is not an admin session', () => {
  let db;
  let client;
  let savedSecret;

  beforeEach(() => {
    savedSecret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = SESSION_SECRET;
    db = createDb();
    const userId = uuidv4();
    db.prepare(
      'INSERT INTO admin_users (id, email, password_hash, name, role, active, created_at) VALUES (?,?,?,?,?,?,?)'
    ).run(userId, 'ops@test.com', hashPassword('Passw0rd!'), 'Ops', 'admin', 1, new Date().toISOString());
    client = createClient(buildApp(db));
  });

  afterEach(() => {
    process.env.SESSION_SECRET = savedSecret;
    return client.close();
  });

  it('rejects a signed role=admin HMAC cookie on /api/admin/overview', async () => {
    const cookieVal = encodeURIComponent(signTallySession({
      role: 'admin',
      userId: db.prepare('SELECT id FROM admin_users').get().id,
      email: 'ops@test.com',
      exp: Date.now() + 60 * 60 * 1000,
    }));
    const { status, body } = await client.get('/api/admin/overview', {
      cookie: `tally_session=${cookieVal}`,
    });
    expect(status).toBe(401);
    expect(body.error).toBe('unauthorized');
  });

  it('still accepts a Bearer admin JWT', async () => {
    const user = db.prepare('SELECT id, role, email FROM admin_users').get();
    const token = jwt.sign(
      { type: 'admin', userId: user.id, role: user.role, email: user.email, name: 'Ops' },
      JWT_SECRET,
      { expiresIn: '8h' },
    );
    const { status, body } = await client.get('/api/admin/overview', { token });
    expect(status).toBe(200);
    expect(body).toHaveProperty('onlineNow');
  });
});
