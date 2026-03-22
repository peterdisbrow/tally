/**
 * Epiphan Pearl encoder smoke tests
 *
 * Uses a real local HTTP server to verify that EpiphanEncoder:
 *   - Sends HTTP Basic auth header on every request
 *   - Auto-upgrades _apiBase to /api/v2.0 when firmware >= 4.24.0.1
 *   - Calls the right REST paths for channels, publishers, recorders
 *   - Correctly aggregates multi-channel live state and bitrate
 *   - Provides CPU/temp stats when using the v2 API
 *
 * REST API v1: /api/channels, /api/recorders
 * REST API v2: /api/v2.0/channels, /api/v2.0/system/status, etc.
 * Auth: HTTP Basic (admin:password)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { EpiphanEncoder } = require('../src/encoders/epiphan');

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

function respond(res, body, status = 200) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function collectBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(body));
  });
}

// Channel payload with optional encoders/publishers included inline
function channelPayload(id, name, encoders = []) {
  return { id, name, encoders };
}

// Publisher status response
function publisherStatus(started = false) {
  return { result: [{ id: 'pub1', name: 'Stream 1', status: { started } }] };
}

// ── HTTP Basic Auth ────────────────────────────────────────────────────────

test('epiphan: every request includes HTTP Basic Authorization header', async () => {
  const authHeaders = [];

  const srv = await createServer(async (req, res) => {
    authHeaders.push(req.headers.authorization || '');
    await collectBody(req);
    // Return 404 for v2 firmware probe, 200 for channels
    if (req.url.includes('/v2.0')) respond(res, {}, 404);
    else if (req.url.includes('/channels?')) respond(res, { result: [] });
    else if (req.url.includes('/recorders')) respond(res, { result: [] });
    else respond(res, { result: [] });
  });

  try {
    const enc = new EpiphanEncoder({ host: '127.0.0.1', port: srv.port, password: 'secret', username: 'admin' });
    await enc.getStatus();

    assert.ok(authHeaders.length > 0, 'expected at least one request');
    const expected = 'Basic ' + Buffer.from('admin:secret').toString('base64');
    for (const h of authHeaders) {
      assert.equal(h, expected, `expected Basic auth header; got: ${h}`);
    }
  } finally {
    await srv.close();
  }
});

// ── API version detection ──────────────────────────────────────────────────

test('epiphan: connect upgrades to /api/v2.0 when firmware is >= 4.24.0.1', async () => {
  const srv = await createServer(async (req, res) => {
    await collectBody(req);
    if (req.url === '/api/v2.0/system/firmware/version') {
      // Must be a JSON-encoded string: "4.24.0.1" → strip dots → "42401" → 42401 >= 42401 → use v2
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('"4.24.0.1"');
    } else if (req.url.includes('/v2.0/channels')) {
      respond(res, { result: [] });
    } else if (req.url.includes('/v2.0/system/firmware')) {
      respond(res, { result: { product_name: 'Pearl-2', version: '4.24.0.1' } });
    } else {
      respond(res, { result: [] });
    }
  });
  try {
    const enc = new EpiphanEncoder({ host: '127.0.0.1', port: srv.port, password: 'admin' });
    await enc.connect();
    assert.equal(enc._apiBase, '/api/v2.0');
  } finally {
    await srv.close();
  }
});

test('epiphan: connect stays on /api when firmware probe returns 404', async () => {
  const srv = await createServer(async (req, res) => {
    await collectBody(req);
    if (req.url === '/api/v2.0/system/firmware/version') respond(res, {}, 404);
    else respond(res, { result: [] });
  });
  try {
    const enc = new EpiphanEncoder({ host: '127.0.0.1', port: srv.port });
    await enc.connect();
    assert.equal(enc._apiBase, '/api');
  } finally {
    await srv.close();
  }
});

// ── getStatus — no channels ────────────────────────────────────────────────

test('epiphan: getStatus — no channels, connected=true, live=false', async () => {
  const requests = [];
  const srv = await createServer(async (req, res) => {
    requests.push(req.url);
    await collectBody(req);
    if (req.url.includes('/api/v2.0')) respond(res, {}, 404);
    else if (req.url.includes('/channels?')) respond(res, { result: [] });
    else if (req.url.includes('/recorders')) respond(res, { result: [] });
    else respond(res, {}, 404);
  });
  try {
    const enc = new EpiphanEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.type, 'epiphan');
    assert.equal(status.connected, true);
    assert.equal(status.live, false);
    assert.equal(status.recording, false);
    assert.ok(Array.isArray(status.channels));
    assert.equal(status.channels.length, 0);
    assert.ok(requests.some((u) => u.includes('/channels?publishers=yes&encoders=yes')), 'should call channels endpoint');
  } finally {
    await srv.close();
  }
});

// ── getStatus — single channel streaming ──────────────────────────────────

test('epiphan: getStatus — single channel streaming returns live=true with bitrate and fps', async () => {
  const requests = [];
  const srv = await createServer(async (req, res) => {
    requests.push(req.url);
    await collectBody(req);
    if (req.url.includes('/api/v2.0')) return respond(res, {}, 404);
    if (req.url.includes('/channels?')) {
      return respond(res, {
        result: [
          channelPayload('ch1', 'Main Camera', [
            { video_bitrate: 4_500_000, frame_size: '1920x1080', frame_rate: 30, video_codec: 'h264' },
          ]),
        ],
      });
    }
    if (req.url.includes('/channels/ch1/publishers/status')) {
      return respond(res, publisherStatus(true));
    }
    if (req.url.includes('/recorders/status')) {
      return respond(res, { result: [] });
    }
    respond(res, {}, 404);
  });

  try {
    const enc = new EpiphanEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();

    assert.equal(status.type, 'epiphan');
    assert.equal(status.connected, true);
    assert.equal(status.live, true);
    assert.equal(status.bitrateKbps, 4500);
    assert.equal(status.fps, 30);
    assert.ok(status.details.includes('Streaming'));
    assert.equal(status.channels.length, 1);
    assert.equal(status.channels[0].live, true);
    assert.equal(status.channels[0].publishers[0].state, 'streaming');
  } finally {
    await srv.close();
  }
});

test('epiphan: getStatus — publisher state="started" also marks channel live', async () => {
  const srv = await createServer(async (req, res) => {
    await collectBody(req);
    if (req.url.includes('/api/v2.0')) return respond(res, {}, 404);
    if (req.url.includes('/channels?')) return respond(res, { result: [channelPayload('ch1', 'Camera 1')] });
    if (req.url.includes('/channels/ch1/publishers/status')) {
      return respond(res, { result: [{ id: 'pub1', status: { state: 'started' } }] });
    }
    if (req.url.includes('/recorders')) return respond(res, { result: [] });
    respond(res, {}, 404);
  });
  try {
    const enc = new EpiphanEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.live, true);
  } finally {
    await srv.close();
  }
});

// ── getStatus — recording state ────────────────────────────────────────────

test('epiphan: getStatus — recorder state="recording" sets recording=true', async () => {
  const srv = await createServer(async (req, res) => {
    await collectBody(req);
    if (req.url.includes('/api/v2.0')) return respond(res, {}, 404);
    if (req.url.includes('/channels?')) return respond(res, { result: [] });
    if (req.url.includes('/recorders/status')) {
      return respond(res, { result: [{ id: 'rec1', status: { state: 'recording' } }] });
    }
    respond(res, {}, 404);
  });
  try {
    const enc = new EpiphanEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.recording, true);
    assert.ok(status.details.includes('Recording'));
  } finally {
    await srv.close();
  }
});

test('epiphan: getStatus — recorder state="started" also sets recording=true', async () => {
  const srv = await createServer(async (req, res) => {
    await collectBody(req);
    if (req.url.includes('/api/v2.0')) return respond(res, {}, 404);
    if (req.url.includes('/channels?')) return respond(res, { result: [] });
    if (req.url.includes('/recorders/status')) {
      return respond(res, { result: [{ id: 'rec1', status: { state: 'started' } }] });
    }
    respond(res, {}, 404);
  });
  try {
    const enc = new EpiphanEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.recording, true);
  } finally {
    await srv.close();
  }
});

// ── getStatus — v2 CPU/temperature stats ──────────────────────────────────

test('epiphan: getStatus — v2 API provides cpuUsage and temperature', async () => {
  const srv = await createServer(async (req, res) => {
    await collectBody(req);
    if (req.url === '/api/v2.0/system/firmware/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('"4.24.0.1"');
    }
    if (req.url.includes('/v2.0/channels?')) return respond(res, { result: [] });
    if (req.url.includes('/v2.0/system/firmware')) return respond(res, { result: { product_name: 'Pearl-2', version: '4.24.0.1' } });
    if (req.url.includes('/v2.0/channels')) return respond(res, { result: [] });
    if (req.url.includes('/v2.0/recorders')) return respond(res, { result: [] });
    if (req.url.includes('/v2.0/system/status')) return respond(res, { result: { cpuload: 42.5, cputemp: 65 } });
    respond(res, { result: [] });
  });

  try {
    const enc = new EpiphanEncoder({ host: '127.0.0.1', port: srv.port, password: 'admin' });
    await enc.connect(); // upgrades to v2
    const status = await enc.getStatus();

    assert.equal(status.cpuUsage, 42.5);
    assert.ok(status.details.includes('43%'), `expected CPU% in details; got: ${status.details}`);
    assert.ok(status.temperature?.includes('65'), `expected temp in status; got: ${status.temperature}`);
  } finally {
    await srv.close();
  }
});

// ── getStatus — multi-channel ──────────────────────────────────────────────

test('epiphan: getStatus — two channels, only one live, aggregates from live channel', async () => {
  const srv = await createServer(async (req, res) => {
    await collectBody(req);
    if (req.url.includes('/api/v2.0')) return respond(res, {}, 404);
    if (req.url.includes('/channels?')) {
      return respond(res, {
        result: [
          channelPayload('ch1', 'Live Mix', [{ video_bitrate: 6_000_000, frame_rate: 60 }]),
          channelPayload('ch2', 'Preview', [{ video_bitrate: 1_000_000, frame_rate: 30 }]),
        ],
      });
    }
    if (req.url.includes('/channels/ch1/publishers/status')) return respond(res, publisherStatus(true));
    if (req.url.includes('/channels/ch2/publishers/status')) return respond(res, publisherStatus(false));
    if (req.url.includes('/recorders')) return respond(res, { result: [] });
    respond(res, {}, 404);
  });
  try {
    const enc = new EpiphanEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.live, true);
    // Aggregated from the live channel (ch1)
    assert.equal(status.bitrateKbps, 6000);
    assert.equal(status.fps, 60);
    assert.equal(status.channels.length, 2);
    assert.equal(status.channels[0].live, true);
    assert.equal(status.channels[1].live, false);
  } finally {
    await srv.close();
  }
});

// ── getStatus — error paths ────────────────────────────────────────────────

test('epiphan: getStatus — network failure returns connected=false', async () => {
  const enc = new EpiphanEncoder({ host: '127.0.0.1', port: 1 });
  const status = await enc.getStatus();
  assert.equal(status.connected, false);
  assert.equal(status.live, false);
  assert.equal(status.type, 'epiphan');
});

test('epiphan: getStatus — HTTP 401 from channels endpoint returns connected=false', async () => {
  const srv = await createServer(async (req, res) => {
    await collectBody(req);
    if (req.url.includes('/api/v2.0')) return respond(res, {}, 404);
    respond(res, { error: 'Unauthorized' }, 401);
  });
  try {
    const enc = new EpiphanEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.connected, false);
  } finally {
    await srv.close();
  }
});

// ── Stream control ─────────────────────────────────────────────────────────

test('epiphan: startStream POSTs to /channels/{id}/publishers/control/start', async () => {
  const requests = [];
  const srv = await createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url });
    await collectBody(req);
    respond(res, { result: 'ok' });
  });
  try {
    const enc = new EpiphanEncoder({ host: '127.0.0.1', port: srv.port });
    enc._channels = [{ id: 'ch1' }];
    enc._apiBase = '/api';
    await enc.startStream('ch1');
    assert.ok(
      requests.some((r) => r.method === 'POST' && r.url.includes('/channels/ch1/publishers/control/start')),
      'expected POST to /channels/ch1/publishers/control/start'
    );
  } finally {
    await srv.close();
  }
});

test('epiphan: stopStream POSTs to /channels/{id}/publishers/control/stop', async () => {
  const requests = [];
  const srv = await createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url });
    await collectBody(req);
    respond(res, { result: 'ok' });
  });
  try {
    const enc = new EpiphanEncoder({ host: '127.0.0.1', port: srv.port });
    enc._channels = [{ id: 'ch1' }];
    enc._apiBase = '/api';
    await enc.stopStream('ch1');
    assert.ok(
      requests.some((r) => r.method === 'POST' && r.url.includes('/channels/ch1/publishers/control/stop')),
      'expected POST to /channels/ch1/publishers/control/stop'
    );
  } finally {
    await srv.close();
  }
});

test('epiphan: startStream with no channels and no channelId returns null', async () => {
  const enc = new EpiphanEncoder({ host: '127.0.0.1', port: 9999 });
  enc._channels = [];
  const result = await enc.startStream();
  assert.equal(result, null);
});

// ── Record control ─────────────────────────────────────────────────────────

test('epiphan: startRecord POSTs to /recorders/{id}/control/start', async () => {
  const requests = [];
  const srv = await createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url });
    await collectBody(req);
    respond(res, { result: 'ok' });
  });
  try {
    const enc = new EpiphanEncoder({ host: '127.0.0.1', port: srv.port });
    enc._recorders = [{ id: 'rec1' }];
    enc._apiBase = '/api';
    await enc.startRecord('rec1');
    assert.ok(
      requests.some((r) => r.method === 'POST' && r.url.includes('/recorders/rec1/control/start')),
      'expected POST to /recorders/rec1/control/start'
    );
  } finally {
    await srv.close();
  }
});

test('epiphan: stopRecord POSTs to /recorders/{id}/control/stop', async () => {
  const requests = [];
  const srv = await createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url });
    await collectBody(req);
    respond(res, { result: 'ok' });
  });
  try {
    const enc = new EpiphanEncoder({ host: '127.0.0.1', port: srv.port });
    enc._recorders = [{ id: 'rec1' }];
    enc._apiBase = '/api';
    await enc.stopRecord('rec1');
    assert.ok(
      requests.some((r) => r.method === 'POST' && r.url.includes('/recorders/rec1/control/stop')),
      'expected POST to /recorders/rec1/control/stop'
    );
  } finally {
    await srv.close();
  }
});

// ── Layout control ─────────────────────────────────────────────────────────

test('epiphan: getLayouts returns layout array for channel', async () => {
  const layouts = [{ id: 'lay1', name: 'Full Screen' }, { id: 'lay2', name: 'PiP' }];
  const srv = await createServer(async (req, res) => {
    await collectBody(req);
    if (req.url.includes('/channels/ch1/layouts')) respond(res, { result: layouts });
    else respond(res, {}, 404);
  });
  try {
    const enc = new EpiphanEncoder({ host: '127.0.0.1', port: srv.port });
    enc._channels = [{ id: 'ch1' }];
    enc._apiBase = '/api';
    const result = await enc.getLayouts('ch1');
    assert.deepEqual(result, layouts);
  } finally {
    await srv.close();
  }
});

// ── Lifecycle ──────────────────────────────────────────────────────────────

test('epiphan: disconnect sets _connected=false', async () => {
  const enc = new EpiphanEncoder({ host: '127.0.0.1', port: 9999 });
  enc._connected = true;
  const result = await enc.disconnect();
  assert.equal(result, true);
  assert.equal(enc._connected, false);
});
