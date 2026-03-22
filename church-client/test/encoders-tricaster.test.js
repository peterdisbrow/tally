/**
 * TriCaster encoder smoke tests
 *
 * TriCasterEncoder uses the global `fetch` API. Tests replace globalThis.fetch
 * with a controlled mock, verify the exact URLs and HTTP methods called, and
 * confirm the parsed status shape.
 *
 * Key behaviours:
 *   - isOnline probes /v1/version → /v1/shortcut?name=record_toggle → /
 *     and returns true if any probe succeeds (including 401/403)
 *   - getStatus queries streaming_toggle and record_toggle shortcut states
 *   - startStream/stopStream POST to /v1/shortcut with XML payload
 *   - state is cached for 6 s; force=true bypasses cache
 *   - Optional HTTP Basic auth header included when password is set
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { TriCasterEncoder } = require('../src/encoders/tricaster');

// ── fetch mock helpers ─────────────────────────────────────────────────────

/**
 * Replace globalThis.fetch for the duration of `fn`.
 * `mock` maps URL fragments (or regexp) → (url, opts) → Response-like object.
 */
function withFetch(responses, fn) {
  const original = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body, headers: opts.headers });
    const urlStr = String(url);

    for (const [pattern, handler] of responses) {
      const matches = typeof pattern === 'string' ? urlStr.includes(pattern) : pattern.test(urlStr);
      if (matches) {
        const matchesMethod = !handler.method || (opts.method || 'GET') === handler.method;
        if (matchesMethod) {
          const result = typeof handler === 'function' ? await handler(urlStr, opts) : handler;
          return result;
        }
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
    json: async () => (typeof body === 'object' ? body : JSON.parse(text)),
  };
}

// ── isOnline ───────────────────────────────────────────────────────────────

test('tricaster: isOnline returns true when /v1/version responds 200', async () => {
  await withFetch(
    [['/v1/version', mockResp({ version: '3.0.0' })]],
    async (getCalls) => {
      const enc = new TriCasterEncoder({ host: '192.168.1.50', port: 5951 });
      const online = await enc.isOnline();
      assert.equal(online, true);
      assert.equal(enc._connected, true);
      assert.ok(getCalls().some((c) => c.url.includes('/v1/version')));
    }
  );
});

test('tricaster: isOnline returns true when /v1/version fails but shortcut probe succeeds', async () => {
  await withFetch(
    [
      ['/v1/version', mockResp('Not Found', 404)],
      ['/v1/shortcut?name=record_toggle', mockResp('{"value":"0"}')],
    ],
    async (getCalls) => {
      const enc = new TriCasterEncoder({ host: '192.168.1.50', port: 5951 });
      const online = await enc.isOnline();
      assert.equal(online, true);
      assert.ok(getCalls().some((c) => c.url.includes('record_toggle')));
    }
  );
});

test('tricaster: isOnline returns true on 401 (auth required but reachable)', async () => {
  await withFetch(
    [['/v1/version', mockResp('Unauthorized', 401)]],
    async () => {
      const enc = new TriCasterEncoder({ host: '192.168.1.50', port: 5951 });
      const online = await enc.isOnline();
      assert.equal(online, true);
    }
  );
});

test('tricaster: isOnline returns true on 403', async () => {
  await withFetch(
    [['/v1/version', mockResp('Forbidden', 403)]],
    async () => {
      const enc = new TriCasterEncoder({ host: '192.168.1.50', port: 5951 });
      const online = await enc.isOnline();
      assert.equal(online, true);
    }
  );
});

test('tricaster: isOnline returns false when all probes fail', async () => {
  await withFetch(
    [['', mockResp('error', 500)]],
    async () => {
      const enc = new TriCasterEncoder({ host: '192.168.1.50', port: 5951 });
      const online = await enc.isOnline();
      assert.equal(online, false);
      assert.equal(enc._connected, false);
    }
  );
});

test('tricaster: isOnline returns false when host is empty string', async () => {
  await withFetch(
    [],
    async () => {
      const enc = new TriCasterEncoder({ host: '' });
      const online = await enc.isOnline();
      assert.equal(online, false);
    }
  );
});

