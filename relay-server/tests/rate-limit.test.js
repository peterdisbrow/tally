import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import rateLimitModule from '../src/rateLimit.js';

const { createRateLimit } = rateLimitModule;

function makeReq(path = '/test', ip = '203.0.113.10') {
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

describe('createRateLimit', () => {
  beforeEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    delete process.env.RATE_LIMIT_KEY_PREFIX;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests under the limit and blocks when exceeded', async () => {
    const scope = `test-under-over-${Date.now()}`;
    const limiter = createRateLimit({ scope, maxAttempts: 2, windowMs: 5_000 });
    const req = makeReq('/api/admin/login');

    const next1 = vi.fn();
    const res1 = makeRes();
    await limiter(req, res1, next1);
    expect(next1).toHaveBeenCalledTimes(1);
    expect(res1.statusCode).toBeNull();

    const next2 = vi.fn();
    const res2 = makeRes();
    await limiter(req, res2, next2);
    expect(next2).toHaveBeenCalledTimes(1);
    expect(res2.statusCode).toBeNull();

    const next3 = vi.fn();
    const res3 = makeRes();
    await limiter(req, res3, next3);
    expect(next3).not.toHaveBeenCalled();
    expect(res3.statusCode).toBe(429);
    expect(res3.headers['Retry-After']).toBeDefined();
    expect(res3.body?.error).toContain('Too many attempts');
  });

  it('resets after the rate-limit window expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-24T00:00:00.000Z'));

    const scope = 'test-window-reset';
    const limiter = createRateLimit({ scope, maxAttempts: 1, windowMs: 1_000 });
    const req = makeReq('/api/church/app/login', '198.51.100.77');

    const next1 = vi.fn();
    const res1 = makeRes();
    await limiter(req, res1, next1);
    expect(next1).toHaveBeenCalledTimes(1);

    const next2 = vi.fn();
    const res2 = makeRes();
    await limiter(req, res2, next2);
    expect(next2).not.toHaveBeenCalled();
    expect(res2.statusCode).toBe(429);

    vi.setSystemTime(new Date('2026-02-24T00:00:01.200Z'));

    const next3 = vi.fn();
    const res3 = makeRes();
    await limiter(req, res3, next3);
    expect(next3).toHaveBeenCalledTimes(1);
    expect(res3.statusCode).toBeNull();
  });

  it('supports custom onLimit handlers (HTML path behavior)', async () => {
    const scope = `test-html-${Date.now()}`;
    const limiter = createRateLimit({
      scope,
      maxAttempts: 1,
      windowMs: 60_000,
      onLimit: (_req, res) => res.status(429).send('<html>blocked</html>'),
    });
    const req = makeReq('/church-login', '192.0.2.12');

    const next1 = vi.fn();
    await limiter(req, makeRes(), next1);
    expect(next1).toHaveBeenCalledTimes(1);

    const next2 = vi.fn();
    const res2 = makeRes();
    await limiter(req, res2, next2);
    expect(next2).not.toHaveBeenCalled();
    expect(res2.statusCode).toBe(429);
    expect(res2.body).toContain('blocked');
  });

  it('falls back to x-forwarded-for when req.ip is missing', async () => {
    const scope = `test-forwarded-${Date.now()}`;
    const limiter = createRateLimit({ scope, maxAttempts: 1, windowMs: 30_000 });
    const req = {
      path: '/api/admin/login',
      ip: '',
      headers: { 'x-forwarded-for': '198.51.100.1, 10.0.0.2' },
      socket: { remoteAddress: '10.0.0.2' },
    };

    const next1 = vi.fn();
    await limiter(req, makeRes(), next1);
    expect(next1).toHaveBeenCalledTimes(1);

    const next2 = vi.fn();
    const res2 = makeRes();
    await limiter(req, res2, next2);
    expect(next2).not.toHaveBeenCalled();
    expect(res2.statusCode).toBe(429);
  });
});
