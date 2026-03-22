const test = require('node:test');
const assert = require('node:assert/strict');

const { commandHandlers } = require('../src/commands');

// Creates a mock OBS websocket that records all calls
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

// ─── Registration ─────────────────────────────────────────────────────────────

test('all OBS commands are registered', () => {
  const expected = [
    'obs.startStream', 'obs.stopStream', 'obs.startRecording', 'obs.stopRecording',
    'obs.pauseRecording', 'obs.resumeRecording', 'obs.setScene', 'obs.getScenes',
    'obs.getInputList', 'obs.setInputVolume', 'obs.setInputMute', 'obs.setTransition',
    'obs.setTransitionDuration', 'obs.getSourceFilters', 'obs.setSourceFilterEnabled',
    'obs.setStudioMode', 'obs.setPreviewScene', 'obs.toggleVirtualCam',
    'obs.getSceneItems', 'obs.setSceneItemEnabled', 'obs.configureMonitorStream',
    'obs.reduceBitrate',
  ];
  for (const name of expected) {
    assert.ok(commandHandlers[name], `${name} should be registered`);
  }
});

// ─── ensureObs guard ──────────────────────────────────────────────────────────

test('OBS commands throw when obs not present on agent', async () => {
  const agent = { status: {} };
  await assert.rejects(() => commandHandlers['obs.startStream'](agent, {}), /OBS not connected/);
});

test('OBS commands throw when obs.connected is false', async () => {
  const agent = { obs: {}, status: { obs: { connected: false } } };
  await assert.rejects(() => commandHandlers['obs.startStream'](agent, {}), /OBS not connected/);
});

// ─── Stream control ───────────────────────────────────────────────────────────

test('obs.startStream calls StartStream and returns confirmation', async () => {
  const { agent, obs } = obsAgent();
  const result = await commandHandlers['obs.startStream'](agent, {});
  assert.equal(result, 'Stream started');
  assert.equal(obs.calls[0].method, 'StartStream');
});

test('obs.stopStream calls StopStream and returns confirmation', async () => {
  const { agent, obs } = obsAgent();
  const result = await commandHandlers['obs.stopStream'](agent, {});
  assert.equal(result, 'Stream stopped');
  assert.equal(obs.calls[0].method, 'StopStream');
});

// ─── Recording control ────────────────────────────────────────────────────────

test('obs.startRecording calls StartRecord', async () => {
  const { agent, obs } = obsAgent();
  const result = await commandHandlers['obs.startRecording'](agent, {});
  assert.equal(result, 'OBS recording started');
  assert.equal(obs.calls[0].method, 'StartRecord');
});

test('obs.stopRecording calls StopRecord', async () => {
  const { agent, obs } = obsAgent();
  const result = await commandHandlers['obs.stopRecording'](agent, {});
  assert.equal(result, 'OBS recording stopped');
  assert.equal(obs.calls[0].method, 'StopRecord');
});

test('obs.pauseRecording calls PauseRecord', async () => {
  const { agent, obs } = obsAgent();
  const result = await commandHandlers['obs.pauseRecording'](agent, {});
  assert.equal(result, 'OBS recording paused');
  assert.equal(obs.calls[0].method, 'PauseRecord');
});

test('obs.resumeRecording calls ResumeRecord', async () => {
  const { agent, obs } = obsAgent();
  const result = await commandHandlers['obs.resumeRecording'](agent, {});
  assert.equal(result, 'OBS recording resumed');
  assert.equal(obs.calls[0].method, 'ResumeRecord');
});

// ─── Scene management ─────────────────────────────────────────────────────────

test('obs.setScene calls SetCurrentProgramScene with sceneName param', async () => {
  const { agent, obs } = obsAgent();
  const result = await commandHandlers['obs.setScene'](agent, { scene: 'Main Wide' });
  assert.equal(result, 'Scene set to: Main Wide');
  assert.equal(obs.calls[0].method, 'SetCurrentProgramScene');
  assert.equal(obs.calls[0].params.sceneName, 'Main Wide');
});

test('obs.getScenes reverses list and marks current in brackets', async () => {
  const { agent } = obsAgent({
    GetSceneList: {
      scenes: [{ sceneName: 'A' }, { sceneName: 'B' }, { sceneName: 'C' }],
      currentProgramSceneName: 'B',
    },
  });
  const result = await commandHandlers['obs.getScenes'](agent, {});
  assert.ok(result.includes('[B]'), 'current scene should be in brackets');
  // Reversed order: C, [B], A
  assert.ok(result.indexOf('C') < result.indexOf('B'), 'C should come before B after reverse');
  assert.ok(result.indexOf('B') < result.indexOf('A'), 'B should come before A after reverse');
});