// ── getStatus ──────────────────────────────────────────────────────────────

test('tricaster: getStatus — streaming=true, recording=false from shortcut state', async () => {
  await withFetch(
    [
      ['/v1/version', mockResp({ version: '3.0.0' })],
      [/shortcut\?name=streaming_toggle/, mockResp('{"value":"1"}')],
      [/shortcut\?name=record_toggle/, mockResp('{"value":"0"}')],
    ],
    async (getCalls) => {
      const enc = new TriCasterEncoder({ host: '192.168.1.50', port: 5951 });
      const status = await enc.getStatus();

      assert.equal(status.type, 'tricaster');
      assert.equal(status.connected, true);
      assert.equal(status.live, true);
      assert.equal(status.recording, false);
      assert.equal(status.bitrateKbps, null);
      assert.equal(status.fps, null);
      assert.ok(status.details.includes('Streaming'));
      assert.ok(!status.details.includes('Recording'));

      // Verify shortcut polling happened
      const shortcuts = getCalls().filter((c) => c.url.includes('/v1/shortcut?name='));
      assert.ok(shortcuts.some((c) => c.url.includes('streaming_toggle')));
      assert.ok(shortcuts.some((c) => c.url.includes('record_toggle')));
    }
  );
});

test('tricaster: getStatus — recording=true when record_toggle shortcut is on', async () => {
  await withFetch(
    [
      ['/v1/version', mockResp({ version: '3.0.0' })],
      [/streaming_toggle/, mockResp('{"value":"0"}')],
      [/record_toggle/, mockResp('{"value":"1"}')],
    ],
    async () => {
      const enc = new TriCasterEncoder({ host: '192.168.1.50', port: 5951 });
      const status = await enc.getStatus();
      assert.equal(status.recording, true);
      assert.equal(status.live, false);
      assert.ok(status.details.includes('Recording'));
    }
  );
});

test('tricaster: getStatus — version loaded from /v1/version appears in details', async () => {
  await withFetch(
    [
      ['/v1/version', mockResp({ version: '3.0.5.1234' })],
      [/streaming_toggle/, mockResp('{"value":"0"}')],
      [/record_toggle/, mockResp('{"value":"0"}')],
    ],
    async () => {
      const enc = new TriCasterEncoder({ host: '192.168.1.50', port: 5951 });
      await enc.connect();
      const status = await enc.getStatus();
      assert.ok(status.details.includes('3.0.5.1234'), `expected version in details; got: ${status.details}`);
      assert.equal(status.version, '3.0.5.1234');
    }
  );
});

test('tricaster: getStatus — off-air device shows Off-air in details', async () => {
  await withFetch(
    [
      ['/v1/version', mockResp({ version: '3.0.0' })],
      [/streaming_toggle/, mockResp('{"value":"0"}')],
      [/record_toggle/, mockResp('{"value":"0"}')],
    ],
    async () => {
      const enc = new TriCasterEncoder({ host: '192.168.1.50', port: 5951 });
      const status = await enc.getStatus();
      assert.ok(status.details.includes('Off-air'), `expected Off-air; got: ${status.details}`);
    }
  );
});

test('tricaster: getStatus — offline device returns connected=false, live=false', async () => {
  await withFetch(
    [['', mockResp('error', 500)]],
    async () => {
      const enc = new TriCasterEncoder({ host: '192.168.1.50', port: 5951 });
      const status = await enc.getStatus();
      assert.equal(status.connected, false);
      assert.equal(status.live, false);
      assert.equal(status.recording, false);
    }
  );
});

// ── Shortcut state parsing ─────────────────────────────────────────────────

test('tricaster: shortcut state parsed from XML attribute value="1"', async () => {
  await withFetch(
    [
      ['/v1/version', mockResp({ version: '3.0.0' })],
      [/streaming_toggle/, mockResp('<shortcut value="1" />')],
      [/record_toggle/, mockResp('<shortcut value="0" />')],
    ],
    async () => {
      const enc = new TriCasterEncoder({ host: '192.168.1.50', port: 5951 });
      const status = await enc.getStatus();
      assert.equal(status.live, true);
      assert.equal(status.recording, false);
    }
  );
});

