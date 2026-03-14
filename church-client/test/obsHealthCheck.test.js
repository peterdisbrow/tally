const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkOBSSources,
  getSourceList,
  getAudioInputs,
  validateSceneCollection,
  OBSHealthChecker,
} = require('../src/obsHealthCheck');

// ─── Mock OBS Connection ────────────────────────────────────────────────────

function createMockOBS(options = {}) {
  const {
    scenes = [
      { sceneName: 'Program', sceneIndex: 0 },
      { sceneName: 'IMAG', sceneIndex: 1 },
      { sceneName: 'Slides', sceneIndex: 2 },
    ],
    currentScene = 'Program',
    sceneItems = {
      Program: [
        { sourceName: 'Camera 1', sceneItemEnabled: true, inputKind: 'v4l2_input', sceneItemId: 1 },
        { sourceName: 'Camera 2', sceneItemEnabled: true, inputKind: 'v4l2_input', sceneItemId: 2 },
        { sourceName: 'Lower Third', sceneItemEnabled: false, inputKind: 'text_gdiplus', sceneItemId: 3 },
      ],
      IMAG: [
        { sourceName: 'NDI Feed', sceneItemEnabled: true, inputKind: 'obs_ndi_source', sceneItemId: 4 },
      ],
      Slides: [
        { sourceName: 'ProPresenter', sceneItemEnabled: true, inputKind: 'window_capture', sceneItemId: 5 },
      ],
    },
    inputs = [
      { inputName: 'Mic/Aux', inputKind: 'wasapi_input_capture' },
      { inputName: 'Desktop Audio', inputKind: 'wasapi_output_capture' },
    ],
    inputMuteState = {
      'Mic/Aux': false,
      'Desktop Audio': false,
    },
  } = options;

  return {
    async call(method, payload = {}) {
      switch (method) {
        case 'GetSceneList':
          return {
            currentProgramSceneName: currentScene,
            scenes: scenes,
          };
        case 'GetSceneItemList': {
          const items = sceneItems[payload.sceneName];
          if (!items) throw new Error(`Scene not found: ${payload.sceneName}`);
          return { sceneItems: items };
        }
        case 'GetInputList':
          return { inputs: inputs };
        case 'GetInputMute': {
          const name = payload.inputName;
          if (!(name in inputMuteState)) throw new Error(`Input not found: ${name}`);
          return { inputMuted: inputMuteState[name] };
        }
        default:
          throw new Error(`Mock OBS does not implement: ${method}`);
      }
    },
  };
}

// ─── getSourceList ──────────────────────────────────────────────────────────

test('getSourceList returns all sources across all scenes', async () => {
  const obs = createMockOBS();
  const sources = await getSourceList(obs);

  assert.ok(Array.isArray(sources), 'should return an array');
  assert.equal(sources.length, 5, 'should have 5 sources total across 3 scenes');

  const cam1 = sources.find(s => s.sourceName === 'Camera 1');
  assert.ok(cam1, 'Camera 1 should be present');
  assert.equal(cam1.scene, 'Program');
  assert.equal(cam1.enabled, true);
  assert.equal(cam1.sourceKind, 'v4l2_input');
  assert.equal(cam1.sceneItemId, 1);

  const lowerThird = sources.find(s => s.sourceName === 'Lower Third');
  assert.ok(lowerThird, 'Lower Third should be present');
  assert.equal(lowerThird.enabled, false);
});

test('getSourceList returns empty array when no scenes exist', async () => {
  const obs = createMockOBS({ scenes: [], sceneItems: {} });
  const sources = await getSourceList(obs);
  assert.deepEqual(sources, []);
});

test('getSourceList handles scene item list errors gracefully', async () => {
  const obs = createMockOBS({
    scenes: [{ sceneName: 'Broken', sceneIndex: 0 }],
    sceneItems: {},
  });
  const sources = await getSourceList(obs);
  assert.deepEqual(sources, [], 'should return empty array when scene item listing fails');
});

