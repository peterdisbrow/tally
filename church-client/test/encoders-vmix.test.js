/**
 * Tests for src/encoders/vmix.js — VmixEncoder
 *
 * Strategy: override _vmix methods directly on the instance to avoid any
 * real network calls or dependency on the VMix constructor.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { VmixEncoder } = require('../src/encoders/vmix');

// ─── Constructor ──────────────────────────────────────────────────────────────

test('VmixEncoder constructor — default host and port', () => {
  const enc = new VmixEncoder();
  assert.ok(enc._vmix, '_vmix should be set');
  // VMix stores host/port internally; we verify defaults via the options used
  assert.equal(enc._vmix.host, 'localhost');
  assert.equal(enc._vmix.port, 8088);
});

test('VmixEncoder constructor — custom host and port', () => {
  const enc = new VmixEncoder({ host: '192.168.1.50', port: 9000 });
  assert.equal(enc._vmix.host, '192.168.1.50');
  assert.equal(enc._vmix.port, 9000);
});

// ─── connect / disconnect ────────────────────────────────────────────────────

test('connect() always returns true', async () => {
  const enc = new VmixEncoder();
  const result = await enc.connect();
  assert.equal(result, true);
});

test('disconnect() always returns true', async () => {
  const enc = new VmixEncoder();
  const result = await enc.disconnect();
  assert.equal(result, true);
});

// ─── isOnline() ───────────────────────────────────────────────────────────────

test('isOnline() delegates to _vmix.isRunning() and returns true', async () => {
  const enc = new VmixEncoder();
  enc._vmix.isRunning = async () => true;
  const result = await enc.isOnline();
  assert.equal(result, true);
});

test('isOnline() delegates to _vmix.isRunning() and returns false', async () => {
  const enc = new VmixEncoder();
  enc._vmix.isRunning = async () => false;
  const result = await enc.isOnline();
  assert.equal(result, false);
});

// ─── getStatus() — happy path ─────────────────────────────────────────────────

test('getStatus() returns type=vmix with correct shape', async () => {
  const enc = new VmixEncoder();
  enc._vmix.getStatus = async () => ({
    running: true,
    streaming: true,
    recording: false,
    edition: 'HD',
    version: '26.0',
  });
  const status = await enc.getStatus();
  assert.equal(status.type, 'vmix');
  assert.equal(status.connected, true);
  assert.equal(status.live, true);
  assert.equal(status.recording, false);
  assert.equal(status.bitrateKbps, null);
  assert.equal(status.fps, null);
  assert.equal(status.cpuUsage, null);
});

test('getStatus() — connected=false when running is falsy', async () => {
  const enc = new VmixEncoder();
  enc._vmix.getStatus = async () => ({
    running: false,
    streaming: false,
    recording: false,
    edition: 'HD',
    version: '26.0',
  });
  const status = await enc.getStatus();
  assert.equal(status.connected, false);
});

test('getStatus() — live=false when streaming is falsy', async () => {
  const enc = new VmixEncoder();
  enc._vmix.getStatus = async () => ({
    running: true,
    streaming: false,
    recording: false,
    edition: 'HD',
    version: '26.0',
  });
  const status = await enc.getStatus();
  assert.equal(status.live, false);
});

test('getStatus() — recording=true when recording is truthy', async () => {
  const enc = new VmixEncoder();
  enc._vmix.getStatus = async () => ({
    running: true,
    streaming: false,
    recording: true,
    edition: 'HD',
    version: '26.0',
  });
  const status = await enc.getStatus();
  assert.equal(status.recording, true);
});

test('getStatus() — details is "HD 26.0" when both edition and version present', async () => {
  const enc = new VmixEncoder();
  enc._vmix.getStatus = async () => ({
    running: true,
    streaming: false,
    recording: false,
    edition: 'HD',
    version: '26.0',
  });
  const status = await enc.getStatus();
  assert.equal(status.details, 'HD 26.0');
});

test('getStatus() — details is "HD" when version is absent', async () => {
  const enc = new VmixEncoder();
  enc._vmix.getStatus = async () => ({
    running: true,
    streaming: false,
    recording: false,
    edition: 'HD',
    version: '',
  });
  const status = await enc.getStatus();
  assert.equal(status.details, 'HD');
});

test('getStatus() — details is "vMix" when neither edition nor version present', async () => {
  const enc = new VmixEncoder();
  enc._vmix.getStatus = async () => ({
    running: true,
    streaming: false,
    recording: false,
    edition: '',
    version: '',
  });
  const status = await enc.getStatus();
  assert.equal(status.details, 'vMix');
});

test('getStatus() — bitrateKbps, fps, cpuUsage are always null', async () => {
  const enc = new VmixEncoder();
  enc._vmix.getStatus = async () => ({
    running: true,
    streaming: true,
    recording: true,
    edition: 'HD',
    version: '26.0',
  });
  const status = await enc.getStatus();
  assert.equal(status.bitrateKbps, null);
  assert.equal(status.fps, null);
  assert.equal(status.cpuUsage, null);
});

// ─── getStatus() — error fallback ─────────────────────────────────────────────

test('getStatus() returns disconnected fallback when _vmix.getStatus() throws', async () => {
  const enc = new VmixEncoder();
  enc._vmix.getStatus = async () => { throw new Error('connection refused'); };
  const status = await enc.getStatus();
  assert.equal(status.type, 'vmix');
  assert.equal(status.connected, false);
  assert.equal(status.live, false);
  assert.equal(status.recording, false);
  assert.equal(status.bitrateKbps, null);
  assert.equal(status.fps, null);
  assert.equal(status.cpuUsage, null);
  assert.equal(status.details, 'vMix');
});

// ─── startStream / stopStream ─────────────────────────────────────────────────

test('startStream() delegates to _vmix.startStream()', async () => {
  const enc = new VmixEncoder();
  let called = false;
  enc._vmix.startStream = async () => { called = true; return 'started'; };
  const result = await enc.startStream();
  assert.ok(called, '_vmix.startStream() should have been called');
  assert.equal(result, 'started');
});

test('stopStream() delegates to _vmix.stopStream()', async () => {
  const enc = new VmixEncoder();
  let called = false;
  enc._vmix.stopStream = async () => { called = true; return 'stopped'; };
  const result = await enc.stopStream();
  assert.ok(called, '_vmix.stopStream() should have been called');
  assert.equal(result, 'stopped');
});
