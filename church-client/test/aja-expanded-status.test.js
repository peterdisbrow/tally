const test = require('node:test');
const assert = require('node:assert/strict');

// Mock AJA encoder with controllable param responses
function createMockAja(paramOverrides = {}) {
  const { AjaEncoder } = require('../src/encoders/aja');
  const enc = new AjaEncoder({ host: '192.168.1.100', port: 80 });

  // Override _getParam to return mock data
  const defaults = {
    eParamID_ReplicatorStreamState: { ok: true, data: { value: '2' } },   // streaming
    eParamID_ReplicatorRecordState: { ok: true, data: { value: '2' } },   // recording
    eParamID_Temperature: { ok: true, data: { value: '42' } },
    eParamID_CurrentMediaAvailable: { ok: true, data: { value: '85' } },
    eParamID_VideoInSelect: { ok: true, data: { value: '1' } },          // HDMI
    eParamID_AudioInSelect: { ok: true, data: { value: '0' } },          // SDI
    eParamID_StreamingDuration: { ok: true, data: { value: '3723' } },   // 1h 2m 3s
    eParamID_RecordingDuration: { ok: true, data: { value: '1800' } },   // 30m
    eParamID_SchedulerEnabled: { ok: true, data: { value: '1' } },
    eParamID_AVMute: { ok: true, data: { value: '0' } },
    ...paramOverrides,
  };

  enc._getParam = async (paramId) => defaults[paramId] || { ok: false, data: null };
  return enc;
}

test('AJA getStatus returns extended fields when streaming', async () => {
  const enc = createMockAja();
  const s = await enc.getStatus();

  assert.equal(s.type, 'aja');
  assert.equal(s.connected, true);
  assert.equal(s.live, true);
  assert.equal(s.recording, true);
  assert.equal(s.videoInput, 'HDMI');
  assert.equal(s.audioInput, 'SDI');
  assert.equal(s.temperature, '42°C');
  assert.equal(s.mediaAvailable, '85%');
  assert.equal(s.schedulerEnabled, true);
  assert.equal(s.muted, false);
  assert.equal(s.failing, false);

  // Duration formatting
  assert.equal(s.streamDuration, '1:02:03');
  assert.equal(s.recordDuration, '0:30:00');

  // Details string
  assert.ok(s.details.includes('Streaming'));
  assert.ok(s.details.includes('Recording'));
  assert.ok(s.details.includes('42°C'));
  assert.ok(s.details.includes('HDMI'));
  assert.ok(s.details.includes('1:02:03'));
});

test('AJA getStatus — muted state shows in details', async () => {
  const enc = createMockAja({
    eParamID_AVMute: { ok: true, data: { value: '1' } },
  });
  const s = await enc.getStatus();
  assert.equal(s.muted, true);
  assert.ok(s.details.includes('Muted'));
});

test('AJA getStatus — idle state with no duration', async () => {
  const enc = createMockAja({
    eParamID_ReplicatorStreamState: { ok: true, data: { value: '1' } },   // idle
    eParamID_ReplicatorRecordState: { ok: true, data: { value: '1' } },   // idle
    eParamID_StreamingDuration: { ok: true, data: { value: '0' } },
    eParamID_RecordingDuration: { ok: true, data: { value: '0' } },
  });
  const s = await enc.getStatus();
  assert.equal(s.live, false);
  assert.equal(s.recording, false);
  assert.equal(s.streamDuration, null);
  assert.equal(s.recordDuration, null);
});

test('AJA getStatus — failing state detected', async () => {
  const enc = createMockAja({
    eParamID_ReplicatorStreamState: { ok: true, data: { value: '4' } },   // FailStream
  });
  const s = await enc.getStatus();
  assert.equal(s.failing, true);
  assert.ok(s.details.includes('Error'));
});

test('AJA getStatus — test pattern video input', async () => {
  const enc = createMockAja({
    eParamID_VideoInSelect: { ok: true, data: { value: '2' } },
  });
  const s = await enc.getStatus();
  assert.equal(s.videoInput, 'Test Pattern');
});
