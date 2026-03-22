const test = require('node:test');
const assert = require('node:assert/strict');

const { commandHandlers } = require('../src/commands');
const { mixerBrandName } = require('../src/commands/mixer');

// Full mock mixer with all methods (overrides selectively)
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
      getMeters: async () => [{ channel: 1, fader: 0.5, muted: false }],
      verifySceneSave: async (scene) => ({ exists: true, sceneNumber: scene, name: 'Test Scene' }),
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

// ─── mixer.status ─────────────────────────────────────────────────────────────

test('mixer.status throws when no mixer configured', async () => {
  await assert.rejects(() => commandHandlers['mixer.status']({}), /Audio console not configured/);
});

test('mixer.status shows offline message when not responding', async () => {
  const agent = mockMixer('X32', {
    getStatus: async () => ({ online: false, type: 'behringer', model: 'X32' }),
  });
  const result = await commandHandlers['mixer.status'](agent, {});
  assert.ok(result.includes('Offline'));
  assert.ok(result.includes('not responding'));
});

test('mixer.status shows online with fader percentage and scene', async () => {
  const agent = mockMixer('X32', {
    getStatus: async () => ({
      online: true, type: 'x32', model: 'X32',
      mainFader: 0.75, mainMuted: false, scene: 5, firmware: '4.0.6',
    }),
  });
  const result = await commandHandlers['mixer.status'](agent, {});
  assert.ok(result.includes('Online'));
  assert.ok(result.includes('75%'));
  assert.ok(result.includes('Scene: 5'));
  assert.ok(result.includes('4.0.6'));
});

test('mixer.status shows MUTED when main output muted', async () => {
  const agent = mockMixer('X32', {
    getStatus: async () => ({ online: true, type: 'x32', model: 'X32', mainFader: 0, mainMuted: true }),
  });
  const result = await commandHandlers['mixer.status'](agent, {});
  assert.ok(result.includes('MUTED'));
});

// ─── mixer.mute / mixer.unmute ────────────────────────────────────────────────

test('mixer.mute throws when no mixer', async () => {
  await assert.rejects(() => commandHandlers['mixer.mute']({}, {}), /Audio console not configured/);
});

test('mixer.mute without channel mutes master output', async () => {
  let called = false;
  const agent = mockMixer('X32', { muteMaster: async () => { called = true; } });
  const result = await commandHandlers['mixer.mute'](agent, {});
  assert.ok(called);
  assert.equal(result, 'Master output muted');
});

test('mixer.mute with channel="master" also mutes master', async () => {
  let called = false;
  const agent = mockMixer('X32', { muteMaster: async () => { called = true; } });
  const result = await commandHandlers['mixer.mute'](agent, { channel: 'master' });
  assert.ok(called);
  assert.equal(result, 'Master output muted');
});

test('mixer.mute with channel number mutes that channel', async () => {
  let mutedCh = null;
  const agent = mockMixer('X32', { muteChannel: async (ch) => { mutedCh = ch; } });
  const result = await commandHandlers['mixer.mute'](agent, { channel: 5 });
  assert.equal(mutedCh, 5);
  assert.equal(result, 'Channel 5 muted');
});

test('mixer.unmute throws when no mixer', async () => {
  await assert.rejects(() => commandHandlers['mixer.unmute']({}, {}), /Audio console not configured/);
});

test('mixer.unmute without channel unmutes master', async () => {
  let called = false;
  const agent = mockMixer('X32', { unmuteMaster: async () => { called = true; } });
  const result = await commandHandlers['mixer.unmute'](agent, {});
  assert.ok(called);
  assert.equal(result, 'Master output unmuted');
});

test('mixer.unmute with channel number unmutes that channel', async () => {
  let unmutedCh = null;
  const agent = mockMixer('X32', { unmuteChannel: async (ch) => { unmutedCh = ch; } });
  const result = await commandHandlers['mixer.unmute'](agent, { channel: 3 });
  assert.equal(unmutedCh, 3);
  assert.equal(result, 'Channel 3 unmuted');
});

// ─── mixer.channelStatus ──────────────────────────────────────────────────────

