const { toInt } = require('./helpers');

function ensureObs(agent) {
  if (!agent.obs || !agent.status.obs?.connected) throw new Error('OBS not connected');
  return agent.obs;
}

async function obsStartStream(agent) {
  const obs = ensureObs(agent);
  await obs.call('StartStream');
  return 'Stream started';
}

async function obsStopStream(agent) {
  const obs = ensureObs(agent);
  await obs.call('StopStream');
  return 'Stream stopped';
}

async function obsStartRecording(agent) {
  const obs = ensureObs(agent);
  await obs.call('StartRecord');
  return 'OBS recording started';
}

async function obsStopRecording(agent) {
  const obs = ensureObs(agent);
  await obs.call('StopRecord');
  return 'OBS recording stopped';
}

async function obsSetScene(agent, params) {
  const obs = ensureObs(agent);
  await obs.call('SetCurrentProgramScene', { sceneName: params.scene });
  return `Scene set to: ${params.scene}`;
}

// ─── OBS EXTENDED COMMANDS ──────────────────────────────────────────────────

async function obsGetScenes(agent) {
  const obs = ensureObs(agent);
  const data = await obs.call('GetSceneList');
  const scenes = (data.scenes || []).map(s => s.sceneName).reverse();
  const current = data.currentProgramSceneName || '';
  return `Scenes: ${scenes.map(s => s === current ? `[${s}]` : s).join(', ')}`;
}

async function obsGetInputList(agent) {
  const obs = ensureObs(agent);
  const data = await obs.call('GetInputList');
  const inputs = (data.inputs || []).map(i => `${i.inputName} (${i.inputKind})`);
  return inputs.length ? `Inputs:\n${inputs.join('\n')}` : 'No inputs found';
}

async function obsSetInputVolume(agent, params) {
  const obs = ensureObs(agent);
  const name = String(params.input || params.name || '').trim();
  if (!name) throw new Error('input name required');
  const opts = {};
  if (params.volumeDb != null) {
    opts.inputVolumeDb = Number(params.volumeDb);
  } else {
    opts.inputVolumeMul = params.volume != null ? Number(params.volume) : 1;
  }
  await obs.call('SetInputVolume', { inputName: name, ...opts });
  return `Volume set for "${name}"`;
}

async function obsSetInputMute(agent, params) {
  const obs = ensureObs(agent);
  const name = String(params.input || params.name || '').trim();
  if (!name) throw new Error('input name required');
  const muted = params.muted !== false && params.muted !== 'false';
  await obs.call('SetInputMute', { inputName: name, inputMuted: muted });
  return `${name}: ${muted ? 'muted' : 'unmuted'}`;
}

async function obsSetTransition(agent, params) {
  const obs = ensureObs(agent);
  const name = String(params.transition || params.name || '').trim();
  if (!name) throw new Error('transition name required');
  await obs.call('SetCurrentSceneTransition', { transitionName: name });
  return `Transition set to: ${name}`;
}

async function obsSetTransitionDuration(agent, params) {
  const obs = ensureObs(agent);
  const ms = toInt(params.duration || params.ms, 'duration');
  await obs.call('SetCurrentSceneTransitionDuration', { transitionDuration: ms });
  return `Transition duration set to ${ms}ms`;
}

async function obsGetSourceFilters(agent, params) {
  const obs = ensureObs(agent);
  const name = String(params.source || params.input || '').trim();
  if (!name) throw new Error('source name required');
  const data = await obs.call('GetSourceFilterList', { sourceName: name });
  const filters = (data.filters || []).map(f => `${f.filterName} (${f.filterKind}) ${f.filterEnabled ? '✓' : '✗'}`);
  return filters.length ? `Filters on "${name}":\n${filters.join('\n')}` : `No filters on "${name}"`;
}

async function obsSetSourceFilterEnabled(agent, params) {
  const obs = ensureObs(agent);
  const source = String(params.source || '').trim();
  const filter = String(params.filter || '').trim();
  if (!source || !filter) throw new Error('source and filter names required');
  const enabled = params.enabled !== false && params.enabled !== 'false';
  await obs.call('SetSourceFilterEnabled', { sourceName: source, filterName: filter, filterEnabled: enabled });
  return `Filter "${filter}" on "${source}": ${enabled ? 'enabled' : 'disabled'}`;
}

async function obsSetStudioMode(agent, params) {
  const obs = ensureObs(agent);
  const enabled = params.enabled !== false && params.enabled !== 'false';
  await obs.call('SetStudioModeEnabled', { studioModeEnabled: enabled });
  return `Studio mode: ${enabled ? 'enabled' : 'disabled'}`;
}

async function obsSetPreviewScene(agent, params) {
  const obs = ensureObs(agent);
  const scene = String(params.scene || '').trim();
  if (!scene) throw new Error('scene name required');
  await obs.call('SetCurrentPreviewScene', { sceneName: scene });
  return `Preview scene set to: ${scene}`;
}

async function obsToggleVirtualCam(agent) {
  const obs = ensureObs(agent);
  await obs.call('ToggleVirtualCam');
  return 'Virtual camera toggled';
}

