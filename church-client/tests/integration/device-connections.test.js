'use strict';

/**
 * Integration test suite — mock device connections
 *
 * Starts real mock TCP/HTTP servers and connects the actual church-client
 * driver modules to them.  No hardware required.
 *
 * Covered:
 *   VideoHub  — TCP text protocol, routing state, setRoute command
 *   SQ mixer  — TCP MIDI, muteChannel → verify NRPN bytes at server
 *   vMix      — HTTP XML API, startStream → streaming state flips
 *
 * Run:
 *   node --test tests/integration/device-connections.test.js
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');

const { MockVideoHub }   = require('../mock-devices/videohub');
const { MockAllenHeath } = require('../mock-devices/allenheath');
const { MockVmix }       = require('../mock-devices/vmix');

const { VideoHub }         = require('../../src/videohub');
const { AllenHeathMixer }  = require('../../src/mixers/allenheath');
const { VMix }             = require('../../src/vmix');

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Wait until predicate() returns true, polling every 10ms.
 * Rejects with a descriptive error after `timeoutMs`.
 */
function waitUntil(predicate, timeoutMs = 3000, label = 'condition') {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - start >= timeoutMs) {
        return reject(new Error(`Timeout (${timeoutMs}ms) waiting for: ${label}`));
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

/**
 * Wire a freshly constructed AllenHeathMixer to connect to `host:port`
 * instead of the hardcoded MIDI_PORT=51325.
 *
 * AllenHeathMixer hardcodes port 51325 in its constructor, so we patch
 * _tcp's port directly — the same technique the allenheath-wire.test.js
 * unit tests use to swap out the transport layer.
 *
 * Also suppresses _queryInitialState: that method runs ~6s of background
 * setTimeout chains (1000ms warm-up + batched queries).  Those pending
 * timers keep the Node.js process alive after the test, which disrupts
 * the test runner's IPC channel and produces spurious failures.
 */
function patchMixerPort(mixer, host, port) {
  mixer._tcp.host = host;
  mixer._tcp.port = port;
  mixer._tcp.autoReconnect = false;          // no reconnect loops during tests
  mixer._queryInitialState = async () => {}; // suppress slow background query
}

// ─── VIDEOHUB TESTS ───────────────────────────────────────────────────────────

test('VideoHub: connects and populates routing state from mock server', async (t) => {
  const mock = new MockVideoHub();
  const port = await mock.start();

  const hub = new VideoHub({ ip: '127.0.0.1', port, name: 'test-hub' });

  try {
    await hub.connect();

    // Wait for the full initial state exchange (preamble → labels + routing)
    await waitUntil(
      () => hub._routes.size > 0 && hub._inputLabels.size > 0 && hub._outputLabels.size > 0,
      3000,
      'VideoHub initial state populated',
    );

    // Routing should match the mock's default (0→0, 1→1, 2→2, 3→3)
    assert.equal(hub._routes.get(0), 0, 'output 0 → input 0');
    assert.equal(hub._routes.get(1), 1, 'output 1 → input 1');
    assert.equal(hub._routes.get(2), 2, 'output 2 → input 2');
    assert.equal(hub._routes.get(3), 3, 'output 3 → input 3');

    // Labels should match the mock's default names
    assert.equal(hub._inputLabels.get(0),  'Camera 1',  'input 0 label');
    assert.equal(hub._outputLabels.get(0), 'Monitor 1', 'output 0 label');
  } finally {
    await hub.disconnect();
    await mock.stop();
  }
});

test('VideoHub: setRoute command updates routing on both client and server', async (t) => {
  const mock = new MockVideoHub();
  const port = await mock.start();

  const hub = new VideoHub({ ip: '127.0.0.1', port, name: 'test-hub' });

  try {
    await hub.connect();

    // Wait for initial state
    await waitUntil(() => hub._routes.size > 0, 3000, 'VideoHub initial state');

    // Route output 0 to input 2 (was input 0)
    const ok = await hub.setRoute(0, 2);
    assert.ok(ok, 'setRoute should return true on success');

    // Client state updated
    assert.equal(hub._routes.get(0), 2, 'client: output 0 → input 2');

    // Server state updated
    assert.equal(mock.getRouting()[0], 2, 'server: output 0 → input 2');
  } finally {
    await hub.disconnect();
    await mock.stop();
  }
});

test('VideoHub: getRoutes() returns enriched route objects', async (t) => {
  const mock = new MockVideoHub();
  const port = await mock.start();
  const hub  = new VideoHub({ ip: '127.0.0.1', port, name: 'test-hub' });

  try {
    await hub.connect();
    await waitUntil(() => hub._routes.size > 0, 3000, 'VideoHub initial state');

    const routes = await hub.getRoutes();
    assert.ok(Array.isArray(routes), 'getRoutes returns array');
    assert.ok(routes.length > 0, 'routes array not empty');

    const r0 = routes.find((r) => r.output === 0);
    assert.ok(r0, 'route for output 0 present');
    assert.equal(r0.outputLabel, 'Monitor 1', 'output label resolved');
    assert.equal(r0.inputLabel,  'Camera 1',  'input label resolved');
  } finally {
    await hub.disconnect();
    await mock.stop();
  }
});

// ─── ALLEN & HEATH SQ TESTS ───────────────────────────────────────────────────

test('SQ mixer: muteChannel(1) sends correct 12-byte NRPN to server', async (t) => {
  const mock = new MockAllenHeath();
  const port = await mock.start();

  const mixer = new AllenHeathMixer({ host: '127.0.0.1', model: 'SQ6', midiChannel: 0 });
  patchMixerPort(mixer, '127.0.0.1', port);

  try {
    await mixer._tcp.connect();
    mixer._online = true;

    // NRPN for input channel 1 mute:
    //   param = nrpn1D(0x00, 0x00, 0) = { msb: 0x00, lsb: 0x00 }
    //   mute=true → vc=0x00, vf=0x01
    const nrpnPromise = mock.waitForNrpn(0x00, 0x00, 2000);
    await mixer.muteChannel(1);

    await nrpnPromise;

    // Mute state tracked on server
    assert.ok(mock.getMuteState(0x00, 0x00), 'server: channel 1 muted');

    // Exactly 12 bytes should have been received (one NRPN set)
    const bytes = mock.getReceivedBytes();
    assert.equal(bytes.length, 12, '12 bytes for one NRPN set message');

    // Verify wire format
    const cc = 0xB0; // MIDI ch 0
    assert.equal(bytes[0],  cc,    'CC status byte');
    assert.equal(bytes[1],  0x63,  'NRPN MSB controller');
    assert.equal(bytes[2],  0x00,  'param MSB = 0x00');
    assert.equal(bytes[4],  0x62,  'NRPN LSB controller');
    assert.equal(bytes[5],  0x00,  'param LSB = 0x00');
    assert.equal(bytes[11], 0x01,  'vf = 0x01 (muted)');
  } finally {
    await mixer.disconnect();
    await mock.stop();
  }
});

test('SQ mixer: unmuteChannel(1) sends vf=0x00', async (t) => {
  const mock = new MockAllenHeath();
  const port = await mock.start();

  const mixer = new AllenHeathMixer({ host: '127.0.0.1', model: 'SQ6', midiChannel: 0 });
  patchMixerPort(mixer, '127.0.0.1', port);

  try {
    await mixer._tcp.connect();
    mixer._online = true;

    await mixer.muteChannel(1);
    // Wait until the mute bytes have arrived at the server before clearing,
    // otherwise they land in the same TCP frame as the unmute and the
    // waitForNrpn promise resolves on the mute event instead of the unmute.
    await mock.waitForBytes(12);
    mock.clearReceivedBytes();

    const nrpnPromise = mock.waitForNrpn(0x00, 0x00, 2000);
    await mixer.unmuteChannel(1);
    await nrpnPromise;

    assert.ok(!mock.getMuteState(0x00, 0x00), 'server: channel 1 unmuted');
    const bytes = mock.getReceivedBytes();
    assert.equal(bytes[11], 0x00, 'vf = 0x00 (unmuted)');
  } finally {
    await mixer.disconnect();
    await mock.stop();
  }
});

test('SQ mixer: muteChannel(5) uses correct param LSB=4', async (t) => {
  const mock = new MockAllenHeath();
  const port = await mock.start();

  const mixer = new AllenHeathMixer({ host: '127.0.0.1', model: 'SQ6', midiChannel: 0 });
  patchMixerPort(mixer, '127.0.0.1', port);

  try {
    await mixer._tcp.connect();
    mixer._online = true;

    // Channel 5 = 0-based index 4 → nrpn(0,0)+4 = { msb:0, lsb:4 }
    const nrpnPromise = mock.waitForNrpn(0x00, 0x04, 2000);
    await mixer.muteChannel(5);
    await nrpnPromise;

    assert.ok(mock.getMuteState(0x00, 0x04), 'server: channel 5 muted');
    const bytes = mock.getReceivedBytes();
    assert.equal(bytes[5], 0x04, 'param LSB = 4 for channel 5');
  } finally {
    await mixer.disconnect();
    await mock.stop();
  }
});

test('SQ mixer: setFader(1, 1.0) sends max 14-bit value', async (t) => {
  const mock = new MockAllenHeath();
  const port = await mock.start();

  const mixer = new AllenHeathMixer({ host: '127.0.0.1', model: 'SQ6', midiChannel: 0 });
  patchMixerPort(mixer, '127.0.0.1', port);

  try {
    await mixer._tcp.connect();
    mixer._online = true;

    // inputToLr base: msb=0x40, lsb=0x00; ch1 = index 0 → same address
    const nrpnPromise = mock.waitForNrpn(0x40, 0x00, 2000);
    await mixer.setFader(1, 1.0);
    await nrpnPromise;

    const level = mock.getFaderLevel(0x40, 0x00);
    assert.equal(level, 16383, 'fader at max (16383 = 0x3FFF)');
  } finally {
    await mixer.disconnect();
    await mock.stop();
  }
});

// ─── VMIX TESTS ───────────────────────────────────────────────────────────────

test('vMix: isRunning() returns true when mock server is up', async (t) => {
  const mock = new MockVmix();
  const port = await mock.start();

  const vmix = new VMix({ host: '127.0.0.1', port });

  try {
    const running = await vmix.isRunning();
    assert.ok(running, 'vMix reports as running');
  } finally {
    await mock.stop();
  }
});

test('vMix: getState() parses XML and returns correct structure', async (t) => {
  const mock = new MockVmix();
  const port = await mock.start();
  const vmix = new VMix({ host: '127.0.0.1', port });

  try {
    const state = await vmix.getState(true);
    assert.ok(state, 'getState returns object');
    assert.equal(typeof state.streaming,  'boolean', 'streaming is boolean');
    assert.equal(typeof state.recording,  'boolean', 'recording is boolean');
    assert.equal(state.version,  '26.0.0.58', 'version parsed');
    assert.equal(state.edition,  'HD',         'edition parsed');
    assert.ok(Array.isArray(state.inputs),   'inputs is array');
    assert.ok(state.inputs.length > 0,       'at least one input');
    assert.equal(state.inputs[0].title, 'Camera 1', 'first input title');
  } finally {
    await mock.stop();
  }
});

test('vMix: startStream() flips streaming state on mock server', async (t) => {
  const mock = new MockVmix();
  const port = await mock.start();
  const vmix = new VMix({ host: '127.0.0.1', port });

  try {
    // Confirm initially not streaming
    const before = await vmix.getState(true);
    assert.equal(before.streaming, false, 'not streaming before');

    await vmix.startStream();

    // Server-side state update
    assert.ok(mock.getState().streaming, 'mock server: streaming=true');

    // Client re-fetches and sees updated state
    const after = await vmix.getState(true);
    assert.equal(after.streaming, true, 'client: streaming=true after startStream');
  } finally {
    await mock.stop();
  }
});

test('vMix: stopStream() flips streaming state back', async (t) => {
  const mock = new MockVmix();
  const port = await mock.start();
  const vmix = new VMix({ host: '127.0.0.1', port });

  try {
    mock.setStreaming(true);
    await vmix.stopStream();
    assert.ok(!mock.getState().streaming, 'mock server: streaming=false after stopStream');
  } finally {
    await mock.stop();
  }
});

test('vMix: startStream records call in server call log', async (t) => {
  const mock = new MockVmix();
  const port = await mock.start();
  const vmix = new VMix({ host: '127.0.0.1', port });

  try {
    mock.clearCallLog();
    await vmix.startStream();
    assert.ok(mock.getCallLog().includes('StartStreaming'), 'StartStreaming recorded in call log');
  } finally {
    await mock.stop();
  }
});

test('vMix: startRecording / stopRecording toggle recording state', async (t) => {
  const mock = new MockVmix();
  const port = await mock.start();
  const vmix = new VMix({ host: '127.0.0.1', port });

  try {
    await vmix.startRecording();
    assert.ok(mock.getState().recording, 'recording=true after startRecording');

    await vmix.stopRecording();
    assert.ok(!mock.getState().recording, 'recording=false after stopRecording');
  } finally {
    await mock.stop();
  }
});

test('vMix: returns null state when server is down', async (t) => {
  // Intentionally connect to a port with nothing listening
  const vmix = new VMix({ host: '127.0.0.1', port: 19999 });
  const running = await vmix.isRunning();
  assert.ok(!running, 'isRunning() = false with no server');
});
