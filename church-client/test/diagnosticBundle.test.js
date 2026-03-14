const test = require('node:test');
const assert = require('node:assert/strict');

const { collectDiagnosticBundle } = require('../src/diagnosticBundle');

// ─── Helper: build a minimal mock agent ──────────────────────────────────────

function createMockAgent(overrides = {}) {
  const WebSocket = require('ws');
  return {
    relay: overrides.relay ?? { readyState: WebSocket.OPEN },
    config: overrides.config ?? { relay: 'wss://test.relay', token: 'mock-token', autoRecovery: true },
    churchId: overrides.churchId ?? 'church-123',
    status: overrides.status ?? {
      atem: { connected: true, model: 'ATEM Mini Pro', ip: '192.168.1.100', programInput: 1, previewInput: 2 },
      obs: { connected: false, version: null, streaming: false, recording: false },
      encoder: { connected: true, live: true, bitrateKbps: 4500, type: 'OBS', congestion: 0.01 },
      companion: { connected: false, endpoint: null },
      vmix: { connected: false },
      mixer: { connected: false, type: null },
      ptz: [],
      hyperdeck: { connected: false },
      audio: { monitoring: true, lastLevel: -18, silenceDetected: false },
      streamHealth: { monitoring: true },
      system: { hostname: 'church-pc', platform: 'win32', uptime: 3600 },
    },
    health: overrides.health ?? {
      relay: { latencyMs: 42, reconnects: 0 },
      atem: { latencyMs: 5, commandsTotal: 100, commandsOk: 99, commandsFailed: 1, reconnects: 0 },
    },
    obs: overrides.obs ?? null,
    atem: overrides.atem ?? {},
    vmix: overrides.vmix ?? null,
    companion: overrides.companion ?? null,
    mixer: overrides.mixer ?? null,
    ptzManager: overrides.ptzManager ?? null,
    encoderBridge: overrides.encoderBridge ?? { type: 'obs' },
    hyperdecks: overrides.hyperdecks ?? [],
    streamHealthMonitor: overrides.streamHealthMonitor ?? { getStatus: () => ({ monitoring: true, history: [] }) },
    audioMonitor: overrides.audioMonitor ?? {},
    _recentAlerts: overrides._recentAlerts ?? [],
    _recentCommands: overrides._recentCommands ?? [],
    _lastProblemFinderResult: overrides._lastProblemFinderResult ?? null,
    _getStreamBitrate: overrides._getStreamBitrate ?? (() => ({ value: 4500, source: 'OBS' })),
    _getStreamFps: overrides._getStreamFps ?? (() => ({ value: 30, source: 'OBS' })),
  };
}

// ─── Top-level keys ──────────────────────────────────────────────────────────

test('returns all expected top-level keys', async () => {
  const agent = createMockAgent();
  const bundle = await collectDiagnosticBundle(agent);

  const expectedKeys = [
    'timestamp', 'appVersion', 'platform', 'system', 'connections',
    'stream', 'alerts', 'problemFinder', 'config', 'recentCommands',
  ];
  for (const key of expectedKeys) {
    assert.ok(key in bundle, `bundle should have key "${key}"`);
  }
});

test('timestamp is recent (within last 5 seconds)', async () => {
  const agent = createMockAgent();
  const before = Date.now();
  const bundle = await collectDiagnosticBundle(agent);
  const after = Date.now();

  assert.ok(bundle.timestamp >= before, 'timestamp should be >= test start');
  assert.ok(bundle.timestamp <= after, 'timestamp should be <= test end');
});

test('appVersion is a string', async () => {
  const agent = createMockAgent();
  const bundle = await collectDiagnosticBundle(agent);
  assert.equal(typeof bundle.appVersion, 'string');
});

// ─── Platform info ───────────────────────────────────────────────────────────

