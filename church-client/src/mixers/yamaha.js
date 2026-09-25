/**
 * Yamaha CL / QL / TF driver — Yamaha Remote Control Protocol (RCP), TCP 49280.
 *
 * All three families (and DM3 / DM7 / RIVAGE) speak the same plain-text RCP on
 * TCP 49280 — the protocol Yamaha documents for QLab, and that the Bitfocus
 * Companion "yamaha-rcp" module uses. There is NO OSC on CL/QL (the old
 * "/ymhss/state on 8765" driver talked to nothing) and TF does not take MIDI
 * notes on 49280.
 *
 *   get <address> <x> <y>            →  OK get <address> <x> <y> <value>
 *   set <address> <x> <y> <value>    →  OK set … / OKm set … (value clipped) / ERROR set <reason>
 *   another client / the surface     →  NOTIFY set <address> <x> <y> <value>
 *   ssrecall_ex MIXER:Lib/Scene N    (CL/QL, 1–300)   ssrecall_ex scene_a|scene_b N (TF, 0–99)
 *   sscurrent_ex …                   current scene read-back
 *   devinfo productname              →  OK devinfo productname "CL5"
 *
 *   Indices are 0-based. …/Fader/On: 1 = ON (unmuted), 0 = OFF (muted).
 *   Levels are dB × 100 (max +10.00 dB = 1000, −∞ = −32768). Pan −63…63.
 *
 * Honesty contract (same as the X32 / SQ / dLive drivers):
 *   • every set is answered OK/ERROR by the console, then READ BACK with get;
 *     a command only succeeds when the console reports the new value;
 *   • scene recall is confirmed by reading the current scene back;
 *   • liveness is a round-trip (devstatus runmode), never "socket open";
 *   • unknown values are null, never "unmuted" / 0;
 *   • RCP has no HPF / EQ / dynamics / scene-save / solo-clear / SoftKey
 *     control we can confirm → those refuse with an error.
 */

'use strict';

const net = require('net');
const { _internals: law } = require('./allenheath');   // shared X32 fader law (0.75 = 0 dB)

const RCP_PORT = 49280;
const LEGACY_PORTS = new Set([8765, 9765]);   // fictional CL/QL "OSC" ports from old configs
const REPLY_TIMEOUT_MS = 1000;
const PROBE_TIMEOUT_MS = 1500;
const RECONNECT_MS = 2000;
const NEG_INF = -32768;

const FAMILIES = {
  CL: { inputs: 72, dcas: 16, muteGroups: 8, nameMax: 8, sceneMin: 1, sceneMax: 300 },
  QL: { inputs: 64, dcas: 16, muteGroups: 8, nameMax: 8, sceneMin: 1, sceneMax: 300 },
  TF: { inputs: 40, dcas: 8, muteGroups: 6, nameMax: 64, sceneMin: 0, sceneMax: 99 },
};
const INPUTS_BY_PRODUCT = { CL5: 72, CL3: 64, CL1: 48, QL5: 64, QL1: 32 };

const A = {
  inOn: 'MIXER:Current/InCh/Fader/On',
  inLevel: 'MIXER:Current/InCh/Fader/Level',
  inPan: 'MIXER:Current/InCh/ToSt/Pan',
  inName: 'MIXER:Current/InCh/Label/Name',
  stOn: 'MIXER:Current/St/Fader/On',
  stLevel: 'MIXER:Current/St/Fader/Level',
  dcaOn: 'MIXER:Current/DCA/Fader/On',
  dcaLevel: 'MIXER:Current/DCA/Fader/Level',
  muteMaster: 'MIXER:Current/MuteMaster/On',
};

function normalToLevel(norm) {
  const dB = law.normalToDb(norm);
  if (!Number.isFinite(dB) || dB < -138) return NEG_INF;
  return Math.max(-13800, Math.min(1000, Math.round(dB * 100)));
}
function levelToNormal(v) {
  if (v == null || !Number.isFinite(v)) return null;
  if (v <= -13800) return 0;
  return Math.round(law.dbToNormal(v / 100) * 1000) / 1000;
}
function levelMatches(want, got) {
  if (!Number.isFinite(got)) return false;
  if (want <= -13800) return got <= -13800;
  // consoles quantise coarser at low levels
  return Math.abs(got - want) <= (want >= -4000 ? 100 : 500);
}

function tokenize(line) {
  return line.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
}
function parseValue(tok) {
  if (tok == null) return undefined;
  if (/^".*"$/.test(tok)) return tok.slice(1, -1);
  const n = Number(tok);
  return Number.isFinite(n) ? n : tok;
}

