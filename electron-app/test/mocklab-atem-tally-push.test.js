/**
 * A crew member cutting on the MockLab panel (HTTP /api/program) must show up
 * on a switcher client that is already connected. A real ATEM pushes PrgI/PrvI
 * to every session. Updating only the in-memory fake leaves the booth on the
 * old camera.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { MockLabManager } = require('../src/mockLabManager');
const { Atem } = require(path.join(__dirname, '../../church-client/node_modules/atem-connection'));

function waitFor(pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      let ok = false;
      try { ok = !!pred(); } catch { ok = false; }
      if (ok) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
}

test('already-connected ATEM client sees a MockLab panel cut to program 5 / preview 3', async () => {
  const mgr = new MockLabManager(() => {});
  const atem = new Atem();
  try {
    const addrs = await mgr.start({
      allowFallback: false,
      addresses: {
        atem: { ip: '127.0.0.1', port: 21000 },
        obs: { ip: '127.0.0.1', port: 21001 },
        x32: { ip: '127.0.0.1', port: 21002 },
        encoder: { ip: '127.0.0.1', port: 21003 },
        hyperdeck: { ip: '127.0.0.1', port: 21004 },
        propresenter: { ip: '127.0.0.1', port: 21005 },
        controlApi: { ip: '127.0.0.1', port: 21020 },
      },
    });
    await atem.connect(addrs.atem.ip, addrs.atem.port);
    const ready = await waitFor(() => atem.state?.video?.mixEffects?.[0]?.programInput != null, 8000);
    assert.equal(ready, true, 'client never received the initial program bus');
    // The fake sends one more bus packet ~120ms after hello. Wait that out so
    // the cut below is not credited to the handshake.
    await new Promise((r) => setTimeout(r, 500));
    const before = atem.state.video.mixEffects[0];
    assert.notEqual(before.programInput, 5, 'fixture must not already be on camera 5');

    const api = `http://${addrs.controlApi.ip}:${addrs.controlApi.port}`;
    const program = await fetch(`${api}/api/program`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ me: 0, input: 5 }),
    });
    const preview = await fetch(`${api}/api/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ me: 0, input: 3 }),
    });
    assert.equal(program.ok, true, 'panel program cut was refused');
    assert.equal(preview.ok, true, 'panel preview cut was refused');

    const seen = await waitFor(() => {
      const me = atem.state?.video?.mixEffects?.[0];
      return me && me.programInput === 5 && me.previewInput === 3;
    }, 4000);
    const after = atem.state?.video?.mixEffects?.[0] || {};
    assert.equal(seen, true,
      `connected client stayed on program ${after.programInput} preview ${after.previewInput} after the panel cut to 5/3`);
  } finally {
    try { await atem.destroy(); } catch { /* already closed */ }
    try { await mgr.stop(); } catch { /* */ }
  }
});
