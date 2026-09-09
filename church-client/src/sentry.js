'use strict';

/**
 * Booth crash reporting for the church-client agent.
 *
 * Init is a no-op when ELECTRON_SENTRY_DSN / SENTRY_DSN are unset, so local
 * CLI and tests still work. Never log the DSN. Do not reuse the relay's
 * Railway SENTRY_DSN — that project is tally-relay, not tally-booth.
 */

const SENSITIVE_KEY = /^(authorization|cookie|set-cookie|x-api-key|api[-_]?key|token|access[-_]?token|refresh[-_]?token|password|secret|jwt|webhook(?:[-_]?url)?|bot[-_]?token)$/i;
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._\-+=/]+/gi;
const TELEGRAM_BOT_RE = /https?:\/\/api\.telegram\.org\/bot[^\s"'\\]+/gi;
const SLACK_HOOK_RE = /https?:\/\/hooks\.slack\.com\/services\/[^\s"'\\]+/gi;
const QUERY_SECRET_RE = /([?&](?:token|jwt|key|api_key|apikey|secret|password|auth)=)[^&\s"']+/gi;

let _enabled = false;
let _sentry = null;

function isUsableDsn(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed.startsWith('https://')) return false;
  if (/placeholder/i.test(trimmed)) return false;
  return /ingest\./i.test(trimmed);
}

function resolveSentryDsn(env = process.env) {
  const candidates = [env && env.ELECTRON_SENTRY_DSN, env && env.SENTRY_DSN];
  for (const raw of candidates) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (isUsableDsn(value)) return value;
  }
  return '';
}

function scrubString(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(JWT_RE, '[Filtered]')
    .replace(BEARER_RE, 'Bearer [Filtered]')
    .replace(TELEGRAM_BOT_RE, '[Filtered webhook]')
    .replace(SLACK_HOOK_RE, '[Filtered webhook]')
    .replace(QUERY_SECRET_RE, '$1[Filtered]');
}

function scrubValue(value, key) {
  if (key && SENSITIVE_KEY.test(key)) return '[Filtered]';
  if (typeof value === 'string') return scrubString(value);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = scrubValue(v, k);
  }
  return out;
}

function beforeSend(event) {
  if (!event || typeof event !== 'object') return event;
  if (event.request) {
    event.request = scrubValue(event.request);
    if (event.request.headers) {
      delete event.request.headers.authorization;
      delete event.request.headers.cookie;
      delete event.request.headers.Authorization;
      delete event.request.headers.Cookie;
    }
  }
  if (event.extra) event.extra = scrubValue(event.extra);
  if (event.contexts) event.contexts = scrubValue(event.contexts);
  if (event.user) {
    event.user = { id: event.user.id || undefined };
  }
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.map((crumb) => scrubValue(crumb));
  }
  if (event.exception && Array.isArray(event.exception.values)) {
    event.exception.values = event.exception.values.map((item) => {
      if (!item || typeof item !== 'object') return item;
      return { ...item, value: scrubString(item.value) };
    });
  }
  if (event.message) event.message = scrubString(event.message);
  return event;
}

function initBoothSentry(options = {}) {
  if (_enabled) return { enabled: true, already: true };

  const env = options.env || process.env;
  const dsn = resolveSentryDsn(env);
  if (!dsn) return { enabled: false };

  let Sentry = options.sentryModule;
  if (!Sentry) {
    try {
      Sentry = require('@sentry/node');
    } catch (err) {
      console.warn('[sentry] @sentry/node unavailable:', err && err.message);
      return { enabled: false };
    }
  }

  try {
    const release = options.release ? `tally-booth@${options.release}` : undefined;
    Sentry.init({
      dsn,
      environment: options.environment || env.SENTRY_ENVIRONMENT || env.NODE_ENV || 'production',
      release,
      sendDefaultPii: false,
      tracesSampleRate: 0,
      maxBreadcrumbs: 15,
      beforeSend,
      initialScope: {
        tags: { tally_process: options.processName || 'church-client' },
      },
    });
    _sentry = Sentry;
    _enabled = true;
    return { enabled: true };
  } catch (err) {
    console.warn('[sentry] init failed:', err && err.message);
    return { enabled: false };
  }
}

function isSentryEnabled() {
  return _enabled;
}

function captureBoothException(error, context = {}) {
  if (!_enabled || !_sentry) return false;
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    _sentry.withScope((scope) => {
      if (context.tags && typeof context.tags === 'object') {
        for (const [k, v] of Object.entries(context.tags)) scope.setTag(k, String(v));
      }
      if (context.extra && typeof context.extra === 'object') {
        for (const [k, v] of Object.entries(context.extra)) scope.setExtra(k, v);
      }
      _sentry.captureException(err);
    });
    return true;
  } catch {
    return false;
  }
}

async function flushBoothSentry(timeoutMs = 2000) {
  if (!_enabled || !_sentry || typeof _sentry.flush !== 'function') return false;
  try {
    await _sentry.flush(timeoutMs);
    return true;
  } catch {
    return false;
  }
}

function _resetForTests() {
  _enabled = false;
  _sentry = null;
}

module.exports = {
  isUsableDsn,
  resolveSentryDsn,
  scrubString,
  scrubValue,
  beforeSend,
  initBoothSentry,
  isSentryEnabled,
  captureBoothException,
  flushBoothSentry,
  _resetForTests,
};
