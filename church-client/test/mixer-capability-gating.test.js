const test = require('node:test');
const assert = require('node:assert/strict');

const { commandHandlers } = require('../src/commands');

// Mock mixer helper — creates a mock agent with a mixer of the given model
function mockMixer(model, overrides = {}) {
  return {
    mixer: {
      model,
      isOnline: async () => true,
      getStatus: async () => ({ online: true, type: model, model, mainFader: 0.75, mainMuted: false }),
      getChannelStatus: async (ch) => ({ fader: 0.5, muted: false }),
      setFader: async () => {},
      setChannelName: async () => {},
      setHpf: async () => {},
      setEq: async () => {},
      setCompressor: async () => {},
      setGate: async () => {},
      setFullChannelStrip: async () => {},
      muteMaster: async () => {},
      unmuteMaster: async () => {},
      muteChannel: async () => {},
      unmuteChannel: async () => {},
      recallScene: async () => {},
      saveScene: async () => {},
      clearSolos: async () => {},
      ...overrides,
    },
  };
}

// ─── Capability gating: X32 (full support) ─────────────────────────────────

test('X32 mixer supports all features', async () => {
  const agent = mockMixer('X32');
  // These should all succeed without "not supported" error
  await commandHandlers['mixer.setCompressor'](agent, { channel: 1 });
  await commandHandlers['mixer.setGate'](agent, { channel: 1 });
  await commandHandlers['mixer.setHpf'](agent, { channel: 1 });
  await commandHandlers['mixer.setEq'](agent, { channel: 1 });
  await commandHandlers['mixer.setFader'](agent, { channel: 1, level: 0.5 });
  await commandHandlers['mixer.setChannelName'](agent, { channel: 1, name: 'Test' });
  await commandHandlers['mixer.clearSolos'](agent, {});
  await commandHandlers['mixer.saveScene'](agent, { scene: 1 });
  await commandHandlers['mixer.setFullChannelStrip'](agent, { channel: 1, name: 'Ch1' });
});

// ─── Capability gating: Allen & Heath SQ (partial support) ─────────────────

test('SQ mixer blocks compressor', async () => {
  const agent = mockMixer('SQ');
  await assert.rejects(
    () => commandHandlers['mixer.setCompressor'](agent, { channel: 1 }),
    /not supported on SQ/
  );
});

test('SQ mixer blocks gate', async () => {
  const agent = mockMixer('SQ');
  await assert.rejects(
    () => commandHandlers['mixer.setGate'](agent, { channel: 1 }),
    /not supported on SQ/
  );
});

test('SQ mixer blocks clearSolos', async () => {
  const agent = mockMixer('SQ');
  await assert.rejects(
    () => commandHandlers['mixer.clearSolos'](agent, {}),
    /not supported on SQ/
  );
});

test('SQ mixer allows HPF', async () => {
  const agent = mockMixer('SQ');
  // Should NOT throw
  await commandHandlers['mixer.setHpf'](agent, { channel: 1 });
});

test('SQ mixer allows fader', async () => {
  const agent = mockMixer('SQ');
  await commandHandlers['mixer.setFader'](agent, { channel: 1, level: 0.5 });
});

// ─── Capability gating: Yamaha CL/QL ───────────────────────────────────────

test('CL mixer blocks compressor, gate, HPF, EQ, channelName', async () => {
  const agent = mockMixer('CL');
  await assert.rejects(() => commandHandlers['mixer.setCompressor'](agent, { channel: 1 }), /not supported on CL/);
  await assert.rejects(() => commandHandlers['mixer.setGate'](agent, { channel: 1 }), /not supported on CL/);
  await assert.rejects(() => commandHandlers['mixer.setHpf'](agent, { channel: 1 }), /not supported on CL/);
  await assert.rejects(() => commandHandlers['mixer.setEq'](agent, { channel: 1 }), /not supported on CL/);
  await assert.rejects(() => commandHandlers['mixer.setChannelName'](agent, { channel: 1, name: 'X' }), /not supported on CL/);
  await assert.rejects(() => commandHandlers['mixer.clearSolos'](agent, {}), /not supported on CL/);
  await assert.rejects(() => commandHandlers['mixer.saveScene'](agent, { scene: 1 }), /not supported on CL/);
});

