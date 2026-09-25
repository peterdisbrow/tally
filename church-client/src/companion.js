/**
 * Bitfocus Companion bridge — Companion 3.x/4.x/5.x HTTP API (verified against a real
 * Companion 5.0.6, see tally-linux/wip/companion/REAL-COMPANION-5.0.6-FINDINGS.md):
 *
 *   GET  /api/variable/internal/time_hms/value        liveness + fingerprint ("HH:MM:SS")
 *   POST /api/location/<page>/<row>/<col>/press       200 "ok"  | 204 = no button there
 *   GET  /api/variable/internal/b_text_<p>_<r>_<c>/value   button label (404 = none)
 *   GET  /api/variable/<label>/<name>/value           module variable (404 = unknown)
 *   GET  /api/custom-variable/<name>/value            custom variable (404 = unknown)
 *   POST /api/custom-variable/<name>/value?value=<v>  set (404 = variable doesn't exist)
 *   GET  /api/connections                             [{id,label,moduleId,enabled,status:{category,level,message}}] (5.x; 404 on older)
 *   403 on everything when Companion's HTTP API is switched off (Settings → Protocols).
 *
 * Every command reports what Companion actually answered: a press on an empty slot,
 * a missing variable, a disabled API or an unreachable Companion is an error — never "done".
 */

'use strict';

const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

const DEFAULT_URL = 'http://localhost:8000';   // Companion 3.x+ default admin/HTTP port
const GRID_ROWS = 4;
const GRID_COLS = 8;

class CompanionError extends Error {
  constructor(message, { status, unreachable, apiDisabled } = {}) {
    super(message);
    this.status = status; this.unreachable = !!unreachable; this.apiDisabled = !!apiDisabled;
  }
}

function toInt(v, what, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || (max != null && n > max)) throw new Error(`Invalid ${what} "${v}"${max != null ? ` (${min}–${max})` : ''}`);
  return n;
}

class CompanionBridge extends EventEmitter {
  constructor({ companionUrl = DEFAULT_URL, buttonPollPages = [1] } = {}) {
    super();
    this.baseUrl = String(companionUrl || DEFAULT_URL).replace(/\/$/, '');
    this.connected = false;
    this.apiDisabled = false;
    this.lastError = null;
    this.connectionCount = 0;
    this.connections = [];
    this.connectionsKnown = false;          // false on Companion builds without /api/connections
    this._pollTimer = null;
    this._buttonPollPages = buttonPollPages;
    this._recentButtonPresses = [];
    this._recentButtonPressLimit = 10;

    this._buttonIndex = new Map();
    this._buttonIndexBuiltAt = 0;
    this._buttonIndexTTL = 60 * 1000;
    this._buttonIndexBuilding = null;

    this._watchedVariables = new Map();
    this._variablePollTimer = null;
    this._variableValues = {};
  }

  // ─── HTTP ──────────────────────────────────────────────────────────────────

