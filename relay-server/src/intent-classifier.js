'use strict';

/**
 * intent-classifier.js
 *
 * Lightweight intent classifier for the Tally AI routing layer.
 * Runs BEFORE any model call — pure regex/keyword, no API call.
 *
 * Returns: { intent: 'command'|'diagnostic'|'ambiguous', confidence: number, reason: string }
 */

// ─── Command verb patterns ──────────────────────────────────────────────────

const COMMAND_VERBS = /^(cut|switch|take|go|start|stop|mute|unmute|fade|set|recall|save|run|press|play|record|route|clear|toggle|upload|snap|turn|apply|load|zoom|pan|tilt|next|previous|prev|cam|camera|macro|dsk|usk)\b/i;

// Short imperatives that are almost certainly commands (1-2 word patterns)
const SHORT_COMMAND_PATTERNS = [
  /^cam(?:era)?\s*\d+$/i,                   // cam 1, camera 2
  /^(take|auto|cut)$/i,                      // single-word transitions
  /^(go\s+live|we'?re\s+live)$/i,            // go live
  /^(that'?s?\s+a\s+wrap|we'?re\s+done)$/i,  // end-of-service
  /^(help|status|info)$/i,                    // single-word queries (handled as command path)
  /^(mute|unmute)$/i,                         // single-word audio
  /^(ftb|fade\s*to\s*black)$/i,              // fade to black
  /^macro\s*\d+$/i,                          // macro 1
  /^dsk\s*\d*\s*(on|off)$/i,                 // dsk on/off
  /^input\s*\d+$/i,                          // input 3
  /^preset\s*\d+$/i,                         // preset 1 (PTZ)
  /^slide\s*\d+$/i,                          // slide 5 (ProPresenter)
  /^scene\s+\S+/i,                           // scene Worship
];

// Longer command patterns with device references
const DEVICE_COMMAND_PATTERNS = [
  /^(cut|switch|go)\s+(to\s+)?(cam|camera|input|source)\s*\d+/i,
  /^(start|stop)\s+(stream|record|play)/i,
  /^(start|stop)\s+(all|obs|vmix|atem|encoder)/i,
  /^(mute|unmute)\s+(ch|channel|input|master|mic|main)\s*/i,
  /^(set|change)\s+(scene|transition|volume|fader|gain|iris)/i,
  /^(recall|load)\s+(preset|scene|macro|snapshot)/i,
  /^(run|press)\s+(macro|button|companion)/i,
  /^(route|send)\s+/i,
  /^(zoom|pan|tilt)\s+(in|out|left|right|up|down)/i,
  /^(next|prev|previous)\s+(slide|clip|cue)/i,
  /^(clear|blank)\s+(all|slide|message|layer)/i,
];

// ─── Diagnostic / question patterns ──────────────────────────────────────────

const QUESTION_STARTERS = /^(how|what|why|where|when|which|who|explain|tell me|can (you|i|we|tally)|could (you|i|we)|would (you|it)|does|do|is there|is it|is the|is my|help me|i need help|i'm having|im having|any idea|do you know|what's|whats|where's|where is|walk me through|show me how|describe|should (i|we)|i don't understand|i dont understand|i'm confused|im confused|troubleshoot|diagnose)/i;

const TROUBLESHOOTING_KEYWORDS = [
  'dropped', 'dropping', 'drops', 'drop',
  'lag', 'lagging', 'latency', 'delay', 'delayed',
  'issue', 'issues', 'problem', 'problems',
  'error', 'errors', 'failed', 'failing', 'failure',
  'crash', 'crashed', 'crashing',
  'restart', 'restarted', 'restarting', 'reconnect', 'reconnecting',
  'slow', 'stuck', 'frozen', 'freeze', 'freezing',
  'flicker', 'flickering', 'noise', 'noisy',
  'black', 'blank', 'no signal', 'no video', 'no audio',
  'glitch', 'glitching', 'artifact', 'artifacts',
  'buffering', 'stutter', 'stuttering',
  'silence', 'silent',
  'disconnected', 'offline', 'down', 'not working',
  'not responding', 'unresponsive', 'timeout',
  'low bitrate', 'low fps', 'frame drop',
];

const ANALYSIS_KEYWORDS = [
  'during the service', 'last week', 'last service', 'last sunday',
  'trending', 'trend', 'pattern', 'patterns',
  'what happened', 'what went wrong',
  'history', 'timeline', 'recap',
  'healthy', 'health', 'health check',
  'performance', 'stats', 'statistics',
  'compare', 'compared to', 'worse than', 'better than',
  'recurring', 'keeps happening', 'again',
];

// ─── Ambiguous signal patterns ──────────────────────────────────────────────

const AMBIGUOUS_PATTERNS = [
  /^check\s+(if|whether|that)/i,           // "check if we're live"
  /^make\s+sure/i,                          // "make sure audio is working"
  /^verify\s/i,                             // "verify the stream is up"
  /^confirm\s+(that|if|whether)/i,          // "confirm that we're recording" (not the confirm: prefix)
  /^look\s+at/i,                            // "look at the encoder"
  /^test\s/i,                               // "test the audio"
];

// ─── Classifier ──────────────────────────────────────────────────────────────

/**
 * Classify a message as command, diagnostic, or ambiguous.
 *
 * @param {string} message - raw user message
 * @returns {{ intent: 'command'|'diagnostic'|'ambiguous', confidence: number, reason: string }}
 */
function classifyIntent(message) {
  if (!message || typeof message !== 'string') {
    return { intent: 'command', confidence: 0.5, reason: 'empty_or_invalid' };
  }

  const trimmed = message.trim();
  if (!trimmed) {
    return { intent: 'command', confidence: 0.5, reason: 'empty' };
  }

  const lower = trimmed.toLowerCase();
  const wordCount = trimmed.split(/\s+/).length;

  // ── Phase 0: Check for troubleshooting keywords early (before command matching) ──
  // This prevents command verbs from masking diagnostic/ambiguous signals
  const troubleshootMatch = TROUBLESHOOTING_KEYWORDS.find(kw => lower.includes(kw));
  const analysisMatch = ANALYSIS_KEYWORDS.find(kw => lower.includes(kw));

  // ── Phase 1: Strong command signals ─────────────────────────────────────

  // Short command patterns (1-2 words, very high confidence)
  for (const pat of SHORT_COMMAND_PATTERNS) {
    if (pat.test(trimmed)) {
      return { intent: 'command', confidence: 0.95, reason: 'short_command_pattern' };
    }
  }

  // Longer device-specific command patterns — but only if no troubleshooting signals
  if (!troubleshootMatch && !analysisMatch) {
    for (const pat of DEVICE_COMMAND_PATTERNS) {
      if (pat.test(trimmed)) {
        // If the message is very long (many clauses), it's ambiguous even with a device pattern
        if (wordCount > 8) {
          return { intent: 'ambiguous', confidence: 0.5, reason: 'long_multi_clause_command' };
        }
        return { intent: 'command', confidence: 0.9, reason: 'device_command_pattern' };
      }
    }
  }

  // Starts with a command verb AND is short (≤4 words) with no question mark AND no troubleshoot keywords
  if (COMMAND_VERBS.test(trimmed) && wordCount <= 4 && !trimmed.includes('?') && !troubleshootMatch) {
    return { intent: 'command', confidence: 0.85, reason: 'command_verb_short' };
  }

  // ── Phase 2: Strong diagnostic signals ──────────────────────────────────

  // Explicit question starters
  if (QUESTION_STARTERS.test(trimmed)) {
    // But if it's a very short question-starter that maps to a command ("help", "status")
    if (wordCount <= 2 && /^(help|status|info)$/i.test(trimmed)) {
      return { intent: 'command', confidence: 0.8, reason: 'short_utility_command' };
    }
    return { intent: 'diagnostic', confidence: 0.85, reason: 'question_starter' };
  }

  // Contains a question mark
  if (trimmed.includes('?')) {
    return { intent: 'diagnostic', confidence: 0.8, reason: 'question_mark' };
  }

  // Troubleshooting keywords (already checked in Phase 0, reuse the match)
  if (troubleshootMatch) {
    // If also starts with a command verb, it's ambiguous ("start stream dropping frames" vs "stop the drops")
    if (COMMAND_VERBS.test(trimmed)) {
      return { intent: 'ambiguous', confidence: 0.5, reason: `command_verb_with_troubleshoot:${troubleshootMatch}` };
    }
    return { intent: 'diagnostic', confidence: 0.8, reason: `troubleshooting_keyword:${troubleshootMatch}` };
  }

  // Analysis / pattern keywords (already checked in Phase 0, reuse the match)
  if (analysisMatch) {
    return { intent: 'diagnostic', confidence: 0.85, reason: `analysis_keyword:${analysisMatch}` };
  }

  // ── Phase 3: Ambiguous signals ──────────────────────────────────────────

  for (const pat of AMBIGUOUS_PATTERNS) {
    if (pat.test(trimmed)) {
      return { intent: 'ambiguous', confidence: 0.5, reason: 'ambiguous_pattern' };
    }
  }

  // Starts with a command verb but is longer (5+ words) — might be conversational
  if (COMMAND_VERBS.test(trimmed) && wordCount >= 5) {
    return { intent: 'ambiguous', confidence: 0.6, reason: 'long_command_verb_sentence' };
  }

  // ── Phase 4: Default to command path ────────────────────────────────────
  // If we can't tell, default to the command pipeline (Haiku).
  // Haiku will return type:'chat' if it can't parse a command,
  // and the ambiguous fallback path will escalate to Sonnet.

  if (wordCount <= 3) {
    return { intent: 'command', confidence: 0.7, reason: 'short_default' };
  }

  return { intent: 'ambiguous', confidence: 0.5, reason: 'unclassified' };
}

module.exports = { classifyIntent };
