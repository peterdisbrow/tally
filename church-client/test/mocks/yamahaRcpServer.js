/**
 * Stateful Yamaha CL / QL / TF mock — Remote Control Protocol (RCP), TCP 49280.
 *
 * What the real consoles do (Yamaha "QLab Setup Guide for CL/QL/TF", the RCP
 * parameter dumps shipped with bitfocus/companion-module-yamaha-rcp):
 *   - Plain text lines terminated by LF. Client → `get`, `set`, `ssrecall_ex`,
 *     `sscurrent_ex`, `devinfo`, `devstatus`.
 *   - Replies in order: `OK <action> <address> <x> <y> <value>` / `ERROR <action> <reason>`.
 *     A change made by another client or on the surface is pushed as `NOTIFY set …`.
 *   - Channel/DCA indices are 0-based. `…/Fader/On` 1 = channel ON (unmuted), 0 = muted.
 *     Levels are dB × 100, −32768 = −∞, max 1000. Pan −63…63.
 *   - CL/QL scenes: `ssrecall_ex MIXER:Lib/Scene N` (1–300). TF: `ssrecall_ex scene_a|scene_b N` (0–99).
 *     Recalling an empty scene is refused with ERROR.
 *   - CL/QL have NO OSC; nothing listens on 8765.
 *
 * It says no: unknown addresses / out-of-range indices / bad values → ERROR, empty
 * scenes → ERROR, unplugged (setReachable false) = silent half-open socket,
 * dropClients closes sockets, setAccepting(false) refuses TCP.
 *
 * Mutation modes (YAMAHA_MOCK_BREAK or start({ breakMode })):
 *   drop-sets    answers `OK set …` but does not apply the change
 *   no-reply     reads everything, answers nothing
 *   stale        applies sets but `get` keeps answering the power-on value
 *   no-scene     answers `OK ssrecall_ex` but does not recall
 */
'use strict';

const net = require('node:net');
const { createControlServer } = require('./_lib/control');

const MODELS = {
  CL5: { family: 'CL', inputs: 72, st: 3, dca: 16, muteMaster: 8, mix: 24, nameMax: 8 },
  CL3: { family: 'CL', inputs: 64, st: 3, dca: 16, muteMaster: 8, mix: 24, nameMax: 8 },
  CL1: { family: 'CL', inputs: 48, st: 3, dca: 16, muteMaster: 8, mix: 24, nameMax: 8 },
  QL5: { family: 'QL', inputs: 64, st: 3, dca: 16, muteMaster: 8, mix: 16, nameMax: 8 },
  QL1: { family: 'QL', inputs: 32, st: 3, dca: 16, muteMaster: 8, mix: 16, nameMax: 8 },
  TF5: { family: 'TF', inputs: 40, st: 2, dca: 8, muteMaster: 6, mix: 20, nameMax: 64 },
  TF1: { family: 'TF', inputs: 40, st: 2, dca: 8, muteMaster: 6, mix: 20, nameMax: 64 },
};

function paramTable(M) {
  const lvl = { type: 'int', min: -32768, max: 1000, def: -32768 };
  const on = { type: 'int', min: 0, max: 1, def: 1 };
  return {
    'MIXER:Current/InCh/Fader/Level': { x: M.inputs, ...lvl },
    'MIXER:Current/InCh/Fader/On': { x: M.inputs, ...on },
    'MIXER:Current/InCh/ToSt/Pan': { x: M.inputs, type: 'int', min: -63, max: 63, def: 0 },
    'MIXER:Current/InCh/Label/Name': { x: M.inputs, type: 'str', max: M.nameMax, def: (i) => `ch ${i + 1}` },
    'MIXER:Current/St/Fader/Level': { x: M.st, ...lvl, def: 0 },
    'MIXER:Current/St/Fader/On': { x: M.st, ...on },
    'MIXER:Current/DCA/Fader/Level': { x: M.dca, ...lvl, def: 0 },
    'MIXER:Current/DCA/Fader/On': { x: M.dca, ...on },
    'MIXER:Current/MuteMaster/On': { x: M.muteMaster, ...on, def: 0 },
    'MIXER:Current/Mix/Fader/On': { x: M.mix, ...on },
  };
}