async function obsPauseRecording(agent) {
  const obs = ensureObs(agent);
  await obs.call('PauseRecord');
  return 'OBS recording paused';
}

async function obsResumeRecording(agent) {
  const obs = ensureObs(agent);
  await obs.call('ResumeRecord');
  return 'OBS recording resumed';
}

async function obsGetSceneItems(agent, params) {
  const obs = ensureObs(agent);
  const scene = String(params.scene || '').trim();
  if (!scene) throw new Error('scene name required');
  const data = await obs.call('GetSceneItemList', { sceneName: scene });
  const items = (data.sceneItems || []).map(i => `${i.sourceName} ${i.sceneItemEnabled ? '✓' : '✗'}`);
  return items.length ? `Items in "${scene}":\n${items.join('\n')}` : `No items in "${scene}"`;
}

async function obsSetSceneItemEnabled(agent, params) {
  const obs = ensureObs(agent);
  const scene = String(params.scene || '').trim();
  if (!scene) throw new Error('scene name required');
  const item = toInt(params.itemId, 'itemId');
  const enabled = params.enabled !== false && params.enabled !== 'false';
  await obs.call('SetSceneItemEnabled', { sceneName: scene, sceneItemId: item, sceneItemEnabled: enabled });
  return `Scene item ${item} in "${scene}": ${enabled ? 'visible' : 'hidden'}`;
}

async function obsConfigureMonitorStream(agent, params) {
  const obs = ensureObs(agent);

  const { relayUrl, streamKey, bitrate = 3000, startStream = false } = params || {};
  if (!relayUrl)  throw new Error('relayUrl is required');
  if (!streamKey) throw new Error('streamKey is required');

  // Build the full RTMP URL: rtmp://host/app/streamKey
  const serverUrl = relayUrl.endsWith('/') ? relayUrl.slice(0, -1) : relayUrl;

  // Configure the stream service to Custom RTMP
  await obs.call('SetStreamServiceSettings', {
    streamServiceType: 'rtmp_custom',
    streamServiceSettings: {
      server:   serverUrl,
      key:      streamKey,
      use_auth: false,
      // OBS uses bitsPerSecond for some service types; set both for compatibility
      bitsPerSecond: bitrate * 1000,
    },
  });

  let result = `OBS monitor stream configured → ${serverUrl} (key: ${streamKey}, ${bitrate}kbps)`;

  if (startStream) {
    // Check if already streaming to avoid duplicate start
    let alreadyStreaming = false;
    try {
      const streamStatus = await obs.call('GetStreamStatus');
      alreadyStreaming = streamStatus?.outputActive || false;
    } catch { /* GetStreamStatus may not be available on all OBS versions */ }

    if (!alreadyStreaming) {
      await obs.call('StartStream');
      result += ' — stream started';
    } else {
      result += ' — already streaming (stream not restarted; use obs.stopStream then obs.startStream to apply)';
    }
  }

  return result;
}

async function obsReduceBitrate(agent, params) {
  const obs = ensureObs(agent);
  const reductionPercent = params.reductionPercent || 20;
  const settings = await obs.call('GetStreamServiceSettings');
  const currentBitrate = parseInt(settings.streamServiceSettings?.bitsPerSecond || settings.streamServiceSettings?.bitrate || '4500', 10);
  const newBitrate = Math.round(currentBitrate * (1 - reductionPercent / 100));
  const newSettings = { ...settings.streamServiceSettings };
  // OBS stores bitrate in different keys depending on service type
  if (newSettings.bitsPerSecond !== undefined) newSettings.bitsPerSecond = newBitrate;
  else newSettings.bitrate = String(newBitrate);
  await obs.call('SetStreamServiceSettings', {
    streamServiceType: settings.streamServiceType,
    streamServiceSettings: newSettings,
  });
  return `Bitrate reduced by ${reductionPercent}%: ${currentBitrate} → ${newBitrate}`;
}

module.exports = {
  'obs.startStream': obsStartStream,
  'obs.stopStream': obsStopStream,
  'obs.startRecording': obsStartRecording,
  'obs.stopRecording': obsStopRecording,
  'obs.setScene': obsSetScene,
  'obs.configureMonitorStream': obsConfigureMonitorStream,
  'obs.getScenes': obsGetScenes,
  'obs.getInputList': obsGetInputList,
  'obs.setInputVolume': obsSetInputVolume,
  'obs.setInputMute': obsSetInputMute,
  'obs.setTransition': obsSetTransition,
  'obs.setTransitionDuration': obsSetTransitionDuration,
  'obs.getSourceFilters': obsGetSourceFilters,
  'obs.setSourceFilterEnabled': obsSetSourceFilterEnabled,
  'obs.setStudioMode': obsSetStudioMode,
  'obs.setPreviewScene': obsSetPreviewScene,
  'obs.toggleVirtualCam': obsToggleVirtualCam,
  'obs.pauseRecording': obsPauseRecording,
  'obs.resumeRecording': obsResumeRecording,
  'obs.getSceneItems': obsGetSceneItems,
  'obs.setSceneItemEnabled': obsSetSceneItemEnabled,
  'obs.reduceBitrate': obsReduceBitrate,
};
