/**
 * Companion driver against a mock that mirrors a REAL Companion 5.0.6 (fixture:
 * test/fixtures/companion-5.0.6-http-api.json). Every refusal Companion can give —
 * empty slot (204), unknown variable (404), HTTP API switched off (403), not running,
 * another web server on the port — must come back as an error, never as "done".
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const mockLib = require('./mocks/companionServer');
const SRC = process.env.TALLY_COMPANION_SRC || path.join(__dirname, '..', 'src');
const { CompanionBridge } = require(path.join(SRC, 'companion.js'));
const FIX = require('./fixtures/companion-5.0.6-http-api.json');
for (const k of ['log', 'info', 'warn']) console[k] = (...a) => process.stderr.write(a.join(' ') + '\n');

const mocks = [];
async function mk(opts = {}) { const m = await mockLib.start({ port: 0, ...opts }); mocks.push(m); return m; }
const bridges = [];
function br(m, url) { const b = new CompanionBridge({ companionUrl: url || m.url }); bridges.push(b); return b; }
test.afterEach(() => { while (bridges.length) { try { bridges.pop().stopPolling(); } catch { /* */ } } });
test.after(async () => { for (const m of mocks) { try { await m.stop(); } catch { /* */ } } });

function raw(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject); req.end();
  });
}

test('mock answers exactly like the real Companion 5.0.6 observations', async () => {
  const m = await mk();
  for (const o of FIX.observations) {
    const r = await raw(m.url + o.path, o.method);
    assert.equal(r.status, o.status, `${o.method} ${o.path}`);
    if ('body' in o) assert.equal(r.body, o.body, `${o.method} ${o.path} body`);
    if (o.bodyPattern) assert.match(r.body, new RegExp(o.bodyPattern));
    if (o.json) assert.ok(Array.isArray(JSON.parse(r.body)));
    if (o.readBack) assert.equal((await raw(m.url + o.path.split('?')[0])).body, o.readBack);
  }
  m.setMode('api-disabled');
  assert.equal((await raw(m.url + '/api/variable/internal/time_hms/value')).status, FIX.apiDisabledStatus);
});

test('default address is Companion 3+/4.x/5.x port 8000 (not the 2.x 8888)', () => {
  const b = new CompanionBridge();
  assert.equal(b.baseUrl, 'http://localhost:8000');
});

test('probe: only a real Companion counts; another web server, offline, hang and API-off are distinguished', { timeout: 20000 }, async () => {
  const m = await mk();
  const b = br(m);
  assert.deepEqual(await b.probe(), { ok: true, apiDisabled: false, reason: null });
  assert.equal(await b.isAvailable(), true);
  m.setMode('not-companion');
  const p1 = await b.probe();
  assert.equal(p1.ok, false); assert.match(p1.reason, /not Companion/);
  assert.equal(await b.isAvailable(), false);
  m.setMode('api-disabled');
  const p2 = await b.probe();
  assert.equal(p2.ok, false); assert.equal(p2.apiDisabled, true);
  m.setMode('offline');
  assert.equal((await b.probe()).ok, false);
  m.setMode('hang');
  const t0 = Date.now();
  assert.equal((await b.probe()).ok, false);
  assert.ok(Date.now() - t0 < 5000);
  m.setMode('ok');
  assert.equal(await b.isAvailable(), true);
});

test('press: a real button is pressed and its label reported; an empty slot (204) is refused and nothing happens', async () => {
  const m = await mk();
  const b = br(m);
  const r = await b.pressButton(1, 0, 0);
  assert.equal(r.success, true); assert.equal(r.text, 'Walk In');
  assert.equal(m.state.pressLog.length, 1);
  await assert.rejects(b.pressButton(1, 3, 7), /No button at page 1 row 3 column 7/);
  assert.equal(m.state.pressLog.length, 1);
  await assert.rejects(b.pressButton(0, 0, 0), /Invalid page/);
  await assert.rejects(b.pressButton(1, -1, 0), /Invalid row/);
  await assert.rejects(b.pressButton('x', 0, 0), /Invalid page/);
  m.setMode('api-disabled');
  await assert.rejects(b.pressButton(1, 0, 0), /HTTP API is switched off/);
  m.setMode('offline');
  await assert.rejects(b.pressButton(1, 0, 0), /not reachable/);
  assert.equal(m.state.pressLog.length, 1);
});

test('press actually runs the button (stateful): a button that sets a custom variable changes it', async () => {
  const m = await mk();
  m.setButton({ page: 2, row: 1, col: 1, text: 'Ready Green', action: { setCustom: ['tally_service_ready', 'green'] } });
  const b = br(m);
  await b.pressButton(2, 1, 1);
  assert.equal(await b.getCustomVariable('tally_service_ready'), 'green');
});

test('button grid comes from Companion b_text variables; labels on pages 1–10 drive press-by-name', async () => {
  const m = await mk();
  const b = br(m);
  const g = await b.getButtonGrid(1);
  assert.equal(g.length, 4); assert.equal(g[0].length, 8);
  assert.equal(g[0][0].text, 'Walk In'); assert.equal(g[0][2].text, 'Dante: Sunday'); assert.equal(g[3][7].text, '');
  m.setButton({ page: 7, row: 2, col: 5, text: 'Offering Loop' });
  const r = await b.pressNamed('offering loop');
  assert.deepEqual([r.page, r.row, r.col], [7, 2, 5]);
});

