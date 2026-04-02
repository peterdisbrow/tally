/**
 * Tests for src/routes/slack.js
 *
 * Covers: GET/PUT/DELETE slack config, POST slack/test.
 * alertEngine.sendSlackAlert is stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { hashPassword } = require('../src/auth');
const setupSlackRoutes = require('../src/routes/slack');
const { createClient } = require('./helpers/expressTestClient');

const JWT_SECRET = 'test-slack-routes-secret';

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
      slack_webhook_url TEXT,
      slack_channel TEXT
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
  return db;
}

function seedChurch(db, opts = {}) {
  const churchId = opts.churchId || uuidv4();
  db.prepare(
    'INSERT INTO churches (churchId, name, email, token, registeredAt, slack_webhook_url, slack_channel) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(churchId, opts.name || 'Slack Church', 'slack@church.com', 'tok', new Date().toISOString(), opts.slack_webhook_url || null, opts.slack_channel || null);
  return churchId;
}

function seedAdmin(db) {
  const id = uuidv4();
  db.prepare(
    'INSERT INTO admin_users (id, email, password_hash, name, role, active, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(id, 'admin@test.com', hashPassword('Admin1234!'), 'Admin', 'super_admin', 1, new Date().toISOString());
  return id;
}

// ─── App factory ──────────────────────────────────────────────────────────────

function buildApp(db, overrides = {}) {
  const app = express();
  app.use(express.json());

  const churchesMap = new Map();

  function requireAdmin(req, res, next) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : req.headers['x-admin-jwt'];
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (payload.type !== 'admin') throw new Error('wrong type');
      const user = db.prepare('SELECT id, email, name, role, active FROM admin_users WHERE id = ?').get(payload.userId);
      if (!user || !user.active) return res.status(401).json({ error: 'Deactivated' });
      req.adminUser = user;
      return next();
    } catch { return res.status(401).json({ error: 'Invalid admin token' }); }
  }

  const alertEngine = {
    sendSlackAlert: vi.fn().mockResolvedValue(undefined),
  };

  const ctx = {
    db,
    churches: churchesMap,
    requireAdmin,
    alertEngine,
    stmtGet: db.prepare('SELECT * FROM churches WHERE churchId = ?'),
    safeErrorMessage: (e) => e.message,
    log: vi.fn(),
    isValidSlackWebhookUrl: (url) => url.startsWith('https://hooks.slack.com/'),
    ...overrides,
  };

  setupSlackRoutes(app, ctx);
  return { app, churchesMap, alertEngine };
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

const makeClient = createClient;

function issueAdminToken(userId) {
  return jwt.sign({ type: 'admin', userId, role: 'super_admin' }, JWT_SECRET, { expiresIn: '8h' });
}

// ─── GET /api/churches/:churchId/slack ───────────────────────────────────────

describe('GET /api/churches/:churchId/slack', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 401 without token', async () => {
    const { status } = await client.get('/api/churches/any/slack');
    expect(status).toBe(401);
  });

  it('returns 404 for unknown church', async () => {
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status } = await client.get('/api/churches/no-such-church/slack', { token });
    expect(status).toBe(404);
  });

  it('returns slack config with masked URL', async () => {
    const churchId = seedChurch(db, { slack_webhook_url: 'https://hooks.slack.com/services/TXXXXX/BXXXXX/xxxxx', slack_channel: '#alerts' });
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status, body } = await client.get(`/api/churches/${churchId}/slack`, { token });
    expect(status).toBe(200);
    expect(body.configured).toBe(true);
    expect(body.channel).toBe('#alerts');
    expect(body.webhookUrl).toMatch(/••••••/);
    expect(body.webhookUrlFull).toMatch(/hooks\.slack\.com/);
  });

  it('returns {configured:false} for church without webhook', async () => {
    const churchId = seedChurch(db);
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status, body } = await client.get(`/api/churches/${churchId}/slack`, { token });
    expect(status).toBe(200);
    expect(body.configured).toBe(false);
  });
});

// ─── PUT /api/churches/:churchId/slack ───────────────────────────────────────

describe('PUT /api/churches/:churchId/slack', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 401 without token', async () => {
    const { status } = await client.put('/api/churches/any/slack', {
      body: { webhookUrl: 'https://hooks.slack.com/x' },
    });
    expect(status).toBe(401);
  });

  it('returns 404 for unknown church', async () => {
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status } = await client.put('/api/churches/no-such-church/slack', {
      token,
      body: { webhookUrl: 'https://hooks.slack.com/x' },
    });
    expect(status).toBe(404);
  });

  it('returns 400 when webhookUrl is missing', async () => {
    const churchId = seedChurch(db);
    built.churchesMap.set(churchId, { name: 'Slack Church', churchId });
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status, body } = await client.put(`/api/churches/${churchId}/slack`, {
      token,
      body: {},
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/webhookUrl/i);
  });

  it('returns 400 for an invalid Slack webhook URL', async () => {
    const churchId = seedChurch(db);
    built.churchesMap.set(churchId, { name: 'Slack Church', churchId });
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status, body } = await client.put(`/api/churches/${churchId}/slack`, {
      token,
      body: { webhookUrl: 'https://evil.com/webhook' },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid slack webhook/i);
  });

  it('saves valid webhook URL and returns {saved:true}', async () => {
    const churchId = seedChurch(db);
    built.churchesMap.set(churchId, { name: 'Slack Church', churchId });
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const webhookUrl = 'https://hooks.slack.com/services/T123/B456/abcdef';
    const { status, body } = await client.put(`/api/churches/${churchId}/slack`, {
      token,
      body: { webhookUrl, channel: '#notifications' },
    });
    expect(status).toBe(200);
    expect(body.saved).toBe(true);
    expect(body.channel).toBe('#notifications');
    const row = db.prepare('SELECT slack_webhook_url, slack_channel FROM churches WHERE churchId = ?').get(churchId);
    expect(row.slack_webhook_url).toBe(webhookUrl);
    expect(row.slack_channel).toBe('#notifications');
  });
});

// ─── DELETE /api/churches/:churchId/slack ────────────────────────────────────

describe('DELETE /api/churches/:churchId/slack', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 401 without token', async () => {
    const { status } = await client.delete('/api/churches/any/slack');
    expect(status).toBe(401);
  });

  it('returns 404 for unknown church', async () => {
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status } = await client.delete('/api/churches/no-church/slack', { token });
    expect(status).toBe(404);
  });

  it('clears webhook URL and returns {removed:true}', async () => {
    const churchId = seedChurch(db, { slack_webhook_url: 'https://hooks.slack.com/x', slack_channel: '#ch' });
    built.churchesMap.set(churchId, { name: 'Slack Church', churchId });
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status, body } = await client.delete(`/api/churches/${churchId}/slack`, { token });
    expect(status).toBe(200);
    expect(body.removed).toBe(true);
    const row = db.prepare('SELECT slack_webhook_url, slack_channel FROM churches WHERE churchId = ?').get(churchId);
    expect(row.slack_webhook_url).toBeNull();
    expect(row.slack_channel).toBeNull();
  });
});

// ─── POST /api/churches/:churchId/slack/test ─────────────────────────────────

describe('POST /api/churches/:churchId/slack/test', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 401 without token', async () => {
    const { status } = await client.post('/api/churches/any/slack/test');
    expect(status).toBe(401);
  });

  it('returns 404 for unknown church', async () => {
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status } = await client.post('/api/churches/no-church/slack/test', { token });
    expect(status).toBe(404);
  });

  it('returns 400 when Slack is not configured', async () => {
    const churchId = seedChurch(db); // no webhook
    built.churchesMap.set(churchId, { name: 'Slack Church', churchId });
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status, body } = await client.post(`/api/churches/${churchId}/slack/test`, { token });
    expect(status).toBe(400);
    expect(body.error).toMatch(/not configured/i);
  });

  it('sends test alert and returns {sent:true}', async () => {
    const churchId = seedChurch(db, { slack_webhook_url: 'https://hooks.slack.com/services/T123/B456/abc' });
    built.churchesMap.set(churchId, { name: 'Slack Church', churchId });
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status, body } = await client.post(`/api/churches/${churchId}/slack/test`, { token });
    expect(status).toBe(200);
    expect(body.sent).toBe(true);
    expect(built.alertEngine.sendSlackAlert).toHaveBeenCalledOnce();
  });

  it('returns 500 when sendSlackAlert throws', async () => {
    const churchId = seedChurch(db, { slack_webhook_url: 'https://hooks.slack.com/services/T123/B456/abc' });
    built.churchesMap.set(churchId, { name: 'Slack Church', churchId });
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    built.alertEngine.sendSlackAlert.mockRejectedValueOnce(new Error('Slack API error'));
    const { status, body } = await client.post(`/api/churches/${churchId}/slack/test`, { token });
    expect(status).toBe(500);
    expect(body.error).toMatch(/Slack API error/);
  });
});
