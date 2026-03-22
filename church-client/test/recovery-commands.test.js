const test = require('node:test');
const assert = require('node:assert/strict');

const { commandHandlers } = require('../src/commands');

// ─── Registration ─────────────────────────────────────────────────────────────

test('all recovery commands are registered', () => {
  const expected = [
    'recovery.restartStream', 'recovery.restartRecording',
    'recovery.reconnectDevice', 'recovery.restartEncoder', 'recovery.resetAudio',
  ];
  for (const name of expected) {
    assert.ok(commandHandlers[name], `${name} should be registered`);
  }
});

// ─── recovery.restartStream ───────────────────────────────────────────────────

test('recovery.restartStream throws when no streaming device available', async () => {
  await assert.rejects(
    () => commandHandlers['recovery.restartStream']({}, {}),
    /No streaming device available/
  );
});

test('recovery.restartStream restarts OBS: stop, wait, start', { timeout: 5000 }, async () => {
  const calls = [];
  const agent = {
    obs: { call: async (m) => { calls.push(m); } },
    status: { obs: { connected: true } },
  };
  const result = await commandHandlers['recovery.restartStream'](agent, { source: 'obs' });
  assert.ok(calls.includes('StopStream'), 'should call StopStream');
  assert.ok(calls.includes('StartStream'), 'should call StartStream');
  assert.ok(result.includes('OBS stream restarted'));
});

test('recovery.restartStream continues even if StopStream throws', { timeout: 5000 }, async () => {
  const calls = [];
  const agent = {
    obs: {
      call: async (m) => {
        calls.push(m);
        if (m === 'StopStream') throw new Error('already stopped');
      },
    },
    status: { obs: { connected: true } },
  };
  const result = await commandHandlers['recovery.restartStream'](agent, { source: 'obs' });
  assert.ok(calls.includes('StartStream'), 'StartStream should still be called');
  assert.ok(result.includes('restarted'));
});

test('recovery.restartStream auto-detects OBS when no source specified', { timeout: 5000 }, async () => {
  const calls = [];
  const agent = {
    obs: { call: async (m) => { calls.push(m); } },
    status: { obs: { connected: true } },
  };
  const result = await commandHandlers['recovery.restartStream'](agent, {});
  assert.ok(calls.includes('StartStream'));
  assert.ok(result.includes('OBS'));
});

test('recovery.restartStream ATEM throws when stopStreaming not supported', async () => {
  const agent = {
    atem: { startStreaming: async () => {} }, // no stopStreaming
    status: { atem: { connected: true } },
  };
  await assert.rejects(
    () => commandHandlers['recovery.restartStream'](agent, { source: 'atem' }),
    /does not support remote streaming control/
  );
});

test('recovery.restartStream vMix throws when stopStream/startStream methods missing', async () => {
  const agent = {
    vmix: {}, // no stopStream or startStream
    status: { vmix: { connected: true } },
  };
  await assert.rejects(
    () => commandHandlers['recovery.restartStream'](agent, { source: 'vmix' }),
    /does not support stopStream\/startStream/
  );
});

// ─── recovery.restartRecording ────────────────────────────────────────────────

test('recovery.restartRecording throws when no recording device available', async () => {
  await assert.rejects(
    () => commandHandlers['recovery.restartRecording']({}, {}),
    /No recording device available/
  );
});

test('recovery.restartRecording restarts OBS recording: stop, wait, start', { timeout: 5000 }, async () => {
  const calls = [];
  const agent = {
    obs: { call: async (m) => { calls.push(m); } },
    status: { obs: { connected: true } },
  };
  const result = await commandHandlers['recovery.restartRecording'](agent, { source: 'obs' });
  assert.ok(calls.includes('StopRecord'), 'should call StopRecord');
  assert.ok(calls.includes('StartRecord'), 'should call StartRecord');
  assert.ok(result.includes('OBS recording restarted'));
});

test('recovery.restartRecording vMix throws when methods unavailable', async () => {
  const agent = {
    vmix: {}, // no stopRecording/startRecording
    status: { vmix: { connected: true } },
  };
  await assert.rejects(
    () => commandHandlers['recovery.restartRecording'](agent, { source: 'vmix' }),
    /does not support stopRecording\/startRecording/
  );
});

// ─── recovery.reconnectDevice ─────────────────────────────────────────────────

test('recovery.reconnectDevice throws when no disconnected devices found', async () => {
  const agent = {
    atem: {},
    status: { atem: { connected: true } }, // connected — should not reconnect
  };
  await assert.rejects(
    () => commandHandlers['recovery.reconnectDevice'](agent, {}),
    /No disconnected devices found/
  );
});

test('recovery.reconnectDevice throws when device present but no reconnect method', async () => {
  const agent = {
    atem: {},
    status: { atem: { connected: false } },
    // no reconnectAtem method
  };
  await assert.rejects(
    () => commandHandlers['recovery.reconnectDevice'](agent, {}),
    /No disconnected devices found or no reconnect method/
  );
});

