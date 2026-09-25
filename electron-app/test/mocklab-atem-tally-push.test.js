/**
 * A crew member cutting on the MockLab panel (HTTP /api/program) must show up
 * on a switcher client that is already connected. A real ATEM pushes PrgI/PrvI
 * to every session. Updating only the in-memory fake leaves the booth on the
 * old camera.
 *
 * The client here is a small UDP speaker so this file does not need
 * church-client's node_modules (the Electron CI job does not install them).
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('dgram');

const { MockLabManager } = require('../src/mockLabManager');

const ATEM_HELLO = Buffer.from([
  0x10, 0x14, 0x53, 0xab, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3a,
  0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

function parseCommands(payload) {
  const cmds = [];
  let offset = 0;
  while (offset + 8 <= payload.length) {
    const len = payload.readUInt16BE(offset);
    if (len < 8 || offset + len > payload.length) break;
    cmds.push({
      name: payload.toString('ascii', offset + 4, offset + 8),
      body: payload.subarray(offset + 8, offset + len),
    });
    offset += len;
  }
  return cmds;
}

function openAtemClient(port) {
  const sock = dgram.createSocket('udp4');
  const bus = { program: null, preview: null };
  sock.on('message', (msg) => {
    if (msg.length < 12) return;
    const flags = msg.readUInt8(0) >> 3;
    const sessionId = msg.readUInt16BE(2);
    const remoteId = msg.readUInt16BE(10) & 0x7fff;
    if (flags & 1) {
      const ack = Buffer.alloc(12);
      ack.writeUInt16BE((16 << 11) | 12, 0);
      ack.writeUInt16BE(sessionId, 2);
      ack.writeUInt16BE(remoteId, 4);
      sock.send(ack, port, '127.0.0.1');
    }
    if (msg.length <= 12) return;
    for (const cmd of parseCommands(msg.subarray(12))) {
      if (cmd.name === 'PrgI' && cmd.body.length >= 4) bus.program = cmd.body.readUInt16BE(2);
      if (cmd.name === 'PrvI' && cmd.body.length >= 4) bus.preview = cmd.body.readUInt16BE(2);
    }
  });
  return new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(0, '127.0.0.1', () => {
      sock.send(ATEM_HELLO, port, '127.0.0.1', (err) => {
        if (err) reject(err);
        else resolve({ sock, bus });
      });
    });
  });
}

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
  let client = null;
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
    client = await openAtemClient(addrs.atem.port);
    const ready = await waitFor(() => client.bus.program != null && client.bus.preview != null, 8000);
    assert.equal(ready, true, 'client never received the initial program bus');
    // The fake sends one more bus packet ~120ms after hello. Wait that out so
    // the cut below is not credited to the handshake.
    await new Promise((r) => setTimeout(r, 500));
    assert.notEqual(client.bus.program, 5, 'fixture must not already be on camera 5');

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

    const seen = await waitFor(() => client.bus.program === 5 && client.bus.preview === 3, 4000);
    assert.equal(seen, true,
      `connected client stayed on program ${client.bus.program} preview ${client.bus.preview} after the panel cut to 5/3`);
  } finally {
    try { client?.sock?.close(); } catch { /* already closed */ }
    try { await mgr.stop(); } catch { /* */ }
  }
});
