/**
 * ProPresenter Integration (PP7 / PP 21.x+)
 * Uses the official /v1/ REST API on port 1025.
 * Real-time slide updates via 2s polling (PP 21 removed the old
 * "Remote Classic" WebSocket protocol).
 * Supports presentation & playlist trigger modes, library browsing,
 * slide thumbnails, and optional backup PP mirroring.
 */

const { EventEmitter } = require('events');

class ProPresenter extends EventEmitter {
  constructor({ host = 'localhost', port = 1025, triggerMode = 'presentation', backupHost, backupPort } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.triggerMode = triggerMode; // 'presentation' or 'playlist'
    this.connected = false;
    this.running = false;
    this._pollAbort = null;
    this._reconnectTimer = null;
    this._reconnectDelay = 5000;
    this._pollInterval = null;
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
      try { return JSON.parse(text); } catch { return null; }
    } catch {
      return null;
    }
  }

  /** Fire-and-forget HTTP request (for triggers that return 204/empty). */
  async _fire(path, options = {}) {
    const url = `${this.baseUrl}${path}`;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000), ...options });
      // Consume body to prevent socket hang
      await resp.text();
      return resp.ok || resp.status === 204;
    } catch {
      return false;
    }
  }

  /** Mirror a command to the backup PP instance (fire-and-forget). */
  _mirror(path, options = {}) {
    if (!this._backup) return;
    this._backup._fire(path, options).catch(() => {});
  }

  // ─── PUBLIC API ───────────────────────────────────────────────────────

  async isRunning() {
    try {
      // Use /v1/status/slide (proven reliable in PP 21.x, same as Tally Clicker).
      // Any HTTP response (even 404) proves PP is running.
      // Only a network-level failure (ECONNREFUSED, timeout) means not running.
      const resp = await fetch(`${this.baseUrl}/v1/status/slide`, {
        signal: AbortSignal.timeout(3000),
      });
      // Consume body to prevent socket hang
      await resp.text();
      this.running = true;
      return true;
    } catch {
      this.running = false;
      return false;
    }
  }

  async getVersion() {
    // Per PP spec, version endpoint lives at /version (not /v1/version)
    const data = await this._fetch('/version');
    if (!data) return null;
    if (typeof data === 'string') { this._version = data; return data; }
    const v = data.host_description || data.version || data.appVersion || data.product || null;
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
    await this._fire(path);
    this._mirror(path);
    return true;
  }

  async previousSlide() {
    const path = this.triggerMode === 'playlist'
      ? '/v1/trigger/previous'
      : '/v1/presentation/focused/previous/trigger';
    await this._fire(path);
    this._mirror(path);
    return true;
  }

  async goToSlide(index) {
    const path = `/v1/presentation/focused/${index}/trigger`;
    await this._fire(path);
    this._mirror(path);
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
    await Promise.allSettled(layers.map(l => this._fire(`/v1/clear/layer/${l}`)));
    for (const l of layers) this._mirror(`/v1/clear/layer/${l}`);
    return true;
  }

  async clearSlide() {
    await this._fire('/v1/clear/layer/slide');
    this._mirror('/v1/clear/layer/slide');
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
        (m.name || '').toLowerCase() === String(idOrName).toLowerCase() ||
        m.id === idOrName
      );
      if (found) msgId = found.id;
    }
    const body = tokens.length > 0 ? JSON.stringify(tokens) : undefined;
    const fetchOpts = body ? { body, headers: { 'Content-Type': 'application/json' } } : {};
    await this._fire(`/v1/message/${encodeURIComponent(msgId)}/trigger`, fetchOpts);
    this._mirror(`/v1/message/${encodeURIComponent(msgId)}/trigger`, fetchOpts);
    return true;
  }

  async clearMessages() {
    await this._fire('/v1/clear/layer/messages');
    this._mirror('/v1/clear/layer/messages');
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
      (l.name || '').toLowerCase() === String(nameOrId).toLowerCase() ||
      l.id === nameOrId
    );
    if (!found) throw new Error(`Look "${nameOrId}" not found. Available: ${looks.map(l => l.name).join(', ')}`);
    const body = JSON.stringify({ id: { uuid: found.id, name: found.name } });
    const headers = { 'Content-Type': 'application/json' };
    await this._fire('/v1/looks/current', { method: 'PUT', body, headers });
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
      (t.name || '').toLowerCase() === String(nameOrId).toLowerCase() ||
      t.id === nameOrId
    );
    if (!found) throw new Error(`Timer "${nameOrId}" not found. Available: ${timers.map(t => t.name).join(', ')}`);
    await this._fire(`/v1/timer/${encodeURIComponent(found.id)}/start`);
    this._mirror(`/v1/timer/${encodeURIComponent(found.id)}/start`);
    return found.name;
  }

  async stopTimer(nameOrId) {
    const timers = await this.getTimers();
    const found = timers.find(t =>
      (t.name || '').toLowerCase() === String(nameOrId).toLowerCase() ||
      t.id === nameOrId
    );
    if (!found) throw new Error(`Timer "${nameOrId}" not found. Available: ${timers.map(t => t.name).join(', ')}`);
    await this._fire(`/v1/timer/${encodeURIComponent(found.id)}/stop`);
    this._mirror(`/v1/timer/${encodeURIComponent(found.id)}/stop`);
    return found.name;
  }

  // ─── AUDIENCE SCREENS ───────────────────────────────────────────────

  async setAudienceScreens(on) {
    await this._fire('/v1/status/audience_screens', {
      method: 'PUT',
      body: JSON.stringify(!!on),
      headers: { 'Content-Type': 'application/json' },
    });
    this._mirror('/v1/status/audience_screens', {
      method: 'PUT',
      body: JSON.stringify(!!on),
      headers: { 'Content-Type': 'application/json' },
    });
    return on ? 'Audience screens ON' : 'Audience screens OFF';
  }

  // ─── STATUS POLLING CONNECTION ───────────────────────────────────────
  // PP 21 removed the old WebSocket "Remote Classic" protocol.
  // We poll /v1/status/slide + /v1/presentation/slide_index every 2s
  // (same proven pattern as Tally Clicker).

  async connect() {
    if (this._pollInterval) return;

    const running = await this.isRunning();
    if (!running) {
      console.log('⛪ ProPresenter not reachable, will retry in 30s...');
      this._scheduleReconnect(30000);
      return;
    }

    console.log('✅ ProPresenter connected (REST API)');
    this.connected = true;
    this.running = true;
    this._reconnectDelay = 5000;
    this.emit('connected');

    // Start slide polling (2s interval, same as proven Tally Clicker pattern)
    this._startSlidePoll();

    // Also connect backup if configured (no status, just ready for mirroring)
    if (this._backup) {
      this._backup.connect().catch(() => {});
    }
  }

  /** Poll /v1/status/slide + /v1/presentation/slide_index every 2s for slide changes */
  _startSlidePoll() {
    this._stopPolling();
    this._lastSlideUuid = null;
    this._lastSlideIndex = null;
    this._pollAbort = new AbortController();

    const poll = async () => {
      while (this._pollAbort && !this._pollAbort.signal.aborted) {
        try {
          const [slideRes, indexRes] = await Promise.all([
            fetch(`${this.baseUrl}/v1/status/slide`, { signal: AbortSignal.timeout(3000) }),
            fetch(`${this.baseUrl}/v1/presentation/slide_index`, { signal: AbortSignal.timeout(3000) }),
          ]);

          // Connection is alive
          if (!this.connected) {
            this.connected = true;
            this.running = true;
            this.emit('connected');
          }

          let slideData = null, indexData = null;
          if (slideRes.ok) {
            try { slideData = await slideRes.json(); } catch { /* empty */ }
          } else { await slideRes.text(); }
          if (indexRes.ok) {
            try { indexData = await indexRes.json(); } catch { /* empty */ }
          } else { await indexRes.text(); }

          const uuid = slideData?.current?.uuid;
          const currentIndex = indexData?.presentation_index?.index ?? null;

          if ((uuid && uuid !== this._lastSlideUuid) || (currentIndex != null && currentIndex !== this._lastSlideIndex)) {
            this._lastSlideUuid = uuid || this._lastSlideUuid;
            this._lastSlideIndex = currentIndex;
            this.emit('slideChanged', {
              current: slideData?.current || {},
              next: slideData?.next || {},
              slideIndex: currentIndex,
              presentationName: indexData?.presentation_index?.presentation_id?.name || null,
              presentationUuid: indexData?.presentation_index?.presentation_id?.uuid || null,
            });
          }
        } catch (err) {
          if (this._pollAbort?.signal.aborted) return;
          // Connection lost
          if (this.connected) {
            console.warn('⚠️  ProPresenter disconnected:', err.message);
            this.connected = false;
            this.running = false;
            this.emit('disconnected');
            this._stopPolling();
            this._scheduleReconnect();
            return;
          }
        }

        // Wait 2 seconds before next poll
        await new Promise(r => setTimeout(r, 2000));
      }
    };
    poll();
  }

  _stopPolling() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
    if (this._pollAbort) {
      this._pollAbort.abort();
      this._pollAbort = null;
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
    this._stopPolling();
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
