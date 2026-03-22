/**
 * NDI Encoder smoke tests
 *
 * NdiEncoder wraps ffprobe via child_process.spawn. Tests avoid invoking the
 * real process by either:
 *   1. Using an empty source (source='') which short-circuits before runCommand
 *   2. Overriding enc._probe on the instance with a synchronous mock
 *
 * Key behaviours:
 *   - Constructor normalises/trims host, falls back to 'NDI Decoder' for empty label
 *   - setSource() clears cache only when the value actually changes
 *   - _probe() returns source_not_configured immediately when source is ''
 *   - _probe() returns cached result when within _cacheMs window
 *   - connect() / isOnline() delegate to _probe and update _connected
 *   - getStatus() maps the probe result to a typed status object
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { NdiEncoder } = require('../src/encoders/ndi');

// ── helpers ────────────────────────────────────────────────────────────────

/** Build a fake probe result as the real _probe success branch would return. */
function fakeProbe({
  connected = true,
  live = true,
  bitrateKbps = 5000,
  fps = 29.97,
  details = 'Test NDI Source · 1920x1080 @ 29.97 fps · 5000 kbps',
  width = 1920,
  height = 1080,
  codec = 'h264',
  pixelFormat = 'yuv420p',
  probeError = null,
} = {}) {
  return { connected, live, bitrateKbps, fps, details, width, height, codec, pixelFormat, probeError };
}

/** Build a fake probe result for source_not_configured */
function notConfiguredProbe() {
  return {
    connected: false,
    live: false,
    bitrateKbps: null,
    fps: null,
    details: 'NDI source name not configured',
    width: null,
    height: null,
    codec: null,
    pixelFormat: null,
    probeError: 'source_not_configured',
  };
}

// ── Constructor ────────────────────────────────────────────────────────────

test('ndi: constructor — defaults when called with no args', () => {
  const enc = new NdiEncoder();
  assert.equal(enc.source, '');
  assert.equal(enc.label, 'NDI Decoder');
  assert.equal(enc.timeoutMs, 5000);
  assert.equal(enc._connected, false);
  assert.equal(enc._lastProbe, null);
  assert.equal(enc._lastProbeAt, 0);
});

test('ndi: constructor — custom host, label, timeoutMs', () => {
  const enc = new NdiEncoder({ host: 'MY-PC (NDI Source)', label: 'Main Camera', timeoutMs: 8000 });
  assert.equal(enc.source, 'MY-PC (NDI Source)');
  assert.equal(enc.label, 'Main Camera');
  assert.equal(enc.timeoutMs, 8000);
});

test('ndi: constructor — trims whitespace from host', () => {
  const enc = new NdiEncoder({ host: '  source  ' });
  assert.equal(enc.source, 'source');
});

test('ndi: constructor — empty label falls back to "NDI Decoder"', () => {
  const enc = new NdiEncoder({ host: 'SomeSource', label: '' });
  assert.equal(enc.label, 'NDI Decoder');
});

test('ndi: constructor — whitespace-only label falls back to "NDI Decoder"', () => {
  const enc = new NdiEncoder({ host: 'SomeSource', label: '   ' });
  assert.equal(enc.label, 'NDI Decoder');
});

test('ndi: constructor — _connected starts false even when host is set', () => {
  const enc = new NdiEncoder({ host: 'LIVE-PC (NDI)' });
  assert.equal(enc._connected, false);
});

// ── setSource() ────────────────────────────────────────────────────────────

test('ndi: setSource — changes source and clears probe cache', () => {
  const enc = new NdiEncoder({ host: 'OldSource' });
  // Simulate a populated cache
  enc._lastProbe = fakeProbe();
  enc._lastProbeAt = Date.now();

  enc.setSource('NewSource');

  assert.equal(enc.source, 'NewSource');
  assert.equal(enc._lastProbe, null);
  assert.equal(enc._lastProbeAt, 0);
});

test('ndi: setSource — no-op when same source (does NOT clear cache)', () => {
  const enc = new NdiEncoder({ host: 'SameSource' });
  const cached = fakeProbe();
  enc._lastProbe = cached;
  const probeAt = Date.now();
  enc._lastProbeAt = probeAt;

  enc.setSource('SameSource');

  assert.equal(enc.source, 'SameSource');
  assert.equal(enc._lastProbe, cached, 'cache should be unchanged for same source');
  assert.equal(enc._lastProbeAt, probeAt);
});