test('mixer.channelStatus throws when no mixer', async () => {
  await assert.rejects(() => commandHandlers['mixer.channelStatus']({}, {}), /Audio console not configured/);
});

test('mixer.channelStatus requires channel parameter', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(() => commandHandlers['mixer.channelStatus'](agent, {}), /channel parameter required/);
});

test('mixer.channelStatus returns formatted channel status', async () => {
  const agent = mockMixer('X32', {
    getChannelStatus: async () => ({ fader: 0.75, muted: false, name: 'Vocals' }),
  });
  const result = await commandHandlers['mixer.channelStatus'](agent, { channel: 1 });
  assert.ok(result.includes('Channel 1'));
  assert.ok(result.includes('75%'));
  assert.ok(result.includes('Vocals'));
  assert.ok(result.includes('Active'));
});

test('mixer.channelStatus shows Muted state', async () => {
  const agent = mockMixer('X32', {
    getChannelStatus: async () => ({ fader: 0, muted: true }),
  });
  const result = await commandHandlers['mixer.channelStatus'](agent, { channel: 2 });
  assert.ok(result.includes('Muted'));
});

// ─── mixer.recallScene ────────────────────────────────────────────────────────

test('mixer.recallScene throws when no mixer', async () => {
  await assert.rejects(() => commandHandlers['mixer.recallScene']({}, {}), /Audio console not configured/);
});

test('mixer.recallScene requires scene parameter', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(() => commandHandlers['mixer.recallScene'](agent, {}), /scene parameter required/);
});

test('mixer.recallScene calls recallScene with correct scene number', async () => {
  let recalled = null;
  const agent = mockMixer('X32', { recallScene: async (s) => { recalled = s; } });
  const result = await commandHandlers['mixer.recallScene'](agent, { scene: 7 });
  assert.equal(recalled, 7);
  assert.equal(result, 'Scene 7 recalled');
});

// ─── mixer.isOnline ───────────────────────────────────────────────────────────

test('mixer.isOnline throws when no mixer', async () => {
  await assert.rejects(() => commandHandlers['mixer.isOnline']({}), /Audio console not configured/);
});

test('mixer.isOnline returns Online when reachable', async () => {
  const agent = { ...mockMixer('X32'), config: { mixer: { type: 'behringer', model: 'X32' } } };
  const result = await commandHandlers['mixer.isOnline'](agent);
  assert.ok(result.includes('Online'));
});

test('mixer.isOnline returns Not reachable when offline', async () => {
  const agent = {
    ...mockMixer('X32', { isOnline: async () => false }),
    config: { mixer: { type: 'behringer', model: 'X32' } },
  };
  const result = await commandHandlers['mixer.isOnline'](agent);
  assert.ok(result.includes('Not reachable'));
});

// ─── mixer.setFader ───────────────────────────────────────────────────────────

test('mixer.setFader requires channel', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(() => commandHandlers['mixer.setFader'](agent, { level: 0.5 }), /channel parameter required/);
});

test('mixer.setFader requires level', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(() => commandHandlers['mixer.setFader'](agent, { channel: 1 }), /level parameter required/);
});

test('mixer.setFader calls setFader and returns percentage', async () => {
  let ch = null, lvl = null;
  const agent = mockMixer('X32', { setFader: async (c, l) => { ch = c; lvl = l; } });
  const result = await commandHandlers['mixer.setFader'](agent, { channel: 3, level: 0.8 });
  assert.equal(ch, 3);
  assert.equal(lvl, 0.8);
  assert.ok(result.includes('80%'));
});

// ─── mixer.setPreampGain ──────────────────────────────────────────────────────

test('mixer.setPreampGain requires channel', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(() => commandHandlers['mixer.setPreampGain'](agent, { gain: 6 }), /channel parameter required/);
});

test('mixer.setPreampGain requires gain', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(() => commandHandlers['mixer.setPreampGain'](agent, { channel: 1 }), /gain parameter required/);
});

test('mixer.setPreampGain rejects non-numeric gain', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(
    () => commandHandlers['mixer.setPreampGain'](agent, { channel: 1, gain: 'loud' }),
    /gain must be a number/
  );
});