test('recovery.reconnectDevice reconnects disconnected ATEM', async () => {
  let called = false;
  const agent = {
    atem: {},
    status: { atem: { connected: false } },
    reconnectAtem: async () => { called = true; },
  };
  const result = await commandHandlers['recovery.reconnectDevice'](agent, {});
  assert.ok(called);
  assert.ok(result.includes('ATEM reconnection triggered'));
});

test('recovery.reconnectDevice reconnects disconnected OBS', async () => {
  let called = false;
  const agent = {
    obs: {},
    status: { obs: { connected: false } },
    reconnectObs: async () => { called = true; },
  };
  const result = await commandHandlers['recovery.reconnectDevice'](agent, {});
  assert.ok(called);
  assert.ok(result.includes('OBS reconnection triggered'));
});

test('recovery.reconnectDevice reconnects disconnected vMix', async () => {
  let called = false;
  const agent = {
    vmix: {},
    status: { vmix: { connected: false } },
    reconnectVmix: async () => { called = true; },
  };
  const result = await commandHandlers['recovery.reconnectDevice'](agent, {});
  assert.ok(called);
  assert.ok(result.includes('vMix reconnection triggered'));
});

test('recovery.reconnectDevice reconnects disconnected encoder', async () => {
  let called = false;
  const agent = {
    encoderBridge: {},
    status: { encoder: { connected: false } },
    reconnectEncoder: async () => { called = true; },
  };
  const result = await commandHandlers['recovery.reconnectDevice'](agent, {});
  assert.ok(called);
  assert.ok(result.includes('Encoder reconnection triggered'));
});

test('recovery.reconnectDevice reconnects disconnected Companion', async () => {
  let called = false;
  const agent = {
    companion: {},
    status: { companion: { connected: false } },
    reconnectCompanion: async () => { called = true; },
  };
  const result = await commandHandlers['recovery.reconnectDevice'](agent, {});
  assert.ok(called);
  assert.ok(result.includes('Companion reconnection triggered'));
});

test('recovery.reconnectDevice with deviceId reconnects only that device', async () => {
  let atemCalled = false;
  let obsCalled = false;
  const agent = {
    atem: {}, obs: {},
    status: { atem: { connected: false }, obs: { connected: false } },
    reconnectAtem: async () => { atemCalled = true; },
    reconnectObs: async () => { obsCalled = true; },
  };
  const result = await commandHandlers['recovery.reconnectDevice'](agent, { deviceId: 'atem' });
  assert.ok(atemCalled, 'ATEM should be reconnected');
  assert.ok(!obsCalled, 'OBS should NOT be reconnected when deviceId=atem');
  assert.ok(result.includes('ATEM'));
});

test('recovery.reconnectDevice returns semicolon-separated results for multiple devices', async () => {
  let atemDone = false, obsDone = false;
  const agent = {
    atem: {}, obs: {},
    status: { atem: { connected: false }, obs: { connected: false } },
    reconnectAtem: async () => { atemDone = true; },
    reconnectObs: async () => { obsDone = true; },
  };
  const result = await commandHandlers['recovery.reconnectDevice'](agent, {});
  assert.ok(atemDone && obsDone);
  assert.ok(result.includes('ATEM'));
  assert.ok(result.includes('OBS'));
  assert.ok(result.includes(';'), 'multiple results should be separated by semicolon');
});

// ─── recovery.restartEncoder ──────────────────────────────────────────────────

test('recovery.restartEncoder throws when encoder not configured', async () => {
  await assert.rejects(
    () => commandHandlers['recovery.restartEncoder']({}),
    /Encoder not configured/
  );
});

test('recovery.restartEncoder disconnects then reconnects via reconnectEncoder', { timeout: 6000 }, async () => {
  let disconnected = false;
  let reconnected = false;
  const agent = {
    encoderBridge: {
      disconnect: async () => { disconnected = true; },
    },
    reconnectEncoder: async () => { reconnected = true; },
  };
  const result = await commandHandlers['recovery.restartEncoder'](agent);
  assert.ok(disconnected, 'should call disconnect()');
  assert.ok(reconnected, 'should call reconnectEncoder()');
  assert.ok(result.includes('restarted'));
});

test('recovery.restartEncoder falls back to encoderBridge.connect() when no reconnectEncoder', { timeout: 6000 }, async () => {
  let connected = false;
  const agent = {
    encoderBridge: {
      disconnect: async () => {},
      connect: async () => { connected = true; },
    },
    // no reconnectEncoder
  };
  const result = await commandHandlers['recovery.restartEncoder'](agent);
  assert.ok(connected, 'should use encoderBridge.connect() as fallback');
  assert.ok(result.includes('restarted'));
});

