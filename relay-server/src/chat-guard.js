/**
 * chat-guard.js
 *
 * Pre-filter that rejects obviously off-topic messages before they hit the AI,
 * saving API calls and keeping all chat relevant to Tally / church AV production.
 *
 * Strategy: generous keyword whitelist.  If the message contains ANY
 * production-related term, it passes through to the AI (which has its own
 * stricter system prompt).  Only messages with zero AV relevance are blocked.
 */

'use strict';

// ─── ON-TOPIC KEYWORD WHITELIST ──────────────────────────────────────────────
// Kept deliberately broad so borderline production questions still reach the AI.

const ON_TOPIC_KEYWORDS = [
  // ── Equipment brands / models ──
  'atem', 'blackmagic', 'bmd', 'switcher', 'hyperdeck', 'videohub',
  'x32', 'm32', 'x-air', 'xr18', 'xr16', 'xr12', 'wing', 'behringer', 'midas',
  'sq5', 'sq6', 'sq7', 'dlive', 'avantis', 'allen', 'heath', 'a&h',
  'yamaha', 'cl5', 'cl3', 'cl1', 'ql5', 'ql1', 'tf5', 'tf3', 'tf1', 'rio',
  'obs', 'vmix', 'wirecast', 'ecamm',
  'propresenter', 'pro presenter', 'propres', 'proclaim', 'easyworship',
  'companion', 'bitfocus', 'streamdeck', 'stream deck', 'elgato',
  'resolume', 'playback pro',
  'ptz', 'camera', 'cam', 'lens', 'tripod', 'jib', 'crane',
  'ndi', 'sdi', 'hdmi', 'displayport', 'dvi', 'bnc',
  'dante', 'aes67', 'avb', 'madi',
  'encoder', 'decoder', 'kiloview', 'magewell', 'birddog',

  // ── Production / AV terminology ──
  'mixer', 'console', 'board', 'channel', 'fader', 'gain',
  'eq', 'equaliz', 'compressor', 'compression', 'gate', 'hpf', 'high pass', 'low cut',
  'mute', 'unmute', 'solo', 'pan', 'aux', 'bus', 'send', 'return', 'fx', 'effects',
  'scene', 'snapshot', 'preset', 'cue', 'macro',
  'audio', 'sound', 'mic', 'microphone', 'wireless', 'rf', 'iem', 'in-ear', 'monitor',
  'speaker', 'pa', 'wedge', 'sub', 'subwoofer', 'amp', 'amplifier',
  'video', 'stream', 'streaming', 'broadcast', 'recording', 'record', 'playback',
  'media player', 'media pool', 'still', 'graphic', 'lower third', 'overlay',
  'transition', 'dissolve', 'wipe', 'stinger', 'dsk', 'key', 'keyer', 'upstream', 'downstream',
  'preview', 'program', 'pgm', 'pvw', 'multiview', 'multi-view',
  'input', 'output', 'source', 'destination', 'route', 'routing', 'matrix',
  'tally', 'tally light',
  'patch', 'patch list', 'patch sheet', 'input list',
  'label', 'rename', 'name',
  'upload', 'image', 'photo', 'picture',

  // ── Church / service context ──
  'church', 'service', 'worship', 'sermon', 'pastor', 'preacher',
  'praise', 'band', 'choir', 'vocal', 'singer', 'musician',
  'stage', 'platform', 'pulpit', 'podium', 'lectern',
  'sanctuary', 'auditorium', 'venue', 'lobby', 'overflow',
  'volunteer', 'tech team', 'td', 'technical director', 'producer',
  'rehearsal', 'sound check', 'soundcheck', 'line check',
  'live', 'online', 'campus', 'multisite', 'multi-site',
  'imag', 'confidence', 'comfort monitor',

  // ── System / troubleshooting ──
  'status', 'online', 'offline', 'connected', 'disconnected', 'connection',
  'error', 'issue', 'problem', 'trouble', 'fix', 'debug', 'diagnose',
  'alert', 'warning', 'notification',
  'network', 'ip', 'address', 'port', 'ping', 'latency', 'dropped',
  'equipment', 'device', 'gear', 'setup', 'configure', 'config',
  'install', 'update', 'firmware', 'software', 'driver',
  'help', 'how', 'what', 'can you', 'show me',

  // ── Common actions ──
  'start', 'stop', 'go', 'take', 'cut', 'fade', 'black', 'ftb',
  'recall', 'save', 'load', 'apply', 'set', 'change', 'adjust', 'turn',
  'check', 'test', 'verify', 'scan', 'snap', 'capture',
];

const OFF_TOPIC_RESPONSE = "I'm only here for production and equipment. Try 'help' to see what I can do.";

/**
 * Check whether a chat message is plausibly about AV / production.
 * Very short messages (≤ 3 words) are allowed through — they're often
 * terse commands like "status", "help", "cam 2", "go live".
 *
 * @param {string} message
 * @returns {boolean}
 */
function isOnTopic(message) {
  if (!message || typeof message !== 'string') return false;

  const trimmed = message.trim();
  if (!trimmed) return false;

  // Short messages are almost always commands or quick questions — let them through
  if (trimmed.split(/\s+/).length <= 3) return true;

  const lower = trimmed.toLowerCase();
  return ON_TOPIC_KEYWORDS.some((kw) => lower.includes(kw));
}

module.exports = { isOnTopic, OFF_TOPIC_RESPONSE };
