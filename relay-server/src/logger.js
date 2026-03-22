'use strict';

/**
 * Structured logger for Tally Relay Server.
 *
 * When LOG_FORMAT=json, every log line is a single JSON object with:
 *   { ts, level, scope, msg, ...contextFields }
 *
 * Railway captures stdout/stderr and indexes these lines so they're
 * searchable by churchId, deviceType, action, etc.
 *
 * Without LOG_FORMAT=json (local dev), output stays human-readable:
 *   [ScheduleEngine] poll error { error: 'SQLITE_BUSY' }
 *
 * Usage:
 *   const { createLogger } = require('./logger');
 *   const log = createLogger('ScheduleEngine');
 *   log.error('poll error', { churchId: 'abc', error: e.message });
 *   log.info('window opened', { churchId, action: 'window_open' });
 *
 *   // Scoped child logger
 *   const child = log.child('billing');
 *   child.warn('payment failed', { churchId, stripeError: '...' });
 */

const LOG_JSON = process.env.LOG_FORMAT === 'json';

function createLogger(scope = 'app') {
  const scopeStr = String(scope || 'app');
  const prefix = `[${scopeStr}]`;

  function write(level, consoleMethod, args) {
    if (LOG_JSON) {
      // args signature: (msg: string, ctx?: object) OR (...parts)
      const [first, ...rest] = args;
      const msg = typeof first === 'string' ? first : JSON.stringify(first);
      // If second arg is a plain object, treat it as structured context metadata
      const ctx =
        rest.length === 1 &&
        rest[0] !== null &&
        typeof rest[0] === 'object' &&
        !Array.isArray(rest[0])
          ? rest[0]
          : {};
      const entry = { ts: new Date().toISOString(), level, scope: scopeStr, msg, ...ctx };
      (console[consoleMethod] || console.log)(JSON.stringify(entry));
    } else {
      const fn = console[consoleMethod] || console.log;
      fn(prefix, ...args);
    }
  }

  return {
    info:  (...args) => write('info',  'log',   args),
    warn:  (...args) => write('warn',  'warn',  args),
    error: (...args) => write('error', 'error', args),
    debug: (...args) => write('debug', 'debug', args),
    child: (childScope) => createLogger(`${scopeStr}:${childScope}`),
  };
}

module.exports = { createLogger };
