/**
 * fetchRoomEquipment must distinguish a real relay answer from a failure,
 * against a real HTTP server (loopback). decideRoomEquipment never treats a
 * failure as authoritative.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const rc = require('../src/relay-client');
const { decideRoomEquipment } = require('../src/room-equipment');

let mode = 'ok';
let server, port;
test.before(async () => {
  server = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer tok') { res.writeHead(401); return res.end('{"error":"invalid token"}'); }
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(body); };
    switch (mode) {
      case 'ok': return send(200, JSON.stringify({ equipment: { atemIp: '127.0.0.1' } }));
      case 'empty': return send(200, JSON.stringify({ equipment: {} }));
      case 'none': return send(200, JSON.stringify({}));
      case 'array': return send(200, JSON.stringify({ equipment: [1, 2] }));
      case 'string': return send(200, JSON.stringify({ equipment: 'x' }));
      case 'html': return send(200, '<html>proxy error</html>');
      case '500': return send(500, '{"error":"boom"}');
      case '503': return send(503, '');
      case 'drop': return req.socket.destroy();
      default: return send(404, '{}');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
test.after(() => server.close());
const use = (token = 'tok', relay) => rc.init({ loadConfig: () => ({ token, relay: relay || `ws://127.0.0.1:${port}` }) });

test('fetchRoomEquipment: 200 with equipment -> ok + equipment', async () => {
  use(); mode = 'ok';
  assert.deepEqual(await rc.fetchRoomEquipment('r1'), { ok: true, equipment: { atemIp: '127.0.0.1' } });
  assert.deepEqual(await rc.fetchEquipmentFromRelay('r1'), { atemIp: '127.0.0.1' });
});
test('fetchRoomEquipment: 200 with empty/no equipment -> ok + null (real "nothing saved")', async () => {
  use();
  for (const m of ['empty', 'none']) { mode = m; assert.deepEqual(await rc.fetchRoomEquipment('r1'), { ok: true, equipment: null }, m); }
});
for (const m of ['array', 'string', 'html', '500', '503', 'drop']) {
  test(`fetchRoomEquipment: ${m} -> ok:false (never "no equipment")`, async () => {
    use(); mode = m;
    const r = await rc.fetchRoomEquipment('r1');
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.ok(r.error);
    assert.equal(decideRoomEquipment({ fetchResult: r, localLoaded: true }).action, 'keep-local');
    assert.equal(decideRoomEquipment({ fetchResult: r, localLoaded: true }).fetchFailed, true);
  });
}
test('fetchRoomEquipment: 401 bad token -> ok:false status 401', async () => {
  use('wrong'); mode = 'ok';
  const r = await rc.fetchRoomEquipment('r1');
  assert.equal(r.ok, false); assert.equal(r.status, 401);
});
test('fetchRoomEquipment: relay port closed -> ok:false', async () => {
  const s2 = http.createServer(); await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const dead = s2.address().port; await new Promise((r) => s2.close(r));
  use('tok', `ws://127.0.0.1:${dead}`);
  const r = await rc.fetchRoomEquipment('r1');
  assert.equal(r.ok, false);
});
test('decideRoomEquipment matrix', () => {
  const d = (fetchResult, localLoaded) => decideRoomEquipment({ fetchResult, localLoaded });
  assert.equal(d({ ok: true, equipment: { atemIp: 'x' } }, false).action, 'apply-remote');
  assert.equal(d({ ok: true, equipment: { atemIp: 'x' } }, true).action, 'apply-remote');
  assert.equal(d({ ok: true, equipment: null }, true).action, 'keep-local');
  assert.equal(d({ ok: true, equipment: null }, false).action, 'clear');
  assert.equal(d({ ok: true, equipment: null }, false).fetchFailed, false);
  assert.equal(d({ ok: false }, false).action, 'clear');
  assert.equal(d({ ok: false }, false).fetchFailed, true);
  assert.equal(d({ ok: true, equipment: [1] }, true).action, 'keep-local', 'partial/malformed = failed');
  assert.equal(d(null, true).action, 'keep-local');
});
