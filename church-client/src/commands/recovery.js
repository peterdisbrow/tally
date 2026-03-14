/**
 * Recovery command handlers — compound actions for auto-recovery.
 *
 * These are dispatched by the relay's AutoRecovery engine when it detects
 * failures like stream_stopped, recording_not_started, encoder_disconnected, etc.
 * Each handler orchestrates the appropriate stop-then-start sequence.
 */

/**
 * Restart the stream — stops then starts, routing to the correct device.
 * Params:
 *   source: 'obs' | 'atem' | 'vmix' | 'encoder' (default: auto-detect)
 */
async function recoveryRestartStream(agent, params) {
  const source = (params.source || '').toLowerCase();

  // OBS stream restart
  if (source === 'obs' || (!source && agent.obs && agent.status.obs?.connected)) {
    try { await agent.obs.call('StopStream'); } catch { /* may already be stopped */ }
    await new Promise(r => setTimeout(r, 2000));
    await agent.obs.call('StartStream');
    return 'OBS stream restarted (stop + start)';
  }

  // ATEM streaming restart
  if (source === 'atem' || (!source && agent.atem && agent.status.atem?.connected)) {
    if (typeof agent.atem.stopStreaming === 'function') {
      try { await agent.atem.stopStreaming(); } catch { /* may already be stopped */ }
      await new Promise(r => setTimeout(r, 2000));
      await agent.atem.startStreaming();
      return 'ATEM stream restarted (stop + start)';
    }
    throw new Error('ATEM model does not support remote streaming control');
  }

  // vMix stream restart
  if (source === 'vmix' || (!source && agent.vmix && agent.status.vmix?.connected)) {
    try { await agent.vmix.stopStream(); } catch { /* may already be stopped */ }
    await new Promise(r => setTimeout(r, 2000));
    await agent.vmix.startStream();
    return 'vMix stream restarted (stop + start)';
  }

  // Encoder stream restart
  if (source === 'encoder' || (!source && agent.encoderBridge)) {
    try { await agent.encoderBridge.stopStream(); } catch { /* may already be stopped */ }
    await new Promise(r => setTimeout(r, 2000));
    await agent.encoderBridge.startStream();
    return 'Encoder stream restarted (stop + start)';
  }

  throw new Error('No streaming device available for recovery');
}

/**
 * Restart recording — stops then starts recording on the detected device.
 */
async function recoveryRestartRecording(agent, params) {
  const source = (params.source || '').toLowerCase();

  // OBS recording
  if (source === 'obs' || (!source && agent.obs && agent.status.obs?.connected)) {
    try { await agent.obs.call('StopRecord'); } catch { /* may already be stopped */ }
    await new Promise(r => setTimeout(r, 2000));
    await agent.obs.call('StartRecord');
    return 'OBS recording restarted (stop + start)';
  }

  // vMix recording
  if (source === 'vmix' || (!source && agent.vmix && agent.status.vmix?.connected)) {
    try { await agent.vmix.stopRecording(); } catch { /* may already be stopped */ }
    await new Promise(r => setTimeout(r, 2000));
    await agent.vmix.startRecording();
    return 'vMix recording restarted (stop + start)';
  }

  // Encoder recording
  if (source === 'encoder' || (!source && agent.encoderBridge)) {
    try { await agent.encoderBridge.stopRecord(); } catch { /* may already be stopped */ }
    await new Promise(r => setTimeout(r, 2000));
    await agent.encoderBridge.startRecord();
    return 'Encoder recording restarted (stop + start)';
  }

  throw new Error('No recording device available for recovery');
}

/**
 * Reconnect a disconnected device — triggers reconnection logic.
 * Params:
 *   deviceId: optional specific device to reconnect
 */
