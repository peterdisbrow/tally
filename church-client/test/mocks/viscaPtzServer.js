/**
 * Stateful VISCA PTZ camera mock — TCP (PTZOptics :5678), raw UDP (:1259) and
 * Sony VISCA-over-IP UDP (:52381). It behaves like a real camera and can say no:
 *
 *  - Replies: ACK `90 4y FF`, Completion `90 5y FF`, inquiry `90 50 .. FF`.
 *  - Errors:  `90 60 02 FF` syntax (bad length/range/unknown cmd),
 *             `90 60 03 FF` command buffer full (both sockets busy),
 *             `90 6y 41 FF` not executable (power standby / powering on).
 *  - Inquiries: CAM_PowerInq (81 09 04 00 FF), Pan-tiltPosInq (81 09 06 12 FF),
 *               CAM_ZoomPosInq (81 09 04 47 FF), CAM_VersionInq (81 09 00 02 FF).
 *  - State: power, pan/tilt/zoom position (integrates drive speed over time),
 *           presets (memorize stores the real position; recall moves there),
 *           focus/WB modes, busy sockets.
 *  - Sony framing: 8-byte header (type, length, seq). 0x0100 command /
 *    0x0110 inquiry → 0x0111 reply echoing seq; 0x0200 control (reset seq)
 *    → 0x0201. Wrong type for the payload / stale seq → 0x0201 error
 *    (0F 02 message error / 0F 01 sequence error).
 *  - Unplug (setReachable false): existing TCP sockets are destroyed, new
 *    connections refused; UDP goes silent (no reply, like a dead camera).
 *
 * VISCA_MOCK_BREAK (or start({ breakMode })) mutation modes for red proofs:
 *   no-reply     accept connections/datagrams but never answer (port open, not VISCA)
 *   ack-only     ACK commands but never send Completion (inquiries still answered)
 *   always-ok    never return errors (accepts garbage, standby executes)
 *   no-drop      unplug keeps existing TCP sockets open (and keeps answering)
 *   power-lies   power inquiry always answers "on"
 *   wrong-seq    Sony replies carry a wrong sequence number
 */

'use strict';

const net = require('node:net');
const dgram = require('node:dgram');
const { createControlServer } = require('./_lib/control');

const PAN_MIN = -2448, PAN_MAX = 2448;    // 0xF670..0x0990 on PTZOptics
const TILT_MIN = -432, TILT_MAX = 1296;   // 0xFE50..0x0510
const ZOOM_MIN = 0, ZOOM_MAX = 0x4000;
const PAN_UNITS_PER_SEC_AT_MAX = 2000;
const TILT_UNITS_PER_SEC_AT_MAX = 1200;
const ZOOM_UNITS_PER_SEC_AT_MAX = 8000;

const DEFAULTS = {
  reachable: true,
  power: 'on',             // 'on' | 'standby'
  pan: 0, tilt: 0, zoom: 0,
  panSpeed: 0, tiltSpeed: 0, zoomSpeed: 0,   // normalised -1..1 (drive in progress)
  focusMode: 'auto',
  whiteBalance: 'auto',
  presets: {},             // { "n": { pan, tilt, zoom } }
  lastPreset: null,
  panTiltMoves: 0, zoomMoves: 0, presetRecalls: 0, presetStores: 0, homeCalls: 0,
  commandsOk: 0, commandsRejected: 0, inquiries: 0,
  errorsSent: { syntax: 0, bufferFull: 0, notExecutable: 0, sonyMessage: 0, sonySequence: 0 },
  framesReceived: 0, bytesReceived: 0,
  tcpConnections: 0, tcpOpen: 0, tcpDropped: 0,
  model: 0x0617, rom: 0x0203,
  log: [],
};
const LOG_LIMIT = 80;

