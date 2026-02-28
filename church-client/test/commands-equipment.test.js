const test = require('node:test');
const assert = require('node:assert/strict');

const { commandHandlers } = require('../src/commands');

// ─── Command registry coverage ─────────────────────────────────────────────

test('commandHandlers is a non-empty object', () => {
  assert.ok(typeof commandHandlers === 'object');
  assert.ok(Object.keys(commandHandlers).length > 200);
});

test('every registry value is a function', () => {
  for (const [name, handler] of Object.entries(commandHandlers)) {
    assert.equal(typeof handler, 'function', `${name} should be a function`);
  }
});

test('new equipment commands are registered', () => {
  const expected = [
    'videohub.getInputLabels',
    'videohub.getOutputLabels',
    'hyperdeck.status',
    'propresenter.version',
    'propresenter.messages',
    'vmix.startPlaylist',
    'vmix.stopPlaylist',
    'vmix.audioLevels',
    'resolume.version',
    'resolume.getBpm',
  ];
  for (const name of expected) {
    assert.ok(commandHandlers[name], `${name} should be registered`);
  }
});

test('encoder-specific commands are registered', () => {
  const expected = [
    'blackmagic.getActivePlatform', 'blackmagic.setActivePlatform',
    'blackmagic.getPlatforms', 'blackmagic.getPlatformConfig',
    'blackmagic.getVideoFormat', 'blackmagic.setVideoFormat',
    'blackmagic.getSupportedVideoFormats',
    'blackmagic.getAudioSources', 'blackmagic.setAudioSource',
    'aja.setVideoInput', 'aja.setAudioInput',
    'aja.setStreamProfile', 'aja.setRecordProfile',
    'aja.setMute', 'aja.recallPreset',
    'epiphan.startPublisher', 'epiphan.stopPublisher',
    'epiphan.getLayouts', 'epiphan.setActiveLayout',
    'epiphan.getStreamingParams', 'epiphan.setStreamingParams',
    'ecamm.togglePause', 'ecamm.getScenes', 'ecamm.setScene',
    'ecamm.nextScene', 'ecamm.prevScene', 'ecamm.toggleMute',
    'ecamm.getInputs', 'ecamm.setInput', 'ecamm.togglePIP',
    'ecamm.getOverlays',
    'ndi.getSource', 'ndi.setSource',
  ];
  for (const name of expected) {
    assert.ok(commandHandlers[name], `${name} should be registered`);
  }
});

test('mixer.capabilities command is registered', () => {
  assert.ok(commandHandlers['mixer.capabilities']);
});

// ─── Equipment command validation ───────────────────────────────────────────

test('videohub.getInputLabels throws when no hub', async () => {
  const agent = { videoHubs: null };
  await assert.rejects(
    () => commandHandlers['videohub.getInputLabels'](agent, {}),
    /Video Hub not configured/
  );
});

test('videohub.getOutputLabels throws when no hub', async () => {
  const agent = { videoHubs: [] };
  await assert.rejects(
    () => commandHandlers['videohub.getOutputLabels'](agent, {}),
    /Video Hub not configured/
  );
});

test('hyperdeck.status throws when not configured', async () => {
  const agent = { hyperdecks: [] };
  await assert.rejects(
    () => commandHandlers['hyperdeck.status'](agent, {}),
    /not configured/
  );
});

test('propresenter.version throws when not configured', async () => {
  const agent = { proPresenter: null };
  await assert.rejects(
    () => commandHandlers['propresenter.version'](agent, {}),
    /ProPresenter not configured/
  );
});

test('propresenter.messages throws when not configured', async () => {
  const agent = {};
  await assert.rejects(
    () => commandHandlers['propresenter.messages'](agent, {}),
    /ProPresenter not configured/
  );
});

test('vmix.startPlaylist throws when not configured', async () => {
  await assert.rejects(
    () => commandHandlers['vmix.startPlaylist']({}, {}),
    /vMix not configured/
  );
});

test('vmix.stopPlaylist throws when not configured', async () => {
  await assert.rejects(
    () => commandHandlers['vmix.stopPlaylist']({}, {}),
    /vMix not configured/
  );
});