test('press by name: exact label wins; partial must be unique; ambiguous and unknown names press NOTHING', async () => {
  const m = await mk();
  const b = br(m);
  const exact = await b.pressNamed('Dante: Sunday');
  assert.deepEqual([exact.row, exact.col], [0, 2], 'exact label must beat "Dante: Sunday Late"');
  const n0 = m.state.pressLog.length;
  await assert.rejects(b.pressNamed('sunday'), /matches 2 Companion buttons.*nothing pressed/);
  await assert.rejects(b.pressNamed('Walk Out'), /No Companion button labelled "Walk Out"/);
  assert.equal(m.state.pressLog.length, n0);
  const part = await b.pressNamed('service st');
  assert.equal(part.text, 'Service Start');
  await assert.rejects(b.pressNamed(''), /Button name required/);
});

test('press by name sees a button added after the first lookup (index refresh on miss)', async () => {
  const m = await mk();
  const b = br(m);
  await b.pressNamed('Walk In');
  m.setButton({ page: 1, row: 2, col: 2, text: 'New Cue' });
  const r = await b.pressNamed('New Cue');
  assert.deepEqual([r.row, r.col], [2, 2]);
});

test('connections carry Companion\'s real status: ok / warning / error (with message) / disabled / unknown; 4.x → not reported', async () => {
  const m = await mk();
  m.setConnections([
    { id: 'a', label: 'atem', moduleId: 'bmd-atem', enabled: true, status: { category: 'good', level: 'ok', message: null } },
    { id: 'b', label: 'pp', moduleId: 'renewedvision-propresenter', enabled: true, status: { category: 'error', level: 'connection_failure', message: 'ECONNREFUSED 10.0.0.5:1025' } },
    { id: 'c', label: 'obs', moduleId: 'obs-studio', enabled: true, status: { category: 'warning', level: 'bad_config', message: 'No password' } },
    { id: 'd', label: 'old', moduleId: 'x', enabled: false, status: null },
    { id: 'e', label: 'new', moduleId: 'y', enabled: true, status: null },
  ]);
  const b = br(m);
  const list = await b.getConnections();
  const by = Object.fromEntries(list.map((c) => [c.label, c]));
  assert.equal(by.atem.status, 'ok');
  assert.equal(by.pp.status, 'error'); assert.equal(by.pp.hasError, true); assert.match(by.pp.detail, /ECONNREFUSED/);
  assert.equal(by.obs.status, 'warning'); assert.match(by.obs.detail, /No password/);
  assert.equal(by.old.status, 'disabled');
  assert.equal(by.new.status, 'unknown');
  for (const c of list) assert.doesNotMatch(String(c.status), /object/);
  m.setMode('v4');
  assert.equal(await b.getConnections(), null);
  assert.equal(b.connectionsKnown, false);
});

test('custom variables: set with ?value= and read back; a variable that doesn\'t exist is refused', async () => {
  const m = await mk();
  const b = br(m);
  assert.equal(await b.setCustomVariable('tally_service_ready', 'yellow'), 'yellow');
  assert.equal(m.state.customVariables.tally_service_ready, 'yellow', 'must be the plain value, not a JSON object');
  await assert.rejects(b.setCustomVariable('service_state', 'live'), /no custom variable "service_state"/);
  assert.equal('service_state' in m.state.customVariables, false);
  assert.equal(await b.getCustomVariable('service_state'), null);
  m.setMode('offline');
  await assert.rejects(b.setCustomVariable('tally_service_ready', 'red'), /not reachable/);
});

test('module variables use /api/variable/<label>/<name>/value; unknown → null; offline → error', async () => {
  const m = await mk();
  const b = br(m);
  assert.equal(await b.getVariable('atem', 'pgm1_input'), 'Camera 1');
  assert.equal(await b.getVariable('atem', 'nope'), null);
  m.setMode('offline');
  await assert.rejects(b.getVariable('atem', 'pgm1_input'), /not reachable/);
});

test('polling: connected → disconnected within one interval, reason kept; back again; module change emitted', { timeout: 20000 }, async () => {
  const m = await mk();
  const b = br(m);
  const ev = [];
  b.on('connected', () => ev.push('up'));
  b.on('disconnected', (why) => ev.push(`down:${why}`));
  b.on('connectionsChanged', () => ev.push('conns'));
  await b.startPolling(300);
  assert.equal(b.connected, true);
  m.setConnectionStatus({ label: 'atem', category: 'error', message: 'lost' });
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(b.getStatus().connections[0].status, 'error');
  m.setMode('offline');
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(b.connected, false);
  assert.equal(b.getStatus().connectionCount, 0);
  assert.match(b.getStatus().error, /not reachable/);
  m.setMode('api-disabled');
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(b.getStatus().apiDisabled, true);
  m.setMode('ok');
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(b.connected, true);
  assert.deepEqual(ev.filter((e) => e === 'up').length, 2);
  assert.ok(ev.some((e) => e.startsWith('down:')));
  assert.ok(ev.includes('conns'));
});
