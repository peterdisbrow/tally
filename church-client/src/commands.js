/**
 * Command Handlers for Tally Client
 * Each handler receives (agent, params) and returns a result string or object.
 */

const { collectDiagnosticBundle } = require('./diagnosticBundle');

function toInt(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

// ─── Fairlight enum mappings (accept both strings and integers) ─────────────

const FAIRLIGHT_MIX_OPTION = {
  off: 0, '0': 0,
  on: 1, '1': 1,
  audiofollowvideo: 2, afv: 2, '2': 2,
};

const FAIRLIGHT_EQ_SHAPE = {
  lowshelf: 0, 'low shelf': 0, '0': 0,
  lowpass: 1, 'low pass': 1, '1': 1,
  bell: 2, '2': 2,
  notch: 3, '3': 3,
  highpass: 4, 'high pass': 4, '4': 4,
  highshelf: 5, 'high shelf': 5, '5': 5,
};

const FAIRLIGHT_FREQ_RANGE = {
  low: 0, '0': 0,
  mid: 1, '1': 1,
  high: 2, '2': 2,
};

function toFairlightEnum(value, map, name) {
  if (value == null) return undefined;
  const key = String(value).trim().toLowerCase().replace(/[^a-z0-9 ]/g, '');
  if (key in map) return map[key];
  const num = Number.parseInt(value, 10);
  if (Number.isFinite(num)) return num;
  throw new Error(`${name}: unknown value "${value}". Expected one of: ${Object.keys(map).filter(k => isNaN(k)).join(', ')}`);
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

/**
 * Validate ATEM camera input number. If the ATEM reports available inputs,
 * check that the requested input exists. Returns early for non-camera sources
 * (e.g. color bars 1000+, media player 3010+, etc.).
 */
function validateAtemInput(agent, input) {
  if (input == null || input >= 1000) return; // special sources are fine
  const labels = agent.status?.atem?.inputLabels;
  if (!labels || typeof labels !== 'object') return; // can't validate without labels
  const knownIds = Object.keys(labels).map(Number).filter((n) => n >= 1 && n <= 40);
  if (knownIds.length === 0) return; // no label data
  if (!knownIds.includes(input)) {
    const available = knownIds.sort((a, b) => a - b).join(', ');
    throw new Error(`Camera ${input} doesn't exist on this switcher. Available inputs: ${available}. Try one of those instead.`);
  }
}

const SPECIAL_INPUT_NAMES = {
  1000: 'Color Bars', 2001: 'Color 1', 2002: 'Color 2',
  3010: 'Media Player 1', 3020: 'Media Player 2',
  6000: 'SuperSource', 7001: 'Clean Feed 1', 7002: 'Clean Feed 2',
  10010: 'Program', 10011: 'Preview',
};

function friendlyInputName(input, agent) {
  if (SPECIAL_INPUT_NAMES[input]) return SPECIAL_INPUT_NAMES[input];
  const labels = agent?.status?.atem?.inputLabels;
  if (labels && labels[input]) return labels[input];
  return `Camera ${input}`;
}

function resolvePtzRef(params = {}) {
  if (params.cameraName) return String(params.cameraName);
  return Number.parseInt(params.camera || 1, 10) || 1;
}

function hasNetworkPtz(agent) {
  return !!agent.ptzManager?.hasCameras?.();
}

function resolveHyperDeckIndex(params = {}) {
  const raw = Number.parseInt(params.hyperdeck ?? params.index ?? 0, 10);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw - 1;
}

function getHyperDeckLabel(indexZeroBased) {
  return Number(indexZeroBased) + 1;
}

function getDirectHyperDeck(agent, indexZeroBased) {
  return Array.isArray(agent.hyperdecks) ? agent.hyperdecks[indexZeroBased] || null : null;
}

async function runHyperDeckDirectOrAtem(agent, params, options) {
  const index = resolveHyperDeckIndex(params);
  const direct = getDirectHyperDeck(agent, index);

  if (direct) {
    try {
      if (!direct.connected && typeof direct.connect === 'function') {
        await direct.connect();
      }
      if (direct.connected) {
        await options.direct(direct, index);
        if (typeof agent._updateHyperDeckStatus === 'function') agent._updateHyperDeckStatus();
        if (typeof agent.sendStatus === 'function') agent.sendStatus();
        return { mode: 'direct', index };
      }
    } catch {
      // Keep legacy ATEM fallback when direct HyperDeck is unreachable.
    }
  }

  await agent.atemCommand(() => {
    if (typeof agent.atem?.[options.atemMethod] !== 'function') {
      throw new Error('HyperDeck control is not available (configure HyperDeck IPs or use an ATEM model with HyperDeck bridge)');
    }
    return agent.atem[options.atemMethod](index);
  });
  return { mode: 'atem', index };
}

function ensureEncoderBridge(agent) {
  if (!agent.encoderBridge) throw new Error('Encoder not configured');
  return agent.encoderBridge;
}

function ensureObs(agent) {
  if (!agent.obs || !agent.status.obs?.connected) throw new Error('OBS not connected');
  return agent.obs;
}

// ─── ATEM COMMANDS ──────────────────────────────────────────────────────────

async function atemCut(agent, params) {
  const me = toInt(params.me ?? 0, 'me');
  const input = params.input != null ? toInt(params.input, 'input') : null;
  if (input != null) validateAtemInput(agent, input);
  await agent.atemCommand(async () => {
    if (input != null) {
      if (isFakeAtem(agent)) await agent.atem?.changeProgramInput(me, input);
      else await agent.atem?.changeProgramInput(input, me);
      return;
    }
    await agent.atem?.cut(me);
  });
  return input != null ? `Cut to ${friendlyInputName(input, agent)}` : 'Cut executed';
}

async function atemAuto(agent, params) {
  await agent.atemCommand(() => agent.atem?.autoTransition(params.me || 0));
  return 'Auto transition executed';
}

async function atemSetProgram(agent, params) {
  const input = toInt(params.input, 'input');
  const me = toInt(params.me ?? 0, 'me');
  validateAtemInput(agent, input);
  await agent.atemCommand(() => {
    if (isFakeAtem(agent)) return agent.atem?.changeProgramInput(me, input);
    return agent.atem?.changeProgramInput(input, me);
  });
  return `Program set to ${friendlyInputName(input, agent)}`;
}

async function atemSetPreview(agent, params) {
  const input = toInt(params.input, 'input');
  const me = toInt(params.me ?? 0, 'me');
  validateAtemInput(agent, input);
  await agent.atemCommand(() => {
    if (isFakeAtem(agent)) return agent.atem?.changePreviewInput(me, input);
    return agent.atem?.changePreviewInput(input, me);
  });
  return `Preview set to ${friendlyInputName(input, agent)}`;
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

async function atemStartStreaming(agent) {
  await agent.atemCommand(async () => {
    if (typeof agent.atem?.startStreaming === 'function') return agent.atem.startStreaming();
    throw new Error('ATEM streaming start is not supported by this switcher');
  });
  return 'Streaming started';
}

async function atemStopStreaming(agent) {
  await agent.atemCommand(async () => {
    if (typeof agent.atem?.stopStreaming === 'function') return agent.atem.stopStreaming();
    throw new Error('ATEM streaming stop is not supported by this switcher');
  });
  return 'Streaming stopped';
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
  const ok = await hub.setRoute(params.output, params.input);
  if (!ok) throw new Error('Video Hub did not acknowledge route change');
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
  const ok = await hub.setInputLabel(params.index, params.label);
  if (!ok) throw new Error('Video Hub did not acknowledge input label change');
  return `Input ${params.index} labeled "${params.label}"`;
}

async function videohubSetOutputLabel(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  const ok = await hub.setOutputLabel(params.index, params.label);
  if (!ok) throw new Error('Video Hub did not acknowledge output label change');
  return `Output ${params.index} labeled "${params.label}"`;
}

async function videohubGetInputLabels(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  const labels = await hub.getInputLabels();
  if (!labels.length) return 'No input labels found';
  return labels.map(l => `${l.index}: ${l.label}`).join('\n');
}

async function videohubGetOutputLabels(agent, params) {
  const hub = agent.videoHubs?.[params.hubIndex || 0];
  if (!hub) throw new Error('Video Hub not configured');
  const labels = await hub.getOutputLabels();
  if (!labels.length) return 'No output labels found';
  return labels.map(l => `${l.index}: ${l.label}`).join('\n');
}

// ─── HYPERDECK COMMANDS ─────────────────────────────────────────────────────

async function hyperdeckPlay(agent, params) {
  const result = await runHyperDeckDirectOrAtem(agent, params, {
    direct: (deck) => deck.play(),
    atemMethod: 'setHyperDeckPlay',
  });
  return `HyperDeck ${getHyperDeckLabel(result.index)} playing`;
}

async function hyperdeckStop(agent, params) {
  const result = await runHyperDeckDirectOrAtem(agent, params, {
    direct: (deck) => deck.stop(),
    atemMethod: 'setHyperDeckStop',
  });
  return `HyperDeck ${getHyperDeckLabel(result.index)} stopped`;
}

async function hyperdeckRecord(agent, params) {
  const result = await runHyperDeckDirectOrAtem(agent, params, {
    direct: (deck) => deck.record(),
    atemMethod: 'setHyperDeckRecord',
  });
  return `HyperDeck ${getHyperDeckLabel(result.index)} recording`;
}

async function hyperdeckStopRecord(agent, params) {
  const result = await runHyperDeckDirectOrAtem(agent, params, {
    direct: (deck) => deck.stop(),
    atemMethod: 'setHyperDeckStop',
  });
  return `HyperDeck ${getHyperDeckLabel(result.index)} recording stopped`;
}

async function hyperdeckNextClip(agent, params) {
  const result = await runHyperDeckDirectOrAtem(agent, params, {
    direct: (deck) => deck.nextClip(),
    atemMethod: 'setHyperDeckNextClip',
  });
  return `HyperDeck ${getHyperDeckLabel(result.index)} next clip`;
}

async function hyperdeckPrevClip(agent, params) {
  const result = await runHyperDeckDirectOrAtem(agent, params, {
    direct: (deck) => deck.prevClip(),
    atemMethod: 'setHyperDeckPrevClip',
  });
  return `HyperDeck ${getHyperDeckLabel(result.index)} previous clip`;
}

async function hyperdeckStatus(agent, params) {
  const index = resolveHyperDeckIndex(params);
  const direct = getDirectHyperDeck(agent, index);
  if (!direct) throw new Error(`HyperDeck ${getHyperDeckLabel(index)} not configured`);
  const status = await direct.refreshStatus();
  const label = status.name || `HyperDeck ${getHyperDeckLabel(index)}`;
  const modelInfo = [status.model, status.protocolVersion ? `v${status.protocolVersion}` : null].filter(Boolean).join(' · ');

  if (!status.connected) {
    return `🎬 ${label} — ❌ Offline\n\nHyperDeck is not responding. Check power and network connection.`;
  }

  const transportLabel = (status.transport || 'unknown').replace(/([a-z])([A-Z])/g, '$1 $2');
  const lines = [
    `🎬 ${label} — ✅ Connected`,
    modelInfo ? `📦 ${modelInfo}` : null,
    '',
    status.recording
      ? '⏺️  Recording: Active'
      : '⚫ Recording: Off',
    `🔄 Transport: ${transportLabel.charAt(0).toUpperCase() + transportLabel.slice(1)}`,
    status.clipId != null ? `🎞️  Clip: ${status.clipId}` : null,
    status.slotId != null ? `💾 Slot: ${status.slotId}` : null,
  ].filter(l => l != null);

  return lines.join('\n');
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

// ─── PTZ EXTENDED COMMANDS (VISCA focus, white balance) ─────────────────────

async function ptzAutoFocus(agent, params) {
  if (!hasNetworkPtz(agent)) throw new Error('PTZ focus control requires network PTZ cameras (VISCA)');
  const camera = resolvePtzRef(params);
  await agent.ptzManager.autoFocus(camera);
  return `PTZ camera ${camera}: auto focus enabled`;
}

async function ptzManualFocus(agent, params) {
  if (!hasNetworkPtz(agent)) throw new Error('PTZ focus control requires network PTZ cameras (VISCA)');
  const camera = resolvePtzRef(params);
  await agent.ptzManager.manualFocus(camera);
  return `PTZ camera ${camera}: manual focus mode`;
}

async function ptzFocusNear(agent, params) {
  if (!hasNetworkPtz(agent)) throw new Error('PTZ focus control requires network PTZ cameras (VISCA)');
  const camera = resolvePtzRef(params);
  const speed = params.speed != null ? Number(params.speed) : 3;
  await agent.ptzManager.focusNear(camera, speed);
  return `PTZ camera ${camera}: focusing near`;
}

async function ptzFocusFar(agent, params) {
  if (!hasNetworkPtz(agent)) throw new Error('PTZ focus control requires network PTZ cameras (VISCA)');
  const camera = resolvePtzRef(params);
  const speed = params.speed != null ? Number(params.speed) : 3;
  await agent.ptzManager.focusFar(camera, speed);
  return `PTZ camera ${camera}: focusing far`;
}

async function ptzFocusStop(agent, params) {
  if (!hasNetworkPtz(agent)) throw new Error('PTZ focus control requires network PTZ cameras (VISCA)');
  const camera = resolvePtzRef(params);
  await agent.ptzManager.focusStop(camera);
  return `PTZ camera ${camera}: focus stopped`;
}

async function ptzAutoWhiteBalance(agent, params) {
  if (!hasNetworkPtz(agent)) throw new Error('PTZ white balance control requires network PTZ cameras (VISCA)');
  const camera = resolvePtzRef(params);
  await agent.ptzManager.setAutoWhiteBalance(camera);
  return `PTZ camera ${camera}: auto white balance`;
}

async function ptzIndoorWhiteBalance(agent, params) {
  if (!hasNetworkPtz(agent)) throw new Error('PTZ white balance control requires network PTZ cameras (VISCA)');
  const camera = resolvePtzRef(params);
  await agent.ptzManager.setIndoorWhiteBalance(camera);
  return `PTZ camera ${camera}: indoor white balance`;
}

async function ptzOutdoorWhiteBalance(agent, params) {
  if (!hasNetworkPtz(agent)) throw new Error('PTZ white balance control requires network PTZ cameras (VISCA)');
  const camera = resolvePtzRef(params);
  await agent.ptzManager.setOutdoorWhiteBalance(camera);
  return `PTZ camera ${camera}: outdoor white balance`;
}

async function ptzOnePushWb(agent, params) {
  if (!hasNetworkPtz(agent)) throw new Error('PTZ white balance control requires network PTZ cameras (VISCA)');
  const camera = resolvePtzRef(params);
  await agent.ptzManager.setOnePushWhiteBalance(camera);
  return `PTZ camera ${camera}: one-push white balance triggered`;
}

async function ptzBacklightComp(agent, params) {
  if (!hasNetworkPtz(agent)) throw new Error('PTZ backlight compensation requires network PTZ cameras (VISCA)');
  const camera = resolvePtzRef(params);
  const enabled = params.enabled !== false && params.enabled !== 'false';
  await agent.ptzManager.setBacklightComp(camera, enabled);
  return `PTZ camera ${camera}: backlight compensation ${enabled ? 'on' : 'off'}`;
}

// ─── BLACKMAGIC CAMERA CONTROL (via ATEM) ───────────────────────────────────

const CAMERA_CTRL = {
  // Blackmagic Camera Control Protocol categories & parameters
  LENS: 0,
  VIDEO: 1,
  COLOR: 8,
  // Lens parameters
  FOCUS: 0,
  AUTO_FOCUS: 1,
  IRIS: 2,
  AUTO_IRIS: 3,
  // Video parameters
  GAIN: 1,
  WHITE_BALANCE: 2,
  AUTO_WB: 3,
  SHUTTER_SPEED: 5,
  SHUTTER_ANGLE: 8,
  ISO: 13,
  // Color correction parameters
  LIFT: 0,
  GAMMA: 1,
  COLOR_GAIN: 2,
  OFFSET: 3,
  CONTRAST: 4,
  LUM_MIX: 5,
  HUE_SAT: 6,
};

let _atemCommands = null;
function getAtemCommands() {
  if (!_atemCommands) {
    const { Commands } = require('atem-connection');
    _atemCommands = Commands;
  }
  return _atemCommands;
}

function sendCameraControl(agent, source, category, parameter, type, data) {
  const Commands = getAtemCommands();
  const cmd = new Commands.CameraControlCommand(source, category, parameter, {
    type,
    numberData: Array.isArray(data) ? data : [data],
    boolData: [],
    bigintData: [],
    stringData: '',
    relative: false,
  });
  return agent.atemCommand(() => agent.atem.sendCommand(cmd));
}

function sendCameraControlTrigger(agent, source, category, parameter) {
  const Commands = getAtemCommands();
  const cmd = new Commands.CameraControlCommand(source, category, parameter, {
    type: 0, // BOOL / void trigger
    numberData: [],
    boolData: [],
    bigintData: [],
    stringData: '',
    relative: false,
  });
  return agent.atemCommand(() => agent.atem.sendCommand(cmd));
}

// Data type constants matching CameraControlDataType enum
const DT_SINT8 = 1;
const DT_SINT16 = 2;
const DT_SINT32 = 3;
const DT_FLOAT = 128;

async function cameraSetIris(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  let value = Number(params.value);
  if (!Number.isFinite(value)) throw new Error('iris value is required (0.0–1.0 or 0–100%)');
  if (value > 1 && value <= 100) value = value / 100;
  value = Math.max(0, Math.min(1, value));
  await sendCameraControl(agent, camera, CAMERA_CTRL.LENS, CAMERA_CTRL.IRIS, DT_FLOAT, value);
  return `Camera ${camera} iris set to ${Math.round(value * 100)}%`;
}

async function cameraAutoIris(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  await sendCameraControlTrigger(agent, camera, CAMERA_CTRL.LENS, CAMERA_CTRL.AUTO_IRIS);
  return `Camera ${camera} auto iris triggered`;
}

async function cameraSetGain(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const gain = toInt(params.gain, 'gain');
  await sendCameraControl(agent, camera, CAMERA_CTRL.VIDEO, CAMERA_CTRL.GAIN, DT_SINT8, gain);
  return `Camera ${camera} gain set to ${gain} dB`;
}

async function cameraSetISO(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const iso = toInt(params.iso, 'iso');
  await sendCameraControl(agent, camera, CAMERA_CTRL.VIDEO, CAMERA_CTRL.ISO, DT_SINT32, iso);
  return `Camera ${camera} ISO set to ${iso}`;
}

async function cameraSetWhiteBalance(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const kelvin = toInt(params.kelvin, 'kelvin');
  const tint = toInt(params.tint ?? 0, 'tint');
  await sendCameraControl(agent, camera, CAMERA_CTRL.VIDEO, CAMERA_CTRL.WHITE_BALANCE, DT_SINT16, [kelvin, tint]);
  return `Camera ${camera} white balance set to ${kelvin}K${tint !== 0 ? `, tint ${tint}` : ''}`;
}

async function cameraAutoWhiteBalance(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  await sendCameraControlTrigger(agent, camera, CAMERA_CTRL.VIDEO, CAMERA_CTRL.AUTO_WB);
  return `Camera ${camera} auto white balance triggered`;
}

async function cameraSetShutter(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const speed = toInt(params.speed, 'speed');
  // If value looks like an angle (≤360), convert to hundredths of degrees
  if (speed <= 360) {
    const angle = speed * 100;
    await sendCameraControl(agent, camera, CAMERA_CTRL.VIDEO, CAMERA_CTRL.SHUTTER_ANGLE, DT_SINT32, angle);
    return `Camera ${camera} shutter angle set to ${speed}°`;
  }
  // Otherwise treat as microseconds (e.g. 20000 = 1/50s)
  await sendCameraControl(agent, camera, CAMERA_CTRL.VIDEO, CAMERA_CTRL.SHUTTER_SPEED, DT_SINT32, speed);
  return `Camera ${camera} shutter speed set to 1/${Math.round(1000000 / speed)}s`;
}

async function cameraSetFocus(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  let value = Number(params.value);
  if (!Number.isFinite(value)) throw new Error('focus value is required (0.0–1.0)');
  value = Math.max(0, Math.min(1, value));
  await sendCameraControl(agent, camera, CAMERA_CTRL.LENS, CAMERA_CTRL.FOCUS, DT_FLOAT, value);
  return `Camera ${camera} focus set to ${Math.round(value * 100)}%`;
}

async function cameraAutoFocus(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  await sendCameraControlTrigger(agent, camera, CAMERA_CTRL.LENS, CAMERA_CTRL.AUTO_FOCUS);
  return `Camera ${camera} auto focus triggered`;
}

async function cameraSetLift(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const r = Number(params.r ?? 0), g = Number(params.g ?? 0), b = Number(params.b ?? 0), y = Number(params.y ?? 0);
  await sendCameraControl(agent, camera, CAMERA_CTRL.COLOR, CAMERA_CTRL.LIFT, DT_FLOAT, [r, g, b, y]);
  return `Camera ${camera} lift set to R:${r} G:${g} B:${b} Y:${y}`;
}

async function cameraSetGamma(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const r = Number(params.r ?? 0), g = Number(params.g ?? 0), b = Number(params.b ?? 0), y = Number(params.y ?? 0);
  await sendCameraControl(agent, camera, CAMERA_CTRL.COLOR, CAMERA_CTRL.GAMMA, DT_FLOAT, [r, g, b, y]);
  return `Camera ${camera} gamma set to R:${r} G:${g} B:${b} Y:${y}`;
}

async function cameraSetColorGain(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const r = Number(params.r ?? 1), g = Number(params.g ?? 1), b = Number(params.b ?? 1), y = Number(params.y ?? 1);
  await sendCameraControl(agent, camera, CAMERA_CTRL.COLOR, CAMERA_CTRL.COLOR_GAIN, DT_FLOAT, [r, g, b, y]);
  return `Camera ${camera} color gain set to R:${r} G:${g} B:${b} Y:${y}`;
}

async function cameraSetContrast(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const pivot = Number(params.pivot ?? 0.5);
  const adjust = Number(params.adjust ?? 1.0);
  await sendCameraControl(agent, camera, CAMERA_CTRL.COLOR, CAMERA_CTRL.CONTRAST, DT_FLOAT, [pivot, adjust]);
  return `Camera ${camera} contrast set to pivot:${pivot} adjust:${adjust}`;
}

async function cameraSetSaturation(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  const saturation = Number(params.saturation ?? 1.0);
  const hue = Number(params.hue ?? 0);
  await sendCameraControl(agent, camera, CAMERA_CTRL.COLOR, CAMERA_CTRL.HUE_SAT, DT_FLOAT, [hue, saturation]);
  return `Camera ${camera} saturation set to ${saturation}${hue !== 0 ? `, hue ${hue}` : ''}`;
}

async function cameraResetColorCorrection(agent, params) {
  const camera = toInt(params.camera ?? 1, 'camera');
  await sendCameraControl(agent, camera, CAMERA_CTRL.COLOR, CAMERA_CTRL.LIFT, DT_FLOAT, [0, 0, 0, 0]);
  await sendCameraControl(agent, camera, CAMERA_CTRL.COLOR, CAMERA_CTRL.GAMMA, DT_FLOAT, [0, 0, 0, 0]);
  await sendCameraControl(agent, camera, CAMERA_CTRL.COLOR, CAMERA_CTRL.COLOR_GAIN, DT_FLOAT, [1, 1, 1, 1]);
  await sendCameraControl(agent, camera, CAMERA_CTRL.COLOR, CAMERA_CTRL.OFFSET, DT_FLOAT, [0, 0, 0, 0]);
  await sendCameraControl(agent, camera, CAMERA_CTRL.COLOR, CAMERA_CTRL.CONTRAST, DT_FLOAT, [0.5, 1]);
  await sendCameraControl(agent, camera, CAMERA_CTRL.COLOR, CAMERA_CTRL.HUE_SAT, DT_FLOAT, [0, 1]);
  await sendCameraControl(agent, camera, CAMERA_CTRL.COLOR, CAMERA_CTRL.LUM_MIX, DT_FLOAT, 1);
  return `Camera ${camera} color correction reset to defaults`;
}

// ─── OBS COMMANDS ───────────────────────────────────────────────────────────

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

// ─── ENCODER COMMANDS ────────────────────────────────────────────────────────

async function encoderStartStream(agent) {
  const bridge = ensureEncoderBridge(agent);
  const result = await bridge.startStream();
  if (result == null) throw new Error(`Encoder "${agent.status.encoder?.type || 'unknown'}" does not support remote stream start`);
  return 'Encoder stream started';
}

async function encoderStopStream(agent) {
  const bridge = ensureEncoderBridge(agent);
  const result = await bridge.stopStream();
  if (result == null) throw new Error(`Encoder "${agent.status.encoder?.type || 'unknown'}" does not support remote stream stop`);
  return 'Encoder stream stopped';
}

async function encoderStartRecording(agent) {
  const bridge = ensureEncoderBridge(agent);
  const result = await bridge.startRecord();
  if (result == null) throw new Error(`Encoder "${agent.status.encoder?.type || 'unknown'}" does not support remote recording start`);
  return 'Encoder recording started';
}

async function encoderStopRecording(agent) {
  const bridge = ensureEncoderBridge(agent);
  const result = await bridge.stopRecord();
  if (result == null) throw new Error(`Encoder "${agent.status.encoder?.type || 'unknown'}" does not support remote recording stop`);
  return 'Encoder recording stopped';
}

/** Pretty encoder type name for display. */
function encoderBrandName(type) {
  switch ((type || '').toLowerCase()) {
    case 'obs':           return 'OBS Studio';
    case 'vmix':          return 'vMix';
    case 'ecamm':         return 'Ecamm Live';
    case 'blackmagic':    return 'Blackmagic Web Presenter';
    case 'aja':           return 'AJA HELO';
    case 'epiphan':       return 'Epiphan Pearl';
    case 'teradek':       return 'Teradek';
    case 'rtmppush':      return 'RTMP Push Encoder';
    case 'ndi':           return 'NDI Encoder';
    case 'tricaster':     return 'TriCaster';
    case 'birddog':       return 'BirdDog';
    case 'custom':        return 'Custom Encoder';
    default:              return type || 'Encoder';
  }
}

async function encoderStatus(agent) {
  if (!agent.encoderBridge) return agent.status.encoder;
  try {
    const latest = await agent.encoderBridge.getStatus();
    Object.assign(agent.status.encoder, latest);
  } catch {
    // best-effort read
  }
  const s = agent.status.encoder || {};
  const name = encoderBrandName(s.type);

  if (!s.connected) {
    return `📡 ${name} — ❌ Offline\n\nEncoder is not responding. Check power and network connection.`;
  }

  const lines = [
    `📡 ${name} — ✅ Connected`,
    '',
    s.live || s.streaming
      ? '🔴 Streaming: LIVE'
      : '⚫ Streaming: Off',
    s.recording
      ? '⏺️  Recording: Active'
      : '⚫ Recording: Off',
    s.bitrateKbps != null ? `📊 Bitrate: ${s.bitrateKbps >= 1000 ? (s.bitrateKbps / 1000).toFixed(1) + ' Mbps' : s.bitrateKbps + ' kbps'}` : null,
    s.fps != null ? `🎞️  Frame rate: ${s.fps} fps` : null,
    s.cpuUsage != null ? `💻 CPU: ${Math.round(s.cpuUsage)}%` : null,
    s.details ? `ℹ️  ${s.details}` : null,
  ].filter(l => l != null);

  return lines.join('\n');
}

function ensureEncoderAdapter(agent, expectedType) {
  const bridge = ensureEncoderBridge(agent);
  const type = (bridge.type || '').toLowerCase();
  if (type !== expectedType) {
    throw new Error(`Encoder is "${type}", not "${expectedType}" — this command is ${expectedType}-specific`);
  }
  const adapter = bridge.adapter;
  if (!adapter) throw new Error(`${expectedType} adapter not available`);
  return adapter;
}

// ─── BLACKMAGIC WEB PRESENTER COMMANDS ──────────────────────────────────────

async function blackmagicGetActivePlatform(agent) {
  const adapter = ensureEncoderAdapter(agent, 'blackmagic');
  const platform = await adapter.getActivePlatform();
  if (!platform) return 'Active platform data not available';
  return platform;
}

async function blackmagicSetActivePlatform(agent, params) {
  const adapter = ensureEncoderAdapter(agent, 'blackmagic');
  if (!params.config) throw new Error('config object required');
  const result = await adapter.setActivePlatform(params.config);
  if (!result.ok) throw new Error(`Failed to set active platform (HTTP ${result.status})`);
  return 'Active platform updated';
}

async function blackmagicGetPlatforms(agent) {
  const adapter = ensureEncoderAdapter(agent, 'blackmagic');
  const platforms = await adapter.getPlatforms();
  if (!platforms.length) return 'No platforms found';
  return platforms;
}

async function blackmagicGetPlatformConfig(agent, params) {
  const adapter = ensureEncoderAdapter(agent, 'blackmagic');
  if (!params.name) throw new Error('platform name required');
  const config = await adapter.getPlatformConfig(params.name);
  if (!config) return `Platform "${params.name}" not found`;
  return config;
}

async function blackmagicGetVideoFormat(agent) {
  const adapter = ensureEncoderAdapter(agent, 'blackmagic');
  const format = await adapter.getVideoFormat();
  if (!format) return 'Video format data not available';
  return format;
}

async function blackmagicSetVideoFormat(agent, params) {
  const adapter = ensureEncoderAdapter(agent, 'blackmagic');
  if (!params.format) throw new Error('format object required');
  const result = await adapter.setVideoFormat(params.format);
  if (!result.ok) throw new Error(`Failed to set video format (HTTP ${result.status})`);
  return 'Video format updated';
}

async function blackmagicGetSupportedVideoFormats(agent) {
  const adapter = ensureEncoderAdapter(agent, 'blackmagic');
  const formats = await adapter.getSupportedVideoFormats();
  if (!formats.length) return 'No supported video formats found';
  return formats;
}

async function blackmagicGetAudioSources(agent) {
  const adapter = ensureEncoderAdapter(agent, 'blackmagic');
  const sources = await adapter.getAudioSources();
  if (!sources.length) return 'No audio sources found';
  return sources;
}

async function blackmagicSetAudioSource(agent, params) {
  const adapter = ensureEncoderAdapter(agent, 'blackmagic');
  if (params.source == null) throw new Error('source parameter required');
  const result = await adapter.setAudioSource(params.source);
  if (!result.ok) throw new Error(`Failed to set audio source (HTTP ${result.status})`);
  return 'Audio source updated';
}

// ─── AJA HELO COMMANDS ─────────────────────────────────────────────────────

async function ajaSetVideoInput(agent, params) {
  const adapter = ensureEncoderAdapter(agent, 'aja');
  const src = toInt(params.source ?? params.src ?? 0, 'source');
  const result = await adapter.setVideoInput(src);
  if (!result.ok) throw new Error('Failed to set AJA video input');
  const labels = { 0: 'SDI', 1: 'HDMI', 2: 'Test' };
  return `Video input set to ${labels[src] || src}`;
}

async function ajaSetAudioInput(agent, params) {
  const adapter = ensureEncoderAdapter(agent, 'aja');
  const src = toInt(params.source ?? params.src ?? 0, 'source');
  const result = await adapter.setAudioInput(src);
  if (!result.ok) throw new Error('Failed to set AJA audio input');
  const labels = { 0: 'SDI', 1: 'HDMI', 2: 'Analog', 4: 'None' };
  return `Audio input set to ${labels[src] || src}`;
}

async function ajaSetStreamProfile(agent, params) {
  const adapter = ensureEncoderAdapter(agent, 'aja');
  const n = toInt(params.profile, 'profile');
  const result = await adapter.setStreamProfile(n);
  if (!result.ok) throw new Error('Failed to set AJA stream profile');
  return `Stream profile set to ${n}`;
}

async function ajaSetRecordProfile(agent, params) {
  const adapter = ensureEncoderAdapter(agent, 'aja');
  const n = toInt(params.profile, 'profile');
  const result = await adapter.setRecordProfile(n);
  if (!result.ok) throw new Error('Failed to set AJA record profile');
  return `Record profile set to ${n}`;
}

async function ajaSetMute(agent, params) {
  const adapter = ensureEncoderAdapter(agent, 'aja');
  const mute = params.mute !== false && params.mute !== 'false' && params.mute !== 0;
  const result = await adapter.setMute(mute);
  if (!result.ok) throw new Error('Failed to set AJA mute');
  return mute ? 'AJA audio muted' : 'AJA audio unmuted';
}

async function ajaRecallPreset(agent, params) {
  const adapter = ensureEncoderAdapter(agent, 'aja');
  const n = toInt(params.preset, 'preset');
  const result = await adapter.recallPreset(n);
  if (!result.ok) throw new Error('Failed to recall AJA preset');
  return `Preset ${n} recalled`;
}

// ─── EPIPHAN PEARL COMMANDS ─────────────────────────────────────────────────

async function epiphanStartPublisher(agent, params) {
  const adapter = ensureEncoderAdapter(agent, 'epiphan');
  if (!params.channel) throw new Error('channel parameter required');
  if (!params.publisher) throw new Error('publisher parameter required');
  const result = await adapter.startPublisher(params.channel, params.publisher);
  if (!result.ok) throw new Error(`Failed to start publisher (HTTP ${result.status})`);
  return `Publisher ${params.publisher} started on channel ${params.channel}`;
}

async function epiphanStopPublisher(agent, params) {
  const adapter = ensureEncoderAdapter(agent, 'epiphan');
  if (!params.channel) throw new Error('channel parameter required');
  if (!params.publisher) throw new Error('publisher parameter required');
  const result = await adapter.stopPublisher(params.channel, params.publisher);
  if (!result.ok) throw new Error(`Failed to stop publisher (HTTP ${result.status})`);
  return `Publisher ${params.publisher} stopped on channel ${params.channel}`;
}

async function epiphanGetLayouts(agent, params) {
  const adapter = ensureEncoderAdapter(agent, 'epiphan');
  if (!params.channel) throw new Error('channel parameter required');
  const layouts = await adapter.getLayouts(params.channel);
  if (!layouts.length) return 'No layouts found';
  return layouts;
}

async function epiphanSetActiveLayout(agent, params) {
  const adapter = ensureEncoderAdapter(agent, 'epiphan');
  if (!params.channel) throw new Error('channel parameter required');
  if (!params.layout) throw new Error('layout parameter required');
  const result = await adapter.setActiveLayout(params.channel, params.layout);
  if (!result.ok) throw new Error(`Failed to set layout (HTTP ${result.status})`);
  return `Active layout set to ${params.layout} on channel ${params.channel}`;
}

async function epiphanGetStreamingParams(agent, params) {
  const adapter = ensureEncoderAdapter(agent, 'epiphan');
  if (!params.channel) throw new Error('channel parameter required');
  const result = await adapter.getStreamingParams(params.channel, params.keys);
  if (!result.ok) throw new Error(`Failed to get streaming params (HTTP ${result.status})`);
  return result.data;
}

async function epiphanSetStreamingParams(agent, params) {
  const adapter = ensureEncoderAdapter(agent, 'epiphan');
  if (!params.channel) throw new Error('channel parameter required');
  if (!params.params || typeof params.params !== 'object') throw new Error('params object required');
  const result = await adapter.setStreamingParams(params.channel, params.params);
  if (!result.ok) throw new Error(`Failed to set streaming params (HTTP ${result.status})`);
  return 'Streaming parameters updated';
}

// ─── ECAMM LIVE COMMANDS ────────────────────────────────────────────────────

async function ecammTogglePause(agent) {
  const adapter = ensureEncoderAdapter(agent, 'ecamm');
  const result = await adapter.togglePause();
  if (!result.ok) throw new Error('Failed to toggle Ecamm pause');
  return 'Pause toggled';
}

async function ecammGetScenes(agent) {
  const adapter = ensureEncoderAdapter(agent, 'ecamm');
  const scenes = await adapter.getScenes();
  if (!scenes.length) return 'No scenes found';
  return scenes;
}

async function ecammSetScene(agent, params) {
  const adapter = ensureEncoderAdapter(agent, 'ecamm');
  if (!params.id) throw new Error('scene id (uuid) required');
  const result = await adapter.setScene(params.id);
  if (!result.ok) throw new Error('Failed to set Ecamm scene');
  return `Scene set to ${params.id}`;
}

async function ecammNextScene(agent) {
  const adapter = ensureEncoderAdapter(agent, 'ecamm');
  const result = await adapter.nextScene();
  if (!result.ok) throw new Error('Failed to advance Ecamm scene');
  return 'Next scene';
}

async function ecammPrevScene(agent) {
  const adapter = ensureEncoderAdapter(agent, 'ecamm');
  const result = await adapter.prevScene();
  if (!result.ok) throw new Error('Failed to go to previous Ecamm scene');
  return 'Previous scene';
}

async function ecammToggleMute(agent) {
  const adapter = ensureEncoderAdapter(agent, 'ecamm');
  const result = await adapter.toggleMute();
  if (!result.ok) throw new Error('Failed to toggle Ecamm mute');
  return 'Mute toggled';
}

async function ecammGetInputs(agent) {
  const adapter = ensureEncoderAdapter(agent, 'ecamm');
  const inputs = await adapter.getInputs();
  if (!inputs.length) return 'No inputs found';
  return inputs;
}

async function ecammSetInput(agent, params) {
  const adapter = ensureEncoderAdapter(agent, 'ecamm');
  if (!params.id) throw new Error('input id (uuid) required');
  const result = await adapter.setInput(params.id);
  if (!result.ok) throw new Error('Failed to set Ecamm input');
  return `Input set to ${params.id}`;
}

async function ecammTogglePIP(agent) {
  const adapter = ensureEncoderAdapter(agent, 'ecamm');
  const result = await adapter.togglePIP();
  if (!result.ok) throw new Error('Failed to toggle Ecamm PIP');
  return 'PIP toggled';
}

async function ecammGetOverlays(agent) {
  const adapter = ensureEncoderAdapter(agent, 'ecamm');
  const overlays = await adapter.getOverlays();
  if (!overlays.length) return 'No overlays found';
  return overlays;
}

// ─── NDI ENCODER COMMANDS ───────────────────────────────────────────────────

function ndiGetSource(agent) {
  const adapter = ensureEncoderAdapter(agent, 'ndi');
  const source = adapter.getSource();
  return source || 'No NDI source configured';
}

function ndiSetSource(agent, params) {
  const adapter = ensureEncoderAdapter(agent, 'ndi');
  if (!params.source) throw new Error('source parameter required');
  adapter.setSource(params.source);
  return `NDI source set to "${params.source}"`;
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
  const userSlide = params.index || 0;
  const apiIndex = Math.max(0, userSlide - 1);
  await agent.proPresenter.goToSlide(apiIndex);
  return `Jumped to slide ${userSlide}`;
}

async function propresenterLastSlide(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const slide = await agent.proPresenter.getCurrentSlide();
  if (!slide || !slide.slideTotal) throw new Error('Could not determine slide count from ProPresenter');
  const lastIndex = Math.max(0, slide.slideTotal - 1);
  await agent.proPresenter.goToSlide(lastIndex);
  return `Jumped to last slide (slide ${slide.slideTotal})`;
}

async function propresenterStatus(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const slide = await agent.proPresenter.getCurrentSlide();

  if (!slide) {
    return '📺 ProPresenter — ❌ Offline\n\nProPresenter is not responding. Check that it is running.';
  }

  const lines = [
    '📺 ProPresenter — ✅ Running',
    '',
    `🎬 Presentation: ${slide.presentationName || 'Untitled'}`,
    `📄 Slide: ${slide.slideIndex + 1} of ${slide.slideTotal}`,
  ];

  return lines.join('\n');
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
  return running ? '📺 ProPresenter — ✅ Running' : '📺 ProPresenter — ❌ Not reachable';
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

async function propresenterVersion(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const version = await agent.proPresenter.getVersion();
  if (!version) return 'ProPresenter version not available (not reachable)';
  return `ProPresenter ${version}`;
}

async function propresenterMessages(agent) {
  if (!agent.proPresenter) throw new Error('ProPresenter not configured');
  const messages = await agent.proPresenter.getMessages();
  if (!messages.length) return 'No messages found';
  return messages.map(m => `${m.name} (${m.id})`).join('\n');
}

// ─── VMIX COMMANDS ────────────────────────────────────────────────────────────

async function vmixStatus(agent) {
  if (!agent.vmix) throw new Error('vMix not configured');
  const status = await agent.vmix.getStatus();

  if (!status.running) {
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

// ─── RESOLUME COMMANDS ────────────────────────────────────────────────────────

async function resolumeStatus(agent) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const status = await agent.resolume.getStatus();

  if (!status.running) {
    return '🎆 Resolume Arena — ❌ Offline\n\nResolume is not responding. Check that it is running.';
  }

  const lines = [
    '🎆 Resolume Arena — ✅ Running',
    '',
    `📐 Composition: ${status.layerCount} layers · ${status.columnCount} columns`,
    status.bpm ? `🥁 BPM: ${status.bpm}` : null,
    '',
  ];

  if (status.playing.length) {
    lines.push('▶️  Now playing:');
    for (const p of status.playing) {
      lines.push(`   ${p.layer}: ${p.clip}`);
    }
  } else {
    lines.push('⏸️  Nothing playing');
  }

  return lines.filter(l => l != null).join('\n');
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
  return running ? '🎆 Resolume Arena — ✅ Running' : '🎆 Resolume Arena — ❌ Not reachable';
}

async function resolumeVersion(agent) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const version = await agent.resolume.getVersion();
  if (!version) return 'Resolume version not available (not reachable)';
  return version;
}

async function resolumeGetBpm(agent) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const bpm = await agent.resolume.getBpm();
  if (bpm == null) return 'BPM data not available';
  return `Current BPM: ${bpm}`;
}

// ─── RESOLUME EXTENDED COMMANDS ──────────────────────────────────────────────

async function resolumePlayClipByName(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const name = String(params.name || '').trim();
  if (!name) throw new Error('clip name required');
  const result = await agent.resolume.playClipByName(name);
  return `Playing clip "${result.clip}" on layer "${result.layer}"`;
}

async function resolumeTriggerColumnByName(agent, params) {
  if (!agent.resolume) throw new Error('Resolume not configured');
  const name = String(params.name || '').trim();
  if (!name) throw new Error('column name required');
  await agent.resolume.triggerColumnByName(name);
  return `Triggered column "${name}"`;
}

// ─── HYPERDECK EXTENDED COMMANDS ────────────────────────────────────────────

async function hyperdeckSelectSlot(agent, params) {
  const index = resolveHyperDeckIndex(params);
  const deck = getDirectHyperDeck(agent, index);
  if (!deck || !deck.connected) throw new Error(`HyperDeck ${getHyperDeckLabel(index)} not connected`);
  const slot = toInt(params.slot, 'slot');
  await deck._sendAndWait(`slot select: slot id: ${slot}`, [200]);
  return `HyperDeck ${getHyperDeckLabel(index)} slot ${slot} selected`;
}

async function hyperdeckSetPlaySpeed(agent, params) {
  const index = resolveHyperDeckIndex(params);
  const deck = getDirectHyperDeck(agent, index);
  if (!deck || !deck.connected) throw new Error(`HyperDeck ${getHyperDeckLabel(index)} not connected`);
  const speed = params.speed != null ? Number(params.speed) : 100;
  await deck._sendAndWait(`play: speed: ${speed}`, [200]);
  return `HyperDeck ${getHyperDeckLabel(index)} playing at ${speed}% speed`;
}

async function hyperdeckGoToClip(agent, params) {
  const index = resolveHyperDeckIndex(params);
  const deck = getDirectHyperDeck(agent, index);
  if (!deck || !deck.connected) throw new Error(`HyperDeck ${getHyperDeckLabel(index)} not connected`);
  const clipId = toInt(params.clip || params.clipId, 'clip');
  await deck._sendAndWait(`goto: clip id: ${clipId}`, [200]);
  return `HyperDeck ${getHyperDeckLabel(index)} went to clip ${clipId}`;
}

async function hyperdeckGoToTimecode(agent, params) {
  const index = resolveHyperDeckIndex(params);
  const deck = getDirectHyperDeck(agent, index);
  if (!deck || !deck.connected) throw new Error(`HyperDeck ${getHyperDeckLabel(index)} not connected`);
  const tc = String(params.timecode || '00:00:00:00').trim();
  await deck._sendAndWait(`goto: timecode: ${tc}`, [200]);
  return `HyperDeck ${getHyperDeckLabel(index)} jumped to ${tc}`;
}

async function hyperdeckJog(agent, params) {
  const index = resolveHyperDeckIndex(params);
  const deck = getDirectHyperDeck(agent, index);
  if (!deck || !deck.connected) throw new Error(`HyperDeck ${getHyperDeckLabel(index)} not connected`);
  const tc = String(params.timecode || '00:00:01:00').trim();
  await deck._sendAndWait(`jog: timecode: ${tc}`, [200]);
  return `HyperDeck ${getHyperDeckLabel(index)} jogged to ${tc}`;
}

// ─── MIXER COMMANDS ──────────────────────────────────────────────────────────

/**
 * Capability map per mixer model.  Keys are features, values indicate
 * 'full', 'partial' (works but may warn), or false (unsupported / no-op).
 * The default fallback assumes all features are available so that unknown
 * mixer types aren't blocked.
 */
const MIXER_CAPABILITIES = {
  X32:    { compressor: 'full', gate: 'full', hpf: 'full', eq: 'full', fader: 'full', channelName: 'full', muteMaster: 'full', clearSolos: 'full', saveScene: 'partial', channelStrip: 'full', preampGain: 'full', phantom: 'full', pan: 'full', channelColor: 'full', channelIcon: 'full', sendLevel: 'full', busAssign: 'full', dcaAssign: 'full', metering: 'full', sceneSaveVerify: 'full' },
  M32:    { compressor: 'full', gate: 'full', hpf: 'full', eq: 'full', fader: 'full', channelName: 'full', muteMaster: 'full', clearSolos: 'full', saveScene: 'partial', channelStrip: 'full', preampGain: 'full', phantom: 'full', pan: 'full', channelColor: 'full', channelIcon: 'full', sendLevel: 'full', busAssign: 'full', dcaAssign: 'full', metering: 'full', sceneSaveVerify: 'full' },
  SQ:      { compressor: false, gate: false, hpf: 'full', eq: 'partial', fader: 'full', channelName: 'full', muteMaster: 'full', clearSolos: false, saveScene: false, channelStrip: 'partial', sendLevel: 'full', dcaControl: 'full', muteGroup: 'full', pan: 'full', softKey: 'full' },
  SQ5:     { compressor: false, gate: false, hpf: 'full', eq: 'partial', fader: 'full', channelName: 'full', muteMaster: 'full', clearSolos: false, saveScene: false, channelStrip: 'partial', sendLevel: 'full', dcaControl: 'full', muteGroup: 'full', pan: 'full', softKey: 'full' },
  SQ6:     { compressor: false, gate: false, hpf: 'full', eq: 'partial', fader: 'full', channelName: 'full', muteMaster: 'full', clearSolos: false, saveScene: false, channelStrip: 'partial', sendLevel: 'full', dcaControl: 'full', muteGroup: 'full', pan: 'full', softKey: 'full' },
  SQ7:     { compressor: false, gate: false, hpf: 'full', eq: 'partial', fader: 'full', channelName: 'full', muteMaster: 'full', clearSolos: false, saveScene: false, channelStrip: 'partial', sendLevel: 'full', dcaControl: 'full', muteGroup: 'full', pan: 'full', softKey: 'full' },
  DLIVE:   { compressor: false, gate: false, hpf: 'full', eq: false, fader: 'full', channelName: 'full', muteMaster: 'full', clearSolos: false, saveScene: false, channelStrip: 'partial', sendLevel: false, dcaControl: 'full', muteGroup: false, pan: 'full', softKey: false },
  AVANTIS: { compressor: false, gate: false, hpf: 'full', eq: false, fader: 'full', channelName: 'full', muteMaster: 'full', clearSolos: false, saveScene: false, channelStrip: 'partial', sendLevel: false, dcaControl: 'full', muteGroup: false, pan: 'full', softKey: false },
  CL:      { compressor: false, gate: false, hpf: false, eq: false, fader: 'partial', channelName: false, muteMaster: 'partial', clearSolos: false, saveScene: false, channelStrip: 'partial' },
  QL:     { compressor: false, gate: false, hpf: false, eq: false, fader: 'partial', channelName: false, muteMaster: 'partial', clearSolos: false, saveScene: false, channelStrip: 'partial' },
  TF:     { compressor: false, gate: false, hpf: false, eq: false, fader: false, channelName: false, muteMaster: false, clearSolos: false, saveScene: false, channelStrip: false },
};

function mixerCan(agent, feature) {
  const model = (agent.mixer?.model || '').toUpperCase();
  const caps = MIXER_CAPABILITIES[model];
  if (!caps) return 'full'; // unknown model — don't block
  return caps[feature] || false;
}

function requireMixerCapability(agent, feature, friendlyName) {
  const cap = mixerCan(agent, feature);
  if (cap === false) {
    const model = agent.mixer?.model || 'this mixer';
    throw new Error(`${friendlyName} is not supported on ${model} via its remote protocol — set this at the console directly`);
  }
  return cap; // 'full' or 'partial'
}

/** Pretty brand name for display. */
function mixerBrandName(type, model) {
  const t = (type || '').toLowerCase();
  const m = (model || '').trim();
  switch (t) {
    case 'behringer': case 'x32':   return m ? `Behringer ${m}` : 'Behringer X32';
    case 'midas':                    return m ? `Midas ${m}` : 'Midas M32';
    case 'allenheath':               return m ? `Allen & Heath ${m}` : 'Allen & Heath SQ';
    case 'avantis':                  return m ? `Allen & Heath ${m}` : 'Allen & Heath Avantis';
    case 'dlive':                    return m ? `Allen & Heath ${m}` : 'Allen & Heath dLive';
    case 'yamaha':                   return m ? `Yamaha ${m}` : 'Yamaha CL/QL';
    default:                         return m || type || 'Audio Console';
  }
}

/** Simple ASCII fader bar. */
function faderBar(pct) {
  const filled = Math.round(pct / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}

async function mixerStatus(agent) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  const status = await agent.mixer.getStatus();
  const name = mixerBrandName(status.type, status.model);

  if (!status.online) {
    return `🎛️ ${name} — ❌ Offline\n\nConsole is not responding. Check power and network connection.`;
  }

  const faderPct = Math.round((status.mainFader ?? 0) * 100);
  const lines = [
    `🎛️ ${name} — ✅ Online`,
    '',
    status.mainMuted
      ? '🔇 Main output: MUTED'
      : `🔊 Main output: Active`,
    `📊 Main fader: ${faderBar(faderPct)} ${faderPct}%`,
    status.scene != null ? `🎬 Scene: ${status.scene}` : null,
    status.firmware ? `📟 Firmware: ${status.firmware}` : null,
  ].filter(l => l != null);

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
  const lines = [
    `🎚️ Channel ${ch}`,
    status.muted ? '🔇 Muted' : '🔊 Active',
    `📊 Fader: ${faderBar(faderPct)} ${faderPct}%`,
    status.name ? `🏷️ Name: ${status.name}` : null,
  ].filter(l => l != null);
  return lines.join('\n');
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
  requireMixerCapability(agent, 'clearSolos', 'Solo clear');
  await agent.mixer.clearSolos();
  return 'All solos cleared';
}

async function mixerIsOnline(agent) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  const online = await agent.mixer.isOnline();
  const name = mixerBrandName(agent.config?.mixer?.type, agent.config?.mixer?.model);
  return online ? `🎛️ ${name} — ✅ Online` : `🎛️ ${name} — ❌ Not reachable`;
}

function mixerCapabilities(agent) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  const model = (agent.mixer.model || 'unknown').toUpperCase();
  const caps = MIXER_CAPABILITIES[model];
  if (!caps) return { model, note: 'Unknown mixer model — all features assumed available' };
  const lines = [`🎛️ ${model} — remote capabilities:`];
  for (const [feature, level] of Object.entries(caps)) {
    const icon = level === 'full' ? '✅' : level === 'partial' ? '⚠️' : '❌';
    const label = level === 'full' ? 'Supported' : level === 'partial' ? 'Partial (may warn)' : 'Not available';
    lines.push(`  ${icon} ${feature}: ${label}`);
  }
  return lines.join('\n');
}

async function mixerSetFader(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'fader', 'Fader control');
  const { channel, level } = params;
  if (channel == null) throw new Error('channel parameter required');
  if (level == null) throw new Error('level parameter required (0.0–1.0)');
  await agent.mixer.setFader(channel, level);
  return `Channel ${channel} fader set to ${Math.round(parseFloat(level) * 100)}%`;
}

async function mixerSetChannelName(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'channelName', 'Channel name');
  const { channel, name } = params;
  if (channel == null) throw new Error('channel parameter required');
  if (!name) throw new Error('name parameter required');
  await agent.mixer.setChannelName(channel, name);
  return `Channel ${channel} renamed to "${name}"`;
}

