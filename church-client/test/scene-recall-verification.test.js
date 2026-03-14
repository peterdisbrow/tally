const test = require('node:test');
const assert = require('node:assert/strict');

// We test MixerBridge's scene verification logic directly.
// The underlying mixer driver is replaced with a mock so no real hardware is needed.

const { MixerBridge } = require('../src/mixerBridge');

// ─── Mock Mixer Driver ────────────────────────────────────────────────────────

/**
 * Creates a mock mixer driver with controllable channel state.
 * channelState: { [ch]: { fader: number, muted: boolean } }
 */
function createMockDriver(channelState = {}) {
  return {
    connect: async () => {},
    disconnect: async () => {},
    isOnline: async () => true,
    getStatus: async () => ({
      online: true, model: 'MockX32', firmware: '1.0',
      mainFader: 0.75, mainMuted: false, scene: null,
    }),
    getChannelStatus: async (ch) => {
      const s = channelState[ch];
      if (!s) return { fader: 0, muted: false };
      return { fader: s.fader, muted: s.muted };
    },
    muteChannel: async () => {},
    unmuteChannel: async () => {},
    setFader: async () => {},
    muteMaster: async () => {},
    unmuteMaster: async () => {},
    recallScene: async () => {},
    saveScene: async () => {},
    verifySceneSave: async () => ({ sceneNumber: 0, name: null, exists: false }),
    clearSolos: async () => {},
    setChannelName: async () => {},
    setHpf: async () => {},
    setEq: async () => {},
    setCompressor: async () => {},
    setGate: async () => {},
    setFullChannelStrip: async () => {},
    setPreampGain: async () => {},
    setHeadampGain: async () => {},
    setPhantom: async () => {},
    setPan: async () => {},
    setChannelColor: async () => {},
    setChannelIcon: async () => {},
    setSendLevel: async () => {},
    assignToBus: async () => {},
    assignToDca: async () => {},
    muteDca: async () => {},
    unmuteDca: async () => {},
    setDcaFader: async () => {},
    activateMuteGroup: async () => {},
    deactivateMuteGroup: async () => {},
    pressSoftKey: async () => {},
    getMeters: async () => [],
  };
}

/**
 * Create a MixerBridge instance with a mock driver injected.
 */
function createBridge(channelState = {}) {
  // Construct with a valid type, then swap the driver
  const bridge = Object.create(MixerBridge.prototype);
  // Manually initialize (avoid the constructor calling _create which needs real modules)
  require('events').EventEmitter.call(bridge);
  bridge.config = { type: 'behringer', host: '127.0.0.1' };
  bridge.type = 'behringer';
  bridge._expectedStates = new Map();
  bridge._mixer = createMockDriver(channelState);
  return bridge;
}

// ─── captureCurrentState ──────────────────────────────────────────────────────

test('captureCurrentState returns fader and mute for specified channels', async () => {
  const bridge = createBridge({
    1: { fader: 0.75, muted: false },
    2: { fader: 0.50, muted: true },
    3: { fader: 0.00, muted: false },
  });

  const state = await bridge.captureCurrentState([1, 2, 3]);
  assert.equal(state.channels.length, 3);
  assert.deepStrictEqual(state.channels[0], { channel: 1, fader: 0.75, muted: false });
  assert.deepStrictEqual(state.channels[1], { channel: 2, fader: 0.50, muted: true });
  assert.deepStrictEqual(state.channels[2], { channel: 3, fader: 0.00, muted: false });
});

test('captureCurrentState returns defaults for unknown channels', async () => {
  const bridge = createBridge({});

  const state = await bridge.captureCurrentState([99]);
  assert.equal(state.channels.length, 1);
  assert.deepStrictEqual(state.channels[0], { channel: 99, fader: 0, muted: false });
});

test('captureCurrentState throws when no channels specified', async () => {
  const bridge = createBridge();
  await assert.rejects(() => bridge.captureCurrentState([]), /At least one channel/);
  await assert.rejects(() => bridge.captureCurrentState(null), /At least one channel/);
});

