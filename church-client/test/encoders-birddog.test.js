/**
 * BirdDog encoder smoke tests
 *
 * BirdDogEncoder uses the global `fetch` API. Tests replace globalThis.fetch
 * with a controlled mock that verifies exact URLs, auth headers, and response
 * parsing.
 *
 * Key behaviours:
 *   - _probeIdentity tries /about → /version → /List until one looks like BirdDog
 *   - Identity probe result is cached for 30 s (bypass with force=true)
 *   - _probeDecodeStatus hits /decodestatus?ChNum=1 for decoder source/state
 *   - getStatus combines web API identity + NDI encoder status
 *   - Optional HTTP Basic auth header when password is set
 *   - All requests fail gracefully when host is empty or unreachable
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BirdDogEncoder } = require('../src/encoders/birddog');

// ── fetch mock helpers ─────────────────────────────────────────────────────

function withFetch(routes, fn) {
  const original = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {} });
    const urlStr = String(url);
    for (const [pattern, response] of routes) {
      const matches = typeof pattern === 'string' ? urlStr.includes(pattern) : pattern.test(urlStr);
      if (matches) {
        return typeof response === 'function' ? await response(urlStr, opts) : response;
      }
    }
    return mockResp('Not Found', 404);
  };

  const getCalls = () => calls;

  return fn(getCalls).finally(() => {
    globalThis.fetch = original;
  });
}

function mockResp(body, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 400,
    status,
    text: async () => text,
    json: async () => (typeof body === 'object' ? body : (() => { try { return JSON.parse(text); } catch { return null; } })()),
  };
}

// BirdDog-looking response bodies
const BIRDDOG_ABOUT = JSON.stringify({ model: 'BirdDog P400', firmware: '4.0.1.3', product: 'BirdDog P400' });
const BIRDDOG_DECODE = JSON.stringify({ source: 'BirdDog Cam (SERVER-PC)', status: 'connected' });

// ── _probeIdentity — endpoint selection ───────────────────────────────────

test('birddog: _probeIdentity succeeds via /about when body contains "birddog"', async () => {
  await withFetch(
    [['/about', mockResp(BIRDDOG_ABOUT)]],
    async (getCalls) => {
      const enc = new BirdDogEncoder({ host: '192.168.1.70', port: 8080 });
      await enc._probeIdentity(true);

      assert.equal(enc._connected, true);
      assert.ok(enc._model.toLowerCase().includes('birddog') || enc._model.includes('P400'),
        `expected BirdDog model; got: ${enc._model}`);
      assert.equal(enc._firmware, '4.0.1.3');
      assert.ok(getCalls().some((c) => c.url.includes('/about')));
    }
  );
});

test('birddog: _probeIdentity falls back to /version when /about returns 404', async () => {
  await withFetch(
    [
      ['/about', mockResp('Not Found', 404)],
      ['/version', mockResp(JSON.stringify({ model: 'BirdDog 4K', firmware: '4.1.0', fwversion: '4.1.0' }))],
    ],
    async (getCalls) => {
      const enc = new BirdDogEncoder({ host: '192.168.1.70', port: 8080 });
      await enc._probeIdentity(true);

      assert.equal(enc._connected, true);
      assert.ok(getCalls().some((c) => c.url.includes('/version')));
    }
  );
});

test('birddog: _probeIdentity falls back to /List when /about and /version fail', async () => {
  const listBody = JSON.stringify({ birddog_version: '4.0', model: 'BirdDog Mini' });
  await withFetch(
    [
      ['/about', mockResp('Not Found', 404)],
      ['/version', mockResp('Not Found', 404)],
      ['/List', mockResp(listBody)],
    ],
    async (getCalls) => {
      const enc = new BirdDogEncoder({ host: '192.168.1.70', port: 8080 });
      await enc._probeIdentity(true);

      assert.equal(enc._connected, true);
      assert.ok(getCalls().some((c) => c.url.includes('/List')));
    }
  );
});

test('birddog: _probeIdentity sets _connected=false when no endpoint works', async () => {
  await withFetch(
    [['', mockResp('error', 500)]],
    async () => {
      const enc = new BirdDogEncoder({ host: '192.168.1.70', port: 8080 });
      await enc._probeIdentity(true);
      assert.equal(enc._connected, false);
    }
  );
});

test('birddog: _probeIdentity result is cached — second call does not re-fetch', async () => {
  let probeCount = 0;

  await withFetch(
    [['/about', async () => {
      probeCount++;
      return mockResp(BIRDDOG_ABOUT);
    }]],
    async () => {
      const enc = new BirdDogEncoder({ host: '192.168.1.70', port: 8080 });
      await enc._probeIdentity(true);  // force refresh
      const countAfterFirst = probeCount;
      await enc._probeIdentity();       // within cache window
      assert.equal(probeCount, countAfterFirst, 'second probe should use cached result');
    }
  );
});

// ── host is empty ──────────────────────────────────────────────────────────

test('birddog: _request returns ok=false immediately when host is empty', async () => {
  await withFetch([], async (getCalls) => {
    const enc = new BirdDogEncoder({ host: '' });
    const result = await enc._request('/about');
    assert.equal(result.ok, false);
    assert.equal(getCalls().length, 0, 'should not call fetch when host is empty');
  });
});

test('birddog: getStatus — empty host returns connected=false without error', async () => {
  await withFetch([], async () => {
    const enc = new BirdDogEncoder({ host: '' });
    const status = await enc.getStatus();
    assert.equal(status.connected, false);
    assert.equal(status.type, 'birddog');
  });
});

// ── _probeDecodeStatus ─────────────────────────────────────────────────────

test('birddog: _probeDecodeStatus calls /decodestatus?ChNum=1', async () => {
  await withFetch(
    [['/decodestatus?ChNum=1', mockResp(BIRDDOG_DECODE)]],
    async (getCalls) => {
      const enc = new BirdDogEncoder({ host: '192.168.1.70', port: 8080 });
      const result = await enc._probeDecodeStatus();

      assert.ok(getCalls().some((c) => c.url.includes('/decodestatus?ChNum=1')));
      assert.equal(result.source, 'BirdDog Cam (SERVER-PC)');
      assert.equal(result.status, 'connected');
    }
  );
});

test('birddog: _probeDecodeStatus returns empty object on failure', async () => {
  await withFetch(
    [['/decodestatus', mockResp('error', 500)]],
    async () => {
      const enc = new BirdDogEncoder({ host: '192.168.1.70', port: 8080 });
      const result = await enc._probeDecodeStatus();
      assert.deepEqual(result, {});
    }
  );
});

test('birddog: _probeDecodeStatus parses key=value text format', async () => {
  await withFetch(
    [['/decodestatus', mockResp('source=MyNDISource\nstatus=active')]],
    async () => {
      const enc = new BirdDogEncoder({ host: '192.168.1.70', port: 8080 });
      const result = await enc._probeDecodeStatus();
      assert.equal(result.source, 'MyNDISource');
      assert.equal(result.status, 'active');
    }
  );
});

// ── getStatus — full flow ──────────────────────────────────────────────────

test('birddog: getStatus — connected device returns model, firmware, ndiSource in status', async () => {
  await withFetch(
    [
      ['/about', mockResp(BIRDDOG_ABOUT)],
      ['/decodestatus', mockResp(BIRDDOG_DECODE)],
    ],
    async () => {
      const enc = new BirdDogEncoder({
        host: '192.168.1.70',
        port: 8080,
        label: 'Booth Camera',
        source: '', // no NDI source → NDI probe returns probeError
      });
      const status = await enc.getStatus();

      assert.equal(status.type, 'birddog');
      assert.equal(status.connected, true);
      // Model extracted from /about response
      assert.ok(status.model && status.model.includes('P400'), `expected model; got: ${status.model}`);
      assert.equal(status.firmware, undefined); // firmwareVersion field
      assert.equal(status.firmwareVersion, '4.0.1.3');
      // NDI source picked up from decoder response
      assert.ok(status.ndiSource, 'expected ndiSource to be populated from decoder status');
      // NDI without ffprobe → probeError reported
      assert.ok(status.probeError, 'expected probeError from NDI without ffprobe');
    }
  );
});

test('birddog: getStatus — decoderStatus reflects device decode state', async () => {
  await withFetch(
    [
      ['/about', mockResp(BIRDDOG_ABOUT)],
      ['/decodestatus', mockResp(JSON.stringify({ source: 'Feed 1', status: 'decoding' }))],
    ],
    async () => {
      const enc = new BirdDogEncoder({ host: '192.168.1.70', port: 8080 });
      const status = await enc.getStatus();
      assert.equal(status.decoderStatus, 'decoding');
    }
  );
});

test('birddog: getStatus — offline device returns connected=false', async () => {
  await withFetch(
    [['', mockResp('error', 500)]],
    async () => {
      const enc = new BirdDogEncoder({ host: '192.168.1.70', port: 8080 });
      const status = await enc.getStatus();
      assert.equal(status.connected, false);
      assert.equal(status.live, false);
      assert.equal(status.type, 'birddog');
    }
  );
});

test('birddog: getStatus — network error (fetch throws) returns connected=false', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    const enc = new BirdDogEncoder({ host: '192.168.1.70', port: 8080 });
    const status = await enc.getStatus();
    assert.equal(status.connected, false);
    assert.equal(status.type, 'birddog');
  } finally {
    globalThis.fetch = original;
  }
});

// ── Auth header ────────────────────────────────────────────────────────────

test('birddog: password sends Authorization: Basic header', async () => {
  await withFetch(
    [['/about', mockResp(BIRDDOG_ABOUT)]],
    async (getCalls) => {
      const enc = new BirdDogEncoder({ host: '192.168.1.70', port: 8080, password: 'mypassword' });
      await enc._probeIdentity(true);

      const expected = 'Basic ' + Buffer.from('admin:mypassword').toString('base64');
      assert.ok(getCalls().some((c) => c.headers?.Authorization === expected),
        'expected Basic auth header with password');
    }
  );
});

test('birddog: no Authorization header when password is empty', async () => {
  await withFetch(
    [['/about', mockResp(BIRDDOG_ABOUT)]],
    async (getCalls) => {
      const enc = new BirdDogEncoder({ host: '192.168.1.70', port: 8080, password: '' });
      await enc._probeIdentity(true);

      for (const call of getCalls()) {
        assert.ok(!call.headers?.Authorization,
          `should not send auth header; got: ${call.headers?.Authorization}`);
      }
    }
  );
});

// ── HTTPS on port 443 ─────────────────────────────────────────────────────

test('birddog: uses https base URL when port is 443', async () => {
  await withFetch(
    [['/about', mockResp(BIRDDOG_ABOUT)]],
    async (getCalls) => {
      const enc = new BirdDogEncoder({ host: '192.168.1.70', port: 443 });
      await enc._probeIdentity(true);

      const urls = getCalls().map((c) => c.url);
      assert.ok(urls.some((u) => u.startsWith('https://')), `expected HTTPS URL; got: ${urls}`);
    }
  );
});

// ── Lifecycle ──────────────────────────────────────────────────────────────

test('birddog: disconnect sets _connected=false', async () => {
  await withFetch([], async () => {
    const enc = new BirdDogEncoder({ host: '192.168.1.70', port: 8080 });
    enc._connected = true;
    const result = await enc.disconnect();
    assert.equal(result, true);
    assert.equal(enc._connected, false);
  });
});

test('birddog: connect calls _probeIdentity(true) for a fresh read', async () => {
  let probeCount = 0;
  await withFetch(
    [['/about', async () => {
      probeCount++;
      return mockResp(BIRDDOG_ABOUT);
    }]],
    async () => {
      const enc = new BirdDogEncoder({ host: '192.168.1.70', port: 8080 });
      // Manually set a stale cached timestamp in the past
      enc._lastIdentityAt = Date.now() - 60_000;
      await enc.connect();
      // connect() calls isOnline → _probeIdentity(), then _probeIdentity(true)
      assert.ok(probeCount >= 1, 'expected at least one identity probe');
    }
  );
});

// ── details string ─────────────────────────────────────────────────────────

test('birddog: getStatus details includes label, model, firmware, NDI source', async () => {
  await withFetch(
    [
      ['/about', mockResp(BIRDDOG_ABOUT)],
      ['/decodestatus', mockResp(JSON.stringify({ source: 'Studio Feed', status: 'active' }))],
    ],
    async () => {
      const enc = new BirdDogEncoder({ host: '192.168.1.70', port: 8080, label: 'Front Cam' });
      const status = await enc.getStatus();

      assert.ok(status.details.includes('Front Cam'), `should include label; got: ${status.details}`);
      assert.ok(status.details.includes('P400') || status.details.includes('BirdDog'),
        `should include model; got: ${status.details}`);
      assert.ok(status.details.includes('4.0.1.3'), `should include firmware; got: ${status.details}`);
      assert.ok(status.details.includes('Studio Feed'), `should include NDI source; got: ${status.details}`);
    }
  );
});

test('birddog: getStatus details shows "NDI source not set" when no source configured', async () => {
  await withFetch(
    [
      ['/about', mockResp(BIRDDOG_ABOUT)],
      ['/decodestatus', mockResp(JSON.stringify({}))],  // no source in decoder
    ],
    async () => {
      const enc = new BirdDogEncoder({ host: '192.168.1.70', port: 8080, source: '' });
      const status = await enc.getStatus();
      assert.ok(status.details.includes('not set'), `expected 'not set' in details; got: ${status.details}`);
    }
  );
});
