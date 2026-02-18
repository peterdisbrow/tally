/**
 * ProPresenter 7 Integration
 * REST API (port 1025) + WebSocket (port 1026) for real-time events.
 */

const { EventEmitter } = require('events');
const WebSocket = require('ws');

class ProPresenter extends EventEmitter {
  constructor({ host = 'localhost', port = 1025 } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.wsPort = port + 1; // 1026 by default
    this.connected = false;
    this.running = false;
    this._ws = null;
    this._reconnectTimer = null;
    this._reconnectDelay = 5000;
    this._currentSlide = null;
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

  async getCurrentSlide() {
    const data = await this._fetch('/v1/presentation/active');
    if (!data) return null;
    // ProPresenter 7 API returns presentation info
    const result = {
      presentationName: data.presentation?.name || data.name || 'Unknown',
      slideIndex: data.slideIndex ?? data.presentation?.slideIndex ?? 0,
      slideTotal: data.slideCount ?? data.presentation?.slideCount ?? 0,
      slideNotes: data.notes || '',
    };
    this._currentSlide = result;
    return result;
  }

  async nextSlide() {
    await this._fetch('/v1/trigger/next', { method: 'GET' });
    return true;
  }

  async previousSlide() {
    await this._fetch('/v1/trigger/previous', { method: 'GET' });
    return true;
  }

  async goToSlide(index) {
    await this._fetch(`/v1/presentation/active/${index}/trigger`, { method: 'GET' });
    return true;
  }

  async getPlaylist() {
    const data = await this._fetch('/v1/playlists');
    if (!data) return [];
    // Flatten playlist items
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
  }

  toStatus() {
    return {
      connected: this.connected,
      running: this.running,
      currentSlide: this._currentSlide?.presentationName || null,
      slideIndex: this._currentSlide?.slideIndex ?? null,
      slideTotal: this._currentSlide?.slideTotal ?? null,
    };
  }
}

module.exports = { ProPresenter };
