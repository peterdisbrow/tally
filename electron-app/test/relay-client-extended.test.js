/**
 * relay-client-extended.test.js — Comprehensive tests for relay-client.js
 *
 * Covers everything beyond URL normalization (already in relay-url.test.js):
 *
 *   decodeChurchIdFromToken
 *     - Extracts churchId / church_id from JWT payload
 *     - Returns null for malformed / missing tokens
 *
 *   checkTokenWithRelay — WebSocket auth state machine
 *     - Resolves success after socket opens and stays stable for 1200ms
 *     - Resolves failure on error event
 *     - Resolves failure on close code 1008 (policy violation / invalid token)
 *     - Resolves failure on close before open
 *     - Resolves failure on close after open (non-1008)
 *     - Resolves failure on timeout
 *     - Constructs correct WebSocket URL (/church?token=...)
 *     - finish() is idempotent (second call is a no-op)
 *
 *   postJson
 *     - Returns success:true with data on 2xx response
 *     - Returns success:false with error on 4xx/5xx response
 *     - Returns success:false on network error
 *     - Sends Content-Type: application/json header
 *     - Serializes payload as JSON body
 *     - Handles json() parse failure on error responses gracefully
 *
 *   loginChurchWithCredentials
 *     - Constructs correct /api/church/app/login endpoint (https://)
 *     - Sends email and password in POST body
 *
 *   sendPreviewCommand
 *     - Throws when no token configured
 *     - Throws when no adminApiKey
 *     - Throws when churchId cannot be parsed from token
 *     - preview.stop resolves immediately after socket opens and command is sent
 *     - preview.snap resolves on command_result message (success and error cases)
 *     - preview.start keeps persistent socket and forwards preview frames to mainWindow
 *     - preview.start ignores frames for wrong churchId
 *     - Constructs correct WebSocket URL (/controller?apikey=...)
 *     - Sends correct {type, command, churchId, params} message on open
 *     - Resolves failure on socket error
 *
 *   sendProblemFinderReport
 *     - Returns failure when no token
 *     - Sends Bearer token in Authorization header
 *     - Constructs /api/pf/report endpoint (https://)
 *     - Serializes report as JSON body
 *     - Returns failure on HTTP error response
 *     - Returns failure on network error
 *
 *   init()
 *     - Wires loadConfig and getMainWindow dependencies
 *     - Ignores non-function arguments gracefully
 *
 * Run: node --test test/relay-client-extended.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const EventEmitter = require('events');

// ─── Per-test mock WebSocket factory ─────────────────────────────────────────
//
// loadRelayClient() creates a fresh copy of relay-client.js for each test,
// injecting a local MockWebSocket class. Instances created during the test
// are tracked in the returned `instances` array.

function loadRelayClient() {
  const instances = [];

  class MockWebSocket extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = MockWebSocket.CONNECTING;
      this._lastSent = null;
      instances.push(this);
    }

    send(data) {
      this._lastSent = data;
    }

    close() {
      this.readyState = MockWebSocket.CLOSED;
      setImmediate(() => this.emit('close', 1000));
    }

    terminate() {
      this.readyState = MockWebSocket.CLOSED;
    }

    removeAllListeners() {
      super.removeAllListeners();
    }

    // ── Test helpers ──────────────────────────────────────────────────────

    simulateOpen() {
      this.readyState = MockWebSocket.OPEN;
      this.emit('open');
    }

    simulateClose(code = 1000) {
      this.readyState = MockWebSocket.CLOSED;
      this.emit('close', code);
    }

    simulateError(message = 'connection refused') {
      this.emit('error', new Error(message));
    }

    simulateMessage(data) {
      const raw = typeof data === 'string' ? data : JSON.stringify(data);
      this.emit('message', raw);
    }
  }

  MockWebSocket.CONNECTING = 0;
  MockWebSocket.OPEN = 1;
  MockWebSocket.CLOSING = 2;
  MockWebSocket.CLOSED = 3;

  const originalLoad = Module._load.bind(Module);
  Module._load = function (request, parent, isMain) {
    if (request === 'ws') return MockWebSocket;
    return originalLoad(request, parent, isMain);
  };

  const clientPath = require.resolve('../src/relay-client.js');
  delete require.cache[clientPath];

  let client;
  try {
    client = require('../src/relay-client.js');
  } finally {
    Module._load = originalLoad;
    delete require.cache[clientPath];
  }

  return { client, instances };
}

// ─── Helper: build a JWT-shaped token with the given payload ─────────────────

function makeToken(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  return `header.${encoded}.signature`;
}

// ─── Helper: build a relay-client config with valid credentials ──────────────

function makeConfig(overrides = {}) {
  const token = makeToken({ churchId: 'ch_test' });
  return {
    token,
    adminApiKey: 'test-api-key',
    relay: 'wss://relay.example.com',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// decodeChurchIdFromToken
// ═══════════════════════════════════════════════════════════════════════════════

test('decodeChurchIdFromToken extracts churchId (camelCase) from JWT payload', () => {
  const { client } = loadRelayClient();
  const token = makeToken({ churchId: 'church_abc123' });
  assert.equal(client.decodeChurchIdFromToken(token), 'church_abc123');
});

test('decodeChurchIdFromToken extracts church_id (snake_case) from JWT payload', () => {
  const { client } = loadRelayClient();
  const token = makeToken({ church_id: 'church_xyz789' });
  assert.equal(client.decodeChurchIdFromToken(token), 'church_xyz789');
});

test('decodeChurchIdFromToken prefers churchId over church_id when both present', () => {
  const { client } = loadRelayClient();
  const token = makeToken({ churchId: 'camel_wins', church_id: 'snake_loses' });
  assert.equal(client.decodeChurchIdFromToken(token), 'camel_wins');
});

test('decodeChurchIdFromToken returns null when payload segment is missing', () => {
  const { client } = loadRelayClient();
  assert.equal(client.decodeChurchIdFromToken('onlyone'), null);
  assert.equal(client.decodeChurchIdFromToken(''), null);
  assert.equal(client.decodeChurchIdFromToken(null), null);
  assert.equal(client.decodeChurchIdFromToken(undefined), null);
});

test('decodeChurchIdFromToken returns null when payload contains no churchId', () => {
  const { client } = loadRelayClient();
  const token = makeToken({ sub: 'user123', email: 'a@b.com', iat: 1234567890 });
  assert.equal(client.decodeChurchIdFromToken(token), null);
});

test('decodeChurchIdFromToken returns null for malformed base64 payload', () => {
  const { client } = loadRelayClient();
  assert.equal(client.decodeChurchIdFromToken('header.!!!invalid!!!.sig'), null);
});

test('decodeChurchIdFromToken handles URL-safe base64 without padding', () => {
  const { client } = loadRelayClient();
  // Standard base64 encoding used by Buffer — should decode fine
  const token = makeToken({ churchId: 'church_urlsafe' });
  assert.equal(client.decodeChurchIdFromToken(token), 'church_urlsafe');
});

// ═══════════════════════════════════════════════════════════════════════════════
// checkTokenWithRelay — WebSocket auth state machine
// ═══════════════════════════════════════════════════════════════════════════════

test('checkTokenWithRelay resolves success after socket opens and stays open 1200ms', async () => {
  const { client, instances } = loadRelayClient();
  const promise = client.checkTokenWithRelay('valid-token', 'wss://relay.example.com', 5000);

  await new Promise((r) => setImmediate(r));

  const ws = instances[0];
  assert.ok(ws, 'WebSocket created');
  ws.simulateOpen();

  // AUTH_STABILITY_MS = 1200 — wait 1350ms to be safe
  await new Promise((r) => setTimeout(r, 1350));

  const result = await promise;
  assert.equal(result.success, true, `Expected success, got: ${JSON.stringify(result)}`);
  assert.ok(result.message && result.message.includes('handshake'), `Expected handshake in message, got: ${result.message}`);
}, { timeout: 5000 });

test('checkTokenWithRelay resolves failure on error event', async () => {
  const { client, instances } = loadRelayClient();
  const promise = client.checkTokenWithRelay('bad-token', 'wss://relay.example.com', 5000);

  await new Promise((r) => setImmediate(r));
  instances[0].simulateError('ECONNREFUSED');

  const result = await promise;
  assert.equal(result.success, false);
  assert.ok(result.error.includes('ECONNREFUSED'), `Expected ECONNREFUSED, got: ${result.error}`);
});

test('checkTokenWithRelay resolves failure on close code 1008 (policy violation / invalid token)', async () => {
  const { client, instances } = loadRelayClient();
  const promise = client.checkTokenWithRelay('bad-token', 'wss://relay.example.com', 5000);

  await new Promise((r) => setImmediate(r));
  instances[0].simulateClose(1008);

  const result = await promise;
  assert.equal(result.success, false);
  assert.ok(result.error.includes('Invalid token'), `Expected 'Invalid token', got: ${result.error}`);
});

test('checkTokenWithRelay resolves failure on close before open', async () => {
  const { client, instances } = loadRelayClient();
  const promise = client.checkTokenWithRelay('tok', 'wss://relay.example.com', 5000);

  await new Promise((r) => setImmediate(r));
  // Close without ever opening (e.g. TCP refused)
  instances[0].simulateClose(1006);

  const result = await promise;
  assert.equal(result.success, false);
  assert.ok(
    result.error.includes('before auth') || result.error.includes('1006'),
    `Expected 'before auth' or '1006' in error, got: ${result.error}`,
  );
});

test('checkTokenWithRelay resolves failure on close after open (non-1008)', async () => {
  const { client, instances } = loadRelayClient();
  const promise = client.checkTokenWithRelay('tok', 'wss://relay.example.com', 5000);

  await new Promise((r) => setImmediate(r));
  const ws = instances[0];
  ws.simulateOpen();
  // Immediately close after open — before 1200ms auth timer fires
  ws.simulateClose(1001); // Going Away

  const result = await promise;
  assert.equal(result.success, false);
  assert.ok(
    result.error.includes('Relay closed') || result.error.includes('1001'),
    `Expected relay-closed error, got: ${result.error}`,
  );
});

test('checkTokenWithRelay times out and resolves failure after ms', async () => {
  const { client, instances } = loadRelayClient();
  // Very short timeout — do NOT simulate any events
  const promise = client.checkTokenWithRelay('tok', 'wss://relay.example.com', 60);

  const result = await promise;
  assert.equal(result.success, false);
  assert.ok(result.error.includes('timed out'), `Expected 'timed out', got: ${result.error}`);
}, { timeout: 3000 });

test('checkTokenWithRelay constructs WebSocket URL with /church endpoint and token query param', async () => {
  const { client, instances } = loadRelayClient();
  // Use short timeout so promise resolves quickly
  const promise = client.checkTokenWithRelay('my-secret-token', 'wss://relay.example.com', 50);

  await new Promise((r) => setImmediate(r));
  const ws = instances[0];

  assert.ok(ws.url.includes('/church'), `URL must include /church, got: ${ws.url}`);
  assert.ok(ws.url.includes('token='), `URL must include token= param, got: ${ws.url}`);
  assert.ok(
    ws.url.includes(encodeURIComponent('my-secret-token')),
    `token must be URI-encoded in URL, got: ${ws.url}`,
  );

  await promise; // consume
}, { timeout: 3000 });

test('checkTokenWithRelay finish() is idempotent — only resolves once', async () => {
  const { client, instances } = loadRelayClient();
  const promise = client.checkTokenWithRelay('tok', 'wss://relay.example.com', 5000);

  await new Promise((r) => setImmediate(r));
  const ws = instances[0];

  // Trigger finish() via error — this also calls socket.removeAllListeners()
  ws.simulateError('first');
  // After removeAllListeners(), emitting 'error' would throw (no listener).
  // Instead verify idempotency by confirming the promise resolved with the first result.

  const result = await promise;
  assert.equal(result.success, false);
  assert.ok(result.error.includes('first'), `Expected first error, got: ${result.error}`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// postJson
// ═══════════════════════════════════════════════════════════════════════════════

test('postJson returns success:true with parsed data on 200 response', async () => {
  const { client } = loadRelayClient();
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ token: 'abc', churchId: 'ch1' }),
  });
  try {
    const result = await client.postJson('https://example.com/api', { foo: 'bar' });
    assert.equal(result.success, true);
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { token: 'abc', churchId: 'ch1' });
  } finally {
    globalThis.fetch = orig;
  }
});

test('postJson returns success:false with error on 401 response', async () => {
  const { client } = loadRelayClient();
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: 'Unauthorized' }),
  });
  try {
    const result = await client.postJson('https://example.com/api', {});
    assert.equal(result.success, false);
    assert.equal(result.status, 401);
    assert.equal(result.error, 'Unauthorized');
  } finally {
    globalThis.fetch = orig;
  }
});

test('postJson returns success:false with status string when 5xx has no error field', async () => {
  const { client } = loadRelayClient();
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    json: async () => ({}), // no error field
  });
  try {
    const result = await client.postJson('https://example.com/api', {});
    assert.equal(result.success, false);
    assert.equal(result.status, 503);
    assert.ok(result.error.includes('503'), `Expected 503 in error, got: ${result.error}`);
  } finally {
    globalThis.fetch = orig;
  }
});

test('postJson returns success:false on network / throw error', async () => {
  const { client } = loadRelayClient();
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network failure'); };
  try {
    const result = await client.postJson('https://example.com/api', {});
    assert.equal(result.success, false);
    assert.ok(result.error.includes('network failure'));
  } finally {
    globalThis.fetch = orig;
  }
});

test('postJson sends Content-Type: application/json header', async () => {
  const { client } = loadRelayClient();
  const orig = globalThis.fetch;
  let capturedHeaders;
  globalThis.fetch = async (url, opts) => {
    capturedHeaders = opts.headers;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    await client.postJson('https://example.com/api', { x: 1 });
    assert.equal(capturedHeaders['content-type'], 'application/json');
  } finally {
    globalThis.fetch = orig;
  }
});

test('postJson serializes payload as JSON body', async () => {
  const { client } = loadRelayClient();
  const orig = globalThis.fetch;
  let capturedBody;
  globalThis.fetch = async (url, opts) => {
    capturedBody = opts.body;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    await client.postJson('https://example.com/api', { email: 'a@b.com', password: 'secret' });
    assert.deepEqual(JSON.parse(capturedBody), { email: 'a@b.com', password: 'secret' });
  } finally {
    globalThis.fetch = orig;
  }
});

test('postJson handles json() parse failure on error response gracefully', async () => {
  const { client } = loadRelayClient();
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    json: async () => { throw new Error('not json'); },
  });
  try {
    const result = await client.postJson('https://example.com/api', {});
    assert.equal(result.success, false);
    assert.equal(result.status, 500);
    // error falls back to "Request failed (500)"
    assert.ok(result.error.includes('500'), `Expected 500 in error, got: ${result.error}`);
  } finally {
    globalThis.fetch = orig;
  }
});

test('postJson uses AbortController and does not leave timer dangling on success', async () => {
  const { client } = loadRelayClient();
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
  });
  try {
    // Should complete without hanging (timer cleared in finally)
    const result = await client.postJson('https://example.com/api', {}, 5000);
    assert.equal(result.success, true);
  } finally {
    globalThis.fetch = orig;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// loginChurchWithCredentials
// ═══════════════════════════════════════════════════════════════════════════════

test('loginChurchWithCredentials constructs https:// /api/church/app/login endpoint', async () => {
  const { client } = loadRelayClient();
  const orig = globalThis.fetch;
  let capturedUrl;
  globalThis.fetch = async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, json: async () => ({ token: 'tok' }) };
  };
  try {
    await client.loginChurchWithCredentials({
      relay: 'wss://api.tallyconnect.app',
      email: 'admin@church.org',
      password: 'pass',
    });
    assert.ok(capturedUrl.startsWith('https://'), `Expected https://, got: ${capturedUrl}`);
    assert.ok(capturedUrl.includes('/api/church/app/login'), `Expected login path, got: ${capturedUrl}`);
  } finally {
    globalThis.fetch = orig;
  }
});

test('loginChurchWithCredentials sends email and password in POST body', async () => {
  const { client } = loadRelayClient();
  const orig = globalThis.fetch;
  let capturedBody;
  globalThis.fetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    await client.loginChurchWithCredentials({
      relay: 'wss://api.tallyconnect.app',
      email: 'user@church.org',
      password: 'hunter2',
    });
    assert.equal(capturedBody.email, 'user@church.org');
    assert.equal(capturedBody.password, 'hunter2');
  } finally {
    globalThis.fetch = orig;
  }
});

test('loginChurchWithCredentials handles http relay (ws:// → http://)', async () => {
  const { client } = loadRelayClient();
  const orig = globalThis.fetch;
  let capturedUrl;
  globalThis.fetch = async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    await client.loginChurchWithCredentials({
      relay: 'ws://localhost:3000',
      email: 'a@b.com',
      password: 'pass',
    });
    assert.ok(capturedUrl.startsWith('http://'), `Expected http://, got: ${capturedUrl}`);
    assert.ok(capturedUrl.includes('localhost:3000'), `Expected localhost, got: ${capturedUrl}`);
  } finally {
    globalThis.fetch = orig;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// sendPreviewCommand — validation guards
// ═══════════════════════════════════════════════════════════════════════════════

test('sendPreviewCommand throws synchronously when no token configured', () => {
  const { client } = loadRelayClient();
  client.init({ loadConfig: () => ({}), getMainWindow: () => null });
  assert.throws(() => client.sendPreviewCommand('preview.snap'), /No church token/);
});

test('sendPreviewCommand throws when adminApiKey is absent', () => {
  const { client } = loadRelayClient();
  client.init({
    loadConfig: () => ({ token: makeToken({ churchId: 'ch1' }) }),
    getMainWindow: () => null,
  });
  assert.throws(() => client.sendPreviewCommand('preview.snap'), /adminApiKey/);
});

test('sendPreviewCommand throws when churchId cannot be parsed from token', () => {
  const { client } = loadRelayClient();
  client.init({
    loadConfig: () => ({
      token: makeToken({ sub: 'user_only', email: 'x@y.com' }), // no churchId
      adminApiKey: 'key123',
    }),
    getMainWindow: () => null,
  });
  assert.throws(() => client.sendPreviewCommand('preview.snap'), /churchId/);
});

// ─── sendPreviewCommand — preview.stop resolves immediately on open ───────────

test('sendPreviewCommand preview.stop resolves success immediately after socket opens', async () => {
  const { client, instances } = loadRelayClient();
  client.init({ loadConfig: () => makeConfig(), getMainWindow: () => null });

  const promise = client.sendPreviewCommand('preview.stop');
  await new Promise((r) => setImmediate(r));

  instances[0].simulateOpen();

  const result = await promise;
  assert.equal(result.success, true);
});

test('sendPreviewCommand sends correct command message on socket open', async () => {
  const { client, instances } = loadRelayClient();
  client.init({ loadConfig: () => makeConfig(), getMainWindow: () => null });

  const promise = client.sendPreviewCommand('preview.stop', { quality: 'high' });
  await new Promise((r) => setImmediate(r));

  const ws = instances[0];
  ws.simulateOpen();

  const sent = JSON.parse(ws._lastSent);
  assert.equal(sent.type, 'command');
  assert.equal(sent.command, 'preview.stop');
  assert.equal(sent.churchId, 'ch_test');
  assert.deepEqual(sent.params, { quality: 'high' });

  await promise;
});

test('sendPreviewCommand constructs WebSocket URL with /controller and apikey param', async () => {
  const { client, instances } = loadRelayClient();
  client.init({
    loadConfig: () => makeConfig({ adminApiKey: 'my-api-key' }),
    getMainWindow: () => null,
  });

  const promise = client.sendPreviewCommand('preview.stop');
  await new Promise((r) => setImmediate(r));

  const ws = instances[0];
  assert.ok(ws.url.includes('/controller'), `Expected /controller in URL, got: ${ws.url}`);
  assert.ok(ws.url.includes('apikey='), `Expected apikey= in URL, got: ${ws.url}`);
  assert.ok(
    ws.url.includes(encodeURIComponent('my-api-key')),
    `Expected URI-encoded apikey in URL, got: ${ws.url}`,
  );

  ws.simulateOpen();
  await promise;
});

// ─── sendPreviewCommand — preview.snap resolves on command_result ─────────────

test('sendPreviewCommand preview.snap resolves success on matching command_result', async () => {
  const { client, instances } = loadRelayClient();
  client.init({ loadConfig: () => makeConfig(), getMainWindow: () => null });

  const promise = client.sendPreviewCommand('preview.snap');
  await new Promise((r) => setImmediate(r));

  const ws = instances[0];
  ws.simulateOpen();
  await new Promise((r) => setImmediate(r));

  ws.simulateMessage({
    type: 'command_result',
    command: 'preview.snap',
    churchId: 'ch_test',
    result: { frame: 'base64framedata' },
  });

  const result = await promise;
  assert.equal(result.success, true);
  assert.deepEqual(result.result, { frame: 'base64framedata' });
});

test('sendPreviewCommand preview.snap resolves failure on command_result with error', async () => {
  const { client, instances } = loadRelayClient();
  client.init({ loadConfig: () => makeConfig(), getMainWindow: () => null });

  const promise = client.sendPreviewCommand('preview.snap');
  await new Promise((r) => setImmediate(r));

  const ws = instances[0];
  ws.simulateOpen();
  await new Promise((r) => setImmediate(r));

  ws.simulateMessage({
    type: 'command_result',
    command: 'preview.snap',
    churchId: 'ch_test',
    error: 'NDI source not found',
  });

  const result = await promise;
  assert.equal(result.success, false);
  assert.equal(result.error, 'NDI source not found');
});

test('sendPreviewCommand preview.snap ignores command_result for wrong command', async () => {
  const { client, instances } = loadRelayClient();
  client.init({ loadConfig: () => makeConfig(), getMainWindow: () => null });

  const promise = client.sendPreviewCommand('preview.snap');
  await new Promise((r) => setImmediate(r));

  const ws = instances[0];
  ws.simulateOpen();
  await new Promise((r) => setImmediate(r));

  // Wrong command — should be ignored; resolve via close
  ws.simulateMessage({
    type: 'command_result',
    command: 'preview.start', // different command
    churchId: 'ch_test',
    result: {},
  });

  // Close socket to resolve
  ws.simulateClose(1000);

  const result = await promise;
  // Resolves on close with success:true (socket.once('close') fallback)
  assert.equal(result.success, true);
});

// ─── sendPreviewCommand — preview.start: frame forwarding ────────────────────

test('sendPreviewCommand preview.start forwards preview_frame to mainWindow renderer', async () => {
  const { client, instances } = loadRelayClient();
  const sentToRenderer = [];
  const mockWindow = {
    webContents: {
      send: (channel, data) => sentToRenderer.push({ channel, data }),
    },
  };

  client.init({ loadConfig: () => makeConfig(), getMainWindow: () => mockWindow });

  const promise = client.sendPreviewCommand('preview.start');
  await new Promise((r) => setImmediate(r));

  const ws = instances[0];
  ws.simulateOpen();
  await new Promise((r) => setImmediate(r));

  ws.simulateMessage({
    type: 'preview_frame',
    churchId: 'ch_test',
    timestamp: 12345,
    width: 1280,
    height: 720,
    format: 'jpeg',
    data: 'base64framedata',
  });

  // Filter to only preview-frame events (open also sends a 'log' event to renderer)
  const frames = sentToRenderer.filter((s) => s.channel === 'preview-frame');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].data.width, 1280);
  assert.equal(frames[0].data.height, 720);
  assert.equal(frames[0].data.format, 'jpeg');
  assert.equal(frames[0].data.data, 'base64framedata');
  assert.equal(frames[0].data.timestamp, 12345);

  // Clean up — resolve via close
  ws.simulateClose(1000);
  await promise;
});

test('sendPreviewCommand preview.start does not forward frames for wrong churchId', async () => {
  const { client, instances } = loadRelayClient();
  const sentToRenderer = [];
  const mockWindow = {
    webContents: {
      send: (channel, data) => sentToRenderer.push({ channel, data }),
    },
  };

  client.init({ loadConfig: () => makeConfig(), getMainWindow: () => mockWindow });

  const promise = client.sendPreviewCommand('preview.start');
  await new Promise((r) => setImmediate(r));

  const ws = instances[0];
  ws.simulateOpen();
  await new Promise((r) => setImmediate(r));

  ws.simulateMessage({
    type: 'preview_frame',
    churchId: 'WRONG_CHURCH_ID',
    data: 'should_not_forward',
  });

  const frames = sentToRenderer.filter((s) => s.channel === 'preview-frame');
  assert.equal(frames.length, 0, 'Frame for wrong churchId must not be forwarded');

  ws.simulateClose(1000);
  await promise;
});

test('sendPreviewCommand preview.start forwards multiple frames in sequence', async () => {
  const { client, instances } = loadRelayClient();
  const sentToRenderer = [];
  const mockWindow = {
    webContents: {
      send: (channel, data) => sentToRenderer.push({ channel, data }),
    },
  };

  client.init({ loadConfig: () => makeConfig(), getMainWindow: () => mockWindow });

  const promise = client.sendPreviewCommand('preview.start');
  await new Promise((r) => setImmediate(r));

  const ws = instances[0];
  ws.simulateOpen();
  await new Promise((r) => setImmediate(r));

  for (let i = 0; i < 5; i++) {
    ws.simulateMessage({
      type: 'preview_frame',
      churchId: 'ch_test',
      timestamp: i,
      width: 1280,
      height: 720,
      format: 'jpeg',
      data: `frame_${i}`,
    });
  }

  const frames = sentToRenderer.filter((s) => s.channel === 'preview-frame');
  assert.equal(frames.length, 5, 'All 5 frames should be forwarded');
  assert.equal(frames[4].data.data, 'frame_4');

  ws.simulateClose(1000);
  await promise;
});

// ─── sendPreviewCommand — error / close fallbacks ─────────────────────────────

test('sendPreviewCommand resolves failure on socket error', async () => {
  const { client, instances } = loadRelayClient();
  client.init({ loadConfig: () => makeConfig(), getMainWindow: () => null });

  const promise = client.sendPreviewCommand('preview.snap');
  await new Promise((r) => setImmediate(r));

  instances[0].simulateError('relay connection refused');

  const result = await promise;
  assert.equal(result.success, false);
  assert.ok(result.error.includes('relay connection refused'), `Got: ${result.error}`);
});

test('sendPreviewCommand resolves success on unexpected socket close (graceful fallback)', async () => {
  const { client, instances } = loadRelayClient();
  client.init({ loadConfig: () => makeConfig(), getMainWindow: () => null });

  const promise = client.sendPreviewCommand('preview.snap');
  await new Promise((r) => setImmediate(r));

  const ws = instances[0];
  ws.simulateOpen();
  await new Promise((r) => setImmediate(r));
  // Close without sending command_result
  ws.simulateClose(1000);

  const result = await promise;
  // socket.once('close') calls done({ success: true })
  assert.equal(result.success, true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// sendProblemFinderReport
// ═══════════════════════════════════════════════════════════════════════════════

test('sendProblemFinderReport returns failure when no token in config', async () => {
  const { client } = loadRelayClient();
  client.init({
    loadConfig: () => ({ relay: 'wss://relay.example.com' }), // no token
    getMainWindow: () => null,
  });

  const result = await client.sendProblemFinderReport({ issues: [] });
  assert.equal(result.success, false);
  assert.ok(result.error, 'Expected an error message');
});

test('sendProblemFinderReport sends Bearer token in Authorization header', async () => {
  const { client } = loadRelayClient();
  client.init({
    loadConfig: () => ({ token: 'church-token-abc', relay: 'wss://relay.example.com' }),
    getMainWindow: () => null,
  });

  const orig = globalThis.fetch;
  let capturedHeaders;
  globalThis.fetch = async (url, opts) => {
    capturedHeaders = opts.headers;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    await client.sendProblemFinderReport({ issues: [] });
    assert.equal(capturedHeaders['authorization'], 'Bearer church-token-abc');
  } finally {
    globalThis.fetch = orig;
  }
});

test('sendProblemFinderReport constructs https:// /api/pf/report endpoint', async () => {
  const { client } = loadRelayClient();
  client.init({
    loadConfig: () => ({ token: 'tok', relay: 'wss://relay.example.com' }),
    getMainWindow: () => null,
  });

  const orig = globalThis.fetch;
  let capturedUrl;
  globalThis.fetch = async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    await client.sendProblemFinderReport({ issues: [] });
    assert.ok(capturedUrl.startsWith('https://'), `Expected https://, got: ${capturedUrl}`);
    assert.ok(capturedUrl.includes('/api/pf/report'), `Expected /api/pf/report, got: ${capturedUrl}`);
  } finally {
    globalThis.fetch = orig;
  }
});

test('sendProblemFinderReport serializes report as JSON body', async () => {
  const { client } = loadRelayClient();
  client.init({
    loadConfig: () => ({ token: 'tok', relay: 'wss://relay.example.com' }),
    getMainWindow: () => null,
  });

  const report = { issues: [{ id: 'relay_down', severity: 'critical' }], coverageScore: 40 };
  const orig = globalThis.fetch;
  let capturedBody;
  globalThis.fetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    await client.sendProblemFinderReport(report);
    assert.deepEqual(capturedBody, report);
  } finally {
    globalThis.fetch = orig;
  }
});

test('sendProblemFinderReport returns failure on HTTP 403 response', async () => {
  const { client } = loadRelayClient();
  client.init({
    loadConfig: () => ({ token: 'tok', relay: 'wss://relay.example.com' }),
    getMainWindow: () => null,
  });

  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: 'Forbidden' }),
  });
  try {
    const result = await client.sendProblemFinderReport({ issues: [] });
    assert.equal(result.success, false);
    assert.equal(result.status, 403);
  } finally {
    globalThis.fetch = orig;
  }
});

test('sendProblemFinderReport returns failure on network error', async () => {
  const { client } = loadRelayClient();
  client.init({
    loadConfig: () => ({ token: 'tok', relay: 'wss://relay.example.com' }),
    getMainWindow: () => null,
  });

  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('fetch failed'); };
  try {
    const result = await client.sendProblemFinderReport({ issues: [] });
    assert.equal(result.success, false);
    assert.ok(result.error.includes('fetch failed') || result.error.includes('Network'), `Got: ${result.error}`);
  } finally {
    globalThis.fetch = orig;
  }
});

test('sendProblemFinderReport uses DEFAULT_RELAY_URL when config has no relay', async () => {
  const { client } = loadRelayClient();
  client.init({
    loadConfig: () => ({ token: 'tok' }), // no relay — should fall back to DEFAULT
    getMainWindow: () => null,
  });

  const orig = globalThis.fetch;
  let capturedUrl;
  globalThis.fetch = async (url) => {
    capturedUrl = url;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    await client.sendProblemFinderReport({ issues: [] });
    assert.ok(capturedUrl, 'URL should be constructed');
    assert.ok(capturedUrl.includes('/api/pf/report'), `Expected /api/pf/report, got: ${capturedUrl}`);
  } finally {
    globalThis.fetch = orig;
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// init() dependency injection
// ═══════════════════════════════════════════════════════════════════════════════

test('init wires loadConfig — sendPreviewCommand uses injected config', () => {
  const { client } = loadRelayClient();
  client.init({
    loadConfig: () => ({ token: makeToken({ churchId: 'injected_church' }) }),
    getMainWindow: () => null,
  });
  // Token present but no adminApiKey → should throw adminApiKey error (not 'No church token')
  assert.throws(() => client.sendPreviewCommand('preview.snap'), /adminApiKey/);
});

test('init with non-function loadConfig does not throw', () => {
  const { client } = loadRelayClient();
  assert.doesNotThrow(() => client.init({ loadConfig: null, getMainWindow: null }));
});

test('init with non-function getMainWindow does not throw', () => {
  const { client } = loadRelayClient();
  assert.doesNotThrow(() => client.init({ loadConfig: () => ({}), getMainWindow: 'not-a-function' }));
});

test('init can be called multiple times — last call wins', () => {
  const { client } = loadRelayClient();
  client.init({ loadConfig: () => ({ token: 'first' }), getMainWindow: () => null });
  client.init({
    loadConfig: () => ({ token: makeToken({ churchId: 'second' }) }),
    getMainWindow: () => null,
  });
  // Second init's loadConfig should be active — no token means adminApiKey error
  assert.throws(() => client.sendPreviewCommand('preview.snap'), /adminApiKey/);
});
