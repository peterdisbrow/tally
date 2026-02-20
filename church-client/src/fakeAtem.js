const { EventEmitter } = require('events');

/**
 * FakeAtem
 * In-memory ATEM simulator for local testing when no hardware is available.
 */
class FakeAtem extends EventEmitter {
  constructor() {
    super();
    this._connected = false;
    this._tickTimer = null;
    this._audioPhase = 0;
    this._inputLabels = new Map();
    this._fadeToBlack = false;
    this._manualAudioUntil = 0;
    this._manualAudio = { left: 18000, right: 17500 };
    this.resetState();
  }

  resetState() {
    this._fadeToBlack = false;
    this._audioPhase = 0;
    this._manualAudioUntil = 0;
    this._manualAudio = { left: 18000, right: 17500 };
    this._inputLabels.clear();

    const inputs = {};
    for (let i = 1; i <= 8; i += 1) {
      const longName = `Camera ${i}`;
      const shortName = `CAM${i}`;
      inputs[i] = {
        longName,
        shortName,
        internalPortType: 0,
        isExternal: true,
      };
      this._inputLabels.set(i, { longName, shortName });
    }

    this.state = {
      video: {
        mixEffects: [
          {
            programInput: 1,
            previewInput: 2,
            transitionPosition: { inTransition: false },
            transitionProperties: { style: 'mix', rate: 25 },
            upstreamKeyers: {
              0: { onAir: false, tie: false, type: 'luma', fillSource: 3, keySource: 4 },
            },
          },
        ],
        fadeToBlack: { isFullyBlack: false },
        downstreamKeyers: {
          0: { onAir: false, tie: false, rate: 25, fillSource: 3, keySource: 4 },
        },
        auxiliaries: {
          1: 1,
          2: 2,
        },
        superSource: {
          art: {
            enabled: false,
            fillSource: 1,
            cutSource: 2,
            premultiplied: false,
            clip: 0,
            gain: 0,
            invert: false,
          },
          boxes: {
            0: { enabled: false, input: 1, x: -0.35, y: 0.2, size: 0.5, cropped: false },
            1: { enabled: false, input: 2, x: 0.35, y: 0.2, size: 0.5, cropped: false },
            2: { enabled: false, input: 3, x: -0.35, y: -0.2, size: 0.5, cropped: false },
            3: { enabled: false, input: 4, x: 0.35, y: -0.2, size: 0.5, cropped: false },
          },
        },
        colorGenerators: {
          1: { hue: 0, saturation: 0, luma: 0 },
          2: { hue: 0, saturation: 0, luma: 0 },
        },
        mediaPlayers: {
          1: { sourceType: 'still', sourceIndex: 1, playing: false },
          2: { sourceType: 'still', sourceIndex: 2, playing: false },
        },
      },
      recording: { status: 'Idle' },
      hyperdecks: {
        0: { status: 'stopped', clip: 1 },
        1: { status: 'stopped', clip: 1 },
      },
      audio: {
        master: { left: 18000, right: 17500 },
        classic: {
          channels: {
            1: { delay: 0 },
            2: { delay: 0 },
            3: { delay: 0 },
            4: { delay: 0 },
          },
        },
      },
      inputs,
      macros: {
        running: false,
        lastRun: null,
        lastFinished: null,
      },
      ptz: {
        cameras: {
          1: { pan: 0, tilt: 0, zoom: 0, preset: 1 },
          2: { pan: 0, tilt: 0, zoom: 0, preset: 1 },
        },
      },
    };
    this._emitState('reset');
  }

  async connect() {
    if (this._connected) return;
    this._connected = true;
    this.emit('connected');
    this._emitState('connected');
    this._startTicker();
  }

  async disconnect() {
    if (!this._connected) return;
    this._connected = false;
    this._stopTicker();
    this.emit('disconnected');
  }

  destroy() {
    this._stopTicker();
    this.removeAllListeners();
  }

