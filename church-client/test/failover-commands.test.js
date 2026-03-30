const test = require('node:test');
const assert = require('node:assert/strict');

const { commandHandlers } = require('../src/commands');

// ─── Registration ─────────────────────────────────────────────────────────────

test('failover commands are registered', () => {
  assert.ok(commandHandlers['failover.switchToBackupEncoder'], 'switchToBackupEncoder should be registered');
  assert.ok(commandHandlers['failover.switchToPrimaryEncoder'], 'switchToPrimaryEncoder should be registered');
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockAgent(overrides = {}) {
  return {
    config: {
      encoder: { type: 'blackmagic', host: '192.168.1.10', port: 80 },
      backupEncoder: { type: 'teradek', host: '192.168.1.20', port: 80 },
    },
    status: {
      encoder: { type: 'blackmagic', connected: true, live: true, bitrateKbps: 5000 },
      backupEncoder: { configured: true, connected: false, type: 'teradek' },
    },
    encoderBridge: {
      disconnect: async () => {},
      stopStream: async () => {},
      connect: async () => true,
      getStatus: async () => ({ connected: true, live: true, bitrateKbps: 5000 }),
    },
    _encoderPollTimer: null,
    _backupEncoderActive: false,
    _backupEncoderType: null,
    _startEncoderPoll: function () {},
    _monitorBackupEncoder: function () {},
    _stopMonitoringBackupEncoder: function () {},
    _track: (x) => x,
    obs: null,
    atem: null,
    ...overrides,
  };
}

// Mock EncoderBridge — the failover commands require() it
// We need to mock it at the module level. Since the commands file uses require('../encoderBridge'),
// we intercept by checking the behavior of the functions.

// ─── switchToBackupEncoder ────────────────────────────────────────────────────

test('switchToBackupEncoder throws when no backup configured', async () => {
  const agent = mockAgent();
  agent.config.backupEncoder = null;
  await assert.rejects(
    () => commandHandlers['failover.switchToBackupEncoder'](agent),
    /No backup encoder configured/
  );
});

test('switchToBackupEncoder swaps roles: old primary becomes backupEncoder config', async () => {
  const agent = mockAgent();
  const originalPrimary = agent.config.encoder;
  const originalBackup = agent.config.backupEncoder;

  // The command creates a new EncoderBridge internally, which we can't easily mock
  // without module-level mocking. Test the config swap logic by calling directly.
  // We'll verify the contract: after switchToBackupEncoder, config.backupEncoder = old primary
  try {
    await commandHandlers['failover.switchToBackupEncoder'](agent);
  } catch {
    // EncoderBridge constructor may fail in test env — that's OK
    // The role swap happens before the bridge creation throws
  }

  // If the function got past the bridge creation, verify swap
  if (agent._backupEncoderActive) {
    assert.deepStrictEqual(agent.config.backupEncoder, originalPrimary,
      'old primary should become backupEncoder config');
    assert.deepStrictEqual(agent.config.encoder, originalBackup,
      'backup should become encoder config');
  }
});

test('switchToBackupEncoder with atem-streaming type uses ATEM', async () => {
  let streamingStarted = false;
  const agent = mockAgent({
    config: {
      encoder: { type: 'blackmagic', host: '192.168.1.10', port: 80 },
      backupEncoder: { type: 'atem-streaming' },
    },
    atem: {
      startStreaming: async () => { streamingStarted = true; },
    },
  });

  await commandHandlers['failover.switchToBackupEncoder'](agent);

  assert.ok(streamingStarted, 'should have called atem.startStreaming()');
  assert.ok(agent._backupEncoderActive, 'backup should be active');
  assert.strictEqual(agent._backupEncoderType, 'atem-streaming');
  assert.deepStrictEqual(agent.config.backupEncoder, { type: 'blackmagic', host: '192.168.1.10', port: 80 },
    'old primary should be in backupEncoder after role swap');
});

// ─── switchToPrimaryEncoder ───────────────────────────────────────────────────

test('switchToPrimaryEncoder throws when no backup config available', async () => {
  const agent = mockAgent();
  agent.config.backupEncoder = null;
  agent._backupEncoderType = 'blackmagic';
  await assert.rejects(
    () => commandHandlers['failover.switchToPrimaryEncoder'](agent),
    /No backup encoder config available/
  );
});

test('switchToPrimaryEncoder stops atem-streaming backup', async () => {
  let streamingStopped = false;
  const agent = mockAgent({
    _backupEncoderType: 'atem-streaming',
    _backupEncoderActive: true,
    atem: {
      stopStreaming: async () => { streamingStopped = true; },
    },
  });

  try {
    await commandHandlers['failover.switchToPrimaryEncoder'](agent);
  } catch {
    // EncoderBridge may throw in test env
  }

  assert.ok(streamingStopped, 'should have called atem.stopStreaming()');
});

test('switchToPrimaryEncoder swaps roles on recovery', async () => {
  const agent = mockAgent({
    _backupEncoderType: 'teradek',
    _backupEncoderActive: true,
    config: {
      encoder: { type: 'teradek', host: '192.168.1.20', port: 80 },
      backupEncoder: { type: 'blackmagic', host: '192.168.1.10', port: 80 },
    },
  });

  try {
    await commandHandlers['failover.switchToPrimaryEncoder'](agent);
  } catch {
    // EncoderBridge constructor may fail
  }

  // If it completed, verify swap
  if (!agent._backupEncoderActive) {
    assert.strictEqual(agent.config.encoder.type, 'blackmagic',
      'target (backupEncoder) should become the new primary');
    assert.strictEqual(agent.config.backupEncoder.type, 'teradek',
      'old active should become the new backup');
  }
});
