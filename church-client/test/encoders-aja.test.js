/**
 * AJA HELO encoder smoke tests
 *
 * Uses a real local HTTP server to verify that AjaEncoder:
 *   - Calls /config?action=get&paramid=... for each status parameter
 *   - Calls /config?action=set&paramid=eParamID_ReplicatorCommand&value=N for control
 *   - POSTs to /authenticator/login when a password is set
 *   - Correctly maps stream state value 2 → live=true, record state 2 → recording=true
 *   - Maps video/audio input enum values to human-readable labels
 *   - Handles network failures gracefully
 *
 * REST API: GET /config?action=get|set&paramid=eParamID_*
 * Auth (optional): POST /authenticator/login
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { AjaEncoder } = require('../src/encoders/aja');

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

function respond(res, body, status = 200, extraHeaders = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(payload);
}

function collectBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(body));
  });
}

// Build a full set of default param responses for getStatus
function defaultParams() {
  return {
    eParamID_ReplicatorStreamState: '0',   // Uninit/Idle → not streaming
    eParamID_ReplicatorRecordState: '0',   // Idle
    eParamID_Temperature: '42',
    eParamID_CurrentMediaAvailable: '85',
    eParamID_VideoInSelect: '0',           // SDI
    eParamID_AudioInSelect: '1',           // HDMI
    eParamID_StreamingDuration: '0',
    eParamID_RecordingDuration: '0',
    eParamID_SchedulerEnabled: '0',
    eParamID_AVMute: '0',
  };
}

// Server that responds to /config?action=get&paramid=X with { value: params[X] }
function paramServer(params, overrides = {}) {
  return createServer(async (req, res) => {
    await collectBody(req);
    const url = new URL(req.url, 'http://localhost');
    if (req.url.includes('/authenticator/login')) {
      return respond(res, { ok: true }, 200, { 'Set-Cookie': 'serenity-session=sess1; Path=/' });
    }
    if (url.pathname === '/config' && url.searchParams.get('action') === 'get') {
      const paramid = url.searchParams.get('paramid');
      const merged = { ...params, ...overrides };
      const value = merged[paramid];
      if (value !== undefined) return respond(res, { value });
    }
    if (url.pathname === '/config' && url.searchParams.get('action') === 'set') {
      return respond(res, { ok: true });
    }
    respond(res, {}, 404);
  });
}

// ── getStatus — happy path ─────────────────────────────────────────────────

test('aja: getStatus — idle device, all params fetched, returns connected=true live=false', async () => {
  const requests = [];
  const params = defaultParams();
  const srv = await createServer(async (req, res) => {
    requests.push(req.url);
    await collectBody(req);
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/config' && url.searchParams.get('action') === 'get') {
      const paramid = url.searchParams.get('paramid');
      if (params[paramid] !== undefined) return respond(res, { value: params[paramid] });
    }
    respond(res, {}, 404);
  });

  try {
    const enc = new AjaEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();

    assert.equal(status.type, 'aja');
    assert.equal(status.connected, true);
    assert.equal(status.live, false);
    assert.equal(status.recording, false);
    assert.equal(status.bitrateKbps, null); // AJA never exposes runtime bitrate
    assert.equal(status.fps, null);
    assert.equal(status.videoInput, 'SDI');
    assert.equal(status.audioInput, 'HDMI');
    assert.equal(status.muted, false);
    assert.equal(status.failing, false);

    // Verify all 10 param IDs were requested
    const paramIds = requests
      .filter((u) => u.includes('action=get'))
      .map((u) => new URL(u, 'http://localhost').searchParams.get('paramid'));
    assert.ok(paramIds.includes('eParamID_ReplicatorStreamState'));
    assert.ok(paramIds.includes('eParamID_ReplicatorRecordState'));
    assert.ok(paramIds.includes('eParamID_Temperature'));
    assert.ok(paramIds.includes('eParamID_CurrentMediaAvailable'));
    assert.ok(paramIds.includes('eParamID_VideoInSelect'));
    assert.ok(paramIds.includes('eParamID_AudioInSelect'));
    assert.ok(paramIds.includes('eParamID_StreamingDuration'));
    assert.ok(paramIds.includes('eParamID_RecordingDuration'));
    assert.ok(paramIds.includes('eParamID_SchedulerEnabled'));
    assert.ok(paramIds.includes('eParamID_AVMute'));
  } finally {
    await srv.close();
  }
});

test('aja: getStatus — stream state 2 sets live=true', async () => {
  const srv = await paramServer(defaultParams(), { eParamID_ReplicatorStreamState: '2' });
  try {
    const enc = new AjaEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.live, true);
    assert.ok(status.details.includes('Streaming'));
  } finally {
    await srv.close();
  }
});

test('aja: getStatus — record state 2 sets recording=true', async () => {
  const srv = await paramServer(defaultParams(), { eParamID_ReplicatorRecordState: '2' });
  try {
    const enc = new AjaEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.recording, true);
    assert.ok(status.details.includes('Recording'));
  } finally {
    await srv.close();
  }
});

test('aja: getStatus — stream state >= 3 sets failing=true', async () => {
  const srv = await paramServer(defaultParams(), { eParamID_ReplicatorStreamState: '3' });
  try {
    const enc = new AjaEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.failing, true);
    assert.ok(status.details.includes('Error'));
  } finally {
    await srv.close();
  }
});

test('aja: getStatus — mute state 1 shows in details and status', async () => {
  const srv = await paramServer(defaultParams(), { eParamID_AVMute: '1' });
  try {
    const enc = new AjaEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.muted, true);
    assert.ok(status.details.includes('Muted'));
  } finally {
    await srv.close();
  }
});

test('aja: getStatus — temperature and media percentage shown in details', async () => {
  const srv = await paramServer(defaultParams(), {
    eParamID_Temperature: '58',
    eParamID_CurrentMediaAvailable: '42',
  });
  try {
    const enc = new AjaEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.ok(status.details.includes('58°C'), `expected temp in details; got: ${status.details}`);
    assert.ok(status.details.includes('42% storage'), `expected media in details; got: ${status.details}`);
    assert.equal(status.temperature, '58°C');
    assert.equal(status.mediaAvailable, '42%');
  } finally {
    await srv.close();
  }
});

test('aja: getStatus — HDMI video input label', async () => {
  const srv = await paramServer(defaultParams(), { eParamID_VideoInSelect: '1' });
  try {
    const enc = new AjaEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.videoInput, 'HDMI');
  } finally {
    await srv.close();
  }
});

test('aja: getStatus — streaming duration formatted as H:MM:SS in details', async () => {
  const srv = await paramServer(defaultParams(), {
    eParamID_ReplicatorStreamState: '2',
    eParamID_StreamingDuration: String(2 * 3600 + 15 * 60 + 42), // 2h15m42s
  });
  try {
    const enc = new AjaEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.ok(status.details.includes('2:15:42'), `expected duration; got: ${status.details}`);
    assert.equal(status.streamDuration, '2:15:42');
  } finally {
    await srv.close();
  }
});

test('aja: getStatus — scheduler enabled=true reflected in status', async () => {
  const srv = await paramServer(defaultParams(), { eParamID_SchedulerEnabled: '1' });
  try {
    const enc = new AjaEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.schedulerEnabled, true);
  } finally {
    await srv.close();
  }
});

// ── getStatus — error paths ────────────────────────────────────────────────

test('aja: getStatus — network failure returns connected=false', async () => {
  const enc = new AjaEncoder({ host: '127.0.0.1', port: 1 });
  const status = await enc.getStatus();
  assert.equal(status.connected, false);
  assert.equal(status.live, false);
  assert.equal(status.type, 'aja');
});

test('aja: getStatus — HTTP 500 returns connected=false', async () => {
  const srv = await createServer(async (req, res) => {
    await collectBody(req);
    respond(res, 'Server Error', 500);
  });
  try {
    const enc = new AjaEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.connected, false);
  } finally {
    await srv.close();
  }
});

// ── Stream / Record control ────────────────────────────────────────────────

test('aja: startStream sends set&paramid=eParamID_ReplicatorCommand&value=3', async () => {
  const requests = [];
  const srv = await createServer(async (req, res) => {
    requests.push(req.url);
    await collectBody(req);
    respond(res, { ok: true });
  });
  try {
    const enc = new AjaEncoder({ host: '127.0.0.1', port: srv.port });
    await enc.startStream();
    assert.ok(
      requests.some((u) => u.includes('action=set') && u.includes('eParamID_ReplicatorCommand') && u.includes('value=3')),
      'expected set ReplicatorCommand=3 for start stream'
    );
  } finally {
    await srv.close();
  }
});

test('aja: stopStream sends set&paramid=eParamID_ReplicatorCommand&value=4', async () => {
  const requests = [];
  const srv = await createServer(async (req, res) => {
    requests.push(req.url);
    await collectBody(req);
    respond(res, { ok: true });
  });
  try {
    const enc = new AjaEncoder({ host: '127.0.0.1', port: srv.port });
    await enc.stopStream();
    assert.ok(
      requests.some((u) => u.includes('action=set') && u.includes('eParamID_ReplicatorCommand') && u.includes('value=4')),
      'expected set ReplicatorCommand=4 for stop stream'
    );
  } finally {
    await srv.close();
  }
});

test('aja: startRecord sends set&paramid=eParamID_ReplicatorCommand&value=1', async () => {
  const requests = [];
  const srv = await createServer(async (req, res) => {
    requests.push(req.url);
    await collectBody(req);
    respond(res, { ok: true });
  });
  try {
    const enc = new AjaEncoder({ host: '127.0.0.1', port: srv.port });
    await enc.startRecord();
    assert.ok(
      requests.some((u) => u.includes('action=set') && u.includes('eParamID_ReplicatorCommand') && u.includes('value=1')),
      'expected set ReplicatorCommand=1 for start record'
    );
  } finally {
    await srv.close();
  }
});

test('aja: stopRecord sends set&paramid=eParamID_ReplicatorCommand&value=2', async () => {
  const requests = [];
  const srv = await createServer(async (req, res) => {
    requests.push(req.url);
    await collectBody(req);
    respond(res, { ok: true });
  });
  try {
    const enc = new AjaEncoder({ host: '127.0.0.1', port: srv.port });
    await enc.stopRecord();
    assert.ok(
      requests.some((u) => u.includes('action=set') && u.includes('eParamID_ReplicatorCommand') && u.includes('value=2')),
      'expected set ReplicatorCommand=2 for stop record'
    );
  } finally {
    await srv.close();
  }
});

// ── Authentication ─────────────────────────────────────────────────────────

test('aja: _login POSTs to /authenticator/login with password', async () => {
  const requests = [];
  let postBody = '';

  const srv = await createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url });
    postBody = await collectBody(req);
    respond(res, { ok: true }, 200, { 'Set-Cookie': 'serenity-session=ajatoken; Path=/' });
  });

  try {
    const enc = new AjaEncoder({ host: '127.0.0.1', port: srv.port, password: 'securepass' });
    const success = await enc._login();

    assert.equal(success, true);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/authenticator/login');
    assert.ok(postBody.includes('password_provided=securepass'), `expected password in body; got: ${postBody}`);
  } finally {
    await srv.close();
  }
});

test('aja: connect calls _login when password is set', async () => {
  const requests = [];

  const srv = await createServer(async (req, res) => {
    requests.push(req.url);
    await collectBody(req);
    if (req.url === '/authenticator/login') {
      return respond(res, { ok: true }, 200, { 'Set-Cookie': 'serenity-session=tok; Path=/' });
    }
    // isOnline → _getParam(STREAM_STATE)
    respond(res, { value: '0' });
  });

  try {
    const enc = new AjaEncoder({ host: '127.0.0.1', port: srv.port, password: 'secret' });
    await enc.connect();
    assert.ok(requests.includes('/authenticator/login'), 'connect should call login when password set');
  } finally {
    await srv.close();
  }
});

test('aja: connect skips login when no password configured', async () => {
  const requests = [];

  const srv = await createServer(async (req, res) => {
    requests.push(req.url);
    await collectBody(req);
    respond(res, { value: '0' });
  });

  try {
    const enc = new AjaEncoder({ host: '127.0.0.1', port: srv.port });
    await enc.connect();
    assert.ok(!requests.includes('/authenticator/login'), 'connect should skip login without password');
  } finally {
    await srv.close();
  }
});

// ── Configuration methods ──────────────────────────────────────────────────

test('aja: setVideoInput sends set&paramid=eParamID_VideoInSelect with value', async () => {
  const requests = [];
  const srv = await createServer(async (req, res) => {
    requests.push(req.url);
    await collectBody(req);
    respond(res, { ok: true });
  });
  try {
    const enc = new AjaEncoder({ host: '127.0.0.1', port: srv.port });
    await enc.setVideoInput(1); // 1 = HDMI
    assert.ok(
      requests.some((u) => u.includes('eParamID_VideoInSelect') && u.includes('value=1')),
      'expected set VideoInSelect=1'
    );
  } finally {
    await srv.close();
  }
});

test('aja: setMute(true) sends set&paramid=eParamID_AVMute&value=1', async () => {
  const requests = [];
  const srv = await createServer(async (req, res) => {
    requests.push(req.url);
    await collectBody(req);
    respond(res, { ok: true });
  });
  try {
    const enc = new AjaEncoder({ host: '127.0.0.1', port: srv.port });
    await enc.setMute(true);
    assert.ok(
      requests.some((u) => u.includes('eParamID_AVMute') && u.includes('value=1')),
      'expected set AVMute=1 for mute'
    );
  } finally {
    await srv.close();
  }
});

// ── Lifecycle ──────────────────────────────────────────────────────────────

test('aja: disconnect clears cookie and _connected flag', async () => {
  const enc = new AjaEncoder({ host: '127.0.0.1', port: 9999 });
  enc._connected = true;
  enc._cookie = 'serenity-session=old';
  const result = await enc.disconnect();
  assert.equal(result, true);
  assert.equal(enc._connected, false);
  assert.equal(enc._cookie, '');
});