// ─── getAudioInputs ─────────────────────────────────────────────────────────

test('getAudioInputs returns all inputs with mute state', async () => {
  const obs = createMockOBS({
    inputMuteState: { 'Mic/Aux': true, 'Desktop Audio': false },
  });
  const inputs = await getAudioInputs(obs);

  assert.equal(inputs.length, 2);
  const mic = inputs.find(i => i.inputName === 'Mic/Aux');
  assert.ok(mic, 'Mic/Aux should be present');
  assert.equal(mic.muted, true);
  assert.equal(mic.inputKind, 'wasapi_input_capture');

  const desktop = inputs.find(i => i.inputName === 'Desktop Audio');
  assert.ok(desktop);
  assert.equal(desktop.muted, false);
});

test('getAudioInputs returns empty array when GetInputList not available', async () => {
  const obs = {
    async call(method) {
      throw new Error('Not implemented');
    },
  };
  const inputs = await getAudioInputs(obs);
  assert.deepEqual(inputs, []);
});

// ─── checkOBSSources — healthy scenario ─────────────────────────────────────

test('checkOBSSources reports healthy when all expected sources present and active', async () => {
  const obs = createMockOBS();
  const config = {
    expectedSources: [
      { name: 'Camera 1', scene: 'Program', critical: true },
      { name: 'NDI Feed', scene: 'IMAG', critical: false },
    ],
    expectedAudioInputs: [
      { name: 'Mic/Aux', shouldBeUnmuted: true },
    ],
  };

  const result = await checkOBSSources(obs, config);
  assert.equal(result.healthy, true, 'should be healthy');
  assert.deepEqual(result.issues, [], 'should have no issues');
});

// ─── checkOBSSources — missing source ───────────────────────────────────────

test('checkOBSSources detects missing source', async () => {
  const obs = createMockOBS();
  const config = {
    expectedSources: [
      { name: 'NonExistent Source', scene: 'Program', critical: true },
    ],
    expectedAudioInputs: [],
  };

  const result = await checkOBSSources(obs, config);
  assert.equal(result.healthy, false);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].type, 'obs_source_missing');
  assert.equal(result.issues[0].source, 'NonExistent Source');
  assert.equal(result.issues[0].scene, 'Program');
});

test('checkOBSSources detects source missing from specific scene', async () => {
  const obs = createMockOBS();
  const config = {
    expectedSources: [
      { name: 'Camera 1', scene: 'IMAG', critical: true },
    ],
    expectedAudioInputs: [],
  };

  const result = await checkOBSSources(obs, config);
  assert.equal(result.healthy, false);
  assert.equal(result.issues[0].type, 'obs_source_missing');
  assert.ok(result.issues[0].details.includes('IMAG'));
});

// ─── checkOBSSources — disabled source ──────────────────────────────────────

test('checkOBSSources detects disabled source', async () => {
  const obs = createMockOBS();
  const config = {
    expectedSources: [
      { name: 'Lower Third', scene: 'Program', critical: true },
    ],
    expectedAudioInputs: [],
  };

  const result = await checkOBSSources(obs, config);
  assert.equal(result.healthy, false);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].type, 'obs_source_disabled');
  assert.equal(result.issues[0].source, 'Lower Third');
  assert.ok(result.issues[0].details.includes('not visible'));
});

// ─── checkOBSSources — muted audio ──────────────────────────────────────────

test('checkOBSSources detects unexpectedly muted audio input', async () => {
  const obs = createMockOBS({
    inputMuteState: { 'Mic/Aux': true, 'Desktop Audio': false },
  });
  const config = {
    expectedSources: [],
    expectedAudioInputs: [
      { name: 'Mic/Aux', shouldBeUnmuted: true },
      { name: 'Desktop Audio', shouldBeUnmuted: false },
    ],
  };

  const result = await checkOBSSources(obs, config);
  assert.equal(result.healthy, false);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].type, 'obs_audio_muted');
  assert.equal(result.issues[0].source, 'Mic/Aux');
});

