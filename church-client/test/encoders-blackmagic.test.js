/**
 * Blackmagic encoder smoke tests
 *
 * Spins up a real local HTTP server on a random port to verify that
 * BlackmagicEncoder makes the exact requests documented in the REST API spec
 * and maps responses to the standardised status shape.
 *
 * REST API prefix: /control/api/v1/
 * No auth required.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { BlackmagicEncoder } = require('../src/encoders/blackmagic');

// ── Shared test-server helpers ─────────────────────────────────────────────

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
  const payload = body === null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

// Build a handler that dispatches by exact URL match
function routedHandler(routes, fallback = (req, res) => respond(res, {}, 404)) {
  return (req, res) => {
    for (const [pattern, fn] of Object.entries(routes)) {
      if (req.url === pattern || req.url.startsWith(pattern + '?')) {
        fn(req, res);
        return;
      }
    }
    // Check prefix matches
    for (const [pattern, fn] of Object.entries(routes)) {
      if (req.url.startsWith(pattern)) {
        fn(req, res);
        return;
      }
    }
    fallback(req, res);
  };
}

// ── getStatus — connected, streaming ──────────────────────────────────────

test('blackmagic: getStatus — streaming device returns live=true and bitrateKbps', async () => {
  const requests = [];
  const srv = await createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    if (req.url === '/control/api/v1/livestreams/0') {
      respond(res, { status: 'Streaming', bitrate: 5_000_000, effectiveVideoFormat: '1920x1080p30', duration: 125 });
    } else if (req.url === '/control/api/v1/system') {
      respond(res, { productName: 'Blackmagic Web Presenter HD', softwareVersion: '3.4.1' });
    } else {
      respond(res, {}, 404);
    }
  });

  try {
    const enc = new BlackmagicEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();

    assert.equal(status.type, 'blackmagic');
    assert.equal(status.connected, true);
    assert.equal(status.live, true);
    assert.equal(status.bitrateKbps, 5000);
    assert.equal(status.fps, 30);
    assert.equal(status.cpuUsage, null);
    assert.equal(status.recording, false);
    assert.ok(status.details.includes('Streaming'));

    const paths = requests.map((r) => r.url);
    assert.ok(paths.includes('/control/api/v1/livestreams/0'), 'should GET /livestreams/0');
    assert.ok(paths.includes('/control/api/v1/system'), 'should GET /system');
  } finally {
    await srv.close();
  }
});

test('blackmagic: getStatus — Connecting state also reports live=true', async () => {
  const srv = await createServer((req, res) => {
    if (req.url === '/control/api/v1/livestreams/0') respond(res, { status: 'Connecting' });
    else respond(res, {});
  });
  try {
    const enc = new BlackmagicEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.live, true);
    assert.equal(status.connected, true);
  } finally {
    await srv.close();
  }
});

test('blackmagic: getStatus — Idle device returns live=false, bitrateKbps=null', async () => {
  const srv = await createServer((req, res) => {
    if (req.url === '/control/api/v1/livestreams/0') respond(res, { status: 'Idle' });
    else respond(res, {});
  });
  try {
    const enc = new BlackmagicEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.live, false);
    assert.equal(status.connected, true);
    assert.equal(status.bitrateKbps, null);
  } finally {
    await srv.close();
  }
});

// ── getStatus — FPS extraction ─────────────────────────────────────────────

test('blackmagic: getStatus — FPS parsed from "1920x1080p30" format string', async () => {
  const srv = await createServer((req, res) => {
    if (req.url === '/control/api/v1/livestreams/0') respond(res, { status: 'Streaming', effectiveVideoFormat: '1920x1080p30' });
    else respond(res, {});
  });
  try {
    const enc = new BlackmagicEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.fps, 30);
  } finally {
    await srv.close();
  }
});

test('blackmagic: getStatus — FPS parsed from interlaced "1080i59.94" format string', async () => {
  const srv = await createServer((req, res) => {
    if (req.url === '/control/api/v1/livestreams/0') respond(res, { status: 'Streaming', effectiveVideoFormat: '1920x1080i59.94' });
    else respond(res, {});
  });
  try {
    const enc = new BlackmagicEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.fps, 59.94);
  } finally {
    await srv.close();
  }
});

test('blackmagic: getStatus — missing video format yields fps=null', async () => {
  const srv = await createServer((req, res) => {
    if (req.url === '/control/api/v1/livestreams/0') respond(res, { status: 'Idle' });
    else respond(res, {});
  });
  try {
    const enc = new BlackmagicEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.fps, null);
  } finally {
    await srv.close();
  }
});

// ── getStatus — details string ─────────────────────────────────────────────

test('blackmagic: getStatus — cache > 50% appears in details', async () => {
  const srv = await createServer((req, res) => {
    if (req.url === '/control/api/v1/livestreams/0') respond(res, { status: 'Streaming', cache: 75 });
    else respond(res, {});
  });
  try {
    const enc = new BlackmagicEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.ok(status.details.includes('Cache 75%'), `details should mention cache; got: ${status.details}`);
  } finally {
    await srv.close();
  }
});

test('blackmagic: getStatus — cache <= 50% not mentioned in details', async () => {
  const srv = await createServer((req, res) => {
    if (req.url === '/control/api/v1/livestreams/0') respond(res, { status: 'Streaming', cache: 30 });
    else respond(res, {});
  });
  try {
    const enc = new BlackmagicEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.ok(!status.details.includes('Cache'), `details should not mention low cache; got: ${status.details}`);
  } finally {
    await srv.close();
  }
});

test('blackmagic: getStatus — streaming duration shown in details', async () => {
  const srv = await createServer((req, res) => {
    if (req.url === '/control/api/v1/livestreams/0') respond(res, { status: 'Streaming', duration: 185 });
    else respond(res, {});
  });
  try {
    const enc = new BlackmagicEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    // 185s = 3m5s
    assert.ok(status.details.includes('3m5s'), `expected duration in details; got: ${status.details}`);
  } finally {
    await srv.close();
  }
});

// ── getStatus — error paths ────────────────────────────────────────────────

test('blackmagic: getStatus — HTTP 500 from device returns connected=false', async () => {
  const srv = await createServer((req, res) => respond(res, 'error', 500));
  try {
    const enc = new BlackmagicEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.connected, false);
    assert.equal(status.live, false);
    assert.equal(status.type, 'blackmagic');
  } finally {
    await srv.close();
  }
});

test('blackmagic: getStatus — network failure (no server) returns connected=false', async () => {
  const enc = new BlackmagicEncoder({ host: '127.0.0.1', port: 1 });
  const status = await enc.getStatus();
  assert.equal(status.connected, false);
  assert.equal(status.live, false);
  assert.equal(status.type, 'blackmagic');
});

test('blackmagic: getStatus — malformed JSON body handled gracefully', async () => {
  const srv = await createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('not-valid-json{{');
  });
  try {
    const enc = new BlackmagicEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    // 200 but unparseable → ok=true but data=null → connected=false (no data.status)
    assert.equal(status.type, 'blackmagic');
    assert.equal(status.live, false);
  } finally {
    await srv.close();
  }
});

// ── startStream / stopStream ───────────────────────────────────────────────

test('blackmagic: startStream sends PUT /control/api/v1/livestreams/0/start', async () => {
  const requests = [];
  const srv = await createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    respond(res, null, 204);
  });
  try {
    const enc = new BlackmagicEncoder({ host: '127.0.0.1', port: srv.port });
    const result = await enc.startStream();
    assert.equal(result.ok, true);
    assert.equal(result.status, 204);
    assert.ok(requests.some((r) => r.method === 'PUT' && r.url === '/control/api/v1/livestreams/0/start'),
      'expected PUT /livestreams/0/start');
  } finally {
    await srv.close();
  }
});

test('blackmagic: stopStream sends PUT /control/api/v1/livestreams/0/stop', async () => {
  const requests = [];
  const srv = await createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    respond(res, null, 204);
  });
  try {
    const enc = new BlackmagicEncoder({ host: '127.0.0.1', port: srv.port });
    const result = await enc.stopStream();
    assert.equal(result.ok, true);
    assert.ok(requests.some((r) => r.method === 'PUT' && r.url === '/control/api/v1/livestreams/0/stop'),
      'expected PUT /livestreams/0/stop');
  } finally {
    await srv.close();
  }
});

test('blackmagic: startStream — device error returns ok=false', async () => {
  const srv = await createServer((req, res) => respond(res, { error: 'not allowed' }, 403));
  try {
    const enc = new BlackmagicEncoder({ host: '127.0.0.1', port: srv.port });
    const result = await enc.startStream();
    assert.equal(result.ok, false);
  } finally {
    await srv.close();
  }
});

// ── connect / isOnline ─────────────────────────────────────────────────────

test('blackmagic: connect fetches product name and software version', async () => {
  const srv = await createServer((req, res) => {
    if (req.url === '/control/api/v1/livestreams/0') respond(res, { status: 'Idle' });
    else if (req.url === '/control/api/v1/system/product') {
      respond(res, { productName: 'Blackmagic Streaming Encoder', softwareVersion: '4.1.0' });
    } else {
      respond(res, {});
    }
  });
  try {
    const enc = new BlackmagicEncoder({ host: '127.0.0.1', port: srv.port });
    const online = await enc.connect();
    assert.equal(online, true);
    assert.equal(enc._productName, 'Blackmagic Streaming Encoder');
    assert.equal(enc._softwareVersion, '4.1.0');
  } finally {
    await srv.close();
  }
});

test('blackmagic: isOnline returns true when device responds', async () => {
  const srv = await createServer((req, res) => respond(res, { status: 'Idle' }));
  try {
    const enc = new BlackmagicEncoder({ host: '127.0.0.1', port: srv.port });
    const online = await enc.isOnline();
    assert.equal(online, true);
    assert.equal(enc._connected, true);
  } finally {
    await srv.close();
  }
});

test('blackmagic: isOnline returns false when device is unreachable', async () => {
  const enc = new BlackmagicEncoder({ host: '127.0.0.1', port: 1 });
  const online = await enc.isOnline();
  assert.equal(online, false);
  assert.equal(enc._connected, false);
});

test('blackmagic: disconnect sets _connected=false', async () => {
  const enc = new BlackmagicEncoder({ host: '127.0.0.1', port: 9999 });
  enc._connected = true;
  const result = await enc.disconnect();
  assert.equal(result, true);
  assert.equal(enc._connected, false);
});

// ── Platform config ────────────────────────────────────────────────────────

test('blackmagic: getActivePlatform returns platform data', async () => {
  const srv = await createServer((req, res) => {
    if (req.url === '/control/api/v1/livestreams/0/activePlatform') {
      respond(res, { platform: 'YouTube', key: 'abc123', quality: 'High' });
    } else {
      respond(res, {});
    }
  });
  try {
    const enc = new BlackmagicEncoder({ host: '127.0.0.1', port: srv.port });
    const result = await enc.getActivePlatform();
    assert.equal(result?.platform, 'YouTube');
    assert.equal(result?.key, 'abc123');
  } finally {
    await srv.close();
  }
});

test('blackmagic: setActivePlatform sends PUT with config body', async () => {
  const requests = [];
  const srv = await createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      respond(res, null, 204);
    });
  });
  try {
    const enc = new BlackmagicEncoder({ host: '127.0.0.1', port: srv.port });
    await enc.setActivePlatform({ platform: 'YouTube', key: 'stream_key_xyz' });
    const req = requests.find((r) => r.url.includes('activePlatform'));
    assert.ok(req, 'expected PUT to activePlatform');
    assert.equal(req.method, 'PUT');
    const parsed = JSON.parse(req.body);
    assert.equal(parsed.platform, 'YouTube');
    assert.equal(parsed.key, 'stream_key_xyz');
  } finally {
    await srv.close();
  }
});

test('blackmagic: getSupportedVideoFormats returns format array', async () => {
  const formats = ['1920x1080p30', '1920x1080p60', '3840x2160p30'];
  const srv = await createServer((req, res) => {
    if (req.url.includes('/supportedVideoFormats')) respond(res, { formats });
    else respond(res, {});
  });
  try {
    const enc = new BlackmagicEncoder({ host: '127.0.0.1', port: srv.port });
    const result = await enc.getSupportedVideoFormats();
    assert.deepEqual(result, formats);
  } finally {
    await srv.close();
  }
});

test('blackmagic: getPlatforms returns platform names', async () => {
  const srv = await createServer((req, res) => {
    if (req.url === '/control/api/v1/livestreams/platforms') {
      respond(res, ['YouTube', 'Facebook', 'Twitch']);
    } else {
      respond(res, {});
    }
  });
  try {
    const enc = new BlackmagicEncoder({ host: '127.0.0.1', port: srv.port });
    const result = await enc.getPlatforms();
    assert.deepEqual(result, ['YouTube', 'Facebook', 'Twitch']);
  } finally {
    await srv.close();
  }
});

// ── setVideoFormat ─────────────────────────────────────────────────────────

test('blackmagic: setVideoFormat sends PUT with format body', async () => {
  const requests = [];
  const srv = await createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body });
      respond(res, null, 204);
    });
  });
  try {
    const enc = new BlackmagicEncoder({ host: '127.0.0.1', port: srv.port });
    await enc.setVideoFormat({ format: '1920x1080p30' });
    const req = requests.find((r) => r.url.includes('videoFormat'));
    assert.ok(req, 'expected PUT to videoFormat');
    assert.equal(req.method, 'PUT');
    const parsed = JSON.parse(req.body);
    assert.equal(parsed.format, '1920x1080p30');
  } finally {
    await srv.close();
  }
});
