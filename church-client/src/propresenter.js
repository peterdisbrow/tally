/**
 * ProPresenter Integration (PP7 / PP 21.x+) — official /v1 REST API, default port 1025.
 * Paths and methods follow Renewed Vision's published OpenAPI spec
 * (openapi.propresenter.com): triggers are GET and answer 204; unknown ids → 404.
 *
 * Honesty contract (same as the mixer drivers):
 *   • every command checks the HTTP status — a 404/500/timeout is an error, never "done";
 *   • where PP exposes the resulting state, the command reads it back and only
 *     succeeds when PP reports the change (slide index, look, timer state, layers,
 *     audience/stage screens, message/prop active, capture status, transport);
 *   • "running" means /version answered like ProPresenter, not "something on port 1025";
 *   • status never shows stale slide data after PP stops answering;
 *   • backup-PP mirroring is awaited and its outcome recorded in `lastMirror`
 *     (commands report "backup did not follow" instead of pretending).
 * Real-time slide updates via 2 s polling (PP 21 removed Remote Classic).
 */

'use strict';

const { EventEmitter } = require('events');

const TIMER_STATES = { running: 'Running', stopped: 'Stopped', complete: 'Complete', overrunning: 'Overrun', overran: 'Overran' };
const LAYERS = ['audio', 'props', 'messages', 'announcements', 'slide', 'media', 'video_input'];
const TRANSPORT_LAYERS = ['presentation', 'announcement', 'audio'];
const VERIFY_MS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idOf = (x) => x?.id?.uuid || x?.uuid || (typeof x?.id === 'string' ? x.id : null);
const nameOf = (x) => x?.id?.name || x?.name || 'Untitled';
const matchName = (list, nameOrId) => {
  const s = String(nameOrId ?? '').trim();
  const lc = s.toLowerCase();
  return list.find((x) => x.id === s) || list.find((x) => (x.name || '').toLowerCase() === lc) || null;
};

class PPError extends Error {
  constructor(message, { status, unreachable } = {}) { super(message); this.status = status; this.unreachable = !!unreachable; }
}

class ProPresenter extends EventEmitter {
  constructor({ host = 'localhost', port = 1025, triggerMode = 'presentation', backupHost, backupPort, isBackup = false } = {}) {
    super();
    this.host = host;
    this.port = Number(port) || 1025;
    this.triggerMode = triggerMode === 'playlist' ? 'playlist' : 'presentation';
    this.connected = false;
    this.running = false;
    this._isBackup = isBackup;
    this._pollAbort = null;
    this._reconnectTimer = null;
    this._reconnectDelay = 5000;
    this._pollInterval = null;
    this._currentSlide = null;
    this._version = null;
    this._activeLook = null;
    this._activeTimers = [];
    this._videoCountdown = null;
    this._screenStatus = null;
    this._playlistFocused = null;
    this.lastMirror = null;
    this._backup = backupHost ? new ProPresenter({ host: backupHost, port: backupPort || 1025, triggerMode, isBackup: true }) : null;
  }

  get baseUrl() { return `http://${this.host}:${this.port}`; }

  // ─── HTTP ──────────────────────────────────────────────────────────────

  /** Request that must succeed. Returns parsed JSON (or null for 204 / empty). */
  async _req(method, path, { body, label, timeout = 5000 } = {}) {
    const what = label || `${method} ${path}`;
    let resp;
    try {
      resp = await fetch(`${this.baseUrl}${path}`, {
        method,
        signal: AbortSignal.timeout(timeout),
        ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
      });
    } catch (e) {
      throw new PPError(`ProPresenter${this._isBackup ? ' (backup)' : ''} is not reachable — ${what} not done (${e.name === 'TimeoutError' ? 'no answer' : e.cause?.code || e.message})`, { unreachable: true });
    }
    const text = await resp.text().catch(() => '');
    if (!resp.ok) {
      const hint = resp.status === 404 ? 'not found in ProPresenter' : `HTTP ${resp.status}`;
      throw new PPError(`ProPresenter refused ${what} (${hint})`, { status: resp.status });
    }
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  }

  /** Best-effort read for status/polling: null on any failure. */
  async _fetch(path) {
    try { return await this._req('GET', path, { timeout: 4000 }); } catch { return null; }
  }

  /** Legacy helper name kept for callers: a GET trigger that must succeed. */
  async _fire(path, options = {}) {
    await this._req(options.method || 'GET', path, { body: options.body !== undefined ? JSON.parse(options.body) : undefined });
    return true;
  }

  /** Mirror to the backup PP; awaited, never throws, outcome in this.lastMirror. */
  async _mirror(method, path, body) {
    if (!this._backup) return;
    try {
      await this._backup._req(method, path, { body, timeout: 3000 });
      this.lastMirror = { ok: true };
    } catch (e) {
      this.lastMirror = { ok: false, error: e.message };
    }
  }

  async _cmd(method, path, { body, label, mirror = true } = {}) {
    await this._req(method, path, { body, label });
    if (mirror) await this._mirror(method, path, body);
  }

  /** Poll `read` until `ok(value)` or VERIFY_MS elapses; returns the last value. */
  async _until(read, ok, ms = VERIFY_MS) {
    const t0 = Date.now();
    let v;
    do {
      v = await read();
      if (ok(v)) return { ok: true, v };
      await sleep(100);
    } while (Date.now() - t0 < ms);
    return { ok: false, v };
  }

