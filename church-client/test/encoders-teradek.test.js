/**
 * Teradek encoder smoke tests
 *
 * Uses a real local HTTP server to verify that TeradekEncoder:
 *   - POSTs login credentials to /cgi-bin/api.cgi and captures the session cookie
 *   - Passes the cookie on subsequent requests
 *   - Correctly parses the status JSON shape returned by /cgi-bin/system.cgi
 *   - Calls the codec-status endpoint for non-VidiU-Go devices
 *   - Skips codec endpoint for VidiU Go devices
 *   - Retries after ##Access denied## response by re-logging in
 *
 * CGI API: POST /cgi-bin/api.cgi (login), GET /cgi-bin/system.cgi, GET /cgi-bin/json.cgi
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { TeradekEncoder } = require('../src/encoders/teradek');

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

// Collects POST body text from a request
function collectBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(body));
  });
}

// Minimal status payload for "ready but not live"
function statusBody(overrides = {}) {
  return {
    status: {
      'Broadcast-State': 'Ready',
      'Record-Status': '0:stopped',
      'System-Power': 'ac:100:unknown:false',
      'Video-Input': 'HDMI:locked',
      ...overrides,
    },
  };
}

// ── Authentication ─────────────────────────────────────────────────────────

test('teradek: _login POSTs credentials to /cgi-bin/api.cgi and captures cookie', async () => {
  const requests = [];
  let postBody = '';

  const srv = await createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url });
    postBody = await collectBody(req);
    respond(res, 'OK', 200, { 'Set-Cookie': 'serenity-session=deadbeef; Path=/' });
  });

  try {
    const enc = new TeradekEncoder({ host: '127.0.0.1', port: srv.port, password: 'hunter2' });
    const success = await enc._login();

    assert.equal(success, true);
    assert.equal(enc._cookie, 'deadbeef');
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/cgi-bin/api.cgi');
    assert.ok(postBody.includes('command=login'), `body should contain command=login; got: ${postBody}`);
    assert.ok(postBody.includes('user=admin'), `body should contain user=admin; got: ${postBody}`);
    assert.ok(postBody.includes('passwd=hunter2'), `body should contain passwd=hunter2; got: ${postBody}`);
  } finally {
    await srv.close();
  }
});

test('teradek: _login returns false when device responds ##Invalid password#', async () => {
  const srv = await createServer(async (req, res) => {
    await collectBody(req);
    res.writeHead(200);
    res.end('##Invalid password#');
  });

  try {
    const enc = new TeradekEncoder({ host: '127.0.0.1', port: srv.port, password: 'wrong' });
    const success = await enc._login();
    assert.equal(success, false);
  } finally {
    await srv.close();
  }
});

test('teradek: subsequent requests send session cookie in Cookie header', async () => {
  const receivedCookies = [];

  const srv = await createServer(async (req, res) => {
    receivedCookies.push(req.headers.cookie || '');
    await collectBody(req);
    if (req.url === '/cgi-bin/api.cgi') {
      respond(res, 'OK', 200, { 'Set-Cookie': 'serenity-session=mysession; Path=/' });
    } else {
      respond(res, statusBody());
    }
  });

  try {
    const enc = new TeradekEncoder({ host: '127.0.0.1', port: srv.port, password: 'admin' });
    await enc._login();
    await enc._authedGet('/cgi-bin/system.cgi?command=status');

    // Second request (status) should include the session cookie
    const cookieHeader = receivedCookies[1] || '';
    assert.ok(cookieHeader.includes('mysession'), `should send session cookie; got: ${cookieHeader}`);
  } finally {
    await srv.close();
  }
});

// ── getStatus — happy path ─────────────────────────────────────────────────

test('teradek: getStatus — Live broadcast returns live=true', async () => {
  const requests = [];

  const srv = await createServer(async (req, res) => {
    requests.push(req.url);
    await collectBody(req);
    if (req.url === '/cgi-bin/api.cgi') {
      respond(res, 'OK', 200, { 'Set-Cookie': 'serenity-session=s1; Path=/' });
    } else if (req.url.includes('/cgi-bin/system.cgi?command=status')) {
      respond(res, statusBody({ 'Broadcast-State': 'Live' }));
    } else if (req.url.includes('/cgi-bin/json.cgi?command=geti&q=Codec.Status')) {
      respond(res, { 'Codec.Status.stream1': JSON.stringify({ encoder: { current_bitrate: 4_000_000 } }) });
    } else {
      respond(res, {});
    }
  });

  try {
    const enc = new TeradekEncoder({ host: '127.0.0.1', port: srv.port, password: 'admin' });
    const status = await enc.getStatus();

    assert.equal(status.type, 'teradek');
    assert.equal(status.connected, true);
    assert.equal(status.live, true);
    assert.equal(status.recording, false);
    assert.equal(status.bitrateKbps, 4000);
    assert.ok(status.details.includes('Live'), `details should mention Live; got: ${status.details}`);
    assert.ok(requests.some((u) => u.includes('/cgi-bin/system.cgi?command=status')), 'should call system status endpoint');
    assert.ok(requests.some((u) => u.includes('Codec.Status')), 'should call codec status endpoint');
  } finally {
    await srv.close();
  }
});

test('teradek: getStatus — Starting state also reports live=true', async () => {
  const srv = await createServer(async (req, res) => {
    await collectBody(req);
    if (req.url === '/cgi-bin/api.cgi') respond(res, 'OK', 200, { 'Set-Cookie': 'serenity-session=s1; Path=/' });
    else if (req.url.includes('/cgi-bin/system.cgi')) respond(res, statusBody({ 'Broadcast-State': 'Starting' }));
    else respond(res, { 'Codec.Status.stream1': JSON.stringify({}) });
  });
  try {
    const enc = new TeradekEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.live, true);
  } finally {
    await srv.close();
  }
});

test('teradek: getStatus — Record-Status "1:..." sets recording=true', async () => {
  const srv = await createServer(async (req, res) => {
    await collectBody(req);
    if (req.url === '/cgi-bin/api.cgi') respond(res, 'OK', 200, { 'Set-Cookie': 'serenity-session=s1; Path=/' });
    else if (req.url.includes('/cgi-bin/system.cgi')) {
      respond(res, statusBody({ 'Record-Status': '1:recording:00:05:30' }));
    } else {
      respond(res, { 'Codec.Status.stream1': JSON.stringify({}) });
    }
  });
  try {
    const enc = new TeradekEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.recording, true);
    assert.equal(status.live, false);
    assert.ok(status.details.includes('Recording'));
  } finally {
    await srv.close();
  }
});

test('teradek: getStatus — battery percentage shown in details', async () => {
  const srv = await createServer(async (req, res) => {
    await collectBody(req);
    if (req.url === '/cgi-bin/api.cgi') respond(res, 'OK', 200, { 'Set-Cookie': 'serenity-session=s1; Path=/' });
    else if (req.url.includes('/cgi-bin/system.cgi')) {
      respond(res, statusBody({ 'System-Power': 'battery:72:unknown:false' }));
    } else {
      respond(res, { 'Codec.Status.stream1': JSON.stringify({}) });
    }
  });
  try {
    const enc = new TeradekEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.ok(status.details.includes('72%'), `expected battery % in details; got: ${status.details}`);
  } finally {
    await srv.close();
  }
});

test('teradek: getStatus — firmware version from connect() appears in details', async () => {
  const srv = await createServer(async (req, res) => {
    await collectBody(req);
    if (req.url === '/cgi-bin/api.cgi') {
      respond(res, 'OK', 200, { 'Set-Cookie': 'serenity-session=s1; Path=/' });
    } else if (req.url.includes('System.Info.Product')) {
      respond(res, {
        'System.Info.Product.productname': 'VidiU Pro',
        'System.Info.Product.serialnumber': 'SN123456',
        'System.Info.Product.productversion': '8.2.1',
      });
    } else if (req.url.includes('/cgi-bin/system.cgi')) {
      respond(res, statusBody());
    } else {
      respond(res, { 'Codec.Status.stream1': JSON.stringify({}) });
    }
  });
  try {
    const enc = new TeradekEncoder({ host: '127.0.0.1', port: srv.port });
    await enc.connect();
    const status = await enc.getStatus();
    assert.ok(status.details.includes('8.2.1'), `expected firmware in details; got: ${status.details}`);
    assert.equal(status.firmwareVersion, '8.2.1');
  } finally {
    await srv.close();
  }
});

// ── VidiU Go — codec endpoint skipped ─────────────────────────────────────

test('teradek: VidiU Go skips Codec.Status endpoint in getStatus', async () => {
  const codecRequests = [];

  const srv = await createServer(async (req, res) => {
    await collectBody(req);
    if (req.url.includes('Codec.Status')) codecRequests.push(req.url);
    if (req.url === '/cgi-bin/api.cgi') {
      respond(res, 'OK', 200, { 'Set-Cookie': 'serenity-session=s1; Path=/' });
    } else if (req.url.includes('System.Info.Product')) {
      respond(res, {
        'System.Info.Product.productname': 'VidiU Go',
        'System.Info.Product.serialnumber': 'SN000',
        'System.Info.Product.productversion': '7.0.0',
      });
    } else if (req.url.includes('/cgi-bin/system.cgi')) {
      respond(res, statusBody());
    } else {
      respond(res, {});
    }
  });

  try {
    const enc = new TeradekEncoder({ host: '127.0.0.1', port: srv.port });
    await enc.connect(); // sets _isVidiuGo = true
    assert.equal(enc._isVidiuGo, true);

    await enc.getStatus();
    assert.equal(codecRequests.length, 0, 'VidiU Go must skip Codec.Status endpoint');
  } finally {
    await srv.close();
  }
});

// ── Access denied → re-login ───────────────────────────────────────────────

test('teradek: ##Access denied## triggers automatic re-login and retry', async () => {
  let callCount = 0;

  const srv = await createServer(async (req, res) => {
    callCount++;
    await collectBody(req);
    // Login endpoint — always sets cookie
    if (req.url === '/cgi-bin/api.cgi') {
      respond(res, 'OK', 200, { 'Set-Cookie': 'serenity-session=renewed; Path=/' });
      return;
    }
    // First status call → access denied; subsequent calls succeed
    if (callCount <= 2) {
      respond(res, '##Access denied#', 200);
    } else if (req.url.includes('/cgi-bin/system.cgi')) {
      respond(res, statusBody());
    } else {
      respond(res, { 'Codec.Status.stream1': JSON.stringify({}) });
    }
  });

  try {
    const enc = new TeradekEncoder({ host: '127.0.0.1', port: srv.port, password: 'admin' });
    const status = await enc.getStatus();
    // Should ultimately succeed after the re-login
    assert.equal(status.type, 'teradek');
    assert.equal(status.connected, true);
  } finally {
    await srv.close();
  }
});

// ── getStatus — offline ────────────────────────────────────────────────────

test('teradek: getStatus — network failure returns connected=false', async () => {
  const enc = new TeradekEncoder({ host: '127.0.0.1', port: 1 });
  const status = await enc.getStatus();
  assert.equal(status.connected, false);
  assert.equal(status.live, false);
  assert.equal(status.type, 'teradek');
  assert.equal(status.bitrateKbps, null);
});

test('teradek: getStatus — HTTP 500 from status endpoint returns connected=false', async () => {
  const srv = await createServer(async (req, res) => {
    await collectBody(req);
    if (req.url === '/cgi-bin/api.cgi') respond(res, 'OK', 200, { 'Set-Cookie': 'serenity-session=s1; Path=/' });
    else respond(res, 'Internal Error', 500);
  });
  try {
    const enc = new TeradekEncoder({ host: '127.0.0.1', port: srv.port });
    const status = await enc.getStatus();
    assert.equal(status.connected, false);
  } finally {
    await srv.close();
  }
});

// ── Stream / Record control ────────────────────────────────────────────────

test('teradek: startStream calls broadcast&action=start endpoint', async () => {
  const requests = [];
  const srv = await createServer(async (req, res) => {
    requests.push(req.url);
    await collectBody(req);
    respond(res, {});
  });
  try {
    const enc = new TeradekEncoder({ host: '127.0.0.1', port: srv.port });
    await enc.startStream();
    assert.ok(
      requests.some((u) => u.includes('command=broadcast') && u.includes('action=start')),
      'expected broadcast&action=start request'
    );
  } finally {
    await srv.close();
  }
});

test('teradek: stopStream calls broadcast&action=stop endpoint', async () => {
  const requests = [];
  const srv = await createServer(async (req, res) => {
    requests.push(req.url);
    await collectBody(req);
    respond(res, {});
  });
  try {
    const enc = new TeradekEncoder({ host: '127.0.0.1', port: srv.port });
    await enc.stopStream();
    assert.ok(
      requests.some((u) => u.includes('command=broadcast') && u.includes('action=stop')),
      'expected broadcast&action=stop request'
    );
  } finally {
    await srv.close();
  }
});

test('teradek: startRecord calls recording&action=start endpoint', async () => {
  const requests = [];
  const srv = await createServer(async (req, res) => {
    requests.push(req.url);
    await collectBody(req);
    respond(res, {});
  });
  try {
    const enc = new TeradekEncoder({ host: '127.0.0.1', port: srv.port });
    await enc.startRecord();
    assert.ok(
      requests.some((u) => u.includes('command=recording') && u.includes('action=start')),
      'expected recording&action=start request'
    );
  } finally {
    await srv.close();
  }
});

test('teradek: stopRecord calls recording&action=stop endpoint', async () => {
  const requests = [];
  const srv = await createServer(async (req, res) => {
    requests.push(req.url);
    await collectBody(req);
    respond(res, {});
  });
  try {
    const enc = new TeradekEncoder({ host: '127.0.0.1', port: srv.port });
    await enc.stopRecord();
    assert.ok(
      requests.some((u) => u.includes('command=recording') && u.includes('action=stop')),
      'expected recording&action=stop request'
    );
  } finally {
    await srv.close();
  }
});

// ── Lifecycle ──────────────────────────────────────────────────────────────

test('teradek: disconnect clears cookie and _connected flag', async () => {
  const enc = new TeradekEncoder({ host: '127.0.0.1', port: 9999 });
  enc._connected = true;
  enc._cookie = 'some-cookie';
  const result = await enc.disconnect();
  assert.equal(result, true);
  assert.equal(enc._connected, false);
  assert.equal(enc._cookie, '');
});
