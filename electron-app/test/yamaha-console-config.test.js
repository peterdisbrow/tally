/**
 * Yamaha CL / QL / TF booth side. The consoles speak RCP text on TCP 49280 (no OSC,
 * nothing on 8765). The network scan and the "Test" button must ask the console
 * for its product name, and old configs holding 8765 must be steered to 49280.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
for (const k of ['log', 'info', 'warn']) console[k] = (...a) => process.stderr.write(a.join(' ') + '\n');

const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

async function server(onLine) {
  const srv = net.createServer((s) => {
    let b = '';
    s.on('data', (d) => { b += d; let i; while ((i = b.indexOf('\n')) >= 0) { const l = b.slice(0, i); b = b.slice(i + 1); onLine(s, l); } });
    s.on('error', () => {});
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

test('scanner: Yamaha probe is RCP on TCP 49280 and requires a Yamaha answer', async () => {
  const ns = require('../src/networkScanner');
  const s = SRC('networkScanner.js');
  assert.match(s, /\{ port: 49280, type: 'mixer-yamaha' \}/);
  assert.doesNotMatch(s, /port: 8765/);
  assert.doesNotMatch(s, /ymhss/);
  const yam = await server((sock, l) => { if (l === 'devinfo productname') sock.write('OK devinfo productname "QL5"\n'); });
  const silent = await server(() => {});
  const other = await server((sock) => sock.write('HTTP/1.1 400 Bad Request\r\n\r\n'));
  try {
    assert.equal(await ns.tryYamahaRcpProbe('127.0.0.1', yam.port, 800), 'QL5');
    assert.equal(await ns.tryYamahaRcpProbe('127.0.0.1', silent.port, 400), false, 'open port that never answers is not a Yamaha');
    assert.equal(await ns.tryYamahaRcpProbe('127.0.0.1', other.port, 400), false, 'something else on the port is not a Yamaha');
  } finally { await yam.close(); await silent.close(); await other.close(); }
});

test('equipment test: Yamaha uses the RCP probe; legacy 8765 → 49280; result names the model', async () => {
  const et = require('../src/equipment-tester');
  const calls = [];
  et.init({ tryYamahaRcpProbe: async (ip, port) => { calls.push(port); return port === 49280 ? 'CL5' : false; }, tryUdpProbe: async () => { throw new Error('no UDP for Yamaha'); } });
  const r1 = await et.testEquipmentConnection({ type: 'mixer', mixerType: 'yamaha', ip: '10.0.0.9', port: 8765 });
  assert.equal(r1.success, true);
  assert.match(r1.details, /Yamaha CL5 answering at 10\.0\.0\.9:49280 \(RCP\)/);
  const r2 = await et.testEquipmentConnection({ type: 'mixer', mixerType: 'yamaha', ip: '10.0.0.9' });
  assert.equal(r2.success, true);
  const r3 = await et.testEquipmentConnection({ type: 'mixer', mixerType: 'yamaha', ip: '10.0.0.9', port: 50000 });
  assert.equal(r3.success, false);
  assert.match(r3.details, /Cannot reach a Yamaha console at 10\.0\.0\.9:50000/);
  assert.deepEqual(calls, [49280, 49280, 50000]);
});

test('device registry port hint says Yamaha CL/QL/TF=49280', () => {
  const s = SRC('device-registry.js');
  assert.match(s, /Yamaha CL\/QL\/TF=49280/);
  assert.doesNotMatch(s, /CL\/QL=8765/);
});