test('tricaster: shortcut state parsed from plain text "true"', async () => {
  await withFetch(
    [
      ['/v1/version', mockResp({ version: '3.0.0' })],
      [/streaming_toggle/, mockResp('true')],
      [/record_toggle/, mockResp('false')],
    ],
    async () => {
      const enc = new TriCasterEncoder({ host: '192.168.1.50', port: 5951 });
      const status = await enc.getStatus();
      assert.equal(status.live, true);
      assert.equal(status.recording, false);
    }
  );
});

test('tricaster: shortcut state parsed from key=value plain text format', async () => {
  await withFetch(
    [
      ['/v1/version', mockResp({ version: '3.0.0' })],
      [/streaming_toggle/, mockResp('state=1')],
      [/record_toggle/, mockResp('state=0')],
    ],
    async () => {
      const enc = new TriCasterEncoder({ host: '192.168.1.50', port: 5951 });
      const status = await enc.getStatus();
      assert.equal(status.live, true);
    }
  );
});

// ── State caching ──────────────────────────────────────────────────────────

test('tricaster: state is cached and not re-fetched within pollCacheMs', async () => {
  let shortcutCallCount = 0;

  await withFetch(
    [
      ['/v1/version', mockResp({ version: '3.0.0' })],
      [/shortcut\?name=/, async () => {
        shortcutCallCount++;
        return mockResp('{"value":"0"}');
      }],
    ],
    async () => {
      const enc = new TriCasterEncoder({ host: '192.168.1.50', port: 5951 });
      await enc.getStatus();
      const firstCount = shortcutCallCount;

      // Second call within cache window — should not re-fetch shortcuts
      await enc.getStatus();

      // isOnline still probes /v1/version each time, but shortcut polling is cached
      assert.equal(shortcutCallCount, firstCount, 'shortcut state should not be re-fetched within cache window');
    }
  );
});

// ── startStream / stopStream ───────────────────────────────────────────────

test('tricaster: startStream POSTs shortcut XML to /v1/shortcut', async () => {
  await withFetch(
    [
      [{ test: (u) => u.includes('/v1/shortcut'), method: 'POST' },
       (url, opts) => ({ ok: true, status: 200, text: async () => '', method: opts.method })],
      ['/v1/shortcut', { ok: true, status: 200, text: async () => '' }],
    ],
    async (getCalls) => {
      const enc = new TriCasterEncoder({ host: '192.168.1.50', port: 5951 });
      await enc.startStream();

      assert.equal(enc._streaming, true);
      const postCall = getCalls().find((c) => c.method === 'POST' && c.url.includes('/v1/shortcut'));
      assert.ok(postCall, 'expected POST to /v1/shortcut');
      assert.ok(postCall.body.includes('streaming_toggle'), `expected shortcut name in body; got: ${postCall.body}`);
      assert.ok(postCall.body.includes('value="1"') || postCall.body.includes('value="1"'), 'expected value=1 in body');
    }
  );
});

test('tricaster: stopStream POSTs shortcut XML with value=0', async () => {
  await withFetch(
    [['/v1/shortcut', { ok: true, status: 200, text: async () => '' }]],
    async (getCalls) => {
      const enc = new TriCasterEncoder({ host: '192.168.1.50', port: 5951 });
      await enc.stopStream();

      assert.equal(enc._streaming, false);
      const postCall = getCalls().find((c) => c.method === 'POST' && c.url.includes('/v1/shortcut'));
      assert.ok(postCall, 'expected POST to /v1/shortcut');
      assert.ok(postCall.body.includes('value="0"'), `expected value=0; got: ${postCall.body}`);
    }
  );
});

