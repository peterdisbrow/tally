/**
 * Companion booth side. Only a real Companion answers GET /api/variable/internal/time_hms/value
 * with its clock; 403 = Companion with the HTTP API switched off. The scan, the "Test" button and
 * the Control Room card must tell those apart and show Companion's own module problems.
 * (Never probes a real Companion: every server here is a throwaway on an ephemeral port.)
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
for (const k of ['log', 'info', 'warn']) console[k] = (...a) => process.stderr.write(a.join(' ') + '\n');

async function web(handler) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}
function companion({ apiOff = false, conns = [] } = {}) {
  return (req, res) => {
    if (!req.url.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Companion</title>'); return; }
    if (apiOff) { res.writeHead(403); res.end('Forbidden'); return; }
    if (req.url === '/api/variable/internal/time_hms/value') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('19:42:07'); return; }
    if (req.url === '/api/connections') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(conns)); return; }
    res.writeHead(404); res.end('Not found');
  };
}
const anyWeb = (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>Router admin</h1>'); };
const notFound = (req, res) => { res.writeHead(404); res.end(); };

test('scanner: Companion probe needs Companion\'s clock variable — any other web server is not Companion', async () => {
  const ns = require('../src/networkScanner');
  assert.equal(typeof ns.tryCompanionProbe, 'function', 'scanner exposes a Companion fingerprint probe');
  const a = await web(companion()); const b = await web(anyWeb); const c = await web(notFound);
  try {
    assert.deepEqual(await ns.tryCompanionProbe('127.0.0.1', a.port, 1000), { apiDisabled: false });
    assert.equal(await ns.tryCompanionProbe('127.0.0.1', b.port, 1000), null, 'a 200 web page is not Companion');
    assert.equal(await ns.tryCompanionProbe('127.0.0.1', c.port, 1000), null, '404 server is not Companion');
    assert.equal(await ns.tryCompanionProbe('127.0.0.1', 1, 500), null, 'nothing listening');
  } finally { await a.close(); await b.close(); await c.close(); }
});

test('scanner looks on Companion 3+ default port 8000 as well as 8888', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'networkScanner.js'), 'utf8');
  assert.match(src, /\{ type: 'companion', ip: '127\.0\.0\.1', port: 8000 \}/);
  assert.match(src, /\{ port: 8000,\s+type: 'companion' \}/);
});

test('equipment test: real Companion passes and reports module problems; API off, other web server, nothing → fail with the reason', async () => {
  const et = require('../src/equipment-tester');
  const ns = require('../src/networkScanner');
  et.init({ tryHttpGet: ns.tryHttpGet });
  const conns = [
    { id: 'a', label: 'atem', enabled: true, status: { category: 'good' } },
    { id: 'b', label: 'pp', enabled: true, status: { category: 'error', message: 'ECONNREFUSED' } },
    { id: 'c', label: 'off', enabled: false, status: null },
  ];
  const a = await web(companion({ conns })); const b = await web(companion({ apiOff: true })); const c = await web(anyWeb);
  try {
    const r1 = await et.testEquipmentConnection({ type: 'companion', ip: '127.0.0.1', port: a.port });
    assert.equal(r1.success, true, JSON.stringify(r1));
    assert.match(r1.details, /2 connections, 1 with problems: pp \(ECONNREFUSED\)/);
    const r2 = await et.testEquipmentConnection({ type: 'companion', ip: '127.0.0.1', port: b.port });
    assert.equal(r2.success, false); assert.match(r2.details, /HTTP API is switched off/);
    const r3 = await et.testEquipmentConnection({ type: 'companion', ip: '127.0.0.1', port: c.port });
    assert.equal(r3.success, false); assert.match(r3.details, /not Companion/);
    const r4 = await et.testEquipmentConnection({ type: 'companion', ip: '127.0.0.1', port: 1 });
    assert.equal(r4.success, false); assert.match(r4.details, /Cannot reach Companion/);
  } finally { await a.close(); await b.close(); await c.close(); }
});

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  let depth = 0;
  for (let i = src.indexOf(') {', start) + 2; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unterminated');
}
function summary(comp) {
  const code = `${extractFn(SRC, 'getStatusActive')}\n${extractFn(SRC, 'getCompanionSummary')}\ngetCompanionSummary(c);`;
  return vm.runInNewContext(code, { c: comp });
}

test('card: Companion down / API off / module error / warnings / not reported are all spelled out', () => {
  assert.equal(summary(null), null, 'not configured → no card');
  const down = summary({ connected: false, error: 'not reachable (ECONNREFUSED)' });
  assert.equal(down.state, 'error'); assert.equal(down.issue, true); assert.match(down.detail, /ECONNREFUSED/);
  const off = summary({ connected: false, apiDisabled: true });
  assert.equal(off.value, 'HTTP API off'); assert.equal(off.issue, true);
  const err = summary({ connected: true, connectionsKnown: true, connections: [{ label: 'atem', status: 'ok' }, { label: 'pp', status: 'error', detail: 'connection_failure: ECONNREFUSED' }] });
  assert.equal(err.state, 'error'); assert.equal(err.issue, true); assert.match(err.detail, /1 module in error: pp \(connection_failure: ECONNREFUSED\)/);
  const warn = summary({ connected: true, connectionsKnown: true, connections: [{ label: 'obs', status: 'warning', detail: 'No password' }] });
  assert.equal(warn.state, 'warning'); assert.equal(warn.issue, false);
  const ok = summary({ connected: true, connectionsKnown: true, connections: [{ label: 'a', status: 'ok' }, { label: 'b', status: 'ok' }] });
  assert.equal(ok.state, 'ok'); assert.equal(ok.detail, '2 modules OK');
  const v4 = summary({ connected: true, connectionsKnown: false, connections: [] });
  assert.match(v4.detail, /not reported/);
});

test('hero counts a configured Companion that is down (or a module in error) as an issue', () => {
  const fn = extractFn(SRC, 'updateControlRoom');
  assert.match(fn, /companionSummary && companionSummary\.issue\) issues\+\+/);
});

test('default Companion port in the Equipment UI is 8000 (Companion 3+), not 8888', () => {
  for (const f of ['equipment-ui.js', 'device-registry.js']) {
    const s = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    assert.doesNotMatch(s, /8888/, `${f} still defaults Companion to 8888`);
  }
  assert.doesNotMatch(SRC, /companion[^\n]{0,80}'8888'/, 'renderer still defaults Companion to 8888');
});

test('Test button builds the Companion address from the host/port fields (the form has no URL field)', () => {
  const i = SRC.indexOf("} else if (type === 'companion') {");
  const block = SRC.slice(i, SRC.indexOf('} else if', i + 10));
  assert.doesNotMatch(block, /Enter a URL/, 'Test button always said "Enter a URL" because deviceState.companion has host/port');
  assert.match(block, /state\.host/);
  assert.match(block, /parseInt\(state\.port\) \|\| 8000/);
});