test('mixer.setPreampGain formats positive gain with + prefix', async () => {
  let ch = null, gain = null;
  const agent = mockMixer('X32', { setPreampGain: async (c, g) => { ch = c; gain = g; } });
  const result = await commandHandlers['mixer.setPreampGain'](agent, { channel: 2, gain: 6 });
  assert.equal(ch, 2);
  assert.equal(gain, 6);
  assert.ok(result.includes('+6 dB'));
});

test('mixer.setPreampGain formats negative gain without double sign', async () => {
  const agent = mockMixer('X32');
  const result = await commandHandlers['mixer.setPreampGain'](agent, { channel: 1, gain: -12 });
  assert.ok(result.includes('-12 dB'));
  assert.ok(!result.includes('+-12'));
});

// ─── mixer.setPhantom ────────────────────────────────────────────────────────

test('mixer.setPhantom requires channel', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(() => commandHandlers['mixer.setPhantom'](agent, {}), /channel parameter required/);
});

test('mixer.setPhantom enables phantom power by default', async () => {
  let on = null;
  const agent = mockMixer('X32', { setPhantom: async (c, o) => { on = o; } });
  const result = await commandHandlers['mixer.setPhantom'](agent, { channel: 1 });
  assert.equal(on, true);
  assert.ok(result.includes('ON'));
});

test('mixer.setPhantom disables when enabled=false', async () => {
  let on = null;
  const agent = mockMixer('X32', { setPhantom: async (c, o) => { on = o; } });
  const result = await commandHandlers['mixer.setPhantom'](agent, { channel: 1, enabled: false });
  assert.equal(on, false);
  assert.ok(result.includes('OFF'));
});

// ─── mixer.setPan ────────────────────────────────────────────────────────────

test('mixer.setPan requires channel', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(() => commandHandlers['mixer.setPan'](agent, { pan: 0 }), /channel parameter required/);
});

test('mixer.setPan requires pan', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(() => commandHandlers['mixer.setPan'](agent, { channel: 1 }), /pan parameter required/);
});

test('mixer.setPan rejects values outside -1.0 to 1.0', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(
    () => commandHandlers['mixer.setPan'](agent, { channel: 1, pan: 1.5 }),
    /out of range/
  );
  await assert.rejects(
    () => commandHandlers['mixer.setPan'](agent, { channel: 1, pan: -2 }),
    /out of range/
  );
});

test('mixer.setPan labels center (0) correctly', async () => {
  const agent = mockMixer('X32');
  const result = await commandHandlers['mixer.setPan'](agent, { channel: 1, pan: 0 });
  assert.ok(result.includes('Center'));
});

test('mixer.setPan labels left pan with L', async () => {
  const agent = mockMixer('X32');
  const result = await commandHandlers['mixer.setPan'](agent, { channel: 1, pan: -0.5 });
  assert.ok(result.includes('L'));
  assert.ok(result.includes('50'));
});

test('mixer.setPan labels right pan with R', async () => {
  const agent = mockMixer('X32');
  const result = await commandHandlers['mixer.setPan'](agent, { channel: 1, pan: 0.75 });
  assert.ok(result.includes('R'));
  assert.ok(result.includes('75'));
});

// ─── mixer.setChannelColor / setChannelIcon ───────────────────────────────────

test('mixer.setChannelColor requires channel and color', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(() => commandHandlers['mixer.setChannelColor'](agent, {}), /channel parameter required/);
  await assert.rejects(
    () => commandHandlers['mixer.setChannelColor'](agent, { channel: 1 }),
    /color parameter required/
  );
});

test('mixer.setChannelColor calls setChannelColor and returns label', async () => {
  let args = null;
  const agent = mockMixer('X32', { setChannelColor: async (c, col) => { args = { c, col }; } });
  const result = await commandHandlers['mixer.setChannelColor'](agent, { channel: 1, color: 'red' });
  assert.deepEqual(args, { c: 1, col: 'red' });
  assert.ok(result.includes('red'));
});

test('mixer.setChannelIcon requires channel and icon', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(() => commandHandlers['mixer.setChannelIcon'](agent, {}), /channel parameter required/);
  await assert.rejects(
    () => commandHandlers['mixer.setChannelIcon'](agent, { channel: 1 }),
    /icon parameter required/
  );
});

