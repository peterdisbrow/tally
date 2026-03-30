/**
 * RtmpPushEncoder smoke tests
 *
 * RtmpPushEncoder is a "relay-fed" adapter: it has no control API but its
 * status fields (live, bitrateKbps, fps) are populated externally via the
 * setLive / setBitrate / setFps methods when the RTMP relay reports activity.
 *
 * isOnline() optionally checks a management HTTP endpoint when a host is set.
 * getStatus() returns the relay-provided state combined with reachability.
 *
 * Tests verify:
 *   - setLive / setBitrate / setFps state transitions
 *   - getStatus shape for each type variant (youtube-live, facebook-live, etc.)
 *   - isOnline returns true / false based on HTTP probe
 *   - When host is empty, connected=true (configuration-only mode)
 *   - Live duration timer tracks elapsed time
 *   - Default label per encoder type
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { RtmpPushEncoder } = require('../src/encoders/rtmpPush');

// ── helpers ────────────────────────────────────────────────────────────────

function createServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        port: srv.address().port,
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

// ── setLive ────────────────────────────────────────────────────────────────

test('rtmppush: setLive(true) sets _live=true and records start time', () => {
  const enc = new RtmpPushEncoder({ type: 'youtube-live' });
  assert.equal(enc._live, false);
  assert.equal(enc._liveStartedAt, null);

  enc.setLive(true);
  assert.equal(enc._live, true);
  assert.ok(enc._liveStartedAt > 0, 'should record start timestamp');
});

test('rtmppush: setLive(false) clears _live, _bitrateKbps, _fps, and _liveStartedAt', () => {
  const enc = new RtmpPushEncoder({ type: 'youtube-live' });
  enc.setLive(true);
  enc.setBitrate(5000);
  enc.setFps(30);

  enc.setLive(false);
  assert.equal(enc._live, false);
  assert.equal(enc._bitrateKbps, null);
  assert.equal(enc._fps, null);
  assert.equal(enc._liveStartedAt, null);
});

test('rtmppush: setLive(true) again does not reset _liveStartedAt', () => {
  const enc = new RtmpPushEncoder({ type: 'youtube-live' });
  enc.setLive(true);
  const firstTimestamp = enc._liveStartedAt;

  enc.setLive(true); // already live
  assert.equal(enc._liveStartedAt, firstTimestamp, 'timestamp should not change on repeated setLive(true)');
});

// ── setBitrate / setFps ────────────────────────────────────────────────────

test('rtmppush: setBitrate stores kbps value', () => {
  const enc = new RtmpPushEncoder({ type: 'custom-rtmp' });
  enc.setBitrate(3500);
  assert.equal(enc._bitrateKbps, 3500);
});

test('rtmppush: setBitrate(0) clears value to null', () => {
  const enc = new RtmpPushEncoder({ type: 'custom-rtmp' });
  enc.setBitrate(3500);
  enc.setBitrate(0);
  assert.equal(enc._bitrateKbps, null);
});

test('rtmppush: setFps stores fps value', () => {
  const enc = new RtmpPushEncoder({ type: 'custom-rtmp' });
  enc.setFps(60);
  assert.equal(enc._fps, 60);
});

test('rtmppush: setFps(0) clears value to null', () => {
  const enc = new RtmpPushEncoder({ type: 'custom-rtmp' });
  enc.setFps(30);
  enc.setFps(0);
  assert.equal(enc._fps, null);
});

// ── getStatus — no host (configuration-only mode) ─────────────────────────

test('rtmppush: getStatus — no host, not live: connected=true, live=false', async () => {
  const enc = new RtmpPushEncoder({ type: 'youtube-live', label: 'YouTube' });
  const status = await enc.getStatus();

  assert.equal(status.type, 'youtube-live');
  assert.equal(status.connected, true); // no host = always connected
  assert.equal(status.live, false);
  assert.equal(status.bitrateKbps, null);
  assert.equal(status.fps, null);
  assert.equal(status.recording, false);
  assert.equal(status.cpuUsage, null);
  assert.ok(status.details.includes('configured'), `expected 'configured' in details; got: ${status.details}`);
});

test('rtmppush: getStatus — no host, live with bitrate and fps: details includes LIVE, Mbps, fps', async () => {
  const enc = new RtmpPushEncoder({ type: 'youtube-live', label: 'YouTube' });
  enc.setLive(true);
  enc.setBitrate(4500);
  enc.setFps(30);

  const status = await enc.getStatus();
  assert.equal(status.live, true);
  assert.equal(status.bitrateKbps, 4500);
  assert.equal(status.fps, 30);
  assert.ok(status.details.includes('LIVE'), `expected LIVE in details; got: ${status.details}`);
  assert.ok(status.details.includes('4.5 Mbps'), `expected Mbps; got: ${status.details}`);
  assert.ok(status.details.includes('30fps'), `expected fps; got: ${status.details}`);
});

test('rtmppush: getStatus — sub-1000 kbps shown as kbps not Mbps', async () => {
  const enc = new RtmpPushEncoder({ type: 'custom-rtmp' });
  enc.setLive(true);
  enc.setBitrate(750);

  const status = await enc.getStatus();
  assert.ok(status.details.includes('750 kbps'), `expected kbps; got: ${status.details}`);
  assert.ok(!status.details.includes('Mbps'), `should not show Mbps; got: ${status.details}`);
});

test('rtmppush: getStatus — details includes elapsed duration when live', async () => {
  const enc = new RtmpPushEncoder({ type: 'youtube-live' });
  enc.setLive(true);
  // Backdate start time by 65 seconds to simulate elapsed time
  enc._liveStartedAt = Date.now() - 65_000;

  const status = await enc.getStatus();
  // Duration formatted as H:MM — 65s = 0h 1m → "0:01"
  assert.ok(status.details.includes('0:01'), `expected 0:01 in details; got: ${status.details}`);
});

// ── getStatus — with host (HTTP probe for reachability) ───────────────────

test('rtmppush: getStatus — host reachable → connected=true', async () => {
  const srv = await createServer((req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  try {
    const enc = new RtmpPushEncoder({ host: '127.0.0.1', port: srv.port, type: 'custom-rtmp' });
    const status = await enc.getStatus();
    assert.equal(status.connected, true);
    assert.ok(status.details.includes('reachable'), `expected 'reachable' in details; got: ${status.details}`);
  } finally {
    await srv.close();
  }
});

test('rtmppush: getStatus — host unreachable → connected=false', async () => {
  const enc = new RtmpPushEncoder({ host: '127.0.0.1', port: 1, type: 'custom-rtmp' });
  const status = await enc.getStatus();
  assert.equal(status.connected, false);
  assert.ok(status.details.includes('unreachable'), `expected 'unreachable' in details; got: ${status.details}`);
});

test('rtmppush: isOnline returns true when management endpoint responds', async () => {
  const srv = await createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  try {
    const enc = new RtmpPushEncoder({ host: '127.0.0.1', port: srv.port });
    const online = await enc.isOnline();
    assert.equal(online, true);
  } finally {
    await srv.close();
  }
});

test('rtmppush: isOnline returns true when no host configured', async () => {
  const enc = new RtmpPushEncoder({ host: '' });
  const online = await enc.isOnline();
  assert.equal(online, true);
});

test('rtmppush: isOnline returns false when host is unreachable', async () => {
  const enc = new RtmpPushEncoder({ host: '127.0.0.1', port: 1 });
  const online = await enc.isOnline();
  assert.equal(online, false);
});

// ── Default labels per type ────────────────────────────────────────────────

test('rtmppush: youtube-live default label is "YouTube Live"', async () => {
  const enc = new RtmpPushEncoder({ type: 'youtube-live' });
  const status = await enc.getStatus();
  assert.ok(status.details.includes('YouTube Live'), `got: ${status.details}`);
});

test('rtmppush: facebook-live default label is "Facebook Live"', async () => {
  const enc = new RtmpPushEncoder({ type: 'facebook-live' });
  const status = await enc.getStatus();
  assert.ok(status.details.includes('Facebook Live'), `got: ${status.details}`);
});

test('rtmppush: vimeo-live default label is "Vimeo Live"', async () => {
  const enc = new RtmpPushEncoder({ type: 'vimeo-live' });
  const status = await enc.getStatus();
  assert.ok(status.details.includes('Vimeo Live'), `got: ${status.details}`);
});

test('rtmppush: yolobox default label is "YoloBox"', async () => {
  const enc = new RtmpPushEncoder({ type: 'yolobox' });
  const status = await enc.getStatus();
  assert.ok(status.details.includes('YoloBox'), `got: ${status.details}`);
});

test('rtmppush: atem-streaming default label is "ATEM Mini"', async () => {
  const enc = new RtmpPushEncoder({ type: 'atem-streaming' });
  const status = await enc.getStatus();
  assert.ok(status.details.includes('ATEM Mini'), `got: ${status.details}`);
});

test('rtmppush: custom-rtmp default label is "Custom RTMP"', async () => {
  const enc = new RtmpPushEncoder({ type: 'custom-rtmp' });
  const status = await enc.getStatus();
  assert.ok(status.details.includes('Custom RTMP'), `got: ${status.details}`);
});

test('rtmppush: explicit label overrides default', async () => {
  const enc = new RtmpPushEncoder({ type: 'youtube-live', label: 'Sunday Stream' });
  const status = await enc.getStatus();
  assert.ok(status.details.includes('Sunday Stream'), `got: ${status.details}`);
});

// ── status URL path ────────────────────────────────────────────────────────

test('rtmppush: isOnline uses configured statusPath', async () => {
  const requests = [];
  const srv = await createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200);
    res.end('ok');
  });
  try {
    const enc = new RtmpPushEncoder({ host: '127.0.0.1', port: srv.port, statusPath: '/healthz' });
    await enc.isOnline();
    assert.ok(requests.includes('/healthz'), `expected /healthz; got: ${requests}`);
  } finally {
    await srv.close();
  }
});

// ── Constructor edge cases ────────────────────────────────────────────────

test('rtmppush: port defaults to 80 when given 0', () => {
  const enc = new RtmpPushEncoder({ port: 0 });
  assert.equal(enc.port, 80);
});

test('rtmppush: statusPath without leading slash gets one prepended', () => {
  const enc = new RtmpPushEncoder({ statusPath: 'healthz' });
  assert.equal(enc.statusPath, '/healthz');
});

test('rtmppush: unknown type falls back to "RTMP Device" label', () => {
  const enc = new RtmpPushEncoder({ type: 'unknown-device' });
  assert.equal(enc.label, 'RTMP Device');
});

// ── Lifecycle ──────────────────────────────────────────────────────────────

test('rtmppush: disconnect returns true', async () => {
  const enc = new RtmpPushEncoder({ type: 'custom-rtmp' });
  const result = await enc.disconnect();
  assert.equal(result, true);
});

test('rtmppush: connect delegates to isOnline', async () => {
  const enc = new RtmpPushEncoder({ type: 'custom-rtmp', host: '' });
  const result = await enc.connect();
  assert.equal(result, true);
});