test('ndi: setSource — trims whitespace when setting new source', () => {
  const enc = new NdiEncoder({ host: 'OldSource' });
  enc.setSource('  TrimmedSource  ');
  assert.equal(enc.source, 'TrimmedSource');
});

test('ndi: setSource — empty string sets source to empty and clears cache', () => {
  const enc = new NdiEncoder({ host: 'SomeSource' });
  enc._lastProbe = fakeProbe();
  enc._lastProbeAt = Date.now();

  enc.setSource('');
  assert.equal(enc.source, '');
  assert.equal(enc._lastProbe, null);
});

// ── getSource() ────────────────────────────────────────────────────────────

test('ndi: getSource — returns current source', () => {
  const enc = new NdiEncoder({ host: 'MY-PC (Main)' });
  assert.equal(enc.getSource(), 'MY-PC (Main)');
});

test('ndi: getSource — returns empty string for default instance', () => {
  const enc = new NdiEncoder();
  assert.equal(enc.getSource(), '');
});

test('ndi: getSource — reflects setSource changes', () => {
  const enc = new NdiEncoder({ host: 'OriginalSource' });
  enc.setSource('UpdatedSource');
  assert.equal(enc.getSource(), 'UpdatedSource');
});

// ── disconnect() ───────────────────────────────────────────────────────────

test('ndi: disconnect — sets _connected=false and returns true', async () => {
  const enc = new NdiEncoder({ host: 'SomeSource' });
  enc._connected = true;
  const result = await enc.disconnect();
  assert.equal(result, true);
  assert.equal(enc._connected, false);
});

test('ndi: disconnect — returns true even when already disconnected', async () => {
  const enc = new NdiEncoder();
  enc._connected = false;
  const result = await enc.disconnect();
  assert.equal(result, true);
  assert.equal(enc._connected, false);
});

// ── _probe() — source not configured (no runCommand involved) ──────────────

test('ndi: _probe — returns source_not_configured when source is empty', async () => {
  const enc = new NdiEncoder(); // source=''
  const probe = await enc._probe(true);

  assert.equal(probe.connected, false);
  assert.equal(probe.live, false);
  assert.equal(probe.probeError, 'source_not_configured');
  assert.ok(probe.details.includes('not configured'),
    `expected "not configured" in details; got: ${probe.details}`);
  assert.equal(probe.bitrateKbps, null);
  assert.equal(probe.fps, null);
  assert.equal(probe.width, null);
  assert.equal(probe.height, null);
  assert.equal(probe.codec, null);
  assert.equal(probe.pixelFormat, null);
});

test('ndi: _probe — source_not_configured result is cached after first call', async () => {
  const enc = new NdiEncoder(); // source=''
  const first = await enc._probe(true);
  const second = await enc._probe(false); // should hit cache
  assert.equal(first, second, 'should return same cached object reference');
});

test('ndi: _probe — force=true bypasses cache', async () => {
  const enc = new NdiEncoder(); // source=''
  const first = await enc._probe(true);
  // Mess with the cached value to confirm force re-runs _probe logic
  enc._lastProbe = { ...first, probeError: 'tampered' };
  const forced = await enc._probe(true);
  // After force, _lastProbe is reset to the fresh source_not_configured result
  assert.equal(forced.probeError, 'source_not_configured');
});

// ── _probe() — caching with source set ────────────────────────────────────

test('ndi: _probe — returns cached result when within _cacheMs window', async () => {
  const enc = new NdiEncoder({ host: 'MyNDISource' });
  const cached = fakeProbe({ details: 'cached-probe-result' });
  enc._lastProbe = cached;
  enc._lastProbeAt = Date.now(); // fresh, within _cacheMs

  // Without force, should return cached value (doesn't call runCommand)
  const result = await enc._probe(false);
  assert.equal(result, cached, 'should return exact cached object reference');
});

