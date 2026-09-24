'use strict';
/**
 * Pure tray-menu device summary. agentStatus device entries can be:
 *   null/undefined  → not configured (hidden)
 *   boolean         → legacy stdout-derived state
 *   object          → { connected: bool, ... } from /local-status or relay
 * An object is only "connected" when .connected === true — a configured but
 * disconnected device ({connected:false}) is truthy and used to be shown as
 * "✓ Connected" in the tray (fake connected).
 */
function isDeviceActive(v) {
  if (v === true) return true;
  return !!(v && typeof v === 'object' && v.connected === true);
}
function isConfigured(v) { return v !== null && v !== undefined; }

function buildTrayDeviceSummary(s = {}) {
  const encLabel = s.encoderType || 'OBS';
  const atemOk = isDeviceActive(s.atem);
  const encoderOk = isDeviceActive(s.encoder) || isDeviceActive(s.obs);
  const encoderConfigured = isConfigured(s.encoder) || isConfigured(s.obs);
  const compOk = isDeviceActive(s.companion);
  const ppOk = isDeviceActive(s.proPresenter);
  const resOk = isDeviceActive(s.resolume);
  const deviceCount = [atemOk, encoderOk, compOk, ppOk, resOk].filter(Boolean).length;
  const lines = [];
  if (isConfigured(s.atem)) lines.push(`  ATEM: ${atemOk ? '✓ Connected' : '✗ Disconnected'}`);
  if (encoderConfigured) lines.push(`  ${encLabel}: ${encoderOk ? '✓ Connected' : '✗ Disconnected'}`);
  if (isConfigured(s.companion)) lines.push(`  Companion: ${compOk ? '✓ Connected' : '✗ Disconnected'}`);
  if (isConfigured(s.proPresenter)) lines.push(`  ProPresenter: ${ppOk ? '✓ Connected' : '✗ Disconnected'}`);
  if (isConfigured(s.resolume)) lines.push(`  Resolume: ${resOk ? '✓ Connected' : '✗ Disconnected'}`);
  const isLive = !!(s.streaming || (s.encoder && typeof s.encoder === 'object' && s.encoder.live)
    || (s.obs && typeof s.obs === 'object' && s.obs.connected === true && s.obs.streaming === true));
  const fingerprint = [atemOk, encoderOk, compOk, ppOk, resOk, isLive, lines.join('|')].join(',');
  return { atemOk, encoderOk, compOk, deviceCount, lines, isLive, encLabel, fingerprint };
}

module.exports = { isDeviceActive, buildTrayDeviceSummary };
