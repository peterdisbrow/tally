/**
 * ATEM command handlers — video switcher, keyers, audio, media.
 */
const { toInt } = require('./helpers');

// ─── Friendly input name mapping ────────────────────────────────────────────
function friendlyInputName(input) {
  if (input == null) return '';
  const n = Number(input);
  if (n >= 1 && n <= 40) return `Cam ${n}`;
  if (n >= 1000 && n < 2000) return `Color Bars`;
  if (n === 2001) return `Color 1`;
  if (n === 2002) return `Color 2`;
  if (n >= 3010 && n <= 3010) return `MP1`;
  if (n === 3011) return `MP1 Key`;
  if (n === 3020) return `MP2`;
  if (n === 3021) return `MP2 Key`;
  if (n === 6000) return `Super Source`;
  if (n === 7001) return `Clean Feed 1`;
  if (n === 7002) return `Clean Feed 2`;
  if (n === 10010) return `ME 1 PGM`;
  if (n === 10011) return `ME 1 PVW`;
  return `${n}`;
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
 *
 * @param {object} agent
 * @param {number} input
 * @param {string} [switcherId] — optional: validate against a specific switcher's labels
 */
function validateAtemInput(agent, input, switcherId) {
  if (input == null || input >= 1000) return; // special sources are fine

  // Resolve labels from a specific switcher or from legacy status.atem
  let labels;
  if (switcherId && agent.switcherManager) {
    const sw = agent.switcherManager.get(switcherId);
    if (sw) {
      const s = sw.getStatus();
      labels = s.inputLabels;
    }
  }
  if (!labels) labels = agent.status?.atem?.inputLabels;
  if (!labels || typeof labels !== 'object') return; // can't validate without labels
  const knownIds = Object.keys(labels).map(Number).filter((n) => n >= 1 && n <= 40);
  if (knownIds.length === 0) return; // no label data
  if (!knownIds.includes(input)) {
    const available = knownIds.sort((a, b) => a - b).join(', ');
    throw new Error(`Camera ${input} doesn't exist on this switcher. Available inputs: ${available}. Try one of those instead.`);
  }
}

/**
 * Resolve the ATEM instance and connected flag for a command.
 * If params.switcherId is set, use that specific switcher's raw Atem.
 * Otherwise use the legacy agent.atem (primary).
 */
function resolveAtem(agent, params) {
  if (params.switcherId && agent.switcherManager) {
    const sw = agent.switcherManager.get(params.switcherId);
    if (!sw) throw new Error(`Switcher "${params.switcherId}" not found`);
    if (sw.type !== 'atem') throw new Error(`Switcher "${params.switcherId}" is ${sw.type}, not ATEM`);
    if (!sw.connected) throw new Error(`ATEM "${params.switcherId}" not connected`);
    return { atem: sw.raw, fake: false };
  }
  return { atem: agent.atem, fake: isFakeAtem(agent) };
}

// ─── CORE SWITCHING ─────────────────────────────────────────────────────────

async function atemCut(agent, params) {
  const me = toInt(params.me ?? 0, 'me');
  const input = params.input != null ? toInt(params.input, 'input') : null;
  if (input != null) validateAtemInput(agent, input, params.switcherId);
  const { atem, fake } = resolveAtem(agent, params);
  await agent.atemCommand(async () => {
    if (input != null) {
      if (fake) await atem?.changeProgramInput(me, input);
      else await atem?.changeProgramInput(input, me);
      return;
    }
    await atem?.cut(me);
  });
  return input != null ? `Cut to ${friendlyInputName(input)}` : 'Cut executed';
}

async function atemAuto(agent, params) {
  const { atem } = resolveAtem(agent, params);
  await agent.atemCommand(() => atem?.autoTransition(params.me || 0));
  return 'Auto transition executed';
}

async function atemSetProgram(agent, params) {
  const input = toInt(params.input, 'input');
  const me = toInt(params.me ?? 0, 'me');
  validateAtemInput(agent, input, params.switcherId);
  const { atem, fake } = resolveAtem(agent, params);
  await agent.atemCommand(() => {
    if (fake) return atem?.changeProgramInput(me, input);
    return atem?.changeProgramInput(input, me);
  });
  return `Program set to ${friendlyInputName(input)}`;
}

async function atemSetPreview(agent, params) {
  const input = toInt(params.input, 'input');
  const me = toInt(params.me ?? 0, 'me');
  validateAtemInput(agent, input, params.switcherId);
  const { atem, fake } = resolveAtem(agent, params);
  await agent.atemCommand(() => {
    if (fake) return atem?.changePreviewInput(me, input);
    return atem?.changePreviewInput(input, me);
  });
  return `Preview set to ${friendlyInputName(input)}`;
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
  return `${friendlyInputName(input)} labeled "${params.longName}"`;
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

// ─── MEDIA HANDLERS ─────────────────────────────────────────────────────────

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

// ─── COMPANION PARITY: Monitoring Feedbacks ──────────────────────────────────

async function atemGetFadeToBlackStatus(agent) {
  const state = agent.atem?.state;
  if (!state) throw new Error('ATEM state not available');
  const me = state.video?.mixEffects?.[0];
  if (!me) return { active: false, inTransition: false, remainingFrames: 0 };
  const ftb = me.fadeToBlack || {};
  return {
    active: !!ftb.isFullyBlack,
    inTransition: !!ftb.inTransition,
    remainingFrames: ftb.remainingFrames || 0,
    rate: ftb.rate || 0,
  };
}

async function atemGetTransitionStatus(agent) {
  const state = agent.atem?.state;
  if (!state) throw new Error('ATEM state not available');
  const me = state.video?.mixEffects?.[0];
  if (!me) return { inTransition: false, position: 0, style: null, preview: false };
  const tp = me.transitionPosition || {};
  const ts = me.transitionSettings || {};
  return {
    inTransition: !!tp.inTransition,
    position: tp.handlePosition || 0,
    remainingFrames: tp.remainingFrames || 0,
    style: ts.nextTransition?.style ?? null,
    preview: !!me.transitionPreview,
  };
}

async function atemGetMacroStatus(agent) {
  const state = agent.atem?.state;
  if (!state) throw new Error('ATEM state not available');
  const macro = state.macro || {};
  return {
    isRunning: !!macro.macroPlayer?.isRunning,
    isWaiting: !!macro.macroPlayer?.isWaiting,
    isRecording: !!macro.macroRecorder?.isRecording,
    loop: !!macro.macroPlayer?.loop,
    runningIndex: macro.macroPlayer?.macroIndex ?? null,
    recordingIndex: macro.macroRecorder?.macroIndex ?? null,
  };
}

async function atemGetCameraControl(agent, params) {
  // Camera control via ATEM Camera Control Protocol (CCdP)
  // Returns camera settings from ATEM's internal state
  const state = agent.atem?.state;
  if (!state) throw new Error('ATEM state not available');
  const cameras = agent.status?.atem?.cameras || {};
  if (params.camera) {
    const cam = cameras[params.camera];
    if (!cam) throw new Error(`Camera ${params.camera} not found in ATEM state`);
    return cam;
  }
  return cameras;
}

async function atemGetTallyByIndex(agent, params) {
  const state = agent.atem?.state;
  if (!state) throw new Error('ATEM state not available');
  const me = state.video?.mixEffects?.[0];
  if (!me) return { input: null, program: false, preview: false };
  const input = toInt(params.input, 'input');
  return {
    input,
    name: friendlyInputName(input),
    program: me.programInput === input,
    preview: me.previewInput === input,
  };
}

async function atemGetInputProperties(agent) {
  const state = agent.atem?.state;
  if (!state) throw new Error('ATEM state not available');
  const inputs = state.inputs || {};
  const result = [];
  for (const [id, inp] of Object.entries(inputs)) {
    result.push({
      id: Number(id),
      shortName: inp.shortName || '',
      longName: inp.longName || '',
      externalPortType: inp.externalPortType ?? null,
      internalPortType: inp.internalPortType ?? null,
      availableExternalPortTypes: inp.availableExternalPortTypes || [],
      meAvailability: inp.meAvailability ?? null,
    });
  }
  return result.sort((a, b) => a.id - b.id);
}

// ─── COMPANION PARITY: Transition Selection ────────────────────────────────

async function atemSetTransitionSelection(agent, params) {
  const me = toInt(params.me ?? 0, 'me');
  const selection = toInt(params.selection, 'selection');
  await agent.atemCommand(() => agent.atem?.setTransitionStyle({ nextSelection: selection }, me));
  return `Transition selection set to bitmask ${selection} on ME ${me}`;
}

// ─── COMPANION PARITY: USK Keyframes ───────────────────────────────────────

async function atemStoreUskKeyframe(agent, params) {
  const me = toInt(params.me ?? 0, 'me');
  const keyer = toInt(params.keyer ?? params.key ?? 0, 'keyer');
  const keyFrameId = toInt(params.keyFrame ?? params.keyFrameId, 'keyFrame');
  await agent.atemCommand(() => agent.atem?.storeUpstreamKeyerFlyKeyKeyframe(me, keyer, keyFrameId));
  return `USK ${keyer} keyframe ${keyFrameId} stored on ME ${me}`;
}

// ─── COMPANION PARITY: Media Player Cycle ──────────────────────────────────

async function atemMediaPlayerCycle(agent, params) {
  if (!agent.atem) throw new Error('ATEM not configured');
  const playerIdx = toInt(params.player ?? 0, 'player');

  // Read current state
  const state = agent.atem.state;
  const mpState = state?.media?.players?.[playerIdx];
  const poolStills = state?.media?.stillPool || [];

  // Count available stills
  const validStills = [];
  for (let i = 0; i < poolStills.length; i++) {
    if (poolStills[i]?.isUsed) validStills.push(i);
  }
  if (validStills.length === 0) throw new Error('No stills in media pool to cycle through');

  // Find current index and advance
  const currentIndex = mpState?.stillIndex ?? 0;
  const currentPos = validStills.indexOf(currentIndex);
  const nextPos = (currentPos + 1) % validStills.length;
  const nextIndex = validStills[nextPos];

  await agent.atem.setMediaPlayerSource({ sourceType: 0, stillIndex: nextIndex }, playerIdx);
  return `Media player ${playerIdx + 1} cycled to still ${nextIndex + 1}`;
}

// ─── COMPANION PARITY: Fairlight Audio Routing ─────────────────────────────

async function atemSetFairlightAudioRouting(agent, params) {
  const outputId = toInt(params.outputId, 'outputId');
  const sourceId = toInt(params.sourceId, 'sourceId');
  await agent.atemCommand(async () => {
    if (typeof agent.atem?.setFairlightAudioRoutingOutput !== 'function') {
      throw new Error('setFairlightAudioRoutingOutput not supported on this switcher');
    }
    return agent.atem.setFairlightAudioRoutingOutput(outputId, { sourceId });
  });
  return `Fairlight audio routing output ${outputId} set to source ${sourceId}`;
}

// ─── COMPANION PARITY: Timecode Mode ───────────────────────────────────────

async function atemSetTimecodeMode(agent, params) {
  const mode = toInt(params.mode, 'mode');
  await agent.atemCommand(async () => {
    if (typeof agent.atem?.setTimecodeMode !== 'function') {
      throw new Error('setTimecodeMode not supported on this switcher');
    }
    return agent.atem.setTimecodeMode(mode);
  });
  const modeName = mode === 0 ? 'free run' : mode === 1 ? 'time of day' : `mode ${mode}`;
  return `Timecode mode set to ${modeName}`;
}

// ─── COMMAND REGISTRY ───────────────────────────────────────────────────────

module.exports = {
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

  // Media (upload / player / capture)
  'atem.uploadStill': atemUploadStill,
  'atem.setMediaPlayer': atemSetMediaPlayer,
  'atem.captureStill': atemCaptureStill,
  'atem.clearStill': atemClearStill,

  // Companion parity: monitoring feedbacks
  'atem.getFadeToBlackStatus': atemGetFadeToBlackStatus,
  'atem.getTransitionStatus': atemGetTransitionStatus,
  'atem.getMacroStatus': atemGetMacroStatus,
  'atem.getCameraControl': atemGetCameraControl,
  'atem.getTallyByIndex': atemGetTallyByIndex,
  'atem.getInputProperties': atemGetInputProperties,

  // Companion parity: transition selection, USK keyframes, media cycle, routing, timecode
  'atem.setTransitionSelection': atemSetTransitionSelection,
  'atem.storeUskKeyframe': atemStoreUskKeyframe,
  'atem.setUskKeyframe': atemStoreUskKeyframe,
  'atem.mediaPlayerCycle': atemMediaPlayerCycle,
  'atem.setFairlightAudioRouting': atemSetFairlightAudioRouting,
  'atem.setTimecodeMode': atemSetTimecodeMode,
};