test('CL mixer allows fader (partial)', async () => {
  const agent = mockMixer('CL');
  // Partial — doesn't throw but may warn
  await commandHandlers['mixer.setFader'](agent, { channel: 1, level: 0.7 });
});

// ─── Capability gating: Yamaha TF ──────────────────────────────────────────

test('TF mixer blocks almost everything', async () => {
  const agent = mockMixer('TF');
  await assert.rejects(() => commandHandlers['mixer.setCompressor'](agent, { channel: 1 }), /not supported on TF/);
  await assert.rejects(() => commandHandlers['mixer.setGate'](agent, { channel: 1 }), /not supported on TF/);
  await assert.rejects(() => commandHandlers['mixer.setHpf'](agent, { channel: 1 }), /not supported on TF/);
  await assert.rejects(() => commandHandlers['mixer.setEq'](agent, { channel: 1 }), /not supported on TF/);
  await assert.rejects(() => commandHandlers['mixer.setFader'](agent, { channel: 1, level: 0.5 }), /not supported on TF/);
  await assert.rejects(() => commandHandlers['mixer.setChannelName'](agent, { channel: 1, name: 'X' }), /not supported on TF/);
  await assert.rejects(() => commandHandlers['mixer.clearSolos'](agent, {}), /not supported on TF/);
  await assert.rejects(() => commandHandlers['mixer.saveScene'](agent, { scene: 1 }), /not supported on TF/);
  await assert.rejects(() => commandHandlers['mixer.setFullChannelStrip'](agent, { channel: 1 }), /not supported on TF/);
});

// ─── mixer.capabilities command ─────────────────────────────────────────────

test('mixer.capabilities returns feature list for known model', () => {
  const agent = mockMixer('X32');
  const result = commandHandlers['mixer.capabilities'](agent, {});
  assert.ok(result.includes('X32'));
  assert.ok(result.includes('compressor'));
  assert.ok(result.includes('✅'));
});

test('mixer.capabilities returns feature list for SQ', () => {
  const agent = mockMixer('SQ');
  const result = commandHandlers['mixer.capabilities'](agent, {});
  assert.ok(result.includes('SQ'));
  assert.ok(result.includes('❌'));  // compressor, gate
  assert.ok(result.includes('✅'));  // hpf, fader
});

test('mixer.capabilities handles unknown model gracefully', () => {
  const agent = mockMixer('FooBar');
  const result = commandHandlers['mixer.capabilities'](agent, {});
  assert.ok(result.model === 'FOOBAR');
  assert.ok(result.note.includes('Unknown'));
});

test('mixer.capabilities throws when no mixer', () => {
  assert.throws(
    () => commandHandlers['mixer.capabilities']({}, {}),
    /Audio console not configured/
  );
});

// ─── setupFromPatchList reports skipped features ────────────────────────────

test('setupFromPatchList on SQ reports skipped features', async () => {
  const agent = mockMixer('SQ');
  const result = await commandHandlers['mixer.setupFromPatchList'](agent, {
    channels: [{ channel: 1, name: 'Vocals', compressor: {}, gate: {} }],
  });
  assert.ok(result.includes('applied'));
  assert.ok(result.includes('Skipped'));
  assert.ok(result.includes('compressor'));
  assert.ok(result.includes('gate'));
});

test('setupFromPatchList on X32 does not report skipped', async () => {
  const agent = mockMixer('X32');
  const result = await commandHandlers['mixer.setupFromPatchList'](agent, {
    channels: [{ channel: 1, name: 'Vocals' }],
  });
  assert.ok(result.includes('applied'));
  assert.ok(!result.includes('Skipped'));
});

test('setupFromPatchList on TF reports channel strip unsupported', async () => {
  const agent = mockMixer('TF');
  const result = await commandHandlers['mixer.setupFromPatchList'](agent, {
    channels: [{ channel: 1, name: 'Test' }],
  });
  // Should fail since channelStrip is false for TF
  assert.ok(result.includes('failed'));
});

// ─── Unknown mixer model allows all features ───────────────────────────────

test('unknown mixer model does not gate features', async () => {
  const agent = mockMixer('SomeNewBrand');
  // Should not throw even for compressor/gate since model isn't recognized
  await commandHandlers['mixer.setCompressor'](agent, { channel: 1 });
  await commandHandlers['mixer.setGate'](agent, { channel: 1 });
  await commandHandlers['mixer.clearSolos'](agent, {});
});