  _request(method, path, { timeout = 4000 } = {}) {
    // Always settles within `timeout`: a socket that dies mid-response ('close' without 'end'),
    // a request stuck waiting for a pooled socket, or a silent peer can never wedge the poller.
    return new Promise((resolve, reject) => {
      let url;
      try { url = new URL(path, this.baseUrl); } catch (e) { reject(e); return; }
      let done = false;
      const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, agent: false }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => finish(resolve, { status: res.statusCode, text: data, type: String(res.headers['content-type'] || '') }));
        res.on('error', (e) => finish(reject, e));
        res.on('close', () => { if (!res.complete) finish(reject, Object.assign(new Error('connection dropped mid-answer'), { code: 'ECONNRESET' })); });
      });
      const timer = setTimeout(() => { req.destroy(); finish(reject, Object.assign(new Error('no answer'), { code: 'ETIMEDOUT' })); }, timeout);
      req.on('error', (e) => finish(reject, e));
      req.end();
    });
  }

  /** Request that must succeed (2xx). Maps Companion's answers to honest errors. */
  async _call(method, path, what) {
    let r;
    try { r = await this._request(method, path); } catch (e) {
      throw new CompanionError(`Companion is not reachable at ${this.baseUrl} — ${what} not done (${e.code || e.message})`, { unreachable: true });
    }
    if (r.status === 403) throw new CompanionError(`Companion's HTTP API is switched off — ${what} not done (enable it in Companion → Settings → Protocols → HTTP)`, { status: 403, apiDisabled: true });
    return r;
  }

  // ─── Liveness ──────────────────────────────────────────────────────────────

  /** { ok, apiDisabled, reason }. Only a real Companion answers the internal clock variable. */
  async probe() {
    let r;
    try { r = await this._request('GET', '/api/variable/internal/time_hms/value', { timeout: 3000 }); } catch (e) {
      return { ok: false, apiDisabled: false, reason: `not reachable (${e.code || e.message})` };
    }
    if (r.status === 403) return { ok: false, apiDisabled: true, reason: 'HTTP API switched off in Companion settings' };
    if (r.status === 200 && /^\s*\d{1,2}:\d{2}:\d{2}\s*$/.test(r.text)) return { ok: true, apiDisabled: false, reason: null };
    return { ok: false, apiDisabled: false, reason: `something answered at ${this.baseUrl} but it is not Companion (HTTP ${r.status})` };
  }

  async isAvailable() {
    const p = await this.probe();
    this.connected = p.ok;
    this.apiDisabled = p.apiDisabled;
    this.lastError = p.ok ? null : p.reason;
    return p.ok;
  }

  // ─── Buttons ───────────────────────────────────────────────────────────────

  async _buttonText(page, row, col) {
    const r = await this._request('GET', `/api/variable/internal/b_text_${page}_${row}_${col}/value`);
    if (r.status === 403) throw new CompanionError('Companion\'s HTTP API is switched off', { status: 403, apiDisabled: true });
    return r.status === 200 ? r.text : null;
  }

  /** Press a button. 204 from Companion means there is no button at that location. */
  async pressButton(page, row, col) {
    const p = toInt(page, 'page', 1, 99);
    const r0 = toInt(row, 'row', 0, 99);
    const c0 = toInt(col, 'column', 0, 99);
    const where = `page ${p} row ${r0} column ${c0}`;
    const r = await this._call('POST', `/api/location/${p}/${r0}/${c0}/press`, `press ${where}`);
    if (r.status === 204) throw new CompanionError(`No button at ${where} in Companion — nothing pressed`, { status: 204 });
    if (r.status < 200 || r.status >= 300) throw new CompanionError(`Companion refused press ${where} (HTTP ${r.status})`, { status: r.status });
    let text = null;
    try { text = await this._buttonText(p, r0, c0); } catch { /* label is informational */ }
    const event = { page: p, row: r0, column: c0, text: text || '', timestamp: Date.now() };
    this._recentButtonPresses.push(event);
    if (this._recentButtonPresses.length > this._recentButtonPressLimit) this._recentButtonPresses.shift();
    this.emit('companion_button_pressed', event);
    return { success: true, page: p, row: r0, col: c0, text };
  }

  /** Labels of one page (4×8 default grid) from Companion's internal b_text variables. */
  async getButtonGrid(page) {
    const p = toInt(page ?? 1, 'page', 1, 99);
    const grid = [];
    for (let r = 0; r < GRID_ROWS; r++) {
      const row = [];
      for (let c = 0; c < GRID_COLS; c++) {
        let text = null;
        try { text = await this._buttonText(p, r, c); } catch (e) { if (e.apiDisabled) throw e; throw new CompanionError(`Companion is not reachable — cannot read page ${p}`, { unreachable: true }); }
        row.push({ row: r, col: c, text: text || '' });
      }
      grid.push(row);
    }
    return grid;
  }

  async _ensureButtonIndex(force = false) {
    if (!force && this._buttonIndex.size && Date.now() - this._buttonIndexBuiltAt < this._buttonIndexTTL) return;
    if (this._buttonIndexBuilding) { await this._buttonIndexBuilding; return; }
    this._buttonIndexBuilding = (async () => {
      const index = new Map();
      for (let page = 1; page <= 10; page++) {
        const grid = await this.getButtonGrid(page);
        for (const row of grid) for (const b of row) {
          const key = b.text.replace(/\s+/g, ' ').trim().toLowerCase();
          if (!key) continue;
          if (!index.has(key)) index.set(key, []);
          index.get(key).push({ page, row: b.row, col: b.col, text: b.text });
        }
      }
      this._buttonIndex = index;
      this._buttonIndexBuiltAt = Date.now();
    })();
    try { await this._buttonIndexBuilding; } finally { this._buttonIndexBuilding = null; }
  }

  _matchNamed(needle) {
    const exact = this._buttonIndex.get(needle);
    if (exact) return exact;
    const partial = [];
    for (const [key, locs] of this._buttonIndex) if (key.includes(needle)) partial.push(...locs);
    return partial;
  }

  /** Press by label (pages 1–10). Exact label wins; a partial match must be unique. */
  async pressNamed(name) {
    const needle = String(name ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!needle) throw new Error('Button name required');
    await this._ensureButtonIndex();
    let hits = this._matchNamed(needle);
    if (!hits.length) { await this._ensureButtonIndex(true); hits = this._matchNamed(needle); }
    if (!hits.length) throw new CompanionError(`No Companion button labelled "${name}" on pages 1–10`);
    if (hits.length > 1) throw new CompanionError(`"${name}" matches ${hits.length} Companion buttons (${hits.slice(0, 5).map((h) => `"${h.text}" p${h.page} r${h.row} c${h.col}`).join(', ')}) — nothing pressed; use the exact label or page/row/column`);
    return this.pressButton(hits[0].page, hits[0].row, hits[0].col);
  }

  getRecentButtonPresses(limit = 10) {
    return this._recentButtonPresses.slice(-Math.min(limit, this._recentButtonPresses.length)).map((e) => ({ ...e }));
  }

  // ─── Connections (Companion modules) ───────────────────────────────────────

  static _normalizeConnection(raw) {
    const st = raw?.status;
    const category = st && typeof st === 'object' ? st.category : null;
    const level = st && typeof st === 'object' ? st.level : null;
    let status;
    if (raw?.enabled === false) status = 'disabled';
    else if (category === 'good') status = 'ok';
    else if (category === 'error') status = 'error';
    else if (category === 'warning') status = 'warning';
    else status = 'unknown';
    return {
      id: String(raw?.id ?? ''),
      label: String(raw?.label ?? raw?.id ?? ''),
      moduleId: String(raw?.moduleId ?? 'unknown'),
      enabled: raw?.enabled !== false,
      status,
      detail: [level, st?.message].filter((x) => x != null && x !== '').join(': ') || null,
      hasError: status === 'error',
    };
  }

  /** Module connections with their real status. null = this Companion can't list them (pre-5.x). */
  async getConnections() {
    const r = await this._call('GET', '/api/connections', 'list connections');
    if (r.status === 404) { this.connectionsKnown = false; this.connections = []; this.connectionCount = 0; return null; }
    if (r.status !== 200) throw new CompanionError(`Companion refused the connections list (HTTP ${r.status})`, { status: r.status });
    let list;
    try { list = JSON.parse(r.text); } catch { throw new CompanionError('Companion sent an unreadable connections list'); }
    if (!Array.isArray(list)) throw new CompanionError('Companion sent an unexpected connections list');
    this.connectionsKnown = true;
    this.connections = list.map((c) => CompanionBridge._normalizeConnection(c));
    this.connectionCount = this.connections.length;
    return this.connections;
  }

  // ─── Variables ─────────────────────────────────────────────────────────────

  /** Module variable value, or null when Companion doesn't know it. Throws when Companion is unreachable. */
  async getVariable(connectionLabel, variableName) {
    const r = await this._call('GET', `/api/variable/${encodeURIComponent(connectionLabel)}/${encodeURIComponent(variableName)}/value`, `read ${connectionLabel}:${variableName}`);
    return r.status === 200 ? r.text : null;
  }

  async getCustomVariable(name) {
    const r = await this._call('GET', `/api/custom-variable/${encodeURIComponent(name)}/value`, `read custom variable "${name}"`);
    return r.status === 200 ? r.text : null;
  }

  /** Set a custom variable and read it back. Companion only sets variables that already exist. */
  async setCustomVariable(name, value) {
    const n = String(name ?? '').trim();
    if (!n) throw new Error('Custom variable name required');
    const v = String(value ?? '');
    const r = await this._call('POST', `/api/custom-variable/${encodeURIComponent(n)}/value?value=${encodeURIComponent(v)}`, `set custom variable "${n}"`);
    if (r.status === 404) throw new CompanionError(`Companion has no custom variable "${n}" — create it in Companion (Variables → Custom) first`, { status: 404 });
    if (r.status < 200 || r.status >= 300) throw new CompanionError(`Companion refused custom variable "${n}" (HTTP ${r.status})`, { status: r.status });
    const back = await this.getCustomVariable(n);
    if (back !== v) throw new CompanionError(`Companion accepted "${n}" = "${v}" but reports "${back}"`);
    return v;
  }

  watchVariable(connectionLabel, variableName) {
    const key = `${connectionLabel}:${variableName}`;
    if (this._watchedVariables.has(key)) return;
    this._watchedVariables.set(key, { connection: connectionLabel, variable: variableName, lastValue: undefined });
    if (!this._variablePollTimer) this._variablePollTimer = setInterval(() => this._pollVariables(), 2000);
  }

  unwatchVariable(connectionLabel, variableName) {
    this._watchedVariables.delete(`${connectionLabel}:${variableName}`);
    if (!this._watchedVariables.size && this._variablePollTimer) { clearInterval(this._variablePollTimer); this._variablePollTimer = null; }
  }

  getWatchedVariables() {
    const out = {};
    for (const e of this._watchedVariables.values()) { (out[e.connection] ||= {})[e.variable] = e.lastValue ?? null; }
    return out;
  }

  async _pollVariables() {
    if (!this.connected) return;
    for (const e of this._watchedVariables.values()) {
      let value;
      try { value = await this.getVariable(e.connection, e.variable); } catch { continue; }
      if (value === e.lastValue) continue;
      const prev = e.lastValue;
      e.lastValue = value;
      (this._variableValues[e.connection] ||= {})[e.variable] = value;
      if (prev !== undefined) this.emit('variable_changed', { connection: e.connection, variable: e.variable, value, previousValue: prev, timestamp: Date.now() });
    }
  }

  autoWatchConnections() {
    const PROFILES = {
      'bmd-atem': ['pgm1_input', 'pvw1_input', 'stream', 'record'],
      'obs-studio': ['scene_active', 'streaming', 'recording'],
      'renewedvision-propresenter': ['current_slide', 'current_presentation_name'],
    };
    for (const c of this.connections) {
      const profile = PROFILES[String(c.moduleId || '').toLowerCase()];
      if (profile && c.enabled) for (const v of profile) this.watchVariable(c.label || c.id, v);
    }
  }

  stopVariablePolling() {
    if (this._variablePollTimer) { clearInterval(this._variablePollTimer); this._variablePollTimer = null; }
    this._watchedVariables.clear();
    this._variableValues = {};
  }

  // ─── Polling ───────────────────────────────────────────────────────────────

  /** Liveness every intervalMs; emits 'connected'/'disconnected'/'connectionsChanged'. */
  startPolling(intervalMs = 3000) {
    this.stopPolling({ keepVariables: true });
    let busy = false;
    const tick = async () => {
      if (busy) return; busy = true;
      try {
        const was = this.connected;
        const ok = await this.isAvailable();
        if (ok) {
          const before = JSON.stringify(this.connections);
          try { await this.getConnections(); } catch { /* keep last list */ }
          if (JSON.stringify(this.connections) !== before) this.emit('connectionsChanged', this.connections);
        } else { this.connections = []; this.connectionCount = 0; }
        if (ok && !was) this.emit('connected');
        if (!ok && was) this.emit('disconnected', this.lastError);
        const key = `${this.connected}|${this.apiDisabled}|${this.lastError}`;
        if (key !== this._lastStateKey) { this._lastStateKey = key; this.emit('stateChanged', this.getStatus()); }
      } finally { busy = false; }
    };
    this._pollTimer = setInterval(tick, intervalMs);
    return tick();
  }

  getStatus() {
    return {
      connected: this.connected,
      apiDisabled: this.apiDisabled,
      error: this.connected ? null : this.lastError,
      connectionsKnown: this.connectionsKnown,
      connectionCount: this.connectionCount,
      connections: this.connections.map((c) => ({ id: c.id, label: c.label, moduleId: c.moduleId, status: c.status, detail: c.detail })),
      recentPresses: this.getRecentButtonPresses(),
      variables: this._variableValues,
    };
  }

  stopPolling({ keepVariables = false } = {}) {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    if (!keepVariables) this.stopVariablePolling();
  }
}

module.exports = { CompanionBridge, CompanionError, DEFAULT_URL };
