class FakeMixerBridge {
  constructor(config = {}) {
    const type = String(config.type || 'behringer').toLowerCase();
    this.type = type === 'x32' ? 'behringer' : type;
    this.model = config.model || (type === 'x32' ? 'X32' : 'Mock X32');
    this._online = false;

    this._mainMuted = false;
    this._mainFader = 0.78;
    this._scene = 1;
    this._channels = new Map();
    for (let i = 1; i <= 32; i += 1) {
      this._channels.set(String(i), { muted: false, fader: 0.72 });
    }
  }

  async connect() {
    this._online = true;
  }

  async disconnect() {
    this._online = false;
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
    };
  }

  _channelRef(channel) {
    const key = String(channel);
    if (!this._channels.has(key)) {
      this._channels.set(key, { muted: false, fader: 0.7 });
    }
    return this._channels.get(key);
  }

  async muteChannel(channel) {
    this._channelRef(channel).muted = true;
  }

  async unmuteChannel(channel) {
    this._channelRef(channel).muted = false;
  }

  async getChannelStatus(channel) {
    const ch = this._channelRef(channel);
    return { muted: ch.muted, fader: ch.fader };
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
    return {
      online: this._online,
      type: this.type,
      model: this.model,
      mainMuted: this._mainMuted,
      mainFader: this._mainFader,
      scene: this._scene,
    };
  }
}

module.exports = { FakeMixerBridge };
