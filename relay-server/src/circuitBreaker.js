'use strict';

/**
 * Simple circuit breaker for external service calls.
 *
 * States:
 *   CLOSED    — normal operation; calls pass through
 *   OPEN      — circuit tripped; calls fail-fast during cooldown period
 *   HALF_OPEN — cooldown elapsed; one test request is allowed through
 *
 * Usage:
 *   const { CircuitBreaker } = require('./circuitBreaker');
 *   const cb = new CircuitBreaker('telegram', { failureThreshold: 5, cooldownMs: 60_000 });
 *   const result = await cb.call(() => fetch(...));
 *
 * State transitions:
 *   CLOSED    → OPEN      after failureThreshold consecutive failures
 *   OPEN      → HALF_OPEN after cooldownMs has elapsed
 *   HALF_OPEN → CLOSED    if the test request succeeds
 *   HALF_OPEN → OPEN      if the test request fails (cooldown resets)
 *
 * All transitions are logged at 'warn' severity via the structured logger.
 */

const { createLogger } = require('./logger');

const log = createLogger('CircuitBreaker');

const STATE = {
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half_open',
};

class CircuitOpenError extends Error {
  constructor(name) {
    super(`Circuit '${name}' is OPEN — call rejected`);
    this.name = 'CircuitOpenError';
    this.code = 'CIRCUIT_OPEN';
  }
}

class CircuitBreaker {
  /**
   * @param {string}   name                        Identifier used in log output
   * @param {object}   [options]
   * @param {number}   [options.failureThreshold=5] Consecutive failures before opening
   * @param {number}   [options.cooldownMs=60000]   ms to wait in OPEN before trying HALF_OPEN
   * @param {function} [options.onClose]            Called (sync) when circuit transitions to CLOSED
   */
  constructor(name, options = {}) {
    this.name = name;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this._onClose = options.onClose || null;

    this._state = STATE.CLOSED;
    this._failures = 0;
    this._openedAt = null;
  }

  get state() { return this._state; }
  get isOpen() { return this._state === STATE.OPEN; }

  /**
   * Execute fn through the circuit breaker.
   *
   * Throws CircuitOpenError immediately if circuit is OPEN and cooldown has not elapsed.
   * Re-throws fn's own error after recording the failure.
   *
   * @param {function(): Promise<any>} fn  Async function to wrap
   */
  async call(fn) {
    if (this._state === STATE.OPEN) {
      if (Date.now() - this._openedAt >= this.cooldownMs) {
        this._setState(STATE.HALF_OPEN);
      } else {
        throw new CircuitOpenError(this.name);
      }
    }

    try {
      const result = await fn();
      this._recordSuccess();
      return result;
    } catch (err) {
      this._recordFailure();
      throw err;
    }
  }

  _recordSuccess() {
    const wasHalfOpen = this._state === STATE.HALF_OPEN;
    this._failures = 0;
    if (wasHalfOpen) {
      this._setState(STATE.CLOSED);
      if (this._onClose) {
        try { this._onClose(); } catch { /* ignore errors in onClose callback */ }
      }
    }
  }

  _recordFailure() {
    this._failures++;
    if (this._state === STATE.HALF_OPEN || this._failures >= this.failureThreshold) {
      this._setState(STATE.OPEN);
    }
  }

  _setState(newState) {
    this._state = newState;
    if (newState === STATE.OPEN) {
      this._openedAt = Date.now();
      log.warn('circuit opened', { circuit: this.name, event: 'circuit_open', failures: this._failures });
    } else if (newState === STATE.HALF_OPEN) {
      log.warn('circuit half-open', { circuit: this.name, event: 'circuit_half_open' });
    } else if (newState === STATE.CLOSED) {
      log.warn('circuit closed', { circuit: this.name, event: 'circuit_closed' });
    }
  }
}

module.exports = { CircuitBreaker, CircuitOpenError, STATE };
