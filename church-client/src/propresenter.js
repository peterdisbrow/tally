/**
 * ProPresenter 7 Integration
 * REST API (port 1025) + WebSocket (port 1026) for real-time events.
 * Supports presentation & playlist trigger modes, library browsing,
 * slide thumbnails, and optional backup PP mirroring.
 */

const { EventEmitter } = require('events');
const WebSocket = require('ws');

class ProPresenter extends EventEmitter {
  constructor({ host = 'localhost', port = 1025, triggerMode = 'presentation', backupHost, backupPort } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.wsPort = port + 1; // 1026 by default
    this.triggerMode = triggerMode; // 'presentation' or 'playlist'
    this.connected = false;
    this.running = false;
    this._ws = null;
    this._reconnectTimer = null;
    this._reconnectDelay = 5000;
    this._currentSlide = null;
    this._version = null;
    this._activeLook = null;
    this._activeTimers = [];
    this._screenStatus = null;
    this._playlistFocused = null;

    // Backup PP instance (fire-and-forget mirroring, no status polling)
    this._backup = null;
    if (backupHost) {
      this._backup = new ProPresenter({ host: backupHost, port: backupPort || 1025 });
    }
  }

  get baseUrl() {
    return `http://${this.host}:${this.port}`;
  }

  // ─── HTTP HELPERS ─────────────────────────────────────────────────────