  _startTicker() {
    this._stopTicker();
    this._tickTimer = setInterval(() => {
      if (Date.now() < this._manualAudioUntil) {
        this.state.audio.master.left = this._manualAudio.left;
        this.state.audio.master.right = this._manualAudio.right;
      } else {
        // Oscillate master level so audio watchdog sees active signal.
        this._audioPhase += 1;
        const wave = Math.sin(this._audioPhase / 3);
        const base = 16000;
        const spread = 3000;
        this.state.audio.master.left = Math.max(500, Math.round(base + (wave * spread)));
        this.state.audio.master.right = Math.max(500, Math.round(base + (Math.cos(this._audioPhase / 4) * spread)));
      }
      this._emitState('audio.master');
    }, 1000);
  }

  _stopTicker() {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
  }

  _emitState(path) {
    this.emit('stateChanged', this.state, path || '');
  }

  _me(index) {
    if (!this.state.video.mixEffects[index]) {
      this.state.video.mixEffects[index] = {
        programInput: 1,
        previewInput: 2,
        transitionPosition: { inTransition: false },
        transitionProperties: { style: 'mix', rate: 25 },
        upstreamKeyers: {
          0: { onAir: false, tie: false, type: 'luma', fillSource: 3, keySource: 4 },
        },
      };
    }
    if (!this.state.video.mixEffects[index].transitionProperties) {
      this.state.video.mixEffects[index].transitionProperties = { style: 'mix', rate: 25 };
    }
    if (!this.state.video.mixEffects[index].upstreamKeyers) {
      this.state.video.mixEffects[index].upstreamKeyers = {
        0: { onAir: false, tie: false, type: 'luma', fillSource: 3, keySource: 4 },
      };
    }
    return this.state.video.mixEffects[index];
  }

  _getUpstreamKeyer(me = 0, keyer = 0) {
    const m = this._me(me);
    if (!m.upstreamKeyers[keyer]) {
      m.upstreamKeyers[keyer] = { onAir: false, tie: false, type: 'luma', fillSource: 3, keySource: 4 };
    }
    return m.upstreamKeyers[keyer];
  }

  _getDownstreamKeyer(keyer = 0) {
    if (!this.state.video.downstreamKeyers[keyer]) {
      this.state.video.downstreamKeyers[keyer] = { onAir: false, tie: false, rate: 25, fillSource: 3, keySource: 4 };
    }
    return this.state.video.downstreamKeyers[keyer];
  }

  _getSuperSourceBox(box = 0) {
    const idx = Math.max(0, Math.min(3, Number(box) || 0));
    if (!this.state.video.superSource) {
      this.state.video.superSource = { art: {}, boxes: {} };
    }
    if (!this.state.video.superSource.boxes) {
      this.state.video.superSource.boxes = {};
    }
    if (!this.state.video.superSource.boxes[idx]) {
      this.state.video.superSource.boxes[idx] = {
        enabled: false,
        input: idx + 1,
        x: 0,
        y: 0,
        size: 0.5,
        cropped: false,
      };
    }
    return this.state.video.superSource.boxes[idx];
  }

  _getColorGenerator(index = 1) {
    const idx = Math.max(1, Number(index) || 1);
    if (!this.state.video.colorGenerators) {
      this.state.video.colorGenerators = {};
    }
    if (!this.state.video.colorGenerators[idx]) {
      this.state.video.colorGenerators[idx] = { hue: 0, saturation: 0, luma: 0 };
    }
    return this.state.video.colorGenerators[idx];
  }

  _getMediaPlayer(player = 1) {
    const p = Number(player) || 1;
    if (!this.state.video.mediaPlayers[p]) {
      this.state.video.mediaPlayers[p] = { sourceType: 'still', sourceIndex: 1, playing: false };
    }
    return this.state.video.mediaPlayers[p];
  }

