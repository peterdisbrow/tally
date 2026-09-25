/**
 * Stateful Allen & Heath SQ-5/6/7 mock — MIDI over TCP (default port 51325).
 *
 * Behaviour follows the SQ MIDI Protocol, Issue 5 (firmware 1.5/1.6):
 *   - The SQ speaks NO OSC. Everything is NRPN / Program Change / Note over TCP.
 *   - SET  (BN 63 MB  BN 62 LB  BN 06 VC  BN 26 VF) → applied SILENTLY
 *     (the console does not echo a remote SET back to the sender).
 *   - GET  (BN 63 MB  BN 62 LB  BN 60 7F) → the console replies with the full
 *     4-CC value message for that parameter.
 *   - Mute toggle (BN 60 00 / BN 61 00 on a mute parameter) flips the mute.
 *   - Scene recall = BN 00 BK + CN PG. "Blank scenes cannot be recalled" —
 *     a recall of an empty scene is ignored. The console sends no reply.
 *   - SoftKeys = Note On 0x30+n / Note Off. No reply.
 *   - Messages on a MIDI channel other than the console's are ignored.
 *   - Parameters outside the SQ tables are ignored (no reply to a GET).
 *   - Changes made on the console surface (control action `surfaceSet`) are
 *     transmitted to every connected client as NRPN value messages.
 *
 * It says no: blank scenes don't recall, wrong MIDI channel is ignored, bogus
 * parameters don't answer, an unplugged console (setReachable false) keeps the
 * TCP socket but goes silent, `dropClients` closes sockets, and
 * `midiAcceptingClients:false` refuses new connections.
 *
 * Mutation modes (SQ_MOCK_BREAK or start({ breakMode })) make it sloppy ONE way:
 *   drop-sets    answers every GET but silently ignores SETs
 *   no-reply     receives everything, answers no GET
 *   stale        applies SETs but GET keeps answering the power-on value
 *   no-scene     ignores scene recalls
 */
'use strict';

const net = require('node:net');
const { createControlServer } = require('./_lib/control');

const N = (msb, lsb) => (msb << 7) + lsb;
const LEVEL_0DB = 15196;
const PAN_CENTER = 8191;

// Valid parameter ranges from the SQ Issue 5 reference tables.
const RANGES = [
  { kind: 'mute',   from: N(0x00, 0x00), to: N(0x00, 0x57) }, // inputs, groups, FX rtn, LR, aux, FX snd, mtx
  { kind: 'mute',   from: N(0x02, 0x00), to: N(0x02, 0x07) }, // DCA 1-8
  { kind: 'mute',   from: N(0x04, 0x00), to: N(0x04, 0x07) }, // mute groups 1-8
  { kind: 'level',  from: N(0x40, 0x00), to: N(0x4F, 0x27) }, // sends + master levels
  { kind: 'pan',    from: N(0x50, 0x00), to: N(0x5F, 0x13) },
  { kind: 'assign', from: N(0x60, 0x00), to: N(0x6F, 0x7F) },
];
function kindOf(nrpn) {
  for (const r of RANGES) if (nrpn >= r.from && nrpn <= r.to) return r.kind;
  return null;
}
function defaultValue(kind) {
  if (kind === 'level') return LEVEL_0DB;
  if (kind === 'pan') return PAN_CENTER;
  if (kind === 'assign') return 1;
  return 0;
}

// Friendly keys (mirrors church-client/src/mixers/allenheath.js)
function keyOf(nrpn) {
  if (nrpn >= 0 && nrpn < 48) return `mute:input:${nrpn}`;
  if (nrpn >= N(0, 0x30) && nrpn <= N(0, 0x3B)) return `mute:group:${nrpn - N(0, 0x30)}`;
  if (nrpn === N(0, 0x44)) return 'mute:lr:0';
  if (nrpn >= N(0, 0x45) && nrpn <= N(0, 0x50)) return `mute:mix:${nrpn - N(0, 0x45)}`;
  if (nrpn >= N(2, 0) && nrpn <= N(2, 7)) return `mute:dca:${nrpn - N(2, 0)}`;
  if (nrpn >= N(4, 0) && nrpn <= N(4, 7)) return `mute:muteGroup:${nrpn - N(4, 0)}`;
  if (nrpn >= N(0x40, 0) && nrpn < N(0x40, 0) + 48) return `level:inputToLr:${nrpn - N(0x40, 0)}`;
  if (nrpn === N(0x4F, 0)) return 'level:lr:0';
  if (nrpn >= N(0x4F, 0x20) && nrpn <= N(0x4F, 0x27)) return `level:dca:${nrpn - N(0x4F, 0x20)}`;
  return `nrpn:${nrpn}`;
}

