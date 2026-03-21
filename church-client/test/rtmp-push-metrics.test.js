const test = require('node:test');
const assert = require('node:assert/strict');
const { RtmpPushEncoder } = require('../src/encoders/rtmpPush');

test('RtmpPushEncoder — setBitrate/setFps expose in getStatus', async () => {
  const enc = new RtmpPushEncoder({ type: 'yolobox' });
  enc.setLive(true);
  enc.setBitrate(4500);
  enc.setFps(30);

  const status = await enc.getStatus();
  assert.equal(status.live, true);
  assert.equal(status.bitrateKbps, 4500);
  assert.equal(status.fps, 30);
  assert.ok(status.details.includes('LIVE'));
  assert.ok(status.details.includes('4.5 Mbps'));
  assert.ok(status.details.includes('30fps'));
});

test('RtmpPushEncoder — metrics reset on stream-down', async () => {
  const enc = new RtmpPushEncoder({ type: 'yolobox' });
  enc.setLive(true);
  enc.setBitrate(3000);
  enc.setFps(25);

  enc.setLive(false);
  const status = await enc.getStatus();
  assert.equal(status.live, false);
  assert.equal(status.bitrateKbps, null);
  assert.equal(status.fps, null);
});

test('RtmpPushEncoder — tracks stream duration', async () => {
  const enc = new RtmpPushEncoder({ type: 'youtube-live' });
  enc.setLive(true);
  // Manually backdate the start time for testing
  enc._liveStartedAt = Date.now() - (65 * 60 * 1000); // 1h 5m ago

  const status = await enc.getStatus();
  assert.ok(status.details.includes('1:05'), `Expected "1:05" in details, got: ${status.details}`);
});

test('RtmpPushEncoder — zero/negative bitrate ignored', async () => {
  const enc = new RtmpPushEncoder({ type: 'vimeo-live' });
  enc.setLive(true);
  enc.setBitrate(0);
  enc.setFps(-1);

  const status = await enc.getStatus();
  assert.equal(status.bitrateKbps, null);
  assert.equal(status.fps, null);
});

test('RtmpPushEncoder — low bitrate shown in kbps', async () => {
  const enc = new RtmpPushEncoder({ type: 'custom-rtmp' });
  enc.setLive(true);
  enc.setBitrate(750);

  const status = await enc.getStatus();
  assert.ok(status.details.includes('750 kbps'));
});

test('RtmpPushEncoder — all RTMP types get correct labels', () => {
  const types = ['yolobox', 'youtube-live', 'facebook-live', 'vimeo-live', 'custom-rtmp', 'rtmp-generic'];
  const expectedLabels = ['YoloBox', 'YouTube Live', 'Facebook Live', 'Vimeo Live', 'Custom RTMP', 'RTMP Device'];
  for (let i = 0; i < types.length; i++) {
    const enc = new RtmpPushEncoder({ type: types[i] });
    assert.equal(enc.label, expectedLabels[i], `Type ${types[i]} should have label ${expectedLabels[i]}`);
  }
});
