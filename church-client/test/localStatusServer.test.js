/**
 * Tests for the local-status HTTP server. This is the data source the
 * Electron desktop app falls back to when the relay is unreachable.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startLocalStatusServer } = require('../src/localStatusServer');

async function getJson(port, path = '/local-status') {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

test('serves /local-status with the current status snapshot', async () => {
  let counter = 0;
  const handle = await startLocalStatusServer({
    getStatus: () => ({ tick: ++counter, atem: { connected: true } }),
  });
  try {
    const r1 = await getJson(handle.port);
    assert.equal(r1.status, 200);
    assert.equal(r1.body.ok, true);
    assert.equal(r1.body.status.tick, 1);
    assert.equal(r1.body.status.atem.connected, true);
    assert.ok(typeof r1.body.generatedAt === 'string');

    const r2 = await getJson(handle.port);
    assert.equal(r2.body.status.tick, 2, 'snapshot is regenerated each request');
  } finally {
    await handle.stop();
  }
});

test('also serves the snapshot on /', async () => {
  const handle = await startLocalStatusServer({
    getStatus: () => ({ ping: 'pong' }),
  });
  try {
    const r = await getJson(handle.port, '/');
    assert.equal(r.status, 200);
    assert.equal(r.body.status.ping, 'pong');
  } finally {
    await handle.stop();
  }
});

test('returns 404 for unknown paths', async () => {
  const handle = await startLocalStatusServer({ getStatus: () => ({}) });
  try {
    const r = await getJson(handle.port, '/something-else');
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'not_found');
  } finally {
    await handle.stop();
  }
});

test('rejects non-GET methods', async () => {
  const handle = await startLocalStatusServer({ getStatus: () => ({}) });
  try {
    const r = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: handle.port,
        path: '/local-status',
        method: 'POST',
        timeout: 2000,
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.end();
    });
    assert.equal(r.status, 405);
    assert.equal(r.body.error, 'method_not_allowed');
  } finally {
    await handle.stop();
  }
});

test('binds to loopback only', async () => {
  const handle = await startLocalStatusServer({ getStatus: () => ({}) });
  try {
    const addr = handle.server.address();
    assert.equal(addr.address, '127.0.0.1');
  } finally {
    await handle.stop();
  }
});

test('returns 500 if getStatus throws', async () => {
  const handle = await startLocalStatusServer({
    getStatus: () => { throw new Error('boom'); },
  });
  try {
    const r = await getJson(handle.port);
    assert.equal(r.status, 500);
    assert.equal(r.body.error, 'serialization_failed');
  } finally {
    await handle.stop();
  }
});

test('throws if getStatus is not a function', () => {
  assert.throws(
    () => startLocalStatusServer({ getStatus: 'not-a-fn' }),
    /getStatus must be a function/,
  );
});