test('obs.getScenes handles empty scene list', async () => {
  const { agent } = obsAgent({ GetSceneList: { scenes: [], currentProgramSceneName: '' } });
  const result = await commandHandlers['obs.getScenes'](agent, {});
  assert.ok(result.startsWith('Scenes:'));
});

test('obs.setPreviewScene requires scene name', async () => {
  const { agent } = obsAgent();
  await assert.rejects(() => commandHandlers['obs.setPreviewScene'](agent, {}), /scene name required/);
});

test('obs.setPreviewScene calls SetCurrentPreviewScene', async () => {
  const { agent, obs } = obsAgent();
  const result = await commandHandlers['obs.setPreviewScene'](agent, { scene: 'Preview Wide' });
  assert.equal(result, 'Preview scene set to: Preview Wide');
  assert.equal(obs.calls[0].method, 'SetCurrentPreviewScene');
  assert.equal(obs.calls[0].params.sceneName, 'Preview Wide');
});

test('obs.setStudioMode enables by default', async () => {
  const { agent, obs } = obsAgent();
  const result = await commandHandlers['obs.setStudioMode'](agent, {});
  assert.ok(result.includes('enabled'));
  assert.equal(obs.calls[0].params.studioModeEnabled, true);
});

test('obs.setStudioMode disables when enabled=false', async () => {
  const { agent, obs } = obsAgent();
  const result = await commandHandlers['obs.setStudioMode'](agent, { enabled: false });
  assert.ok(result.includes('disabled'));
  assert.equal(obs.calls[0].params.studioModeEnabled, false);
});

test('obs.toggleVirtualCam calls ToggleVirtualCam', async () => {
  const { agent, obs } = obsAgent();
  const result = await commandHandlers['obs.toggleVirtualCam'](agent, {});
  assert.equal(result, 'Virtual camera toggled');
  assert.equal(obs.calls[0].method, 'ToggleVirtualCam');
});

// ─── Input/source control ─────────────────────────────────────────────────────

test('obs.getInputList formats inputs with kind', async () => {
  const { agent } = obsAgent({
    GetInputList: { inputs: [{ inputName: 'Mic', inputKind: 'wasapi_input_capture' }] },
  });
  const result = await commandHandlers['obs.getInputList'](agent, {});
  assert.ok(result.includes('Mic'));
  assert.ok(result.includes('wasapi_input_capture'));
});

test('obs.getInputList returns "No inputs found" for empty list', async () => {
  const { agent } = obsAgent({ GetInputList: { inputs: [] } });
  const result = await commandHandlers['obs.getInputList'](agent, {});
  assert.equal(result, 'No inputs found');
});

test('obs.setInputVolume requires input name', async () => {
  const { agent } = obsAgent();
  await assert.rejects(() => commandHandlers['obs.setInputVolume'](agent, {}), /input name required/);
});

test('obs.setInputVolume uses volumeDb when provided', async () => {
  const { agent, obs } = obsAgent();
  const result = await commandHandlers['obs.setInputVolume'](agent, { input: 'Mic', volumeDb: -6 });
  assert.ok(result.includes('"Mic"'));
  assert.equal(obs.calls[0].params.inputVolumeDb, -6);
  assert.equal(obs.calls[0].params.inputVolumeMul, undefined);
});

test('obs.setInputVolume uses inputVolumeMul when volume provided', async () => {
  const { agent, obs } = obsAgent();
  await commandHandlers['obs.setInputVolume'](agent, { input: 'Mic', volume: 0.75 });
  assert.equal(obs.calls[0].params.inputVolumeMul, 0.75);
  assert.equal(obs.calls[0].params.inputVolumeDb, undefined);
});

test('obs.setInputVolume defaults to multiplier=1 when neither specified', async () => {
  const { agent, obs } = obsAgent();
  await commandHandlers['obs.setInputVolume'](agent, { name: 'Mic' });
  assert.equal(obs.calls[0].params.inputVolumeMul, 1);
});

test('obs.setInputMute requires input name', async () => {
  const { agent } = obsAgent();
  await assert.rejects(() => commandHandlers['obs.setInputMute'](agent, {}), /input name required/);
});

