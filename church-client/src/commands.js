/**
 * Command Handlers for Tally Client
 * Each handler receives (agent, params) and returns a result string or object.
 */

// ─── ATEM COMMANDS ──────────────────────────────────────────────────────────

async function atemCut(agent, params) {
  await agent.atemCommand(() => agent.atem?.cut(params.me || 0));
  return 'Cut executed';
}

async function atemAuto(agent, params) {
  await agent.atemCommand(() => agent.atem?.autoTransition(params.me || 0));
  return 'Auto transition executed';
}

async function atemSetProgram(agent, params) {
  await agent.atemCommand(() => agent.atem?.changeProgramInput(params.me || 0, params.input));
  return `Program input set to ${params.input}`;
}

async function atemSetPreview(agent, params) {
  await agent.atemCommand(() => agent.atem?.changePreviewInput(params.me || 0, params.input));
  return `Preview input set to ${params.input}`;
}

async function atemStartRecording(agent) {
  await agent.atemCommand(() => agent.atem?.setRecordingAction({ action: 1 }));
  return 'Recording started';
}

async function atemStopRecording(agent) {
  await agent.atemCommand(() => agent.atem?.setRecordingAction({ action: 0 }));
  return 'Recording stopped';
}

async function atemFadeToBlack(agent, params) {
  await agent.atemCommand(() => agent.atem?.setFadeToBlackState(params.me || 0, { isFullyBlack: params.black !== false }));
  return 'Fade to black toggled';
}

async function atemSetInputLabel(agent, params) {
  const shortName = params.shortName || params.longName.substring(0, 4).toUpperCase();
  await agent.atemCommand(() => agent.atem?.setInputSettings(params.input, {
    longName: params.longName,
    shortName: shortName,
  }));
  return `Input ${params.input} labeled "${params.longName}"`;
}

// ─── VIDEOHUB COMMANDS ──────────────────────────────────────────────────────

async function videohubRoute(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  await hub.setRoute(params.output, params.input);
  return `Routed input ${params.input} → output ${params.output}`;
}

async function videohubGetRoutes(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  return await hub.getRoutes();
}

async function videohubSetInputLabel(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  await hub.setInputLabel(params.index, params.label);
  return `Input ${params.index} labeled "${params.label}"`;
}

async function videohubSetOutputLabel(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  await hub.setOutputLabel(params.index, params.label);
  return `Output ${params.index} labeled "${params.label}"`;
}

// ─── HYPERDECK COMMANDS ─────────────────────────────────────────────────────

async function hyperdeckPlay(agent, params) {
  const hd = params.hyperdeck || 0;
  await agent.atemCommand(() => agent.atem?.setHyperDeckPlay(hd));
  return `HyperDeck ${hd} playing`;
}

async function hyperdeckStop(agent, params) {
  const hd = params.hyperdeck || 0;
  await agent.atemCommand(() => agent.atem?.setHyperDeckStop(hd));
  return `HyperDeck ${hd} stopped`;
}

async function hyperdeckRecord(agent, params) {
  const hd = params.hyperdeck || 0;
  await agent.atemCommand(() => agent.atem?.setHyperDeckRecord(hd));
  return `HyperDeck ${hd} recording`;
}

async function hyperdeckStopRecord(agent, params) {
  const hd = params.hyperdeck || 0;
  await agent.atemCommand(() => agent.atem?.setHyperDeckStop(hd));
  return `HyperDeck ${hd} recording stopped`;
}

async function hyperdeckNextClip(agent, params) {
  const hd = params.hyperdeck || 0;
  await agent.atemCommand(() => agent.atem?.setHyperDeckNextClip(hd));
  return `HyperDeck ${hd} next clip`;
}

async function hyperdeckPrevClip(agent, params) {
  const hd = params.hyperdeck || 0;
  await agent.atemCommand(() => agent.atem?.setHyperDeckPrevClip(hd));
  return `HyperDeck ${hd} previous clip`;
}

// ─── PTZ CAMERA COMMANDS ────────────────────────────────────────────────────

async function ptzPan(agent, params) {
  const speed = params.speed || 0; // -1.0 to 1.0 (negative=left, positive=right)
  const camera = params.camera || 1;
  await agent.atemCommand(() => agent.atem?.setCameraControlPanTilt(camera, speed, 0));
  return `PTZ camera ${camera} pan speed ${speed}`;
}

