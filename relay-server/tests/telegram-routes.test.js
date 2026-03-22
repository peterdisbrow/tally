/**
 * Tests for src/routes/telegram.js
 *
 * Covers: POST /api/telegram-webhook (secret validation),
 *         POST /api/churches/:churchId/td-register,
 *         GET  /api/churches/:churchId/tds,
 *         DELETE /api/churches/:churchId/tds/:userId,
 *         POST /api/bot/set-webhook.
 *
 * tallyBot is stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';
import http from 'http';

const require = createRequire(import.meta.url);
const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { hashPassword } = require('../src/auth');
const setupTelegramRoutes = require('../src/routes/telegram');

const JWT_SECRET = 'test-telegram-routes-secret';
const WEBHOOK_SECRET = 'super-secret-webhook-token';

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
  return db;
}

function seedChurch(db, opts = {}) {
  const churchId = opts.churchId || uuidv4();
  db.prepare(
    'INSERT INTO churches (churchId, name, email, token, registeredAt) VALUES (?, ?, ?, ?, ?)'
  ).run(churchId, opts.name || 'Telegram Church', 'tg@church.com', 'tok', new Date().toISOString());
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

function buildApp(db, opts = {}) {
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

  // Build a realistic tallyBot stub with the prepared statement stubs
  const tdStore = [];
  const tallyBot = opts.tallyBot !== undefined ? opts.tallyBot : {
    handleUpdate: vi.fn().mockResolvedValue(undefined),
    setWebhook: vi.fn().mockResolvedValue({ ok: true }),
    _stmtRegisterTD: {
      run: vi.fn((churchId, userId, chatId, name, at) => tdStore.push({ churchId, telegram_user_id: userId, telegram_chat_id: chatId, name, registered_at: at, active: 1 })),
    },
    _stmtListTDs: {
      all: vi.fn((churchId) => tdStore.filter(td => td.churchId === churchId)),
    },
    _stmtDeactivateTD: {
      run: vi.fn((churchId, userId) => {
        const td = tdStore.find(t => t.churchId === churchId && t.telegram_user_id === String(userId));
        if (td) td.active = 0;
      }),
    },
  };

  const ctx = {
    db,
    churches: churchesMap,
    tallyBot,
    requireAdmin,
    safeErrorMessage: (e) => e.message,
    log: vi.fn(),
    TALLY_BOT_WEBHOOK_URL: 'https://api.example.com/telegram-webhook',
    TALLY_BOT_WEBHOOK_SECRET: opts.webhookSecret ?? WEBHOOK_SECRET,
    ...opts.ctxOverrides,
  };

  setupTelegramRoutes(app, ctx);
  return { app, churchesMap, tallyBot, tdStore };
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
    delete: (path, opts) => call('DELETE', path, opts),
    close: () => new Promise(r => server.close(r)),
  };
}

function issueAdminToken(userId) {
  return jwt.sign({ type: 'admin', userId, role: 'super_admin' }, JWT_SECRET, { expiresIn: '8h' });
}

// ─── POST /api/telegram-webhook ──────────────────────────────────────────────

describe('POST /api/telegram-webhook (webhook secret validation)', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 401 when secret is missing', async () => {
    const { status } = await client.post('/api/telegram-webhook', {
      body: { update_id: 1, message: { text: 'hi' } },
    });
    expect(status).toBe(401);
  });

  it('returns 401 when secret is wrong', async () => {
    const { status } = await client.post('/api/telegram-webhook', {
      body: { update_id: 1 },
      headers: { 'x-telegram-bot-api-secret-token': 'wrong-secret' },
    });
    expect(status).toBe(401);
  });

  it('returns 200 with correct secret and calls handleUpdate', async () => {
    const update = { update_id: 42, message: { text: '/start', chat: { id: 123 } } };
    const { status } = await client.post('/api/telegram-webhook', {
      body: update,
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    });
    expect(status).toBe(200);
    // handleUpdate is called async — give it a tick
    await new Promise(r => setTimeout(r, 10));
    expect(built.tallyBot.handleUpdate).toHaveBeenCalledWith(update);
  });
});

// ─── POST /api/churches/:churchId/td-register ────────────────────────────────

describe('POST /api/churches/:churchId/td-register', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 401 without admin token', async () => {
    const churchId = seedChurch(db);
    const { status } = await client.post(`/api/churches/${churchId}/td-register`, {
      body: { telegram_user_id: '100', name: 'Bob' },
    });
    expect(status).toBe(401);
  });

  it('returns 404 for unknown church', async () => {
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status } = await client.post('/api/churches/no-church/td-register', {
      token,
      body: { telegram_user_id: '100', name: 'Bob' },
    });
    expect(status).toBe(404);
  });

  it('returns 400 when required fields are missing', async () => {
    const churchId = seedChurch(db);
    built.churchesMap.set(churchId, { name: 'Telegram Church', churchId });
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status, body } = await client.post(`/api/churches/${churchId}/td-register`, {
      token,
      body: { telegram_user_id: '100' }, // name missing
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/name/i);
  });

  it('registers TD and returns {registered:true}', async () => {
    const churchId = seedChurch(db);
    built.churchesMap.set(churchId, { name: 'Telegram Church', churchId });
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status, body } = await client.post(`/api/churches/${churchId}/td-register`, {
      token,
      body: { telegram_user_id: '999', telegram_chat_id: '999', name: 'Alice' },
    });
    expect(status).toBe(200);
    expect(body.registered).toBe(true);
    expect(body.name).toBe('Alice');
    expect(built.tallyBot._stmtRegisterTD.run).toHaveBeenCalled();
  });
});

// ─── GET /api/churches/:churchId/tds ─────────────────────────────────────────

describe('GET /api/churches/:churchId/tds', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 401 without token', async () => {
    const { status } = await client.get('/api/churches/any/tds');
    expect(status).toBe(401);
  });

  it('returns empty array when no TDs registered', async () => {
    const churchId = seedChurch(db);
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status, body } = await client.get(`/api/churches/${churchId}/tds`, { token });
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });

  it('returns registered TDs', async () => {
    const churchId = seedChurch(db);
    // Pre-populate the TD store
    built.tdStore.push({ churchId, telegram_user_id: '999', name: 'Alice', active: 1 });
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status, body } = await client.get(`/api/churches/${churchId}/tds`, { token });
    expect(status).toBe(200);
    expect(body.length).toBe(1);
    expect(body[0].name).toBe('Alice');
  });
});

// ─── DELETE /api/churches/:churchId/tds/:userId ──────────────────────────────

describe('DELETE /api/churches/:churchId/tds/:userId', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 401 without token', async () => {
    const { status } = await client.delete('/api/churches/any/tds/999');
    expect(status).toBe(401);
  });

  it('calls deactivate and returns {removed:true}', async () => {
    const churchId = seedChurch(db);
    built.tdStore.push({ churchId, telegram_user_id: '888', name: 'Bob', active: 1 });
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status, body } = await client.delete(`/api/churches/${churchId}/tds/888`, { token });
    expect(status).toBe(200);
    expect(body.removed).toBe(true);
    expect(built.tallyBot._stmtDeactivateTD.run).toHaveBeenCalledWith(churchId, '888');
  });
});

// ─── POST /api/bot/set-webhook ────────────────────────────────────────────────

describe('POST /api/bot/set-webhook', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 401 without admin token', async () => {
    const { status } = await client.post('/api/bot/set-webhook', { body: {} });
    expect(status).toBe(401);
  });

  it('sets webhook and returns result', async () => {
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status, body } = await client.post('/api/bot/set-webhook', {
      token,
      body: { url: 'https://api.example.com/my-webhook' },
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(built.tallyBot.setWebhook).toHaveBeenCalled();
  });

  it('returns 400 when no url provided and no env var', async () => {
    db = createDb();
    // Build app with no webhook URL configured
    built = buildApp(db, {
      ctxOverrides: { TALLY_BOT_WEBHOOK_URL: null, TALLY_BOT_WEBHOOK_SECRET: null },
    });
    client = makeClient(built.app);
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status, body } = await client.post('/api/bot/set-webhook', { token, body: {} });
    expect(status).toBe(400);
    expect(body.error).toMatch(/url/i);
  });
});

// ─── Webhook when tallyBot is null ───────────────────────────────────────────

describe('Webhook with no tallyBot configured', () => {
  let db, client;

  beforeEach(() => {
    db = createDb();
    const { app } = buildApp(db, { tallyBot: null });
    client = makeClient(app);
  });
  afterEach(() => client.close());

  it('still returns 200 (responds to Telegram immediately)', async () => {
    const { status } = await client.post('/api/telegram-webhook', {
      body: { update_id: 1 },
      headers: { 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET },
    });
    expect(status).toBe(200);
  });
});
