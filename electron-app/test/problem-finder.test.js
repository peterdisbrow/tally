#!/usr/bin/env node
/**
 * problem-finder.test.js — Unit tests for the Problem Finder bridge module.
 *
 * Tests buildLiveSnapshot, Go/No-Go evaluation, event triggers,
 * run history, and feature flag gating.
 *
 * Run:  node test/problem-finder.test.js
 */

const path = require('path');

// ─── Helpers ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

function section(name) {
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 60 - name.length))}`);
}

// ─── Resolve lab path ─────────────────────────────────────────────────────

const LAB_ROOT = path.resolve(__dirname, '..', '..', '..', '..', 'New project', 'problem-finder-lab');

let labAvailable = false;
try {
  require(path.join(LAB_ROOT, 'src', 'engine.js'));
  labAvailable = true;
} catch {
  console.log('⚠ Lab not found at', LAB_ROOT, '— some tests will be skipped.');
}

// ─── Mock Dependencies ───────────────────────────────────────────────────

const mockAgentStatus = {
  relay: true,
  atem: { connected: true, model: 'ATEM Mini Pro' },
  obs: true,
  companion: false,
  encoder: true,
  encoderType: 'obs',
  streaming: true,
  fps: 29.97,
  audio: { silenceDetected: false, masterMuted: false },
  billingStatus: 'active',
  billingTier: 'standard',
  trialDaysRemaining: null,
};

const mockConfig = {
  token: 'test-token-123',
  relay: 'wss://relay.example.com',
  encoder: { type: 'obs' },
};

const mockLogs = [
  '[2025-01-01 10:00:00] Agent started',
  '[2025-01-01 10:00:01] Relay connected',
  '[2025-01-01 10:00:02] ATEM connected',
  '[2025-01-01 10:00:03] Streaming started at 30fps',
];

const mockEquipmentResults = [
  { name: 'ATEM', status: 'pass' },
  { name: 'OBS', status: 'pass' },
];

// ─── Import Bridge ──────────────────────────────────────────────────────

const bridge = require('../src/problem-finder-bridge');

// ─── Init ───────────────────────────────────────────────────────────────

section('Bridge Init');

bridge.init({
  getAgentStatus: () => ({ ...mockAgentStatus }),
  getConfig: () => ({ ...mockConfig }),
  getRecentLogs: () => [...mockLogs],
  getEquipmentResults: () => [...mockEquipmentResults],
  getMainWindow: () => null,
  appendAppLog: () => {},
  getLabRootDir: () => labAvailable ? LAB_ROOT : null,
});

assert(typeof bridge.isAvailable === 'function', 'bridge.isAvailable is function');
if (labAvailable) {
  assert(bridge.isAvailable() === true, 'bridge is available with lab');
} else {
  assert(bridge.isAvailable() === false, 'bridge unavailable without lab');
}

// ─── buildLiveSnapshot ──────────────────────────────────────────────────

section('buildLiveSnapshot');

const snapshot = bridge.buildLiveSnapshot();
assert(typeof snapshot === 'object', 'snapshot is object');
assert(snapshot.scenario === 'live', 'scenario is "live"');
assert(typeof snapshot.timestamp === 'string', 'timestamp is ISO string');

// Agent status mapping
assert(snapshot.agentStatus.relay === true, 'relay mapped');
assert(snapshot.agentStatus.atem === true, 'atem connected mapped');
assert(snapshot.agentStatus.atemModel === 'ATEM Mini Pro', 'atem model mapped');
assert(snapshot.agentStatus.obs === true, 'obs mapped');
assert(snapshot.agentStatus.companion === false, 'companion mapped');
assert(snapshot.agentStatus.encoder === true, 'encoder mapped');
assert(snapshot.agentStatus.encoderType === 'obs', 'encoderType mapped');
assert(snapshot.agentStatus.streaming === true, 'streaming mapped');
assert(snapshot.agentStatus.fps === 29.97, 'fps mapped');
assert(snapshot.agentStatus.audio.silenceDetected === false, 'audio.silenceDetected mapped');
assert(snapshot.agentStatus.audio.masterMuted === false, 'audio.masterMuted mapped');

// Config mapping
assert(snapshot.config.tokenPresent === true, 'config.tokenPresent mapped');
assert(snapshot.config.relayUrl === 'wss://relay.example.com', 'config.relayUrl mapped');
assert(snapshot.config.encoderConfigured === true, 'config.encoderConfigured mapped');

// Runtime
assert(typeof snapshot.runtime === 'object', 'runtime is object');
assert(typeof snapshot.runtime.authFailuresLastHour === 'number', 'authFailuresLastHour is number');
assert(typeof snapshot.runtime.crashCountLastHour === 'number', 'crashCountLastHour is number');
assert(Array.isArray(snapshot.runtime.recentErrors), 'recentErrors is array');

// Logs
assert(Array.isArray(snapshot.logs), 'logs is array');
assert(snapshot.logs.length <= 200, 'logs capped at 200');

// Equipment tests
assert(Array.isArray(snapshot.equipmentTests), 'equipmentTests is array');

// ─── buildLiveSnapshot: atem boolean ────────────────────────────────────

section('buildLiveSnapshot: atem as boolean');

bridge.init({
  getAgentStatus: () => ({ relay: true, atem: true, obs: false, companion: false }),
  getConfig: () => ({ token: 'x' }),
  getRecentLogs: () => [],
  getEquipmentResults: () => [],
  getMainWindow: () => null,
  appendAppLog: () => {},
  getLabRootDir: () => labAvailable ? LAB_ROOT : null,
});

const snap2 = bridge.buildLiveSnapshot();
assert(snap2.agentStatus.atem === true, 'atem=true boolean handled');
assert(snap2.agentStatus.atemModel === '', 'atem boolean → empty model');

// Re-init with full mock for remaining tests
bridge.init({
  getAgentStatus: () => ({ ...mockAgentStatus }),
  getConfig: () => ({ ...mockConfig }),
  getRecentLogs: () => [...mockLogs],
  getEquipmentResults: () => [...mockEquipmentResults],
  getMainWindow: () => null,
  appendAppLog: () => {},
  getLabRootDir: () => labAvailable ? LAB_ROOT : null,
});

// ─── Go/No-Go (requires lab) ───────────────────────────────────────────

if (labAvailable) {
  section('Go/No-Go: Healthy State → GO');

  (async () => {
    try {
      const result = await bridge.runGoNoGo({ triggerType: 'preflight' });
      assert(result.goNoGo != null, 'goNoGo returned');
      assert(result.goNoGo.status === 'GO', `healthy state → GO (got ${result.goNoGo.status})`);
      assert(result.goNoGo.blockerCount === 0, 'zero blockers');
      assert(result.report != null, 'report returned');
      assert(result.runEntry != null, 'runEntry returned');
      assert(typeof result.runEntry.runId === 'string', 'runEntry has runId');
      assert(typeof result.runEntry.durationMs === 'number', 'runEntry has durationMs');

      // ─── Go/No-Go: Relay Down → NO_GO ──────────────────────────────────

      section('Go/No-Go: Relay Down → NO_GO');

      bridge.init({
        getAgentStatus: () => ({ ...mockAgentStatus, relay: false }),
        getConfig: () => ({ ...mockConfig }),
        getRecentLogs: () => [...mockLogs],
        getEquipmentResults: () => [...mockEquipmentResults],
        getMainWindow: () => null,
        appendAppLog: () => {},
        getLabRootDir: () => LAB_ROOT,
      });

      const relayDown = await bridge.runGoNoGo({ triggerType: 'manual' });
      assert(relayDown.goNoGo != null, 'goNoGo returned for relay-down');
      assert(relayDown.goNoGo.status === 'NO_GO', `relay down → NO_GO (got ${relayDown.goNoGo.status})`);
      assert(relayDown.goNoGo.blockerCount > 0, 'relay-down has blockers');

      // ─── Go/No-Go: No Token → NO_GO ──────────────────────────────────

      section('Go/No-Go: No Token → NO_GO');

      bridge.init({
        getAgentStatus: () => ({ ...mockAgentStatus }),
        getConfig: () => ({ relay: 'wss://relay.example.com' }), // no token
        getRecentLogs: () => [...mockLogs],
        getEquipmentResults: () => [...mockEquipmentResults],
        getMainWindow: () => null,
        appendAppLog: () => {},
        getLabRootDir: () => LAB_ROOT,
      });

      const noToken = await bridge.runGoNoGo();
      assert(noToken.goNoGo != null, 'goNoGo returned for no-token');
      assert(noToken.goNoGo.status === 'NO_GO', `no token → NO_GO (got ${noToken.goNoGo.status})`);

      // Re-init for remaining tests
      bridge.init({
        getAgentStatus: () => ({ ...mockAgentStatus }),
        getConfig: () => ({ ...mockConfig }),
        getRecentLogs: () => [...mockLogs],
        getEquipmentResults: () => [...mockEquipmentResults],
        getMainWindow: () => null,
        appendAppLog: () => {},
        getLabRootDir: () => LAB_ROOT,
      });

      // ─── Run History ─────────────────────────────────────────────────

      section('Run History');

      const history = bridge.getRunHistory();
      assert(Array.isArray(history), 'getRunHistory returns array');
      assert(history.length > 0, 'history has entries after analysis runs');

      const lastRun = history[history.length - 1];
      assert(typeof lastRun.runId === 'string', 'run entry has runId');
      assert(typeof lastRun.triggerType === 'string', 'run entry has triggerType');
      assert(typeof lastRun.issueCount === 'number', 'run entry has issueCount');
      assert(typeof lastRun.coverageScore === 'number', 'run entry has coverageScore');
      assert(typeof lastRun.goNoGoStatus === 'string', 'run entry has goNoGoStatus');

      // ─── Simulate Fix ──────────────────────────────────────────────

      section('Simulate Fix');

      const sim = await bridge.simulateFix('relay_reconnect');
      assert(typeof sim === 'object', 'simulateFix returns object');
      assert(sim.simulationId === 'relay_reconnect', 'simulationId preserved');
      if (!sim.error) {
        assert(typeof sim.diff === 'object', 'sim has diff');
        assert(typeof sim.diff.issueDelta === 'number', 'diff has issueDelta');
        assert(typeof sim.diff.coverageDelta === 'number', 'diff has coverageDelta');
      }

      // ─── Feature Flags ─────────────────────────────────────────────

      section('Feature Flags');

      const flags = bridge.getFeatureFlags();
      assert(typeof flags === 'object', 'getFeatureFlags returns object');
      assert(typeof flags.problemFinderDesktopEnabled === 'boolean', 'desktop flag exists');
      assert(typeof flags.problemFinderPortalEnabled === 'boolean', 'portal flag exists');
      assert(typeof flags.problemFinderAiEnabled === 'boolean', 'ai flag exists');

      // ─── Event-Driven Trigger (rate-limited) ──────────────────────

      section('Event Triggers');

      // onAgentEvent should not throw
      bridge.onAgentEvent('relay disconnected');
      assert(true, 'onAgentEvent("relay disconnected") does not throw');
      bridge.onAgentEvent('normal log message nothing special');
      assert(true, 'onAgentEvent with no match does not throw');

      // ─── Summary ──────────────────────────────────────────────────

      console.log(`\n${'═'.repeat(64)}`);
      console.log(`  PASSED: ${passed}   FAILED: ${failed}`);
      console.log(`${'═'.repeat(64)}\n`);

      if (failed > 0) process.exit(1);
    } catch (err) {
      console.error('\nFATAL ERROR:', err.message);
      console.error(err.stack);
      process.exit(1);
    }
  })();
} else {
  section('Lab-Dependent Tests Skipped');
  console.log('  (lab not available — run from proper workspace to enable)');
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  PASSED: ${passed}   FAILED: ${failed}`);
  console.log(`${'═'.repeat(64)}\n`);
  if (failed > 0) process.exit(1);
}
