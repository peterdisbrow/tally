/**
 * OBS Source/Scene Health Check
 *
 * Verifies that expected OBS sources are present, active, and correctly
 * configured by querying the OBS WebSocket connection and comparing
 * against the church's expected source configuration.
 *
 * Emits events through the agent relay:
 *   obs_source_missing  — a critical source defined in config is not found in OBS
 *   obs_source_disabled — a source exists but is not visible/enabled
 *   obs_audio_muted     — an audio source is muted when config expects it unmuted
 */

const { EventEmitter } = require('events');

/**
 * Query OBS for all sources across all scenes with their current state.
 *
 * @param {object} obsConnection - OBS WebSocket connection (obs-websocket-js instance or FakeOBS)
 * @returns {Promise<Array<{ sourceName: string, scene: string, enabled: boolean, sourceKind: string, sceneItemId: number }>>}
 */
async function getSourceList(obsConnection) {
  const sceneData = await obsConnection.call('GetSceneList');
  const scenes = sceneData.scenes || [];
  const sources = [];

  for (const scene of scenes) {
    const sceneName = scene.sceneName;
    try {
      const itemData = await obsConnection.call('GetSceneItemList', { sceneName });
      const items = itemData.sceneItems || [];
      for (const item of items) {
        sources.push({
          sourceName: item.sourceName,
          scene: sceneName,
          enabled: !!item.sceneItemEnabled,
          sourceKind: item.inputKind || item.sourceType || 'unknown',
          sceneItemId: item.sceneItemId,
        });
      }
    } catch {
      // Scene may not support item listing (e.g. special scenes); skip
    }
  }

  return sources;
}

/**
 * Query OBS for all audio inputs and their mute state.
 *
 * @param {object} obsConnection - OBS WebSocket connection
 * @returns {Promise<Array<{ inputName: string, inputKind: string, muted: boolean }>>}
 */
async function getAudioInputs(obsConnection) {
  const inputs = [];
  try {
    const inputData = await obsConnection.call('GetInputList');
    for (const input of (inputData.inputs || [])) {
      let muted = false;
      try {
        const muteData = await obsConnection.call('GetInputMute', { inputName: input.inputName });
        muted = !!muteData.inputMuted;
      } catch {
        // Input may not support mute queries; treat as not muted
      }
      inputs.push({
        inputName: input.inputName,
        inputKind: input.inputKind || 'unknown',
        muted,
      });
    }
  } catch {
    // GetInputList not available; return empty
  }
  return inputs;
}

/**
 * Check OBS sources against expected configuration.
 *
 * Expected config format:
 *   {
 *     expectedSources: [
 *       { name: 'Camera 1', scene: 'Program', critical: true },
 *       { name: 'NDI Feed', scene: 'IMAG', critical: false },
 *     ],
 *     expectedAudioInputs: [
 *       { name: 'Mic/Aux', shouldBeUnmuted: true },
 *       { name: 'Desktop Audio', shouldBeUnmuted: false },
 *     ]
 *   }
 *
 * @param {object} obsConnection - OBS WebSocket connection
 * @param {object} [expectedConfig] - Expected source configuration
 * @param {EventEmitter} [emitter] - Optional event emitter for issue events
 * @returns {Promise<{ healthy: boolean, issues: Array<{ type: string, source: string, scene: string, details: string }> }>}
 */
