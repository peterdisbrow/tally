'use strict';

/**
 * Lightweight in-process event counter with sliding-window snapshots.
 * Used by health routes and internal diagnostics to track message rates,
 * byte throughput, and event-loop latency without an external dependency.
 */

const { monitorEventLoopDelay } = require('perf_hooks');

function createRuntimeMetrics({ windowMs = 60_000 } = {}) {
  // key → [{ ts, count }]
  const counters = new Map();
  // key → total (lifetime)
  const totals = new Map();
  // key → [{ ts, bytes }]
  const byteCounters = new Map();

  // Event-loop latency histogram (node ≥ 12)
  let eld = null;
  try {
    eld = monitorEventLoopDelay({ resolution: 20 });
    eld.enable();
  } catch {
    // older runtimes or restricted environments
  }

  function now() {
    return Date.now();
  }

  function pruneWindow(entries, cutoff) {
    while (entries.length && entries[0].ts < cutoff) entries.shift();
  }

  /**
   * Record one or more occurrences of a named event.
   */
  function record(key, count = 1) {
    const ts = now();
    if (!counters.has(key)) counters.set(key, []);
    counters.get(key).push({ ts, count });
    totals.set(key, (totals.get(key) || 0) + count);
  }

  /**
   * Record byte throughput for a named event.
   */
  function recordBytes(key, bytes) {
    if (!bytes) return;
    const ts = now();
    if (!byteCounters.has(key)) byteCounters.set(key, []);
    byteCounters.get(key).push({ ts, bytes });
  }

  /**
   * Return a snapshot of counters within the given window.
   */
  function snapshot(windowSeconds = 60) {
    const windowMsActual = windowSeconds * 1000;
    const cutoff = now() - windowMsActual;

    const result = { windowSeconds, counters: {}, ratesPerSecond: {}, totals: {} };

    for (const [key, entries] of counters) {
      pruneWindow(entries, cutoff);
      let sum = 0;
      for (const e of entries) sum += e.count;
      result.counters[key] = sum;
      result.ratesPerSecond[key] = windowSeconds > 0 ? +(sum / windowSeconds).toFixed(2) : 0;
      result.totals[key] = totals.get(key) || 0;
    }

    return result;
  }

  /**
   * Return event-loop delay percentiles.
   */
  function eventLoopSnapshot() {
    if (!eld) return null;
    return {
      min_ms: +(eld.min / 1e6).toFixed(2),
      max_ms: +(eld.max / 1e6).toFixed(2),
      mean_ms: +(eld.mean / 1e6).toFixed(2),
      p50_ms: +(eld.percentile(50) / 1e6).toFixed(2),
      p95_ms: +(eld.percentile(95) / 1e6).toFixed(2),
      p99_ms: +(eld.percentile(99) / 1e6).toFixed(2),
      utilization: eld.utilization !== undefined ? +eld.utilization.toFixed(4) : null,
    };
  }

  function close() {
    if (eld) {
      try { eld.disable(); } catch { /* ignore */ }
    }
    counters.clear();
    totals.clear();
    byteCounters.clear();
  }

  return {
    record,
    recordBytes,
    snapshot,
    eventLoopSnapshot,
    close,
  };
}

module.exports = { createRuntimeMetrics };