test('tricaster: startRecord POSTs record_toggle shortcut with value=1', async () => {
  await withFetch(
    [['/v1/shortcut', { ok: true, status: 200, text: async () => '' }]],
    async (getCalls) => {
      const enc = new TriCasterEncoder({ host: '192.168.1.50', port: 5951 });
      await enc.startRecord();

      assert.equal(enc._recording, true);
      const postCall = getCalls().find((c) => c.method === 'POST');
      assert.ok(postCall.body.includes('record_toggle'), `expected record_toggle in body; got: ${postCall.body}`);
      assert.ok(postCall.body.includes('value="1"'), `expected value=1 in body; got: ${postCall.body}`);
    }
  );
});

test('tricaster: stopRecord POSTs record_toggle shortcut with value=0', async () => {
  await withFetch(
    [['/v1/shortcut', { ok: true, status: 200, text: async () => '' }]],
    async (getCalls) => {
      const enc = new TriCasterEncoder({ host: '192.168.1.50', port: 5951 });
      await enc.stopRecord();

      assert.equal(enc._recording, false);
      const postCall = getCalls().find((c) => c.method === 'POST');
      assert.ok(postCall.body.includes('record_toggle'));
      assert.ok(postCall.body.includes('value="0"'));
    }
  );
});

test('tricaster: startStream throws when all shortcut POST attempts fail', async () => {
  await withFetch(
    [['/v1/shortcut', { ok: false, status: 500, text: async () => 'error' }]],
    async () => {
      const enc = new TriCasterEncoder({ host: '192.168.1.50', port: 5951 });
      await assert.rejects(async () => enc.startStream(), /TriCaster shortcut.*failed/);
    }
  );
});

// ── Auth header ────────────────────────────────────────────────────────────

test('tricaster: password causes Authorization: Basic header on all requests', async () => {
  await withFetch(
    [
      ['/v1/version', mockResp({ version: '3.0.0' })],
      [/shortcut/, mockResp('{"value":"0"}')],
    ],
    async (getCalls) => {
      const enc = new TriCasterEncoder({ host: '192.168.1.50', port: 5951, password: 'secret' });
      await enc.getStatus();

      const expected = 'Basic ' + Buffer.from('admin:secret').toString('base64');
      for (const call of getCalls()) {
        assert.equal(call.headers?.Authorization, expected, `expected Basic auth on ${call.url}`);
      }
    }
  );
});

test('tricaster: no Authorization header when password is empty', async () => {
  await withFetch(
    [
      ['/v1/version', mockResp({ version: '3.0.0' })],
      [/shortcut/, mockResp('{"value":"0"}')],
    ],
    async (getCalls) => {
      const enc = new TriCasterEncoder({ host: '192.168.1.50', port: 5951 });
      await enc.getStatus();

      for (const call of getCalls()) {
        assert.ok(!call.headers?.Authorization, `should not send auth header; got: ${call.headers?.Authorization}`);
      }
    }
  );
});

// ── Version detection ──────────────────────────────────────────────────────

test('tricaster: connect tries multiple version endpoints until one succeeds', async () => {
  let versionCallCount = 0;

  await withFetch(
    [
      ['/v1/version', async () => {
        versionCallCount++;
        // First call fails, second succeeds (simulate connect -> _loadVersion)
        return versionCallCount <= 1
          ? mockResp('not found', 404)
          : mockResp({ version: '3.0.0' });
      }],
      ['/v1/dictionary?key=version', mockResp({ version: '3.1.0' })],
      [/shortcut/, mockResp('{"value":"0"}')],
    ],
    async () => {
      const enc = new TriCasterEncoder({ host: '192.168.1.50', port: 5951 });
      await enc.connect();
      // Should load version from the dictionary endpoint as fallback
      assert.ok(enc._version, 'version should be loaded after connect');
    }
  );
});

// ── Lifecycle ──────────────────────────────────────────────────────────────

test('tricaster: disconnect sets _connected=false', async () => {
  await withFetch([], async () => {
    const enc = new TriCasterEncoder({ host: '192.168.1.50', port: 5951 });
    enc._connected = true;
    const result = await enc.disconnect();
    assert.equal(result, true);
    assert.equal(enc._connected, false);
  });
});
