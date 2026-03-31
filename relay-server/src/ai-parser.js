/**
 * ai-parser.js
 * Anthropic Claude natural language command parser for Tally church AV system.
 * Uses Claude Haiku for fast, cheap parsing.
 * Returns { command, params } shape or multi-step array.
 */

const { isOnTopic, OFF_TOPIC_RESPONSE } = require('./chat-guard');

// ─── AI USAGE LOGGING ────────────────────────────────────────────────────────

let _logAiUsage = null;
function setAiUsageLogger(fn) { _logAiUsage = fn; }

// ─── COST CONTROLS ──────────────────────────────────────────────────────────

// Simple LRU cache for AI responses (keyed on normalized message text)
const CACHE_TTL = 60 * 1000; // 1 minute
const CACHE_MAX = 200;
const responseCache = new Map();

function getCachedResponse(key) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    responseCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedResponse(key, value) {
  // Evict oldest if at capacity
  if (responseCache.size >= CACHE_MAX) {
    const oldest = responseCache.keys().next().value;
    responseCache.delete(oldest);
  }
  responseCache.set(key, { value, ts: Date.now() });
}

// Per-church AI call rate limit (tier-based)
const AI_RATE_LIMITS = {
  connect: 5,     // basic taste — upgrade to Plus for more
  plus: 30,
  pro: 60,
  managed: 250,   // Enterprise gets highest throughput
  event: 15,
  default: 15,
};
const AI_RATE_WINDOW = 60 * 60 * 1000; // 1 hour
const aiCallCounts = new Map(); // churchId → { count, windowStart }

// Incident bypass hook — set by server.js to check signalFailover state
let _incidentBypassCheck = null;
function setIncidentBypassCheck(fn) { _incidentBypassCheck = fn; }

function checkAiRateLimit(churchId, tier) {
  if (!churchId) {
    console.warn('[ai-parser] Rate limit check called without churchId — applying default limit');
    return true; // Allow but log — churchId should always be present
  }
  // Active incident bypass: during CONFIRMED_OUTAGE / FAILOVER_ACTIVE, skip limits
  if (_incidentBypassCheck && _incidentBypassCheck(churchId)) return true;
  const limit = AI_RATE_LIMITS[tier] || AI_RATE_LIMITS.default;
  const now = Date.now();
  let bucket = aiCallCounts.get(churchId);
  if (!bucket || now - bucket.windowStart > AI_RATE_WINDOW) {
    bucket = { count: 0, windowStart: now };
    aiCallCounts.set(churchId, bucket);
  }
  if (bucket.count >= limit) return false;
  bucket.count++;
  return true;
}

// ─── Configured-device extraction from room equipment JSON ─────────────────
// Maps equipment config keys → status object keys
const EQUIPMENT_TO_STATUS_KEY = {
  atem: 'atem',
  atems: 'atem',  // multi-ATEM array key
  companion: 'companion',
  encoder: 'encoder',
  propresenter: 'proPresenter',
  vmix: 'vmix',
  resolume: 'resolume',
  mixer: 'mixer',
  hyperdeck: 'hyperdeck',
  ptz: 'ptz',
  videohub: 'videohub',
  obs: 'obs',
  ecamm: 'ecamm',
  dante: 'dante',
  ndi: 'ndi',
};

// Display names for status reporting
const DEVICE_DISPLAY_NAMES = {
  atem: 'ATEM',
  companion: 'Companion',
  encoder: 'Encoder',
  proPresenter: 'ProPresenter',
  vmix: 'vMix',
  resolume: 'Resolume',
  mixer: 'Audio Mixer',
  hyperdeck: 'HyperDeck',
  ptz: 'PTZ',
  videohub: 'VideoHub',
  obs: 'OBS',
  ecamm: 'Ecamm',
  dante: 'Dante',
  ndi: 'NDI',
};

/**
 * Extract configured device type keys (status-object keys) from room equipment JSON.
 * Returns an array like ['atem', 'proPresenter', 'encoder'] for devices actually set up.
 */
function getConfiguredDeviceTypes(equipment) {
  if (!equipment || typeof equipment !== 'object') return [];
  const configured = [];
  for (const [eqKey, statusKey] of Object.entries(EQUIPMENT_TO_STATUS_KEY)) {
    const val = equipment[eqKey];
    if (!val) continue;
    // Multi-instance devices (encoder, hyperdeck, ptz, videohub) are arrays
    if (Array.isArray(val)) {
      if (eqKey === 'encoder') {
        if (val.some(e => e.encoderType)) configured.push(statusKey);
      } else if (eqKey === 'atem') {
        // Multi-ATEM: atems array — check if any entry has an ip
        if (val.some(e => e.ip || e.host)) configured.push(statusKey);
      } else {
        // ptz, hyperdeck, videohub — check if any entry has an ip/host
        if (val.some(e => e.ip || e.host)) configured.push(statusKey);
      }
    } else if (typeof val === 'object') {
      // Single devices — check 'configured' flag or any meaningful field
      if (val.configured) {
        configured.push(statusKey);
      } else if (eqKey === 'atem' && (val.ip || val.host)) {
        configured.push(statusKey);
      } else if (eqKey === 'companion' && val.host) {
        configured.push(statusKey);
      } else if (eqKey === 'mixer' && val.type) {
        configured.push(statusKey);
      } else if (val.host || val.ip) {
        configured.push(statusKey);
      }
    }
  }
  return configured;
}

// ─── System prompt ─────────────────────────────────────────────────────────

const FALLBACK_COMMANDS = [
  // ── AJA HELO ──
  'aja.recallPreset',
  'aja.setAudioInput',
  'aja.setMute',
  'aja.setRecordProfile',
  'aja.setStreamProfile',
  'aja.setVideoInput',
  // ── ATEM (video switching) ──
  'atem.auto',
  'atem.autoDsk',
  'atem.captureStill',
  'atem.clearMediaPoolClip',
  'atem.clearStartupState',
  'atem.clearStill',
  'atem.cut',
  'atem.fadeToBlack',
  'atem.listVisibleInputs',
  'atem.macroContinue',
  'atem.macroDelete',
  'atem.macroInsertTimedWait',
  'atem.macroInsertUserWait',
  'atem.macroSetLoop',
  'atem.macroStartRecord',
  'atem.macroStopRecord',
  'atem.macroUpdateProperties',
  'atem.previewTransition',
  'atem.requestRecordingDuration',
  'atem.requestStreamingDuration',
  'atem.requestTime',
  'atem.runMacro',
  'atem.runUskFlyKeyTo',
  'atem.runUskFlyKeyToInfinite',
  'atem.saveStartupState',
  'atem.setAux',
  // ── ATEM (classic audio) ──
  'atem.setClassicAudioHeadphonesProps',
  'atem.setClassicAudioInputProps',
  'atem.setClassicAudioMasterProps',
  'atem.setClassicAudioMixerProps',
  'atem.setClassicAudioMonitorProps',
  'atem.setClassicAudioResetPeaks',
  // ── ATEM (misc) ──
  'atem.setColorGeneratorColour',
  'atem.setDVETransitionSettings',
  'atem.setDipTransitionSettings',
  'atem.setDisplayClockProperties',
  'atem.setDskGeneralProperties',
  'atem.setDskMaskSettings',
  'atem.setDskOnAir',
  'atem.setDskRate',
  'atem.setDskSource',
  'atem.setDskTie',
  'atem.setEnableISORecording',
  'atem.setFadeToBlackRate',
  // ── ATEM (Fairlight audio) ──
  'atem.setFairlightAudioInputProps',
  'atem.setFairlightAudioMasterCompressorProps',
  'atem.setFairlightAudioMasterDynamicsReset',
  'atem.setFairlightAudioMasterEqBandProps',
  'atem.setFairlightAudioMasterEqReset',
  'atem.setFairlightAudioMasterLimiterProps',
  'atem.setFairlightAudioMasterProps',
  'atem.setFairlightAudioMonitorProps',
  'atem.setFairlightAudioMonitorSolo',
  'atem.setFairlightAudioResetPeaks',
  'atem.setFairlightAudioSourceCompressorProps',
  'atem.setFairlightAudioSourceEqBandProps',
  'atem.setFairlightAudioSourceExpanderProps',
  'atem.setFairlightAudioSourceLimiterProps',
  'atem.setFairlightAudioSourceProps',
  // ── ATEM (inputs, media, transitions, keys) ──
  'atem.setInputLabel',
  'atem.setMediaClip',
  'atem.setMediaPlayer',
  'atem.setMediaPlayerSettings',
  'atem.setMultiViewerProperties',
  'atem.setMultiViewerVuOpacity',
  'atem.setMultiViewerWindowSafeAreaEnabled',
  'atem.setMultiViewerWindowSource',
  'atem.setMultiViewerWindowVuEnabled',
  'atem.setPreview',
  'atem.setProgram',
  'atem.setRecordingSettings',
  'atem.setStingerTransitionSettings',
  'atem.setStreamingAudioBitrates',
  'atem.setStreamingService',
  'atem.setSuperSourceBorder',
  'atem.setSuperSourceBoxSettings',
  'atem.setSuperSourceProperties',
  'atem.setTime',
  'atem.setTransitionPosition',
  'atem.setTransitionRate',
  'atem.setTransitionStyle',
  'atem.setUskChromaSettings',
  'atem.setUskCutSource',
  'atem.setUskDVESettings',
  'atem.setUskFillSource',
  'atem.setUskLumaSettings',
  'atem.setUskMaskSettings',
  'atem.setUskOnAir',
  'atem.setUskPatternSettings',
  'atem.setUskType',
  'atem.setWipeTransitionSettings',
  'atem.startFairlightSendLevels',
  'atem.startRecording',
  'atem.startStreaming',
  'atem.stopFairlightSendLevels',
  'atem.stopMacro',
  'atem.stopRecording',
  'atem.stopStreaming',
  'atem.switchRecordingDisk',
  'atem.uploadStill',
  // ── Multi-switcher (abstract) ──
  'switcher.cut',
  'switcher.setProgram',
  'switcher.setPreview',
  'switcher.auto',
  'switcher.list',
  'switcher.status',
  // ── Blackmagic Web Presenter ──
  'blackmagic.getActivePlatform',
  'blackmagic.getAudioSources',
  'blackmagic.getPlatformConfig',
  'blackmagic.getPlatforms',
  'blackmagic.getSupportedVideoFormats',
  'blackmagic.getVideoFormat',
  'blackmagic.setActivePlatform',
  'blackmagic.setAudioSource',
  'blackmagic.setVideoFormat',
  // ── Camera (ATEM camera control) ──
  'camera.autoFocus',
  'camera.autoIris',
  'camera.autoWhiteBalance',
  'camera.resetColorCorrection',
  'camera.setColorGain',
  'camera.setContrast',
  'camera.setFocus',
  'camera.setGain',
  'camera.setGamma',
  'camera.setISO',
  'camera.setIris',
  'camera.setLift',
  'camera.setSaturation',
  'camera.setShutter',
  'camera.setWhiteBalance',
  // ── Companion ──
  'companion.connections',
  'companion.getGrid',
  'companion.press',
  'companion.pressNamed',
  'companion.getVariable',
  'companion.getCustomVariable',
  'companion.setCustomVariable',
  'companion.getWatchedVariables',
  // ── Dante ──
  'dante.scene',
  // ── Ecamm Live ──
  'ecamm.getInputs',
  'ecamm.getOverlays',
  'ecamm.getScenes',
  'ecamm.nextScene',
  'ecamm.prevScene',
  'ecamm.setInput',
  'ecamm.setScene',
  'ecamm.toggleMute',
  'ecamm.togglePIP',
  'ecamm.togglePause',
  // ── Encoder (generic) ──
  'encoder.startRecording',
  'encoder.startStream',
  'encoder.status',
  'encoder.stopRecording',
  'encoder.stopStream',
  // ── Epiphan Pearl ──
  'epiphan.getLayouts',
  'epiphan.getStreamingParams',
  'epiphan.setActiveLayout',
  'epiphan.setStreamingParams',
  'epiphan.startPublisher',
  'epiphan.stopPublisher',
  // ── HyperDeck ──
  'hyperdeck.goToClip',
  'hyperdeck.goToTimecode',
  'hyperdeck.jog',
  'hyperdeck.nextClip',
  'hyperdeck.play',
  'hyperdeck.prevClip',
  'hyperdeck.record',
  'hyperdeck.selectSlot',
  'hyperdeck.setPlaySpeed',
  'hyperdeck.status',
  'hyperdeck.stop',
  'hyperdeck.stopRecord',
  // ── Mixer (audio console) ──
  'mixer.activateMuteGroup',
  'mixer.assignToBus',
  'mixer.assignToDca',
  'mixer.capabilities',
  'mixer.channelStatus',
  'mixer.clearSolos',
  'mixer.deactivateMuteGroup',
  'mixer.getMeters',
  'mixer.isOnline',
  'mixer.mute',
  'mixer.muteDca',
  'mixer.pressSoftKey',
  'mixer.recallScene',
  'mixer.saveScene',
  'mixer.setChannelColor',
  'mixer.setChannelIcon',
  'mixer.setChannelName',
  'mixer.setCompressor',
  'mixer.setDcaFader',
  'mixer.setEq',
  'mixer.setFader',
  'mixer.setFullChannelStrip',
  'mixer.setGate',
  'mixer.setHpf',
  'mixer.setPan',
  'mixer.setPhantom',
  'mixer.setPreampGain',
  'mixer.setSendLevel',
  'mixer.setupFromPatchList',
  'mixer.status',
  'mixer.unmute',
  'mixer.unmuteDca',
  'mixer.verifySceneSave',
  // ── NDI ──
  'ndi.getSource',
  'ndi.setSource',
  // ── OBS ──
  'obs.configureMonitorStream',
  'obs.getInputList',
  'obs.getSceneItems',
  'obs.getScenes',
  'obs.getSourceFilters',
  'obs.pauseRecording',
  'obs.reduceBitrate',
  'obs.resumeRecording',
  'obs.setInputMute',
  'obs.setInputVolume',
  'obs.setPreviewScene',
  'obs.setScene',
  'obs.setSceneItemEnabled',
  'obs.setSourceFilterEnabled',
  'obs.setStudioMode',
  'obs.setTransition',
  'obs.setTransitionDuration',
  'obs.startRecording',
  'obs.startStream',
  'obs.stopRecording',
  'obs.stopStream',
  'obs.toggleVirtualCam',
  // ── Presets / Preview / Status ──
  'preset.delete',
  'preset.list',
  'preset.recall',
  'preset.save',
  // 'preview.snap', — removed from AI; TD says "preview X" meaning ATEM preview, not screenshot
  'preview.start',
  'preview.stop',
  // ── ProPresenter ──
  'propresenter.clearAll',
  'propresenter.clearMessage',
  'propresenter.clearSlide',
  'propresenter.getLooks',
  'propresenter.getTimers',
  'propresenter.goToSlide',
  'propresenter.isRunning',
  'propresenter.lastSlide',
  'propresenter.messages',
  'propresenter.next',
  'propresenter.playlist',
  'propresenter.previous',
  'propresenter.setLook',
  'propresenter.stageMessage',
  'propresenter.startTimer',
  'propresenter.status',
  'propresenter.stopTimer',
  'propresenter.version',
  // ── PTZ Cameras ──
  'ptz.autoFocus',
  'ptz.autoWhiteBalance',
  'ptz.backlightComp',
  'ptz.focusFar',
  'ptz.focusNear',
  'ptz.focusStop',
  'ptz.home',
  'ptz.indoorWhiteBalance',
  'ptz.manualFocus',
  'ptz.onePushWb',
  'ptz.outdoorWhiteBalance',
  'ptz.pan',
  'ptz.preset',
  'ptz.setPreset',
  'ptz.stop',
  'ptz.tilt',
  'ptz.zoom',
  // ── Resolume ──
  'resolume.clearAll',
  'resolume.getBpm',
  'resolume.getColumns',
  'resolume.getLayers',
  'resolume.isRunning',
  'resolume.playClip',
  'resolume.playClipByName',
  'resolume.setBpm',
  'resolume.setLayerOpacity',
  'resolume.setMasterOpacity',
  'resolume.status',
  'resolume.stopClip',
  'resolume.triggerColumn',
  'resolume.triggerColumnByName',
  'resolume.version',
  // ── System ──
  'status',
  'system.getServiceWindow',
  'system.preServiceCheck',
  'system.setWatchdogMode',
  // ── VideoHub ──
  'videohub.getInputLabels',
  'videohub.getOutputLabels',
  'videohub.getRoutes',
  'videohub.route',
  'videohub.setInputLabel',
  'videohub.setOutputLabel',
  // ── vMix ──
  'vmix.audioLevels',
  'vmix.cut',
  'vmix.fade',
  'vmix.fadeToBlack',
  'vmix.function',
  'vmix.isRunning',
  'vmix.listInputs',
  'vmix.mute',
  'vmix.muteInput',
  'vmix.overlayInput',
  'vmix.overlayOff',
  'vmix.preview',
  'vmix.replay',
  'vmix.setInputVolume',
  'vmix.setPreview',
  'vmix.setProgram',
  'vmix.setText',
  'vmix.setVolume',
  'vmix.startPlaylist',
  'vmix.startRecording',
  'vmix.startStream',
  'vmix.status',
  'vmix.stopPlaylist',
  'vmix.stopRecording',
  'vmix.stopStream',
  'vmix.unmute',
  'vmix.unmuteInput',
];