async function mixerSetHpf(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'hpf', 'HPF');
  const { channel, enabled, frequency } = params;
  if (channel == null) throw new Error('channel parameter required');
  await agent.mixer.setHpf(channel, { enabled: enabled !== false, frequency: frequency || 80 });
  return `Channel ${channel} HPF ${enabled === false ? 'disabled' : `set to ${frequency || 80} Hz`}`;
}

async function mixerSetEq(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'eq', 'EQ');
  const { channel, enabled, bands } = params;
  if (channel == null) throw new Error('channel parameter required');
  await agent.mixer.setEq(channel, { enabled: enabled !== false, bands: bands || [] });
  return `Channel ${channel} EQ ${enabled === false ? 'disabled' : 'updated'}`;
}

async function mixerSetCompressor(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'compressor', 'Compressor');
  const { channel, ...compParams } = params;
  if (channel == null) throw new Error('channel parameter required');
  await agent.mixer.setCompressor(channel, compParams);
  return `Channel ${channel} compressor ${compParams.enabled === false ? 'disabled' : 'updated'}`;
}

async function mixerSetGate(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'gate', 'Gate');
  const { channel, ...gateParams } = params;
  if (channel == null) throw new Error('channel parameter required');
  await agent.mixer.setGate(channel, gateParams);
  return `Channel ${channel} gate ${gateParams.enabled === false ? 'disabled' : 'updated'}`;
}

