const LOCAL_RATE_LIMIT_STORE = new Map();
const LOCAL_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const LOCAL_STALE_WINDOW_MS = 15 * 60 * 1000;
let cleanupTimerStarted = false;
let redisWarned = false;

function startLocalCleanup() {
  if (cleanupTimerStarted) return;
  cleanupTimerStarted = true;
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of LOCAL_RATE_LIMIT_STORE.entries()) {
      const windowMs = Number(entry.windowMs || LOCAL_STALE_WINDOW_MS);
      if (!entry.windowStart || now - entry.windowStart > Math.max(windowMs, LOCAL_STALE_WINDOW_MS)) {
        LOCAL_RATE_LIMIT_STORE.delete(key);
      }
    }
  }, LOCAL_CLEANUP_INTERVAL_MS).unref();
}

function resolveClientIp(req) {
  // Use req.ip which respects Express trust proxy setting.
  // Falls back to socket address if req.ip is unavailable.
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function hasRedisRateLimitConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return !!(url && token);
}

function getRedisRateLimitConfig() {
  return {
    url: (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/+$/, ''),
    token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '',
    prefix: process.env.RATE_LIMIT_KEY_PREFIX || 'tally:rl',
  };
}

async function callRedisCommand(command, args = [], timeoutMs = 2500) {
  const cfg = getRedisRateLimitConfig();
  if (!cfg.url || !cfg.token) throw new Error('redis-config-missing');
  const encodedArgs = args.map((arg) => encodeURIComponent(String(arg)));
  const endpoint = `${cfg.url}/${command}/${encodedArgs.join('/')}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: controller.signal,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`redis-http-${resp.status}${body ? `: ${body.slice(0, 120)}` : ''}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

async function incrementWithRedis(scopedKey, windowMs) {
  const cfg = getRedisRateLimitConfig();
  const redisKey = `${cfg.prefix}:${scopedKey}`;
  const incrResp = await callRedisCommand('incr', [redisKey]);
  const count = Number(incrResp?.result);
  if (!Number.isFinite(count)) throw new Error('redis-incr-invalid');

  if (count === 1) {
    await callRedisCommand('pexpire', [redisKey, windowMs]);
  }

  const ttlResp = await callRedisCommand('pttl', [redisKey]);
  let ttlMs = Number(ttlResp?.result);
  if (!Number.isFinite(ttlMs) || ttlMs < 0) ttlMs = windowMs;

  return {
    count,
    retryAfterSec: Math.max(1, Math.ceil(ttlMs / 1000)),
    store: 'redis',
  };
}

function incrementWithLocalStore(scopedKey, windowMs) {
  startLocalCleanup();
  const now = Date.now();
  let entry = LOCAL_RATE_LIMIT_STORE.get(scopedKey);
  if (!entry || now - entry.windowStart > windowMs) {
    entry = { windowStart: now, count: 0, windowMs };
    LOCAL_RATE_LIMIT_STORE.set(scopedKey, entry);
  }
  entry.count++;
  const retryAfterSec = Math.max(1, Math.ceil((entry.windowStart + windowMs - now) / 1000));
  return {
    count: entry.count,
    retryAfterSec,
    store: 'memory',
  };
}

async function consumeRateLimit({
  scope = 'default',
  key = 'unknown',
  maxAttempts = 10,
  windowMs = 15 * 60 * 1000,
} = {}) {
  const scopedKey = `${scope}:${String(key || 'unknown')}`;

  let state;
  if (hasRedisRateLimitConfig()) {
    try {
      state = await incrementWithRedis(scopedKey, windowMs);
    } catch (error) {
      if (!redisWarned) {
        redisWarned = true;
        console.warn(`[rateLimit] Redis backend unavailable, falling back to memory: ${error.message}`);
      }
    }
  }

  if (!state) {
    state = incrementWithLocalStore(scopedKey, windowMs);
  }

  return {
    ...state,
    scopedKey,
    maxAttempts,
    remaining: Math.max(0, maxAttempts - state.count),
    limited: state.count > maxAttempts,
  };
}

function createRateLimit({
  scope = 'default',
  maxAttempts = 10,
  windowMs = 15 * 60 * 1000,
  keyGenerator = null,
  onLimit = null,
} = {}) {
  return async (req, res, next) => {
    const ip = resolveClientIp(req);
    const defaultKey = `${req.path || 'path'}:${ip}`;
    const key = (typeof keyGenerator === 'function' ? keyGenerator(req, ip) : defaultKey) || defaultKey;
    const state = await consumeRateLimit({ scope, key, maxAttempts, windowMs });

    if (state.limited) {
      res.set('Retry-After', String(state.retryAfterSec));
      if (typeof onLimit === 'function') {
        return onLimit(req, res, state.retryAfterSec, state);
      }
      return res.status(429).json({
        error: 'Too many attempts. Please try again later.',
        retryAfter: state.retryAfterSec,
      });
    }

    return next();
  };
}

/**
 * Log production guardrail warning if Redis is not configured.
 * Called once at startup from server.js.
 */
function logRateLimitStatus() {
  const isProduction = process.env.NODE_ENV === 'production';
  if (hasRedisRateLimitConfig()) {
    console.log('[rateLimit] ✓ Redis/Upstash backend configured');
  } else if (isProduction) {
    console.warn('[rateLimit] ⚠️  PRODUCTION: No Redis/Upstash configured — rate limits use in-memory store (not distributed). Set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN for multi-instance safety.');
  } else {
    console.log('[rateLimit] Using in-memory store (dev mode — no Redis configured)');
  }
}

module.exports = {
  consumeRateLimit,
  createRateLimit,
  resolveClientIp,
  logRateLimitStatus,
};
