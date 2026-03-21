/**
 * Rate limit enforcement tests — verifies rate limiting actually stops requests,
 * that independent identifiers have independent buckets, and that the
 * consumeRateLimit function returns correct metadata.
 *
 * These tests complement rate-limit.test.js (which tests the basic happy path).
 * Focus here: enforcement at scale, isolation, and metadata accuracy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import rateLimitModule from '../src/rateLimit.js';

const { createRateLimit, consumeRateLimit } = rateLimitModule;

// ─── Helpers (same pattern as rate-limit.test.js) ─────────────────────────────

function makeReq(path = '/api/test', ip = '203.0.113.55') {
  return {
    path,
    ip,
    headers: {},
    socket: { remoteAddress: ip },
  };
}

function makeRes() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    set(name, value) { this.headers[name] = value; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    send(payload) { this.body = payload; return this; },
  };
}

beforeEach(() => {
  // Always clear Redis env vars so tests use in-memory store
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.RATE_LIMIT_KEY_PREFIX;
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Rapid sequential requests hit and stay blocked ──────────────────────────

describe('Rate limit enforcement — rapid sequential requests', () => {
  it('blocks exactly after maxAttempts+1 requests', async () => {
    const scope = `enforcement-seq-${Date.now()}-${Math.random()}`;
    const limiter = createRateLimit({ scope, maxAttempts: 3, windowMs: 60_000 });
    const req = makeReq('/api/login', '10.0.0.1');

    // Requests 1-3: all should pass
    for (let i = 1; i <= 3; i++) {
      const next = vi.fn();
      const res = makeRes();
      await limiter(req, res, next);
      expect(next, `request ${i} should pass`).toHaveBeenCalledTimes(1);
      expect(res.statusCode, `request ${i} should have null status`).toBeNull();
    }

    // Request 4: should be blocked
    const next4 = vi.fn();
    const res4 = makeRes();
    await limiter(req, res4, next4);
    expect(next4).not.toHaveBeenCalled();
    expect(res4.statusCode).toBe(429);
  });

  it('all subsequent requests after limit are blocked, not just the first over-limit', async () => {
    const scope = `enforcement-sustained-${Date.now()}-${Math.random()}`;
    const limiter = createRateLimit({ scope, maxAttempts: 2, windowMs: 60_000 });
    const req = makeReq('/api/login', '10.0.1.1');

    // Exhaust the limit
    await limiter(req, makeRes(), vi.fn());
    await limiter(req, makeRes(), vi.fn());

    // All subsequent requests (5 of them) should all be blocked
    for (let i = 0; i < 5; i++) {
      const next = vi.fn();
      const res = makeRes();
      await limiter(req, res, next);
      expect(next, `over-limit request ${i + 1} must not call next()`).not.toHaveBeenCalled();
      expect(res.statusCode, `over-limit request ${i + 1} should return 429`).toBe(429);
    }
  });

  it('response body contains error message and retryAfter when blocked', async () => {
    const scope = `enforcement-body-${Date.now()}-${Math.random()}`;
    const limiter = createRateLimit({ scope, maxAttempts: 1, windowMs: 30_000 });
    const req = makeReq('/api/login', '10.0.2.1');

    await limiter(req, makeRes(), vi.fn()); // first request passes
    const res = makeRes();
    await limiter(req, res, vi.fn());
    expect(res.statusCode).toBe(429);
    expect(res.body.error).toContain('Too many attempts');
    expect(typeof res.body.retryAfter).toBe('number');
    expect(res.body.retryAfter).toBeGreaterThanOrEqual(1);
  });

  it('sets Retry-After header when blocked', async () => {
    const scope = `enforcement-header-${Date.now()}-${Math.random()}`;
    const limiter = createRateLimit({ scope, maxAttempts: 1, windowMs: 60_000 });
    const req = makeReq('/api/church/login', '10.0.3.1');

    await limiter(req, makeRes(), vi.fn());
    const res = makeRes();
    await limiter(req, res, vi.fn());
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBeDefined();
    const retryAfter = Number(res.headers['Retry-After']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });
});

// ─── Independent buckets per identifier ──────────────────────────────────────

describe('Rate limit enforcement — independent buckets per IP', () => {
  it('different IPs have independent rate limit counters', async () => {
    const scope = `enforcement-ip-isolation-${Date.now()}-${Math.random()}`;
    const limiter = createRateLimit({ scope, maxAttempts: 2, windowMs: 60_000 });
    const reqA = makeReq('/api/login', '192.168.1.1');
    const reqB = makeReq('/api/login', '192.168.1.2');

    // Exhaust limit for IP A
    await limiter(reqA, makeRes(), vi.fn());
    await limiter(reqA, makeRes(), vi.fn());
    const nextA3 = vi.fn();
    const resA3 = makeRes();
    await limiter(reqA, resA3, nextA3);
    expect(nextA3).not.toHaveBeenCalled();
    expect(resA3.statusCode).toBe(429);

    // IP B should still be allowed
    const nextB = vi.fn();
    const resB = makeRes();
    await limiter(reqB, resB, nextB);
    expect(nextB).toHaveBeenCalledTimes(1);
    expect(resB.statusCode).toBeNull();
  });

  it('different scopes have independent counters for the same IP', async () => {
    const ts = `${Date.now()}-${Math.random()}`;
    const limiterA = createRateLimit({ scope: `scope-a-${ts}`, maxAttempts: 2, windowMs: 60_000 });
    const limiterB = createRateLimit({ scope: `scope-b-${ts}`, maxAttempts: 2, windowMs: 60_000 });
    const req = makeReq('/api/login', '10.100.0.1');

    // Exhaust scope A
    await limiterA(req, makeRes(), vi.fn());
    await limiterA(req, makeRes(), vi.fn());
    const resA3 = makeRes();
    const nextA3 = vi.fn();
    await limiterA(req, resA3, nextA3);
    expect(nextA3).not.toHaveBeenCalled();
    expect(resA3.statusCode).toBe(429);

    // Scope B is independent — should still allow requests
    const nextB = vi.fn();
    const resB = makeRes();
    await limiterB(req, resB, nextB);
    expect(nextB).toHaveBeenCalledTimes(1);
    expect(resB.statusCode).toBeNull();
  });

  it('different paths have independent counters (using default keyGenerator)', async () => {
    const scope = `enforcement-path-${Date.now()}-${Math.random()}`;
    const limiter = createRateLimit({ scope, maxAttempts: 1, windowMs: 60_000 });
    const ip = '10.200.0.1';
    const reqLogin = makeReq('/api/login', ip);
    const reqChat = makeReq('/api/chat', ip);

    // Exhaust limit on /api/login
    await limiter(reqLogin, makeRes(), vi.fn());
    const resLogin2 = makeRes();
    const nextLogin2 = vi.fn();
    await limiter(reqLogin, resLogin2, nextLogin2);
    expect(nextLogin2).not.toHaveBeenCalled();
    expect(resLogin2.statusCode).toBe(429);

    // /api/chat should be unaffected
    const nextChat = vi.fn();
    const resChat = makeRes();
    await limiter(reqChat, resChat, nextChat);
    expect(nextChat).toHaveBeenCalledTimes(1);
    expect(resChat.statusCode).toBeNull();
  });
});

// ─── consumeRateLimit — metadata accuracy ─────────────────────────────────────

describe('consumeRateLimit — metadata returned by the function', () => {
  it('first call returns count=1, limited=false, remaining=maxAttempts-1', async () => {
    const scope = `meta-first-${Date.now()}-${Math.random()}`;
    const state = await consumeRateLimit({ scope, key: 'user-1', maxAttempts: 5, windowMs: 60_000 });
    expect(state.count).toBe(1);
    expect(state.limited).toBe(false);
    expect(state.remaining).toBe(4);
    expect(state.store).toBe('memory');
  });

  it('remaining decrements on each call', async () => {
    const scope = `meta-decr-${Date.now()}-${Math.random()}`;
    const key = 'user-decr';
    const s1 = await consumeRateLimit({ scope, key, maxAttempts: 3, windowMs: 60_000 });
    const s2 = await consumeRateLimit({ scope, key, maxAttempts: 3, windowMs: 60_000 });
    const s3 = await consumeRateLimit({ scope, key, maxAttempts: 3, windowMs: 60_000 });
    expect(s1.remaining).toBe(2);
    expect(s2.remaining).toBe(1);
    expect(s3.remaining).toBe(0);
    expect(s3.limited).toBe(false); // exactly at limit, not over
  });

  it('limited=true when count exceeds maxAttempts', async () => {
    const scope = `meta-over-${Date.now()}-${Math.random()}`;
    const key = 'user-over';
    await consumeRateLimit({ scope, key, maxAttempts: 2, windowMs: 60_000 });
    await consumeRateLimit({ scope, key, maxAttempts: 2, windowMs: 60_000 });
    const over = await consumeRateLimit({ scope, key, maxAttempts: 2, windowMs: 60_000 });
    expect(over.limited).toBe(true);
    expect(over.count).toBe(3);
    expect(over.remaining).toBe(0);
  });

  it('scopedKey is composed of scope and key', async () => {
    const scope = 'test-scoped-key';
    const key = 'my-identifier';
    const state = await consumeRateLimit({ scope, key, maxAttempts: 10, windowMs: 60_000 });
    expect(state.scopedKey).toBe(`${scope}:${key}`);
  });

  it('retryAfterSec is at least 1 second', async () => {
    const scope = `meta-retry-${Date.now()}-${Math.random()}`;
    const key = 'user-retry';
    await consumeRateLimit({ scope, key, maxAttempts: 1, windowMs: 60_000 });
    const blocked = await consumeRateLimit({ scope, key, maxAttempts: 1, windowMs: 60_000 });
    expect(blocked.limited).toBe(true);
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it('different keys under the same scope are independent', async () => {
    const scope = `key-iso-${Date.now()}-${Math.random()}`;
    await consumeRateLimit({ scope, key: 'key-alpha', maxAttempts: 1, windowMs: 60_000 });
    const blocked = await consumeRateLimit({ scope, key: 'key-alpha', maxAttempts: 1, windowMs: 60_000 });
    expect(blocked.limited).toBe(true);

    // key-beta is fresh
    const fresh = await consumeRateLimit({ scope, key: 'key-beta', maxAttempts: 1, windowMs: 60_000 });
    expect(fresh.limited).toBe(false);
    expect(fresh.count).toBe(1);
  });
});

// ─── Window reset after expiry ─────────────────────────────────────────────────

describe('Rate limit enforcement — window reset', () => {
  it('resets the counter after the window expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T10:00:00.000Z'));
    const scope = `reset-test-${Date.now()}-${Math.random()}`;
    const key = 'user-reset';

    await consumeRateLimit({ scope, key, maxAttempts: 2, windowMs: 1_000 });
    await consumeRateLimit({ scope, key, maxAttempts: 2, windowMs: 1_000 });
    const blocked = await consumeRateLimit({ scope, key, maxAttempts: 2, windowMs: 1_000 });
    expect(blocked.limited).toBe(true);

    // Advance past the window
    vi.setSystemTime(new Date('2026-03-01T10:00:01.500Z'));

    const fresh = await consumeRateLimit({ scope, key, maxAttempts: 2, windowMs: 1_000 });
    expect(fresh.limited).toBe(false);
    expect(fresh.count).toBe(1);
  });

  it('createRateLimit middleware resets after window expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T11:00:00.000Z'));
    const scope = `mw-reset-${Date.now()}-${Math.random()}`;
    const limiter = createRateLimit({ scope, maxAttempts: 1, windowMs: 500 });
    const req = makeReq('/api/test', '10.50.0.1');

    // First request passes
    const next1 = vi.fn();
    await limiter(req, makeRes(), next1);
    expect(next1).toHaveBeenCalledTimes(1);

    // Second request is blocked
    const res2 = makeRes();
    const next2 = vi.fn();
    await limiter(req, res2, next2);
    expect(next2).not.toHaveBeenCalled();
    expect(res2.statusCode).toBe(429);

    // Advance past the window
    vi.setSystemTime(new Date('2026-03-01T11:00:01.000Z'));

    // Third request should now pass
    const next3 = vi.fn();
    const res3 = makeRes();
    await limiter(req, res3, next3);
    expect(next3).toHaveBeenCalledTimes(1);
    expect(res3.statusCode).toBeNull();
  });
});

// ─── Custom keyGenerator ───────────────────────────────────────────────────────

describe('createRateLimit — custom keyGenerator', () => {
  it('uses the custom key from keyGenerator, isolating by that key', async () => {
    const scope = `custom-key-${Date.now()}-${Math.random()}`;
    // keyGenerator returns the body.email — rate limit by email, not IP
    const limiter = createRateLimit({
      scope,
      maxAttempts: 2,
      windowMs: 60_000,
      keyGenerator: (req) => req.body?.email || 'unknown',
    });

    const makeEmailReq = (email, ip) => ({
      path: '/api/login',
      ip,
      headers: {},
      socket: { remoteAddress: ip },
      body: { email },
    });

    const reqAlice = makeEmailReq('alice@test.com', '1.1.1.1');
    const reqBob   = makeEmailReq('bob@test.com',   '1.1.1.1'); // same IP, different email

    // Exhaust Alice's limit
    await limiter(reqAlice, makeRes(), vi.fn());
    await limiter(reqAlice, makeRes(), vi.fn());
    const nextAlice3 = vi.fn();
    const resAlice3 = makeRes();
    await limiter(reqAlice, resAlice3, nextAlice3);
    expect(nextAlice3).not.toHaveBeenCalled();
    expect(resAlice3.statusCode).toBe(429);

    // Bob has the same IP but different email — should still pass
    const nextBob = vi.fn();
    const resBob = makeRes();
    await limiter(reqBob, resBob, nextBob);
    expect(nextBob).toHaveBeenCalledTimes(1);
    expect(resBob.statusCode).toBeNull();
  });
});
