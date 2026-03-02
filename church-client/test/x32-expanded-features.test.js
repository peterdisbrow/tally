const test = require('node:test');
const assert = require('node:assert/strict');

const { commandHandlers } = require('../src/commands');
const {
  panToFloat, panFloatToValue,
  trimGainToFloat, trimFloatToGain,
  headampGainToFloat, headampFloatToGain,
  sendLevelDbToFloat,
  normalizeColor, normalizeIcon,
  X32_COLORS, X32_ICONS,
} = require('../src/mixers/x32-osc-map');

// ─── SCALING HELPER TESTS ───────────────────────────────────────────────────

test('panToFloat: -1 → 0, 0 → 0.5, +1 → 1', () => {
  assert.equal(panToFloat(-1), 0);
  assert.equal(panToFloat(0), 0.5);
  assert.equal(panToFloat(1), 1);
});

test('panToFloat clamps out-of-range values', () => {
  assert.equal(panToFloat(-5), 0);
  assert.equal(panToFloat(99), 1);
});

test('panFloatToValue round-trips', () => {
  for (const v of [-1, -0.5, 0, 0.5, 1]) {
    const f = panToFloat(v);
    assert.ok(Math.abs(panFloatToValue(f) - v) < 0.001, `round-trip failed for ${v}`);
  }
});

test('trimGainToFloat: -18 → 0, 0 → 0.5, +18 → 1', () => {
  assert.equal(trimGainToFloat(-18), 0);
  assert.equal(trimGainToFloat(0), 0.5);
  assert.equal(trimGainToFloat(18), 1);
});

test('trimGainToFloat clamps', () => {
  assert.equal(trimGainToFloat(-50), 0);
  assert.equal(trimGainToFloat(50), 1);
});

test('trimFloatToGain round-trips', () => {
  for (const dB of [-18, -9, 0, 9, 18]) {
    const f = trimGainToFloat(dB);
    assert.ok(Math.abs(trimFloatToGain(f) - dB) < 0.001, `round-trip failed for ${dB}`);
  }
});

test('headampGainToFloat: -12 → 0, 0 → ~0.167, +60 → 1', () => {
  assert.equal(headampGainToFloat(-12), 0);
  assert.equal(headampGainToFloat(60), 1);
  assert.ok(Math.abs(headampGainToFloat(0) - 12/72) < 0.001);
});

test('headampFloatToGain round-trips', () => {
  for (const dB of [-12, 0, 24, 48, 60]) {
    const f = headampGainToFloat(dB);
    assert.ok(Math.abs(headampFloatToGain(f) - dB) < 0.001, `round-trip failed for ${dB}`);
  }
});

test('sendLevelDbToFloat is the same function as faderDbToFloat', () => {
  // Send levels use the same taper as main fader
  assert.equal(sendLevelDbToFloat(-90), 0);
  assert.equal(sendLevelDbToFloat(10), 1);
  assert.ok(sendLevelDbToFloat(0) > 0.7); // unity should be high
});

// ─── COLOR / ICON NORMALIZATION ─────────────────────────────────────────────

test('normalizeColor accepts integers 0–15', () => {
  assert.equal(normalizeColor(0), 0);
  assert.equal(normalizeColor(7), 7);
  assert.equal(normalizeColor(15), 15);
});

test('normalizeColor clamps out-of-range integers', () => {
  assert.equal(normalizeColor(-1), 0);
  assert.equal(normalizeColor(99), 15);
});

test('normalizeColor accepts name strings', () => {
  assert.equal(normalizeColor('red'), 1);
  assert.equal(normalizeColor('Green'), 2);
  assert.equal(normalizeColor('BLUE'), 4);
  assert.equal(normalizeColor('white'), 7);
  assert.equal(normalizeColor('red-inv'), 9);
});

test('normalizeColor accepts short codes', () => {
  assert.equal(normalizeColor('RD'), 1);
  assert.equal(normalizeColor('GN'), 2);
  assert.equal(normalizeColor('BL'), 4);
  assert.equal(normalizeColor('WHi'), 15);
});

test('normalizeColor throws for unknown string', () => {
  assert.throws(() => normalizeColor('purple'), /Unknown X32 color/);
});

test('normalizeIcon accepts integers 1–74', () => {
  assert.equal(normalizeIcon(1), 1);
  assert.equal(normalizeIcon(47), 47);
  assert.equal(normalizeIcon(74), 74);
});

test('normalizeIcon clamps out-of-range integers', () => {
  assert.equal(normalizeIcon(0), 1);
  assert.equal(normalizeIcon(100), 74);
});

test('normalizeIcon accepts name strings', () => {
  assert.equal(normalizeIcon('mic'), 47);
  assert.equal(normalizeIcon('guitar'), 23);
  assert.equal(normalizeIcon('kick'), 2);
  assert.equal(normalizeIcon('drums'), 11);
  assert.equal(normalizeIcon('vocal'), 41);
  assert.equal(normalizeIcon('piano'), 27);
});