test('checkOBSSources ignores muted audio when shouldBeUnmuted is false', async () => {
  const obs = createMockOBS({
    inputMuteState: { 'Mic/Aux': true, 'Desktop Audio': true },
  });
  const config = {
    expectedSources: [],
    expectedAudioInputs: [
      { name: 'Mic/Aux', shouldBeUnmuted: false },
      { name: 'Desktop Audio', shouldBeUnmuted: false },
    ],
  };

  const result = await checkOBSSources(obs, config);
  assert.equal(result.healthy, true);
  assert.deepEqual(result.issues, []);
});

// ─── checkOBSSources — multiple issues ──────────────────────────────────────

test('checkOBSSources reports multiple issues at once', async () => {
  const obs = createMockOBS({
    inputMuteState: { 'Mic/Aux': true, 'Desktop Audio': false },
  });
  const config = {
    expectedSources: [
      { name: 'Missing Camera', scene: 'Program', critical: true },
      { name: 'Lower Third', scene: 'Program', critical: false },
    ],
    expectedAudioInputs: [
      { name: 'Mic/Aux', shouldBeUnmuted: true },
    ],
  };

  const result = await checkOBSSources(obs, config);
  assert.equal(result.healthy, false);
  assert.equal(result.issues.length, 3);

  const types = result.issues.map(i => i.type).sort();
  assert.deepEqual(types, ['obs_audio_muted', 'obs_source_disabled', 'obs_source_missing']);
});

// ─── checkOBSSources — no config ────────────────────────────────────────────

test('checkOBSSources reports healthy when no expected config provided', async () => {
  const obs = createMockOBS();
  const result = await checkOBSSources(obs);
  assert.equal(result.healthy, true);
  assert.deepEqual(result.issues, []);
});

// ─── checkOBSSources — source without scene constraint ──────────────────────

test('checkOBSSources finds source in any scene when no scene specified', async () => {
  const obs = createMockOBS();
  const config = {
    expectedSources: [
      { name: 'Camera 1', critical: true },
    ],
    expectedAudioInputs: [],
  };

  const result = await checkOBSSources(obs, config);
  assert.equal(result.healthy, true, 'Camera 1 should be found in any scene');
});

// ─── validateSceneCollection ────────────────────────────────────────────────

test('validateSceneCollection reports valid when all expected scenes present', async () => {
  const obs = createMockOBS();
  const result = await validateSceneCollection(obs, ['Program', 'IMAG', 'Slides']);

  assert.equal(result.valid, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.extra, []);
  assert.equal(result.current, 'Program');
});

test('validateSceneCollection detects missing scenes', async () => {
  const obs = createMockOBS();
  const result = await validateSceneCollection(obs, ['Program', 'IMAG', 'Slides', 'PreService']);

  assert.equal(result.valid, false);
  assert.deepEqual(result.missing, ['PreService']);
});

test('validateSceneCollection reports extra scenes', async () => {
  const obs = createMockOBS();
  const result = await validateSceneCollection(obs, ['Program']);

  assert.equal(result.valid, true, 'extra scenes should not make it invalid');
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.extra, ['IMAG', 'Slides']);
});

test('validateSceneCollection handles empty expected list', async () => {
  const obs = createMockOBS();
  const result = await validateSceneCollection(obs, []);

  assert.equal(result.valid, true);
  assert.deepEqual(result.missing, []);
  assert.equal(result.extra.length, 3);
});

// ─── Event emission ─────────────────────────────────────────────────────────

test('checkOBSSources emits obs_source_missing event', async () => {
  const obs = createMockOBS();
  const { EventEmitter } = require('events');
  const emitter = new EventEmitter();

  const events = [];
  emitter.on('obs_source_missing', (e) => events.push(e));

  const config = {
    expectedSources: [{ name: 'Ghost Source', scene: 'Program' }],
    expectedAudioInputs: [],
  };

  await checkOBSSources(obs, config, emitter);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'obs_source_missing');
  assert.equal(events[0].source, 'Ghost Source');
});