  _getPtzCamera(camera = 1) {
    const c = Number(camera) || 1;
    if (!this.state.ptz.cameras[c]) {
      this.state.ptz.cameras[c] = { pan: 0, tilt: 0, zoom: 0, preset: 1 };
    }
    return this.state.ptz.cameras[c];
  }

  async cut(me = 0) {
    const m = this._me(me);
    const nextProgram = m.previewInput;
    m.previewInput = m.programInput;
    m.programInput = nextProgram;
    this._emitState(`video.mixEffects.${me}.cut`);
  }

  async autoTransition(me = 0) {
    const m = this._me(me);
    const rate = Number(m.transitionProperties?.rate) || 25;
    const duration = Math.max(200, Math.min(3000, Math.round((rate / 30) * 1000)));

    m.transitionPosition.inTransition = true;
    this._emitState(`video.mixEffects.${me}.auto.start`);
    setTimeout(() => {
      const nextProgram = m.previewInput;
      m.previewInput = m.programInput;
      m.programInput = nextProgram;
      m.transitionPosition.inTransition = false;
      this._emitState(`video.mixEffects.${me}.auto.end`);
    }, duration);
  }

  async changeProgramInput(me = 0, input = 1) {
    const m = this._me(me);
    m.programInput = Number(input) || 1;
    this._emitState(`video.mixEffects.${me}.program`);
  }

  async changePreviewInput(me = 0, input = 2) {
    const m = this._me(me);
    m.previewInput = Number(input) || 2;
    this._emitState(`video.mixEffects.${me}.preview`);
  }

  async setTransitionStyle(me = 0, style = 'mix') {
    const m = this._me(me);
    const normalized = String(style || '').toLowerCase();
    const allowed = new Set(['mix', 'dip', 'wipe', 'dve', 'sting']);
    m.transitionProperties.style = allowed.has(normalized) ? normalized : 'mix';
    this._emitState(`video.mixEffects.${me}.transition.style`);
  }

  async setTransitionRate(me = 0, rate = 25) {
    const m = this._me(me);
    const n = Number(rate);
    m.transitionProperties.rate = Number.isFinite(n) ? Math.max(1, Math.min(250, Math.round(n))) : 25;
    this._emitState(`video.mixEffects.${me}.transition.rate`);
  }

  async setAuxSource(aux = 1, input = 1) {
    const auxIdx = Math.max(1, Number(aux) || 1);
    const src = Math.max(1, Number(input) || 1);
    this.state.video.auxiliaries[auxIdx] = src;
    this._emitState(`video.auxiliaries.${auxIdx}`);
  }

  async setUpstreamKeyerOnAir(me = 0, keyer = 0, onAir = false) {
    const usk = this._getUpstreamKeyer(me, keyer);
    usk.onAir = !!onAir;
    this._emitState(`video.mixEffects.${me}.upstreamKeyers.${keyer}.onAir`);
  }

  async setUpstreamKeyerTie(me = 0, keyer = 0, tie = false) {
    const usk = this._getUpstreamKeyer(me, keyer);
    usk.tie = !!tie;
    this._emitState(`video.mixEffects.${me}.upstreamKeyers.${keyer}.tie`);
  }

  async setUpstreamKeyerType(me = 0, keyer = 0, type = 'luma') {
    const usk = this._getUpstreamKeyer(me, keyer);
    const normalized = String(type || '').toLowerCase();
    const allowed = new Set(['luma', 'chroma', 'pattern', 'dve']);
    usk.type = allowed.has(normalized) ? normalized : 'luma';
    this._emitState(`video.mixEffects.${me}.upstreamKeyers.${keyer}.type`);
  }

  async setUpstreamKeyerSources(me = 0, keyer = 0, fillSource = 1, keySource = 2) {
    const usk = this._getUpstreamKeyer(me, keyer);
    usk.fillSource = Math.max(1, Number(fillSource) || 1);
    usk.keySource = Math.max(1, Number(keySource) || 2);
    this._emitState(`video.mixEffects.${me}.upstreamKeyers.${keyer}.sources`);
  }