test('ndi: _probe — does NOT return stale cache when _lastProbeAt is old', async () => {
  const enc = new NdiEncoder(); // source='' means no runCommand path
  const stale = { ...notConfiguredProbe(), probeError: 'stale_value' };
  enc._lastProbe = stale;
  enc._lastProbeAt = Date.now() - 60_000; // expired

  // When cache is stale, re-runs _probe logic (returns fresh source_not_configured)
  const result = await enc._probe(false);
  assert.equal(result.probeError, 'source_not_configured');
});

// ── connect() — mocked _probe ──────────────────────────────────────────────

test('ndi: connect — returns true and sets _connected=true when probe connected', async () => {
  const enc = new NdiEncoder({ host: 'MySource' });
  enc._probe = async () => fakeProbe({ connected: true });

  const result = await enc.connect();
  assert.equal(result, true);
  assert.equal(enc._connected, true);
});

test('ndi: connect — returns false and sets _connected=false when probe not connected', async () => {
  const enc = new NdiEncoder({ host: 'MySource' });
  enc._probe = async () => fakeProbe({ connected: false, live: false, probeError: 'source_unreachable' });

  const result = await enc.connect();
  assert.equal(result, false);
  assert.equal(enc._connected, false);
});

test('ndi: connect — calls _probe with force=true', async () => {
  const enc = new NdiEncoder({ host: 'MySource' });
  let capturedForce;
  enc._probe = async (force = false) => {
    capturedForce = force;
    return fakeProbe();
  };

  await enc.connect();
  assert.equal(capturedForce, true, 'connect() should call _probe(true)');
});

// ── isOnline() — mocked _probe ─────────────────────────────────────────────

test('ndi: isOnline — returns true and sets _connected=true when probe connected', async () => {
  const enc = new NdiEncoder({ host: 'MySource' });
  enc._probe = async () => fakeProbe({ connected: true });

  const result = await enc.isOnline();
  assert.equal(result, true);
  assert.equal(enc._connected, true);
});

test('ndi: isOnline — returns false and sets _connected=false when probe not connected', async () => {
  const enc = new NdiEncoder({ host: 'MySource' });
  enc._probe = async () => fakeProbe({ connected: false, live: false });

  const result = await enc.isOnline();
  assert.equal(result, false);
  assert.equal(enc._connected, false);
});

test('ndi: isOnline — calls _probe without forcing (uses default force=false)', async () => {
  const enc = new NdiEncoder({ host: 'MySource' });
  let capturedForce = 'not_called';
  enc._probe = async (force = false) => {
    capturedForce = force;
    return fakeProbe();
  };

  await enc.isOnline();
  assert.equal(capturedForce, false, 'isOnline() should call _probe without force');
});

// ── getStatus() — mocked _probe — disconnected / not configured ────────────

test('ndi: getStatus — source_not_configured probe returns correct status shape', async () => {
  const enc = new NdiEncoder(); // source=''
  enc._probe = async () => notConfiguredProbe();

  const status = await enc.getStatus();

  assert.equal(status.type, 'ndi');
  assert.equal(status.connected, false);
  assert.equal(status.live, false);
  assert.equal(status.probeError, 'source_not_configured');
  assert.equal(status.ndiSource, null); // source is ''
  assert.equal(status.bitrateKbps, null);
  assert.equal(status.fps, null);
  assert.equal(status.width, null);
  assert.equal(status.height, null);
  assert.equal(status.codec, null);
  assert.equal(status.pixelFormat, null);
  assert.equal(status.cpuUsage, null); // always null for NDI
  assert.equal(status.recording, false); // always false for NDI
});

test('ndi: getStatus — details from probe is forwarded to status', async () => {
  const enc = new NdiEncoder(); // source=''
  enc._probe = async () => notConfiguredProbe();

  const status = await enc.getStatus();
  assert.equal(status.details, 'NDI source name not configured');
});

// ── getStatus() — mocked _probe — connected ────────────────────────────────