test('captureCurrentState handles getChannelStatus failure gracefully', async () => {
  const bridge = createBridge();
  bridge._mixer.getChannelStatus = async () => { throw new Error('timeout'); };

  const state = await bridge.captureCurrentState([1]);
  assert.equal(state.channels.length, 1);
  assert.deepStrictEqual(state.channels[0], { channel: 1, fader: 0, muted: false });
});

// ─── saveExpectedState / getExpectedState ─────────────────────────────────────

test('saveExpectedState stores and getExpectedState retrieves state', () => {
  const bridge = createBridge();
  const state = { channels: [{ channel: 1, fader: 0.75, muted: false }] };

  bridge.saveExpectedState(5, state);
  const retrieved = bridge.getExpectedState(5);
  assert.deepStrictEqual(retrieved, state);
});

test('saveExpectedState accepts string scene IDs', () => {
  const bridge = createBridge();
  const state = { channels: [{ channel: 1, fader: 0.5, muted: true }] };

  bridge.saveExpectedState('sunday-morning', state);
  assert.deepStrictEqual(bridge.getExpectedState('sunday-morning'), state);
});

test('saveExpectedState overwrites previous state for same scene', () => {
  const bridge = createBridge();
  bridge.saveExpectedState(1, { channels: [{ channel: 1, fader: 0.1, muted: false }] });
  bridge.saveExpectedState(1, { channels: [{ channel: 1, fader: 0.9, muted: true }] });

  const retrieved = bridge.getExpectedState(1);
  assert.equal(retrieved.channels[0].fader, 0.9);
  assert.equal(retrieved.channels[0].muted, true);
});

test('saveExpectedState throws on null sceneId', () => {
  const bridge = createBridge();
  assert.throws(() => bridge.saveExpectedState(null, { channels: [{ channel: 1, fader: 0, muted: false }] }), /sceneId is required/);
});

test('saveExpectedState throws on missing or empty channels', () => {
  const bridge = createBridge();
  assert.throws(() => bridge.saveExpectedState(1, {}), /non-empty channels array/);
  assert.throws(() => bridge.saveExpectedState(1, { channels: [] }), /non-empty channels array/);
  assert.throws(() => bridge.saveExpectedState(1, null), /non-empty channels array/);
});

test('getExpectedState returns undefined for unknown scene', () => {
  const bridge = createBridge();
  assert.equal(bridge.getExpectedState(999), undefined);
});

// ─── verifySceneRecall — all matching ─────────────────────────────────────────

test('verifySceneRecall returns verified=true when state matches', async () => {
  const bridge = createBridge({
    1: { fader: 0.75, muted: false },
    2: { fader: 0.50, muted: true },
  });

  const result = await bridge.verifySceneRecall(1, {
    channels: [
      { channel: 1, fader: 0.75, muted: false },
      { channel: 2, fader: 0.50, muted: true },
    ],
  });

  assert.equal(result.verified, true);
  assert.equal(result.mismatches.length, 0);
});

test('verifySceneRecall uses saved state when expectedState is omitted', async () => {
  const bridge = createBridge({
    1: { fader: 0.75, muted: false },
  });

  bridge.saveExpectedState(3, {
    channels: [{ channel: 1, fader: 0.75, muted: false }],
  });

  const result = await bridge.verifySceneRecall(3);
  assert.equal(result.verified, true);
  assert.equal(result.mismatches.length, 0);
});

// ─── verifySceneRecall — fader mismatch ───────────────────────────────────────

test('verifySceneRecall detects fader mismatch', async () => {
  const bridge = createBridge({
    1: { fader: 0.30, muted: false },
  });

  const result = await bridge.verifySceneRecall(1, {
    channels: [{ channel: 1, fader: 0.75, muted: false }],
  });

  assert.equal(result.verified, false);
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0].channel, 1);
  assert.equal(result.mismatches[0].parameter, 'fader');
  assert.equal(result.mismatches[0].expected, 0.75);
  assert.equal(result.mismatches[0].actual, 0.30);
});