class YamahaMixer {
  /**
   * @param {{ host: string, port?: number, model?: string }} opts
   *   model is only a hint ('CL' / 'QL' / 'TF' / 'CL5' …) — the console's own
   *   product name (devinfo productname) wins once connected.
   */
  constructor({ host, port, model = 'CL' } = {}) {
    this.host = host;
    const p = Number(port);
    this.port = !p || LEGACY_PORTS.has(p) ? RCP_PORT : p;
    if (p && LEGACY_PORTS.has(p)) console.warn(`🎛️  Yamaha: port ${p} is not an RCP port — using ${RCP_PORT}`);
    this._setModel(String(model || 'CL'));
    this._detected = false;
    this._sock = null;
    this._connected = false;
    this._online = false;
    this._stopped = false;
    this._buf = '';
    this._queue = [];
    this._reconnectTimer = null;
    this._state = { mutes: {}, faders: {}, names: {}, scene: null };
  }

  _setModel(name) {
    const up = name.toUpperCase().replace(/\s+/g, '');
    const fam = /^TF/.test(up) ? 'TF' : /^QL/.test(up) ? 'QL' : 'CL';
    this.family = fam;
    this.F = { ...FAMILIES[fam] };
    if (INPUTS_BY_PRODUCT[up]) this.F.inputs = INPUTS_BY_PRODUCT[up];
    this.model = /^(CL|QL|TF)\d|^TF-?RACK/.test(up) ? up : fam;
  }

  // ─── LIFECYCLE ──────────────────────────────────────────────────────────────

  async connect() {
    this._stopped = false;
    try { await this._open(); } catch (e) { console.warn(`🎛️  Yamaha: connect failed — ${e.message}`); this._scheduleReconnect(); }
  }

  async disconnect() {
    this._stopped = true;
    clearTimeout(this._reconnectTimer);
    this._failAll(new Error('Yamaha disconnected'));
    if (this._sock) { this._sock.destroy(); this._sock = null; }
    this._connected = false;
    this._online = false;
  }

