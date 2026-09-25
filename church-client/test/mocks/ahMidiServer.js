/**
 * Stateful Allen & Heath dLive / Avantis mock — MIDI over TCP (default port 51325).
 *
 * Behaviour follows the A&H protocol documents:
 *   dLive  MIDI Over TCP/IP Protocol, firmware V2.0
 *   Avantis TCP/IP Protocol, firmware V1.10 (unchanged in the V2.0 web edition)
 *
 *   - Five consecutive MIDI channels from the base N (1–12, default 12):
 *       N inputs · N+1 groups · N+2 aux · N+3 matrix ·
 *       N+4 FX sends/returns, Mains, DCAs, Mute Groups (dLive also UFX)
 *   - Mute: Note On vel 40–7F = ON, 01–3F = OFF; velocity 00 and Note Off are IGNORED.
 *     A remote mute is applied SILENTLY (no echo to the sender).
 *   - Fader: NRPN  BN 63 CH  BN 62 17  BN 06 LV  (LV 6B = 0 dB, 7F = +10 dB). Silent.
 *   - HPF on/off NRPN 31, HPF freq NRPN 30 — dLive ONLY (Avantis has no HPF over MIDI).
 *   - NRPN 18 = Channel → Main Mix assign (NOT pan — neither console has pan over MIDI).
 *   - Get (dLive ONLY):  SysEx 0N 05 09 CH → Note On reply (+ Note Off)
 *                        SysEx 0N 05 0B pp CH → NRPN reply for parameter pp (17/30/31)
 *     Avantis has NO mute/level get; it ignores these.
 *   - Name get/set (0N 01 / 0N 03, reply 0N 02), colour get/set (04 / 06, reply 05) —
 *     both consoles. Names are max 8 chars.
 *   - Scene recall BN 00 bank, CN SS on the base channel. Blank scenes are ignored.
 *     dLive Surface port (surface:true) ignores scene recall ("MixRack only").
 *   - Messages outside the console's channel range / tables are ignored.
 *   - Console-surface changes (surfaceSet) are transmitted to every client.
 *
 * It says no: wrong base MIDI channel is ignored, velocity 00 is ignored, blank
 * scenes don't recall, unplugged (setReachable false) keeps a silent half-open
 * socket, dropClients closes sockets, midiAcceptingClients:false refuses TCP.
 *
 * Mutation modes (AH_MOCK_BREAK or start({ breakMode })):
 *   drop-sets    answers gets/name requests but ignores every SET
 *   no-reply     receives everything, answers nothing
 *   stale        applies SETs but gets keep answering the power-on value
 *   no-scene     ignores scene recalls
 */
'use strict';

const net = require('node:net');
const { createControlServer } = require('./_lib/control');

const HDR = [0xF0, 0x00, 0x00, 0x1A, 0x50, 0x10, 0x01, 0x00];
const LV_0DB = 0x6B;

const MODELS = {
  dlive: {
    name: 'dLive', inputs: 128, monoGroups: 62, monoAux: 62, monoMatrix: 62, stereo: 31,
    fxSends: 16, fxReturns: 16, mains: 6, dcas: 24, muteGroups: 8,
    fxRetBase: 0x20, mainBase: 0x30, dcaBase: 0x36, mgBase: 0x4E, hasGet: true, hasHpf: true,
  },
  avantis: {
    name: 'Avantis', inputs: 64, monoGroups: 40, monoAux: 40, monoMatrix: 40, stereo: 20,
    fxSends: 12, fxReturns: 12, mains: 3, dcas: 16, muteGroups: 8,
    fxRetBase: 0x20, mainBase: 0x30, dcaBase: 0x36, mgBase: 0x46, hasGet: false, hasHpf: false,
  },
};

function modelKey(m) { return /dlive/i.test(String(m || '')) ? 'dlive' : 'avantis'; }

