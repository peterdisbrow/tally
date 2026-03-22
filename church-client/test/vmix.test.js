/**
 * Tests for VMix HTTP API integration.
 * Mocks global.fetch in beforeEach/afterEach — no real HTTP connections.
 * Covers: constructor, _call, _extractTag, _extractAttr, _parseInputs,
 * _parseAudio, isRunning, getState (caching), getStatus, cut, fade,
 * setPreview, setProgram, startStream, stopStream, startRecording,
 * stopRecording, setMasterVolume, muteMaster, unmuteMaster,
 * getAudioLevels, startPlaylist, stopPlaylist, listInputs,
 * getScreenshot, toStatus.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { VMix } = require('../src/vmix');

// ─── Shared sample XML ────────────────────────────────────────────────────────

const SAMPLE_XML = `<vmix>
  <version>26.0.0</version>
  <edition>HD</edition>
  <stream>True</stream>
  <recording>False</recording>
  <external>False</external>
  <playList>False</playList>
  <multiCorder>False</multiCorder>
  <fullscreen>False</fullscreen>
  <active>1</active>
  <preview>2</preview>
  <input key="abc" number="1" type="Camera" title="Main Cam" state="Running" muted="False" volume="100" />
  <input key="def" number="2" type="NDI" title="NDI Source" state="Paused" muted="True" volume="80" />
  <master volume="85.5" muted="False" meterF1="0.5" meterF2="0.6" />
</vmix>`;

// ─── Fetch mock helpers ───────────────────────────────────────────────────────

let _originalFetch;

beforeEach(() => {
  _originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = _originalFetch;
});

function mockFetchText(text, { ok = true } = {}) {
  global.fetch = async () => ({
    ok,
    text: async () => text,
  });
}

function mockFetchOk(ok = true) {
  global.fetch = async () => ({ ok });
}

function mockFetchThrows() {
  global.fetch = async () => { throw new Error('Network error'); };
}

function mockFetchArrayBuffer(data = 'fakeimage') {
  // Use Uint8Array.from to get a standalone ArrayBuffer (not a pool slice)
  // so Buffer.from(arrayBuffer) encodes only the expected bytes.
  const bytes = Buffer.from(data);
  const standalone = new Uint8Array(bytes).buffer;
  global.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => standalone,
  });
}

// ─── constructor ──────────────────────────────────────────────────────────────

describe('VMix constructor', () => {
  it('uses default host and port', () => {
    const v = new VMix();
    assert.equal(v.host, 'localhost');
    assert.equal(v.port, 8088);
    assert.equal(v.running, false);
    assert.equal(v._stateCache, null);
    assert.equal(v._cacheTime, 0);
    assert.equal(v._CACHE_TTL, 3000);
  });

  it('accepts custom host and port', () => {
    const v = new VMix({ host: '192.168.1.50', port: 9000 });
    assert.equal(v.host, '192.168.1.50');
    assert.equal(v.port, 9000);
  });

  it('constructs correct baseUrl', () => {
    const v = new VMix({ host: '10.0.0.1', port: 8088 });
    assert.equal(v.baseUrl, 'http://10.0.0.1:8088/api/');
  });
});

// ─── _call ────────────────────────────────────────────────────────────────────

describe('VMix._call()', () => {
  it('builds correct URL with Function param', async () => {
    const v = new VMix();
    const urls = [];
    global.fetch = async (url) => {
      urls.push(url);
      return { ok: true, text: async () => 'ok' };
    };
    await v._call('Cut');
    assert.ok(urls[0].includes('Function=Cut'), `URL should include Function=Cut, got: ${urls[0]}`);
    assert.ok(urls[0].startsWith('http://localhost:8088/api/'));
  });

  it('appends extra params to query string', async () => {
    const v = new VMix();
    const urls = [];
    global.fetch = async (url) => {
      urls.push(url);
      return { ok: true, text: async () => 'ok' };
    };
    await v._call('Fade', { Duration: 2000 });
    assert.ok(urls[0].includes('Duration=2000'));
  });

  it('returns text response on success', async () => {
    const v = new VMix();
    mockFetchText('response body');
    const result = await v._call('Cut');
    assert.equal(result, 'response body');
  });

  it('returns null when response is not ok', async () => {
    const v = new VMix();
    mockFetchText('error', { ok: false });
    const result = await v._call('Cut');
    assert.equal(result, null);
  });

  it('returns null when fetch throws', async () => {
    const v = new VMix();
    mockFetchThrows();
    const result = await v._call('Cut');
    assert.equal(result, null);
  });
});

// ─── _extractTag ─────────────────────────────────────────────────────────────

describe('VMix._extractTag()', () => {
  it('extracts content of a simple tag', () => {
    const v = new VMix();
    assert.equal(v._extractTag('<version>26.0.0</version>', 'version'), '26.0.0');
  });

  it('trims whitespace from extracted content', () => {
    const v = new VMix();
    assert.equal(v._extractTag('<edition>  HD  </edition>', 'edition'), 'HD');
  });

  it('returns null when tag is absent', () => {
    const v = new VMix();
    assert.equal(v._extractTag('<vmix></vmix>', 'version'), null);
  });

  it('is case-insensitive', () => {
    const v = new VMix();
    assert.equal(v._extractTag('<VERSION>26.0.0</VERSION>', 'version'), '26.0.0');
  });

  it('extracts from full sample XML', () => {
    const v = new VMix();
    assert.equal(v._extractTag(SAMPLE_XML, 'version'), '26.0.0');
    assert.equal(v._extractTag(SAMPLE_XML, 'edition'), 'HD');
    assert.equal(v._extractTag(SAMPLE_XML, 'stream'), 'True');
    assert.equal(v._extractTag(SAMPLE_XML, 'recording'), 'False');
    assert.equal(v._extractTag(SAMPLE_XML, 'active'), '1');
    assert.equal(v._extractTag(SAMPLE_XML, 'preview'), '2');
  });
});

// ─── _extractAttr ─────────────────────────────────────────────────────────────

describe('VMix._extractAttr()', () => {
  it('extracts an attribute value from a tag', () => {
    const v = new VMix();
    const xml = '<master volume="85.5" muted="False" />';
    assert.equal(v._extractAttr(xml, 'master', 'volume'), '85.5');
    assert.equal(v._extractAttr(xml, 'master', 'muted'), 'False');
  });

  it('returns null when attribute is absent', () => {
    const v = new VMix();
    const xml = '<master volume="85.5" />';
    assert.equal(v._extractAttr(xml, 'master', 'missing'), null);
  });

  it('returns null when tag is absent', () => {
    const v = new VMix();
    assert.equal(v._extractAttr('<vmix></vmix>', 'master', 'volume'), null);
  });

  it('is case-insensitive for tag and attr', () => {
    const v = new VMix();
    const xml = '<MASTER VOLUME="99" />';
    assert.equal(v._extractAttr(xml, 'master', 'volume'), '99');
  });
});

// ─── _parseInputs ─────────────────────────────────────────────────────────────

describe('VMix._parseInputs()', () => {
  it('parses two inputs from sample XML', () => {
    const v = new VMix();
    const inputs = v._parseInputs(SAMPLE_XML);
    assert.equal(inputs.length, 2);
  });

  it('correctly maps first input fields', () => {
    const v = new VMix();
    const [first] = v._parseInputs(SAMPLE_XML);
    assert.equal(first.key, 'abc');
    assert.equal(first.number, 1);
    assert.equal(first.type, 'Camera');
    assert.equal(first.title, 'Main Cam');
    assert.equal(first.state, 'Running');
    assert.equal(first.muted, false);
    assert.equal(first.volume, 100);
  });

  it('correctly maps second input fields', () => {
    const v = new VMix();
    const [, second] = v._parseInputs(SAMPLE_XML);
    assert.equal(second.key, 'def');
    assert.equal(second.number, 2);
    assert.equal(second.type, 'NDI');
    assert.equal(second.title, 'NDI Source');
    assert.equal(second.state, 'Paused');
    assert.equal(second.muted, true);
    assert.equal(second.volume, 80);
  });

  it('returns empty array when no inputs present', () => {
    const v = new VMix();
    assert.deepEqual(v._parseInputs('<vmix></vmix>'), []);
  });

  it('defaults number to 0 when missing', () => {
    const v = new VMix();
    const xml = '<input key="x" type="Camera" title="T" state="Running" muted="False" volume="100" />';
    const [input] = v._parseInputs(xml);
    assert.equal(input.number, 0);
  });

  it('defaults volume to 100 when missing', () => {
    const v = new VMix();
    const xml = '<input key="x" number="1" type="Camera" title="T" state="Running" muted="False" />';
    const [input] = v._parseInputs(xml);
    assert.equal(input.volume, 100);
  });

  it('muted is false when value is not "True"', () => {
    const v = new VMix();
    const xml = '<input key="x" number="1" type="Camera" title="T" state="Running" muted="False" volume="50" />';
    const [input] = v._parseInputs(xml);
    assert.equal(input.muted, false);
  });
});

// ─── _parseAudio ──────────────────────────────────────────────────────────────

describe('VMix._parseAudio()', () => {
  it('parses master audio from sample XML', () => {
    const v = new VMix();
    const audio = v._parseAudio(SAMPLE_XML);
    assert.ok(audio !== null);
    assert.equal(audio.volume, 85.5);
    assert.equal(audio.muted, false);
    assert.equal(audio.meterL, 0.5);
    assert.equal(audio.meterR, 0.6);
  });

  it('returns null when no master tag present', () => {
    const v = new VMix();
    assert.equal(v._parseAudio('<vmix></vmix>'), null);
  });

  it('muted is true when value is "True"', () => {
    const v = new VMix();
    const xml = '<master volume="100" muted="True" meterF1="0" meterF2="0" />';
    const audio = v._parseAudio(xml);
    assert.equal(audio.muted, true);
  });

  it('defaults volume to 100 and meters to 0 when those attrs missing', () => {
    const v = new VMix();
    // Provide muted to satisfy the regex, but omit volume/meterF1/meterF2
    const xml = '<master muted="False" />';
    const audio = v._parseAudio(xml);
    assert.ok(audio !== null);
    assert.equal(audio.volume, 100);
    assert.equal(audio.meterL, 0);
    assert.equal(audio.meterR, 0);
  });
});

// ─── isRunning ────────────────────────────────────────────────────────────────

describe('VMix.isRunning()', () => {
  it('returns true when HEAD succeeds', async () => {
    const v = new VMix();
    global.fetch = async (url, opts) => {
      assert.equal(opts.method, 'HEAD');
      return { ok: true };
    };
    const result = await v.isRunning();
    assert.equal(result, true);
    assert.equal(v.running, true);
  });

  it('returns false when HEAD returns non-ok', async () => {
    const v = new VMix();
    mockFetchOk(false);
    const result = await v.isRunning();
    assert.equal(result, false);
    assert.equal(v.running, false);
  });

  it('falls back to GET when HEAD throws', async () => {
    const v = new VMix();
    let callCount = 0;
    global.fetch = async (url, opts) => {
      callCount++;
      if (opts?.method === 'HEAD') throw new Error('HEAD not allowed');
      return { ok: true };
    };
    const result = await v.isRunning();
    assert.equal(result, true);
    assert.equal(v.running, true);
    assert.equal(callCount, 2);
  });

  it('returns false when both HEAD and GET throw', async () => {
    const v = new VMix();
    mockFetchThrows();
    const result = await v.isRunning();
    assert.equal(result, false);
    assert.equal(v.running, false);
  });

  it('includes GetShortXML in URL', async () => {
    const v = new VMix();
    const urls = [];
    global.fetch = async (url) => { urls.push(url); return { ok: true }; };
    await v.isRunning();
    assert.ok(urls[0].includes('GetShortXML'));
  });
});

// ─── getState ─────────────────────────────────────────────────────────────────

describe('VMix.getState()', () => {
  it('calls GetShortXML and returns parsed state', async () => {
    const v = new VMix();
    mockFetchText(SAMPLE_XML);
    const state = await v.getState();
    assert.equal(state.version, '26.0.0');
    assert.equal(state.edition, 'HD');
    assert.equal(state.streaming, true);
    assert.equal(state.recording, false);
    assert.equal(state.external, false);
    assert.equal(state.playList, false);
    assert.equal(state.multiCorder, false);
    assert.equal(state.fullscreen, false);
    assert.equal(state.activeInput, 1);
    assert.equal(state.previewInput, 2);
    assert.equal(state.inputs.length, 2);
    assert.ok(state.audio !== null);
  });

  it('returns null when _call returns null', async () => {
    const v = new VMix();
    mockFetchOk(false);
    const state = await v.getState();
    assert.equal(state, null);
  });

  it('caches state and does not re-fetch within TTL', async () => {
    const v = new VMix();
    let fetchCount = 0;
    global.fetch = async () => {
      fetchCount++;
      return { ok: true, text: async () => SAMPLE_XML };
    };
    await v.getState();
    await v.getState();
    assert.equal(fetchCount, 1, 'Should only fetch once within TTL');
  });

  it('re-fetches when forceRefresh is true', async () => {
    const v = new VMix();
    let fetchCount = 0;
    global.fetch = async () => {
      fetchCount++;
      return { ok: true, text: async () => SAMPLE_XML };
    };
    await v.getState();
    await v.getState(true);
    assert.equal(fetchCount, 2);
  });

  it('re-fetches when cache is expired', async () => {
    const v = new VMix();
    v._CACHE_TTL = 0; // expire immediately
    let fetchCount = 0;
    global.fetch = async () => {
      fetchCount++;
      return { ok: true, text: async () => SAMPLE_XML };
    };
    await v.getState();
    await v.getState();
    assert.equal(fetchCount, 2);
  });

  it('stores parsed state in _stateCache', async () => {
    const v = new VMix();
    mockFetchText(SAMPLE_XML);
    await v.getState();
    assert.ok(v._stateCache !== null);
    assert.equal(v._stateCache.version, '26.0.0');
  });
});

// ─── getStatus ────────────────────────────────────────────────────────────────

describe('VMix.getStatus()', () => {
  it('returns running:false when not running', async () => {
    const v = new VMix();
    global.fetch = async () => ({ ok: false });
    const status = await v.getStatus();
    assert.deepEqual(status, { running: false });
  });

  it('returns error when isRunning true but getState fails', async () => {
    const v = new VMix();
    let callCount = 0;
    global.fetch = async (url, opts) => {
      callCount++;
      if (callCount === 1) return { ok: true }; // HEAD for isRunning
      return { ok: false }; // fail getState
    };
    const status = await v.getStatus();
    assert.equal(status.running, true);
    assert.ok(status.error);
  });

  it('returns full status when running and state available', async () => {
    const v = new VMix();
    global.fetch = async (url, opts) => {
      if (opts?.method === 'HEAD') return { ok: true };
      return { ok: true, text: async () => SAMPLE_XML };
    };
    const status = await v.getStatus();
    assert.equal(status.running, true);
    assert.equal(status.edition, 'HD');
    assert.equal(status.version, '26.0.0');
    assert.equal(status.streaming, true);
    assert.equal(status.recording, false);
    assert.equal(status.inputCount, 2);
    assert.ok(status.activeInput.includes('Main Cam'));
    assert.ok(status.previewInput.includes('NDI Source'));
    assert.ok(status.audio !== null);
  });

  it('falls back to raw input number when input not found in list', async () => {
    const v = new VMix();
    const xml = SAMPLE_XML.replace('<active>1</active>', '<active>99</active>');
    global.fetch = async (url, opts) => {
      if (opts?.method === 'HEAD') return { ok: true };
      return { ok: true, text: async () => xml };
    };
    const status = await v.getStatus();
    assert.equal(status.activeInput, 99);
  });
});

// ─── cut ──────────────────────────────────────────────────────────────────────

describe('VMix.cut()', () => {
  it('calls Cut function and returns true', async () => {
    const v = new VMix();
    const urls = [];
    global.fetch = async (url) => { urls.push(url); return { ok: true, text: async () => 'ok' }; };
    const result = await v.cut();
    assert.equal(result, true);
    assert.ok(urls[0].includes('Function=Cut'));
  });

  it('invalidates state cache on success', async () => {
    const v = new VMix();
    v._stateCache = { version: 'old' };
    mockFetchText('ok');
    await v.cut();
    assert.equal(v._stateCache, null);
  });

  it('throws when _call returns null', async () => {
    const v = new VMix();
    mockFetchOk(false);
    await assert.rejects(() => v.cut(), /Could not send Cut/);
  });
});

// ─── fade ──────────────────────────────────────────────────────────────────────

describe('VMix.fade()', () => {
  it('calls Fade with default duration and returns true', async () => {
    const v = new VMix();
    const urls = [];
    global.fetch = async (url) => { urls.push(url); return { ok: true, text: async () => 'ok' }; };
    const result = await v.fade();
    assert.equal(result, true);
    assert.ok(urls[0].includes('Function=Fade'));
    assert.ok(urls[0].includes('Duration=2000'));
  });

  it('passes custom duration', async () => {
    const v = new VMix();
    const urls = [];
    global.fetch = async (url) => { urls.push(url); return { ok: true, text: async () => 'ok' }; };
    await v.fade(500);
    assert.ok(urls[0].includes('Duration=500'));
  });

  it('invalidates state cache on success', async () => {
    const v = new VMix();
    v._stateCache = { version: 'old' };
    mockFetchText('ok');
    await v.fade();
    assert.equal(v._stateCache, null);
  });

  it('throws when _call returns null', async () => {
    const v = new VMix();
    mockFetchOk(false);
    await assert.rejects(() => v.fade(), /Could not send Fade/);
  });
});

// ─── setPreview ────────────────────────────────────────────────────────────────

describe('VMix.setPreview()', () => {
  it('calls PreviewInput with input number', async () => {
    const v = new VMix();
    const urls = [];
    global.fetch = async (url) => { urls.push(url); return { ok: true, text: async () => 'ok' }; };
    const result = await v.setPreview(3);
    assert.equal(result, true);
    assert.ok(urls[0].includes('Function=PreviewInput'));
    assert.ok(urls[0].includes('Input=3'));
  });

  it('invalidates state cache on success', async () => {
    const v = new VMix();
    v._stateCache = { version: 'old' };
    mockFetchText('ok');
    await v.setPreview(2);
    assert.equal(v._stateCache, null);
  });

  it('throws when _call returns null', async () => {
    const v = new VMix();
    mockFetchOk(false);
    await assert.rejects(() => v.setPreview(1), /Could not set preview/);
  });
});

// ─── setProgram ────────────────────────────────────────────────────────────────

describe('VMix.setProgram()', () => {
  it('calls ActiveInput with input number', async () => {
    const v = new VMix();
    const urls = [];
    global.fetch = async (url) => { urls.push(url); return { ok: true, text: async () => 'ok' }; };
    const result = await v.setProgram(2);
    assert.equal(result, true);
    assert.ok(urls[0].includes('Function=ActiveInput'));
    assert.ok(urls[0].includes('Input=2'));
  });

  it('invalidates state cache on success', async () => {
    const v = new VMix();
    v._stateCache = { version: 'old' };
    mockFetchText('ok');
    await v.setProgram(1);
    assert.equal(v._stateCache, null);
  });

  it('throws when _call returns null', async () => {
    const v = new VMix();
    mockFetchOk(false);
    await assert.rejects(() => v.setProgram(1), /Could not set program/);
  });
});

// ─── startStream / stopStream ─────────────────────────────────────────────────

describe('VMix.startStream()', () => {
  it('calls StartStreaming without destination param', async () => {
    const v = new VMix();
    const urls = [];
    global.fetch = async (url) => { urls.push(url); return { ok: true, text: async () => 'ok' }; };
    const result = await v.startStream();
    assert.equal(result, true);
    assert.ok(urls[0].includes('Function=StartStreaming'));
    assert.ok(!urls[0].includes('StreamingChannel'));
  });

  it('includes StreamingChannel when destination specified', async () => {
    const v = new VMix();
    const urls = [];
    global.fetch = async (url) => { urls.push(url); return { ok: true, text: async () => 'ok' }; };
    await v.startStream(1);
    assert.ok(urls[0].includes('StreamingChannel=1'));
  });

  it('invalidates state cache on success', async () => {
    const v = new VMix();
    v._stateCache = { streaming: false };
    mockFetchText('ok');
    await v.startStream();
    assert.equal(v._stateCache, null);
  });

  it('throws when _call returns null', async () => {
    const v = new VMix();
    mockFetchOk(false);
    await assert.rejects(() => v.startStream(), /Could not start vMix stream/);
  });
});

describe('VMix.stopStream()', () => {
  it('calls StopStreaming without destination', async () => {
    const v = new VMix();
    const urls = [];
    global.fetch = async (url) => { urls.push(url); return { ok: true, text: async () => 'ok' }; };
    const result = await v.stopStream();
    assert.equal(result, true);
    assert.ok(urls[0].includes('Function=StopStreaming'));
  });

  it('includes StreamingChannel when destination specified', async () => {
    const v = new VMix();
    const urls = [];
    global.fetch = async (url) => { urls.push(url); return { ok: true, text: async () => 'ok' }; };
    await v.stopStream(2);
    assert.ok(urls[0].includes('StreamingChannel=2'));
  });

  it('throws when _call returns null', async () => {
    const v = new VMix();
    mockFetchOk(false);
    await assert.rejects(() => v.stopStream(), /Could not stop vMix stream/);
  });
});

// ─── startRecording / stopRecording ───────────────────────────────────────────

describe('VMix.startRecording()', () => {
  it('calls StartRecording and returns true', async () => {
    const v = new VMix();
    const urls = [];
    global.fetch = async (url) => { urls.push(url); return { ok: true, text: async () => 'ok' }; };
    const result = await v.startRecording();
    assert.equal(result, true);
    assert.ok(urls[0].includes('Function=StartRecording'));
  });

  it('invalidates state cache', async () => {
    const v = new VMix();
    v._stateCache = { recording: false };
    mockFetchText('ok');
    await v.startRecording();
    assert.equal(v._stateCache, null);
  });

  it('throws when _call returns null', async () => {
    const v = new VMix();
    mockFetchOk(false);
    await assert.rejects(() => v.startRecording(), /Could not start vMix recording/);
  });
});

describe('VMix.stopRecording()', () => {
  it('calls StopRecording and returns true', async () => {
    const v = new VMix();
    const urls = [];
    global.fetch = async (url) => { urls.push(url); return { ok: true, text: async () => 'ok' }; };
    const result = await v.stopRecording();
    assert.equal(result, true);
    assert.ok(urls[0].includes('Function=StopRecording'));
  });

  it('throws when _call returns null', async () => {
    const v = new VMix();
    mockFetchOk(false);
    await assert.rejects(() => v.stopRecording(), /Could not stop vMix recording/);
  });
});

// ─── setMasterVolume ──────────────────────────────────────────────────────────

describe('VMix.setMasterVolume()', () => {
  it('calls SetVolume with Master input', async () => {
    const v = new VMix();
    const urls = [];
    global.fetch = async (url) => { urls.push(url); return { ok: true, text: async () => 'ok' }; };
    const result = await v.setMasterVolume(75);
    assert.equal(result, 75);
    assert.ok(urls[0].includes('Function=SetVolume'));
    assert.ok(urls[0].includes('Input=Master'));
    assert.ok(urls[0].includes('Value=75'));
  });

  it('clamps value to 0 minimum', async () => {
    const v = new VMix();
    const urls = [];
    global.fetch = async (url) => { urls.push(url); return { ok: true, text: async () => 'ok' }; };
    const result = await v.setMasterVolume(-10);
    assert.equal(result, 0);
    assert.ok(urls[0].includes('Value=0'));
  });

  it('clamps value to 100 maximum', async () => {
    const v = new VMix();
    const urls = [];
    global.fetch = async (url) => { urls.push(url); return { ok: true, text: async () => 'ok' }; };
    const result = await v.setMasterVolume(150);
    assert.equal(result, 100);
    assert.ok(urls[0].includes('Value=100'));
  });

  it('truncates float to integer via parseInt', async () => {
    const v = new VMix();
    const urls = [];
    global.fetch = async (url) => { urls.push(url); return { ok: true, text: async () => 'ok' }; };
    const result = await v.setMasterVolume(85.9);
    assert.equal(result, 85);
  });

  it('throws when _call returns null', async () => {
    const v = new VMix();
    mockFetchOk(false);
    await assert.rejects(() => v.setMasterVolume(50), /Could not set master volume/);
  });
});

// ─── muteMaster / unmuteMaster ────────────────────────────────────────────────

describe('VMix.muteMaster()', () => {
  it('calls MuteInput with Master and returns true', async () => {
    const v = new VMix();
    const urls = [];
    global.fetch = async (url) => { urls.push(url); return { ok: true, text: async () => 'ok' }; };
    const result = await v.muteMaster();
    assert.equal(result, true);
    assert.ok(urls[0].includes('Function=MuteInput'));
    assert.ok(urls[0].includes('Input=Master'));
  });

  it('throws when _call returns null', async () => {
    const v = new VMix();
    mockFetchOk(false);
    await assert.rejects(() => v.muteMaster(), /Could not mute master/);
  });
});

describe('VMix.unmuteMaster()', () => {
  it('calls UnmuteInput with Master and returns true', async () => {
    const v = new VMix();
    const urls = [];
    global.fetch = async (url) => { urls.push(url); return { ok: true, text: async () => 'ok' }; };
    const result = await v.unmuteMaster();
    assert.equal(result, true);
    assert.ok(urls[0].includes('Function=UnmuteInput'));
    assert.ok(urls[0].includes('Input=Master'));
  });

  it('throws when _call returns null', async () => {
    const v = new VMix();
    mockFetchOk(false);
    await assert.rejects(() => v.unmuteMaster(), /Could not unmute master/);
  });
});

// ─── getAudioLevels ───────────────────────────────────────────────────────────

describe('VMix.getAudioLevels()', () => {
  it('returns audio from state', async () => {
    const v = new VMix();
    mockFetchText(SAMPLE_XML);
    const audio = await v.getAudioLevels();
    assert.ok(audio !== null);
    assert.equal(audio.volume, 85.5);
    assert.equal(audio.muted, false);
    assert.equal(audio.meterL, 0.5);
    assert.equal(audio.meterR, 0.6);
  });

  it('returns null when state unavailable', async () => {
    const v = new VMix();
    mockFetchOk(false);
    const audio = await v.getAudioLevels();
    assert.equal(audio, null);
  });

  it('returns null when state has no audio', async () => {
    const v = new VMix();
    const xml = SAMPLE_XML.replace(/<master[^/]*\/>/i, '');
    mockFetchText(xml);
    const audio = await v.getAudioLevels();
    assert.equal(audio, null);
  });
});

// ─── startPlaylist / stopPlaylist ─────────────────────────────────────────────

describe('VMix.startPlaylist()', () => {
  it('calls StartPlayList and returns true', async () => {
    const v = new VMix();
    const urls = [];
    global.fetch = async (url) => { urls.push(url); return { ok: true, text: async () => 'ok' }; };
    const result = await v.startPlaylist();
    assert.equal(result, true);
    assert.ok(urls[0].includes('Function=StartPlayList'));
  });

  it('throws when _call returns null', async () => {
    const v = new VMix();
    mockFetchOk(false);
    await assert.rejects(() => v.startPlaylist(), /Could not start vMix playlist/);
  });
});

describe('VMix.stopPlaylist()', () => {
  it('calls StopPlayList and returns true', async () => {
    const v = new VMix();
    const urls = [];
    global.fetch = async (url) => { urls.push(url); return { ok: true, text: async () => 'ok' }; };
    const result = await v.stopPlaylist();
    assert.equal(result, true);
    assert.ok(urls[0].includes('Function=StopPlayList'));
  });

  it('throws when _call returns null', async () => {
    const v = new VMix();
    mockFetchOk(false);
    await assert.rejects(() => v.stopPlaylist(), /Could not stop vMix playlist/);
  });
});

// ─── listInputs ────────────────────────────────────────────────────────────────

describe('VMix.listInputs()', () => {
  it('returns inputs from state', async () => {
    const v = new VMix();
    mockFetchText(SAMPLE_XML);
    const inputs = await v.listInputs();
    assert.equal(inputs.length, 2);
    assert.equal(inputs[0].title, 'Main Cam');
    assert.equal(inputs[1].title, 'NDI Source');
  });

  it('returns empty array when state unavailable', async () => {
    const v = new VMix();
    mockFetchOk(false);
    const inputs = await v.listInputs();
    assert.deepEqual(inputs, []);
  });

  it('always force-refreshes state', async () => {
    const v = new VMix();
    v._stateCache = { inputs: [{ title: 'Stale' }] };
    v._cacheTime = Date.now();
    let fetchCount = 0;
    global.fetch = async () => {
      fetchCount++;
      return { ok: true, text: async () => SAMPLE_XML };
    };
    await v.listInputs();
    assert.equal(fetchCount, 1, 'Should re-fetch even with valid cache');
  });
});

// ─── getScreenshot ────────────────────────────────────────────────────────────

describe('VMix.getScreenshot()', () => {
  it('returns base64 string from arrayBuffer', async () => {
    const v = new VMix();
    const data = 'fake-jpeg-bytes';
    mockFetchArrayBuffer(data);
    const result = await v.getScreenshot();
    assert.equal(result, Buffer.from(data).toString('base64'));
  });

  it('uses default input "Output"', async () => {
    const v = new VMix();
    const urls = [];
    global.fetch = async (url) => {
      urls.push(url);
      return { ok: true, arrayBuffer: async () => Buffer.from('img').buffer };
    };
    await v.getScreenshot();
    assert.ok(urls[0].includes('input=Output'));
  });

  it('uses specified input name', async () => {
    const v = new VMix();
    const urls = [];
    global.fetch = async (url) => {
      urls.push(url);
      return { ok: true, arrayBuffer: async () => Buffer.from('img').buffer };
    };
    await v.getScreenshot('Main Cam');
    assert.ok(urls[0].includes('input=Main+Cam') || urls[0].includes('input=Main%20Cam'));
  });

  it('includes snapshot path and dimensions', async () => {
    const v = new VMix();
    const urls = [];
    global.fetch = async (url) => {
      urls.push(url);
      return { ok: true, arrayBuffer: async () => Buffer.from('img').buffer };
    };
    await v.getScreenshot();
    assert.ok(urls[0].includes('/api/snapshot'));
    assert.ok(urls[0].includes('width=720'));
    assert.ok(urls[0].includes('height=405'));
    assert.ok(urls[0].includes('format=jpg'));
  });

  it('returns null when response is not ok', async () => {
    const v = new VMix();
    mockFetchOk(false);
    const result = await v.getScreenshot();
    assert.equal(result, null);
  });

  it('returns null when fetch throws', async () => {
    const v = new VMix();
    mockFetchThrows();
    const result = await v.getScreenshot();
    assert.equal(result, null);
  });
});

// ─── toStatus ─────────────────────────────────────────────────────────────────

describe('VMix.toStatus()', () => {
  it('returns connected, host, port', () => {
    const v = new VMix({ host: '10.0.0.5', port: 8088 });
    v.running = true;
    const status = v.toStatus();
    assert.deepEqual(status, { connected: true, host: '10.0.0.5', port: 8088 });
  });

  it('connected reflects running state', () => {
    const v = new VMix();
    v.running = false;
    assert.equal(v.toStatus().connected, false);
    v.running = true;
    assert.equal(v.toStatus().connected, true);
  });

  it('uses default host and port', () => {
    const v = new VMix();
    const status = v.toStatus();
    assert.equal(status.host, 'localhost');
    assert.equal(status.port, 8088);
  });
});
