'use strict';

function toBool(value) {
  return value === true;
}

function getHyperDeckList(status = {}) {
  if (Array.isArray(status.hyperdecks)) return status.hyperdecks;
  if (Array.isArray(status.hyperdeck?.decks)) return status.hyperdeck.decks;
  if (Array.isArray(status.hyperDecks)) return status.hyperDecks;
  return [];
}

function isHyperDeckRecording(status = {}) {
  if (toBool(status.hyperdeck?.recording) || toBool(status.hyperDeck?.recording)) return true;
  const decks = getHyperDeckList(status);
  return decks.some((deck) => {
    if (!deck || typeof deck !== 'object') return false;
    if (toBool(deck.recording)) return true;
    const state = String(deck.status || deck.transport || '').trim().toLowerCase();
    return state === 'record' || state === 'recording';
  });
}

function hasStreamSignal(status = {}) {
  return (
    typeof status.obs?.streaming === 'boolean' ||
    typeof status.vmix?.streaming === 'boolean' ||
    typeof status.atem?.streaming === 'boolean' ||
    typeof status.encoder?.live === 'boolean' ||
    typeof status.encoder?.streaming === 'boolean'
  );
}

function isStreamActive(status = {}) {
  return (
    toBool(status.obs?.streaming) ||
    toBool(status.vmix?.streaming) ||
    toBool(status.atem?.streaming) ||
    toBool(status.encoder?.live) ||
    toBool(status.encoder?.streaming)
  );
}

/**
 * Get the current streaming bitrate from whatever source is active.
 * Returns { bitrateKbps, source } or null if no bitrate available.
 */
function getStreamBitrate(status = {}) {
  if (status.obs?.streaming && status.obs.bitrate > 0)
    return { bitrateKbps: status.obs.bitrate, source: 'obs' };
  if (status.atem?.streaming && status.atem.streamingBitrate > 0)
    return { bitrateKbps: Math.round(status.atem.streamingBitrate / 1000), source: 'atem' };
  if ((status.encoder?.live || status.encoder?.streaming) && status.encoder.bitrateKbps > 0)
    return { bitrateKbps: status.encoder.bitrateKbps, source: status.encoder.type || 'encoder' };
  return null;
}

/**
 * Get the current streaming FPS from whatever source is active.
 * Returns { fps, source } or null if no FPS available.
 */
function getStreamFps(status = {}) {
  if (status.obs?.streaming && status.obs.fps > 0)
    return { fps: status.obs.fps, source: 'obs' };
  if ((status.encoder?.live || status.encoder?.streaming) && status.encoder.fps > 0)
    return { fps: status.encoder.fps, source: status.encoder.type || 'encoder' };
  return null;
}

function isRecordingActive(status = {}) {
  return (
    toBool(status.atem?.recording) ||
    toBool(status.obs?.recording) ||
    toBool(status.vmix?.recording) ||
    toBool(status.encoder?.recording) ||
    isHyperDeckRecording(status)
  );
}

module.exports = {
  hasStreamSignal,
  isStreamActive,
  isRecordingActive,
  isHyperDeckRecording,
  getStreamBitrate,
  getStreamFps,
};