async function start({
  port = 0, controlPort = 0, transport = 'tcp', host = '127.0.0.1',
  breakMode = process.env.VISCA_MOCK_BREAK || '',
  completionMs = 15, presetMoveMs = 120, powerOnMs = 300,
} = {}) {
  const state = JSON.parse(JSON.stringify(DEFAULTS));
  const brk = new Set(String(breakMode || '').split(',').map((s) => s.trim()).filter(Boolean));
  let lastTick = Date.now();
  let busySockets = 0;       // commands executing (max 2, like real cameras)
  let poweringUntil = 0;
  const log = (e) => { state.log.push({ t: Date.now(), ...e }); if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT); };

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  function integrate() {
    const now = Date.now();
    const dt = (now - lastTick) / 1000;
    lastTick = now;
    if (state.panSpeed) state.pan = Math.round(clamp(state.pan + state.panSpeed * PAN_UNITS_PER_SEC_AT_MAX * dt, PAN_MIN, PAN_MAX));
    if (state.tiltSpeed) state.tilt = Math.round(clamp(state.tilt + state.tiltSpeed * TILT_UNITS_PER_SEC_AT_MAX * dt, TILT_MIN, TILT_MAX));
    if (state.zoomSpeed) state.zoom = Math.round(clamp(state.zoom + state.zoomSpeed * ZOOM_UNITS_PER_SEC_AT_MAX * dt, ZOOM_MIN, ZOOM_MAX));
  }

  const ACK = (s) => Buffer.from([0x90, 0x40 | s, 0xff]);
  const DONE = (s) => Buffer.from([0x90, 0x50 | s, 0xff]);
  const ERR = (code, s = 0) => Buffer.from([0x90, 0x60 | s, code, 0xff]);
  const INQ = (bytes) => Buffer.from([0x90, 0x50, ...bytes, 0xff]);
  const nib4 = (v) => { const u = v & 0xffff; return [(u >> 12) & 0xf, (u >> 8) & 0xf, (u >> 4) & 0xf, u & 0xf]; };

  function isPoweringOn() { return poweringUntil && Date.now() < poweringUntil; }

  /**
   * Handle one VISCA frame. `reply(buf)` sends a VISCA reply message.
   * Returns nothing; replies are sent async as a real camera would.
   */
  function handleFrame(frame, reply, { expectInquiry } = {}) {
    state.framesReceived++;
    integrate();
    if (brk.has('no-reply')) { log({ kind: 'ignored', hex: frame.toString('hex') }); return; }
    const syntax = (why) => {
      log({ kind: 'error', why, hex: frame.toString('hex') });
      if (brk.has('always-ok')) { reply(ACK(1)); reply(DONE(1)); return; }
      state.errorsSent.syntax++; state.commandsRejected++;
      reply(ERR(0x02));
    };
    if (frame.length < 3 || frame[frame.length - 1] !== 0xff) return syntax('unterminated');
    const addr = frame[0];
    if (addr === 0x88) {
      // Broadcast: IF_Clear (88 01 00 01 FF) / AddressSet (88 30 01 FF)
      if (frame[1] === 0x01 && frame[2] === 0x00 && frame[3] === 0x01) { reply(Buffer.from([0x88, 0x01, 0x00, 0x01, 0xff])); return; }
      if (frame[1] === 0x30) { reply(Buffer.from([0x88, 0x30, 0x02, 0xff])); return; }
      return syntax('unknown broadcast');
    }
    if (addr !== 0x81) return syntax(`address 0x${addr.toString(16)} (camera is 1)`);
    const kind = frame[1];

    // ── Inquiries ──
    if (kind === 0x09) {
      state.inquiries++;
      const f = frame.toString('hex');
      if (f === '81090400ff') { log({ kind: 'inq', what: 'power' }); reply(INQ([(state.power === 'on' || brk.has('power-lies')) && !isPoweringOn() ? 0x02 : 0x03])); return; }
      if (f === '81090612ff') { log({ kind: 'inq', what: 'pantilt' }); reply(INQ([...nib4(state.pan), ...nib4(state.tilt)])); return; }
      if (f === '81090447ff') { log({ kind: 'inq', what: 'zoom' }); reply(INQ(nib4(state.zoom))); return; }
      if (f === '81090002ff') {
        log({ kind: 'inq', what: 'version' });
        reply(INQ([0x00, 0x01, (state.model >> 8) & 0xff, state.model & 0xff, (state.rom >> 8) & 0xff, state.rom & 0xff, 0x02]));
        return;
      }
      return syntax('unknown inquiry');
    }
    if (kind !== 0x01) return syntax('not a command/inquiry');
    if (expectInquiry) { /* sony type mismatch handled by caller */ }

    // ── Commands ──
    const f = [...frame];
    let exec = null;        // () => void, applied on completion
    let durationMs = completionMs;
    let needsPower = true;
    let label = '';
    if (f[2] === 0x04 && f[3] === 0x00 && frame.length === 6) {            // CAM_Power
      if (f[4] !== 0x02 && f[4] !== 0x03) return syntax('power arg');
      needsPower = false; label = f[4] === 0x02 ? 'power-on' : 'power-standby';
      exec = () => {
        if (f[4] === 0x02 && state.power !== 'on') { state.power = 'on'; poweringUntil = Date.now() + powerOnMs; }
        if (f[4] === 0x03) { state.power = 'standby'; state.panSpeed = state.tiltSpeed = state.zoomSpeed = 0; }
      };
    } else if (f[2] === 0x06 && f[3] === 0x01 && frame.length === 9) {     // Pan-tiltDrive
      const [ps, ts, pd, td] = [f[4], f[5], f[6], f[7]];
      if (ps < 0x01 || ps > 0x18 || ts < 0x01 || ts > 0x14) return syntax('pan/tilt speed out of range');
      if (![1, 2, 3].includes(pd) || ![1, 2, 3].includes(td)) return syntax('pan/tilt direction');
      label = 'pantilt';
      exec = () => {
        state.panSpeed = pd === 3 ? 0 : (pd === 2 ? 1 : -1) * ps / 0x18;
        state.tiltSpeed = td === 3 ? 0 : (td === 1 ? 1 : -1) * ts / 0x14;
        state.panTiltMoves++;
      };
    } else if (f[2] === 0x06 && f[3] === 0x04 && frame.length === 5) {     // Home
      label = 'home'; durationMs = presetMoveMs;
      exec = () => { state.pan = 0; state.tilt = 0; state.panSpeed = state.tiltSpeed = 0; state.homeCalls++; };
    } else if (f[2] === 0x04 && f[3] === 0x07 && frame.length === 6) {     // CAM_Zoom
      const c = f[4];
      const ok = c === 0x00 || c === 0x02 || c === 0x03 || (c >= 0x20 && c <= 0x27) || (c >= 0x30 && c <= 0x37);
      if (!ok) return syntax('zoom arg');
      label = 'zoom';
      exec = () => {
        const sp = (c & 0x0f) / 7 || 0.5;
        state.zoomSpeed = c === 0x00 ? 0 : (c === 0x02 || (c & 0xf0) === 0x20) ? sp : -sp;
        state.zoomMoves++;
      };
    } else if (f[2] === 0x04 && f[3] === 0x3f && frame.length === 7) {     // CAM_Memory
      const [op, n] = [f[4], f[5]];
      if (![0, 1, 2].includes(op) || n > 0x7f) return syntax('memory arg');
      label = ['preset-reset', 'preset-set', 'preset-recall'][op];
      if (op === 2) durationMs = presetMoveMs;
      exec = () => {
        if (op === 0) delete state.presets[n];
        if (op === 1) { state.presets[n] = { pan: state.pan, tilt: state.tilt, zoom: state.zoom }; state.presetStores++; }
        if (op === 2) {
          const p = state.presets[n];
          state.panSpeed = state.tiltSpeed = state.zoomSpeed = 0;
          if (p) { state.pan = p.pan; state.tilt = p.tilt; state.zoom = p.zoom; }
          state.lastPreset = n; state.presetRecalls++;
        }
      };
    } else if (f[2] === 0x04 && f[3] === 0x38 && frame.length === 6) {     // Focus mode
      if (![0x02, 0x03, 0x10].includes(f[4])) return syntax('focus mode');
      label = 'focus-mode'; exec = () => { state.focusMode = f[4] === 0x03 ? 'manual' : 'auto'; };
    } else if (f[2] === 0x04 && f[3] === 0x08 && frame.length === 6) {     // Focus drive
      const c = f[4];
      if (!(c === 0 || c === 2 || c === 3 || (c >= 0x20 && c <= 0x27) || (c >= 0x30 && c <= 0x37))) return syntax('focus arg');
      label = 'focus'; exec = () => {};
    } else if (f[2] === 0x04 && f[3] === 0x35 && frame.length === 6) {     // WB
      if (f[4] > 0x05) return syntax('wb arg');
      label = 'wb'; exec = () => { state.whiteBalance = ['auto', 'indoor', 'outdoor', 'onepush', 'atw', 'manual'][f[4]]; };
    } else if (f[2] === 0x04 && f[3] === 0x10 && frame.length === 6 && f[4] === 0x05) { // one-push trigger
      label = 'wb-trigger'; exec = () => {};
    } else if (f[2] === 0x04 && f[3] === 0x33 && frame.length === 6) {     // Backlight
      if (f[4] !== 0x02 && f[4] !== 0x03) return syntax('backlight arg');
      label = 'backlight'; exec = () => {};
    } else {
      return syntax('unknown command');
    }

    if (needsPower && !brk.has('always-ok') && (state.power !== 'on' || isPoweringOn())) {
      state.errorsSent.notExecutable++; state.commandsRejected++;
      log({ kind: 'rejected', label, why: state.power !== 'on' ? 'standby' : 'powering-on' });
      reply(ERR(0x41, 1));
      return;
    }
    if (busySockets >= 2 && !brk.has('always-ok')) {
      state.errorsSent.bufferFull++; state.commandsRejected++;
      log({ kind: 'rejected', label, why: 'buffer-full' });
      reply(ERR(0x03));
      return;
    }
    const sock = busySockets === 0 ? 1 : 2;
    busySockets++;
    log({ kind: 'cmd', label, hex: frame.toString('hex') });
    reply(ACK(sock));
    setTimeout(() => {
      busySockets = Math.max(0, busySockets - 1);
      integrate();
      exec();
      state.commandsOk++;
      if (!brk.has('ack-only')) reply(DONE(sock));
    }, durationMs);
  }

  // Split a byte stream into VISCA frames (terminated by 0xFF).
  function splitFrames(buf) {
    const frames = [];
    let start = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0xff) { frames.push(buf.subarray(start, i + 1)); start = i + 1; }
    return { frames, rest: buf.subarray(start) };
  }

  let server = null, udp = null, actualPort = port;
  const sockets = new Set();

  async function listenTcp(p) {
    server = net.createServer((socket) => {
      if (!state.reachable) { socket.destroy(); return; }
      state.tcpConnections++; state.tcpOpen++;
      sockets.add(socket);
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        if (!state.reachable && !brk.has('no-drop')) return;
        state.bytesReceived += chunk.length;
        buffer = Buffer.concat([buffer, chunk]);
        const { frames, rest } = splitFrames(buffer);
        buffer = Buffer.from(rest);
        for (const fr of frames) handleFrame(Buffer.from(fr), (b) => { if (!socket.destroyed) socket.write(b); });
      });
      socket.on('close', () => { sockets.delete(socket); state.tcpOpen = Math.max(0, state.tcpOpen - 1); });
      socket.on('error', () => {});
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(p, host, resolve); });
    actualPort = server.address().port;
  }

  async function listenUdp(p) {
    udp = dgram.createSocket('udp4');
    let expectedSeq = null;  // Sony: last seq accepted
    udp.on('message', (msg, rinfo) => {
      if (!state.reachable) return; // dead camera: silence
      state.bytesReceived += msg.length;
      const send = (b) => udp.send(b, rinfo.port, rinfo.address);
      if (transport !== 'sony') {
        const { frames } = splitFrames(msg);
        if (!frames.length) { state.errorsSent.syntax++; send(ERR(0x02)); return; }
        for (const fr of frames) handleFrame(Buffer.from(fr), send);
        return;
      }
      // Sony VISCA over IP
      if (msg.length < 8) return;
      const type = msg.readUInt16BE(0);
      const len = msg.readUInt16BE(2);
      const seq = msg.readUInt32BE(4);
      const payload = msg.subarray(8);
      const header = (t, s, l) => { const h = Buffer.alloc(8); h.writeUInt16BE(t, 0); h.writeUInt16BE(l, 2); h.writeUInt32BE(s >>> 0, 4); return h; };
      const replySeq = (s) => (brk.has('wrong-seq') ? (s + 1000) : s);
      const ctlErr = (code) => { send(Buffer.concat([header(0x0201, replySeq(seq), 2), Buffer.from([0x0f, code])])); };
      if (brk.has('no-reply')) return;
      if (len !== payload.length) { state.errorsSent.sonyMessage++; ctlErr(0x02); return; }
      if (type === 0x0200) {                    // control command: reset sequence
        if (payload.length === 1 && payload[0] === 0x01) {
          expectedSeq = null;
          log({ kind: 'sony-reset-seq' });
          send(Buffer.concat([header(0x0201, replySeq(seq), 1), Buffer.from([0x01])]));
        } else { state.errorsSent.sonyMessage++; ctlErr(0x02); }
        return;
      }
      if (type !== 0x0100 && type !== 0x0110) { state.errorsSent.sonyMessage++; ctlErr(0x02); return; }
      const isInq = payload[1] === 0x09;
      if ((type === 0x0110) !== isInq && !brk.has('always-ok')) {
        state.errorsSent.sonyMessage++;
        log({ kind: 'sony-type-mismatch', type: type.toString(16), hex: payload.toString('hex') });
        ctlErr(0x02);
        return;
      }
      if (expectedSeq !== null && seq <= expectedSeq && !brk.has('always-ok')) {
        state.errorsSent.sonySequence++;
        log({ kind: 'sony-seq-error', seq, expectedAbove: expectedSeq });
        ctlErr(0x01);
        return;
      }
      expectedSeq = seq;
      handleFrame(Buffer.from(payload), (b) => send(Buffer.concat([header(0x0111, replySeq(seq), b.length), b])));
    });
    await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(p, host, resolve); });
    actualPort = udp.address().port;
  }

  if (transport === 'tcp') await listenTcp(port); else await listenUdp(port);

  async function setReachable(reachable) {
    const was = state.reachable;
    state.reachable = !!reachable;
    if (transport !== 'tcp' || was === state.reachable) return;
    if (!state.reachable) {
      if (!brk.has('no-drop')) {
        for (const s of sockets) { state.tcpDropped++; s.destroy(); }
        // Stop listening so new connections are refused (unplugged cable).
        await new Promise((r) => server.close(() => r()));
      }
    } else if (!server.listening) {
      await listenTcp(actualPort);
    }
  }

  const control = await createControlServer({
    device: 'visca-ptz',
    port: controlPort,
    state,
    initialState: DEFAULTS,
    actions: {
      setReachable: ({ reachable }) => setReachable(reachable),
      unplug: () => setReachable(false),
      plug: () => setReachable(true),
      setPower: ({ power }) => { state.power = power === 'standby' ? 'standby' : 'on'; },
      setPosition: ({ pan, tilt, zoom }) => {
        if (pan !== undefined) state.pan = Number(pan);
        if (tilt !== undefined) state.tilt = Number(tilt);
        if (zoom !== undefined) state.zoom = Number(zoom);
      },
      clearLog: () => { state.log = []; },
    },
  });

  return {
    device: 'visca-ptz',
    transport,
    get port() { return actualPort; },
    url: `${transport}://${host}:${actualPort}`,
    control,
    state,
    setReachable,
    stop: async () => {
      for (const s of sockets) s.destroy();
      if (server && server.listening) await new Promise((r) => server.close(() => r()));
      if (udp) await new Promise((r) => { try { udp.close(r); } catch { r(); } });
      await control.stop();
    },
  };
}

module.exports = { start, DEFAULTS };

if (require.main === module) {
  const transport = process.env.VISCA_TRANSPORT || 'tcp';
  const def = transport === 'sony' ? 52381 : transport === 'udp' ? 1259 : 5678;
  start({ port: Number(process.env.PORT) || def, controlPort: Number(process.env.CONTROL_PORT) || 0, transport })
    .then((s) => console.log(`[mock-visca-ptz] device=${s.url}  control=${s.control.url}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
