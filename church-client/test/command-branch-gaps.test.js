/**
 * Real command behavior that the unit suite was not exercising:
 * OBS companion-parity requests (and the "OBS dropped before confirming" path),
 * vMix function/overlay/tally/script commands, ProPresenter companion-parity
 * commands including a backup that did not follow, and mixer model-family
 * capability labels plus "sent, not confirmed" wording when the desk gives no reason.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { commandHandlers } = require('../src/commands');
const { mixerBrandName } = require('../src/commands/mixer');

function makeObs(responseMap = {}) {
  const calls = [];
  const listeners = new Map();
  return {
    calls,
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
    },
    off(event, fn) { listeners.get(event)?.delete(fn); },
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
  return { obs, agent: { obs, status: { obs: { connected: true } } } };
}

async function run(name, agent, params) {
  return commandHandlers[name](agent, params);
}

// ─── OBS: confirmation gives up if OBS disconnects mid-command ──────────────

test('obs.startStream refuses when OBS disconnects before the stream is confirmed', async () => {
  const obs = {
    async call() { agent.status.obs.connected = false; },
    on() {},
    off() {},
  };
  const agent = { obs, status: { obs: { connected: true } } };
  await assert.rejects(
    () => commandHandlers['obs.startStream'](agent, {}),
    /OBS disconnected before confirming the stream start/
  );
});

test('obs.stopRecording refuses when OBS disconnects before the stop is confirmed', async () => {
  const obs = {
    async call() { agent.status.obs.connected = false; },
    on() {},
    off() {},
  };
  const agent = { obs, status: { obs: { connected: true } } };
  await assert.rejects(
    () => commandHandlers['obs.stopRecording'](agent, {}),
    /OBS disconnected before confirming the record stop/
  );
});

// ─── OBS companion-parity commands ───────────────────────────────────────────

test('OBS scene collections and profiles mark the current one and refuse a blank name', async () => {
  const { agent, obs } = obsAgent({
    GetSceneCollectionList: { currentSceneCollectionName: 'Sunday', sceneCollections: ['Sunday', 'Practice'] },
    GetProfileList: { currentProfileName: 'Stream', profiles: ['Stream', 'Record'] },
  });
  assert.equal(await run('obs.getSceneCollections', agent, {}), 'Scene collections: [Sunday], Practice');
  assert.equal(await run('obs.getProfiles', agent, {}), 'Profiles: [Stream], Record');
  assert.equal(await run('obs.setSceneCollection', agent, { collection: 'Practice' }), 'Scene collection set to: Practice');
  assert.equal(obs.calls.at(-1).params.sceneCollectionName, 'Practice');
  assert.equal(await run('obs.setProfile', agent, { name: 'Record' }), 'Profile set to: Record');
  assert.equal(obs.calls.at(-1).params.profileName, 'Record');
  await assert.rejects(() => run('obs.setSceneCollection', agent, {}), /collection name required/);
  await assert.rejects(() => run('obs.setProfile', agent, { profile: '  ' }), /profile name required/);
});

test('OBS screenshot uses the program output when no source is named, and the named source otherwise', async () => {
  const { agent, obs } = obsAgent({
    GetSourceScreenshot: { imageData: 'img-bytes' },
  });
  const program = await run('obs.getScreenshot', agent, { width: 320, height: 180 });
  assert.deepEqual(program, { type: 'screenshot', data: 'img-bytes', source: 'obs-program' });
  assert.equal(obs.calls[0].params.sourceName, '__program__');
  assert.equal(obs.calls[0].params.imageWidth, 320);
  assert.equal(obs.calls[0].params.imageHeight, 180);

  const named = await run('obs.getScreenshot', agent, { source: 'Lyrics', format: 'jpg' });
  assert.equal(named.source, 'obs-Lyrics');
  assert.equal(obs.calls[1].params.sourceName, 'Lyrics');
  assert.equal(obs.calls[1].params.imageFormat, 'jpg');
  assert.equal(obs.calls[1].params.imageWidth, undefined);
});

test('OBS scene-item transform sends only the fields the crew set', async () => {
  const { agent, obs } = obsAgent();
  await assert.rejects(() => run('obs.setSceneItemTransform', agent, { itemId: 1 }), /scene name required/);
  const msg = await run('obs.setSceneItemTransform', agent, {
    scene: 'Main', itemId: 4, positionX: 10, positionY: 20, rotation: 90,
    scaleX: 1.5, scaleY: 1.5, cropTop: 1, cropBottom: 2, cropLeft: 3, cropRight: 4,
    boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 1920, boundsHeight: 1080,
  });
  assert.equal(msg, 'Transform updated for item 4 in "Main"');
  assert.deepEqual(obs.calls[0].params.sceneItemTransform, {
    positionX: 10, positionY: 20, rotation: 90, scaleX: 1.5, scaleY: 1.5,
    cropTop: 1, cropBottom: 2, cropLeft: 3, cropRight: 4,
    boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 1920, boundsHeight: 1080,
  });
});

test('OBS filter settings overlay defaults on and rejects a non-object settings payload', async () => {
  const { agent, obs } = obsAgent();
  await assert.rejects(() => run('obs.setSourceFilterSettings', agent, { source: 'Cam' }), /source and filter names required/);
  await assert.rejects(
    () => run('obs.setSourceFilterSettings', agent, { source: 'Cam', filter: 'Blur', settings: 'nope' }),
    /settings must be an object/
  );
  const msg = await run('obs.setSourceFilterSettings', agent, {
    source: 'Cam', filter: 'Blur', settings: { opacity: 0.5 }, overlay: false,
  });
  assert.equal(msg, 'Filter "Blur" settings updated on "Cam"');
  assert.equal(obs.calls[0].params.overlay, false);
  assert.deepEqual(obs.calls[0].params.filterSettings, { opacity: 0.5 });
});

test('OBS stats and stream settings hide a missing key and say N/A when OBS omits a number', async () => {
  const { agent } = obsAgent({
    GetStats: { cpuUsage: 12.34, memoryUsage: 0, availableDiskSpace: 0, activeFps: 0, renderSkippedFrames: 0, outputSkippedFrames: 3 },
    GetStreamServiceSettings: { streamServiceType: 'rtmp_custom', streamServiceSettings: { server: 'rtmp://a' } },
  });
  const stats = await run('obs.getStats', agent, {});
  assert.equal(stats.cpuUsage, '12.3%');
  assert.equal(stats.memoryUsage, 'N/A');
  assert.equal(stats.availableDiskSpace, 'N/A');
  assert.equal(stats.activeFps, 'N/A');
  assert.equal(stats.outputSkippedFrames, 3);
  assert.equal(stats.renderSkippedFrames, 0);
  const settings = await run('obs.getStreamSettings', agent, {});
  assert.deepEqual(settings, { type: 'rtmp_custom', server: 'rtmp://a', key: '(none)' });
});

test('OBS stats format memory, disk and fps when OBS reports them, and masks a stream key', async () => {
  const { agent } = obsAgent({
    GetStats: { cpuUsage: 0, memoryUsage: 512.4, availableDiskSpace: 80.2, activeFps: 59.94, renderTotalFrames: 10, outputTotalFrames: 9 },
    GetStreamServiceSettings: { streamServiceType: 'rtmp_common', streamServiceSettings: { server: 'rtmp://b', key: 'secret' } },
  });
  const stats = await run('obs.getStats', agent, {});
  assert.equal(stats.cpuUsage, 'N/A');
  assert.equal(stats.memoryUsage, '512 MB');
  assert.equal(stats.availableDiskSpace, '80.2 GB');
  assert.equal(stats.activeFps, '59.9');
  assert.equal(stats.renderTotalFrames, 10);
  const settings = await run('obs.getStreamSettings', agent, {});
  assert.equal(settings.key, '***');
});

test('OBS output status keeps whichever of stream or record OBS actually answered', async () => {
  const streamOnly = obsAgent({
    GetStreamStatus: { outputActive: true, outputTimecode: '00:01:00', outputBytes: 10, outputSkippedFrames: 1, outputTotalFrames: 100 },
    GetRecordStatus: new Error('record status unavailable'),
  });
  const s = await run('obs.getOutputStatus', streamOnly.agent, {});
  assert.equal(s.streaming, true);
  assert.equal(s.streamTimecode, '00:01:00');
  assert.equal(s.recording, undefined);

  const recordOnly = obsAgent({
    GetStreamStatus: new Error('stream status unavailable'),
    GetRecordStatus: { outputActive: false, outputPaused: true, outputTimecode: '00:00:10', outputBytes: 5 },
  });
  const r = await run('obs.getOutputStatus', recordOnly.agent, {});
  assert.equal(r.streaming, undefined);
  assert.equal(r.recording, false);
  assert.equal(r.recordPaused, true);
});

test('OBS media actions accept short names and the full OBS enum, and refuse anything else', async () => {
  const { agent, obs } = obsAgent();
  await assert.rejects(() => run('obs.mediaInputAction', agent, { input: 'Clip' }), /action must be one of/);
  await assert.rejects(() => run('obs.mediaInputAction', agent, { action: 'PLAY' }), /input name required/);
  assert.match(await run('obs.mediaInputAction', agent, { input: 'Clip', action: 'pause' }), /Media "Clip": PAUSE/);
  assert.equal(obs.calls.at(-1).params.mediaAction, 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE');
  await run('obs.mediaInputAction', agent, { name: 'Clip', action: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP' });
  assert.equal(obs.calls.at(-1).params.mediaAction, 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP');
  await assert.rejects(() => run('obs.setMediaInputCursor', agent, { input: 'Clip' }), /cursor \(ms\) must be an integer/);
  assert.equal(await run('obs.setMediaInputCursor', agent, { input: 'Clip', ms: 1500 }), 'Media "Clip" seeked to 1500ms');
  const status = await run('obs.getMediaInputStatus', agent, { input: 'Clip' });
  assert.deepEqual(status, { state: undefined, duration: undefined, cursor: undefined });
  await assert.rejects(() => run('obs.getMediaInputStatus', agent, {}), /input name required/);
});

test('OBS hotkeys, captions, text, browser refresh and virtual cam say exactly what they sent', async () => {
  const { agent, obs } = obsAgent();
  assert.equal(await run('obs.triggerTransition', agent, {}), 'Studio mode transition triggered');
  assert.equal(obs.calls.at(-1).method, 'TriggerStudioModeTransition');
  await assert.rejects(() => run('obs.triggerHotkey', agent, {}), /hotkey name required/);
  assert.equal(await run('obs.triggerHotkey', agent, { name: 'OBSBasic.StartStreaming' }), 'Hotkey triggered: OBSBasic.StartStreaming');
  await assert.rejects(() => run('obs.triggerHotkeySequence', agent, {}), /keyId required/);
  assert.match(await run('obs.triggerHotkeySequence', agent, { keyId: 'OBS_KEY_S', shift: 'true', control: true, alt: false, command: 'true' }), /OBS_KEY_S/);
  assert.deepEqual(obs.calls.at(-1).params.keyModifiers, { shift: true, alt: false, control: true, command: true });
  await assert.rejects(() => run('obs.sendStreamCaption', agent, { text: '  ' }), /captionText required/);
  assert.equal(await run('obs.sendStreamCaption', agent, { captionText: 'Welcome' }), 'Stream caption sent');
  await assert.rejects(() => run('obs.setText', agent, {}), /input name required/);
  assert.equal(await run('obs.setText', agent, { input: 'Lower Third', text: 'Hello' }), 'Text set for "Lower Third"');
  assert.deepEqual(obs.calls.at(-1).params.inputSettings, { text: 'Hello' });
  const props = await run('obs.setTextProperties', agent, {
    input: 'Lower Third', face: 'Arial', size: 48, style: 'Bold', flags: 1, color: 0xffffff, text: 'Hi',
  });
  assert.equal(props, 'Text properties updated for "Lower Third"');
  assert.deepEqual(obs.calls.at(-1).params.inputSettings.font, { face: 'Arial', size: 48, style: 'Bold', flags: 1 });
  await assert.rejects(() => run('obs.refreshBrowserSource', agent, {}), /input name required/);
  assert.match(await run('obs.refreshBrowserSource', agent, { name: 'Slides' }), /Browser source "Slides" refreshed/);
  assert.equal(obs.calls.at(-1).params.propertyName, 'refreshnocache');
  await assert.rejects(() => run('obs.resetCaptureDevice', agent, {}), /input name required/);
  assert.match(await run('obs.resetCaptureDevice', agent, { input: 'Cam' }), /Capture device "Cam" reset/);
  assert.equal(await run('obs.startVirtualCam', agent, {}), 'Virtual camera started');
  assert.equal(await run('obs.stopVirtualCam', agent, {}), 'Virtual camera stopped');
  assert.equal(await run('obs.toggleStream', agent, {}), 'Stream toggled');
  assert.equal(await run('obs.toggleReplayBuffer', agent, {}), 'Replay buffer toggled');
  assert.equal(await run('obs.startReplayBuffer', agent, {}), 'Replay buffer started');
  assert.equal(await run('obs.stopReplayBuffer', agent, {}), 'Replay buffer stopped');
  assert.equal(await run('obs.saveReplayBuffer', agent, {}), 'Replay buffer saved');
  assert.equal(await run('obs.toggleRecordPause', agent, {}), 'Record pause toggled');
  assert.equal(await run('obs.splitRecordFile', agent, {}), 'Record file split');
  assert.equal(await run('obs.createRecordChapter', agent, {}), 'Record chapter created');
  assert.equal(await run('obs.createRecordChapter', agent, { chapterName: 'Sermon' }), 'Record chapter created: Sermon');
  assert.equal(obs.calls.at(-1).params.chapterName, 'Sermon');
});

test('OBS volume adjust and fade clamp to the OBS dB range, and balance must be 0–1', async () => {
  const { agent, obs } = obsAgent({ GetInputVolume: { inputVolumeDb: 20 } });
  await assert.rejects(() => run('obs.adjustVolume', agent, { input: 'Mic' }), /adjustDb \(number\) required/);
  await assert.rejects(() => run('obs.adjustVolume', agent, { adjustDb: 1 }), /input name required/);
  const up = await run('obs.adjustVolume', agent, { input: 'Mic', adjustDb: 20 });
  assert.equal(up, 'Volume for "Mic": 20.0 → 26.0 dB');
  const downAgent = obsAgent({ GetInputVolume: { inputVolumeDb: -90 } });
  const down = await run('obs.adjustVolume', downAgent.agent, { name: 'Mic', adjustDb: -50 });
  assert.equal(down, 'Volume for "Mic": -90.0 → -100.0 dB');

  await assert.rejects(() => run('obs.fadeVolume', agent, { input: 'Mic' }), /targetDb \(number\) required/);
  const faded = await run('obs.fadeVolume', agent, { input: 'Mic', targetDb: 0, duration: 1 });
  assert.equal(faded, 'Volume for "Mic" faded: 20.0 → 0.0 dB over 1ms');
  const sets = obs.calls.filter(c => c.method === 'SetInputVolume');
  assert.equal(sets.length, 26); // the clamp adjust, then 25 fade steps
  assert.equal(sets[0].params.inputVolumeDb, 26);
  assert.ok(sets.every(c => c.params.inputVolumeDb <= 26 && c.params.inputVolumeDb >= -100));

  await assert.rejects(() => run('obs.setInputAudioBalance', agent, { input: 'Mic', balance: 1.5 }), /balance must be 0\.0–1\.0/);
  await assert.rejects(() => run('obs.setInputAudioBalance', agent, { balance: 0.5 }), /input name required/);
  assert.match(await run('obs.setInputAudioBalance', agent, { input: 'Mic', value: 0 }), /set to 0/);
  await assert.rejects(() => run('obs.setInputAudioSyncOffset', agent, { input: 'Mic' }), /ms must be an integer/);
  assert.match(await run('obs.setInputAudioSyncOffset', agent, { name: 'Mic', offset: -40 }), /set to -40ms/);
  await assert.rejects(() => run('obs.setInputAudioMonitorType', agent, {}), /input name required/);
  assert.match(await run('obs.setInputAudioMonitorType', agent, { input: 'Mic', type: 'OBS_MONITORING_TYPE_MONITOR_ONLY' }), /MONITOR_ONLY/);
  await assert.rejects(() => run('obs.toggleInputMute', agent, {}), /input name required/);
  assert.match(await run('obs.toggleInputMute', agent, { input: 'Mic' }), /Mute toggled for "Mic"/);
});

test('OBS input settings and custom requests refuse a bad payload and return OBS data when it answers', async () => {
  const { agent, obs } = obsAgent({ GetVersion: { obsVersion: '30.0.0' }, Sleep: null });
  await assert.rejects(() => run('obs.setInputSettings', agent, { input: 'Title', settings: 'x' }), /settings must be an object/);
  await assert.rejects(() => run('obs.setInputSettings', agent, {}), /input name required/);
  assert.match(await run('obs.setInputSettings', agent, { name: 'Title', settings: { text: 'A' }, overlay: false }), /settings updated/);
  assert.equal(obs.calls.at(-1).params.overlay, false);
  await assert.rejects(() => run('obs.customCommand', agent, {}), /requestType required/);
  const data = await run('obs.customCommand', agent, { requestType: 'GetVersion' });
  assert.deepEqual(data, { obsVersion: '30.0.0' });
  const empty = await run('obs.customCommand', agent, { requestType: 'Sleep', requestData: { sleepMillis: 0 } });
  assert.equal(empty, 'Command executed');
});

test('OBS projector includes a monitor and source only when the crew named them', async () => {
  const { agent, obs } = obsAgent();
  assert.match(await run('obs.openProjector', agent, {}), /OBS_WEBSOCKET_PROJECTOR_PREVIEW/);
  assert.deepEqual(obs.calls[0].params, { projectorType: 'OBS_WEBSOCKET_PROJECTOR_PREVIEW' });
  await run('obs.openProjector', agent, { type: 'OBS_WEBSOCKET_PROJECTOR_SOURCE', monitor: 1, source: 'Cam' });
  assert.deepEqual(obs.calls[1].params, {
    projectorType: 'OBS_WEBSOCKET_PROJECTOR_SOURCE', monitorIndex: 1, sourceName: 'Cam',
  });
});

// ─── vMix ────────────────────────────────────────────────────────────────────

function vmixAgent(extra = {}) {
  const calls = [];
  const vmix = {
    calls,
    async _call(fn, params) {
      calls.push({ fn, params });
      if (extra._call) return extra._call(fn, params);
      return 'ok';
    },
  };
  for (const [name, fn] of Object.entries(extra)) {
    if (name === '_call') continue;
    vmix[name] = async (...args) => {
      calls.push({ fn: name, args });
      return fn(...args);
    };
  }
  const base = new Proxy(vmix, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== 'string') return undefined;
      return async (...args) => {
        calls.push({ fn: prop, args });
        return undefined;
      };
    },
  });
  return { agent: { vmix: base }, calls };
}

test('vMix function command refuses a blank name, a missing low-level API, and a null result', async () => {
  await assert.rejects(() => run('vmix.function', { vmix: {} }, {}), /function parameter required/);
  await assert.rejects(() => run('vmix.function', {}, { function: 'Cut' }), /vMix not configured/);
  await assert.rejects(() => run('vmix.function', { vmix: {} }, { function: 'Cut' }), /low-level function API unavailable/);
  await assert.rejects(() => run('vmix.function', { vmix: { _call: async () => {} } }, {}), /function parameter required/);
  const { agent, calls } = vmixAgent({ _call: async () => null });
  await assert.rejects(() => run('vmix.function', agent, { function: 'Cut', input: 1, value: 'x' }), /Could not execute vMix function "Cut"/);
  assert.deepEqual(calls[0], { fn: 'Cut', params: { Input: 1, Value: 'x' } });
  const ok = vmixAgent();
  assert.equal(await run('vmix.function', ok.agent, { function: 'Fade' }), 'vMix function "Fade" executed');
});

test('vMix playlist, audio levels, overlays and input volume say what the desk was asked to do', async () => {
  await assert.rejects(() => run('vmix.startPlaylist', {}, {}), /vMix not configured/);
  const { agent, calls } = vmixAgent({
    getAudioLevels: async () => ({ volume: 40, muted: true, meterL: -6, meterR: -8 }),
  });
  assert.equal(await run('vmix.startPlaylist', agent, {}), 'vMix playlist started');
  assert.equal(await run('vmix.stopPlaylist', agent, {}), 'vMix playlist stopped');
  assert.match(await run('vmix.audioLevels', agent, {}), /Master: 40% 🔇 MUTED \| L: -6 R: -8/);
  const quiet = vmixAgent({ getAudioLevels: async () => null });
  assert.equal(await run('vmix.audioLevels', quiet.agent, {}), 'Audio level data not available');
  const live = vmixAgent({ getAudioLevels: async () => ({ volume: 80, muted: false, meterL: 0, meterR: 0 }) });
  assert.match(await run('vmix.audioLevels', live.agent, {}), /80% 🔊/);

  await assert.rejects(() => run('vmix.setInputVolume', agent, { input: 2 }), /volume value required/);
  await assert.rejects(() => run('vmix.setInputVolume', agent, { volume: 10 }), /input required/);
  assert.match(await run('vmix.setInputVolume', agent, { input: 2, value: 15 }), /input 2 volume set to 15%/);
  assert.deepEqual(calls.at(-1), { fn: 'SetVolume', params: { Input: 2, Value: 15 } });
  await assert.rejects(() => run('vmix.muteInput', agent, {}), /input required/);
  assert.match(await run('vmix.muteInput', agent, { input: 3 }), /input 3 muted/);
  assert.match(await run('vmix.unmuteInput', agent, { input: 3 }), /input 3 unmuted/);
  assert.match(await run('vmix.overlayInput', agent, { input: 4 }), /overlay 1 set to input 4/);
  assert.equal(calls.at(-1).fn, 'OverlayInput1');
  assert.match(await run('vmix.overlayOff', agent, { overlay: 2 }), /overlay 2 off/);
  assert.equal(calls.at(-1).fn, 'OverlayInput2Off');
  assert.match(await run('vmix.setText', agent, { input: 5 }), /input 5 text updated/);
  assert.equal(calls.at(-1).params.Value, '');
  assert.match(await run('vmix.replay', agent, {}), /vMix replay: PlayLastEvent/);
  assert.match(await run('vmix.replay', agent, { action: 'Play' }), /vMix replay: Play/);
  assert.equal(await run('vmix.fadeToBlack', agent, {}), 'vMix: fade to black');
});

test('vMix transition, crop, loop, bus, tally and scripts report the choice that was sent', async () => {
  const { agent, calls } = vmixAgent({
    transition: async () => {},
    setInputPosition: async () => {},
    setInputZoom: async () => {},
    setInputCrop: async () => {},
    setInputLoop: async () => {},
    renameInput: async () => {},
    setInputColourCorrection: async () => {},
    setInputAudioBus: async () => {},
    setBusVolume: async () => 33,
    muteBus: async () => {},
    setInputNDISource: async () => {},
    setLayerInput: async () => {},
    setTitleField: async () => {},
    selectTitleIndex: async () => {},
    getTallyState: async () => ([
      { number: 1, title: 'Cam', program: true, preview: false },
      { number: 2, title: 'Wide', program: false, preview: true },
      { number: 3, title: 'Off', program: false, preview: false },
    ]),
    runScript: async () => {},
    stopScript: async () => {},
    saveSnapshot: async () => {},
    loadSnapshot: async () => {},
    browserNavigate: async () => {},
    startMultiCorder: async () => {},
    stopMultiCorder: async () => {},
    startExternal: async () => {},
    stopExternal: async () => {},
    toggleFullscreen: async () => {},
  });
  assert.equal(await run('vmix.transition', agent, { type: 'Fade', input: 2, duration: 500 }), 'vMix: Fade transition to input 2');
  assert.equal(await run('vmix.transition', agent, {}), 'vMix: Cut transition');
  await assert.rejects(() => run('vmix.setInputPosition', agent, { x: 1 }), /input required/);
  assert.match(await run('vmix.setInputPosition', agent, { input: 1, x: 10, y: 20 }), /position set/);
  assert.deepEqual(calls.find(c => c.fn === 'setInputPosition').args, [1, 10, 20]);
  assert.equal(await run('vmix.setInputZoom', agent, { input: 1, value: 2 }), 'vMix input 1 zoom set to 2');
  assert.deepEqual(calls.find(c => c.fn === 'setInputZoom').args, [1, 2]);
  // 0 is falsy, so the API is asked for zoom 1 while the reply still quotes the 0 the crew sent.
  assert.equal(await run('vmix.setInputZoom', agent, { input: 1, value: 0 }), 'vMix input 1 zoom set to 0');
  assert.equal(calls.filter(c => c.fn === 'setInputZoom').at(-1).args[1], 1);
  assert.match(await run('vmix.setInputCrop', agent, { input: 1, x1: 0.1, y1: 0.2, x2: 0.8, y2: 0.9 }), /crop set/);
  await assert.rejects(() => run('vmix.setInputLoop', agent, {}), /input required/);
  assert.match(await run('vmix.setInputLoop', agent, { input: 2, on: 'false' }), /loop off/);
  assert.match(await run('vmix.setInputLoop', agent, { input: 2 }), /loop on/);
  await assert.rejects(() => run('vmix.renameInput', agent, { input: 1 }), /name required/);
  assert.match(await run('vmix.renameInput', agent, { input: 1, name: 'Pastor' }), /renamed to "Pastor"/);
  assert.match(await run('vmix.setColourCorrection', agent, { input: 1, gain: 1.1, hue: 5 }), /colour correction updated/);
  assert.match(await run('vmix.setInputAudioBus', agent, { input: 1, bus: 'b', on: false }), /audio bus B off/);
  assert.match(await run('vmix.setBusVolume', agent, { value: 33 }), /bus A volume set to 33%/);
  assert.match(await run('vmix.muteBus', agent, { bus: 'master' }), /bus MASTER mute toggled/);
  await assert.rejects(() => run('vmix.setInputNDISource', agent, { input: 1 }), /NDI source name required/);
  assert.match(await run('vmix.setInputNDISource', agent, { input: 1, source: 'CAM (A)' }), /NDI source set to "CAM \(A\)"/);
  await assert.rejects(() => run('vmix.setLayerInput', agent, { layer: 2 }), /input required/);
  assert.match(await run('vmix.setLayerInput', agent, { input: 3 }), /layer 1 set to input 3/);
  await assert.rejects(() => run('vmix.setTitleField', agent, { input: 1 }), /field name required/);
  assert.match(await run('vmix.setTitleField', agent, { input: 1, field: 'Headline', value: 'Go' }), /title field "Headline"/);
  assert.match(await run('vmix.selectTitleIndex', agent, { input: 1, index: 2 }), /title index set to 2/);
  const tally = await run('vmix.getTallyState', agent, {});
  assert.match(tally, /1\. Cam \[PGM\]/);
  assert.match(tally, /2\. Wide \[PVW\]/);
  assert.match(tally, /3\. Off \[---\]/);
  const none = vmixAgent({ getTallyState: async () => null });
  assert.equal(await run('vmix.getTallyState', none.agent, {}), 'Tally data not available');
  await assert.rejects(() => run('vmix.runScript', agent, {}), /script name required/);
  assert.match(await run('vmix.runScript', agent, { name: 'LowerThird' }), /script "LowerThird" started/);
  assert.match(await run('vmix.stopScript', agent, { name: 'LowerThird' }), /script "LowerThird" stopped/);
  await assert.rejects(() => run('vmix.saveSnapshot', agent, {}), /filename required/);
  assert.match(await run('vmix.saveSnapshot', agent, { filename: 'sunday.vmix' }), /snapshot saved: sunday.vmix/);
  assert.match(await run('vmix.loadSnapshot', agent, { name: 'sunday.vmix' }), /snapshot loaded: sunday.vmix/);
  await assert.rejects(() => run('vmix.browserNavigate', agent, { input: 1 }), /url required/);
  assert.match(await run('vmix.browserNavigate', agent, { input: 8, url: 'https://example.test' }), /navigated to https:\/\/example.test/);
  assert.equal(await run('vmix.startMultiCorder', agent, {}), 'vMix MultiCorder started');
  assert.equal(await run('vmix.stopMultiCorder', agent, {}), 'vMix MultiCorder stopped');
  assert.equal(await run('vmix.startExternal', agent, {}), 'vMix external output started');
  assert.equal(await run('vmix.stopExternal', agent, {}), 'vMix external output stopped');
  assert.equal(await run('vmix.toggleFullscreen', agent, {}), 'vMix fullscreen toggled');
});

// ─── ProPresenter companion parity ───────────────────────────────────────────

function ppAgent(methods, { backup = false } = {}) {
  const calls = [];
  const proPresenter = {
    _backup: backup ? { host: '10.0.0.2' } : null,
    lastMirror: null,
  };
  for (const [name, fn] of Object.entries(methods)) {
    proPresenter[name] = async (...args) => {
      calls.push({ name, args });
      return fn(...args);
    };
  }
  return { agent: { proPresenter }, calls };
}

test('ProPresenter audience screens accept on/off in several forms and refuse anything else', async () => {
  const { agent, calls } = ppAgent({ setAudienceScreens: async (on) => (on ? 'Audience screens on' : 'Audience screens off') });
  await assert.rejects(() => run('propresenter.audienceScreens', {}, {}), /ProPresenter not configured/);
  await assert.rejects(() => run('propresenter.audienceScreens', agent, {}), /Specify on: true\/false/);
  await assert.rejects(() => run('propresenter.audienceScreens', agent, { on: 'maybe' }), /Invalid value "maybe"/);
  assert.equal(await run('propresenter.audienceScreens', agent, { on: 'on' }), 'Audience screens on');
  assert.equal(await run('propresenter.audienceScreens', agent, { state: 0 }), 'Audience screens off');
  assert.equal(await run('propresenter.audienceScreens', agent, { on: '1' }), 'Audience screens on');
  assert.equal(await run('propresenter.audienceScreens', agent, { state: 'false' }), 'Audience screens off');
  assert.deepEqual(calls.map(c => c.args[0]), [true, false, true, false]);
});

test('ProPresenter lists are honest when empty, and triggers name what was fired', async () => {
  const empty = ppAgent({
    getProps: async () => [],
    getGroups: async () => [],
    getMacros: async () => [],
    getStageLayouts: async () => [],
    getAudioPlaylists: async () => [],
    getMediaPlaylists: async () => [],
    getAnnouncementStatus: async () => null,
    getCurrentSlide: async () => null,
  });
  assert.equal(await run('propresenter.getProps', empty.agent, {}), 'No props found');
  assert.equal(await run('propresenter.getGroups', empty.agent, {}), 'No groups found');
  assert.equal(await run('propresenter.getMacros', empty.agent, {}), 'No macros found');
  assert.equal(await run('propresenter.getStageLayouts', empty.agent, {}), 'No stage layouts found');
  assert.equal(await run('propresenter.getAudioPlaylists', empty.agent, {}), 'No audio playlists found');
  assert.equal(await run('propresenter.getMediaPlaylists', empty.agent, {}), 'No media playlists found');
  assert.equal(await run('propresenter.announcementStatus', empty.agent, {}), 'No active announcement');
  await assert.rejects(() => run('propresenter.lastSlide', empty.agent, {}), /Could not determine slide count/);

  const full = ppAgent({
    getProps: async () => [{ name: 'Logo' }],
    getGroups: async () => [{ name: 'Chorus' }],
    getMacros: async () => [{ name: 'Lights' }],
    getStageLayouts: async () => [{ name: 'Lyrics' }],
    getAudioPlaylists: async () => [{ name: 'Walk-in' }],
    getMediaPlaylists: async () => [{ name: 'Bumpers' }],
    getAnnouncementStatus: async () => ({ presentationName: '', slideIndex: 0, slideCount: 2 }),
    triggerPresentation: async (n) => n,
    triggerPlaylistItem: async (p) => p,
    triggerProp: async (n) => n,
    clearProps: async () => {},
    triggerGroup: async (n) => n,
    triggerMacro: async (n) => n,
    setStageLayout: async (n) => n,
    triggerVideoInput: async () => {},
    nextAnnouncement: async () => {},
    previousAnnouncement: async () => {},
    clearMedia: async () => {},
    clearAudio: async () => {},
    clearAnnouncements: async () => {},
    resetTimer: async (n) => n,
    createTimer: async (n) => n,
    getCurrentSlide: async () => ({ slideTotal: 12, name: 'Call to Worship' }),
    goToSlide: async () => {},
  });
  assert.equal(await run('propresenter.getProps', full.agent, {}), 'Logo');
  assert.equal(await run('propresenter.getGroups', full.agent, {}), 'Chorus');
  assert.equal(await run('propresenter.getMacros', full.agent, {}), 'Lights');
  assert.match(await run('propresenter.announcementStatus', full.agent, {}), /Announcement: Unknown — slide 1 of 2/);
  await assert.rejects(() => run('propresenter.triggerPresentation', full.agent, {}), /presentation name or UUID required/);
  assert.match(await run('propresenter.triggerPresentation', full.agent, { uuid: 'pres-1' }), /Triggered presentation "pres-1"/);
  await assert.rejects(() => run('propresenter.triggerPlaylistItem', full.agent, {}), /playlist name required/);
  assert.match(await run('propresenter.triggerPlaylistItem', full.agent, { playlist: 'Sunday' }), /item 0/);
  assert.match(await run('propresenter.triggerPlaylistItem', full.agent, { playlist: 'Sunday', index: 3 }), /item 3/);
  await assert.rejects(() => run('propresenter.triggerProp', full.agent, {}), /prop name required/);
  assert.match(await run('propresenter.triggerProp', full.agent, { name: 'Logo' }), /Prop "Logo" triggered/);
  assert.equal(await run('propresenter.clearProps', full.agent, {}), 'Props layer cleared');
  await assert.rejects(() => run('propresenter.triggerGroup', full.agent, {}), /group name required/);
  assert.match(await run('propresenter.triggerGroup', full.agent, { name: 'Chorus' }), /Group "Chorus" triggered/);
  await assert.rejects(() => run('propresenter.triggerMacro', full.agent, { name: '  ' }), /macro name required/);
  assert.match(await run('propresenter.triggerMacro', full.agent, { name: 'Lights' }), /macros have no readable state/);
  await assert.rejects(() => run('propresenter.setStageLayout', full.agent, {}), /layout name required/);
  assert.match(await run('propresenter.setStageLayout', full.agent, { name: 'Lyrics', screen: 1 }), /Stage layout set to "Lyrics"/);
  assert.deepEqual(full.calls.find(c => c.name === 'setStageLayout').args, ['Lyrics', 1]);
  await assert.rejects(() => run('propresenter.triggerVideoInput', full.agent, {}), /video input name required/);
  assert.match(await run('propresenter.triggerVideoInput', full.agent, { name: 'Camera 1' }), /Video input "Camera 1" triggered/);
  assert.match(await run('propresenter.nextAnnouncement', full.agent, {}), /Next announcement slide — accepted by ProPresenter/);
  assert.match(await run('propresenter.previousAnnouncement', full.agent, {}), /Previous announcement slide/);
  assert.equal(await run('propresenter.clearMedia', full.agent, {}), 'Media layer cleared');
  assert.equal(await run('propresenter.clearAudio', full.agent, {}), 'Audio layer cleared');
  assert.equal(await run('propresenter.clearAnnouncements', full.agent, {}), 'Announcements cleared');
  await assert.rejects(() => run('propresenter.resetTimer', full.agent, {}), /Timer name required/);
  assert.match(await run('propresenter.resetTimer', full.agent, { name: 'Sermon' }), /Timer "Sermon" reset — accepted/);
  await assert.rejects(() => run('propresenter.createTimer', full.agent, {}), /Timer name required/);
  assert.match(await run('propresenter.createTimer', full.agent, { name: 'Giving', allowsOverrun: true, duration: 300 }), /Timer "Giving" created/);
  const created = full.calls.find(c => c.name === 'createTimer');
  assert.deepEqual(created.args[1], { allowsOverrun: true, countdownDuration: 300 });
  assert.match(await run('propresenter.lastSlide', full.agent, {}), /Jumped to last slide \(slide 12\)/);
});

test('a backup ProPresenter that did not follow is named on the result, and a successful mirror is not', async () => {
  const failed = ppAgent({
    triggerProp: async function (n) {
      this.lastMirror = { ok: false, error: 'backup offline' };
      return n;
    },
  }, { backup: true });
  // `this` inside the method is the proPresenter object.
  failed.agent.proPresenter.triggerProp = async (n) => {
    failed.agent.proPresenter.lastMirror = { ok: false, error: 'backup offline' };
    return n;
  };
  const msg = await run('propresenter.triggerProp', failed.agent, { name: 'Logo' });
  assert.match(msg, /Prop "Logo" triggered/);
  assert.match(msg, /Backup ProPresenter did not follow: backup offline/);

  const ok = ppAgent({
    clearProps: async () => {},
  }, { backup: true });
  ok.agent.proPresenter.clearProps = async () => {
    ok.agent.proPresenter.lastMirror = { ok: true };
  };
  assert.equal(await run('propresenter.clearProps', ok.agent, {}), 'Props layer cleared');

  const objectResult = ppAgent({
    toggleAudienceScreens: async () => ({ on: false }),
  }, { backup: true });
  objectResult.agent.proPresenter.toggleAudienceScreens = async () => {
    objectResult.agent.proPresenter.lastMirror = { ok: false, error: 'backup offline' };
    return { on: false };
  };
  assert.deepEqual(await run('propresenter.toggleAudienceScreens', objectResult.agent, {}), { on: false });
});

test('ProPresenter transport, timeline, capture, timers and library cues name the layer and refuse a missing id', async () => {
  const { agent, calls } = ppAgent({
    transportPlay: async () => {},
    transportPause: async () => {},
    transportSkipForward: async () => {},
    transportSkipBackward: async () => {},
    transportGoToTime: async () => {},
    transportGoToEnd: async () => {},
    timelinePlay: async () => {},
    timelinePause: async () => {},
    timelineRewind: async () => {},
    captureStart: async () => {},
    captureStop: async () => {},
    incrementTimer: async (n) => n,
    setTimerValue: async (n) => n,
    toggleProp: async (n) => n,
    toggleStageMessage: async (n) => `stage ${n}`,
    toggleAudienceScreens: async () => 'audience toggled',
    toggleStageScreens: async () => 'stage toggled',
    triggerLibraryCue: async () => {},
    activeAudioPlaylistTrigger: async () => {},
    focusedAudioPlaylistTrigger: async () => {},
    audioPlaylistFocus: async (n) => n,
    audioPlaylistTrigger: async (n) => n,
    activeMediaPlaylistTrigger: async () => {},
    focusedMediaPlaylistTrigger: async () => {},
    mediaPlaylistFocus: async (n) => n,
    mediaPlaylistTrigger: async (n) => n,
  });
  assert.equal(await run('propresenter.transportPlay', agent, {}), 'Transport play (presentation)');
  assert.equal(await run('propresenter.transportPause', agent, { layer: 'announcement' }), 'Transport paused (announcement)');
  assert.match(await run('propresenter.transportSkipForward', agent, {}), /skip forward 10s \(presentation\) — accepted/);
  assert.match(await run('propresenter.transportSkipBackward', agent, { layer: 'media', seconds: 5 }), /skip backward 5s \(media\)/);
  assert.equal(await run('propresenter.transportGoToTime', agent, { time: 12 }), 'Transport go to time 12 (presentation)');
  assert.match(await run('propresenter.transportGoToEnd', agent, { layer: 'audio' }), /go to end \(audio\) — accepted/);
  assert.match(await run('propresenter.timelinePlay', agent, {}), /Timeline playing — accepted/);
  assert.match(await run('propresenter.timelinePause', agent, {}), /Timeline paused — accepted/);
  assert.match(await run('propresenter.timelineRewind', agent, {}), /Timeline rewound — accepted/);
  assert.equal(await run('propresenter.captureStart', agent, {}), 'Capture started');
  assert.equal(await run('propresenter.captureStop', agent, {}), 'Capture stopped');
  await assert.rejects(() => run('propresenter.incrementTimer', agent, {}), /Timer name required/);
  assert.match(await run('propresenter.incrementTimer', agent, { name: 'Sermon' }), /incremented by 30s — accepted/);
  await assert.rejects(() => run('propresenter.setTimerValue', agent, {}), /Timer name required/);
  assert.match(await run('propresenter.setTimerValue', agent, { name: 'Sermon', type: 'countdown', duration: 60, overrun: false, newName: 'Talk' }), /Timer "Sermon" updated/);
  const updated = calls.find(c => c.name === 'setTimerValue');
  assert.deepEqual(updated.args[1], { type: 'countdown', duration: 60, overrun: false, name: 'Talk' });
  await assert.rejects(() => run('propresenter.toggleProp', agent, {}), /prop name required/);
  assert.match(await run('propresenter.toggleProp', agent, { name: 'Logo' }), /Prop "Logo" toggled/);
  await assert.rejects(() => run('propresenter.toggleStageMessage', agent, {}), /message name required/);
  assert.equal(await run('propresenter.toggleStageMessage', agent, { name: 'Welcome' }), 'stage Welcome');
  assert.equal(await run('propresenter.toggleAudienceScreens', agent, {}), 'audience toggled');
  assert.equal(await run('propresenter.toggleStageScreens', agent, {}), 'stage toggled');
  await assert.rejects(() => run('propresenter.triggerLibraryCue', agent, {}), /libraryId required/);
  await assert.rejects(() => run('propresenter.triggerLibraryCue', agent, { libraryId: 'lib' }), /presentationId required/);
  assert.match(
    await run('propresenter.triggerLibraryCue', agent, { libraryId: 'lib', presentationId: 'pres', cueIndex: 2 }),
    /library: lib, presentation: pres, cue: 2/
  );
  assert.match(await run('propresenter.activeAudioPlaylistTrigger', agent, {}), /Active audio playlist: next — accepted/);
  assert.match(await run('propresenter.focusedAudioPlaylistTrigger', agent, { action: 'previous' }), /Focused audio playlist: previous/);
  await assert.rejects(() => run('propresenter.audioPlaylistFocus', agent, {}), /playlist name or ID required/);
  assert.match(await run('propresenter.audioPlaylistFocus', agent, { name: 'Walk-in' }), /Audio playlist "Walk-in" focused — accepted/);
  assert.match(await run('propresenter.audioPlaylistTrigger', agent, { name: 'Walk-in' }), /Audio playlist "Walk-in" triggered — accepted/);
  assert.match(await run('propresenter.mediaPlaylistFocus', agent, { name: 'Bumpers' }), /Media playlist "Bumpers" focused — accepted/);
  await assert.rejects(() => run('propresenter.mediaPlaylistTrigger', agent, {}), /playlist name or ID required/);
  assert.match(await run('propresenter.mediaPlaylistTrigger', agent, { id: 'pl-1' }), /Media playlist "pl-1"/);
});

// ─── Mixer families and honest "not confirmed" wording ──────────────────────

test('mixer brand names cover Avantis, dLive and the X32 alias, and fall back when both are blank', () => {
  assert.equal(mixerBrandName('avantis', ''), 'Allen & Heath Avantis');
  assert.equal(mixerBrandName('avantis', 'Avantis'), 'Allen & Heath Avantis');
  assert.equal(mixerBrandName('dlive', ''), 'Allen & Heath dLive');
  assert.equal(mixerBrandName('dlive', 'C3500'), 'Allen & Heath C3500');
  assert.equal(mixerBrandName('x32', 'X32 Compact'), 'Behringer X32 Compact');
  assert.equal(mixerBrandName('', ''), 'Audio Console');
  assert.equal(mixerBrandName('soundcraft', 'Si'), 'Si');
});

test('mixer.capabilities maps compact models onto their family and says so when the model is unknown', async () => {
  const caps = async (model) => run('mixer.capabilities', { mixer: { model } }, {});
  assert.match(await caps('X32RACK'), /compressor: Supported/);
  assert.match(await caps('M32C'), /muteGroup: Supported/);
  assert.match(await caps('CL5'), /pan: Supported/);
  assert.match(await caps('CL5'), /compressor: Not available/);
  assert.match(await caps('QL1'), /fader: Supported/);
  assert.match(await caps('TF-RACK'), /muteMaster: Supported/);
  const unknown = await caps('GLD');
  assert.equal(unknown.model, 'GLD');
  assert.equal(unknown.note, 'Unknown mixer model — all features assumed available');
});

test('a channel strip that the desk only partly applied says what was skipped and what was not confirmed', async () => {
  const agent = {
    mixer: {
      model: 'SQ5',
      async setFullChannelStrip() {
        return { skipped: ['eq'], unconfirmed: ['mute'] };
      },
    },
  };
  const msg = await run('mixer.setFullChannelStrip', agent, { channel: 4, name: 'Pastor' });
  assert.match(msg, /Channel 4 \(Pastor\) — strip partly applied/);
  assert.match(msg, /skipped \(not available on this console\): eq/);
  assert.match(msg, /sent but not confirmed by the console: mute/);
});

test('SoftKey and scene recall say "not confirmed" even when the console gives no reason', async () => {
  const agent = {
    mixer: {
      model: 'SQ6',
      async pressSoftKey() { return { confirmed: false }; },
      async recallScene() { return { confirmed: false }; },
      async muteMaster() { return { confirmed: false }; },
    },
  };
  assert.match(await run('mixer.pressSoftKey', agent, { key: 3 }), /SoftKey 3 press sent — not confirmed by the console \(no read-back available\)/);
  assert.match(await run('mixer.recallScene', agent, { scene: 2 }), /Scene 2 recall sent — not confirmed by the console \(no read-back available\)/);
  assert.match(await run('mixer.mute', agent, {}), /Master mute sent — not confirmed by the console \(no read-back available\)/);
});

test('every vMix and ProPresenter command refuses when that device is not configured', async () => {
  const vmixCommands = require('../src/commands/vmix');
  const ppCommands = require('../src/commands/propresenter');
  assert.ok(Object.keys(vmixCommands).length > 20);
  for (const [name, fn] of Object.entries(vmixCommands)) {
    await assert.rejects(() => fn({}, {}), /vMix not configured/, name);
  }
  assert.ok(Object.keys(ppCommands).length > 20);
  for (const [name, fn] of Object.entries(ppCommands)) {
    await assert.rejects(() => fn({}, {}), /ProPresenter not configured/, name);
  }
});

test('vMix replay commands send the matching vMix function and say which choice was used', async () => {
  const { agent, calls } = vmixAgent();
  const sent = () => calls.at(-1);

  assert.equal(await run('vmix.replayACamera', agent, { camera: 2 }), 'vMix replay A camera set to 2');
  assert.equal(sent().fn, 'ReplayACamera2');
  assert.equal(await run('vmix.replayBCamera', agent, { camera: 1 }), 'vMix replay B camera set to 1');
  assert.equal(sent().fn, 'ReplayBCamera1');
  assert.equal(await run('vmix.replayCamera', agent, { camera: 3 }), 'vMix replay camera set to 3');
  assert.equal(await run('vmix.replaySelectChannel', agent, {}), 'vMix replay channel selected: AB');
  assert.equal(sent().fn, 'ReplaySelectChannelAB');
  assert.equal(await run('vmix.replaySelectChannel', agent, { channel: 'A' }), 'vMix replay channel selected: A');
  assert.equal(sent().fn, 'ReplaySelectChannelA');
  assert.equal(await run('vmix.replaySwapChannels', agent, {}), 'vMix replay channels swapped');
  assert.equal(await run('vmix.replayMark', agent, {}), 'vMix replay: ReplayMarkIn');
  assert.deepEqual(sent().params, {});
  assert.equal(await run('vmix.replayMark', agent, { action: 'ReplayMarkOut', seconds: 4 }), 'vMix replay: ReplayMarkOut');
  assert.deepEqual(sent().params, { Value: 4 });
  assert.match(await run('vmix.replayMoveInOut', agent, { frames: -2 }), /ReplayMoveSelectedInPoint by -2 frames/);
  assert.equal(await run('vmix.replayUpdateInOut', agent, { action: 'ReplayUpdateSelectedOutPoint' }), 'vMix replay: ReplayUpdateSelectedOutPoint');
  assert.equal(await run('vmix.replaySelectEvents', agent, { tab: 2 }), 'vMix replay events tab 2 selected');
  assert.equal(sent().fn, 'ReplaySelectEvents2');
  assert.equal(await run('vmix.replayChangeDirection', agent, {}), 'vMix replay direction changed');
  assert.equal(await run('vmix.replayChangeSpeed', agent, { value: -1 }), 'vMix replay speed changed by -1');
  assert.equal(await run('vmix.replaySetSpeed', agent, { value: 50 }), 'vMix replay speed set to 50');
  assert.equal(await run('vmix.replayMoveEvent', agent, { tab: 1 }), 'vMix replay event moved to tab 1');
  assert.equal(await run('vmix.replayMoveEventUp', agent, {}), 'vMix replay event moved up');
  assert.equal(await run('vmix.replayMoveEventDown', agent, {}), 'vMix replay event moved down');
  assert.equal(await run('vmix.replayFastForward', agent, {}), 'vMix replay fast forward at 2x');
  assert.deepEqual(sent().params, { Value: 2 });
  assert.equal(await run('vmix.replayFastBackward', agent, { speed: 4 }), 'vMix replay fast backward at 4x');
  assert.equal(await run('vmix.replayJumpFrames', agent, { frames: 15 }), 'vMix replay jumped 15 frames');
  assert.equal(await run('vmix.replayJumpToNow', agent, {}), 'vMix replay jumped to now');
  assert.equal(await run('vmix.replayLiveToggle', agent, {}), 'vMix replay live toggled');
  assert.equal(await run('vmix.replayPlay', agent, {}), 'vMix replay playing');
  assert.equal(await run('vmix.replayPause', agent, {}), 'vMix replay paused');
  assert.equal(await run('vmix.replayPlayEvent', agent, { event: 7 }), 'vMix replay playing event 7');
  assert.equal(sent().fn, 'ReplayPlayEvent7');
  assert.equal(await run('vmix.replayPlaySelectedEventToOutput', agent, {}), 'vMix replay playing selected event to output');
  assert.equal(await run('vmix.replayPlayEventsByID', agent, { ids: '1,2' }), 'vMix replay playing events by ID: 1,2');
  assert.equal(await run('vmix.replayPlayEventsByIDToOutput', agent, { ids: '3' }), 'vMix replay playing events by ID to output: 3');
  assert.equal(await run('vmix.replayPlayLastEventToOutput', agent, {}), 'vMix replay playing last event to output');
  assert.equal(await run('vmix.replayPlayAllEventsToOutput', agent, {}), 'vMix replay playing all events to output');
  assert.equal(await run('vmix.replayStopEvents', agent, {}), 'vMix replay events stopped');
  assert.match(await run('vmix.replayToggleCamera', agent, { camera: 2 }), /toggled camera 2/);
  assert.equal(await run('vmix.replayShowHide', agent, {}), 'vMix replay show/hide toggled');
  assert.equal(await run('vmix.replayRecording', agent, {}), 'vMix replay: StartRecording');
  assert.equal(sent().fn, 'ReplayStartRecording');
  assert.equal(await run('vmix.replayRecording', agent, { action: 'StopRecording' }), 'vMix replay: StopRecording');
  assert.equal(await run('vmix.replayEventText', agent, { text: 'Goal' }), 'vMix replay event text set');
  assert.equal(sent().fn, 'ReplaySetSelectedEventText');
  assert.equal(await run('vmix.replayEventText', agent, { text: '!' , append: true }), 'vMix replay event text appended');
  assert.equal(sent().fn, 'ReplayAppendSelectedEventText');
  assert.equal(await run('vmix.replayEventTextClear', agent, {}), 'vMix replay event text cleared');
  assert.equal(await run('vmix.ptzMove', agent, { input: 1, speed: 0.5 }), 'vMix PTZ Home');
  assert.equal(sent().fn, 'PTZHome');
  assert.equal(await run('vmix.ptzMove', agent, { direction: 'Up', input: 1, speed: 1 }), 'vMix PTZ Up');
  await assert.rejects(() => run('vmix.replayACamera', agent, {}), /camera must be an integer/);
});

test('OBS accepts the alternate parameter names the portal and Companion send', async () => {
  const { agent, obs } = obsAgent({
    GetSceneCollectionList: { currentSceneCollectionName: '', sceneCollections: ['A'] },
    GetProfileList: { profiles: ['P'] },
    GetInputVolume: { inputVolumeDb: 0 },
  });
  assert.equal(await run('obs.setSceneCollection', agent, { name: 'A' }), 'Scene collection set to: A');
  assert.equal(await run('obs.setProfile', agent, { profile: 'P' }), 'Profile set to: P');
  assert.match(await run('obs.setInputAudioMonitorType', agent, { input: 'Mic', monitorType: 'OBS_MONITORING_TYPE_NONE' }), /NONE/);
  assert.match(await run('obs.setMediaInputCursor', agent, { input: 'Clip', cursor: 10 }), /seeked to 10ms/);
  assert.match(await run('obs.sendStreamCaption', agent, { text: 'Hello' }), /Stream caption sent/);
  assert.match(await run('obs.refreshBrowserSource', agent, { input: 'Web' }), /Web/);
  assert.match(await run('obs.setInputSettings', agent, { input: 'Title' }), /Title/);
  assert.equal(obs.calls.filter(c => c.method === 'SetCurrentSceneCollection').at(-1).params.sceneCollectionName, 'A');
});

test('mixer status uses 0% when the main fader is unknown and omits scene and firmware when the desk did not send them', async () => {
  const agent = {
    mixer: {
      async getStatus() {
        return { type: 'yamaha', model: 'TF5', online: true, mainFader: null, mainMuted: false, scene: null, firmware: '' };
      },
      async getChannelStatus() {
        return { fader: null, muted: true, name: '' };
      },
    },
  };
  const status = await run('mixer.status', agent, {});
  assert.match(status, /Yamaha TF5/);
  assert.match(status, /Main fader: ░░░░░░░░░░ 0%/);
  assert.doesNotMatch(status, /Scene:/);
  assert.doesNotMatch(status, /Firmware:/);
  const ch = await run('mixer.channelStatus', agent, { channel: 8 });
  assert.match(ch, /Channel 8/);
  assert.match(ch, /Muted/);
  assert.match(ch, /0%/);
  assert.doesNotMatch(ch, /Name:/);
});
