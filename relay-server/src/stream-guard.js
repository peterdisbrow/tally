/**
 * Stream Guard — Safety gate for dangerous commands while live.
 *
 * Checks if a command could disrupt an active stream or recording
 * and returns a warning message requiring user confirmation.
 *
 * Same pure-function pattern as chat-guard.js — no side effects.
 */

const { isStreamActive, isRecordingActive } = require('./status-utils');

// ─── DANGEROUS COMMAND REGISTRY ──────────────────────────────────────────────

const DANGEROUS_COMMANDS = {
  // CRITICAL — kills the live broadcast
  'obs.stopStream':        { severity: 'critical', desc: 'stop the OBS stream' },
  'vmix.stopStream':       { severity: 'critical', desc: 'stop the vMix stream' },
  'encoder.stopStream':    { severity: 'critical', desc: 'stop the encoder stream' },
  'atem.stopStreaming':     { severity: 'critical', desc: 'stop the ATEM stream' },
  'atem.fadeToBlack':       { severity: 'critical', desc: 'fade to black on the switcher' },

  // HIGH — disrupts broadcast or loses recording
  'obs.stopRecording':     { severity: 'high', desc: 'stop the OBS recording' },
  'vmix.stopRecording':    { severity: 'high', desc: 'stop the vMix recording' },
  'encoder.stopRecording': { severity: 'high', desc: 'stop the encoder recording' },
  'atem.stopRecording':    { severity: 'high', desc: 'stop the ATEM recording' },
  'vmix.mute':             { severity: 'high', desc: 'mute the vMix master audio' },
  'mixer.recallScene':     { severity: 'high', desc: 'recall a mixer scene (changes all audio routing)' },
};

// ─── FORCE BYPASS DETECTION ──────────────────────────────────────────────────

const FORCE_RE = /\b(force|override|bypass)\b/i;
const FORCE_SUFFIX_RE = /\b(now|do it|just do it)\s*[!.]*$/i;

/**
 * Detects force/bypass keywords in the raw message text.
 * e.g. "force stop stream", "stop stream now", "override fade to black"
 */
function hasForceBypass(text) {
  if (!text || typeof text !== 'string') return false;
  return FORCE_RE.test(text) || FORCE_SUFFIX_RE.test(text);
}

// ─── DANGER CLASSIFICATION ───────────────────────────────────────────────────

/**
 * Returns danger info if command is dangerous while live, or false if safe.
 * @param {string} command - e.g. 'obs.stopStream'
 * @param {object} params  - command parameters
 * @returns {false|{severity: string, description: string}}
 */
function isDangerousWhileLive(command, params = {}) {
  // Special case: mixer.mute only dangerous for master
  if (command === 'mixer.mute') {
    const ch = params.channel;
    if (ch === 'master' || ch === undefined || ch === null) {
      return { severity: 'high', description: 'mute the master audio output' };
    }
    return false; // individual channel mute is normal mixing
  }

  const entry = DANGEROUS_COMMANDS[command];
  if (!entry) return false;
  return { severity: entry.severity, description: entry.desc };
}

// ─── SINGLE COMMAND SAFETY CHECK ─────────────────────────────────────────────

/**
 * Check if a single command is safe to execute given current device status.
 * @returns {null|{warning: string, severity: string}}
 */
function checkStreamSafety(command, params, status) {
  const streaming = isStreamActive(status);
  const recording = isRecordingActive(status);

  if (!streaming && !recording) return null;

  const danger = isDangerousWhileLive(command, params);
  if (!danger) return null;

  const context = streaming ? 'stream is live' : 'recording is in progress';
  const emoji = danger.severity === 'critical' ? '🔴' : '🟡';

  return {
    warning: `${emoji} You're about to ${danger.description} while the ${context}. Are you sure?\n\nReply "yes" to proceed or "cancel" to abort.`,
    severity: danger.severity,
  };
}

// ─── MULTI-STEP WORKFLOW SAFETY CHECK ────────────────────────────────────────

/**
 * Check an entire multi-step workflow (e.g. end-of-service) at once.
 * Returns ONE warning listing all dangerous steps.
 * @returns {null|{warning: string, severity: string}}
 */
function checkWorkflowSafety(steps, status) {
  const streaming = isStreamActive(status);
  const recording = isRecordingActive(status);

  if (!streaming && !recording) return null;

  const dangerousSteps = [];
  for (const step of steps) {
    const danger = isDangerousWhileLive(step.command, step.params);
    if (danger) dangerousSteps.push(danger);
  }

  if (dangerousSteps.length === 0) return null;

  const hasCritical = dangerousSteps.some(s => s.severity === 'critical');
  const context = streaming ? 'stream is live' : 'recording is in progress';
  const descriptions = dangerousSteps.map(s => `  • ${s.description}`).join('\n');

  return {
    warning: `🔴 The ${context}. This will:\n${descriptions}\n\nReply "yes" to proceed or "cancel" to abort.`,
    severity: hasCritical ? 'critical' : 'high',
  };
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  checkStreamSafety,
  checkWorkflowSafety,
  hasForceBypass,
  isDangerousWhileLive,
  DANGEROUS_COMMANDS,
};
