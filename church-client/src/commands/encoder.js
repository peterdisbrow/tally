const { toInt } = require('./helpers');

function ensureEncoderBridge(agent) {
  if (!agent.encoderBridge) throw new Error('Encoder not configured');
  return agent.encoderBridge;
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

async function encoderStartStream(agent) {
  const bridge = ensureEncoderBridge(agent);
  // ATEM Mini's built-in encoder uses ATEM protocol, not generic encoder API
  if (bridge.type === 'atem-streaming') {
    if (typeof agent.atem?.startStreaming === 'function') {
      await agent.atem.startStreaming();
      return 'ATEM streaming started';
    }
    throw new Error('ATEM streaming start is not supported by this switcher');
  }
  const result = await bridge.startStream();
  if (result == null) throw new Error(`Encoder "${agent.status.encoder?.type || 'unknown'}" does not support remote stream start`);
  return 'Encoder stream started';
}

async function encoderStopStream(agent) {
  const bridge = ensureEncoderBridge(agent);
  // ATEM Mini's built-in encoder uses ATEM protocol, not generic encoder API
  if (bridge.type === 'atem-streaming') {
    if (typeof agent.atem?.stopStreaming === 'function') {
      await agent.atem.stopStreaming();
      return 'ATEM streaming stopped';
    }
    throw new Error('ATEM streaming stop is not supported by this switcher');
  }
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

async function encoderStatus(agent) {
  if (!agent.encoderBridge) return agent.status.encoder;
  try {
    const latest = await agent.encoderBridge.getStatus();
    agent.status.encoder = Object.assign(agent.status.encoder || {}, latest);
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
  // Accept either params.config (object) or individual fields (platform, server, key, quality)
  const config = params.config || {};
  if (!params.config) {
    // AI may send individual params — assemble into config object
    if (params.platform) config.platform = params.platform;
    if (params.server) config.server = params.server;
    if (params.key) config.key = params.key;
    if (params.quality) config.quality = params.quality;
    if (params.url) config.url = params.url;
  }
  if (!Object.keys(config).length) throw new Error('config object or individual params (platform, server, key, quality) required');
  const result = await adapter.setActivePlatform(config);
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

// ─── OBS STREAMING CONFIG COMMANDS ─────────────────────────────────────────

async function obsGetStreamServiceSettings(agent) {
  const adapter = ensureEncoderAdapter(agent, 'obs');
  const settings = await adapter.getStreamServiceSettings();
  if (!settings) return 'Stream service settings not available';
  return settings;
}

async function obsSetStreamServiceSettings(agent, params) {
  const adapter = ensureEncoderAdapter(agent, 'obs');
  const config = params.config || {};
  if (!params.config) {
    if (params.server) config.server = params.server;
    if (params.key) config.key = params.key;
    if (params.type) config.type = params.type;
    if (params.url) config.server = params.url; // url alias for server
  }
  if (!Object.keys(config).length) throw new Error('config object or individual params (server, key, type) required');
  const result = await adapter.setStreamServiceSettings(config);
  if (!result.ok) throw new Error('Failed to set OBS stream service settings');
  return 'OBS stream service settings updated';
}

// ─── VMIX STREAMING CONFIG COMMANDS ────────────────────────────────────────

async function vmixGetStreamingConfig(agent, params) {
  const adapter = ensureEncoderAdapter(agent, 'vmix');
  const channel = toInt(params?.channel ?? 0, 'channel');
  const config = await adapter.getStreamingConfig(channel);
  if (!config) return 'Streaming config not available';
  return config;
}

async function vmixSetStreamingConfig(agent, params) {
  const adapter = ensureEncoderAdapter(agent, 'vmix');
  const channel = toInt(params?.channel ?? 0, 'channel');
  const server = params.server || params.url || null;
  const key = params.key || null;
  if (!server && !key) throw new Error('server/url and/or key required');
  const results = [];
  if (server) {
    await adapter.setStreamingUrl(server, channel);
    results.push('URL');
  }
  if (key) {
    await adapter.setStreamingKey(key, channel);
    results.push('key');
  }
  return `vMix streaming ${results.join(' and ')} updated`;
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

module.exports = {
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

  // OBS streaming config
  'obs.getStreamServiceSettings': obsGetStreamServiceSettings,
  'obs.setStreamServiceSettings': obsSetStreamServiceSettings,

  // vMix streaming config
  'vmix.getStreamingConfig': vmixGetStreamingConfig,
  'vmix.setStreamingConfig': vmixSetStreamingConfig,

  // NDI
  'ndi.getSource': ndiGetSource,
  'ndi.setSource': ndiSetSource,
};