async function mixerSetFullChannelStrip(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'channelStrip', 'Channel strip');
  const { channel, ...strip } = params;
  if (channel == null) throw new Error('channel parameter required');
  await agent.mixer.setFullChannelStrip(channel, strip);
  return `Channel ${channel} (${strip.name || 'unnamed'}) — full strip applied`;
}

async function mixerSaveScene(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'saveScene', 'Scene save');
  const { scene, name } = params;
  if (scene == null) throw new Error('scene number required');
  await agent.mixer.saveScene(scene, name);
  return `Scene ${scene}${name ? ` ("${name}")` : ''} save attempted`;
}

// ─── NEW X32/M32 MIXER COMMANDS ──────────────────────────────────────────────

async function mixerSetPreampGain(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'preampGain', 'Preamp gain');
  const { channel, gain } = params;
  if (channel == null) throw new Error('channel parameter required');
  if (gain == null) throw new Error('gain parameter required (dB, -18 to +18)');
  const gainDb = parseFloat(gain);
  if (isNaN(gainDb)) throw new Error('gain must be a number in dB');
  await agent.mixer.setPreampGain(channel, gainDb);
  return `Channel ${channel} preamp trim set to ${gainDb > 0 ? '+' : ''}${gainDb} dB`;
}

async function mixerSetPhantom(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'phantom', 'Phantom power');
  const { channel, enabled } = params;
  if (channel == null) throw new Error('channel parameter required');
  const on = enabled !== false && enabled !== 0 && enabled !== 'false';
  await agent.mixer.setPhantom(channel, on);
  return `Channel ${channel} phantom power ${on ? '⚡ ON' : 'OFF'}`;
}

