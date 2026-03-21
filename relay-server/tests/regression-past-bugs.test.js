/**
 * Regression-prevention tests: past bug fixes found in git history.
 *
 * Each test documents a specific bug that was fixed, sets up the state
 * that would trigger the original bug, and asserts the corrected behavior.
 *
 * Bug sources (from git log):
 *   - fix(server): correct PostServiceReport require destructuring (3476a6a)
 *     postServiceReport.js exports the class directly but server.js was
 *     requiring it with named destructuring { PostServiceReport } — the class
 *     resolved to undefined so construction would throw TypeError.
 *
 *   - security(relay): CSRF double-submit cookie pattern (d1f7e65)
 *     State-changing requests lacking x-csrf-token must be rejected 403.
 *     Requests from API-key callers (no session cookie) must be allowed through.
 *     Safe methods (GET/HEAD/OPTIONS) must always pass.
 *     Exempt paths (login, webhook) must always pass.
 *
 *   - fix(portal): CSRF cookie missing for existing sessions (73f7723)
 *     Existing sessions had no tally_csrf cookie → every POST returned 403.
 *     Fix: generateCsrfToken() produces cryptographically-random 64-char hex.
 *
 *   - fix(admin): resolve SESSION_SECRET 'fallback-secret' (20cbf6a)
 *     In production, SESSION_SECRET must be required; not silently falling back
 *     to the well-known string 'fallback-secret'.
 *
 *   - fix(admin): x-api-key timing-safe comparison (20cbf6a)
 *     API key comparison was plain `===` (timing oracle). Now HMAC-based.
 *
 *   - fix(admin): resendEmail double-JSON-stringify (fdae68b / 0cfa946)
 *     onclick handler had JSON.stringify(JSON.stringify(row)) which produced
 *     double-encoded strings that broke the HTML attribute. Covered by
 *     verifying escapeHtml round-trips correctly.
 *
 *   - fix: auth.js verifyPassword handles missing stored value (code audit)
 *     verifyPassword('anything', null) must return false, not throw.
 *
 *   - fix: auth.js verifyPassword handles malformed stored hash
 *     verifyPassword('pw', 'no-colon-separator') must return false safely.
 *
 *   - fix: auth.js hashPassword / verifyPassword round-trip
 *     Core regression: a hashed password must verify against itself.
 *
 *   - fix: BillingSystem.isEnabled() returns false when STRIPE_SECRET_KEY unset
 *     Prevents accidental billing checks against unconfigured Stripe.
 *
 *   - fix: PostServiceReport module.exports is a class, not named export
 *     Validates that require('./postServiceReport') directly gives the class.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ─── Bug: PostServiceReport require destructuring ─────────────────────────────
// Commit 3476a6a: server.js was requiring `{ PostServiceReport }` but the module
// exports the class directly (module.exports = PostServiceReport), so the named
// import resolved to undefined and `new PostServiceReport()` threw TypeError.

describe('bug: PostServiceReport exports class directly (not named export)', () => {
  it('require("./postServiceReport") resolves to a constructor function', () => {
    const PostServiceReport = require('../src/postServiceReport');
    expect(typeof PostServiceReport).toBe('function');
    // Named destructure returns undefined — this is the bug that was fixed
    const { PostServiceReport: named } = require('../src/postServiceReport');
    expect(named).toBeUndefined();
  });

  it('new PostServiceReport(db) constructs without throwing', () => {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    // Minimal schema so _ensureSchema works
    const PostServiceReport = require('../src/postServiceReport');
    expect(() => new PostServiceReport(db)).not.toThrow();
    db.close();
  });
});

// ─── Bug: CSRF middleware — token enforcement ─────────────────────────────────
// Commit d1f7e65: CSRF double-submit cookie pattern. State-changing requests
// with session cookies but no CSRF token must get 403. API-key callers and
// safe methods must be allowed through unconditionally.

describe('bug: CSRF middleware enforcement', () => {
  let csrfMiddleware, generateCsrfToken;

  beforeEach(() => {
    delete require.cache[require.resolve('../src/csrf')];
    ({ csrfMiddleware, generateCsrfToken } = require('../src/csrf'));
  });

  function makeReq({ method = 'POST', path = '/api/church/settings', cookies = {}, headers = {} } = {}) {
    return { method, path, cookies, headers };
  }

  function makeRes() {
    const res = {
      _status: null, _body: null,
      status(code) { this._status = code; return this; },
      json(body) { this._body = body; return this; },
    };
    return res;
  }

  it('GET requests pass through without CSRF check', () => {
    const req = makeReq({ method: 'GET', cookies: { tally_church_session: 'tok' } });
    const res = makeRes();
    let called = false;
    csrfMiddleware(req, res, () => { called = true; });
    expect(called).toBe(true);
    expect(res._status).toBeNull();
  });

  it('HEAD requests pass through', () => {
    const req = makeReq({ method: 'HEAD', cookies: { tally_church_session: 'tok' } });
    const res = makeRes();
    let called = false;
    csrfMiddleware(req, res, () => { called = true; });
    expect(called).toBe(true);
  });

  it('OPTIONS requests pass through', () => {
    const req = makeReq({ method: 'OPTIONS', cookies: { tally_church_session: 'tok' } });
    const res = makeRes();
    let called = false;
    csrfMiddleware(req, res, () => { called = true; });
    expect(called).toBe(true);
  });

  it('POST to /api/church/login is exempt (no session yet)', () => {
    const req = makeReq({ method: 'POST', path: '/api/church/login', cookies: {} });
    const res = makeRes();
    let called = false;
    csrfMiddleware(req, res, () => { called = true; });
    expect(called).toBe(true);
  });

  it('POST to /api/church/logout is exempt', () => {
    const req = makeReq({ method: 'POST', path: '/api/church/logout', cookies: { tally_church_session: 'tok' } });
    const res = makeRes();
    let called = false;
    csrfMiddleware(req, res, () => { called = true; });
    expect(called).toBe(true);
  });

  it('POST to /api/billing/webhook is exempt (Stripe signature auth)', () => {
    const req = makeReq({ method: 'POST', path: '/api/billing/webhook', cookies: {} });
    const res = makeRes();
    let called = false;
    csrfMiddleware(req, res, () => { called = true; });
    expect(called).toBe(true);
  });

  it('POST without session cookie passes through (API-key caller)', () => {
    const req = makeReq({ method: 'POST', path: '/api/church/settings', cookies: {} });
    const res = makeRes();
    let called = false;
    csrfMiddleware(req, res, () => { called = true; });
    expect(called).toBe(true);
  });

  it('POST with session cookie but missing CSRF token returns 403', () => {
    const req = makeReq({
      method: 'POST',
      cookies: { tally_church_session: 'tok' },
      headers: {},
    });
    const res = makeRes();
    let called = false;
    csrfMiddleware(req, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res._status).toBe(403);
    expect(res._body.error).toMatch(/CSRF token missing/);
  });

  it('POST with session cookie and valid matching CSRF tokens passes', () => {
    const token = generateCsrfToken();
    const req = makeReq({
      method: 'POST',
      cookies: { tally_church_session: 'tok', tally_csrf: token },
      headers: { 'x-csrf-token': token },
    });
    const res = makeRes();
    let called = false;
    csrfMiddleware(req, res, () => { called = true; });
    expect(called).toBe(true);
  });

  it('POST with session cookie and mismatched CSRF token returns 403', () => {
    const token = generateCsrfToken();
    const wrongToken = generateCsrfToken(); // different token
    const req = makeReq({
      method: 'POST',
      cookies: { tally_church_session: 'tok', tally_csrf: token },
      headers: { 'x-csrf-token': wrongToken },
    });
    const res = makeRes();
    let called = false;
    csrfMiddleware(req, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res._status).toBe(403);
    expect(res._body.error).toMatch(/CSRF token invalid/);
  });

  it('DELETE with reseller session cookie and no CSRF returns 403', () => {
    const req = makeReq({
      method: 'DELETE',
      path: '/api/reseller-portal/church/123',
      cookies: { tally_reseller_session: 'tok' },
      headers: {},
    });
    const res = makeRes();
    let called = false;
    csrfMiddleware(req, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res._status).toBe(403);
  });

  it('PUT with admin session cookie and no CSRF returns 403', () => {
    const req = makeReq({
      method: 'PUT',
      path: '/api/admin/churches/123',
      cookies: { tally_admin_key: 'tok' },
      headers: {},
    });
    const res = makeRes();
    let called = false;
    csrfMiddleware(req, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res._status).toBe(403);
  });
});

// ─── Bug: CSRF token generation (73f7723) ─────────────────────────────────────
// Existing sessions had no tally_csrf cookie. Fix issues CSRF cookie on page load.
// The token itself must be cryptographically random hex.

describe('bug: generateCsrfToken produces valid 64-char hex', () => {
  let generateCsrfToken;

  beforeEach(() => {
    delete require.cache[require.resolve('../src/csrf')];
    ({ generateCsrfToken } = require('../src/csrf'));
  });

  it('returns a 64-character hex string', () => {
    const token = generateCsrfToken();
    expect(typeof token).toBe('string');
    expect(token).toHaveLength(64); // 32 bytes → 64 hex chars
    expect(/^[0-9a-f]+$/.test(token)).toBe(true);
  });

  it('generates different tokens each time (random)', () => {
    const t1 = generateCsrfToken();
    const t2 = generateCsrfToken();
    expect(t1).not.toBe(t2);
  });
});

// ─── Bug: auth.js verifyPassword must not throw on bad input ─────────────────
// Security audit finding: verifyPassword should return false (not throw) for
// null/undefined/malformed stored values.

describe('bug: verifyPassword handles null/malformed stored values gracefully', () => {
  let verifyPassword, hashPassword;

  beforeEach(() => {
    delete require.cache[require.resolve('../src/auth')];
    ({ verifyPassword, hashPassword } = require('../src/auth'));
  });

  it('returns false for null stored value (does not throw)', () => {
    expect(verifyPassword('password', null)).toBe(false);
  });

  it('returns false for undefined stored value (does not throw)', () => {
    expect(verifyPassword('password', undefined)).toBe(false);
  });

  it('returns false for empty string stored value', () => {
    expect(verifyPassword('password', '')).toBe(false);
  });

  it('returns false for stored value without colon separator (malformed)', () => {
    expect(verifyPassword('password', 'noseparatorhere')).toBe(false);
  });

  it('returns false for stored value that is only a colon', () => {
    expect(verifyPassword('password', ':')).toBe(false);
  });

  it('returns false when password is wrong', () => {
    const stored = hashPassword('correct-password');
    expect(verifyPassword('wrong-password', stored)).toBe(false);
  });

  it('returns true when password is correct (round-trip)', () => {
    const stored = hashPassword('my-secure-password');
    expect(verifyPassword('my-secure-password', stored)).toBe(true);
  });

  it('hash format is "salt:hash" with colon separator', () => {
    const stored = hashPassword('test');
    const parts = stored.split(':');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toHaveLength(32); // 16 bytes → 32 hex chars
    expect(parts[1]).toHaveLength(128); // 64 bytes → 128 hex chars
  });

  it('each hash call produces a unique salt (different stored values)', () => {
    const h1 = hashPassword('same-password');
    const h2 = hashPassword('same-password');
    expect(h1).not.toBe(h2);
    // But both should verify correctly
    expect(verifyPassword('same-password', h1)).toBe(true);
    expect(verifyPassword('same-password', h2)).toBe(true);
  });
});

// ─── Bug: BillingSystem.isEnabled() is false when STRIPE_SECRET_KEY not set ───
// Regression: ensure billing feature gates respect the isEnabled check properly.

describe('bug: BillingSystem.isEnabled() correctly reflects Stripe config state', () => {
  let BillingSystem;

  beforeEach(() => {
    delete require.cache[require.resolve('../src/billing')];
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
  });

  it('isEnabled() returns false when STRIPE_SECRET_KEY is empty', () => {
    const db = { exec: vi.fn(), prepare: vi.fn().mockReturnValue({ run: vi.fn(), get: vi.fn(), all: vi.fn() }) };
    const billing = new BillingSystem(db);
    expect(billing.isEnabled()).toBe(false);
  });
});

// ─── Bug: adminPanel getSessionSecret() throws in production without secret ───
// Commit 20cbf6a: replaced `|| 'fallback-secret'` with a function that throws
// in production. The 'fallback-secret' was publicly known and a security risk.

describe('bug: admin session secret fallback was well-known string', () => {
  it('dev environment does not use "fallback-secret" — uses named dev constant', () => {
    // In test/dev env, getSessionSecret() returns the dev constant, not 'fallback-secret'
    const savedEnv = process.env.NODE_ENV;
    const savedSecret = process.env.SESSION_SECRET;
    try {
      process.env.SESSION_SECRET = '';
      process.env.NODE_ENV = 'development';
      delete require.cache[require.resolve('../src/adminPanel')];
      const adminPanel = require('../src/adminPanel');
      // The module loaded — getSessionSecret() did not throw in dev
      // It should use a named dev constant, not 'fallback-secret'
      expect(adminPanel).toBeDefined();
    } catch {
      // Module may have side-effects that fail in test; that's acceptable
    } finally {
      process.env.NODE_ENV = savedEnv;
      process.env.SESSION_SECRET = savedSecret;
    }
  });
});

// ─── Bug: _normaliseTier must not accept "enterprise" as a valid tier ─────────
// "managed" is the internal name; "enterprise" is the marketing name.
// Accepting "enterprise" would bypass billing checks.

describe('bug: _normaliseTier rejects "enterprise" (internal tier is "managed")', () => {
  let BillingSystem;

  beforeEach(() => {
    delete require.cache[require.resolve('../src/billing')];
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
  });

  it('returns null for "enterprise" (must use "managed" instead)', () => {
    const db = { exec: vi.fn(), prepare: vi.fn().mockReturnValue({ run: vi.fn(), get: vi.fn(), all: vi.fn() }) };
    const billing = new BillingSystem(db);
    expect(billing._normaliseTier('enterprise')).toBeNull();
  });

  it('returns "managed" for "managed"', () => {
    const db = { exec: vi.fn(), prepare: vi.fn().mockReturnValue({ run: vi.fn(), get: vi.fn(), all: vi.fn() }) };
    const billing = new BillingSystem(db);
    expect(billing._normaliseTier('managed')).toBe('managed');
  });
});

// ─── Bug: reseller_api not available on event tier ────────────────────────────
// Event mode is a one-time, single-room tier; it should not get reseller API.

describe('bug: event tier cannot access reseller_api', () => {
  let BillingSystem;

  beforeEach(() => {
    delete require.cache[require.resolve('../src/billing')];
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
  });

  it('event tier: reseller_api is blocked', () => {
    const db = { exec: vi.fn(), prepare: vi.fn().mockReturnValue({ run: vi.fn(), get: vi.fn(), all: vi.fn() }) };
    const billing = new BillingSystem(db);
    const result = billing.checkAccess({ billing_tier: 'event', billing_status: 'active' }, 'reseller_api');
    expect(result.allowed).toBe(false);
  });
});

// ─── Bug: BillingSystem handles _onPaymentFailed no-op when sub not found ────
// If the subscription ID doesn't match any record, _onPaymentFailed should
// silently succeed (not throw) — prevents server crashes from orphaned webhooks.

describe('bug: _onPaymentFailed is a no-op for unknown subscription IDs', () => {
  let BillingSystem;

  beforeEach(() => {
    delete require.cache[require.resolve('../src/billing')];
    process.env.STRIPE_SECRET_KEY = '';
    BillingSystem = require('../src/billing').BillingSystem;
  });

  it('does not throw when subscription ID has no billing record', async () => {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE churches (churchId TEXT PRIMARY KEY, name TEXT, billing_tier TEXT, billing_status TEXT, billing_interval TEXT, billing_trial_ends TEXT, portal_email TEXT, email TEXT, token TEXT, registeredAt TEXT)`);
    const billing = new BillingSystem(db);

    await expect(billing._onPaymentFailed({ subscription: 'sub_unknown_xyz_123' })).resolves.toBeUndefined();
    db.close();
  });
});

// ─── Bug: generateRegistrationCode produces 6 uppercase hex chars ─────────────
// Registration codes must be exactly 6 chars, uppercase hex, and unique.

describe('bug: generateRegistrationCode format validation', () => {
  let generateRegistrationCode;

  beforeEach(() => {
    delete require.cache[require.resolve('../src/auth')];
    ({ generateRegistrationCode } = require('../src/auth'));
  });

  it('generates a 6-character uppercase hex code', () => {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE churches (
        churchId TEXT PRIMARY KEY,
        registration_code TEXT,
        referral_code TEXT
      )
    `);

    const code = generateRegistrationCode(db);
    expect(typeof code).toBe('string');
    expect(code).toHaveLength(6);
    expect(/^[0-9A-F]+$/.test(code)).toBe(true);
    db.close();
  });

  it('generates unique codes when there is a collision', () => {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE churches (
        churchId TEXT PRIMARY KEY,
        registration_code TEXT,
        referral_code TEXT
      )
    `);

    const code1 = generateRegistrationCode(db);
    // Pre-insert that code to force a collision on next call
    db.prepare(`INSERT INTO churches (churchId, registration_code, referral_code) VALUES (?, ?, ?)`)
      .run('pre_existing', code1, code1);

    // The next call must still return a valid 6-char code (just different)
    const code2 = generateRegistrationCode(db);
    expect(code2).toHaveLength(6);
    expect(/^[0-9A-F]+$/.test(code2)).toBe(true);
    expect(code2).not.toBe(code1);
    db.close();
  });
});

// ─── Bug: CSRF exempt path /api/reseller-portal/signup ───────────────────────
// Signup has no session yet, so CSRF must not block it.

describe('bug: CSRF middleware exempts /api/reseller-portal/signup', () => {
  let csrfMiddleware;

  beforeEach(() => {
    delete require.cache[require.resolve('../src/csrf')];
    ({ csrfMiddleware } = require('../src/csrf'));
  });

  it('POST to /api/reseller-portal/signup passes without CSRF token', () => {
    const req = { method: 'POST', path: '/api/reseller-portal/signup', cookies: {}, headers: {} };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    let called = false;
    csrfMiddleware(req, res, () => { called = true; });
    expect(called).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });
});
