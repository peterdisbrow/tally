/**
 * Tests for EcammEncoder.
 * The _get method is mocked to avoid real HTTP connections.
 * Tests focus on behavior: how the encoder interprets Ecamm's HTTP responses.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { EcammEncoder } = require('../src/encoders/ecamm');

function makeEncoder(overrides = {}) {
  const enc = new EcammEncoder({ host: '127.0.0.1', port: 65194, ...overrides });
  return enc;
}

// Helper: mock _get on an encoder instance
function mockGet(enc, response) {
  enc._get = async () => response;
}

function mockGetSequence(enc, responses) {
  let i = 0;
  enc._get = async () => responses[i++] || { ok: false, data: null };
}

// ─── Constructor ──────────────────────────────────────────────────────────────

describe('EcammEncoder constructor', () => {
  it('sets default host and port', () => {
    const enc = new EcammEncoder();
    assert.equal(enc.host, 'localhost');
    assert.equal(enc.port, 65194);
  });

  it('accepts custom host and port', () => {
    const enc = new EcammEncoder({ host: '10.0.0.5', port: 12345 });
    assert.equal(enc.host, '10.0.0.5');
    assert.equal(enc.port, 12345);
  });

  it('starts with disconnected state', () => {
    const enc = makeEncoder();
    assert.equal(enc._connected, false);
  });
});

// ─── disconnect() ─────────────────────────────────────────────────────────────

describe('EcammEncoder.disconnect()', () => {
  it('sets _connected to false and returns true', async () => {
    const enc = makeEncoder();
    enc._connected = true;
    const result = await enc.disconnect();
    assert.equal(result, true);
    assert.equal(enc._connected, false);
  });
});

// ─── isOnline() ────────────────────────────────────────────────────────────────

describe('EcammEncoder.isOnline()', () => {
  it('returns true when _get succeeds with ok:true', async () => {
    const enc = makeEncoder();
    mockGet(enc, { ok: true, data: { Product: 'Ecamm Live' } });
    const result = await enc.isOnline();
    assert.equal(result, true);
    assert.equal(enc._connected, true);
  });

  it('returns false when _get fails', async () => {
    const enc = makeEncoder();
    mockGet(enc, { ok: false, data: null });
    const result = await enc.isOnline();
    assert.equal(result, false);
    assert.equal(enc._connected, false);
  });

  it('stores returned data in _info', async () => {
    const enc = makeEncoder();
    const info = { Product: 'Ecamm Live', Version: '4.11' };
    mockGet(enc, { ok: true, data: info });
    await enc.isOnline();
    assert.deepEqual(enc._info, info);
  });
});

// ─── getStatus() — not connected ──────────────────────────────────────────────

describe('EcammEncoder.getStatus() — not connected', () => {
  it('returns type=ecamm with connected:false when _get fails', async () => {
    const enc = makeEncoder();
    mockGet(enc, { ok: false, data: null });
    const status = await enc.getStatus();
    assert.equal(status.type, 'ecamm');
    assert.equal(status.connected, false);
    assert.equal(status.live, false);
    assert.equal(status.recording, false);
    assert.equal(status.bitrateKbps, null);
    assert.equal(status.fps, null);
  });
});

// ─── getStatus() — live states ────────────────────────────────────────────────

describe('EcammEncoder.getStatus() — live detection via ButtonLabel', () => {
  it('detects live=true when ButtonLabel contains "end"', async () => {
    const enc = makeEncoder();
    mockGet(enc, { ok: true, data: { ButtonLabel: 'End Broadcast', Viewers: '0' } });
    const status = await enc.getStatus();
    assert.equal(status.live, true);
    assert.equal(status.connected, true);
  });

  it('detects live=false when ButtonLabel is "Go Live"', async () => {
    const enc = makeEncoder();
    mockGet(enc, { ok: true, data: { ButtonLabel: 'Go Live', Viewers: '0' } });
    const status = await enc.getStatus();
    assert.equal(status.live, false);
  });

  it('detects live=true when ButtonLabel contains "stop broadcast"', async () => {
    const enc = makeEncoder();
    mockGet(enc, { ok: true, data: { ButtonLabel: 'Stop Broadcast', Viewers: '0' } });
    const status = await enc.getStatus();
    assert.equal(status.live, true);
  });

  it('detects recording=true when ButtonLabel contains "stop recording"', async () => {
    const enc = makeEncoder();
    mockGet(enc, { ok: true, data: { ButtonLabel: 'Stop Recording', Viewers: '0' } });
    const status = await enc.getStatus();
    assert.equal(status.recording, true);
  });

  it('detects recording=false when ButtonLabel is "Start Recording"', async () => {
    const enc = makeEncoder();
    mockGet(enc, { ok: true, data: { ButtonLabel: 'Start Recording', Viewers: '0' } });
    const status = await enc.getStatus();
    assert.equal(status.recording, false);
  });
});

describe('EcammEncoder.getStatus() — viewer count and mute', () => {
  it('parses viewer count from Viewers field', async () => {
    const enc = makeEncoder();
    mockGet(enc, { ok: true, data: { ButtonLabel: 'End Broadcast', Viewers: '150' } });
    const status = await enc.getStatus();
    assert.ok(status.details.includes('150 viewers'));
  });

  it('shows "Muted" in details when Mute is truthy', async () => {
    const enc = makeEncoder();
    mockGet(enc, { ok: true, data: { ButtonLabel: 'End Broadcast', Mute: 1, Viewers: '0' } });
    const status = await enc.getStatus();
    assert.ok(status.details.includes('Muted'));
  });

  it('does not show Muted when Mute is falsy', async () => {
    const enc = makeEncoder();
    mockGet(enc, { ok: true, data: { ButtonLabel: 'Go Live', Mute: 0, Viewers: '0' } });
    const status = await enc.getStatus();
    assert.ok(!status.details.includes('Muted'));
  });

  it('shows LIVE in details when streaming', async () => {
    const enc = makeEncoder();
    mockGet(enc, { ok: true, data: { ButtonLabel: 'End Broadcast', Viewers: '0' } });
    const status = await enc.getStatus();
    assert.ok(status.details.includes('LIVE'));
  });

  it('shows Recording in details when recording', async () => {
    const enc = makeEncoder();
    mockGet(enc, { ok: true, data: { ButtonLabel: 'Stop Recording', Viewers: '0' } });
    const status = await enc.getStatus();
    assert.ok(status.details.includes('Recording'));
  });

  it('defaults to 0 viewers when Viewers field is missing', async () => {
    const enc = makeEncoder();
    mockGet(enc, { ok: true, data: { ButtonLabel: 'Go Live' } });
    const status = await enc.getStatus();
    // No viewers → not shown in details
    assert.ok(!status.details.includes('viewer'));
  });
});

// ─── startStream() ────────────────────────────────────────────────────────────

describe('EcammEncoder.startStream()', () => {
  it('returns already live when getStatus reports live=true', async () => {
    const enc = makeEncoder();
    // First call is getStatus (via isOnline path)
    mockGet(enc, { ok: true, data: { ButtonLabel: 'End Broadcast', Viewers: '0' } });
    const result = await enc.startStream();
    assert.deepEqual(result, { ok: true, data: 'already live' });
  });

  it('calls /setClickButton when not live', async () => {
    const enc = makeEncoder();
    const calls = [];
    enc._get = async (path) => {
      calls.push(path);
      if (path === '/getInfo') return { ok: true, data: { ButtonLabel: 'Go Live', Viewers: '0' } };
      return { ok: true, data: null };
    };
    await enc.startStream();
    assert.ok(calls.some(p => p === '/setClickButton'), `Expected /setClickButton in calls: ${calls.join(', ')}`);
  });
});

// ─── stopStream() ─────────────────────────────────────────────────────────────

describe('EcammEncoder.stopStream()', () => {
  it('returns not live when getStatus reports live=false', async () => {
    const enc = makeEncoder();
    mockGet(enc, { ok: true, data: { ButtonLabel: 'Go Live', Viewers: '0' } });
    const result = await enc.stopStream();
    assert.deepEqual(result, { ok: true, data: 'not live' });
  });

  it('calls /setClickButton when live', async () => {
    const enc = makeEncoder();
    const calls = [];
    enc._get = async (path) => {
      calls.push(path);
      if (path === '/getInfo') return { ok: true, data: { ButtonLabel: 'End Broadcast', Viewers: '0' } };
      return { ok: true, data: null };
    };
    await enc.stopStream();
    assert.ok(calls.some(p => p === '/setClickButton'));
  });
});

// ─── Scene control ─────────────────────────────────────────────────────────────

describe('EcammEncoder.getScenes()', () => {
  it('returns items array when response contains items', async () => {
    const enc = makeEncoder();
    const scenes = [{ id: 's1', name: 'Scene 1' }, { id: 's2', name: 'Scene 2' }];
    enc._get = async () => ({ ok: true, data: { items: scenes } });
    const result = await enc.getScenes();
    assert.deepEqual(result, scenes);
    assert.deepEqual(enc._scenes, scenes);
  });

  it('returns empty array when _get fails', async () => {
    const enc = makeEncoder();
    enc._get = async () => ({ ok: false, data: null });
    const result = await enc.getScenes();
    assert.deepEqual(result, []);
  });

  it('returns empty array when data has no items', async () => {
    const enc = makeEncoder();
    enc._get = async () => ({ ok: true, data: {} });
    const result = await enc.getScenes();
    assert.deepEqual(result, []);
  });
});

describe('EcammEncoder.setScene()', () => {
  it('calls _get with encoded scene UUID', async () => {
    const enc = makeEncoder();
    const calls = [];
    enc._get = async (path) => { calls.push(path); return { ok: true, data: null }; };
    await enc.setScene('scene-uuid-123');
    assert.ok(calls.some(p => p.includes('scene-uuid-123')));
    assert.ok(calls.some(p => p.includes('/setScene')));
  });

  it('URL-encodes the UUID', async () => {
    const enc = makeEncoder();
    const calls = [];
    enc._get = async (path) => { calls.push(path); return { ok: true, data: null }; };
    await enc.setScene('uuid with spaces');
    assert.ok(calls[0].includes('uuid%20with%20spaces'));
  });
});

describe('EcammEncoder.nextScene() / prevScene()', () => {
  it('nextScene calls /setNext', async () => {
    const enc = makeEncoder();
    const calls = [];
    enc._get = async (path) => { calls.push(path); return { ok: true, data: null }; };
    await enc.nextScene();
    assert.equal(calls[0], '/setNext');
  });

  it('prevScene calls /setPrev', async () => {
    const enc = makeEncoder();
    const calls = [];
    enc._get = async (path) => { calls.push(path); return { ok: true, data: null }; };
    await enc.prevScene();
    assert.equal(calls[0], '/setPrev');
  });
});

// ─── Audio / input / overlay control ──────────────────────────────────────────

describe('EcammEncoder.toggleMute()', () => {
  it('calls /setMute', async () => {
    const enc = makeEncoder();
    const calls = [];
    enc._get = async (path) => { calls.push(path); return { ok: true }; };
    await enc.toggleMute();
    assert.equal(calls[0], '/setMute');
  });
});

describe('EcammEncoder.getInputs()', () => {
  it('returns items when available', async () => {
    const enc = makeEncoder();
    enc._get = async () => ({ ok: true, data: { items: [{ id: 'i1', name: 'Webcam' }] } });
    const result = await enc.getInputs();
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'Webcam');
  });

  it('returns empty array on failure', async () => {
    const enc = makeEncoder();
    enc._get = async () => ({ ok: false, data: null });
    const result = await enc.getInputs();
    assert.deepEqual(result, []);
  });
});

describe('EcammEncoder.setInput()', () => {
  it('calls _get with encoded input UUID', async () => {
    const enc = makeEncoder();
    const calls = [];
    enc._get = async (path) => { calls.push(path); return { ok: true }; };
    await enc.setInput('input-uuid-456');
    assert.ok(calls[0].includes('/setInput'));
    assert.ok(calls[0].includes('input-uuid-456'));
  });
});

describe('EcammEncoder.getOverlays()', () => {
  it('returns items when available', async () => {
    const enc = makeEncoder();
    enc._get = async () => ({ ok: true, data: { items: [{ id: 'o1', name: 'Lower Third' }] } });
    const result = await enc.getOverlays();
    assert.equal(result.length, 1);
  });

  it('returns empty array when no overlays', async () => {
    const enc = makeEncoder();
    enc._get = async () => ({ ok: true, data: {} });
    const result = await enc.getOverlays();
    assert.deepEqual(result, []);
  });
});

describe('EcammEncoder.togglePIP() / togglePause()', () => {
  it('togglePIP calls /setPIP', async () => {
    const enc = makeEncoder();
    const calls = [];
    enc._get = async (path) => { calls.push(path); return { ok: true }; };
    await enc.togglePIP();
    assert.equal(calls[0], '/setPIP');
  });

  it('togglePause calls /setClickPauseButton', async () => {
    const enc = makeEncoder();
    const calls = [];
    enc._get = async (path) => { calls.push(path); return { ok: true }; };
    await enc.togglePause();
    assert.equal(calls[0], '/setClickPauseButton');
  });
});

// ─── connect() ────────────────────────────────────────────────────────────────

describe('EcammEncoder.connect()', () => {
  it('delegates to isOnline()', async () => {
    const enc = makeEncoder();
    let isOnlineCalled = false;
    enc.isOnline = async () => { isOnlineCalled = true; return true; };
    await enc.connect();
    assert.equal(isOnlineCalled, true);
  });
});