test('platform info is present and accurate', async () => {
  const agent = createMockAgent();
  const bundle = await collectDiagnosticBundle(agent);

  assert.equal(bundle.platform.os, process.platform);
  assert.equal(bundle.platform.arch, process.arch);
  assert.equal(bundle.platform.nodeVersion, process.version);
});

// ─── System health ───────────────────────────────────────────────────────────

test('system health data is included', async () => {
  const agent = createMockAgent();
  const bundle = await collectDiagnosticBundle(agent);

  assert.ok(bundle.system, 'system should exist');
  // getSystemHealth returns { cpu, memory, disk, uptime, warnings }
  assert.ok(bundle.system.cpu || bundle.system.error, 'system should have cpu or error');
  assert.ok(bundle.system.memory || bundle.system.error, 'system should have memory or error');
});

// ─── Connections ─────────────────────────────────────────────────────────────

test('connections.relay reflects connected state', async () => {
  const WebSocket = require('ws');
  const agent = createMockAgent({ relay: { readyState: WebSocket.OPEN } });
  const bundle = await collectDiagnosticBundle(agent);

  assert.equal(bundle.connections.relay.connected, true);
  assert.equal(bundle.connections.relay.url, 'wss://test.relay');
});

test('connections.relay reflects disconnected state', async () => {
  const agent = createMockAgent({ relay: { readyState: 3 } }); // CLOSED
  const bundle = await collectDiagnosticBundle(agent);

  assert.equal(bundle.connections.relay.connected, false);
});

test('connections.atem reflects connected ATEM', async () => {
  const agent = createMockAgent();
  const bundle = await collectDiagnosticBundle(agent);

  assert.equal(bundle.connections.atem.connected, true);
  assert.equal(bundle.connections.atem.model, 'ATEM Mini Pro');
  assert.equal(bundle.connections.atem.ip, '192.168.1.100');
  assert.equal(bundle.connections.atem.programInput, 1);
  assert.equal(bundle.connections.atem.previewInput, 2);
});

test('connections.atem reflects disconnected ATEM', async () => {
  const agent = createMockAgent({
    status: {
      ...createMockAgent().status,
      atem: { connected: false, model: null, ip: null, programInput: null, previewInput: null },
    },
  });
  const bundle = await collectDiagnosticBundle(agent);

  assert.equal(bundle.connections.atem.connected, false);
  assert.equal(bundle.connections.atem.model, null);
});

test('connections.obs shows disconnected when OBS is not connected', async () => {
  const agent = createMockAgent();
  const bundle = await collectDiagnosticBundle(agent);

  assert.equal(bundle.connections.obs.connected, false);
  assert.equal(bundle.connections.obs.streaming, false);
});

test('connections.encoders is populated when encoderBridge exists', async () => {
  const agent = createMockAgent();
  const bundle = await collectDiagnosticBundle(agent);

  assert.ok(Array.isArray(bundle.connections.encoders));
  assert.equal(bundle.connections.encoders.length, 1);
  assert.equal(bundle.connections.encoders[0].connected, true);
  assert.equal(bundle.connections.encoders[0].streaming, true);
  assert.equal(bundle.connections.encoders[0].bitrate, 4500);
});

test('connections.ptz returns empty array when no PTZ configured', async () => {
  const agent = createMockAgent();
  const bundle = await collectDiagnosticBundle(agent);

  assert.ok(Array.isArray(bundle.connections.ptz));
  assert.equal(bundle.connections.ptz.length, 0);
});

test('connections.ptz returns cameras when PTZ is configured', async () => {
  const agent = createMockAgent({
    status: {
      ...createMockAgent().status,
      ptz: [
        { name: 'Camera 1', connected: true },
        { name: 'Camera 2', connected: false },
      ],
    },
  });
  const bundle = await collectDiagnosticBundle(agent);

  assert.equal(bundle.connections.ptz.length, 2);
  assert.equal(bundle.connections.ptz[0].name, 'Camera 1');
  assert.equal(bundle.connections.ptz[0].connected, true);
  assert.equal(bundle.connections.ptz[1].connected, false);
});

