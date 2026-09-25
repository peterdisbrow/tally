/**
 * ProPresenter booth side. PP7 answers GET /version with { api_version, host_description }
 * (official OpenAPI spec). The network scan and the "Test" button must only call it
 * ProPresenter when that answer comes back — a 404 or another web server on :1025 is not PP.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
for (const k of ['log', 'info', 'warn']) console[k] = (...a) => process.stderr.write(a.join(' ') + '\n');

async function web(handler) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}
const pp = (req, res) => {
  if (req.url === '/version') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ name: 'Sanctuary PP', host_description: 'ProPresenter 7.16.2', api_version: 'v1', platform: 'mac' })); return; }
  res.writeHead(404); res.end();
};
const notFound = (req, res) => { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<h1>Not Found</h1>'); };
const otherJson = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok","product":"Some NAS"}'); };

test('scanner: ProPresenter probe is GET /version and needs a ProPresenter answer', async () => {
  const ns = require('../src/networkScanner');
  assert.equal(typeof ns.tryProPresenterProbe, 'function', 'scanner exposes a ProPresenter fingerprint probe');
  const a = await web(pp); const b = await web(notFound); const c = await web(otherJson);
  try {
    assert.deepEqual(await ns.tryProPresenterProbe('127.0.0.1', a.port, 1000), { version: 'ProPresenter 7.16.2', name: 'Sanctuary PP' });
    assert.equal(await ns.tryProPresenterProbe('127.0.0.1', b.port, 1000), null, '404 web server is not ProPresenter');
    assert.equal(await ns.tryProPresenterProbe('127.0.0.1', c.port, 1000), null, 'other JSON server is not ProPresenter');
    assert.equal(await ns.tryProPresenterProbe('127.0.0.1', 1, 500), null, 'nothing listening');
  } finally { await a.close(); await b.close(); await c.close(); }
});

test('equipment test: ProPresenter passes only for a real /version answer and names the version', async () => {
  const et = require('../src/equipment-tester');
  const ns = require('../src/networkScanner');
  et.init({ tryHttpGet: ns.tryHttpGet });
  const a = await web(pp); const b = await web(notFound); const c = await web(otherJson);
  try {
    const r1 = await et.testEquipmentConnection({ type: 'propresenter', ip: '127.0.0.1', port: a.port });
    assert.equal(r1.success, true, JSON.stringify(r1));
    assert.match(r1.details, /ProPresenter 7\.16\.2 running \(Sanctuary PP\)/);
    const r2 = await et.testEquipmentConnection({ type: 'propresenter', ip: '127.0.0.1', port: b.port });
    assert.equal(r2.success, false, JSON.stringify(r2));
    assert.match(r2.details, /not ProPresenter/);
    const r3 = await et.testEquipmentConnection({ type: 'propresenter', ip: '127.0.0.1', port: c.port });
    assert.equal(r3.success, false, JSON.stringify(r3));
    const r4 = await et.testEquipmentConnection({ type: 'propresenter', ip: '127.0.0.1', port: 1 });
    assert.equal(r4.success, false);
    assert.match(r4.details, /Cannot reach ProPresenter/);
  } finally { await a.close(); await b.close(); await c.close(); }
});
