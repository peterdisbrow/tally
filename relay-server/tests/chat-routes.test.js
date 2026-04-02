/**
 * Tests for src/routes/chat.js
 *
 * Covers: church POST/GET chat, admin POST/GET chat,
 *         onboarding chat endpoints (message/confirm/state).
 *
 * Uses in-memory SQLite + real Express. chatEngine and
 * onboardingChat functions are stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';

// Hoist mock for onboardingChat so it is applied before chat.js is imported
vi.mock('../src/onboardingChat', () => ({
  processOnboardingMessage: vi.fn().mockResolvedValue({ reply: 'Hello from onboarding!', state: 'gear' }),
  executeOnboardingAction: vi.fn().mockReturnValue({ success: true }),
  getSession: vi.fn().mockReturnValue(null),
}));

const require = createRequire(import.meta.url);
const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { hashPassword } = require('../src/auth');
const setupChatRoutes = require('../src/routes/chat');
const { createClient } = require('./helpers/expressTestClient');

const JWT_SECRET = 'test-chat-routes-secret';

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
      td_name TEXT,
      billing_status TEXT DEFAULT 'active',
      billing_tier TEXT DEFAULT 'connect'
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
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      church_id TEXT NOT NULL,
      sender_name TEXT,
      sender_role TEXT,
      source TEXT,
      message TEXT,
      created_at TEXT,
      session_id TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS onboarding_sessions (
      church_id TEXT PRIMARY KEY,
      state TEXT DEFAULT 'intro',
      collected_data TEXT DEFAULT '{}',
      scan_results TEXT DEFAULT '{}',
      started_at TEXT,
      updated_at TEXT
    )
  `);
  return db;
}

function seedChurch(db, opts = {}) {
  const churchId = opts.churchId || uuidv4();
  db.prepare(
    'INSERT INTO churches (churchId, name, email, token, registeredAt, portal_email, td_name) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(churchId, opts.name || 'Test Church', 'test@church.com', 'tok', new Date().toISOString(), opts.portal_email || null, opts.td_name || 'TD');
  return churchId;
}

function seedAdmin(db, opts = {}) {
  const id = uuidv4();
  db.prepare(
    'INSERT INTO admin_users (id, email, password_hash, name, role, active, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(id, opts.email || 'admin@test.com', hashPassword('Admin1234!'), opts.name || 'Admin', 'super_admin', 1, new Date().toISOString());
  return id;
}

// ─── App factory ──────────────────────────────────────────────────────────────

function buildApp(db, overrides = {}) {
  const app = express();
  app.use(express.json());

  function requireChurchAppAuth(req, res, next) {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Authorization required' });
    try {
      const payload = jwt.verify(auth.slice(7), JWT_SECRET);
      if (payload.type !== 'church_app') throw new Error('wrong type');
      const church = db.prepare('SELECT * FROM churches WHERE churchId = ?').get(payload.churchId);
      if (!church) return res.status(404).json({ error: 'Church not found' });
      req.church = church;
      return next();
    } catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
  }

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

  const messageStore = [];

  const chatEngine = {
    saveMessage: vi.fn((msg) => {
      const saved = { id: uuidv4(), ...msg, created_at: new Date().toISOString() };
      messageStore.push(saved);
      return saved;
    }),
    getMessages: vi.fn((churchId, opts = {}) => {
      return messageStore.filter(m => m.churchId === churchId);
    }),
    broadcastChat: vi.fn(),
  };

  const handleChatCommandMessage = vi.fn().mockResolvedValue(undefined);

  const ctx = {
    db,
    chatEngine,
    requireAdmin,
    requireChurchAppAuth,
    handleChatCommandMessage,
    rateLimit: () => (req, res, next) => next(),
    log: vi.fn(),
    churches: new Map(),
    scheduleEngine: {},
    ...overrides,
  };

  setupChatRoutes(app, ctx);
  return { app, chatEngine, handleChatCommandMessage, messageStore };
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

const makeClient = createClient;

function issueChurchToken(churchId) {
  return jwt.sign({ type: 'church_app', churchId }, JWT_SECRET, { expiresIn: '1h' });
}

function issueAdminToken(userId) {
  return jwt.sign({ type: 'admin', userId, role: 'super_admin' }, JWT_SECRET, { expiresIn: '8h' });
}

// ─── POST /api/church/chat ────────────────────────────────────────────────────

describe('POST /api/church/chat', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 401 without token', async () => {
    const { status } = await client.post('/api/church/chat', { body: { message: 'hello' } });
    expect(status).toBe(401);
  });

  it('returns 400 when message and attachment are both empty', async () => {
    const churchId = seedChurch(db);
    const token = issueChurchToken(churchId);
    const { status, body } = await client.post('/api/church/chat', { token, body: {} });
    expect(status).toBe(400);
    expect(body.error).toMatch(/message|attachment/i);
  });

  it('saves and returns message', async () => {
    const churchId = seedChurch(db, { name: 'Chat Church', td_name: 'Bob' });
    const token = issueChurchToken(churchId);
    const { status, body } = await client.post('/api/church/chat', {
      token,
      body: { message: 'Hello world', senderName: 'Bob' },
    });
    expect(status).toBe(200);
    expect(body.id).toBeTruthy();
    expect(body.message).toBe('Hello world');
    expect(built.chatEngine.saveMessage).toHaveBeenCalledOnce();
    expect(built.chatEngine.broadcastChat).toHaveBeenCalledOnce();
  });

  it('allows empty message when attachment is provided', async () => {
    const churchId = seedChurch(db);
    const token = issueChurchToken(churchId);
    const { status } = await client.post('/api/church/chat', {
      token,
      body: { attachment: { data: 'base64data', mimeType: 'image/jpeg', fileName: 'img.jpg' } },
    });
    expect(status).toBe(200);
  });
});

// ─── GET /api/church/chat ─────────────────────────────────────────────────────

describe('GET /api/church/chat', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 401 without token', async () => {
    const { status } = await client.get('/api/church/chat');
    expect(status).toBe(401);
  });

  it('returns messages array for valid church token', async () => {
    const churchId = seedChurch(db);
    const token = issueChurchToken(churchId);
    const { status, body } = await client.get('/api/church/chat', { token });
    expect(status).toBe(200);
    expect(Array.isArray(body.messages)).toBe(true);
  });
});

// ─── POST /api/churches/:churchId/chat (admin) ────────────────────────────────

describe('POST /api/churches/:churchId/chat (admin)', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 401 without admin token', async () => {
    const churchId = seedChurch(db);
    const { status } = await client.post(`/api/churches/${churchId}/chat`, {
      body: { message: 'hello' },
    });
    expect(status).toBe(401);
  });

  it('returns 404 for unknown church', async () => {
    const adminId = seedAdmin(db);
    const token = issueAdminToken(adminId);
    const { status } = await client.post('/api/churches/no-such-church/chat', {
      token,
      body: { message: 'hello' },
    });
    expect(status).toBe(404);
  });

  it('returns 400 when message is empty', async () => {
    const adminId = seedAdmin(db);
    const churchId = seedChurch(db);
    const token = issueAdminToken(adminId);
    const { status } = await client.post(`/api/churches/${churchId}/chat`, {
      token,
      body: { message: '   ' },
    });
    expect(status).toBe(400);
  });

  it('saves message with admin senderRole', async () => {
    const adminId = seedAdmin(db, { name: 'Admin User' });
    const churchId = seedChurch(db);
    const token = issueAdminToken(adminId);
    const { status, body } = await client.post(`/api/churches/${churchId}/chat`, {
      token,
      body: { message: 'Admin message', senderName: 'Admin User' },
    });
    expect(status).toBe(200);
    expect(body.id).toBeTruthy();
    const saved = built.chatEngine.saveMessage.mock.calls[0][0];
    expect(saved.senderRole).toBe('admin');
  });
});

// ─── GET /api/churches/:churchId/chat (admin) ─────────────────────────────────

describe('GET /api/churches/:churchId/chat (admin)', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 401 without admin token', async () => {
    const { status } = await client.get('/api/churches/any/chat');
    expect(status).toBe(401);
  });

  it('returns messages for valid admin token', async () => {
    const adminId = seedAdmin(db);
    const churchId = seedChurch(db);
    const token = issueAdminToken(adminId);
    const { status, body } = await client.get(`/api/churches/${churchId}/chat`, { token });
    expect(status).toBe(200);
    expect(Array.isArray(body.messages)).toBe(true);
  });
});

// ─── POST /api/church/onboarding/confirm ─────────────────────────────────────

describe('POST /api/church/onboarding/confirm', () => {
  let db, client;

  beforeEach(() => {
    db = createDb();
    client = makeClient(buildApp(db).app);
  });
  afterEach(() => client.close());

  it('returns 401 without token', async () => {
    const { status } = await client.post('/api/church/onboarding/confirm', {
      body: { action: { type: 'SET_GEAR' } },
    });
    expect(status).toBe(401);
  });

  it('returns 400 when action is missing', async () => {
    const churchId = seedChurch(db);
    const token = issueChurchToken(churchId);
    const { status, body } = await client.post('/api/church/onboarding/confirm', {
      token,
      body: {},
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/action/i);
  });
});

// ─── GET /api/church/onboarding/state ────────────────────────────────────────

describe('GET /api/church/onboarding/state', () => {
  let db, client;

  beforeEach(() => {
    db = createDb();
    client = makeClient(buildApp(db).app);
  });
  afterEach(() => client.close());

  it('returns 401 without token', async () => {
    const { status } = await client.get('/api/church/onboarding/state');
    expect(status).toBe(401);
  });

  it('returns {state:null, messages:[]} when no session exists', async () => {
    const churchId = seedChurch(db);
    const token = issueChurchToken(churchId);
    const { status, body } = await client.get('/api/church/onboarding/state', { token });
    expect(status).toBe(200);
    expect(body.state).toBeNull();
    expect(Array.isArray(body.messages)).toBe(true);
  });
});