test('connections.hyperdeck returns empty array when no hyperdecks', async () => {
  const agent = createMockAgent();
  const bundle = await collectDiagnosticBundle(agent);

  assert.ok(Array.isArray(bundle.connections.hyperdeck));
  assert.equal(bundle.connections.hyperdeck.length, 0);
});

test('connections.hyperdeck populates from hyperdeck instances', async () => {
  const agent = createMockAgent({
    hyperdecks: [
      { getStatus: () => ({ name: 'HyperDeck 1', connected: true, recording: true, diskSpace: '250GB' }) },
    ],
  });
  const bundle = await collectDiagnosticBundle(agent);

  assert.equal(bundle.connections.hyperdeck.length, 1);
  assert.equal(bundle.connections.hyperdeck[0].name, 'HyperDeck 1');
  assert.equal(bundle.connections.hyperdeck[0].connected, true);
  assert.equal(bundle.connections.hyperdeck[0].recording, true);
});

// ─── Stream ──────────────────────────────────────────────────────────────────

test('stream reports active when encoder is live', async () => {
  const agent = createMockAgent();
  const bundle = await collectDiagnosticBundle(agent);

  assert.equal(bundle.stream.active, true);
  assert.equal(bundle.stream.bitrate, 4500);
  assert.equal(bundle.stream.fps, 30);
  assert.equal(bundle.stream.qualityTier, 'good');
});

test('stream reports inactive when nothing is streaming', async () => {
  const agent = createMockAgent({
    status: {
      ...createMockAgent().status,
      obs: { connected: false, streaming: false },
      atem: { connected: true, streaming: false },
      encoder: { connected: false, live: false, streaming: false },
    },
    _getStreamBitrate: () => null,
    _getStreamFps: () => null,
  });
  const bundle = await collectDiagnosticBundle(agent);

  assert.equal(bundle.stream.active, false);
  assert.equal(bundle.stream.qualityTier, null);
});

test('stream quality tier is fair for moderate bitrate', async () => {
  const agent = createMockAgent({
    _getStreamBitrate: () => ({ value: 3000, source: 'OBS' }),
  });
  const bundle = await collectDiagnosticBundle(agent);
  assert.equal(bundle.stream.qualityTier, 'fair');
});

test('stream quality tier is poor for low bitrate', async () => {
  const agent = createMockAgent({
    _getStreamBitrate: () => ({ value: 1500, source: 'OBS' }),
  });
  const bundle = await collectDiagnosticBundle(agent);
  assert.equal(bundle.stream.qualityTier, 'poor');
});

// ─── Alerts ──────────────────────────────────────────────────────────────────

test('alerts includes recent alerts from agent', async () => {
  const agent = createMockAgent({
    _recentAlerts: [
      { message: 'ATEM disconnected', severity: 'warning', timestamp: Date.now() - 60000 },
      { message: 'Stream bitrate low', severity: 'warning', timestamp: Date.now() - 30000 },
    ],
  });
  const bundle = await collectDiagnosticBundle(agent);

  assert.ok(Array.isArray(bundle.alerts));
  assert.equal(bundle.alerts.length, 2);
  assert.equal(bundle.alerts[0].message, 'ATEM disconnected');
});

// ─── Config ──────────────────────────────────────────────────────────────────

test('config section is populated with churchId', async () => {
  const agent = createMockAgent();
  const bundle = await collectDiagnosticBundle(agent);

  assert.equal(bundle.config.churchId, 'church-123');
  assert.ok(Array.isArray(bundle.config.configuredDevices));
  assert.equal(bundle.config.autoRecoveryEnabled, true);
});

