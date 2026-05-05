/**
 * Relay health monitor.
 *
 * Polls the relay's /health endpoint on a fixed interval and emits
 * debounced online/offline transitions. The agent's WebSocket gives us
 * one signal, but it's tied to the WS lifecycle; this is an independent
 * HTTP probe so the desktop app can flip into local-fallback mode the
 * moment the relay goes dark — even if the WS is still in a stale
 * connecting/reconnecting state.
 *
 * Debounce rules:
 *   - Flip to OFFLINE only after `failureThreshold` consecutive HTTP
 *     failures (default 3 → ~30s at 10s interval).
 *   - Flip to ONLINE on the first successful response.
 *
 * The factory returns a controller; the caller is responsible for
 * forwarding state changes to the rest of the app (e.g. via IPC).
 */

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_FAILURE_THRESHOLD = 3;

/**
 * @param {object} opts
 * @param {() => string} opts.getRelayUrl  Callback that returns the current relay URL (ws/wss/http/https).
 * @param {(state: {online: boolean, lastSeen: Date|null, consecutiveFailures: number}) => void} opts.onChange
 *        Called only when the debounced online/offline state flips.
 * @param {(state: {online: boolean, lastSeen: Date|null, consecutiveFailures: number}) => void} [opts.onPoll]
 *        Called on every poll, regardless of state change. Useful for telemetry.
 * @param {number} [opts.intervalMs=10000]
 * @param {number} [opts.timeoutMs=5000]
 * @param {number} [opts.failureThreshold=3]
 * @param {(url: string, opts: {timeoutMs: number}) => Promise<{ok: boolean, status: number}>} [opts.fetchHealth]
 *        Override the HTTP probe (used in tests).
 */
function createRelayHealthMonitor({
  getRelayUrl,
  onChange,
  onPoll,
  intervalMs = DEFAULT_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  failureThreshold = DEFAULT_FAILURE_THRESHOLD,
  fetchHealth = defaultFetchHealth,
}) {
  if (typeof getRelayUrl !== 'function') {
    throw new TypeError('createRelayHealthMonitor: getRelayUrl must be a function');
  }
  if (typeof onChange !== 'function') {
    throw new TypeError('createRelayHealthMonitor: onChange must be a function');
  }

  const state = {
    online: true,           // optimistic — flips to false after threshold misses
    lastSeen: null,         // Date of last successful probe
    consecutiveFailures: 0,
    started: false,
  };

  let timer = null;
  let pollInFlight = false;

  async function pollOnce() {
    if (pollInFlight) return; // skip overlap
    pollInFlight = true;
    try {
      const url = healthUrlFromRelay(getRelayUrl());
      if (!url) {
        // No relay configured — treat as offline but don't oscillate.
        applyResult(false);
        return;
      }
      const result = await fetchHealth(url, { timeoutMs });
      applyResult(!!result?.ok);
    } catch {
      applyResult(false);
    } finally {
      pollInFlight = false;
    }
  }

  function applyResult(ok) {
    if (ok) {
      state.consecutiveFailures = 0;
      state.lastSeen = new Date();
      const wasOnline = state.online;
      state.online = true;
      if (!wasOnline) emitChange();
    } else {
      state.consecutiveFailures += 1;
      const wasOnline = state.online;
      if (wasOnline && state.consecutiveFailures >= failureThreshold) {
        state.online = false;
        emitChange();
      }
    }
    if (onPoll) {
      try { onPoll(snapshot()); } catch { /* swallow listener errors */ }
    }
  }

  function emitChange() {
    try { onChange(snapshot()); } catch { /* swallow listener errors */ }
  }

  function snapshot() {
    return {
      online: state.online,
      lastSeen: state.lastSeen,
      consecutiveFailures: state.consecutiveFailures,
    };
  }

  function start() {
    if (state.started) return;
    state.started = true;
    // Kick off immediately so the UI gets an initial reading without a 10s wait.
    pollOnce();
    timer = setInterval(pollOnce, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    state.started = false;
  }

  return {
    start,
    stop,
    pollNow: pollOnce,
    getState: snapshot,
  };
}

/**
 * Convert a relay URL (ws/wss/http/https) into the absolute /health URL.
 * Returns null if the input is empty/invalid.
 */
function healthUrlFromRelay(relayUrl) {
  if (!relayUrl || typeof relayUrl !== 'string') return null;
  const trimmed = relayUrl.trim();
  if (!trimmed) return null;
  let httpish = trimmed.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  if (!/^https?:/.test(httpish)) httpish = `https://${httpish}`;
  return `${httpish.replace(/\/+$/, '')}/health`;
}

async function defaultFetchHealth(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method: 'GET', signal: controller.signal });
    return { ok: resp.ok, status: resp.status };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse a `[LOCAL_STATUS_PORT] <port>` line emitted by the church-client agent.
 * Returns the port number, or null if the line is not a port marker.
 */
function parseLocalStatusPortLine(line) {
  if (typeof line !== 'string') return null;
  const m = line.match(/\[LOCAL_STATUS_PORT\]\s+(\d{1,5})/);
  if (!m) return null;
  const port = Number.parseInt(m[1], 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return port;
}

module.exports = {
  createRelayHealthMonitor,
  healthUrlFromRelay,
  parseLocalStatusPortLine,
  DEFAULT_INTERVAL_MS,
  DEFAULT_FAILURE_THRESHOLD,
};
