/**
 * Command Handlers for Tally Client
 * Each handler receives (agent, params) and returns a result string or object.
 */

function toInt(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function normalizeTransitionStyle(style) {
  const raw = String(style || '').trim().toLowerCase();
  const table = {
    mix: 0,
    dip: 1,
    wipe: 2,
    dve: 3,
    stinger: 4,
    sting: 4,
  };
  if (!(raw in table)) {
    throw new Error('transition style must be one of: mix, dip, wipe, dve, stinger');
  }
  return { code: table[raw], name: raw === 'sting' ? 'stinger' : raw };
}

function isFakeAtem(agent) {
  return !!agent._fakeAtemMode;
}

function resolvePtzRef(params = {}) {
  if (params.cameraName) return String(params.cameraName);
  return Number.parseInt(params.camera || 1, 10) || 1;
}

function hasNetworkPtz(agent) {
  return !!agent.ptzManager?.hasCameras?.();
}

// ─── ATEM COMMANDS ──────────────────────────────────────────────────────────

async function atemCut(agent, params) {
  const me = toInt(params.me ?? 0, 'me');
  const input = params.input != null ? toInt(params.input, 'input') : null;
  await agent.atemCommand(async () => {
    if (input != null) {
      if (isFakeAtem(agent)) await agent.atem?.changeProgramInput(me, input);
      else await agent.atem?.changeProgramInput(input, me);
      return;
    }
    await agent.atem?.cut(me);
  });
  return input != null ? `Cut to input ${input}` : 'Cut executed';
}

async function atemAuto(agent, params) {
  await agent.atemCommand(() => agent.atem?.autoTransition(params.me || 0));
  return 'Auto transition executed';
}

async function atemSetProgram(agent, params) {
  const input = toInt(params.input, 'input');
  const me = toInt(params.me ?? 0, 'me');
  await agent.atemCommand(() => {
    if (isFakeAtem(agent)) return agent.atem?.changeProgramInput(me, input);
    return agent.atem?.changeProgramInput(input, me);
  });
  return `Program input set to ${input}`;
}

async function atemSetPreview(agent, params) {
  const input = toInt(params.input, 'input');
  const me = toInt(params.me ?? 0, 'me');
  await agent.atemCommand(() => {
    if (isFakeAtem(agent)) return agent.atem?.changePreviewInput(me, input);
    return agent.atem?.changePreviewInput(input, me);
  });
  return `Preview input set to ${input}`;
}

async function atemStartRecording(agent) {
  await agent.atemCommand(async () => {
    if (typeof agent.atem?.startRecording === 'function') return agent.atem.startRecording();
    if (typeof agent.atem?.setRecordingAction === 'function') return agent.atem.setRecordingAction({ action: 1 });
    throw new Error('ATEM recording start is not supported by this switcher');
  });
  return 'Recording started';
}

async function atemStopRecording(agent) {
  await agent.atemCommand(async () => {
    if (typeof agent.atem?.stopRecording === 'function') return agent.atem.stopRecording();
    if (typeof agent.atem?.setRecordingAction === 'function') return agent.atem.setRecordingAction({ action: 0 });
    throw new Error('ATEM recording stop is not supported by this switcher');
  });
  return 'Recording stopped';
}

async function atemFadeToBlack(agent, params) {
  const me = toInt(params.me ?? 0, 'me');
  await agent.atemCommand(async () => {
    if (typeof agent.atem?.fadeToBlack === 'function') return agent.atem.fadeToBlack(me);
    if (typeof agent.atem?.setFadeToBlackState === 'function') {
      return agent.atem.setFadeToBlackState(me, { isFullyBlack: params.black !== false });
    }
    throw new Error('ATEM fade-to-black is not supported by this switcher');
  });
  return 'Fade to black toggled';
}

async function atemSetInputLabel(agent, params) {
  const input = toInt(params.input, 'input');
  if (!params.longName) throw new Error('longName is required');
  const shortName = params.shortName || params.longName.substring(0, 4).toUpperCase();
  await agent.atemCommand(() => {
    if (isFakeAtem(agent)) {
      return agent.atem?.setInputSettings(input, {
        longName: params.longName,
        shortName,
      });
    }
    return agent.atem?.setInputSettings(
      { longName: params.longName, shortName },
      input
    );
  });
  return `Input ${input} labeled "${params.longName}"`;
}

async function atemRunMacro(agent, params) {
  const macroIndex = toInt(params.macroIndex ?? params.index ?? 0, 'macroIndex');
  await agent.atemCommand(async () => {
    if (typeof agent.atem?.macroRun === 'function') return agent.atem.macroRun(macroIndex);
    if (typeof agent.atem?.runMacro === 'function') return agent.atem.runMacro(macroIndex);
    throw new Error('ATEM macro run is not supported by this switcher');
  });
  return `Macro ${macroIndex} started`;
}

async function atemStopMacro(agent) {
  await agent.atemCommand(async () => {
    if (typeof agent.atem?.macroStop === 'function') return agent.atem.macroStop();
    if (typeof agent.atem?.stopMacro === 'function') return agent.atem.stopMacro();
    throw new Error('ATEM macro stop is not supported by this switcher');
  });
  return 'Macro stopped';
}

async function atemSetAux(agent, params) {
  const sourceInput = toInt(params.input, 'input');
  const auxOneBased = toInt(params.aux ?? params.bus ?? 1, 'aux');
  await agent.atemCommand(() => {
    if (isFakeAtem(agent)) return agent.atem?.setAuxSource(auxOneBased, sourceInput);
    const busZeroBased = Math.max(0, auxOneBased - 1);
    return agent.atem?.setAuxSource(sourceInput, busZeroBased);
  });
  return `Aux ${auxOneBased} set to input ${sourceInput}`;
}

async function atemSetTransitionStyle(agent, params) {
  const me = toInt(params.me ?? 0, 'me');
  const { code, name } = normalizeTransitionStyle(params.style);
  await agent.atemCommand(() => {
    if (isFakeAtem(agent)) return agent.atem?.setTransitionStyle(me, name);
    return agent.atem?.setTransitionStyle({ nextStyle: code }, me);
  });
  return `Transition style set to ${name}`;
}

async function atemSetTransitionRate(agent, params) {
  const me = toInt(params.me ?? 0, 'me');
  const rate = toInt(params.rate, 'rate');
  await agent.atemCommand(() => {
    if (isFakeAtem(agent) && typeof agent.atem?.setTransitionRate === 'function') {
      return agent.atem.setTransitionRate(me, rate);
    }
    return agent.atem?.setMixTransitionSettings({ rate }, me);
  });
  return `Transition rate set to ${rate}`;
}

async function atemSetDskOnAir(agent, params) {
  const keyer = toInt(params.keyer ?? params.key ?? 0, 'keyer');
  const onAir = params.onAir !== false;
  await agent.atemCommand(() => {
    if (isFakeAtem(agent) && typeof agent.atem?.setDownstreamKeyerOnAir === 'function') {
      return agent.atem.setDownstreamKeyerOnAir(keyer, onAir);
    }
    return agent.atem?.setDownstreamKeyOnAir(onAir, keyer);
  });
  return `DSK ${keyer + 1} ${onAir ? 'on-air' : 'off-air'}`;
}

async function atemSetDskTie(agent, params) {
  const keyer = toInt(params.keyer ?? params.key ?? 0, 'keyer');
  const tie = params.tie !== false;
  await agent.atemCommand(() => {
    if (isFakeAtem(agent) && typeof agent.atem?.setDownstreamKeyerTie === 'function') {
      return agent.atem.setDownstreamKeyerTie(keyer, tie);
    }
    return agent.atem?.setDownstreamKeyTie(tie, keyer);
  });
  return `DSK ${keyer + 1} tie ${tie ? 'enabled' : 'disabled'}`;
}

async function atemSetDskRate(agent, params) {
  const keyer = toInt(params.keyer ?? params.key ?? 0, 'keyer');
  const rate = toInt(params.rate, 'rate');
  await agent.atemCommand(() => {
    if (isFakeAtem(agent) && typeof agent.atem?.setDownstreamKeyerRate === 'function') {
      return agent.atem.setDownstreamKeyerRate(keyer, rate);
    }
    return agent.atem?.setDownstreamKeyRate(rate, keyer);
  });
  return `DSK ${keyer + 1} rate set to ${rate}`;
}

async function atemSetDskSource(agent, params) {
  const keyer = toInt(params.keyer ?? params.key ?? 0, 'keyer');
  const fillSource = toInt(params.fillSource, 'fillSource');
  const keySource = toInt(params.keySource, 'keySource');
  await agent.atemCommand(async () => {
    if (isFakeAtem(agent) && typeof agent.atem?.setDownstreamKeyerSource === 'function') {
      return agent.atem.setDownstreamKeyerSource(keyer, fillSource, keySource);
    }
    await agent.atem?.setDownstreamKeyFillSource(fillSource, keyer);
    await agent.atem?.setDownstreamKeyCutSource(keySource, keyer);
  });
  return `DSK ${keyer + 1} source set (fill ${fillSource}, key ${keySource})`;
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
  await agent.atemCommand(() => {
    if (typeof agent.atem?.setHyperDeckPlay !== 'function') {
      throw new Error('HyperDeck transport via ATEM is not supported by this switcher');
    }
    return agent.atem.setHyperDeckPlay(hd);
  });
  return `HyperDeck ${hd} playing`;
}

async function hyperdeckStop(agent, params) {
  const hd = params.hyperdeck || 0;
  await agent.atemCommand(() => {
    if (typeof agent.atem?.setHyperDeckStop !== 'function') {
      throw new Error('HyperDeck transport via ATEM is not supported by this switcher');
    }
    return agent.atem.setHyperDeckStop(hd);
  });
  return `HyperDeck ${hd} stopped`;
}

async function hyperdeckRecord(agent, params) {
  const hd = params.hyperdeck || 0;
  await agent.atemCommand(() => {
    if (typeof agent.atem?.setHyperDeckRecord !== 'function') {
      throw new Error('HyperDeck transport via ATEM is not supported by this switcher');
    }
    return agent.atem.setHyperDeckRecord(hd);
  });
  return `HyperDeck ${hd} recording`;
}

async function hyperdeckStopRecord(agent, params) {
  const hd = params.hyperdeck || 0;
  await agent.atemCommand(() => {
    if (typeof agent.atem?.setHyperDeckStop !== 'function') {
      throw new Error('HyperDeck transport via ATEM is not supported by this switcher');
    }
    return agent.atem.setHyperDeckStop(hd);
  });
  return `HyperDeck ${hd} recording stopped`;
}

async function hyperdeckNextClip(agent, params) {
  const hd = params.hyperdeck || 0;
  await agent.atemCommand(() => {
    if (typeof agent.atem?.setHyperDeckNextClip !== 'function') {
      throw new Error('HyperDeck transport via ATEM is not supported by this switcher');
    }
    return agent.atem.setHyperDeckNextClip(hd);
  });
  return `HyperDeck ${hd} next clip`;
}

async function hyperdeckPrevClip(agent, params) {
  const hd = params.hyperdeck || 0;
  await agent.atemCommand(() => {
    if (typeof agent.atem?.setHyperDeckPrevClip !== 'function') {
      throw new Error('HyperDeck transport via ATEM is not supported by this switcher');
    }
    return agent.atem.setHyperDeckPrevClip(hd);
  });
  return `HyperDeck ${hd} previous clip`;
}

// ─── PTZ CAMERA COMMANDS ────────────────────────────────────────────────────

async function ptzPan(agent, params) {
  const speed = params.speed || 0; // -1.0 to 1.0 (negative=left, positive=right)
  const camera = resolvePtzRef(params);
  if (hasNetworkPtz(agent)) {
    await agent.ptzManager.panTilt(camera, speed, 0, { durationMs: params.durationMs || 350 });
    return `PTZ camera ${camera} pan speed ${speed}`;
  }
  await agent.atemCommand(() => {
    if (typeof agent.atem?.setCameraControlPanTilt !== 'function') {
      throw new Error('ATEM PTZ pan/tilt control is not supported in this runtime');
    }
    return agent.atem.setCameraControlPanTilt(camera, speed, 0);
  });
  return `PTZ camera ${camera} pan speed ${speed}`;
}

async function ptzTilt(agent, params) {
  const speed = params.speed || 0;
  const camera = resolvePtzRef(params);
  if (hasNetworkPtz(agent)) {
    await agent.ptzManager.panTilt(camera, 0, speed, { durationMs: params.durationMs || 350 });
    return `PTZ camera ${camera} tilt speed ${speed}`;
  }
  await agent.atemCommand(() => {
    if (typeof agent.atem?.setCameraControlPanTilt !== 'function') {
      throw new Error('ATEM PTZ pan/tilt control is not supported in this runtime');
    }
    return agent.atem.setCameraControlPanTilt(camera, 0, speed);
  });
  return `PTZ camera ${camera} tilt speed ${speed}`;
}

async function ptzZoom(agent, params) {
  const speed = params.speed || 0; // negative=out, positive=in
  const camera = resolvePtzRef(params);
  if (hasNetworkPtz(agent)) {
    await agent.ptzManager.zoom(camera, speed, { durationMs: params.durationMs || 250 });
    return `PTZ camera ${camera} zoom speed ${speed}`;
  }
  await agent.atemCommand(() => {
    if (typeof agent.atem?.setCameraControlZoom !== 'function') {
      throw new Error('ATEM PTZ zoom control is not supported in this runtime');
    }
    return agent.atem.setCameraControlZoom(camera, speed);
  });
  return `PTZ camera ${camera} zoom speed ${speed}`;
}

async function ptzPreset(agent, params) {
  const preset = params.preset || 1;
  const camera = resolvePtzRef(params);
  if (hasNetworkPtz(agent)) {
    await agent.ptzManager.recallPreset(camera, preset, { zeroBasedPreset: !!params.zeroBasedPreset });
    return `PTZ camera ${camera} recalled preset ${preset}`;
  }
  // ATEM camera control — recall preset via macro or camera control protocol
  await agent.atemCommand(() => {
    if (typeof agent.atem?.setCameraControlPreset !== 'function') {
      throw new Error('ATEM PTZ preset recall is not supported in this runtime');
    }
    return agent.atem.setCameraControlPreset(camera, preset);
  });
  return `PTZ camera ${camera} recalled preset ${preset}`;
}

async function ptzStop(agent, params) {
  const camera = resolvePtzRef(params);
  if (hasNetworkPtz(agent)) {
    await agent.ptzManager.stop(camera, {
      panTilt: params.panTilt !== false,
      zoom: params.zoom !== false,
    });
    return `PTZ camera ${camera} stopped`;
  }
  const speed = 0;
  await ptzPan(agent, { ...params, camera, speed });
  await ptzTilt(agent, { ...params, camera, speed });
  await ptzZoom(agent, { ...params, camera, speed });
  return `PTZ camera ${camera} stopped`;
}

async function ptzHome(agent, params) {
  const camera = resolvePtzRef(params);
  if (hasNetworkPtz(agent)) {
    await agent.ptzManager.home(camera);
    return `PTZ camera ${camera} moved to home`;
  }
  throw new Error('PTZ home is only available for network PTZ cameras (ONVIF/VISCA)');
}

async function ptzSetPreset(agent, params) {
  const camera = resolvePtzRef(params);
  const preset = params.preset || 1;
  if (hasNetworkPtz(agent)) {
    const token = await agent.ptzManager.setPreset(camera, preset, params.name || '', {
      zeroBasedPreset: !!params.zeroBasedPreset,
    });
    return `PTZ camera ${camera} saved preset ${preset} (${token})`;
  }
  throw new Error('PTZ set preset is only available for network PTZ cameras (ONVIF/VISCA)');
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

async function propresenterClearAll(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  await agent.proPresenter.clearAll();
  return 'All layers cleared';
}

async function propresenterClearSlide(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  await agent.proPresenter.clearSlide();
  return 'Slide layer cleared';
}

async function propresenterStageMessage(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  if (!params.name) throw new Error('Message name required');
  await agent.proPresenter.triggerMessage(params.name, params.tokens || []);
  return `Stage message "${params.name}" triggered`;
}

async function propresenterClearMessage(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  await agent.proPresenter.clearMessages();
  return 'Stage messages cleared';
}

async function propresenterGetLooks(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const looks = await agent.proPresenter.getLooks();
  if (!looks.length) return 'No looks found';
  return looks.map(l => l.name).join('\n');
}

async function propresenterSetLook(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  if (!params.name) throw new Error('Look name required');
  const name = await agent.proPresenter.setLook(params.name);
  return `Look set to "${name}"`;
}

async function propresenterGetTimers(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const timers = await agent.proPresenter.getTimers();
  if (!timers.length) return 'No timers found';
  return timers.map(t => `${t.name}${t.allows_overrun ? ' (overrun)' : ''}`).join('\n');
}

async function propresenterStartTimer(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  if (!params.name) throw new Error('Timer name required');
  const name = await agent.proPresenter.startTimer(params.name);
  return `Timer "${name}" started`;
}

async function propresenterStopTimer(agent, params) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  if (!params.name) throw new Error('Timer name required');
  const name = await agent.proPresenter.stopTimer(params.name);
  return `Timer "${name}" stopped`;
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
  const ms = params.ms || params.duration || 2000;
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

// ─── PRESET COMMANDS ─────────────────────────────────────────────────────────

/**
 * Capture current equipment state and return it for the relay to save as a preset.
 * The relay receives this as a command_result and stores it in presetLibrary.
 */
async function presetSave(agent, params) {
  const steps = [];

  // Capture current mixer scene
  if (agent.mixer && agent.status.mixer?.connected) {
    try {
      const status = await agent.mixer.getStatus();
      if (status.scene != null) {
        steps.push({ type: 'mixer_scene', scene: status.scene });
      }
    } catch { /* mixer may not expose scene */ }
  }

  // Capture current OBS scene
  if (agent.obs && agent.status.obs?.connected) {
    try {
      const scene = await agent.obs.call('GetCurrentProgramScene');
      if (scene?.currentProgramSceneName) {
        steps.push({ type: 'obs_scene', sceneName: scene.currentProgramSceneName });
      }
    } catch { /* ignore */ }
  }

  // Capture vMix active input
  if (agent.vmix && agent.status.vmix?.connected) {
    try {
      const status = await agent.vmix.getStatus();
      if (status?.activeInput) {
        steps.push({ type: 'vmix_preset', inputName: String(status.activeInput) });
      }
    } catch { /* ignore */ }
  }

  // Capture Resolume playing column
  if (agent.resolume && agent.status.resolume?.connected) {
    try {
      const status = await agent.resolume.getStatus();
      if (status?.playing?.length > 0) {
        const col = status.currentColumn ?? status.playing[0]?.column;
        if (col != null) {
          steps.push({ type: 'resolume_column', columnIndex: col });
        }
      }
    } catch { /* ignore */ }
  }

  if (steps.length === 0) {
    throw new Error('No connected devices found to save state from');
  }

  const presetType = steps.length === 1 ? steps[0].type : 'named_bundle';
  return { presetType, steps, name: params.name };
}

/**
 * List saved presets via relay REST API.
 */
async function presetList(agent) {
  const { churchId, relayHttpBase, config } = agent;
  if (!churchId || !relayHttpBase) {
    throw new Error('Relay HTTP URL not available');
  }
  const resp = await fetch(`${relayHttpBase}/api/churches/${churchId}/presets`, {
    headers: { 'Authorization': `Bearer ${config.token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`Failed to list presets: ${resp.status}`);
  const presets = await resp.json();
  if (!presets.length) return 'No saved presets';
  return presets.map(p => `• ${p.name} (${p.type.replace(/_/g, ' ')})`).join('\n');
}

/**
 * Recall a named preset via relay REST API.
 */
async function presetRecall(agent, params) {
  const { churchId, relayHttpBase, config } = agent;
  if (!churchId || !relayHttpBase) throw new Error('Relay HTTP URL not available');
  const name = encodeURIComponent(params.name);
  const resp = await fetch(`${relayHttpBase}/api/churches/${churchId}/presets/${name}/recall`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Failed to recall preset: ${resp.status}`);
  return `Preset "${params.name}" recalled`;
}

/**
 * Delete a named preset via relay REST API.
 */
async function presetDelete(agent, params) {
  const { churchId, relayHttpBase, config } = agent;
  if (!churchId || !relayHttpBase) throw new Error('Relay HTTP URL not available');
  const name = encodeURIComponent(params.name);
  const resp = await fetch(`${relayHttpBase}/api/churches/${churchId}/presets/${name}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${config.token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`Failed to delete preset: ${resp.status}`);
  return `Preset "${params.name}" deleted`;
}

/**
 * obs.configureMonitorStream
 *
 * Remotely configures OBS to stream a secondary monitoring feed to the
 * Tally relay server.  This lets the admin push RTMP stream settings to
 * any church's OBS without visiting on-site.
 *
 * params:
 *   relayUrl   {string} RTMP base URL, e.g. rtmp://relay.example.com/live
 *   streamKey  {string} The church's stream key / token
 *   bitrate    {number} Target bitrate in kbps (default 3000)
 *   startStream {boolean} If true, also start streaming after config (default false)
 */
async function obsConfigureMonitorStream(agent, params) {
  if (!agent.obs) throw new Error('OBS not connected');

  const { relayUrl, streamKey, bitrate = 3000, startStream = false } = params || {};
  if (!relayUrl)  throw new Error('relayUrl is required');
  if (!streamKey) throw new Error('streamKey is required');

  // Build the full RTMP URL: rtmp://host/app/streamKey
  const serverUrl = relayUrl.endsWith('/') ? relayUrl.slice(0, -1) : relayUrl;

  // Configure the stream service to Custom RTMP
  await agent.obs.call('SetStreamServiceSettings', {
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
      const streamStatus = await agent.obs.call('GetStreamStatus');
      alreadyStreaming = streamStatus?.outputActive || false;
    } catch { /* GetStreamStatus may not be available on all OBS versions */ }

    if (!alreadyStreaming) {
      await agent.obs.call('StartStream');
      result += ' — stream started';
    } else {
      result += ' — already streaming (stream not restarted; use obs.stopStream then obs.startStream to apply)';
    }
  }

  return result;
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
  'atem.runMacro': atemRunMacro,
  'atem.stopMacro': atemStopMacro,
  'atem.setAux': atemSetAux,
  'atem.setTransitionStyle': atemSetTransitionStyle,
  'atem.setTransitionRate': atemSetTransitionRate,
  'atem.setDskOnAir': atemSetDskOnAir,
  'atem.setDskTie': atemSetDskTie,
  'atem.setDskRate': atemSetDskRate,
  'atem.setDskSource': atemSetDskSource,

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
  'ptz.stop': ptzStop,
  'ptz.home': ptzHome,
  'ptz.setPreset': ptzSetPreset,

  'obs.startStream': obsStartStream,
  'obs.stopStream': obsStopStream,
  'obs.startRecording': obsStartRecording,
  'obs.stopRecording': obsStopRecording,
  'obs.setScene': obsSetScene,
  'obs.configureMonitorStream': obsConfigureMonitorStream,

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
  'propresenter.clearAll': propresenterClearAll,
  'propresenter.clearSlide': propresenterClearSlide,
  'propresenter.stageMessage': propresenterStageMessage,
  'propresenter.clearMessage': propresenterClearMessage,
  'propresenter.getLooks': propresenterGetLooks,
  'propresenter.setLook': propresenterSetLook,
  'propresenter.getTimers': propresenterGetTimers,
  'propresenter.startTimer': propresenterStartTimer,
  'propresenter.stopTimer': propresenterStopTimer,

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

  'preset.save': presetSave,
  'preset.list': presetList,
  'preset.recall': presetRecall,
  'preset.delete': presetDelete,
};

module.exports = { commandHandlers };