test('verifySceneRecall respects fader tolerance', async () => {
  const bridge = createBridge({
    1: { fader: 0.74, muted: false }, // within default 0.02 tolerance of 0.75
  });

  const result = await bridge.verifySceneRecall(1, {
    channels: [{ channel: 1, fader: 0.75, muted: false }],
  });

  assert.equal(result.verified, true);
  assert.equal(result.mismatches.length, 0);
});

test('verifySceneRecall allows custom tolerance', async () => {
  const bridge = createBridge({
    1: { fader: 0.70, muted: false }, // 0.05 away from expected
  });

  // With tight tolerance (0.01) — should mismatch
  const tight = await bridge.verifySceneRecall(1, {
    channels: [{ channel: 1, fader: 0.75, muted: false }],
  }, { tolerance: 0.01 });
  assert.equal(tight.verified, false);

  // With loose tolerance (0.10) — should match
  const loose = await bridge.verifySceneRecall(1, {
    channels: [{ channel: 1, fader: 0.75, muted: false }],
  }, { tolerance: 0.10 });
  assert.equal(loose.verified, true);
});

// ─── verifySceneRecall — mute mismatch ────────────────────────────────────────

test('verifySceneRecall detects mute mismatch', async () => {
  const bridge = createBridge({
    5: { fader: 0.75, muted: true }, // expected unmuted
  });

  const result = await bridge.verifySceneRecall(1, {
    channels: [{ channel: 5, fader: 0.75, muted: false }],
  });

  assert.equal(result.verified, false);
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0].channel, 5);
  assert.equal(result.mismatches[0].parameter, 'muted');
  assert.equal(result.mismatches[0].expected, false);
  assert.equal(result.mismatches[0].actual, true);
});

// ─── verifySceneRecall — multiple mismatches ──────────────────────────────────

test('verifySceneRecall reports multiple mismatches across channels', async () => {
  const bridge = createBridge({
    1: { fader: 0.00, muted: true },  // expected 0.75, unmuted
    2: { fader: 0.50, muted: false }, // matches
    3: { fader: 0.25, muted: true },  // fader wrong, mute wrong
  });

  const result = await bridge.verifySceneRecall(1, {
    channels: [
      { channel: 1, fader: 0.75, muted: false },
      { channel: 2, fader: 0.50, muted: false },
      { channel: 3, fader: 0.80, muted: false },
    ],
  });

  assert.equal(result.verified, false);
  // Ch1: fader + mute mismatches = 2, Ch3: fader + mute mismatches = 2
  assert.equal(result.mismatches.length, 4);

  const ch1Mismatches = result.mismatches.filter(m => m.channel === 1);
  assert.equal(ch1Mismatches.length, 2);
  assert.ok(ch1Mismatches.some(m => m.parameter === 'fader'));
  assert.ok(ch1Mismatches.some(m => m.parameter === 'muted'));
});

// ─── verifySceneRecall — unreachable channel ──────────────────────────────────

test('verifySceneRecall marks unreachable channels', async () => {
  const bridge = createBridge({});
  bridge._mixer.getChannelStatus = async () => { throw new Error('OSC timeout'); };

  const result = await bridge.verifySceneRecall(1, {
    channels: [{ channel: 1, fader: 0.75, muted: false }],
  });

  assert.equal(result.verified, false);
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0].parameter, 'unreachable');
  assert.equal(result.mismatches[0].actual, null);
});

// ─── verifySceneRecall — partial expected state ───────────────────────────────

test('verifySceneRecall only checks fields present in expected state', async () => {
  const bridge = createBridge({
    1: { fader: 0.50, muted: true },
  });

  // Only check fader, not mute
  const faderOnly = await bridge.verifySceneRecall(1, {
    channels: [{ channel: 1, fader: 0.50 }],
  });
  assert.equal(faderOnly.verified, true);

  // Only check mute, not fader
  const muteOnly = await bridge.verifySceneRecall(1, {
    channels: [{ channel: 1, muted: true }],
  });
  assert.equal(muteOnly.verified, true);
});

