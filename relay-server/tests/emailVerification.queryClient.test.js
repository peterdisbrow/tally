import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);
const express = require('express');
const setupEmailVerificationRoutes = require('../src/routes/emailVerification');
const { SqliteQueryClient } = require('../src/db/queryClient');
const { hashPassword } = require('../src/auth');
const { createClient } = require('./helpers/expressTestClient');

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

function poisonDb(realDb) {
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        throw new Error('emailVerification route should use queryClient, not db.prepare');
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function buildApp(realDb) {
  const app = express();
  app.use(express.json());

  const sendOnboardingEmail = vi.fn().mockResolvedValue(undefined);
  const lifecycleEmails = {
    sendWelcomeVerified: vi.fn().mockResolvedValue(undefined),
    sendPasswordReset: vi.fn().mockResolvedValue(undefined),
  };
  const queryClient = new SqliteQueryClient(realDb);

  setupEmailVerificationRoutes(app, {
    db: poisonDb(realDb),
    queryClient,
    APP_URL: 'https://app.example.com',
    sendOnboardingEmail,
    lifecycleEmails,
    rateLimit: () => (req, res, next) => next(),
    log: vi.fn(),
  });

  return { app, mocks: { sendOnboardingEmail, lifecycleEmails } };
}

const makeClient = createClient;

describe('emailVerification queryClient path', () => {
  let db, client, mocks;

  beforeEach(() => {
    db = createDb();
    const built = buildApp(db);
    client = makeClient(built.app);
    mocks = built.mocks;
  });

  afterEach(() => client.close());

  it('verifies email through queryClient without touching db.prepare', async () => {
    seedChurch(db, { email_verify_token: 'good-token-123', email_verified: 0 });
    const { status, headers } = await client.get('/api/church/verify-email?token=good-token-123');
    expect(status).toBe(302);
    expect(headers.location).toMatch(/verified=true/);
    expect(mocks.lifecycleEmails.sendWelcomeVerified).toHaveBeenCalledOnce();
    const row = db.prepare('SELECT email_verified, email_verify_token FROM churches WHERE churchId = ?').get('church-test-001');
    expect(row.email_verified).toBe(1);
    expect(row.email_verify_token).toBeNull();
  });

  it('generates a reset token through queryClient', async () => {
    seedChurch(db, { portal_email: 'portal@church.com' });
    const { status, body } = await client.post('/api/church/forgot-password', {
      body: { email: 'portal@church.com' },
    });
    expect(status).toBe(200);
    expect(body.sent).toBe(true);
    expect(mocks.lifecycleEmails.sendPasswordReset).toHaveBeenCalledOnce();
    const row = db.prepare('SELECT password_reset_token, password_reset_expires FROM churches WHERE churchId = ?').get('church-test-001');
    expect(row.password_reset_token).toBeTruthy();
    expect(new Date(row.password_reset_expires) > new Date()).toBe(true);
  });
});