async function mixerSetPan(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'pan', 'Pan');
  const { channel, pan } = params;
  if (channel == null) throw new Error('channel parameter required');
  if (pan == null) throw new Error('pan parameter required (-1.0 left to +1.0 right, 0 = center)');
  const panVal = parseFloat(pan);
  if (isNaN(panVal)) throw new Error('pan must be a number (-1.0 to +1.0)');
  if (panVal < -1 || panVal > 1) throw new Error('pan out of range (-1.0 to +1.0)');
  await agent.mixer.setPan(channel, panVal);
  const label = panVal < -0.01 ? `${Math.round(panVal * 100)}% L` :
                panVal > 0.01  ? `${Math.round(panVal * 100)}% R` : 'Center';
  return `Channel ${channel} pan set to ${label}`;
}

async function mixerSetChannelColor(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'channelColor', 'Channel color');
  const { channel, color } = params;
  if (channel == null) throw new Error('channel parameter required');
  if (color == null) throw new Error('color parameter required (name like "red" or index 0–15)');
  await agent.mixer.setChannelColor(channel, color);
  return `Channel ${channel} color set to ${color}`;
}

async function mixerSetChannelIcon(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'channelIcon', 'Channel icon');
  const { channel, icon } = params;
  if (channel == null) throw new Error('channel parameter required');
  if (icon == null) throw new Error('icon parameter required (name like "mic" or index 1–74)');
  await agent.mixer.setChannelIcon(channel, icon);
  return `Channel ${channel} icon set to ${icon}`;
}

async function mixerSetSendLevel(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'sendLevel', 'Send level');
  const { channel, bus, level } = params;
  if (channel == null) throw new Error('channel parameter required');
  if (bus == null) throw new Error('bus parameter required (1–16)');
  if (level == null) throw new Error('level parameter required (0.0–1.0)');

  const busNum = Number(bus);
  if (!Number.isInteger(busNum) || busNum < 1 || busNum > 16) {
    throw new Error('bus must be an integer in range 1–16');
  }

  const levelNum = Number(level);
  if (!Number.isFinite(levelNum) || levelNum < 0 || levelNum > 1) {
    throw new Error('level must be a number in range 0.0–1.0');
  }

  await agent.mixer.setSendLevel(channel, busNum, levelNum);
  return `Channel ${channel} → Bus ${busNum} send level set to ${Math.round(levelNum * 100)}%`;
}

async function mixerAssignToBus(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'busAssign', 'Bus assignment');
  const { channel, bus, enabled } = params;
  if (channel == null) throw new Error('channel parameter required');
  if (bus == null) throw new Error('bus parameter required (1–16)');
  const on = enabled !== false && enabled !== 0 && enabled !== 'false';
  await agent.mixer.assignToBus(channel, parseInt(bus), on);
  return `Channel ${channel} → Bus ${bus}: ${on ? '✅ assigned' : '❌ removed'}`;
}

async function mixerAssignToDca(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'dcaAssign', 'DCA assignment');
  const { channel, dca, enabled } = params;
  if (channel == null) throw new Error('channel parameter required');
  if (dca == null) throw new Error('dca parameter required (1–8)');
  const on = enabled !== false && enabled !== 0 && enabled !== 'false';
  await agent.mixer.assignToDca(channel, parseInt(dca), on);
  return `Channel ${channel} → DCA ${dca}: ${on ? '✅ assigned' : '❌ removed'}`;
}

async function mixerGetMeters(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'metering', 'Metering');
  const channels = params.channels ? (Array.isArray(params.channels) ? params.channels.map(Number) : [parseInt(params.channels)]) : undefined;
  const meters = await agent.mixer.getMeters(channels);
  const lines = ['📊 Channel meters:'];
  for (const m of meters) {
    const pct = Math.round((m.fader ?? 0) * 100);
    const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
    lines.push(`  Ch ${String(m.channel).padStart(2)}: ${bar} ${pct}% ${m.muted ? '🔇' : '🔊'}`);
  }
  return lines.join('\n');
}

async function mixerVerifySceneSave(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'sceneSaveVerify', 'Scene verification');
  const { scene } = params;
  if (scene == null) throw new Error('scene number required');
  const result = await agent.mixer.verifySceneSave(parseInt(scene));
  if (result.exists) {
    return `✅ Scene ${result.sceneNumber} verified: "${result.name}"`;
  }
  return `⚠️ Scene ${result.sceneNumber}: no name found (may not exist or save may have failed)`;
}

// ─── DCA / MUTE GROUP / SOFTKEY ──────────────────────────────────────────────

async function mixerMuteDca(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'dcaControl', 'DCA control');
  const { dca } = params;
  if (dca == null) throw new Error('dca number required');
  await agent.mixer.muteDca(parseInt(dca));
  return `DCA ${dca} muted`;
}

async function mixerUnmuteDca(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'dcaControl', 'DCA control');
  const { dca } = params;
  if (dca == null) throw new Error('dca number required');
  await agent.mixer.unmuteDca(parseInt(dca));
  return `DCA ${dca} unmuted`;
}

async function mixerSetDcaFader(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'dcaControl', 'DCA control');
  const { dca, level } = params;
  if (dca == null) throw new Error('dca number required');
  if (level == null) throw new Error('level required (0.0–1.0)');
  const lvl = Math.max(0, Math.min(1, parseFloat(level)));
  await agent.mixer.setDcaFader(parseInt(dca), lvl);
  return `DCA ${dca} fader set to ${Math.round(lvl * 100)}%`;
}

async function mixerActivateMuteGroup(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'muteGroup', 'Mute groups');
  const { group } = params;
  if (group == null) throw new Error('group number required');
  await agent.mixer.activateMuteGroup(parseInt(group));
  return `Mute group ${group} activated`;
}

async function mixerDeactivateMuteGroup(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'muteGroup', 'Mute groups');
  const { group } = params;
  if (group == null) throw new Error('group number required');
  await agent.mixer.deactivateMuteGroup(parseInt(group));
  return `Mute group ${group} deactivated`;
}

async function mixerPressSoftKey(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  requireMixerCapability(agent, 'softKey', 'SoftKeys');
  const { key } = params;
  if (key == null) throw new Error('softkey number required');
  await agent.mixer.pressSoftKey(parseInt(key));
  return `SoftKey ${key} pressed`;
}

/**
 * Batch setup: apply full channel strips to all specified channels,
 * then optionally save a new scene.  Receives the output from the AI
 * setup assistant.
 */
async function mixerSetupFromPatchList(agent, params) {
  if (!agent.mixer) throw new Error('Audio console not configured');
  const { channels, saveScene: doSave, sceneName } = params;
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new Error('No channels provided');
  }

  // Pre-calculate which features are gated so we can report skipped ops
  const stripCap = mixerCan(agent, 'channelStrip');
  const skippedFeatures = [];
  if (mixerCan(agent, 'compressor') === false) skippedFeatures.push('compressor');
  if (mixerCan(agent, 'gate') === false) skippedFeatures.push('gate');
  if (mixerCan(agent, 'hpf') === false) skippedFeatures.push('HPF');
  if (mixerCan(agent, 'eq') === false) skippedFeatures.push('EQ');
  if (mixerCan(agent, 'channelName') === false) skippedFeatures.push('name');

  const results = [];
  for (const ch of channels) {
    try {
      if (stripCap === false) {
        throw new Error('Channel strip not supported on this mixer');
      }
      await agent.mixer.setFullChannelStrip(ch.channel, ch);
      results.push({ channel: ch.channel, name: ch.name, ok: true });
    } catch (e) {
      results.push({ channel: ch.channel, name: ch.name, ok: false, error: e.message });
    }
    // Pace UDP sends — 30ms between channels prevents buffer overflow
    await new Promise(r => setTimeout(r, 30));
  }

  // Optionally save as a new scene
  if (doSave) {
    const sceneCap = mixerCan(agent, 'saveScene');
    if (sceneCap === false) {
      results.push({ scene: 'save', ok: false, error: 'Scene save not supported on this mixer' });
    } else {
      try {
        const sceneNum = 90; // Use scene slot 90 as "AI Setup" slot
        const label = sceneName || `AI Setup ${new Date().toLocaleDateString()}`;
        await agent.mixer.saveScene(sceneNum, label);
        results.push({ scene: sceneNum, name: label, ok: true });
      } catch (e) {
        results.push({ scene: 'save', ok: false, error: e.message });
      }
    }
  }

  // Also save locally as a JSON preset for recall
  const fs = require('fs');
  const path = require('path');
  const presetDir = path.join(process.env.HOME || '/tmp', '.church-av', 'mixer-presets');
  try {
    fs.mkdirSync(presetDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.writeFileSync(
      path.join(presetDir, `setup-${ts}.json`),
      JSON.stringify({ created: new Date().toISOString(), channels }, null, 2)
    );
  } catch { /* non-critical — don't fail the whole setup */ }

  const ok = results.filter(r => r.ok).length;
  const fail = results.filter(r => !r.ok).length;
  const lines = [`✅ Mixer setup complete: ${ok} applied, ${fail} failed`];
  if (fail > 0) lines.push(`⚠️ Failed: ${results.filter(r => !r.ok).map(r => r.channel != null ? `Ch${r.channel}` : r.scene).join(', ')}`);
  if (skippedFeatures.length > 0) {
    lines.push(`ℹ️ Skipped on ${agent.mixer.model || 'this mixer'}: ${skippedFeatures.join(', ')} — set these at the console`);
  }
  return lines.join('\n');
}