  // ─── LIVENESS / VERSION ────────────────────────────────────────────────

  async isRunning() {
    const v = await this._fetch('/version');
    const ok = !!(v && typeof v === 'object' && (v.api_version || /propresenter/i.test(v.host_description || '')));
    if (ok) this._version = v.host_description || v.api_version;
    this.running = ok;
    return ok;
  }

  async getVersion() {
    const v = await this._fetch('/version');
    if (!v || typeof v !== 'object' || !(v.api_version || v.host_description)) return null;
    this._version = v.host_description || `API ${v.api_version}`;
    return this._version;
  }

  // ─── SLIDES ────────────────────────────────────────────────────────────

  async _slideIndex() {
    const d = await this._fetch('/v1/presentation/slide_index');
    if (!d || typeof d !== 'object') return undefined;             // unknown
    const pi = d.presentation_index;
    if (!pi) return null;                                          // nothing on screen
    return { index: pi.index, uuid: pi.presentation_id?.uuid || null, name: pi.presentation_id?.name || null };
  }

  async _slideCount(uuid) {
    if (!uuid) return null;
    const d = await this._fetch(`/v1/presentation/${encodeURIComponent(uuid)}`);
    const p = d?.presentation || d;
    if (!p || !Array.isArray(p.groups)) return null;
    return p.groups.reduce((a, g) => a + (Array.isArray(g.slides) ? g.slides.length : 0), 0);
  }

  async getCurrentSlide() {
    const si = await this._slideIndex();
    if (si === undefined) { if (!this.connected) this._currentSlide = null; return this.connected ? this._currentSlide : null; }
    if (si === null) { this._currentSlide = null; return { presentationName: null, presentationUUID: null, slideIndex: null, slideTotal: null, slideNotes: '', onScreen: false }; }
    const total = this._currentSlide?.presentationUUID === si.uuid && this._currentSlide.slideTotal != null
      ? this._currentSlide.slideTotal : await this._slideCount(si.uuid);
    const st = await this._fetch('/v1/status/slide');
    this._currentSlide = {
      presentationName: si.name, presentationUUID: si.uuid, slideIndex: si.index,
      slideTotal: total, slideNotes: st?.current?.notes || '', onScreen: true,
    };
    return this._currentSlide;
  }

  async _verifyMoved(before, label) {
    const r = await this._until(() => this._slideIndex(), (s) => s && (!before || s.index !== before.index || s.uuid !== before.uuid));
    if (!r.ok) {
      if (r.v === undefined) throw new PPError(`ProPresenter stopped answering — cannot confirm ${label}`);
      throw new PPError(`ProPresenter accepted ${label} but the slide did not change${before ? ` (still slide ${before.index + 1} of "${before.name}" — end of presentation?)` : ' (nothing on screen)'}`);
    }
    return r.v;
  }

  async nextSlide() {
    const before = await this._slideIndex();
    const path = this.triggerMode === 'playlist' ? '/v1/trigger/next' : '/v1/presentation/focused/next/trigger';
    await this._cmd('GET', path, { label: 'next slide' });
    return this._verifyMoved(before, 'next slide');
  }

  async previousSlide() {
    const before = await this._slideIndex();
    const path = this.triggerMode === 'playlist' ? '/v1/trigger/previous' : '/v1/presentation/focused/previous/trigger';
    await this._cmd('GET', path, { label: 'previous slide' });
    return this._verifyMoved(before, 'previous slide');
  }