test('ndi: getStatus — connected probe returns full video metadata', async () => {
  const enc = new NdiEncoder({ host: 'MY-PC (NDI Source)', label: 'Main Camera' });
  enc._probe = async () => fakeProbe({
    connected: true,
    live: true,
    bitrateKbps: 5000,
    fps: 29.97,
    details: 'Main Camera (MY-PC NDI Source) · 1920x1080 @ 29.97 fps · 5000 kbps',
    width: 1920,
    height: 1080,
    codec: 'h264',
    pixelFormat: 'yuv420p',
    probeError: null,
  });

  const status = await enc.getStatus();

  assert.equal(status.type, 'ndi');
  assert.equal(status.connected, true);
  assert.equal(status.live, true);
  assert.equal(status.bitrateKbps, 5000);
  assert.equal(status.fps, 29.97);
  assert.equal(status.width, 1920);
  assert.equal(status.height, 1080);
  assert.equal(status.codec, 'h264');
  assert.equal(status.pixelFormat, 'yuv420p');
  assert.equal(status.probeError, null);
  assert.equal(status.ndiSource, 'MY-PC (NDI Source)');
  assert.equal(status.recording, false); // always false
  assert.equal(status.cpuUsage, null);   // always null
});

test('ndi: getStatus — ndiSource is source string when source is set', async () => {
  const enc = new NdiEncoder({ host: 'STUDIO-PC (Camera 1)' });
  enc._probe = async () => fakeProbe();

  const status = await enc.getStatus();
  assert.equal(status.ndiSource, 'STUDIO-PC (Camera 1)');
});

test('ndi: getStatus — ndiSource is null when source is empty', async () => {
  const enc = new NdiEncoder(); // source=''
  enc._probe = async () => notConfiguredProbe();

  const status = await enc.getStatus();
  assert.equal(status.ndiSource, null);
});

test('ndi: getStatus — updates _connected from probe result', async () => {
  const enc = new NdiEncoder({ host: 'SomeSource' });
  enc._connected = false;
  enc._probe = async () => fakeProbe({ connected: true });

  await enc.getStatus();
  assert.equal(enc._connected, true);
});

test('ndi: getStatus — null bitrateKbps and fps for offline probe', async () => {
  const enc = new NdiEncoder({ host: 'SomeSource' });
  enc._probe = async () => ({
    connected: false,
    live: false,
    bitrateKbps: null,
    fps: null,
    details: 'NDI source "SomeSource" not reachable',
    width: null,
    height: null,
    codec: null,
    pixelFormat: null,
    probeError: 'source_unreachable',
  });

  const status = await enc.getStatus();
  assert.equal(status.connected, false);
  assert.equal(status.bitrateKbps, null);
  assert.equal(status.fps, null);
  assert.equal(status.probeError, 'source_unreachable');
});

test('ndi: getStatus — recording is always false', async () => {
  const enc = new NdiEncoder({ host: 'SomeSource' });
  enc._probe = async () => fakeProbe({ connected: true });
  const status = await enc.getStatus();
  assert.equal(status.recording, false);
});

test('ndi: getStatus — cpuUsage is always null', async () => {
  const enc = new NdiEncoder({ host: 'SomeSource' });
  enc._probe = async () => fakeProbe({ connected: true });
  const status = await enc.getStatus();
  assert.equal(status.cpuUsage, null);
});

// ── getStatus() — missing_ffprobe probe error ──────────────────────────────

test('ndi: getStatus — missing_ffprobe probe returns probeError in status', async () => {
  const enc = new NdiEncoder({ host: 'SomeSource' });
  enc._probe = async () => ({
    connected: false,
    live: false,
    bitrateKbps: null,
    fps: null,
    details: 'ffprobe not installed (required for NDI monitoring)',
    width: null,
    height: null,
    codec: null,
    pixelFormat: null,
    probeError: 'missing_ffprobe',
  });

  const status = await enc.getStatus();
  assert.equal(status.probeError, 'missing_ffprobe');
  assert.equal(status.connected, false);
});

// ── getStatus() — probe_timeout path ──────────────────────────────────────

test('ndi: getStatus — probe_timeout probe returns probeError in status', async () => {
  const enc = new NdiEncoder({ host: 'SomeSource' });
  enc._probe = async () => ({
    connected: false,
    live: false,
    bitrateKbps: null,
    fps: null,
    details: 'NDI probe timed out for "SomeSource"',
    width: null,
    height: null,
    codec: null,
    pixelFormat: null,
    probeError: 'probe_timeout',
  });

  const status = await enc.getStatus();
  assert.equal(status.probeError, 'probe_timeout');
  assert.equal(status.connected, false);
  assert.ok(status.details.includes('timed out'));
});