  async setDownstreamKeyerOnAir(keyer = 0, onAir = false) {
    const dsk = this._getDownstreamKeyer(keyer);
    dsk.onAir = !!onAir;
    this._emitState(`video.downstreamKeyers.${keyer}.onAir`);
  }

  async setDownstreamKeyerTie(keyer = 0, tie = false) {
    const dsk = this._getDownstreamKeyer(keyer);
    dsk.tie = !!tie;
    this._emitState(`video.downstreamKeyers.${keyer}.tie`);
  }

  async setDownstreamKeyerRate(keyer = 0, rate = 25) {
    const dsk = this._getDownstreamKeyer(keyer);
    const n = Number(rate);
    dsk.rate = Number.isFinite(n) ? Math.max(1, Math.min(250, Math.round(n))) : 25;
    this._emitState(`video.downstreamKeyers.${keyer}.rate`);
  }

  async setDownstreamKeyerSource(keyer = 0, fillSource = 1, keySource = 2) {
    const dsk = this._getDownstreamKeyer(keyer);
    dsk.fillSource = Math.max(1, Number(fillSource) || 1);
    dsk.keySource = Math.max(1, Number(keySource) || 2);
    this._emitState(`video.downstreamKeyers.${keyer}.sources`);
  }

  async setSuperSourceArt(settings = {}) {
    if (!this.state.video.superSource) {
      this.state.video.superSource = { art: {}, boxes: {} };
    }
    if (!this.state.video.superSource.art) {
      this.state.video.superSource.art = {};
    }

    const art = this.state.video.superSource.art;
    if (settings.enabled !== undefined) art.enabled = !!settings.enabled;
    if (settings.fillSource !== undefined) art.fillSource = Math.max(1, Number(settings.fillSource) || 1);
    if (settings.cutSource !== undefined) art.cutSource = Math.max(1, Number(settings.cutSource) || 1);
    if (settings.premultiplied !== undefined) art.premultiplied = !!settings.premultiplied;
    if (settings.clip !== undefined) {
      const clip = Number(settings.clip);
      art.clip = Number.isFinite(clip) ? Math.max(0, Math.min(1000, Math.round(clip))) : art.clip || 0;
    }
    if (settings.gain !== undefined) {
      const gain = Number(settings.gain);
      art.gain = Number.isFinite(gain) ? Math.max(0, Math.min(1000, Math.round(gain))) : art.gain || 0;
    }
    if (settings.invert !== undefined) art.invert = !!settings.invert;
    this._emitState('video.superSource.art');
  }

  async setSuperSourceBox(box = 0, settings = {}) {
    const b = this._getSuperSourceBox(box);
    if (settings.enabled !== undefined) b.enabled = !!settings.enabled;
    if (settings.input !== undefined) b.input = Math.max(1, Number(settings.input) || 1);
    if (settings.x !== undefined) {
      const x = Number(settings.x);
      b.x = Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : b.x;
    }
    if (settings.y !== undefined) {
      const y = Number(settings.y);
      b.y = Number.isFinite(y) ? Math.max(-1, Math.min(1, y)) : b.y;
    }
    if (settings.size !== undefined) {
      const size = Number(settings.size);
      b.size = Number.isFinite(size) ? Math.max(0.05, Math.min(1, size)) : b.size;
    }
    if (settings.cropped !== undefined) b.cropped = !!settings.cropped;
    this._emitState(`video.superSource.boxes.${Math.max(0, Math.min(3, Number(box) || 0))}`);
  }

