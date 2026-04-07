import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createRuntimeMetrics } = require('../src/runtimeMetrics');

describe('createRuntimeMetrics', () => {
  it('records counters and computes a 60-second snapshot', () => {
    let currentMs = 1700000000000;
    const metrics = createRuntimeMetrics({ now: () => currentMs, windowSeconds: 120 });

    metrics.record('church.status_update.in');
    metrics.record('church.status_update.in', 2);
    metrics.record('controller.broadcast.out', 4);
    metrics.recordBytes('controller.broadcast.out', 1024);

    currentMs += 30_000;
    metrics.record('church.status_update.in', 3);

    const snapshot = metrics.snapshot(60);
    expect(snapshot.windowSeconds).toBe(60);
    expect(snapshot.counters['church.status_update.in']).toBe(6);
    expect(snapshot.counters['controller.broadcast.out']).toBe(4);
    expect(snapshot.counters['controller.broadcast.out.bytes']).toBe(1024);
    expect(snapshot.ratesPerSecond['church.status_update.in']).toBe(0.1);

    metrics.close();
  });

  it('trims counters that fall outside the requested window', () => {
    let currentMs = 1700000000000;
    const metrics = createRuntimeMetrics({ now: () => currentMs, windowSeconds: 120 });

    metrics.record('preview_frame.out', 2);
    currentMs += 70_000;
    metrics.record('preview_frame.out', 1);

    const snapshot = metrics.snapshot(60);
    expect(snapshot.counters['preview_frame.out']).toBe(1);
    expect(snapshot.totals['preview_frame.out']).toBe(3);

    metrics.close();
  });

  it('returns event loop stats with utilization', () => {
    const metrics = createRuntimeMetrics();
    metrics.record('controller.connect');
    const eventLoop = metrics.eventLoopSnapshot();

    expect(eventLoop).toHaveProperty('p95_ms');
    expect(eventLoop).toHaveProperty('utilization');
    expect(typeof eventLoop.utilization).toBe('number');

    metrics.close();
  });
});
