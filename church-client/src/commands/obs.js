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
  const reductionPercent = Math.min(99, Math.max(0, params.reductionPercent || 20));
  const settings = await obs.call('GetStreamServiceSettings');
  const currentBitrate = parseInt(settings.streamServiceSettings?.bitsPerSecond || settings.streamServiceSettings?.bitrate || '4500', 10);
  const rawBitrate = Math.round(currentBitrate * (1 - reductionPercent / 100));
  const newBitrate = Math.max(500, rawBitrate); // floor at 500 kbps
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

// ─── COMPANION PARITY: Scene Collections & Profiles ────────────────────────

async function obsGetSceneCollections(agent) {
  const obs = ensureObs(agent);
  const data = await obs.call('GetSceneCollectionList');
  const current = data.currentSceneCollectionName || '';
  const list = (data.sceneCollections || []).map(c => c === current ? `[${c}]` : c);
  return `Scene collections: ${list.join(', ')}`;
}

async function obsSetSceneCollection(agent, params) {
  const obs = ensureObs(agent);
  const name = String(params.collection || params.name || '').trim();
  if (!name) throw new Error('collection name required');
  await obs.call('SetCurrentSceneCollection', { sceneCollectionName: name });
  return `Scene collection set to: ${name}`;
}

async function obsGetProfiles(agent) {
  const obs = ensureObs(agent);
  const data = await obs.call('GetProfileList');
  const current = data.currentProfileName || '';
  const list = (data.profiles || []).map(p => p === current ? `[${p}]` : p);
  return `Profiles: ${list.join(', ')}`;
}

async function obsSetProfile(agent, params) {
  const obs = ensureObs(agent);
  const name = String(params.profile || params.name || '').trim();
  if (!name) throw new Error('profile name required');
  await obs.call('SetCurrentProfile', { profileName: name });
  return `Profile set to: ${name}`;
}

// ─── COMPANION PARITY: Replay Buffer ───────────────────────────────────────

async function obsStartReplayBuffer(agent) {
  const obs = ensureObs(agent);
  await obs.call('StartReplayBuffer');
  return 'Replay buffer started';
}

async function obsStopReplayBuffer(agent) {
  const obs = ensureObs(agent);
  await obs.call('StopReplayBuffer');
  return 'Replay buffer stopped';
}

async function obsSaveReplayBuffer(agent) {
  const obs = ensureObs(agent);
  await obs.call('SaveReplayBuffer');
  return 'Replay buffer saved';
}

// ─── COMPANION PARITY: Screenshots ────────────────────────────────────────

async function obsGetScreenshot(agent, params) {
  const obs = ensureObs(agent);
  const source = String(params.source || params.name || '').trim();
  const format = params.format || 'png';
  const width = params.width ? toInt(params.width, 'width') : undefined;
  const height = params.height ? toInt(params.height, 'height') : undefined;
  const reqParams = {
    sourceName: source || undefined,
    imageFormat: format,
  };
  if (width) reqParams.imageWidth = width;
  if (height) reqParams.imageHeight = height;
  // If no source, get program output screenshot
  if (!source) {
    const data = await obs.call('GetSourceScreenshot', { sourceName: '__program__', imageFormat: format, imageWidth: width || 960, imageHeight: height || 540 });
    return { type: 'screenshot', data: data.imageData, source: 'obs-program' };
  }
  const data = await obs.call('GetSourceScreenshot', reqParams);
  return { type: 'screenshot', data: data.imageData, source: `obs-${source}` };
}

// ─── COMPANION PARITY: Audio Monitoring ───────────────────────────────────

async function obsSetInputAudioMonitorType(agent, params) {
  const obs = ensureObs(agent);
  const name = String(params.input || params.name || '').trim();
  if (!name) throw new Error('input name required');
  // OBS monitor types: OBS_MONITORING_TYPE_NONE, OBS_MONITORING_TYPE_MONITOR_ONLY, OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT
  const type = String(params.monitorType || params.type || 'OBS_MONITORING_TYPE_NONE');
  await obs.call('SetInputAudioMonitorType', { inputName: name, monitorType: type });
  return `Audio monitor type for "${name}" set to ${type}`;
}

// ─── COMPANION PARITY: Source Transforms ──────────────────────────────────