  async _fetch(path, options = {}) {
    const url = `${this.baseUrl}${path}`;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000), ...options });
      if (!resp.ok) return null;
      const text = await resp.text();
      try { return JSON.parse(text); } catch { return text; }
    } catch {
      return null;
    }
  }

  /** Mirror a command to the backup PP instance (fire-and-forget). */
  _mirror(path, options = {}) {
    if (!this._backup) return;
    this._backup._fetch(path, options).catch(() => {});
  }

  // ─── PUBLIC API ───────────────────────────────────────────────────────

  async isRunning() {
    try {
      const resp = await fetch(`${this.baseUrl}/v1/version`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(3000),
      });
      this.running = resp.ok;
      return this.running;
    } catch {
      this.running = false;
      return false;
    }
  }

  async getVersion() {
    const data = await this._fetch('/v1/version');
    if (!data) return null;
    if (typeof data === 'string') { this._version = data; return data; }
    const v = data.version || data.appVersion || data.product || null;
    this._version = v;
    return v;
  }

  async getCurrentSlide() {
    const data = await this._fetch('/v1/presentation/active');
    if (!data) return null;
    const result = {
      presentationName: data.presentation?.name || data.name || 'Unknown',
      presentationUUID: data.presentation?.uuid || data.uuid || null,
      slideIndex: data.slideIndex ?? data.presentation?.slideIndex ?? 0,
      slideTotal: data.slideCount ?? data.presentation?.slideCount ?? 0,
      slideNotes: data.notes || data.presentation?.notes || '',
    };
    this._currentSlide = result;
    return result;
  }

  async nextSlide() {
    const path = this.triggerMode === 'playlist'
      ? '/v1/trigger/next'
      : '/v1/presentation/focused/next/trigger';
    await this._fetch(path, { method: 'GET' });
    this._mirror(path, { method: 'GET' });
    return true;
  }

  async previousSlide() {
    const path = this.triggerMode === 'playlist'
      ? '/v1/trigger/previous'
      : '/v1/presentation/focused/previous/trigger';
    await this._fetch(path, { method: 'GET' });
    this._mirror(path, { method: 'GET' });
    return true;
  }

  async goToSlide(index) {
    const path = `/v1/presentation/active/${index}/trigger`;
    await this._fetch(path, { method: 'GET' });
    this._mirror(`/v1/presentation/focused/${index}/trigger`, { method: 'GET' });
    return true;
  }

  async getPlaylist() {
    const data = await this._fetch('/v1/playlists');
    if (!data) return [];
    const items = [];
    const extract = (list) => {
      if (Array.isArray(list)) {
        for (const item of list) {
          if (item.name || item.id) items.push({ name: item.name || item.id, type: item.type || 'unknown' });
          if (item.items) extract(item.items);
        }
      }
    };
    extract(data.playlists || data);
    return items;
  }

  // ─── RICH STATUS METHODS ──────────────────────────────────────────────

  async getActiveLook() {
    const data = await this._fetch('/v1/looks/current');
    if (!data) return null;
    const look = { id: data.id?.uuid || data.uuid || null, name: data.id?.name || data.name || 'Unknown' };
    const prev = this._activeLook;
    this._activeLook = look;
    if (prev && prev.name !== look.name) this.emit('lookChanged', look);
    return look;
  }

  async getTimerStatus() {
    const data = await this._fetch('/v1/timers/current');
    if (!data) return [];
    const list = (Array.isArray(data) ? data : data.timers || []).map(t => ({
      id: t.id?.uuid || t.id || t.uuid,
      name: t.id?.name || t.name || 'Untitled',
      time: t.time || '00:00',
      state: t.state || 'Stopped', // Running, Stopped, Overrun
    }));
    const prev = this._activeTimers;
    this._activeTimers = list;
    // Emit if any timer state changed
    if (JSON.stringify(prev.map(t => `${t.id}:${t.state}`)) !== JSON.stringify(list.map(t => `${t.id}:${t.state}`))) {
      this.emit('timerUpdate', list);
    }
    return list;
  }

  async getAudienceScreenStatus() {
    const data = await this._fetch('/v1/status/screens');
    if (!data) {
      // Fallback to audience_screens endpoint
      const fallback = await this._fetch('/v1/status/audience_screens');
      if (!fallback) return null;
      const status = { audience: !!fallback.audience, stage: !!fallback.stage };
      const prev = this._screenStatus;
      this._screenStatus = status;
      if (prev && (prev.audience !== status.audience || prev.stage !== status.stage)) {
        this.emit('screenStateChanged', status);
      }
      return status;
    }
    const status = { audience: !!data.audience, stage: !!data.stage };
    const prev = this._screenStatus;
    this._screenStatus = status;
    if (prev && (prev.audience !== status.audience || prev.stage !== status.stage)) {
      this.emit('screenStateChanged', status);
    }
    return status;
  }

  async getPlaylistFocused() {
    const data = await this._fetch('/v1/playlist/focused');
    if (!data) return null;
    this._playlistFocused = {
      name: data.id?.name || data.name || null,
      uuid: data.id?.uuid || data.uuid || null,
      index: data.index ?? null,
    };
    return this._playlistFocused;
  }

  // ─── LIBRARY BROWSING ────────────────────────────────────────────────

  async getLibraries() {
    const data = await this._fetch('/v1/libraries');
    if (!data) return [];
    const libraries = data.libraries || data || [];
    const result = [];
    for (const lib of (Array.isArray(libraries) ? libraries : [])) {
      const libId = lib.id?.uuid || lib.id;
      const libName = lib.id?.name || lib.name || 'Untitled';
      try {
        const items = await this._fetch(`/v1/library/${encodeURIComponent(libId)}`);
        result.push({
          id: libId,
          name: libName,
          presentations: ((items?.items || items || [])).map(p => ({
            id: p.id?.uuid || p.id,
            name: p.id?.name || p.name || 'Untitled',
          })),
        });
      } catch {
        result.push({ id: libId, name: libName, presentations: [] });
      }
    }
    return result;
  }

  // ─── THUMBNAILS ──────────────────────────────────────────────────────

  async getThumbnail(presentationUUID, slideIndex) {
    try {
      const resp = await fetch(
        `${this.baseUrl}/v1/presentation/${encodeURIComponent(presentationUUID)}/thumbnail/${slideIndex}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!resp.ok) return null;
      const buffer = await resp.arrayBuffer();
      return Buffer.from(buffer).toString('base64');
    } catch {
      return null;
    }
  }

  // ─── EXTENDED PP7 API ────────────────────────────────────────────────

  async clearAll() {
    const layers = ['slide', 'media', 'props', 'messages'];
    await Promise.all(layers.map(l => this._fetch(`/v1/clear/layer/${l}`, { method: 'GET' })));
    for (const l of layers) this._mirror(`/v1/clear/layer/${l}`, { method: 'GET' });
    return true;
  }

  async clearSlide() {
    await this._fetch('/v1/clear/layer/slide', { method: 'GET' });
    this._mirror('/v1/clear/layer/slide', { method: 'GET' });
    return true;
  }

  async getMessages() {
    const data = await this._fetch('/v1/messages');
    if (!data) return [];
    return (data.messages || data || []).map(m => ({
      id: m.id?.uuid || m.id || m.uuid,
      name: m.id?.name || m.name || 'Untitled',
    }));
  }

  async triggerMessage(idOrName, tokens = []) {
    const messages = await this.getMessages();
    let msgId = idOrName;
    if (messages.length > 0) {
      const found = messages.find(m =>
        m.name.toLowerCase() === String(idOrName).toLowerCase() ||
        m.id === idOrName
      );
      if (found) msgId = found.id;
    }
    const body = tokens.length > 0 ? JSON.stringify(tokens) : undefined;
    const fetchOpts = { method: 'GET', ...(body ? { body, headers: { 'Content-Type': 'application/json' } } : {}) };
    await this._fetch(`/v1/message/${encodeURIComponent(msgId)}/trigger`, fetchOpts);
    this._mirror(`/v1/message/${encodeURIComponent(msgId)}/trigger`, fetchOpts);
    return true;
  }

  async clearMessages() {
    await this._fetch('/v1/clear/layer/messages', { method: 'GET' });
    this._mirror('/v1/clear/layer/messages', { method: 'GET' });
    return true;
  }

  async getLooks() {
    const data = await this._fetch('/v1/looks');
    if (!data) return [];
    return (data.looks || data || []).map(l => ({
      id: l.id?.uuid || l.id || l.uuid,
      name: l.id?.name || l.name || 'Untitled',
    }));
  }

  async setLook(nameOrId) {
    const looks = await this.getLooks();
    const found = looks.find(l =>
      l.name.toLowerCase() === String(nameOrId).toLowerCase() ||
      l.id === nameOrId
    );
    if (!found) throw new Error(`Look "${nameOrId}" not found. Available: ${looks.map(l => l.name).join(', ')}`);
    const body = JSON.stringify({ id: { uuid: found.id, name: found.name } });
    const headers = { 'Content-Type': 'application/json' };
    await this._fetch('/v1/looks/current', { method: 'PUT', body, headers });
    this._mirror('/v1/looks/current', { method: 'PUT', body, headers });
    return found.name;
  }

  async getTimers() {
    const data = await this._fetch('/v1/timers');
    if (!data) return [];
    return (data.timers || data || []).map(t => ({
      id: t.id?.uuid || t.id || t.uuid,
      name: t.id?.name || t.name || 'Untitled',
      allows_overrun: !!t.allows_overrun,
    }));
  }

  async startTimer(nameOrId) {
    const timers = await this.getTimers();
    const found = timers.find(t =>
      t.name.toLowerCase() === String(nameOrId).toLowerCase() ||
      t.id === nameOrId
    );
    if (!found) throw new Error(`Timer "${nameOrId}" not found. Available: ${timers.map(t => t.name).join(', ')}`);
    await this._fetch(`/v1/timer/${encodeURIComponent(found.id)}/start`, { method: 'GET' });
    this._mirror(`/v1/timer/${encodeURIComponent(found.id)}/start`, { method: 'GET' });
    return found.name;
  }

  async stopTimer(nameOrId) {
    const timers = await this.getTimers();
    const found = timers.find(t =>
      t.name.toLowerCase() === String(nameOrId).toLowerCase() ||
      t.id === nameOrId
    );
    if (!found) throw new Error(`Timer "${nameOrId}" not found. Available: ${timers.map(t => t.name).join(', ')}`);
    await this._fetch(`/v1/timer/${encodeURIComponent(found.id)}/stop`, { method: 'GET' });
    this._mirror(`/v1/timer/${encodeURIComponent(found.id)}/stop`, { method: 'GET' });
    return found.name;
  }

  // ─── AUDIENCE SCREENS ───────────────────────────────────────────────

  async setAudienceScreens(on) {
    await this._fetch('/v1/status/audience_screens', {
      method: 'PUT',
      body: JSON.stringify({ audience: !!on }),
      headers: { 'Content-Type': 'application/json' },
    });
    this._mirror('/v1/status/audience_screens', {
      method: 'PUT',
      body: JSON.stringify({ audience: !!on }),
      headers: { 'Content-Type': 'application/json' },
    });
    return on ? 'Audience screens ON' : 'Audience screens OFF';
  }

  // ─── WEBSOCKET CONNECTION ─────────────────────────────────────────────

  async connect() {
    if (this._ws) return;

    const running = await this.isRunning();
    if (!running) {
      console.log('⛪ ProPresenter not reachable, will retry in 30s...');
      this._scheduleReconnect(30000);
      return;
    }

    const wsUrl = `ws://${this.host}:${this.wsPort}/stagedisplay`;
    try {
      this._ws = new WebSocket(wsUrl);

      this._ws.on('open', () => {
        console.log('✅ ProPresenter WebSocket connected');
        this.connected = true;
        this._reconnectDelay = 5000;
        this.emit('connected');
      });

      this._ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this._handleWSMessage(msg);
        } catch { /* ignore parse errors */ }
      });

      this._ws.on('close', () => {
        console.warn('⚠️  ProPresenter WebSocket disconnected');
        this.connected = false;
        this._ws = null;
        this.emit('disconnected');
        this._scheduleReconnect();
      });

      this._ws.on('error', (err) => {
        console.error('ProPresenter WS error:', err.message);
        this._ws?.close();
      });
    } catch (err) {
      console.error('ProPresenter WS connection failed:', err.message);
      this._scheduleReconnect();
    }

    // Also connect backup if configured (no status, just ready for mirroring)
    if (this._backup) {
      this._backup.connect().catch(() => {});
    }
  }

  _handleWSMessage(msg) {
    if (msg.action === 'slideChanged' || msg.acn === 'fv') {
      this.emit('slideChanged', msg);
    }
    if (msg.action === 'presentationChanged') {
      this.emit('presentationChanged', msg);
    }
  }

  _scheduleReconnect(delayOverride) {
    if (this._reconnectTimer) return;
    const delay = delayOverride || this._reconnectDelay;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, delay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, 60000);
  }

  disconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this.connected = false;
    if (this._backup) this._backup.disconnect();
  }

  toStatus() {
    return {
      connected: this.connected,
      running: this.running,
      version: this._version || null,
      // Slide info
      currentSlide: this._currentSlide?.presentationName || null,
      presentationUUID: this._currentSlide?.presentationUUID || null,
      slideIndex: this._currentSlide?.slideIndex ?? null,
      slideTotal: this._currentSlide?.slideTotal ?? null,
      slideNotes: this._currentSlide?.slideNotes || null,
      // Active look
      activeLook: this._activeLook || null,
      // Timers
      timers: this._activeTimers || [],
      // Audience screens
      screens: this._screenStatus || null,
      // Playlist position
      playlistFocused: this._playlistFocused || null,
      // Trigger mode
      triggerMode: this.triggerMode,
      // Backup status
      backup: this._backup ? { connected: this._backup.connected, running: this._backup.running } : null,
    };
  }
}

module.exports = { ProPresenter };
