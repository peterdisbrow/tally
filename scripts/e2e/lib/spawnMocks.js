/**
 * Lifecycle wrapper around `npm run mocks` (church-client/test/mocks/launcher.js).
 *
 * Spawns the launcher as a subprocess so we can SIGINT/SIGTERM it cleanly at
 * the end of the run. Streams stdout to a buffer so the harness can scrape
 * the `[mock-<name>] device=...  control=...` lines if a port override is
 * needed (default ports are fine for this harness).
 *
 * Also exposes restartOne(name) — kills the launcher and reboots it with the
 * named mock excluded, then re-includes it. That's how the recovery scenarios
 * simulate a single-device disconnect without taking down the others.
 */

'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../../..');
const CHURCH_CLIENT = path.join(REPO_ROOT, 'church-client');

const ALL_MOCKS = [
  'companion', 'propresenter', 'videohub', 'obs', 'atem',
  'tricaster', 'birddog', 'teradek', 'resolume', 'sq', 'planning-center',
];

class MockLauncher {
  constructor({ log, mocks = ALL_MOCKS } = {}) {
    this.log = log;
    this.mocks = mocks.slice();
    this.proc = null;
    this.stdoutBuf = '';
    this.stderrBuf = '';
    this.startedAt = 0;
  }

  async start() {
    if (this.proc) throw new Error('[mocks] already running');
    this.startedAt = Date.now();
    this.proc = spawn('node', ['test/mocks/launcher.js'], {
      cwd: CHURCH_CLIENT,
      env: { ...process.env, MOCKS: this.mocks.join(',') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', (d) => { this.stdoutBuf += d.toString(); this.log?.debug('[mocks-out]', d.toString().trimEnd()); });
    this.proc.stderr.on('data', (d) => { this.stderrBuf += d.toString(); this.log?.debug('[mocks-err]', d.toString().trimEnd()); });
    this.proc.on('exit', (code, signal) => {
      this.log?.debug(`[mocks] exited code=${code} signal=${signal}`);
      this.proc = null;
    });

    // Wait for the launcher's "N mock(s) running" line before returning so
    // callers can immediately hit control APIs.
    await this._waitForReady();
  }

  async _waitForReady({ timeoutMs = 15_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (/\d+ mock\(s\) running/.test(this.stdoutBuf)) return;
      if (this.stderrBuf.includes('failed to start')) {
        throw new Error(`[mocks] launcher reported a failure:\n${this.stderrBuf}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`[mocks] launcher did not report ready within ${timeoutMs}ms\nstdout:\n${this.stdoutBuf}\nstderr:\n${this.stderrBuf}`);
  }

  async stop() {
    if (!this.proc) return;
    const dead = new Promise((r) => this.proc.once('exit', r));
    try { this.proc.kill('SIGINT'); } catch { /* already dead */ }
    // Force kill after 3s if SIGINT doesn't bring it down.
    const force = setTimeout(() => { try { this.proc?.kill('SIGKILL'); } catch { /* */ } }, 3_000);
    await dead;
    clearTimeout(force);
    this.proc = null;
  }

  /** Restart the entire launcher with `name` excluded (= simulate that one
   *  device going dark while the rest stay up). Inverse: pass `null` to
   *  restart with the original full set. */
  async restartWithout(name) {
    await this.stop();
    this.stdoutBuf = '';
    this.stderrBuf = '';
    const next = name ? this.mocks.filter((m) => m !== name) : this.mocks.slice();
    this.proc = spawn('node', ['test/mocks/launcher.js'], {
      cwd: CHURCH_CLIENT,
      env: { ...process.env, MOCKS: next.join(',') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', (d) => { this.stdoutBuf += d.toString(); });
    this.proc.stderr.on('data', (d) => { this.stderrBuf += d.toString(); });
    this.proc.on('exit', () => { this.proc = null; });
    await this._waitForReady();
  }
}

module.exports = { MockLauncher, ALL_MOCKS };
