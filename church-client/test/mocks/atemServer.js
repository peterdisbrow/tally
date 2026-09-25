/**
 * Mock ATEM switcher — the REAL Blackmagic UDP control protocol (port 9910),
 * stateful, and able to say no the way a real ATEM does.
 *
 * Wire protocol (as atem-connection 3.9 / BMD firmware 8.x–9.x speak it):
 *   - 12-byte header: word0 = (flags << 11) | length, session id, ack id,
 *     packet id at byte 10. Flags: AckRequest 1, NewSessionId 2, AckReply 16.
 *   - Client hello (NewSessionId) → reply with a new session id, then the
 *     initial state dump (_ver, _pin, _top, InPr…, PrgI/PrvI, TrPs, RTMS,
 *     StRS, InCm = "init complete"; atem-connection emits 'connected' on InCm).
 *   - Server packet ids are sequential per session (the client drops
 *     out-of-order ids); every client AckRequest packet is acked.
 *   - A keepalive (empty AckRequest) every second; atem-connection declares
 *     the switcher gone after 5 s of silence.
 *
 * How a real ATEM says no (and so does this mock):
 *   - The ATEM never sends an error. A command for a source the model doesn't
 *     have (e.g. Media Player 2 or Super Source on an ATEM Mini Pro) is ACKED
 *     and IGNORED: program/preview stay as they were. Only a read-back of the
 *     state can tell.
 *   - Record start with no USB disk: acked, nothing happens, RTMS keeps
 *     reporting Idle + NoMedia.
 *   - Stream start with no/invalid stream key: Connecting, then back to Idle.
 *   - Unplugged: `setReachable(false)` = cable pulled (packets vanish in both
 *     directions). `crash()` = power off (socket closed, sessions forgotten;
 *     after `restart()` old sessions are unknown and the client must re-hello).
 *
 * Break modes (ATEM_MOCK_BREAK or opts.breakMode) make the mock sloppy one way
 * at a time so tests can prove they notice:
 *   ack-no-apply       acks every command, never changes anything
 *   accept-any-source  applies sources the model doesn't have
 *   no-state-push      applies changes but never tells the client
 *   no-init-complete   never sends InCm (client never becomes 'connected')
 */
'use strict';

const dgram = require('node:dgram');
const { createControlServer } = require('./_lib/control');

const FLAG = { AckRequest: 1, NewSessionId: 2, IsRetransmit: 4, RetransmitRequest: 8, AckReply: 16 };
const PROTOCOL_V8_1_1 = 0x0002001e;
const MODEL_MINI_PRO = 14;

function cmd(rawName, payload = Buffer.alloc(0)) {
  const out = Buffer.alloc(payload.length + 8);
  out.writeUInt16BE(payload.length + 8, 0);
  out.write(rawName, 4, 4, 'ascii');
  payload.copy(out, 8);
  return out;
}

function isHello(packet) {
  return packet.length >= 12 && ((packet.readUInt8(0) >> 3) & FLAG.NewSessionId) !== 0;
}

