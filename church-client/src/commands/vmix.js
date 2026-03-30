const { toInt } = require('./helpers');

/** Simple ASCII fader bar. */
function faderBar(pct) {
  const filled = Math.round(pct / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

async function vmixStatus(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const status = await agent.vmix.getStatus();

  if (!status || !status.running) {
    return '🖥️ vMix — ❌ Offline\n\nvMix is not responding. Check that it is running.';
  }

  const edition = [status.edition, status.version].filter(Boolean).join(' ');
  const lines = [
    `🖥️ vMix${edition ? ' ' + edition : ''} — ✅ Running`,
    '',
    status.streaming ? '🔴 Streaming: LIVE' : '⚫ Streaming: Off',
    status.recording ? '⏺️  Recording: Active' : '⚫ Recording: Off',
    '',
    `🎬 Program: Input ${status.activeInput}`,
    `👁️ Preview: Input ${status.previewInput}`,
    `📋 Inputs: ${status.inputCount} loaded`,
  ];

  if (status.audio) {
    const volPct = Math.round(status.audio.volume ?? 0);
    lines.push('');
    lines.push(status.audio.muted
      ? `🔇 Master audio: MUTED (${volPct}%)`
      : `🔊 Master audio: ${faderBar(volPct)} ${volPct}%`);
  }

  return lines.join('\n');
}

async function vmixStartStream(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix.startStream();
  return 'vMix streaming started';
}

async function vmixStopStream(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix.stopStream();
  return 'vMix streaming stopped';
}

async function vmixStartRecording(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix.startRecording();
  return 'vMix recording started';
}

async function vmixStopRecording(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix.stopRecording();
  return 'vMix recording stopped';
}

async function vmixCut(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix.cut();
  return 'vMix: cut to preview';
}

async function vmixFade(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const ms = params.ms || params.duration || 2000;
  await agent.vmix.fade(ms);
  return `vMix: fade to preview (${ms}ms)`;
}

async function vmixSetPreview(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input parameter required');
  await agent.vmix.setPreview(params.input);
  return `vMix: preview set to input ${params.input}`;
}

async function vmixSetProgram(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input parameter required');
  await agent.vmix.setProgram(params.input);
  return `vMix: program cut to input ${params.input}`;
}

async function vmixListInputs(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const inputs = await agent.vmix.listInputs();
  if (!inputs.length) return 'No inputs found';
  return inputs.map(i => `${i.number}. ${i.title} (${i.type})`).join('\n');
}

async function vmixSetVolume(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const value = toInt(params.value, 'value');
  if (value < 0 || value > 100) throw new Error('value must be 0–100');
  const vol = await agent.vmix.setMasterVolume(value);
  return `vMix master volume set to ${vol}%`;
}

async function vmixMute(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix.muteMaster();
  return 'vMix master muted';
}

async function vmixUnmute(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix.unmuteMaster();
  return 'vMix master unmuted';
}

async function vmixPreview(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const b64 = await agent.vmix.getScreenshot('Output');
  if (!b64) return 'Could not get vMix screenshot';
  return { type: 'screenshot', data: b64, source: 'vmix' };
}

async function vmixIsRunning(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const running = await agent.vmix.isRunning();
  return running ? '🖥️ vMix — ✅ Running' : '🖥️ vMix — ❌ Not reachable';
}

async function vmixFunction(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const functionName = String(params.function || '').trim();
  if (!functionName) throw new Error('function parameter required');
  if (typeof agent.vmix._call !== 'function') {
    throw new Error('vMix low-level function API unavailable');
  }
  const callParams = {};
  if (params.input != null) callParams.Input = params.input;
  if (params.value != null) callParams.Value = params.value;
  const result = await agent.vmix._call(functionName, callParams);
  if (result === null) throw new Error(`Could not execute vMix function "${functionName}"`);
  return `vMix function "${functionName}" executed`;
}

async function vmixStartPlaylist(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix.startPlaylist();
  return 'vMix playlist started';
}

async function vmixStopPlaylist(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix.stopPlaylist();
  return 'vMix playlist stopped';
}

async function vmixAudioLevels(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const audio = await agent.vmix.getAudioLevels();
  if (!audio) return 'Audio level data not available';
  return `Master: ${audio.volume}% ${audio.muted ? '🔇 MUTED' : '🔊'} | L: ${audio.meterL} R: ${audio.meterR}`;
}

// ─── VMIX EXTENDED COMMANDS ─────────────────────────────────────────────────

async function vmixFadeToBlack(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('FadeToBlack');
  return 'vMix: fade to black';
}

async function vmixSetInputVolume(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const input = params.input;
  if (input == null) throw new Error('input required');
  const value = params.volume != null ? params.volume : params.value;
  if (value == null) throw new Error('volume value required (0-100)');
  await agent.vmix._call('SetVolume', { Input: input, Value: value });
  return `vMix input ${input} volume set to ${value}%`;
}

async function vmixMuteInput(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const input = params.input;
  if (input == null) throw new Error('input required');
  await agent.vmix._call('AudioOff', { Input: input });
  return `vMix input ${input} muted`;
}

async function vmixUnmuteInput(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const input = params.input;
  if (input == null) throw new Error('input required');
  await agent.vmix._call('AudioOn', { Input: input });
  return `vMix input ${input} unmuted`;
}

async function vmixOverlayInput(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const overlay = toInt(params.overlay || 1, 'overlay');
  const input = params.input;
  if (input == null) throw new Error('input required');
  await agent.vmix._call(`OverlayInput${overlay}`, { Input: input });
  return `vMix overlay ${overlay} set to input ${input}`;
}

async function vmixOverlayOff(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const overlay = toInt(params.overlay || 1, 'overlay');
  await agent.vmix._call(`OverlayInput${overlay}Off`);
  return `vMix overlay ${overlay} off`;
}

async function vmixSetText(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const input = params.input;
  if (input == null) throw new Error('input required');
  const text = String(params.text || params.value || '');
  await agent.vmix._call('SetText', { Input: input, Value: text });
  return `vMix input ${input} text updated`;
}

async function vmixReplay(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const action = String(params.action || 'PlayLastEvent').trim();
  await agent.vmix._call(action);
  return `vMix replay: ${action}`;
}

// ─── COMPANION PARITY: Transition Types ───────────────────────────────────

async function vmixTransition(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const type = String(params.type || 'Cut').trim();
  const input = params.input;
  const duration = params.duration || params.ms;
  await agent.vmix.transition(type, input, duration);
  return `vMix: ${type} transition${input != null ? ` to input ${input}` : ''}`;
}

// ─── COMPANION PARITY: Input Position/Zoom/Crop ──────────────────────────

async function vmixSetInputPosition(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  await agent.vmix.setInputPosition(params.input, params.x || 0, params.y || 0);
  return `vMix input ${params.input} position set`;
}

async function vmixSetInputZoom(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  await agent.vmix.setInputZoom(params.input, params.value || 1);
  return `vMix input ${params.input} zoom set to ${params.value}`;
}

async function vmixSetInputCrop(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  await agent.vmix.setInputCrop(params.input, params.x1 || 0, params.y1 || 0, params.x2 || 1, params.y2 || 1);
  return `vMix input ${params.input} crop set`;
}

// ─── COMPANION PARITY: MultiCorder & External ────────────────────────────

async function vmixStartMultiCorder(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix.startMultiCorder();
  return 'vMix MultiCorder started';
}

async function vmixStopMultiCorder(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix.stopMultiCorder();
  return 'vMix MultiCorder stopped';
}

async function vmixStartExternal(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix.startExternal();
  return 'vMix external output started';
}

async function vmixStopExternal(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix.stopExternal();
  return 'vMix external output stopped';
}

// ─── COMPANION PARITY: Fullscreen, Loop, Rename ─────────────────────────

async function vmixToggleFullscreen(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix.toggleFullscreen();
  return 'vMix fullscreen toggled';
}

async function vmixSetInputLoop(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  const on = params.on !== false && params.on !== 'false';
  await agent.vmix.setInputLoop(params.input, on);
  return `vMix input ${params.input} loop ${on ? 'on' : 'off'}`;
}

async function vmixRenameInput(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  if (!params.name) throw new Error('name required');
  await agent.vmix.renameInput(params.input, params.name);
  return `vMix input ${params.input} renamed to "${params.name}"`;
}

// ─── COMPANION PARITY: Colour Correction ────────────────────────────────

async function vmixSetColourCorrection(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  await agent.vmix.setInputColourCorrection(params.input, {
    lift: params.lift, gamma: params.gamma, gain: params.gain,
    saturation: params.saturation, hue: params.hue,
  });
  return `vMix input ${params.input} colour correction updated`;
}

// ─── COMPANION PARITY: Audio Bus Routing ────────────────────────────────

async function vmixSetInputAudioBus(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  const bus = String(params.bus || 'A').toUpperCase();
  const on = params.on !== false && params.on !== 'false';
  await agent.vmix.setInputAudioBus(params.input, bus, on);
  return `vMix input ${params.input} audio bus ${bus} ${on ? 'on' : 'off'}`;
}

async function vmixSetBusVolume(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const bus = String(params.bus || 'A').toUpperCase();
  const value = toInt(params.value, 'value');
  const vol = await agent.vmix.setBusVolume(bus, value);
  return `vMix bus ${bus} volume set to ${vol}%`;
}

async function vmixMuteBus(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const bus = String(params.bus || 'A').toUpperCase();
  await agent.vmix.muteBus(bus);
  return `vMix bus ${bus} mute toggled`;
}

// ─── COMPANION PARITY: NDI, Layers, Title, Tally, Script ───────────────

async function vmixSetInputNDISource(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  if (!params.source) throw new Error('NDI source name required');
  await agent.vmix.setInputNDISource(params.input, params.source);
  return `vMix input ${params.input} NDI source set to "${params.source}"`;
}

async function vmixSetLayerInput(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const layer = toInt(params.layer || 1, 'layer');
  if (params.input == null) throw new Error('input required');
  await agent.vmix.setLayerInput(layer, params.input);
  return `vMix layer ${layer} set to input ${params.input}`;
}

async function vmixSetTitleField(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  if (!params.field) throw new Error('field name required');
  await agent.vmix.setTitleField(params.input, params.field, params.value || '');
  return `vMix input ${params.input} title field "${params.field}" updated`;
}

async function vmixSelectTitleIndex(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  const index = toInt(params.index, 'index');
  await agent.vmix.selectTitleIndex(params.input, index);
  return `vMix input ${params.input} title index set to ${index}`;
}

async function vmixGetTallyState(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const tally = await agent.vmix.getTallyState();
  if (!tally) return 'Tally data not available';
  return tally.map(t => {
    const state = t.program ? 'PGM' : t.preview ? 'PVW' : '---';
    return `${t.number}. ${t.title} [${state}]`;
  }).join('\n');
}

async function vmixRunScript(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const name = String(params.name || '').trim();
  if (!name) throw new Error('script name required');
  await agent.vmix.runScript(name);
  return `vMix script "${name}" started`;
}

async function vmixStopScript(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const name = String(params.name || '').trim();
  if (!name) throw new Error('script name required');
  await agent.vmix.stopScript(name);
  return `vMix script "${name}" stopped`;
}

// ─── COMPANION PARITY: Snapshots ────────────────────────────────────────

async function vmixSaveSnapshot(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const filename = String(params.filename || params.name || '').trim();
  if (!filename) throw new Error('filename required');
  await agent.vmix.saveSnapshot(filename);
  return `vMix snapshot saved: ${filename}`;
}

async function vmixLoadSnapshot(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const filename = String(params.filename || params.name || '').trim();
  if (!filename) throw new Error('filename required');
  await agent.vmix.loadSnapshot(filename);
  return `vMix snapshot loaded: ${filename}`;
}

// ─── COMPANION PARITY: Browser Navigate ─────────────────────────────────

async function vmixBrowserNavigate(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  if (!params.url) throw new Error('url required');
  await agent.vmix.browserNavigate(params.input, params.url);
  return `vMix browser input ${params.input} navigated to ${params.url}`;
}

// ─── COMPANION PARITY: Replay (33 commands) ────────────────────────────────

async function vmixReplayACamera(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('ReplayACamera' + toInt(params.camera, 'camera'));
  return `vMix replay A camera set to ${params.camera}`;
}

async function vmixReplayBCamera(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('ReplayBCamera' + toInt(params.camera, 'camera'));
  return `vMix replay B camera set to ${params.camera}`;
}

async function vmixReplayCamera(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('ReplayCamera' + toInt(params.camera, 'camera'));
  return `vMix replay camera set to ${params.camera}`;
}

async function vmixReplaySelectChannel(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const channel = params.channel || 'AB';
  await agent.vmix._call('ReplaySelectChannel' + channel);
  return `vMix replay channel selected: ${channel}`;
}

async function vmixReplaySwapChannels(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('ReplaySwapChannels');
  return 'vMix replay channels swapped';
}

async function vmixReplayMark(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const action = params.action || 'ReplayMarkIn';
  const callParams = params.seconds ? { Value: params.seconds } : {};
  await agent.vmix._call(action, callParams);
  return `vMix replay: ${action}`;
}

async function vmixReplayMoveInOut(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const action = params.action || 'ReplayMoveSelectedInPoint';
  await agent.vmix._call(action, { Value: params.frames });
  return `vMix replay: ${action} by ${params.frames} frames`;
}

async function vmixReplayUpdateInOut(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const action = params.action || 'ReplayUpdateSelectedInPoint';
  await agent.vmix._call(action);
  return `vMix replay: ${action}`;
}

async function vmixReplaySelectEvents(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const tab = toInt(params.tab, 'tab');
  await agent.vmix._call('ReplaySelectEvents' + tab);
  return `vMix replay events tab ${tab} selected`;
}

async function vmixReplayChangeDirection(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('ReplayChangeDirection');
  return 'vMix replay direction changed';
}

async function vmixReplayChangeSpeed(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('ReplayChangeSpeed', { Value: params.value });
  return `vMix replay speed changed by ${params.value}`;
}

async function vmixReplaySetSpeed(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('ReplaySetSpeed', { Value: params.value });
  return `vMix replay speed set to ${params.value}`;
}

async function vmixReplayMoveEvent(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const tab = toInt(params.tab, 'tab');
  await agent.vmix._call('ReplayMoveSelectedEventToTab' + tab);
  return `vMix replay event moved to tab ${tab}`;
}

async function vmixReplayMoveEventUp(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('ReplayMoveSelectedEventUp');
  return 'vMix replay event moved up';
}

async function vmixReplayMoveEventDown(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('ReplayMoveSelectedEventDown');
  return 'vMix replay event moved down';
}

async function vmixReplayFastForward(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const speed = params.speed || 2;
  await agent.vmix._call('ReplayFastForward', { Value: speed });
  return `vMix replay fast forward at ${speed}x`;
}

async function vmixReplayFastBackward(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const speed = params.speed || 2;
  await agent.vmix._call('ReplayFastBackward', { Value: speed });
  return `vMix replay fast backward at ${speed}x`;
}

async function vmixReplayJumpFrames(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('ReplayJumpFrames', { Value: params.frames });
  return `vMix replay jumped ${params.frames} frames`;
}

async function vmixReplayJumpToNow(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('ReplayJumpToNow');
  return 'vMix replay jumped to now';
}

async function vmixReplayLiveToggle(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('ReplayLiveToggle');
  return 'vMix replay live toggled';
}

async function vmixReplayPlay(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('ReplayPlay');
  return 'vMix replay playing';
}

async function vmixReplayPause(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('ReplayPause');
  return 'vMix replay paused';
}

async function vmixReplayPlayEvent(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const event = toInt(params.event, 'event');
  await agent.vmix._call('ReplayPlayEvent' + event);
  return `vMix replay playing event ${event}`;
}

async function vmixReplayPlaySelectedEventToOutput(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('ReplayPlaySelectedEventToOutput');
  return 'vMix replay playing selected event to output';
}

async function vmixReplayPlayEventsByID(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('ReplayPlayEventsByID', { Value: params.ids });
  return `vMix replay playing events by ID: ${params.ids}`;
}

async function vmixReplayPlayEventsByIDToOutput(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('ReplayPlayEventsByIDToOutput', { Value: params.ids });
  return `vMix replay playing events by ID to output: ${params.ids}`;
}

async function vmixReplayPlayLastEventToOutput(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('ReplayPlayLastEventToOutput');
  return 'vMix replay playing last event to output';
}

async function vmixReplayPlayAllEventsToOutput(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('ReplayPlayAllEventsToOutput');
  return 'vMix replay playing all events to output';
}

async function vmixReplayStopEvents(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('ReplayStopEvents');
  return 'vMix replay events stopped';
}

async function vmixReplayToggleCamera(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const camera = toInt(params.camera, 'camera');
  await agent.vmix._call('ReplayToggleSelectedEventCamera' + camera);
  return `vMix replay toggled camera ${camera} on selected event`;
}

async function vmixReplayShowHide(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('ReplayShowHide');
  return 'vMix replay show/hide toggled';
}

async function vmixReplayRecording(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const action = params.action || 'StartRecording';
  await agent.vmix._call('Replay' + action);
  return `vMix replay: ${action}`;
}

async function vmixReplayEventText(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const fn = params.append ? 'ReplayAppendSelectedEventText' : 'ReplaySetSelectedEventText';
  await agent.vmix._call(fn, { Value: params.text });
  return `vMix replay event text ${params.append ? 'appended' : 'set'}`;
}

async function vmixReplayEventTextClear(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('ReplayClearSelectedEventText');
  return 'vMix replay event text cleared';
}

// ─── COMPANION PARITY: PTZ (3 commands) ─────────────────────────────────────

async function vmixPtzMove(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const direction = params.direction || 'Home';
  await agent.vmix._call('PTZ' + direction, { Input: params.input, Value: params.speed });
  return `vMix PTZ ${direction}`;
}

async function vmixPtzFocusZoom(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const action = params.action || 'FocusAuto';
  await agent.vmix._call('PTZ' + action, { Input: params.input, Value: params.speed });
  return `vMix PTZ ${action}`;
}

async function vmixPtzVirtualInput(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const action = params.action || 'Create';
  await agent.vmix._call('PTZVirtualInput' + action, { Input: params.input, Value: params.value });
  return `vMix PTZ virtual input: ${action}`;
}

// ─── COMPANION PARITY: Data Sources (4 commands) ────────────────────────────

async function vmixDataSourceAutoNext(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const suffix = params.on === false ? 'Off' : params.on === true ? 'On' : 'OnOff';
  await agent.vmix._call('DataSourceAutoNext' + suffix, { Value: params.name + ',' + params.table });
  return `vMix data source auto-next ${suffix.toLowerCase()}`;
}

async function vmixDataSourceNextRow(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('DataSourceNextRow', { Value: params.name + ',' + params.table });
  return 'vMix data source next row';
}

async function vmixDataSourcePreviousRow(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('DataSourcePreviousRow', { Value: params.name + ',' + params.table });
  return 'vMix data source previous row';
}

async function vmixDataSourceSelectRow(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('DataSourceSelectRow', { Value: params.name + ',' + params.table + ',' + params.index });
  return `vMix data source row ${params.index} selected`;
}

// ─── COMPANION PARITY: Advanced Title (13 commands) ─────────────────────────

async function vmixSetTextByLayer(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  await agent.vmix._call('SetText', { Input: params.input, SelectedName: params.layer || params.name, Value: params.text });
  return `vMix input ${params.input} text set by layer`;
}

async function vmixSetTextColor(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  await agent.vmix._call('SetTextColour', { Input: params.input, SelectedName: params.layer, Value: params.color });
  return `vMix input ${params.input} text color set`;
}

async function vmixSetTextVisible(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  const fn = 'SetTextVisibleO' + (params.on === false ? 'ff' : 'n');
  await agent.vmix._call(fn, { Input: params.input, SelectedName: params.layer });
  return `vMix input ${params.input} text visibility ${params.on === false ? 'off' : 'on'}`;
}

async function vmixSetShapeColor(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  await agent.vmix._call('SetColour', { Input: params.input, SelectedName: params.layer, Value: params.color });
  return `vMix input ${params.input} shape color set`;
}

async function vmixSetTitleImage(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  await agent.vmix._call('SetImage', { Input: params.input, SelectedName: params.layer, Value: params.filename });
  return `vMix input ${params.input} title image set`;
}

async function vmixSetTitleImageVisible(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  const fn = 'SetImageVisibleO' + (params.on === false ? 'ff' : 'n');
  await agent.vmix._call(fn, { Input: params.input, SelectedName: params.layer });
  return `vMix input ${params.input} title image visibility ${params.on === false ? 'off' : 'on'}`;
}

async function vmixNextTitlePreset(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  await agent.vmix._call('NextTitlePreset', { Input: params.input });
  return `vMix input ${params.input} next title preset`;
}

async function vmixPreviousTitlePreset(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  await agent.vmix._call('PreviousTitlePreset', { Input: params.input });
  return `vMix input ${params.input} previous title preset`;
}

async function vmixTitleBeginAnimation(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  await agent.vmix._call('TitleBeginAnimation', { Input: params.input, Value: params.animation });
  return `vMix input ${params.input} animation: ${params.animation}`;
}

async function vmixControlCountdown(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  const action = params.action || 'Start';
  await agent.vmix._call('Countdown' + action, { Input: params.input });
  return `vMix input ${params.input} countdown ${action.toLowerCase()}`;
}

async function vmixSetCountdown(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  await agent.vmix._call('SetCountdown', { Input: params.input, Value: params.duration });
  return `vMix input ${params.input} countdown set to ${params.duration}`;
}

async function vmixChangeCountdown(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  await agent.vmix._call('ChangeCountdown', { Input: params.input, Value: params.time });
  return `vMix input ${params.input} countdown changed`;
}

async function vmixAdjustCountdown(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  await agent.vmix._call('AdjustCountdown', { Input: params.input, Value: params.seconds });
  return `vMix input ${params.input} countdown adjusted by ${params.seconds}s`;
}

// ─── COMPANION PARITY: Virtual Set (1 command) ─────────────────────────────

async function vmixVirtualSet(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const preset = toInt(params.preset || 1, 'preset');
  await agent.vmix._call('SelectVirtualSet' + preset, { Input: params.input });
  return `vMix virtual set preset ${preset} selected`;
}

// ─── COMPANION PARITY: Audio — new commands (7) ─────────────────────────────

async function vmixFadeInputVolume(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  const duration = params.duration || 2000;
  await agent.vmix._call('SetVolumeFade', { Input: params.input, Value: params.volume + ',' + duration });
  return `vMix input ${params.input} volume fading to ${params.volume}% over ${duration}ms`;
}

async function vmixFadeBusVolume(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const bus = params.bus || 'A';
  const duration = params.duration || 2000;
  await agent.vmix._call('SetBus' + bus + 'VolumeFade', { Value: params.volume + ',' + duration });
  return `vMix bus ${bus} volume fading to ${params.volume}% over ${duration}ms`;
}

async function vmixAudioPluginOnOff(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  const action = params.action || 'OnOff';
  await agent.vmix._call('AudioPlugin' + action, { Input: params.input, Value: params.pluginIndex });
  return `vMix input ${params.input} audio plugin ${action.toLowerCase()}`;
}

async function vmixSetChannelVolume(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  const channel = toInt(params.channel, 'channel');
  await agent.vmix._call('SetVolumeChannel' + channel, { Input: params.input, Value: params.value });
  return `vMix input ${params.input} channel ${channel} volume set`;
}

async function vmixSetChannelMixerVolume(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  await agent.vmix._call('SetVolumeChannelMixer', { Input: params.input, Value: params.channel + ',' + params.value });
  return `vMix input ${params.input} channel mixer volume set`;
}

async function vmixSoloInput(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  const fn = params.on === false ? 'SoloOff' : 'Solo';
  await agent.vmix._call(fn, { Input: params.input });
  return `vMix input ${params.input} solo ${params.on === false ? 'off' : 'on'}`;
}

async function vmixSoloAllOff(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('SoloAllOff');
  return 'vMix all solo off';
}

// ─── COMPANION PARITY: Audio Presets (3 commands) ───────────────────────────

async function vmixLoadAudioPreset(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('AudioPresetLoad', { Value: params.name });
  return `vMix audio preset "${params.name}" loaded`;
}

async function vmixSaveAudioPreset(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('AudioPresetSave', { Value: params.name });
  return `vMix audio preset "${params.name}" saved`;
}

async function vmixDeleteAudioPreset(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('AudioPresetDelete', { Value: params.name });
  return `vMix audio preset "${params.name}" deleted`;
}

// ─── COMPANION PARITY: General (3 commands) ─────────────────────────────────

async function vmixKeyPress(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('KeyPress', { Value: params.key });
  return `vMix key press: ${params.key}`;
}

async function vmixTBar(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('SetFader', { Value: params.value });
  return `vMix T-Bar set to ${params.value}`;
}

async function vmixSetDynamicInput(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const type = params.type || 'Input';
  const index = params.index || 1;
  await agent.vmix._call('SetDynamic' + type + index, { Value: params.value });
  return `vMix dynamic ${type}${index} set to ${params.value}`;
}

// ─── COMPANION PARITY: Layer (8 commands) ───────────────────────────────────

async function vmixMultiViewOverlay(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const action = params.action || 'OnOff';
  await agent.vmix._call('MultiViewOverlay' + action, { Input: params.input, Value: params.layer || 1 });
  return `vMix multi-view overlay ${action.toLowerCase()}`;
}

async function vmixSetMultiViewOverlayInput(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('SetMultiViewOverlay', { Input: params.input, Value: params.layer + ',' + params.layerInput });
  return `vMix multi-view overlay layer ${params.layer} set`;
}

async function vmixSetMultiViewOverlayOnPreview(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('SetMultiViewOverlayOnPreview', { Value: params.layer + ',' + params.input });
  return `vMix multi-view overlay on preview set`;
}

async function vmixSetMultiViewOverlayOnProgram(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('SetMultiViewOverlayOnProgram', { Value: params.layer + ',' + params.input });
  return `vMix multi-view overlay on program set`;
}

async function vmixSetRoutableLayerDestination(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('SetMultiViewOverlayDestinationInput', { Value: params.input });
  return 'vMix routable layer destination set';
}

async function vmixSetRoutableLayerSource(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('SetMultiViewOverlaySourceInput', { Value: params.input });
  return 'vMix routable layer source set';
}

async function vmixSetLayerPosition(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  const value = [params.layer, params.x, params.y, params.width, params.height].filter(v => v != null).join(',');
  await agent.vmix._call('SetLayerPosition', { Input: params.input, Value: value });
  return `vMix input ${params.input} layer position set`;
}

async function vmixClearLayerSelection(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('ClearMultiViewOverlaySelection');
  return 'vMix multi-view overlay selection cleared';
}

// ─── COMPANION PARITY: List (3 commands) ────────────────────────────────────

async function vmixAutoPlayFirst(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const suffix = params.on === false ? 'Off' : params.on === true ? 'On' : 'OnOff';
  await agent.vmix._call('AutoPlayFirst' + suffix, { Input: params.input });
  return `vMix auto-play first ${suffix.toLowerCase()}`;
}

async function vmixAutoPlayNext(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const suffix = params.on === false ? 'Off' : params.on === true ? 'On' : 'OnOff';
  await agent.vmix._call('AutoPlayNext' + suffix, { Input: params.input });
  return `vMix auto-play next ${suffix.toLowerCase()}`;
}

async function vmixListShuffle(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('ListShuffle', { Input: params.input });
  return 'vMix list shuffled';
}

// ─── COMPANION PARITY: Media (3 commands) ───────────────────────────────────

async function vmixVideoAction(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const action = params.action || 'Play';
  await agent.vmix._call(action, { Input: params.input });
  return `vMix input ${params.input}: ${action}`;
}

async function vmixSetPlayhead(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  const fn = params.mode === 'adjust' ? 'SetPlayheadAdjust' : 'SetPlayhead';
  await agent.vmix._call(fn, { Input: params.input, Value: params.ms });
  return `vMix input ${params.input} playhead ${params.mode === 'adjust' ? 'adjusted' : 'set'}`;
}

async function vmixVideoMark(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  const action = params.action || 'MarkIn';
  await agent.vmix._call(action, { Input: params.input });
  return `vMix input ${params.input}: ${action}`;
}

// ─── COMPANION PARITY: Input (4 commands) ───────────────────────────────────

async function vmixInputEffect(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  const action = params.action || 'OnOff';
  await agent.vmix._call('Effect' + action, { Input: params.input, Value: params.index });
  return `vMix input ${params.input} effect ${action.toLowerCase()}`;
}

async function vmixInputEffectStrength(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  await agent.vmix._call('SetEffectStrength', { Input: params.input, Value: params.value });
  return `vMix input ${params.input} effect strength set`;
}

async function vmixResetInput(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  await agent.vmix._call('ResetInput', { Input: params.input });
  return `vMix input ${params.input} reset`;
}

async function vmixInputFrameDelay(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (params.input == null) throw new Error('input required');
  await agent.vmix._call('SetFrameDelay', { Input: params.input, Value: params.frames });
  return `vMix input ${params.input} frame delay set to ${params.frames}`;
}

// ─── COMPANION PARITY: Output (2 commands) ──────────────────────────────────

async function vmixSetOutput(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const output = params.output || '2';
  await agent.vmix._call('SetOutput' + output, { Value: params.source });
  return `vMix output ${output} set to ${params.source}`;
}

async function vmixToggleFunction(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  if (!params.action) throw new Error('action required');
  const state = params.state || 'StartStop';
  await agent.vmix._call(params.action + state);
  return `vMix ${params.action} ${state.toLowerCase()}`;
}

// ─── COMPANION PARITY: Util (2 commands) ────────────────────────────────────

async function vmixSelectMix(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const mix = toInt(params.mix, 'mix');
  await agent.vmix._call('SelectMix' + mix);
  return `vMix mix ${mix} selected`;
}

async function vmixSelectBus(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const bus = params.bus || 'Master';
  await agent.vmix._call('SelectBus' + bus);
  return `vMix bus ${bus} selected`;
}

// ─── COMPANION PARITY: Open Playlist (1 command) ───────────────────────────

async function vmixOpenPlaylist(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix._call('OpenPlayList', { Value: params.name });
  return `vMix playlist "${params.name}" opened`;
}

module.exports = {
  'vmix.status': vmixStatus,
  'vmix.startStream': vmixStartStream,
  'vmix.stopStream': vmixStopStream,
  'vmix.startRecording': vmixStartRecording,
  'vmix.stopRecording': vmixStopRecording,
  'vmix.cut': vmixCut,
  'vmix.fade': vmixFade,
  'vmix.setPreview': vmixSetPreview,
  'vmix.setProgram': vmixSetProgram,
  'vmix.listInputs': vmixListInputs,
  'vmix.setVolume': vmixSetVolume,
  'vmix.mute': vmixMute,
  'vmix.unmute': vmixUnmute,
  'vmix.preview': vmixPreview,
  'vmix.isRunning': vmixIsRunning,
  'vmix.function': vmixFunction,
  'vmix.startPlaylist': vmixStartPlaylist,
  'vmix.stopPlaylist': vmixStopPlaylist,
  'vmix.audioLevels': vmixAudioLevels,
  'vmix.fadeToBlack': vmixFadeToBlack,
  'vmix.setInputVolume': vmixSetInputVolume,
  'vmix.muteInput': vmixMuteInput,
  'vmix.unmuteInput': vmixUnmuteInput,
  'vmix.overlayInput': vmixOverlayInput,
  'vmix.overlayOff': vmixOverlayOff,
  'vmix.setText': vmixSetText,
  'vmix.replay': vmixReplay,

  // Companion parity: transition types
  'vmix.transition': vmixTransition,

  // Companion parity: input position/zoom/crop
  'vmix.setInputPosition': vmixSetInputPosition,
  'vmix.setInputZoom': vmixSetInputZoom,
  'vmix.setInputCrop': vmixSetInputCrop,

  // Companion parity: multicorder & external
  'vmix.startMultiCorder': vmixStartMultiCorder,
  'vmix.stopMultiCorder': vmixStopMultiCorder,
  'vmix.startExternal': vmixStartExternal,
  'vmix.stopExternal': vmixStopExternal,

  // Companion parity: fullscreen, loop, rename
  'vmix.toggleFullscreen': vmixToggleFullscreen,
  'vmix.setInputLoop': vmixSetInputLoop,
  'vmix.renameInput': vmixRenameInput,

  // Companion parity: colour correction
  'vmix.setColourCorrection': vmixSetColourCorrection,

  // Companion parity: audio bus routing
  'vmix.setInputAudioBus': vmixSetInputAudioBus,
  'vmix.setBusVolume': vmixSetBusVolume,
  'vmix.muteBus': vmixMuteBus,

  // Companion parity: NDI, layers, title, tally
  'vmix.setInputNDISource': vmixSetInputNDISource,
  'vmix.setLayerInput': vmixSetLayerInput,
  'vmix.setTitleField': vmixSetTitleField,
  'vmix.selectTitleIndex': vmixSelectTitleIndex,
  'vmix.getTallyState': vmixGetTallyState,

  // Companion parity: scripting
  'vmix.runScript': vmixRunScript,
  'vmix.stopScript': vmixStopScript,

  // Companion parity: snapshots
  'vmix.saveSnapshot': vmixSaveSnapshot,
  'vmix.loadSnapshot': vmixLoadSnapshot,

  // Companion parity: browser navigate
  'vmix.browserNavigate': vmixBrowserNavigate,

  // Companion parity: replay (33)
  'vmix.replayACamera': vmixReplayACamera,
  'vmix.replayBCamera': vmixReplayBCamera,
  'vmix.replayCamera': vmixReplayCamera,
  'vmix.replaySelectChannel': vmixReplaySelectChannel,
  'vmix.replaySwapChannels': vmixReplaySwapChannels,
  'vmix.replayMark': vmixReplayMark,
  'vmix.replayMoveInOut': vmixReplayMoveInOut,
  'vmix.replayUpdateInOut': vmixReplayUpdateInOut,
  'vmix.replaySelectEvents': vmixReplaySelectEvents,
  'vmix.replayChangeDirection': vmixReplayChangeDirection,
  'vmix.replayChangeSpeed': vmixReplayChangeSpeed,
  'vmix.replaySetSpeed': vmixReplaySetSpeed,
  'vmix.replayMoveEvent': vmixReplayMoveEvent,
  'vmix.replayMoveEventUp': vmixReplayMoveEventUp,
  'vmix.replayMoveEventDown': vmixReplayMoveEventDown,
  'vmix.replayFastForward': vmixReplayFastForward,
  'vmix.replayFastBackward': vmixReplayFastBackward,
  'vmix.replayJumpFrames': vmixReplayJumpFrames,
  'vmix.replayJumpToNow': vmixReplayJumpToNow,
  'vmix.replayLiveToggle': vmixReplayLiveToggle,
  'vmix.replayPlay': vmixReplayPlay,
  'vmix.replayPause': vmixReplayPause,
  'vmix.replayPlayEvent': vmixReplayPlayEvent,
  'vmix.replayPlaySelectedEventToOutput': vmixReplayPlaySelectedEventToOutput,
  'vmix.replayPlayEventsByID': vmixReplayPlayEventsByID,
  'vmix.replayPlayEventsByIDToOutput': vmixReplayPlayEventsByIDToOutput,
  'vmix.replayPlayLastEventToOutput': vmixReplayPlayLastEventToOutput,
  'vmix.replayPlayAllEventsToOutput': vmixReplayPlayAllEventsToOutput,
  'vmix.replayStopEvents': vmixReplayStopEvents,
  'vmix.replayToggleCamera': vmixReplayToggleCamera,
  'vmix.replayShowHide': vmixReplayShowHide,
  'vmix.replayRecording': vmixReplayRecording,
  'vmix.replayEventText': vmixReplayEventText,
  'vmix.replayEventTextClear': vmixReplayEventTextClear,

  // Companion parity: PTZ (3)
  'vmix.ptzMove': vmixPtzMove,
  'vmix.ptzFocusZoom': vmixPtzFocusZoom,
  'vmix.ptzVirtualInput': vmixPtzVirtualInput,

  // Companion parity: data sources (4)
  'vmix.dataSourceAutoNext': vmixDataSourceAutoNext,
  'vmix.dataSourceNextRow': vmixDataSourceNextRow,
  'vmix.dataSourcePreviousRow': vmixDataSourcePreviousRow,
  'vmix.dataSourceSelectRow': vmixDataSourceSelectRow,

  // Companion parity: advanced title (13)
  'vmix.setTextByLayer': vmixSetTextByLayer,
  'vmix.setTextColor': vmixSetTextColor,
  'vmix.setTextVisible': vmixSetTextVisible,
  'vmix.setShapeColor': vmixSetShapeColor,
  'vmix.setTitleImage': vmixSetTitleImage,
  'vmix.setTitleImageVisible': vmixSetTitleImageVisible,
  'vmix.nextTitlePreset': vmixNextTitlePreset,
  'vmix.previousTitlePreset': vmixPreviousTitlePreset,
  'vmix.titleBeginAnimation': vmixTitleBeginAnimation,
  'vmix.controlCountdown': vmixControlCountdown,
  'vmix.setCountdown': vmixSetCountdown,
  'vmix.changeCountdown': vmixChangeCountdown,
  'vmix.adjustCountdown': vmixAdjustCountdown,

  // Companion parity: virtual set (1)
  'vmix.virtualSet': vmixVirtualSet,

  // Companion parity: audio — new (7)
  'vmix.fadeInputVolume': vmixFadeInputVolume,
  'vmix.fadeBusVolume': vmixFadeBusVolume,
  'vmix.audioPluginOnOff': vmixAudioPluginOnOff,
  'vmix.setChannelVolume': vmixSetChannelVolume,
  'vmix.setChannelMixerVolume': vmixSetChannelMixerVolume,
  'vmix.soloInput': vmixSoloInput,
  'vmix.soloAllOff': vmixSoloAllOff,

  // Companion parity: audio presets (3)
  'vmix.loadAudioPreset': vmixLoadAudioPreset,
  'vmix.saveAudioPreset': vmixSaveAudioPreset,
  'vmix.deleteAudioPreset': vmixDeleteAudioPreset,

  // Companion parity: general (3)
  'vmix.keyPress': vmixKeyPress,
  'vmix.tBar': vmixTBar,
  'vmix.setDynamicInput': vmixSetDynamicInput,

  // Companion parity: layer (8)
  'vmix.multiViewOverlay': vmixMultiViewOverlay,
  'vmix.setMultiViewOverlayInput': vmixSetMultiViewOverlayInput,
  'vmix.setMultiViewOverlayOnPreview': vmixSetMultiViewOverlayOnPreview,
  'vmix.setMultiViewOverlayOnProgram': vmixSetMultiViewOverlayOnProgram,
  'vmix.setRoutableLayerDestination': vmixSetRoutableLayerDestination,
  'vmix.setRoutableLayerSource': vmixSetRoutableLayerSource,
  'vmix.setLayerPosition': vmixSetLayerPosition,
  'vmix.clearLayerSelection': vmixClearLayerSelection,

  // Companion parity: list (3)
  'vmix.autoPlayFirst': vmixAutoPlayFirst,
  'vmix.autoPlayNext': vmixAutoPlayNext,
  'vmix.listShuffle': vmixListShuffle,

  // Companion parity: media (3)
  'vmix.videoAction': vmixVideoAction,
  'vmix.setPlayhead': vmixSetPlayhead,
  'vmix.videoMark': vmixVideoMark,

  // Companion parity: input (4)
  'vmix.inputEffect': vmixInputEffect,
  'vmix.inputEffectStrength': vmixInputEffectStrength,
  'vmix.resetInput': vmixResetInput,
  'vmix.inputFrameDelay': vmixInputFrameDelay,

  // Companion parity: output (2)
  'vmix.setOutput': vmixSetOutput,
  'vmix.toggleFunction': vmixToggleFunction,

  // Companion parity: util (2)
  'vmix.selectMix': vmixSelectMix,
  'vmix.selectBus': vmixSelectBus,

  // Companion parity: open playlist
  'vmix.openPlaylist': vmixOpenPlaylist,
};
