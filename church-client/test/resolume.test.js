/**
 * Tests for Resolume Arena REST API integration.
 * Mocks global.fetch in beforeEach/afterEach — no real HTTP connections.
 * Covers: constructor, _fetch, _put, _post, _delete, isRunning, getVersion,
 * getComposition (caching), getLayers, getColumns, getStatus,
 * playClip, stopClip, playClipByName, triggerColumn, triggerColumnByName,
 * setLayerOpacity, clearAll, setMasterOpacity, getBpm, setBpm, toStatus.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { Resolume } = require('../src/resolume');

// ─── Fetch mock helpers ───────────────────────────────────────────────────────

let _originalFetch;

beforeEach(() => {
  _originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = _originalFetch;
});

function mockFetchJson(data, { ok = true } = {}) {
  global.fetch = async () => ({
    ok,
    text: async () => JSON.stringify(data),
  });
}

function mockFetchText(text, { ok = true } = {}) {
  global.fetch = async () => ({
    ok,
    text: async () => text,
  });
}

function mockFetchNoContent() {
  // 204 No Content — ok but empty body
  global.fetch = async () => ({
    ok: true,
    text: async () => '',
  });
}

function mockFetchNotOk() {
  global.fetch = async () => ({ ok: false });
}

function mockFetchThrows() {
  global.fetch = async () => { throw new Error('Network error'); };
}

// ─── Sample composition data ──────────────────────────────────────────────────

const SAMPLE_COMPOSITION = {
  layers: [
    {
      id: 1,
      name: { value: 'Layer 1' },
      clips: [
        { id: 1, name: { value: 'Intro Clip' }, connected: { value: true } },
        { id: 2, name: { value: 'Worship Loop' }, connected: { value: false } },
      ],
    },
    {
      id: 2,
      name: { value: 'Background' },
      clips: [
        { id: 1, name: { value: 'Sky BG' }, connected: { value: false } },
      ],
    },
  ],
  columns: [
    { id: 1, name: { value: 'Intro' } },
    { id: 2, name: { value: 'Worship' } },
    { id: 3, name: { value: 'Sermon' } },
  ],
  tempo: { bpm: { value: 120 } },
  video: { opacity: { value: 1 } },
};

// ─── constructor ──────────────────────────────────────────────────────────────

describe('Resolume constructor', () => {
  it('uses default host and port', () => {
    const r = new Resolume();
    assert.equal(r.host, 'localhost');
    assert.equal(r.port, 8080);
    assert.equal(r.running, false);
    assert.equal(r._compositionCache, null);
    assert.equal(r._cacheTime, 0);
    assert.equal(r._CACHE_TTL, 5000);
  });

  it('accepts custom host and port', () => {
    const r = new Resolume({ host: '192.168.1.10', port: 9090 });
    assert.equal(r.host, '192.168.1.10');
    assert.equal(r.port, 9090);
  });

  it('constructs correct baseUrl', () => {
    const r = new Resolume({ host: '10.0.0.2', port: 8080 });
    assert.equal(r.baseUrl, 'http://10.0.0.2:8080/api/v1');
  });
});

// ─── _fetch ───────────────────────────────────────────────────────────────────

describe('Resolume._fetch()', () => {
  it('builds correct URL from path', async () => {
    const r = new Resolume();
    const urls = [];
    global.fetch = async (url) => { urls.push(url); return { ok: true, text: async () => '{}' }; };
    await r._fetch('/product');
    assert.equal(urls[0], 'http://localhost:8080/api/v1/product');
  });

  it('returns parsed JSON on success', async () => {
    const r = new Resolume();
    mockFetchJson({ name: 'Resolume Arena 7' });
    const data = await r._fetch('/product');
    assert.deepEqual(data, { name: 'Resolume Arena 7' });
  });

  it('returns raw text when JSON parse fails', async () => {
    const r = new Resolume();
    mockFetchText('not-json-at-all');
    const data = await r._fetch('/some/path');
    assert.equal(data, 'not-json-at-all');
  });

  it('returns true (not text) when body is empty (204 pattern)', async () => {
    const r = new Resolume();
    mockFetchNoContent();
    const data = await r._fetch('/composition/disconnectall', { method: 'POST' });
    assert.equal(data, true);
  });

  it('returns null when response is not ok', async () => {
    const r = new Resolume();
    mockFetchNotOk();
    const data = await r._fetch('/product');
    assert.equal(data, null);
  });

  it('returns null when fetch throws', async () => {
    const r = new Resolume();
    mockFetchThrows();
    const data = await r._fetch('/product');
    assert.equal(data, null);
  });
});

// ─── _put ────────────────────────────────────────────────────────────────────

describe('Resolume._put()', () => {
  it('sends PUT with JSON body and Content-Type header', async () => {
    const r = new Resolume();
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, text: async () => '{}' };
    };
    await r._put('/composition/video/opacity', { value: 0.5 });
    assert.equal(calls[0].opts.method, 'PUT');
    assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
    assert.equal(calls[0].opts.body, JSON.stringify({ value: 0.5 }));
  });

  it('returns parsed response', async () => {
    const r = new Resolume();
    mockFetchJson({ value: 0.5 });
    const result = await r._put('/composition/video/opacity', { value: 0.5 });
    assert.deepEqual(result, { value: 0.5 });
  });
});

// ─── _post ───────────────────────────────────────────────────────────────────

describe('Resolume._post()', () => {
  it('sends POST with JSON body when body provided', async () => {
    const r = new Resolume();
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, text: async () => '' };
    };
    await r._post('/some/path', { key: 'val' });
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
    assert.equal(calls[0].opts.body, JSON.stringify({ key: 'val' }));
  });

  it('sends POST without body when body is undefined', async () => {
    const r = new Resolume();
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, text: async () => '' };
    };
    await r._post('/composition/disconnectall');
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.body, undefined);
  });
});

// ─── _delete ─────────────────────────────────────────────────────────────────

describe('Resolume._delete()', () => {
  it('sends DELETE request', async () => {
    const r = new Resolume();
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, text: async () => '' };
    };
    await r._delete('/composition/layers/1/clips/1/connect');
    assert.equal(calls[0].opts.method, 'DELETE');
    assert.ok(calls[0].url.includes('/composition/layers/1/clips/1/connect'));
  });
});

// ─── isRunning ────────────────────────────────────────────────────────────────

describe('Resolume.isRunning()', () => {
  it('returns true when GET /product succeeds', async () => {
    const r = new Resolume();
    global.fetch = async (url, opts) => {
      // Must use GET (not HEAD) — Resolume Arena 7 returns 405 for HEAD
      assert.ok(!opts?.method || opts.method === 'GET');
      assert.ok(url.includes('/product'));
      return { ok: true };
    };
    const result = await r.isRunning();
    assert.equal(result, true);
    assert.equal(r.running, true);
  });

  it('returns false when HEAD returns non-ok', async () => {
    const r = new Resolume();
    mockFetchNotOk();
    const result = await r.isRunning();
    assert.equal(result, false);
    assert.equal(r.running, false);
  });

  it('returns false when fetch throws', async () => {
    const r = new Resolume();
    mockFetchThrows();
    const result = await r.isRunning();
    assert.equal(result, false);
    assert.equal(r.running, false);
  });
});

// ─── getVersion ───────────────────────────────────────────────────────────────

describe('Resolume.getVersion()', () => {
  it('returns data.name when present', async () => {
    const r = new Resolume();
    mockFetchJson({ name: 'Resolume Arena 7.16' });
    const v = await r.getVersion();
    assert.equal(v, 'Resolume Arena 7.16');
  });

  it('falls back to data.version when name absent', async () => {
    const r = new Resolume();
    mockFetchJson({ version: '7.15.0' });
    const v = await r.getVersion();
    assert.equal(v, '7.15.0');
  });

  it('falls back to literal string when both absent', async () => {
    const r = new Resolume();
    mockFetchJson({});
    const v = await r.getVersion();
    assert.equal(v, 'Resolume Arena');
  });

  it('returns null when fetch fails', async () => {
    const r = new Resolume();
    mockFetchNotOk();
    const v = await r.getVersion();
    assert.equal(v, null);
  });
});

// ─── getComposition ───────────────────────────────────────────────────────────

describe('Resolume.getComposition()', () => {
  it('fetches /composition and returns data', async () => {
    const r = new Resolume();
    const urls = [];
    global.fetch = async (url) => {
      urls.push(url);
      return { ok: true, text: async () => JSON.stringify(SAMPLE_COMPOSITION) };
    };
    const comp = await r.getComposition();
    assert.ok(urls[0].includes('/composition'));
    assert.equal(comp.layers.length, 2);
    assert.equal(comp.columns.length, 3);
  });

  it('caches composition within TTL', async () => {
    const r = new Resolume();
    let fetchCount = 0;
    global.fetch = async () => {
      fetchCount++;
      return { ok: true, text: async () => JSON.stringify(SAMPLE_COMPOSITION) };
    };
    await r.getComposition();
    await r.getComposition();
    assert.equal(fetchCount, 1);
  });

  it('re-fetches when forceRefresh is true', async () => {
    const r = new Resolume();
    let fetchCount = 0;
    global.fetch = async () => {
      fetchCount++;
      return { ok: true, text: async () => JSON.stringify(SAMPLE_COMPOSITION) };
    };
    await r.getComposition();
    await r.getComposition(true);
    assert.equal(fetchCount, 2);
  });

  it('re-fetches when cache is expired', async () => {
    const r = new Resolume();
    r._CACHE_TTL = 0;
    let fetchCount = 0;
    global.fetch = async () => {
      fetchCount++;
      return { ok: true, text: async () => JSON.stringify(SAMPLE_COMPOSITION) };
    };
    await r.getComposition();
    await r.getComposition();
    assert.equal(fetchCount, 2);
  });

  it('returns null when fetch fails', async () => {
    const r = new Resolume();
    mockFetchNotOk();
    const comp = await r.getComposition();
    assert.equal(comp, null);
  });

  it('stores result in _compositionCache', async () => {
    const r = new Resolume();
    mockFetchJson(SAMPLE_COMPOSITION);
    await r.getComposition();
    assert.ok(r._compositionCache !== null);
  });
});

// ─── getLayers ────────────────────────────────────────────────────────────────

describe('Resolume.getLayers()', () => {
  it('returns layers from composition', async () => {
    const r = new Resolume();
    mockFetchJson(SAMPLE_COMPOSITION);
    const layers = await r.getLayers();
    assert.equal(layers.length, 2);
    assert.equal(layers[0].name.value, 'Layer 1');
  });

  it('returns empty array when composition unavailable', async () => {
    const r = new Resolume();
    mockFetchNotOk();
    const layers = await r.getLayers();
    assert.deepEqual(layers, []);
  });

  it('returns empty array when composition has no layers key', async () => {
    const r = new Resolume();
    mockFetchJson({});
    const layers = await r.getLayers();
    assert.deepEqual(layers, []);
  });
});

// ─── getColumns ───────────────────────────────────────────────────────────────

describe('Resolume.getColumns()', () => {
  it('returns columns from composition', async () => {
    const r = new Resolume();
    mockFetchJson(SAMPLE_COMPOSITION);
    const cols = await r.getColumns();
    assert.equal(cols.length, 3);
    assert.equal(cols[0].name.value, 'Intro');
  });

  it('returns empty array when composition unavailable', async () => {
    const r = new Resolume();
    mockFetchNotOk();
    const cols = await r.getColumns();
    assert.deepEqual(cols, []);
  });
});

// ─── getStatus ────────────────────────────────────────────────────────────────

describe('Resolume.getStatus()', () => {
  it('returns running:false when not running', async () => {
    const r = new Resolume();
    mockFetchNotOk();
    const status = await r.getStatus();
    assert.deepEqual(status, { running: false });
  });

  it('returns error when running but composition unavailable', async () => {
    const r = new Resolume();
    let callCount = 0;
    global.fetch = async () => {
      callCount++;
      if (callCount === 1) return { ok: true }; // HEAD isRunning
      return { ok: false };
    };
    const status = await r.getStatus();
    assert.equal(status.running, true);
    assert.ok(status.error);
  });

  it('returns full status with playing clips', async () => {
    const r = new Resolume();
    global.fetch = async (url, opts) => {
      if (opts?.method === 'HEAD') return { ok: true };
      return { ok: true, text: async () => JSON.stringify(SAMPLE_COMPOSITION) };
    };
    const status = await r.getStatus();
    assert.equal(status.running, true);
    assert.equal(status.bpm, 120);
    assert.equal(status.masterOpacity, 1);
    assert.equal(status.layerCount, 2);
    assert.equal(status.columnCount, 3);
    assert.equal(status.playing.length, 1);
    assert.equal(status.playing[0].clip, 'Intro Clip');
    assert.equal(status.playing[0].layer, 'Layer 1');
  });

  it('returns empty playing array when no clips connected', async () => {
    const r = new Resolume();
    const comp = {
      ...SAMPLE_COMPOSITION,
      layers: [
        {
          id: 1,
          name: { value: 'Layer 1' },
          clips: [
            { id: 1, name: { value: 'Clip A' }, connected: { value: false } },
          ],
        },
      ],
    };
    global.fetch = async (url, opts) => {
      if (opts?.method === 'HEAD') return { ok: true };
      return { ok: true, text: async () => JSON.stringify(comp) };
    };
    const status = await r.getStatus();
    assert.deepEqual(status.playing, []);
  });

  it('uses fallback layer id when name not present', async () => {
    const r = new Resolume();
    const comp = {
      layers: [
        {
          id: 5,
          clips: [
            { id: 2, connected: { value: true } },
          ],
        },
      ],
      columns: [],
    };
    global.fetch = async (url, opts) => {
      if (opts?.method === 'HEAD') return { ok: true };
      return { ok: true, text: async () => JSON.stringify(comp) };
    };
    const status = await r.getStatus();
    assert.equal(status.playing[0].layer, 'Layer 5');
    assert.equal(status.playing[0].clip, 'Clip 2');
  });
});

// ─── playClip ─────────────────────────────────────────────────────────────────

describe('Resolume.playClip()', () => {
  it('POSTs to /composition/layers/{l}/clips/{c}/connect', async () => {
    const r = new Resolume();
    const urls = [];
    global.fetch = async (url, opts) => {
      urls.push({ url, method: opts?.method });
      return { ok: true, text: async () => '' };
    };
    const result = await r.playClip(1, 2);
    assert.equal(result, true);
    const call = urls[0];
    assert.ok(call.url.includes('/composition/layers/1/clips/2/connect'));
    assert.equal(call.method, 'POST');
  });

  it('invalidates composition cache on success', async () => {
    const r = new Resolume();
    r._compositionCache = SAMPLE_COMPOSITION;
    mockFetchNoContent();
    await r.playClip(1, 1);
    assert.equal(r._compositionCache, null);
  });

  it('throws when fetch fails', async () => {
    const r = new Resolume();
    mockFetchNotOk();
    await assert.rejects(() => r.playClip(1, 1), /Could not play clip/);
  });
});

// ─── stopClip ─────────────────────────────────────────────────────────────────

describe('Resolume.stopClip()', () => {
  it('DELETEs /composition/layers/{l}/clips/{c}/connect', async () => {
    const r = new Resolume();
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url, method: opts?.method });
      return { ok: true, text: async () => '' };
    };
    const result = await r.stopClip(2, 3);
    assert.equal(result, true);
    assert.ok(calls[0].url.includes('/composition/layers/2/clips/3/connect'));
    assert.equal(calls[0].method, 'DELETE');
  });

  it('invalidates composition cache', async () => {
    const r = new Resolume();
    r._compositionCache = SAMPLE_COMPOSITION;
    mockFetchNoContent();
    await r.stopClip(1, 1);
    assert.equal(r._compositionCache, null);
  });

  it('throws when fetch fails', async () => {
    const r = new Resolume();
    mockFetchNotOk();
    await assert.rejects(() => r.stopClip(1, 1), /Could not stop clip/);
  });
});

// ─── playClipByName ───────────────────────────────────────────────────────────

describe('Resolume.playClipByName()', () => {
  it('finds and plays clip by exact name', async () => {
    const r = new Resolume();
    let postedUrl = null;
    global.fetch = async (url, opts) => {
      if (opts?.method === 'POST') postedUrl = url;
      return { ok: true, text: async () => JSON.stringify(SAMPLE_COMPOSITION) };
    };
    const result = await r.playClipByName('Intro Clip');
    assert.ok(postedUrl !== null);
    assert.ok(postedUrl.includes('/composition/layers/1/clips/1/connect'));
    assert.equal(result.clip, 'Intro Clip');
    assert.equal(result.layer, 'Layer 1');
  });

  it('does case-insensitive fuzzy match', async () => {
    const r = new Resolume();
    let postedUrl = null;
    global.fetch = async (url, opts) => {
      if (opts?.method === 'POST') postedUrl = url;
      return { ok: true, text: async () => JSON.stringify(SAMPLE_COMPOSITION) };
    };
    await r.playClipByName('WORSHIP');
    assert.ok(postedUrl !== null);
    assert.ok(postedUrl.includes('/composition/layers/1/clips/2/connect'));
  });

  it('throws when no matching clip found', async () => {
    const r = new Resolume();
    global.fetch = async () => ({
      ok: true,
      text: async () => JSON.stringify(SAMPLE_COMPOSITION),
    });
    await assert.rejects(() => r.playClipByName('NonExistentClip'), /No clip found matching/);
  });

  it('throws when composition unavailable', async () => {
    const r = new Resolume();
    mockFetchNotOk();
    await assert.rejects(() => r.playClipByName('Anything'), /Could not read Resolume composition/);
  });

  it('force-refreshes composition', async () => {
    const r = new Resolume();
    r._compositionCache = SAMPLE_COMPOSITION;
    r._cacheTime = Date.now();
    let fetchCount = 0;
    global.fetch = async (url, opts) => {
      if (opts?.method !== 'POST') fetchCount++;
      return { ok: true, text: async () => JSON.stringify(SAMPLE_COMPOSITION) };
    };
    await r.playClipByName('Intro Clip');
    assert.equal(fetchCount, 1, 'Should force-refresh composition');
  });
});

// ─── triggerColumn ────────────────────────────────────────────────────────────

describe('Resolume.triggerColumn()', () => {
  it('POSTs to /composition/columns/{idx}/connect', async () => {
    const r = new Resolume();
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url, method: opts?.method });
      return { ok: true, text: async () => '' };
    };
    const result = await r.triggerColumn(2);
    assert.equal(result, true);
    assert.ok(calls[0].url.includes('/composition/columns/2/connect'));
    assert.equal(calls[0].method, 'POST');
  });

  it('invalidates composition cache', async () => {
    const r = new Resolume();
    r._compositionCache = SAMPLE_COMPOSITION;
    mockFetchNoContent();
    await r.triggerColumn(1);
    assert.equal(r._compositionCache, null);
  });

  it('throws when fetch fails', async () => {
    const r = new Resolume();
    mockFetchNotOk();
    await assert.rejects(() => r.triggerColumn(1), /Could not trigger column/);
  });
});

// ─── triggerColumnByName ──────────────────────────────────────────────────────

describe('Resolume.triggerColumnByName()', () => {
  it('finds and triggers column by exact name', async () => {
    const r = new Resolume();
    let postedUrl = null;
    global.fetch = async (url, opts) => {
      if (opts?.method === 'POST') postedUrl = url;
      return { ok: true, text: async () => JSON.stringify(SAMPLE_COMPOSITION) };
    };
    const result = await r.triggerColumnByName('Worship');
    assert.ok(postedUrl !== null);
    assert.ok(postedUrl.includes('/composition/columns/2/connect'));
    assert.equal(result, 'Worship');
  });

  it('does case-insensitive fuzzy match', async () => {
    const r = new Resolume();
    let postedUrl = null;
    global.fetch = async (url, opts) => {
      if (opts?.method === 'POST') postedUrl = url;
      return { ok: true, text: async () => JSON.stringify(SAMPLE_COMPOSITION) };
    };
    await r.triggerColumnByName('SERMON');
    assert.ok(postedUrl.includes('/composition/columns/3/connect'));
  });

  it('throws when no matching column found', async () => {
    const r = new Resolume();
    global.fetch = async () => ({
      ok: true,
      text: async () => JSON.stringify(SAMPLE_COMPOSITION),
    });
    await assert.rejects(() => r.triggerColumnByName('NoSuchCol'), /No column found matching/);
  });

  it('throws when composition unavailable', async () => {
    const r = new Resolume();
    mockFetchNotOk();
    await assert.rejects(() => r.triggerColumnByName('Intro'), /Could not read Resolume composition/);
  });
});

// ─── setLayerOpacity ─────────────────────────────────────────────────────────

describe('Resolume.setLayerOpacity()', () => {
  it('PUTs to /composition/layers/{n}/video/opacity with clamped value', async () => {
    const r = new Resolume();
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, text: async () => JSON.stringify({ value: 0.75 }) };
    };
    const result = await r.setLayerOpacity(1, 0.75);
    assert.equal(result, 0.75);
    assert.ok(calls[0].url.includes('/composition/layers/1/video/opacity'));
    assert.equal(calls[0].opts.method, 'PUT');
    assert.equal(calls[0].opts.body, JSON.stringify({ value: 0.75 }));
  });

  it('clamps value to 0 minimum', async () => {
    const r = new Resolume();
    const bodies = [];
    global.fetch = async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, text: async () => '{}' };
    };
    const result = await r.setLayerOpacity(1, -0.5);
    assert.equal(result, 0);
    assert.equal(bodies[0].value, 0);
  });

  it('clamps value to 1 maximum', async () => {
    const r = new Resolume();
    const bodies = [];
    global.fetch = async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, text: async () => '{}' };
    };
    const result = await r.setLayerOpacity(1, 2.5);
    assert.equal(result, 1);
    assert.equal(bodies[0].value, 1);
  });

  it('parses float string values', async () => {
    const r = new Resolume();
    const bodies = [];
    global.fetch = async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, text: async () => '{}' };
    };
    const result = await r.setLayerOpacity(1, '0.5');
    assert.equal(result, 0.5);
  });

  it('throws when fetch fails', async () => {
    const r = new Resolume();
    mockFetchNotOk();
    await assert.rejects(() => r.setLayerOpacity(1, 0.5), /Could not set opacity/);
  });
});

// ─── clearAll ─────────────────────────────────────────────────────────────────

describe('Resolume.clearAll()', () => {
  it('POSTs to /composition/disconnectall and returns true', async () => {
    const r = new Resolume();
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url, method: opts?.method });
      return { ok: true, text: async () => '' };
    };
    const result = await r.clearAll();
    assert.equal(result, true);
    assert.ok(calls[0].url.includes('/composition/disconnectall'));
    assert.equal(calls[0].method, 'POST');
  });

  it('invalidates composition cache', async () => {
    const r = new Resolume();
    r._compositionCache = SAMPLE_COMPOSITION;
    mockFetchNoContent();
    await r.clearAll();
    assert.equal(r._compositionCache, null);
  });

  it('throws when fetch fails', async () => {
    const r = new Resolume();
    mockFetchNotOk();
    await assert.rejects(() => r.clearAll(), /Could not clear Resolume composition/);
  });
});

// ─── setMasterOpacity ─────────────────────────────────────────────────────────

describe('Resolume.setMasterOpacity()', () => {
  it('PUTs to /composition/video/opacity with clamped value', async () => {
    const r = new Resolume();
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, text: async () => '{}' };
    };
    const result = await r.setMasterOpacity(0.8);
    assert.equal(result, 0.8);
    assert.ok(calls[0].url.includes('/composition/video/opacity'));
    assert.equal(calls[0].opts.method, 'PUT');
    assert.equal(JSON.parse(calls[0].opts.body).value, 0.8);
  });

  it('clamps below 0 to 0', async () => {
    const r = new Resolume();
    global.fetch = async (url, opts) => ({ ok: true, text: async () => '{}' });
    const result = await r.setMasterOpacity(-1);
    assert.equal(result, 0);
  });

  it('clamps above 1 to 1', async () => {
    const r = new Resolume();
    global.fetch = async (url, opts) => ({ ok: true, text: async () => '{}' });
    const result = await r.setMasterOpacity(5);
    assert.equal(result, 1);
  });

  it('throws when fetch fails', async () => {
    const r = new Resolume();
    mockFetchNotOk();
    await assert.rejects(() => r.setMasterOpacity(1), /Could not set master opacity/);
  });
});

// ─── getBpm ───────────────────────────────────────────────────────────────────

describe('Resolume.getBpm()', () => {
  it('returns bpm value from /composition/tempo', async () => {
    const r = new Resolume();
    const urls = [];
    global.fetch = async (url) => {
      urls.push(url);
      return { ok: true, text: async () => JSON.stringify({ bpm: { value: 120 } }) };
    };
    const bpm = await r.getBpm();
    assert.equal(bpm, 120);
    assert.ok(urls[0].includes('/composition/tempo'));
  });

  it('returns null when tempo data unavailable', async () => {
    const r = new Resolume();
    mockFetchNotOk();
    const bpm = await r.getBpm();
    assert.equal(bpm, null);
  });

  it('returns null when bpm.value not present', async () => {
    const r = new Resolume();
    mockFetchJson({ bpm: {} });
    const bpm = await r.getBpm();
    assert.equal(bpm, null);
  });
});

// ─── setBpm ───────────────────────────────────────────────────────────────────

describe('Resolume.setBpm()', () => {
  it('PUTs to /composition/tempo/bpm with valid BPM', async () => {
    const r = new Resolume();
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, text: async () => '{}' };
    };
    const result = await r.setBpm(128);
    assert.equal(result, 128);
    assert.ok(calls[0].url.includes('/composition/tempo/bpm'));
    assert.equal(calls[0].opts.method, 'PUT');
    assert.equal(JSON.parse(calls[0].opts.body).value, 128);
  });

  it('accepts float BPM values', async () => {
    const r = new Resolume();
    global.fetch = async () => ({ ok: true, text: async () => '{}' });
    const result = await r.setBpm(120.5);
    assert.equal(result, 120.5);
  });

  it('accepts string BPM that parses to valid float', async () => {
    const r = new Resolume();
    global.fetch = async () => ({ ok: true, text: async () => '{}' });
    const result = await r.setBpm('140');
    assert.equal(result, 140);
  });

  it('throws on BPM below 20', async () => {
    const r = new Resolume();
    await assert.rejects(() => r.setBpm(10), /Invalid BPM/);
  });

  it('throws on BPM above 300', async () => {
    const r = new Resolume();
    await assert.rejects(() => r.setBpm(400), /Invalid BPM/);
  });

  it('throws on NaN BPM', async () => {
    const r = new Resolume();
    await assert.rejects(() => r.setBpm('not-a-number'), /Invalid BPM/);
  });

  it('accepts boundary value 20', async () => {
    const r = new Resolume();
    global.fetch = async () => ({ ok: true, text: async () => '{}' });
    const result = await r.setBpm(20);
    assert.equal(result, 20);
  });

  it('accepts boundary value 300', async () => {
    const r = new Resolume();
    global.fetch = async () => ({ ok: true, text: async () => '{}' });
    const result = await r.setBpm(300);
    assert.equal(result, 300);
  });

  it('throws when fetch fails after validation passes', async () => {
    const r = new Resolume();
    mockFetchNotOk();
    await assert.rejects(() => r.setBpm(120), /Could not set BPM/);
  });
});

// ─── toStatus ─────────────────────────────────────────────────────────────────

describe('Resolume.toStatus()', () => {
  it('returns connected, host, port', () => {
    const r = new Resolume({ host: '192.168.1.10', port: 8080 });
    r.running = true;
    const status = r.toStatus();
    assert.deepEqual(status, { connected: true, host: '192.168.1.10', port: 8080 });
  });

  it('connected reflects running state', () => {
    const r = new Resolume();
    r.running = false;
    assert.equal(r.toStatus().connected, false);
    r.running = true;
    assert.equal(r.toStatus().connected, true);
  });

  it('uses default host and port', () => {
    const r = new Resolume();
    const status = r.toStatus();
    assert.equal(status.host, 'localhost');
    assert.equal(status.port, 8080);
  });
});