  _open() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      const t = setTimeout(() => { sock.destroy(); reject(new Error('connect timeout')); }, 3000);
      sock.setNoDelay(true);
      sock.on('connect', async () => {
        clearTimeout(t);
        this._sock = sock;
        this._connected = true;
        this._buf = '';
        console.log(`🎛️  Yamaha: RCP connected to ${this.host}:${this.port}`);
        await this._detect();
        resolve();
      });
      sock.on('data', (d) => this._onData(d));
      sock.on('error', (e) => { clearTimeout(t); if (!this._connected) reject(e); });
      sock.on('close', () => {
        clearTimeout(t);
        if (this._sock === sock) {
          this._sock = null;
          this._connected = false;
          this._online = false;
          this._failAll(new Error(`${this.model} not connected`));
          console.log('🎛️  Yamaha: RCP disconnected');
          this._scheduleReconnect();
        }
      });
    });
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this._stopped || this._connected) return;
      try { await this._open(); } catch { this._scheduleReconnect(); }
    }, RECONNECT_MS);
  }

  async _detect() {
    try {
      const r = await this._req('devinfo productname', { action: 'devinfo', addr: 'productname' }, PROBE_TIMEOUT_MS);
      if (typeof r.value === 'string' && r.value) { this._setModel(r.value); this._detected = true; }
      this._online = true;
    } catch { this._online = false; }
  }

  // ─── LINE PROTOCOL ─────────────────────────────────────────────────────────

  _onData(d) {
    this._buf += d.toString('utf8');
    let i;
    while ((i = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, i).replace(/\r$/, '');
      this._buf = this._buf.slice(i + 1);
      if (line.trim()) this._onLine(line.trim());
    }
    if (this._buf.length > 65536) this._buf = '';
  }

  _onLine(line) {
    const t = tokenize(line);
    const kind = t[0];
    if (kind === 'NOTIFY') { this._applyNotify(t); return; }
    if (kind !== 'OK' && kind !== 'OKm' && kind !== 'ERROR') return;
    const action = t[1];
    // Replies come back in order; after a timeout a late reply may arrive for a
    // request we already gave up on — only resolve the head when it matches.
    while (this._queue.length) {
      const head = this._queue[0];
      const e = head.expect;
      const matches = e.action === action
        && (kind === 'ERROR' || ((!e.addr || e.addr === t[2]) && (e.x == null || Number(t[3]) === e.x)));
      if (!matches) {
        // A reply for something that is not at the head: ignore it (late or foreign).
        return;
      }
      this._queue.shift();
      clearTimeout(head.timer);
      if (kind === 'ERROR') head.reject(Object.assign(new Error(t.slice(2).join(' ') || 'ERROR'), { rcpError: true }));
      else head.resolve({ kind, tokens: t, value: parseValue(t[t.length - 1]) });
      return;
    }
  }

  _applyNotify(t) {
    if (t[1] === 'set') this._cache(t[2], Number(t[3]), parseValue(t[5]));
    if (t[1] === 'sscurrent_ex') this._state.scene = this.family === 'TF' ? `${t[2]}:${t[3]}` : Number(t[3]);
  }

  _cache(addr, x, v) {
    if (v === undefined) return;
    switch (addr) {
      case A.inOn: this._state.mutes[`input:${x}`] = v === 0; break;
      case A.stOn: this._state.mutes[`st:${x}`] = v === 0; break;
      case A.dcaOn: this._state.mutes[`dca:${x}`] = v === 0; break;
      case A.muteMaster: this._state.mutes[`muteGroup:${x}`] = v === 1; break;
      case A.inLevel: this._state.faders[`input:${x}`] = v; break;
      case A.stLevel: this._state.faders[`st:${x}`] = v; break;
      case A.dcaLevel: this._state.faders[`dca:${x}`] = v; break;
      case A.inName: this._state.names[`input:${x}`] = v; break;
      default: break;
    }
  }

  _req(line, expect, timeoutMs = REPLY_TIMEOUT_MS) {
    if (!this._sock || !this._connected) return Promise.reject(new Error(`${this.model} not connected`));
    return new Promise((resolve, reject) => {
      const entry = { expect, resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        const i = this._queue.indexOf(entry);
        if (i >= 0) this._queue.splice(i, 1);
        reject(Object.assign(new Error('no reply'), { timeout: true }));
      }, timeoutMs);
      this._queue.push(entry);
      this._sock.write(line + '\n');
    });
  }

  _failAll(err) {
    const q = this._queue;
    this._queue = [];
    for (const e of q) { clearTimeout(e.timer); e.reject(err); }
  }

  async _get(addr, x, t) {
    const r = await this._req(`get ${addr} ${x} 0`, { action: 'get', addr, x }, t);
    this._cache(addr, x, r.value);
    return r.value;
  }

  _noReply(label) {
    this._online = false;
    return new Error(`${this.model} did not confirm ${label} — no reply from the console (check it is powered and on the network)`);
  }

  _requireOnline() {
    if (!this._sock || !this._connected) throw new Error(`${this.model} not connected`);
  }

  /** set → OK/ERROR → get read-back. */
  async _setVerified(addr, x, value, label, cmp = (w, g) => w === g) {
    this._requireOnline();
    const wire = typeof value === 'string' ? `"${value}"` : String(value);
    try {
      await this._req(`set ${addr} ${x} 0 ${wire}`, { action: 'set', addr, x });
    } catch (e) {
      if (e.rcpError) throw new Error(`${this.model} refused ${label} (${e.message})`);
      if (e.timeout) throw this._noReply(label);
      throw e;
    }
    let got;
    try { got = await this._get(addr, x); } catch (e) {
      if (e.timeout) throw this._noReply(label);
      throw e;
    }
    if (!cmp(value, got)) throw new Error(`${this.model} did not apply ${label} — console reports ${JSON.stringify(got)}, expected ${JSON.stringify(value)}`);
    this._online = true;
    return { confirmed: true };
  }

  // ─── HEALTH ─────────────────────────────────────────────────────────────────

  async _probe(t = PROBE_TIMEOUT_MS) {
    if (!this._sock || !this._connected) return false;
    try {
      await this._req('devstatus runmode', { action: 'devstatus', addr: 'runmode' }, t);
      if (!this._detected) await this._detect();
      return true;
    } catch { return false; }
  }

  async isOnline() {
    this._online = await this._probe();
    return this._online;
  }

  async getStatus() {
    const online = await this.isOnline();
    let on, lvl;
    if (online) {
      on = await this._get(A.stOn, 0).catch(() => undefined);
      lvl = await this._get(A.stLevel, 0).catch(() => undefined);
    }
    return {
      online,
      model: this.model,
      firmware: '',
      mainFader: online && Number.isFinite(lvl) ? levelToNormal(lvl) : null,
      mainMuted: online && (on === 0 || on === 1) ? on === 0 : null,
      scene: this._state.scene,
    };
  }

  // ─── VALIDATION ─────────────────────────────────────────────────────────────

  static _idx(val, max, what = 'channel') {
    const s = String(val ?? '').trim();
    const n = /^\d+$/.test(s) ? Number(s) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`Invalid ${what} "${val}" (valid: 1–${max})`);
    return n - 1;
  }
  static _level(level) {
    const v = Number(level);
    if (level === '' || level == null || !Number.isFinite(v) || v < 0 || v > 1) throw new Error(`Invalid level "${level}" (valid: 0.0–1.0)`);
    return v;
  }

  // ─── INPUTS ─────────────────────────────────────────────────────────────────

  async muteChannel(ch)   { return this._inputOn(ch, 0); }
  async unmuteChannel(ch) { return this._inputOn(ch, 1); }
  async _inputOn(ch, on) {
    const n = YamahaMixer._idx(ch, this.F.inputs);
    return this._setVerified(A.inOn, n, on, `channel ${n + 1} ${on ? 'unmute' : 'mute'}`);
  }

  async setFader(ch, level) {
    const n = YamahaMixer._idx(ch, this.F.inputs);
    const v = normalToLevel(YamahaMixer._level(level));
    return this._setVerified(A.inLevel, n, v, `channel ${n + 1} fader`, levelMatches);
  }

  async getChannelStatus(ch) {
    const n = YamahaMixer._idx(ch, this.F.inputs);
    if (this._connected) {
      await this._get(A.inOn, n).catch(() => undefined);
      await this._get(A.inLevel, n).catch(() => undefined);
      await this._get(A.inName, n).catch(() => undefined);
    }
    const key = `input:${n}`;
    const f = this._state.faders[key];
    const m = this._state.mutes[key];
    return { fader: f != null ? levelToNormal(f) : null, muted: m != null ? m : null, name: this._state.names[key] || undefined };
  }

  async setPan(ch, pan) {
    const n = YamahaMixer._idx(ch, this.F.inputs);
    const p = Number(pan);
    if (pan === '' || pan == null || !Number.isFinite(p) || p < -1 || p > 1) throw new Error(`Invalid pan "${pan}" (valid: -1.0–1.0)`);
    const v = Math.sign(p) * Math.round(Math.abs(p) * 63);   // symmetric: ±0.5 → ±32
    return this._setVerified(A.inPan, n, v === 0 ? 0 : v, `channel ${n + 1} pan`);
  }

  async setChannelName(ch, name) {
    const n = YamahaMixer._idx(ch, this.F.inputs);
    const s = String(name ?? '');
    if (!s.length || s.length > this.F.nameMax || !/^[\x20-\x7E]+$/.test(s) || s.includes('"')) {
      throw new Error(`Invalid name "${name}" (1–${this.F.nameMax} plain characters, no quotes, on ${this.model})`);
    }
    return this._setVerified(A.inName, n, s, `channel ${n + 1} name`);
  }

  // ─── MASTER / DCA / MUTE GROUPS ─────────────────────────────────────────────

  async muteMaster()   { return this._setVerified(A.stOn, 0, 0, 'stereo master mute'); }
  async unmuteMaster() { return this._setVerified(A.stOn, 0, 1, 'stereo master unmute'); }

  async muteDca(dca)   { return this._dcaOn(dca, 0); }
  async unmuteDca(dca) { return this._dcaOn(dca, 1); }
  async _dcaOn(dca, on) {
    const n = YamahaMixer._idx(dca, this.F.dcas, 'DCA');
    return this._setVerified(A.dcaOn, n, on, `DCA ${n + 1} ${on ? 'unmute' : 'mute'}`);
  }
  async setDcaFader(dca, level) {
    const n = YamahaMixer._idx(dca, this.F.dcas, 'DCA');
    return this._setVerified(A.dcaLevel, n, normalToLevel(YamahaMixer._level(level)), `DCA ${n + 1} fader`, levelMatches);
  }

  async activateMuteGroup(mg)   { return this._muteGroup(mg, 1); }
  async deactivateMuteGroup(mg) { return this._muteGroup(mg, 0); }
  async _muteGroup(mg, on) {
    const n = YamahaMixer._idx(mg, this.F.muteGroups, 'mute group');
    return this._setVerified(A.muteMaster, n, on, `mute group ${n + 1} ${on ? 'on' : 'off'}`);
  }

  // ─── SCENES ─────────────────────────────────────────────────────────────────

  _parseScene(scene) {
    const s = String(scene ?? '').trim();
    if (this.family === 'TF') {
      const m = /^(?:([ab])[\s:._-]?)?(\d{1,2})$/i.exec(s);
      if (!m) throw new Error(`Invalid scene "${scene}" (TF: A00–A99 or B00–B99)`);
      const n = Number(m[2]);
      return { bank: `scene_${(m[1] || 'a').toLowerCase()}`, n, label: `${(m[1] || 'A').toUpperCase()}${String(n).padStart(2, '0')}` };
    }
    const n = /^\d+$/.test(s) ? Number(s) : NaN;
    if (!Number.isInteger(n) || n < this.F.sceneMin || n > this.F.sceneMax) {
      throw new Error(`Invalid scene "${scene}" (valid: ${this.F.sceneMin}–${this.F.sceneMax})`);
    }
    return { bank: 'MIXER:Lib/Scene', n, label: String(n) };
  }

  async recallScene(scene) {
    const { bank, n, label } = this._parseScene(scene);
    this._requireOnline();
    try {
      await this._req(`ssrecall_ex ${bank} ${n}`, { action: 'ssrecall_ex' }, 3000);
    } catch (e) {
      if (e.rcpError) throw new Error(`${this.model} refused scene ${label} — not recalled (empty or protected scene?)`);
      if (e.timeout) throw this._noReply(`scene ${label} recall`);
      throw e;
    }
    let cur;
    try {
      const r = await this._req(`sscurrent_ex ${bank}`, { action: 'sscurrent_ex' });
      cur = r.value;
    } catch (e) {
      if (e.timeout) throw this._noReply(`scene ${label} recall`);
      cur = undefined;
    }
    if (cur !== n) throw new Error(`${this.model} did not recall scene ${label} — console reports current scene ${cur ?? 'unknown'}`);
    this._state.scene = this.family === 'TF' ? `${bank}:${n}` : n;
    return { confirmed: true, scene: label };
  }

  // ─── NOT IN RCP (refuse honestly) ───────────────────────────────────────────

  _notAvailable(what) {
    throw new Error(`${what} is not available on Yamaha ${this.model} remote control — set it at the console`);
  }
  async setHpf()          { this._notAvailable('HPF'); }
  async setEq()           { this._notAvailable('EQ'); }
  async setCompressor()   { this._notAvailable('Compressor'); }
  async setGate()         { this._notAvailable('Gate'); }
  async saveScene()       { this._notAvailable('Scene save'); }
  async verifySceneSave() { this._notAvailable('Scene save'); }
  async clearSolos()      { this._notAvailable('Solo clear'); }
  async pressSoftKey()    { this._notAvailable('User-defined key control'); }
  async setChannelColor() { this._notAvailable('Channel colour'); }
  async setChannelIcon()  { this._notAvailable('Channel icon'); }
  async setPreampGain()   { this._notAvailable('Preamp gain'); }
  async setHeadampGain()  { this._notAvailable('Head-amp gain'); }
  async setPhantom()      { this._notAvailable('Phantom power'); }
  async setSendLevel()    { this._notAvailable('Send level'); }
  async assignToBus()     { this._notAvailable('Bus assign'); }
  async assignToDca()     { this._notAvailable('DCA assign'); }
  async getMeters()       { this._notAvailable('Metering'); }

  async setFullChannelStrip(ch, strip = {}) {
    const applied = [];
    const skipped = [];
    for (const k of ['hpf', 'eq', 'compressor', 'gate', 'color']) if (strip[k] != null && strip[k] !== false) skipped.push(k);
    if (strip.name != null) { await this.setChannelName(ch, strip.name); applied.push('name'); }
    if (strip.pan != null) { await this.setPan(ch, strip.pan); applied.push('pan'); }
    if (strip.fader != null) { await this.setFader(ch, strip.fader); applied.push('fader'); }
    if (strip.mute === true) { await this.muteChannel(ch); applied.push('mute'); }
    else if (strip.mute === false) { await this.unmuteChannel(ch); applied.push('unmute'); }
    if (skipped.length) console.warn(`🎛️  Yamaha ${this.model} Ch${ch}: skipped [${skipped.join(', ')}] — not available over RCP`);
    return { applied, skipped, unconfirmed: [] };
  }
}

module.exports = { YamahaMixer, RCP_PORT, _internals: { normalToLevel, levelToNormal, levelMatches, tokenize } };
