/**
 * Tests for src/statusBatcher.js — coalescing rapid status updates into
 * batched deliveries.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createStatusBatcher } = require('../src/statusBatcher');

describe('createStatusBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns an object with enqueue, flush, and _pending', () => {
    const batcher = createStatusBatcher(() => {});
    expect(typeof batcher.enqueue).toBe('function');
    expect(typeof batcher.flush).toBe('function');
    expect(batcher._pending).toBeInstanceOf(Map);
  });

  it('calls flushFn with latest event after windowMs', () => {
    const flushFn = vi.fn();
    const batcher = createStatusBatcher(flushFn, { windowMs: 100 });

    batcher.enqueue('church_a', { type: 'status', value: 1 });
    expect(flushFn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100);
    expect(flushFn).toHaveBeenCalledOnce();
    expect(flushFn).toHaveBeenCalledWith('church_a', { type: 'status', value: 1 });
  });

  it('last-write-wins: only sends the latest event per churchId', () => {
    const flushFn = vi.fn();
    const batcher = createStatusBatcher(flushFn, { windowMs: 100 });

    batcher.enqueue('church_a', { value: 1 });
    batcher.enqueue('church_a', { value: 2 });
    batcher.enqueue('church_a', { value: 3 });

    vi.advanceTimersByTime(100);
    expect(flushFn).toHaveBeenCalledOnce();
    expect(flushFn).toHaveBeenCalledWith('church_a', { value: 3 });
  });

  it('batches multiple churches and flushes all at once', () => {
    const flushFn = vi.fn();
    const batcher = createStatusBatcher(flushFn, { windowMs: 50 });

    batcher.enqueue('church_a', { value: 'a' });
    batcher.enqueue('church_b', { value: 'b' });

    vi.advanceTimersByTime(50);
    expect(flushFn).toHaveBeenCalledTimes(2);
  });

  it('schedules a new batch after the previous one flushes', () => {
    const flushFn = vi.fn();
    const batcher = createStatusBatcher(flushFn, { windowMs: 100 });

    batcher.enqueue('church_a', { value: 1 });
    vi.advanceTimersByTime(100);
    expect(flushFn).toHaveBeenCalledTimes(1);

    // Second batch
    batcher.enqueue('church_a', { value: 2 });
    vi.advanceTimersByTime(100);
    expect(flushFn).toHaveBeenCalledTimes(2);
  });

  it('does not schedule a second timer if one is already pending', () => {
    const flushFn = vi.fn();
    const batcher = createStatusBatcher(flushFn, { windowMs: 100 });

    batcher.enqueue('church_a', { value: 1 });
    batcher.enqueue('church_a', { value: 2 }); // should not create a second timer

    vi.advanceTimersByTime(100);
    expect(flushFn).toHaveBeenCalledOnce();
  });

  it('flush() clears pending and calls flushFn immediately', () => {
    const flushFn = vi.fn();
    const batcher = createStatusBatcher(flushFn, { windowMs: 500 });

    batcher.enqueue('church_a', { value: 1 });
    expect(batcher._pending.size).toBe(1);

    batcher.flush();
    expect(flushFn).toHaveBeenCalledOnce();
    expect(batcher._pending.size).toBe(0);
  });

  it('uses default windowMs of 100 when not specified', () => {
    const flushFn = vi.fn();
    const batcher = createStatusBatcher(flushFn);

    batcher.enqueue('church_a', { value: 1 });
    vi.advanceTimersByTime(99);
    expect(flushFn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(flushFn).toHaveBeenCalledOnce();
  });

  it('does not crash if flushFn throws', () => {
    const flushFn = vi.fn().mockImplementation(() => { throw new Error('boom'); });
    const batcher = createStatusBatcher(flushFn, { windowMs: 50 });

    batcher.enqueue('church_a', { value: 1 });
    batcher.enqueue('church_b', { value: 2 });

    // Should not throw
    expect(() => vi.advanceTimersByTime(50)).not.toThrow();
    expect(flushFn).toHaveBeenCalledTimes(2);
  });

  it('flush() is a no-op when pending is empty', () => {
    const flushFn = vi.fn();
    const batcher = createStatusBatcher(flushFn);

    batcher.flush();
    expect(flushFn).not.toHaveBeenCalled();
  });
});