test('mixer.setChannelIcon calls setChannelIcon and returns label', async () => {
  const agent = mockMixer('X32');
  const result = await commandHandlers['mixer.setChannelIcon'](agent, { channel: 2, icon: 'mic' });
  assert.ok(result.includes('mic'));
});

// ─── mixer.setSendLevel ───────────────────────────────────────────────────────

test('mixer.setSendLevel requires channel, bus, and level', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(() => commandHandlers['mixer.setSendLevel'](agent, {}), /channel parameter required/);
  await assert.rejects(
    () => commandHandlers['mixer.setSendLevel'](agent, { channel: 1 }),
    /bus parameter required/
  );
  await assert.rejects(
    () => commandHandlers['mixer.setSendLevel'](agent, { channel: 1, bus: 3 }),
    /level parameter required/
  );
});

test('mixer.setSendLevel rejects bus out of range 1–16', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(
    () => commandHandlers['mixer.setSendLevel'](agent, { channel: 1, bus: 0, level: 0.5 }),
    /bus must be an integer in range 1.16/
  );
  await assert.rejects(
    () => commandHandlers['mixer.setSendLevel'](agent, { channel: 1, bus: 17, level: 0.5 }),
    /bus must be an integer in range 1.16/
  );
});

test('mixer.setSendLevel rejects level outside 0.0–1.0', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(
    () => commandHandlers['mixer.setSendLevel'](agent, { channel: 1, bus: 3, level: 1.5 }),
    /level must be a number in range/
  );
  await assert.rejects(
    () => commandHandlers['mixer.setSendLevel'](agent, { channel: 1, bus: 3, level: -0.1 }),
    /level must be a number in range/
  );
});

test('mixer.setSendLevel calls setSendLevel with correct args', async () => {
  let args = null;
  const agent = mockMixer('X32', {
    setSendLevel: async (ch, bus, lvl) => { args = { ch, bus, lvl }; },
  });
  const result = await commandHandlers['mixer.setSendLevel'](agent, { channel: 2, bus: 4, level: 0.6 });
  assert.deepEqual(args, { ch: 2, bus: 4, lvl: 0.6 });
  assert.ok(result.includes('Bus 4'));
  assert.ok(result.includes('60%'));
});

// ─── mixer.assignToBus ────────────────────────────────────────────────────────

test('mixer.assignToBus requires channel and bus', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(() => commandHandlers['mixer.assignToBus'](agent, {}), /channel parameter required/);
  await assert.rejects(
    () => commandHandlers['mixer.assignToBus'](agent, { channel: 1 }),
    /bus parameter required/
  );
});

test('mixer.assignToBus assigns by default (enabled=true)', async () => {
  let args = null;
  const agent = mockMixer('X32', { assignToBus: async (ch, bus, on) => { args = { ch, bus, on }; } });
  const result = await commandHandlers['mixer.assignToBus'](agent, { channel: 1, bus: 3 });
  assert.deepEqual(args, { ch: 1, bus: 3, on: true });
  assert.ok(result.includes('assigned'));
});

test('mixer.assignToBus removes assignment when enabled=false', async () => {
  let args = null;
  const agent = mockMixer('X32', { assignToBus: async (ch, bus, on) => { args = { ch, bus, on }; } });
  const result = await commandHandlers['mixer.assignToBus'](agent, { channel: 1, bus: 3, enabled: false });
  assert.equal(args.on, false);
  assert.ok(result.includes('removed'));
});

// ─── mixer.assignToDca ────────────────────────────────────────────────────────

test('mixer.assignToDca requires channel and dca', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(() => commandHandlers['mixer.assignToDca'](agent, {}), /channel parameter required/);
  await assert.rejects(
    () => commandHandlers['mixer.assignToDca'](agent, { channel: 1 }),
    /dca parameter required/
  );
});

test('mixer.assignToDca assigns channel to DCA', async () => {
  let args = null;
  const agent = mockMixer('X32', { assignToDca: async (ch, dca, on) => { args = { ch, dca, on }; } });
  const result = await commandHandlers['mixer.assignToDca'](agent, { channel: 3, dca: 2 });
  assert.deepEqual(args, { ch: 3, dca: 2, on: true });
  assert.ok(result.includes('DCA 2'));
  assert.ok(result.includes('assigned'));
});

