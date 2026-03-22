/**
 * Custom and TallyEncoder smoke tests
 *
 * Both adapters are simple HTTP polling wrappers. Tests use a real local HTTP
 * server to verify exact endpoint paths, response field mapping, and error
 * handling.
 *
 * CustomEncoder — polls a user-specified status URL path and extracts streaming
 * state from arbitrary JSON fields (streaming, live, state, status, bitrate, fps).
 *
 * TallyEncoderAdapter — polls /health for connectivity and /status for state.
 * Port defaults to 7070.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { CustomEncoder } = require('../src/encoders/custom');
const { TallyEncoderAdapter } = require('../src/encoders/tallyEncoder');

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

// ══════════════════════════════════════════════════════════════════════════
// CustomEncoder
// ══════════════════════════════════════════════════════════════════════════

// ── getStatus — field extraction variants ─────────────────────────────────

test('custom: getStatus — `streaming: true` field maps to live=true', async () => {
  const srv = await createServer((req, res) => {
    respond(res, { streaming: true, bitrate: 4_000_000, fps: 30 });
  });
  try {
    const enc = new CustomEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.type, 'custom');
    assert.equal(status.connected, true);
    assert.equal(status.live, true);
    assert.equal(status.bitrateKbps, 4000);
    assert.equal(status.fps, 30);
    assert.equal(status.recording, false);
  } finally {
    await srv.close();
  }
});

test('custom: getStatus — `live: true` field maps to live=true', async () => {
  const srv = await createServer((req, res) => respond(res, { live: true }));
  try {
    const enc = new CustomEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.live, true);
  } finally {
    await srv.close();
  }
});

test('custom: getStatus — `state: "streaming"` maps to live=true', async () => {
  const srv = await createServer((req, res) => respond(res, { state: 'streaming' }));
  try {
    const enc = new CustomEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.live, true);
  } finally {
    await srv.close();
  }
});

test('custom: getStatus — `status: "streaming"` maps to live=true', async () => {
  const srv = await createServer((req, res) => respond(res, { status: 'streaming' }));
  try {
    const enc = new CustomEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.live, true);
  } finally {
    await srv.close();
  }
});

test('custom: getStatus — `bitrateKbps` field preferred over `bitrate`', async () => {
  const srv = await createServer((req, res) => respond(res, { bitrateKbps: 3500, bitrate: 9_000_000 }));
  try {
    const enc = new CustomEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.bitrateKbps, 3500);
  } finally {
    await srv.close();
  }
});

test('custom: getStatus — bitrate in bps converted to kbps', async () => {
  const srv = await createServer((req, res) => respond(res, { bitrate: 6_500_000 }));
  try {
    const enc = new CustomEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.bitrateKbps, 6500);
  } finally {
    await srv.close();
  }
});

test('custom: getStatus — `recording: true` maps to recording=true', async () => {
  const srv = await createServer((req, res) => respond(res, { recording: true }));
  try {
    const enc = new CustomEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.recording, true);
  } finally {
    await srv.close();
  }
});

test('custom: getStatus — cpuUsage field forwarded in status', async () => {
  const srv = await createServer((req, res) => respond(res, { cpuUsage: 68.5 }));
  try {
    const enc = new CustomEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.cpuUsage, 68.5);
  } finally {
    await srv.close();
  }
});

test('custom: getStatus — idle device (no live fields) returns live=false', async () => {
  const srv = await createServer((req, res) => respond(res, { uptime: 1234 }));
  try {
    const enc = new CustomEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.live, false);
    assert.equal(status.bitrateKbps, null);
    assert.equal(status.fps, null);
  } finally {
    await srv.close();
  }
});

// ── getStatus — custom status URL path ────────────────────────────────────

test('custom: getStatus calls configured statusUrl path', async () => {
  const requests = [];
  const srv = await createServer((req, res) => {
    requests.push(req.url);
    respond(res, { streaming: false });
  });
  try {
    const enc = new CustomEncoder({ host: '127.0.0.1', port: srv.port, statusUrl: '/api/livestatus' });
    await enc.getStatus();
    assert.ok(requests.includes('/api/livestatus'), `expected /api/livestatus; got: ${requests}`);
  } finally {
    await srv.close();
  }
});

test('custom: getStatus defaults to /status when no statusUrl specified', async () => {
  const requests = [];
  const srv = await createServer((req, res) => {
    requests.push(req.url);
    respond(res, {});
  });
  try {
    const enc = new CustomEncoder({ host: '127.0.0.1', port: srv.port });
    await enc.getStatus();
    assert.ok(requests.includes('/status'), `expected /status; got: ${requests}`);
  } finally {
    await srv.close();
  }
});

// ── getStatus — error paths ────────────────────────────────────────────────

test('custom: getStatus — network failure returns connected=false', async () => {
  const enc = new CustomEncoder({ host: '127.0.0.1', port: 1 });
  const status = await enc.getStatus();
  assert.equal(status.connected, false);
  assert.equal(status.live, false);
  assert.equal(status.type, 'custom');
});

test('custom: getStatus — HTTP 500 returns connected=false', async () => {
  const srv = await createServer((req, res) => respond(res, 'error', 500));
  try {
    const enc = new CustomEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.connected, false);
    assert.equal(status.live, false);
  } finally {
    await srv.close();
  }
});

test('custom: getStatus — malformed JSON returns connected=true but live=false', async () => {
  const srv = await createServer((req, res) => {
    res.writeHead(200);
    res.end('{ bad json {{');
  });
  try {
    const enc = new CustomEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    // HTTP 200 but unparseable → ok=true, data=null → connected=true, live=false
    assert.equal(status.connected, true);
    assert.equal(status.live, false);
  } finally {
    await srv.close();
  }
});

// ── isOnline ───────────────────────────────────────────────────────────────

test('custom: isOnline returns true when status endpoint responds 200', async () => {
  const srv = await createServer((req, res) => respond(res, {}));
  try {
    const enc = new CustomEncoder({ host: '127.0.0.1', port: srv.port });
    const online = await enc.isOnline();
    assert.equal(online, true);
    assert.equal(enc._connected, true);
  } finally {
    await srv.close();
  }
});

test('custom: isOnline returns false when device is unreachable', async () => {
  const enc = new CustomEncoder({ host: '127.0.0.1', port: 1 });
  const online = await enc.isOnline();
  assert.equal(online, false);
  assert.equal(enc._connected, false);
});

// ── label ──────────────────────────────────────────────────────────────────

test('custom: getStatus details uses configured label', async () => {
  const srv = await createServer((req, res) => respond(res, {}));
  try {
    const enc = new CustomEncoder({ host: '127.0.0.1', port: srv.port, label: 'Streaming PC' });
    const status = await enc.getStatus();
    assert.equal(status.details, 'Streaming PC');
  } finally {
    await srv.close();
  }
});

test('custom: getStatus details defaults to "Custom Encoder" when no label', async () => {
  const srv = await createServer((req, res) => respond(res, {}));
  try {
    const enc = new CustomEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.details, 'Custom Encoder');
  } finally {
    await srv.close();
  }
});

// ── Lifecycle ──────────────────────────────────────────────────────────────

test('custom: disconnect sets _connected=false', async () => {
  const enc = new CustomEncoder({ host: '127.0.0.1', port: 9999 });
  enc._connected = true;
  const result = await enc.disconnect();
  assert.equal(result, true);
  assert.equal(enc._connected, false);
});

// ══════════════════════════════════════════════════════════════════════════
// TallyEncoderAdapter
// ══════════════════════════════════════════════════════════════════════════

// ── isOnline ───────────────────────────────────────────────────────────────

test('tally: isOnline calls /health endpoint', async () => {
  const requests = [];
  const srv = await createServer((req, res) => {
    requests.push(req.url);
    respond(res, { status: 'ok' });
  });
  try {
    const enc = new TallyEncoderAdapter({ host: '127.0.0.1', port: srv.port });
    const online = await enc.isOnline();
    assert.equal(online, true);
    assert.equal(enc._connected, true);
    assert.ok(requests.includes('/health'), `expected /health call; got: ${requests}`);
  } finally {
    await srv.close();
  }
});

test('tally: isOnline returns false when /health is unreachable', async () => {
  const enc = new TallyEncoderAdapter({ host: '127.0.0.1', port: 1 });
  const online = await enc.isOnline();
  assert.equal(online, false);
  assert.equal(enc._connected, false);
});

// ── getStatus ──────────────────────────────────────────────────────────────

test('tally: getStatus calls /status endpoint', async () => {
  const requests = [];
  const srv = await createServer((req, res) => {
    requests.push(req.url);
    // Use bitrate (bps) — the adapter converts via Math.round(bitrate / 1000)
    respond(res, { streaming: true, bitrate: 4_500_000, fps: 30, inputType: 'HDMI' });
  });
  try {
    const enc = new TallyEncoderAdapter({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.ok(requests.includes('/status'), `expected /status call; got: ${requests}`);
    assert.equal(status.type, 'tally-encoder');
    assert.equal(status.connected, true);
    assert.equal(status.live, true);
    assert.equal(status.bitrateKbps, 4500);
    assert.equal(status.fps, 30);
  } finally {
    await srv.close();
  }
});

test('tally: getStatus — live=true from `streaming: true`', async () => {
  const srv = await createServer((req, res) => respond(res, { streaming: true }));
  try {
    const enc = new TallyEncoderAdapter({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.live, true);
  } finally {
    await srv.close();
  }
});

test('tally: getStatus — live=true from `live: true`', async () => {
  const srv = await createServer((req, res) => respond(res, { live: true }));
  try {
    const enc = new TallyEncoderAdapter({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.live, true);
  } finally {
    await srv.close();
  }
});

test('tally: getStatus — inputType appears in details when provided', async () => {
  const srv = await createServer((req, res) => respond(res, { streaming: false, inputType: 'HDMI' }));
  try {
    const enc = new TallyEncoderAdapter({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.ok(status.details.includes('HDMI'), `expected inputType in details; got: ${status.details}`);
  } finally {
    await srv.close();
  }
});

test('tally: getStatus — recording is always false (no record capability)', async () => {
  const srv = await createServer((req, res) => respond(res, { streaming: true, recording: true }));
  try {
    const enc = new TallyEncoderAdapter({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.recording, false);
  } finally {
    await srv.close();
  }
});

test('tally: getStatus — cpuUsage forwarded from response', async () => {
  const srv = await createServer((req, res) => respond(res, { cpuUsage: 55.3 }));
  try {
    const enc = new TallyEncoderAdapter({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.cpuUsage, 55.3);
  } finally {
    await srv.close();
  }
});

test('tally: getStatus — network failure returns connected=false', async () => {
  const enc = new TallyEncoderAdapter({ host: '127.0.0.1', port: 1 });
  const status = await enc.getStatus();
  assert.equal(status.connected, false);
  assert.equal(status.live, false);
  assert.equal(status.type, 'tally-encoder');
});

test('tally: getStatus — HTTP 500 returns connected=false', async () => {
  const srv = await createServer((req, res) => respond(res, 'error', 500));
  try {
    const enc = new TallyEncoderAdapter({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.connected, false);
  } finally {
    await srv.close();
  }
});

test('tally: getStatus — malformed JSON returns connected=true, live=false', async () => {
  const srv = await createServer((req, res) => {
    res.writeHead(200);
    res.end('{ broken ');
  });
  try {
    const enc = new TallyEncoderAdapter({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.connected, true);
    assert.equal(status.live, false);
  } finally {
    await srv.close();
  }
});

// ── default port ───────────────────────────────────────────────────────────

test('tally: constructor defaults to port 7070', () => {
  const enc = new TallyEncoderAdapter({ host: '192.168.1.100' });
  assert.equal(enc.port, 7070);
});

// ── Lifecycle ──────────────────────────────────────────────────────────────

test('tally: disconnect sets _connected=false', async () => {
  const enc = new TallyEncoderAdapter({ host: '127.0.0.1', port: 9999 });
  enc._connected = true;
  const result = await enc.disconnect();
  assert.equal(result, true);
  assert.equal(enc._connected, false);
});

test('tally: connect calls isOnline and returns its result', async () => {
  const srv = await createServer((req, res) => respond(res, { status: 'ok' }));
  try {
    const enc = new TallyEncoderAdapter({ host: '127.0.0.1', port: srv.port });
    const result = await enc.connect();
    assert.equal(result, true);
  } finally {
    await srv.close();
  }
});