function getAvailableCommandNames() {
  try {
    // Keep parser command surface aligned with the church client runtime.
    // This path exists in monorepo and local/dev contexts.
    // In partial deployments, we fall back to a static snapshot.
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const { commandHandlers } = require('../../church-client/src/commands/index');
    const runtimeCommands = Object.keys(commandHandlers || {}).sort();
    if (runtimeCommands.length > 0) return runtimeCommands;
  } catch {
    // Fall back to static command list.
  }
  return FALLBACK_COMMANDS;
}

const AVAILABLE_COMMANDS = getAvailableCommandNames();
const AVAILABLE_COMMANDS_TEXT = AVAILABLE_COMMANDS.map((cmd) => `- ${cmd}`).join('\n');
// Note: AVAILABLE_COMMANDS is exported via getAvailableCommandNames() for use elsewhere

const SYSTEM_PROMPT = `You are the AI command interface for Tally, a church AV monitoring and control system.
A Technical Director is chatting with you from the Tally app. You have DIRECT control over their equipment.
When they ask you to do something or ask about device state, you EXECUTE the action or QUERY the status yourself — you ARE the command interface.
NEVER tell the user to "type a command" or "try typing X" — if they asked you to do it, DO IT by returning the appropriate command JSON.
When asked about live device state (e.g. "what's on aux 1", "what camera is on program", "is the stream running"), return a command to query that state (e.g. status, atem.listVisibleInputs, encoder.status).

AVAILABLE COMMANDS (JSON schema):
{"command":"atem.cut","params":{"input":N}}                        — switch program to camera N
{"command":"atem.setPreview","params":{"input":N}}                 — put camera N on preview
{"command":"atem.auto","params":{}}                                — execute auto transition / take
{"command":"atem.fadeToBlack","params":{}}                         — toggle fade to black
{"command":"atem.startRecording","params":{}}
{"command":"atem.stopRecording","params":{}}
{"command":"atem.setInputLabel","params":{"input":N,"longName":"X"}}
{"command":"atem.runMacro","params":{"macroIndex":N}}
{"command":"atem.stopMacro","params":{}}
{"command":"atem.setAux","params":{"aux":N,"input":N}}
{"command":"atem.setTransitionStyle","params":{"style":"mix|dip|wipe|dve|stinger"}}
{"command":"atem.setTransitionRate","params":{"rate":N}}
{"command":"atem.setDskOnAir","params":{"keyer":N,"onAir":true}}
{"command":"atem.setDskTie","params":{"keyer":N,"tie":true}}
{"command":"atem.setDskRate","params":{"keyer":N,"rate":N}}
{"command":"atem.setDskSource","params":{"keyer":N,"fillSource":N,"keySource":N}}
{"command":"switcher.cut","params":{"switcherId":"X","input":N}}      — cut on a specific switcher (by id or role)
{"command":"switcher.list","params":{}}                               — list all configured switchers
{"command":"switcher.status","params":{"switcherId":"X"}}             — get status of a specific switcher
{"command":"hyperdeck.play","params":{"hyperdeck":N}}
{"command":"hyperdeck.stop","params":{"hyperdeck":N}}
{"command":"hyperdeck.record","params":{"hyperdeck":N}}
{"command":"hyperdeck.nextClip","params":{"hyperdeck":N}}
{"command":"hyperdeck.prevClip","params":{"hyperdeck":N}}
{"command":"ptz.pan","params":{"camera":N,"speed":-1.0-1.0}}
{"command":"ptz.tilt","params":{"camera":N,"speed":-1.0-1.0}}
{"command":"ptz.zoom","params":{"camera":N,"speed":-1.0-1.0}}
{"command":"ptz.preset","params":{"camera":N,"preset":N}}
{"command":"ptz.setPreset","params":{"camera":N,"preset":N}}
{"command":"ptz.stop","params":{"camera":N}}
{"command":"ptz.home","params":{"camera":N}}
{"command":"obs.startStream","params":{}}
{"command":"obs.stopStream","params":{}}
{"command":"obs.startRecording","params":{}}
{"command":"obs.stopRecording","params":{}}
{"command":"obs.setScene","params":{"scene":"X"}}                           — switch to scene "X"
{"command":"encoder.startStream","params":{}}
{"command":"encoder.stopStream","params":{}}
{"command":"encoder.startRecording","params":{}}
{"command":"encoder.stopRecording","params":{}}
{"command":"encoder.status","params":{}}
{"command":"companion.pressNamed","params":{"name":"X"}}           — press a named Companion button
{"command":"companion.getVariable","params":{"connection":"atem","variable":"pgm1_input"}} — read a Companion module variable
{"command":"companion.getCustomVariable","params":{"name":"X"}}    — read a Companion custom variable
{"command":"companion.setCustomVariable","params":{"name":"X","value":"Y"}} — set a Companion custom variable
{"command":"companion.getWatchedVariables","params":{}}            — list all watched Companion variables and current values
{"command":"vmix.startStream","params":{}}
{"command":"vmix.stopStream","params":{}}
{"command":"vmix.startRecording","params":{}}
{"command":"vmix.stopRecording","params":{}}
{"command":"vmix.cut","params":{}}
{"command":"vmix.fade","params":{"ms":300}}
{"command":"vmix.setPreview","params":{"input":1}}
{"command":"vmix.setProgram","params":{"input":1}}
{"command":"vmix.setVolume","params":{"value":80}}
{"command":"vmix.mute","params":{}}
{"command":"vmix.unmute","params":{}}
{"command":"vmix.preview","params":{}}
{"command":"vmix.isRunning","params":{}}
{"command":"vmix.function","params":{"function":"X","input":"Y"}}
{"command":"videohub.route","params":{"input":N,"output":N}}
{"command":"videohub.getRoutes","params":{}}
{"command":"propresenter.next","params":{}}
{"command":"propresenter.previous","params":{}}
{"command":"propresenter.goToSlide","params":{"index":N}}
{"command":"propresenter.lastSlide","params":{}}
{"command":"propresenter.status","params":{}}
{"command":"propresenter.playlist","params":{}}
{"command":"resolume.playClip","params":{"name":"X"}}
{"command":"resolume.triggerColumn","params":{"column":N}}
{"command":"resolume.clearAll","params":{}}
{"command":"resolume.setBpm","params":{"bpm":N}}
{"command":"mixer.status","params":{}}
{"command":"mixer.mute","params":{"channel":"master|N"}}
{"command":"mixer.unmute","params":{"channel":"master|N"}}
{"command":"mixer.recallScene","params":{"scene":N}}
{"command":"mixer.setFader","params":{"channel":N,"level":0.0-1.0}}
{"command":"dante.scene","params":{"name":"X"}}
{"command":"system.preServiceCheck","params":{}}
{"command":"status","params":{}}                                   — overall system status

ADDITIONAL VALID COMMAND IDS (same params as church runtime):
${AVAILABLE_COMMANDS_TEXT}

RESPONSE FORMAT — always return valid JSON, one of these three shapes:

1. Single command:
{"type":"command","command":"atem.cut","params":{"input":2}}

2. Multiple sequential commands:
{"type":"commands","steps":[
  {"command":"atem.cut","params":{"input":2}},
  {"command":"obs.startStream","params":{}}
]}

3. Conversational reply (questions, unknown intent, out-of-scope):
{"type":"chat","text":"Short helpful reply here."}

RULES:
- You ARE the command interface. There is only ONE chat input — the user is already talking to you through it. NEVER say "type this command", "try entering", "use the command", or redirect to another input. If they asked for it, return the command JSON and it will be executed.
- When asked about device state ("what's on program", "what camera is live", "is aux 1 set", "what's the stream status"), return a status-querying command like {"type":"command","command":"status","params":{}} or a specific device query. The result will be shown to the user.
- Be liberal with inference. "wide angle" likely means camera 1. "pastor" likely means camera 2. "center" or "main" likely means camera 1 or the current program input.
- If the message references lowering/muting audio: map to companion.pressNamed with a descriptive name like "Mute Audience Mics" or "Lower Music".
- If the message is production-related but you cannot map it to a command with confidence, return type:chat with a brief clarifying question. Do NOT suggest the user type a command — ask what they want and you will execute it.
- If the message is NOT related to church AV production (weather, sports, general chat, jokes, etc.), return type:chat with exactly: "I'm only here for production. Try 'help' for what I can do."
- Never return anything outside of the three JSON shapes above.
- No markdown, no explanation, just the JSON.`;