/** (type offset, note) → friendly key, or null if not in the console's tables. */
function keyFor(M, off, note) {
  if (off === 0) return note < M.inputs ? `input:${note}` : null;
  const stereoOk = (n) => n >= 0x40 && n < 0x40 + M.stereo;
  if (off === 1) return note < M.monoGroups ? `group:${note}` : stereoOk(note) ? `stGroup:${note - 0x40}` : null;
  if (off === 2) return note < M.monoAux ? `aux:${note}` : stereoOk(note) ? `stAux:${note - 0x40}` : null;
  if (off === 3) return note < M.monoMatrix ? `matrix:${note}` : stereoOk(note) ? `stMatrix:${note - 0x40}` : null;
  if (off === 4) {
    if (note < M.fxSends) return `fxSend:${note}`;
    if (note >= 0x10 && note < 0x10 + M.fxSends) return `stFxSend:${note - 0x10}`;
    if (note >= M.fxRetBase && note < M.fxRetBase + M.fxReturns) return `fxReturn:${note - M.fxRetBase}`;
    if (note >= M.mainBase && note < M.mainBase + M.mains) return `main:${note - M.mainBase}`;
    if (note >= M.dcaBase && note < M.dcaBase + M.dcas) return `dca:${note - M.dcaBase}`;
    if (note >= M.mgBase && note < M.mgBase + M.muteGroups) return `muteGroup:${note - M.mgBase}`;
  }
  return null;
}
/** friendly key → [type offset, note] */
function addrFor(M, key) {
  const [type, idxS] = String(key).split(':');
  const i = Number(idxS);
  switch (type) {
    case 'input': return [0, i];
    case 'group': return [1, i];
    case 'aux': return [2, i];
    case 'matrix': return [3, i];
    case 'fxSend': return [4, i];
    case 'fxReturn': return [4, M.fxRetBase + i];
    case 'main': return [4, M.mainBase + i];
    case 'dca': return [4, M.dcaBase + i];
    case 'muteGroup': return [4, M.mgBase + i];
    default: throw new Error(`unknown key ${key}`);
  }
}

function freshState(mk) {
  const M = MODELS[mk];
  return {
    model: M.name,
    baseChannel: 0x0B,        // MIDI channel 12 (console default)
    mutes: {},                // 'input:0': true
    faders: {},               // 'input:0': LV (0–127)
    names: {},                // 'input:0': 'Pastor'
    colors: {},               // 'input:0': 0–7
    hpf: {},                  // 'input:0': { on: bool, vv: 0–127 }   (dLive)
    mainAssign: {},           // 'input:0': bool
    scenes: { 1: { name: 'Sunday', mutes: {}, faders: {} } },
    currentScene: null,
    midiBytesReceived: 0,
    midiClientsConnected: 0,
    midiAcceptingClients: true,
    reachable: true,
    sets: 0, gets: 0, ignored: 0, recalls: 0, refusedRecalls: 0,
    log: [],
  };
}