// ─── ATEM MEDIA COMMANDS ────────────────────────────────────────────────────

async function atemUploadStill(agent, params) {
  if (!agent.atem) throw new Error('ATEM not configured');
  const { index, data, name, description, mimeType } = params;
  if (data == null) throw new Error('image data (base64) required');

  const slotIndex = index != null ? parseInt(index) : 0;
  const imgBuffer = Buffer.from(data, 'base64');

  // Decode and resize to ATEM resolution using sharp (if available)
  let rgbaBuffer;
  try {
    const sharp = require('sharp');
    // Get ATEM video mode resolution — default to 1080p
    const width = 1920;
    const height = 1080;
    rgbaBuffer = await sharp(imgBuffer)
      .resize(width, height, { fit: 'cover' })
      .ensureAlpha()
      .raw()
      .toBuffer();
  } catch (e) {
    throw new Error(`Image processing failed: ${e.message}. Is the 'sharp' package installed?`);
  }

  await agent.atem.uploadStill(slotIndex, rgbaBuffer, name || `Still ${slotIndex + 1}`, description || '');
  return `✅ Image uploaded to ATEM media pool slot ${slotIndex + 1}${name ? ` ("${name}")` : ''}`;
}

async function atemSetMediaPlayer(agent, params) {
  if (!agent.atem) throw new Error('ATEM not configured');
  const { player, sourceType, stillIndex, clipIndex } = params;
  const playerIdx = player != null ? parseInt(player) : 0;

  const props = {};
  if (sourceType === 'clip') {
    props.sourceType = 1; // MediaSourceType.Clip
    props.clipIndex = clipIndex != null ? parseInt(clipIndex) : 0;
  } else {
    props.sourceType = 0; // MediaSourceType.Still
    props.stillIndex = stillIndex != null ? parseInt(stillIndex) : 0;
  }

  await agent.atem.setMediaPlayerSource(props, playerIdx);
  return `Media player ${playerIdx + 1} set to ${sourceType || 'still'} ${sourceType === 'clip' ? clipIndex : stillIndex}`;
}

async function atemCaptureStill(agent) {
  if (!agent.atem) throw new Error('ATEM not configured');
  await agent.atem.captureMediaPoolStill();
  return '✅ Still captured from program output to media pool';
}

async function atemClearStill(agent, params) {
  if (!agent.atem) throw new Error('ATEM not configured');
  const { index } = params;
  if (index == null) throw new Error('still index required');
  await agent.atem.clearMediaPoolStill(parseInt(index));
  return `Media pool still slot ${parseInt(index) + 1} cleared`;
}

// ─── ATEM: ADDITIONAL VIDEO SWITCHING ────────────────────────────────────────

async function atemSetFadeToBlackRate(agent, params) {
  const me = toInt(params.me ?? 0, 'me');
  const rate = toInt(params.rate, 'rate');
  await agent.atemCommand(() => agent.atem?.setFadeToBlackRate(rate, me));
  return `FTB rate set to ${rate} on ME ${me}`;
}

async function atemListVisibleInputs(agent, params) {
  const mode = params.mode || 'program';
  const me = toInt(params.me ?? 0, 'me');
  if (typeof agent.atem?.listVisibleInputs !== 'function') throw new Error('listVisibleInputs not supported');
  const inputs = await agent.atem.listVisibleInputs(mode, me);
  return { inputs, mode, me };
}

// ─── ATEM: TRANSITION SETTINGS ──────────────────────────────────────────────

async function atemSetDipTransitionSettings(agent, params) {
  const me = toInt(params.me ?? 0, 'me');
  const props = {};
  if (params.rate !== undefined) props.rate = toInt(params.rate, 'rate');
  if (params.input !== undefined) props.input = toInt(params.input, 'input');
  await agent.atemCommand(() => agent.atem?.setDipTransitionSettings(props, me));
  return `Dip transition settings updated on ME ${me}`;
}

async function atemSetWipeTransitionSettings(agent, params) {
  const me = toInt(params.me ?? 0, 'me');
  const props = {};
  if (params.rate !== undefined) props.rate = toInt(params.rate, 'rate');
  if (params.pattern !== undefined) props.pattern = toInt(params.pattern, 'pattern');
  if (params.borderWidth !== undefined) props.borderWidth = Number(params.borderWidth);
  if (params.borderInput !== undefined) props.borderInput = toInt(params.borderInput, 'borderInput');
  if (params.symmetry !== undefined) props.symmetry = Number(params.symmetry);
  if (params.borderSoftness !== undefined) props.borderSoftness = Number(params.borderSoftness);
  if (params.xPosition !== undefined) props.xPosition = Number(params.xPosition);
  if (params.yPosition !== undefined) props.yPosition = Number(params.yPosition);
  if (params.reverseDirection !== undefined) props.reverseDirection = !!params.reverseDirection;
  if (params.flipFlop !== undefined) props.flipFlop = !!params.flipFlop;
  await agent.atemCommand(() => agent.atem?.setWipeTransitionSettings(props, me));
  return `Wipe transition settings updated on ME ${me}`;
}

async function atemSetDVETransitionSettings(agent, params) {
  const me = toInt(params.me ?? 0, 'me');
  const props = {};
  if (params.rate !== undefined) props.rate = toInt(params.rate, 'rate');
  if (params.style !== undefined) props.style = toInt(params.style, 'style');
  if (params.fillSource !== undefined) props.fillSource = toInt(params.fillSource, 'fillSource');
  if (params.keySource !== undefined) props.keySource = toInt(params.keySource, 'keySource');
  if (params.enableKey !== undefined) props.enableKey = !!params.enableKey;
  if (params.preMultiplied !== undefined) props.preMultiplied = !!params.preMultiplied;
  if (params.clip !== undefined) props.clip = Number(params.clip);
  if (params.gain !== undefined) props.gain = Number(params.gain);
  if (params.invertKey !== undefined) props.invertKey = !!params.invertKey;
  if (params.reverse !== undefined) props.reverse = !!params.reverse;
  if (params.flipFlop !== undefined) props.flipFlop = !!params.flipFlop;
  await agent.atemCommand(() => agent.atem?.setDVETransitionSettings(props, me));
  return `DVE transition settings updated on ME ${me}`;
}

async function atemSetStingerTransitionSettings(agent, params) {
  const me = toInt(params.me ?? 0, 'me');
  const props = {};
  if (params.source !== undefined) props.source = toInt(params.source, 'source');
  if (params.preMultiplied !== undefined) props.preMultiplied = !!params.preMultiplied;
  if (params.clip !== undefined) props.clip = Number(params.clip);
  if (params.gain !== undefined) props.gain = Number(params.gain);
  if (params.invertKey !== undefined) props.invertKey = !!params.invertKey;
  if (params.preroll !== undefined) props.preroll = toInt(params.preroll, 'preroll');
  if (params.clipDuration !== undefined) props.clipDuration = toInt(params.clipDuration, 'clipDuration');
  if (params.triggerPoint !== undefined) props.triggerPoint = toInt(params.triggerPoint, 'triggerPoint');
  if (params.mixRate !== undefined) props.mixRate = toInt(params.mixRate, 'mixRate');
  await agent.atemCommand(() => agent.atem?.setStingerTransitionSettings(props, me));
  return `Stinger transition settings updated on ME ${me}`;
}

async function atemSetTransitionPosition(agent, params) {
  const me = toInt(params.me ?? 0, 'me');
  const position = Number(params.position);
  if (!Number.isFinite(position)) throw new Error('position must be a number (0-10000)');
  await agent.atemCommand(() => agent.atem?.setTransitionPosition(position, me));
  return `Transition position set to ${position} on ME ${me}`;
}

async function atemPreviewTransition(agent, params) {
  const me = toInt(params.me ?? 0, 'me');
  const on = params.on !== false;
  await agent.atemCommand(() => agent.atem?.previewTransition(on, me));
  return `Transition preview ${on ? 'enabled' : 'disabled'} on ME ${me}`;
}

// ─── ATEM: UPSTREAM KEYERS ──────────────────────────────────────────────────

async function atemSetUskOnAir(agent, params) {
  const me = toInt(params.me ?? 0, 'me');
  const keyer = toInt(params.keyer ?? params.key ?? 0, 'keyer');
  const onAir = params.onAir !== false;
  await agent.atemCommand(() => agent.atem?.setUpstreamKeyerOnAir(onAir, me, keyer));
  return `USK ${keyer} ${onAir ? 'on-air' : 'off-air'} on ME ${me}`;
}

async function atemSetUskCutSource(agent, params) {
  const me = toInt(params.me ?? 0, 'me');
  const keyer = toInt(params.keyer ?? params.key ?? 0, 'keyer');
  const cutSource = toInt(params.cutSource ?? params.input, 'cutSource');
  await agent.atemCommand(() => agent.atem?.setUpstreamKeyerCutSource(cutSource, me, keyer));
  return `USK ${keyer} cut source set to ${cutSource} on ME ${me}`;
}

async function atemSetUskFillSource(agent, params) {
  const me = toInt(params.me ?? 0, 'me');
  const keyer = toInt(params.keyer ?? params.key ?? 0, 'keyer');
  const fillSource = toInt(params.fillSource ?? params.input, 'fillSource');
  await agent.atemCommand(() => agent.atem?.setUpstreamKeyerFillSource(fillSource, me, keyer));
  return `USK ${keyer} fill source set to ${fillSource} on ME ${me}`;
}

async function atemSetUskType(agent, params) {
  const me = toInt(params.me ?? 0, 'me');
  const keyer = toInt(params.keyer ?? params.key ?? 0, 'keyer');
  const props = {};
  if (params.mixEffectKeyType !== undefined) props.mixEffectKeyType = toInt(params.mixEffectKeyType, 'mixEffectKeyType');
  if (params.flyEnabled !== undefined) props.flyEnabled = !!params.flyEnabled;
  await agent.atemCommand(() => agent.atem?.setUpstreamKeyerType(props, me, keyer));
  return `USK ${keyer} type updated on ME ${me}`;
}

async function atemSetUskLumaSettings(agent, params) {
  const me = toInt(params.me ?? 0, 'me');
  const keyer = toInt(params.keyer ?? params.key ?? 0, 'keyer');
  const props = {};
  if (params.preMultiplied !== undefined) props.preMultiplied = !!params.preMultiplied;
  if (params.clip !== undefined) props.clip = Number(params.clip);
  if (params.gain !== undefined) props.gain = Number(params.gain);
  if (params.invertKey !== undefined) props.invertKey = !!params.invertKey;
  await agent.atemCommand(() => agent.atem?.setUpstreamKeyerLumaSettings(props, me, keyer));
  return `USK ${keyer} luma settings updated on ME ${me}`;
}

async function atemSetUskChromaSettings(agent, params) {
  const me = toInt(params.me ?? 0, 'me');
  const keyer = toInt(params.keyer ?? params.key ?? 0, 'keyer');
  const props = {};
  if (params.hue !== undefined) props.hue = Number(params.hue);
  if (params.gain !== undefined) props.gain = Number(params.gain);
  if (params.ySuppress !== undefined) props.ySuppress = Number(params.ySuppress);
  if (params.lift !== undefined) props.lift = Number(params.lift);
  if (params.narrow !== undefined) props.narrow = !!params.narrow;
  await agent.atemCommand(() => agent.atem?.setUpstreamKeyerChromaSettings(props, me, keyer));
  return `USK ${keyer} chroma settings updated on ME ${me}`;
}

async function atemSetUskPatternSettings(agent, params) {
  const me = toInt(params.me ?? 0, 'me');
  const keyer = toInt(params.keyer ?? params.key ?? 0, 'keyer');
  const props = {};
  if (params.style !== undefined) props.style = toInt(params.style, 'style');
  if (params.size !== undefined) props.size = Number(params.size);
  if (params.symmetry !== undefined) props.symmetry = Number(params.symmetry);
  if (params.softness !== undefined) props.softness = Number(params.softness);
  if (params.positionX !== undefined) props.positionX = Number(params.positionX);
  if (params.positionY !== undefined) props.positionY = Number(params.positionY);
  if (params.invertPattern !== undefined) props.invertPattern = !!params.invertPattern;
  await agent.atemCommand(() => agent.atem?.setUpstreamKeyerPatternSettings(props, me, keyer));
  return `USK ${keyer} pattern settings updated on ME ${me}`;
}

async function atemSetUskDVESettings(agent, params) {
  const me = toInt(params.me ?? 0, 'me');
  const keyer = toInt(params.keyer ?? params.key ?? 0, 'keyer');
  const props = {};
  const numKeys = ['sizeX', 'sizeY', 'positionX', 'positionY', 'rotation',
    'borderOuterWidth', 'borderInnerWidth', 'borderOuterSoftness', 'borderInnerSoftness',
    'borderBevelSoftness', 'borderBevelPosition', 'borderOpacity',
    'borderHue', 'borderSaturation', 'borderLuma',
    'lightSourceDirection', 'lightSourceAltitude',
    'shadowAltitude', 'rate', 'maskTop', 'maskBottom', 'maskLeft', 'maskRight'];
  for (const k of numKeys) { if (params[k] !== undefined) props[k] = Number(params[k]); }
  const boolKeys = ['borderEnabled', 'maskEnabled'];
  for (const k of boolKeys) { if (params[k] !== undefined) props[k] = !!params[k]; }
  if (params.borderBevelType !== undefined) props.borderBevelType = toInt(params.borderBevelType, 'borderBevelType');
  await agent.atemCommand(() => agent.atem?.setUpstreamKeyerDVESettings(props, me, keyer));
  return `USK ${keyer} DVE settings updated on ME ${me}`;
}

async function atemSetUskMaskSettings(agent, params) {
  const me = toInt(params.me ?? 0, 'me');
  const keyer = toInt(params.keyer ?? params.key ?? 0, 'keyer');
  const props = {};
  if (params.maskEnabled !== undefined) props.maskEnabled = !!params.maskEnabled;
  if (params.maskTop !== undefined) props.maskTop = Number(params.maskTop);
  if (params.maskBottom !== undefined) props.maskBottom = Number(params.maskBottom);
  if (params.maskLeft !== undefined) props.maskLeft = Number(params.maskLeft);
  if (params.maskRight !== undefined) props.maskRight = Number(params.maskRight);
  await agent.atemCommand(() => agent.atem?.setUpstreamKeyerMaskSettings(props, me, keyer));
  return `USK ${keyer} mask settings updated on ME ${me}`;
}

async function atemRunUskFlyKeyTo(agent, params) {
  const me = toInt(params.me ?? 0, 'me');
  const keyer = toInt(params.keyer ?? params.key ?? 0, 'keyer');
  const keyFrameId = toInt(params.keyFrame ?? params.keyFrameId, 'keyFrame');
  await agent.atemCommand(() => agent.atem?.runUpstreamKeyerFlyKeyTo(me, keyer, keyFrameId));
  return `USK ${keyer} fly key running to keyframe ${keyFrameId} on ME ${me}`;
}

async function atemRunUskFlyKeyToInfinite(agent, params) {
  const me = toInt(params.me ?? 0, 'me');
  const keyer = toInt(params.keyer ?? params.key ?? 0, 'keyer');
  const direction = toInt(params.direction, 'direction');
  await agent.atemCommand(() => agent.atem?.runUpstreamKeyerFlyKeyToInfinite(me, keyer, direction));
  return `USK ${keyer} fly key to infinite direction ${direction} on ME ${me}`;
}

