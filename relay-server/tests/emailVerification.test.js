/**
 * Tests for src/routes/emailVerification.js
 *
 * Covers: verify-email GET, resend-verification POST,
 *         forgot-password POST, reset-password-token POST.
 *
 * Uses in-memory SQLite + real Express app (no supertest).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const express = require('express');
const crypto = require('crypto');
const { hashPassword } = require('../src/auth');
const setupEmailVerificationRoutes = require('../src/routes/emailVerification');
const { createClient } = require('./helpers/expressTestClient');

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
      password_reset_token TEXT,
      password_reset_expires TEXT
    )
  `);
  return db;
}

function seedChurch(db, opts = {}) {
  const churchId = opts.churchId || 'church-test-001';
  db.prepare(`
    INSERT INTO churches
      (churchId, name, email, token, registeredAt, portal_email, email_verified, email_verify_token, password_reset_token, password_reset_expires)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    churchId,
    opts.name || 'Test Church',
    opts.email || 'test@church.com',
    'tok',
    new Date().toISOString(),
    opts.portal_email || 'portal@church.com',
    opts.email_verified ?? 0,
    opts.email_verify_token || null,
    opts.password_reset_token || null,
    opts.password_reset_expires || null,
  );
  return churchId;
}

// ─── App factory ──────────────────────────────────────────────────────────────

function buildApp(db, overrides = {}) {
  const app = express();
  app.use(express.json());

  const sendOnboardingEmail = vi.fn().mockResolvedValue(undefined);
  const lifecycleEmails = {
    sendWelcomeVerified: vi.fn().mockResolvedValue(undefined),
    sendPasswordReset: vi.fn().mockResolvedValue(undefined),
  };

  const ctx = {
    db,
    APP_URL: 'https://app.example.com',
    sendOnboardingEmail,
    lifecycleEmails,
    rateLimit: () => (req, res, next) => next(),
    log: vi.fn(),
    ...overrides,
  };

  setupEmailVerificationRoutes(app, ctx);
  return { app, mocks: { sendOnboardingEmail, lifecycleEmails } };
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

const makeClient = createClient;

// ─── GET /api/church/verify-email ─────────────────────────────────────────────

describe('GET /api/church/verify-email', () => {
  let db, client;

  beforeEach(() => {
    db = createDb();
    const { app } = buildApp(db);
    client = makeClient(app);
  });
  afterEach(() => client.close());

  it('returns 400 when token is missing', async () => {
    const { status, body } = await client.get('/api/church/verify-email');
    expect(status).toBe(400);
    expect(body.error).toMatch(/token/i);
  });

  it('returns 404 for an invalid token', async () => {
    const { status, body } = await client.get('/api/church/verify-email?token=notarealtoken');
    expect(status).toBe(404);
    expect(body.error).toMatch(/invalid|expired/i);
  });

  it('redirects to ?verified=already when already verified', async () => {
    seedChurch(db, { email_verify_token: 'valid-tok-already', email_verified: 1 });
    const { status, headers } = await client.get('/api/church/verify-email?token=valid-tok-already');
    expect(status).toBe(302);
    expect(headers.location).toMatch(/verified=already/);
  });

  it('verifies email and clears token on success', async () => {
    seedChurch(db, { email_verify_token: 'good-token-123', email_verified: 0 });
    const { status, headers } = await client.get('/api/church/verify-email?token=good-token-123');
    expect(status).toBe(302);
    expect(headers.location).toMatch(/verified=true/);
    const row = db.prepare('SELECT email_verified, email_verify_token FROM churches WHERE churchId = ?').get('church-test-001');
    expect(row.email_verified).toBe(1);
    expect(row.email_verify_token).toBeNull();
  });
});

// ─── POST /api/church/resend-verification ─────────────────────────────────────

describe('POST /api/church/resend-verification', () => {
  let db, client, mocks;

  beforeEach(() => {
    db = createDb();
    const built = buildApp(db);
    client = makeClient(built.app);
    mocks = built.mocks;
  });
  afterEach(() => client.close());

  it('returns 400 when email is missing', async () => {
    const { status, body } = await client.post('/api/church/resend-verification', { body: {} });
    expect(status).toBe(400);
    expect(body.error).toMatch(/email/i);
  });

  it('returns {sent:true} for unknown email (no enumeration)', async () => {
    const { status, body } = await client.post('/api/church/resend-verification', {
      body: { email: 'nobody@unknown.com' },
    });
    expect(status).toBe(200);
    expect(body.sent).toBe(true);
  });

  it('returns {sent:true, alreadyVerified:true} for already-verified church', async () => {
    seedChurch(db, { portal_email: 'portal@church.com', email_verified: 1 });
    const { status, body } = await client.post('/api/church/resend-verification', {
      body: { email: 'portal@church.com' },
    });
    expect(status).toBe(200);
    expect(body.alreadyVerified).toBe(true);
  });

  it('sends verification email for unverified church with existing token', async () => {
    seedChurch(db, { portal_email: 'portal@church.com', email_verified: 0, email_verify_token: 'existing-token' });
    const { status, body } = await client.post('/api/church/resend-verification', {
      body: { email: 'portal@church.com' },
    });
    expect(status).toBe(200);
    expect(body.sent).toBe(true);
    expect(mocks.sendOnboardingEmail).toHaveBeenCalledOnce();
    const callArg = mocks.sendOnboardingEmail.mock.calls[0][0];
    expect(callArg.to).toBe('portal@church.com');
    expect(callArg.html).toMatch(/existing-token/);
  });

  it('generates new token for unverified church with no token', async () => {
    seedChurch(db, { portal_email: 'portal@church.com', email_verified: 0, email_verify_token: null });
    const { status, body } = await client.post('/api/church/resend-verification', {
      body: { email: 'portal@church.com' },
    });
    expect(status).toBe(200);
    expect(body.sent).toBe(true);
    const row = db.prepare('SELECT email_verify_token FROM churches WHERE churchId = ?').get('church-test-001');
    expect(row.email_verify_token).toBeTruthy();
    expect(row.email_verify_token.length).toBeGreaterThan(16);
  });

  it('normalises email to lowercase', async () => {
    seedChurch(db, { portal_email: 'portal@church.com', email_verified: 0, email_verify_token: 'tok' });
    const { status, body } = await client.post('/api/church/resend-verification', {
      body: { email: 'PORTAL@CHURCH.COM' },
    });
    expect(status).toBe(200);
    expect(body.sent).toBe(true);
  });
});

// ─── POST /api/church/forgot-password ─────────────────────────────────────────

describe('POST /api/church/forgot-password', () => {
  let db, client, mocks;

  beforeEach(() => {
    db = createDb();
    const built = buildApp(db);
    client = makeClient(built.app);
    mocks = built.mocks;
  });
  afterEach(() => client.close());

  it('returns 400 when email is missing', async () => {
    const { status, body } = await client.post('/api/church/forgot-password', { body: {} });
    expect(status).toBe(400);
    expect(body.error).toMatch(/email/i);
  });

  it('returns {sent:true} for unknown email (no enumeration)', async () => {
    const { status, body } = await client.post('/api/church/forgot-password', {
      body: { email: 'nobody@example.com' },
    });
    expect(status).toBe(200);
    expect(body.sent).toBe(true);
    expect(mocks.lifecycleEmails.sendPasswordReset).not.toHaveBeenCalled();
  });

  it('generates reset token and calls lifecycle email for known church', async () => {
    seedChurch(db, { portal_email: 'portal@church.com' });
    const { status, body } = await client.post('/api/church/forgot-password', {
      body: { email: 'portal@church.com' },
    });
    expect(status).toBe(200);
    expect(body.sent).toBe(true);
    const row = db.prepare('SELECT password_reset_token, password_reset_expires FROM churches WHERE churchId = ?').get('church-test-001');
    expect(row.password_reset_token).toBeTruthy();
    expect(new Date(row.password_reset_expires) > new Date()).toBe(true);
    expect(mocks.lifecycleEmails.sendPasswordReset).toHaveBeenCalledOnce();
  });
});

// ─── POST /api/church/reset-password-token ────────────────────────────────────

describe('POST /api/church/reset-password-token', () => {
  let db, client;

  beforeEach(() => {
    db = createDb();
    const { app } = buildApp(db);
    client = makeClient(app);
  });
  afterEach(() => client.close());

  it('returns 400 when token or password is missing', async () => {
    const { status } = await client.post('/api/church/reset-password-token', {
      body: { token: 'abc' },
    });
    expect(status).toBe(400);
  });

  it('returns 400 when password is too short', async () => {
    const { status, body } = await client.post('/api/church/reset-password-token', {
      body: { token: 'abc', password: 'short' },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/8 characters/i);
  });

  it('returns 400 for an invalid token', async () => {
    const { status, body } = await client.post('/api/church/reset-password-token', {
      body: { token: 'no-such-token', password: 'NewSecure!123' },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid|expired/i);
  });

  it('returns 400 for an expired token', async () => {
    const pastDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    seedChurch(db, { password_reset_token: 'expired-tok', password_reset_expires: pastDate });
    const { status, body } = await client.post('/api/church/reset-password-token', {
      body: { token: 'expired-tok', password: 'NewSecure!123' },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/expired/i);
  });

  it('resets password and clears token on success', async () => {
    const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    seedChurch(db, { password_reset_token: 'valid-reset-tok', password_reset_expires: futureDate });
    const { status, body } = await client.post('/api/church/reset-password-token', {
      body: { token: 'valid-reset-tok', password: 'NewSecure!123' },
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const row = db.prepare('SELECT portal_password_hash, password_reset_token FROM churches WHERE churchId = ?').get('church-test-001');
    expect(row.portal_password_hash).toBeTruthy();
    expect(row.password_reset_token).toBeNull();
  });

  it('clears the reset token after expiry check even on expired token', async () => {
    const pastDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    seedChurch(db, { password_reset_token: 'stale-tok', password_reset_expires: pastDate });
    await client.post('/api/church/reset-password-token', {
      body: { token: 'stale-tok', password: 'NewSecure!123' },
    });
    const row = db.prepare('SELECT password_reset_token FROM churches WHERE churchId = ?').get('church-test-001');
    expect(row.password_reset_token).toBeNull();
  });
});