test('obs.setInputMute mutes by default', async () => {
  const { agent, obs } = obsAgent();
  const result = await commandHandlers['obs.setInputMute'](agent, { input: 'Mic' });
  assert.ok(result.includes('muted'));
  assert.equal(obs.calls[0].params.inputMuted, true);
});

test('obs.setInputMute unmutes when muted=false', async () => {
  const { agent, obs } = obsAgent();
  const result = await commandHandlers['obs.setInputMute'](agent, { input: 'Mic', muted: false });
  assert.ok(result.includes('unmuted'));
  assert.equal(obs.calls[0].params.inputMuted, false);
});

test('obs.setInputMute unmutes when muted="false" (string)', async () => {
  const { agent, obs } = obsAgent();
  const result = await commandHandlers['obs.setInputMute'](agent, { input: 'Mic', muted: 'false' });
  assert.ok(result.includes('unmuted'));
  assert.equal(obs.calls[0].params.inputMuted, false);
});

// ─── Transition control ───────────────────────────────────────────────────────

test('obs.setTransition requires transition name', async () => {
  const { agent } = obsAgent();
  await assert.rejects(() => commandHandlers['obs.setTransition'](agent, {}), /transition name required/);
});

test('obs.setTransition calls SetCurrentSceneTransition with name', async () => {
  const { agent, obs } = obsAgent();
  const result = await commandHandlers['obs.setTransition'](agent, { transition: 'Fade' });
  assert.equal(result, 'Transition set to: Fade');
  assert.equal(obs.calls[0].params.transitionName, 'Fade');
});

test('obs.setTransitionDuration throws on non-integer duration', async () => {
  const { agent } = obsAgent();
  await assert.rejects(
    () => commandHandlers['obs.setTransitionDuration'](agent, { duration: 'abc' }),
    /duration must be an integer/
  );
});

test('obs.setTransitionDuration sends correct duration in ms', async () => {
  const { agent, obs } = obsAgent();
  const result = await commandHandlers['obs.setTransitionDuration'](agent, { duration: 500 });
  assert.equal(result, 'Transition duration set to 500ms');
  assert.equal(obs.calls[0].params.transitionDuration, 500);
});

// ─── Source filters ───────────────────────────────────────────────────────────

test('obs.getSourceFilters requires source name', async () => {
  const { agent } = obsAgent();
  await assert.rejects(() => commandHandlers['obs.getSourceFilters'](agent, {}), /source name required/);
});

test('obs.getSourceFilters formats filter list with enabled/disabled markers', async () => {
  const { agent } = obsAgent({
    GetSourceFilterList: {
      filters: [
        { filterName: 'Color Correction', filterKind: 'color_filter_v2', filterEnabled: true },
        { filterName: 'Crop', filterKind: 'crop_filter', filterEnabled: false },
      ],
    },
  });
  const result = await commandHandlers['obs.getSourceFilters'](agent, { source: 'Camera' });
  assert.ok(result.includes('Color Correction'));
  assert.ok(result.includes('✓'));
  assert.ok(result.includes('Crop'));
  assert.ok(result.includes('✗'));
});

test('obs.getSourceFilters returns "No filters" for empty list', async () => {
  const { agent } = obsAgent({ GetSourceFilterList: { filters: [] } });
  const result = await commandHandlers['obs.getSourceFilters'](agent, { source: 'Camera' });
  assert.ok(result.includes('No filters on "Camera"'));
});

test('obs.setSourceFilterEnabled requires both source and filter', async () => {
  const { agent } = obsAgent();
  await assert.rejects(
    () => commandHandlers['obs.setSourceFilterEnabled'](agent, { source: 'Camera' }),
    /source and filter names required/
  );
  await assert.rejects(
    () => commandHandlers['obs.setSourceFilterEnabled'](agent, { filter: 'Blur' }),
    /source and filter names required/
  );
});

test('obs.setSourceFilterEnabled enables by default', async () => {
  const { agent, obs } = obsAgent();
  const result = await commandHandlers['obs.setSourceFilterEnabled'](agent, {
    source: 'Camera', filter: 'Blur',
  });
  assert.ok(result.includes('enabled'));
  assert.equal(obs.calls[0].params.filterEnabled, true);
});

