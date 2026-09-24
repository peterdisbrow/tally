'use strict';
/**
 * Decide whether a chunk of agent stdout/stderr means the TALLY SESSION was
 * rejected by the relay (→ stop agent, show sign-in).
 *
 * The agent reports relay rejections from its WebSocket close handler as:
 *   "⚠️  Relay disconnected (1008: invalid token). Reconnecting in …"
 * (relay-server websocketRouter closes with 1008 + 'token required' |
 *  'invalid token' | 'church not registered' | 'billing_<status>').
 *
 * It must NOT match device-level auth failures that the agent also logs —
 * e.g. OBS "Authentication failed." (obs-websocket close 4009), a Companion /
 * Planning Center / ProPresenter HTTP 401 "Unauthorized", or any number that
 * happens to contain "1008" (a port like :41008, 1008 kbps). The old
 * substring list signed the operator out of Tally for a wrong OBS password.
 */
const RELAY_REJECT_RE = /Relay disconnected \(1008: *(token required|invalid token|church not registered|billing_[a-z_]+)\s*\)/i;

function isRelayAuthFailure(text) {
  if (!text || typeof text !== 'string') return false;
  return text.split(/\r?\n/).some((line) => RELAY_REJECT_RE.test(line));
}

module.exports = { isRelayAuthFailure, RELAY_REJECT_RE };