async function ptzTilt(agent, params) {
  const speed = params.speed || 0;
  const camera = params.camera || 1;
  await agent.atemCommand(() => agent.atem?.setCameraControlPanTilt(camera, 0, speed));
  return `PTZ camera ${camera} tilt speed ${speed}`;
}

async function ptzZoom(agent, params) {
  const speed = params.speed || 0; // negative=out, positive=in
  const camera = params.camera || 1;
  await agent.atemCommand(() => agent.atem?.setCameraControlZoom(camera, speed));
  return `PTZ camera ${camera} zoom speed ${speed}`;
}

async function ptzPreset(agent, params) {
  const preset = params.preset || 1;
  const camera = params.camera || 1;
  // ATEM camera control — recall preset via macro or camera control protocol
  await agent.atemCommand(() => agent.atem?.setCameraControlPreset(camera, preset));
  return `PTZ camera ${camera} recalled preset ${preset}`;
}

// ─── OBS COMMANDS ───────────────────────────────────────────────────────────

async function obsStartStream(agent) {
  await agent.obs?.call('StartStream');
  return 'Stream started';
}

async function obsStopStream(agent) {
  await agent.obs?.call('StopStream');
  return 'Stream stopped';
}

async function obsStartRecording(agent) {
  await agent.obs?.call('StartRecord');
  return 'OBS recording started';
}

async function obsStopRecording(agent) {
  await agent.obs?.call('StopRecord');
  return 'OBS recording stopped';
}

async function obsSetScene(agent, params) {
  await agent.obs?.call('SetCurrentProgramScene', { sceneName: params.scene });
  return `Scene set to: ${params.scene}`;
}

// ─── PROPRESENTER COMMANDS ───────────────────────────────────────────────────

async function propresenterNext(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  await agent.proPresenter.nextSlide();
  return 'Next slide';
}

async function propresenterPrevious(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  await agent.proPresenter.previousSlide();
  return 'Previous slide';
}

async function propresenterGoToSlide(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  await agent.proPresenter.goToSlide(params.index);
  return `Jumped to slide ${params.index}`;
}

async function propresenterStatus(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const slide = await agent.proPresenter.getCurrentSlide();
  if (!slide) return 'ProPresenter not reachable';
  return `${slide.presentationName} — slide ${slide.slideIndex + 1}/${slide.slideTotal}`;
}

async function propresenterPlaylist(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const items = await agent.proPresenter.getPlaylist();
  if (!items.length) return 'No playlist items found';
  return items.map(i => i.name).join('\n');
}

async function propresenterIsRunning(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const running = await agent.proPresenter.isRunning();
  return running ? 'ProPresenter is running' : 'ProPresenter is not reachable';
}

// ─── VMIX COMMANDS ────────────────────────────────────────────────────────────

async function vmixStatus(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const status = await agent.vmix.getStatus();
  if (!status.running) return 'vMix is not reachable';
  const lines = [
    `vMix ${status.edition} ${status.version}`,
    `Program: ${status.activeInput} | Preview: ${status.previewInput}`,
    `Streaming: ${status.streaming ? '🔴 LIVE' : '⚫ Off'} | Recording: ${status.recording ? '⏺ On' : '⚫ Off'}`,
    `Inputs: ${status.inputCount}`,
  ];
  if (status.audio) {
    lines.push(`Master: ${status.audio.volume}% ${status.audio.muted ? '(MUTED)' : ''}`);
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
  const ms = params.duration || 2000;
  await agent.vmix.fade(ms);
  return `vMix: fade to preview (${ms}ms)`;
}

async function vmixSetPreview(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
  await agent.vmix.setPreview(params.input);
  return `vMix: preview set to input ${params.input}`;
}

async function vmixSetProgram(agent, params) {
  if (!agent.vmix) throw new Error('vMix not configured');
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
  const vol = await agent.vmix.setMasterVolume(params.value);
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
  return running ? 'vMix is running' : 'vMix is not reachable';
}

// ─── RESOLUME COMMANDS ────────────────────────────────────────────────────────

async function resolumeStatus(agent) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const status = await agent.resolume.getStatus();
  if (!status.running) return 'Resolume Arena is not reachable';
  const playing = status.playing.length
    ? status.playing.map(p => `${p.layer}: ${p.clip}`).join('\n')
    : 'Nothing playing';
  const bpm = status.bpm ? ` | BPM: ${status.bpm}` : '';
  return `Resolume running | ${status.layerCount} layers | ${status.columnCount} columns${bpm}\n${playing}`;
}

