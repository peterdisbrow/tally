'use strict';

const { monitorEventLoopDelay, performance } = require('perf_hooks');

function toMs(value) {
  return Number.isFinite(value) ? Math.round((value / 1e6) * 1000) / 1000 : 0;
}

function createRuntimeMetrics({
  now = () => Date.now(),
  windowSeconds = 300,
  eventLoopResolutionMs = 20,
} = {}) {
  const retentionSeconds = Math.max(60, Number(windowSeconds || 300));
  const buckets = new Map();
  const totals = new Map();
  const eventLoopHistogram = monitorEventLoopDelay({ resolution: Math.max(10, Number(eventLoopResolutionMs || 20)) });
  eventLoopHistogram.enable();

  function trimBuckets(currentSec = Math.floor(now() / 1000)) {
    const minSec = currentSec - retentionSeconds;
    for (const sec of buckets.keys()) {
      if (sec < minSec) buckets.delete(sec);
    }
  }

  function ensureBucket(sec) {
    let bucket = buckets.get(sec);
    if (!bucket) {
      bucket = new Map();
      buckets.set(sec, bucket);
    }
    return bucket;
  }

  function record(name, value = 1) {
    const metric = String(name || '').trim();
    const numericValue = Number(value);
    if (!metric || !Number.isFinite(numericValue) || numericValue === 0) return;

    const currentSec = Math.floor(now() / 1000);
    trimBuckets(currentSec);

    totals.set(metric, (totals.get(metric) || 0) + numericValue);
    const bucket = ensureBucket(currentSec);
    bucket.set(metric, (bucket.get(metric) || 0) + numericValue);
  }

  function recordBytes(name, bytes) {
    const size = Number(bytes);
    if (!Number.isFinite(size) || size <= 0) return;
    record(`${name}.bytes`, size);
  }

  function aggregateWindow(windowSec = 60) {
    const currentSec = Math.floor(now() / 1000);
    const minSec = currentSec - Math.max(1, Number(windowSec || 60)) + 1;
    trimBuckets(currentSec);

    const counters = new Map();
    for (const [sec, bucket] of buckets.entries()) {
      if (sec < minSec) continue;
      for (const [metric, value] of bucket.entries()) {
        counters.set(metric, (counters.get(metric) || 0) + value);
      }
    }

    return counters;
  }

  function mapToObject(map) {
    return Object.fromEntries(Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b)));
  }

  function snapshot(windowSec = 60) {
    const windowCounters = aggregateWindow(windowSec);
    const duration = Math.max(1, Number(windowSec || 60));
    const ratesPerSecond = new Map();
    for (const [metric, value] of windowCounters.entries()) {
      ratesPerSecond.set(metric, Math.round((value / duration) * 1000) / 1000);
    }

    return {
      windowSeconds: duration,
      counters: mapToObject(windowCounters),
      ratesPerSecond: mapToObject(ratesPerSecond),
      totals: mapToObject(totals),
    };
  }

  function eventLoopSnapshot() {
    const elu = performance.eventLoopUtilization();
    return {
      min_ms: toMs(eventLoopHistogram.min),
      max_ms: toMs(eventLoopHistogram.max),
      mean_ms: toMs(eventLoopHistogram.mean),
      p50_ms: toMs(eventLoopHistogram.percentile(50)),
      p95_ms: toMs(eventLoopHistogram.percentile(95)),
      p99_ms: toMs(eventLoopHistogram.percentile(99)),
      stddev_ms: toMs(eventLoopHistogram.stddev),
      utilization: Math.round((elu.utilization || 0) * 1000) / 1000,
    };
  }

  function close() {
    try {
      eventLoopHistogram.disable();
    } catch (err) {
      // ignore shutdown races
      console.debug('[runtimeMetrics close] histogram.disable race:', err?.message);
    }
  }

  return {
    record,
    recordBytes,
    snapshot,
    eventLoopSnapshot,
    close,
  };
}

module.exports = {
  createRuntimeMetrics,
};
