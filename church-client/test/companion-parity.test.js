/**
 * Tests for Companion Parity features.
 * Covers all new commands added for Bitfocus Companion feature parity:
 * OBS, ProPresenter, vMix, Resolume, VideoHub, ATEM monitoring feedbacks.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { commandHandlers } = require('../src/commands');

// ═══════════════════════════════════════════════════════════════════════════════
// OBS COMPANION PARITY
// ═══════════════════════════════════════════════════════════════════════════════

function makeObs(responseMap = {}) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params: params ?? {} });
      const response = responseMap[method];
      if (response instanceof Error) throw response;
      return response !== undefined ? response : {};
    },
  };
}

function obsAgent(responseMap = {}) {
  const obs = makeObs(responseMap);
  const agent = { obs, status: { obs: { connected: true } } };
  return { agent, obs };
}

test('all new OBS companion parity commands are registered', () => {
  const expected = [
    'obs.getSceneCollections', 'obs.setSceneCollection',
    'obs.getProfiles', 'obs.setProfile',
    'obs.startReplayBuffer', 'obs.stopReplayBuffer', 'obs.saveReplayBuffer',
    'obs.getScreenshot',
    'obs.setInputAudioMonitorType',
    'obs.setSceneItemTransform', 'obs.setSourceFilterSettings',
    'obs.triggerTransition',
    'obs.getStreamSettings', 'obs.getStats',
    'obs.openProjector',
    'obs.mediaInputAction', 'obs.setMediaInputCursor', 'obs.getMediaInputStatus',
    'obs.getOutputStatus',
    'obs.setInputSettings',
  ];
  for (const name of expected) {
    assert.ok(commandHandlers[name], `${name} should be registered`);
  }
});

test('obs.getSceneCollections returns formatted list', async () => {
  const { agent } = obsAgent({
    GetSceneCollectionList: { currentSceneCollectionName: 'Main', sceneCollections: ['Main', 'Backup'] },
  });
  const result = await commandHandlers['obs.getSceneCollections'](agent, {});
  assert.ok(result.includes('[Main]'));
  assert.ok(result.includes('Backup'));
});

test('obs.setSceneCollection calls SetCurrentSceneCollection', async () => {
  const { agent, obs } = obsAgent();
  await commandHandlers['obs.setSceneCollection'](agent, { collection: 'Worship' });
  assert.equal(obs.calls[0].method, 'SetCurrentSceneCollection');
  assert.equal(obs.calls[0].params.sceneCollectionName, 'Worship');
});

test('obs.getProfiles returns formatted list', async () => {
  const { agent } = obsAgent({
    GetProfileList: { currentProfileName: 'Live', profiles: ['Live', 'Test'] },
  });
  const result = await commandHandlers['obs.getProfiles'](agent, {});
  assert.ok(result.includes('[Live]'));
});

test('obs.setProfile calls SetCurrentProfile', async () => {
  const { agent, obs } = obsAgent();
  await commandHandlers['obs.setProfile'](agent, { profile: 'Live' });
  assert.equal(obs.calls[0].method, 'SetCurrentProfile');
  assert.equal(obs.calls[0].params.profileName, 'Live');
});

test('obs.startReplayBuffer calls StartReplayBuffer', async () => {
  const { agent, obs } = obsAgent();
  await commandHandlers['obs.startReplayBuffer'](agent, {});
  assert.equal(obs.calls[0].method, 'StartReplayBuffer');
});

test('obs.stopReplayBuffer calls StopReplayBuffer', async () => {
  const { agent, obs } = obsAgent();
  await commandHandlers['obs.stopReplayBuffer'](agent, {});
  assert.equal(obs.calls[0].method, 'StopReplayBuffer');
});

test('obs.saveReplayBuffer calls SaveReplayBuffer', async () => {
  const { agent, obs } = obsAgent();
  await commandHandlers['obs.saveReplayBuffer'](agent, {});
  assert.equal(obs.calls[0].method, 'SaveReplayBuffer');
});

test('obs.setInputAudioMonitorType calls SetInputAudioMonitorType', async () => {
  const { agent, obs } = obsAgent();
  await commandHandlers['obs.setInputAudioMonitorType'](agent, {
    input: 'Mic', monitorType: 'OBS_MONITORING_TYPE_MONITOR_ONLY',
  });
  assert.equal(obs.calls[0].method, 'SetInputAudioMonitorType');
  assert.equal(obs.calls[0].params.inputName, 'Mic');
});

test('obs.triggerTransition calls TriggerStudioModeTransition', async () => {
  const { agent, obs } = obsAgent();
  await commandHandlers['obs.triggerTransition'](agent, {});
  assert.equal(obs.calls[0].method, 'TriggerStudioModeTransition');
});

test('obs.getStats calls GetStats and returns formatted data', async () => {
  const { agent } = obsAgent({
    GetStats: { cpuUsage: 5.2, memoryUsage: 1024, availableDiskSpace: 100.5, activeFps: 59.9 },
  });
  const result = await commandHandlers['obs.getStats'](agent, {});
  assert.equal(result.cpuUsage, '5.2%');
  assert.equal(result.activeFps, '59.9');
});

test('obs.mediaInputAction calls TriggerMediaInputAction', async () => {
  const { agent, obs } = obsAgent();
  await commandHandlers['obs.mediaInputAction'](agent, { input: 'Video', action: 'PLAY' });
  assert.equal(obs.calls[0].method, 'TriggerMediaInputAction');
  assert.equal(obs.calls[0].params.mediaAction, 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY');
});

test('obs.mediaInputAction rejects invalid action', async () => {
  const { agent } = obsAgent();
  await assert.rejects(
    () => commandHandlers['obs.mediaInputAction'](agent, { input: 'Video', action: 'INVALID' }),
    /action must be one of/
  );
});

test('obs.setMediaInputCursor calls SetMediaInputCursor', async () => {
  const { agent, obs } = obsAgent();
  await commandHandlers['obs.setMediaInputCursor'](agent, { input: 'Video', cursor: 5000 });
  assert.equal(obs.calls[0].method, 'SetMediaInputCursor');
  assert.equal(obs.calls[0].params.mediaCursor, 5000);
});

test('obs.getOutputStatus returns stream and record status', async () => {
  const { agent } = obsAgent({
    GetStreamStatus: { outputActive: true, outputTimecode: '00:05:30', outputBytes: 12345 },
    GetRecordStatus: { outputActive: true, outputPaused: false, outputTimecode: '00:10:00' },
  });
  const result = await commandHandlers['obs.getOutputStatus'](agent, {});
  assert.equal(result.streaming, true);
  assert.equal(result.recording, true);
  assert.equal(result.streamTimecode, '00:05:30');
});

test('obs.setSceneItemTransform calls SetSceneItemTransform', async () => {
  const { agent, obs } = obsAgent();
  await commandHandlers['obs.setSceneItemTransform'](agent, {
    scene: 'Main', itemId: 1, positionX: 100, positionY: 200, scaleX: 0.5,
  });
  assert.equal(obs.calls[0].method, 'SetSceneItemTransform');
  assert.equal(obs.calls[0].params.sceneItemTransform.positionX, 100);
});

test('obs.setSourceFilterSettings calls SetSourceFilterSettings', async () => {
  const { agent, obs } = obsAgent();
  await commandHandlers['obs.setSourceFilterSettings'](agent, {
    source: 'Cam1', filter: 'Color', settings: { brightness: 50 },
  });
  assert.equal(obs.calls[0].method, 'SetSourceFilterSettings');
  assert.deepEqual(obs.calls[0].params.filterSettings, { brightness: 50 });
});

test('obs.setInputSettings calls SetInputSettings', async () => {
  const { agent, obs } = obsAgent();
  await commandHandlers['obs.setInputSettings'](agent, {
    input: 'TextGDI', settings: { text: 'Hello World' },
  });
  assert.equal(obs.calls[0].method, 'SetInputSettings');
  assert.deepEqual(obs.calls[0].params.inputSettings, { text: 'Hello World' });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROPRESENTER COMPANION PARITY
// ═══════════════════════════════════════════════════════════════════════════════

function ppAgent(overrides = {}) {
  const pp = {
    getProps: async () => [{ id: 'p1', name: 'Logo' }],
    triggerProp: async () => 'Logo',
    clearProps: async () => true,
    resetTimer: async () => 'Countdown',
    createTimer: async () => 'New Timer',
    getGroups: async () => [{ id: 'g1', name: 'Service' }],
    triggerGroup: async () => 'Service',
    nextAnnouncement: async () => true,
    previousAnnouncement: async () => true,
    getAnnouncementStatus: async () => ({ presentationName: 'Announcements', slideIndex: 1, slideCount: 5 }),
    getMacros: async () => [{ id: 'm1', name: 'AutoStart' }],
    triggerMacro: async () => 'AutoStart',
    getStageLayouts: async () => [{ id: 'sl1', name: 'Default' }],
    setStageLayout: async () => 'Default',
    clearMedia: async () => true,
    clearAudio: async () => true,
    triggerVideoInput: async () => true,
    triggerPresentation: async () => 'Worship Songs',
    triggerPlaylistItem: async () => 'Sunday Morning',
    getLibraries: async () => [{ id: 'l1', name: 'Library', presentations: [{ id: 'p1', name: 'Song' }] }],
    ...overrides,
  };
  return { proPresenter: pp };
}

test('all new ProPresenter companion parity commands are registered', () => {
  const expected = [
    'propresenter.triggerPresentation', 'propresenter.triggerPlaylistItem',
    'propresenter.getProps', 'propresenter.triggerProp', 'propresenter.clearProps',
    'propresenter.resetTimer', 'propresenter.createTimer',
    'propresenter.getGroups', 'propresenter.triggerGroup',
    'propresenter.nextAnnouncement', 'propresenter.previousAnnouncement',
    'propresenter.announcementStatus',
    'propresenter.getMacros', 'propresenter.triggerMacro',
    'propresenter.getStageLayouts', 'propresenter.setStageLayout',
    'propresenter.clearMedia', 'propresenter.clearAudio',
    'propresenter.triggerVideoInput',
  ];
  for (const name of expected) {
    assert.ok(commandHandlers[name], `${name} should be registered`);
  }
});

test('propresenter.triggerPresentation triggers a presentation', async () => {
  const agent = ppAgent();
  const result = await commandHandlers['propresenter.triggerPresentation'](agent, { name: 'Worship Songs' });
  assert.ok(result.includes('Worship Songs'));
});

test('propresenter.triggerPlaylistItem triggers a playlist item', async () => {
  const agent = ppAgent();
  const result = await commandHandlers['propresenter.triggerPlaylistItem'](agent, { playlist: 'Sunday Morning' });
  assert.ok(result.includes('Sunday Morning'));
});

test('propresenter.getProps returns prop list', async () => {
  const agent = ppAgent();
  const result = await commandHandlers['propresenter.getProps'](agent, {});
  assert.ok(result.includes('Logo'));
});

test('propresenter.triggerProp triggers a prop', async () => {
  const agent = ppAgent();
  const result = await commandHandlers['propresenter.triggerProp'](agent, { name: 'Logo' });
  assert.ok(result.includes('Logo'));
});

test('propresenter.clearProps clears props layer', async () => {
  const agent = ppAgent();
  const result = await commandHandlers['propresenter.clearProps'](agent, {});
  assert.ok(result.includes('cleared'));
});

test('propresenter.resetTimer resets a timer', async () => {
  const agent = ppAgent();
  const result = await commandHandlers['propresenter.resetTimer'](agent, { name: 'Countdown' });
  assert.ok(result.includes('reset'));
});

test('propresenter.createTimer creates a timer', async () => {
  const agent = ppAgent();
  const result = await commandHandlers['propresenter.createTimer'](agent, { name: 'New Timer' });
  assert.ok(result.includes('created'));
});

test('propresenter.getGroups returns group list', async () => {
  const agent = ppAgent();
  const result = await commandHandlers['propresenter.getGroups'](agent, {});
  assert.ok(result.includes('Service'));
});

test('propresenter.triggerGroup triggers a group', async () => {
  const agent = ppAgent();
  const result = await commandHandlers['propresenter.triggerGroup'](agent, { name: 'Service' });
  assert.ok(result.includes('Service'));
});

test('propresenter.nextAnnouncement goes to next announcement', async () => {
  const agent = ppAgent();
  const result = await commandHandlers['propresenter.nextAnnouncement'](agent, {});
  assert.ok(result.includes('Next'));
});

test('propresenter.previousAnnouncement goes to previous', async () => {
  const agent = ppAgent();
  const result = await commandHandlers['propresenter.previousAnnouncement'](agent, {});
  assert.ok(result.includes('Previous'));
});

test('propresenter.announcementStatus returns status', async () => {
  const agent = ppAgent();
  const result = await commandHandlers['propresenter.announcementStatus'](agent, {});
  assert.ok(result.includes('Announcements'));
});

test('propresenter.getMacros returns macro list', async () => {
  const agent = ppAgent();
  const result = await commandHandlers['propresenter.getMacros'](agent, {});
  assert.ok(result.includes('AutoStart'));
});

test('propresenter.triggerMacro triggers a macro', async () => {
  const agent = ppAgent();
  const result = await commandHandlers['propresenter.triggerMacro'](agent, { name: 'AutoStart' });
  assert.ok(result.includes('AutoStart'));
});

test('propresenter.getStageLayouts returns layouts', async () => {
  const agent = ppAgent();
  const result = await commandHandlers['propresenter.getStageLayouts'](agent, {});
  assert.ok(result.includes('Default'));
});

test('propresenter.setStageLayout sets a layout', async () => {
  const agent = ppAgent();
  const result = await commandHandlers['propresenter.setStageLayout'](agent, { name: 'Default' });
  assert.ok(result.includes('Default'));
});

test('propresenter.clearMedia clears media layer', async () => {
  const agent = ppAgent();
  const result = await commandHandlers['propresenter.clearMedia'](agent, {});
  assert.ok(result.includes('Media'));
});

test('propresenter.clearAudio clears audio layer', async () => {
  const agent = ppAgent();
  const result = await commandHandlers['propresenter.clearAudio'](agent, {});
  assert.ok(result.includes('Audio'));
});

test('propresenter.triggerVideoInput triggers video input', async () => {
  const agent = ppAgent();
  const result = await commandHandlers['propresenter.triggerVideoInput'](agent, { name: 'Camera 1' });
  assert.ok(result.includes('Camera 1'));
});

test('propresenter commands throw when not configured', async () => {
  const agent = {};
  await assert.rejects(
    () => commandHandlers['propresenter.triggerPresentation'](agent, { name: 'test' }),
    /ProPresenter not configured/
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// VMIX COMPANION PARITY
// ═══════════════════════════════════════════════════════════════════════════════

function vmixAgent() {
  const calls = [];
  const vmix = {
    _calls: calls,
    transition: async (t, i, d) => { calls.push({ fn: 'transition', args: [t, i, d] }); return true; },
    setInputPosition: async () => { calls.push({ fn: 'setInputPosition' }); return true; },
    setInputZoom: async () => { calls.push({ fn: 'setInputZoom' }); return true; },
    setInputCrop: async () => { calls.push({ fn: 'setInputCrop' }); return true; },
    startMultiCorder: async () => { calls.push({ fn: 'startMultiCorder' }); return true; },
    stopMultiCorder: async () => { calls.push({ fn: 'stopMultiCorder' }); return true; },
    startExternal: async () => { calls.push({ fn: 'startExternal' }); return true; },
    stopExternal: async () => { calls.push({ fn: 'stopExternal' }); return true; },
    toggleFullscreen: async () => { calls.push({ fn: 'toggleFullscreen' }); return true; },
    setInputLoop: async (i, on) => { calls.push({ fn: 'setInputLoop', args: [i, on] }); return true; },
    renameInput: async () => { calls.push({ fn: 'renameInput' }); return true; },
    setInputColourCorrection: async () => { calls.push({ fn: 'setInputColourCorrection' }); return true; },
    setInputAudioBus: async () => { calls.push({ fn: 'setInputAudioBus' }); return true; },
    setBusVolume: async (b, v) => { calls.push({ fn: 'setBusVolume' }); return v; },
    muteBus: async () => { calls.push({ fn: 'muteBus' }); return true; },
    setInputNDISource: async () => { calls.push({ fn: 'setInputNDISource' }); return true; },
    setLayerInput: async () => { calls.push({ fn: 'setLayerInput' }); return true; },
    setTitleField: async () => { calls.push({ fn: 'setTitleField' }); return true; },
    selectTitleIndex: async () => { calls.push({ fn: 'selectTitleIndex' }); return true; },
    getTallyState: async () => [{ number: 1, title: 'Cam1', program: true, preview: false }],
    runScript: async () => { calls.push({ fn: 'runScript' }); return true; },
    stopScript: async () => { calls.push({ fn: 'stopScript' }); return true; },
    saveSnapshot: async () => { calls.push({ fn: 'saveSnapshot' }); return true; },
    loadSnapshot: async () => { calls.push({ fn: 'loadSnapshot' }); return true; },
    browserNavigate: async () => { calls.push({ fn: 'browserNavigate' }); return true; },
    _call: async () => 'ok',
  };
  return { vmix, _vmixCalls: calls };
}

test('all new vMix companion parity commands are registered', () => {
  const expected = [
    'vmix.transition',
    'vmix.setInputPosition', 'vmix.setInputZoom', 'vmix.setInputCrop',
    'vmix.startMultiCorder', 'vmix.stopMultiCorder',
    'vmix.startExternal', 'vmix.stopExternal',
    'vmix.toggleFullscreen', 'vmix.setInputLoop', 'vmix.renameInput',
    'vmix.setColourCorrection',
    'vmix.setInputAudioBus', 'vmix.setBusVolume', 'vmix.muteBus',
    'vmix.setInputNDISource', 'vmix.setLayerInput',
    'vmix.setTitleField', 'vmix.selectTitleIndex',
    'vmix.getTallyState',
    'vmix.runScript', 'vmix.stopScript',
    'vmix.saveSnapshot', 'vmix.loadSnapshot',
    'vmix.browserNavigate',
  ];
  for (const name of expected) {
    assert.ok(commandHandlers[name], `${name} should be registered`);
  }
});

test('vmix.transition calls transition with correct type', async () => {
  const agent = vmixAgent();
  const result = await commandHandlers['vmix.transition'](agent, { type: 'Merge', input: 1 });
  assert.ok(result.includes('Merge'));
  assert.equal(agent._vmixCalls[0].fn, 'transition');
});

test('vmix.startMultiCorder starts multicorder', async () => {
  const agent = vmixAgent();
  const result = await commandHandlers['vmix.startMultiCorder'](agent, {});
  assert.ok(result.includes('MultiCorder started'));
});

test('vmix.stopMultiCorder stops multicorder', async () => {
  const agent = vmixAgent();
  const result = await commandHandlers['vmix.stopMultiCorder'](agent, {});
  assert.ok(result.includes('MultiCorder stopped'));
});

test('vmix.startExternal starts external output', async () => {
  const agent = vmixAgent();
  const result = await commandHandlers['vmix.startExternal'](agent, {});
  assert.ok(result.includes('external output started'));
});

test('vmix.toggleFullscreen toggles fullscreen', async () => {
  const agent = vmixAgent();
  const result = await commandHandlers['vmix.toggleFullscreen'](agent, {});
  assert.ok(result.includes('fullscreen toggled'));
});

test('vmix.setInputLoop sets loop on/off', async () => {
  const agent = vmixAgent();
  const result = await commandHandlers['vmix.setInputLoop'](agent, { input: 1, on: true });
  assert.ok(result.includes('loop on'));
});

test('vmix.setInputAudioBus sets audio bus', async () => {
  const agent = vmixAgent();
  const result = await commandHandlers['vmix.setInputAudioBus'](agent, { input: 1, bus: 'A', on: true });
  assert.ok(result.includes('bus A on'));
});

test('vmix.setBusVolume sets bus volume', async () => {
  const agent = vmixAgent();
  const result = await commandHandlers['vmix.setBusVolume'](agent, { bus: 'A', value: 80 });
  assert.ok(result.includes('bus A volume'));
});

test('vmix.getTallyState returns tally info', async () => {
  const agent = vmixAgent();
  const result = await commandHandlers['vmix.getTallyState'](agent, {});
  assert.ok(result.includes('Cam1'));
  assert.ok(result.includes('PGM'));
});

test('vmix.runScript runs a script', async () => {
  const agent = vmixAgent();
  const result = await commandHandlers['vmix.runScript'](agent, { name: 'MyScript' });
  assert.ok(result.includes('MyScript'));
});

test('vmix.saveSnapshot saves a snapshot', async () => {
  const agent = vmixAgent();
  const result = await commandHandlers['vmix.saveSnapshot'](agent, { filename: 'test.xml' });
  assert.ok(result.includes('test.xml'));
});

test('vmix.browserNavigate navigates browser input', async () => {
  const agent = vmixAgent();
  const result = await commandHandlers['vmix.browserNavigate'](agent, { input: 1, url: 'https://example.com' });
  assert.ok(result.includes('navigated'));
});

test('vmix commands throw when not configured', async () => {
  const agent = {};
  await assert.rejects(
    () => commandHandlers['vmix.transition'](agent, { type: 'Cut' }),
    /vMix not configured/
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// RESOLUME COMPANION PARITY
// ═══════════════════════════════════════════════════════════════════════════════

function resolumeAgent() {
  const calls = [];
  const resolume = {
    _calls: calls,
    setLayerBypass: async (l, b) => { calls.push({ fn: 'setLayerBypass' }); return b; },
    setLayerSolo: async (l, s) => { calls.push({ fn: 'setLayerSolo' }); return s; },
    setClipSpeed: async (l, c, s) => { calls.push({ fn: 'setClipSpeed' }); return s; },
    pauseClip: async () => { calls.push({ fn: 'pauseClip' }); return true; },
    restartClip: async () => { calls.push({ fn: 'restartClip' }); return true; },
    setLayerEffectParam: async () => { calls.push({ fn: 'setLayerEffectParam' }); return true; },
    setLayerEffectBypassed: async () => { calls.push({ fn: 'setLayerEffectBypassed' }); return true; },
    selectDeck: async () => { calls.push({ fn: 'selectDeck' }); return true; },
    setLayerBlendMode: async () => { calls.push({ fn: 'setLayerBlendMode' }); return true; },
    setCrossfader: async (v) => { calls.push({ fn: 'setCrossfader' }); return v; },
    setCompositionSpeed: async (s) => { calls.push({ fn: 'setCompositionSpeed' }); return s; },
    selectLayer: async () => { calls.push({ fn: 'selectLayer' }); return true; },
    getClipThumbnail: async () => 'base64data',
  };
  return { resolume, _resolumeCalls: calls };
}

test('all new Resolume companion parity commands are registered', () => {
  const expected = [
    'resolume.setLayerBypass', 'resolume.setLayerSolo',
    'resolume.setClipSpeed', 'resolume.pauseClip', 'resolume.restartClip',
    'resolume.setLayerEffectParam', 'resolume.setLayerEffectBypassed',
    'resolume.selectDeck',
    'resolume.setLayerBlendMode',
    'resolume.setCrossfader',
    'resolume.setCompositionSpeed',
    'resolume.selectLayer',
    'resolume.getClipThumbnail',
  ];
  for (const name of expected) {
    assert.ok(commandHandlers[name], `${name} should be registered`);
  }
});

test('resolume.setLayerBypass sets bypass', async () => {
  const agent = resolumeAgent();
  const result = await commandHandlers['resolume.setLayerBypass'](agent, { layer: 1, bypassed: true });
  assert.ok(result.includes('muted'));
});

test('resolume.setLayerSolo sets solo', async () => {
  const agent = resolumeAgent();
  const result = await commandHandlers['resolume.setLayerSolo'](agent, { layer: 1, solo: true });
  assert.ok(result.includes('solo on'));
});

test('resolume.setClipSpeed sets speed', async () => {
  const agent = resolumeAgent();
  const result = await commandHandlers['resolume.setClipSpeed'](agent, { layer: 1, clip: 1, speed: 2 });
  assert.ok(result.includes('2x'));
});

test('resolume.pauseClip pauses a clip', async () => {
  const agent = resolumeAgent();
  const result = await commandHandlers['resolume.pauseClip'](agent, { layer: 1, clip: 1 });
  assert.ok(result.includes('paused'));
});

test('resolume.restartClip restarts a clip', async () => {
  const agent = resolumeAgent();
  const result = await commandHandlers['resolume.restartClip'](agent, { layer: 1, clip: 1 });
  assert.ok(result.includes('restarted'));
});

test('resolume.selectDeck selects a deck', async () => {
  const agent = resolumeAgent();
  const result = await commandHandlers['resolume.selectDeck'](agent, { deck: 2 });
  assert.ok(result.includes('Deck 2'));
});

test('resolume.setLayerBlendMode sets blend mode', async () => {
  const agent = resolumeAgent();
  const result = await commandHandlers['resolume.setLayerBlendMode'](agent, { layer: 1, mode: 'Add' });
  assert.ok(result.includes('Add'));
});

test('resolume.setCrossfader sets crossfader', async () => {
  const agent = resolumeAgent();
  const result = await commandHandlers['resolume.setCrossfader'](agent, { value: 0.5 });
  assert.ok(result.includes('50%'));
});

test('resolume.setCompositionSpeed sets speed', async () => {
  const agent = resolumeAgent();
  const result = await commandHandlers['resolume.setCompositionSpeed'](agent, { speed: 1.5 });
  assert.ok(result.includes('1.5x'));
});

test('resolume.getClipThumbnail returns screenshot data', async () => {
  const agent = resolumeAgent();
  const result = await commandHandlers['resolume.getClipThumbnail'](agent, { layer: 1, clip: 1 });
  assert.equal(result.type, 'screenshot');
  assert.equal(result.data, 'base64data');
});

test('resolume commands throw when not configured', async () => {
  const agent = {};
  await assert.rejects(
    () => commandHandlers['resolume.setLayerBypass'](agent, { layer: 1 }),
    /Resolume not configured/
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// VIDEOHUB COMPANION PARITY
// ═══════════════════════════════════════════════════════════════════════════════

function videohubAgent() {
  const hub = {
    connected: true,
    lockOutput: async () => true,
    unlockOutput: async () => true,
    getOutputLocks: async () => [{ output: 0, state: 'O', label: 'PGM', locked: true }],
    setSerialRoute: async () => true,
    setProcessingRoute: async () => true,
    setMonitoringRoute: async () => true,
    setBulkRoutes: async () => true,
    setRoute: async () => true,
  };
  return { videoHubs: [hub] };
}

test('all new VideoHub companion parity commands are registered', () => {
  const expected = [
    'videohub.lockOutput', 'videohub.unlockOutput', 'videohub.getOutputLocks',
    'videohub.setSerialRoute', 'videohub.setProcessingRoute',
    'videohub.setMonitoringRoute',
    'videohub.bulkRoute', 'videohub.routeTake',
  ];
  for (const name of expected) {
    assert.ok(commandHandlers[name], `${name} should be registered`);
  }
});

test('videohub.lockOutput locks an output', async () => {
  const agent = videohubAgent();
  const result = await commandHandlers['videohub.lockOutput'](agent, { output: 0 });
  assert.ok(result.includes('locked'));
});

test('videohub.unlockOutput unlocks an output', async () => {
  const agent = videohubAgent();
  const result = await commandHandlers['videohub.unlockOutput'](agent, { output: 0 });
  assert.ok(result.includes('unlocked'));
});

test('videohub.getOutputLocks returns lock status', async () => {
  const agent = videohubAgent();
  const result = await commandHandlers['videohub.getOutputLocks'](agent, {});
  assert.ok(result.includes('LOCKED'));
});

test('videohub.setSerialRoute sets serial route', async () => {
  const agent = videohubAgent();
  const result = await commandHandlers['videohub.setSerialRoute'](agent, { output: 0, input: 1 });
  assert.ok(result.includes('Serial'));
});

test('videohub.setMonitoringRoute sets monitoring route', async () => {
  const agent = videohubAgent();
  const result = await commandHandlers['videohub.setMonitoringRoute'](agent, { output: 0, input: 1 });
  assert.ok(result.includes('Monitoring'));
});

test('videohub.bulkRoute sets multiple routes', async () => {
  const agent = videohubAgent();
  const result = await commandHandlers['videohub.bulkRoute'](agent, {
    routes: [{ output: 0, input: 1 }, { output: 1, input: 2 }],
  });
  assert.ok(result.includes('2 routes'));
});

test('videohub.routeTake executes a route take', async () => {
  const agent = videohubAgent();
  const result = await commandHandlers['videohub.routeTake'](agent, { output: 0, input: 1 });
  assert.ok(result.includes('Route take'));
});

test('videohub commands throw when not configured', async () => {
  const agent = {};
  await assert.rejects(
    () => commandHandlers['videohub.lockOutput'](agent, { output: 0 }),
    /Video Hub not configured/
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// ATEM COMPANION PARITY: Monitoring Feedbacks
// ═══════════════════════════════════════════════════════════════════════════════

test('all new ATEM companion parity monitoring commands are registered', () => {
  const expected = [
    'atem.getFadeToBlackStatus', 'atem.getTransitionStatus',
    'atem.getMacroStatus', 'atem.getCameraControl',
    'atem.getTallyByIndex', 'atem.getInputProperties',
  ];
  for (const name of expected) {
    assert.ok(commandHandlers[name], `${name} should be registered`);
  }
});

test('atem.getFadeToBlackStatus returns FTB state', async () => {
  const agent = {
    atem: {
      state: {
        video: {
          mixEffects: [{
            fadeToBlack: { isFullyBlack: true, inTransition: false, remainingFrames: 0, rate: 25 },
          }],
        },
      },
    },
    status: { atem: { connected: true } },
  };
  const result = await commandHandlers['atem.getFadeToBlackStatus'](agent, {});
  assert.equal(result.active, true);
  assert.equal(result.rate, 25);
});

test('atem.getTransitionStatus returns transition state', async () => {
  const agent = {
    atem: {
      state: {
        video: {
          mixEffects: [{
            transitionPosition: { inTransition: true, handlePosition: 5000 },
            transitionSettings: { nextTransition: { style: 0 } },
            transitionPreview: false,
          }],
        },
      },
    },
    status: { atem: { connected: true } },
  };
  const result = await commandHandlers['atem.getTransitionStatus'](agent, {});
  assert.equal(result.inTransition, true);
  assert.equal(result.position, 5000);
});

test('atem.getMacroStatus returns macro state', async () => {
  const agent = {
    atem: {
      state: {
        macro: {
          macroPlayer: { isRunning: true, isWaiting: false, loop: true, macroIndex: 3 },
          macroRecorder: { isRecording: false },
        },
      },
    },
    status: { atem: { connected: true } },
  };
  const result = await commandHandlers['atem.getMacroStatus'](agent, {});
  assert.equal(result.isRunning, true);
  assert.equal(result.loop, true);
  assert.equal(result.runningIndex, 3);
});

test('atem.getTallyByIndex returns per-input tally', async () => {
  const agent = {
    atem: {
      state: {
        video: {
          mixEffects: [{ programInput: 1, previewInput: 2 }],
        },
      },
    },
    status: { atem: { connected: true } },
  };
  const result = await commandHandlers['atem.getTallyByIndex'](agent, { input: 1 });
  assert.equal(result.program, true);
  assert.equal(result.preview, false);
  assert.equal(result.name, 'Cam 1');

  const result2 = await commandHandlers['atem.getTallyByIndex'](agent, { input: 2 });
  assert.equal(result2.program, false);
  assert.equal(result2.preview, true);
});

test('atem.getInputProperties returns input info', async () => {
  const agent = {
    atem: {
      state: {
        inputs: {
          1: { shortName: 'CAM1', longName: 'Camera 1', externalPortType: 1 },
          2: { shortName: 'CAM2', longName: 'Camera 2', externalPortType: 1 },
        },
      },
    },
    status: { atem: { connected: true } },
  };
  const result = await commandHandlers['atem.getInputProperties'](agent, {});
  assert.equal(result.length, 2);
  assert.equal(result[0].longName, 'Camera 1');
  assert.equal(result[1].id, 2);
});

test('atem monitoring commands throw when state unavailable', async () => {
  const agent = { atem: null, status: { atem: { connected: false } } };
  await assert.rejects(
    () => commandHandlers['atem.getFadeToBlackStatus'](agent, {}),
    /ATEM state not available/
  );
});
