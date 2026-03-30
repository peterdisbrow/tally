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
    // Try JSON parse first, fall back to raw text (PP 21 may return plain text)
    try {
      const resp = await fetch(`${this.baseUrl}/version`, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return null;
      const text = (await resp.text()).trim();
      if (!text) return null;
      let data;
      try { data = JSON.parse(text); } catch { /* not JSON */ }
      if (data && typeof data === 'object') {
        const v = data.host_description || data.version || data.appVersion || data.product || null;
        this._version = v;
        return v;
      }
      // Raw text response (strip surrounding quotes if present)
      const cleaned = text.replace(/^["']|["']$/g, '');
      if (cleaned) { this._version = cleaned; return cleaned; }
      return null;
    } catch {
      return null;
    }
  }

  async getCurrentSlide() {
    const data = await this._fetch('/v1/presentation/active');
    if (!data || typeof data !== 'object') return this._currentSlide || null;
    // Log once for debugging PP 21 response format
    if (!this._activeSlideFormatLogged) {
      console.log('[ProPresenter] /v1/presentation/active response keys:', Object.keys(data).join(', '));
      this._activeSlideFormatLogged = true;
    }
    const pres = data.presentation || data;
    const result = {
      presentationName: pres.name || data.id?.name || this._currentSlide?.presentationName || 'Unknown',
      presentationUUID: pres.uuid || data.id?.uuid || this._currentSlide?.presentationUUID || null,
      slideIndex: data.slideIndex ?? pres.slideIndex ?? data.index ?? this._currentSlide?.slideIndex ?? 0,
      slideTotal: data.slideCount ?? pres.slideCount ?? data.slide_count ?? pres.groups?.reduce((a, g) => a + (g.slides?.length || 0), 0) ?? this._currentSlide?.slideTotal ?? 0,
      slideNotes: data.notes || pres.notes || this._currentSlide?.slideNotes || '',
    };
    // Don't overwrite good poll data with 'Unknown' from a sparse /active response
    if (result.presentationName !== 'Unknown' || !this._currentSlide?.presentationName) {
      this._currentSlide = result;
    }
    return this._currentSlide;
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
    if (!data || typeof data !== 'object') return null;
    if (!this._lookFormatLogged) {
      console.log('[ProPresenter] /v1/looks/current response keys:', Object.keys(data).join(', '));
      this._lookFormatLogged = true;
    }
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
    // Try /v1/status/screens first, then /v1/status/audience_screens
    const data = await this._fetch('/v1/status/screens')
      || await this._fetch('/v1/status/audience_screens');
    if (!data || typeof data !== 'object') return null;
    // Log once for debugging PP 21 response format
    if (!this._screenFormatLogged) {
      console.log('[ProPresenter] Screen status response:', JSON.stringify(data).slice(0, 500));
      this._screenFormatLogged = true;
    }
    // PP7 format: { audience: true, stage: false }
    // PP 21 may use: { screens: [{ name, enabled }] } or similar
    let audience, stage;
    if (data.audience !== undefined) {
      audience = !!data.audience;
      stage = !!data.stage;
    } else if (Array.isArray(data.screens)) {
      audience = data.screens.some(s => /audience/i.test(s.name || s.type || '') && s.enabled !== false);
      stage = data.screens.some(s => /stage/i.test(s.name || s.type || '') && s.enabled !== false);
    } else if (Array.isArray(data)) {
      audience = data.some(s => /audience/i.test(s.name || s.type || '') && s.enabled !== false);
      stage = data.some(s => /stage/i.test(s.name || s.type || '') && s.enabled !== false);
    } else {
      // Unknown format — log once for debugging
      if (!this._screenFormatLogged) {
        console.log('[ProPresenter] Screen status response format:', JSON.stringify(data));
        this._screenFormatLogged = true;
      }
      return null;
    }
    const status = { audience, stage };
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

  // ─── COMPANION PARITY: Presentation & Playlist Trigger ─────────────

  async triggerPresentation(nameOrUUID) {
    // Find in libraries, then trigger by UUID
    const libs = await this.getLibraries();
    for (const lib of libs) {
      const found = lib.presentations.find(p =>
        (p.name || '').toLowerCase() === String(nameOrUUID).toLowerCase() ||
        p.id === nameOrUUID
      );
      if (found) {
        await this._fire(`/v1/presentation/${encodeURIComponent(found.id)}/0/trigger`);
        this._mirror(`/v1/presentation/${encodeURIComponent(found.id)}/0/trigger`);
        return found.name;
      }
    }
    // Try direct UUID trigger
    await this._fire(`/v1/presentation/${encodeURIComponent(nameOrUUID)}/0/trigger`);
    this._mirror(`/v1/presentation/${encodeURIComponent(nameOrUUID)}/0/trigger`);
    return nameOrUUID;
  }

  async triggerPlaylistItem(playlistName, itemIndex = 0) {
    const data = await this._fetch('/v1/playlists');
    if (!data) throw new Error('Could not fetch playlists');
    const playlists = data.playlists || data || [];
    const findPlaylist = (list) => {
      for (const item of (Array.isArray(list) ? list : [])) {
        if ((item.name || '').toLowerCase() === String(playlistName).toLowerCase() ||
            (item.id?.name || '').toLowerCase() === String(playlistName).toLowerCase()) {
          return item;
        }
        if (item.items) {
          const found = findPlaylist(item.items);
          if (found) return found;
        }
      }
      return null;
    };
    const playlist = findPlaylist(playlists);
    if (!playlist) throw new Error(`Playlist "${playlistName}" not found`);
    const playlistId = playlist.id?.uuid || playlist.id;
    await this._fire(`/v1/playlist/${encodeURIComponent(playlistId)}/${itemIndex}/trigger`);
    this._mirror(`/v1/playlist/${encodeURIComponent(playlistId)}/${itemIndex}/trigger`);
    return playlist.name || playlist.id?.name || playlistName;
  }

  // ─── COMPANION PARITY: Props ──────────────────────────────────────────

  async getProps() {
    const data = await this._fetch('/v1/props');
    if (!data) return [];
    return (data.props || data || []).map(p => ({
      id: p.id?.uuid || p.id || p.uuid,
      name: p.id?.name || p.name || 'Untitled',
    }));
  }

  async triggerProp(nameOrId) {
    const props = await this.getProps();
    const found = props.find(p =>
      (p.name || '').toLowerCase() === String(nameOrId).toLowerCase() ||
      p.id === nameOrId
    );
    if (!found) throw new Error(`Prop "${nameOrId}" not found. Available: ${props.map(p => p.name).join(', ')}`);
    await this._fire(`/v1/prop/${encodeURIComponent(found.id)}/trigger`);
    this._mirror(`/v1/prop/${encodeURIComponent(found.id)}/trigger`);
    return found.name;
  }

  async clearProps() {
    await this._fire('/v1/clear/layer/props');
    this._mirror('/v1/clear/layer/props');
    return true;
  }

  // ─── COMPANION PARITY: Timer Reset & Configure ────────────────────────

  async resetTimer(nameOrId) {
    const timers = await this.getTimers();
    const found = timers.find(t =>
      (t.name || '').toLowerCase() === String(nameOrId).toLowerCase() ||
      t.id === nameOrId
    );
    if (!found) throw new Error(`Timer "${nameOrId}" not found`);
    await this._fire(`/v1/timer/${encodeURIComponent(found.id)}/reset`);
    this._mirror(`/v1/timer/${encodeURIComponent(found.id)}/reset`);
    return found.name;
  }

  async createTimer(name, settings = {}) {
    const body = {
      id: { name },
      allows_overrun: settings.allowsOverrun || false,
    };
    if (settings.countdownDuration) {
      body.countdown = { duration: settings.countdownDuration };
    }
    await this._fire('/v1/timers', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
    return name;
  }

  // ─── COMPANION PARITY: Groups ─────────────────────────────────────────

  async getGroups() {
    const data = await this._fetch('/v1/groups');
    if (!data) return [];
    return (data.groups || data || []).map(g => ({
      id: g.id?.uuid || g.id || g.uuid,
      name: g.id?.name || g.name || 'Untitled',
      color: g.color || null,
    }));
  }

  async triggerGroup(nameOrId) {
    const groups = await this.getGroups();
    const found = groups.find(g =>
      (g.name || '').toLowerCase() === String(nameOrId).toLowerCase() ||
      g.id === nameOrId
    );
    if (!found) throw new Error(`Group "${nameOrId}" not found. Available: ${groups.map(g => g.name).join(', ')}`);
    await this._fire(`/v1/group/${encodeURIComponent(found.id)}/trigger`);
    this._mirror(`/v1/group/${encodeURIComponent(found.id)}/trigger`);
    return found.name;
  }

  // ─── COMPANION PARITY: Announcements ──────────────────────────────────

  async nextAnnouncement() {
    await this._fire('/v1/announcement/active/next/trigger');
    this._mirror('/v1/announcement/active/next/trigger');
    return true;
  }

  async previousAnnouncement() {
    await this._fire('/v1/announcement/active/previous/trigger');
    this._mirror('/v1/announcement/active/previous/trigger');
    return true;
  }

  async getAnnouncementStatus() {
    const data = await this._fetch('/v1/announcement/active');
    if (!data) return null;
    return {
      presentationName: data.presentation?.name || data.id?.name || null,
      slideIndex: data.slideIndex ?? 0,
      slideCount: data.slideCount ?? 0,
    };
  }

  // ─── COMPANION PARITY: Macros ─────────────────────────────────────────

  async getMacros() {
    const data = await this._fetch('/v1/macros');
    if (!data) return [];
    return (data.macros || data || []).map(m => ({
      id: m.id?.uuid || m.id || m.uuid,
      name: m.id?.name || m.name || 'Untitled',
    }));
  }

  async triggerMacro(nameOrId) {
    const macros = await this.getMacros();
    const found = macros.find(m =>
      (m.name || '').toLowerCase() === String(nameOrId).toLowerCase() ||
      m.id === nameOrId
    );
    if (!found) throw new Error(`Macro "${nameOrId}" not found. Available: ${macros.map(m => m.name).join(', ')}`);
    await this._fire(`/v1/macro/${encodeURIComponent(found.id)}/trigger`);
    this._mirror(`/v1/macro/${encodeURIComponent(found.id)}/trigger`);
    return found.name;
  }

  // ─── COMPANION PARITY: Stage Layouts ──────────────────────────────────

  async getStageLayouts() {
    const data = await this._fetch('/v1/stage/layouts');
    if (!data) return [];
    return (data.layouts || data || []).map(l => ({
      id: l.id?.uuid || l.id || l.uuid,
      name: l.id?.name || l.name || 'Untitled',
    }));
  }

  async setStageLayout(nameOrId, screenIndex = 0) {
    const layouts = await this.getStageLayouts();
    const found = layouts.find(l =>
      (l.name || '').toLowerCase() === String(nameOrId).toLowerCase() ||
      l.id === nameOrId
    );
    if (!found) throw new Error(`Stage layout "${nameOrId}" not found`);
    await this._fire(`/v1/stage/layout/${encodeURIComponent(found.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ screen: screenIndex }),
      headers: { 'Content-Type': 'application/json' },
    });
    this._mirror(`/v1/stage/layout/${encodeURIComponent(found.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ screen: screenIndex }),
      headers: { 'Content-Type': 'application/json' },
    });
    return found.name;
  }

  // ─── COMPANION PARITY: Clear Specific Layers ─────────────────────────

  async clearMedia() {
    await this._fire('/v1/clear/layer/media');
    this._mirror('/v1/clear/layer/media');
    return true;
  }

  async clearAudio() {
    await this._fire('/v1/clear/layer/audio');
    this._mirror('/v1/clear/layer/audio');
    return true;
  }

  // ─── COMPANION PARITY: Video Input ────────────────────────────────────

  async triggerVideoInput(name) {
    await this._fire(`/v1/video_input/${encodeURIComponent(name)}/trigger`);
    this._mirror(`/v1/video_input/${encodeURIComponent(name)}/trigger`);
    return true;
  }

  // ─── COMPANION PARITY: Audio Playlists ─────────────────────────────

  async getAudioPlaylists() {
    const data = await this._fetch('/v1/audio/playlists');
    if (!data) return [];
    return (data.playlists || data || []).map(p => ({
      id: p.id?.uuid || p.id || p.uuid,
      name: p.id?.name || p.name || 'Untitled',
    }));
  }

  async activeAudioPlaylistTrigger(action = 'next') {
    const path = `/v1/audio/playlists/active/${encodeURIComponent(action)}/trigger`;
    await this._fire(path, { method: 'POST' });
    this._mirror(path, { method: 'POST' });
    return true;
  }

  async focusedAudioPlaylistTrigger(action = 'next') {
    const path = `/v1/audio/playlists/focused/${encodeURIComponent(action)}/trigger`;
    await this._fire(path, { method: 'POST' });
    this._mirror(path, { method: 'POST' });
    return true;
  }

  async audioPlaylistFocus(nameOrId) {
    const playlists = await this.getAudioPlaylists();
    const found = playlists.find(p =>
      (p.name || '').toLowerCase() === String(nameOrId).toLowerCase() ||
      p.id === nameOrId
    );
    const id = found ? found.id : nameOrId;
    await this._fire(`/v1/audio/playlists/${encodeURIComponent(id)}/focus`, { method: 'PUT' });
    return found ? found.name : nameOrId;
  }

  async audioPlaylistTrigger(nameOrId) {
    const playlists = await this.getAudioPlaylists();
    const found = playlists.find(p =>
      (p.name || '').toLowerCase() === String(nameOrId).toLowerCase() ||
      p.id === nameOrId
    );
    const id = found ? found.id : nameOrId;
    const path = `/v1/audio/playlists/${encodeURIComponent(id)}/trigger`;
    await this._fire(path, { method: 'POST' });
    this._mirror(path, { method: 'POST' });
    return found ? found.name : nameOrId;
  }

  // ─── COMPANION PARITY: Media Playlists ────────────────────────────

  async getMediaPlaylists() {
    const data = await this._fetch('/v1/media/playlists');
    if (!data) return [];
    return (data.playlists || data || []).map(p => ({
      id: p.id?.uuid || p.id || p.uuid,
      name: p.id?.name || p.name || 'Untitled',
    }));
  }

  async activeMediaPlaylistTrigger(action = 'next') {
    const path = `/v1/media/playlists/active/${encodeURIComponent(action)}/trigger`;
    await this._fire(path, { method: 'POST' });
    this._mirror(path, { method: 'POST' });
    return true;
  }

  async focusedMediaPlaylistTrigger(action = 'next') {
    const path = `/v1/media/playlists/focused/${encodeURIComponent(action)}/trigger`;
    await this._fire(path, { method: 'POST' });
    this._mirror(path, { method: 'POST' });
    return true;
  }

  async mediaPlaylistFocus(nameOrId) {
    const playlists = await this.getMediaPlaylists();
    const found = playlists.find(p =>
      (p.name || '').toLowerCase() === String(nameOrId).toLowerCase() ||
      p.id === nameOrId
    );
    const id = found ? found.id : nameOrId;
    await this._fire(`/v1/media/playlists/${encodeURIComponent(id)}/focus`, { method: 'PUT' });
    return found ? found.name : nameOrId;
  }

  async mediaPlaylistTrigger(nameOrId) {
    const playlists = await this.getMediaPlaylists();
    const found = playlists.find(p =>
      (p.name || '').toLowerCase() === String(nameOrId).toLowerCase() ||
      p.id === nameOrId
    );
    const id = found ? found.id : nameOrId;
    const path = `/v1/media/playlists/${encodeURIComponent(id)}/trigger`;
    await this._fire(path, { method: 'POST' });
    this._mirror(path, { method: 'POST' });
    return found ? found.name : nameOrId;
  }

  // ─── COMPANION PARITY: Transport Layer Control ────────────────────

  async transportPlay(layer = 'presentation') {
    const path = `/v1/transport/${encodeURIComponent(layer)}/play`;
    await this._fire(path, { method: 'PUT' });
    this._mirror(path, { method: 'PUT' });
    return true;
  }

  async transportPause(layer = 'presentation') {
    const path = `/v1/transport/${encodeURIComponent(layer)}/pause`;
    await this._fire(path, { method: 'PUT' });
    this._mirror(path, { method: 'PUT' });
    return true;
  }

  async transportSkipForward(layer = 'presentation', seconds = 10) {
    const path = `/v1/transport/${encodeURIComponent(layer)}/skip_forward/${seconds}`;
    await this._fire(path, { method: 'PUT' });
    this._mirror(path, { method: 'PUT' });
    return true;
  }

  async transportSkipBackward(layer = 'presentation', seconds = 10) {
    const path = `/v1/transport/${encodeURIComponent(layer)}/skip_backward/${seconds}`;
    await this._fire(path, { method: 'PUT' });
    this._mirror(path, { method: 'PUT' });
    return true;
  }

  async transportGoToTime(layer = 'presentation', time = 0) {
    const path = `/v1/transport/${encodeURIComponent(layer)}/go_to_time/${time}`;
    await this._fire(path, { method: 'PUT' });
    this._mirror(path, { method: 'PUT' });
    return true;
  }

  async transportGoToEnd(layer = 'presentation') {
    const path = `/v1/transport/${encodeURIComponent(layer)}/go_to_end`;
    await this._fire(path, { method: 'PUT' });
    this._mirror(path, { method: 'PUT' });
    return true;
  }

  // ─── COMPANION PARITY: Timeline ───────────────────────────────────

  async timelinePlay() {
    const path = '/v1/presentation/active/timeline/play';
    await this._fire(path, { method: 'PUT' });
    this._mirror(path, { method: 'PUT' });
    return true;
  }

  async timelinePause() {
    const path = '/v1/presentation/active/timeline/pause';
    await this._fire(path, { method: 'PUT' });
    this._mirror(path, { method: 'PUT' });
    return true;
  }

  async timelineRewind() {
    const path = '/v1/presentation/active/timeline/rewind';
    await this._fire(path, { method: 'PUT' });
    this._mirror(path, { method: 'PUT' });
    return true;
  }

  // ─── COMPANION PARITY: Capture ────────────────────────────────────

  async captureStart() {
    await this._fire('/v1/capture/start', { method: 'POST' });
    this._mirror('/v1/capture/start', { method: 'POST' });
    return true;
  }

  async captureStop() {
    await this._fire('/v1/capture/stop', { method: 'POST' });
    this._mirror('/v1/capture/stop', { method: 'POST' });
    return true;
  }

  // ─── COMPANION PARITY: Timer Enhancements ─────────────────────────

  async incrementTimer(nameOrId, seconds = 30) {
    const timers = await this.getTimers();
    const found = timers.find(t =>
      (t.name || '').toLowerCase() === String(nameOrId).toLowerCase() ||
      t.id === nameOrId
    );
    if (!found) throw new Error(`Timer "${nameOrId}" not found`);
    const body = JSON.stringify({ seconds });
    const headers = { 'Content-Type': 'application/json' };
    await this._fire(`/v1/timers/${encodeURIComponent(found.id)}/increment`, { method: 'PUT', body, headers });
    this._mirror(`/v1/timers/${encodeURIComponent(found.id)}/increment`, { method: 'PUT', body, headers });
    return found.name;
  }

  async setTimerValue(nameOrId, settings = {}) {
    const timers = await this.getTimers();
    const found = timers.find(t =>
      (t.name || '').toLowerCase() === String(nameOrId).toLowerCase() ||
      t.id === nameOrId
    );
    if (!found) throw new Error(`Timer "${nameOrId}" not found`);
    const body = {};
    if (settings.type) body.type = settings.type;
    if (settings.duration) body.duration = settings.duration;
    if (settings.overrun !== undefined) body.allows_overrun = settings.overrun;
    if (settings.name) body.id = { name: settings.name, uuid: found.id };
    const headers = { 'Content-Type': 'application/json' };
    await this._fire(`/v1/timers/${encodeURIComponent(found.id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
      headers,
    });
    return found.name;
  }

  // ─── COMPANION PARITY: Toggles ────────────────────────────────────

  async toggleProp(nameOrId) {
    // Check if the prop is currently active by checking the clear state
    // If triggering, it shows; if clearing, it hides
    const props = await this.getProps();
    const found = props.find(p =>
      (p.name || '').toLowerCase() === String(nameOrId).toLowerCase() ||
      p.id === nameOrId
    );
    if (!found) throw new Error(`Prop "${nameOrId}" not found. Available: ${props.map(p => p.name).join(', ')}`);
    // PP doesn't expose an "is prop active" endpoint, so we trigger it (toggle behavior)
    await this._fire(`/v1/prop/${encodeURIComponent(found.id)}/trigger`);
    this._mirror(`/v1/prop/${encodeURIComponent(found.id)}/trigger`);
    return found.name;
  }

  async toggleStageMessage(nameOrId) {
    // Similar toggle: trigger the message (PP handles toggle internally)
    await this.triggerMessage(nameOrId);
    return nameOrId;
  }

  async toggleAudienceScreens() {
    const status = await this.getAudienceScreenStatus();
    const newState = !(status?.audience ?? true);
    await this.setAudienceScreens(newState);
    return newState ? 'Audience screens ON' : 'Audience screens OFF';
  }

  async toggleStageScreens() {
    // Try dedicated toggle endpoint first
    const ok = await this._fire('/v1/screens/stage/toggle', { method: 'PUT' });
    if (ok) {
      this._mirror('/v1/screens/stage/toggle', { method: 'PUT' });
      return 'Stage screens toggled';
    }
    // Fallback: read current state and flip
    const status = await this.getAudienceScreenStatus();
    const newState = !(status?.stage ?? true);
    await this._fire('/v1/status/stage_screens', {
      method: 'PUT',
      body: JSON.stringify(!!newState),
      headers: { 'Content-Type': 'application/json' },
    });
    return newState ? 'Stage screens ON' : 'Stage screens OFF';
  }

  // ─── COMPANION PARITY: Library Cue Trigger ────────────────────────

  async triggerLibraryCue(libraryId, presentationId, cueIndex = 0) {
    const path = `/v1/libraries/${encodeURIComponent(libraryId)}/presentations/${encodeURIComponent(presentationId)}/${cueIndex}/trigger`;
    await this._fire(path, { method: 'POST' });
    this._mirror(path, { method: 'POST' });
    return true;
  }

  // ─── COMPANION PARITY: Clear Announcements ────────────────────────

  async clearAnnouncements() {
    await this._fire('/v1/clear/announcements', { method: 'POST' });
    this._mirror('/v1/clear/announcements', { method: 'POST' });
    return true;
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
    if (this._pollAbort) return;

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
          // Log once for debugging PP 21 response format
          if (!this._pollFormatLogged && (slideData || indexData)) {
            if (slideData) console.log('[ProPresenter] /v1/status/slide keys:', JSON.stringify(Object.keys(slideData)));
            if (indexData) console.log('[ProPresenter] /v1/presentation/slide_index:', JSON.stringify(indexData).slice(0, 500));
            this._pollFormatLogged = true;
          }

          const uuid = slideData?.current?.uuid;
          const currentIndex = indexData?.presentation_index?.index ?? null;

          // Extract presentation info from both endpoints
          const presIndex = indexData?.presentation_index;
          const presName = presIndex?.presentation_id?.name || null;
          const presUuid = presIndex?.presentation_id?.uuid || null;
          const slideCount = presIndex?.slide_count ?? slideData?.current?.slide_count ?? null;

          // Always update _currentSlide from poll data (more reliable than /v1/presentation/active in PP 21)
          if (presName || currentIndex != null) {
            this._currentSlide = {
              presentationName: presName || this._currentSlide?.presentationName || null,
              presentationUUID: presUuid || this._currentSlide?.presentationUUID || null,
              slideIndex: currentIndex ?? this._currentSlide?.slideIndex ?? 0,
              slideTotal: slideCount ?? this._currentSlide?.slideTotal ?? 0,
              slideNotes: slideData?.current?.notes || this._currentSlide?.slideNotes || '',
            };
          }

          if ((uuid && uuid !== this._lastSlideUuid) || (currentIndex != null && currentIndex !== this._lastSlideIndex)) {
            this._lastSlideUuid = uuid || this._lastSlideUuid;
            this._lastSlideIndex = currentIndex;
            this.emit('slideChanged', {
              current: slideData?.current || {},
              next: slideData?.next || {},
              slideIndex: currentIndex,
              slideCount,
              presentationName: presName,
              presentationUuid: presUuid,
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
