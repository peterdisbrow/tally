/**
 * Mock Allen & Heath SQ mixer — UDP OSC (port 51326) + TCP MIDI stub (port 51325).
 *
 * SQ mixers speak two protocols simultaneously:
 *   - TCP MIDI for everything operational (mute, fader, sends, scenes) using
 *     A&H's NRPN parameter table from the SQ MIDI Protocol Issue 5 spec.
 *   - UDP OSC for channel name + HPF reads, on /sq/* paths.
 *
 * This mock implements:
 *   - **OSC** (UDP, port 51326) — full mock. Handles /sq/alive (liveness probe)
 *     and /sq/ch/<n>/name (channel name read). OSC packet codec is hand-rolled
 *     because the church-client uses its own minimal OSC implementation in
 *     src/osc.js — keeping the mock dependency-free.
 *   - **TCP MIDI** (TCP, port 51325) — STUB. Accepts the connection, logs
 *     received bytes, and never sends anything back. The real NRPN MIDI
 *     dictionary is enormous and lives in `src/mixers/x32-osc-map.js` /
 *     `src/mixers/allenheath.js`; implementing it fully is out of scope for
 *     this PR. The stub is enough that the church-client can verify the
 *     "TCP socket reaches the mixer" code path without crashing.
 *
 * Tests can manipulate the mock via the control API:
 *   POST /action { action: "setChannelName", args: { channel, name } }
 *   POST /action { action: "midiAcceptingClients", args: { accepting: false } }
 *     → start refusing TCP MIDI connections to test reconnect logic
 */

'use strict';

const dgram = require('node:dgram');
const net = require('node:net');
const { createControlServer } = require('./_lib/control');

const DEFAULTS = {
  channelNames: {
    1: 'Lead Vox', 2: 'Choir', 3: 'Acoustic', 4: 'Electric',
    5: 'Bass', 6: 'Kick', 7: 'Snare', 8: 'OH L',
  },
  midiBytesReceived: 0,
  midiClientsConnected: 0,
  midiAcceptingClients: true,
  oscPacketsReceived: 0,
};

// ─── OSC codec (just enough for /sq/* paths the SQ adapter sends) ──────────

function pad4(buf) {
  // OSC requires 4-byte aligned length with at least one trailing null.
  const len = buf.length;
  const padding = 4 - (len % 4);
  return Buffer.concat([buf, Buffer.alloc(padding)]);
}

function encodeString(s) {
  return pad4(Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]));
}

function encodeOscMessage(address, args = []) {
  // Args supported: string (s), int32 (i). Sufficient for SQ name reads.
  const addressBuf = encodeString(address);
  const typeTags = ',' + args.map((a) => (typeof a === 'number' ? 'i' : 's')).join('');
  const tagsBuf = encodeString(typeTags);
  const argBufs = args.map((a) => {
    if (typeof a === 'number') {
      const b = Buffer.alloc(4);
      b.writeInt32BE(a, 0);
      return b;
    }
    return encodeString(String(a));
  });
  return Buffer.concat([addressBuf, tagsBuf, ...argBufs]);
}

function decodeOscMessage(buf) {
  // Returns { address, args } or null. Supports string, int32, float32 args.
  function readString(offset) {
    const end = buf.indexOf(0, offset);
    if (end === -1) return null;
    const s = buf.slice(offset, end).toString('utf8');
    const next = end + (4 - (end - offset) % 4);
    return { value: s, next };
  }
  const a = readString(0);
  if (!a) return null;
  const t = readString(a.next);
  if (!t || !t.value.startsWith(',')) return { address: a.value, args: [] };
  const tags = t.value.slice(1);
  let cursor = t.next;
  const args = [];
  for (const tag of tags) {
    if (tag === 's') {
      const s = readString(cursor);
      if (!s) break;
      args.push(s.value);
      cursor = s.next;
    } else if (tag === 'i') {
      args.push(buf.readInt32BE(cursor));
      cursor += 4;
    } else if (tag === 'f') {
      args.push(buf.readFloatBE(cursor));
      cursor += 4;
    } else {
      break;
    }
  }
  return { address: a.value, args };
}

async function start({ oscPort = 51326, midiPort = 51325, port, controlPort = 0 } = {}) {
  // The launcher passes a single `port` per mock — alias it to MIDI so SQ
  // composes cleanly with the rest of the registry. OSC stays on its
  // default unless the caller passes `oscPort` explicitly.
  if (port !== undefined && midiPort === 51325) midiPort = port;
  const state = JSON.parse(JSON.stringify(DEFAULTS));

  // ── UDP OSC server ─────────────────────────────────────────────────────────
  const oscSock = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    oscSock.once('error', reject);
    oscSock.bind(oscPort, '127.0.0.1', resolve);
  });
  const actualOscPort = oscSock.address().port;

  oscSock.on('message', (msg, rinfo) => {
    state.oscPacketsReceived += 1;
    const decoded = decodeOscMessage(msg);
    if (!decoded) return;

    // /sq/alive — respond with a heartbeat
    if (decoded.address === '/sq/alive') {
      oscSock.send(encodeOscMessage('/sq/alive', ['ok']), rinfo.port, rinfo.address);
      return;
    }
    // /sq/ch/N/name — return the channel name as a string arg
    const nameMatch = decoded.address.match(/^\/sq\/ch\/(\d+)\/name$/);
    if (nameMatch) {
      const chan = Number(nameMatch[1]);
      const name = state.channelNames[chan] || `Ch ${chan}`;
      oscSock.send(encodeOscMessage(`/sq/ch/${chan}/name`, [name]), rinfo.port, rinfo.address);
    }
  });

  // ── TCP MIDI stub server ──────────────────────────────────────────────────
  const midiServer = net.createServer((socket) => {
    if (!state.midiAcceptingClients) {
      socket.destroy();
      return;
    }
    state.midiClientsConnected += 1;
    socket.on('data', (buf) => { state.midiBytesReceived += buf.length; });
    socket.on('close', () => { state.midiClientsConnected = Math.max(0, state.midiClientsConnected - 1); });
    socket.on('error', () => { /* ignore client errors */ });
  });

  await new Promise((resolve, reject) => {
    midiServer.once('error', reject);
    midiServer.listen(midiPort, '127.0.0.1', resolve);
  });
  const actualMidiPort = midiServer.address().port;

  const control = await createControlServer({
    device: 'sq',
    port: controlPort,
    state,
    initialState: DEFAULTS,
    actions: {
      setChannelName: ({ channel, name }) => { state.channelNames[channel] = String(name); },
      midiAcceptingClients: ({ accepting }) => { state.midiAcceptingClients = !!accepting; },
    },
  });

  return {
    device: 'sq',
    port: actualMidiPort, // surface MIDI as the canonical port (matches A&H docs)
    oscPort: actualOscPort,
    midiPort: actualMidiPort,
    url: `tcp://127.0.0.1:${actualMidiPort}`,
    control,
    state,
    stop: async () => {
      await new Promise((r) => oscSock.close(() => r()));
      await new Promise((r) => midiServer.close(() => r()));
      await control.stop();
    },
  };
}

module.exports = { start };

if (require.main === module) {
  start({
    oscPort: Number(process.env.PORT_OSC) || 51326,
    midiPort: Number(process.env.PORT) || 51325,
    controlPort: Number(process.env.CONTROL_PORT) || 0,
  })
    .then((s) => console.log(`[mock-sq] midi=tcp://127.0.0.1:${s.midiPort}  osc=udp://127.0.0.1:${s.oscPort}  control=${s.control.url}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