// ─── Device command signature blocks (included only when device is connected) ──
const CMD_SIGS = {
  atem: `atem: cut(input:N), setPreview(input:N), auto(), fadeToBlack(), setFadeToBlackRate(rate:N), startRecording(), stopRecording(), startStreaming(), stopStreaming(), requestStreamingDuration(), requestRecordingDuration(), setInputLabel(input:N,longName:X), listVisibleInputs(), runMacro(macroIndex:N), stopMacro(), macroContinue(), macroSetLoop(macroIndex:N,isLooping:bool), macroStartRecord(macroIndex:N), macroStopRecord(macroIndex:N), macroUpdateProperties(macroIndex:N,name:X,description:X), macroDelete(macroIndex:N), setAux(aux:N,input:N), setTransitionStyle(style:mix|dip|wipe|dve|stinger), setTransitionRate(rate:N), setDskOnAir(keyer:N,onAir:bool), setDskTie(keyer:N,tie:bool), setDskRate(keyer:N,rate:N), setDskSource(keyer:N,fillSource:N,keySource:N), autoDsk(keyer:N), setDskGeneralProperties(keyer:N,preMultiplied:bool,clip:N,gain:N,invertKey:bool), setDskMaskSettings(keyer:N,maskEnabled:bool,maskTop:N,maskBottom:N,maskLeft:N,maskRight:N), setProgram(input:N), uploadStill(index:N,data:X,name:X), setMediaPlayer(player:N,sourceType:X,stillIndex:N), captureStill(), clearStill(index:N), setColorGeneratorColour(index:N,hue:N,saturation:N,luminance:N), saveStartupState(), clearStartupState()`,
  atemFairlight: `atem (Fairlight audio — use when audio_via_atem is true or user says "on the atem"):
  setFairlightAudioSourceProps(index:N,source:N,faderGain:N,gain:N,balance:N,mixOption:N) — faderGain -10000 to 1000, mixOption: 0=off 1=on 2=AFV
  setFairlightAudioSourceCompressorProps(index:N,source:N,compressorEnabled:bool,threshold:N,ratio:N,attack:N,hold:N,release:N)
  setFairlightAudioSourceLimiterProps(index:N,source:N,limiterEnabled:bool,threshold:N,attack:N,hold:N,release:N)
  setFairlightAudioSourceExpanderProps(index:N,source:N,expanderEnabled:bool,gateEnabled:bool,threshold:N,range:N,ratio:N,attack:N,hold:N,release:N)
  setFairlightAudioSourceEqBandProps(index:N,source:N,band:0-5,eqEnabled:bool,shape:N,frequencyRange:N,frequency:N,gain:N,qFactor:N)
  setFairlightAudioMasterProps(faderGain:N,followFadeToBlack:bool)
  setFairlightAudioMasterCompressorProps(compressorEnabled:bool,threshold:N,ratio:N,attack:N,hold:N,release:N)
  setFairlightAudioMasterLimiterProps(limiterEnabled:bool,threshold:N,attack:N,hold:N,release:N)
  setFairlightAudioMasterEqBandProps(band:0-5,eqEnabled:bool,shape:N,frequencyRange:N,frequency:N,gain:N,qFactor:N)
  setFairlightAudioMasterEqReset(band:N), setFairlightAudioMasterDynamicsReset()
  setFairlightAudioMonitorProps(gain:N,inputMasterMuted:bool,inputMasterGain:N)
  setFairlightAudioMonitorSolo(index:N,source:N,solo:bool), setFairlightAudioInputProps(index:N,activeConfiguration:X), setFairlightAudioResetPeaks(all:bool)`,
  atemClassicAudio: `atem (Classic audio — ATEM Mini / Mini Pro / older non-Fairlight):
  setClassicAudioInputProps(index:N,mixOption:N,gain:N,balance:N), setClassicAudioMasterProps(gain:N,balance:N,followFadeToBlack:bool), setClassicAudioMonitorProps(enabled:bool,gain:N,mute:bool,solo:bool,soloInput:N,dim:bool) — use mute:true/false to mute/unmute headphone or monitor output, setClassicAudioHeadphonesProps(gain:N,programOutGain:N,sidetoneGain:N,talkbackGain:N) — gain adjustment only (no mute here), setClassicAudioResetPeaks() — resets peak meters only (never use for unmute)`,
  atemKeyers: `atem (Upstream Keyers — PIP, chroma, luma, DVE):
  setUskOnAir(keyer:N,onAir:bool), setUskFillSource(keyer:N,fillSource:N), setUskCutSource(keyer:N,cutSource:N), setUskType(keyer:N,mixEffectKeyType:N,flyEnabled:bool) — 0=luma 1=chroma 2=pattern 3=DVE
  setUskLumaSettings(keyer:N,preMultiplied:bool,clip:N,gain:N,invertKey:bool), setUskChromaSettings(keyer:N,hue:N,gain:N,ySuppress:N,lift:N,narrow:bool)
  setUskDVESettings(keyer:N,sizeX:N,sizeY:N,positionX:N,positionY:N,rotation:N,borderEnabled:bool,borderOuterWidth:N,borderHue:N,borderSaturation:N,borderLuma:N,maskEnabled:bool,maskTop:N,maskBottom:N,maskLeft:N,maskRight:N)
  setUskPatternSettings(keyer:N,style:N,size:N,symmetry:N,softness:N,positionX:N,positionY:N,invertPattern:bool), setUskMaskSettings(keyer:N,maskEnabled:bool,maskTop:N,maskBottom:N,maskLeft:N,maskRight:N)
  runUskFlyKeyTo(keyer:N,keyFrame:N), runUskFlyKeyToInfinite(keyer:N,direction:N)
  PIP: "put camera X in a PIP" → setUskType(keyer:0,mixEffectKeyType:3,flyEnabled:true), setUskFillSource(keyer:0,fillSource:X), setUskDVESettings(keyer:0,sizeX:0.33,sizeY:0.33,positionX:7,positionY:4), setUskOnAir(keyer:0,onAir:true)`,
  atemSuperSource: `atem (SuperSource — split-screen, 1 M/E+ and Constellation only):
  setSuperSourceBoxSettings(box:0-3,source:N,enabled:bool,positionX:N,positionY:N,size:N,cropped:bool,cropTop:N,cropBottom:N,cropLeft:N,cropRight:N), setSuperSourceProperties(artFillSource:N,artCutSource:N,artOption:N,artPreMultiplied:bool,artClip:N,artGain:N,artInvertKey:bool), setSuperSourceBorder(borderEnabled:bool,borderOuterWidth:N,borderInnerWidth:N,borderHue:N,borderSaturation:N,borderLuma:N)`,
  atemMultiviewer: `atem (Multiviewer):
  setMultiViewerWindowSource(mv:N,window:N,source:N), setMultiViewerWindowVuEnabled(mv:N,window:N,enabled:bool), setMultiViewerWindowSafeAreaEnabled(mv:N,window:N,enabled:bool), setMultiViewerVuOpacity(mv:N,opacity:N), setMultiViewerProperties(mv:N,layout:N,programPreviewSwapped:bool)`,
  atemTransitions: `atem (Transitions):
  setDipTransitionSettings(rate:N,input:N), setWipeTransitionSettings(rate:N,pattern:N,borderWidth:N,borderSoftness:N,symmetry:N,xPosition:N,yPosition:N,reverseDirection:bool,flipFlop:bool), setDVETransitionSettings(rate:N,style:N,fillSource:N,keySource:N), setStingerTransitionSettings(source:N,preMultiplied:bool,clip:N,gain:N,invertKey:bool,preRoll:N,clipDuration:N,triggerPoint:N,mixRate:N)`,
  hyperdeck: `hyperdeck: play(hyperdeck:N), stop(hyperdeck:N), record(hyperdeck:N), stopRecord(hyperdeck:N), nextClip(hyperdeck:N), prevClip(hyperdeck:N), status(hyperdeck:N), selectSlot(hyperdeck:N,slot:N), setPlaySpeed(hyperdeck:N,speed:N), goToClip(hyperdeck:N,clip:N), goToTimecode(hyperdeck:N,timecode:X), jog(hyperdeck:N,timecode:X)`,
  ptz: `ptz: pan(camera:N,speed:-1to1), tilt(camera:N,speed:-1to1), zoom(camera:N,speed:-1to1), preset(camera:N,preset:N), setPreset(camera:N,preset:N), stop(camera:N), home(camera:N), autoFocus(camera:N), manualFocus(camera:N), focusNear(camera:N,speed:0-7), focusFar(camera:N,speed:0-7), focusStop(camera:N), autoWhiteBalance(camera:N), indoorWhiteBalance(camera:N), outdoorWhiteBalance(camera:N), onePushWb(camera:N), backlightComp(camera:N,enabled:bool)`,
  camera: `camera: setIris(camera:N,value:0-1), autoIris(camera:N), setGain(camera:N,gain:N), setISO(camera:N,iso:N), setWhiteBalance(camera:N,kelvin:N,tint:N), autoWhiteBalance(camera:N), setShutter(camera:N,speed:N), setFocus(camera:N,value:0-1), autoFocus(camera:N), setLift(camera:N,r:N,g:N,b:N,y:N), setGamma(camera:N,r:N,g:N,b:N,y:N), setColorGain(camera:N,r:N,g:N,b:N,y:N), setContrast(camera:N,pivot:N,adjust:N), setSaturation(camera:N,saturation:N), resetColorCorrection(camera:N)`,
  obs: `obs: startStream(), stopStream(), startRecording(), stopRecording(), pauseRecording(), resumeRecording(), setScene(scene:X), getScenes(), getInputList(), setInputVolume(input:X,volume:0-1), setInputMute(input:X,muted:bool), setTransition(transition:X), setTransitionDuration(duration:N), getSourceFilters(source:X), setSourceFilterEnabled(source:X,filter:X,enabled:bool), setStudioMode(enabled:bool), setPreviewScene(scene:X), toggleVirtualCam(), getSceneItems(scene:X), setSceneItemEnabled(scene:X,itemId:N,enabled:bool), reduceBitrate(), configureMonitorStream()`,
  encoder: `encoder: startStream(), stopStream(), startRecording(), stopRecording(), status()`,
  webPresenter: `blackmagic (Web Presenter): getActivePlatform(), setActivePlatform(config:{platform:X,server:X,key:X,quality:X}), getPlatforms(), getPlatformConfig(name:X), getVideoFormat(), setVideoFormat(format:X), getSupportedVideoFormats(), getAudioSources(), setAudioSource(source:X)`,
  companion: `companion: pressNamed(name:X), press(page:N,row:N,col:N), getGrid(), connections(), getVariable(connection:X,variable:X), getCustomVariable(name:X), setCustomVariable(name:X,value:X), getWatchedVariables(). Use getVariable to read device state through Companion (e.g. getVariable("atem","pgm1_input") for current program source, getVariable("obs","current_scene") for OBS scene).`,
  vmix: `vmix: startStream(), stopStream(), startRecording(), stopRecording(), cut(), fade(ms:N), setPreview(input:N), setProgram(input:N), setVolume(value:N), mute(), unmute(), function(function:X,input:X), status(), listInputs(), isRunning(), startPlaylist(), stopPlaylist(), audioLevels(), fadeToBlack(), setInputVolume(input:X,volume:0-100), muteInput(input:X), unmuteInput(input:X), overlayInput(overlay:1-4,input:X), overlayOff(overlay:1-4), setText(input:X,text:X), replay(action:X)`,
  videohub: `videohub: route(input:N,output:N), getRoutes(), setInputLabel(index:N,label:X), setOutputLabel(index:N,label:X), getInputLabels(), getOutputLabels()`,
  propresenter: `propresenter: next(), previous(), goToSlide(index:N), lastSlide(), status(), playlist(), clearAll(), clearSlide(), stageMessage(name:X), clearMessage(), getLooks(), setLook(name:X), getTimers(), startTimer(name:X), stopTimer(name:X), version(), messages()`,
  resolume: `resolume: playClip(name:X OR layer:N,clip:N), stopClip(layer:N,clip:N), triggerColumn(column:N OR name:X), clearAll(), setBpm(bpm:N), getBpm(), setLayerOpacity(layer:N,value:0-1), setMasterOpacity(value:0-1), getLayers(), getColumns(), isRunning(), version(), status(), playClipByName(name:X), triggerColumnByName(name:X)`,
  mixer: `mixer: status(), mute(channel:master|N), unmute(channel:master|N), recallScene(scene:N), saveScene(scene:N,name:X), setFader(channel:N,level:0-1), setChannelName(channel:N,name:X), setHpf(channel:N,enabled:bool,frequency:N), setEq(channel:N,enabled:bool,bands:[...]), setCompressor(channel:N,enabled:bool,threshold:N,ratio:N,attack:N,release:N,knee:N), setGate(channel:N,enabled:bool,threshold:N,range:N,attack:N,hold:N,release:N), setPreampGain(channel:N,gain:N), setPhantom(channel:N,enabled:bool), setPan(channel:N,pan:-1to1), setSendLevel(channel:N,bus:N,level:0-1), assignToBus(channel:N,bus:N,enabled:bool), assignToDca(channel:N,dca:N,enabled:bool), muteDca(dca:N), unmuteDca(dca:N), setDcaFader(dca:N,level:0-1), activateMuteGroup(group:N), deactivateMuteGroup(group:N), pressSoftKey(key:N), clearSolos(), channelStatus(channel:N), getMeters(), capabilities(), setChannelColor(channel:N,color:X), setChannelIcon(channel:N,icon:X)`,
  switcher: `switcher (multi-switcher — use when multiple ATEMs/OBS/vMix are configured, or to target a specific switcher by id or role): cut(switcherId:X,input:N), setProgram(switcherId:X,input:N), setPreview(switcherId:X,input:N), auto(switcherId:X), list(), status(switcherId:X). switcherId can be an ID or role name (primary, backup, imag, broadcast, recording).`,
  dante: `dante: scene(name:X)`,
  ecamm: `ecamm: togglePause(), getScenes(), setScene(id:X), nextScene(), prevScene(), toggleMute(), getInputs(), setInput(id:X), togglePIP(), getOverlays()`,
  aja: `aja (AJA HELO): setVideoInput(source:N), setAudioInput(source:N), setStreamProfile(profile:X), setRecordProfile(profile:X), setMute(muted:bool), recallPreset(preset:X)`,
  epiphan: `epiphan (Epiphan Pearl): startPublisher(channel:X,publisher:X), stopPublisher(channel:X,publisher:X), getLayouts(channel:X), setActiveLayout(channel:X,layout:X), getStreamingParams(channel:X), setStreamingParams(channel:X,params:X)`,
  ndi: `ndi: getSource(), setSource(source:X)`,
};

