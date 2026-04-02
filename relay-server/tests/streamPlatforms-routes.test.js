/**
 * Tests for src/routes/streamPlatforms.js
 *
 * Covers: Facebook OAuth callback, poll for pending code,
 *         YouTube/Facebook exchange, disconnect, status, stream-keys.
 *
 * streamOAuth is stubbed — we test the HTTP layer, not the OAuth module.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const setupStreamPlatformRoutes = require('../src/routes/streamPlatforms');
const { createClient } = require('./helpers/expressTestClient');

const JWT_SECRET = 'test-stream-platforms-secret';

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
  return db;
}

function seedChurch(db, opts = {}) {
  const churchId = opts.churchId || uuidv4();
  db.prepare(
    'INSERT INTO churches (churchId, name, email, token, registeredAt) VALUES (?, ?, ?, ?, ?)'
  ).run(churchId, opts.name || 'Stream Church', 'stream@church.com', 'tok', new Date().toISOString());
  return churchId;
}

// ─── App factory ──────────────────────────────────────────────────────────────

function buildApp(db, streamOAuthOverrides = {}) {
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

  const pendingCodes = new Map();

  const streamOAuth = {
    storeFacebookPendingCode: vi.fn((state, code) => pendingCodes.set(state, { code })),
    getFacebookPendingCode: vi.fn((state) => pendingCodes.get(state) || null),
    exchangeYouTubeCode: vi.fn().mockResolvedValue({ connected: true, channelTitle: 'Test Channel' }),
    fetchYouTubeStreamKey: vi.fn().mockResolvedValue({ streamKey: 'yt-key-123' }),
    disconnectYouTube: vi.fn(),
    exchangeFacebookCode: vi.fn().mockResolvedValue({ connected: true, pages: [] }),
    selectFacebookPage: vi.fn().mockResolvedValue({ connected: true, streamKey: 'fb-key-456' }),
    refreshFacebookStreamKey: vi.fn().mockResolvedValue({ streamKey: 'fb-key-new' }),
    disconnectFacebook: vi.fn(),
    getStatus: vi.fn().mockReturnValue({ youtube: { connected: false }, facebook: { connected: false } }),
    getStreamKeys: vi.fn().mockReturnValue({ youtube: null, facebook: null }),
    ...streamOAuthOverrides,
  };

  const ctx = {
    requireChurchAppAuth,
    streamOAuth,
    safeErrorMessage: (e) => e.message,
  };

  setupStreamPlatformRoutes(app, ctx);
  return { app, streamOAuth, pendingCodes };
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

const makeClient = createClient;

function issueChurchToken(churchId) {
  return jwt.sign({ type: 'church_app', churchId }, JWT_SECRET, { expiresIn: '1h' });
}

// ─── GET /api/oauth/facebook/callback ─────────────────────────────────────────

describe('GET /api/oauth/facebook/callback', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 400 when code is missing', async () => {
    const { status } = await client.get('/api/oauth/facebook/callback?state=abc');
    expect(status).toBe(400);
  });

  it('returns 400 when state is missing', async () => {
    const { status } = await client.get('/api/oauth/facebook/callback?code=abc123');
    expect(status).toBe(400);
  });

  it('returns 400 when error param is present', async () => {
    const { status } = await client.get('/api/oauth/facebook/callback?error=access_denied&state=abc&code=nope');
    expect(status).toBe(400);
  });

  it('stores pending code and returns success HTML on valid callback', async () => {
    const { status, body, headers } = await client.get('/api/oauth/facebook/callback?code=fbcode123&state=state-abc');
    expect(status).toBe(200);
    expect(headers['content-type']).toMatch(/html/i);
    expect(built.streamOAuth.storeFacebookPendingCode).toHaveBeenCalledWith('state-abc', 'fbcode123');
  });
});

// ─── GET /api/church/app/oauth/facebook/pending ───────────────────────────────

describe('GET /api/church/app/oauth/facebook/pending', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 401 without token', async () => {
    const { status } = await client.get('/api/church/app/oauth/facebook/pending?state=abc');
    expect(status).toBe(401);
  });

  it('returns 400 when state param is missing', async () => {
    const churchId = seedChurch(db);
    const token = issueChurchToken(churchId);
    const { status, body } = await client.get('/api/church/app/oauth/facebook/pending', { token });
    expect(status).toBe(400);
    expect(body.error).toMatch(/state/i);
  });

  it('returns {ready:false} when no pending code for state', async () => {
    const churchId = seedChurch(db);
    const token = issueChurchToken(churchId);
    const { status, body } = await client.get('/api/church/app/oauth/facebook/pending?state=unknown-state', { token });
    expect(status).toBe(200);
    expect(body.ready).toBe(false);
  });

  it('returns {ready:true, code} when pending code exists', async () => {
    const churchId = seedChurch(db);
    const token = issueChurchToken(churchId);
    // Pre-store a pending code
    built.pendingCodes.set('my-state-123', { code: 'auth-code-abc' });
    const { status, body } = await client.get('/api/church/app/oauth/facebook/pending?state=my-state-123', { token });
    expect(status).toBe(200);
    expect(body.ready).toBe(true);
    expect(body.code).toBe('auth-code-abc');
  });
});

// ─── POST /api/church/app/oauth/youtube/exchange ──────────────────────────────

describe('POST /api/church/app/oauth/youtube/exchange', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 401 without token', async () => {
    const { status } = await client.post('/api/church/app/oauth/youtube/exchange', {
      body: { code: 'code', redirectUri: 'http://localhost' },
    });
    expect(status).toBe(401);
  });

  it('calls exchangeYouTubeCode and returns result', async () => {
    const churchId = seedChurch(db);
    const token = issueChurchToken(churchId);
    const { status, body } = await client.post('/api/church/app/oauth/youtube/exchange', {
      token,
      body: { code: 'yt-auth-code', redirectUri: 'http://localhost:3000/callback' },
    });
    expect(status).toBe(200);
    expect(body.connected).toBe(true);
    expect(built.streamOAuth.exchangeYouTubeCode).toHaveBeenCalledWith(churchId, 'yt-auth-code', 'http://localhost:3000/callback');
  });

  it('returns 500 when exchange throws', async () => {
    const churchId = seedChurch(db);
    const token = issueChurchToken(churchId);
    built.streamOAuth.exchangeYouTubeCode.mockRejectedValueOnce(new Error('OAuth token exchange failed'));
    const { status, body } = await client.post('/api/church/app/oauth/youtube/exchange', {
      token,
      body: { code: 'bad-code' },
    });
    expect(status).toBe(500);
    expect(body.error).toMatch(/OAuth token exchange failed/);
  });
});

// ─── DELETE /api/church/app/oauth/youtube ─────────────────────────────────────

describe('DELETE /api/church/app/oauth/youtube', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 401 without token', async () => {
    const { status } = await client.delete('/api/church/app/oauth/youtube');
    expect(status).toBe(401);
  });

  it('calls disconnectYouTube and returns {disconnected:true}', async () => {
    const churchId = seedChurch(db);
    const token = issueChurchToken(churchId);
    const { status, body } = await client.delete('/api/church/app/oauth/youtube', { token });
    expect(status).toBe(200);
    expect(body.disconnected).toBe(true);
    expect(built.streamOAuth.disconnectYouTube).toHaveBeenCalledWith(churchId);
  });
});

// ─── POST /api/church/app/oauth/facebook/exchange ─────────────────────────────

describe('POST /api/church/app/oauth/facebook/exchange', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 401 without token', async () => {
    const { status } = await client.post('/api/church/app/oauth/facebook/exchange', {
      body: { code: 'code' },
    });
    expect(status).toBe(401);
  });

  it('calls exchangeFacebookCode and returns result', async () => {
    const churchId = seedChurch(db);
    const token = issueChurchToken(churchId);
    const { status, body } = await client.post('/api/church/app/oauth/facebook/exchange', {
      token,
      body: { code: 'fb-code', redirectUri: 'http://localhost/cb' },
    });
    expect(status).toBe(200);
    expect(body.connected).toBe(true);
    expect(built.streamOAuth.exchangeFacebookCode).toHaveBeenCalledWith(churchId, 'fb-code', 'http://localhost/cb');
  });
});

// ─── DELETE /api/church/app/oauth/facebook ────────────────────────────────────

describe('DELETE /api/church/app/oauth/facebook', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns {disconnected:true} for valid token', async () => {
    const churchId = seedChurch(db);
    const token = issueChurchToken(churchId);
    const { status, body } = await client.delete('/api/church/app/oauth/facebook', { token });
    expect(status).toBe(200);
    expect(body.disconnected).toBe(true);
    expect(built.streamOAuth.disconnectFacebook).toHaveBeenCalledWith(churchId);
  });
});

// ─── GET /api/church/app/oauth/status ────────────────────────────────────────

describe('GET /api/church/app/oauth/status', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 401 without token', async () => {
    const { status } = await client.get('/api/church/app/oauth/status');
    expect(status).toBe(401);
  });

  it('returns combined platform status', async () => {
    const churchId = seedChurch(db);
    const token = issueChurchToken(churchId);
    built.streamOAuth.getStatus.mockReturnValueOnce({
      youtube: { connected: true, channelTitle: 'My Channel' },
      facebook: { connected: false },
    });
    const { status, body } = await client.get('/api/church/app/oauth/status', { token });
    expect(status).toBe(200);
    expect(body.youtube.connected).toBe(true);
    expect(body.facebook.connected).toBe(false);
  });
});

// ─── GET /api/church/app/oauth/stream-keys ────────────────────────────────────

describe('GET /api/church/app/oauth/stream-keys', () => {
  let db, client, built;

  beforeEach(() => {
    db = createDb();
    built = buildApp(db);
    client = makeClient(built.app);
  });
  afterEach(() => client.close());

  it('returns 401 without token', async () => {
    const { status } = await client.get('/api/church/app/oauth/stream-keys');
    expect(status).toBe(401);
  });

  it('returns stream keys for valid token', async () => {
    const churchId = seedChurch(db);
    const token = issueChurchToken(churchId);
    built.streamOAuth.getStreamKeys.mockReturnValueOnce({ youtube: 'yt-key', facebook: 'fb-key' });
    const { status, body } = await client.get('/api/church/app/oauth/stream-keys', { token });
    expect(status).toBe(200);
    expect(body.youtube).toBe('yt-key');
  });
});
