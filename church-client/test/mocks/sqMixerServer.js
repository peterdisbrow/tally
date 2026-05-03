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
 *   - **TCP MIDI** (TCP, port 51325) — partial NRPN parser. Accepts the
 *     connection, decodes the four-CC NRPN Data Entry frames the
 *     church-client emits (mute on/off, input fader level), and tracks
 *     the resulting state for tests to read. The full SQ NRPN dictionary
 *     is much larger than what we parse — anything we don't recognise is
 *     counted under `unknownNrpns` and discarded so the client doesn't
 *     hang waiting for an ACK.
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
  // Tracked NRPN state. Keys mirror the church-client's allenheath driver:
  //   mutes:  'input:<n>', 'lr:0', 'mix:<n>', 'dca:<n>'  → boolean
  //   faders: same key shape  → 14-bit integer (0..16383)
  mutes: {},
  faders: {},
  // Last NRPN frame parsed, useful for tests that assert "the agent sent
  // *some* command and we caught it." Each entry is { msb, lsb, vc, vf, ts }.
  nrpnLog: [],
  unknownNrpns: 0,
};

// SQ NRPN parameter base addresses (subset — covers what the e2e tests need).
// Keep in sync with church-client/src/mixers/allenheath.js MUTE / SEND_LEVEL.
const NRPN_BASES = [
  // Mutes
  { kind: 'mute', key: 'input',  base: (0x00 << 7) + 0x00, max: 48 },
  { kind: 'mute', key: 'group',  base: (0x00 << 7) + 0x30, max: 12 },
  { kind: 'mute', key: 'lr',     base: (0x00 << 7) + 0x44, max: 1  },
  { kind: 'mute', key: 'mix',    base: (0x00 << 7) + 0x45, max: 12 },
  { kind: 'mute', key: 'dca',    base: (0x02 << 7) + 0x00, max: 8  },
  // Input → LR fader (the only fader path used by mixer.setFader on SQ).
  { kind: 'fader', key: 'input', base: (0x40 << 7) + 0x00, max: 48 },
];

function decodeNrpn(nrpn14) {
  for (const entry of NRPN_BASES) {
    if (nrpn14 >= entry.base && nrpn14 < entry.base + entry.max) {
      const idx = nrpn14 - entry.base;
      return { kind: entry.kind, key: entry.key, idx };
    }
  }
  return null;
}

const NRPN_LOG_LIMIT = 50;

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

  // ── TCP MIDI server with NRPN parser ──────────────────────────────────────
  // The SQ driver always emits NRPN Data Entry frames using ControlChange CCs
  // 0x63 (NRPN MSB), 0x62 (NRPN LSB), 0x06 (Data MSB / vc), 0x26 (Data LSB / vf).
  // We track the most recent NRPN address per channel and apply Data Entry
  // bytes against it — that's all the church-client emits for set operations.
  function parseMidiBuffer(perSocket, buf) {
    for (const byte of buf) {
      // Status byte: top bit set. Latches the running status.
      if (byte & 0x80) {
        // Realtime / system bytes (>= 0xF8) don't reset running status — ignore.
        if (byte >= 0xF8) continue;
        perSocket.status = byte;
        perSocket.dataIdx = 0;
        perSocket.data = [];
        continue;
      }
      // Data byte. Need a status to make sense of it.
      if (perSocket.status == null) continue;
      perSocket.data.push(byte);

      const cmd = perSocket.status & 0xF0;
      // ControlChange messages take exactly 2 data bytes (CC#, value).
      if (cmd === 0xB0 && perSocket.data.length === 2) {
        const ccNum = perSocket.data[0];
        const ccVal = perSocket.data[1];
        perSocket.data = []; // ready for next two-byte payload (running status)
        applyCc(state, perSocket, ccNum, ccVal);
        continue;
      }
      // Note On/Off/aftertouch (rare here) — drop after 2 bytes.
      if ((cmd === 0x80 || cmd === 0x90 || cmd === 0xA0) && perSocket.data.length === 2) {
        perSocket.data = [];
        continue;
      }
      // Program Change / channel pressure — 1 data byte.
      if ((cmd === 0xC0 || cmd === 0xD0) && perSocket.data.length === 1) {
        perSocket.data = [];
        continue;
      }
    }
  }

  function applyCc(state, perSocket, ccNum, ccVal) {
    if (ccNum === 0x63) { perSocket.nrpnMsb = ccVal; perSocket.dataMsb = null; perSocket.dataLsb = null; return; }
    if (ccNum === 0x62) { perSocket.nrpnLsb = ccVal; return; }
    if (ccNum === 0x06) { perSocket.dataMsb = ccVal; return; }
    if (ccNum === 0x26) {
      perSocket.dataLsb = ccVal;
      // We have a complete NRPN Data Entry frame.
      if (perSocket.nrpnMsb == null || perSocket.nrpnLsb == null || perSocket.dataMsb == null) return;
      const nrpn14 = (perSocket.nrpnMsb << 7) + perSocket.nrpnLsb;
      const data14 = (perSocket.dataMsb << 7) + perSocket.dataLsb;
      const decoded = decodeNrpn(nrpn14);
      state.nrpnLog.push({ nrpn: nrpn14, data: data14, decoded, ts: Date.now() });
      while (state.nrpnLog.length > NRPN_LOG_LIMIT) state.nrpnLog.shift();
      if (!decoded) {
        state.unknownNrpns += 1;
        return;
      }
      const stateKey = `${decoded.key}:${decoded.idx}`;
      if (decoded.kind === 'mute') {
        // SQ convention: data 1 = muted, 0 = unmuted.
        state.mutes[stateKey] = data14 === 1 || perSocket.dataLsb === 1;
      } else if (decoded.kind === 'fader') {
        state.faders[stateKey] = data14;
      }
    }
  }

  const midiServer = net.createServer((socket) => {
    if (!state.midiAcceptingClients) {
      socket.destroy();
      return;
    }
    state.midiClientsConnected += 1;
    const perSocket = { status: null, data: [], nrpnMsb: null, nrpnLsb: null, dataMsb: null, dataLsb: null };
    socket.on('data', (buf) => {
      state.midiBytesReceived += buf.length;
      parseMidiBuffer(perSocket, buf);
    });
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