async function checkOBSSources(obsConnection, expectedConfig, emitter) {
  const issues = [];
  const expectedSources = (expectedConfig && expectedConfig.expectedSources) || [];
  const expectedAudioInputs = (expectedConfig && expectedConfig.expectedAudioInputs) || [];

  // Gather current state from OBS
  const currentSources = await getSourceList(obsConnection);
  const currentAudioInputs = await getAudioInputs(obsConnection);

  // Check expected sources
  for (const expected of expectedSources) {
    const matching = currentSources.filter(s => s.sourceName === expected.name);

    // If scene is specified, narrow down
    const sceneMatches = expected.scene
      ? matching.filter(s => s.scene === expected.scene)
      : matching;

    if (sceneMatches.length === 0) {
      const issue = {
        type: 'obs_source_missing',
        source: expected.name,
        scene: expected.scene || '*',
        details: `Expected source "${expected.name}" not found${expected.scene ? ` in scene "${expected.scene}"` : ''}`,
      };
      issues.push(issue);
      if (emitter) emitter.emit('obs_source_missing', issue);
    } else {
      // Check if any matching source is disabled
      const allDisabled = sceneMatches.every(s => !s.enabled);
      if (allDisabled) {
        const issue = {
          type: 'obs_source_disabled',
          source: expected.name,
          scene: expected.scene || sceneMatches[0].scene,
          details: `Source "${expected.name}" exists but is not visible/active`,
        };
        issues.push(issue);
        if (emitter) emitter.emit('obs_source_disabled', issue);
      }
    }
  }

  // Check expected audio inputs
  for (const expected of expectedAudioInputs) {
    if (!expected.shouldBeUnmuted) continue; // Only flag if config says it should be unmuted

    const input = currentAudioInputs.find(i => i.inputName === expected.name);
    if (input && input.muted) {
      const issue = {
        type: 'obs_audio_muted',
        source: expected.name,
        scene: '*',
        details: `Audio input "${expected.name}" is muted but should be unmuted`,
      };
      issues.push(issue);
      if (emitter) emitter.emit('obs_audio_muted', issue);
    }
  }

  return {
    healthy: issues.length === 0,
    issues,
  };
}

/**
 * Validate that the OBS scene collection matches an expected set of scenes.
 *
 * @param {object} obsConnection - OBS WebSocket connection
 * @param {string[]} expectedScenes - Array of expected scene names
 * @returns {Promise<{ valid: boolean, missing: string[], extra: string[], current: string }>}
 */
async function validateSceneCollection(obsConnection, expectedScenes) {
  const sceneData = await obsConnection.call('GetSceneList');
  const actualScenes = (sceneData.scenes || []).map(s => s.sceneName);
  const current = sceneData.currentProgramSceneName || '';

  const missing = expectedScenes.filter(s => !actualScenes.includes(s));
  const extra = actualScenes.filter(s => !expectedScenes.includes(s));

  return {
    valid: missing.length === 0,
    missing,
    extra,
    current,
  };
}

/**
 * OBSHealthChecker — wraps the health check functions with event emission
 * and agent integration. Can be used standalone or attached to the agent.
 */
class OBSHealthChecker extends EventEmitter {
  /**
   * @param {object} obsConnection - OBS WebSocket connection
   * @param {object} [expectedConfig] - Expected source/audio config
   */
  constructor(obsConnection, expectedConfig) {
    super();
    this.obsConnection = obsConnection;
    this.expectedConfig = expectedConfig || {};
  }

  /**
   * Run a full health check, emitting events for any issues found.
   * @returns {Promise<{ healthy: boolean, issues: Array }>}
   */
  async check() {
    return checkOBSSources(this.obsConnection, this.expectedConfig, this);
  }

  /**
   * Get all sources across all scenes.
   * @returns {Promise<Array>}
   */
  async getSources() {
    return getSourceList(this.obsConnection);
  }

  /**
   * Get all audio inputs with mute state.
   * @returns {Promise<Array>}
   */
  async getAudioInputs() {
    return getAudioInputs(this.obsConnection);
  }

  /**
   * Validate scene collection against expected scenes.
   * @param {string[]} expectedScenes
   * @returns {Promise<{ valid: boolean, missing: string[], extra: string[], current: string }>}
   */
  async validateScenes(expectedScenes) {
    return validateSceneCollection(this.obsConnection, expectedScenes);
  }
}

module.exports = {
  checkOBSSources,
  getSourceList,
  getAudioInputs,
  validateSceneCollection,
  OBSHealthChecker,
};