test('checkOBSSources emits obs_source_disabled event', async () => {
  const obs = createMockOBS();
  const { EventEmitter } = require('events');
  const emitter = new EventEmitter();

  const events = [];
  emitter.on('obs_source_disabled', (e) => events.push(e));

  const config = {
    expectedSources: [{ name: 'Lower Third', scene: 'Program' }],
    expectedAudioInputs: [],
  };

  await checkOBSSources(obs, config, emitter);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'obs_source_disabled');
});

test('checkOBSSources emits obs_audio_muted event', async () => {
  const obs = createMockOBS({
    inputMuteState: { 'Mic/Aux': true, 'Desktop Audio': false },
  });
  const { EventEmitter } = require('events');
  const emitter = new EventEmitter();

  const events = [];
  emitter.on('obs_audio_muted', (e) => events.push(e));

  const config = {
    expectedSources: [],
    expectedAudioInputs: [{ name: 'Mic/Aux', shouldBeUnmuted: true }],
  };

  await checkOBSSources(obs, config, emitter);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'obs_audio_muted');
  assert.equal(events[0].source, 'Mic/Aux');
});

test('no events emitted when everything is healthy', async () => {
  const obs = createMockOBS();
  const { EventEmitter } = require('events');
  const emitter = new EventEmitter();

  const events = [];
  emitter.on('obs_source_missing', (e) => events.push(e));
  emitter.on('obs_source_disabled', (e) => events.push(e));
  emitter.on('obs_audio_muted', (e) => events.push(e));

  const config = {
    expectedSources: [{ name: 'Camera 1', scene: 'Program' }],
    expectedAudioInputs: [{ name: 'Mic/Aux', shouldBeUnmuted: true }],
  };

  await checkOBSSources(obs, config, emitter);
  assert.equal(events.length, 0, 'no events should be emitted when healthy');
});

// ─── OBSHealthChecker class ─────────────────────────────────────────────────

test('OBSHealthChecker.check() runs full health check with event emission', async () => {
  const obs = createMockOBS({
    inputMuteState: { 'Mic/Aux': true, 'Desktop Audio': false },
  });

  const checker = new OBSHealthChecker(obs, {
    expectedSources: [
      { name: 'Camera 1', scene: 'Program' },
      { name: 'Missing Source', scene: 'Program' },
    ],
    expectedAudioInputs: [
      { name: 'Mic/Aux', shouldBeUnmuted: true },
    ],
  });

  const events = [];
  checker.on('obs_source_missing', (e) => events.push(e));
  checker.on('obs_audio_muted', (e) => events.push(e));

  const result = await checker.check();
  assert.equal(result.healthy, false);
  assert.equal(result.issues.length, 2);
  assert.equal(events.length, 2);
});

test('OBSHealthChecker.getSources() returns source list', async () => {
  const obs = createMockOBS();
  const checker = new OBSHealthChecker(obs);
  const sources = await checker.getSources();
  assert.equal(sources.length, 5);
});

test('OBSHealthChecker.getAudioInputs() returns audio inputs', async () => {
  const obs = createMockOBS();
  const checker = new OBSHealthChecker(obs);
  const inputs = await checker.getAudioInputs();
  assert.equal(inputs.length, 2);
});

test('OBSHealthChecker.validateScenes() delegates to validateSceneCollection', async () => {
  const obs = createMockOBS();
  const checker = new OBSHealthChecker(obs);
  const result = await checker.validateScenes(['Program', 'IMAG', 'Slides']);
  assert.equal(result.valid, true);
  assert.deepEqual(result.missing, []);
});

// ─── NEW: Error handling when OBS WebSocket calls throw ─────────────────────

test('getSourceList handles GetSceneList throwing', async () => {
  const obs = {
    async call(method) {
      if (method === 'GetSceneList') throw new Error('Connection lost');
      throw new Error('unexpected');
    },
  };
  // getSourceList does NOT catch GetSceneList errors — it should propagate
  await assert.rejects(() => getSourceList(obs), { message: 'Connection lost' });
});

