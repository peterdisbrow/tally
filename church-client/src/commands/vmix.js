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
};