test('config does not leak sensitive keys', async () => {
  const agent = createMockAgent({
    config: {
      relay: 'wss://test.relay',
      token: 'secret-token',
      obsPassword: 'secret-password',
      atemIp: '192.168.1.100',
      autoRecovery: true,
    },
  });
  const bundle = await collectDiagnosticBundle(agent);

  // token and obsPassword should be filtered out of configuredDevices
  assert.ok(!bundle.config.configuredDevices.includes('token'), 'should not include token');
  assert.ok(!bundle.config.configuredDevices.includes('obsPassword'), 'should not include obsPassword');
  // But non-sensitive keys should remain
  assert.ok(bundle.config.configuredDevices.includes('relay'), 'should include relay');
  assert.ok(bundle.config.configuredDevices.includes('atemIp'), 'should include atemIp');
});

// ─── Recent commands ─────────────────────────────────────────────────────────

test('recentCommands includes agent command history', async () => {
  const agent = createMockAgent({
    _recentCommands: [
      { command: 'atem.cut', params: { input: 1 }, error: null, timestamp: Date.now() },
    ],
  });
  const bundle = await collectDiagnosticBundle(agent);

  assert.ok(Array.isArray(bundle.recentCommands));
  assert.equal(bundle.recentCommands.length, 1);
  assert.equal(bundle.recentCommands[0].command, 'atem.cut');
});

// ─── Handles missing/disconnected devices gracefully ─────────────────────────

test('handles completely empty agent without crashing', async () => {
  const agent = {
    relay: null,
    config: {},
    churchId: null,
    status: {},
    health: {},
    obs: null,
    atem: null,
    vmix: null,
    companion: null,
    mixer: null,
    ptzManager: null,
    encoderBridge: null,
    hyperdecks: null,
    streamHealthMonitor: null,
    audioMonitor: null,
    _recentAlerts: null,
    _recentCommands: null,
    _lastProblemFinderResult: null,
  };
  const bundle = await collectDiagnosticBundle(agent);

  assert.ok(bundle.timestamp);
  assert.ok(bundle.platform);
  assert.ok(bundle.connections);
  assert.equal(bundle.connections.relay.connected, false);
  assert.equal(bundle.connections.atem.connected, false);
  assert.equal(bundle.stream.active, false);
  assert.ok(Array.isArray(bundle.alerts));
  assert.equal(bundle.alerts.length, 0);
});

test('handles agent with undefined status fields', async () => {
  const agent = createMockAgent({
    status: {
      atem: undefined,
      obs: undefined,
      encoder: undefined,
      companion: undefined,
      vmix: undefined,
      mixer: undefined,
      ptz: undefined,
    },
  });
  const bundle = await collectDiagnosticBundle(agent);

  assert.equal(bundle.connections.atem.connected, false);
  assert.equal(bundle.connections.obs.connected, false);
  assert.equal(bundle.connections.vmix.connected, false);
  assert.equal(bundle.connections.companion.connected, false);
});

test('handles mixer with connected status', async () => {
  const agent = createMockAgent({
    mixer: { type: 'x32' },
    status: {
      ...createMockAgent().status,
      mixer: { connected: true, type: 'x32', model: 'X32 Compact' },
    },
    config: { ...createMockAgent().config, mixer: { type: 'x32', model: 'X32 Compact' } },
  });
  const bundle = await collectDiagnosticBundle(agent);

  assert.equal(bundle.connections.mixers.length, 1);
  assert.equal(bundle.connections.mixers[0].connected, true);
  assert.equal(bundle.connections.mixers[0].type, 'x32');
});

// ─── Problem Finder ──────────────────────────────────────────────────────────

test('problemFinder is empty object when no results available', async () => {
  const agent = createMockAgent();
  const bundle = await collectDiagnosticBundle(agent);
  assert.deepEqual(bundle.problemFinder, {});
});

test('problemFinder includes last run results when available', async () => {
  const agent = createMockAgent({
    _lastProblemFinderResult: { issues: 3, blockers: 1, coverage: 0.85 },
  });
  const bundle = await collectDiagnosticBundle(agent);
  assert.deepEqual(bundle.problemFinder, { issues: 3, blockers: 1, coverage: 0.85 });
});