async function resolumePlayClip(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  if (params.name) {
    const result = await agent.resolume.playClipByName(params.name);
    return `Playing clip "${result.clip}" on layer "${result.layer}"`;
  }
  await agent.resolume.playClip(params.layer, params.clip);
  return `Playing clip (layer ${params.layer}, clip ${params.clip})`;
}

async function resolumeStopClip(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  await agent.resolume.stopClip(params.layer, params.clip);
  return `Stopped clip (layer ${params.layer}, clip ${params.clip})`;
}

async function resolumeTriggerColumn(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  if (params.name) {
    const colName = await agent.resolume.triggerColumnByName(params.name);
    return `Triggered column "${colName}"`;
  }
  await agent.resolume.triggerColumn(params.column);
  return `Triggered column ${params.column}`;
}

async function resolumeClearAll(agent) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  await agent.resolume.clearAll();
  return 'Resolume cleared — visual blackout';
}

async function resolumeSetLayerOpacity(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const val = await agent.resolume.setLayerOpacity(params.layer, params.value);
  return `Layer ${params.layer} opacity set to ${Math.round(val * 100)}%`;
}

async function resolumeSetMasterOpacity(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const val = await agent.resolume.setMasterOpacity(params.value);
  return `Master opacity set to ${Math.round(val * 100)}%`;
}

async function resolumeSetBpm(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const bpm = await agent.resolume.setBpm(params.bpm);
  return `BPM set to ${bpm}`;
}

async function resolumeGetLayers(agent) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const layers = await agent.resolume.getLayers();
  if (!layers.length) return 'No layers found';
  return layers.map((l, i) => `${l.id || i + 1}. ${l.name?.value || 'Unnamed'}`).join('\n');
}

async function resolumeGetColumns(agent) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const columns = await agent.resolume.getColumns();
  if (!columns.length) return 'No columns found';
  return columns.map((c, i) => `${c.id || i + 1}. ${c.name?.value || 'Unnamed'}`).join('\n');
}

async function resolumeIsRunning(agent) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const running = await agent.resolume.isRunning();
  return running ? 'Resolume Arena is running' : 'Resolume Arena is not reachable';
}

// ─── MIXER COMMANDS ──────────────────────────────────────────────────────────