function freshState(model) {
  return {
    model,
    midiChannel: 0,
    params: {},           // nrpn14 -> data14 (only ones that differ from default or were touched)
    scenes: { 1: { name: 'Sunday', params: {} } },  // scene -> { name, params }
    currentScene: null,
    softKeys: [],          // [{ key, on, ts }]
    midiBytesReceived: 0,
    midiClientsConnected: 0,
    midiAcceptingClients: true,
    reachable: true,
    // Friendly views of params for e2e readers: mutes { 'input:4': true, 'lr:0': false },
    // faders { 'input:0': 15196, 'lr:0': …, 'dca:2': … } (14-bit SQ linear-taper data).
    mutes: {},
    faders: {},
    sets: 0, gets: 0, ignored: 0, recalls: 0, refusedRecalls: 0,
    nrpnLog: [],
  };
}

async function start(opts = {}) {
  let { port, midiPort, controlPort = 0 } = opts;
  midiPort = midiPort ?? port ?? 51325;
  const breakMode = opts.breakMode || process.env.SQ_MOCK_BREAK || '';
  const state = freshState(opts.model || 'SQ6');
  const initial = JSON.parse(JSON.stringify(state));
  const powerOn = {};                 // for `stale`
  const clients = new Set();

  const get = (nrpn) => {
    if (Object.prototype.hasOwnProperty.call(state.params, nrpn)) return state.params[nrpn];
    return defaultValue(kindOf(nrpn));
  };
  const set = (nrpn, data) => {
    if (breakMode === 'stale' && !(nrpn in powerOn)) powerOn[nrpn] = get(nrpn);
    state.params[nrpn] = data;
    const k = keyOf(nrpn);
    if (k.startsWith('mute:')) state.mutes[k.slice(5)] = data === 1;
    else if (k.startsWith('level:inputToLr:')) state.faders[`input:${k.split(':')[2]}`] = data;
    else if (k.startsWith('level:')) state.faders[k.slice(6)] = data;
    state.nrpnLog.push({ key: keyOf(nrpn), nrpn, data, ts: Date.now() });
    while (state.nrpnLog.length > 100) state.nrpnLog.shift();
  };
  const valueMsg = (ch, nrpn, data) => {
    const cc = 0xB0 | ch;
    return Buffer.from([cc, 0x63, (nrpn >> 7) & 0x7F, cc, 0x62, nrpn & 0x7F,
      cc, 0x06, (data >> 7) & 0x7F, cc, 0x26, data & 0x7F]);
  };

  function applySet(nrpn, data) {
    const kind = kindOf(nrpn);
    if (!kind) { state.ignored++; return; }
    if ((kind === 'mute' || kind === 'assign') && data !== 0 && data !== 1) { state.ignored++; return; }
    if (breakMode === 'drop-sets') { state.ignored++; return; }
    state.sets++;
    set(nrpn, data);
  }

  function handleGet(sock, ch, nrpn) {
    const kind = kindOf(nrpn);
    if (!kind) { state.ignored++; return; }
    if (breakMode === 'no-reply') { state.ignored++; return; }
    state.gets++;
    const v = breakMode === 'stale' && nrpn in powerOn ? powerOn[nrpn] : get(nrpn);
    sock.write(valueMsg(ch, nrpn, v));
  }

  function recall(scene) {
    if (breakMode === 'no-scene') { state.ignored++; return; }
    const sc = state.scenes[scene];
    if (!sc) { state.refusedRecalls++; return; }   // blank scenes cannot be recalled
    state.recalls++;
    for (const [k, v] of Object.entries(sc.params)) set(Number(k), v);
    state.currentScene = scene;
  }

  function onMessage(sock, ps, msg) {
    const status = msg[0];
    const hi = status & 0xF0;
    const ch = status & 0x0F;
    if (ch !== state.midiChannel) { state.ignored++; return; }
    if (hi === 0xB0) {
      const [, cc, val] = msg;
      switch (cc) {
        case 0x00: ps.bank = val; break;
        case 0x63: ps.msb = val; ps.vc = null; break;
        case 0x62: ps.lsb = val; break;
        case 0x06: ps.vc = val; break;
        case 0x26:
          if (ps.msb == null || ps.lsb == null || ps.vc == null) return;
          applySet(N(ps.msb, ps.lsb), (ps.vc << 7) | val);
          break;
        case 0x60: case 0x61: {
          if (ps.msb == null || ps.lsb == null) return;
          const nrpn = N(ps.msb, ps.lsb);
          if (cc === 0x60 && val === 0x7F) { handleGet(sock, ch, nrpn); return; }
          const kind = kindOf(nrpn);
          if (kind === 'mute' && breakMode !== 'drop-sets') { state.sets++; set(nrpn, get(nrpn) ? 0 : 1); }
          else if (kind === 'level' && breakMode !== 'drop-sets') {
            state.sets++; set(nrpn, Math.max(0, Math.min(16383, get(nrpn) + (cc === 0x60 ? 119 : -119))));
          } else state.ignored++;
          break;
        }
        default: state.ignored++;
      }
      return;
    }
    if (hi === 0xC0) { recall(((ps.bank || 0) << 7) + msg[1] + 1); return; }
    if (hi === 0x90 || hi === 0x80) {
      const key = msg[1] - 0x30 + 1;
      if (key < 1 || key > 16) { state.ignored++; return; }
      state.softKeys.push({ key, on: hi === 0x90 && msg[2] > 0, ts: Date.now() });
      while (state.softKeys.length > 50) state.softKeys.shift();
    }
  }

  // Minimal running-status MIDI parser per socket.
  function feed(sock, ps, buf) {
    for (const b of buf) {
      if (b >= 0xF8) continue;
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
    const ps = { status: null, data: [], msb: null, lsb: null, vc: null, bank: 0 };
    sock.on('data', (buf) => {
      state.midiBytesReceived += buf.length;
      if (!state.reachable) return;               // cable pulled: bytes vanish
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

  function surfaceSet(nrpn, data) {
    if (!kindOf(nrpn)) throw new Error(`not an SQ parameter: ${nrpn}`);
    set(nrpn, data);
    if (!state.reachable) return;
    for (const c of clients) c.write(valueMsg(state.midiChannel, nrpn, data));
  }
  const byKey = (key) => {
    const [kind, type, idx] = String(key).split(':');
    const i = Number(idx);
    if (kind === 'mute' && type === 'input') return N(0, 0) + i;
    if (kind === 'mute' && type === 'lr') return N(0, 0x44);
    if (kind === 'mute' && type === 'dca') return N(2, 0) + i;
    if (kind === 'mute' && type === 'muteGroup') return N(4, 0) + i;
    if (kind === 'level' && type === 'inputToLr') return N(0x40, 0) + i;
    if (kind === 'level' && type === 'lr') return N(0x4F, 0);
    if (kind === 'level' && type === 'dca') return N(0x4F, 0x20) + i;
    throw new Error(`unknown key ${key}`);
  };

  const api = {
    get: (key) => get(byKey(key)),
    getNrpn: get,
    surfaceSet: (key, data) => surfaceSet(byKey(key), data),
    storeScene: (n, name = `Scene ${n}`, params = {}) => {
      const p = {};
      for (const [k, v] of Object.entries(params)) p[byKey(k)] = v;
      state.scenes[n] = { name, params: p };
    },
    setReachable: (r) => { state.reachable = !!r; },
    dropClients: () => { for (const c of clients) c.destroy(); },
    setMidiChannel: (c) => { state.midiChannel = c & 0x0F; },
  };

  const control = await createControlServer({
    device: 'sq', port: controlPort, state, initialState: initial,
    actions: {
      midiAcceptingClients: ({ accepting }) => { state.midiAcceptingClients = !!accepting; },
      setReachable: ({ reachable }) => api.setReachable(reachable),
      dropClients: () => api.dropClients(),
      surfaceSet: ({ key, value }) => api.surfaceSet(key, Number(value)),
      storeScene: ({ scene, name, params }) => api.storeScene(Number(scene), name, params || {}),
    },
  });

  return {
    device: 'sq',
    port: actualPort,
    midiPort: actualPort,
    url: `tcp://127.0.0.1:${actualPort}`,
    breakMode,
    control,
    state,
    ...api,
    stop: async () => {
      for (const c of clients) c.destroy();
      await new Promise((r) => server.close(() => r()));
      await control.stop();
    },
  };
}

module.exports = { start, LEVEL_0DB };

if (require.main === module) {
  start({ midiPort: Number(process.env.PORT) || 51325, controlPort: Number(process.env.CONTROL_PORT) || 0 })
    .then((s) => console.log(`[mock-sq] midi=tcp://127.0.0.1:${s.midiPort}  control=${s.control.url}${s.breakMode ? '  break=' + s.breakMode : ''}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