  async setColorGenerator(index = 1, hue = 0, saturation = 0, luma = 0) {
    const cg = this._getColorGenerator(index);
    const h = Number(hue);
    const s = Number(saturation);
    const l = Number(luma);
    cg.hue = Number.isFinite(h) ? Math.max(0, Math.min(359, Math.round(h))) : cg.hue;
    cg.saturation = Number.isFinite(s) ? Math.max(0, Math.min(1000, Math.round(s))) : cg.saturation;
    cg.luma = Number.isFinite(l) ? Math.max(0, Math.min(1000, Math.round(l))) : cg.luma;
    this._emitState(`video.colorGenerators.${Math.max(1, Number(index) || 1)}`);
  }

  async runMacro(index = 0) {
    const idx = Math.max(0, Number(index) || 0);
    this.state.macros.running = true;
    this.state.macros.lastRun = idx;
    this._emitState('macros.running');
    setTimeout(() => {
      this.state.macros.running = false;
      this.state.macros.lastFinished = idx;
      this._emitState('macros.finished');
    }, 500);
  }

  async stopMacro() {
    this.state.macros.running = false;
    this._emitState('macros.running');
  }

  async setMediaPlayerSource(player = 1, sourceType = 'still', sourceIndex = 1) {
    const mp = this._getMediaPlayer(player);
    mp.sourceType = String(sourceType || 'still').toLowerCase() === 'clip' ? 'clip' : 'still';
    mp.sourceIndex = Math.max(1, Number(sourceIndex) || 1);
    this._emitState(`video.mediaPlayers.${player}.source`);
  }

  async setMediaPlayerPlaying(player = 1, playing = false) {
    const mp = this._getMediaPlayer(player);
    mp.playing = !!playing;
    this._emitState(`video.mediaPlayers.${player}.playing`);
  }

  async setRecordingAction(opts = {}) {
    this.state.recording.status = opts.action === 1 ? 'Recording' : 'Idle';
    this._emitState('recording.status');
  }

  async setFadeToBlackState() {
    this._fadeToBlack = !this._fadeToBlack;
    this.state.video.fadeToBlack = { isFullyBlack: this._fadeToBlack };
    this._emitState('video.fadeToBlack');
  }

  async setFadeToBlack(enabled) {
    this._fadeToBlack = !!enabled;
    this.state.video.fadeToBlack = { isFullyBlack: this._fadeToBlack };
    this._emitState('video.fadeToBlack');
  }

  async setMasterAudioLevels(left, right, holdMs = 15_000) {
    const l = Math.max(0, Math.min(32768, Number(left) || 0));
    const r = Math.max(0, Math.min(32768, Number(right ?? left) || 0));
    this._manualAudio = { left: l, right: r };
    this._manualAudioUntil = Date.now() + Math.max(1000, Number(holdMs) || 15_000);
    this.state.audio.master.left = l;
    this.state.audio.master.right = r;
    this._emitState('audio.master.manual');
  }

  async setAudioDelay(input, delay) {
    const idx = Number(input);
    if (!Number.isFinite(idx) || idx < 1) return;
    if (!this.state.audio.classic.channels[idx]) {
      this.state.audio.classic.channels[idx] = { delay: 0 };
    }
    this.state.audio.classic.channels[idx].delay = Number(delay) || 0;
    this._emitState(`audio.classic.channels.${idx}.delay`);
  }

  async setInputSettings(input, settings = {}) {
    const idx = Math.max(1, Number(input) || 1);
    const longName = settings.longName || `Input ${idx}`;
    const shortName = settings.shortName || longName.substring(0, 4).toUpperCase();

    this._inputLabels.set(idx, { longName, shortName });
    if (!this.state.inputs[idx]) {
      this.state.inputs[idx] = { internalPortType: 0, isExternal: true };
    }
    this.state.inputs[idx].longName = longName;
    this.state.inputs[idx].shortName = shortName;
    this._emitState(`inputs.${idx}.label`);
  }

  async setHyperDeckPlay(index = 0) {
    const key = Number(index) || 0;
    const hd = this._getHyperdeck(key);
    hd.status = 'playing';
    this._emitState(`hyperdecks.${key}.status`);
  }