test('vmix.audioLevels throws when not configured', async () => {
  await assert.rejects(
    () => commandHandlers['vmix.audioLevels']({}, {}),
    /vMix not configured/
  );
});

test('resolume.version throws when not configured', async () => {
  await assert.rejects(
    () => commandHandlers['resolume.version']({}, {}),
    /Resolume not configured/
  );
});

test('resolume.getBpm throws when not configured', async () => {
  await assert.rejects(
    () => commandHandlers['resolume.getBpm']({}, {}),
    /Resolume not configured/
  );
});

// ─── Equipment commands with mock devices (success paths) ───────────────────

test('videohub.getInputLabels returns formatted labels', async () => {
  const agent = { videoHubs: [{ getInputLabels: async () => [{ index: 0, label: 'Camera 1' }, { index: 1, label: 'Camera 2' }] }] };
  const result = await commandHandlers['videohub.getInputLabels'](agent, {});
  assert.ok(result.includes('Camera 1'));
  assert.ok(result.includes('Camera 2'));
});

test('videohub.getOutputLabels returns "no labels" for empty', async () => {
  const agent = { videoHubs: [{ getOutputLabels: async () => [] }] };
  const result = await commandHandlers['videohub.getOutputLabels'](agent, {});
  assert.ok(result.includes('No output labels'));
});

test('hyperdeck.status returns formatted status', async () => {
  const mockDeck = {
    connected: true,
    refreshStatus: async () => ({
      name: 'TestDeck', model: 'HyperDeck Studio Mini', protocolVersion: '1.12',
      connected: true, transport: 'record', recording: true, clipId: 5, slotId: 1,
    }),
  };
  const agent = { hyperdecks: [mockDeck] };
  const result = await commandHandlers['hyperdeck.status'](agent, {});
  assert.ok(result.includes('HyperDeck 1'));
  assert.ok(result.includes('Studio Mini'));
  assert.ok(result.includes('🔴 Yes'));
});

test('propresenter.version returns version string', async () => {
  const agent = { proPresenter: { getVersion: async () => '7.14' } };
  const result = await commandHandlers['propresenter.version'](agent, {});
  assert.ok(result.includes('7.14'));
});

test('propresenter.version handles null (not reachable)', async () => {
  const agent = { proPresenter: { getVersion: async () => null } };
  const result = await commandHandlers['propresenter.version'](agent, {});
  assert.ok(result.includes('not available'));
});

test('propresenter.messages returns formatted messages', async () => {
  const agent = { proPresenter: { getMessages: async () => [{ name: 'Welcome', id: '123' }] } };
  const result = await commandHandlers['propresenter.messages'](agent, {});
  assert.ok(result.includes('Welcome'));
});

test('vmix.startPlaylist calls through to device', async () => {
  let called = false;
  const agent = { vmix: { startPlaylist: async () => { called = true; return true; } } };
  const result = await commandHandlers['vmix.startPlaylist'](agent, {});
  assert.ok(called);
  assert.ok(result.includes('started'));
});

test('vmix.audioLevels returns level data', async () => {
  const agent = { vmix: { getAudioLevels: async () => ({ volume: 80, muted: false, meterL: -12, meterR: -14 }) } };
  const result = await commandHandlers['vmix.audioLevels'](agent, {});
  assert.ok(result.includes('80%'));
  assert.ok(result.includes('🔊'));
});

test('vmix.audioLevels handles null', async () => {
  const agent = { vmix: { getAudioLevels: async () => null } };
  const result = await commandHandlers['vmix.audioLevels'](agent, {});
  assert.ok(result.includes('not available'));
});

test('resolume.version returns version', async () => {
  const agent = { resolume: { getVersion: async () => 'Resolume Arena 7.16.0' } };
  const result = await commandHandlers['resolume.version'](agent, {});
  assert.ok(result.includes('7.16.0'));
});

test('resolume.getBpm returns BPM', async () => {
  const agent = { resolume: { getBpm: async () => 120 } };
  const result = await commandHandlers['resolume.getBpm'](agent, {});
  assert.ok(result.includes('120'));
});

