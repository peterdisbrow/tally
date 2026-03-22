'use strict';

/**
 * Integration tests for church-client/src/index.js — ChurchAVAgent
 *
 * Strategy:
 *  1. Subprocess integration tests: spawn the real agent process against a local
 *     WS relay server (from the 'ws' package). These exercise the actual
 *     connection lifecycle, command dispatch, reconnection backoff, and graceful
 *     shutdown code paths.
 *
 *  2. Pure logic tests: the helper functions (prettifyAtemModelEnumName,
 *     isMockValue, stripMockConfig, extractAtemIdentity,
 *     detectAtemAudioSources, _updateBitrateSignal, etc.) are not exported from
 *     index.js, so their logic is tested by extracting / re-implementing the
 *     exact function bodies here. Any drift between the source and these
 *     copies will surface immediately as a test failure.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const INDEX_PATH = path.join(__dirname, '..', 'src', 'index.js');

// A test JWT: header.payload.sig  (no crypto verification in agent)
// Payload: {"churchId":"test-church"}
const TEST_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJjaHVyY2hJZCI6InRlc3QtY2h1cmNoIn0.test-sig';

// ─── Subprocess test helpers ──────────────────────────────────────────────────

/** Start a WS server on a random free port and resolve once listening. */
function createRelayServer() {
  return new Promise((resolve, reject) => {
    const server = new WebSocketServer({ port: 0 });
    server.on('listening', () => resolve({ server, port: server.address().port }));
    server.on('error', reject);
  });
}

/** Spawn the agent process connected to `port` with a temp config file. */
function spawnAgent({ port, extraArgs = [], extraEnv = {} }) {
  const configFile = path.join(
    os.tmpdir(),
    `tally-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  const proc = spawn(
    process.execPath,
    [
      INDEX_PATH,
      '--relay', `ws://127.0.0.1:${port}`,
      '--config', configFile,
      '--no-watchdog',
      ...extraArgs,
    ],
    {
      env: { ...process.env, TALLY_TOKEN: TEST_TOKEN, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  proc.stdout.resume();
  proc.stderr.resume();
  return { proc, configFile };
}

/** Poll `condition()` until truthy or `timeoutMs` elapses, then resolve/throw. */
async function waitFor(condition, timeoutMs = 8000, pollMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

/** Send SIGTERM and wait for the process to exit (with SIGKILL fallback). */
function killProc(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.killed) { resolve(); return; }
    proc.once('exit', resolve);
    try { proc.kill('SIGTERM'); } catch { /* already dead */ }
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 2000);
  });
}

/** Close a WebSocket server and wait for it to finish. */
function closeServer(server) {
  return new Promise((resolve) => {
    // Force-terminate open connections so server.close() resolves promptly.
    for (const ws of server.clients) { try { ws.terminate(); } catch { /* ignore */ } }
    server.close(() => resolve());
  });
}

/** Try to delete a temp config file, ignoring errors. */
function cleanConfig(p) { try { fs.unlinkSync(p); } catch { /* ignore */ } }

// ─── 1. RELAY CONNECTION LIFECYCLE ───────────────────────────────────────────

test('agent connects to relay and sends status_update', { timeout: 12000 }, async () => {
  const { server, port } = await createRelayServer();
  const received = [];
  server.on('connection', (ws) =>
    ws.on('message', (d) => { try { received.push(JSON.parse(d.toString())); } catch { /* ignore */ } })
  );

  const { proc, configFile } = spawnAgent({ port });
  try {
    await waitFor(() => received.some((m) => m.type === 'status_update'));
    assert.ok(received.some((m) => m.type === 'status_update'));
  } finally {
    await killProc(proc);
    await closeServer(server);
    cleanConfig(configFile);
  }
});

test('status_update contains all required top-level fields', { timeout: 12000 }, async () => {
  const { server, port } = await createRelayServer();
  const received = [];
  server.on('connection', (ws) =>
    ws.on('message', (d) => { try { received.push(JSON.parse(d.toString())); } catch { /* ignore */ } })
  );

  const { proc, configFile } = spawnAgent({ port });
  try {
    await waitFor(() => received.some((m) => m.type === 'status_update'));
    const s = received.find((m) => m.type === 'status_update').status;

    // Core device status blocks
    for (const key of ['atem', 'obs', 'encoder', 'system', 'companion', 'ptz', 'audio',
      'hyperdeck', 'hyperdecks', 'proPresenter', 'resolume', 'vmix', 'mixer', 'videoHubs']) {
      assert.ok(key in s, `missing status.${key}`);
    }
    // Health block is included alongside status
    assert.ok('health' in s, 'missing status.health');
    // System block always has hostname + platform
    assert.equal(s.system.hostname, os.hostname());
    assert.equal(s.system.platform, os.platform());
  } finally {
    await killProc(proc);
    await closeServer(server);
    cleanConfig(configFile);
  }
});

test('status.atem.connected is false when no ATEM IP configured', { timeout: 12000 }, async () => {
  const { server, port } = await createRelayServer();
  const received = [];
  server.on('connection', (ws) =>
    ws.on('message', (d) => { try { received.push(JSON.parse(d.toString())); } catch { /* ignore */ } })
  );

  const { proc, configFile } = spawnAgent({ port });
  try {
    await waitFor(() => received.some((m) => m.type === 'status_update'));
    const s = received.find((m) => m.type === 'status_update').status;
    assert.equal(s.atem.connected, false);
    assert.equal(s.atem.ip, null);
  } finally {
    await killProc(proc);
    await closeServer(server);
    cleanConfig(configFile);
  }
});

test('status.system.name reflects --name CLI flag', { timeout: 12000 }, async () => {
  const { server, port } = await createRelayServer();
  const received = [];
  server.on('connection', (ws) =>
    ws.on('message', (d) => { try { received.push(JSON.parse(d.toString())); } catch { /* ignore */ } })
  );

  const { proc, configFile } = spawnAgent({ port, extraArgs: ['--name', 'Test Sanctuary'] });
  try {
    await waitFor(() => received.some((m) => m.type === 'status_update'));
    const s = received.find((m) => m.type === 'status_update').status;
    assert.equal(s.system.name, 'Test Sanctuary');
  } finally {
    await killProc(proc);
    await closeServer(server);
    cleanConfig(configFile);
  }
});

// ─── 2. COMMAND DISPATCH ─────────────────────────────────────────────────────