// ─── mixer.getMeters ──────────────────────────────────────────────────────────

test('mixer.getMeters formats channel meter bars', async () => {
  const agent = mockMixer('X32', {
    getMeters: async () => [
      { channel: 1, fader: 0.75, muted: false },
      { channel: 2, fader: 0, muted: true },
    ],
  });
  const result = await commandHandlers['mixer.getMeters'](agent, {});
  assert.ok(result.includes('Ch  1'));
  assert.ok(result.includes('75%'));
  assert.ok(result.includes('🔇'));
});

test('mixer.getMeters passes channels array to driver', async () => {
  let requestedChannels = null;
  const agent = mockMixer('X32', {
    getMeters: async (ch) => { requestedChannels = ch; return []; },
  });
  await commandHandlers['mixer.getMeters'](agent, { channels: [1, 2, 3] });
  assert.deepEqual(requestedChannels, [1, 2, 3]);
});

// ─── mixer.verifySceneSave ────────────────────────────────────────────────────

test('mixer.verifySceneSave requires scene parameter', async () => {
  const agent = mockMixer('X32');
  await assert.rejects(() => commandHandlers['mixer.verifySceneSave'](agent, {}), /scene number required/);
});

test('mixer.verifySceneSave returns verified message when scene exists', async () => {
  const agent = mockMixer('X32', {
    verifySceneSave: async (s) => ({ exists: true, sceneNumber: s, name: 'Sunday Morning' }),
  });
  const result = await commandHandlers['mixer.verifySceneSave'](agent, { scene: 5 });
  assert.ok(result.includes('✅'));
  assert.ok(result.includes('Scene 5'));
  assert.ok(result.includes('Sunday Morning'));
});

test('mixer.verifySceneSave returns warning when scene not found', async () => {
  const agent = mockMixer('X32', {
    verifySceneSave: async (s) => ({ exists: false, sceneNumber: s, name: null }),
  });
  const result = await commandHandlers['mixer.verifySceneSave'](agent, { scene: 99 });
  assert.ok(result.includes('⚠️'));
});

// ─── DCA commands ─────────────────────────────────────────────────────────────

test('mixer.muteDca requires dca parameter', async () => {
  const agent = mockMixer('SQ');
  await assert.rejects(() => commandHandlers['mixer.muteDca'](agent, {}), /dca number required/);
});

test('mixer.muteDca calls muteDca with correct number', async () => {
  let dcaNum = null;
  const agent = mockMixer('SQ', { muteDca: async (d) => { dcaNum = d; } });
  const result = await commandHandlers['mixer.muteDca'](agent, { dca: 3 });
  assert.equal(dcaNum, 3);
  assert.equal(result, 'DCA 3 muted');
});

test('mixer.unmuteDca calls unmuteDca with correct number', async () => {
  let dcaNum = null;
  const agent = mockMixer('SQ', { unmuteDca: async (d) => { dcaNum = d; } });
  const result = await commandHandlers['mixer.unmuteDca'](agent, { dca: 2 });
  assert.equal(dcaNum, 2);
  assert.equal(result, 'DCA 2 unmuted');
});

test('mixer.setDcaFader requires dca and level', async () => {
  const agent = mockMixer('SQ');
  await assert.rejects(() => commandHandlers['mixer.setDcaFader'](agent, {}), /dca number required/);
  await assert.rejects(() => commandHandlers['mixer.setDcaFader'](agent, { dca: 1 }), /level required/);
});

test('mixer.setDcaFader sets fader and returns percentage', async () => {
  let dcaNum = null, lvl = null;
  const agent = mockMixer('SQ', { setDcaFader: async (d, l) => { dcaNum = d; lvl = l; } });
  const result = await commandHandlers['mixer.setDcaFader'](agent, { dca: 1, level: 0.75 });
  assert.equal(dcaNum, 1);
  assert.equal(lvl, 0.75);
  assert.ok(result.includes('75%'));
});

test('mixer.setDcaFader clamps level above 1 to 1', async () => {
  let lvl = null;
  const agent = mockMixer('SQ', { setDcaFader: async (d, l) => { lvl = l; } });
  await commandHandlers['mixer.setDcaFader'](agent, { dca: 1, level: 2.0 });
  assert.equal(lvl, 1);
});

