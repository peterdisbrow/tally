class FakeMixerBridge {
  constructor(config = {}) {
    const type = String(config.type || 'behringer').toLowerCase();
    this.type = type === 'x32' ? 'behringer' : type;
    this.model = config.model || (type === 'x32' ? 'X32' : 'Mock X32');
    this._online = false;
    this._meterTick = null;
    this._meterPhase = 0;

    this.resetState();
  }

  async connect() {
    this._online = true;
    this._startMeterTicker();
  }

  async disconnect() {
    this._online = false;
    this._stopMeterTicker();
  }

  resetState() {
    this._mainMuted = false;
    this._mainFader = 0.78;
    this._scene = 1;
    this._selectedChannel = 1;
    this._channels = new Map();
    for (let i = 1; i <= 32; i += 1) {
      this._channels.set(String(i), {
        name: `CH ${i}`,
        muted: false,
        solo: false,
        fader: 0.72,
        gainDb: 0,
        pan: 0,
        meterPre: 0.18,
        meterPost: 0.14,
      });
    }
  }

  _startMeterTicker() {
    this._stopMeterTicker();
    this._meterTick = setInterval(() => {
      this._meterPhase += 1;
      this._channels.forEach((ch, idx) => {
        const seed = Number(idx) / 6 + this._meterPhase / 4;
        const wave = (Math.sin(seed) + 1) / 2;
        const base = ch.muted ? 0.0 : wave;
        const gainBoost = 1 + (ch.gainDb / 24);
        const pre = Math.max(0, Math.min(1, base * 0.85 * gainBoost));
        const post = Math.max(0, Math.min(1, pre * ch.fader * (this._mainMuted ? 0 : this._mainFader)));
        ch.meterPre = Number(pre.toFixed(3));
        ch.meterPost = Number(post.toFixed(3));
      });
    }, 280);
  }

  _stopMeterTicker() {
    if (this._meterTick) {
      clearInterval(this._meterTick);
      this._meterTick = null;
    }
  }

  async isOnline() {
    return this._online;
  }

  async getStatus() {
    return {
      online: this._online,
      type: this.type,
      model: this.model,
      mainFader: this._mainFader,
      mainMuted: this._mainMuted,
      scene: this._scene,
      selectedChannel: this._selectedChannel,
    };
  }

  _channelRef(channel) {
    const idx = Math.max(1, Math.min(32, Number(channel) || 1));
    const key = String(idx);
    if (!this._channels.has(key)) {
      this._channels.set(key, {
        name: `CH ${idx}`,
        muted: false,
        solo: false,
        fader: 0.72,
        gainDb: 0,
        pan: 0,
        meterPre: 0.18,
        meterPost: 0.14,
      });
    }
    return this._channels.get(key);
  }

  async muteChannel(channel) {
    this._channelRef(channel).muted = true;
  }

  async unmuteChannel(channel) {
    this._channelRef(channel).muted = false;
  }

  async setChannelMute(channel, muted) {
    this._channelRef(channel).muted = !!muted;
  }

  async setChannelSolo(channel, solo) {
    this._channelRef(channel).solo = !!solo;
  }

  async setChannelFader(channel, level) {
    this._channelRef(channel).fader = Math.max(0, Math.min(1, Number(level) || 0));
  }

  async setChannelGain(channel, gainDb) {
    this._channelRef(channel).gainDb = Math.max(-24, Math.min(24, Number(gainDb) || 0));
  }

  async setChannelPan(channel, pan) {
    this._channelRef(channel).pan = Math.max(-1, Math.min(1, Number(pan) || 0));
  }

  async setChannelLabel(channel, name = '') {
    const idx = Math.max(1, Math.min(32, Number(channel) || 1));
    const clean = String(name || '').trim();
    this._channelRef(idx).name = clean ? clean.slice(0, 14) : `CH ${idx}`;
  }

  async setSelectedChannel(channel) {
    this._selectedChannel = Math.max(1, Math.min(32, Number(channel) || 1));
  }

  async getChannelStatus(channel) {
    const ch = this._channelRef(channel);
    return {
      name: ch.name,
      muted: ch.muted,
      solo: ch.solo,
      fader: ch.fader,
      gainDb: ch.gainDb,
      pan: ch.pan,
      meterPre: ch.meterPre,
      meterPost: ch.meterPost,
    };
  }

  async setFader(channel, level) {
    const value = Math.max(0, Math.min(1, Number(level) || 0));
    if (String(channel).toLowerCase() === 'master') {
      this._mainFader = value;
      return;
    }
    this._channelRef(channel).fader = value;
  }

  async muteMaster() {
    this._mainMuted = true;
  }

  async unmuteMaster() {
    this._mainMuted = false;
  }

  async recallScene(scene) {
    this._scene = Number(scene) || this._scene;
  }

  async clearSolos() {
    // no-op in fake mixer
  }

  setOnline(online) {
    this._online = !!online;
    if (this._online) this._startMeterTicker();
    else this._stopMeterTicker();
  }

  setMainMuted(muted) {
    this._mainMuted = !!muted;
  }

  setMainFader(level) {
    this._mainFader = Math.max(0, Math.min(1, Number(level) || 0));
  }

  setScene(scene) {
    const next = Number(scene);
    if (Number.isFinite(next) && next > 0) this._scene = next;
  }

  getSnapshot() {
    const channels = {};
    this._channels.forEach((ch, key) => {
      channels[key] = {
        name: ch.name,
        muted: ch.muted,
        solo: ch.solo,
        fader: ch.fader,
        gainDb: ch.gainDb,
        pan: ch.pan,
        meterPre: ch.meterPre,
        meterPost: ch.meterPost,
      };
    });

    const selected = channels[String(this._selectedChannel)] || null;

    return {
      online: this._online,
      type: this.type,
      model: this.model,
      mainMuted: this._mainMuted,
      mainFader: this._mainFader,
      scene: this._scene,
      selectedChannel: this._selectedChannel,
      channels,
      selected,
    };
  }
}

module.exports = { FakeMixerBridge };