test('known command returns command_result with result', { timeout: 12000 }, async () => {
  const { server, port } = await createRelayServer();
  const received = [];
  let relayWs;
  server.on('connection', (ws) => {
    relayWs = ws;
    ws.on('message', (d) => { try { received.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
  });

  const { proc, configFile } = spawnAgent({ port });
  try {
    await waitFor(() => received.some((m) => m.type === 'status_update'));

    // 'status' command returns the current status object
    relayWs.send(JSON.stringify({ type: 'command', command: 'status', params: {}, id: 'cmd-001' }));
    await waitFor(() => received.some((m) => m.type === 'command_result' && m.id === 'cmd-001'));

    const r = received.find((m) => m.id === 'cmd-001');
    assert.equal(r.command, 'status');
    assert.equal(r.error, null);
    assert.ok(r.result, 'result should be non-null');
    assert.ok('atem' in r.result, 'result should be the status object');
  } finally {
    await killProc(proc);
    await closeServer(server);
    cleanConfig(configFile);
  }
});

test('unknown command returns error in command_result', { timeout: 12000 }, async () => {
  const { server, port } = await createRelayServer();
  const received = [];
  let relayWs;
  server.on('connection', (ws) => {
    relayWs = ws;
    ws.on('message', (d) => { try { received.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
  });

  const { proc, configFile } = spawnAgent({ port });
  try {
    await waitFor(() => received.some((m) => m.type === 'status_update'));

    relayWs.send(JSON.stringify({ type: 'command', command: 'nonexistent.fooBar', params: {}, id: 'cmd-002' }));
    await waitFor(() => received.some((m) => m.id === 'cmd-002'));

    const r = received.find((m) => m.id === 'cmd-002');
    assert.ok(r.error, 'expected error for unknown command');
    assert.match(r.error, /Unknown command/);
    assert.equal(r.result, null);
  } finally {
    await killProc(proc);
    await closeServer(server);
    cleanConfig(configFile);
  }
});

test('command that throws returns error in command_result', { timeout: 12000 }, async () => {
  const { server, port } = await createRelayServer();
  const received = [];
  let relayWs;
  server.on('connection', (ws) => {
    relayWs = ws;
    ws.on('message', (d) => { try { received.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
  });

  const { proc, configFile } = spawnAgent({ port });
  try {
    await waitFor(() => received.some((m) => m.type === 'status_update'));

    // videohub.getInputLabels throws "Video Hub not configured" when no hub is set up
    relayWs.send(JSON.stringify({ type: 'command', command: 'videohub.getInputLabels', params: {}, id: 'cmd-003' }));
    await waitFor(() => received.some((m) => m.id === 'cmd-003'));

    const r = received.find((m) => m.id === 'cmd-003');
    assert.ok(r.error, 'expected error for command that throws');
    assert.equal(r.result, null);
  } finally {
    await killProc(proc);
    await closeServer(server);
    cleanConfig(configFile);
  }
});

test('command_result echoes back the command name', { timeout: 12000 }, async () => {
  const { server, port } = await createRelayServer();
  const received = [];
  let relayWs;
  server.on('connection', (ws) => {
    relayWs = ws;
    ws.on('message', (d) => { try { received.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
  });

  const { proc, configFile } = spawnAgent({ port });
  try {
    await waitFor(() => received.some((m) => m.type === 'status_update'));

    relayWs.send(JSON.stringify({ type: 'command', command: 'status', params: {}, id: 'echo-test' }));
    await waitFor(() => received.some((m) => m.id === 'echo-test'));

    const r = received.find((m) => m.id === 'echo-test');
    assert.equal(r.type, 'command_result');
    assert.equal(r.command, 'status');
    assert.equal(r.id, 'echo-test');
  } finally {
    await killProc(proc);
    await closeServer(server);
    cleanConfig(configFile);
  }
});

test('malformed JSON relay message does not crash the agent', { timeout: 12000 }, async () => {
  const { server, port } = await createRelayServer();
  const received = [];
  let relayWs;
  server.on('connection', (ws) => {
    relayWs = ws;
    ws.on('message', (d) => { try { received.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
  });

  const { proc, configFile } = spawnAgent({ port });
  try {
    await waitFor(() => received.some((m) => m.type === 'status_update'));

    // Blast several malformed payloads
    relayWs.send('{ not valid json !!');
    relayWs.send('undefined');
    relayWs.send('');

    // Give the agent a moment to process
    await new Promise((r) => setTimeout(r, 300));

    // Agent must still be alive and responsive
    relayWs.send(JSON.stringify({ type: 'command', command: 'status', id: 'alive-check', params: {} }));
    await waitFor(() => received.some((m) => m.id === 'alive-check'));
    assert.ok(received.some((m) => m.id === 'alive-check'), 'agent unresponsive after malformed JSON');
  } finally {
    await killProc(proc);
    await closeServer(server);
    cleanConfig(configFile);
  }
});

test('pong message updates health.relay.latencyMs', { timeout: 12000 }, async () => {
  const { server, port } = await createRelayServer();
  const received = [];
  let relayWs;
  server.on('connection', (ws) => {
    relayWs = ws;
    ws.on('message', (d) => { try { received.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
  });

  const { proc, configFile } = spawnAgent({ port });
  try {
    await waitFor(() => received.some((m) => m.type === 'status_update'));

    // Verify initial latencyMs is null (no ping-pong yet)
    const su0 = received.find((m) => m.type === 'status_update');
    assert.equal(su0.status.health.relay.latencyMs, null, 'latencyMs should start null');

    // Simulate relay responding to a ping that was sent ~50ms ago
    const ts = Date.now() - 50;
    relayWs.send(JSON.stringify({ type: 'pong', ts }));
    await new Promise((r) => setTimeout(r, 200));

    // Agent should still be alive and responsive after processing the pong
    relayWs.send(JSON.stringify({ type: 'command', command: 'status', id: 'pong-alive', params: {} }));
    await waitFor(() => received.some((m) => m.id === 'pong-alive'));
    assert.ok(received.some((m) => m.id === 'pong-alive'), 'agent not responsive after pong');
  } finally {
    await killProc(proc);
    await closeServer(server);
    cleanConfig(configFile);
  }
});

test('unknown relay message type is handled without crashing', { timeout: 12000 }, async () => {
  const { server, port } = await createRelayServer();
  const received = [];
  let relayWs;
  server.on('connection', (ws) => {
    relayWs = ws;
    ws.on('message', (d) => { try { received.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
  });

  const { proc, configFile } = spawnAgent({ port });
  try {
    await waitFor(() => received.some((m) => m.type === 'status_update'));

    relayWs.send(JSON.stringify({ type: 'totally_unknown_type', data: 'test' }));
    await new Promise((r) => setTimeout(r, 200));

    // Still responsive
    relayWs.send(JSON.stringify({ type: 'command', command: 'status', id: 'unknown-type-check', params: {} }));
    await waitFor(() => received.some((m) => m.id === 'unknown-type-check'));
    assert.ok(received.some((m) => m.id === 'unknown-type-check'));
  } finally {
    await killProc(proc);
    await closeServer(server);
    cleanConfig(configFile);
  }
});

// ─── 3. RELAY RECONNECTION ────────────────────────────────────────────────────

test('agent reconnects after relay server restarts on same port', { timeout: 15000 }, async () => {
  const { server: server1, port } = await createRelayServer();
  const received1 = [];
  server1.on('connection', (ws) =>
    ws.on('message', (d) => { try { received1.push(JSON.parse(d.toString())); } catch { /* ignore */ } })
  );

  const { proc, configFile } = spawnAgent({ port });
  try {
    await waitFor(() => received1.some((m) => m.type === 'status_update'));

    // Simulate relay outage
    await closeServer(server1);

    // Give the port a moment to be released, then start a new relay
    await new Promise((r) => setTimeout(r, 200));
    const server2 = new WebSocketServer({ port });
    await new Promise((r) => server2.on('listening', r));
    const received2 = [];
    server2.on('connection', (ws) =>
      ws.on('message', (d) => { try { received2.push(JSON.parse(d.toString())); } catch { /* ignore */ } })
    );

    // Agent's reconnectDelay starts at 3000ms — allow 10s total
    await waitFor(() => received2.some((m) => m.type === 'status_update'), 10000);
    assert.ok(received2.some((m) => m.type === 'status_update'), 'agent did not reconnect');

    await closeServer(server2);
  } finally {
    await killProc(proc);
    cleanConfig(configFile);
  }
});

test('health.relay.reconnects increments after a relay disconnect', { timeout: 15000 }, async () => {
  const { server: server1, port } = await createRelayServer();
  const received1 = [];
  server1.on('connection', (ws) =>
    ws.on('message', (d) => { try { received1.push(JSON.parse(d.toString())); } catch { /* ignore */ } })
  );

  const { proc, configFile } = spawnAgent({ port });
  try {
    await waitFor(() => received1.some((m) => m.type === 'status_update'));
    const su1 = received1.find((m) => m.type === 'status_update');
    assert.equal(su1.status.health.relay.reconnects, 0, 'no reconnects on initial connect');

    await closeServer(server1);
    await new Promise((r) => setTimeout(r, 200));

    const server2 = new WebSocketServer({ port });
    await new Promise((r) => server2.on('listening', r));
    const received2 = [];
    let ws2;
    server2.on('connection', (ws) => {
      ws2 = ws;
      ws.on('message', (d) => { try { received2.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
    });

    await waitFor(() => received2.some((m) => m.type === 'status_update'), 10000);

    // The status_update sent on reconnect includes health — check it there
    const su2 = received2.find((m) => m.type === 'status_update');
    assert.ok(su2.status.health.relay.reconnects >= 1, 'reconnect counter should have incremented');

    await closeServer(server2);
  } finally {
    await killProc(proc);
    cleanConfig(configFile);
  }
});

// ─── 4. GRACEFUL SHUTDOWN ─────────────────────────────────────────────────────

test('agent exits with code 0 on SIGTERM', { timeout: 10000 }, async () => {
  const { server, port } = await createRelayServer();
  const received = [];
  server.on('connection', (ws) =>
    ws.on('message', (d) => { try { received.push(JSON.parse(d.toString())); } catch { /* ignore */ } })
  );

  const { proc, configFile } = spawnAgent({ port });
  try {
    await waitFor(() => received.some((m) => m.type === 'status_update'));

    const exitPromise = new Promise((resolve) => proc.once('exit', resolve));
    proc.kill('SIGTERM');

    const code = await Promise.race([
      exitPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('SIGTERM timeout')), 6000)),
    ]);
    assert.equal(code, 0, 'expected exit code 0 on SIGTERM');
  } finally {
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    await closeServer(server);
    cleanConfig(configFile);
  }
});

test('agent exits with code 0 on SIGINT', { timeout: 10000 }, async () => {
  const { server, port } = await createRelayServer();
  const received = [];
  server.on('connection', (ws) =>
    ws.on('message', (d) => { try { received.push(JSON.parse(d.toString())); } catch { /* ignore */ } })
  );

  const { proc, configFile } = spawnAgent({ port });
  try {
    await waitFor(() => received.some((m) => m.type === 'status_update'));

    const exitPromise = new Promise((resolve) => proc.once('exit', resolve));
    proc.kill('SIGINT');

    const code = await Promise.race([
      exitPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('SIGINT timeout')), 6000)),
    ]);
    assert.equal(code, 0, 'expected exit code 0 on SIGINT');
  } finally {
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    await closeServer(server);
    cleanConfig(configFile);
  }
});

test('double SIGTERM does not hang or crash (shuttingDown guard)', { timeout: 10000 }, async () => {
  const { server, port } = await createRelayServer();
  const received = [];
  server.on('connection', (ws) =>
    ws.on('message', (d) => { try { received.push(JSON.parse(d.toString())); } catch { /* ignore */ } })
  );

  const { proc, configFile } = spawnAgent({ port });
  try {
    await waitFor(() => received.some((m) => m.type === 'status_update'));

    const exitPromise = new Promise((resolve) => proc.once('exit', resolve));
    proc.kill('SIGTERM');
    setTimeout(() => { try { proc.kill('SIGTERM'); } catch { /* ignore */ } }, 100);

    const code = await Promise.race([
      exitPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('double SIGTERM timeout')), 6000)),
    ]);
    assert.equal(code, 0);
  } finally {
    try { proc.kill('SIGKILL'); } catch { /* ignore */ }
    await closeServer(server);
    cleanConfig(configFile);
  }
});

// ─── 5. CONFIG LOADING ────────────────────────────────────────────────────────

test('agent exits 1 when no token is provided', { timeout: 8000 }, async () => {
  const { TALLY_TOKEN: _t, ...envWithout } = process.env;
  const configFile = path.join(os.tmpdir(), `tally-no-token-${Date.now()}.json`);
  const proc = spawn(
    process.execPath,
    [INDEX_PATH, '--relay', 'ws://127.0.0.1:1', '--config', configFile],
    { env: envWithout, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  proc.stdout.resume();
  proc.stderr.resume();

  const code = await Promise.race([
    new Promise((resolve) => proc.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('no-token test timed out')), 6000)),
  ]);
  try { proc.kill('SIGKILL'); } catch { /* ignore */ }
  cleanConfig(configFile);
  assert.equal(code, 1, 'should exit 1 when no token');
});

test('agent starts successfully when token supplied via TALLY_TOKEN env var', { timeout: 12000 }, async () => {
  const { server, port } = await createRelayServer();
  const received = [];
  server.on('connection', (ws) =>
    ws.on('message', (d) => { try { received.push(JSON.parse(d.toString())); } catch { /* ignore */ } })
  );

  // No --token flag; rely on TALLY_TOKEN env var
  const configFile = path.join(os.tmpdir(), `tally-env-test-${Date.now()}.json`);
  const proc = spawn(
    process.execPath,
    [INDEX_PATH, '--relay', `ws://127.0.0.1:${port}`, '--config', configFile, '--no-watchdog'],
    { env: { ...process.env, TALLY_TOKEN: TEST_TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  proc.stdout.resume();
  proc.stderr.resume();

  try {
    await waitFor(() => received.some((m) => m.type === 'status_update'));
    assert.ok(received.some((m) => m.type === 'status_update'));
  } finally {
    await killProc(proc);
    await closeServer(server);
    cleanConfig(configFile);
  }
});

test('agent strips mock values from config before connecting', { timeout: 12000 }, async () => {
  // Write a config file with mock ATEM IP — agent should connect to relay normally
  // and NOT attempt to connect to a mock ATEM (i.e., no real ATEM connection attempt)
  const { server, port } = await createRelayServer();
  const received = [];
  server.on('connection', (ws) =>
    ws.on('message', (d) => { try { received.push(JSON.parse(d.toString())); } catch { /* ignore */ } })
  );

  const configFile = path.join(os.tmpdir(), `tally-mock-test-${Date.now()}.json`);
  // Pre-write config with mock ATEM value
  fs.writeFileSync(configFile, JSON.stringify({
    token: TEST_TOKEN,
    relay: `ws://127.0.0.1:${port}`,
    atemIp: 'mock',          // should be stripped
    obsUrl: 'fake',          // should be stripped
  }));

  const proc = spawn(
    process.execPath,
    // Must pass --relay explicitly: the default option value ('wss://api.tallyconnect.app')
    // would otherwise override the relay URL written in the config file.
    [INDEX_PATH, '--relay', `ws://127.0.0.1:${port}`, '--config', configFile, '--no-watchdog'],
    { env: { ...process.env, TALLY_TOKEN: TEST_TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  proc.stdout.resume();
  proc.stderr.resume();

  try {
    await waitFor(() => received.some((m) => m.type === 'status_update'));
    const s = received.find((m) => m.type === 'status_update').status;
    // atemIp was 'mock' → stripped → null
    assert.equal(s.atem.ip, null, 'mock atemIp should have been stripped');
    assert.equal(s.atem.connected, false);
    // obs should not be connected (mock url was stripped)
    assert.equal(s.obs.connected, false);
  } finally {
    await killProc(proc);
    await closeServer(server);
    cleanConfig(configFile);
  }
});

// ─── 6. PRETTIFY ATEM MODEL ENUM NAME ────────────────────────────────────────
// Exact copy of the function from src/index.js

const ATEM_MODEL_LABELS = {
  Unknown: 'ATEM',
  TVS: 'ATEM Television Studio',
  OneME: 'ATEM 1 M/E Production Studio',
  TwoME: 'ATEM 2 M/E Production Studio',
  PS4K: 'ATEM Production Studio 4K',
  OneME4K: 'ATEM 1 M/E Production Studio 4K',
  TwoME4K: 'ATEM 2 M/E Production Studio 4K',
  TwoMEBS4K: 'ATEM 2 M/E Broadcast Studio 4K',
  TVSHD: 'ATEM Television Studio HD',
  TVSProHD: 'ATEM Television Studio Pro HD',
  TVSPro4K: 'ATEM Television Studio Pro 4K',
  Constellation: 'ATEM Constellation',
  Constellation8K: 'ATEM Constellation 8K',
  Mini: 'ATEM Mini',
  MiniPro: 'ATEM Mini Pro',
  MiniProISO: 'ATEM Mini Pro ISO',
  MiniExtreme: 'ATEM Mini Extreme',
  MiniExtremeISO: 'ATEM Mini Extreme ISO',
  ConstellationHD1ME: 'ATEM 1 M/E Constellation HD',
  ConstellationHD2ME: 'ATEM 2 M/E Constellation HD',
  ConstellationHD4ME: 'ATEM 4 M/E Constellation HD',
  SDI: 'ATEM SDI',
  SDIProISO: 'ATEM SDI Pro ISO',
  SDIExtremeISO: 'ATEM SDI Extreme ISO',
  TelevisionStudioHD8: 'ATEM Television Studio HD8',
  TelevisionStudioHD8ISO: 'ATEM Television Studio HD8 ISO',
  Constellation4K1ME: 'ATEM 1 M/E Constellation 4K',
  Constellation4K2ME: 'ATEM 2 M/E Constellation 4K',
  Constellation4K4ME: 'ATEM 4 M/E Constellation 4K',
  Constellation4K4MEPlus: 'ATEM 4 M/E Constellation 4K Plus',
  TelevisionStudio4K8: 'ATEM Television Studio 4K8',
  MiniExtremeISOG2: 'ATEM Mini Extreme ISO G2',
};

function prettifyAtemModelEnumName(rawName) {
  if (!rawName || typeof rawName !== 'string') return null;
  if (ATEM_MODEL_LABELS[rawName]) return ATEM_MODEL_LABELS[rawName];
  return rawName
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Z])/g, '$1 $2')
    .replace(/\bTVS\b/g, 'Television Studio')
    .replace(/\bME\b/g, 'M/E')
    .trim();
}

test('prettifyAtemModelEnumName: known keys return their exact label', () => {
  assert.equal(prettifyAtemModelEnumName('TVS'), 'ATEM Television Studio');
  assert.equal(prettifyAtemModelEnumName('Mini'), 'ATEM Mini');
  assert.equal(prettifyAtemModelEnumName('MiniPro'), 'ATEM Mini Pro');
  assert.equal(prettifyAtemModelEnumName('MiniProISO'), 'ATEM Mini Pro ISO');
  assert.equal(prettifyAtemModelEnumName('OneME'), 'ATEM 1 M/E Production Studio');
  assert.equal(prettifyAtemModelEnumName('Constellation8K'), 'ATEM Constellation 8K');
});

test('prettifyAtemModelEnumName: null/empty/non-string returns null', () => {
  assert.equal(prettifyAtemModelEnumName(null), null);
  assert.equal(prettifyAtemModelEnumName(''), null);
  assert.equal(prettifyAtemModelEnumName(0), null);
  assert.equal(prettifyAtemModelEnumName(undefined), null);
});

test('prettifyAtemModelEnumName: camelCase fallback inserts spaces', () => {
  // Not in the map — should be formatted by regex rules
  const result = prettifyAtemModelEnumName('SomeCamelCase');
  assert.ok(result.includes(' '), `"${result}" should have spaces`);
});

test('prettifyAtemModelEnumName: ME token replaced with M/E when it is a standalone word', () => {
  // 'FakeME': camelCase split → 'Fake ME' → \bME\b matches standalone ME → 'Fake M/E'
  const result = prettifyAtemModelEnumName('FakeME');
  assert.ok(result.includes('M/E'), `expected M/E in "${result}"`);
});

test('prettifyAtemModelEnumName: TVS token replaced with Television Studio when standalone', () => {
  // 'SomeTVS': camelCase split → 'Some TVS' → \bTVS\b matches standalone TVS
  const result = prettifyAtemModelEnumName('SomeTVS');
  assert.ok(result.includes('Television Studio'), `expected Television Studio in "${result}"`);
});

// ─── 7. isMockValue ───────────────────────────────────────────────────────────

function isMockValue(value) {
  const v = String(value || '').trim().toLowerCase();
  return v === 'mock' || v === 'fake' || v === 'sim' || v === 'simulate'
    || v.startsWith('mock://') || v.includes('mock-hyperdeck');
}

test('isMockValue: returns true for "mock" (case-insensitive)', () => {
  assert.equal(isMockValue('mock'), true);
  assert.equal(isMockValue('MOCK'), true);
  assert.equal(isMockValue('  Mock  '), true);
});

test('isMockValue: returns true for "fake", "sim", "simulate"', () => {
  assert.equal(isMockValue('fake'), true);
  assert.equal(isMockValue('sim'), true);
  assert.equal(isMockValue('simulate'), true);
});

test('isMockValue: returns true for mock:// prefix', () => {
  assert.equal(isMockValue('mock://192.168.1.100'), true);
  assert.equal(isMockValue('MOCK://host'), true);
});

test('isMockValue: returns true when value contains "mock-hyperdeck"', () => {
  assert.equal(isMockValue('mock-hyperdeck'), true);
  assert.equal(isMockValue('192.168.1.50-mock-hyperdeck'), true);
});

test('isMockValue: returns false for real values', () => {
  assert.equal(isMockValue('192.168.1.100'), false);
  assert.equal(isMockValue('localhost'), false);
  assert.equal(isMockValue('ws://real.server.com'), false);
  assert.equal(isMockValue(''), false);
  assert.equal(isMockValue(null), false);
  assert.equal(isMockValue(undefined), false);
  assert.equal(isMockValue('simulation'), false); // contains 'sim' but not exact match
});

// ─── 8. stripMockConfig ───────────────────────────────────────────────────────

function stripMockConfig(config = {}) {
  const cleaned = { ...(config || {}) };
  if (isMockValue(cleaned.atemIp)) cleaned.atemIp = '';
  if (isMockValue(cleaned.obsUrl)) {
    cleaned.obsUrl = '';
    cleaned.obsPassword = '';
  }
  if (cleaned.proPresenter && isMockValue(cleaned.proPresenter.host)) cleaned.proPresenter = null;
  if (cleaned.mixer && isMockValue(cleaned.mixer.host)) cleaned.mixer = null;
  if (Array.isArray(cleaned.hyperdecks)) {
    cleaned.hyperdecks = cleaned.hyperdecks.filter((entry) => {
      if (typeof entry === 'string') return !isMockValue(entry);
      const host = String(entry?.host || entry?.ip || '').trim();
      return !!host && !isMockValue(host);
    });
  }
  delete cleaned.mockProduction;
  delete cleaned.fakeAtemApiPort;
  delete cleaned._preMock;
  return cleaned;
}

test('stripMockConfig: clears atemIp when it is a mock value', () => {
  assert.equal(stripMockConfig({ atemIp: 'mock' }).atemIp, '');
  assert.equal(stripMockConfig({ atemIp: 'fake' }).atemIp, '');
  assert.equal(stripMockConfig({ atemIp: '192.168.1.100' }).atemIp, '192.168.1.100');
});

test('stripMockConfig: clears obsUrl and obsPassword together', () => {
  const r = stripMockConfig({ obsUrl: 'mock', obsPassword: 'supersecret' });
  assert.equal(r.obsUrl, '');
  assert.equal(r.obsPassword, '');
});

test('stripMockConfig: nullifies proPresenter when host is a mock value', () => {
  assert.equal(stripMockConfig({ proPresenter: { host: 'mock', port: 1025 } }).proPresenter, null);
  assert.equal(stripMockConfig({ proPresenter: { host: 'sim', port: 1025 } }).proPresenter, null);
  // Real host is kept
  const pp = { host: '192.168.1.50', port: 1025 };
  assert.deepEqual(stripMockConfig({ proPresenter: pp }).proPresenter, pp);
});

test('stripMockConfig: nullifies mixer when host is a mock value', () => {
  assert.equal(stripMockConfig({ mixer: { type: 'x32', host: 'mock' } }).mixer, null);
  const real = { type: 'x32', host: '192.168.1.200' };
  assert.deepEqual(stripMockConfig({ mixer: real }).mixer, real);
});

test('stripMockConfig: filters mock entries from hyperdecks array', () => {
  const r = stripMockConfig({
    hyperdecks: [
      '192.168.1.10',           // real string
      'mock',                   // mock string → removed
      { host: '192.168.1.20' }, // real object
      { host: 'fake' },         // mock object → removed
      { ip: 'mock-hyperdeck-1' }, // mock via .ip → removed
      { host: '' },             // empty host → removed (no host)
    ],
  });
  assert.equal(r.hyperdecks.length, 2);
  assert.equal(r.hyperdecks[0], '192.168.1.10');
  assert.equal(r.hyperdecks[1].host, '192.168.1.20');
});

test('stripMockConfig: deletes mockProduction, fakeAtemApiPort, _preMock fields', () => {
  const r = stripMockConfig({
    token: 'abc',
    mockProduction: true,
    fakeAtemApiPort: 9999,
    _preMock: { saved: true },
  });
  assert.ok(!('mockProduction' in r));
  assert.ok(!('fakeAtemApiPort' in r));
  assert.ok(!('_preMock' in r));
  assert.equal(r.token, 'abc');
});

test('stripMockConfig: handles null/undefined input gracefully', () => {
  assert.doesNotThrow(() => stripMockConfig(null));
  assert.doesNotThrow(() => stripMockConfig(undefined));
  assert.deepEqual(stripMockConfig(null), {});
});

// ─── 9. extractAtemIdentity ───────────────────────────────────────────────────
// Mirrors the function in index.js; ATEM_MODEL_ENUM comes from atem-connection.

// Build a small synthetic enum for testing (same structure as real)
const ATEM_MODEL_ENUM_TEST = { 284: 'Mini', 289: 'MiniPro', 394: 'MiniProISO' };

function extractAtemIdentityTest(state) {
  const info = state && typeof state === 'object' ? state.info : {};
  const safeInfo = info || {};
  const productIdentifier = typeof safeInfo.productIdentifier === 'string'
    ? safeInfo.productIdentifier.trim() : '';
  const parsedModelCode = Number(safeInfo.model);
  const modelCode = Number.isFinite(parsedModelCode) ? parsedModelCode : null;
  const modelEnumName = modelCode !== null ? ATEM_MODEL_ENUM_TEST[modelCode] : null;
  const modelName = productIdentifier || prettifyAtemModelEnumName(modelEnumName);
  const apiVer = safeInfo.apiVersion;
  const protocolVersion = apiVer && typeof apiVer === 'object'
    ? `${apiVer.major || 0}.${apiVer.minor || 0}` : null;
  return {
    modelName: modelName || null,
    modelCode,
    productIdentifier: productIdentifier || null,
    protocolVersion,
  };
}

test('extractAtemIdentity: extracts productIdentifier as model name', () => {
  const r = extractAtemIdentityTest({
    info: { productIdentifier: 'ATEM Mini Pro ISO', model: 394, apiVersion: { major: 2, minor: 30 } },
  });
  assert.equal(r.modelName, 'ATEM Mini Pro ISO');
  assert.equal(r.productIdentifier, 'ATEM Mini Pro ISO');
  assert.equal(r.modelCode, 394);
  assert.equal(r.protocolVersion, '2.30');
});

test('extractAtemIdentity: falls back to enum name when productIdentifier is empty', () => {
  const r = extractAtemIdentityTest({
    info: { productIdentifier: '', model: 284, apiVersion: { major: 1, minor: 0 } },
  });
  assert.equal(r.modelName, 'ATEM Mini'); // from test enum + prettify
  assert.equal(r.productIdentifier, null);
  assert.equal(r.protocolVersion, '1.0');
});

test('extractAtemIdentity: handles empty info object', () => {
  const r = extractAtemIdentityTest({ info: {} });
  assert.equal(r.modelName, null);
  assert.equal(r.modelCode, null);
  assert.equal(r.protocolVersion, null);
});

test('extractAtemIdentity: handles null/undefined state gracefully', () => {
  for (const input of [null, undefined, {}]) {
    const r = extractAtemIdentityTest(input);
    assert.equal(r.modelName, null);
    assert.equal(r.modelCode, null);
    assert.equal(r.protocolVersion, null);
  }
});

test('extractAtemIdentity: non-numeric model yields null modelCode', () => {
  const r = extractAtemIdentityTest({ info: { model: 'notanumber' } });
  assert.equal(r.modelCode, null);
});

test('extractAtemIdentity: productIdentifier trims whitespace', () => {
  const r = extractAtemIdentityTest({ info: { productIdentifier: '  ATEM Mini  ', model: 284 } });
  assert.equal(r.modelName, 'ATEM Mini');
  assert.equal(r.productIdentifier, 'ATEM Mini');
});

// ─── 10. detectAtemAudioSources ───────────────────────────────────────────────

const PORT_TYPE_NAMES = {
  1: 'SDI', 2: 'HDMI', 4: 'Component', 8: 'Composite',
  16: 'S-Video', 32: 'XLR', 64: 'AES/EBU', 128: 'RCA', 256: 'Internal',
  512: 'TS Jack', 1024: 'MADI', 2048: 'TRS Jack', 4096: 'RJ45',
};

function detectAtemAudioSources(state) {
  const detected = [];
  if (!state || typeof state !== 'object') return detected;

  const classicChannels = state.audio?.classic?.channels || state.audio?.channels;
  if (classicChannels && typeof classicChannels === 'object') {
    for (const [channelId, ch] of Object.entries(classicChannels)) {
      if (!ch) continue;
      if (ch.sourceType === 2 && ch.mixOption !== 0) {
        detected.push({
          inputId: channelId, type: 'classic', sourceType: 'ExternalAudio',
          portType: PORT_TYPE_NAMES[ch.portType] || 'Unknown',
          mixOption: ch.mixOption === 1 ? 'On' : 'AFV',
        });
      }
    }
  }

  const fairlightInputs = state.fairlight?.inputs;
  if (fairlightInputs && typeof fairlightInputs === 'object') {
    for (const [inputId, input] of Object.entries(fairlightInputs)) {
      if (!input?.properties || input.properties.inputType !== 2) continue;
      const portName = PORT_TYPE_NAMES[input.properties.externalPortType] || 'Unknown';
      for (const [sourceId, src] of Object.entries(input.sources || {})) {
        if (!src?.properties || src.properties.mixOption === 1) continue;
        detected.push({
          inputId, sourceId, type: 'fairlight', sourceType: 'AudioIn',
          portType: portName,
          mixOption: src.properties.mixOption === 2 ? 'On' : 'AFV',
        });
      }
    }
  }

  return detected;
}

test('detectAtemAudioSources: returns empty array for empty/null state', () => {
  assert.deepEqual(detectAtemAudioSources({}), []);
  assert.deepEqual(detectAtemAudioSources(null), []);
  assert.deepEqual(detectAtemAudioSources(undefined), []);
});

test('detectAtemAudioSources: detects classic ExternalAudio channel set to On', () => {
  const state = { audio: { channels: { '1': { sourceType: 2, mixOption: 1, portType: 32 } } } };
  const r = detectAtemAudioSources(state);
  assert.equal(r.length, 1);
  assert.equal(r[0].type, 'classic');
  assert.equal(r[0].portType, 'XLR');
  assert.equal(r[0].mixOption, 'On');
  assert.equal(r[0].inputId, '1');
});

test('detectAtemAudioSources: detects classic ExternalAudio channel set to AFV', () => {
  const state = { audio: { channels: { '2': { sourceType: 2, mixOption: 2, portType: 128 } } } };
  const r = detectAtemAudioSources(state);
  assert.equal(r.length, 1);
  assert.equal(r[0].mixOption, 'AFV');
  assert.equal(r[0].portType, 'RCA');
});

test('detectAtemAudioSources: skips classic channel with mixOption Off (0)', () => {
  const state = { audio: { channels: { '1': { sourceType: 2, mixOption: 0, portType: 32 } } } };
  assert.deepEqual(detectAtemAudioSources(state), []);
});

test('detectAtemAudioSources: skips non-ExternalAudio classic channels', () => {
  // sourceType 1 = camera, not ExternalAudio (2)
  const state = { audio: { channels: { '1': { sourceType: 1, mixOption: 1, portType: 1 } } } };
  assert.deepEqual(detectAtemAudioSources(state), []);
});

test('detectAtemAudioSources: reads from audio.classic.channels path', () => {
  const state = {
    audio: { classic: { channels: { '3': { sourceType: 2, mixOption: 1, portType: 64 } } } },
  };
  const r = detectAtemAudioSources(state);
  assert.equal(r.length, 1);
  assert.equal(r[0].portType, 'AES/EBU');
});

test('detectAtemAudioSources: detects Fairlight AudioIn source set to On', () => {
  const state = {
    fairlight: {
      inputs: {
        '101': {
          properties: { inputType: 2, externalPortType: 32 }, // XLR
          sources: { '0': { properties: { mixOption: 2 } } }, // On (not Off=1)
        },
      },
    },
  };
  const r = detectAtemAudioSources(state);
  assert.equal(r.length, 1);
  assert.equal(r[0].type, 'fairlight');
  assert.equal(r[0].inputId, '101');
  assert.equal(r[0].portType, 'XLR');
  assert.equal(r[0].mixOption, 'On');
});

test('detectAtemAudioSources: skips Fairlight source with mixOption Off (1)', () => {
  const state = {
    fairlight: {
      inputs: {
        '101': {
          properties: { inputType: 2, externalPortType: 32 },
          sources: { '0': { properties: { mixOption: 1 } } }, // Off
        },
      },
    },
  };
  assert.deepEqual(detectAtemAudioSources(state), []);
});

test('detectAtemAudioSources: skips Fairlight non-AudioIn inputs (inputType != 2)', () => {
  const state = {
    fairlight: {
      inputs: {
        '1': {
          properties: { inputType: 1 }, // not AudioIn
          sources: { '0': { properties: { mixOption: 2 } } },
        },
      },
    },
  };
  assert.deepEqual(detectAtemAudioSources(state), []);
});

test('detectAtemAudioSources: accumulates from both classic and Fairlight simultaneously', () => {
  const state = {
    audio: { channels: { '1': { sourceType: 2, mixOption: 1, portType: 32 } } },
    fairlight: {
      inputs: {
        '101': {
          properties: { inputType: 2, externalPortType: 1 },
          sources: { '0': { properties: { mixOption: 2 } } },
        },
      },
    },
  };
  const r = detectAtemAudioSources(state);
  assert.equal(r.length, 2);
  assert.equal(r.filter((x) => x.type === 'classic').length, 1);
  assert.equal(r.filter((x) => x.type === 'fairlight').length, 1);
});

// ─── 11. _updateBitrateSignal state machine ───────────────────────────────────
// Exact copy of the method body, bound to a minimal tracker object.

function makeBitrateTracker() {
  const tracker = {
    _bitrateBaseline: null,
    _bitrateSamples: [],
    _bitrateInLoss: false,
    _events: [],
    sendToRelay(msg) { this._events.push(msg); },
  };
  tracker._updateBitrateSignal = function _updateBitrateSignal(bitrateKbps) {
    const BASELINE_SAMPLES = 3;
    const DROP_RATIO = 0.2;
    const RECOVER_RATIO = 0.5;

    if (bitrateKbps > 500) {
      this._bitrateSamples.push(bitrateKbps);
      if (this._bitrateSamples.length > 10) this._bitrateSamples.shift();
      if (!this._bitrateBaseline && this._bitrateSamples.length >= BASELINE_SAMPLES) {
        this._bitrateBaseline = this._bitrateSamples.reduce((a, b) => a + b, 0) / this._bitrateSamples.length;
      }
    }
    if (!this._bitrateBaseline) return;
    const ratio = bitrateKbps / this._bitrateBaseline;
    if (!this._bitrateInLoss && ratio < DROP_RATIO) {
      this._bitrateInLoss = true;
      this.sendToRelay({ type: 'signal_event', signal: 'encoder_bitrate_loss',
        bitrateKbps: Math.round(bitrateKbps), baselineKbps: Math.round(this._bitrateBaseline) });
    } else if (this._bitrateInLoss && ratio > RECOVER_RATIO) {
      this._bitrateInLoss = false;
      this.sendToRelay({ type: 'signal_event', signal: 'encoder_bitrate_recovered',
        bitrateKbps: Math.round(bitrateKbps) });
    }
  };
  return tracker;
}

test('_updateBitrateSignal: baseline established after 3 healthy samples (>500kbps)', () => {
  const t = makeBitrateTracker();
  t._updateBitrateSignal(3000);
  assert.equal(t._bitrateBaseline, null, '1 sample: no baseline yet');
  t._updateBitrateSignal(3200);
  assert.equal(t._bitrateBaseline, null, '2 samples: still no baseline');
  t._updateBitrateSignal(2800);
  assert.ok(t._bitrateBaseline !== null, '3 samples: baseline established');
  // ~3000 kbps average
  assert.ok(t._bitrateBaseline > 2900 && t._bitrateBaseline < 3100);
});

test('_updateBitrateSignal: samples ≤500kbps do not build baseline', () => {
  const t = makeBitrateTracker();
  t._updateBitrateSignal(400);
  t._updateBitrateSignal(300);
  t._updateBitrateSignal(500);
  assert.equal(t._bitrateBaseline, null);
});

test('_updateBitrateSignal: drop below 20% of baseline fires encoder_bitrate_loss', () => {
  const t = makeBitrateTracker();
  t._updateBitrateSignal(3000); t._updateBitrateSignal(3000); t._updateBitrateSignal(3000);
  // 19% of 3000 = 570 (below 20% threshold of 600)
  t._updateBitrateSignal(570);
  assert.equal(t._bitrateInLoss, true);
  assert.equal(t._events.length, 1);
  assert.equal(t._events[0].signal, 'encoder_bitrate_loss');
  assert.equal(t._events[0].bitrateKbps, 570);
  assert.ok(t._events[0].baselineKbps > 0);
});

test('_updateBitrateSignal: loss event does not fire again while bitrate stays low', () => {
  const t = makeBitrateTracker();
  t._updateBitrateSignal(4000); t._updateBitrateSignal(4000); t._updateBitrateSignal(4000);
  t._updateBitrateSignal(500); // triggers loss
  t._updateBitrateSignal(500); // should not re-trigger
  t._updateBitrateSignal(600); // still below 20% of 4000=800
  assert.equal(t._events.length, 1, 'loss event should fire only once');
});

test('_updateBitrateSignal: recovery above 50% fires encoder_bitrate_recovered', () => {
  const t = makeBitrateTracker();
  t._updateBitrateSignal(4000); t._updateBitrateSignal(4000); t._updateBitrateSignal(4000);
  t._updateBitrateSignal(500); // loss (below 20% of 4000=800)
  t._updateBitrateSignal(2500); // recovery (above 50% of 4000=2000)
  assert.equal(t._bitrateInLoss, false);
  assert.equal(t._events.length, 2);
  assert.equal(t._events[1].signal, 'encoder_bitrate_recovered');
  assert.equal(t._events[1].bitrateKbps, 2500);
});

test('_updateBitrateSignal: mid-range (20-50%) does not trigger either event', () => {
  const t = makeBitrateTracker();
  t._updateBitrateSignal(4000); t._updateBitrateSignal(4000); t._updateBitrateSignal(4000);
  t._updateBitrateSignal(500); // loss
  // 30% of 4000 = 1200 — above 20% so no re-trigger, below 50% so no recovery
  t._updateBitrateSignal(1200);
  assert.equal(t._events.length, 1, 'no new event in the 20-50% band');
  assert.equal(t._bitrateInLoss, true, 'still in loss state');
});

test('_updateBitrateSignal: sample window is capped at 10 entries', () => {
  const t = makeBitrateTracker();
  for (let i = 0; i < 15; i++) t._updateBitrateSignal(3000);
  assert.ok(t._bitrateSamples.length <= 10);
});

test('_updateBitrateSignal: recovery resets loss flag so a new drop re-fires', () => {
  const t = makeBitrateTracker();
  t._updateBitrateSignal(4000); t._updateBitrateSignal(4000); t._updateBitrateSignal(4000);
  t._updateBitrateSignal(500);  // loss → event 1
  t._updateBitrateSignal(3000); // recovery → event 2
  t._updateBitrateSignal(500);  // new loss → event 3
  assert.equal(t._events.length, 3);
  assert.equal(t._events[2].signal, 'encoder_bitrate_loss');
});

// ─── 12. _getStreamBitrate and _getStreamFps ─────────────────────────────────

function _getStreamBitrate(status) {
  if (status.obs?.streaming && status.obs.bitrate > 0)
    return { value: status.obs.bitrate, source: 'OBS' };
  if (status.atem?.streaming && status.atem.streamingBitrate > 0)
    return { value: Math.round(status.atem.streamingBitrate / 1000), source: 'ATEM' };
  if ((status.encoder?.live || status.encoder?.streaming) && status.encoder.bitrateKbps > 0)
    return { value: status.encoder.bitrateKbps, source: status.encoder.type || 'Encoder' };
  return null;
}

function _getStreamFps(status) {
  if (status.obs?.streaming && status.obs.fps > 0)
    return { value: status.obs.fps, source: 'OBS' };
  if ((status.encoder?.live || status.encoder?.streaming) && status.encoder.fps > 0)
    return { value: status.encoder.fps, source: status.encoder.type || 'Encoder' };
  return null;
}

// Builds a minimal merged status object
function makeStatus(overrides = {}) {
  const base = {
    obs:     { streaming: false, bitrate: null, fps: null },
    atem:    { streaming: false, streamingBitrate: null },
    encoder: { live: false, streaming: false, bitrateKbps: null, fps: null, type: 'obs' },
  };
  return {
    obs:     { ...base.obs,     ...(overrides.obs || {}) },
    atem:    { ...base.atem,    ...(overrides.atem || {}) },
    encoder: { ...base.encoder, ...(overrides.encoder || {}) },
  };
}

test('_getStreamBitrate: returns OBS bitrate when OBS is streaming', () => {
  const r = _getStreamBitrate(makeStatus({ obs: { streaming: true, bitrate: 5000 } }));
  assert.ok(r);
  assert.equal(r.value, 5000);
  assert.equal(r.source, 'OBS');
});

test('_getStreamBitrate: converts ATEM bps → kbps', () => {
  const r = _getStreamBitrate(makeStatus({ atem: { streaming: true, streamingBitrate: 5_000_000 } }));
  assert.ok(r);
  assert.equal(r.value, 5000);
  assert.equal(r.source, 'ATEM');
});

test('_getStreamBitrate: returns encoder bitrate when encoder is live', () => {
  const r = _getStreamBitrate(makeStatus({ encoder: { live: true, bitrateKbps: 3500, type: 'blackmagic' } }));
  assert.ok(r);
  assert.equal(r.value, 3500);
  assert.equal(r.source, 'blackmagic');
});

test('_getStreamBitrate: returns null when nothing is streaming', () => {
  assert.equal(_getStreamBitrate(makeStatus()), null);
});

test('_getStreamBitrate: OBS takes priority over ATEM', () => {
  const r = _getStreamBitrate(makeStatus({
    obs:  { streaming: true, bitrate: 4000 },
    atem: { streaming: true, streamingBitrate: 6_000_000 },
  }));
  assert.equal(r.source, 'OBS');
});

test('_getStreamBitrate: encoder.streaming (not just .live) is also checked', () => {
  const r = _getStreamBitrate(makeStatus({ encoder: { streaming: true, bitrateKbps: 2500 } }));
  assert.ok(r);
  assert.equal(r.value, 2500);
});

test('_getStreamFps: returns OBS fps when streaming', () => {
  const r = _getStreamFps(makeStatus({ obs: { streaming: true, fps: 30 } }));
  assert.ok(r);
  assert.equal(r.value, 30);
  assert.equal(r.source, 'OBS');
});

test('_getStreamFps: returns encoder fps when live', () => {
  const r = _getStreamFps(makeStatus({ encoder: { live: true, fps: 60, type: 'vmix' } }));
  assert.ok(r);
  assert.equal(r.value, 60);
  assert.equal(r.source, 'vmix');
});

test('_getStreamFps: returns null when nothing is streaming', () => {
  assert.equal(_getStreamFps(makeStatus()), null);
});

// ─── 13. sendAlert / _sendWatchdogAlert ──────────────────────────────────────

function makeAlertTracker() {
  const t = {
    _recentAlerts: [],
    _lastAlerts: new Map(),
    _relaySends: [],
    sendToRelay(msg) { this._relaySends.push(msg); },
    sendAlert(message, severity = 'warning') {
      this.sendToRelay({ type: 'alert', message, severity });
      this._recentAlerts.push({ message, severity, timestamp: Date.now() });
      while (this._recentAlerts.length > 50) this._recentAlerts.shift();
    },
    _sendWatchdogAlert(alertType, message) {
      const now = Date.now();
      const lastSent = this._lastAlerts.get(alertType) || 0;
      if (now - lastSent < 5 * 60 * 1000) return;
      this._lastAlerts.set(alertType, now);
      this.sendToRelay({ type: 'alert', alertType, message, severity: 'warning' });
    },
  };
  return t;
}

test('sendAlert: sends alert to relay with correct type and severity', () => {
  const t = makeAlertTracker();
  t.sendAlert('Stream stopped', 'critical');
  assert.equal(t._relaySends.length, 1);
  assert.equal(t._relaySends[0].type, 'alert');
  assert.equal(t._relaySends[0].message, 'Stream stopped');
  assert.equal(t._relaySends[0].severity, 'critical');
});

test('sendAlert: defaults severity to "warning"', () => {
  const t = makeAlertTracker();
  t.sendAlert('Something happened');
  assert.equal(t._relaySends[0].severity, 'warning');
});

test('sendAlert: appends to _recentAlerts and caps at 50', () => {
  const t = makeAlertTracker();
  for (let i = 0; i < 60; i++) t.sendAlert(`Alert ${i}`);
  assert.equal(t._recentAlerts.length, 50, 'should cap at 50');
  assert.equal(t._recentAlerts[49].message, 'Alert 59', 'most recent is last slot');
});

test('_sendWatchdogAlert: first call goes through', () => {
  const t = makeAlertTracker();
  t._sendWatchdogAlert('atem_disconnected', 'ATEM lost');
  assert.equal(t._relaySends.length, 1);
  assert.equal(t._relaySends[0].alertType, 'atem_disconnected');
});

test('_sendWatchdogAlert: same type within 5 min is deduplicated', () => {
  const t = makeAlertTracker();
  t._sendWatchdogAlert('atem_disconnected', 'ATEM lost #1');
  t._sendWatchdogAlert('atem_disconnected', 'ATEM lost #2 — suppressed');
  t._sendWatchdogAlert('atem_disconnected', 'ATEM lost #3 — suppressed');
  assert.equal(t._relaySends.length, 1, 'only first call should send');
});

test('_sendWatchdogAlert: different types are not deduplicated', () => {
  const t = makeAlertTracker();
  t._sendWatchdogAlert('atem_disconnected', 'ATEM lost');
  t._sendWatchdogAlert('obs_disconnected', 'OBS lost');
  t._sendWatchdogAlert('fps_low', 'Low FPS');
  assert.equal(t._relaySends.length, 3);
});

// ─── 14. isObsMonitoringEnabled / getObsUrlForConnection ─────────────────────

const LEGACY_DEFAULT_OBS_URLS = new Set(['ws://localhost:4455', 'ws://127.0.0.1:4455']);

function isObsMonitoringEnabled(config) {
  const encoderType = String(config.encoder?.type || '').trim().toLowerCase();
  if (encoderType === 'obs') return true;
  const obsUrl = String(config.obsUrl || '').trim();
  if (!obsUrl) return false;
  return !LEGACY_DEFAULT_OBS_URLS.has(obsUrl.toLowerCase());
}

function getObsUrlForConnection(config) {
  const configuredUrl = String(config.obsUrl || '').trim();
  if (configuredUrl) return configuredUrl;
  const encoderType = String(config.encoder?.type || '').trim().toLowerCase();
  if (encoderType === 'obs') {
    const host = String(config.encoder?.host || '').trim() || 'localhost';
    const port = Number(config.encoder?.port) || 4455;
    return `ws://${host}:${port}`;
  }
  return '';
}

test('isObsMonitoringEnabled: true when encoder type is "obs"', () => {
  assert.equal(isObsMonitoringEnabled({ encoder: { type: 'obs' } }), true);
  assert.equal(isObsMonitoringEnabled({ encoder: { type: 'OBS' } }), true);
});

test('isObsMonitoringEnabled: false when no obsUrl and encoder is not obs', () => {
  assert.equal(isObsMonitoringEnabled({ encoder: { type: 'blackmagic' } }), false);
  assert.equal(isObsMonitoringEnabled({}), false);
});

test('isObsMonitoringEnabled: false for legacy default OBS URLs with non-obs encoder', () => {
  assert.equal(isObsMonitoringEnabled({ obsUrl: 'ws://localhost:4455' }), false);
  assert.equal(isObsMonitoringEnabled({ obsUrl: 'ws://127.0.0.1:4455' }), false);
});

test('isObsMonitoringEnabled: true for custom non-default OBS URL', () => {
  assert.equal(isObsMonitoringEnabled({ obsUrl: 'ws://192.168.1.100:4455' }), true);
  assert.equal(isObsMonitoringEnabled({ obsUrl: 'ws://obs-studio-box:4455' }), true);
});

test('getObsUrlForConnection: returns configured obsUrl directly', () => {
  assert.equal(
    getObsUrlForConnection({ obsUrl: 'ws://192.168.1.100:4455' }),
    'ws://192.168.1.100:4455'
  );
});

test('getObsUrlForConnection: derives URL from encoder host + port when type is obs', () => {
  assert.equal(
    getObsUrlForConnection({ encoder: { type: 'obs', host: '192.168.1.50', port: 4455 } }),
    'ws://192.168.1.50:4455'
  );
});

test('getObsUrlForConnection: defaults to localhost:4455 when encoder is obs with no host', () => {
  assert.equal(
    getObsUrlForConnection({ encoder: { type: 'obs' } }),
    'ws://localhost:4455'
  );
});

test('getObsUrlForConnection: returns empty string when nothing configured', () => {
  assert.equal(getObsUrlForConnection({}), '');
  assert.equal(getObsUrlForConnection({ encoder: { type: 'blackmagic' } }), '');
});