async function recoveryReconnectDevice(agent, params) {
  const deviceId = (params.deviceId || '').toLowerCase();
  const results = [];

  // If a specific device is requested, reconnect just that one
  if (deviceId === 'atem' || (!deviceId && agent.atem && !agent.status.atem?.connected)) {
    if (typeof agent.reconnectAtem === 'function') {
      await agent.reconnectAtem();
      results.push('ATEM reconnection triggered');
    }
  }

  if (deviceId === 'obs' || (!deviceId && agent.obs && !agent.status.obs?.connected)) {
    if (typeof agent.reconnectObs === 'function') {
      await agent.reconnectObs();
      results.push('OBS reconnection triggered');
    }
  }

  if (deviceId === 'vmix' || (!deviceId && agent.vmix && !agent.status.vmix?.connected)) {
    if (typeof agent.reconnectVmix === 'function') {
      await agent.reconnectVmix();
      results.push('vMix reconnection triggered');
    }
  }

  if (deviceId === 'encoder' || (!deviceId && agent.encoderBridge && !agent.status.encoder?.connected)) {
    if (typeof agent.reconnectEncoder === 'function') {
      await agent.reconnectEncoder();
      results.push('Encoder reconnection triggered');
    }
  }

  if (deviceId === 'companion' || (!deviceId && agent.companion && !agent.status.companion?.connected)) {
    if (typeof agent.reconnectCompanion === 'function') {
      await agent.reconnectCompanion();
      results.push('Companion reconnection triggered');
    }
  }

  if (results.length === 0) {
    throw new Error('No disconnected devices found or no reconnect method available');
  }

  return results.join('; ');
}

/**
 * Restart the encoder — power-cycles the encoder bridge connection.
 */
async function recoveryRestartEncoder(agent) {
  if (!agent.encoderBridge) throw new Error('Encoder not configured');

  // Disconnect and reconnect the encoder bridge
  if (typeof agent.encoderBridge.disconnect === 'function') {
    try { await agent.encoderBridge.disconnect(); } catch { /* ignore */ }
  }
  await new Promise(r => setTimeout(r, 3000));
  if (typeof agent.reconnectEncoder === 'function') {
    await agent.reconnectEncoder();
  } else if (typeof agent.encoderBridge.connect === 'function') {
    await agent.encoderBridge.connect();
  }

  return 'Encoder restarted (disconnect + reconnect)';
}

/**
 * Reset audio — unmute master and restore fader levels.
 * Attempts mixer, then falls back to OBS/vMix audio controls.
 */
async function recoveryResetAudio(agent) {
  const results = [];

  // Try unmuting the mixer master output
  if (agent.mixer) {
    try {
      await agent.mixer.unmuteMaster();
      results.push('Mixer master unmuted');
    } catch (e) {
      results.push(`Mixer unmute failed: ${e.message}`);
    }
  }

  // Try unmuting OBS audio inputs
  if (agent.obs && agent.status.obs?.connected) {
    try {
      const data = await agent.obs.call('GetInputList');
      const audioInputs = (data.inputs || []).filter(i =>
        i.inputKind?.includes('wasapi') || i.inputKind?.includes('pulse') ||
        i.inputKind?.includes('alsa') || i.inputKind?.includes('coreaudio')
      );
      for (const input of audioInputs) {
        try {
          await agent.obs.call('SetInputMute', { inputName: input.inputName, inputMuted: false });
        } catch { /* ignore individual failures */ }
      }
      if (audioInputs.length > 0) {
        results.push(`OBS: unmuted ${audioInputs.length} audio input(s)`);
      }
    } catch (e) {
      results.push(`OBS audio reset failed: ${e.message}`);
    }
  }

  // Try unmuting vMix master
  if (agent.vmix && agent.status.vmix?.connected) {
    try {
      await agent.vmix.unmuteMaster();
      results.push('vMix master unmuted');
    } catch (e) {
      results.push(`vMix unmute failed: ${e.message}`);
    }
  }

  if (results.length === 0) {
    throw new Error('No audio devices available for reset');
  }

  return results.join('; ');
}

module.exports = {
  'recovery.restartStream': recoveryRestartStream,
  'recovery.restartRecording': recoveryRestartRecording,
  'recovery.reconnectDevice': recoveryReconnectDevice,
  'recovery.restartEncoder': recoveryRestartEncoder,
  'recovery.resetAudio': recoveryResetAudio,
};