test('obs.setSourceFilterEnabled disables when enabled=false', async () => {
  const { agent, obs } = obsAgent();
  const result = await commandHandlers['obs.setSourceFilterEnabled'](agent, {
    source: 'Camera', filter: 'Blur', enabled: false,
  });
  assert.ok(result.includes('disabled'));
  assert.equal(obs.calls[0].params.filterEnabled, false);
});

// ─── Scene items ──────────────────────────────────────────────────────────────

test('obs.getSceneItems requires scene name', async () => {
  const { agent } = obsAgent();
  await assert.rejects(() => commandHandlers['obs.getSceneItems'](agent, {}), /scene name required/);
});

test('obs.getSceneItems formats item list with visibility markers', async () => {
  const { agent } = obsAgent({
    GetSceneItemList: {
      sceneItems: [
        { sourceName: 'Camera', sceneItemEnabled: true },
        { sourceName: 'Logo', sceneItemEnabled: false },
      ],
    },
  });
  const result = await commandHandlers['obs.getSceneItems'](agent, { scene: 'Main' });
  assert.ok(result.includes('Camera'));
  assert.ok(result.includes('✓'));
  assert.ok(result.includes('Logo'));
  assert.ok(result.includes('✗'));
});

test('obs.getSceneItems returns "No items" for empty scene', async () => {
  const { agent } = obsAgent({ GetSceneItemList: { sceneItems: [] } });
  const result = await commandHandlers['obs.getSceneItems'](agent, { scene: 'Empty' });
  assert.ok(result.includes('No items in "Empty"'));
});

test('obs.setSceneItemEnabled requires scene name', async () => {
  const { agent } = obsAgent();
  await assert.rejects(() => commandHandlers['obs.setSceneItemEnabled'](agent, {}), /scene name required/);
});

test('obs.setSceneItemEnabled requires integer itemId', async () => {
  const { agent } = obsAgent();
  await assert.rejects(
    () => commandHandlers['obs.setSceneItemEnabled'](agent, { scene: 'Main', itemId: 'abc' }),
    /itemId must be an integer/
  );
});

test('obs.setSceneItemEnabled sends correct websocket params', async () => {
  const { agent, obs } = obsAgent();
  const result = await commandHandlers['obs.setSceneItemEnabled'](agent, {
    scene: 'Main', itemId: 3, enabled: false,
  });
  assert.ok(result.includes('hidden'));
  assert.equal(obs.calls[0].params.sceneName, 'Main');
  assert.equal(obs.calls[0].params.sceneItemId, 3);
  assert.equal(obs.calls[0].params.sceneItemEnabled, false);
});

test('obs.setSceneItemEnabled shows "visible" when enabled=true', async () => {
  const { agent } = obsAgent();
  const result = await commandHandlers['obs.setSceneItemEnabled'](agent, {
    scene: 'Main', itemId: 1, enabled: true,
  });
  assert.ok(result.includes('visible'));
});

// ─── configureMonitorStream ───────────────────────────────────────────────────

test('obs.configureMonitorStream requires relayUrl', async () => {
  const { agent } = obsAgent();
  await assert.rejects(
    () => commandHandlers['obs.configureMonitorStream'](agent, { streamKey: 'abc' }),
    /relayUrl is required/
  );
});

test('obs.configureMonitorStream requires streamKey', async () => {
  const { agent } = obsAgent();
  await assert.rejects(
    () => commandHandlers['obs.configureMonitorStream'](agent, {
      relayUrl: 'rtmp://relay.example.com/live',
    }),
    /streamKey is required/
  );
});

test('obs.configureMonitorStream strips trailing slash from relayUrl', async () => {
  const { agent, obs } = obsAgent();
  await commandHandlers['obs.configureMonitorStream'](agent, {
    relayUrl: 'rtmp://relay.example.com/live/',
    streamKey: 'abc123',
  });
  const serviceSettings = obs.calls[0].params.streamServiceSettings;
  assert.equal(serviceSettings.server, 'rtmp://relay.example.com/live');
});

test('obs.configureMonitorStream sends rtmp_custom service type with correct fields', async () => {
  const { agent, obs } = obsAgent();
  const result = await commandHandlers['obs.configureMonitorStream'](agent, {
    relayUrl: 'rtmp://relay.example.com/live',
    streamKey: 'mykey',
    bitrate: 5000,
  });
  assert.equal(obs.calls[0].method, 'SetStreamServiceSettings');
  assert.equal(obs.calls[0].params.streamServiceType, 'rtmp_custom');
  assert.equal(obs.calls[0].params.streamServiceSettings.key, 'mykey');
  assert.equal(obs.calls[0].params.streamServiceSettings.bitsPerSecond, 5000000);
  assert.ok(result.includes('5000kbps'));
});

