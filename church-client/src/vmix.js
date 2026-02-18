/**
 * vMix Integration
 * HTTP API on port 8088 (default) — vMix Basic HD, HD, 4K, Pro, Max
 *
 * vMix is purpose-built for live production and significantly more stable
 * than OBS in volunteer-operated church environments. Windows only.
 *
 * API: GET http://{host}:{port}/api/?Function={name}&{params}
 * Status: GET http://{host}:{port}/api/?Function=GetShortXML
 */

class VMix {
  constructor({ host = 'localhost', port = 8088 } = {}) {
    this.host = host;
    this.port = port;
    this.running = false;
    this._stateCache = null;
    this._cacheTime = 0;
    this._CACHE_TTL = 3000; // 3s state cache
  }

  get baseUrl() {
    return `http://${this.host}:${this.port}/api/`;
  }

  // ─── HTTP HELPERS ─────────────────────────────────────────────────────────

  async _call(fn, params = {}) {
    const qs = new URLSearchParams({ Function: fn, ...params }).toString();
    const url = `${this.baseUrl}?${qs}`;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return null;
      return await resp.text();
    } catch {
      return null;
    }
  }

  // ─── XML PARSING ──────────────────────────────────────────────────────────

  _extractTag(xml, tag) {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'));
    return m ? m[1].trim() : null;
  }

  _extractAttr(xml, tag, attr) {
    const m = xml.match(new RegExp(`<${tag}\\b[^>]*\\b${attr}="([^"]*)"`, 'i'));
    return m ? m[1] : null;
  }

  _parseInputs(xml) {
    const inputs = [];
    const re = /<input\s([^>]+)\/>/gi;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const attrs = m[1];
      const getAttr = (a) => {
        const am = attrs.match(new RegExp(`\\b${a}="([^"]*)"`,'i'));
        return am ? am[1] : null;
      };
      inputs.push({
        key: getAttr('key'),
        number: parseInt(getAttr('number') || '0'),
        type: getAttr('type'),
        title: getAttr('title'),
        state: getAttr('state'),
        muted: getAttr('muted') === 'True',
        volume: parseFloat(getAttr('volume') || '100'),
      });
    }
    return inputs;
  }

  _parseAudio(xml) {
    const m = xml.match(/<master\s([^>]+)\/>/i);
    if (!m) return null;
    const attrs = m[1];
    const getAttr = (a) => {
      const am = attrs.match(new RegExp(`\\b${a}="([^"]*)"`,'i'));
      return am ? am[1] : null;
    };
    return {
      volume: parseFloat(getAttr('volume') || '100'),
      muted: getAttr('muted') === 'True',
      meterL: parseFloat(getAttr('meterF1') || '0'),
      meterR: parseFloat(getAttr('meterF2') || '0'),
    };
  }

  // ─── HEALTH CHECK ─────────────────────────────────────────────────────────

  async isRunning() {
    try {
      const resp = await fetch(`${this.baseUrl}?Function=GetShortXML`, {
        method: 'HEAD',
        signal: AbortSignal.timeout(3000),
      });
      this.running = resp.ok;
      return this.running;
    } catch {
      // HEAD may not work — try GET of a minimal endpoint
      try {
        const resp = await fetch(`${this.baseUrl}?Function=GetShortXML`, {
          signal: AbortSignal.timeout(3000),
        });
        this.running = resp.ok;
        return this.running;
      } catch {
        this.running = false;
        return false;
      }
    }
  }

  // ─── STATE ────────────────────────────────────────────────────────────────

  async getState(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && this._stateCache && (now - this._cacheTime) < this._CACHE_TTL) {
      return this._stateCache;
    }
    const xml = await this._call('GetShortXML');
    if (!xml) return null;

    const state = {
      version: this._extractTag(xml, 'version'),
      edition: this._extractTag(xml, 'edition'),
      streaming: this._extractTag(xml, 'stream') === 'True',
      recording: this._extractTag(xml, 'recording') === 'True',
      external: this._extractTag(xml, 'external') === 'True',
      playList: this._extractTag(xml, 'playList') === 'True',
      multiCorder: this._extractTag(xml, 'multiCorder') === 'True',
      fullscreen: this._extractTag(xml, 'fullscreen') === 'True',
      activeInput: parseInt(this._extractTag(xml, 'active') || '0'),
      previewInput: parseInt(this._extractTag(xml, 'preview') || '0'),
      inputs: this._parseInputs(xml),
      audio: this._parseAudio(xml),
    };

    this._stateCache = state;
    this._cacheTime = now;
    return state;
  }

  async getStatus() {
    const running = await this.isRunning();
    if (!running) return { running: false };

    const state = await this.getState(true);
    if (!state) return { running: true, error: 'Could not read vMix state' };

    const activeInput = state.inputs.find(i => i.number === state.activeInput);
    const previewInput = state.inputs.find(i => i.number === state.previewInput);

    return {
      running: true,
      edition: state.edition,
      version: state.version,
      streaming: state.streaming,
      recording: state.recording,
      activeInput: activeInput ? `${activeInput.number}: ${activeInput.title}` : state.activeInput,
      previewInput: previewInput ? `${previewInput.number}: ${previewInput.title}` : state.previewInput,
      inputCount: state.inputs.length,
      audio: state.audio,
    };
  }

  // ─── SWITCHING ────────────────────────────────────────────────────────────

  async cut() {
    const result = await this._call('Cut');
    if (result === null) throw new Error('Could not send Cut to vMix');
    this._stateCache = null;
    return true;
  }

  async fade(durationMs = 2000) {
    const result = await this._call('Fade', { Duration: durationMs });
    if (result === null) throw new Error('Could not send Fade to vMix');
    this._stateCache = null;
    return true;
  }

  async setPreview(input) {
    const result = await this._call('PreviewInput', { Input: input });
    if (result === null) throw new Error(`Could not set preview to ${input}`);
    this._stateCache = null;
    return true;
  }

  async setProgram(input) {
    const result = await this._call('ActiveInput', { Input: input });
    if (result === null) throw new Error(`Could not set program to ${input}`);
    this._stateCache = null;
    return true;
  }

  // ─── STREAMING ────────────────────────────────────────────────────────────

  async startStream(destination = null) {
    const params = destination !== null ? { StreamingChannel: destination } : {};
    const result = await this._call('StartStreaming', params);
    if (result === null) throw new Error('Could not start vMix stream');
    this._stateCache = null;
    return true;
  }

  async stopStream(destination = null) {
    const params = destination !== null ? { StreamingChannel: destination } : {};
    const result = await this._call('StopStreaming', params);
    if (result === null) throw new Error('Could not stop vMix stream');
    this._stateCache = null;
    return true;
  }

  // ─── RECORDING ────────────────────────────────────────────────────────────

  async startRecording() {
    const result = await this._call('StartRecording');
    if (result === null) throw new Error('Could not start vMix recording');
    this._stateCache = null;
    return true;
  }

  async stopRecording() {
    const result = await this._call('StopRecording');
    if (result === null) throw new Error('Could not stop vMix recording');
    this._stateCache = null;
    return true;
  }

  // ─── AUDIO ────────────────────────────────────────────────────────────────

  async setMasterVolume(value) {
    const vol = Math.max(0, Math.min(100, parseInt(value)));
    const result = await this._call('SetVolume', { Input: 'Master', Value: vol });
    if (result === null) throw new Error('Could not set master volume');
    return vol;
  }

  async muteMaster() {
    const result = await this._call('MuteInput', { Input: 'Master' });
    if (result === null) throw new Error('Could not mute master');
    return true;
  }

  async unmuteMaster() {
    const result = await this._call('UnmuteInput', { Input: 'Master' });
    if (result === null) throw new Error('Could not unmute master');
    return true;
  }

  async getAudioLevels() {
    const state = await this.getState();
    return state?.audio || null;
  }

  // ─── PLAYLIST ─────────────────────────────────────────────────────────────

  async startPlaylist() {
    const result = await this._call('StartPlayList');
    if (result === null) throw new Error('Could not start vMix playlist');
    return true;
  }

  async stopPlaylist() {
    const result = await this._call('StopPlayList');
    if (result === null) throw new Error('Could not stop vMix playlist');
    return true;
  }

  // ─── INPUTS ────────────────────────────────────────────────────────────────

  async listInputs() {
    const state = await this.getState(true);
    return state?.inputs || [];
  }

  // ─── SCREENSHOT ───────────────────────────────────────────────────────────

  /**
   * Get a JPEG screenshot of a vMix input (or program output if no input given).
   * Returns base64 string or null.
   */
  async getScreenshot(input = 'Output') {
    try {
      const url = `http://${this.host}:${this.port}/api/snapshot?input=${encodeURIComponent(input)}&width=720&height=405&format=jpg`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) return null;
      const buf = await resp.arrayBuffer();
      return Buffer.from(buf).toString('base64');
    } catch {
      return null;
    }
  }

  // ─── STATUS ───────────────────────────────────────────────────────────────

  toStatus() {
    return {
      connected: this.running,
      host: this.host,
      port: this.port,
    };
  }
}

module.exports = { VMix };