  async setHyperDeckStop(index = 0) {
    const key = Number(index) || 0;
    const hd = this._getHyperdeck(key);
    hd.status = 'stopped';
    this._emitState(`hyperdecks.${key}.status`);
  }

  async setHyperDeckRecord(index = 0) {
    const key = Number(index) || 0;
    const hd = this._getHyperdeck(key);
    hd.status = 'recording';
    this._emitState(`hyperdecks.${key}.status`);
  }

  async setHyperDeckNextClip(index = 0) {
    const key = Number(index) || 0;
    const hd = this._getHyperdeck(key);
    hd.clip += 1;
    this._emitState(`hyperdecks.${key}.clip`);
  }

  async setHyperDeckPrevClip(index = 0) {
    const key = Number(index) || 0;
    const hd = this._getHyperdeck(key);
    hd.clip = Math.max(1, hd.clip - 1);
    this._emitState(`hyperdecks.${key}.clip`);
  }

  async setCameraControlPanTilt(camera = 1, pan = 0, tilt = 0) {
    const cam = this._getPtzCamera(camera);
    cam.pan = Math.max(-1, Math.min(1, Number(pan) || 0));
    cam.tilt = Math.max(-1, Math.min(1, Number(tilt) || 0));
    this._emitState(`ptz.cameras.${camera}.panTilt`);
  }

  async setCameraControlZoom(camera = 1, zoom = 0) {
    const cam = this._getPtzCamera(camera);
    cam.zoom = Math.max(-1, Math.min(1, Number(zoom) || 0));
    this._emitState(`ptz.cameras.${camera}.zoom`);
  }

  async setCameraControlPreset(camera = 1, preset = 1) {
    const cam = this._getPtzCamera(camera);
    cam.preset = Math.max(1, Number(preset) || 1);
    this._emitState(`ptz.cameras.${camera}.preset`);
  }

  _getHyperdeck(index) {
    if (!this.state.hyperdecks[index]) {
      this.state.hyperdecks[index] = { status: 'stopped', clip: 1 };
    }
    return this.state.hyperdecks[index];
  }

  getSnapshot() {
    const me0 = this.state.video?.mixEffects?.[0] || {};
    return {
      connected: this._connected,
      programInput: me0.programInput ?? null,
      previewInput: me0.previewInput ?? null,
      inTransition: !!me0.transitionPosition?.inTransition,
      transition: {
        style: me0.transitionProperties?.style || 'mix',
        rate: me0.transitionProperties?.rate || 25,
      },
      recording: this.state.recording?.status === 'Recording',
      fadeToBlack: !!this._fadeToBlack,
      audio: {
        left: this.state.audio?.master?.left ?? 0,
        right: this.state.audio?.master?.right ?? 0,
      },
      delays: Object.fromEntries(
        Object.entries(this.state.audio?.classic?.channels || {}).map(([k, v]) => [k, v?.delay ?? 0])
      ),
      labels: Object.fromEntries(this._inputLabels.entries()),
      aux: { ...(this.state.video?.auxiliaries || {}) },
      upstreamKeyers: { ...(me0.upstreamKeyers || {}) },
      downstreamKeyers: { ...(this.state.video?.downstreamKeyers || {}) },
      superSource: JSON.parse(JSON.stringify(this.state.video?.superSource || {})),
      colorGenerators: JSON.parse(JSON.stringify(this.state.video?.colorGenerators || {})),
      mediaPlayers: { ...(this.state.video?.mediaPlayers || {}) },
      macros: { ...(this.state.macros || {}) },
      ptz: { ...(this.state.ptz?.cameras || {}) },
      hyperdecks: Object.fromEntries(
        Object.entries(this.state.hyperdecks || {}).map(([k, v]) => [k, { status: v.status, clip: v.clip }])
      ),
    };
  }
}

module.exports = { FakeAtem };