async function obsSetSceneItemTransform(agent, params) {
  const obs = ensureObs(agent);
  const scene = String(params.scene || '').trim();
  if (!scene) throw new Error('scene name required');
  const itemId = toInt(params.itemId, 'itemId');
  const transform = {};
  if (params.positionX != null) transform.positionX = Number(params.positionX);
  if (params.positionY != null) transform.positionY = Number(params.positionY);
  if (params.rotation != null) transform.rotation = Number(params.rotation);
  if (params.scaleX != null) transform.scaleX = Number(params.scaleX);
  if (params.scaleY != null) transform.scaleY = Number(params.scaleY);
  if (params.cropTop != null) transform.cropTop = toInt(params.cropTop, 'cropTop');
  if (params.cropBottom != null) transform.cropBottom = toInt(params.cropBottom, 'cropBottom');
  if (params.cropLeft != null) transform.cropLeft = toInt(params.cropLeft, 'cropLeft');
  if (params.cropRight != null) transform.cropRight = toInt(params.cropRight, 'cropRight');
  if (params.boundsType != null) transform.boundsType = params.boundsType;
  if (params.boundsWidth != null) transform.boundsWidth = Number(params.boundsWidth);
  if (params.boundsHeight != null) transform.boundsHeight = Number(params.boundsHeight);
  await obs.call('SetSceneItemTransform', { sceneName: scene, sceneItemId: itemId, sceneItemTransform: transform });
  return `Transform updated for item ${itemId} in "${scene}"`;
}

// ─── COMPANION PARITY: Filter Settings ────────────────────────────────────

async function obsSetSourceFilterSettings(agent, params) {
  const obs = ensureObs(agent);
  const source = String(params.source || '').trim();
  const filter = String(params.filter || '').trim();
  if (!source || !filter) throw new Error('source and filter names required');
  const settings = params.settings || {};
  if (typeof settings !== 'object') throw new Error('settings must be an object');
  await obs.call('SetSourceFilterSettings', {
    sourceName: source,
    filterName: filter,
    filterSettings: settings,
    overlay: params.overlay !== false,
  });
  return `Filter "${filter}" settings updated on "${source}"`;
}

// ─── COMPANION PARITY: Trigger Transition (Studio Mode) ───────────────────

async function obsTriggerTransition(agent) {
  const obs = ensureObs(agent);
  await obs.call('TriggerStudioModeTransition');
  return 'Studio mode transition triggered';
}

// ─── COMPANION PARITY: Stream Settings ────────────────────────────────────

async function obsGetStreamSettings(agent) {
  const obs = ensureObs(agent);
  const data = await obs.call('GetStreamServiceSettings');
  return {
    type: data.streamServiceType,
    server: data.streamServiceSettings?.server || '',
    key: data.streamServiceSettings?.key ? '***' : '(none)',
  };
}

// ─── COMPANION PARITY: Stats ──────────────────────────────────────────────

async function obsGetStats(agent) {
  const obs = ensureObs(agent);
  const data = await obs.call('GetStats');
  return {
    cpuUsage: data.cpuUsage ? `${data.cpuUsage.toFixed(1)}%` : 'N/A',
    memoryUsage: data.memoryUsage ? `${data.memoryUsage.toFixed(0)} MB` : 'N/A',
    availableDiskSpace: data.availableDiskSpace ? `${data.availableDiskSpace.toFixed(1)} GB` : 'N/A',
    activeFps: data.activeFps ? `${data.activeFps.toFixed(1)}` : 'N/A',
    renderSkippedFrames: data.renderSkippedFrames || 0,
    outputSkippedFrames: data.outputSkippedFrames || 0,
    renderTotalFrames: data.renderTotalFrames || 0,
    outputTotalFrames: data.outputTotalFrames || 0,
  };
}

// ─── COMPANION PARITY: Projector ──────────────────────────────────────────

async function obsOpenProjector(agent, params) {
  const obs = ensureObs(agent);
  const type = params.type || 'OBS_WEBSOCKET_PROJECTOR_PREVIEW'; // or _PROGRAM, _MULTIVIEW, _SOURCE
  const reqParams = { projectorType: type };
  if (params.monitor != null) reqParams.monitorIndex = toInt(params.monitor, 'monitor');
  if (params.source) reqParams.sourceName = params.source;
  await obs.call('OpenSourceProjector', reqParams);
  return `Projector opened: ${type}`;
}

// ─── COMPANION PARITY: Media Input Control ────────────────────────────────