test('getAudioInputs handles GetInputMute throwing for specific input', async () => {
  const obs = {
    async call(method, payload) {
      if (method === 'GetInputList') {
        return {
          inputs: [
            { inputName: 'Mic', inputKind: 'wasapi_input_capture' },
            { inputName: 'BadInput', inputKind: 'unknown' },
          ],
        };
      }
      if (method === 'GetInputMute') {
        if (payload.inputName === 'BadInput') throw new Error('Mute query failed');
        return { inputMuted: false };
      }
      throw new Error('unexpected');
    },
  };
  const inputs = await getAudioInputs(obs);
  assert.equal(inputs.length, 2);
  // BadInput should default to not muted
  const bad = inputs.find(i => i.inputName === 'BadInput');
  assert.equal(bad.muted, false);
});

test('checkOBSSources handles getSourceList failure (propagates error)', async () => {
  const obs = {
    async call(method) {
      if (method === 'GetSceneList') throw new Error('OBS disconnected');
      throw new Error('unexpected');
    },
  };
  await assert.rejects(() => checkOBSSources(obs, { expectedSources: [], expectedAudioInputs: [] }), {
    message: 'OBS disconnected',
  });
});

test('validateSceneCollection handles GetSceneList failure', async () => {
  const obs = {
    async call() { throw new Error('timeout'); },
  };
  await assert.rejects(() => validateSceneCollection(obs, ['Program']), { message: 'timeout' });
});

// ─── NEW: Large scene counts (10+ scenes) ──────────────────────────────────

test('getSourceList handles 10+ scenes correctly', async () => {
  const scenes = [];
  const sceneItems = {};
  for (let i = 0; i < 12; i++) {
    const name = `Scene ${i}`;
    scenes.push({ sceneName: name, sceneIndex: i });
    sceneItems[name] = [
      { sourceName: `Source_${i}_a`, sceneItemEnabled: true, inputKind: 'v4l2_input', sceneItemId: i * 2 },
      { sourceName: `Source_${i}_b`, sceneItemEnabled: i % 2 === 0, inputKind: 'text_gdiplus', sceneItemId: i * 2 + 1 },
    ];
  }

  const obs = createMockOBS({ scenes, sceneItems });
  const sources = await getSourceList(obs);
  assert.equal(sources.length, 24, 'should have 2 sources per scene * 12 scenes');

  // Check that scenes are correctly associated
  const scene5Sources = sources.filter(s => s.scene === 'Scene 5');
  assert.equal(scene5Sources.length, 2);
  assert.equal(scene5Sources[0].sourceName, 'Source_5_a');
});

test('checkOBSSources with 10+ scenes still finds expected sources', async () => {
  const scenes = [];
  const sceneItems = {};
  for (let i = 0; i < 12; i++) {
    const name = `Scene ${i}`;
    scenes.push({ sceneName: name, sceneIndex: i });
    sceneItems[name] = [
      { sourceName: `Camera ${i}`, sceneItemEnabled: true, inputKind: 'v4l2_input', sceneItemId: i },
    ];
  }

  const obs = createMockOBS({ scenes, sceneItems, inputs: [], inputMuteState: {} });
  const config = {
    expectedSources: [
      { name: 'Camera 0', scene: 'Scene 0' },
      { name: 'Camera 11', scene: 'Scene 11' },
    ],
    expectedAudioInputs: [],
  };

  const result = await checkOBSSources(obs, config);
  assert.equal(result.healthy, true);
  assert.deepEqual(result.issues, []);
});

// ─── NEW: Source that exists in multiple scenes ─────────────────────────────

