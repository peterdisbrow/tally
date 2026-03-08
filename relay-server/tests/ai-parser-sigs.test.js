import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildSystemPrompt } = require('../src/ai-parser.js');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ATEM_STATUS = { atem: { connected: true } };
const ATEM_WITH_MIXER = { atem: { connected: true }, mixer: { connected: true } };
const NO_DEVICES = {};
const ALL_DEVICES = {
  atem: { connected: true },
  obs: { connected: true },
  encoder: { connected: true },
  vmix: { connected: true },
  hyperdeck: { connected: true },
  mixer: { connected: true },
};

// ─── Prompt includes all ATEM command categories ─────────────────────────────

describe('buildSystemPrompt includes ATEM command signatures', () => {
  const prompt = buildSystemPrompt(ATEM_STATUS);

  it('includes core switching commands', () => {
    expect(prompt).toContain('cut(input:N)');
    expect(prompt).toContain('setPreview(input:N)');
    expect(prompt).toContain('auto()');
    expect(prompt).toContain('fadeToBlack()');
    expect(prompt).toContain('setProgram(input:N)');
    expect(prompt).toContain('setAux(aux:N,input:N)');
    expect(prompt).toContain('setTransitionStyle(style:mix|dip|wipe|dve|stinger)');
    expect(prompt).toContain('setTransitionRate(rate:N)');
    expect(prompt).toContain('setInputLabel(input:N,longName:X)');
    expect(prompt).toContain('listVisibleInputs()');
  });

  it('includes DSK commands', () => {
    expect(prompt).toContain('setDskOnAir(keyer:N,onAir:bool)');
    expect(prompt).toContain('setDskTie(keyer:N,tie:bool)');
    expect(prompt).toContain('setDskRate(keyer:N,rate:N)');
    expect(prompt).toContain('setDskSource(keyer:N,fillSource:N,keySource:N)');
    expect(prompt).toContain('autoDsk(keyer:N)');
  });

  it('includes upstream keyer commands', () => {
    expect(prompt).toContain('setUskOnAir(keyer:N,onAir:bool)');
    expect(prompt).toContain('setUskFillSource(keyer:N,fillSource:N)');
    expect(prompt).toContain('setUskCutSource(keyer:N,cutSource:N)');
    expect(prompt).toContain('setUskType(keyer:N,mixEffectKeyType:N,flyEnabled:bool)');
    expect(prompt).toContain('setUskLumaSettings');
    expect(prompt).toContain('setUskChromaSettings');
    expect(prompt).toContain('setUskDVESettings');
    expect(prompt).toContain('setUskPatternSettings');
    expect(prompt).toContain('runUskFlyKeyTo');
  });

  it('includes SuperSource commands', () => {
    expect(prompt).toContain('setSuperSourceBoxSettings');
    expect(prompt).toContain('setSuperSourceProperties');
    expect(prompt).toContain('setSuperSourceBorder');
  });

  it('includes multiviewer commands', () => {
    expect(prompt).toContain('setMultiViewerWindowSource');
    expect(prompt).toContain('setMultiViewerWindowVuEnabled');
    expect(prompt).toContain('setMultiViewerProperties');
  });

  it('includes transition setting commands', () => {
    expect(prompt).toContain('setDipTransitionSettings');
    expect(prompt).toContain('setWipeTransitionSettings');
    expect(prompt).toContain('setDVETransitionSettings');
    expect(prompt).toContain('setStingerTransitionSettings');
  });

  it('includes streaming and recording commands', () => {
    expect(prompt).toContain('startRecording()');
    expect(prompt).toContain('stopRecording()');
    expect(prompt).toContain('startStreaming()');
    expect(prompt).toContain('stopStreaming()');
    expect(prompt).toContain('requestStreamingDuration()');
    expect(prompt).toContain('requestRecordingDuration()');
  });

  it('includes macro commands', () => {
    expect(prompt).toContain('runMacro(macroIndex:N)');
    expect(prompt).toContain('stopMacro()');
    expect(prompt).toContain('macroContinue()');
    expect(prompt).toContain('macroSetLoop');
  });

  it('includes media commands', () => {
    expect(prompt).toContain('uploadStill');
    expect(prompt).toContain('setMediaPlayer');
    expect(prompt).toContain('captureStill()');
    expect(prompt).toContain('clearStill(index:N)');
  });

  it('includes camera control commands', () => {
    expect(prompt).toContain('setIris(camera:N,value:0-1)');
    expect(prompt).toContain('autoIris(camera:N)');
    expect(prompt).toContain('setGain(camera:N,gain:N)');
    expect(prompt).toContain('setISO(camera:N,iso:N)');
    expect(prompt).toContain('setWhiteBalance(camera:N,kelvin:N,tint:N)');
    expect(prompt).toContain('setShutter(camera:N,speed:N)');
    expect(prompt).toContain('setFocus(camera:N,value:0-1)');
    expect(prompt).toContain('autoFocus(camera:N)');
    expect(prompt).toContain('setLift(camera:N');
    expect(prompt).toContain('setGamma(camera:N');
    expect(prompt).toContain('setColorGain(camera:N');
    expect(prompt).toContain('setContrast(camera:N');
    expect(prompt).toContain('setSaturation(camera:N');
    expect(prompt).toContain('resetColorCorrection(camera:N)');
  });

  it('includes always-present commands', () => {
    expect(prompt).toContain('preset: save(name:X)');
    expect(prompt).toContain('preview: snap()');
    expect(prompt).toContain('system.preServiceCheck()');
    expect(prompt).toContain('wait(seconds:N)');
  });
});

