/**
 * agentHarness — run the REAL church-client agent process against a fake relay
 * and a mock device, and observe what the booth would see.
 *
 * Every status_update frame is reconstructed exactly the way the relay does it
 * (full frames replace, delta frames are applied with the relay's own
 * applyStatusDelta semantics) and recorded with a timestamp so tests
 * can assert honesty over time (e.g. "never reported connected during a
 * failed auth"), not just the final state.
 */
'use strict';

const { WebSocketServer } = require('ws');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Same semantics as relay-server/src/deltaUpdates.js applyStatusDelta.
function applyStatusDelta(previous, delta) {
  const next = previous && typeof previous === 'object' ? JSON.parse(JSON.stringify(previous)) : {};
  if (!delta || typeof delta !== 'object') return next;
  for (const [key, value] of Object.entries(delta)) {
    if (value === null) delete next[key];
    else next[key] = JSON.parse(JSON.stringify(value));
  }
  return next;
}

// TALLY_AGENT_INDEX lets the red-proof runner point the SAME tests at an older
// Tally build (git worktree) to show they fail on the pre-fix code.
const INDEX_PATH = process.env.TALLY_AGENT_INDEX || path.join(__dirname, '..', '..', 'src', 'index.js');
const TEST_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJjaHVyY2hJZCI6InNpbS1jaHVyY2gifQ.test-sig';

async function startAgent(config = {}, { env = {} } = {}) {
  const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => relay.once('listening', r));
  const port = relay.address().port;
  const frames = [];      // { t, status }
  const results = [];     // command_result
  const alerts = [];
  const logs = [];
  const modes = new Set(); // statusMode values seen on the wire
  let sock = null;
  relay.on('connection', (ws) => {
    sock = ws;
    ws.send(JSON.stringify({ type: 'connected', name: 'sim' }));
    ws.on('message', (d) => {
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      if (m.type === 'status_update' && m.status) {
        modes.add(m.statusMode || (m.isDelta ? 'delta' : 'full'));
        if (m.heartbeatOnly) return;
        const base = frames.length ? frames[frames.length - 1].status : null;
        const status = m.isDelta ? applyStatusDelta(base, m.status) : JSON.parse(JSON.stringify(m.status));
        frames.push({ t: Date.now(), status, raw: m });
      }
      else if (m.type === 'command_result') results.push(m);
      else if (m.type === 'alert') alerts.push(m);
    });
  });
  const configFile = path.join(os.tmpdir(), `tally-sim-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(configFile, JSON.stringify({ token: TEST_TOKEN, ...config }));
  const proc = spawn(process.execPath, [INDEX_PATH, '--relay', `ws://127.0.0.1:${port}`, '--config', configFile, '--no-watchdog'], {
    env: { ...process.env, TALLY_SENTRY_DSN: '', ELECTRON_SENTRY_DSN: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => logs.push(d.toString()));
  proc.stderr.on('data', (d) => logs.push(d.toString()));

  const latest = () => (frames.length ? frames[frames.length - 1].status : null);
  async function waitFor(pred, timeoutMs = 15000, label = 'condition') {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const s = latest();
      try { if (s && pred(s)) return { ms: Date.now() - t0, status: s }; } catch { /* keep waiting */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    const full = logs.join('');
    const dump = path.join(os.tmpdir(), `tally-sim-agentlog-${Date.now()}.log`);
    try { fs.writeFileSync(dump, `pid=${proc.pid} exitCode=${proc.exitCode} signal=${proc.signalCode} frames=${frames.length}\n${full}`); } catch { /* */ }
    const tail = full.split('\n').slice(-25).join('\n') + `\n[full agent log: ${dump}; frames=${frames.length}; exit=${proc.exitCode}]`;
    throw new Error(`timeout (${timeoutMs}ms) waiting for ${label}; last status=${JSON.stringify(latest())?.slice(0, 600)}\n--- agent log tail ---\n${tail}`);
  }
  let cmdSeq = 0;
  async function command(command, params = {}, timeoutMs = 10000) {
    const id = `sim-${++cmdSeq}`;
    sock.send(JSON.stringify({ type: 'command', id, command, params }));
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const r = results.find((x) => x.id === id);
      if (r) return r;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error(`no command_result for ${command}`);
  }
  async function stop() {
    try { proc.kill('SIGTERM'); } catch { /* */ }
    await new Promise((r) => { const to = setTimeout(r, 3000); proc.once('exit', () => { clearTimeout(to); r(); }); });
    try { proc.kill('SIGKILL'); } catch { /* */ }
    await new Promise((r) => relay.close(() => r()));
    try { fs.unlinkSync(configFile); } catch { /* */ }
  }
  /** frames since t (ms epoch) */
  const since = (t) => frames.filter((f) => f.t >= t);
  return { proc, modes, frames, results, alerts, logs, latest, waitFor, command, stop, since };
}

async function freePort() {
  const net = require('node:net');
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

module.exports = { startAgent, freePort, TEST_TOKEN };