// Always-included blocks
const CMD_SIGS_ALWAYS = `preset: save(name:X), list(), recall(name:X), delete(name:X)
preview: snap()
other: system.preServiceCheck(), status()
system: wait(seconds:N) — pause between steps (max 30s)`;

/**
 * Build a SYSTEM_PROMPT that only includes command signatures for connected devices.
 * Cuts token usage dramatically for churches with fewer devices.
 */
function buildSystemPrompt(status = {}) {
  const s = status || {};
  const sigs = [];

  // Multi-switcher support: include switcher commands when multiple switchers present
  const hasSwitchers = s.switchers && Object.keys(s.switchers).length > 1;
  if (hasSwitchers) {
    sigs.push(CMD_SIGS.switcher);
  }

  // ATEM is almost always present
  const atemConnected = s.atem?.connected || (s.switchers && Object.values(s.switchers).some(sw => sw.type === 'atem' && sw.connected));
  if (atemConnected) {
    sigs.push(CMD_SIGS.atem);
    sigs.push(CMD_SIGS.atemFairlight);
    sigs.push(CMD_SIGS.atemClassicAudio);
    sigs.push(CMD_SIGS.atemKeyers);
    sigs.push(CMD_SIGS.atemSuperSource);
    sigs.push(CMD_SIGS.atemMultiviewer);
    sigs.push(CMD_SIGS.atemTransitions);
  }
  if (s.hyperdeck?.connected)     sigs.push(CMD_SIGS.hyperdeck);
  const ptzConnected = (s.ptz || []).some(c => c?.connected);
  if (ptzConnected)               sigs.push(CMD_SIGS.ptz);
  if (atemConnected)              sigs.push(CMD_SIGS.camera); // BMD camera control requires ATEM
  const obsConnected = s.obs?.connected || (s.switchers && Object.values(s.switchers).some(sw => sw.type === 'obs' && sw.connected));
  if (obsConnected)               sigs.push(CMD_SIGS.obs);
  if (s.encoder?.connected)       sigs.push(CMD_SIGS.encoder);
  // Web Presenter commands are available when encoder type is 'blackmagic'
  const isWebPresenter = s.encoder?.connected && (s.encoder.type || '').toLowerCase() === 'blackmagic';
  if (isWebPresenter || s.webPresenter?.connected)  sigs.push(CMD_SIGS.webPresenter);
  if (s.companion?.connected)     sigs.push(CMD_SIGS.companion);
  const vmixConnected = s.vmix?.connected || (s.switchers && Object.values(s.switchers).some(sw => sw.type === 'vmix' && sw.connected));
  if (vmixConnected)              sigs.push(CMD_SIGS.vmix);
  if (s.videohub?.connected)      sigs.push(CMD_SIGS.videohub);
  if (s.proPresenter?.connected)  sigs.push(CMD_SIGS.propresenter);
  if (s.resolume?.connected)      sigs.push(CMD_SIGS.resolume);
  if (s.mixer?.connected)         sigs.push(CMD_SIGS.mixer);
  if (s.dante?.connected)         sigs.push(CMD_SIGS.dante);
  if (s.ecamm?.connected)         sigs.push(CMD_SIGS.ecamm);
  if (s.aja?.connected)           sigs.push(CMD_SIGS.aja);
  if (s.epiphan?.connected)       sigs.push(CMD_SIGS.epiphan);
  if (s.ndi?.connected)           sigs.push(CMD_SIGS.ndi);
  sigs.push(CMD_SIGS_ALWAYS);

  // If NO devices connected (admin context, etc.), include all signatures
  if (sigs.length <= 1) {
    for (const v of Object.values(CMD_SIGS)) sigs.unshift(v);
  }

  // Count connected streaming devices for conditional prompt sections
  const streamDevices = [s.encoder?.connected, obsConnected, vmixConnected, atemConnected].filter(Boolean);
  const hasMultipleStreamDevices = streamDevices.length > 1;
  const hasMixer = !!s.mixer?.connected;
  const hasAtemAudio = atemConnected && !hasMixer;

  // Build streaming selection rules (only if multiple streaming devices exist)
  let streamingRules = '';
  if (hasMultipleStreamDevices) {
    streamingRules = `
STREAMING DEVICE SELECTION:
When asked to "start stream" or "go live", pick the right device:
- If user wants ALL ("start all encoders", "go live on everything") → multi-step for every connected streaming device
- If user names a device → use that device
- If memory/notes say which device → use it
- If only one streaming device → use it
- Priority: Encoder > OBS > vMix > ATEM built-in streaming (last resort)
- If multiple and no preference → ask user which one

RECORDING DEVICE SELECTION:
- "start all recording" → multi-step for all connected recording devices
- If user names a device → use it
- Default to atem.startRecording if ATEM connected`;
  } else {
    streamingRules = `
STREAMING: Use the connected streaming device. For "start all" / "stop all", include all connected devices.`;
  }

  // ATEM-specific switching and keyer detail rules (only when ATEM is connected)
  const atemDetailRules = s.atem?.connected ? `
ATEM SPECIAL INPUTS: Media Player 1=3010, Media Player 2=3020, Color Bars=1000, Color 1=2001, Color 2=2002, SuperSource=6000, Clean Feed 1=7001, Clean Feed 2=7002, Program=10010, Preview=10011.
"Cut to MP1" or "go to media player" → atem.cut(input:3010). Do NOT ask to upload an image — just switch to the input directly. The media player already has content loaded.
"Go to color bars" / "show bars" / "test pattern" → atem.cut(input:1000).

TRANSITIONS:
- "Cut to cam X" / "take cam X" / "go to cam X" → atem.cut(input:X). This is an instant switch.
- "Dissolve to cam X" / "mix to cam X" / "crossfade to cam X" → multi-step: [atem.setTransitionStyle(style:mix), atem.setPreview(input:X), atem.auto()]. Dissolve and mix are the same thing.
- "Dip to cam X" → multi-step: [atem.setTransitionStyle(style:dip), atem.setPreview(input:X), atem.auto()]
- "Wipe to cam X" → multi-step: [atem.setTransitionStyle(style:wipe), atem.setPreview(input:X), atem.auto()]
- "Faster/slower dissolve" → atem.setTransitionRate(rate:N). Default is 30 frames. Faster=15, slower=60.
- "Preview cam X" / "put cam X on preview" / "take X to preview" / "set preview to X" / "can I see cam X in preview" → atem.setPreview(input:X). This does NOT cut or transition — it only sets the ATEM preview bus. NEVER use preview.snap for any of these — preview.snap is ONLY for screenshots.
- "Take it" / "go" / "punch it" → atem.auto(). Transitions whatever is on preview to program.

FADE TO BLACK:
- "Fade to black" / "FTB" → atem.fadeToBlack(). This is a toggle — calling it again brings back from black.
- "Cut to black" → atem.setProgram(input:2001) or atem.cut(input:2001). Uses Color 1 (black) as instant cut.
- "Bring it back" / "come back from black" → atem.fadeToBlack(). Same toggle.

PIP (Picture-in-Picture):
- "Put cam X in a PIP" → multi-step: [atem.setUskType(keyer:0,mixEffectKeyType:3,flyEnabled:true), atem.setUskFillSource(keyer:0,fillSource:X), atem.setUskDVESettings(keyer:0,sizeX:0.33,sizeY:0.33,positionX:7,positionY:4), atem.setUskOnAir(keyer:0,onAir:true)]
- "Remove PIP" / "kill PIP" / "PIP off" → atem.setUskOnAir(keyer:0,onAir:false)
- "Make PIP bigger/smaller" → atem.setUskDVESettings(keyer:0,sizeX:N,sizeY:N). Bigger=0.5, smaller=0.25.
- "Move PIP to top left" → positionX:-7,positionY:-4. Top right: positionX:7,positionY:-4. Bottom left: positionX:-7,positionY:4. Bottom right: positionX:7,positionY:4.

LOWER THIRDS / KEYERS:
- "Show lower third" / "put up the lower third" / "L3 on" → atem.setDskOnAir(keyer:0,onAir:true). DSK 1 (keyer:0) is typically the lower third.
- "Hide lower third" / "take down the L3" / "L3 off" → atem.setDskOnAir(keyer:0,onAir:false)
- "Auto lower third" → atem.autoDsk(keyer:0). Transitions DSK on/off with the configured rate.
- "Show the bug" / "logo on" → atem.setDskOnAir(keyer:1,onAir:true). DSK 2 (keyer:1) is typically the bug/logo.
- "Hide the bug" / "logo off" → atem.setDskOnAir(keyer:1,onAir:false)

ATEM MODEL AWARENESS:
- Context includes the ATEM model name. Use it:
  - ATEM Mini / Mini Pro / Mini Pro ISO / Mini Extreme / Mini Extreme ISO → Classic Audio (NOT Fairlight). No SuperSource. Max 4-8 inputs.
  - Television Studio / 1 M/E / 2 M/E / 4 M/E / Constellation → Fairlight Audio. SuperSource available on 1 M/E+ and above.
- If user asks for a feature their ATEM doesn't support, explain: "Your [model] doesn't support [feature]. Here's what you can do instead: [alternative]."

COLOR GENERATOR:
- "Color 1" = index:0, "Color 2" = index:1. Default to index:0 unless user says "color 2".
- atem.setColorGeneratorColour(index:N,hue:N,saturation:N,luminance:N). Hue is 0-3599 (tenths of degrees), saturation 0-1000, luminance 0-1000.
- Common colors: black=hue:0,sat:0,lum:0. White=hue:0,sat:0,lum:1000. Red=hue:0,sat:1000,lum:500. Blue=hue:2400,sat:1000,lum:500. Green=hue:1200,sat:1000,lum:500. Yellow=hue:600,sat:1000,lum:500. Cyan=hue:1800,sat:1000,lum:500. Magenta=hue:3000,sat:1000,lum:500. Orange=hue:300,sat:1000,lum:500.
- "Change color 1 to blue" → atem.setColorGeneratorColour(index:0,hue:2400,saturation:1000,luminance:500)

DEVICE PRIORITY — CRITICAL:
- If an ATEM is connected, DEFAULT all switching commands (cut, preview, program, transition, fade to black, PIP, keyers, DSK, aux) to atem.* commands.
- Only use OBS/vMix for switching if the user explicitly mentions OBS or vMix by name (e.g., "switch OBS scene", "change vMix program", "in OBS go to...").
- Generic commands like "put cam 1 in preview", "cut to cam 2", "go to camera 3" → ALWAYS use atem.* when ATEM is connected.
- OBS/vMix without explicit mention are only for: streaming control, recording, and source/filter management.` : '';

  // Web Presenter / Blackmagic encoder detail rules
  const webPresenterRules = (isWebPresenter || s.webPresenter?.connected) ? `
WEB PRESENTER (Blackmagic):
- The encoder.* commands (startStream, stopStream, status) AND the blackmagic.* commands both control the SAME Blackmagic Web Presenter device. Use encoder.* for basic stream control and status. Use blackmagic.* for platform, bitrate, video format, and audio configuration.
- BITRATE: The Web Presenter does NOT have a direct "set bitrate" command. Bitrate is controlled through quality profiles:
  1. First get the current platform: blackmagic.getActivePlatform() — returns the configured platform, server URL, stream key, and quality profile
  2. To see available quality profiles: blackmagic.getPlatformConfig(name:X) — returns servers and quality profiles with preset bitrates
  3. To change bitrate: blackmagic.setActivePlatform(config:{platform:X,server:X,key:X,quality:X}) — set a different quality profile
  4. If user asks to "change bitrate" → first run blackmagic.getActivePlatform() to see current config, then explain the quality profile options
- "Where are we streaming?" / "streaming location" / "stream URL" / "stream destination" / "what platform" → blackmagic.getActivePlatform()
- "What platforms are available?" / "list platforms" → blackmagic.getPlatforms()
- "Show YouTube config" / "YouTube settings" → blackmagic.getPlatformConfig(name:"YouTube")
- "Change resolution" / "set to 720p" → first blackmagic.getSupportedVideoFormats(), then blackmagic.setVideoFormat(format:X)
- "What audio input?" / "audio sources" → blackmagic.getAudioSources()
- RTMP CREDENTIAL PUSH: When a user provides an RTMP URL (like rtmp://host:port/live/) and/or a stream key, ALWAYS use blackmagic.setActivePlatform to push them to the Web Presenter. Examples:
  - "Set the RTMP URL to rtmp://x.com/live with key abc123" → blackmagic.setActivePlatform(config:{platform:"Custom RTMP",server:"rtmp://x.com/live",key:"abc123",quality:"1080p High"})
  - "Push rtmp://gondola.proxy.rlwy.net:50201/live/ to the encoder" → blackmagic.setActivePlatform(config:{server:"rtmp://gondola.proxy.rlwy.net:50201/live/"}) — if key/quality not provided, first run blackmagic.getActivePlatform() to get current values and preserve them
  - "Stream to YouTube with this key: xxxx-xxxx-xxxx-xxxx" → blackmagic.setActivePlatform(config:{platform:"YouTube",key:"xxxx-xxxx-xxxx-xxxx"}) — preserve existing server/quality from getActivePlatform()
  - If only a URL or only a key is provided, fetch current config with getActivePlatform() first, then merge the new value with existing config in setActivePlatform.
- NEVER tell the user to "run a command" or to configure the encoder manually — YOU execute setActivePlatform directly. If you need information before acting, run the query command yourself and use the result.` : '';

  // OBS detail rules
  const obsRules = s.obs?.connected ? `
OBS:
- "Switch to scene X" / "go to scene X" → obs.setScene(scene:X). Use exact scene name from context.
- "What scenes do I have?" → obs.getScenes(). Returns the list of available scene names.
- "Show/hide source X in scene Y" → obs.setSceneItemEnabled(scene:Y,itemId:N,enabled:bool). Must know itemId — run obs.getSceneItems(scene:Y) first.
- "Enable/disable filter X on source Y" → obs.setSourceFilterEnabled(source:Y,filter:X,enabled:bool).
- "Reduce bitrate" / "stream is buffering" → obs.reduceBitrate(). Reduces current bitrate by 20%.
- OBS volume is 0-1 (normalized). "Mute desktop audio" → obs.setInputMute(input:"Desktop Audio",muted:true).
- Transition duration is in MILLISECONDS: obs.setTransitionDuration(duration:1000) = 1 second.
- "Enable studio mode" → obs.setStudioMode(enabled:true). "Preview scene X" requires studio mode on first.` : '';

  // vMix detail rules
  const vmixRules = s.vmix?.connected ? `
VMIX:
- "Cut to input X" → vmix.setProgram(input:X) for instant, or vmix.cut() to transition preview→program.
- "Fade to input X" → multi-step: [vmix.setPreview(input:X), vmix.fade(ms:2000)]. Fade duration is MILLISECONDS (not frames).
- "Show overlay" / "put X in overlay" → vmix.overlayInput(overlay:1,input:X). Overlays 1-4 available. "Remove overlay" → vmix.overlayOff(overlay:1).
- "What inputs do I have?" → vmix.listInputs(). Returns numbered list of all inputs.
- Master volume is 0-100: vmix.setVolume(value:80). Per-input: vmix.setInputVolume(input:X,volume:80).
- "Update lower third text" / "change title" → vmix.setText(input:X,text:"New text").
- vmix.function(function:X) is the escape hatch for any vMix function not explicitly listed.
- "Replay" → vmix.replay(action:"PlayLastEvent"). Other actions: "PlayAllEvents", "StopEvents".` : '';

  // HyperDeck detail rules
  const hyperdeckRules = s.hyperdeck?.connected ? `
HYPERDECK:
- "Record to the deck" / "start recording on hyperdeck" → hyperdeck.record(hyperdeck:1). If multiple HyperDecks, ask which one.
- "Play back" / "play the recording" → hyperdeck.play(hyperdeck:1). "Stop playback" → hyperdeck.stop(hyperdeck:1).
- "Next clip" / "skip forward" → hyperdeck.nextClip(hyperdeck:1). "Previous clip" → hyperdeck.prevClip(hyperdeck:1).
- "Check disk space" / "how much recording time?" → hyperdeck.status(hyperdeck:1). Returns disk space and estimated time remaining.
- "Go to timecode 00:05:00:00" → hyperdeck.goToTimecode(hyperdeck:1,timecode:"00:05:00:00").
- "Switch to slot 2" / "use the other disk" → hyperdeck.selectSlot(hyperdeck:1,slot:2). Requires direct connection (not ATEM bridge).
- Playback speed: hyperdeck.setPlaySpeed(hyperdeck:1,speed:200) = 2x speed. 100 = normal, 50 = half speed.
- HyperDeck index is 1-based (hyperdeck:1 = first deck).` : '';

  // PTZ camera detail rules
  const ptzRules = (s.ptz || []).some(c => c?.connected) ? `
PTZ DETAIL:
- Speed range is -1.0 to 1.0. Gentle moves: 0.3. Fast moves: 0.7. Max: 1.0. Negative = reverse direction.
- "Zoom in" → ptz.zoom(camera:1,speed:0.3). "Zoom out" → ptz.zoom(camera:1,speed:-0.3). "Stop" → ptz.stop(camera:1).
- "Go to preset 3" / "recall position 3" → ptz.preset(camera:1,preset:3). Presets are 1-based.
- "Save this position as preset 5" → ptz.setPreset(camera:1,preset:5). Network PTZ only.
- "Home" / "center the camera" → ptz.home(camera:1). Network PTZ only — will error on ATEM-controlled cameras.
- Focus commands (autoFocus, manualFocus, focusNear, focusFar) require VISCA protocol — will error on ATEM-controlled cameras.
- If only one PTZ camera, default to camera:1. If multiple, ask which camera.
- Pan/tilt/zoom commands run for ~350ms then auto-stop. For longer moves, user says "keep going" → use higher speed.` : '';

  // VideoHub detail rules
  const videohubRules = s.videohub?.connected ? `
VIDEOHUB:
- "Route input 3 to output 5" / "send camera 3 to monitor 5" → videohub.route(input:3,output:5).
- "Show me the routes" / "what's routed where?" → videohub.getRoutes(). Returns all output→input mappings.
- "What are the inputs called?" → videohub.getInputLabels(). "What are the outputs called?" → videohub.getOutputLabels().
- "Rename input 1 to Main Camera" → videohub.setInputLabel(index:1,label:"Main Camera").
- Routes are 1-based (input 1, output 1 = first port). Use labels from context to match user intent.` : '';

  // ProPresenter detail rules
  const propresenterRules = s.proPresenter?.connected ? `
PROPRESENTER:
- "Next slide" / "advance" → propresenter.next(). "Previous slide" / "go back" → propresenter.previous().
- "Go to slide 5" → propresenter.goToSlide(index:5). Use 1-based numbers (the system converts internally).
- "Clear the screen" / "blank it" → propresenter.clearAll(). Clears all layers (slides, media, messages).
- "Clear just the slide" → propresenter.clearSlide(). Keeps media/messages visible.
- "What slide are we on?" → propresenter.status(). Returns current slide, total slides, presentation name.
- "Show the playlist" → propresenter.playlist(). Lists all playlist items.
- "Start the countdown" → propresenter.startTimer(name:X). Must know timer name — run propresenter.getTimers() first if unknown.
- "Put up a message" → propresenter.stageMessage(name:X). "Clear the message" → propresenter.clearMessage().
- "Switch the look" → propresenter.setLook(name:X). Run propresenter.getLooks() first if name unknown.` : '';

  // Resolume detail rules
  const resolumeRules = s.resolume?.connected ? `
RESOLUME:
- "Play clip X" → resolume.playClipByName(name:X). Use clip name. For layer/clip index: resolume.playClip(name:X) also accepts layer:N,clip:N.
- "Trigger column 3" / "scene 3" → resolume.triggerColumn(column:3). Plays all clips in that column across all layers (like a scene).
- "Black out" / "clear everything" → resolume.clearAll(). Disconnects all clips instantly.
- "Fade layer 2 out" → resolume.setLayerOpacity(layer:2,value:0). value is 0-1 (0=invisible, 1=full).
- "Master opacity down" → resolume.setMasterOpacity(value:0.5). Affects everything.
- "Set BPM to 120" → resolume.setBpm(bpm:120). Range: 20-300.
- "What layers do I have?" → resolume.getLayers(). "What columns?" → resolume.getColumns().
- Note: stopClip() requires layer AND clip index — prefer clearAll() for general blackout.` : '';

  // Mixer detail rules
  const mixerRules = hasMixer ? `
MIXER:
- "Mute channel 5" → mixer.mute(channel:5). "Unmute" → mixer.unmute(channel:5). "Mute master" → mixer.mute(channel:"master").
- Fader levels are 0.0 to 1.0. On Behringer X32/M32: 0.75 = unity (0 dB), NOT 1.0. "Set channel 1 to unity" → mixer.setFader(channel:1,level:0.75).
- "Turn up mic 3" / "louder on 3" → increase fader by +0.1. "Turn down" → decrease by -0.1. Don't ask what level — just bump it.
- "Recall scene 5" → mixer.recallScene(scene:5). "Save current as scene 10" → mixer.saveScene(scene:10,name:"Service Start").
- "What's the mixer status?" → mixer.status(). Returns main fader, mute state, channel names.
- "Check channel 3 levels" → mixer.channelStatus(channel:3). Detailed per-channel info.
- DCA groups: mixer.muteDca(dca:1), mixer.unmuteDca(dca:1), mixer.setDcaFader(dca:1,level:0.75).
- Mute groups: mixer.activateMuteGroup(group:1), mixer.deactivateMuteGroup(group:1).
- "What can this mixer do?" → mixer.capabilities(). Returns supported features for this specific model.
- Channel names from context: if user says "pastor's mic" and channels show ch3=Pastor, use channel:3.` : '';

  // Companion detail rules
  const companionRules = s.companion?.connected ? `
COMPANION:
- "Press the X button" → companion.pressNamed(name:"X"). Uses fuzzy name matching on button labels.
- "Press page 2, row 1, column 3" → companion.press(page:2,row:1,col:3). Direct grid position.
- "Show me the buttons" → companion.getGrid(). Returns button layout for page 1.
- "What connections are set up?" → companion.connections(). Lists all Companion modules.
- "Read ATEM program input" → companion.getVariable(connection:"atem",variable:"pgm1_input").
- "Set custom variable X to Y" → companion.setCustomVariable(name:"X",value:"Y").
- Companion is a bridge to other systems — if user asks about a device not directly connected, check if Companion has a module for it.` : '';

  // Ecamm detail rules
  const ecammRules = s.ecamm?.connected ? `
ECAMM:
- "Go live" / "start streaming" → use encoder.startStream() (generic). Ecamm uses button toggling internally.
- "Switch to scene X" → first ecamm.getScenes() to get scene UUIDs, then ecamm.setScene(id:uuid).
- "Next scene" → ecamm.nextScene(). "Previous scene" → ecamm.prevScene().
- "Toggle mute" → ecamm.toggleMute(). This is a TOGGLE — calling it again unmutes.
- "Show PIP" / "picture in picture" → ecamm.togglePIP(). Also a toggle.
- "What inputs?" → ecamm.getInputs(). "Switch input" → ecamm.setInput(id:uuid) — requires UUID from getInputs.
- "Show overlays" → ecamm.getOverlays(). Lists available overlay options.
- "Pause" → ecamm.togglePause(). Toggle — calling again resumes.` : '';

  // AJA HELO detail rules
  const ajaRules = (s.encoder?.connected && (s.encoder.type || '').toLowerCase() === 'aja') ? `
AJA HELO:
- The encoder.* commands (startStream, stopStream, status) control the AJA HELO for basic streaming.
- aja.* commands give deeper control: input selection, profiles, presets.
- "Switch to SDI input" → aja.setVideoInput(source:0). HDMI=1, Test Pattern=2.
- "Switch audio to HDMI" → aja.setAudioInput(source:1). SDI=0, HDMI=1, Analog=2, None=4.
- BITRATE on AJA is profile-based: aja.setStreamProfile(profile:N). Profiles 0-9 are pre-configured on the device. Change profile BEFORE starting stream.
- "Recall preset 3" → aja.recallPreset(preset:3). Restores a saved configuration (up to 20 presets).
- "Mute audio" → aja.setMute(muted:true). "Unmute" → aja.setMute(muted:false).
- AJA can stream AND record simultaneously — they are independent.` : '';

  // Epiphan Pearl detail rules
  const epiphanRules = (s.encoder?.connected && (s.encoder.type || '').toLowerCase() === 'epiphan') ? `
EPIPHAN PEARL:
- ALL Epiphan commands require a channel parameter. Ask user which channel if unknown.
- "Start publishing" → epiphan.startPublisher(channel:X,publisher:X). Both channel and publisher name required.
- "Stop publishing" → epiphan.stopPublisher(channel:X,publisher:X).
- "Show layouts" → epiphan.getLayouts(channel:X). "Switch layout" → epiphan.setActiveLayout(channel:X,layout:X).
- "Show stream settings" → epiphan.getStreamingParams(channel:X).
- "Change stream settings" → epiphan.setStreamingParams(channel:X,params:{...}).` : '';

  // Camera control detail rules (BMD cameras via ATEM)
  const cameraRules = s.atem?.connected ? `
CAMERA CONTROL (Blackmagic cameras via ATEM):
- "Open the iris" / "brighten camera 1" → camera.setIris(camera:1,value:0.7). Range 0-1 (0=closed, 1=fully open).
- "Auto iris" / "auto exposure" → camera.autoIris(camera:1).
- "Set white balance to 5600K" → camera.setWhiteBalance(camera:1,kelvin:5600). Common: 3200K=tungsten, 5600K=daylight.
- "Auto white balance" → camera.autoWhiteBalance(camera:1).
- "Focus camera 1" → camera.autoFocus(camera:1). Manual: camera.setFocus(camera:1,value:0.5).
- "Reset color correction" → camera.resetColorCorrection(camera:1). Resets lift/gamma/gain/contrast/saturation to defaults.
- Shutter: values ≤360 are treated as shutter ANGLE (degrees). Values >360 are shutter SPEED (microseconds).
- Camera numbers match ATEM input numbers (camera:1 = ATEM input 1).` : '';

  // Audio rules (only include the relevant set)
  let audioRules = '';
  if (hasMixer) {
    audioRules = `
AUDIO: External mixer is connected — use mixer.* commands for audio. If user says "on the atem" → use ATEM audio commands instead.`;
  } else if (s.atem?.connected) {
    audioRules = `
AUDIO: No external mixer — use ATEM audio commands. Fairlight: index=input number, source=-256 (default), faderGain in hundredths of dB (0=0dB, -10000=-inf, 1000=+10dB).
When enabling compressor/gate/limiter/EQ → MUST set enabled flag to true with defaults.
Classic audio mute/unmute: "mute headphone/monitor" → setClassicAudioMonitorProps(mute:true). "unmute headphone/monitor" → setClassicAudioMonitorProps(mute:false). Never use setClassicAudioHeadphonesProps or setClassicAudioResetPeaks for mute/unmute.`;
  }

  const prompt = `You parse natural language into JSON commands for Tally, a church AV control system.
Return ONLY valid JSON. No markdown, no explanation.

AVAILABLE COMMANDS (N=number, X=string):
${sigs.join('\n')}
${streamingRules}
${audioRules}
${webPresenterRules}
${obsRules}
${vmixRules}
${hyperdeckRules}
${ptzRules}
${videohubRules}
${propresenterRules}
${resolumeRules}
${mixerRules}
${companionRules}
${ecammRules}
${ajaRules}
${epiphanRules}
${cameraRules}

OUTPUT FORMAT — return exactly one of these JSON shapes:
Single: {"type":"command","command":"atem.cut","params":{"input":2}}
Multi: {"type":"commands","steps":[{"command":"...","params":{...}},{"command":"...","params":{...}}]}
Chat: {"type":"chat","text":"..."}

MULTI-STEP: If user asks for >1 action ("then", "and", commas, lists) → MUST return type "commands" with steps array.

WHEN UNSURE — ASK: If ambiguous, return a chat response asking the user to clarify with 2-4 specific options they can say verbatim.

NEVER ASK FOR CONFIRMATION: The server has its own safety system (stream guard) that intercepts dangerous commands and prompts the user. ALWAYS return the command JSON — never return a chat asking "are you sure?" or telling the user to "confirm: X". If you ask for confirmation, the server can't handle "yes" and the user gets stuck.

OPERATOR LEVEL: Context "Operator: volunteer|intermediate|pro". volunteer=simple language, pro=concise. Auto-detect if missing.
${atemDetailRules}
PROPRESENTER:
- "Next slide" / "put up the lyrics" / "advance slides" / "next" → propresenter.next()
- "Previous slide" / "go back a slide" → propresenter.previous()
- "Go to slide 5" / "jump to slide X" → propresenter.goToSlide(index:X). Use the user-visible 1-based number ("slide 5" → index:5). The system converts to 0-based internally.
- "Last slide" / "go to the end" / "end of the slideshow" / "end of presentation" → propresenter.lastSlide()
- "First slide" / "go to the beginning" / "start of presentation" → propresenter.goToSlide(index:1)
- "Clear slides" / "clear the screen" / "blank ProPresenter" → propresenter.clearAll()
- "What slide are we on?" / "slide status" → propresenter.status()
- "Start the countdown" / "start timer" → propresenter.startTimer(name:X). Ask for timer name if unknown.
- "Stop the timer" → propresenter.stopTimer(name:X)

PTZ CAMERAS:
- "Zoom in" → ptz.zoom(speed:0.3). "Zoom in more/faster" → ptz.zoom(speed:0.7). "Zoom out" → ptz.zoom(speed:-0.3).
- "Pan left" → ptz.pan(speed:-0.3). "Pan right" → ptz.pan(speed:0.3).
- "Tilt up" → ptz.tilt(speed:0.3). "Tilt down" → ptz.tilt(speed:-0.3).
- "Stop" / "stop moving" → ptz.stop(). Stops all PTZ movement.
- "Go to preset 1" / "recall position 1" → ptz.recallPreset(preset:1).
- Default speed for gentle moves: 0.3. Fast moves: 0.7. Max: 1.0.
- If multiple PTZ cameras, ask which one. If only one, use camera:1.

AUDIO:
- "Mute mic X" / "mute channel X" → mixer.mute(channel:X) or ATEM Fairlight: setFairlightAudioSourceProps(index:X,source:-256,mixOption:0). mixOption 0=off, 1=on, 2=AFV.
- "Unmute mic X" → mixer.unmute(channel:X) or Fairlight: setFairlightAudioSourceProps(index:X,source:-256,mixOption:1).
- "Turn up mic X" / "louder on X" → increase fader by +0.1 (mixer) or +300 faderGain (Fairlight). Do NOT ask what level — just bump it.
- "Turn down mic X" / "quieter on X" → decrease fader by -0.1 (mixer) or -300 faderGain (Fairlight).
- "Master louder" / "turn up the master" → mixer.setMaster(level:+0.1) or Fairlight: setFairlightAudioMasterProps(faderGain:+300).
- If user says a name like "pastor's mic" or "drums", check input labels from context. If no match, ask: "Which channel is that? Give me the number."
- "Audio follow video" / "AFV on input X" / "set cam X to AFV" → setFairlightAudioSourceProps(index:X,source:-256,mixOption:2). mixOption 2 = AFV.
- "Turn off AFV on input X" / "take X off AFV" → setFairlightAudioSourceProps(index:X,source:-256,mixOption:1). Sets it back to always on.
- "AFV all" / "set all inputs to AFV" → multi-step: one setFairlightAudioSourceProps per input with mixOption:2.
- "What's on AFV?" / "which inputs are AFV?" → return a chat response listing current audio routing from context.

UNDO:
- "Undo" / "go back" / "that was wrong" → Look at the last command in conversation history. If it was atem.cut(input:X), look for the PREVIOUS program input from context and cut back to it. If it was a mute, unmute. If it was setDskOnAir(onAir:true), set onAir:false. If you can't determine the reverse, say "I'm not sure what to undo — what should I change back?"

RECORDING & STREAMING DEVICE PRIORITY:
- If user says "start recording" / "start streaming" without specifying device:
  - Priority: ATEM streaming/recording first (if ATEM supports it). Then OBS/vMix. Then encoder. Then HyperDeck.
  - If multiple devices are connected, use whichever is already configured for streaming/recording.
  - "Record to the deck" / "record on hyperdeck" → hyperdeck.record()
  - "Stop all" / "stop everything" → multi-step: stop streaming + stop recording on ALL connected devices.

RULES:
- ALWAYS EXECUTE, NEVER SUGGEST: If you can map the user's intent to a command, return the command JSON. NEVER return a chat response telling the user to "run" or "try" a command. If you need more info before acting, run a query command yourself, then act on the result. The user talks to you so YOU can do things — not so you can tell them what to do.
- If the user types something that looks like a command name (e.g. "status", "getPlatforms"), treat it as a direct request to execute that command.
- Match camera labels from context when available. If user says "camera 1" and labels show 1=Main Cam, use input 1.
- Off-topic → {"type":"chat","text":"I'm only here for production. Try 'help' for what I can do."}
- Use conversation history for "again", "undo that", etc. Up to 50 steps. Batch: "mute 1-8" → one step per channel.
- "we're done"/"that's a wrap" → multi-step: fadeToBlack + stop all streams + stop all recordings on all connected devices.
- Troubleshooting: describe problem → return diagnosis with suggested commands.
- Social phrases (thanks, hi) → friendly reply, NOT off-topic response.
- Volunteer phrases: "are we live?" → status()
- DEVICE STATUS ACCURACY: When reporting device status (connected/disconnected/online/offline), ONLY report on devices listed as "Configured devices" in the context. If a device is NOT in the configured list, it does NOT exist for this church — never mention it as disconnected or reference it. Use the live status data from the context block, not your general knowledge.

MEMORY & PERSONALITY:
- The context block may contain [Memory: ...] with learned observations about this specific church.
- When memories are relevant, reference them naturally: "I remember last time this happened..." or "Based on your setup history..."
- Be specific: use their camera labels, mixer channel names, and encoder type — not generic terms.
- Think like a veteran TD who knows this room personally.
- If a memory mentions a fix that worked before, suggest it first.
- Never say "I don't have access to that information" — use the live status data in the context block.`;

  return prompt;
}


