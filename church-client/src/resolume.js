/**
 * Resolume Arena Integration
 * REST API (port 8080 by default) — Arena 7+
 *
 * Gives Tally control over your video wall / LED display:
 * - Play/stop clips by index or name
 * - Trigger a full column (scene change)
 * - Fade layers in/out (opacity)
 * - Clear everything (blackout)
 * - Set BPM to match worship tempo
 * - Status: what's currently playing
 */

class Resolume {
  constructor({ host = 'localhost', port = 8080 } = {}) {
    this.host = host;
    this.port = port;
    this.running = false;
    this._compositionCache = null;
    this._cacheTime = 0;
    this._CACHE_TTL = 5000; // 5s composition cache
  }

  get baseUrl() {
    return `http://${this.host}:${this.port}/api/v1`;
  }

  // ─── HTTP HELPERS ────────────────────────────────────────────────────────────

  async _fetch(path, options = {}) {
    const url = `${this.baseUrl}${path}`;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000), ...options });
      if (!resp.ok) return null;
      const text = await resp.text();
      if (!text) return true; // 204 No Content is success
      try { return JSON.parse(text); } catch { return text; }
    } catch {
      return null;
    }
  }

  async _put(path, body) {
    return this._fetch(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async _post(path, body) {
    return this._fetch(path, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async _delete(path) {
    return this._fetch(path, { method: 'DELETE' });
  }

  // ─── HEALTH CHECK ────────────────────────────────────────────────────────────

  async isRunning() {
    try {
      const resp = await fetch(`${this.baseUrl}/product`, {
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
    const data = await this._fetch('/product');
    if (!data) return null;
    return data.name || data.version || 'Resolume Arena';
  }

  // ─── COMPOSITION ─────────────────────────────────────────────────────────────

  async getComposition(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && this._compositionCache && (now - this._cacheTime) < this._CACHE_TTL) {
      return this._compositionCache;
    }
    const data = await this._fetch('/composition');
    if (data) {
      this._compositionCache = data;
      this._cacheTime = now;
    }
    return data;
  }

  async getLayers() {
    const comp = await this.getComposition();
    return comp?.layers || [];
  }

  async getColumns() {
    const comp = await this.getComposition();
    return comp?.columns || [];
  }

  /**
   * Returns a human-readable summary of what's currently playing.
   */
  async getStatus() {
    const running = await this.isRunning();
    if (!running) return { running: false };

    const comp = await this.getComposition();
    if (!comp) return { running: true, error: 'Could not read composition' };

    const layers = comp.layers || [];
    const playing = [];

    for (const layer of layers) {
      const clips = layer.clips || [];
      for (const clip of clips) {
        if (clip.connected?.value) {
          playing.push({
            layer: layer.name?.value || `Layer ${layer.id}`,
            clip: clip.name?.value || `Clip ${clip.id}`,
            layerIndex: layer.id,
            clipIndex: clip.id,
          });
        }
      }
    }

    const bpm = comp.tempo?.bpm?.value || null;
    const masterOpacity = comp.video?.opacity?.value ?? 1;

    return {
      running: true,
      playing,
      bpm,
      masterOpacity,
      layerCount: layers.length,
      columnCount: (comp.columns || []).length,
    };
  }

  // ─── CLIP CONTROL ─────────────────────────────────────────────────────────────

  /**
   * Play a clip by 1-based layer and clip index.
   * Resolume's REST API uses 1-based indices.
   */
  async playClip(layerIndex, clipIndex) {
    const result = await this._post(`/composition/layers/${layerIndex}/clips/${clipIndex}/connect`);
    if (result === null) throw new Error(`Could not play clip (layer ${layerIndex}, clip ${clipIndex})`);
    this._compositionCache = null; // Invalidate cache
    return true;
  }

  async stopClip(layerIndex, clipIndex) {
    const result = await this._delete(`/composition/layers/${layerIndex}/clips/${clipIndex}/connect`);
    if (result === null) throw new Error(`Could not stop clip (layer ${layerIndex}, clip ${clipIndex})`);
    this._compositionCache = null;
    return true;
  }

  /**
   * Find and play a clip by name (fuzzy match).
   * Searches all layers for a clip whose name contains the query.
   */
  async playClipByName(name) {
    const comp = await this.getComposition(true);
    if (!comp) throw new Error('Could not read Resolume composition');

    const needle = name.toLowerCase();
    const layers = comp.layers || [];

    for (const layer of layers) {
      const clips = layer.clips || [];
      for (const clip of clips) {
        const clipName = (clip.name?.value || '').toLowerCase();
        if (clipName.includes(needle)) {
          await this.playClip(layer.id, clip.id);
          return { layer: layer.name?.value || layer.id, clip: clip.name?.value || clip.id };
        }
      }
    }

    throw new Error(`No clip found matching "${name}"`);
  }

  // ─── COLUMN CONTROL (scene triggers) ─────────────────────────────────────────

  /**
   * Trigger a full column (plays all clips in that column across all layers).
   * Great for scene changes during worship.
   */
  async triggerColumn(columnIndex) {
    const result = await this._post(`/composition/columns/${columnIndex}/connect`);
    if (result === null) throw new Error(`Could not trigger column ${columnIndex}`);
    this._compositionCache = null;
    return true;
  }

  /**
   * Find and trigger a column by name.
   */
  async triggerColumnByName(name) {
    const comp = await this.getComposition(true);
    if (!comp) throw new Error('Could not read Resolume composition');

    const needle = name.toLowerCase();
    const columns = comp.columns || [];

    for (const col of columns) {
      const colName = (col.name?.value || '').toLowerCase();
      if (colName.includes(needle)) {
        await this.triggerColumn(col.id);
        return col.name?.value || col.id;
      }
    }

    throw new Error(`No column found matching "${name}"`);
  }

  // ─── LAYER CONTROL ───────────────────────────────────────────────────────────

  /**
   * Set layer opacity (0.0 = invisible, 1.0 = full).
   */
  async setLayerOpacity(layerIndex, value) {
    const clamped = Math.max(0, Math.min(1, parseFloat(value)));
    const result = await this._put(`/composition/layers/${layerIndex}/video/opacity`, { value: clamped });
    if (result === null) throw new Error(`Could not set opacity on layer ${layerIndex}`);
    return clamped;
  }

  // ─── MASTER CONTROL ──────────────────────────────────────────────────────────

  /**
   * Disconnect all clips — full visual blackout.
   */
  async clearAll() {
    const result = await this._post('/composition/disconnectall');
    if (result === null) throw new Error('Could not clear Resolume composition');
    this._compositionCache = null;
    return true;
  }

  /**
   * Set master opacity (0 = black, 1 = full).
   */
  async setMasterOpacity(value) {
    const clamped = Math.max(0, Math.min(1, parseFloat(value)));
    const result = await this._put('/composition/video/opacity', { value: clamped });
    if (result === null) throw new Error('Could not set master opacity');
    return clamped;
  }

  // ─── TEMPO ───────────────────────────────────────────────────────────────────

  async getBpm() {
    const data = await this._fetch('/composition/tempo');
    return data?.bpm?.value || null;
  }

  async setBpm(bpm) {
    const value = parseFloat(bpm);
    if (isNaN(value) || value < 20 || value > 300) throw new Error(`Invalid BPM: ${bpm}`);
    const result = await this._put('/composition/tempo/bpm', { value });
    if (result === null) throw new Error(`Could not set BPM to ${bpm}`);
    return value;
  }

  // ─── STATUS SUMMARY ──────────────────────────────────────────────────────────

  toStatus() {
    return {
      connected: this.running,
      host: this.host,
      port: this.port,
    };
  }
}

module.exports = { Resolume };
