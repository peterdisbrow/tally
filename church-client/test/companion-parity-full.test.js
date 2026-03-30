/**
 * Tests for 100% Companion Parity — Phase 2.
 * Covers all new commands added for complete Bitfocus Companion feature parity:
 * VideoHub, OBS, ProPresenter, Resolume, ATEM/Camera, vMix.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { commandHandlers } = require('../src/commands');

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
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

function makeVmixAgent() {
  const calls = [];
  const vmix = {
    calls,
    _call: async (fn, params) => {
      calls.push({ fn, params: params ?? {} });
      return 'OK';
    },
  };
  return { agent: { vmix }, calls };
}

function makePPAgent() {
  const calls = [];
  const listMethods = ['getAudioPlaylists', 'getMediaPlaylists', 'getProps', 'getGroups',
    'getLooks', 'getTimers', 'getMacros', 'getStageLayouts', 'getMessages', 'getPlaylist', 'getLibraries'];
  const pp = new Proxy({}, {
    get(target, prop) {
      return async (...args) => {
        calls.push({ method: prop, args });
        if (listMethods.includes(prop)) return [{ name: 'Test', id: '1' }];
        return args[0] || 'ok';
      };
    },
  });
  return { agent: { proPresenter: pp, proPresenterBackup: null }, calls };
}

function makeResolumeAgent() {
  const calls = [];
  const resolume = new Proxy({}, {
    get(target, prop) {
      return async (...args) => {
        calls.push({ method: prop, args });
        return args[0] || 0.5;
      };
    },
  });
  return { agent: { resolume }, calls };
}

function makeVideoHubAgent() {
  const calls = [];
  const hub = {
    calls,
    _selectedDestination: null,
    _pendingSource: null,
    _routes: new Map([[0, 1], [1, 2], [2, 3]]),
    _routeHistory: new Map(),
    _inputLabels: new Map([[0, 'Cam 1'], [1, 'Cam 2']]),
    _outputLabels: new Map([[0, 'Out 1'], [1, 'Out 2']]),
    connected: true,
    selectDestination(dest) { this._selectedDestination = dest; },
    queueSource(src) { this._pendingSource = src; },
    async take() {
      calls.push({ method: 'take' });
      this._selectedDestination = null;
      this._pendingSource = null;
    },
    clearSelection() { this._selectedDestination = null; this._pendingSource = null; },
    async routeRouted(from, to) { calls.push({ method: 'routeRouted', from, to }); return true; },
    async routeToPrevious(output) { calls.push({ method: 'routeToPrevious', output }); return true; },
    async setSerialLabel(index, label) { calls.push({ method: 'setSerialLabel', index, label }); return true; },
    async lockSerial(output, state) { calls.push({ method: 'lockSerial', output, state }); return true; },
    async unlockSerial(output) { calls.push({ method: 'unlockSerial', output }); return true; },
    async setRoute(output, input) { calls.push({ method: 'setRoute', output, input }); return true; },
    async setBulkRoutes(routes) { calls.push({ method: 'setBulkRoutes', routes }); return true; },
    async getRoutes() { return []; },
    toStatus() { return { routes: {}, inputLabels: {}, outputLabels: {} }; },
  };
  return { agent: { videoHubs: [hub] }, hub, calls };
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIDEOHUB: NEW COMMANDS REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

test('all new VideoHub companion parity commands are registered', () => {
  const expected = [
    'videohub.selectDestination', 'videohub.routeToSelected', 'videohub.take',
    'videohub.clearSelection', 'videohub.routeRouted', 'videohub.routeToPrevious',
    'videohub.setSerialLabel', 'videohub.lockSerial', 'videohub.unlockSerial',
    'videohub.saveRouteFile', 'videohub.loadRouteFile',
  ];
  for (const name of expected) {
    assert.ok(commandHandlers[name], `${name} should be registered`);
  }
});

test('videohub.selectDestination stores destination', async () => {
  const { agent, hub } = makeVideoHubAgent();
  await commandHandlers['videohub.selectDestination'](agent, { destination: 2 });
  assert.equal(hub._selectedDestination, 2);
});

test('videohub.routeRouted copies route from one output to another', async () => {
  const { agent, calls } = makeVideoHubAgent();
  await commandHandlers['videohub.routeRouted'](agent, { fromOutput: 0, toOutput: 1 });
  assert.ok(calls.some(c => c.method === 'routeRouted'));
});

test('videohub.routeToPrevious reverts route', async () => {
  const { agent, calls } = makeVideoHubAgent();
  await commandHandlers['videohub.routeToPrevious'](agent, { output: 0 });
  assert.ok(calls.some(c => c.method === 'routeToPrevious'));
});

test('videohub.setSerialLabel renames serial port', async () => {
  const { agent, calls } = makeVideoHubAgent();
  await commandHandlers['videohub.setSerialLabel'](agent, { index: 0, label: 'PTZ 1' });
  const call = calls.find(c => c.method === 'setSerialLabel');
  assert.equal(call.label, 'PTZ 1');
});

test('videohub.lockSerial locks serial port', async () => {
  const { agent, calls } = makeVideoHubAgent();
  await commandHandlers['videohub.lockSerial'](agent, { output: 0 });
  assert.ok(calls.some(c => c.method === 'lockSerial'));
});

// ═══════════════════════════════════════════════════════════════════════════════
// OBS: NEW COMMANDS REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

test('all new OBS 100% parity commands are registered', () => {
  const expected = [
    'obs.triggerHotkey', 'obs.triggerHotkeySequence',
    'obs.toggleInputMute', 'obs.adjustVolume', 'obs.fadeVolume',
    'obs.setInputAudioSyncOffset', 'obs.setInputAudioBalance',
    'obs.toggleRecordPause', 'obs.splitRecordFile', 'obs.createRecordChapter',
    'obs.toggleStream', 'obs.sendStreamCaption',
    'obs.refreshBrowserSource', 'obs.setText', 'obs.setTextProperties',
    'obs.resetCaptureDevice', 'obs.toggleReplayBuffer',
    'obs.customCommand', 'obs.startVirtualCam', 'obs.stopVirtualCam',
  ];
  for (const name of expected) {
    assert.ok(commandHandlers[name], `${name} should be registered`);
  }
});

test('obs.triggerHotkey calls TriggerHotkeyByName', async () => {
  const { agent, obs } = obsAgent();
  await commandHandlers['obs.triggerHotkey'](agent, { name: 'OBSBasic.StartStreaming' });
  assert.equal(obs.calls[0].method, 'TriggerHotkeyByName');
  assert.equal(obs.calls[0].params.hotkeyName, 'OBSBasic.StartStreaming');
});

test('obs.triggerHotkeySequence calls TriggerHotkeyByKeySequence', async () => {
  const { agent, obs } = obsAgent();
  await commandHandlers['obs.triggerHotkeySequence'](agent, { keyId: 'OBS_KEY_F1', shift: true });
  assert.equal(obs.calls[0].method, 'TriggerHotkeyByKeySequence');
});

test('obs.toggleInputMute calls ToggleInputMute', async () => {
  const { agent, obs } = obsAgent();
  await commandHandlers['obs.toggleInputMute'](agent, { input: 'Mic' });
  assert.equal(obs.calls[0].method, 'ToggleInputMute');
});

test('obs.splitRecordFile calls SplitRecordFile', async () => {
  const { agent, obs } = obsAgent();
  await commandHandlers['obs.splitRecordFile'](agent, {});
  assert.equal(obs.calls[0].method, 'SplitRecordFile');
});

test('obs.createRecordChapter calls CreateRecordChapter', async () => {
  const { agent, obs } = obsAgent();
  await commandHandlers['obs.createRecordChapter'](agent, { chapterName: 'Worship' });
  assert.equal(obs.calls[0].method, 'CreateRecordChapter');
});

test('obs.sendStreamCaption calls SendStreamCaption', async () => {
  const { agent, obs } = obsAgent();
  await commandHandlers['obs.sendStreamCaption'](agent, { captionText: 'Hello' });
  assert.equal(obs.calls[0].method, 'SendStreamCaption');
  assert.equal(obs.calls[0].params.captionText, 'Hello');
});

test('obs.refreshBrowserSource calls PressInputPropertiesButton', async () => {
  const { agent, obs } = obsAgent();
  await commandHandlers['obs.refreshBrowserSource'](agent, { input: 'Browser' });
  assert.equal(obs.calls[0].method, 'PressInputPropertiesButton');
});

test('obs.customCommand passes through to obs.call', async () => {
  const { agent, obs } = obsAgent({ CustomRequest: { result: 42 } });
  const result = await commandHandlers['obs.customCommand'](agent, { requestType: 'CustomRequest', requestData: { foo: 'bar' } });
  assert.equal(obs.calls[0].method, 'CustomRequest');
});

test('obs.toggleStream calls ToggleStream', async () => {
  const { agent, obs } = obsAgent();
  await commandHandlers['obs.toggleStream'](agent, {});
  assert.equal(obs.calls[0].method, 'ToggleStream');
});

test('obs.startVirtualCam calls StartVirtualCam', async () => {
  const { agent, obs } = obsAgent();
  await commandHandlers['obs.startVirtualCam'](agent, {});
  assert.equal(obs.calls[0].method, 'StartVirtualCam');
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROPRESENTER: NEW COMMANDS REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

test('all new ProPresenter 100% parity commands are registered', () => {
  const expected = [
    'propresenter.getAudioPlaylists', 'propresenter.activeAudioPlaylistTrigger',
    'propresenter.focusedAudioPlaylistTrigger', 'propresenter.audioPlaylistFocus',
    'propresenter.audioPlaylistTrigger',
    'propresenter.getMediaPlaylists', 'propresenter.activeMediaPlaylistTrigger',
    'propresenter.focusedMediaPlaylistTrigger', 'propresenter.mediaPlaylistFocus',
    'propresenter.mediaPlaylistTrigger',
    'propresenter.transportPlay', 'propresenter.transportPause',
    'propresenter.transportSkipForward', 'propresenter.transportSkipBackward',
    'propresenter.transportGoToTime', 'propresenter.transportGoToEnd',
    'propresenter.timelinePlay', 'propresenter.timelinePause', 'propresenter.timelineRewind',
    'propresenter.captureStart', 'propresenter.captureStop',
    'propresenter.incrementTimer', 'propresenter.setTimerValue',
    'propresenter.toggleProp', 'propresenter.toggleStageMessage',
    'propresenter.toggleAudienceScreens', 'propresenter.toggleStageScreens',
    'propresenter.triggerLibraryCue', 'propresenter.clearAnnouncements',
  ];
  for (const name of expected) {
    assert.ok(commandHandlers[name], `${name} should be registered`);
  }
});

test('propresenter.getAudioPlaylists calls PP client', async () => {
  const { agent, calls } = makePPAgent();
  await commandHandlers['propresenter.getAudioPlaylists'](agent, {});
  assert.ok(calls.some(c => c.method === 'getAudioPlaylists'));
});

test('propresenter.transportPlay calls PP transport', async () => {
  const { agent, calls } = makePPAgent();
  await commandHandlers['propresenter.transportPlay'](agent, { layer: 'presentation' });
  assert.ok(calls.some(c => c.method === 'transportPlay'));
});

test('propresenter.captureStart calls PP capture', async () => {
  const { agent, calls } = makePPAgent();
  await commandHandlers['propresenter.captureStart'](agent, {});
  assert.ok(calls.some(c => c.method === 'captureStart'));
});

test('propresenter.timelinePlay calls PP timeline', async () => {
  const { agent, calls } = makePPAgent();
  await commandHandlers['propresenter.timelinePlay'](agent, {});
  assert.ok(calls.some(c => c.method === 'timelinePlay'));
});

test('propresenter.clearAnnouncements calls PP client', async () => {
  const { agent, calls } = makePPAgent();
  await commandHandlers['propresenter.clearAnnouncements'](agent, {});
  assert.ok(calls.some(c => c.method === 'clearAnnouncements'));
});

// ═══════════════════════════════════════════════════════════════════════════════
// RESOLUME: NEW COMMANDS REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

test('all new Resolume 100% parity commands are registered', () => {
  const expected = [
    'resolume.setClipOpacity', 'resolume.setClipVolume',
    'resolume.setCompositionMaster', 'resolume.setCompositionOpacity', 'resolume.setCompositionVolume',
    'resolume.tempoTap', 'resolume.tempoResync',
    'resolume.setLayerVolume', 'resolume.setLayerMaster', 'resolume.setLayerTransitionDuration',
    'resolume.layerNextColumn', 'resolume.layerPreviousColumn', 'resolume.clearLayer',
    'resolume.setLayerGroupBypass', 'resolume.clearLayerGroup',
    'resolume.setLayerGroupSolo', 'resolume.selectLayerGroup',
    'resolume.layerGroupNextColumn', 'resolume.layerGroupPreviousColumn',
    'resolume.triggerLayerGroupColumn', 'resolume.selectLayerGroupColumn',
    'resolume.setLayerGroupMaster', 'resolume.setLayerGroupOpacity',
    'resolume.setLayerGroupVolume', 'resolume.setLayerGroupSpeed',
    'resolume.selectNextDeck', 'resolume.selectPreviousDeck',
    'resolume.selectColumn', 'resolume.nextColumn', 'resolume.previousColumn',
  ];
  for (const name of expected) {
    assert.ok(commandHandlers[name], `${name} should be registered`);
  }
});

test('resolume.tempoTap calls resolume client', async () => {
  const { agent, calls } = makeResolumeAgent();
  await commandHandlers['resolume.tempoTap'](agent, {});
  assert.ok(calls.some(c => c.method === 'tempoTap'));
});

test('resolume.setClipOpacity calls resolume client', async () => {
  const { agent, calls } = makeResolumeAgent();
  await commandHandlers['resolume.setClipOpacity'](agent, { layer: 1, clip: 1, value: 0.5 });
  assert.ok(calls.some(c => c.method === 'setClipOpacity'));
});

test('resolume.clearLayer calls resolume client', async () => {
  const { agent, calls } = makeResolumeAgent();
  await commandHandlers['resolume.clearLayer'](agent, { layer: 1 });
  assert.ok(calls.some(c => c.method === 'clearLayer'));
});

test('resolume.setLayerGroupBypass calls resolume client', async () => {
  const { agent, calls } = makeResolumeAgent();
  await commandHandlers['resolume.setLayerGroupBypass'](agent, { group: 1, bypassed: true });
  assert.ok(calls.some(c => c.method === 'setLayerGroupBypass'));
});

test('resolume.selectNextDeck calls resolume client', async () => {
  const { agent, calls } = makeResolumeAgent();
  await commandHandlers['resolume.selectNextDeck'](agent, {});
  assert.ok(calls.some(c => c.method === 'selectNextDeck'));
});

test('resolume.nextColumn calls resolume client', async () => {
  const { agent, calls } = makeResolumeAgent();
  await commandHandlers['resolume.nextColumn'](agent, {});
  assert.ok(calls.some(c => c.method === 'nextColumn'));
});

// ═══════════════════════════════════════════════════════════════════════════════
// ATEM / CAMERA: NEW COMMANDS REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

test('all new ATEM 100% parity commands are registered', () => {
  const expected = [
    'atem.setTransitionSelection', 'atem.storeUskKeyframe',
    'atem.setUskKeyframe', 'atem.mediaPlayerCycle',
    'atem.setFairlightAudioRouting', 'atem.setTimecodeMode',
  ];
  for (const name of expected) {
    assert.ok(commandHandlers[name], `${name} should be registered`);
  }
});

test('all new Camera 100% parity commands are registered', () => {
  const expected = [
    'camera.setOIS', 'camera.setZoomSpeed', 'camera.incrementIris',
    'camera.setExposure', 'camera.incrementExposure', 'camera.setSharpening',
    'camera.setNDFilter', 'camera.incrementGain', 'camera.incrementWhiteBalance',
    'camera.setColorBars', 'camera.setFocusAssist', 'camera.setFalseColor',
    'camera.setZebra', 'camera.setStatusOverlay',
    'camera.recordStart', 'camera.recordStop',
    'camera.setColorOffset', 'camera.setLumaMix',
  ];
  for (const name of expected) {
    assert.ok(commandHandlers[name], `${name} should be registered`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// VMIX: NEW COMMANDS REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

test('all new vMix 100% parity commands are registered', () => {
  const expected = [
    // Replay
    'vmix.replayACamera', 'vmix.replayBCamera', 'vmix.replayCamera',
    'vmix.replaySelectChannel', 'vmix.replaySwapChannels',
    'vmix.replayMark', 'vmix.replayMoveInOut', 'vmix.replayUpdateInOut',
    'vmix.replaySelectEvents', 'vmix.replayChangeDirection',
    'vmix.replayChangeSpeed', 'vmix.replaySetSpeed',
    'vmix.replayMoveEvent', 'vmix.replayMoveEventUp', 'vmix.replayMoveEventDown',
    'vmix.replayFastForward', 'vmix.replayFastBackward',
    'vmix.replayJumpFrames', 'vmix.replayJumpToNow',
    'vmix.replayLiveToggle', 'vmix.replayPlay', 'vmix.replayPause',
    'vmix.replayPlayEvent', 'vmix.replayPlaySelectedEventToOutput',
    'vmix.replayPlayEventsByID', 'vmix.replayPlayEventsByIDToOutput',
    'vmix.replayPlayLastEventToOutput', 'vmix.replayPlayAllEventsToOutput',
    'vmix.replayStopEvents', 'vmix.replayToggleCamera',
    'vmix.replayShowHide', 'vmix.replayRecording',
    'vmix.replayEventText', 'vmix.replayEventTextClear',
    // PTZ
    'vmix.ptzMove', 'vmix.ptzFocusZoom', 'vmix.ptzVirtualInput',
    // Data Sources
    'vmix.dataSourceAutoNext', 'vmix.dataSourceNextRow',
    'vmix.dataSourcePreviousRow', 'vmix.dataSourceSelectRow',
    // Advanced Title
    'vmix.setTextByLayer', 'vmix.setTextColor', 'vmix.setTextVisible',
    'vmix.setShapeColor', 'vmix.setTitleImage', 'vmix.setTitleImageVisible',
    'vmix.nextTitlePreset', 'vmix.previousTitlePreset',
    'vmix.titleBeginAnimation',
    'vmix.controlCountdown', 'vmix.setCountdown', 'vmix.changeCountdown', 'vmix.adjustCountdown',
    // Virtual Set
    'vmix.virtualSet',
    // Audio new
    'vmix.fadeInputVolume', 'vmix.fadeBusVolume',
    'vmix.audioPluginOnOff', 'vmix.setChannelVolume',
    'vmix.setChannelMixerVolume', 'vmix.soloInput', 'vmix.soloAllOff',
    // Audio Presets
    'vmix.loadAudioPreset', 'vmix.saveAudioPreset', 'vmix.deleteAudioPreset',
    // General
    'vmix.keyPress', 'vmix.tBar', 'vmix.setDynamicInput',
    // Layers
    'vmix.multiViewOverlay', 'vmix.setMultiViewOverlayInput',
    'vmix.setMultiViewOverlayOnPreview', 'vmix.setMultiViewOverlayOnProgram',
    'vmix.setLayerPosition', 'vmix.clearLayerSelection',
    // List
    'vmix.autoPlayFirst', 'vmix.autoPlayNext', 'vmix.listShuffle',
    // Media
    'vmix.videoAction', 'vmix.setPlayhead', 'vmix.videoMark',
    // Input
    'vmix.inputEffect', 'vmix.inputEffectStrength',
    'vmix.resetInput', 'vmix.inputFrameDelay',
    // Output
    'vmix.setOutput', 'vmix.toggleFunction',
    // Util
    'vmix.selectMix', 'vmix.selectBus',
    // Playlist
    'vmix.openPlaylist',
  ];
  for (const name of expected) {
    assert.ok(commandHandlers[name], `${name} should be registered`);
  }
});

test('vmix.replayPlay calls ReplayPlay', async () => {
  const { agent, calls } = makeVmixAgent();
  await commandHandlers['vmix.replayPlay'](agent, {});
  assert.ok(calls.some(c => c.fn === 'ReplayPlay'));
});

test('vmix.replayACamera calls ReplayACameraN', async () => {
  const { agent, calls } = makeVmixAgent();
  await commandHandlers['vmix.replayACamera'](agent, { camera: 3 });
  assert.ok(calls.some(c => c.fn === 'ReplayACamera3'));
});

test('vmix.replayMark calls mark action', async () => {
  const { agent, calls } = makeVmixAgent();
  await commandHandlers['vmix.replayMark'](agent, { action: 'ReplayMarkIn', seconds: 5 });
  assert.ok(calls.some(c => c.fn === 'ReplayMarkIn'));
});

test('vmix.replaySelectEvents calls ReplaySelectEventsN', async () => {
  const { agent, calls } = makeVmixAgent();
  await commandHandlers['vmix.replaySelectEvents'](agent, { tab: 5 });
  assert.ok(calls.some(c => c.fn === 'ReplaySelectEvents5'));
});

test('vmix.ptzMove calls PTZ direction', async () => {
  const { agent, calls } = makeVmixAgent();
  await commandHandlers['vmix.ptzMove'](agent, { direction: 'Up', input: 1, speed: 0.5 });
  assert.ok(calls.some(c => c.fn === 'PTZUp'));
});

test('vmix.ptzFocusZoom calls PTZ action', async () => {
  const { agent, calls } = makeVmixAgent();
  await commandHandlers['vmix.ptzFocusZoom'](agent, { action: 'ZoomIn', input: 1 });
  assert.ok(calls.some(c => c.fn === 'PTZZoomIn'));
});

test('vmix.dataSourceNextRow calls DataSourceNextRow', async () => {
  const { agent, calls } = makeVmixAgent();
  await commandHandlers['vmix.dataSourceNextRow'](agent, { name: 'Scores', table: 'Sheet1' });
  assert.ok(calls.some(c => c.fn === 'DataSourceNextRow'));
});

test('vmix.setTextByLayer calls SetText with SelectedName', async () => {
  const { agent, calls } = makeVmixAgent();
  await commandHandlers['vmix.setTextByLayer'](agent, { input: 1, layer: 'Title', text: 'Hello' });
  const call = calls.find(c => c.fn === 'SetText');
  assert.ok(call);
  assert.equal(call.params.SelectedName, 'Title');
});

test('vmix.virtualSet calls SelectVirtualSetN', async () => {
  const { agent, calls } = makeVmixAgent();
  await commandHandlers['vmix.virtualSet'](agent, { preset: 2, input: 1 });
  assert.ok(calls.some(c => c.fn === 'SelectVirtualSet2'));
});

test('vmix.tBar calls SetFader', async () => {
  const { agent, calls } = makeVmixAgent();
  await commandHandlers['vmix.tBar'](agent, { value: 128 });
  const call = calls.find(c => c.fn === 'SetFader');
  assert.ok(call);
  assert.equal(call.params.Value, 128);
});

test('vmix.soloAllOff calls SoloAllOff', async () => {
  const { agent, calls } = makeVmixAgent();
  await commandHandlers['vmix.soloAllOff'](agent, {});
  assert.ok(calls.some(c => c.fn === 'SoloAllOff'));
});

test('vmix.selectMix calls SelectMixN', async () => {
  const { agent, calls } = makeVmixAgent();
  await commandHandlers['vmix.selectMix'](agent, { mix: 3 });
  assert.ok(calls.some(c => c.fn === 'SelectMix3'));
});

test('vmix.resetInput calls ResetInput', async () => {
  const { agent, calls } = makeVmixAgent();
  await commandHandlers['vmix.resetInput'](agent, { input: 1 });
  assert.ok(calls.some(c => c.fn === 'ResetInput'));
});

test('vmix.videoAction calls specified action', async () => {
  const { agent, calls } = makeVmixAgent();
  await commandHandlers['vmix.videoAction'](agent, { action: 'Pause', input: 1 });
  assert.ok(calls.some(c => c.fn === 'Pause'));
});

test('vmix.controlCountdown calls CountdownAction', async () => {
  const { agent, calls } = makeVmixAgent();
  await commandHandlers['vmix.controlCountdown'](agent, { action: 'Start', input: 1 });
  assert.ok(calls.some(c => c.fn === 'CountdownStart'));
});

test('vmix.titleBeginAnimation calls TitleBeginAnimation', async () => {
  const { agent, calls } = makeVmixAgent();
  await commandHandlers['vmix.titleBeginAnimation'](agent, { input: 1, animation: 'TransitionIn' });
  const call = calls.find(c => c.fn === 'TitleBeginAnimation');
  assert.ok(call);
  assert.equal(call.params.Value, 'TransitionIn');
});

// ═══════════════════════════════════════════════════════════════════════════════
// TOTAL COMMAND COUNT VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

test('total command count confirms 100% parity target', () => {
  // Count commands by prefix
  const counts = {};
  for (const key of Object.keys(commandHandlers)) {
    const prefix = key.split('.')[0];
    counts[prefix] = (counts[prefix] || 0) + 1;
  }
  // Verify minimum counts per device
  assert.ok(counts.atem >= 112, `ATEM should have >= 112 commands, got ${counts.atem}`);
  assert.ok(counts.camera >= 33, `Camera should have >= 33 commands, got ${counts.camera}`);
  assert.ok(counts.obs >= 62, `OBS should have >= 62 commands, got ${counts.obs}`);
  assert.ok(counts.propresenter >= 71, `ProPresenter should have >= 71 commands, got ${counts.propresenter}`);
  assert.ok(counts.vmix >= 143, `vMix should have >= 143 commands, got ${counts.vmix}`);
  assert.ok(counts.resolume >= 58, `Resolume should have >= 58 commands, got ${counts.resolume}`);
  assert.ok(counts.videohub >= 25, `VideoHub should have >= 25 commands, got ${counts.videohub}`);
  console.log('Command counts:', counts);
});