async function start(opts = {}) {
  let { port, midiPort, controlPort = 0 } = opts;
  midiPort = midiPort ?? port ?? 51325;
  const mk = modelKey(opts.model);
  const M = MODELS[mk];
  const breakMode = opts.breakMode || process.env.AH_MOCK_BREAK || '';
  const surface = !!opts.surface;
  const state = freshState(mk);
  if (opts.baseChannel != null) state.baseChannel = opts.baseChannel & 0x0F;
  const initial = JSON.parse(JSON.stringify(state));
  const powerOn = { mutes: {}, faders: {}, hpf: {} };
  const clients = new Set();

  const defFader = () => LV_0DB;
  const getMute = (k) => !!state.mutes[k];
  const getFader = (k) => (k in state.faders ? state.faders[k] : defFader());
  const getHpf = (k) => state.hpf[k] || { on: false, vv: 0x1D };
  const logIt = (e) => { state.log.push({ ...e, ts: Date.now() }); while (state.log.length > 200) state.log.shift(); };

  const offOf = (ch) => ((ch - state.baseChannel) + 16) % 16;
  const chOf = (off) => (state.baseChannel + off) & 0x0F;

  function muteMsg(off, note, on) {
    const s = 0x90 | chOf(off);
    return Buffer.from([s, note, on ? 0x7F : 0x3F, s, note, 0x00]);
  }
  function nrpnMsg(off, note, param, val) {
    const s = 0xB0 | chOf(off);
    return Buffer.from([s, 0x63, note, s, 0x62, param, s, 0x06, val & 0x7F]);
  }
  const sysex = (off, bytes) => Buffer.from([...HDR, chOf(off), ...bytes, 0xF7]);

  function applyMute(key, on) {
    if (breakMode === 'drop-sets') { state.ignored++; return; }
    if (breakMode === 'stale' && !(key in powerOn.mutes)) powerOn.mutes[key] = getMute(key);
    state.sets++;
    state.mutes[key] = on;
    logIt({ kind: 'mute', key, on });
  }
  function applyNrpn(key, param, val) {
    if (breakMode === 'drop-sets') { state.ignored++; return; }
    if (param === 0x17) {
      if (breakMode === 'stale' && !(key in powerOn.faders)) powerOn.faders[key] = getFader(key);
      state.faders[key] = val; state.sets++; logIt({ kind: 'fader', key, val }); return;
    }
    if (param === 0x18) { state.mainAssign[key] = val >= 0x40; state.sets++; logIt({ kind: 'mainAssign', key, val }); return; }
    if ((param === 0x31 || param === 0x30) && M.hasHpf && key.startsWith('input:')) {
      if (breakMode === 'stale' && !(key in powerOn.hpf)) powerOn.hpf[key] = { ...getHpf(key) };
      const h = { ...getHpf(key) };
      if (param === 0x31) h.on = val >= 0x40; else h.vv = val;
      state.hpf[key] = h; state.sets++; logIt({ kind: 'hpf', key, ...h }); return;
    }
    state.ignored++;
  }

  function reply(sock, buf) { if (breakMode === 'no-reply') { state.ignored++; return; } sock.write(buf); }

  function onSysEx(sock, bytes) {
    for (let i = 0; i < HDR.length; i++) if (bytes[i] !== HDR[i]) { state.ignored++; return; }
    const ch = bytes[8];
    const off = offOf(ch);
    if (off > 4) { state.ignored++; return; }
    const cmd = bytes[9];
    const body = bytes.slice(10, bytes.length - 1);
    if (cmd === 0x01 || cmd === 0x03 || cmd === 0x04 || cmd === 0x06) {
      const key = keyFor(M, off, body[0]);
      if (!key) { state.ignored++; return; }
      if (cmd === 0x01) { state.gets++; reply(sock, sysex(off, [0x02, body[0], ...Buffer.from(state.names[key] || '', 'ascii')])); return; }
      if (cmd === 0x03) {
        if (breakMode === 'drop-sets') { state.ignored++; return; }
        const name = Buffer.from(body.slice(1)).toString('ascii').slice(0, 8);
        state.names[key] = name; state.sets++; logIt({ kind: 'name', key, name }); return;
      }
      if (cmd === 0x04) { state.gets++; reply(sock, sysex(off, [0x05, body[0], state.colors[key] ?? 0])); return; }
      if (cmd === 0x06) {
        if (breakMode === 'drop-sets') { state.ignored++; return; }
        if (body[1] > 7) { state.ignored++; return; }
        state.colors[key] = body[1]; state.sets++; logIt({ kind: 'color', key, col: body[1] }); return;
      }
    }
    if (cmd === 0x05 && M.hasGet) {
      if (body[0] === 0x09) {
        const key = keyFor(M, off, body[1]);
        if (!key) { state.ignored++; return; }
        state.gets++;
        const v = breakMode === 'stale' && key in powerOn.mutes ? powerOn.mutes[key] : getMute(key);
        reply(sock, muteMsg(off, body[1], v)); return;
      }
      if (body[0] === 0x0B) {
        const param = body[1];
        const key = keyFor(M, off, body[2]);
        if (!key) { state.ignored++; return; }
        state.gets++;
        if (param === 0x17) {
          const v = breakMode === 'stale' && key in powerOn.faders ? powerOn.faders[key] : getFader(key);
          reply(sock, nrpnMsg(off, body[2], 0x17, v)); return;
        }
        if ((param === 0x31 || param === 0x30) && key.startsWith('input:')) {
          const h = breakMode === 'stale' && key in powerOn.hpf ? powerOn.hpf[key] : getHpf(key);
          reply(sock, nrpnMsg(off, body[2], param, param === 0x31 ? (h.on ? 0x7F : 0x00) : h.vv)); return;
        }
        state.ignored++; return;
      }
    }
    state.ignored++;
  }

  function recall(scene) {
    if (breakMode === 'no-scene' || surface) { state.ignored++; return; }
    const sc = state.scenes[scene];
    if (!sc) { state.refusedRecalls++; return; }
    state.recalls++;
    Object.assign(state.mutes, sc.mutes);
    Object.assign(state.faders, sc.faders);
    state.currentScene = scene;
  }

  function onMessage(sock, ps, msg) {
    const status = msg[0];
    const hi = status & 0xF0;
    const ch = status & 0x0F;
    const off = offOf(ch);
    if (off > 4) { state.ignored++; return; }
    if (hi === 0x90) {
      const [, note, vel] = msg;
      if (vel === 0) return;                               // ignored (also the trailing "note off")
      const key = keyFor(M, off, note);
      if (!key) { state.ignored++; return; }
      applyMute(key, vel >= 0x40);
      return;
    }
    if (hi === 0x80) return;                               // Note Off ignored
    if (hi === 0xB0) {
      const s = ps.nrpn[ch] || (ps.nrpn[ch] = {});
      const [, cc, val] = msg;
      if (cc === 0x63) { s.note = val; s.param = null; return; }
      if (cc === 0x62) { s.param = val; return; }
      if (cc === 0x06) {
        if (s.note == null || s.param == null) { state.ignored++; return; }
        const key = keyFor(M, off, s.note);
        if (!key) { state.ignored++; return; }
        applyNrpn(key, s.param, val);
        return;
      }
      if (cc === 0x00 && off === 0) { ps.bank = val; return; }
      state.ignored++;
      return;
    }
    if (hi === 0xC0) {
      if (off !== 0) { state.ignored++; return; }
      const bank = ps.bank || 0;
      if (bank > 3) { state.ignored++; return; }
      const scene = bank * 128 + msg[1] + 1;
      if (scene > 500) { state.ignored++; return; }
      recall(scene);
      return;
    }
    state.ignored++;
  }

  function feed(sock, ps, buf) {
    for (const b of buf) {
      if (b >= 0xF8) continue;
      if (ps.inSysEx) {
        ps.sx.push(b);
        if (b === 0xF7) { ps.inSysEx = false; onSysEx(sock, ps.sx); ps.sx = []; }
        continue;
      }
      if (b === 0xF0) { ps.inSysEx = true; ps.sx = [b]; continue; }
      if (b & 0x80) { ps.status = b; ps.data = []; continue; }
      if (ps.status == null) continue;
      ps.data.push(b);
      const hi = ps.status & 0xF0;
      const need = (hi === 0xC0 || hi === 0xD0) ? 1 : 2;
      if (ps.data.length === need) {
        const msg = [ps.status, ...ps.data];
        ps.data = [];
        onMessage(sock, ps, msg);
      }
    }
  }

  const server = net.createServer((sock) => {
    if (!state.midiAcceptingClients) { sock.destroy(); return; }
    clients.add(sock);
    state.midiClientsConnected += 1;
    const ps = { status: null, data: [], nrpn: {}, bank: 0, inSysEx: false, sx: [] };
    sock.on('data', (buf) => {
      state.midiBytesReceived += buf.length;
      if (!state.reachable) return;
      feed(sock, ps, buf);
    });
    sock.on('close', () => { clients.delete(sock); state.midiClientsConnected = Math.max(0, state.midiClientsConnected - 1); });
    sock.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(midiPort, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;

  const broadcast = (buf) => { if (!state.reachable) return; for (const c of clients) c.write(buf); };

  /** key like 'mute:main:0' / 'fader:input:3' / 'name:input:0' */
  function surfaceSet(key, value) {
    const [kind, ...rest] = String(key).split(':');
    const k = rest.join(':');
    const [off, note] = addrFor(M, k);
    if (kind === 'mute') { state.mutes[k] = !!Number(value); broadcast(muteMsg(off, note, !!Number(value))); return; }
    if (kind === 'fader') { state.faders[k] = Number(value); broadcast(nrpnMsg(off, note, 0x17, Number(value))); return; }
    if (kind === 'name') { state.names[k] = String(value).slice(0, 8); return; }
    throw new Error(`unknown surface key ${key}`);
  }

  const api = {
    get: (key) => {
      const [kind, ...rest] = String(key).split(':');
      const k = rest.join(':');
      addrFor(M, k); // validate
      if (kind === 'mute') return getMute(k);
      if (kind === 'fader') return getFader(k);
      if (kind === 'name') return state.names[k] || '';
      if (kind === 'color') return state.colors[k] ?? 0;
      if (kind === 'hpf') return getHpf(k);
      if (kind === 'mainAssign') return state.mainAssign[k] ?? true;
      throw new Error(`unknown key ${key}`);
    },
    surfaceSet,
    storeScene: (n, name = `Scene ${n}`, params = {}) => {
      const sc = { name, mutes: {}, faders: {} };
      for (const [key, v] of Object.entries(params)) {
        const [kind, ...rest] = key.split(':');
        if (kind === 'mute') sc.mutes[rest.join(':')] = !!v; else sc.faders[rest.join(':')] = v;
      }
      state.scenes[n] = sc;
    },
    setReachable: (r) => { state.reachable = !!r; },
    dropClients: () => { for (const c of clients) c.destroy(); },
    setBaseChannel: (c) => { state.baseChannel = c & 0x0F; },
  };

  const control = await createControlServer({
    device: mk, port: controlPort, state, initialState: initial,
    actions: {
      setAccepting: ({ accepting }) => { state.midiAcceptingClients = !!accepting; },
      setReachable: ({ reachable }) => api.setReachable(reachable),
      dropClients: () => api.dropClients(),
      surfaceSet: ({ key, value }) => api.surfaceSet(key, value),
      storeScene: ({ scene, name, params }) => api.storeScene(Number(scene), name, params || {}),
      setBaseChannel: ({ channel }) => api.setBaseChannel(Number(channel)),
      get: ({ key }) => ({ value: api.get(key) }),
    },
  });

  return {
    device: mk, model: M.name, port: actualPort, midiPort: actualPort,
    url: `tcp://127.0.0.1:${actualPort}`, breakMode, surface, control, state, ...api,
    stop: async () => {
      for (const c of clients) c.destroy();
      await new Promise((r) => server.close(() => r()));
      await control.stop();
    },
  };
}

module.exports = { start, LV_0DB, MODELS };

if (require.main === module) {
  start({ midiPort: Number(process.env.PORT) || 51325, controlPort: Number(process.env.CONTROL_PORT) || 0, model: process.env.AH_MODEL || 'dLive', surface: process.env.AH_SURFACE === '1' })
    .then((s) => console.log(`[mock-${s.device}] midi=tcp://127.0.0.1:${s.midiPort}  control=${s.control.url}${s.breakMode ? '  break=' + s.breakMode : ''}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