// ─── ATEM: DOWNSTREAM KEYERS (additional) ───────────────────────────────────

async function atemAutoDownstreamKey(agent, params) {
  const keyer = toInt(params.keyer ?? params.key ?? 0, 'keyer');
  const isTowardsOnAir = params.isTowardsOnAir !== false;
  await agent.atemCommand(() => agent.atem?.autoDownstreamKey(keyer, isTowardsOnAir));
  return `DSK ${keyer + 1} auto transition ${isTowardsOnAir ? 'towards on-air' : 'towards off-air'}`;
}

async function atemSetDskGeneralProperties(agent, params) {
  const keyer = toInt(params.keyer ?? params.key ?? 0, 'keyer');
  const props = {};
  if (params.preMultiplied !== undefined) props.preMultiplied = !!params.preMultiplied;
  if (params.clip !== undefined) props.clip = Number(params.clip);
  if (params.gain !== undefined) props.gain = Number(params.gain);
  if (params.invertKey !== undefined) props.invertKey = !!params.invertKey;
  await agent.atemCommand(() => agent.atem?.setDownstreamKeyGeneralProperties(props, keyer));
  return `DSK ${keyer + 1} general properties updated`;
}

async function atemSetDskMaskSettings(agent, params) {
  const keyer = toInt(params.keyer ?? params.key ?? 0, 'keyer');
  const props = {};
  if (params.maskEnabled !== undefined) props.maskEnabled = !!params.maskEnabled;
  if (params.maskTop !== undefined) props.maskTop = Number(params.maskTop);
  if (params.maskBottom !== undefined) props.maskBottom = Number(params.maskBottom);
  if (params.maskLeft !== undefined) props.maskLeft = Number(params.maskLeft);
  if (params.maskRight !== undefined) props.maskRight = Number(params.maskRight);
  await agent.atemCommand(() => agent.atem?.setDownstreamKeyMaskSettings(props, keyer));
  return `DSK ${keyer + 1} mask settings updated`;
}

// ─── ATEM: SUPERSOURCE ──────────────────────────────────────────────────────

async function atemSetSuperSourceBoxSettings(agent, params) {
  const box = toInt(params.box ?? 0, 'box');
  const ssrcId = toInt(params.ssrcId ?? 0, 'ssrcId');
  const props = {};
  if (params.enabled !== undefined) props.enabled = !!params.enabled;
  if (params.source !== undefined) props.source = toInt(params.source, 'source');
  const numKeys = ['positionX', 'positionY', 'size', 'cropTop', 'cropBottom', 'cropLeft', 'cropRight'];
  for (const k of numKeys) { if (params[k] !== undefined) props[k] = Number(params[k]); }
  if (params.cropped !== undefined) props.cropped = !!params.cropped;
  await agent.atemCommand(() => agent.atem?.setSuperSourceBoxSettings(props, box, ssrcId));
  return `SuperSource box ${box} settings updated`;
}

async function atemSetSuperSourceProperties(agent, params) {
  const ssrcId = toInt(params.ssrcId ?? 0, 'ssrcId');
  const props = {};
  if (params.artFillSource !== undefined) props.artFillSource = toInt(params.artFillSource, 'artFillSource');
  if (params.artCutSource !== undefined) props.artCutSource = toInt(params.artCutSource, 'artCutSource');
  if (params.artOption !== undefined) props.artOption = toInt(params.artOption, 'artOption');
  if (params.artPreMultiplied !== undefined) props.artPreMultiplied = !!params.artPreMultiplied;
  if (params.artClip !== undefined) props.artClip = Number(params.artClip);
  if (params.artGain !== undefined) props.artGain = Number(params.artGain);
  if (params.artInvertKey !== undefined) props.artInvertKey = !!params.artInvertKey;
  await agent.atemCommand(() => agent.atem?.setSuperSourceProperties(props, ssrcId));
  return `SuperSource properties updated`;
}

async function atemSetSuperSourceBorder(agent, params) {
  const ssrcId = toInt(params.ssrcId ?? 0, 'ssrcId');
  const props = {};
  if (params.borderEnabled !== undefined) props.borderEnabled = !!params.borderEnabled;
  const numKeys = ['borderBevel', 'borderOuterWidth', 'borderInnerWidth',
    'borderOuterSoftness', 'borderInnerSoftness', 'borderBevelSoftness', 'borderBevelPosition',
    'borderHue', 'borderSaturation', 'borderLuma', 'borderLightSourceDirection', 'borderLightSourceAltitude'];
  for (const k of numKeys) { if (params[k] !== undefined) props[k] = Number(params[k]); }
  await agent.atemCommand(() => agent.atem?.setSuperSourceBorder(props, ssrcId));
  return `SuperSource border settings updated`;
}

// ─── ATEM: MACRO MANAGEMENT ─────────────────────────────────────────────────

async function atemMacroContinue(agent) {
  await agent.atemCommand(async () => {
    if (typeof agent.atem?.macroContinue !== 'function') throw new Error('macroContinue not supported');
    return agent.atem.macroContinue();
  });
  return 'Macro continued';
}

async function atemMacroDelete(agent, params) {
  const index = toInt(params.index ?? params.macroIndex ?? 0, 'index');
  await agent.atemCommand(async () => {
    if (typeof agent.atem?.macroDelete !== 'function') throw new Error('macroDelete not supported');
    return agent.atem.macroDelete(index);
  });
  return `Macro ${index} deleted`;
}

async function atemMacroInsertUserWait(agent) {
  await agent.atemCommand(async () => {
    if (typeof agent.atem?.macroInsertUserWait !== 'function') throw new Error('macroInsertUserWait not supported');
    return agent.atem.macroInsertUserWait();
  });
  return 'User wait inserted into macro';
}

async function atemMacroInsertTimedWait(agent, params) {
  const frames = toInt(params.frames, 'frames');
  await agent.atemCommand(async () => {
    if (typeof agent.atem?.macroInsertTimedWait !== 'function') throw new Error('macroInsertTimedWait not supported');
    return agent.atem.macroInsertTimedWait(frames);
  });
  return `Timed wait (${frames} frames) inserted into macro`;
}

async function atemMacroStartRecord(agent, params) {
  const index = toInt(params.index ?? params.macroIndex, 'index');
  const name = params.name || `Macro ${index}`;
  const description = params.description || '';
  await agent.atemCommand(async () => {
    if (typeof agent.atem?.macroStartRecord !== 'function') throw new Error('macroStartRecord not supported');
    return agent.atem.macroStartRecord(index, name, description);
  });
  return `Macro recording started at slot ${index} ("${name}")`;
}

async function atemMacroStopRecord(agent) {
  await agent.atemCommand(async () => {
    if (typeof agent.atem?.macroStopRecord !== 'function') throw new Error('macroStopRecord not supported');
    return agent.atem.macroStopRecord();
  });
  return 'Macro recording stopped';
}

async function atemMacroUpdateProperties(agent, params) {
  const index = toInt(params.index ?? params.macroIndex ?? 0, 'index');
  const props = {};
  if (params.name !== undefined) props.name = String(params.name);
  if (params.description !== undefined) props.description = String(params.description);
  await agent.atemCommand(async () => {
    if (typeof agent.atem?.macroUpdateProperties !== 'function') throw new Error('macroUpdateProperties not supported');
    return agent.atem.macroUpdateProperties(props, index);
  });
  return `Macro ${index} properties updated`;
}

async function atemMacroSetLoop(agent, params) {
  const loop = params.loop !== false;
  await agent.atemCommand(async () => {
    if (typeof agent.atem?.macroSetLoop !== 'function') throw new Error('macroSetLoop not supported');
    return agent.atem.macroSetLoop(loop);
  });
  return `Macro loop ${loop ? 'enabled' : 'disabled'}`;
}

// ─── ATEM: MEDIA POOL (additional) ──────────────────────────────────────────

async function atemSetMediaPlayerSettings(agent, params) {
  const player = toInt(params.player ?? 0, 'player');
  const props = {};
  if (params.loop !== undefined) props.loop = !!params.loop;
  if (params.playing !== undefined) props.playing = !!params.playing;
  if (params.beginning !== undefined) props.beginning = !!params.beginning;
  if (params.clipFrame !== undefined) props.clipFrame = toInt(params.clipFrame, 'clipFrame');
  await agent.atemCommand(() => agent.atem?.setMediaPlayerSettings(props, player));
  return `Media player ${player + 1} settings updated`;
}

async function atemSetMediaClip(agent, params) {
  const index = toInt(params.index, 'index');
  const name = params.name || `Clip ${index}`;
  const frames = params.frames !== undefined ? toInt(params.frames, 'frames') : undefined;
  await agent.atemCommand(() => agent.atem?.setMediaClip(index, name, frames));
  return `Media clip ${index} set ("${name}")`;
}

async function atemClearMediaPoolClip(agent, params) {
  const clipId = toInt(params.clipId ?? params.index, 'clipId');
  await agent.atemCommand(() => agent.atem?.clearMediaPoolClip(clipId));
  return `Media pool clip ${clipId} cleared`;
}

// ─── ATEM: CLASSIC AUDIO ────────────────────────────────────────────────────

async function atemSetClassicAudioInputProps(agent, params) {
  const index = toInt(params.index ?? params.input, 'index');
  const props = {};
  if (params.mixOption !== undefined) props.mixOption = toFairlightEnum(params.mixOption, FAIRLIGHT_MIX_OPTION, 'mixOption');
  if (params.gain !== undefined) props.gain = Number(params.gain);
  if (params.balance !== undefined) props.balance = Number(params.balance);
  if (params.rcaToXlrEnabled !== undefined) props.rcaToXlrEnabled = !!params.rcaToXlrEnabled;
  await agent.atemCommand(() => agent.atem?.setClassicAudioMixerInputProps(index, props));
  return `Classic audio input ${index} properties updated`;
}

async function atemSetClassicAudioMasterProps(agent, params) {
  const props = {};
  if (params.gain !== undefined) props.gain = Number(params.gain);
  if (params.balance !== undefined) props.balance = Number(params.balance);
  if (params.followFadeToBlack !== undefined) props.followFadeToBlack = !!params.followFadeToBlack;
  await agent.atemCommand(() => agent.atem?.setClassicAudioMixerMasterProps(props));
  return 'Classic audio master properties updated';
}

async function atemSetClassicAudioMonitorProps(agent, params) {
  const props = {};
  if (params.enabled !== undefined) props.enabled = !!params.enabled;
  if (params.gain !== undefined) props.gain = Number(params.gain);
  if (params.mute !== undefined) props.mute = !!params.mute;
  if (params.solo !== undefined) props.solo = !!params.solo;
  if (params.soloInput !== undefined) props.soloInput = toInt(params.soloInput, 'soloInput');
  if (params.dim !== undefined) props.dim = !!params.dim;
  await agent.atemCommand(() => agent.atem?.setClassicAudioMixerMonitorProps(props));
  return 'Classic audio monitor properties updated';
}

async function atemSetClassicAudioHeadphonesProps(agent, params) {
  const props = {};
  if (params.gain !== undefined) props.gain = Number(params.gain);
  if (params.programOutGain !== undefined) props.programOutGain = Number(params.programOutGain);
  if (params.sidetoneGain !== undefined) props.sidetoneGain = Number(params.sidetoneGain);
  if (params.talkbackGain !== undefined) props.talkbackGain = Number(params.talkbackGain);
  await agent.atemCommand(() => agent.atem?.setClassicAudioMixerHeadphonesProps(props));
  return 'Classic audio headphones properties updated';
}

async function atemSetClassicAudioResetPeaks(agent, params) {
  const props = {};
  if (params.all !== undefined) props.all = !!params.all;
  if (params.master !== undefined) props.master = !!params.master;
  if (params.input !== undefined) props.input = toInt(params.input, 'input');
  await agent.atemCommand(() => agent.atem?.setClassicAudioResetPeaks(props));
  return 'Classic audio peaks reset';
}

async function atemSetClassicAudioMixerProps(agent, params) {
  const props = {};
  if (params.audioFollowVideoCrossfadeTransitionEnabled !== undefined) {
    props.audioFollowVideoCrossfadeTransitionEnabled = !!params.audioFollowVideoCrossfadeTransitionEnabled;
  }
  await agent.atemCommand(() => agent.atem?.setClassicAudioMixerProps(props));
  return 'Classic audio mixer properties updated';
}

// ─── ATEM: FAIRLIGHT AUDIO ──────────────────────────────────────────────────

async function atemSetFairlightAudioMasterProps(agent, params) {
  const props = {};
  if (params.faderGain !== undefined) props.faderGain = Number(params.faderGain);
  if (params.followFadeToBlack !== undefined) props.followFadeToBlack = !!params.followFadeToBlack;
  await agent.atemCommand(() => agent.atem?.setFairlightAudioMixerMasterProps(props));
  return 'Fairlight audio master properties updated';
}

async function atemSetFairlightAudioMasterCompressorProps(agent, params) {
  const props = {};
  if (params.compressorEnabled !== undefined) props.compressorEnabled = !!params.compressorEnabled;
  else if (params.enabled !== undefined) props.compressorEnabled = !!params.enabled;
  if (params.threshold !== undefined) props.threshold = Number(params.threshold);
  if (params.ratio !== undefined) props.ratio = Number(params.ratio);
  if (params.attack !== undefined) props.attack = Number(params.attack);
  if (params.hold !== undefined) props.hold = Number(params.hold);
  if (params.release !== undefined) props.release = Number(params.release);
  await agent.atemCommand(() => agent.atem?.setFairlightAudioMixerMasterCompressorProps(props));
  return 'Fairlight audio master compressor updated';
}

async function atemSetFairlightAudioMasterLimiterProps(agent, params) {
  const props = {};
  if (params.limiterEnabled !== undefined) props.limiterEnabled = !!params.limiterEnabled;
  else if (params.enabled !== undefined) props.limiterEnabled = !!params.enabled;
  if (params.threshold !== undefined) props.threshold = Number(params.threshold);
  if (params.attack !== undefined) props.attack = Number(params.attack);
  if (params.hold !== undefined) props.hold = Number(params.hold);
  if (params.release !== undefined) props.release = Number(params.release);
  await agent.atemCommand(() => agent.atem?.setFairlightAudioMixerMasterLimiterProps(props));
  return 'Fairlight audio master limiter updated';
}

async function atemSetFairlightAudioMasterEqBandProps(agent, params) {
  const band = toInt(params.band, 'band');
  const props = {};
  if (params.eqEnabled !== undefined) props.bandEnabled = !!params.eqEnabled;
  else if (params.bandEnabled !== undefined) props.bandEnabled = !!params.bandEnabled;
  if (params.shape !== undefined) props.shape = toFairlightEnum(params.shape, FAIRLIGHT_EQ_SHAPE, 'shape');
  if (params.frequencyRange !== undefined) props.frequencyRange = toFairlightEnum(params.frequencyRange, FAIRLIGHT_FREQ_RANGE, 'frequencyRange');
  if (params.frequency !== undefined) props.frequency = Number(params.frequency);
  if (params.gain !== undefined) props.gain = Number(params.gain);
  if (params.qFactor !== undefined) props.qFactor = Number(params.qFactor);
  await agent.atemCommand(() => agent.atem?.setFairlightAudioMixerMasterEqualizerBandProps(band, props));
  return `Fairlight audio master EQ band ${band} updated`;
}

async function atemSetFairlightAudioMasterEqReset(agent, params) {
  const props = {};
  if (params.equalizer !== undefined) props.equalizer = !!params.equalizer;
  if (params.band !== undefined) props.band = toInt(params.band, 'band');
  await agent.atemCommand(() => agent.atem?.setFairlightAudioMixerMasterEqualizerReset(props));
  return 'Fairlight audio master EQ reset';
}

async function atemSetFairlightAudioMasterDynamicsReset(agent, params) {
  const props = {};
  if (params.dynamics !== undefined) props.dynamics = !!params.dynamics;
  if (params.compressor !== undefined) props.compressor = !!params.compressor;
  if (params.limiter !== undefined) props.limiter = !!params.limiter;
  await agent.atemCommand(() => agent.atem?.setFairlightAudioMixerMasterDynamicsReset(props));
  return 'Fairlight audio master dynamics reset';
}

