/**
 * Tests for src/csrf.js — CSRF double-submit cookie pattern.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { generateCsrfToken, setCsrfCookie, csrfMiddleware } = require('../src/csrf');

// ─── generateCsrfToken ────────────────────────────────────────────────────────

describe('generateCsrfToken', () => {
  it('returns a 64-char hex string (32 random bytes)', () => {
    const token = generateCsrfToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns a unique token each call', () => {
    const a = generateCsrfToken();
    const b = generateCsrfToken();
    expect(a).not.toBe(b);
  });
});

// ─── setCsrfCookie ────────────────────────────────────────────────────────────

describe('setCsrfCookie', () => {
  it('calls res.cookie with the correct cookie name', () => {
    const res = { cookie: vi.fn() };
    setCsrfCookie(res, 'abc123');
    expect(res.cookie).toHaveBeenCalledWith('tally_csrf', 'abc123', expect.any(Object));
  });

  it('sets httpOnly: false so JS can read it', () => {
    const res = { cookie: vi.fn() };
    setCsrfCookie(res, 'abc123');
    const opts = res.cookie.mock.calls[0][2];
    expect(opts.httpOnly).toBe(false);
  });

  it('sets sameSite: Strict', () => {
    const res = { cookie: vi.fn() };
    setCsrfCookie(res, 'token');
    const opts = res.cookie.mock.calls[0][2];
    expect(opts.sameSite).toBe('Strict');
  });

  it('sets maxAge to 7 days in ms', () => {
    const res = { cookie: vi.fn() };
    setCsrfCookie(res, 'token');
    const opts = res.cookie.mock.calls[0][2];
    expect(opts.maxAge).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

// ─── csrfMiddleware ───────────────────────────────────────────────────────────

function makeReq({ method = 'POST', path = '/api/some/endpoint', cookies = {}, headers = {} } = {}) {
  return { method, path, cookies, headers };
}

function makeRes() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe('csrfMiddleware — safe methods bypass', () => {
  it('allows GET without CSRF token', () => {
    const req = makeReq({ method: 'GET', cookies: { tally_church_session: 'session' } });
    const res = makeRes();
    const next = vi.fn();
    csrfMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('allows HEAD without CSRF token', () => {
    const req = makeReq({ method: 'HEAD', cookies: { tally_church_session: 's' } });
    const res = makeRes();
    const next = vi.fn();
    csrfMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('allows OPTIONS without CSRF token', () => {
    const req = makeReq({ method: 'OPTIONS', cookies: { tally_church_session: 's' } });
    const res = makeRes();
    const next = vi.fn();
    csrfMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('csrfMiddleware — exempt routes bypass', () => {
  it.each([
    '/api/church/login',
    '/api/church/logout',
    '/api/reseller-portal/login',
    '/api/reseller-portal/logout',
    '/api/reseller-portal/signup',
    '/api/billing/webhook',
  ])('allows POST %s without CSRF token', (path) => {
    const req = makeReq({ method: 'POST', path, cookies: { tally_church_session: 's' } });
    const res = makeRes();
    const next = vi.fn();
    csrfMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('csrfMiddleware — API key / bearer token requests skip CSRF', () => {
  it('skips CSRF check when no session cookie present', () => {
    const req = makeReq({
      method: 'POST',
      path: '/api/church/update',
      cookies: {}, // no session cookie — API key auth
      headers: { 'x-admin-api-key': 'key123' },
    });
    const res = makeRes();
    const next = vi.fn();
    csrfMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('skips CSRF when Authorization header present even with session cookie', () => {
    const req = makeReq({
      method: 'POST',
      path: '/api/churches/register',
      cookies: { tally_church_session: 'sess' }, // session cookie from another portal
      headers: { authorization: 'Bearer some-jwt-token' },
    });
    const res = makeRes();
    const next = vi.fn();
    csrfMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('skips CSRF when x-api-key header present even with session cookie', () => {
    const req = makeReq({
      method: 'POST',
      path: '/api/admin/churches',
      cookies: { tally_church_session: 'sess', tally_reseller_session: 'sess2' },
      headers: { 'x-api-key': 'admin-key-123' },
    });
    const res = makeRes();
    const next = vi.fn();
    csrfMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('csrfMiddleware — enforcement with session cookie', () => {
  const token = generateCsrfToken();

  it('returns 403 when CSRF cookie is missing', () => {
    const req = makeReq({
      method: 'POST',
      cookies: { tally_church_session: 'sess' }, // session but no csrf cookie
      headers: { 'x-csrf-token': token },
    });
    const res = makeRes();
    const next = vi.fn();
    csrfMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'CSRF token missing' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when x-csrf-token header is missing', () => {
    const req = makeReq({
      method: 'POST',
      cookies: { tally_church_session: 'sess', tally_csrf: token },
      headers: {}, // no header
    });
    const res = makeRes();
    const next = vi.fn();
    csrfMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'CSRF token missing' });
  });

  it('returns 403 when cookie and header tokens do not match', () => {
    const differentToken = generateCsrfToken();
    const req = makeReq({
      method: 'POST',
      cookies: { tally_church_session: 'sess', tally_csrf: token },
      headers: { 'x-csrf-token': differentToken },
    });
    const res = makeRes();
    const next = vi.fn();
    csrfMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'CSRF token invalid' });
  });

  it('calls next() when cookie and header tokens match', () => {
    const req = makeReq({
      method: 'POST',
      cookies: { tally_church_session: 'sess', tally_csrf: token },
      headers: { 'x-csrf-token': token },
    });
    const res = makeRes();
    const next = vi.fn();
    csrfMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('also enforces on tally_reseller_session cookie', () => {
    const req = makeReq({
      method: 'DELETE',
      cookies: { tally_reseller_session: 'sess', tally_csrf: token },
      headers: { 'x-csrf-token': token },
    });
    const res = makeRes();
    const next = vi.fn();
    csrfMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('also enforces on tally_admin_key cookie', () => {
    const req = makeReq({
      method: 'PUT',
      cookies: { tally_admin_key: 'sess', tally_csrf: token },
      headers: { 'x-csrf-token': token },
    });
    const res = makeRes();
    const next = vi.fn();
    csrfMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('returns 403 when header token is a truncated version of the cookie token', () => {
    // A valid token in cookie, but only half the hex in the header (different lengths)
    const req = makeReq({
      method: 'POST',
      cookies: { tally_church_session: 'sess', tally_csrf: token },
      headers: { 'x-csrf-token': token.slice(0, 32) }, // half-length hex
    });
    const res = makeRes();
    const next = vi.fn();
    csrfMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects mismatched token lengths', () => {
    const shortToken = 'aabbcc'; // too short
    const req = makeReq({
      method: 'POST',
      cookies: { tally_church_session: 'sess', tally_csrf: token },
      headers: { 'x-csrf-token': shortToken },
    });
    const res = makeRes();
    const next = vi.fn();
    csrfMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