test('obs.configureMonitorStream with startStream=true starts stream when not already streaming', async () => {
  const { agent, obs } = obsAgent({ GetStreamStatus: { outputActive: false } });
  const result = await commandHandlers['obs.configureMonitorStream'](agent, {
    relayUrl: 'rtmp://relay.example.com/live',
    streamKey: 'key',
    startStream: true,
  });
  const methods = obs.calls.map(c => c.method);
  assert.ok(methods.includes('GetStreamStatus'));
  assert.ok(methods.includes('StartStream'));
  assert.ok(result.includes('stream started'));
});

test('obs.configureMonitorStream with startStream=true does not restart when already streaming', async () => {
  const { agent, obs } = obsAgent({ GetStreamStatus: { outputActive: true } });
  const result = await commandHandlers['obs.configureMonitorStream'](agent, {
    relayUrl: 'rtmp://relay.example.com/live',
    streamKey: 'key',
    startStream: true,
  });
  const methods = obs.calls.map(c => c.method);
  assert.ok(!methods.includes('StartStream'), 'should not call StartStream when already active');
  assert.ok(result.includes('already streaming'));
});

test('obs.configureMonitorStream starts stream when GetStreamStatus is unavailable', async () => {
  const { agent, obs } = obsAgent({ GetStreamStatus: new Error('not supported') });
  const result = await commandHandlers['obs.configureMonitorStream'](agent, {
    relayUrl: 'rtmp://relay.example.com/live',
    streamKey: 'key',
    startStream: true,
  });
  const methods = obs.calls.map(c => c.method);
  assert.ok(methods.includes('StartStream'), 'should start stream when status unavailable');
});

// ─── reduceBitrate ────────────────────────────────────────────────────────────

test('obs.reduceBitrate reduces bitsPerSecond by 20% by default', async () => {
  const { agent, obs } = obsAgent({
    GetStreamServiceSettings: {
      streamServiceType: 'rtmp_common',
      streamServiceSettings: { bitsPerSecond: 5000000 },
    },
  });
  const result = await commandHandlers['obs.reduceBitrate'](agent, {});
  assert.ok(result.includes('5000000 → 4000000'));
  const setCall = obs.calls.find(c => c.method === 'SetStreamServiceSettings');
  assert.ok(setCall);
  assert.equal(setCall.params.streamServiceSettings.bitsPerSecond, 4000000);
});

test('obs.reduceBitrate respects custom reductionPercent', async () => {
  const { agent } = obsAgent({
    GetStreamServiceSettings: {
      streamServiceType: 'rtmp_common',
      streamServiceSettings: { bitsPerSecond: 4000000 },
    },
  });
  const result = await commandHandlers['obs.reduceBitrate'](agent, { reductionPercent: 50 });
  assert.ok(result.includes('50%'));
  assert.ok(result.includes('→ 2000000'));
});

test('obs.reduceBitrate updates string bitrate key when bitsPerSecond absent', async () => {
  const { agent, obs } = obsAgent({
    GetStreamServiceSettings: {
      streamServiceType: 'rtmp_custom',
      streamServiceSettings: { bitrate: '3000' },
    },
  });
  const result = await commandHandlers['obs.reduceBitrate'](agent, {});
  assert.ok(result.includes('3000 → 2400'));
  const setCall = obs.calls.find(c => c.method === 'SetStreamServiceSettings');
  assert.equal(setCall.params.streamServiceSettings.bitrate, '2400');
});

test('obs.reduceBitrate preserves other service settings', async () => {
  const { agent, obs } = obsAgent({
    GetStreamServiceSettings: {
      streamServiceType: 'rtmp_custom',
      streamServiceSettings: { server: 'rtmp://relay/live', key: 'mykey', bitsPerSecond: 4000000 },
    },
  });
  await commandHandlers['obs.reduceBitrate'](agent, {});
  const setCall = obs.calls.find(c => c.method === 'SetStreamServiceSettings');
  assert.equal(setCall.params.streamServiceSettings.server, 'rtmp://relay/live');
  assert.equal(setCall.params.streamServiceSettings.key, 'mykey');
});
