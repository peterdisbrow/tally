'use strict';

/**
 * smart-parser.js
 *
 * Device-aware command router that sits between the regex fast-path
 * (parseCommand) and the AI fallback (aiParseCommand).
 *
 * It uses the church's live device status to route generic commands
 * ("go live", "start recording", "we're done") to the correct device
 * without burning an AI call.
 *
 * Returns the same result shapes as aiParseCommand:
 *   { type: 'command',  command, params }
 *   { type: 'commands', steps: [{ command, params }, …] }
 *   { type: 'chat',     text }
 *   null   — not handled, fall through to AI
 */

const { isStreamActive, isRecordingActive } = require('./status-utils');

// ─── Device priority helpers ────────────────────────────────────────────────

/** ATEM uses startStreaming/stopStreaming, all others use startStream/stopStream. */
function startStreamCmd(device) {
  return device === 'atem' ? 'atem.startStreaming' : `${device}.startStream`;
}
function stopStreamCmd(device) {
  return device === 'atem' ? 'atem.stopStreaming' : `${device}.stopStream`;
}

/** Pick the best streaming device from connected status. */
function pickStreamDevice(status) {
  if (status.encoder?.connected) return 'encoder';
  if (status.obs?.connected)     return 'obs';
  if (status.vmix?.connected)    return 'vmix';
  if (status.atem?.connected)    return 'atem';
  return null;
}

/** Pick the best recording device from connected status. */
function pickRecordDevice(status) {
  if (status.hyperdeck?.connected) return 'hyperdeck';
  if (status.atem?.connected)      return 'atem';
  if (status.encoder?.connected)   return 'encoder';
  if (status.vmix?.connected)      return 'vmix';
  if (status.obs?.connected)       return 'obs';
  return null;
}

/** Get list of all connected streaming-capable devices. */
function getStreamDevices(status) {
  const devices = [];
  if (status.encoder?.connected) devices.push('encoder');
  if (status.obs?.connected)     devices.push('obs');
  if (status.vmix?.connected)    devices.push('vmix');
  if (status.atem?.connected)    devices.push('atem');
  return devices;
}

/** Get list of all connected recording-capable devices. */
function getRecordDevices(status) {
  const devices = [];
  if (status.hyperdeck?.connected) devices.push('hyperdeck');
  if (status.atem?.connected)      devices.push('atem');
  if (status.encoder?.connected)   devices.push('encoder');
  if (status.vmix?.connected)      devices.push('vmix');
  if (status.obs?.connected)       devices.push('obs');
  return devices;
}

/** Describe which device is currently streaming for status messages. */
function describeStreamSource(status) {
  if (status.encoder?.live || status.encoder?.streaming) return 'encoder';
  if (status.obs?.streaming) return 'OBS';
  if (status.vmix?.streaming) return 'vMix';
  if (status.atem?.streaming) return 'ATEM';
  return null;
}

// ─── Pattern categories ─────────────────────────────────────────────────────

// A. Social phrases — instant reply, no AI needed
const SOCIAL_RE = /^(thanks?|thank\s*you|thx|ty|awesome|perfect|great|good\s*job|nice|nice\s*one|cool|ok(ay)?|got\s*it|understood|roger|copy\s*that|10-4|will\s*do|sounds?\s*good|bet|word|yep|yup|nope|no\s*worries|all\s*good|np)[\s!.,]*$/i;

const SOCIAL_REPLIES = [
  "You're welcome! Let me know if you need anything.",
  "👍 Standing by.",
  "No problem — I'm here if you need me.",
  "Got it! Ready when you are.",
];

// B. Status questions
const STREAM_STATUS_RE = /^(?:are\s+we\s+(?:live|streaming|on\s*air)|is\s+(?:the\s+)?stream\s+(?:up|on|running|active|going)|stream\s+status|streaming\s+status|are\s+we\s+on(?:\s*air)?)[\s?!]*$/i;
const RECORD_STATUS_RE = /^(?:are\s+we\s+recording|is\s+(?:the\s+)?record(?:ing)?\s+(?:on|running|active|going)|recording\s+status)[\s?!]*$/i;

// C. Generic streaming start/stop (no device specified)
const START_STREAM_RE = /^(?:start|begin|go)\s+(?:the\s+)?stream(?:ing)?$|^go\s+live$/i;
const STOP_STREAM_RE = /^(?:stop|end|kill)\s+(?:the\s+)?stream(?:ing)?$/i;