// ─── verifySceneRecall — event emission ───────────────────────────────────────

test('verifySceneRecall emits mixer_scene_mismatch event on failure', async () => {
  const bridge = createBridge({
    1: { fader: 0.00, muted: true },
  });

  let emittedEvent = null;
  bridge.on('mixer_scene_mismatch', (evt) => { emittedEvent = evt; });

  await bridge.verifySceneRecall(42, {
    channels: [{ channel: 1, fader: 0.75, muted: false }],
  });

  assert.ok(emittedEvent, 'mixer_scene_mismatch event should have been emitted');
  assert.equal(emittedEvent.sceneId, 42);
  assert.equal(emittedEvent.type, 'behringer');
  assert.ok(emittedEvent.mismatches.length > 0);
  assert.ok(typeof emittedEvent.timestamp === 'number');
});

test('verifySceneRecall does NOT emit event when scene matches', async () => {
  const bridge = createBridge({
    1: { fader: 0.75, muted: false },
  });

  let emittedEvent = null;
  bridge.on('mixer_scene_mismatch', (evt) => { emittedEvent = evt; });

  await bridge.verifySceneRecall(1, {
    channels: [{ channel: 1, fader: 0.75, muted: false }],
  });

  assert.equal(emittedEvent, null, 'No event should be emitted on success');
});

// ─── verifySceneRecall — error cases ──────────────────────────────────────────

test('verifySceneRecall throws when no expected state available', async () => {
  const bridge = createBridge();
  await assert.rejects(
    () => bridge.verifySceneRecall(999),
    /No expected state/
  );
});

test('verifySceneRecall throws when expectedState has empty channels', async () => {
  const bridge = createBridge();
  await assert.rejects(
    () => bridge.verifySceneRecall(1, { channels: [] }),
    /No expected state/
  );
});

// ─── Backward compatibility ───────────────────────────────────────────────────

test('MixerBridge is an EventEmitter', () => {
  const bridge = createBridge();
  assert.ok(typeof bridge.on === 'function');
  assert.ok(typeof bridge.emit === 'function');
  assert.ok(typeof bridge.removeListener === 'function');
});

test('existing recallScene still works without verification', async () => {
  const bridge = createBridge();
  let recalledScene = null;
  bridge._mixer.recallScene = async (n) => { recalledScene = n; };

  await bridge.recallScene(5);
  assert.equal(recalledScene, 5);
});

// ─── Integration-style: capture then verify ───────────────────────────────────

test('capture state, save it, then verify after scene recall', async () => {
  const state = {
    1: { fader: 0.75, muted: false },
    2: { fader: 0.50, muted: true },
    3: { fader: 1.00, muted: false },
  };
  const bridge = createBridge(state);

  // 1. Capture current state
  const captured = await bridge.captureCurrentState([1, 2, 3]);

  // 2. Save as expected state for scene 10
  bridge.saveExpectedState(10, captured);

  // 3. "Recall" the scene (no-op in mock)
  await bridge.recallScene(10);

  // 4. Verify — should pass since state hasn't changed
  const result = await bridge.verifySceneRecall(10);
  assert.equal(result.verified, true);
  assert.equal(result.mismatches.length, 0);
});

test('capture, save, simulate drift, verify detects mismatches', async () => {
  const state = {
    1: { fader: 0.75, muted: false },
    2: { fader: 0.50, muted: true },
  };
  const bridge = createBridge(state);

  // Capture and save
  const captured = await bridge.captureCurrentState([1, 2]);
  bridge.saveExpectedState(20, captured);

  // Simulate state drift (someone moved a fader on the console)
  state[1].fader = 0.10;
  state[2].muted = false;

  // Verify — should detect the drift
  const result = await bridge.verifySceneRecall(20);
  assert.equal(result.verified, false);
  assert.equal(result.mismatches.length, 2);
});