test('recovery.restartEncoder works when no disconnect method', { timeout: 6000 }, async () => {
  let reconnected = false;
  const agent = {
    encoderBridge: {}, // no disconnect
    reconnectEncoder: async () => { reconnected = true; },
  };
  const result = await commandHandlers['recovery.restartEncoder'](agent);
  assert.ok(reconnected);
  assert.ok(result.includes('restarted'));
});

// ─── recovery.resetAudio ─────────────────────────────────────────────────────

test('recovery.resetAudio throws when no audio devices present', async () => {
  await assert.rejects(
    () => commandHandlers['recovery.resetAudio']({}),
    /No audio devices available/
  );
});

test('recovery.resetAudio unmutes mixer master output', async () => {
  let called = false;
  const agent = { mixer: { unmuteMaster: async () => { called = true; } } };
  const result = await commandHandlers['recovery.resetAudio'](agent);
  assert.ok(called);
  assert.ok(result.includes('Mixer master unmuted'));
});

test('recovery.resetAudio reports when mixer lacks unmuteMaster', async () => {
  const agent = { mixer: {} }; // no unmuteMaster method
  const result = await commandHandlers['recovery.resetAudio'](agent);
  assert.ok(result.includes('does not support unmuteMaster'));
});

test('recovery.resetAudio includes error in result when mixer.unmuteMaster throws', async () => {
  const agent = {
    mixer: { unmuteMaster: async () => { throw new Error('protocol error'); } },
  };
  const result = await commandHandlers['recovery.resetAudio'](agent);
  assert.ok(result.includes('Mixer unmute failed'));
  assert.ok(result.includes('protocol error'));
});

test('recovery.resetAudio unmutes OBS audio inputs (wasapi/pulse/alsa/coreaudio)', async () => {
  const mutedNames = [];
  const agent = {
    obs: {
      call: async (method, params) => {
        if (method === 'GetInputList') {
          return {
            inputs: [
              { inputName: 'Mic In', inputKind: 'wasapi_input_capture' },
              { inputName: 'Line In', inputKind: 'wasapi_input_capture' },
              { inputName: 'Camera', inputKind: 'dshow_input' }, // non-audio, should be skipped
            ],
          };
        }
        if (method === 'SetInputMute') {
          mutedNames.push(params.inputName);
        }
        return {};
      },
    },
    status: { obs: { connected: true } },
  };
  const result = await commandHandlers['recovery.resetAudio'](agent);
  assert.ok(mutedNames.includes('Mic In'), 'wasapi input should be unmuted');
  assert.ok(mutedNames.includes('Line In'), 'wasapi input should be unmuted');
  assert.ok(!mutedNames.includes('Camera'), 'non-audio input should be skipped');
  assert.ok(result.includes('unmuted 2 audio input(s)'));
});

test('recovery.resetAudio does not push OBS result when no audio inputs found', async () => {
  const agent = {
    obs: {
      call: async (method) => {
        if (method === 'GetInputList') {
          // Only dshow (video) inputs — no audio
          return { inputs: [{ inputName: 'Camera', inputKind: 'dshow_input' }] };
        }
        return {};
      },
    },
    status: { obs: { connected: true } },
  };
  // No results pushed → throws
  await assert.rejects(
    () => commandHandlers['recovery.resetAudio'](agent),
    /No audio devices available/
  );
});

test('recovery.resetAudio unmutes vMix master', async () => {
  let called = false;
  const agent = {
    vmix: { unmuteMaster: async () => { called = true; } },
    status: { vmix: { connected: true } },
  };
  const result = await commandHandlers['recovery.resetAudio'](agent);
  assert.ok(called);
  assert.ok(result.includes('vMix master unmuted'));
});

test('recovery.resetAudio reports when vMix lacks unmuteMaster', async () => {
  const agent = {
    vmix: {}, // no unmuteMaster
    status: { vmix: { connected: true } },
  };
  const result = await commandHandlers['recovery.resetAudio'](agent);
  assert.ok(result.includes('vMix does not support unmuteMaster'));
});

test('recovery.resetAudio combines results from mixer + OBS + vMix', async () => {
  let mixerDone = false, vmixDone = false;
  const agent = {
    mixer: { unmuteMaster: async () => { mixerDone = true; } },
    obs: {
      call: async (method) => {
        if (method === 'GetInputList') {
          return { inputs: [{ inputName: 'Mic', inputKind: 'wasapi_input_capture' }] };
        }
        return {};
      },
    },
    status: { obs: { connected: true }, vmix: { connected: true } },
    vmix: { unmuteMaster: async () => { vmixDone = true; } },
  };
  const result = await commandHandlers['recovery.resetAudio'](agent);
  assert.ok(mixerDone && vmixDone);
  assert.ok(result.includes('Mixer master unmuted'));
  assert.ok(result.includes('vMix master unmuted'));
  assert.ok(result.includes('OBS'));
});
