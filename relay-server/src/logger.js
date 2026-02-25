'use strict';

/**
 * Lightweight structured logger for Tally Relay Server
 *
 * Features:
 *   - Log levels: debug, info, warn, error
 *   - ISO timestamp prefix on every message
 *   - Named logger contexts via createLogger('billing')
 *   - JSON output in production (NODE_ENV=production), human-readable in dev
 *   - Configurable minimum level via LOG_LEVEL env var (default: 'info')
 *
 * Usage:
 *   const { logger, createLogger } = require('./logger');
 *   logger.info('Server started');                // default logger (no context)
 *   const log = createLogger('billing');
 *   log.info('Checkout complete');                // [2025-01-15T12:00:00.000Z] [INFO] [billing] Checkout complete
 *   log.error('Webhook failed', err.message);     // also works with multiple args
 */

const LOG_LEVELS = {
  debug: 0,
  info:  1,
  warn:  2,
  error: 3,
};

const LEVEL_LABELS = {
  debug: 'DEBUG',
  info:  'INFO',
  warn:  'WARN',
  error: 'ERROR',
};

function resolveMinLevel() {
  const env = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return LOG_LEVELS[env] !== undefined ? LOG_LEVELS[env] : LOG_LEVELS.info;
}

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

/**
 * Format arguments into a single message string.
 * Handles a mix of strings, numbers, objects, and Error instances.
 */
function formatArgs(args) {
  return args.map(a => {
    if (a === null || a === undefined) return String(a);
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object') {
      try { return JSON.stringify(a); } catch { return String(a); }
    }
    return String(a);
  }).join(' ');
}

/**
 * Create a logger bound to an optional context name.
 *
 * @param {string} [context] - e.g. 'billing', 'ws', 'sse'
 * @returns {{ debug, info, warn, error }}
 */
function createLogger(context) {
  const minLevel = resolveMinLevel();
  const prod = isProduction();

  function emit(level, args) {
    if (LOG_LEVELS[level] < minLevel) return;

    const timestamp = new Date().toISOString();
    const label = LEVEL_LABELS[level];
    const message = formatArgs(args);

    if (prod) {
      // JSON structured output
      const entry = { timestamp, level: label, message };
      if (context) entry.context = context;
      const consoleFn = level === 'error' ? console.error
        : level === 'warn' ? console.warn
        : console.log;
      consoleFn(JSON.stringify(entry));
    } else {
      // Human-readable output
      const parts = [`[${timestamp}]`, `[${label}]`];
      if (context) parts.push(`[${context}]`);
      parts.push(message);
      const line = parts.join(' ');
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    }
  }

  return {
    debug: (...args) => emit('debug', args),
    info:  (...args) => emit('info',  args),
    warn:  (...args) => emit('warn',  args),
    error: (...args) => emit('error', args),
  };
}

// Default logger (no context)
const logger = createLogger();

module.exports = { logger, createLogger };
