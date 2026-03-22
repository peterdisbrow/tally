'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { CompanionBridge } = require('../src/companion.js');

// ─── Constructor ──────────────────────────────────────────────────────────────

describe('CompanionBridge constructor', () => {
  let bridge;
  afterEach(() => bridge && bridge.stopPolling());

  test('default baseUrl is http://localhost:8888', () => {
    bridge = new CompanionBridge();
    assert.equal(bridge.baseUrl, 'http://localhost:8888');
  });

  test('strips trailing slash from companionUrl', () => {
    bridge = new CompanionBridge({ companionUrl: 'http://localhost:8888/' });
    assert.equal(bridge.baseUrl, 'http://localhost:8888');
  });

  test('custom buttonPollPages is stored', () => {
    bridge = new CompanionBridge({ buttonPollPages: [1, 2] });
    assert.deepEqual(bridge._buttonPollPages, [1, 2]);
  });

  test('starts with connected=false and connectionCount=0', () => {
    bridge = new CompanionBridge();
    assert.equal(bridge.connected, false);
    assert.equal(bridge.connectionCount, 0);
  });

  test('_buttonIndex is a Map', () => {
    bridge = new CompanionBridge();
    assert.ok(bridge._buttonIndex instanceof Map);
  });

  test('_buttonStates is a Map', () => {
    bridge = new CompanionBridge();
    assert.ok(bridge._buttonStates instanceof Map);
  });

  test('_recentButtonPresses is an empty array', () => {
    bridge = new CompanionBridge();
    assert.ok(Array.isArray(bridge._recentButtonPresses));
    assert.equal(bridge._recentButtonPresses.length, 0);
  });
});

// ─── isAvailable() ────────────────────────────────────────────────────────────

describe('isAvailable()', () => {
  let bridge;
  afterEach(() => bridge && bridge.stopPolling());

  test('returns true and sets connected=true on status 200', async () => {
    bridge = new CompanionBridge();
    bridge._request = async () => ({ status: 200, body: null });
    const result = await bridge.isAvailable();
    assert.equal(result, true);
    assert.equal(bridge.connected, true);
  });

  test('returns true on status 404 (Companion is reachable)', async () => {
    bridge = new CompanionBridge();
    bridge._request = async () => ({ status: 404, body: null });
    const result = await bridge.isAvailable();
    assert.equal(result, true);
    assert.equal(bridge.connected, true);
  });

  test('returns false and sets connected=false on status 500', async () => {
    bridge = new CompanionBridge();
    bridge._request = async () => ({ status: 500, body: null });
    const result = await bridge.isAvailable();
    assert.equal(result, false);
    assert.equal(bridge.connected, false);
  });

  test('returns false and sets connected=false when _request throws', async () => {
    bridge = new CompanionBridge();
    bridge._request = async () => { throw new Error('ECONNREFUSED'); };
    const result = await bridge.isAvailable();
    assert.equal(result, false);
    assert.equal(bridge.connected, false);
  });
});

// ─── pressButton() ────────────────────────────────────────────────────────────

describe('pressButton()', () => {
  let bridge;
  afterEach(() => bridge && bridge.stopPolling());

  test('returns { success:true, page, row, col } on status 200', async () => {
    bridge = new CompanionBridge();
    bridge._request = async () => ({ status: 200, body: {} });
    const result = await bridge.pressButton(1, 0, 3);
    assert.deepEqual(result, { success: true, page: 1, row: 0, col: 3 });
  });

  test('calls _request with POST and the correct path', async () => {
    bridge = new CompanionBridge();
    const calls = [];
    bridge._request = async (method, path) => {
      calls.push({ method, path });
      return { status: 200, body: {} };
    };
    await bridge.pressButton(2, 1, 4);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].path, '/api/location/2/1/4/press');
  });

  test('throws when status >= 400', async () => {
    bridge = new CompanionBridge();
    bridge._request = async () => ({ status: 404, body: { message: 'Not found' } });
    await assert.rejects(
      () => bridge.pressButton(1, 0, 0),
      /Not found|Press failed/
    );
  });

  test('throws with default message when body has no message', async () => {
    bridge = new CompanionBridge();
    bridge._request = async () => ({ status: 500, body: null });
    await assert.rejects(
      () => bridge.pressButton(1, 0, 0),
      /Press failed \(500\)/
    );
  });
});

