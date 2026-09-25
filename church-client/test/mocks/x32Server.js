/**
 * Stateful Behringer X32 / Midas M32 OSC mock (UDP, default port 10023).
 *
 * Behaviour follows the Unofficial X32/M32 OSC Remote Protocol (P-G. Maillot):
 *   - SET  (address + in-range value)  → applied SILENTLY (the console never acks)
 *   - GET  (address, no args)          → current value echoed to the sender
 *   - unknown address / out-of-range   → ignored, no reply
 *   - /info  → ,ssss  server_version, server_name, console_model, console_version
 *   - /xremote → sender receives every parameter change for 10 s
 *   - /-action/goscene ,i n → recalls scene n only if it has data
 *   - /save ,siss "scene" idx name note → stores current mix into scene idx
 *   - faders are 1024-step (value read back is quantised like the real console)
 *
 * It says no: empty scenes don't recall, bad channels don't exist, a powered-off
 * or unplugged console goes silent.
 *
 * Mutation modes (X32_MOCK_BREAK or start({ breakMode })) make it sloppy ONE way:
 *   drop-sets    answers every GET but silently ignores SETs
 *   no-reply     receives everything, answers nothing
 *   info-only    answers /info but no other GET
 *   no-scene     ignores /-action/goscene
 *   stale-mute   applies mute SETs but GET keeps echoing the old value
 */
'use strict';
const dgram = require('node:dgram');
const { encodeMessage, decodeMessage } = require('../../src/osc');

const q = (v) => Math.round(Math.max(0, Math.min(1, v)) * 1023) / 1023;

function freshState(model) {
  const ch = {};
  for (let i = 1; i <= 32; i++) ch[i] = { fader: q(0.75), on: 1, name: `CH ${String(i).padStart(2, '0')}` };
  const dca = {}; for (let i = 1; i <= 8; i++) dca[i] = { fader: q(0.75), on: 1 };
  const mute = {}; for (let i = 1; i <= 6; i++) mute[i] = 0;
  return {
    model, firmware: model.startsWith('M') ? '4.09' : '4.06',
    ch, dca, mute, main: { fader: q(0.75), on: 1 },
    scenes: {},            // idx -> { name, snapshot }
    current: 0,
    power: 'on',
    gets: 0, sets: 0, ignored: 0, recalls: 0,
    log: [],
  };
}

function snapshot(s) {
  return JSON.parse(JSON.stringify({ ch: s.ch, main: s.main, dca: s.dca, mute: s.mute }));
}

