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
    const { commandHandlers } = require('../../church-client/src/commands');
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

const SYSTEM_PROMPT = `You are the command parser for Tally, a church AV monitoring and control system.
A church Technical Director has sent a natural language message via Telegram.
Your job: parse it into one or more structured commands.

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
- Be liberal with inference. "wide angle" likely means camera 1. "pastor" likely means camera 2. "center" or "main" likely means camera 1 or the current program input.
- If the message references lowering/muting audio: map to companion.pressNamed with a descriptive name like "Mute Audience Mics" or "Lower Music".
- If the message is production-related but you cannot map it to a command with confidence, return type:chat with a brief clarifying question.
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
  webPresenter: `blackmagic (Web Presenter): getActivePlatform(), setActivePlatform(platform:X,server:X,key:X,quality:X), getPlatforms(), getPlatformConfig(name:X), getVideoFormat(), setVideoFormat(format:X), getSupportedVideoFormats(), getAudioSources(), setAudioSource(source:X)`,
  companion: `companion: pressNamed(name:X), press(page:N,row:N,col:N), getGrid(), connections(), getVariable(connection:X,variable:X), getCustomVariable(name:X), setCustomVariable(name:X,value:X), getWatchedVariables(). Use getVariable to read device state through Companion (e.g. getVariable("atem","pgm1_input") for current program source, getVariable("obs","current_scene") for OBS scene).`,
  vmix: `vmix: startStream(), stopStream(), startRecording(), stopRecording(), cut(), fade(ms:N), setPreview(input:N), setProgram(input:N), setVolume(value:N), mute(), unmute(), function(function:X,input:X), status(), listInputs(), isRunning(), startPlaylist(), stopPlaylist(), audioLevels(), fadeToBlack(), setInputVolume(input:X,volume:0-100), muteInput(input:X), unmuteInput(input:X), overlayInput(overlay:1-4,input:X), overlayOff(overlay:1-4), setText(input:X,text:X), replay(action:X)`,
  videohub: `videohub: route(input:N,output:N), getRoutes(), setInputLabel(index:N,label:X), setOutputLabel(index:N,label:X), getInputLabels(), getOutputLabels()`,
  propresenter: `propresenter: next(), previous(), goToSlide(index:N), status(), playlist(), clearAll(), clearSlide(), stageMessage(name:X), clearMessage(), getLooks(), setLook(name:X), getTimers(), startTimer(name:X), stopTimer(name:X), version(), messages()`,
  resolume: `resolume: playClip(name:X), stopClip(), triggerColumn(column:N), clearAll(), setBpm(bpm:N), getBpm(), setLayerOpacity(layer:N,value:0-1), setMasterOpacity(value:0-1), getLayers(), getColumns(), isRunning(), version(), status(), playClipByName(name:X), triggerColumnByName(name:X)`,
  mixer: `mixer: status(), mute(channel:master|N), unmute(channel:master|N), recallScene(scene:N), saveScene(scene:N,name:X), setFader(channel:N,level:0-1), setChannelName(channel:N,name:X), setHpf(channel:N,enabled:bool,frequency:N), setEq(channel:N,enabled:bool,bands:[...]), setCompressor(channel:N,enabled:bool,threshold:N,ratio:N,attack:N,release:N,knee:N), setGate(channel:N,enabled:bool,threshold:N,range:N,attack:N,hold:N,release:N), setPreampGain(channel:N,gain:N), setPhantom(channel:N,enabled:bool), setPan(channel:N,pan:-1to1), setSendLevel(channel:N,bus:N,level:0-1), assignToBus(channel:N,bus:N,enabled:bool), assignToDca(channel:N,dca:N,enabled:bool), muteDca(dca:N), unmuteDca(dca:N), setDcaFader(dca:N,level:0-1), activateMuteGroup(group:N), deactivateMuteGroup(group:N), pressSoftKey(key:N), clearSolos(), channelStatus(channel:N), getMeters(), capabilities(), setChannelColor(channel:N,color:X), setChannelIcon(channel:N,icon:X)`,
  dante: `dante: scene(name:X)`,
  ecamm: `ecamm: togglePause(), getScenes(), setScene(id:X), nextScene(), prevScene(), toggleMute(), getInputs(), setInput(id:X), togglePIP(), getOverlays()`,
  aja: `aja (AJA HELO): setVideoInput(source:N), setAudioInput(source:N), setStreamProfile(profile:X), setRecordProfile(profile:X), setMute(muted:bool), recallPreset(preset:X)`,
  epiphan: `epiphan (Epiphan Pearl): startPublisher(publisher:X), stopPublisher(publisher:X), getLayouts(), setActiveLayout(layout:X), getStreamingParams(), setStreamingParams(params:X)`,
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

  // ATEM is almost always present
  if (s.atem?.connected) {
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
  if (s.atem?.connected)          sigs.push(CMD_SIGS.camera); // BMD camera control requires ATEM
  if (s.obs?.connected)           sigs.push(CMD_SIGS.obs);
  if (s.encoder?.connected)       sigs.push(CMD_SIGS.encoder);
  if (s.webPresenter?.connected)  sigs.push(CMD_SIGS.webPresenter);
  if (s.companion?.connected)     sigs.push(CMD_SIGS.companion);
  if (s.vmix?.connected)          sigs.push(CMD_SIGS.vmix);
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
  const streamDevices = [s.encoder?.connected, s.obs?.connected, s.vmix?.connected, s.atem?.connected].filter(Boolean);
  const hasMultipleStreamDevices = streamDevices.length > 1;
  const hasMixer = !!s.mixer?.connected;
  const hasAtemAudio = !!s.atem?.connected && !hasMixer;

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

OUTPUT FORMAT — return exactly one of these JSON shapes:
Single: {"type":"command","command":"atem.cut","params":{"input":2}}
Multi: {"type":"commands","steps":[{"command":"...","params":{...}},{"command":"...","params":{...}}]}
Chat: {"type":"chat","text":"..."}

MULTI-STEP: If user asks for >1 action ("then", "and", commas, lists) → MUST return type "commands" with steps array.

WHEN UNSURE — ASK: If ambiguous, return a chat response asking the user to clarify with 2-4 specific options they can say verbatim.

CONFIRM HIGH-IMPACT: fadeToBlack, stopStream, "end service" → ask for confirmation unless user already expressed clear intent or is repeating.

OPERATOR LEVEL: Context "Operator: volunteer|intermediate|pro". volunteer=simple language, pro=concise. Auto-detect if missing.
${atemDetailRules}
PROPRESENTER:
- "Next slide" / "put up the lyrics" / "advance slides" / "next" → propresenter.next()
- "Previous slide" / "go back a slide" → propresenter.previous()
- "Go to slide 5" / "jump to slide X" → propresenter.goToSlide(index:X). Index is 0-based.
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
- Match camera labels from context when available. If user says "camera 1" and labels show 1=Main Cam, use input 1.
- Off-topic → {"type":"chat","text":"I'm only here for production. Try 'help' for what I can do."}
- Use conversation history for "again", "undo that", etc. Up to 50 steps. Batch: "mute 1-8" → one step per channel.
- "we're done"/"that's a wrap" → multi-step: fadeToBlack + stop all streams + stop all recordings on all connected devices.
- Troubleshooting: describe problem → return diagnosis with suggested commands.
- Social phrases (thanks, hi) → friendly reply, NOT off-topic response.
- Volunteer phrases: "are we live?" → status()

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

  // ATEM switcher
  if (ctx.status?.atem?.connected) {
    const s = ctx.status.atem;
    let atemInfo = 'ATEM';
    if (s.model) atemInfo += ` (${s.model})`;
    atemInfo += `: pgm=cam${s.programInput || '?'}, pvw=cam${s.previewInput || '?'}`;
    contextHint += atemInfo + '. ';
    if (s.inputLabels && Object.keys(s.inputLabels).length) {
      const labels = Object.entries(s.inputLabels).map(([k, v]) => `${k}=${v}`).join(', ');
      contextHint += `Labels: ${labels}. `;
    }
    if (s.streaming) contextHint += `ATEM streaming${s.streamingBitrate ? ` ${s.streamingBitrate}kbps` : ''}${s.streamingService ? ` (${s.streamingService})` : ''}. `;
    if (s.recording) contextHint += 'ATEM recording. ';
    // audio_via_atem flag for audio routing
    if (ctx.status.audio_via_atem) contextHint += 'audio_via_atem=true. ';
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
    contextHint += `vMix: ${ctx.status.vmix.streaming ? 'live' : 'idle'}. `;
  }

  // Encoder bridge
  if (ctx.status?.encoder?.connected) {
    const e = ctx.status.encoder;
    let encInfo = `Encoder: ${e.live ? 'live' : 'idle'}`;
    if (e.bitrateKbps) encInfo += `, ${e.bitrateKbps}kbps`;
    contextHint += encInfo + '. ';
  }

  // ProPresenter
  if (ctx.status?.proPresenter?.connected) {
    const pp = ctx.status.proPresenter;
    contextHint += `ProPresenter: slide ${pp.slideIndex != null ? pp.slideIndex + 1 : '?'}/${pp.slideTotal || '?'}. `;
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

  // PTZ cameras
  const ptzConnected = (ctx.status?.ptz || []).filter(c => c.connected);
  if (ptzConnected.length) contextHint += `PTZ: ${ptzConnected.length} camera${ptzConnected.length > 1 ? 's' : ''} connected. `;

  // HyperDecks
  if (ctx.status?.hyperdeck?.connected) {
    contextHint += `HyperDeck: ${ctx.status.hyperdeck.recording ? 'recording' : 'idle'}. `;
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
8. Keep responses conversational — you're their engineer buddy, not a manual\n`;
  }

  const promptTokenEst = Math.round(systemPrompt.length / 4);
  try {
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

module.exports = { aiParseCommand, getAvailableCommandNames, setAiUsageLogger, setIncidentBypassCheck, checkAiRateLimit, buildSystemPrompt };