// ─── pressNamed() ─────────────────────────────────────────────────────────────

describe('pressNamed()', () => {
  let bridge;
  afterEach(() => bridge && bridge.stopPolling());

  test('presses the exact button when it is found in the index', async () => {
    bridge = new CompanionBridge();
    bridge._buttonIndex = new Map([
      ['worship song', { page: 1, row: 0, col: 2, text: 'Worship Song' }],
    ]);
    bridge._buttonIndexBuiltAt = Date.now();
    bridge._request = async (method, path) => ({ status: 200, body: { text: 'Worship Song' } });
    const result = await bridge.pressNamed('worship song');
    assert.equal(result.page, 1);
    assert.equal(result.row, 0);
    assert.equal(result.col, 2);
    assert.equal(result.success, true);
  });

  test('fuzzy (substring) match finds button when full name not given', async () => {
    bridge = new CompanionBridge();
    bridge._buttonIndex = new Map([
      ['worship song', { page: 1, row: 0, col: 2, text: 'Worship Song' }],
    ]);
    bridge._buttonIndexBuiltAt = Date.now();
    bridge._request = async () => ({ status: 200, body: {} });
    const result = await bridge.pressNamed('worship');
    assert.equal(result.success, true);
  });

  test('throws "No button found matching" when name not in index after full refresh', async () => {
    bridge = new CompanionBridge();
    bridge._buttonIndex = new Map();
    bridge._buttonIndexBuiltAt = Date.now();
    // Mock _buildButtonIndex to be a no-op (leaves index empty)
    bridge._buildButtonIndex = async () => {
      bridge._buttonIndex = new Map();
      bridge._buttonIndexBuiltAt = Date.now();
    };
    await assert.rejects(
      () => bridge.pressNamed('nonexistent button xyz'),
      /No button found matching/
    );
  });
});

// ─── _extractConnections() ────────────────────────────────────────────────────

describe('_extractConnections()', () => {
  let bridge;
  beforeEach(() => { bridge = new CompanionBridge(); });
  afterEach(() => bridge.stopPolling());

  test('returns [] when body is null', () => {
    assert.deepEqual(bridge._extractConnections(null), []);
  });

  test('returns [] when body is undefined', () => {
    assert.deepEqual(bridge._extractConnections(undefined), []);
  });

  test('returns body as-is when body is already an array', () => {
    const arr = [{ id: 'a' }];
    assert.deepEqual(bridge._extractConnections(arr), arr);
  });

  test('returns body.connections when it is an array', () => {
    const conns = [{ id: 'b' }];
    assert.deepEqual(bridge._extractConnections({ connections: conns }), conns);
  });

  test('returns body.modules when it is an array', () => {
    const mods = [{ id: 'c' }];
    assert.deepEqual(bridge._extractConnections({ modules: mods }), mods);
  });

  test('returns body.instances when it is an array', () => {
    const insts = [{ id: 'd' }];
    assert.deepEqual(bridge._extractConnections({ instances: insts }), insts);
  });

  test('maps plain object entries when no array props exist', () => {
    // The implementation returns Object.entries mapped to { id, ...value }
    const body = { myConn: { label: 'Test', status: 'ok' } };
    const result = bridge._extractConnections(body);
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'myConn');
    assert.equal(result[0].label, 'Test');
  });
});

// ─── stopPolling() ────────────────────────────────────────────────────────────

describe('stopPolling()', () => {
  let bridge;
  afterEach(() => bridge && bridge.stopPolling());

  test('can be called without error when not polling', () => {
    bridge = new CompanionBridge();
    assert.doesNotThrow(() => bridge.stopPolling());
  });

  test('can be called multiple times without error', () => {
    bridge = new CompanionBridge();
    assert.doesNotThrow(() => {
      bridge.stopPolling();
      bridge.stopPolling();
    });
  });

  test('clears _pollTimer after stopping', () => {
    bridge = new CompanionBridge();
    bridge.stopPolling();
    assert.equal(bridge._pollTimer, null);
  });
});