// ─── Anthropic API call ───────────────────────────────────────────────────

async function callAnthropic(messages, timeout = 15000, systemPrompt = '', model = 'claude-haiku-4-5-20251001') {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const MAX_RETRIES = 2;
  const RETRY_DELAYS = [1000, 2500]; // ms before each retry

  const callStartMs = Date.now();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          system: systemPrompt,
          messages,
          temperature: model.includes('sonnet') ? 0.4 : 0.2,
          max_tokens: model.includes('sonnet') ? 4096 : 2048,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const body = await resp.text();
        const status = resp.status;
        // Retry on 429 (rate-limited) or 529 (overloaded) — not on 4xx auth/validation errors
        if ((status === 429 || status === 529) && attempt < MAX_RETRIES) {
          clearTimeout(timeoutId);
          console.warn(`[ai-parser] API ${status}, retry ${attempt + 1}/${MAX_RETRIES} in ${RETRY_DELAYS[attempt]}ms`);
          await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
          continue;
        }
        throw new Error(`Anthropic API ${status}: ${body.slice(0, 100)}`);
      }

      const data = await resp.json();
      const raw = data?.content?.[0]?.text?.trim();

      if (!raw) throw new Error('Anthropic returned empty response');
      const latencyMs = Date.now() - callStartMs;
      return { text: raw, usage: data.usage || null, latencyMs };

    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ─── JSON parser (handles markdown wrapping) ────────────────────────────────