async function obsMediaInputAction(agent, params) {
  const obs = ensureObs(agent);
  const name = String(params.input || params.name || '').trim();
  if (!name) throw new Error('input name required');
  const action = String(params.action || '').trim().toUpperCase();
  const validActions = ['OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY', 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE',
    'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP', 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART', 'PLAY', 'PAUSE', 'STOP', 'RESTART'];
  if (!validActions.includes(action)) throw new Error(`action must be one of: PLAY, PAUSE, STOP, RESTART`);
  const mediaAction = action.startsWith('OBS_') ? action : `OBS_WEBSOCKET_MEDIA_INPUT_ACTION_${action}`;
  await obs.call('TriggerMediaInputAction', { inputName: name, mediaAction });
  return `Media "${name}": ${action}`;
}

async function obsSetMediaInputCursor(agent, params) {
  const obs = ensureObs(agent);
  const name = String(params.input || params.name || '').trim();
  if (!name) throw new Error('input name required');
  const cursor = toInt(params.cursor || params.ms, 'cursor (ms)');
  await obs.call('SetMediaInputCursor', { inputName: name, mediaCursor: cursor });
  return `Media "${name}" seeked to ${cursor}ms`;
}

async function obsGetMediaInputStatus(agent, params) {
  const obs = ensureObs(agent);
  const name = String(params.input || params.name || '').trim();
  if (!name) throw new Error('input name required');
  const data = await obs.call('GetMediaInputStatus', { inputName: name });
  return {
    state: data.mediaState,
    duration: data.mediaDuration,
    cursor: data.mediaCursor,
  };
}

// ─── COMPANION PARITY: Output Status ──────────────────────────────────────

async function obsGetOutputStatus(agent) {
  const obs = ensureObs(agent);
  const [stream, record] = await Promise.all([
    obs.call('GetStreamStatus').catch(() => null),
    obs.call('GetRecordStatus').catch(() => null),
  ]);
  const result = {};
  if (stream) {
    result.streaming = stream.outputActive;
    result.streamTimecode = stream.outputTimecode;
    result.streamBytes = stream.outputBytes;
    result.streamSkippedFrames = stream.outputSkippedFrames;
    result.streamTotalFrames = stream.outputTotalFrames;
  }
  if (record) {
    result.recording = record.outputActive;
    result.recordPaused = record.outputPaused;
    result.recordTimecode = record.outputTimecode;
    result.recordBytes = record.outputBytes;
  }
  return result;
}

// ─── COMPANION PARITY: Text Source Update ─────────────────────────────────

async function obsSetInputSettings(agent, params) {
  const obs = ensureObs(agent);
  const name = String(params.input || params.name || '').trim();
  if (!name) throw new Error('input name required');
  const settings = params.settings || {};
  if (typeof settings !== 'object') throw new Error('settings must be an object');
  await obs.call('SetInputSettings', { inputName: name, inputSettings: settings, overlay: params.overlay !== false });
  return `Input "${name}" settings updated`;
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

  // Companion parity: scene collections & profiles
  'obs.getSceneCollections': obsGetSceneCollections,
  'obs.setSceneCollection': obsSetSceneCollection,
  'obs.getProfiles': obsGetProfiles,
  'obs.setProfile': obsSetProfile,

  // Companion parity: replay buffer
  'obs.startReplayBuffer': obsStartReplayBuffer,
  'obs.stopReplayBuffer': obsStopReplayBuffer,
  'obs.saveReplayBuffer': obsSaveReplayBuffer,

  // Companion parity: screenshots
  'obs.getScreenshot': obsGetScreenshot,

  // Companion parity: audio monitoring
  'obs.setInputAudioMonitorType': obsSetInputAudioMonitorType,

  // Companion parity: transforms & filter settings
  'obs.setSceneItemTransform': obsSetSceneItemTransform,
  'obs.setSourceFilterSettings': obsSetSourceFilterSettings,

  // Companion parity: studio mode transition
  'obs.triggerTransition': obsTriggerTransition,

  // Companion parity: stream settings & stats
  'obs.getStreamSettings': obsGetStreamSettings,
  'obs.getStats': obsGetStats,

  // Companion parity: projector
  'obs.openProjector': obsOpenProjector,

  // Companion parity: media input control
  'obs.mediaInputAction': obsMediaInputAction,
  'obs.setMediaInputCursor': obsSetMediaInputCursor,
  'obs.getMediaInputStatus': obsGetMediaInputStatus,

  // Companion parity: output status
  'obs.getOutputStatus': obsGetOutputStatus,

  // Companion parity: input settings (text source, etc.)
  'obs.setInputSettings': obsSetInputSettings,
};