test('normalizeIcon throws for unknown string', () => {
  assert.throws(() => normalizeIcon('ukulele'), /Unknown X32 icon/);
});

// ─── MOCK HELPERS ───────────────────────────────────────────────────────────

function mockX32(overrides = {}) {
  return {
    mixer: {
      model: 'X32',
      setPreampGain: async () => {},
      setHeadampGain: async () => {},
      setPhantom: async () => {},
      setPan: async () => {},
      setChannelColor: async () => {},
      setChannelIcon: async () => {},
      setSendLevel: async () => {},
      assignToBus: async () => {},
      assignToDca: async () => {},
      getMeters: async (chs) => (chs || [1,2,3]).map(c => ({ channel: c, fader: 0.75, muted: false })),
      verifySceneSave: async (n) => ({ sceneNumber: n, name: 'TestScene', exists: true }),
      isOnline: async () => true,
      getStatus: async () => ({ online: true, type: 'behringer', model: 'X32', mainFader: 0.75, mainMuted: false }),
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
      ...overrides,
    },
  };
}

function mockSQ(overrides = {}) {
  return {
    mixer: {
      model: 'SQ',
      isOnline: async () => true,
      setFader: async () => {},
      setChannelName: async () => {},
      setHpf: async () => {},
      setEq: async () => {},
      setFullChannelStrip: async () => {},
      muteMaster: async () => {},
      unmuteMaster: async () => {},
      muteChannel: async () => {},
      unmuteChannel: async () => {},
      recallScene: async () => {},
      getStatus: async () => ({ online: true }),
      getChannelStatus: async () => ({ fader: 0.5, muted: false }),
      ...overrides,
    },
  };
}

// ─── COMMAND HANDLER TESTS: X32 (ALL SHOULD SUCCEED) ────────────────────────

test('mixer.setPreampGain on X32 succeeds', async () => {
  const agent = mockX32();
  const result = await commandHandlers['mixer.setPreampGain'](agent, { channel: 1, gain: 6 });
  assert.ok(result.includes('+6'));
  assert.ok(result.includes('dB'));
});

test('mixer.setPreampGain validates gain param', async () => {
  const agent = mockX32();
  await assert.rejects(
    () => commandHandlers['mixer.setPreampGain'](agent, { channel: 1 }),
    /gain parameter required/
  );
});

test('mixer.setPhantom on X32 succeeds', async () => {
  const agent = mockX32();
  const result = await commandHandlers['mixer.setPhantom'](agent, { channel: 3, enabled: true });
  assert.ok(result.includes('phantom'));
  assert.ok(result.includes('ON'));
});

test('mixer.setPan on X32 succeeds', async () => {
  const agent = mockX32();
  const result = await commandHandlers['mixer.setPan'](agent, { channel: 1, pan: -0.5 });
  assert.ok(result.includes('pan'));
  assert.ok(result.includes('L'));
});

test('mixer.setPan center', async () => {
  const agent = mockX32();
  const result = await commandHandlers['mixer.setPan'](agent, { channel: 1, pan: 0 });
  assert.ok(result.includes('Center'));
});

test('mixer.setChannelColor on X32 succeeds', async () => {
  const agent = mockX32();
  const result = await commandHandlers['mixer.setChannelColor'](agent, { channel: 1, color: 'red' });
  assert.ok(result.includes('color'));
  assert.ok(result.includes('red'));
});

test('mixer.setChannelIcon on X32 succeeds', async () => {
  const agent = mockX32();
  const result = await commandHandlers['mixer.setChannelIcon'](agent, { channel: 1, icon: 'mic' });
  assert.ok(result.includes('icon'));
  assert.ok(result.includes('mic'));
});

test('mixer.setSendLevel on X32 succeeds', async () => {
  const agent = mockX32();
  const result = await commandHandlers['mixer.setSendLevel'](agent, { channel: 1, bus: 3, level: 0.7 });
  assert.ok(result.includes('Bus 3'));
  assert.ok(result.includes('70%'));
});

test('mixer.setSendLevel validates params', async () => {
  const agent = mockX32();
  await assert.rejects(() => commandHandlers['mixer.setSendLevel'](agent, { channel: 1 }), /bus parameter required/);
  await assert.rejects(() => commandHandlers['mixer.setSendLevel'](agent, { channel: 1, bus: 1 }), /level parameter required/);
});

test('mixer.assignToBus on X32 succeeds', async () => {
  const agent = mockX32();
  const result = await commandHandlers['mixer.assignToBus'](agent, { channel: 1, bus: 5, enabled: true });
  assert.ok(result.includes('Bus 5'));
  assert.ok(result.includes('assigned'));
});

test('mixer.assignToDca on X32 succeeds', async () => {
  const agent = mockX32();
  const result = await commandHandlers['mixer.assignToDca'](agent, { channel: 1, dca: 2, enabled: true });
  assert.ok(result.includes('DCA 2'));
  assert.ok(result.includes('assigned'));
});