async function start(opts = {}) {
  const breakMode = opts.breakMode || process.env.X32_MOCK_BREAK || '';
  const state = freshState(opts.model || 'X32');
  const sock = dgram.createSocket('udp4');
  let reachable = true;
  const subscribers = new Map(); // "addr:port" -> expiry

  function reply(rinfo, address, args) {
    sock.send(encodeMessage(address, args), rinfo.port, rinfo.address);
  }
  function notify(address, args, except) {
    const now = Date.now();
    for (const [k, exp] of subscribers) {
      if (exp < now) { subscribers.delete(k); continue; }
      if (k === except) continue;
      const [a, p] = k.split(':');
      sock.send(encodeMessage(address, args), Number(p), a);
    }
  }

  // address → { get(): [args], set(args): bool }
  function resolve(addr) {
    let m;
    if ((m = addr.match(/^\/ch\/(\d\d)\/mix\/(fader|on)$/))) {
      const c = state.ch[Number(m[1])]; if (!c) return null;
      return m[2] === 'fader'
        ? { get: () => [{ type: 'f', value: c.fader }], set: (a) => (a[0]?.type === 'f' && a[0].value >= 0 && a[0].value <= 1 ? ((c.fader = q(a[0].value)), true) : false) }
        : { mute: true, get: () => [{ type: 'i', value: c._staleOn ?? c.on }], set: (a) => (a[0]?.type === 'i' && (a[0].value === 0 || a[0].value === 1) ? ((breakMode === 'stale-mute' && (c._staleOn = c._staleOn ?? c.on)), (c.on = a[0].value), true) : false) };
    }
    if ((m = addr.match(/^\/ch\/(\d\d)\/config\/name$/))) {
      const c = state.ch[Number(m[1])]; if (!c) return null;
      return { get: () => [{ type: 's', value: c.name }], set: (a) => (a[0]?.type === 's' ? ((c.name = a[0].value.slice(0, 12)), true) : false) };
    }
    if ((m = addr.match(/^\/main\/st\/mix\/(fader|on)$/))) {
      const c = state.main;
      return m[1] === 'fader'
        ? { get: () => [{ type: 'f', value: c.fader }], set: (a) => (a[0]?.type === 'f' && a[0].value >= 0 && a[0].value <= 1 ? ((c.fader = q(a[0].value)), true) : false) }
        : { mute: true, get: () => [{ type: 'i', value: c._staleOn ?? c.on }], set: (a) => (a[0]?.type === 'i' && (a[0].value === 0 || a[0].value === 1) ? ((breakMode === 'stale-mute' && (c._staleOn = c._staleOn ?? c.on)), (c.on = a[0].value), true) : false) };
    }
    if ((m = addr.match(/^\/dca\/([1-8])\/(fader|on)$/))) {
      const c = state.dca[Number(m[1])];
      return m[2] === 'fader'
        ? { get: () => [{ type: 'f', value: c.fader }], set: (a) => (a[0]?.type === 'f' && a[0].value >= 0 && a[0].value <= 1 ? ((c.fader = q(a[0].value)), true) : false) }
        : { get: () => [{ type: 'i', value: c.on }], set: (a) => (a[0]?.type === 'i' && (a[0].value === 0 || a[0].value === 1) ? ((c.on = a[0].value), true) : false) };
    }
    if ((m = addr.match(/^\/config\/mute\/([1-6])$/))) {
      const g = Number(m[1]);
      return { get: () => [{ type: 'i', value: state.mute[g] }], set: (a) => (a[0]?.type === 'i' && (a[0].value === 0 || a[0].value === 1) ? ((state.mute[g] = a[0].value), true) : false) };
    }
    if (addr === '/-show/prepos/current') {
      return { get: () => [{ type: 'i', value: state.current }], set: (a) => (a[0]?.type === 'i' && a[0].value >= 0 && a[0].value <= 99 ? ((state.current = a[0].value), true) : false) };
    }
    if ((m = addr.match(/^\/-show\/showfile\/scene\/(\d{3})\/(name|hasdata)$/))) {
      const idx = Number(m[1]); if (idx > 99) return null;
      return m[2] === 'name'
        ? { get: () => [{ type: 's', value: state.scenes[idx]?.name || '' }], set: () => false }
        : { get: () => [{ type: 'i', value: state.scenes[idx] ? 1 : 0 }], set: () => false };
    }
    return null;
  }

  sock.on('message', (buf, rinfo) => {
    if (!reachable || state.power !== 'on') return;
    let msg; try { msg = decodeMessage(buf); } catch { return; }
    if (!msg || !msg.address) return;
    const addr = msg.address; const args = msg.args || [];
    state.log.push({ addr, args: args.map((a) => a.value) });
    if (breakMode === 'no-reply') return;
    const key = `${rinfo.address}:${rinfo.port}`;

    if (addr === '/info') return reply(rinfo, '/info', [
      { type: 's', value: 'V2.07' }, { type: 's', value: 'osc-server' },
      { type: 's', value: state.model }, { type: 's', value: state.firmware }]);
    if (addr === '/status') return reply(rinfo, '/status', [{ type: 's', value: 'active' }, { type: 's', value: '127.0.0.1' }, { type: 's', value: 'osc-server' }]);
    if (addr === '/xremote') { subscribers.set(key, Date.now() + 10000); return; }

    if (addr === '/-action/goscene') {
      if (breakMode === 'no-scene' || breakMode === 'drop-sets') return;
      const idx = args[0]?.type === 'i' ? args[0].value : -1;
      const sc = state.scenes[idx];
      if (!sc) { state.ignored++; return; } // empty scene: console does nothing
      Object.assign(state, JSON.parse(JSON.stringify(sc.snapshot)));
      state.current = idx; state.recalls++;
      notify('/-show/prepos/current', [{ type: 'i', value: idx }]);
      return;
    }
    if (addr === '/save') {
      if (breakMode === 'drop-sets') return;
      if (args[0]?.value !== 'scene' || args[1]?.type !== 'i' || args[1].value < 0 || args[1].value > 99) { state.ignored++; return; }
      state.scenes[args[1].value] = { name: String(args[2]?.value || `Scene ${args[1].value}`).slice(0, 32), snapshot: snapshot(state) };
      return;
    }

    const node = resolve(addr);
    if (!node) { state.ignored++; return; } // unknown address: silence
    if (args.length === 0) {
      if (breakMode === 'info-only') return;
      state.gets++;
      return reply(rinfo, addr, node.get());
    }
    if (breakMode === 'drop-sets') { state.ignored++; return; }
    if (node.set(args)) { state.sets++; notify(addr, node.get(), key); } else state.ignored++;
  });

  await new Promise((res, rej) => { sock.once('error', rej); sock.bind(opts.port || 0, '127.0.0.1', res); });
  const port = sock.address().port;

  return {
    port, state, breakMode,
    /** Seed a stored scene with a given mix (e.g. { ch: { 1: { fader, on } } }). */
    storeScene(idx, name, patch = {}) {
      const snap = snapshot(state);
      for (const [c, v] of Object.entries(patch.ch || {})) Object.assign(snap.ch[c], v);
      if (patch.main) Object.assign(snap.main, patch.main);
      state.scenes[idx] = { name, snapshot: snap };
    },
    setReachable(v) { reachable = !!v; },
    setPower(p) { state.power = p; },
    stop: () => new Promise((r) => { try { sock.close(r); } catch { r(); } }),
  };
}

module.exports = { start };