  async goToSlide(index) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0) throw new Error(`Invalid slide "${index}"`);
    await this._cmd('GET', `/v1/presentation/focused/${i}/trigger`, { label: `slide ${i + 1}` });
    const r = await this._until(() => this._slideIndex(), (s) => s && s.index === i);
    if (!r.ok) throw new PPError(`ProPresenter accepted slide ${i + 1} but reports ${r.v ? `slide ${r.v.index + 1}` : r.v === null ? 'nothing on screen' : 'no answer'}`);
    return r.v;
  }

  async getPlaylist() {
    const data = await this._fetch('/v1/playlists');
    if (!Array.isArray(data)) return [];
    const out = [];
    const walk = (list) => { for (const it of list || []) { out.push({ name: nameOf(it), id: idOf(it), type: it.type || 'playlist' }); if (Array.isArray(it.playlists)) walk(it.playlists); } };
    walk(data);
    return out;
  }

  // ─── RICH STATUS ───────────────────────────────────────────────────────

  async getActiveLook() {
    const d = await this._fetch('/v1/look/current');
    if (!d || typeof d !== 'object') return null;
    const look = { id: idOf(d), name: nameOf(d) };
    const prev = this._activeLook;
    this._activeLook = look;
    if (prev && prev.id !== look.id) this.emit('lookChanged', look);
    return look;
  }

  async getTimerStatus() {
    const d = await this._fetch('/v1/timers/current');
    if (!Array.isArray(d)) return this.connected ? this._activeTimers : [];
    const list = d.map((t) => ({ id: idOf(t), name: nameOf(t), time: t.time || '00:00:00', state: TIMER_STATES[String(t.state || '').toLowerCase()] || 'Stopped' }));
    const prev = this._activeTimers;
    this._activeTimers = list;
    if (JSON.stringify(prev.map((t) => `${t.id}:${t.state}`)) !== JSON.stringify(list.map((t) => `${t.id}:${t.state}`))) this.emit('timerUpdate', list);
    return list;
  }

  async getVideoCountdown() {
    const cur = await this._fetch('/v1/transport/presentation/current');
    if (!cur || typeof cur !== 'object' || !cur.duration || !cur.name) { this._videoCountdown = null; return null; }
    const t = await this._fetch('/v1/transport/presentation/time');
    const elapsed = Number.isFinite(t) ? t : 0;
    const remaining = Math.max(0, cur.duration - elapsed);
    const fmt = (sec) => { const s = Math.floor(sec); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60; return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`; };
    this._videoCountdown = { name: cur.name, time: fmt(remaining), elapsed: fmt(elapsed), duration: fmt(cur.duration), remaining, isPlaying: !!cur.is_playing };
    return this._videoCountdown;
  }

  async getAudienceScreenStatus() {
    const a = await this._fetch('/v1/status/audience_screens');
    const s = await this._fetch('/v1/status/stage_screens');
    if (typeof a !== 'boolean' && typeof s !== 'boolean') { this._screenStatus = null; return null; }
    const status = { audience: typeof a === 'boolean' ? a : null, stage: typeof s === 'boolean' ? s : null };
    const prev = this._screenStatus;
    this._screenStatus = status;
    if (prev && (prev.audience !== status.audience || prev.stage !== status.stage)) this.emit('screenStateChanged', status);
    return status;
  }

  async getPlaylistFocused() {
    const d = await this._fetch('/v1/playlist/focused');
    if (!d || typeof d !== 'object' || !d.playlist) { this._playlistFocused = null; return null; }
    this._playlistFocused = { name: d.playlist.name || null, uuid: d.playlist.uuid || null, index: d.item?.index ?? null, item: d.item?.name || null };
    return this._playlistFocused;
  }

  async _layers() { return this._fetch('/v1/status/layers'); }

  // ─── LIBRARIES / THUMBNAILS ────────────────────────────────────────────

  async getLibraries() {
    const libs = await this._fetch('/v1/libraries');
    if (!Array.isArray(libs)) return [];
    const result = [];
    for (const lib of libs) {
      const libId = idOf(lib);
      const items = await this._fetch(`/v1/library/${encodeURIComponent(libId)}`);
      result.push({ id: libId, name: nameOf(lib), presentations: (items?.items || []).map((p) => ({ id: idOf(p), name: nameOf(p) })) });
    }
    return result;
  }

  async getThumbnail(presentationUUID, slideIndex) {
    try {
      const resp = await fetch(`${this.baseUrl}/v1/presentation/${encodeURIComponent(presentationUUID)}/thumbnail/${slideIndex}`, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return null;
      return Buffer.from(await resp.arrayBuffer()).toString('base64');
    } catch { return null; }
  }

  // ─── CLEAR ─────────────────────────────────────────────────────────────

  async _clearLayers(layers, label) {
    for (const l of layers) await this._cmd('GET', `/v1/clear/layer/${l}`, { label: `clear ${l}` });
    const r = await this._until(() => this._layers(), (s) => s && layers.every((l) => s[l] === false));
    if (!r.ok) {
      if (!r.v) throw new PPError(`ProPresenter did not report its layers — cannot confirm ${label}`);
      throw new PPError(`ProPresenter accepted ${label} but still shows: ${layers.filter((l) => r.v[l]).join(', ')}`);
    }
    return true;
  }
  async clearAll()          { return this._clearLayers(['slide', 'media', 'props', 'messages'], 'clear all'); }
  async clearSlide()        { return this._clearLayers(['slide'], 'clear slide'); }
  async clearMessages()     { return this._clearLayers(['messages'], 'clear messages'); }
  async clearProps()        { return this._clearLayers(['props'], 'clear props'); }
  async clearMedia()        { return this._clearLayers(['media'], 'clear media'); }
  async clearAudio()        { return this._clearLayers(['audio'], 'clear audio'); }
  async clearAnnouncements() { return this._clearLayers(['announcements'], 'clear announcements'); }

  // ─── MESSAGES ──────────────────────────────────────────────────────────

  async getMessages() {
    const d = await this._fetch('/v1/messages');
    return Array.isArray(d) ? d.map((m) => ({ id: idOf(m), name: nameOf(m), active: m.is_active === true })) : [];
  }

  async _find(listFn, nameOrId, what) {
    const list = await listFn();
    const found = matchName(list, nameOrId);
    if (!found) throw new Error(`${what} "${nameOrId}" not found in ProPresenter${list.length ? `. Available: ${list.map((x) => x.name).join(', ')}` : ' (or ProPresenter is not answering)'}`);
    return found;
  }

  async triggerMessage(idOrName, tokens = []) {
    const msg = await this._find(() => this.getMessages(), idOrName, 'Message');
    const body = Array.isArray(tokens) && tokens.length ? tokens : undefined;
    await this._cmd('POST', `/v1/message/${encodeURIComponent(msg.id)}/trigger`, { body, label: `message "${msg.name}"` });
    const r = await this._until(() => this.getMessages(), (l) => l.some((m) => m.id === msg.id && m.active));
    if (!r.ok) throw new PPError(`ProPresenter accepted message "${msg.name}" but does not report it as showing`);
    return msg.name;
  }

  async toggleStageMessage(nameOrId) {
    const msg = await this._find(() => this.getMessages(), nameOrId, 'Message');
    if (msg.active) {
      await this._cmd('GET', `/v1/message/${encodeURIComponent(msg.id)}/clear`, { label: `clear message "${msg.name}"` });
      const r = await this._until(() => this.getMessages(), (l) => l.some((m) => m.id === msg.id && !m.active));
      if (!r.ok) throw new PPError(`ProPresenter accepted clearing "${msg.name}" but still shows it`);
      return `Message "${msg.name}" hidden`;
    }
    await this.triggerMessage(msg.id);
    return `Message "${msg.name}" showing`;
  }

  // ─── LOOKS ─────────────────────────────────────────────────────────────

  async getLooks() {
    const d = await this._fetch('/v1/looks');
    return Array.isArray(d) ? d.map((l) => ({ id: idOf(l), name: nameOf(l) })) : [];
  }

  async setLook(nameOrId) {
    const look = await this._find(() => this.getLooks(), nameOrId, 'Look');
    await this._cmd('GET', `/v1/look/${encodeURIComponent(look.id)}/trigger`, { label: `look "${look.name}"` });
    const r = await this._until(() => this.getActiveLook(), (l) => l && l.id === look.id);
    if (!r.ok) throw new PPError(`ProPresenter accepted look "${look.name}" but reports "${r.v?.name ?? 'unknown'}"`);
    return look.name;
  }

  // ─── TIMERS ────────────────────────────────────────────────────────────

  async getTimers() {
    const d = await this._fetch('/v1/timers');
    return Array.isArray(d) ? d.map((t) => ({ id: idOf(t), name: nameOf(t), allows_overrun: !!t.allows_overrun })) : [];
  }

  async _timerOp(nameOrId, op, want) {
    const t = await this._find(() => this.getTimers(), nameOrId, 'Timer');
    await this._cmd('GET', `/v1/timer/${encodeURIComponent(t.id)}/${op}`, { label: `${op} timer "${t.name}"` });
    if (want) {
      const r = await this._until(() => this.getTimerStatus(), (l) => l.some((x) => x.id === t.id && want.includes(x.state)));
      if (!r.ok) throw new PPError(`ProPresenter accepted ${op} for timer "${t.name}" but reports it ${(r.v || []).find((x) => x.id === t.id)?.state || 'unknown'}`);
    }
    return t.name;
  }
  async startTimer(nameOrId) { return this._timerOp(nameOrId, 'start', ['Running', 'Overrun']); }
  async stopTimer(nameOrId)  { return this._timerOp(nameOrId, 'stop', ['Stopped', 'Complete', 'Overran']); }
  async resetTimer(nameOrId) { return this._timerOp(nameOrId, 'reset', null); }

  async createTimer(name, settings = {}) {
    const n = String(name ?? '').trim();
    if (!n) throw new Error('Timer name required');
    const body = { name: n, allows_overrun: !!settings.allowsOverrun };
    if (settings.countdownDuration != null) {
      const d = Number(settings.countdownDuration);
      if (!Number.isInteger(d) || d <= 0) throw new Error(`Invalid duration "${settings.countdownDuration}" (whole seconds)`);
      body.countdown = { duration: d };
    }
    await this._req('POST', '/v1/timers', { body, label: `create timer "${n}"` });
    const r = await this._until(() => this.getTimers(), (l) => l.some((t) => t.name === n));
    if (!r.ok) throw new PPError(`ProPresenter accepted timer "${n}" but it is not in the timer list`);
    return n;
  }

  async incrementTimer(nameOrId, seconds = 30) {
    const s = Number(seconds);
    if (!Number.isInteger(s)) throw new Error(`Invalid seconds "${seconds}"`);
    const t = await this._find(() => this.getTimers(), nameOrId, 'Timer');
    await this._cmd('GET', `/v1/timer/${encodeURIComponent(t.id)}/increment/${s}`, { label: `increment timer "${t.name}"` });
    return t.name;
  }

  async setTimerValue(nameOrId, settings = {}) {
    const t = await this._find(() => this.getTimers(), nameOrId, 'Timer');
    const body = { id: { uuid: t.id, name: settings.name || t.name }, allows_overrun: settings.overrun !== undefined ? !!settings.overrun : t.allows_overrun };
    if (settings.duration != null) {
      const d = Number(settings.duration);
      if (!Number.isInteger(d) || d <= 0) throw new Error(`Invalid duration "${settings.duration}" (whole seconds)`);
      body.countdown = { duration: d };
    }
    await this._cmd('PUT', `/v1/timer/${encodeURIComponent(t.id)}`, { body, label: `update timer "${t.name}"` });
    return body.id.name;
  }

  // ─── PRESENTATIONS / PLAYLISTS ─────────────────────────────────────────

  async triggerPresentation(nameOrUUID) {
    const libs = await this.getLibraries();
    const all = libs.flatMap((l) => l.presentations);
    const found = matchName(all, nameOrUUID);
    if (!found) throw new Error(`Presentation "${nameOrUUID}" not found in any ProPresenter library${all.length ? '' : ' (or ProPresenter is not answering)'}`);
    await this._cmd('GET', `/v1/presentation/${encodeURIComponent(found.id)}/trigger`, { label: `presentation "${found.name}"` });
    const r = await this._until(() => this._slideIndex(), (s) => s && s.uuid === found.id);
    if (!r.ok) throw new PPError(`ProPresenter accepted "${found.name}" but it is not on screen`);
    return found.name;
  }

  async triggerPlaylistItem(playlistName, itemIndex = 0) {
    const i = Number(itemIndex);
    if (!Number.isInteger(i) || i < 0) throw new Error(`Invalid playlist item "${itemIndex}"`);
    const pl = await this._find(() => this.getPlaylist(), playlistName, 'Playlist');
    await this._cmd('GET', `/v1/playlist/${encodeURIComponent(pl.id)}/${i}/trigger`, { label: `playlist "${pl.name}" item ${i}` });
    const r = await this._until(() => this.getPlaylistFocused(), (f) => f && f.uuid === pl.id && f.index === i);
    if (!r.ok) throw new PPError(`ProPresenter accepted playlist "${pl.name}" item ${i} but reports ${r.v ? `"${r.v.name}" item ${r.v.index}` : 'no focused playlist'}`);
    return pl.name;
  }

  async triggerLibraryCue(libraryId, presentationId, cueIndex = 0) {
    const i = Number(cueIndex);
    if (!Number.isInteger(i) || i < 0) throw new Error(`Invalid cue "${cueIndex}"`);
    await this._cmd('GET', `/v1/library/${encodeURIComponent(libraryId)}/${encodeURIComponent(presentationId)}/${i}/trigger`, { label: 'library cue' });
    const r = await this._until(() => this._slideIndex(), (s) => s && s.uuid === presentationId && s.index === i);
    if (!r.ok) throw new PPError('ProPresenter accepted the library cue but it is not on screen');
    return true;
  }

  // ─── PROPS / GROUPS / MACROS ───────────────────────────────────────────

  async getProps() {
    const d = await this._fetch('/v1/props');
    return Array.isArray(d) ? d.map((p) => ({ id: idOf(p), name: nameOf(p), active: p.is_active === true })) : [];
  }

  async _propSet(nameOrId, on) {
    const p = await this._find(() => this.getProps(), nameOrId, 'Prop');
    await this._cmd('GET', `/v1/prop/${encodeURIComponent(p.id)}/${on ? 'trigger' : 'clear'}`, { label: `${on ? 'show' : 'clear'} prop "${p.name}"` });
    const r = await this._until(() => this.getProps(), (l) => l.some((x) => x.id === p.id && x.active === on));
    if (!r.ok) throw new PPError(`ProPresenter accepted prop "${p.name}" but reports it ${on ? 'not showing' : 'still showing'}`);
    return p;
  }
  async triggerProp(nameOrId) { return (await this._propSet(nameOrId, true)).name; }
  async toggleProp(nameOrId) {
    const p = await this._find(() => this.getProps(), nameOrId, 'Prop');
    await this._propSet(p.id, !p.active);
    return p.name;
  }

  async getGroups() {
    const d = await this._fetch('/v1/groups');
    return Array.isArray(d) ? d.map((g) => ({ id: idOf(g), name: nameOf(g), color: g.color || null })) : [];
  }

  /** Name of the group the given cue index falls in (from /v1/presentation/{uuid}), or null. */
  async _groupAt(uuid, index) {
    const d = await this._fetch(`/v1/presentation/${encodeURIComponent(uuid)}`);
    const p = d?.presentation || d;
    if (!p || !Array.isArray(p.groups)) return null;
    let i = 0;
    for (const g of p.groups) { const n = Array.isArray(g.slides) ? g.slides.length : 0; if (index >= i && index < i + n) return g.name ?? null; i += n; }
    return null;
  }

  async triggerGroup(nameOrId) {
    const g = await this._find(() => this.getGroups(), nameOrId, 'Group');
    await this._cmd('GET', `/v1/presentation/focused/group/${encodeURIComponent(g.id)}/trigger`, { label: `group "${g.name}"` });
    // Confirmed only when the cue on screen belongs to that group.
    const r = await this._until(async () => { const s = await this._slideIndex(); return s ? { s, group: await this._groupAt(s.uuid, s.index) } : s; },
      (v) => v && v.group === g.name);
    if (!r.ok) throw new PPError(`ProPresenter accepted group "${g.name}" but ${r.v ? `slide ${r.v.s.index + 1} (${r.v.group || 'no group'}) is on screen` : r.v === null ? 'nothing is on screen' : 'stopped answering'}`);
    return g.name;
  }

  async getMacros() {
    const d = await this._fetch('/v1/macros');
    return Array.isArray(d) ? d.map((m) => ({ id: idOf(m), name: nameOf(m) })) : [];
  }

  /** Macros have no readable state in the API — success means PP accepted it (HTTP 204). */
  async triggerMacro(nameOrId) {
    const m = await this._find(() => this.getMacros(), nameOrId, 'Macro');
    await this._cmd('GET', `/v1/macro/${encodeURIComponent(m.id)}/trigger`, { label: `macro "${m.name}"` });
    return m.name;
  }

  // ─── ANNOUNCEMENTS ─────────────────────────────────────────────────────

  async nextAnnouncement()     { await this._cmd('GET', '/v1/announcement/active/next/trigger', { label: 'next announcement' }); return true; }
  async previousAnnouncement() { await this._cmd('GET', '/v1/announcement/active/previous/trigger', { label: 'previous announcement' }); return true; }

  async getAnnouncementStatus() {
    const a = await this._fetch('/v1/announcement/active');
    const p = a?.announcement;
    if (!p) return null;
    const si = await this._fetch('/v1/announcement/slide_index');
    return {
      presentationName: nameOf(p),
      slideIndex: si?.announcement_index?.index ?? 0,
      slideCount: (p.groups || []).reduce((n, g) => n + (g.slides?.length || 0), 0),
    };
  }

  // ─── STAGE ─────────────────────────────────────────────────────────────

  async getStageLayouts() {
    const d = await this._fetch('/v1/stage/layouts');
    return Array.isArray(d) ? d.map((l) => ({ id: idOf(l), name: nameOf(l) })) : [];
  }

  async setStageLayout(nameOrId, screenIndex = 0) {
    const layout = await this._find(() => this.getStageLayouts(), nameOrId, 'Stage layout');
    const screens = await this._fetch('/v1/stage/screens');
    const list = Array.isArray(screens) ? screens.map((s) => ({ id: idOf(s), name: nameOf(s), index: s.id?.index ?? s.index })) : [];
    const si = Number(screenIndex);
    const screen = list.find((s) => s.index === si) || list[si];
    if (!screen) throw new Error(`Stage screen ${screenIndex} not found${list.length ? ` (have: ${list.map((s, i) => `${i}=${s.name}`).join(', ')})` : ''}`);
    await this._cmd('GET', `/v1/stage/screen/${encodeURIComponent(screen.id)}/layout/${encodeURIComponent(layout.id)}`, { label: `stage layout "${layout.name}" on ${screen.name}` });
    const r = await this._until(() => this._fetch(`/v1/stage/screen/${encodeURIComponent(screen.id)}/layout`), (l) => l && idOf(l) === layout.id);
    if (!r.ok) throw new PPError(`ProPresenter accepted stage layout "${layout.name}" but ${screen.name} reports "${r.v ? nameOf(r.v) : 'unknown'}"`);
    return layout.name;
  }

  // ─── SCREENS ───────────────────────────────────────────────────────────

  async _setScreens(kind, on) {
    const v = !!on;
    const path = `/v1/status/${kind}_screens`;
    await this._cmd('PUT', path, { body: v, label: `${kind} screens ${v ? 'on' : 'off'}` });
    const r = await this._until(() => this._fetch(path), (x) => x === v);
    if (!r.ok) throw new PPError(`ProPresenter accepted ${kind} screens ${v ? 'on' : 'off'} but reports ${typeof r.v === 'boolean' ? (r.v ? 'on' : 'off') : 'unknown'}`);
    return v;
  }
  async setAudienceScreens(on) { const v = await this._setScreens('audience', on); return v ? 'Audience screens ON' : 'Audience screens OFF'; }
  async toggleAudienceScreens() {
    const cur = await this._fetch('/v1/status/audience_screens');
    if (typeof cur !== 'boolean') throw new PPError('ProPresenter did not report the audience screen state — not toggled');
    return this.setAudienceScreens(!cur);
  }
  async toggleStageScreens() {
    const cur = await this._fetch('/v1/status/stage_screens');
    if (typeof cur !== 'boolean') throw new PPError('ProPresenter did not report the stage screen state — not toggled');
    const v = await this._setScreens('stage', !cur);
    return v ? 'Stage screens ON' : 'Stage screens OFF';
  }

  // ─── VIDEO INPUTS ──────────────────────────────────────────────────────

  async triggerVideoInput(nameOrId) {
    const d = await this._fetch('/v1/video_inputs');
    const list = Array.isArray(d) ? d.map((v) => ({ id: idOf(v), name: nameOf(v) })) : [];
    const vi = matchName(list, nameOrId);
    if (!vi) throw new Error(`Video input "${nameOrId}" not found in ProPresenter${list.length ? `. Available: ${list.map((x) => x.name).join(', ')}` : ''}`);
    await this._cmd('GET', `/v1/video_inputs/${encodeURIComponent(vi.id)}/trigger`, { label: `video input "${vi.name}"` });
    const r = await this._until(() => this._layers(), (s) => s && s.video_input === true);
    if (!r.ok) throw new PPError(`ProPresenter accepted video input "${vi.name}" but the video input layer is not active`);
    return true;
  }

  // ─── AUDIO / MEDIA PLAYLISTS ───────────────────────────────────────────

  async _playlists(kind) {
    const d = await this._fetch(`/v1/${kind}/playlists`);
    const out = [];
    const walk = (l) => { for (const p of l || []) { out.push({ id: idOf(p), name: nameOf(p) }); if (Array.isArray(p.children)) walk(p.children); } };
    if (Array.isArray(d)) walk(d);
    return out;
  }
  static _action(action) {
    const a = String(action || 'next').trim().toLowerCase();
    if (!['next', 'previous'].includes(a)) throw new Error(`Invalid action "${action}" (next or previous)`);
    return a;
  }
  async _plTrigger(kind, which, action) {
    const a = ProPresenter._action(action);
    await this._cmd('GET', `/v1/${kind}/playlist/${which}/${a}/trigger`, { label: `${which} ${kind} playlist ${a}` });
    return true;
  }
  async _plById(kind, nameOrId, op) {
    const pl = await this._find(() => this._playlists(kind), nameOrId, `${kind === 'audio' ? 'Audio' : 'Media'} playlist`);
    await this._cmd('GET', `/v1/${kind}/playlist/${encodeURIComponent(pl.id)}/${op}`, { label: `${op} ${kind} playlist "${pl.name}"` });
    return pl.name;
  }
  async getAudioPlaylists()                  { return this._playlists('audio'); }
  async activeAudioPlaylistTrigger(action)   { return this._plTrigger('audio', 'active', action); }
  async focusedAudioPlaylistTrigger(action)  { return this._plTrigger('audio', 'focused', action); }
  async audioPlaylistFocus(nameOrId)         { return this._plById('audio', nameOrId, 'focus'); }
  async audioPlaylistTrigger(nameOrId)       { return this._plById('audio', nameOrId, 'trigger'); }
  async getMediaPlaylists()                  { return this._playlists('media'); }
  async activeMediaPlaylistTrigger(action)   { return this._plTrigger('media', 'active', action); }
  async focusedMediaPlaylistTrigger(action)  { return this._plTrigger('media', 'focused', action); }
  async mediaPlaylistFocus(nameOrId)         { return this._plById('media', nameOrId, 'focus'); }
  async mediaPlaylistTrigger(nameOrId)       { return this._plById('media', nameOrId, 'trigger'); }

  // ─── TRANSPORT / TIMELINE / CAPTURE ────────────────────────────────────

  static _layer(layer) {
    const l = String(layer || 'presentation').trim().toLowerCase();
    if (!TRANSPORT_LAYERS.includes(l)) throw new Error(`Invalid transport layer "${layer}" (presentation, announcement or audio)`);
    return l;
  }
  async _transportPlaying(l, want, label) {
    const r = await this._until(() => this._fetch(`/v1/transport/${l}/current`), (c) => c && c.is_playing === want);
    if (!r.ok) throw new PPError(`ProPresenter accepted ${label} but reports ${r.v ? (r.v.is_playing ? 'playing' : 'paused') : 'nothing loaded on that layer'}`);
  }
  async transportPlay(layer = 'presentation') {
    const l = ProPresenter._layer(layer);
    await this._cmd('GET', `/v1/transport/${l}/play`, { label: `${l} play` });
    await this._transportPlaying(l, true, `${l} play`);
    return true;
  }
  async transportPause(layer = 'presentation') {
    const l = ProPresenter._layer(layer);
    await this._cmd('GET', `/v1/transport/${l}/pause`, { label: `${l} pause` });
    await this._transportPlaying(l, false, `${l} pause`);
    return true;
  }
  async _seconds(v, what = 'seconds') {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid ${what} "${v}"`);
    return n;
  }
  async transportSkipForward(layer = 'presentation', seconds = 10) {
    const l = ProPresenter._layer(layer); const s = Math.round(await this._seconds(seconds));
    await this._cmd('GET', `/v1/transport/${l}/skip_forward/${s}`, { label: `${l} skip forward` }); return true;
  }
  async transportSkipBackward(layer = 'presentation', seconds = 10) {
    const l = ProPresenter._layer(layer); const s = Math.round(await this._seconds(seconds));
    await this._cmd('GET', `/v1/transport/${l}/skip_backward/${s}`, { label: `${l} skip backward` }); return true;
  }
  async transportGoToTime(layer = 'presentation', time = 0) {
    const l = ProPresenter._layer(layer); const t = await this._seconds(time, 'time');
    await this._cmd('PUT', `/v1/transport/${l}/time`, { body: t, label: `${l} go to ${t}s` });
    const r = await this._until(() => this._fetch(`/v1/transport/${l}/time`), (x) => Number.isFinite(x) && Math.abs(x - t) < 1.5);
    if (!r.ok) throw new PPError(`ProPresenter accepted go to ${t}s but reports ${Number.isFinite(r.v) ? `${r.v}s` : 'unknown'}`);
    return true;
  }
  async transportGoToEnd(layer = 'presentation') {
    const l = ProPresenter._layer(layer);
    await this._cmd('GET', `/v1/transport/${l}/go_to_end`, { label: `${l} go to end` }); return true;
  }
  async timelinePlay()   { await this._cmd('GET', '/v1/presentation/active/timeline/play', { label: 'timeline play' }); return true; }
  async timelinePause()  { await this._cmd('GET', '/v1/presentation/active/timeline/pause', { label: 'timeline pause' }); return true; }
  async timelineRewind() { await this._cmd('GET', '/v1/presentation/active/timeline/rewind', { label: 'timeline rewind' }); return true; }

  async _capture(op, want) {
    await this._cmd('GET', `/v1/capture/${op}`, { label: `capture ${op}` });
    const r = await this._until(() => this._fetch('/v1/capture/status'), (s) => s && s.status === want);
    if (!r.ok) throw new PPError(`ProPresenter accepted capture ${op} but reports ${r.v?.status || 'unknown'}${r.v?.status_description ? ` (${r.v.status_description})` : ''}`);
    return true;
  }
  async captureStart() { return this._capture('start', 'active'); }
  async captureStop()  { return this._capture('stop', 'inactive'); }

  // ─── POLLING CONNECTION ────────────────────────────────────────────────

  async connect() {
    if (this._pollAbort) return;
    const running = await this.isRunning();
    if (!running) {
      console.log('⛪ ProPresenter not reachable (no ProPresenter /version answer), will retry...');
      this._scheduleReconnect(this._isBackup ? 15000 : 10000);
      return;
    }
    console.log('✅ ProPresenter connected (REST API)');
    this.connected = true;
    this.running = true;
    this._reconnectDelay = 5000;
    this.emit('connected');
    this._startSlidePoll();
    if (this._backup) this._backup.connect().catch(() => {});
  }

  _startSlidePoll() {
    this._stopPolling();
    this._lastSlideUuid = null;
    this._lastSlideIndex = null;
    this._pollAbort = new AbortController();
    const abort = this._pollAbort;
    let misses = 0;
    const poll = async () => {
      while (!abort.signal.aborted) {
        let slideData = null, indexData = null, answered = false;
        try {
          const [s, i] = await Promise.all([
            fetch(`${this.baseUrl}/v1/status/slide`, { signal: AbortSignal.timeout(2500) }),
            fetch(`${this.baseUrl}/v1/presentation/slide_index`, { signal: AbortSignal.timeout(2500) }),
          ]);
          if (s.ok) { try { slideData = await s.json(); } catch { /* */ } } else await s.text();
          if (i.ok) { try { indexData = await i.json(); } catch { /* */ } } else await i.text();
          answered = !!(s.ok || i.ok);   // a 404 web page is not ProPresenter
        } catch { answered = false; }
        if (abort.signal.aborted) return;

        if (!answered) {
          misses++;
          if (misses >= 2 && this.connected) {
            console.warn('⚠️  ProPresenter stopped answering');
            this.connected = false;
            this.running = false;
            this._currentSlide = null;
            this.emit('disconnected');
            this._stopPolling();
            this._scheduleReconnect();
            return;
          }
        } else {
          misses = 0;
          if (!this.connected) { this.connected = true; this.running = true; this.emit('connected'); }
          const pi = indexData ? indexData.presentation_index : undefined;
          if (pi === null) {
            if (this._currentSlide) { this._currentSlide = null; this._lastSlideIndex = null; this._lastSlideUuid = null; this.emit('slideChanged', { cleared: true }); }
          } else if (pi) {
            const presUuid = pi.presentation_id?.uuid || null;
            const presName = pi.presentation_id?.name || null;
            const idx = pi.index ?? null;
            let total = this._currentSlide?.presentationUUID === presUuid ? this._currentSlide.slideTotal : null;
            if (presUuid && total == null) total = await this._slideCount(presUuid);
            this._currentSlide = { presentationName: presName, presentationUUID: presUuid, slideIndex: idx, slideTotal: total, slideNotes: slideData?.current?.notes || '', onScreen: true };
            const uuid = slideData?.current?.uuid;
            if ((uuid && uuid !== this._lastSlideUuid) || idx !== this._lastSlideIndex || presUuid !== this._lastPresUuid) {
              this._lastSlideUuid = uuid || this._lastSlideUuid;
              this._lastSlideIndex = idx;
              this._lastPresUuid = presUuid;
              this.emit('slideChanged', { current: slideData?.current || {}, next: slideData?.next || {}, slideIndex: idx, slideCount: total, presentationName: presName, presentationUuid: presUuid });
            }
          }
        }
        await sleep(misses ? 1000 : 2000);
      }
    };
    poll();
  }

  _stopPolling() {
    if (this._pollInterval) { clearInterval(this._pollInterval); this._pollInterval = null; }
    if (this._pollAbort) { this._pollAbort.abort(); this._pollAbort = null; }
  }

  _scheduleReconnect(delayOverride) {
    if (this._reconnectTimer) return;
    const delay = delayOverride || this._reconnectDelay;
    this._reconnectTimer = setTimeout(() => { this._reconnectTimer = null; this.connect(); }, delay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30000);
  }

  disconnect() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._stopPolling();
    this.connected = false;
    if (this._backup) this._backup.disconnect();
  }

  toStatus() {
    const cs = this.connected ? this._currentSlide : null;
    return {
      connected: this.connected,
      running: this.running,
      version: this._version || null,
      currentSlide: cs?.presentationName || null,
      presentationUUID: cs?.presentationUUID || null,
      slideIndex: cs?.slideIndex ?? null,
      slideTotal: cs?.slideTotal ?? null,
      slideNotes: cs?.slideNotes || null,
      activeLook: this.connected ? this._activeLook || null : null,
      timers: this.connected ? [
        ...(this._videoCountdown ? [{ id: '__video_countdown__', name: `Video: ${this._videoCountdown.name}`, time: this._videoCountdown.time, state: this._videoCountdown.isPlaying ? 'Running' : 'Stopped' }] : []),
        ...(this._activeTimers || []),
      ] : [],
      screens: this.connected ? this._screenStatus || null : null,
      playlistFocused: this.connected ? this._playlistFocused || null : null,
      triggerMode: this.triggerMode,
      backup: this._backup ? { connected: this._backup.connected, running: this._backup.running, lastMirror: this.lastMirror } : null,
    };
  }
}

module.exports = { ProPresenter, PPError, _internals: { TIMER_STATES, LAYERS } };