function tokenize(line) {
  return (line.match(/(?:[^\s"]+|"[^"]*")+/g) || []);
}

async function start(opts = {}) {
  let { port, controlPort = 0 } = opts;
  port = port ?? 49280;
  const modelName = String(opts.model || 'CL5').toUpperCase();
  const M = MODELS[modelName] || MODELS.CL5;
  const P = paramTable(M);
  const breakMode = opts.breakMode || process.env.YAMAHA_MOCK_BREAK || '';
  const clients = new Set();
  const hooks = { afterSet: null, delayNext: 0, delayMs: 0 };
  const state = {
    model: modelName,
    params: {},            // 'addr|x|y' → value
    scenes: M.family === 'TF' ? { 'scene_a:0': { name: 'Sunday', params: {} } } : { 1: { name: 'Sunday', params: {} } },
    currentScene: null,
    reachable: true,
    acceptingClients: true,
    clientsConnected: 0,
    sets: 0, gets: 0, errors: 0, recalls: 0, refusedRecalls: 0,
    log: [],
  };
  const initial = JSON.parse(JSON.stringify(state));
  const powerOn = {};
  const k = (addr, x, y) => `${addr}|${x}|${y}`;
  const defOf = (p, x) => (typeof p.def === 'function' ? p.def(x) : p.def);
  const read = (addr, x, y) => {
    const key = k(addr, x, y);
    if (key in state.params) return state.params[key];
    return defOf(P[addr], x);
  };
  const fmt = (p, v) => (p.type === 'str' ? `"${v}"` : String(v));
  const write = (addr, x, y, v) => {
    const key = k(addr, x, y);
    if (breakMode === 'stale' && !(key in powerOn)) powerOn[key] = read(addr, x, y);
    state.params[key] = v;
    state.log.push({ addr, x, y, v, ts: Date.now() });
    while (state.log.length > 200) state.log.shift();
  };
  const broadcast = (line, except) => {
    if (!state.reachable) return;
    for (const c of clients) if (c !== except) c.write(line + '\n');
  };

  function validate(addr, x, y, raw) {
    const p = P[addr];
    if (!p) return { err: 'UnknownAddress' };
    const xi = Number(x), yi = Number(y);
    if (!Number.isInteger(xi) || xi < 0 || xi >= p.x || yi !== 0) return { err: 'InvalidArgument' };
    if (raw === undefined) return { p, xi, yi };
    if (p.type === 'str') {
      if (!/^".*"$/.test(raw)) return { err: 'InvalidArgument' };
      const v = raw.slice(1, -1);
      if (v.length > p.max) return { err: 'InvalidArgument' };
      return { p, xi, yi, v };
    }
    const v = Number(raw);
    if (!Number.isInteger(v) || v < p.min || v > p.max) return { err: 'InvalidArgument' };
    return { p, xi, yi, v };
  }

  function handle(sock, line) {
    const t = tokenize(line.trim());
    if (!t.length) return;
    const reply = (s) => {
      if (breakMode === 'no-reply') return;
      // Replies stay in order (like the console); a delayed reply holds back later ones.
      const q = sock._out || (sock._out = { held: [], busy: false });
      const delay = hooks.delayNext > 0 ? (hooks.delayNext--, hooks.delayMs) : 0;
      q.held.push({ s, delay });
      const pump = () => {
        if (q.busy) return;
        const next = q.held.shift();
        if (!next) return;
        if (!next.delay) { if (!sock.destroyed) sock.write(next.s + '\n'); pump(); return; }
        q.busy = true;
        setTimeout(() => { q.busy = false; if (!sock.destroyed && state.reachable) sock.write(next.s + '\n'); pump(); }, next.delay);
      };
      pump();
    };
    const [cmd, a1, a2, a3, a4] = t;
    switch (cmd) {
      case 'devinfo':
        if (a1 === 'productname') return reply(`OK devinfo productname "${modelName}"`);
        if (a1 === 'devicename') return reply('OK devinfo devicename "FOH"');
        state.errors++; return reply('ERROR devinfo InvalidArgument');
      case 'devstatus':
        if (a1 === 'runmode') return reply('OK devstatus runmode "normal"');
        state.errors++; return reply('ERROR devstatus InvalidArgument');
      case 'get': {
        const r = validate(a1, a2, a3);
        if (r.err) { state.errors++; return reply(`ERROR get ${r.err}`); }
        state.gets++;
        const key = k(a1, r.xi, r.yi);
        const v = breakMode === 'stale' && key in powerOn ? powerOn[key] : read(a1, r.xi, r.yi);
        return reply(`OK get ${a1} ${r.xi} ${r.yi} ${fmt(r.p, v)}`);
      }
      case 'set': {
        const raw = t.slice(4).join(' ') || undefined;
        const r = validate(a1, a2, a3, raw === undefined ? '' : raw);
        if (r.err || raw === undefined) { state.errors++; return reply(`ERROR set ${r.err || 'InvalidArgument'}`); }
        if (breakMode !== 'drop-sets') { write(a1, r.xi, r.yi, r.v); state.sets++; broadcast(`NOTIFY set ${a1} ${r.xi} ${r.yi} ${fmt(r.p, r.v)}`, sock); }
        reply(`OK set ${a1} ${r.xi} ${r.yi} ${fmt(r.p, r.v)}`);
        if (hooks.afterSet) hooks.afterSet({ addr: a1, x: r.xi, value: r.v });
        return undefined;
      }
      case 'ssrecall_ex': {
        const bankOk = M.family === 'TF' ? /^scene_[ab]$/.test(a1 || '') : a1 === 'MIXER:Lib/Scene';
        const n = Number(a2);
        const max = M.family === 'TF' ? 99 : 300;
        const min = M.family === 'TF' ? 0 : 1;
        if (!bankOk || !Number.isInteger(n) || n < min || n > max) { state.errors++; return reply('ERROR ssrecall_ex InvalidArgument'); }
        const sk = M.family === 'TF' ? `${a1}:${n}` : n;
        const sc = state.scenes[sk];
        if (!sc) { state.refusedRecalls++; state.errors++; return reply('ERROR ssrecall_ex InvalidArgument'); }
        if (breakMode !== 'no-scene') {
          for (const [kk, v] of Object.entries(sc.params)) { const [ad, x, y] = kk.split('|'); write(ad, Number(x), Number(y), v); }
          state.currentScene = M.family === 'TF' ? `${a1}:${n}` : n;
          state.recalls++;
          broadcast(`NOTIFY sscurrent_ex ${a1} ${n}`, null);
        }
        return reply(`OK ssrecall_ex ${a1} ${n}`);
      }
      case 'sscurrent_ex': {
        if (M.family === 'TF') {
          const cur = String(state.currentScene || '');
          if (!cur.startsWith(`${a1}:`)) { state.errors++; return reply('ERROR sscurrent_ex InvalidArgument'); }
          return reply(`OK sscurrent_ex ${a1} ${cur.split(':')[1]}`);
        }
        if (a1 !== 'MIXER:Lib/Scene') { state.errors++; return reply('ERROR sscurrent_ex InvalidArgument'); }
        return reply(`OK sscurrent_ex MIXER:Lib/Scene ${state.currentScene ?? 0}`);
      }
      default:
        state.errors++;
        return reply('ERROR unknown command');
    }
  }

  const server = net.createServer((sock) => {
    if (!state.acceptingClients) { sock.destroy(); return; }
    clients.add(sock);
    state.clientsConnected++;
    let buf = '';
    sock.on('data', (d) => {
      if (!state.reachable) return;
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); handle(sock, line); }
    });
    sock.on('close', () => { clients.delete(sock); state.clientsConnected = Math.max(0, state.clientsConnected - 1); });
    sock.on('error', () => {});
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const actualPort = server.address().port;

  // Friendly keys: 'on:input:0', 'level:input:0', 'on:st:0', 'level:st:0', 'on:dca:0', 'level:dca:0',
  // 'muteMaster:0', 'pan:input:0', 'name:input:0'
  const addrOf = (key) => {
    const [kind, type, idx] = String(key).split(':');
    if (kind === 'muteMaster') return ['MIXER:Current/MuteMaster/On', Number(type)];
    const T = { input: 'InCh', st: 'St', dca: 'DCA', mix: 'Mix' }[type];
    if (!T) throw new Error(`bad key ${key}`);
    const leaf = { on: 'Fader/On', level: 'Fader/Level', pan: 'ToSt/Pan', name: 'Label/Name' }[kind];
    return [`MIXER:Current/${T}/${leaf}`, Number(idx)];
  };
  const api = {
    get: (key) => { const [a, x] = addrOf(key); return read(a, x, 0); },
    surfaceSet: (key, v) => {
      const [a, x] = addrOf(key);
      write(a, x, 0, v);
      broadcast(`NOTIFY set ${a} ${x} 0 ${fmt(P[a], v)}`, null);
    },
    storeScene: (n, name = `Scene ${n}`, params = {}, bank = 'scene_a') => {
      const p = {};
      for (const [key, v] of Object.entries(params)) { const [a, x] = addrOf(key); p[k(a, x, 0)] = v; }
      state.scenes[M.family === 'TF' ? `${bank}:${n}` : n] = { name, params: p };
    },
    /** Test hook: runs right after a client's set was answered (e.g. operator moves it back). */
    afterSet: (fn) => { hooks.afterSet = fn; },
    /** Answer the next n requests late (ms) — a congested network / busy console. */
    delayNext: (n, ms) => { hooks.delayNext = n; hooks.delayMs = ms; },
    setReachable: (r) => { state.reachable = !!r; },
    dropClients: () => { for (const c of clients) c.destroy(); },
  };
  const control = await createControlServer({
    device: 'yamaha', port: controlPort, state, initialState: initial,
    actions: {
      setAccepting: ({ accepting }) => { state.acceptingClients = !!accepting; },
      setReachable: ({ reachable }) => api.setReachable(reachable),
      dropClients: () => api.dropClients(),
      surfaceSet: ({ key, value }) => api.surfaceSet(key, value),
      storeScene: ({ scene, name, params, bank }) => api.storeScene(Number(scene), name, params || {}, bank),
      get: ({ key }) => ({ value: api.get(key) }),
    },
  });
  return {
    device: 'yamaha', model: modelName, family: M.family, port: actualPort, url: `tcp://127.0.0.1:${actualPort}`,
    breakMode, control, state, ...api,
    stop: async () => { for (const c of clients) c.destroy(); await new Promise((r) => server.close(() => r())); await control.stop(); },
  };
}

module.exports = { start, MODELS };

if (require.main === module) {
  start({ port: Number(process.env.PORT) || 49280, controlPort: Number(process.env.CONTROL_PORT) || 0, model: process.env.YAMAHA_MODEL || 'CL5' })
    .then((s) => console.log(`[mock-yamaha ${s.model}] rcp=tcp://127.0.0.1:${s.port}  control=${s.control.url}${s.breakMode ? '  break=' + s.breakMode : ''}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