async function atemSetFairlightAudioResetPeaks(agent, params) {
  const props = {};
  if (params.all !== undefined) props.all = !!params.all;
  if (params.master !== undefined) props.master = !!params.master;
  if (params.input !== undefined) props.input = toInt(params.input, 'input');
  await agent.atemCommand(() => agent.atem?.setFairlightAudioMixerResetPeaks(props));
  return 'Fairlight audio peaks reset';
}

async function atemStartFairlightSendLevels(agent) {
  await agent.atemCommand(async () => {
    if (typeof agent.atem?.startFairlightMixerSendLevels !== 'function') throw new Error('startFairlightMixerSendLevels not supported');
    return agent.atem.startFairlightMixerSendLevels();
  });
  return 'Fairlight send levels started';
}

async function atemStopFairlightSendLevels(agent) {
  await agent.atemCommand(async () => {
    if (typeof agent.atem?.stopFairlightMixerSendLevels !== 'function') throw new Error('stopFairlightMixerSendLevels not supported');
    return agent.atem.stopFairlightMixerSendLevels();
  });
  return 'Fairlight send levels stopped';
}

async function atemSetFairlightAudioMonitorProps(agent, params) {
  const props = {};
  if (params.gain !== undefined) props.gain = Number(params.gain);
  if (params.inputMasterGain !== undefined) props.inputMasterGain = Number(params.inputMasterGain);
  if (params.inputMasterMuted !== undefined) props.inputMasterMuted = !!params.inputMasterMuted;
  if (params.inputTalkbackGain !== undefined) props.inputTalkbackGain = Number(params.inputTalkbackGain);
  if (params.inputSidetoneGain !== undefined) props.inputSidetoneGain = Number(params.inputSidetoneGain);
  await agent.atemCommand(() => agent.atem?.setFairlightAudioMixerMonitorProps(props));
  return 'Fairlight audio monitor properties updated';
}

async function atemSetFairlightAudioMonitorSolo(agent, params) {
  const props = {};
  if (params.solo !== undefined) props.solo = !!params.solo;
  if (params.index !== undefined) props.index = toInt(params.index, 'index');
  if (params.source !== undefined) props.source = params.source;
  await agent.atemCommand(() => agent.atem?.setFairlightAudioMixerMonitorSolo(props));
  return 'Fairlight audio monitor solo updated';
}

async function atemSetFairlightAudioInputProps(agent, params) {
  const index = toInt(params.index ?? params.input, 'index');
  const props = {};
  if (params.activeConfiguration !== undefined) props.activeConfiguration = toInt(params.activeConfiguration, 'activeConfiguration');
  if (params.activeInputLevel !== undefined) props.activeInputLevel = toInt(params.activeInputLevel, 'activeInputLevel');
  await agent.atemCommand(() => agent.atem?.setFairlightAudioMixerInputProps(index, props));
  return `Fairlight audio input ${index} properties updated`;
}

async function atemSetFairlightAudioSourceProps(agent, params) {
  const index = toInt(params.index ?? params.input, 'index');
  const source = params.source ?? params.sourceId ?? '0';
  const props = {};
  if (params.framesDelay !== undefined) props.framesDelay = Number(params.framesDelay);
  if (params.gain !== undefined) props.gain = Number(params.gain);
  if (params.balance !== undefined) props.balance = Number(params.balance);
  if (params.faderGain !== undefined) props.faderGain = Number(params.faderGain);
  if (params.mixOption !== undefined) props.mixOption = toFairlightEnum(params.mixOption, FAIRLIGHT_MIX_OPTION, 'mixOption');
  if (params.stereoSimulation !== undefined) props.stereoSimulation = Number(params.stereoSimulation);
  await agent.atemCommand(() => agent.atem?.setFairlightAudioMixerSourceProps(index, source, props));
  return `Fairlight audio input ${index} source ${source} properties updated`;
}

async function atemSetFairlightAudioSourceCompressorProps(agent, params) {
  const index = toInt(params.index ?? params.input, 'index');
  const source = params.source ?? params.sourceId ?? '0';
  const props = {};
  if (params.compressorEnabled !== undefined) props.compressorEnabled = !!params.compressorEnabled;
  else if (params.enabled !== undefined) props.compressorEnabled = !!params.enabled;
  if (params.threshold !== undefined) props.threshold = Number(params.threshold);
  if (params.ratio !== undefined) props.ratio = Number(params.ratio);
  if (params.attack !== undefined) props.attack = Number(params.attack);
  if (params.hold !== undefined) props.hold = Number(params.hold);
  if (params.release !== undefined) props.release = Number(params.release);
  await agent.atemCommand(() => agent.atem?.setFairlightAudioMixerSourceCompressorProps(index, source, props));
  return `Fairlight audio source ${index}/${source} compressor updated`;
}

async function atemSetFairlightAudioSourceLimiterProps(agent, params) {
  const index = toInt(params.index ?? params.input, 'index');
  const source = params.source ?? params.sourceId ?? '0';
  const props = {};
  if (params.limiterEnabled !== undefined) props.limiterEnabled = !!params.limiterEnabled;
  else if (params.enabled !== undefined) props.limiterEnabled = !!params.enabled;
  if (params.threshold !== undefined) props.threshold = Number(params.threshold);
  if (params.attack !== undefined) props.attack = Number(params.attack);
  if (params.hold !== undefined) props.hold = Number(params.hold);
  if (params.release !== undefined) props.release = Number(params.release);
  await agent.atemCommand(() => agent.atem?.setFairlightAudioMixerSourceLimiterProps(index, source, props));
  return `Fairlight audio source ${index}/${source} limiter updated`;
}

async function atemSetFairlightAudioSourceExpanderProps(agent, params) {
  const index = toInt(params.index ?? params.input, 'index');
  const source = params.source ?? params.sourceId ?? '0';
  const props = {};
  if (params.expanderEnabled !== undefined) props.expanderEnabled = !!params.expanderEnabled;
  else if (params.enabled !== undefined) props.expanderEnabled = !!params.enabled;
  if (params.gateEnabled !== undefined) props.gateEnabled = !!params.gateEnabled;
  if (params.threshold !== undefined) props.threshold = Number(params.threshold);
  if (params.range !== undefined) props.range = Number(params.range);
  if (params.ratio !== undefined) props.ratio = Number(params.ratio);
  if (params.attack !== undefined) props.attack = Number(params.attack);
  if (params.hold !== undefined) props.hold = Number(params.hold);
  if (params.release !== undefined) props.release = Number(params.release);
  await agent.atemCommand(() => agent.atem?.setFairlightAudioMixerSourceExpanderProps(index, source, props));
  return `Fairlight audio source ${index}/${source} expander updated`;
}

async function atemSetFairlightAudioSourceEqBandProps(agent, params) {
  const index = toInt(params.index ?? params.input, 'index');
  const source = params.source ?? params.sourceId ?? '0';
  const band = toInt(params.band, 'band');
  const props = {};
  if (params.eqEnabled !== undefined) props.bandEnabled = !!params.eqEnabled;
  else if (params.bandEnabled !== undefined) props.bandEnabled = !!params.bandEnabled;
  if (params.shape !== undefined) props.shape = toFairlightEnum(params.shape, FAIRLIGHT_EQ_SHAPE, 'shape');
  if (params.frequencyRange !== undefined) props.frequencyRange = toFairlightEnum(params.frequencyRange, FAIRLIGHT_FREQ_RANGE, 'frequencyRange');
  if (params.frequency !== undefined) props.frequency = Number(params.frequency);
  if (params.gain !== undefined) props.gain = Number(params.gain);
  if (params.qFactor !== undefined) props.qFactor = Number(params.qFactor);
  await agent.atemCommand(() => agent.atem?.setFairlightAudioMixerSourceEqualizerBandProps(index, source, band, props));
  return `Fairlight audio source ${index}/${source} EQ band ${band} updated`;
}

// ─── ATEM: STREAMING & RECORDING (additional) ──────────────────────────────

async function atemRequestStreamingDuration(agent) {
  await agent.atemCommand(async () => {
    if (typeof agent.atem?.requestStreamingDuration !== 'function') throw new Error('requestStreamingDuration not supported');
    return agent.atem.requestStreamingDuration();
  });
  return 'Streaming duration requested';
}

async function atemSetStreamingService(agent, params) {
  const props = {};
  if (params.serviceName !== undefined) props.serviceName = String(params.serviceName);
  if (params.url !== undefined) props.url = String(params.url);
  if (params.key !== undefined) props.key = String(params.key);
  await agent.atemCommand(() => agent.atem?.setStreamingService(props));
  return 'Streaming service settings updated';
}

async function atemSetStreamingAudioBitrates(agent, params) {
  const lowBitrate = toInt(params.lowBitrate, 'lowBitrate');
  const highBitrate = toInt(params.highBitrate, 'highBitrate');
  await agent.atemCommand(() => agent.atem?.setStreamingAudioBitrates(lowBitrate, highBitrate));
  return `Streaming audio bitrates set: low=${lowBitrate}, high=${highBitrate}`;
}

async function atemRequestRecordingDuration(agent) {
  await agent.atemCommand(async () => {
    if (typeof agent.atem?.requestRecordingDuration !== 'function') throw new Error('requestRecordingDuration not supported');
    return agent.atem.requestRecordingDuration();
  });
  return 'Recording duration requested';
}

async function atemSwitchRecordingDisk(agent) {
  await agent.atemCommand(async () => {
    if (typeof agent.atem?.switchRecordingDisk !== 'function') throw new Error('switchRecordingDisk not supported');
    return agent.atem.switchRecordingDisk();
  });
  return 'Recording disk switched';
}

async function atemSetRecordingSettings(agent, params) {
  const props = {};
  if (params.filename !== undefined) props.filename = String(params.filename);
  if (params.recordInAllCameras !== undefined) props.recordInAllCameras = !!params.recordInAllCameras;
  await agent.atemCommand(() => agent.atem?.setRecordingSettings(props));
  return 'Recording settings updated';
}

async function atemSetEnableISORecording(agent, params) {
  const enabled = params.enabled !== false;
  await agent.atemCommand(() => agent.atem?.setEnableISORecording(enabled));
  return `ISO recording ${enabled ? 'enabled' : 'disabled'}`;
}

// ─── ATEM: TIME / CLOCK ─────────────────────────────────────────────────────

async function atemSetTime(agent, params) {
  const hour = toInt(params.hour ?? 0, 'hour');
  const minute = toInt(params.minute ?? 0, 'minute');
  const second = toInt(params.second ?? 0, 'second');
  const frame = toInt(params.frame ?? 0, 'frame');
  await agent.atemCommand(() => agent.atem?.setTime(hour, minute, second, frame));
  return `Time set to ${hour}:${minute}:${second}:${frame}`;
}

async function atemRequestTime(agent) {
  await agent.atemCommand(async () => {
    if (typeof agent.atem?.requestTime !== 'function') throw new Error('requestTime not supported');
    return agent.atem.requestTime();
  });
  return 'Time requested';
}

async function atemSetDisplayClockProperties(agent, params) {
  const props = {};
  if (params.enabled !== undefined) props.enabled = !!params.enabled;
  if (params.size !== undefined) props.size = toInt(params.size, 'size');
  if (params.opacity !== undefined) props.opacity = Number(params.opacity);
  if (params.positionX !== undefined) props.positionX = Number(params.positionX);
  if (params.positionY !== undefined) props.positionY = Number(params.positionY);
  if (params.autoHide !== undefined) props.autoHide = !!params.autoHide;
  if (params.clockMode !== undefined) props.clockMode = toInt(params.clockMode, 'clockMode');
  if (params.startFrom !== undefined) props.startFrom = params.startFrom;
  await agent.atemCommand(() => agent.atem?.setDisplayClockProperties(props));
  return 'Display clock properties updated';
}

// ─── ATEM: MULTIVIEWER ──────────────────────────────────────────────────────

async function atemSetMultiViewerWindowSource(agent, params) {
  const source = toInt(params.source ?? params.input, 'source');
  const mv = toInt(params.mv ?? 0, 'mv');
  const window = toInt(params.window, 'window');
  await agent.atemCommand(() => agent.atem?.setMultiViewerWindowSource(source, mv, window));
  return `Multiviewer ${mv} window ${window} source set to ${source}`;
}

async function atemSetMultiViewerWindowSafeAreaEnabled(agent, params) {
  const enabled = params.enabled !== false;
  const mv = toInt(params.mv ?? 0, 'mv');
  const window = toInt(params.window, 'window');
  await agent.atemCommand(() => agent.atem?.setMultiViewerWindowSafeAreaEnabled(enabled, mv, window));
  return `Multiviewer ${mv} window ${window} safe area ${enabled ? 'enabled' : 'disabled'}`;
}

async function atemSetMultiViewerWindowVuEnabled(agent, params) {
  const enabled = params.enabled !== false;
  const mv = toInt(params.mv ?? 0, 'mv');
  const window = toInt(params.window, 'window');
  await agent.atemCommand(() => agent.atem?.setMultiViewerWindowVuEnabled(enabled, mv, window));
  return `Multiviewer ${mv} window ${window} VU meter ${enabled ? 'enabled' : 'disabled'}`;
}

async function atemSetMultiViewerVuOpacity(agent, params) {
  const opacity = Number(params.opacity);
  if (!Number.isFinite(opacity)) throw new Error('opacity must be a number');
  const mv = toInt(params.mv ?? 0, 'mv');
  await agent.atemCommand(() => agent.atem?.setMultiViewerVuOpacity(opacity, mv));
  return `Multiviewer ${mv} VU opacity set to ${opacity}`;
}

async function atemSetMultiViewerProperties(agent, params) {
  const mv = toInt(params.mv ?? 0, 'mv');
  const props = {};
  if (params.layout !== undefined) props.layout = toInt(params.layout, 'layout');
  if (params.programPreviewSwapped !== undefined) props.programPreviewSwapped = !!params.programPreviewSwapped;
  await agent.atemCommand(() => agent.atem?.setMultiViewerProperties(props, mv));
  return `Multiviewer ${mv} properties updated`;
}

// ─── ATEM: COLOR GENERATOR ──────────────────────────────────────────────────

async function atemSetColorGeneratorColour(agent, params) {
  const index = toInt(params.index ?? 0, 'index');
  const props = {};
  if (params.hue !== undefined) props.hue = Number(params.hue);
  if (params.saturation !== undefined) props.saturation = Number(params.saturation);
  if (params.luminance !== undefined) props.luminance = Number(params.luminance);
  await agent.atemCommand(() => agent.atem?.setColorGeneratorColour(props, index));
  return `Color generator ${index + 1} updated`;
}

// ─── ATEM: SAVE / RESTORE STATE ─────────────────────────────────────────────

async function atemSaveStartupState(agent) {
  await agent.atemCommand(async () => {
    if (typeof agent.atem?.saveStartupState !== 'function') throw new Error('saveStartupState not supported');
    return agent.atem.saveStartupState();
  });
  return 'Startup state saved';
}