test('source present in multiple scenes is found when no scene specified', async () => {
  const obs = createMockOBS({
    scenes: [
      { sceneName: 'Program', sceneIndex: 0 },
      { sceneName: 'Preview', sceneIndex: 1 },
    ],
    sceneItems: {
      Program: [
        { sourceName: 'Shared Camera', sceneItemEnabled: true, inputKind: 'v4l2_input', sceneItemId: 1 },
      ],
      Preview: [
        { sourceName: 'Shared Camera', sceneItemEnabled: true, inputKind: 'v4l2_input', sceneItemId: 2 },
      ],
    },
  });

  const sources = await getSourceList(obs);
  const shared = sources.filter(s => s.sourceName === 'Shared Camera');
  assert.equal(shared.length, 2, 'same source should appear in both scenes');
  assert.equal(shared[0].scene, 'Program');
  assert.equal(shared[1].scene, 'Preview');

  // Check that it's healthy when expected without a scene constraint
  const config = {
    expectedSources: [{ name: 'Shared Camera', critical: true }],
    expectedAudioInputs: [],
  };
  const result = await checkOBSSources(obs, config);
  assert.equal(result.healthy, true);
});

test('source in multiple scenes: disabled in one, enabled in another is healthy', async () => {
  const obs = createMockOBS({
    scenes: [
      { sceneName: 'Main', sceneIndex: 0 },
      { sceneName: 'Alt', sceneIndex: 1 },
    ],
    sceneItems: {
      Main: [
        { sourceName: 'Camera', sceneItemEnabled: false, inputKind: 'v4l2_input', sceneItemId: 1 },
      ],
      Alt: [
        { sourceName: 'Camera', sceneItemEnabled: true, inputKind: 'v4l2_input', sceneItemId: 2 },
      ],
    },
  });

  // Without scene constraint — should be healthy because at least one copy is enabled
  const config = {
    expectedSources: [{ name: 'Camera', critical: true }],
    expectedAudioInputs: [],
  };
  const result = await checkOBSSources(obs, config);
  assert.equal(result.healthy, true, 'should be healthy when source is enabled in at least one scene');
});

test('source in multiple scenes: disabled in all scenes is unhealthy', async () => {
  const obs = createMockOBS({
    scenes: [
      { sceneName: 'Main', sceneIndex: 0 },
      { sceneName: 'Alt', sceneIndex: 1 },
    ],
    sceneItems: {
      Main: [
        { sourceName: 'Camera', sceneItemEnabled: false, inputKind: 'v4l2_input', sceneItemId: 1 },
      ],
      Alt: [
        { sourceName: 'Camera', sceneItemEnabled: false, inputKind: 'v4l2_input', sceneItemId: 2 },
      ],
    },
  });

  const config = {
    expectedSources: [{ name: 'Camera', critical: true }],
    expectedAudioInputs: [],
  };
  const result = await checkOBSSources(obs, config);
  assert.equal(result.healthy, false, 'should be unhealthy when source is disabled in all scenes');
  assert.equal(result.issues[0].type, 'obs_source_disabled');
});

// ─── NEW: OBSHealthChecker default config ───────────────────────────────────

test('OBSHealthChecker with no config reports healthy', async () => {
  const obs = createMockOBS();
  const checker = new OBSHealthChecker(obs);
  const result = await checker.check();
  assert.equal(result.healthy, true);
});

// ─── NEW: sourceType fallback for sourceKind ────────────────────────────────

test('getSourceList uses sourceType when inputKind is not present', async () => {
  const obs = createMockOBS({
    scenes: [{ sceneName: 'Main', sceneIndex: 0 }],
    sceneItems: {
      Main: [
        { sourceName: 'Legacy Source', sceneItemEnabled: true, sourceType: 'ffmpeg_source', sceneItemId: 10 },
      ],
    },
  });

  const sources = await getSourceList(obs);
  assert.equal(sources[0].sourceKind, 'ffmpeg_source');
});

test('getSourceList defaults to unknown when no kind info present', async () => {
  const obs = createMockOBS({
    scenes: [{ sceneName: 'Main', sceneIndex: 0 }],
    sceneItems: {
      Main: [
        { sourceName: 'Mystery Source', sceneItemEnabled: true, sceneItemId: 11 },
      ],
    },
  });

  const sources = await getSourceList(obs);
  assert.equal(sources[0].sourceKind, 'unknown');
});
