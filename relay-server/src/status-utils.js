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
    typeof status.encoder?.live === 'boolean' ||
    typeof status.encoder?.streaming === 'boolean'
  );
}

function isStreamActive(status = {}) {
  return (
    toBool(status.obs?.streaming) ||
    toBool(status.vmix?.streaming) ||
    toBool(status.encoder?.live) ||
    toBool(status.encoder?.streaming)
  );
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
};