test('mixer.getMeters on X32 returns formatted output', async () => {
  const agent = mockX32();
  const result = await commandHandlers['mixer.getMeters'](agent, {});
  assert.ok(result.includes('📊'));
  assert.ok(result.includes('Ch'));
  assert.ok(result.includes('🔊'));
});

test('mixer.getMeters with specific channels', async () => {
  const agent = mockX32({
    getMeters: async (chs) => chs.map(c => ({ channel: c, fader: 0.5, muted: c === 2 })),
  });
  const result = await commandHandlers['mixer.getMeters'](agent, { channels: [1, 2, 3] });
  assert.ok(result.includes('🔇')); // channel 2 is muted
});

test('mixer.verifySceneSave on X32 succeeds', async () => {
  const agent = mockX32();
  const result = await commandHandlers['mixer.verifySceneSave'](agent, { scene: 5 });
  assert.ok(result.includes('✅'));
  assert.ok(result.includes('TestScene'));
});

test('mixer.verifySceneSave reports missing scene', async () => {
  const agent = mockX32({
    verifySceneSave: async () => ({ sceneNumber: 99, name: null, exists: false }),
  });
  const result = await commandHandlers['mixer.verifySceneSave'](agent, { scene: 99 });
  assert.ok(result.includes('⚠️'));
});

// ─── CAPABILITY GATING: NEW FEATURES ON SQ ──────────────────────────────────

test('SQ mixer blocks preampGain (not in capability map)', async () => {
  const agent = mockSQ();
  await assert.rejects(
    () => commandHandlers['mixer.setPreampGain'](agent, { channel: 1, gain: 6 }),
    /not supported on SQ/
  );
});

test('SQ mixer blocks phantom', async () => {
  const agent = mockSQ();
  await assert.rejects(
    () => commandHandlers['mixer.setPhantom'](agent, { channel: 1, enabled: true }),
    /not supported on SQ/
  );
});

test('SQ mixer allows pan (has pan: full)', async () => {
  const agent = mockSQ({ setPan: async () => {} });
  const result = await commandHandlers['mixer.setPan'](agent, { channel: 1, pan: 0 });
  assert.ok(result.includes('Center'));
});

test('SQ mixer blocks channelColor (not in capability map)', async () => {
  const agent = mockSQ();
  await assert.rejects(
    () => commandHandlers['mixer.setChannelColor'](agent, { channel: 1, color: 'red' }),
    /not supported on SQ/
  );
});

test('SQ mixer blocks metering', async () => {
  const agent = mockSQ();
  await assert.rejects(
    () => commandHandlers['mixer.getMeters'](agent, {}),
    /not supported on SQ/
  );
});

// ─── PARAM VALIDATION ───────────────────────────────────────────────────────

test('mixer.setPreampGain requires channel', async () => {
  const agent = mockX32();
  await assert.rejects(
    () => commandHandlers['mixer.setPreampGain'](agent, { gain: 6 }),
    /channel parameter required/
  );
});

test('mixer.setPan requires channel', async () => {
  const agent = mockX32();
  await assert.rejects(
    () => commandHandlers['mixer.setPan'](agent, { pan: 0 }),
    /channel parameter required/
  );
});

test('mixer.setChannelColor requires color', async () => {
  const agent = mockX32();
  await assert.rejects(
    () => commandHandlers['mixer.setChannelColor'](agent, { channel: 1 }),
    /color parameter required/
  );
});

test('mixer.setChannelIcon requires icon', async () => {
  const agent = mockX32();
  await assert.rejects(
    () => commandHandlers['mixer.setChannelIcon'](agent, { channel: 1 }),
    /icon parameter required/
  );
});

test('mixer.assignToDca requires dca param', async () => {
  const agent = mockX32();
  await assert.rejects(
    () => commandHandlers['mixer.assignToDca'](agent, { channel: 1 }),
    /dca parameter required/
  );
});

test('mixer.verifySceneSave requires scene', async () => {
  const agent = mockX32();
  await assert.rejects(
    () => commandHandlers['mixer.verifySceneSave'](agent, {}),
    /scene number required/
  );
});

test('no mixer configured throws for all new commands', async () => {
  const noMixer = {};
  const cmds = [
    ['mixer.setPreampGain', { channel: 1, gain: 0 }],
    ['mixer.setPhantom', { channel: 1, enabled: true }],
    ['mixer.setPan', { channel: 1, pan: 0 }],
    ['mixer.setChannelColor', { channel: 1, color: 'red' }],
    ['mixer.setChannelIcon', { channel: 1, icon: 'mic' }],
    ['mixer.setSendLevel', { channel: 1, bus: 1, level: 0.5 }],
    ['mixer.assignToBus', { channel: 1, bus: 1, enabled: true }],
    ['mixer.assignToDca', { channel: 1, dca: 1, enabled: true }],
    ['mixer.getMeters', {}],
    ['mixer.verifySceneSave', { scene: 1 }],
  ];
  for (const [cmd, params] of cmds) {
    await assert.rejects(
      () => commandHandlers[cmd](noMixer, params),
      /Audio console not configured/,
      `${cmd} should require mixer`
    );
  }
});