async function start({
  host = '127.0.0.1', port = 9910, controlPort = 0,
  inputs = 4, mediaPlayers = 1, superSource = false,
  hasMedia = true, streamKeyValid = true,
  transitionMs = 1000,
  breakMode = process.env.ATEM_MOCK_BREAK || '',
} = {}) {
  const BREAK = String(breakMode || '');
  const labels = {};
  for (let i = 1; i <= inputs; i++) labels[i] = { longName: `Camera ${i}`, shortName: `CAM${i}`, ext: 1, internal: 0 };
  // Internal sources the model really has.
  const internal = { 0: ['Black', 'BLK', 1], 1000: ['Color Bars', 'BARS', 2], 2001: ['Color 1', 'COL1', 3], 2002: ['Color 2', 'COL2', 3] };
  for (let m = 1; m <= mediaPlayers; m++) {
    internal[3000 + m * 10] = [`Media Player ${m}`, `MP${m}`, 4];
    internal[3001 + m * 10] = [`Media Player ${m} Key`, `MP${m}K`, 5];
  }
  if (superSource) internal[6000] = ['Super Source', 'SSRC', 6];
  internal[10010] = ['Program', 'PGM', 128];
  internal[10011] = ['Preview', 'PVW', 129];
  const validSources = new Set([...Object.keys(labels), ...Object.keys(internal)].map(Number));

  const state = {
    programInput: 1, previewInput: 2, inTransition: false,
    recording: 'Idle', hasMedia, streaming: 'Idle', streamKeyValid,
    reachable: true, running: true, sessions: 0, helloCount: 0,
    commandsReceived: [], ignored: [],
  };
  const sessions = new Map(); // key → session
  let sock = null;
  let nextSessionId = 0x8001;

  function header(flags, s, packetId, payloadLen, ackId = 0) {
    const out = Buffer.alloc(12 + payloadLen, 0);
    out.writeUInt16BE(((flags & 0x1f) << 11) | (12 + payloadLen), 0);
    out.writeUInt16BE(s.sessionId & 0xffff, 2);
    if (flags & FLAG.AckReply) out.writeUInt16BE(ackId & 0x7fff, 4);
    out.writeUInt16BE(packetId & 0x7fff, 10);
    return out;
  }
  function sendRaw(s, buf) {
    if (!state.reachable || !sock) return;
    try { sock.send(buf, 0, buf.length, s.port, s.address); } catch { /* socket closed */ }
  }
  function sendState(s, payload) {
    const id = s.nextPacketId; s.nextPacketId = (s.nextPacketId + 1) % 0x8000;
    const buf = header(FLAG.AckRequest, s, id, payload.length);
    payload.copy(buf, 12);
    sendRaw(s, buf);
  }
  function broadcast(payload) {
    if (BREAK === 'no-state-push') return;
    for (const s of sessions.values()) sendState(s, payload);
  }

  const u16 = (a, b, c) => { const p = Buffer.alloc(4); p.writeUInt8(a, 0); p.writeUInt16BE(b, 2); return p; };
  const prgi = () => cmd('PrgI', u16(0, state.programInput));
  const prvi = () => { const p = Buffer.alloc(8); p.writeUInt16BE(state.previewInput, 2); return cmd('PrvI', p); };
  const trps = (remaining = 0, pos = 0) => { const p = Buffer.alloc(8); p.writeUInt8(0, 0); p.writeUInt8(state.inTransition ? 1 : 0, 1); p.writeUInt8(remaining, 2); p.writeUInt16BE(pos, 4); return cmd('TrPs', p); };
  const rtms = () => {
    const p = Buffer.alloc(8);
    const err = state.hasMedia ? 2 : 0; // None=2, NoMedia=0
    p.writeUInt16BE((state.recording === 'Recording' ? 1 : 0) | err, 0);
    p.writeUInt32BE(state.hasMedia ? 3 * 3600 : 0, 4);
    return cmd('RTMS', p);
  };
  const strs = () => {
    const code = { Idle: 1, Connecting: 2, Streaming: 4, Stopping: 32 }[state.streaming] || 1;
    const p = Buffer.alloc(4); p.writeUInt16BE(code, 0); return cmd('StRS', p);
  };
  function inpr(id, longName, shortName, ext, internalType) {
    const p = Buffer.alloc(36, 0);
    p.writeUInt16BE(id, 0);
    p.write(longName, 2, 20, 'utf8');
    p.write(shortName, 22, 4, 'utf8');
    p.writeUInt8(1, 26);
    p.writeUInt16BE(ext ? 1 : 0, 28);
    p.writeUInt16BE(ext ? 1 : 0, 30);
    p.writeUInt8(internalType, 32);
    p.writeUInt8(0x03, 34);
    p.writeUInt8(0x01, 35);
    return cmd('InPr', p);
  }
  function initDump() {
    const ver = Buffer.alloc(4); ver.writeUInt32BE(PROTOCOL_V8_1_1, 0);
    const pin = Buffer.alloc(44, 0); pin.write('ATEM Mini Pro', 0, 40, 'utf8'); pin.writeUInt8(MODEL_MINI_PRO, 40);
    const top = Buffer.alloc(24, 0);
    top.writeUInt8(1, 0); top.writeUInt8(validSources.size, 1); top.writeUInt8(1, 2); top.writeUInt8(1, 3);
    top.writeUInt8(mediaPlayers, 5); top.writeUInt8(1, 6); top.writeUInt8(superSource ? 1 : 0, 11);
    const rmsu = Buffer.alloc(140, 0); rmsu.write('Tally Mock', 0, 128, 'utf8');
    const srsu = Buffer.alloc(1100, 0); srsu.write('YouTube', 0, 64, 'utf8'); srsu.write('rtmp://a.rtmp.youtube.com/live2', 64, 512, 'utf8');
    if (streamKeyValid) srsu.write('mock-key', 576, 512, 'utf8');
    const parts = [cmd('_ver', ver), cmd('_pin', pin), cmd('_top', top), cmd('RMSu', rmsu), cmd('SRSU', srsu)];
    for (const [id, l] of Object.entries(labels)) parts.push(inpr(Number(id), l.longName, l.shortName, l.ext, l.internal));
    for (const [id, [ln, sn, it]] of Object.entries(internal)) parts.push(inpr(Number(id), ln, sn, 0, it));
    parts.push(prgi(), prvi(), trps(), rtms(), strs());
    return parts;
  }

  function apply(name, body) {
    state.commandsReceived.push(name);
    if (BREAK === 'ack-no-apply') { state.ignored.push(name); return; }
    const okSource = (src) => BREAK === 'accept-any-source' || validSources.has(src);
    switch (name) {
      case 'CPgI': {
        const src = body.readUInt16BE(2);
        if (body.readUInt8(0) !== 0 || !okSource(src)) { state.ignored.push(`CPgI:${src}`); return; }
        state.programInput = src; broadcast(prgi()); return;
      }
      case 'CPvI': {
        const src = body.readUInt16BE(2);
        if (body.readUInt8(0) !== 0 || !okSource(src)) { state.ignored.push(`CPvI:${src}`); return; }
        state.previewInput = src; broadcast(prvi()); return;
      }
      case 'DCut': {
        if (body.readUInt8(0) !== 0 || state.inTransition) { state.ignored.push('DCut'); return; }
        [state.programInput, state.previewInput] = [state.previewInput, state.programInput];
        broadcast(Buffer.concat([prgi(), prvi()])); return;
      }
      case 'DAut': {
        if (body.readUInt8(0) !== 0 || state.inTransition) { state.ignored.push('DAut'); return; }
        state.inTransition = true; broadcast(trps(25, 1));
        setTimeout(() => {
          state.inTransition = false;
          [state.programInput, state.previewInput] = [state.previewInput, state.programInput];
          broadcast(Buffer.concat([prgi(), prvi(), trps()]));
        }, transitionMs);
        return;
      }
      case 'RcTM': {
        const want = body.readUInt8(0) === 1;
        if (want && !state.hasMedia) { state.ignored.push('RcTM:no-media'); broadcast(rtms()); return; }
        state.recording = want ? 'Recording' : 'Idle'; broadcast(rtms()); return;
      }
      case 'StrR': {
        const want = body.readUInt8(0) === 1;
        if (want) {
          if (state.streaming === 'Streaming') return;
          state.streaming = 'Connecting'; broadcast(strs());
          setTimeout(() => {
            state.streaming = state.streamKeyValid ? 'Streaming' : 'Idle';
            if (!state.streamKeyValid) state.ignored.push('StrR:rejected-by-service');
            broadcast(strs());
          }, 300);
        } else {
          if (state.streaming === 'Idle') return;
          state.streaming = 'Stopping'; broadcast(strs());
          setTimeout(() => { state.streaming = 'Idle'; broadcast(strs()); }, 200);
        }
        return;
      }
      default:
        state.ignored.push(name); // not modelled → ignored, like an unsupported command on a real ATEM
    }
  }

  function onMessage(packet, rinfo) {
    if (!state.reachable) return; // cable pulled: packets vanish
    if (packet.length < 12 || (packet.readUInt16BE(0) & 0x07ff) !== packet.length) return;
    const flags = packet.readUInt8(0) >> 3;
    const key = `${rinfo.address}:${rinfo.port}`;
    if (isHello(packet)) {
      const old = sessions.get(key);
      if (old) clearInterval(old.keepalive);
      const s = { address: rinfo.address, port: rinfo.port, sessionId: nextSessionId, nextPacketId: 1, keepalive: null, lastSeen: Date.now() };
      nextSessionId = nextSessionId >= 0xfff0 ? 0x8001 : nextSessionId + 1;
      sessions.set(key, s); state.helloCount++; state.sessions = sessions.size;
      sendRaw(s, header(FLAG.NewSessionId, s, 0, 0));
      setTimeout(() => {
        if (sessions.get(key) !== s) return;
        const parts = initDump();
        // Split the dump over a few packets, like a real ATEM does.
        for (let i = 0; i < parts.length; i += 6) sendState(s, Buffer.concat(parts.slice(i, i + 6)));
        if (BREAK !== 'no-init-complete') sendState(s, cmd('InCm', Buffer.alloc(4)));
      }, 20);
      s.keepalive = setInterval(() => {
        if (Date.now() - s.lastSeen > 6000) { clearInterval(s.keepalive); sessions.delete(key); state.sessions = sessions.size; return; }
        sendState(s, Buffer.alloc(0));
      }, 1000);
      return;
    }
    const s = sessions.get(key);
    if (!s || packet.readUInt16BE(2) !== s.sessionId) return; // unknown session (e.g. after a reboot)
    s.lastSeen = Date.now();
    if (flags & FLAG.AckRequest) {
      sendRaw(s, header(FLAG.AckReply, s, 0, 0, packet.readUInt16BE(10)));
      let off = 12;
      while (off + 8 <= packet.length) {
        const len = packet.readUInt16BE(off);
        if (len < 8 || off + len > packet.length) break;
        apply(packet.toString('ascii', off + 4, off + 8), packet.subarray(off + 8, off + len));
        off += len;
      }
    }
  }

  async function bind() {
    sock = dgram.createSocket('udp4');
    sock.on('message', onMessage);
    sock.on('error', () => { /* ignore */ });
    await new Promise((res, rej) => { sock.once('error', rej); sock.bind(port, host, () => { sock.removeListener('error', rej); res(); }); });
    state.running = true;
  }
  function dropSessions() { for (const s of sessions.values()) clearInterval(s.keepalive); sessions.clear(); state.sessions = 0; }
  async function crash() {
    dropSessions();
    if (sock) { const s = sock; sock = null; await new Promise((r) => { try { s.close(r); } catch { r(); } }); }
    state.running = false;
  }
  async function restart() { if (!sock) await bind(); }
  function setReachable(v) { state.reachable = !!v; }

  await bind();
  const actualPort = sock.address().port;
  const control = await createControlServer({
    device: 'atem', port: controlPort, state, initialState: state,
    actions: {
      setReachable: ({ reachable }) => setReachable(reachable),
      crash: () => crash(), restart: () => restart(),
      setProgram: ({ input }) => { state.programInput = Number(input); broadcast(prgi()); },
      setPreview: ({ input }) => { state.previewInput = Number(input); broadcast(prvi()); },
      setMedia: ({ present }) => { state.hasMedia = !!present; broadcast(rtms()); },
    },
  });

  return {
    device: 'atem', host, port: actualPort, url: `udp://${host}:${actualPort}`, control, state, validSources,
    setReachable, crash, restart,
    /** Operator presses a button on the ATEM panel. */
    operatorProgram(input) { state.programInput = input; broadcast(prgi()); },
    operatorPreview(input) { state.previewInput = input; broadcast(prvi()); },
    setMedia(present) { state.hasMedia = !!present; broadcast(rtms()); },
    stop: async () => { await crash(); await control.stop(); },
  };
}

module.exports = { start };

if (require.main === module) {
  start({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT) || 9910, controlPort: Number(process.env.CONTROL_PORT) || 0 })
    .then((s) => console.log(`[mock-atem] device=${s.url} control=${s.control.url}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
