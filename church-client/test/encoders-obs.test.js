'use strict';

/**
 * ObsEncoder tests
 *
 * Covers: constructor, setObs, connect (when _obs already set), disconnect,
 *         isOnline, getStatus (disconnected + connected), startStream, stopStream.
 *
 * We never open a real WebSocket. Instead we inject mock _obs objects directly.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

const { ObsEncoder } = require('../src/encoders/obs');

// ── helpers ─────────────────────────────────────────────────────────────────

function makeMockObs(stats = {}, stream = {}, record = {}) {
  return {
    identified: true,
    call: async (method) => {
      if (method === 'GetStats')
        return { activeFps: 30, cpuUsage: 0.25, ...stats };
      if (method === 'GetStreamStatus')
        return { outputActive: true, outputBytes: 5_000_000, outputCongestion: 0.1, ...stream };
      if (method === 'GetRecordStatus')
        return { outputActive: false, ...record };
      throw new Error(`Unknown method: ${method}`);
    },
    on: () => {},
    disconnect: () => {},
  };
}

// ── 1. Constructor ────────────────────────────────────────────────────────────

test('ObsEncoder: default constructor values', () => {
  const enc = new ObsEncoder();
  assert.equal(enc.host, 'localhost');
  assert.equal(enc.port, 4455);
  assert.equal(enc.password, '');
});

test('ObsEncoder: custom constructor values', () => {
  const enc = new ObsEncoder({ host: '192.168.1.10', port: 9000, password: 'secret' });
  assert.equal(enc.host, '192.168.1.10');
  assert.equal(enc.port, 9000);
  assert.equal(enc.password, 'secret');
});

test('ObsEncoder: starts with _connected=false and _obs=null', () => {
  const enc = new ObsEncoder();
  assert.equal(enc._connected, false);
  assert.equal(enc._obs, null);
});

// ── 2. setObs() ───────────────────────────────────────────────────────────────

test('setObs: null → _obs=null, _connected=false', () => {
  const enc = new ObsEncoder();
  enc.setObs(null);
  assert.equal(enc._obs, null);
  assert.equal(enc._connected, false);
});

test('setObs: { identified: true } → _connected=true', () => {
  const enc = new ObsEncoder();
  enc.setObs({ identified: true });
  assert.equal(enc._connected, true);
});

test('setObs: { identified: false } → _connected=false', () => {
  const enc = new ObsEncoder();
  enc.setObs({ identified: false });
  assert.equal(enc._connected, false);
});

test('setObs: { identified: undefined } → _connected=false (falsy)', () => {
  const enc = new ObsEncoder();
  enc.setObs({ identified: undefined });
  assert.equal(enc._connected, false);
});

// ── 3. connect() — when _obs already set ─────────────────────────────────────

test('connect: when _obs is set and _connected=true → returns true without creating new obs', async () => {
  const enc = new ObsEncoder();
  const mockObs = makeMockObs();
  enc._obs = mockObs;
  enc._connected = true;

  const result = await enc.connect();
  assert.equal(result, true);
  assert.equal(enc._obs, mockObs, 'should not replace _obs when already set');
});

test('connect: when _obs is set and _connected=false → returns false', async () => {
  const enc = new ObsEncoder();
  enc._obs = makeMockObs();
  enc._connected = false;

  const result = await enc.connect();
  assert.equal(result, false);
});

// ── 4. disconnect() ───────────────────────────────────────────────────────────

test('disconnect: sets _obs=null and _connected=false', async () => {
  const enc = new ObsEncoder();
  enc._obs = makeMockObs();
  enc._connected = true;

  await enc.disconnect();
  assert.equal(enc._obs, null);
  assert.equal(enc._connected, false);
});

test('disconnect: works when _obs is already null (no error)', async () => {
  const enc = new ObsEncoder();
  enc._obs = null;
  // Should not throw
  await enc.disconnect();
  assert.equal(enc._obs, null);
  assert.equal(enc._connected, false);
});

test('disconnect: calls _obs.disconnect() for cleanup', async () => {
  const enc = new ObsEncoder();
  let disconnectCalled = false;
  enc._obs = { ...makeMockObs(), disconnect: () => { disconnectCalled = true; } };
  enc._connected = true;

  await enc.disconnect();
  assert.ok(disconnectCalled, 'should call _obs.disconnect()');
});

// ── 5. isOnline() ────────────────────────────────────────────────────────────

test('isOnline: returns _connected=true when connected', async () => {
  const enc = new ObsEncoder();
  enc._connected = true;
  assert.equal(await enc.isOnline(), true);
});

test('isOnline: returns _connected=false when not connected', async () => {
  const enc = new ObsEncoder();
  enc._connected = false;
  assert.equal(await enc.isOnline(), false);
});

// ── 6. getStatus() — disconnected ────────────────────────────────────────────

test('getStatus: disconnected returns correct shape', async () => {
  const enc = new ObsEncoder();
  const status = await enc.getStatus();
  assert.deepEqual(status, {
    type: 'obs',
    connected: false,
    live: false,
    bitrateKbps: null,
    fps: null,
    cpuUsage: null,
    recording: false,
    details: 'OBS Studio',
  });
});

// ── 7. getStatus() — connected with mocked obs ────────────────────────────────

test('getStatus connected: sets fps correctly (Math.round)', async () => {
  const enc = new ObsEncoder();
  enc._obs = makeMockObs({ activeFps: 29.97 });
  enc._connected = true;

  const status = await enc.getStatus();
  assert.equal(status.fps, 30);
});

test('getStatus connected: sets cpuUsage correctly (Math.round * 100 / 100)', async () => {
  const enc = new ObsEncoder();
  enc._obs = makeMockObs({ cpuUsage: 12.3456 });
  enc._connected = true;

  const status = await enc.getStatus();
  // Math.round(12.3456 * 100) / 100 = Math.round(1234.56) / 100 = 1235 / 100 = 12.35
  assert.equal(status.cpuUsage, 12.35);
});

test('getStatus connected: sets live from GetStreamStatus outputActive', async () => {
  const enc = new ObsEncoder();
  enc._obs = makeMockObs({}, { outputActive: true });
  enc._connected = true;

  const status = await enc.getStatus();
  assert.equal(status.live, true);
});

test('getStatus connected: sets live=false when outputActive=false', async () => {
  const enc = new ObsEncoder();
  enc._obs = makeMockObs({}, { outputActive: false });
  enc._connected = true;

  const status = await enc.getStatus();
  assert.equal(status.live, false);
});

test('getStatus connected: sets recording from GetRecordStatus outputActive', async () => {
  const enc = new ObsEncoder();
  enc._obs = makeMockObs({}, {}, { outputActive: true });
  enc._connected = true;

  const status = await enc.getStatus();
  assert.equal(status.recording, true);
});

test('getStatus connected: calculates bitrate between two calls', async () => {
  const enc = new ObsEncoder();
  enc._obs = makeMockObs({}, { outputBytes: 10_000_000 });
  enc._connected = true;

  // Simulate a previous call: 5 MB received 2 seconds ago
  enc._lastBytesTotal = 5_000_000;
  enc._lastBytesTime  = Date.now() - 2000;

  const status = await enc.getStatus();
  // (10_000_000 - 5_000_000) * 8 bits / 1024 / 2 seconds = 19531 kbps
  assert.ok(
    typeof status.bitrateKbps === 'number' && status.bitrateKbps > 0,
    `bitrateKbps should be a positive number, got ${status.bitrateKbps}`
  );
});

test('getStatus connected: when GetStats throws → still returns connected status', async () => {
  const enc = new ObsEncoder();
  let callCount = 0;
  enc._obs = {
    ...makeMockObs(),
    call: async (method) => {
      if (method === 'GetStats') throw new Error('GetStats failed');
      if (method === 'GetStreamStatus') return { outputActive: false, outputBytes: 0, outputCongestion: 0 };
      if (method === 'GetRecordStatus') return { outputActive: false };
      callCount++;
    },
  };
  enc._connected = true;

  const status = await enc.getStatus();
  assert.equal(status.connected, true);
  assert.equal(status.type, 'obs');
});

test('getStatus connected: when GetStreamStatus throws → still returns connected status', async () => {
  const enc = new ObsEncoder();
  enc._obs = {
    ...makeMockObs(),
    call: async (method) => {
      if (method === 'GetStats') return { activeFps: 30, cpuUsage: 0.1 };
      if (method === 'GetStreamStatus') throw new Error('GetStreamStatus failed');
      if (method === 'GetRecordStatus') return { outputActive: false };
    },
  };
  enc._connected = true;

  const status = await enc.getStatus();
  assert.equal(status.connected, true);
});

test('getStatus connected: when GetRecordStatus throws → still returns connected status', async () => {
  const enc = new ObsEncoder();
  enc._obs = {
    ...makeMockObs(),
    call: async (method) => {
      if (method === 'GetStats') return { activeFps: 30, cpuUsage: 0.1 };
      if (method === 'GetStreamStatus') return { outputActive: true, outputBytes: 0, outputCongestion: 0 };
      if (method === 'GetRecordStatus') throw new Error('GetRecordStatus failed');
    },
  };
  enc._connected = true;

  const status = await enc.getStatus();
  assert.equal(status.connected, true);
});

// ── 8. startStream() / stopStream() ──────────────────────────────────────────

test('startStream: when _obs set, calls _obs.call("StartStream")', async () => {
  const enc = new ObsEncoder();
  const calls = [];
  enc._obs = { ...makeMockObs(), call: async (method) => { calls.push(method); } };

  await enc.startStream();
  assert.ok(calls.includes('StartStream'), 'should call StartStream on _obs');
});

test('stopStream: when _obs set, calls _obs.call("StopStream")', async () => {
  const enc = new ObsEncoder();
  const calls = [];
  enc._obs = { ...makeMockObs(), call: async (method) => { calls.push(method); } };

  await enc.stopStream();
  assert.ok(calls.includes('StopStream'), 'should call StopStream on _obs');
});

test('startStream: when _obs=null, does nothing (no error)', async () => {
  const enc = new ObsEncoder();
  enc._obs = null;
  // Should not throw
  await enc.startStream();
});