// ─── Encoder-specific command validation ────────────────────────────────────

test('blackmagic commands throw when encoder is not blackmagic', async () => {
  const agent = { encoderBridge: { type: 'obs', adapter: {} } };
  await assert.rejects(
    () => commandHandlers['blackmagic.getPlatforms'](agent, {}),
    /not "blackmagic"/
  );
});

test('aja commands throw when encoder is not aja', async () => {
  const agent = { encoderBridge: { type: 'ecamm', adapter: {} } };
  await assert.rejects(
    () => commandHandlers['aja.setVideoInput'](agent, { source: 0 }),
    /not "aja"/
  );
});

test('epiphan commands throw when encoder is not epiphan', async () => {
  const agent = { encoderBridge: { type: 'obs', adapter: {} } };
  await assert.rejects(
    () => commandHandlers['epiphan.getLayouts'](agent, { channel: '1' }),
    /not "epiphan"/
  );
});

test('ecamm commands throw when encoder is not ecamm', async () => {
  const agent = { encoderBridge: { type: 'ndi', adapter: {} } };
  await assert.rejects(
    () => commandHandlers['ecamm.getScenes'](agent, {}),
    /not "ecamm"/
  );
});

test('ndi.getSource returns source when configured', () => {
  const agent = { encoderBridge: { type: 'ndi', adapter: { getSource: () => 'My NDI Feed' } } };
  const result = commandHandlers['ndi.getSource'](agent, {});
  assert.ok(result.includes('My NDI Feed'));
});

test('ndi.setSource validates source parameter', () => {
  const agent = { encoderBridge: { type: 'ndi', adapter: { setSource: () => {} } } };
  assert.throws(
    () => commandHandlers['ndi.setSource'](agent, {}),
    /source parameter required/
  );
});

test('ndi.setSource calls adapter', () => {
  let src = null;
  const agent = { encoderBridge: { type: 'ndi', adapter: { setSource: (s) => { src = s; } } } };
  const result = commandHandlers['ndi.setSource'](agent, { source: 'Feed 1' });
  assert.equal(src, 'Feed 1');
  assert.ok(result.includes('Feed 1'));
});

test('encoder commands throw when no encoder bridge', async () => {
  const agent = {};
  await assert.rejects(
    () => commandHandlers['blackmagic.getPlatforms'](agent, {}),
    /Encoder not configured/
  );
});

// ─── Encoder adapter success paths ──────────────────────────────────────────

test('blackmagic.getPlatforms returns platforms list', async () => {
  const agent = {
    encoderBridge: {
      type: 'blackmagic',
      adapter: { getPlatforms: async () => ['YouTube', 'Facebook', 'Twitch'] },
    },
  };
  const result = await commandHandlers['blackmagic.getPlatforms'](agent, {});
  assert.deepEqual(result, ['YouTube', 'Facebook', 'Twitch']);
});

test('aja.setVideoInput returns formatted label', async () => {
  const agent = {
    encoderBridge: {
      type: 'aja',
      adapter: { setVideoInput: async () => ({ ok: true }) },
    },
  };
  const result = await commandHandlers['aja.setVideoInput'](agent, { source: 1 });
  assert.ok(result.includes('HDMI'));
});

test('ecamm.getScenes calls through', async () => {
  const agent = {
    encoderBridge: {
      type: 'ecamm',
      adapter: { getScenes: async () => [{ id: '1', name: 'Main' }] },
    },
  };
  const result = await commandHandlers['ecamm.getScenes'](agent, {});
  assert.deepEqual(result, [{ id: '1', name: 'Main' }]);
});

test('epiphan.startPublisher validates required params', async () => {
  const agent = {
    encoderBridge: { type: 'epiphan', adapter: {} },
  };
  await assert.rejects(
    () => commandHandlers['epiphan.startPublisher'](agent, {}),
    /channel parameter required/
  );
  await assert.rejects(
    () => commandHandlers['epiphan.startPublisher'](agent, { channel: '1' }),
    /publisher parameter required/
  );
});
