'use strict';

/**
 * Structured log shipper for the church-client agent.
 *
 * Buffers log entries locally and ships them to the relay over the existing
 * agent WebSocket as `agent_log` messages so the developer can diagnose
 * remotely without asking the church to send local files.
 *
 * Flush triggers (whichever fires first):
 *   - `intervalMs` (default 5s)
 *   - buffer reaches `batchSize` (default 20)
 *
 * If the WebSocket is not currently open, entries are buffered up to
 * `maxBuffer` (default 200) and the oldest entries are dropped to keep memory
 * bounded. The next successful `flush()` after reconnect drains them.
 *
 * Levels shipped: `warn`, `error`, and the curated `info` events listed in
 * INFO_KEYWORDS (bridge connect/disconnect, command sent/received, device
 * online/offline). Debug-level noise is dropped on the floor.
 *
 * Each entry strips fields whose key matches `/token|password|secret|key/i`
 * so credentials are never persisted server-side.
 */

const SECRET_KEY_PATTERN = /token|password|secret|key/i;

// Curated set of `info` events that are operationally interesting enough to
// ship. Anything else at info level is dropped to keep the relay table small.
// Matched with `String#includes` (case-insensitive) against the message.
const INFO_KEYWORDS = [
  'connected',
  'disconnected',
  'reconnect',
  'online',
  'offline',
  'online ',
  'offline ',
  'command received',
  'command sent',
  'bridge',
  'rejected',
];

function redactSecrets(value, depth = 0) {
  if (value == null) return value;
  if (depth > 4) return '[truncated]';
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redactSecrets(v, depth + 1);
    }
  }
  return out;
}

function summarizeError(err) {
  if (!err) return null;
  if (err instanceof Error) {
    return {
      name: err.name || 'Error',
      message: err.message || String(err),
      stack: typeof err.stack === 'string' ? err.stack.split('\n').slice(0, 8).join('\n') : null,
    };
  }
  if (typeof err === 'object') return redactSecrets(err);
  return { message: String(err) };
}

function shouldShipInfoMessage(message) {
  const m = String(message || '').toLowerCase();
  return INFO_KEYWORDS.some((kw) => m.includes(kw));
}

/**
 * Create a log shipper bound to an agent.
 *
 * @param {object} opts
 * @param {() => any}   opts.getRelay        Returns the current relay WebSocket (or null).
 * @param {number}      opts.wsOpenState     The library's "OPEN" readyState constant.
 * @param {string}      opts.churchId        Church ID for tagging.
 * @param {() => string|null} opts.getRoomId Resolved at flush time so config changes are picked up.
 * @param {string}      opts.deviceType      e.g. 'church-client'.
 * @param {string}      opts.deviceId        e.g. hostname or instance name.
 * @param {number}     [opts.intervalMs=5000]
 * @param {number}     [opts.batchSize=20]
 * @param {number}     [opts.maxBuffer=200]
 */
function createLogShipper(opts) {
  const {
    getRelay,
    wsOpenState,
    churchId,
    getRoomId,
    deviceType = 'church-client',
    deviceId = '',
    intervalMs = 5000,
    batchSize = 20,
    maxBuffer = 200,
  } = opts;

  if (typeof getRelay !== 'function') {
    throw new Error('logShipper: getRelay must be a function');
  }

  const buffer = [];
  let flushTimer = null;
  let stopped = false;
  let reentrant = false; // guard against logging from within the shipper itself

  function isOpen() {
    const ws = getRelay();
    return !!ws && ws.readyState === wsOpenState;
  }

  function enqueue(level, message, extra) {
    if (stopped) return;
    if (reentrant) return;

    // Drop debug entirely
    if (level === 'debug') return;
    // For info level, only ship curated keywords
    if (level === 'info' && !shouldShipInfoMessage(message)) return;

    const entry = {
      level,
      message: String(message ?? ''),
      ts: new Date().toISOString(),
      churchId,
      roomId: typeof getRoomId === 'function' ? (getRoomId() || null) : null,
      deviceType,
      deviceId,
    };
    if (extra && typeof extra === 'object') {
      const redacted = redactSecrets(extra);
      // If caller passed an Error under .error, normalize it.
      if (redacted.error) entry.error = summarizeError(redacted.error);
      // Drop the noisy keys onto the entry sparingly — keep the payload small
      const ctx = { ...redacted };
      delete ctx.error;
      if (Object.keys(ctx).length > 0) entry.context = ctx;
    } else if (extra instanceof Error) {
      entry.error = summarizeError(extra);
    }

    buffer.push(entry);
    if (buffer.length > maxBuffer) {
      // Drop oldest first to keep most-recent context
      buffer.splice(0, buffer.length - maxBuffer);
    }

    if (buffer.length >= batchSize) {
      // Flush on next microtask so we don't block the caller
      Promise.resolve().then(flush).catch(() => {});
    }
  }

  function flush() {
    if (stopped) return;
    if (buffer.length === 0) return;
    if (!isOpen()) return; // try again on next tick / reconnect

    const ws = getRelay();
    // Drain in chunks of batchSize so a giant backlog doesn't ship as one frame
    while (buffer.length > 0) {
      const chunk = buffer.splice(0, batchSize);
      reentrant = true;
      try {
        ws.send(JSON.stringify({ type: 'agent_log', entries: chunk }));
      } catch {
        // Send failed — re-buffer the chunk at the front and stop draining
        buffer.unshift(...chunk);
        reentrant = false;
        return;
      } finally {
        reentrant = false;
      }
    }
  }

  function start() {
    if (flushTimer) return;
    flushTimer = setInterval(flush, intervalMs);
    if (typeof flushTimer.unref === 'function') flushTimer.unref();
  }

  function stop() {
    stopped = true;
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    buffer.length = 0;
  }

  return {
    info: (msg, extra) => enqueue('info', msg, extra),
    warn: (msg, extra) => enqueue('warn', msg, extra),
    error: (msg, extra) => enqueue('error', msg, extra),
    flush,
    start,
    stop,
    /** Test-only — read current buffer length. */
    _bufferSize: () => buffer.length,
  };
}

/**
 * Wrap the global `console.warn` and `console.error` so that all existing
 * `console.warn(...)`/`console.error(...)` callsites in the agent automatically
 * ship without us having to touch every call. Returns a teardown function.
 *
 * `console.log` is also tapped (level=info) but only entries that match
 * INFO_KEYWORDS will actually be shipped.
 */
function attachConsoleTap(shipper) {
  const orig = {
    log:   console.log.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
  };

  function stringify(args) {
    return args.map((a) => {
      if (a == null) return String(a);
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.message || a.stack || 'Error';
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
  }

  console.log = (...args) => {
    orig.log(...args);
    try { shipper.info(stringify(args)); } catch { /* shipper itself must never throw */ }
  };
  console.warn = (...args) => {
    orig.warn(...args);
    try { shipper.warn(stringify(args)); } catch { /* ignore */ }
  };
  console.error = (...args) => {
    orig.error(...args);
    // Try to find an Error in the args and surface it as structured `error`.
    const err = args.find((a) => a instanceof Error);
    try { shipper.error(stringify(args), err ? { error: err } : undefined); } catch { /* ignore */ }
  };

  return function detach() {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  };
}

module.exports = {
  createLogShipper,
  attachConsoleTap,
  // exported for tests
  redactSecrets,
  shouldShipInfoMessage,
  INFO_KEYWORDS,
};
