/**
 * Additional tests for mixer commands not covered in mixer-commands.test.js.
 * Covers: setChannelName, setHpf, setEq, setCompressor, setGate,
 * setFullChannelStrip, saveScene, clearSolos, capabilities,
 * mixerCan/requireMixerCapability, and setupFromPatchList.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { commandHandlers } = require('../src/commands');

function mockMixer(model, overrides = {}) {
  return {
    mixer: {
      model,
      isOnline: async () => true,
      getStatus: async () => ({ online: true, type: model, model, mainFader: 0.75, mainMuted: false }),
      getChannelStatus: async () => ({ fader: 0.5, muted: false }),
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
      setPreampGain: async () => {},
      setPhantom: async () => {},
      setPan: async () => {},
      setChannelColor: async () => {},
      setChannelIcon: async () => {},
      setSendLevel: async () => {},
      assignToBus: async () => {},
      assignToDca: async () => {},
      getMeters: async () => [],
      verifySceneSave: async (s) => ({ exists: true, sceneNumber: s, name: 'Test' }),
      muteDca: async () => {},
      unmuteDca: async () => {},
      setDcaFader: async () => {},
      activateMuteGroup: async () => {},
      deactivateMuteGroup: async () => {},
      pressSoftKey: async () => {},
      ...overrides,
    },
  };
}

// ─── mixer.setChannelName ─────────────────────────────────────────────────────

test('mixer.setChannelName throws when no mixer', async () => {
  await assert.rejects(() => commandHandlers['mixer.setChannelName']({}, {}), /Audio console not configured/);
});

test('mixer.setChannelName requires channel', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(
    () => commandHandlers['mixer.setChannelName'](agent, { name: 'Vocals' }),
    /channel parameter required/
  );
});

test('mixer.setChannelName requires name', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(
    () => commandHandlers['mixer.setChannelName'](agent, { channel: 1 }),
    /name parameter required/
  );
});

test('mixer.setChannelName calls setChannelName and returns label', async () => {
  let calledWith = null;
  const agent = mockMixer('X32', {
    setChannelName: async (ch, name) => { calledWith = { ch, name }; },
  });
  const result = await commandHandlers['mixer.setChannelName'](agent, { channel: 3, name: 'Bass Guitar' });
  assert.deepEqual(calledWith, { ch: 3, name: 'Bass Guitar' });
  assert.ok(result.includes('Bass Guitar'));
  assert.ok(result.includes('3'));
});

test('mixer.setChannelName throws on Yamaha TF (channelName: false)', async () => {
  const agent = mockMixer('TF');
  await assert.rejects(
    () => commandHandlers['mixer.setChannelName'](agent, { channel: 1, name: 'Drum' }),
    /not supported on TF/
  );
});

// ─── mixer.setHpf ─────────────────────────────────────────────────────────────

test('mixer.setHpf throws when no mixer', async () => {
  await assert.rejects(() => commandHandlers['mixer.setHpf']({}, {}), /Audio console not configured/);
});

test('mixer.setHpf requires channel', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(
    () => commandHandlers['mixer.setHpf'](agent, {}),
    /channel parameter required/
  );
});

test('mixer.setHpf calls setHpf with enabled=true and frequency defaults to 80Hz', async () => {
  let calledWith = null;
  const agent = mockMixer('X32', {
    setHpf: async (ch, opts) => { calledWith = { ch, opts }; },
  });
  const result = await commandHandlers['mixer.setHpf'](agent, { channel: 2 });
  assert.equal(calledWith.ch, 2);
  assert.equal(calledWith.opts.enabled, true);
  assert.equal(calledWith.opts.frequency, 80);
  assert.ok(result.includes('80 Hz'));
});

test('mixer.setHpf with explicit frequency uses that value', async () => {
  let calledWith = null;
  const agent = mockMixer('X32', {
    setHpf: async (ch, opts) => { calledWith = { ch, opts }; },
  });
  const result = await commandHandlers['mixer.setHpf'](agent, { channel: 1, frequency: 120 });
  assert.equal(calledWith.opts.frequency, 120);
  assert.ok(result.includes('120 Hz'));
});

test('mixer.setHpf with enabled=false reports disabled', async () => {
  const agent = mockMixer('X32');
  const result = await commandHandlers['mixer.setHpf'](agent, { channel: 1, enabled: false });
  assert.ok(result.includes('disabled'));
});

test('mixer.setHpf throws on Yamaha TF (hpf: false)', async () => {
  const agent = mockMixer('TF');
  await assert.rejects(
    () => commandHandlers['mixer.setHpf'](agent, { channel: 1 }),
    /not supported on TF/
  );
});

// ─── mixer.setEq ─────────────────────────────────────────────────────────────

test('mixer.setEq throws when no mixer', async () => {
  await assert.rejects(() => commandHandlers['mixer.setEq']({}, {}), /Audio console not configured/);
});

test('mixer.setEq requires channel', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(
    () => commandHandlers['mixer.setEq'](agent, {}),
    /channel parameter required/
  );
});

test('mixer.setEq calls setEq with correct args', async () => {
  let calledWith = null;
  const agent = mockMixer('X32', {
    setEq: async (ch, opts) => { calledWith = { ch, opts }; },
  });
  const bands = [{ freq: 1000, gain: 3 }];
  const result = await commandHandlers['mixer.setEq'](agent, { channel: 4, bands });
  assert.equal(calledWith.ch, 4);
  assert.deepEqual(calledWith.opts.bands, bands);
  assert.ok(result.includes('EQ'));
  assert.ok(result.includes('updated'));
});

test('mixer.setEq with enabled=false reports disabled', async () => {
  const agent = mockMixer('X32');
  const result = await commandHandlers['mixer.setEq'](agent, { channel: 1, enabled: false });
  assert.ok(result.includes('disabled'));
});

test('mixer.setEq throws on Yamaha CL (eq: false)', async () => {
  const agent = mockMixer('CL');
  await assert.rejects(
    () => commandHandlers['mixer.setEq'](agent, { channel: 1 }),
    /not supported on CL/
  );
});

// ─── mixer.setCompressor ─────────────────────────────────────────────────────

test('mixer.setCompressor throws when no mixer', async () => {
  await assert.rejects(() => commandHandlers['mixer.setCompressor']({}, {}), /Audio console not configured/);
});

test('mixer.setCompressor requires channel', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(
    () => commandHandlers['mixer.setCompressor'](agent, {}),
    /channel parameter required/
  );
});

test('mixer.setCompressor calls setCompressor with channel stripped', async () => {
  let calledWith = null;
  const agent = mockMixer('X32', {
    setCompressor: async (ch, params) => { calledWith = { ch, params }; },
  });
  const result = await commandHandlers['mixer.setCompressor'](agent, { channel: 3, ratio: 4, threshold: -20 });
  assert.equal(calledWith.ch, 3);
  assert.equal(calledWith.params.ratio, 4);
  assert.equal(calledWith.params.threshold, -20);
  assert.ok(result.includes('compressor'));
});

test('mixer.setCompressor with enabled=false reports disabled', async () => {
  const agent = mockMixer('X32');
  const result = await commandHandlers['mixer.setCompressor'](agent, { channel: 1, enabled: false });
  assert.ok(result.includes('disabled'));
});

test('mixer.setCompressor throws on Allen & Heath SQ (compressor: false)', async () => {
  const agent = mockMixer('SQ');
  await assert.rejects(
    () => commandHandlers['mixer.setCompressor'](agent, { channel: 1 }),
    /not supported on SQ/
  );
});

// ─── mixer.setGate ─────────────────────────────────────────────────────────────

test('mixer.setGate throws when no mixer', async () => {
  await assert.rejects(() => commandHandlers['mixer.setGate']({}, {}), /Audio console not configured/);
});

test('mixer.setGate requires channel', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(
    () => commandHandlers['mixer.setGate'](agent, {}),
    /channel parameter required/
  );
});

test('mixer.setGate calls setGate with correct args', async () => {
  let calledWith = null;
  const agent = mockMixer('X32', {
    setGate: async (ch, params) => { calledWith = { ch, params }; },
  });
  const result = await commandHandlers['mixer.setGate'](agent, { channel: 5, threshold: -40 });
  assert.equal(calledWith.ch, 5);
  assert.equal(calledWith.params.threshold, -40);
  assert.ok(result.includes('gate'));
});

test('mixer.setGate throws on dLive (gate: false)', async () => {
  const agent = mockMixer('DLIVE');
  await assert.rejects(
    () => commandHandlers['mixer.setGate'](agent, { channel: 1 }),
    /not supported on DLIVE/
  );
});

// ─── mixer.setFullChannelStrip ────────────────────────────────────────────────

test('mixer.setFullChannelStrip throws when no mixer', async () => {
  await assert.rejects(() => commandHandlers['mixer.setFullChannelStrip']({}, {}), /Audio console not configured/);
});

test('mixer.setFullChannelStrip requires channel', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(
    () => commandHandlers['mixer.setFullChannelStrip'](agent, {}),
    /channel parameter required/
  );
});

test('mixer.setFullChannelStrip calls setFullChannelStrip and returns label', async () => {
  let calledWith = null;
  const agent = mockMixer('X32', {
    setFullChannelStrip: async (ch, strip) => { calledWith = { ch, strip }; },
  });
  const result = await commandHandlers['mixer.setFullChannelStrip'](agent, {
    channel: 2,
    name: 'Piano',
    fader: 0.8,
  });
  assert.equal(calledWith.ch, 2);
  assert.equal(calledWith.strip.name, 'Piano');
  assert.ok(result.includes('Piano'));
  assert.ok(result.includes('2'));
});

test('mixer.setFullChannelStrip shows unnamed when name not provided', async () => {
  const agent = mockMixer('X32');
  const result = await commandHandlers['mixer.setFullChannelStrip'](agent, { channel: 1 });
  assert.ok(result.includes('unnamed'));
});

// ─── mixer.saveScene ─────────────────────────────────────────────────────────

test('mixer.saveScene throws when no mixer', async () => {
  await assert.rejects(() => commandHandlers['mixer.saveScene']({}, {}), /Audio console not configured/);
});

test('mixer.saveScene requires scene', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(
    () => commandHandlers['mixer.saveScene'](agent, {}),
    /scene number required/
  );
});

test('mixer.saveScene calls saveScene and returns message', async () => {
  let calledWith = null;
  const agent = mockMixer('X32', {
    saveScene: async (s, n) => { calledWith = { s, n }; },
  });
  const result = await commandHandlers['mixer.saveScene'](agent, { scene: 5, name: 'Sunday AM' });
  assert.deepEqual(calledWith, { s: 5, n: 'Sunday AM' });
  assert.ok(result.includes('Scene 5'));
  assert.ok(result.includes('Sunday AM'));
});

test('mixer.saveScene without name shows just scene number', async () => {
  const agent = mockMixer('X32');
  const result = await commandHandlers['mixer.saveScene'](agent, { scene: 3 });
  assert.ok(result.includes('Scene 3'));
});

test('mixer.saveScene throws on Allen & Heath SQ (saveScene: false)', async () => {
  const agent = mockMixer('SQ');
  await assert.rejects(
    () => commandHandlers['mixer.saveScene'](agent, { scene: 1 }),
    /not supported on SQ/
  );
});

// ─── mixer.clearSolos ────────────────────────────────────────────────────────

test('mixer.clearSolos throws when no mixer', async () => {
  await assert.rejects(() => commandHandlers['mixer.clearSolos']({}), /Audio console not configured/);
});

test('mixer.clearSolos calls clearSolos and returns message', async () => {
  let called = false;
  const agent = mockMixer('X32', { clearSolos: async () => { called = true; } });
  const result = await commandHandlers['mixer.clearSolos'](agent);
  assert.equal(called, true);
  assert.ok(result.includes('solos cleared'));
});

test('mixer.clearSolos throws on Allen & Heath SQ (clearSolos: false)', async () => {
  const agent = mockMixer('SQ');
  await assert.rejects(
    () => commandHandlers['mixer.clearSolos'](agent),
    /not supported on SQ/
  );
});

// ─── mixer.capabilities ───────────────────────────────────────────────────────

test('mixer.capabilities throws when no mixer', () => {
  assert.throws(() => commandHandlers['mixer.capabilities']({}), /Audio console not configured/);
});

test('mixer.capabilities returns capability report for X32', () => {
  const agent = mockMixer('X32');
  const result = commandHandlers['mixer.capabilities'](agent);
  assert.ok(typeof result === 'string');
  assert.ok(result.includes('X32'));
  assert.ok(result.includes('compressor'));
  assert.ok(result.includes('✅'));
});

test('mixer.capabilities shows partial support as ⚠️', () => {
  const agent = mockMixer('X32');
  const result = commandHandlers['mixer.capabilities'](agent);
  assert.ok(result.includes('⚠️'));
});

test('mixer.capabilities shows not available as ❌ for SQ compressor', () => {
  const agent = mockMixer('SQ');
  const result = commandHandlers['mixer.capabilities'](agent);
  assert.ok(result.includes('❌'));
});

test('mixer.capabilities returns object note for unknown model', () => {
  const agent = mockMixer('UNKNOWN_MIXER_XYZ');
  const result = commandHandlers['mixer.capabilities'](agent);
  // Unknown model returns an object with a note
  assert.ok(typeof result === 'object' || typeof result === 'string');
  if (typeof result === 'object') {
    assert.ok(result.note.includes('Unknown mixer'));
  }
});

// ─── mixer.setupFromPatchList ─────────────────────────────────────────────────

test('mixer.setupFromPatchList throws when no mixer', async () => {
  await assert.rejects(
    () => commandHandlers['mixer.setupFromPatchList']({}, { channels: [] }),
    /Audio console not configured/
  );
});

test('mixer.setupFromPatchList throws when channels is empty', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(
    () => commandHandlers['mixer.setupFromPatchList'](agent, { channels: [] }),
    /No channels provided/
  );
});

test('mixer.setupFromPatchList throws when channels is not an array', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(
    () => commandHandlers['mixer.setupFromPatchList'](agent, {}),
    /No channels provided/
  );
});

test('mixer.setupFromPatchList applies all channels and reports results', async () => {
  const applied = [];
  const agent = mockMixer('X32', {
    setFullChannelStrip: async (ch, data) => { applied.push(ch); },
  });
  const result = await commandHandlers['mixer.setupFromPatchList'](agent, {
    channels: [
      { channel: 1, name: 'Kick' },
      { channel: 2, name: 'Snare' },
    ],
  });
  assert.deepEqual(applied, [1, 2]);
  assert.ok(result.includes('2 applied'));
  assert.ok(result.includes('0 failed'));
});

test('mixer.setupFromPatchList handles setFullChannelStrip failure gracefully', async () => {
  const agent = mockMixer('X32', {
    setFullChannelStrip: async () => { throw new Error('hardware error'); },
  });
  const result = await commandHandlers['mixer.setupFromPatchList'](agent, {
    channels: [{ channel: 1, name: 'Kick' }],
  });
  assert.ok(result.includes('0 applied'));
  assert.ok(result.includes('1 failed'));
  assert.ok(result.includes('⚠️'));
});

test('mixer.setupFromPatchList saves scene when saveScene=true and X32 supports it', async () => {
  let sceneSaved = null;
  const agent = mockMixer('X32', {
    setFullChannelStrip: async () => {},
    saveScene: async (num, name) => { sceneSaved = { num, name }; },
  });
  const result = await commandHandlers['mixer.setupFromPatchList'](agent, {
    channels: [{ channel: 1, name: 'Kick' }],
    saveScene: true,
    sceneName: 'Sunday Setup',
  });
  assert.ok(sceneSaved !== null, 'Scene should have been saved');
  assert.equal(sceneSaved.num, 90);
  assert.equal(sceneSaved.name, 'Sunday Setup');
  assert.ok(result.includes('applied'));
});

test('mixer.setupFromPatchList reports skipped features on SQ mixer', async () => {
  const agent = mockMixer('SQ', {
    setFullChannelStrip: async () => {},
  });
  const result = await commandHandlers['mixer.setupFromPatchList'](agent, {
    channels: [{ channel: 1, name: 'Kick' }],
  });
  // SQ doesn't support compressor/gate — should note skipped features
  assert.ok(result.includes('Skipped') || result.includes('ℹ️'));
});

test('mixer.setupFromPatchList uses date-based label when sceneName not provided', async () => {
  let savedName = null;
  const agent = mockMixer('X32', {
    setFullChannelStrip: async () => {},
    saveScene: async (num, name) => { savedName = name; },
  });
  await commandHandlers['mixer.setupFromPatchList'](agent, {
    channels: [{ channel: 1, name: 'Kick' }],
    saveScene: true,
  });
  assert.ok(savedName && savedName.includes('AI Setup'), `Expected 'AI Setup' in name, got: ${savedName}`);
});