// ─── Classic audio signature annotations (headphone mute fix) ────────────────

describe('Classic audio signature annotations', () => {
  const prompt = buildSystemPrompt(ATEM_STATUS);

  it('includes classic audio section', () => {
    expect(prompt).toContain('Classic audio');
    expect(prompt).toContain('ATEM Mini');
  });

  it('setClassicAudioMonitorProps has mute annotation', () => {
    expect(prompt).toContain('setClassicAudioMonitorProps(enabled:bool,gain:N,mute:bool,solo:bool,soloInput:N,dim:bool)');
    expect(prompt).toContain('use mute:true/false to mute/unmute headphone or monitor output');
  });

  it('setClassicAudioHeadphonesProps has no-mute annotation', () => {
    expect(prompt).toContain('setClassicAudioHeadphonesProps(gain:N,programOutGain:N,sidetoneGain:N,talkbackGain:N)');
    expect(prompt).toContain('gain adjustment only (no mute here)');
  });

  it('setClassicAudioResetPeaks has never-for-unmute annotation', () => {
    expect(prompt).toContain('resets peak meters only (never use for unmute)');
  });

  it('includes all classic audio input/master commands', () => {
    expect(prompt).toContain('setClassicAudioInputProps(index:N,mixOption:N,gain:N,balance:N)');
    expect(prompt).toContain('setClassicAudioMasterProps(gain:N,balance:N,followFadeToBlack:bool)');
  });
});

// ─── Fairlight audio signatures ──────────────────────────────────────────────

