/**
 * diagnosticBundle.js — Remote Diagnostic Bundle collector
 * Collects a comprehensive snapshot of the church AV system state
 * for one-click remote troubleshooting.
 */

const path = require('path');
const { getSystemHealth } = require('./systemHealth');

/**
 * Collect a full diagnostic bundle from the running agent.
 * Pulls live data from every connected module so the founder
 * can diagnose an issue without asking 10 questions over Telegram.
 *
 * @param {import('./index').ChurchAVAgent} agent
 * @returns {Promise<Object>} diagnostic bundle
 */
async function collectDiagnosticBundle(agent) {
  // ── System health (CPU / RAM / disk) ────────────────────────────────────────
  let system = {};
  try {
    system = await getSystemHealth();
  } catch (e) {
    system = { error: e.message };
  }

  // ── App version ─────────────────────────────────────────────────────────────
  let appVersion = 'unknown';
  try {
    appVersion = require('../package.json').version;
  } catch { /* not critical */ }

  // ── Connections snapshot ─────────────────────────────────────────────────────
  const connections = {};

  // Relay
  const WebSocket = require('ws');
  connections.relay = {
    connected: agent.relay?.readyState === WebSocket.OPEN,
    lastHeartbeat: agent.health?.relay?.latencyMs != null
      ? Date.now() - (agent.health.relay.latencyMs || 0)
      : null,
    url: agent.config?.relay || null,
  };

  // ATEM
  connections.atem = {
    connected: agent.status?.atem?.connected || false,
    model: agent.status?.atem?.model || null,
    ip: agent.status?.atem?.ip || null,
    programInput: agent.status?.atem?.programInput ?? null,
    previewInput: agent.status?.atem?.previewInput ?? null,
  };

  // OBS
  connections.obs = {
    connected: agent.status?.obs?.connected || false,
    version: agent.status?.obs?.version || null,
    currentScene: null,
    streaming: agent.status?.obs?.streaming || false,
    recording: agent.status?.obs?.recording || false,
    sources: [],
  };
  if (agent.obs && agent.status?.obs?.connected) {
    try {
      const scene = await agent.obs.call('GetCurrentProgramScene');
      connections.obs.currentScene = scene?.currentProgramSceneName || null;
    } catch { /* non-critical */ }
    try {
      const list = await agent.obs.call('GetSceneList');
      connections.obs.sources = (list?.scenes || []).map(s => s.sceneName);
    } catch { /* non-critical */ }
  }

  // vMix
  connections.vmix = {
    connected: agent.status?.vmix?.connected || false,
  };

  // Companion
  connections.companion = {
    connected: agent.status?.companion?.connected || false,
    host: agent.config?.companionUrl || null,
  };

  // Encoders
  connections.encoders = [];
  if (agent.encoderBridge) {
    connections.encoders.push({
      name: agent.status?.encoder?.type || agent.config?.encoder?.type || 'primary',
      connected: agent.status?.encoder?.connected || false,
      streaming: agent.status?.encoder?.live || agent.status?.encoder?.streaming || false,
      bitrate: agent.status?.encoder?.bitrateKbps || null,
    });
  }

  // Mixers
  connections.mixers = [];
  if (agent.mixer) {
    connections.mixers.push({
      name: agent.config?.mixer?.model || 'mixer',
      connected: agent.status?.mixer?.connected || false,
      type: agent.status?.mixer?.type || agent.config?.mixer?.type || null,
    });
  }

  // PTZ
  connections.ptz = [];
  if (Array.isArray(agent.status?.ptz)) {
    connections.ptz = agent.status.ptz.map((cam, i) => ({
      name: cam?.name || `PTZ ${i + 1}`,
      connected: cam?.connected || false,
    }));
  }

  // HyperDecks
  connections.hyperdeck = [];
  if (Array.isArray(agent.hyperdecks)) {
    connections.hyperdeck = agent.hyperdecks.map((deck, i) => {
      const s = typeof deck?.getStatus === 'function' ? deck.getStatus() : {};
      return {
        name: s.name || `HyperDeck ${i + 1}`,
        connected: s.connected || false,
        recording: s.recording || false,
        diskSpace: s.diskSpace ?? s.remainingDiskSpace ?? null,
      };
    });
  }

  // ── Stream status ───────────────────────────────────────────────────────────
  const isStreaming = agent.status?.obs?.streaming
    || agent.status?.atem?.streaming
    || agent.status?.encoder?.live
    || agent.status?.encoder?.streaming
    || false;

  const bitrateInfo = typeof agent._getStreamBitrate === 'function' ? agent._getStreamBitrate() : null;
  const fpsInfo = typeof agent._getStreamFps === 'function' ? agent._getStreamFps() : null;

  const shStatus = agent.streamHealthMonitor?.getStatus?.() || {};

  // Use StreamHealthMonitor's quality tier from getStatus() if available
  let qualityTier = shStatus.qualityTier || null;
  if (!qualityTier && bitrateInfo) {
    // Fallback: use getStreamQualityTier if the monitor exposes it
    if (typeof agent.streamHealthMonitor?.getStreamQualityTier === 'function') {
      const result = agent.streamHealthMonitor.getStreamQualityTier(
        (bitrateInfo.value || 0) * 1000, // convert kbps to bps
        agent.status?.encoder?.resolution || null,
        fpsInfo?.value || null,
        agent.status?.encoder?.congestion || null
      );
      qualityTier = result?.tier || null;
    } else {
      // Simple bitrate-only classification when no monitor is available
      const kbps = bitrateInfo.value;
      if (kbps >= 4000) qualityTier = 'good';
      else if (kbps >= 2000) qualityTier = 'fair';
      else qualityTier = 'poor';
    }
  }

  const stream = {
    active: isStreaming,
    platform: agent.status?.encoder?.type || (agent.status?.obs?.streaming ? 'OBS' : null),
    bitrate: bitrateInfo?.value || null,
    fps: fpsInfo?.value || null,
    resolution: agent.status?.encoder?.resolution || null,
    qualityTier,
    dropRate: agent.status?.encoder?.congestion || null,
    qualityScore: shStatus.qualityScore || null,
    recentQualityHistory: shStatus.tierHistory || 0,
  };

  // ── Alerts ──────────────────────────────────────────────────────────────────
  const alerts = Array.isArray(agent._recentAlerts) ? [...agent._recentAlerts] : [];

  // ── Problem Finder ──────────────────────────────────────────────────────────
  const problemFinder = agent._lastProblemFinderResult || {};

  // ── Config summary (no secrets) ─────────────────────────────────────────────
  const config = {
    churchId: agent.churchId || null,
    configuredDevices: Object.keys(agent.config || {}).filter(k =>
      !['token', 'obsPassword', 'youtubeApiKey', 'facebookAccessToken', 'rtmpKey'].includes(k)
    ),
    autoRecoveryEnabled: agent.config?.autoRecovery !== false,
  };

  // ── Recent commands ─────────────────────────────────────────────────────────
  const recentCommands = Array.isArray(agent._recentCommands)
    ? agent._recentCommands.slice(-10)
    : [];

  return {
    timestamp: Date.now(),
    appVersion,
    platform: {
      os: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
    },
    system,
    connections,
    stream,
    alerts,
    problemFinder,
    config,
    recentCommands,
  };
}

module.exports = { collectDiagnosticBundle };