async function mixerStatus(agent) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  const status = await agent.mixer.getStatus();
  if (!status.online) return `${status.type || 'Mixer'} console: not reachable`;
  const faderPct = Math.round((status.mainFader ?? 0) * 100);
  const lines = [
    `🎛️ ${status.type} console (${status.model || ''})`,
    `Status: ${status.online ? '✅ Online' : '❌ Offline'}`,
    `Main fader: ${faderPct}%`,
    `Main output: ${status.mainMuted ? '🔇 MUTED' : '🔊 Active'}`,
    status.scene != null ? `Current scene: ${status.scene}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

async function mixerMute(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  const ch = params.channel;
  if (ch === 'master' || ch === undefined) {
    await agent.mixer.muteMaster();
    return 'Master output muted';
  }
  await agent.mixer.muteChannel(ch);
  return `Channel ${ch} muted`;
}

async function mixerUnmute(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  const ch = params.channel;
  if (ch === 'master' || ch === undefined) {
    await agent.mixer.unmuteMaster();
    return 'Master output unmuted';
  }
  await agent.mixer.unmuteChannel(ch);
  return `Channel ${ch} unmuted`;
}

async function mixerChannelStatus(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  const ch = params.channel;
  if (!ch) throw new Error('channel parameter required');
  const status = await agent.mixer.getChannelStatus(ch);
  const faderPct = Math.round((status.fader ?? 0) * 100);
  return `Channel ${ch}: fader ${faderPct}% | ${status.muted ? '🔇 Muted' : '🔊 Active'}`;
}

async function mixerRecallScene(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  const scene = params.scene;
  if (scene == null) throw new Error('scene parameter required');
  await agent.mixer.recallScene(scene);
  return `Scene ${scene} recalled`;
}

async function mixerClearSolos(agent) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  await agent.mixer.clearSolos();
  return 'All solos cleared';
}

async function mixerIsOnline(agent) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  const online = await agent.mixer.isOnline();
  return online ? '✅ Audio console is reachable' : '❌ Audio console not reachable';
}

async function mixerSetFader(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  const { channel, level } = params;
  if (channel == null) throw new Error('channel parameter required');
  if (level == null) throw new Error('level parameter required (0.0–1.0)');
  await agent.mixer.setFader(channel, level);
  return `Channel ${channel} fader set to ${Math.round(parseFloat(level) * 100)}%`;
}

// ─── DANTE COMMANDS (via Companion) ─────────────────────────────────────────

async function danteScene(agent, params) {
  if (!agent.companion) throw new Error('Companion not configured — Dante scenes require Companion buttons prefixed with "Dante:"');
  await agent.companion.pressNamed(`Dante: ${params.name}`);
  return `Dante scene "${params.name}" triggered via Companion`;
}

// ─── SYSTEM COMMANDS ────────────────────────────────────────────────────────

function getStatus(agent) {
  return agent.status;
}

async function preServiceCheck(agent) {
  const checks = [];

  // 1. ATEM connection
  const atemConnected = agent.status.atem.connected;
  checks.push({ name: 'ATEM Connection', pass: atemConnected, detail: atemConnected ? 'Connected' : 'Not connected' });

  // 2. Camera inputs active (check for non-black on configured inputs)
  if (atemConnected && agent.atem) {
    try {
      const state = agent.atem.state;
      const inputs = state?.video?.mixEffects?.[0];
      const inputCount = Object.keys(state?.inputs || {}).length;
      let activeInputs = 0;
      let totalInputs = 0;
      for (const [id, input] of Object.entries(state?.inputs || {})) {
        if (input.internalPortType === 0) { // External inputs
          totalInputs++;
          // Check if input has a valid source (not black)
          if (input.isExternal !== false) activeInputs++;
        }
      }
      checks.push({
        name: 'Camera Inputs',
        pass: activeInputs > 0,
        detail: `${activeInputs}/${totalInputs} external inputs detected`,
      });
    } catch (e) {
      checks.push({ name: 'Camera Inputs', pass: false, detail: `Error checking: ${e.message}` });
    }
  } else {
    checks.push({ name: 'Camera Inputs', pass: false, detail: 'Cannot check — ATEM not connected' });
  }

  // 3. OBS connection and stream state
  const obsConnected = agent.status.obs.connected;
  checks.push({ name: 'OBS Connection', pass: obsConnected, detail: obsConnected ? 'Connected' : 'Not connected (optional)' });

  if (obsConnected) {
    const alreadyStreaming = agent.status.obs.streaming;
    checks.push({
      name: 'OBS Stream State',
      pass: !alreadyStreaming,
      detail: alreadyStreaming ? 'Already streaming (expected?)' : 'Not streaming — ready to go',
    });
  }

  // 4. Companion check
  if (agent.companion) {
    const companionAvail = await agent.companion.isAvailable();
    checks.push({ name: 'Companion', pass: companionAvail, detail: companionAvail ? 'Running' : 'Not reachable' });

    if (companionAvail) {
      try {
        const conns = await agent.companion.getConnections();
        checks.push({ name: 'Companion Connections', pass: conns.length > 0, detail: `${conns.length} connections configured` });
        const errors = conns.filter(c => c.hasError);
        if (errors.length > 0) {
          checks.push({ name: 'Companion Errors', pass: false, detail: `${errors.length} connection(s) with errors: ${errors.map(e => e.label).join(', ')}` });
        }
      } catch (e) {
        checks.push({ name: 'Companion Connections', pass: false, detail: `Error: ${e.message}` });
      }
    }
  }

  // 5. ProPresenter check
  if (agent.proPresenter) {
    const ppRunning = await agent.proPresenter.isRunning();
    checks.push({ name: 'ProPresenter', pass: ppRunning, detail: ppRunning ? 'Running' : 'Not reachable' });
    if (ppRunning) {
      const slide = await agent.proPresenter.getCurrentSlide();
      checks.push({ name: 'ProPresenter Presentation', pass: !!slide, detail: slide ? `Loaded: ${slide.presentationName}` : 'No presentation loaded' });
    }
  }

  // 6. vMix check (alternative to OBS)
  if (agent.vmix) {
    const vmixRunning = await agent.vmix.isRunning();
    checks.push({ name: 'vMix', pass: vmixRunning, detail: vmixRunning ? 'Running' : 'Not reachable' });
    if (vmixRunning) {
      const vs = await agent.vmix.getStatus();
      checks.push({ name: 'vMix Streaming', pass: vs.streaming, detail: vs.streaming ? '🔴 LIVE' : 'Not streaming (will start at service time)' });
    }
  }

  // 7. Audio console check
  if (agent.mixer) {
    const mixerOnline = await agent.mixer.isOnline().catch(() => false);
    checks.push({
      name: 'Audio Console',
      pass: mixerOnline,
      detail: mixerOnline ? `${agent.config.mixer?.type} reachable` : 'Console not reachable',
    });
    if (mixerOnline) {
      const mixerStatus = await agent.mixer.getStatus().catch(() => null);
      if (mixerStatus) {
        checks.push({
          name: 'Main Output',
          pass: !mixerStatus.mainMuted,
          detail: mixerStatus.mainMuted
            ? '⚠️ MASTER IS MUTED'
            : `Fader at ${Math.round(mixerStatus.mainFader * 100)}%`,
        });
      }
    }
  }

  // 8. Resolume Arena check
  if (agent.resolume) {
    const resRunning = await agent.resolume.isRunning();
    checks.push({ name: 'Resolume Arena', pass: resRunning, detail: resRunning ? 'Running' : 'Not reachable' });
    if (resRunning) {
      const status = await agent.resolume.getStatus();
      const layerCount = status.layerCount || 0;
      checks.push({ name: 'Resolume Composition', pass: layerCount > 0, detail: layerCount > 0 ? `${layerCount} layers, ${status.columnCount || 0} columns loaded` : 'No composition loaded' });
    }
  }

  const allPass = checks.every(c => c.pass);
  return { pass: allPass, checks };
}

// ─── PREVIEW COMMANDS ───────────────────────────────────────────────────────

async function previewStart(agent, params) {
  const intervalMs = params.intervalMs || 5000;
  agent.startPreview(intervalMs);
  return `Preview started (every ${intervalMs}ms)`;
}

async function previewStop(agent) {
  agent.stopPreview();
  return 'Preview stopped';
}

async function previewSnap(agent) {
  const frame = await agent.capturePreviewFrame();
  if (!frame) throw new Error('Could not capture preview — OBS not connected');
  return { snapshot: true, size: frame.data.length };
}

// ─── COMPANION COMMANDS ─────────────────────────────────────────────────────

async function companionPress(agent, params) {
  if (!agent.companion) throw new Error('Companion not configured');
  const result = await agent.companion.pressButton(params.page, params.row, params.col);
  return `Companion button pressed: page ${params.page}, row ${params.row}, col ${params.col}`;
}

async function companionPressNamed(agent, params) {
  if (!agent.companion) throw new Error('Companion not configured');
  await agent.companion.pressNamed(params.name);
  return `Companion button "${params.name}" pressed`;
}

async function companionGetGrid(agent, params) {
  if (!agent.companion) throw new Error('Companion not configured');
  return await agent.companion.getButtonGrid(params.page || 1);
}

async function companionConnections(agent) {
  if (!agent.companion) throw new Error('Companion not configured');
  return await agent.companion.getConnections();
}

// ─── AUTOMATION COMMANDS ────────────────────────────────────────────────────

async function obsReduceBitrate(agent, params) {
  if (!agent.obs || !agent.status.obs.connected) throw new Error('OBS not connected');
  const reductionPercent = params.reductionPercent || 20;
  const settings = await agent.obs.call('GetStreamServiceSettings');
  const currentBitrate = parseInt(settings.streamServiceSettings?.bitsPerSecond || settings.streamServiceSettings?.bitrate || '4500', 10);
  const newBitrate = Math.round(currentBitrate * (1 - reductionPercent / 100));
  const newSettings = { ...settings.streamServiceSettings };
  // OBS stores bitrate in different keys depending on service type
  if (newSettings.bitsPerSecond !== undefined) newSettings.bitsPerSecond = newBitrate;
  else newSettings.bitrate = String(newBitrate);
  await agent.obs.call('SetStreamServiceSettings', {
    streamServiceType: settings.streamServiceType,
    streamServiceSettings: newSettings,
  });
  return `Bitrate reduced by ${reductionPercent}%: ${currentBitrate} → ${newBitrate}`;
}

function systemSetWatchdogMode(agent, params) {
  agent.watchdogActive = params.active !== false;
  return `Watchdog ${agent.watchdogActive ? 'enabled' : 'disabled'}`;
}

function systemGetServiceWindow(agent) {
  return { inWindow: agent.watchdogActive || false, watchdogActive: agent.watchdogActive || false };
}

// ─── COMMAND REGISTRY ───────────────────────────────────────────────────────

const commandHandlers = {
  'atem.cut': atemCut,
  'atem.auto': atemAuto,
  'atem.setProgram': atemSetProgram,
  'atem.setPreview': atemSetPreview,
  'atem.startRecording': atemStartRecording,
  'atem.stopRecording': atemStopRecording,
  'atem.fadeToBlack': atemFadeToBlack,
  'atem.setInputLabel': atemSetInputLabel,

  'hyperdeck.play': hyperdeckPlay,
  'hyperdeck.stop': hyperdeckStop,
  'hyperdeck.record': hyperdeckRecord,
  'hyperdeck.stopRecord': hyperdeckStopRecord,
  'hyperdeck.nextClip': hyperdeckNextClip,
  'hyperdeck.prevClip': hyperdeckPrevClip,

  'ptz.pan': ptzPan,
  'ptz.tilt': ptzTilt,
  'ptz.zoom': ptzZoom,
  'ptz.preset': ptzPreset,

  'obs.startStream': obsStartStream,
  'obs.stopStream': obsStopStream,
  'obs.startRecording': obsStartRecording,
  'obs.stopRecording': obsStopRecording,
  'obs.setScene': obsSetScene,

  'status': getStatus,
  'system.preServiceCheck': preServiceCheck,

  'preview.start': previewStart,
  'preview.stop': previewStop,
  'preview.snap': previewSnap,

  'obs.reduceBitrate': obsReduceBitrate,
  'system.setWatchdogMode': systemSetWatchdogMode,
  'system.getServiceWindow': systemGetServiceWindow,

  'videohub.route': videohubRoute,
  'videohub.getRoutes': videohubGetRoutes,
  'videohub.setInputLabel': videohubSetInputLabel,
  'videohub.setOutputLabel': videohubSetOutputLabel,

  'propresenter.next': propresenterNext,
  'propresenter.previous': propresenterPrevious,
  'propresenter.goToSlide': propresenterGoToSlide,
  'propresenter.status': propresenterStatus,
  'propresenter.playlist': propresenterPlaylist,
  'propresenter.isRunning': propresenterIsRunning,

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

  'resolume.status': resolumeStatus,
  'resolume.playClip': resolumePlayClip,
  'resolume.stopClip': resolumeStopClip,
  'resolume.triggerColumn': resolumeTriggerColumn,
  'resolume.clearAll': resolumeClearAll,
  'resolume.setLayerOpacity': resolumeSetLayerOpacity,
  'resolume.setMasterOpacity': resolumeSetMasterOpacity,
  'resolume.setBpm': resolumeSetBpm,
  'resolume.getLayers': resolumeGetLayers,
  'resolume.getColumns': resolumeGetColumns,
  'resolume.isRunning': resolumeIsRunning,

  'mixer.status': mixerStatus,
  'mixer.mute': mixerMute,
  'mixer.unmute': mixerUnmute,
  'mixer.channelStatus': mixerChannelStatus,
  'mixer.recallScene': mixerRecallScene,
  'mixer.clearSolos': mixerClearSolos,
  'mixer.isOnline': mixerIsOnline,
  'mixer.setFader': mixerSetFader,

  'dante.scene': danteScene,

  'companion.press': companionPress,
  'companion.pressNamed': companionPressNamed,
  'companion.getGrid': companionGetGrid,
  'companion.connections': companionConnections,
};

module.exports = { commandHandlers };