describe('Fairlight audio signatures', () => {
  const prompt = buildSystemPrompt(ATEM_STATUS);

  it('includes Fairlight source-level commands', () => {
    expect(prompt).toContain('setFairlightAudioSourceProps(index:N,source:N,faderGain:N');
    expect(prompt).toContain('setFairlightAudioSourceCompressorProps');
    expect(prompt).toContain('setFairlightAudioSourceLimiterProps');
    expect(prompt).toContain('setFairlightAudioSourceExpanderProps');
    expect(prompt).toContain('setFairlightAudioSourceEqBandProps');
  });

  it('includes Fairlight master commands', () => {
    expect(prompt).toContain('setFairlightAudioMasterProps(faderGain:N');
    expect(prompt).toContain('setFairlightAudioMasterCompressorProps');
    expect(prompt).toContain('setFairlightAudioMasterLimiterProps');
    expect(prompt).toContain('setFairlightAudioMasterEqBandProps');
    expect(prompt).toContain('setFairlightAudioMasterEqReset');
    expect(prompt).toContain('setFairlightAudioMasterDynamicsReset');
  });

  it('includes Fairlight monitor commands', () => {
    expect(prompt).toContain('setFairlightAudioMonitorProps');
    expect(prompt).toContain('setFairlightAudioMonitorSolo');
    expect(prompt).toContain('setFairlightAudioResetPeaks');
  });
});

// ─── Audio rules in the prompt ───────────────────────────────────────────────

describe('Audio rules in prompt', () => {
  it('ATEM-only: prompt has classic audio mute guidance', () => {
    const prompt = buildSystemPrompt(ATEM_STATUS);
    expect(prompt).toContain('Classic audio mute/unmute');
    expect(prompt).toContain('setClassicAudioMonitorProps(mute:true)');
    expect(prompt).toContain('setClassicAudioMonitorProps(mute:false)');
    expect(prompt).toContain('Never use setClassicAudioHeadphonesProps');
    expect(prompt).toContain('never use for unmute');
  });

  it('ATEM-only: prompt has Fairlight audio guidance', () => {
    const prompt = buildSystemPrompt(ATEM_STATUS);
    expect(prompt).toContain('faderGain in hundredths of dB');
    expect(prompt).toContain('-10000=-inf');
  });

  it('with mixer: prompt says to use mixer.* for audio', () => {
    const prompt = buildSystemPrompt(ATEM_WITH_MIXER);
    expect(prompt).toContain('External mixer is connected');
    expect(prompt).toContain('use mixer.* commands for audio');
  });

  it('with mixer: still includes ATEM audio sigs for "on the atem" override', () => {
    const prompt = buildSystemPrompt(ATEM_WITH_MIXER);
    expect(prompt).toContain('setClassicAudioMonitorProps');
    expect(prompt).toContain('setFairlightAudioSourceProps');
  });
});

// ─── Device-conditional inclusion ────────────────────────────────────────────