// D. Generic recording start/stop (no device specified)
const START_RECORD_RE = /^(?:start|begin)\s+(?:the\s+)?record(?:ing)?$/i;
const STOP_RECORD_RE = /^(?:stop|end)\s+(?:the\s+)?record(?:ing)?$/i;

// E. Multi-device "all" commands
const START_ALL_STREAMS_RE = /^(?:start|begin|go)\s+all\s+(?:the\s+)?(?:stream(?:s|ing)?|encoder(?:s)?)$/i;
const STOP_ALL_STREAMS_RE = /^(?:stop|end|kill)\s+all\s+(?:the\s+)?(?:stream(?:s|ing)?|encoder(?:s)?)$/i;
const START_ALL_RECORD_RE = /^(?:start|begin)\s+all\s+(?:the\s+)?record(?:ing)?s?$/i;
const STOP_ALL_RECORD_RE = /^(?:stop|end)\s+all\s+(?:the\s+)?record(?:ing)?s?$/i;

// F. End-of-service workflow
const END_SERVICE_RE = /^(?:(?:we(?:'re|\s+are)\s+done)|(?:end|finish|wrap\s+up|conclude)\s+(?:the\s+)?(?:service|show|broadcast|event)|(?:wrap\s+(?:it\s+)?up)|(?:that'?s?\s+a\s+wrap)|(?:all\s+done)|(?:service\s+(?:over|ended|complete)))[\s!.]*$/i;

// G. Generic status / pre-service check
const STATUS_RE = /^(?:status|check\s*(?:everything|all|systems?)?|pre-?service\s+check|systems?\s+check|run\s+(?:a\s+)?check)[\s?!]*$/i;

// H. ATEM audio mute/unmute headphone or monitor output
const MUTE_HEADPHONE_RE = /^mute\s+(?:the\s+)?(?:headphone(?:s)?|monitor)(?:\s+(?:mix|output))?[\s!.]*$/i;
const UNMUTE_HEADPHONE_RE = /^unmute\s+(?:the\s+)?(?:headphone(?:s)?|monitor)(?:\s+(?:mix|output))?[\s!.]*$/i;

// ─── Main parser ────────────────────────────────────────────────────────────

/**
 * Try to resolve a command without AI, using the church's live device status.
 *
 * @param {string} text — raw message from the user (already trimmed by caller)
 * @param {object} status — church device status from churches.get(id).status
 * @returns {object|null} — parsed result or null to fall through to AI
 */
function smartParse(text, status = {}) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // ─── A. Social phrases ──────────────────────────────────────────────────
  if (SOCIAL_RE.test(trimmed)) {
    const reply = SOCIAL_REPLIES[Math.floor(Math.random() * SOCIAL_REPLIES.length)];
    return { type: 'chat', text: reply };
  }

  // ─── B. Status questions ────────────────────────────────────────────────
  if (STREAM_STATUS_RE.test(trimmed)) {
    const live = isStreamActive(status);
    const source = describeStreamSource(status);
    if (live && source) {
      return { type: 'chat', text: `Yes, you're live via ${source}.` };
    } else if (live) {
      return { type: 'chat', text: 'Yes, the stream is active.' };
    } else {
      return { type: 'chat', text: 'No, the stream is not active right now.' };
    }
  }

  if (RECORD_STATUS_RE.test(trimmed)) {
    const recording = isRecordingActive(status);
    if (recording) {
      return { type: 'chat', text: 'Yes, recording is in progress.' };
    } else {
      return { type: 'chat', text: 'No, recording is not active right now.' };
    }
  }

  // ─── C. Generic streaming start/stop ────────────────────────────────────
  if (START_STREAM_RE.test(trimmed)) {
    const device = pickStreamDevice(status) || 'encoder'; // fallback to encoder if status unavailable
    return { type: 'command', command: startStreamCmd(device), params: {} };
  }

  if (STOP_STREAM_RE.test(trimmed)) {
    const device = pickStreamDevice(status) || 'encoder'; // fallback to encoder if status unavailable
    return { type: 'command', command: stopStreamCmd(device), params: {} };
  }

  // ─── D. Generic recording start/stop ────────────────────────────────────
  if (START_RECORD_RE.test(trimmed)) {
    const device = pickRecordDevice(status);
    if (!device) return null;
    const cmd = device === 'hyperdeck' ? 'hyperdeck.record' : `${device}.startRecording`;
    return { type: 'command', command: cmd, params: {} };
  }

  if (STOP_RECORD_RE.test(trimmed)) {
    const device = pickRecordDevice(status);
    if (!device) return null;
    const cmd = device === 'hyperdeck' ? 'hyperdeck.stop' : `${device}.stopRecording`;
    return { type: 'command', command: cmd, params: {} };
  }

  // ─── E. Multi-device "all" commands ─────────────────────────────────────
  if (START_ALL_STREAMS_RE.test(trimmed)) {
    const devices = getStreamDevices(status);
    if (devices.length === 0) return null;
    const steps = devices.map(d => ({ command: startStreamCmd(d), params: {} }));
    return { type: 'commands', steps };
  }

  if (STOP_ALL_STREAMS_RE.test(trimmed)) {
    const devices = getStreamDevices(status);
    if (devices.length === 0) return null;
    const steps = devices.map(d => ({ command: stopStreamCmd(d), params: {} }));
    return { type: 'commands', steps };
  }

  if (START_ALL_RECORD_RE.test(trimmed)) {
    const devices = getRecordDevices(status);
    if (devices.length === 0) return null;
    const steps = devices.map(d => {
      if (d === 'hyperdeck') return { command: 'hyperdeck.record', params: {} };
      return { command: `${d}.startRecording`, params: {} };
    });
    return { type: 'commands', steps };
  }

  if (STOP_ALL_RECORD_RE.test(trimmed)) {
    const devices = getRecordDevices(status);
    if (devices.length === 0) return null;
    const steps = devices.map(d => {
      if (d === 'hyperdeck') return { command: 'hyperdeck.stop', params: {} };
      return { command: `${d}.stopRecording`, params: {} };
    });
    return { type: 'commands', steps };
  }

  // ─── F. End-of-service workflow ─────────────────────────────────────────
  if (END_SERVICE_RE.test(trimmed)) {
    const steps = [];

    // Fade to black if ATEM connected
    if (status.atem?.connected) {
      steps.push({ command: 'atem.fadeToBlack', params: {} });
    }

    // Stop all active streams
    if (status.encoder?.live || status.encoder?.streaming) {
      steps.push({ command: 'encoder.stopStream', params: {} });
    }
    if (status.obs?.streaming) {
      steps.push({ command: 'obs.stopStream', params: {} });
    }
    if (status.vmix?.streaming) {
      steps.push({ command: 'vmix.stopStream', params: {} });
    }
    if (status.atem?.streaming) {
      steps.push({ command: 'atem.stopStreaming', params: {} });
    }

    // Stop all active recordings
    if (status.obs?.recording) {
      steps.push({ command: 'obs.stopRecording', params: {} });
    }
    if (status.vmix?.recording) {
      steps.push({ command: 'vmix.stopRecording', params: {} });
    }
    if (status.atem?.recording) {
      steps.push({ command: 'atem.stopRecording', params: {} });
    }
    if (status.encoder?.recording) {
      steps.push({ command: 'encoder.stopRecording', params: {} });
    }

    if (steps.length === 0) {
      // Nothing active to stop — just acknowledge
      return { type: 'chat', text: "Looks like everything is already stopped. You're all set!" };
    }

    return { type: 'commands', steps };
  }

  // ─── G. Generic status / pre-service check ─────────────────────────────
  if (STATUS_RE.test(trimmed)) {
    return { type: 'command', command: 'preServiceCheck', params: {} };
  }

  // ─── H. ATEM audio mute/unmute headphone or monitor ───────────────────
  if (status.atem?.connected) {
    if (MUTE_HEADPHONE_RE.test(trimmed)) {
      return { type: 'command', command: 'atem.setClassicAudioMonitorProps', params: { mute: true } };
    }
    if (UNMUTE_HEADPHONE_RE.test(trimmed)) {
      return { type: 'command', command: 'atem.setClassicAudioMonitorProps', params: { mute: false } };
    }
  }

  // ─── No match — fall through to AI ──────────────────────────────────────
  return null;
}

module.exports = { smartParse, pickStreamDevice, pickRecordDevice };