function parseJSON(raw) {
  // Try direct parse first
  try { return JSON.parse(raw); } catch { /* continue */ }

  // Strip markdown code blocks
  let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(cleaned); } catch { /* continue */ }

  // Extract first JSON object from response (AI sometimes wraps in text)
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch { /* continue */ }
  }

  // Strip trailing commas (common AI mistake)
  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(cleaned); } catch { /* continue */ }

  console.warn('[ai-parser] Failed to parse AI response:', raw.substring(0, 200));
  throw new Error('Failed to parse AI response as JSON');
}

// ─── Main parse function ────────────────────────────────────────────────────

/**
 * @param {string} text — raw message from the TD
 * @param {object} [ctx] — optional church context
 * @param {string} [ctx.churchName]
 * @param {object} [ctx.status] — current device status (atem, obs, companion, etc.)
 * @param {Array<{role: string, content: string}>} [conversationHistory=[]] — recent chat history
 * @returns {Promise<ParseResult>}
 *
 * ParseResult shapes:
 *   { type: 'command', command, params }
 *   { type: 'commands', steps: [{ command, params }] }
 *   { type: 'chat', text }
 *   { type: 'error', message }   — if API call fails
 */
/**
 * Detect if a message is a diagnostic/troubleshooting question that warrants Sonnet.
 * Commands like "cut to cam 1" stay on Haiku. Questions like "why did my stream drop?" go to Sonnet.
 */
