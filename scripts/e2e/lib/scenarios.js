/**
 * Tiny test runner — replaces a full test framework so the harness can ship
 * as a single self-contained Node script with no extra deps.
 *
 * Conventions:
 *   - A scenario is `async (ctx) => ...` that throws on failure.
 *   - The runner records pass/fail/duration per scenario.
 *   - At the end, `summary()` prints a table and the runner returns the
 *     count of failures so the entry script can exit non-zero.
 */

'use strict';

class ScenarioRunner {
  constructor({ log }) {
    this.log = log;
    this.results = [];
  }

  async run(name, fn, ctx) {
    const t0 = Date.now();
    try {
      this.log.info(`▶ ${name}`);
      await fn(ctx);
      const ms = Date.now() - t0;
      this.results.push({ name, ok: true, ms });
      this.log.info(`✓ ${name}  (${ms}ms)`);
    } catch (err) {
      const ms = Date.now() - t0;
      this.results.push({ name, ok: false, ms, error: err });
      this.log.error(`✗ ${name}  (${ms}ms)`);
      this.log.error(`  ${err.message || err}`);
      if (err.stack && process.env.E2E_LOG_LEVEL === 'debug') {
        this.log.debug(err.stack);
      }
    }
  }

  summary() {
    const passed = this.results.filter((r) => r.ok).length;
    const failed = this.results.filter((r) => !r.ok).length;
    const total = this.results.length;
    const totalMs = this.results.reduce((acc, r) => acc + r.ms, 0);

    this.log.info('');
    this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    this.log.info('E2E SUMMARY');
    this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    for (const r of this.results) {
      const icon = r.ok ? '✓' : '✗';
      const dur = `${String(r.ms).padStart(6)}ms`;
      this.log.info(`  ${icon} ${dur}  ${r.name}`);
    }
    this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    this.log.info(`  ${passed}/${total} passed (${failed} failed) — ${totalMs}ms total`);
    this.log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    if (failed > 0) {
      this.log.info('');
      this.log.info('FAILURE DETAIL:');
      for (const r of this.results.filter((x) => !x.ok)) {
        this.log.info(`  ✗ ${r.name}`);
        this.log.info(`    ${r.error?.message || r.error}`);
      }
    }
    return failed;
  }
}

/** Generic poll-until-true with a timeout. Used by scenarios that need to
 *  wait on side-effects of a mock action propagating through the agent →
 *  relay → SSE round-trip. */
async function waitUntil(predicate, { timeoutMs = 10_000, intervalMs = 200, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastResult;
  while (Date.now() < deadline) {
    try {
      lastResult = await predicate();
      if (lastResult) return lastResult;
    } catch (err) {
      lastResult = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`[waitUntil] ${label} did not become true within ${timeoutMs}ms (lastResult=${JSON.stringify(lastResult)?.slice(0, 300)})`);
}

module.exports = { ScenarioRunner, waitUntil };