describe('Device-conditional command inclusion', () => {
  it('no devices → includes all signatures as fallback', () => {
    const prompt = buildSystemPrompt(NO_DEVICES);
    expect(prompt).toContain('cut(input:N)');
    expect(prompt).toContain('setFairlightAudioSourceProps');
    expect(prompt).toContain('setClassicAudioMonitorProps');
  });

  it('OBS-only → includes OBS but not ATEM-specific sigs', () => {
    const prompt = buildSystemPrompt({ obs: { connected: true } });
    expect(prompt).toContain('startStream()');
    expect(prompt).toContain('setScene(scene:X)');
    // Should NOT include ATEM commands
    expect(prompt).not.toContain('setUskOnAir');
    expect(prompt).not.toContain('setClassicAudioMonitorProps');
  });

  it('ATEM → includes all ATEM sub-categories', () => {
    const prompt = buildSystemPrompt(ATEM_STATUS);
    expect(prompt).toContain('Upstream Keyers');
    expect(prompt).toContain('SuperSource');
    expect(prompt).toContain('Multiviewer');
    expect(prompt).toContain('Transitions');
    expect(prompt).toContain('Classic audio');
    expect(prompt).toContain('Fairlight audio');
  });

  it('encoder → includes all encoder commands', () => {
    const prompt = buildSystemPrompt({ encoder: { connected: true } });
    expect(prompt).toContain('encoder: startStream()');
    expect(prompt).toContain('stopStream()');
    expect(prompt).toContain('startRecording()');
    expect(prompt).toContain('stopRecording()');
    expect(prompt).toContain('status()');
  });

  it('webPresenter → includes blackmagic Web Presenter commands', () => {
    const prompt = buildSystemPrompt({ webPresenter: { connected: true } });
    expect(prompt).toContain('blackmagic (Web Presenter)');
    expect(prompt).toContain('getActivePlatform()');
    expect(prompt).toContain('setActivePlatform(platform:X,server:X,key:X,quality:X)');
    expect(prompt).toContain('getPlatforms()');
    expect(prompt).toContain('getPlatformConfig(name:X)');
    expect(prompt).toContain('getVideoFormat()');
    expect(prompt).toContain('setVideoFormat(format:X)');
    expect(prompt).toContain('getSupportedVideoFormats()');
    expect(prompt).toContain('getAudioSources()');
    expect(prompt).toContain('setAudioSource(source:X)');
  });

  it('webPresenter only → does NOT include ATEM-specific command sigs', () => {
    const prompt = buildSystemPrompt({ webPresenter: { connected: true } });
    expect(prompt).not.toContain('setUskOnAir');
    expect(prompt).not.toContain('setClassicAudioMonitorProps');
    // fadeToBlack may appear in rules text, but ATEM switching sigs should be absent
    expect(prompt).not.toContain('cut(input:N)');
    expect(prompt).not.toContain('setPreview(input:N)');
  });

  it('encoder only → does NOT include blackmagic sigs', () => {
    const prompt = buildSystemPrompt({ encoder: { connected: true } });
    expect(prompt).not.toContain('getActivePlatform');
    expect(prompt).not.toContain('blackmagic (Web Presenter)');
  });

  it('encoder + webPresenter → includes both generic and blackmagic sigs', () => {
    const prompt = buildSystemPrompt({ encoder: { connected: true }, webPresenter: { connected: true } });
    expect(prompt).toContain('encoder: startStream()');
    expect(prompt).toContain('blackmagic (Web Presenter)');
    expect(prompt).toContain('getActivePlatform()');
  });

  it('mixer → includes mixer commands', () => {
    const prompt = buildSystemPrompt({ mixer: { connected: true } });
    expect(prompt).toContain('mixer: status()');
    expect(prompt).toContain('mute(channel:master|N)');
  });

  it('hyperdeck → includes hyperdeck commands', () => {
    const prompt = buildSystemPrompt({ hyperdeck: { connected: true } });
    expect(prompt).toContain('hyperdeck: play(hyperdeck:N)');
    expect(prompt).toContain('record(hyperdeck:N)');
    expect(prompt).toContain('stop(hyperdeck:N)');
    expect(prompt).toContain('stopRecord(hyperdeck:N)');
    expect(prompt).toContain('nextClip(hyperdeck:N)');
    expect(prompt).toContain('prevClip(hyperdeck:N)');
    expect(prompt).toContain('selectSlot(hyperdeck:N,slot:N)');
    expect(prompt).toContain('setPlaySpeed(hyperdeck:N,speed:N)');
    expect(prompt).toContain('goToClip(hyperdeck:N,clip:N)');
    expect(prompt).toContain('goToTimecode(hyperdeck:N,timecode:X)');
    expect(prompt).toContain('jog(hyperdeck:N,timecode:X)');
  });

  // ── OBS ──
  it('OBS → includes all OBS commands', () => {
    const prompt = buildSystemPrompt({ obs: { connected: true } });
    expect(prompt).toContain('obs: startStream()');
    expect(prompt).toContain('stopStream()');
    expect(prompt).toContain('startRecording()');
    expect(prompt).toContain('stopRecording()');
    expect(prompt).toContain('pauseRecording()');
    expect(prompt).toContain('resumeRecording()');
    expect(prompt).toContain('setScene(scene:X)');
    expect(prompt).toContain('getScenes()');
    expect(prompt).toContain('getInputList()');
    expect(prompt).toContain('setInputVolume(input:X,volume:0-1)');
    expect(prompt).toContain('setInputMute(input:X,muted:bool)');
    expect(prompt).toContain('setTransition(transition:X)');
    expect(prompt).toContain('setTransitionDuration(duration:N)');
    expect(prompt).toContain('getSourceFilters(source:X)');
    expect(prompt).toContain('setSourceFilterEnabled(source:X,filter:X,enabled:bool)');
    expect(prompt).toContain('setStudioMode(enabled:bool)');
    expect(prompt).toContain('setPreviewScene(scene:X)');
    expect(prompt).toContain('toggleVirtualCam()');
    expect(prompt).toContain('getSceneItems(scene:X)');
    expect(prompt).toContain('setSceneItemEnabled(scene:X,itemId:N,enabled:bool)');
    expect(prompt).toContain('reduceBitrate()');
    expect(prompt).toContain('configureMonitorStream()');
  });

  it('OBS only → does NOT include ATEM-specific sigs', () => {
    const prompt = buildSystemPrompt({ obs: { connected: true } });
    expect(prompt).not.toContain('setUskOnAir');
    expect(prompt).not.toContain('setSuperSourceBoxSettings');
    expect(prompt).not.toContain('setClassicAudioMonitorProps');
  });

  // ── vMix ──
  it('vMix → includes all vMix commands', () => {
    const prompt = buildSystemPrompt({ vmix: { connected: true } });
    expect(prompt).toContain('vmix: startStream()');
    expect(prompt).toContain('stopStream()');
    expect(prompt).toContain('startRecording()');
    expect(prompt).toContain('stopRecording()');
    expect(prompt).toContain('cut()');
    expect(prompt).toContain('fade(ms:N)');
    expect(prompt).toContain('setPreview(input:N)');
    expect(prompt).toContain('setProgram(input:N)');
    expect(prompt).toContain('setVolume(value:N)');
    expect(prompt).toContain('mute()');
    expect(prompt).toContain('unmute()');
    expect(prompt).toContain('function(function:X,input:X)');
    expect(prompt).toContain('listInputs()');
    expect(prompt).toContain('isRunning()');
    expect(prompt).toContain('startPlaylist()');
    expect(prompt).toContain('stopPlaylist()');
    expect(prompt).toContain('audioLevels()');
    expect(prompt).toContain('setInputVolume(input:X,volume:0-100)');
    expect(prompt).toContain('muteInput(input:X)');
    expect(prompt).toContain('unmuteInput(input:X)');
    expect(prompt).toContain('overlayInput(overlay:1-4,input:X)');
    expect(prompt).toContain('overlayOff(overlay:1-4)');
    expect(prompt).toContain('setText(input:X,text:X)');
    expect(prompt).toContain('replay(action:X)');
  });

  // ── PTZ ──
  it('PTZ → includes all PTZ commands', () => {
    const prompt = buildSystemPrompt({ ptz: [{ connected: true }] });
    expect(prompt).toContain('ptz: pan(camera:N,speed:-1to1)');
    expect(prompt).toContain('tilt(camera:N,speed:-1to1)');
    expect(prompt).toContain('zoom(camera:N,speed:-1to1)');
    expect(prompt).toContain('preset(camera:N,preset:N)');
    expect(prompt).toContain('setPreset(camera:N,preset:N)');
    expect(prompt).toContain('stop(camera:N)');
    expect(prompt).toContain('home(camera:N)');
    expect(prompt).toContain('autoFocus(camera:N)');
    expect(prompt).toContain('manualFocus(camera:N)');
    expect(prompt).toContain('focusNear(camera:N,speed:0-7)');
    expect(prompt).toContain('focusFar(camera:N,speed:0-7)');
    expect(prompt).toContain('focusStop(camera:N)');
    expect(prompt).toContain('backlightComp(camera:N,enabled:bool)');
  });

  it('PTZ uses array status flag', () => {
    // No PTZ connected → no ptz sigs (unless fallback kicks in)
    const promptWithObs = buildSystemPrompt({ obs: { connected: true } });
    expect(promptWithObs).not.toContain('ptz: pan');
    // PTZ connected via array
    const promptWithPtz = buildSystemPrompt({ obs: { connected: true }, ptz: [{ connected: true }] });
    expect(promptWithPtz).toContain('ptz: pan');
  });

  // ── ProPresenter ──
  it('ProPresenter → includes all ProPresenter commands', () => {
    const prompt = buildSystemPrompt({ proPresenter: { connected: true } });
    expect(prompt).toContain('propresenter: next()');
    expect(prompt).toContain('previous()');
    expect(prompt).toContain('goToSlide(index:N)');
    expect(prompt).toContain('clearAll()');
    expect(prompt).toContain('clearSlide()');
    expect(prompt).toContain('stageMessage(name:X)');
    expect(prompt).toContain('clearMessage()');
    expect(prompt).toContain('getLooks()');
    expect(prompt).toContain('setLook(name:X)');
    expect(prompt).toContain('getTimers()');
    expect(prompt).toContain('startTimer(name:X)');
    expect(prompt).toContain('stopTimer(name:X)');
    expect(prompt).toContain('version()');
    expect(prompt).toContain('messages()');
  });

  it('ProPresenter status flag is camelCase proPresenter', () => {
    // lowercase propresenter should NOT trigger
    const prompt = buildSystemPrompt({ obs: { connected: true }, propresenter: { connected: true } });
    expect(prompt).not.toContain('propresenter: next()');
    // camelCase SHOULD trigger
    const prompt2 = buildSystemPrompt({ obs: { connected: true }, proPresenter: { connected: true } });
    expect(prompt2).toContain('propresenter: next()');
  });

  // ── Resolume ──
  it('Resolume → includes all Resolume commands', () => {
    const prompt = buildSystemPrompt({ resolume: { connected: true } });
    expect(prompt).toContain('resolume: playClip(name:X)');
    expect(prompt).toContain('stopClip()');
    expect(prompt).toContain('triggerColumn(column:N)');
    expect(prompt).toContain('clearAll()');
    expect(prompt).toContain('setBpm(bpm:N)');
    expect(prompt).toContain('getBpm()');
    expect(prompt).toContain('setLayerOpacity(layer:N,value:0-1)');
    expect(prompt).toContain('setMasterOpacity(value:0-1)');
    expect(prompt).toContain('getLayers()');
    expect(prompt).toContain('getColumns()');
    expect(prompt).toContain('playClipByName(name:X)');
    expect(prompt).toContain('triggerColumnByName(name:X)');
  });

  // ── Videohub ──
  it('Videohub → includes all Videohub commands', () => {
    const prompt = buildSystemPrompt({ videohub: { connected: true } });
    expect(prompt).toContain('videohub: route(input:N,output:N)');
    expect(prompt).toContain('getRoutes()');
    expect(prompt).toContain('setInputLabel(index:N,label:X)');
    expect(prompt).toContain('setOutputLabel(index:N,label:X)');
    expect(prompt).toContain('getInputLabels()');
    expect(prompt).toContain('getOutputLabels()');
  });

  // ── Companion ──
  it('Companion → includes all Companion commands', () => {
    const prompt = buildSystemPrompt({ companion: { connected: true } });
    expect(prompt).toContain('companion: pressNamed(name:X)');
    expect(prompt).toContain('press(page:N,row:N,col:N)');
    expect(prompt).toContain('getGrid()');
    expect(prompt).toContain('connections()');
  });

  // ── Dante ──
  it('Dante → includes Dante scene command', () => {
    const prompt = buildSystemPrompt({ dante: { connected: true } });
    expect(prompt).toContain('dante: scene(name:X)');
  });

  // ── AJA HELO ──
  it('AJA → includes all AJA commands', () => {
    const prompt = buildSystemPrompt({ aja: { connected: true } });
    expect(prompt).toContain('aja (AJA HELO)');
    expect(prompt).toContain('setVideoInput(source:N)');
    expect(prompt).toContain('setAudioInput(source:N)');
    expect(prompt).toContain('setStreamProfile(profile:X)');
    expect(prompt).toContain('setRecordProfile(profile:X)');
    expect(prompt).toContain('setMute(muted:bool)');
    expect(prompt).toContain('recallPreset(preset:X)');
  });

  // ── Epiphan Pearl ──
  it('Epiphan → includes all Epiphan commands', () => {
    const prompt = buildSystemPrompt({ epiphan: { connected: true } });
    expect(prompt).toContain('epiphan (Epiphan Pearl)');
    expect(prompt).toContain('startPublisher(publisher:X)');
    expect(prompt).toContain('stopPublisher(publisher:X)');
    expect(prompt).toContain('getLayouts()');
    expect(prompt).toContain('setActiveLayout(layout:X)');
    expect(prompt).toContain('getStreamingParams()');
    expect(prompt).toContain('setStreamingParams(params:X)');
  });

  // ── Ecamm Live ──
  it('Ecamm → includes all Ecamm commands', () => {
    const prompt = buildSystemPrompt({ ecamm: { connected: true } });
    expect(prompt).toContain('ecamm: togglePause()');
    expect(prompt).toContain('getScenes()');
    expect(prompt).toContain('setScene(id:X)');
    expect(prompt).toContain('nextScene()');
    expect(prompt).toContain('prevScene()');
    expect(prompt).toContain('toggleMute()');
    expect(prompt).toContain('getInputs()');
    expect(prompt).toContain('setInput(id:X)');
    expect(prompt).toContain('togglePIP()');
    expect(prompt).toContain('getOverlays()');
  });

  // ── NDI ──
  it('NDI → includes all NDI commands', () => {
    const prompt = buildSystemPrompt({ ndi: { connected: true } });
    expect(prompt).toContain('ndi: getSource()');
    expect(prompt).toContain('setSource(source:X)');
  });

  // ── Cross-exclusion: each device only shows its own sigs ──
  it('vMix only → does NOT include OBS or ATEM sigs', () => {
    const prompt = buildSystemPrompt({ vmix: { connected: true } });
    expect(prompt).not.toContain('obs: startStream');
    expect(prompt).not.toContain('setUskOnAir');
    expect(prompt).not.toContain('encoder: startStream');
  });

  it('Resolume only → does NOT include ProPresenter sigs', () => {
    const prompt = buildSystemPrompt({ resolume: { connected: true } });
    expect(prompt).not.toContain('propresenter: next');
    expect(prompt).not.toContain('hyperdeck: play');
  });

  it('camera sigs require ATEM (not standalone)', () => {
    // camera control is via ATEM, not a separate device
    const promptNoAtem = buildSystemPrompt({ obs: { connected: true } });
    expect(promptNoAtem).not.toContain('camera: setIris');
    const promptWithAtem = buildSystemPrompt({ atem: { connected: true } });
    expect(promptWithAtem).toContain('camera: setIris');
  });
});

// ─── Prompt format ───────────────────────────────────────────────────────────

describe('Prompt format', () => {
  const prompt = buildSystemPrompt(ATEM_STATUS);

  it('starts with parsing instructions', () => {
    expect(prompt).toContain('You parse natural language into JSON commands');
  });

  it('includes output format specification', () => {
    expect(prompt).toContain('OUTPUT FORMAT');
    expect(prompt).toContain('"type":"command"');
  });

  it('includes AVAILABLE COMMANDS header', () => {
    expect(prompt).toContain('AVAILABLE COMMANDS');
  });

  it('is a non-empty string', () => {
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(500);
  });
});