test('mixer.setDcaFader clamps level below 0 to 0', async () => {
  let lvl = null;
  const agent = mockMixer('SQ', { setDcaFader: async (d, l) => { lvl = l; } });
  await commandHandlers['mixer.setDcaFader'](agent, { dca: 1, level: -0.5 });
  assert.equal(lvl, 0);
});

// ─── Mute group commands ──────────────────────────────────────────────────────

test('mixer.activateMuteGroup requires group parameter', async () => {
  const agent = mockMixer('SQ');
  await assert.rejects(() => commandHandlers['mixer.activateMuteGroup'](agent, {}), /group number required/);
});

test('mixer.activateMuteGroup on SQ calls activateMuteGroup', async () => {
  let groupNum = null;
  const agent = mockMixer('SQ', { activateMuteGroup: async (g) => { groupNum = g; } });
  const result = await commandHandlers['mixer.activateMuteGroup'](agent, { group: 2 });
  assert.equal(groupNum, 2);
  assert.equal(result, 'Mute group 2 activated');
});

test('mixer.deactivateMuteGroup on SQ calls deactivateMuteGroup', async () => {
  let groupNum = null;
  const agent = mockMixer('SQ', { deactivateMuteGroup: async (g) => { groupNum = g; } });
  const result = await commandHandlers['mixer.deactivateMuteGroup'](agent, { group: 1 });
  assert.equal(groupNum, 1);
  assert.equal(result, 'Mute group 1 deactivated');
});

test('mixer.activateMuteGroup throws on dLive (muteGroup: false)', async () => {
  const agent = mockMixer('DLIVE');
  await assert.rejects(
    () => commandHandlers['mixer.activateMuteGroup'](agent, { group: 1 }),
    /not supported on DLIVE/
  );
});

test('mixer.deactivateMuteGroup throws on dLive (muteGroup: false)', async () => {
  const agent = mockMixer('DLIVE');
  await assert.rejects(
    () => commandHandlers['mixer.deactivateMuteGroup'](agent, { group: 1 }),
    /not supported on DLIVE/
  );
});

// ─── SoftKey commands ─────────────────────────────────────────────────────────

test('mixer.pressSoftKey requires key parameter', async () => {
  const agent = mockMixer('SQ');
  await assert.rejects(() => commandHandlers['mixer.pressSoftKey'](agent, {}), /softkey number required/);
});

test('mixer.pressSoftKey on SQ calls pressSoftKey', async () => {
  let keyNum = null;
  const agent = mockMixer('SQ', { pressSoftKey: async (k) => { keyNum = k; } });
  const result = await commandHandlers['mixer.pressSoftKey'](agent, { key: 5 });
  assert.equal(keyNum, 5);
  assert.equal(result, 'SoftKey 5 pressed');
});

test('mixer.pressSoftKey throws on dLive (softKey: false)', async () => {
  const agent = mockMixer('DLIVE');
  await assert.rejects(
    () => commandHandlers['mixer.pressSoftKey'](agent, { key: 1 }),
    /not supported on DLIVE/
  );
});

// ─── mixerBrandName helper ────────────────────────────────────────────────────

test('mixerBrandName returns correct brand strings', () => {
  assert.equal(mixerBrandName('behringer', 'X32'), 'Behringer X32');
  assert.equal(mixerBrandName('midas', 'M32'), 'Midas M32');
  assert.equal(mixerBrandName('allenheath', 'SQ5'), 'Allen & Heath SQ5');
  assert.equal(mixerBrandName('yamaha', 'CL5'), 'Yamaha CL5');
});

test('mixerBrandName returns default model when none provided', () => {
  assert.equal(mixerBrandName('behringer', ''), 'Behringer X32');
  assert.equal(mixerBrandName('midas', ''), 'Midas M32');
  assert.equal(mixerBrandName('allenheath', ''), 'Allen & Heath SQ');
});

test('mixerBrandName returns type or empty string for unknown brand', () => {
  const result = mixerBrandName('unknown', '');
  assert.equal(result, 'unknown');
});
