/**
 * Tests for src/circuitBreaker.js
 *
 * Covers state transitions, failure counting, cooldown, half-open probing,
 * and the onClose callback used to flush the Telegram message queue.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function loadModule() {
  const path = require.resolve('../src/circuitBreaker');
  delete require.cache[path];
  // Also clear logger to avoid stale env state
  try {
    const loggerPath = require.resolve('../src/logger');
    delete require.cache[loggerPath];
  } catch { /* ignore */ }
  return require('../src/circuitBreaker');
}

describe('CircuitBreaker', () => {
  let CircuitBreaker, CircuitOpenError, STATE;

  beforeEach(() => {
    ({ CircuitBreaker, CircuitOpenError, STATE } = loadModule());
  });

  // ─── Initial state ────────────────────────────────────────────────────────

  it('starts in CLOSED state', () => {
    const cb = new CircuitBreaker('test');
    expect(cb.state).toBe(STATE.CLOSED);
    expect(cb.isOpen).toBe(false);
  });

  // ─── Success path ─────────────────────────────────────────────────────────

  it('passes through successful calls unchanged', async () => {
    const cb = new CircuitBreaker('test');
    const result = await cb.call(async () => 42);
    expect(result).toBe(42);
    expect(cb.state).toBe(STATE.CLOSED);
  });

  it('resets failure counter on success', async () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 3 });
    // Two failures then one success — should not open
    const fail = async () => { throw new Error('boom'); };
    await cb.call(fail).catch(() => {});
    await cb.call(fail).catch(() => {});
    await cb.call(async () => 'ok');
    expect(cb.state).toBe(STATE.CLOSED);
  });

  // ─── Failure / OPEN transition ────────────────────────────────────────────

  it('opens after failureThreshold consecutive failures', async () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 3 });
    const fail = async () => { throw new Error('boom'); };

    for (let i = 0; i < 3; i++) {
      await cb.call(fail).catch(() => {});
    }

    expect(cb.state).toBe(STATE.OPEN);
    expect(cb.isOpen).toBe(true);
  });

  it('does not open before reaching failureThreshold', async () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 5 });
    const fail = async () => { throw new Error('boom'); };

    for (let i = 0; i < 4; i++) {
      await cb.call(fail).catch(() => {});
    }

    expect(cb.state).toBe(STATE.CLOSED);
  });

  it('rejects immediately with CircuitOpenError when OPEN', async () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 1, cooldownMs: 60_000 });
    await cb.call(async () => { throw new Error('boom'); }).catch(() => {});

    expect(cb.isOpen).toBe(true);

    const err = await cb.call(async () => 'should not run').catch(e => e);
    expect(err).toBeInstanceOf(CircuitOpenError);
    expect(err.code).toBe('CIRCUIT_OPEN');
  });

  // ─── HALF_OPEN transition ─────────────────────────────────────────────────

  it('transitions to HALF_OPEN after cooldown elapses', async () => {
    vi.useFakeTimers();
    try {
      const cb = new CircuitBreaker('test', { failureThreshold: 1, cooldownMs: 1000 });
      await cb.call(async () => { throw new Error('boom'); }).catch(() => {});
      expect(cb.state).toBe(STATE.OPEN);

      vi.advanceTimersByTime(1001);

      // call() checks the clock and transitions on the next attempt
      const err = await cb.call(async () => 'probe').catch(e => e);
      // Should have gone through (HALF_OPEN → CLOSED on success)
      expect(err).toBe('probe');
      expect(cb.state).toBe(STATE.CLOSED);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-opens from HALF_OPEN if the probe request fails', async () => {
    vi.useFakeTimers();
    try {
      const cb = new CircuitBreaker('test', { failureThreshold: 1, cooldownMs: 1000 });
      await cb.call(async () => { throw new Error('first'); }).catch(() => {});
      expect(cb.state).toBe(STATE.OPEN);

      vi.advanceTimersByTime(1001);

      // Probe fails — should re-open
      await cb.call(async () => { throw new Error('probe fail'); }).catch(() => {});
      expect(cb.state).toBe(STATE.OPEN);
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── CLOSED after HALF_OPEN success ──────────────────────────────────────

  it('closes after a successful HALF_OPEN probe', async () => {
    vi.useFakeTimers();
    try {
      const cb = new CircuitBreaker('test', { failureThreshold: 2, cooldownMs: 500 });
      const fail = async () => { throw new Error('boom'); };
      await cb.call(fail).catch(() => {});
      await cb.call(fail).catch(() => {});
      expect(cb.state).toBe(STATE.OPEN);

      vi.advanceTimersByTime(501);

      await cb.call(async () => 'ok');
      expect(cb.state).toBe(STATE.CLOSED);
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── onClose callback ─────────────────────────────────────────────────────

  it('calls onClose when circuit transitions HALF_OPEN → CLOSED', async () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      const cb = new CircuitBreaker('test', { failureThreshold: 1, cooldownMs: 500, onClose });

      await cb.call(async () => { throw new Error('boom'); }).catch(() => {});
      vi.advanceTimersByTime(501);
      await cb.call(async () => 'ok');

      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not call onClose for normal success in CLOSED state', async () => {
    const onClose = vi.fn();
    const cb = new CircuitBreaker('test', { onClose });
    await cb.call(async () => 'ok');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('swallows errors thrown by onClose', async () => {
    vi.useFakeTimers();
    try {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 1,
        cooldownMs: 100,
        onClose: () => { throw new Error('onClose crashed'); },
      });
      await cb.call(async () => { throw new Error('boom'); }).catch(() => {});
      vi.advanceTimersByTime(101);
      // Should not throw despite onClose crashing
      await expect(cb.call(async () => 'ok')).resolves.toBe('ok');
      expect(cb.state).toBe(STATE.CLOSED);
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── CircuitOpenError ─────────────────────────────────────────────────────

  it('CircuitOpenError has code CIRCUIT_OPEN', () => {
    const err = new CircuitOpenError('svc');
    expect(err.name).toBe('CircuitOpenError');
    expect(err.code).toBe('CIRCUIT_OPEN');
    expect(err.message).toMatch(/svc/);
  });

  // ─── Default options ──────────────────────────────────────────────────────

  it('uses failureThreshold=5 and cooldownMs=60000 by default', () => {
    const cb = new CircuitBreaker('test');
    expect(cb.failureThreshold).toBe(5);
    expect(cb.cooldownMs).toBe(60_000);
  });
});