function _isDiagnosticQuestion(text) {
  const t = text.toLowerCase().trim();
  // Diagnostic keywords / patterns
  const diagnosticPatterns = [
    /\bwhy\b.*\b(drop|fail|stop|crash|disconnect|die|broke|down|lost|mute|silent|freeze|lag|buffer)/,
    /\bwhat('s| is)\b.*\b(wrong|happening|issue|problem|cause|going on)/,
    /\bhow\b.*\b(fix|solve|troubleshoot|diagnose|resolve|prevent|avoid)/,
    /\bhelp\b.*\b(me|with|troubleshoot|diagnose|figure|understand)/,
    /\b(diagnos|troubleshoot|root cause|investigate|debug)/,
    /\b(keeps? (dropping|crashing|disconnecting|failing|stopping|freezing))/,
    /\b(not working|won't connect|can't connect|no signal|no audio|no video)/,
    /\b(stream|encoder|atem|obs|mixer|camera|audio)\b.*\b(issue|problem|error|fail|broke)/,
    /\b(what happened|what went wrong|what caused|explain|tell me about)/,
    /\b(should i|do i need|is it normal|is something wrong)/,
  ];
  return diagnosticPatterns.some(p => p.test(t));
}

async function aiParseCommand(text, ctx = {}, conversationHistory = []) {
  // ── Pre-filter: reject obviously off-topic messages before calling AI ──
  if (!isOnTopic(text)) {
    console.log('[ai-parser] Blocked off-topic message (pre-filter)');
    return { type: 'chat', text: OFF_TOPIC_RESPONSE };
  }

  // ── Rate limit: tier-based AI calls per church per hour ──
  const churchId = ctx.churchId || ctx.churchName || '_default';
  const tier = ctx.tier || 'default';
  if (!checkAiRateLimit(churchId, tier)) {
    const limit = AI_RATE_LIMITS[tier] || AI_RATE_LIMITS.default;
    console.warn(`[ai-parser] Rate limit hit for ${churchId} (${limit}/hr, tier: ${tier})`);
    return { type: 'rate_limited', text: `AI parsing temporarily at capacity. Try direct commands like "cam 2" or "status".` };
  }

  // ── Cache check: skip API call for repeated single messages (no history context) ──
  const cacheKey = text.trim().toLowerCase();
  if (conversationHistory.length === 0) {
    const cached = getCachedResponse(cacheKey);
    if (cached) {
      console.log(`[ai-parser] Cache hit: "${cacheKey.slice(0, 40)}"`);
      if (_logAiUsage) {
        _logAiUsage({
          churchId: ctx.churchId || null,
          feature: 'command_parser',
          model: 'claude-haiku-4-5-20251001',
          inputTokens: 0, outputTokens: 0, cached: true,
        });
      }
      return cached;
    }
  }

  // Build context hint from live status + engineer profile
  let contextHint = '';
  if (ctx.churchName) contextHint += `Church: ${ctx.churchName}. `;
  if (ctx.roomId) contextHint += `Room ID: ${ctx.roomId}${ctx.roomName ? ` (${ctx.roomName})` : ''}. `;

  // ── Multi-switcher status (preferred over legacy single-ATEM) ──
  if (ctx.status?.switchers && Object.keys(ctx.status.switchers).length > 0) {
    for (const [swId, sw] of Object.entries(ctx.status.switchers)) {
      const typeLabel = (sw.type || 'switcher').toUpperCase();
      let swInfo = `${typeLabel} "${sw.name || swId}" [${sw.role || 'primary'}]: ${sw.connected ? 'connected' : 'DISCONNECTED'}`;
      if (sw.connected) {
        if (sw.model) swInfo += ` (${sw.model})`;
        swInfo += `, pgm=input ${sw.programInput || '?'}, pvw=input ${sw.previewInput || '?'}`;
        if (sw.streaming) swInfo += ', streaming';
        if (sw.recording) swInfo += ', recording';
      }
      contextHint += swInfo + '. ';
    }
  }

  // ATEM switcher (legacy single-ATEM path — skipped if multi-switcher already reported)
  if (ctx.status?.atem?.connected && !(ctx.status?.switchers && Object.keys(ctx.status.switchers).length > 0)) {
    const s = ctx.status.atem;
    let atemInfo = 'ATEM';
    if (s.model) atemInfo += ` (${s.model})`;
    atemInfo += `: pgm=cam${s.programInput || '?'}, pvw=cam${s.previewInput || '?'}`;
    if (s.inTransition) atemInfo += ', IN TRANSITION';
    contextHint += atemInfo + '. ';
    if (s.inputLabels && Object.keys(s.inputLabels).length) {
      const labels = Object.entries(s.inputLabels).map(([k, v]) => `${k}=${v}`).join(', ');
      contextHint += `Labels: ${labels}. `;
    }
    if (s.streaming) contextHint += `ATEM streaming${s.streamingBitrate ? ` ${s.streamingBitrate}kbps` : ''}${s.streamingService ? ` (${s.streamingService})` : ''}. `;
    if (s.recording) contextHint += 'ATEM recording. ';
  }
  // ATEM extended state (always include if ATEM connected, regardless of multi-switcher)
  if (ctx.status?.atem?.connected) {
    const s = ctx.status.atem;
    // audio_via_atem flag for audio routing
    if (ctx.status.audio_via_atem || ctx.status.audioViaAtem) contextHint += 'audio_via_atem=true. ';
    // Input labels (if not already added above via legacy path)
    if (ctx.status?.switchers && Object.keys(ctx.status.switchers).length > 0) {
      if (s.inputLabels && Object.keys(s.inputLabels).length) {
        const labels = Object.entries(s.inputLabels).map(([k, v]) => `${k}=${v}`).join(', ');
        contextHint += `ATEM Labels: ${labels}. `;
      }
    }
  }

  // OBS
  if (ctx.status?.obs?.connected) {
    const o = ctx.status.obs;
    let obsInfo = `OBS: ${o.streaming ? 'live' : 'idle'}`;
    if (o.streaming && o.bitrate) obsInfo += `, ${o.bitrate}kbps`;
    if (o.fps) obsInfo += `, ${o.fps}fps`;
    if (o.currentScene) obsInfo += `, scene="${o.currentScene}"`;
    if (o.recording) obsInfo += ', recording';
    contextHint += obsInfo + '. ';
    if (o.scenes?.length) contextHint += `OBS scenes: ${o.scenes.join(', ')}. `;
  }

  // vMix
  if (ctx.status?.vmix?.connected) {
    const v = ctx.status.vmix;
    let vmixInfo = `vMix: ${v.streaming ? 'live' : 'idle'}`;
    if (v.recording) vmixInfo += ', recording';
    if (v.edition) vmixInfo += ` (${v.edition})`;
    if (v.activeInput) vmixInfo += `, active=${v.activeInput}`;
    if (v.masterVolume != null) vmixInfo += `, vol=${v.masterVolume}`;
    if (v.masterMuted) vmixInfo += ', MUTED';
    contextHint += vmixInfo + '. ';
  }

  // Encoder bridge
  if (ctx.status?.encoder?.connected) {
    const e = ctx.status.encoder;
    let encInfo = `Encoder: ${e.type || 'unknown'}, ${e.live ? 'live' : 'idle'}`;
    if (e.bitrateKbps) encInfo += `, ${e.bitrateKbps}kbps`;
    if (e.fps) encInfo += `, ${e.fps}fps`;
    contextHint += encInfo + '. ';
  }

  // Backup encoder
  if (ctx.status?.backupEncoder?.configured) {
    const be = ctx.status.backupEncoder;
    contextHint += `Backup encoder: ${be.type || 'unknown'}, ${be.connected ? 'connected' : 'DISCONNECTED'}${be.live ? ', live' : ''}. `;
  }

  // Web Presenter extended info (platform, quality profile)
  const wpStatus = ctx.status?.webPresenter || (ctx.status?.encoder?.type?.toLowerCase() === 'blackmagic' ? ctx.status.encoder : null);
  if (wpStatus?.connected) {
    // Note: platform/quality/server may not be in basic status — getActivePlatform fetches it on demand
    let wpInfo = 'WebPresenter: use blackmagic.* commands for platform/bitrate/format config';
    if (wpStatus.platform) wpInfo += `, platform=${wpStatus.platform}`;
    if (wpStatus.quality) wpInfo += `, quality=${wpStatus.quality}`;
    contextHint += wpInfo + '. ';
  }

  // ProPresenter
  if (ctx.status?.proPresenter?.connected) {
    const pp = ctx.status.proPresenter;
    let ppInfo = `ProPresenter: slide ${pp.slideIndex != null ? pp.slideIndex + 1 : '?'}/${pp.slideTotal || '?'}`;
    if (pp.presentationName) ppInfo += ` ("${pp.presentationName}")`;
    if (pp.activeLook) ppInfo += `, look="${pp.activeLook}"`;
    contextHint += ppInfo + '. ';
  }

  // Audio mixer
  if (ctx.status?.mixer?.connected) {
    const m = ctx.status.mixer;
    contextHint += `Audio: ${m.type || ''} ${m.model || ''}${m.mainMuted ? ', MUTED' : ''}. `;
    if (m.channelNames && Object.keys(m.channelNames).length) {
      const chNames = Object.entries(m.channelNames).map(([k, v]) => `ch${k}=${v}`).join(', ');
      contextHint += `Channels: ${chNames}. `;
    }
  }

  // Audio silence detection
  if (ctx.status?.audio?.silenceDetected) {
    contextHint += '⚠ AUDIO SILENCE DETECTED. ';
  }

  // PTZ cameras
  const ptzConnected = (ctx.status?.ptz || []).filter(c => c.connected);
  if (ptzConnected.length) contextHint += `PTZ: ${ptzConnected.length} camera${ptzConnected.length > 1 ? 's' : ''} connected. `;

  // HyperDecks (array format)
  const hyperdeckArr = ctx.status?.hyperdecks || [];
  if (hyperdeckArr.length > 0) {
    const hdParts = hyperdeckArr.map((hd, i) => {
      if (!hd) return null;
      let info = `deck${i + 1}=${hd.connected ? (hd.recording ? 'recording' : hd.playing ? 'playing' : 'idle') : 'disconnected'}`;
      if (hd.connected && hd.diskPercent != null) info += ` disk=${hd.diskPercent}%`;
      return info;
    }).filter(Boolean);
    if (hdParts.length) contextHint += `HyperDecks: ${hdParts.join(', ')}. `;
  } else if (ctx.status?.hyperdeck?.connected) {
    // Legacy single hyperdeck fallback
    const hd = ctx.status.hyperdeck;
    let hdInfo = `HyperDeck: ${hd.recording ? 'recording' : hd.playing ? 'playing' : 'idle'}`;
    if (hd.diskPercent != null) hdInfo += `, disk=${hd.diskPercent}%`;
    if (hd.estimatedMinutesRemaining != null) hdInfo += `, ~${hd.estimatedMinutesRemaining}min remaining`;
    contextHint += hdInfo + '. ';
  }

  // VideoHubs (array format)
  const vhArr = ctx.status?.videoHubs || [];
  if (vhArr.length > 0) {
    const vhConnected = vhArr.filter(h => h?.connected).length;
    contextHint += `VideoHub: ${vhConnected}/${vhArr.length} connected. `;
  } else if (ctx.status?.videohub?.connected) {
    contextHint += 'VideoHub: connected. ';
  }

  // Resolume
  if (ctx.status?.resolume?.connected) {
    let resInfo = 'Resolume: connected';
    if (ctx.status.resolume.version) resInfo += ` (${ctx.status.resolume.version})`;
    contextHint += resInfo + '. ';
  }

  // Ecamm
  if (ctx.status?.ecamm?.connected) {
    const ec = ctx.status.ecamm;
    contextHint += `Ecamm: ${ec.live ? 'live' : 'idle'}${ec.recording ? ', recording' : ''}. `;
  }

  // Dante
  if (ctx.status?.dante?.connected) {
    contextHint += 'Dante: connected. ';
  }

  // NDI
  if (ctx.status?.ndi?.connected) {
    contextHint += 'NDI: connected. ';
  }

  // Smart plugs (Shelly)
  const plugs = ctx.status?.smartPlugs || [];
  if (plugs.length > 0) {
    const plugParts = plugs.map(p => `${p.name || p.ip}=${p.on ? 'ON' : 'OFF'}${p.power ? ` ${p.power}W` : ''}`);
    contextHint += `Smart plugs: ${plugParts.join(', ')}. `;
  }

  // Companion
  if (ctx.status?.companion?.connected) {
    const cc = ctx.status.companion.connectionCount || 0;
    if (cc > 0) {
      const connLabels = (ctx.status.companion.connections || []).map(c => c.label).filter(Boolean).join(', ');
      contextHint += `Companion: ${cc} module${cc > 1 ? 's' : ''}${connLabels ? ' (' + connLabels + ')' : ''}. `;
      // Include live variable values if available
      const vars = ctx.status.companion.variables;
      if (vars && Object.keys(vars).length > 0) {
        const varParts = [];
        for (const [conn, varObj] of Object.entries(vars)) {
          const entries = Object.entries(varObj).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join(', ');
          if (entries) varParts.push(`${conn}: ${entries}`);
        }
        if (varParts.length) contextHint += `Companion vars: ${varParts.join('; ')}. `;
      }
    }
  }

  // ── Device health telemetry (latency, reconnects) ──
  if (ctx.status?.health) {
    const h = ctx.status.health;
    const healthParts = [];
    if (h.relay?.latencyMs != null) healthParts.push(`relay=${h.relay.latencyMs}ms`);
    if (h.atem?.latencyMs != null) healthParts.push(`atem=${h.atem.latencyMs}ms`);
    if (h.atem?.reconnects > 0) healthParts.push(`atem_reconnects=${h.atem.reconnects}`);
    if (h.encoder?.reconnects > 0) healthParts.push(`encoder_reconnects=${h.encoder.reconnects}`);
    if (h.obs?.reconnects > 0) healthParts.push(`obs_reconnects=${h.obs.reconnects}`);
    if (healthParts.length) contextHint += `Device health: ${healthParts.join(', ')}. `;
  }

  // ── System info ──
  if (ctx.status?.system) {
    const sys = ctx.status.system;
    if (sys.uptime > 0) contextHint += `System uptime: ${Math.floor(sys.uptime / 60)}min. `;
  }

  // ── Recent alerts (from DB, passed by server.js) ──
  if (ctx.recentAlerts?.length > 0) {
    const alertParts = ctx.recentAlerts.slice(0, 5).map(a => {
      const status = a.resolved ? 'resolved' : a.acknowledged_at ? 'acked' : 'ACTIVE';
      return `${a.alert_type}(${a.severity})[${status}]`;
    });
    contextHint += `Recent alerts: ${alertParts.join(', ')}. `;
  }

  // ── Health score (from DB, passed by server.js) ──
  if (ctx.healthScore != null) {
    contextHint += `Health score: ${ctx.healthScore}/100. `;
  }

  // ── Signal failover state (passed by server.js) ──
  if (ctx.failoverState && ctx.failoverState !== 'HEALTHY') {
    contextHint += `⚠ Failover state: ${ctx.failoverState}. `;
  }

  // Engineer profile (user-provided setup context)
  const ep = ctx.engineerProfile;
  if (ep && Object.keys(ep).length) {
    if (ep.streamPlatform && ep.streamPlatform !== 'None') contextHint += `Streams to: ${ep.streamPlatform}. `;
    if (ep.expectedViewers) contextHint += `Expected viewers: ${ep.expectedViewers}. `;
    if (ep.operatorLevel) contextHint += `Operator: ${ep.operatorLevel}. `;
    if (ep.backupEncoder) contextHint += `Backup encoder: ${ep.backupEncoder}. `;
    if (ep.backupSwitcher) contextHint += `Backup switcher: ${ep.backupSwitcher}. `;
    if (ep.specialNotes) contextHint += `Notes: ${ep.specialNotes}. `;
  }

  // Configured devices summary: tells AI exactly which devices this church has
  // This prevents the AI from hallucinating disconnected devices that aren't configured
  const configuredTypes = ctx.configuredDevices || [];
  if (configuredTypes.length > 0) {
    const connectedSet = new Set();
    // Build set of currently connected device types from live status
    if (ctx.status?.atem?.connected) connectedSet.add('atem');
    if (ctx.status?.obs?.connected) connectedSet.add('obs');
    if (ctx.status?.vmix?.connected) connectedSet.add('vmix');
    if (ctx.status?.encoder?.connected) connectedSet.add('encoder');
    if (ctx.status?.proPresenter?.connected) connectedSet.add('proPresenter');
    if (ctx.status?.companion?.connected) connectedSet.add('companion');
    if (ctx.status?.mixer?.connected) connectedSet.add('mixer');
    if (ctx.status?.hyperdeck?.connected) connectedSet.add('hyperdeck');
    if ((ctx.status?.ptz || []).some(c => c?.connected)) connectedSet.add('ptz');
    if (ctx.status?.videohub?.connected) connectedSet.add('videohub');
    if (ctx.status?.resolume?.connected) connectedSet.add('resolume');
    if (ctx.status?.ecamm?.connected) connectedSet.add('ecamm');
    if (ctx.status?.dante?.connected) connectedSet.add('dante');
    if (ctx.status?.ndi?.connected) connectedSet.add('ndi');

    const parts = configuredTypes.map(key => {
      const name = DEVICE_DISPLAY_NAMES[key] || key;
      return connectedSet.has(key) ? `${name}=Connected` : `${name}=Disconnected`;
    });
    contextHint += `Configured devices: ${parts.join(', ')}. `;
    // Explicitly note devices NOT configured so AI doesn't invent them
    const allKnown = Object.keys(DEVICE_DISPLAY_NAMES);
    const notConfigured = allKnown.filter(k => !configuredTypes.includes(k));
    if (notConfigured.length) {
      contextHint += `NOT configured (do not mention): ${notConfigured.map(k => DEVICE_DISPLAY_NAMES[k]).join(', ')}. `;
    }
  }

  // Church memory (pre-compiled summary from past observations)
  if (ctx.memorySummary) contextHint += ctx.memorySummary + ' ';

  // Church knowledge base documents (relevant chunk for current query)
  if (ctx.documentContext) contextHint += `[Docs: ${ctx.documentContext}] `;

  const userContent = contextHint
    ? `[${contextHint.trim()}]\n${text}`
    : text;

  // Build messages array: conversation history + current message
  const messages = [...conversationHistory, { role: 'user', content: userContent }];

  // ── Detect diagnostic/troubleshooting intent → upgrade to Sonnet ──
  const isDiagnostic = _isDiagnosticQuestion(text);
  const useSonnet = isDiagnostic && !!ctx.diagnosticContext;
  const modelId = useSonnet ? 'claude-sonnet-4-20250514' : 'claude-haiku-4-5-20251001';

  // Build dynamic system prompt based on connected devices
  let systemPrompt = buildSystemPrompt(ctx.status || {});

  // For diagnostic questions, inject diagnostic context + memory referencing instructions
  if (useSonnet) {
    systemPrompt += `\n\n--- DIAGNOSTIC CONTEXT ---\n${ctx.diagnosticContext}\n`;
    systemPrompt += `\n--- INCIDENT CHAINS ---\n${ctx.incidentChains || 'No known incident chains yet.'}\n`;
    systemPrompt += `\n--- INSTRUCTIONS FOR DIAGNOSTIC RESPONSES ---
When troubleshooting:
1. Reference specific memories if relevant: "Last time this happened (2 weeks ago), it was caused by..."
2. Correlate current symptoms with past patterns: "I've seen this pattern 3 times — encoder drops followed by stream failure within 30s"
3. Walk the user through diagnosis step by step — ask follow-up questions if needed
4. Rank possible causes by likelihood based on their specific equipment and history
5. Be specific to THEIR gear: "Your ${ctx.status?.atem?.model || 'ATEM'} + ${ctx.status?.mixer?.model || 'mixer'} setup typically has issue X"
6. If you see a memory about a fix that worked before, suggest it first: "This worked last time: [specific fix]"
7. Think like a veteran TD who knows this specific room — reference their camera labels, mixer channels, encoder type
8. Keep responses conversational — you're their engineer buddy, not a manual
9. Do NOT use markdown formatting (no **bold**, no *italic*, no bullet points, no headers). Write in plain conversational text like you're texting a coworker.\n`;
  }

  const promptTokenEst = Math.round(systemPrompt.length / 4);
  try {
    console.log(`[ai-parser] ctx.churchName="${ctx.churchName}" ctx.roomId="${ctx.roomId}" ctx.roomName="${ctx.roomName}" contextHint="${contextHint.slice(0, 120)}"`);
    console.log(`[ai-parser] Calling ${useSonnet ? 'Sonnet (diagnostic)' : 'Haiku'} (${messages.length} msg, ~${promptTokenEst} prompt tokens) for: "${text.slice(0, 60)}"`);
    const { text: raw, usage, latencyMs } = await callAnthropic(messages, useSonnet ? 25000 : 15000, systemPrompt, modelId);
    console.log(`[ai-parser] ${useSonnet ? 'Sonnet' : 'Haiku'} response (${latencyMs}ms): ${raw.slice(0, 300)}`);

    // Log AI usage
    if (_logAiUsage && usage) {
      _logAiUsage({
        churchId: ctx.churchId || null,
        feature: useSonnet ? 'diagnostic_engineer' : 'command_parser',
        model: modelId,
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
        latencyMs,
        intent: useSonnet ? 'diagnostic' : 'command',
      });
    }

    const parsed = parseJSON(raw);

    if (!parsed.type || !['command', 'commands', 'chat'].includes(parsed.type)) {
      throw new Error(`Invalid response type: ${parsed.type}`);
    }

    // ── Validate command names exist in the handler registry ──
    if (parsed.type === 'command' && parsed.command) {
      if (parsed.command !== 'system.wait' && parsed.command !== 'system.preServiceCheck' && !AVAILABLE_COMMANDS.includes(parsed.command)) {
        console.warn(`[ai-parser] AI hallucinated command: ${parsed.command}`);
        return {
          type: 'chat',
          text: `I tried to run "${parsed.command}" but that command doesn't exist. Could you rephrase what you'd like to do?`,
        };
      }
    }
    if (parsed.type === 'commands' && Array.isArray(parsed.steps)) {
      const invalid = parsed.steps.find((s) =>
        s.command && s.command !== 'system.wait' && s.command !== 'system.preServiceCheck' && !AVAILABLE_COMMANDS.includes(s.command)
      );
      if (invalid) {
        console.warn(`[ai-parser] AI hallucinated command in multi-step: ${invalid.command}`);
        return {
          type: 'chat',
          text: `I tried to run "${invalid.command}" but that command doesn't exist. Could you rephrase what you'd like to do?`,
        };
      }
    }

    // ── Post-parse corrections: fix known AI misroutes ──
    // If ATEM is connected and AI chose preview.snap but user meant preview switching, fix it
    if (ctx.status?.atem?.connected) {
      const lower = text.trim().toLowerCase();
      const previewSwitchPattern = /(?:preview|pvw)\s*(?:cam|camera|input|source)?\s*(\d+)|(?:cam|camera|input|source)\s*(\d+)\s*(?:to|on|in)\s*preview|(?:take|put|set|show|see)\s*(?:cam|camera|input)?\s*(\d+)\s*(?:to|on|in)?\s*preview|^preview\s+(\d+)$/i;
      const match = lower.match(previewSwitchPattern);

      function fixPreviewSnap(cmd) {
        if (cmd.command === 'preview.snap' && match) {
          const inputNum = parseInt(match[1] || match[2] || match[3] || match[4], 10);
          if (inputNum) {
            console.log(`[ai-parser] Corrected preview.snap → atem.setPreview(input:${inputNum})`);
            cmd.command = 'atem.setPreview';
            cmd.params = { input: inputNum };
          }
        }
        // Also fix obs.setPreviewScene when ATEM is connected and user didn't say "obs"
        if (cmd.command === 'obs.setPreviewScene' && !lower.includes('obs')) {
          const inputNum = parseInt(cmd.params?.input || cmd.params?.scene, 10);
          if (inputNum) {
            console.log(`[ai-parser] Corrected obs.setPreviewScene → atem.setPreview(input:${inputNum})`);
            cmd.command = 'atem.setPreview';
            cmd.params = { input: inputNum };
          }
        }
      }

      if (parsed.type === 'command') fixPreviewSnap(parsed);
      if (parsed.type === 'commands' && Array.isArray(parsed.steps)) parsed.steps.forEach(fixPreviewSnap);
    }

    // ── Coerce common parameter types to prevent silent failures ──
    function coerceParams(params) {
      if (!params || typeof params !== 'object') return params;
      const coerced = { ...params };
      // Numeric fields that AI sometimes returns as strings
      for (const key of ['input', 'aux', 'keyer', 'me', 'player', 'index', 'rate', 'macroIndex', 'preset', 'channel', 'hyperdeck', 'camera', 'box']) {
        if (key in coerced && typeof coerced[key] === 'string' && /^\d+$/.test(coerced[key])) {
          coerced[key] = parseInt(coerced[key], 10);
        }
      }
      // Boolean fields
      for (const key of ['onAir', 'tie', 'enabled', 'playing', 'loop', 'mute', 'solo', 'invertKey', 'preMultiplied', 'maskEnabled', 'flyEnabled', 'cropped']) {
        if (key in coerced && typeof coerced[key] === 'string') {
          coerced[key] = coerced[key] === 'true';
        }
      }
      return coerced;
    }

    if (parsed.type === 'command' && parsed.params) {
      parsed.params = coerceParams(parsed.params);
    }
    if (parsed.type === 'commands' && Array.isArray(parsed.steps)) {
      for (const step of parsed.steps) {
        if (step.params) step.params = coerceParams(step.params);
      }
    }

    // Cache the result (only for single-turn requests without history)
    if (conversationHistory.length === 0) {
      setCachedResponse(cacheKey, parsed);
    }

    const stepCount = parsed.type === 'commands' ? (parsed.steps?.length || 0) : (parsed.type === 'command' ? 1 : 0);
    console.log(`[ai-parser] ✓ type: ${parsed.type}, steps: ${stepCount}`);
    return parsed;

  } catch (err) {
    console.error(`[ai-parser] Error: ${err.message}`);
    // Return a volunteer-friendly message instead of raw API jargon
    let friendly = 'Tally couldn\'t understand that — try a simpler command like "cam 2" or "go live".';
    if (err.message?.includes('API') && err.message?.includes('529')) {
      friendly = 'AI is temporarily busy — try again in a moment, or use a direct command like "cam 2".';
    } else if (err.message?.includes('API') && err.message?.includes('rate')) {
      friendly = 'Too many requests — wait a moment and try again.';
    } else if (err.message?.includes('timeout') || err.name === 'AbortError' || err.message?.includes('abort')) {
      friendly = 'Request timed out — try again or use a direct command like "status".';
    } else if (err.message?.includes('API_KEY')) {
      friendly = 'AI features are not configured — contact your admin.';
    }
    return {
      type: 'error',
      message: friendly,
      _debug: err.message, // preserve raw error for server logs only
    };
  }
}

module.exports = { aiParseCommand, getAvailableCommandNames, setAiUsageLogger, setIncidentBypassCheck, checkAiRateLimit, buildSystemPrompt, getConfiguredDeviceTypes };