async function atemClearStartupState(agent) {
  await agent.atemCommand(async () => {
    if (typeof agent.atem?.clearStartupState !== 'function') throw new Error('clearStartupState not supported');
    return agent.atem.clearStartupState();
  });
  return 'Startup state cleared';
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

  // 3. OBS connection and stream state (only if OBS is the configured encoder)
  const encoderType = agent.config?.encoderType || agent.config?.encoder?.type;
  const obsIsConfigured = encoderType === 'obs' || (!encoderType && agent.status.obs.connected);
  if (obsIsConfigured) {
    const obsConnected = agent.status.obs.connected;
    checks.push({ name: 'OBS Connection', pass: obsConnected, detail: obsConnected ? 'Connected' : 'Not connected' });

    if (obsConnected) {
      const alreadyStreaming = agent.status.obs.streaming;
      checks.push({
        name: 'OBS Stream State',
        pass: !alreadyStreaming,
      detail: alreadyStreaming ? 'Already streaming (expected?)' : 'Not streaming — ready to go',
    });
    }
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
      detail: mixerOnline ? `${mixerBrandName(agent.config.mixer?.type, agent.config.mixer?.model)} reachable` : 'Console not reachable',
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
  } else if (agent.status.audioViaAtem || agent.config.audioViaAtem) {
    // Audio routed directly into ATEM — no external mixer to check
    const sources = agent.status.atem?.atemAudioSources || [];
    const sourceDetail = sources.length > 0
      ? sources.map(s => `Input ${s.inputId}: ${s.portType} (${s.mixOption})`).join(', ')
      : 'configured manually';
    const tag = agent.status.audioViaAtemSource === 'manual' ? 'manual override' : 'auto-detected';
    checks.push({
      name: 'Audio Source',
      pass: true,
      detail: `Audio via ATEM [${tag}] — ${sourceDetail}`,
    });
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

async function systemDiagnosticBundle(agent) {
  return await collectDiagnosticBundle(agent);
}

// ─── COMMAND REGISTRY ───────────────────────────────────────────────────────

const commandHandlers = {
  'atem.cut': atemCut,
  'atem.auto': atemAuto,
  'atem.setProgram': atemSetProgram,
  'atem.setPreview': atemSetPreview,
  'atem.startRecording': atemStartRecording,
  'atem.stopRecording': atemStopRecording,
  'atem.startStreaming': atemStartStreaming,
  'atem.stopStreaming': atemStopStreaming,
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
  'atem.autoDsk': atemAutoDownstreamKey,
  'atem.setDskGeneralProperties': atemSetDskGeneralProperties,
  'atem.setDskMaskSettings': atemSetDskMaskSettings,

  // Video switching (additional)
  'atem.setFadeToBlackRate': atemSetFadeToBlackRate,
  'atem.listVisibleInputs': atemListVisibleInputs,

  // Transition settings
  'atem.setDipTransitionSettings': atemSetDipTransitionSettings,
  'atem.setWipeTransitionSettings': atemSetWipeTransitionSettings,
  'atem.setDVETransitionSettings': atemSetDVETransitionSettings,
  'atem.setStingerTransitionSettings': atemSetStingerTransitionSettings,
  'atem.setTransitionPosition': atemSetTransitionPosition,
  'atem.previewTransition': atemPreviewTransition,

  // Upstream keyers
  'atem.setUskOnAir': atemSetUskOnAir,
  'atem.setUskCutSource': atemSetUskCutSource,
  'atem.setUskFillSource': atemSetUskFillSource,
  'atem.setUskType': atemSetUskType,
  'atem.setUskLumaSettings': atemSetUskLumaSettings,
  'atem.setUskChromaSettings': atemSetUskChromaSettings,
  'atem.setUskPatternSettings': atemSetUskPatternSettings,
  'atem.setUskDVESettings': atemSetUskDVESettings,
  'atem.setUskMaskSettings': atemSetUskMaskSettings,
  'atem.runUskFlyKeyTo': atemRunUskFlyKeyTo,
  'atem.runUskFlyKeyToInfinite': atemRunUskFlyKeyToInfinite,

  // SuperSource
  'atem.setSuperSourceBoxSettings': atemSetSuperSourceBoxSettings,
  'atem.setSuperSourceProperties': atemSetSuperSourceProperties,
  'atem.setSuperSourceBorder': atemSetSuperSourceBorder,

  // Macro management
  'atem.macroContinue': atemMacroContinue,
  'atem.macroDelete': atemMacroDelete,
  'atem.macroInsertUserWait': atemMacroInsertUserWait,
  'atem.macroInsertTimedWait': atemMacroInsertTimedWait,
  'atem.macroStartRecord': atemMacroStartRecord,
  'atem.macroStopRecord': atemMacroStopRecord,
  'atem.macroUpdateProperties': atemMacroUpdateProperties,
  'atem.macroSetLoop': atemMacroSetLoop,

  // Media pool (additional)
  'atem.setMediaPlayerSettings': atemSetMediaPlayerSettings,
  'atem.setMediaClip': atemSetMediaClip,
  'atem.clearMediaPoolClip': atemClearMediaPoolClip,

  // Classic audio
  'atem.setClassicAudioInputProps': atemSetClassicAudioInputProps,
  'atem.setClassicAudioMasterProps': atemSetClassicAudioMasterProps,
  'atem.setClassicAudioMonitorProps': atemSetClassicAudioMonitorProps,
  'atem.setClassicAudioHeadphonesProps': atemSetClassicAudioHeadphonesProps,
  'atem.setClassicAudioResetPeaks': atemSetClassicAudioResetPeaks,
  'atem.setClassicAudioMixerProps': atemSetClassicAudioMixerProps,

  // Fairlight audio
  'atem.setFairlightAudioMasterProps': atemSetFairlightAudioMasterProps,
  'atem.setFairlightAudioMasterCompressorProps': atemSetFairlightAudioMasterCompressorProps,
  'atem.setFairlightAudioMasterLimiterProps': atemSetFairlightAudioMasterLimiterProps,
  'atem.setFairlightAudioMasterEqBandProps': atemSetFairlightAudioMasterEqBandProps,
  'atem.setFairlightAudioMasterEqReset': atemSetFairlightAudioMasterEqReset,
  'atem.setFairlightAudioMasterDynamicsReset': atemSetFairlightAudioMasterDynamicsReset,
  'atem.setFairlightAudioResetPeaks': atemSetFairlightAudioResetPeaks,
  'atem.startFairlightSendLevels': atemStartFairlightSendLevels,
  'atem.stopFairlightSendLevels': atemStopFairlightSendLevels,
  'atem.setFairlightAudioMonitorProps': atemSetFairlightAudioMonitorProps,
  'atem.setFairlightAudioMonitorSolo': atemSetFairlightAudioMonitorSolo,
  'atem.setFairlightAudioInputProps': atemSetFairlightAudioInputProps,
  'atem.setFairlightAudioSourceProps': atemSetFairlightAudioSourceProps,
  'atem.setFairlightAudioSourceCompressorProps': atemSetFairlightAudioSourceCompressorProps,
  'atem.setFairlightAudioSourceLimiterProps': atemSetFairlightAudioSourceLimiterProps,
  'atem.setFairlightAudioSourceExpanderProps': atemSetFairlightAudioSourceExpanderProps,
  'atem.setFairlightAudioSourceEqBandProps': atemSetFairlightAudioSourceEqBandProps,

  // Streaming & recording (additional)
  'atem.requestStreamingDuration': atemRequestStreamingDuration,
  'atem.setStreamingService': atemSetStreamingService,
  'atem.setStreamingAudioBitrates': atemSetStreamingAudioBitrates,
  'atem.requestRecordingDuration': atemRequestRecordingDuration,
  'atem.switchRecordingDisk': atemSwitchRecordingDisk,
  'atem.setRecordingSettings': atemSetRecordingSettings,
  'atem.setEnableISORecording': atemSetEnableISORecording,

  // Time / clock
  'atem.setTime': atemSetTime,
  'atem.requestTime': atemRequestTime,
  'atem.setDisplayClockProperties': atemSetDisplayClockProperties,

  // Multiviewer
  'atem.setMultiViewerWindowSource': atemSetMultiViewerWindowSource,
  'atem.setMultiViewerWindowSafeAreaEnabled': atemSetMultiViewerWindowSafeAreaEnabled,
  'atem.setMultiViewerWindowVuEnabled': atemSetMultiViewerWindowVuEnabled,
  'atem.setMultiViewerVuOpacity': atemSetMultiViewerVuOpacity,
  'atem.setMultiViewerProperties': atemSetMultiViewerProperties,

  // Color generator
  'atem.setColorGeneratorColour': atemSetColorGeneratorColour,

  // Save / restore state
  'atem.saveStartupState': atemSaveStartupState,
  'atem.clearStartupState': atemClearStartupState,

  'hyperdeck.play': hyperdeckPlay,
  'hyperdeck.stop': hyperdeckStop,
  'hyperdeck.record': hyperdeckRecord,
  'hyperdeck.stopRecord': hyperdeckStopRecord,
  'hyperdeck.nextClip': hyperdeckNextClip,
  'hyperdeck.prevClip': hyperdeckPrevClip,
  'hyperdeck.status': hyperdeckStatus,
  'hyperdeck.selectSlot': hyperdeckSelectSlot,
  'hyperdeck.setPlaySpeed': hyperdeckSetPlaySpeed,
  'hyperdeck.goToClip': hyperdeckGoToClip,
  'hyperdeck.goToTimecode': hyperdeckGoToTimecode,
  'hyperdeck.jog': hyperdeckJog,

  'ptz.pan': ptzPan,
  'ptz.tilt': ptzTilt,
  'ptz.zoom': ptzZoom,
  'ptz.preset': ptzPreset,
  'ptz.stop': ptzStop,
  'ptz.home': ptzHome,
  'ptz.setPreset': ptzSetPreset,
  'ptz.autoFocus': ptzAutoFocus,
  'ptz.manualFocus': ptzManualFocus,
  'ptz.focusNear': ptzFocusNear,
  'ptz.focusFar': ptzFocusFar,
  'ptz.focusStop': ptzFocusStop,
  'ptz.autoWhiteBalance': ptzAutoWhiteBalance,
  'ptz.indoorWhiteBalance': ptzIndoorWhiteBalance,
  'ptz.outdoorWhiteBalance': ptzOutdoorWhiteBalance,
  'ptz.onePushWb': ptzOnePushWb,
  'ptz.backlightComp': ptzBacklightComp,

  // Blackmagic camera control (via ATEM)
  'camera.setIris': cameraSetIris,
  'camera.autoIris': cameraAutoIris,
  'camera.setGain': cameraSetGain,
  'camera.setISO': cameraSetISO,
  'camera.setWhiteBalance': cameraSetWhiteBalance,
  'camera.autoWhiteBalance': cameraAutoWhiteBalance,
  'camera.setShutter': cameraSetShutter,
  'camera.setFocus': cameraSetFocus,
  'camera.autoFocus': cameraAutoFocus,
  'camera.setLift': cameraSetLift,
  'camera.setGamma': cameraSetGamma,
  'camera.setColorGain': cameraSetColorGain,
  'camera.setContrast': cameraSetContrast,
  'camera.setSaturation': cameraSetSaturation,
  'camera.resetColorCorrection': cameraResetColorCorrection,

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
  'encoder.startStream': encoderStartStream,
  'encoder.stopStream': encoderStopStream,
  'encoder.startRecording': encoderStartRecording,
  'encoder.stopRecording': encoderStopRecording,
  'encoder.status': encoderStatus,

  // Blackmagic Web Presenter
  'blackmagic.getActivePlatform': blackmagicGetActivePlatform,
  'blackmagic.setActivePlatform': blackmagicSetActivePlatform,
  'blackmagic.getPlatforms': blackmagicGetPlatforms,
  'blackmagic.getPlatformConfig': blackmagicGetPlatformConfig,
  'blackmagic.getVideoFormat': blackmagicGetVideoFormat,
  'blackmagic.setVideoFormat': blackmagicSetVideoFormat,
  'blackmagic.getSupportedVideoFormats': blackmagicGetSupportedVideoFormats,
  'blackmagic.getAudioSources': blackmagicGetAudioSources,
  'blackmagic.setAudioSource': blackmagicSetAudioSource,

  // AJA HELO
  'aja.setVideoInput': ajaSetVideoInput,
  'aja.setAudioInput': ajaSetAudioInput,
  'aja.setStreamProfile': ajaSetStreamProfile,
  'aja.setRecordProfile': ajaSetRecordProfile,
  'aja.setMute': ajaSetMute,
  'aja.recallPreset': ajaRecallPreset,

  // Epiphan Pearl
  'epiphan.startPublisher': epiphanStartPublisher,
  'epiphan.stopPublisher': epiphanStopPublisher,
  'epiphan.getLayouts': epiphanGetLayouts,
  'epiphan.setActiveLayout': epiphanSetActiveLayout,
  'epiphan.getStreamingParams': epiphanGetStreamingParams,
  'epiphan.setStreamingParams': epiphanSetStreamingParams,

  // Ecamm Live
  'ecamm.togglePause': ecammTogglePause,
  'ecamm.getScenes': ecammGetScenes,
  'ecamm.setScene': ecammSetScene,
  'ecamm.nextScene': ecammNextScene,
  'ecamm.prevScene': ecammPrevScene,
  'ecamm.toggleMute': ecammToggleMute,
  'ecamm.getInputs': ecammGetInputs,
  'ecamm.setInput': ecammSetInput,
  'ecamm.togglePIP': ecammTogglePIP,
  'ecamm.getOverlays': ecammGetOverlays,

  // NDI
  'ndi.getSource': ndiGetSource,
  'ndi.setSource': ndiSetSource,

  'status': getStatus,
  'system.preServiceCheck': preServiceCheck,

  'preview.start': previewStart,
  'preview.stop': previewStop,
  'preview.snap': previewSnap,

  'obs.reduceBitrate': obsReduceBitrate,
  'system.setWatchdogMode': systemSetWatchdogMode,
  'system.getServiceWindow': systemGetServiceWindow,
  'system.diagnosticBundle': systemDiagnosticBundle,

  'videohub.route': videohubRoute,
  'videohub.getRoutes': videohubGetRoutes,
  'videohub.setInputLabel': videohubSetInputLabel,
  'videohub.setOutputLabel': videohubSetOutputLabel,
  'videohub.getInputLabels': videohubGetInputLabels,
  'videohub.getOutputLabels': videohubGetOutputLabels,

  'propresenter.next': propresenterNext,
  'propresenter.previous': propresenterPrevious,
  'propresenter.goToSlide': propresenterGoToSlide,
  'propresenter.lastSlide': propresenterLastSlide,
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
  'propresenter.version': propresenterVersion,
  'propresenter.messages': propresenterMessages,

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
  'resolume.version': resolumeVersion,
  'resolume.getBpm': resolumeGetBpm,
  'resolume.playClipByName': resolumePlayClipByName,
  'resolume.triggerColumnByName': resolumeTriggerColumnByName,

  'mixer.status': mixerStatus,
  'mixer.mute': mixerMute,
  'mixer.unmute': mixerUnmute,
  'mixer.channelStatus': mixerChannelStatus,
  'mixer.recallScene': mixerRecallScene,
  'mixer.clearSolos': mixerClearSolos,
  'mixer.isOnline': mixerIsOnline,
  'mixer.setFader': mixerSetFader,
  'mixer.setChannelName': mixerSetChannelName,
  'mixer.setHpf': mixerSetHpf,
  'mixer.setEq': mixerSetEq,
  'mixer.setCompressor': mixerSetCompressor,
  'mixer.setGate': mixerSetGate,
  'mixer.setFullChannelStrip': mixerSetFullChannelStrip,
  'mixer.saveScene': mixerSaveScene,
  'mixer.setPreampGain': mixerSetPreampGain,
  'mixer.setPhantom': mixerSetPhantom,
  'mixer.setPan': mixerSetPan,
  'mixer.setChannelColor': mixerSetChannelColor,
  'mixer.setChannelIcon': mixerSetChannelIcon,
  'mixer.setSendLevel': mixerSetSendLevel,
  'mixer.assignToBus': mixerAssignToBus,
  'mixer.assignToDca': mixerAssignToDca,
  'mixer.getMeters': mixerGetMeters,
  'mixer.verifySceneSave': mixerVerifySceneSave,
  'mixer.setupFromPatchList': mixerSetupFromPatchList,
  'mixer.capabilities': mixerCapabilities,
  'mixer.muteDca': mixerMuteDca,
  'mixer.unmuteDca': mixerUnmuteDca,
  'mixer.setDcaFader': mixerSetDcaFader,
  'mixer.activateMuteGroup': mixerActivateMuteGroup,
  'mixer.deactivateMuteGroup': mixerDeactivateMuteGroup,
  'mixer.pressSoftKey': mixerPressSoftKey,

  'atem.uploadStill': atemUploadStill,
  'atem.setMediaPlayer': atemSetMediaPlayer,
  'atem.captureStill': atemCaptureStill,
  'atem.clearStill': atemClearStill,

  'dante.scene': danteScene,

  'companion.press': companionPress,
  'companion.pressNamed': companionPressNamed,
  'companion.getGrid': companionGetGrid,
  'companion.connections': companionConnections,

  'preset.save': presetSave,
  'preset.list': presetList,
  'preset.recall': presetRecall,
  'preset.delete': presetDelete,

  ...require('./commands/recovery'),
};

module.exports = { commandHandlers };
