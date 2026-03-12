const { EventEmitter } = require('events');

class FakeProPresenter extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.running = true;
    this.triggerMode = 'presentation';

    this._presentationName = 'Sunday Service';
    this._presentationUUID = 'fake-uuid-001';
    this._slideIndex = 0;
    this._slideTotal = 12;
    this._version = '7.16';

    this._playlist = [
      { name: 'Pre-Service Loop', type: 'presentation' },
      { name: 'Welcome', type: 'presentation' },
      { name: 'Worship Set', type: 'presentation' },
      { name: 'Message Slides', type: 'presentation' },
      { name: 'Announcements', type: 'presentation' },
    ];

    this._activeLook = { id: 'look-2', name: 'Worship' };
    this._activeTimers = [
      { id: 'timer-1', name: 'Sermon Timer', time: '24:15', state: 'Running' },
      { id: 'timer-2', name: 'Countdown', time: '00:00', state: 'Stopped' },
    ];
    this._screenStatus = { audience: true, stage: true };
    this._playlistFocused = { name: 'Main Service', uuid: 'playlist-001', index: 2 };
    this._backup = null;
  }

  async connect() {
    if (this.connected) return;
    this.connected = true;
    this.emit('connected');
  }

  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    this.emit('disconnected');
  }

  async isRunning() {
    return this.running;
  }

  async getVersion() {
    return this._version;
  }

  async getCurrentSlide() {
    if (!this.running) return null;
    return {
      presentationName: this._presentationName,
      presentationUUID: this._presentationUUID,
      slideIndex: this._slideIndex,
      slideTotal: this._slideTotal,
      slideNotes: 'Speaker notes for this slide — remind congregation about upcoming potluck.',
    };
  }

  async nextSlide() {
    this._slideIndex = Math.min(this._slideIndex + 1, Math.max(0, this._slideTotal - 1));
    this._emitSlideChanged();
    return true;
  }

  async previousSlide() {
    this._slideIndex = Math.max(0, this._slideIndex - 1);
    this._emitSlideChanged();
    return true;
  }

  async goToSlide(index) {
    const i = Math.max(0, Math.min(Math.max(0, this._slideTotal - 1), Number(index) || 0));
    this._slideIndex = i;
    this._emitSlideChanged();
    return true;
  }

  async getPlaylist() {
    return [...this._playlist];
  }

  async clearAll() { return true; }
  async clearSlide() { return true; }

  async getMessages() {
    return [
      { id: 'msg-1', name: 'Welcome Message' },
      { id: 'msg-2', name: 'Prayer Request' },
    ];
  }
  async triggerMessage() { return true; }
  async clearMessages() { return true; }

  async getLooks() {
    return [
      { id: 'look-1', name: 'Default' },
      { id: 'look-2', name: 'Worship' },
      { id: 'look-3', name: 'Message' },
    ];
  }
  async setLook(name) { return name; }

  async getTimers() {
    return [
      { id: 'timer-1', name: 'Sermon Timer', allows_overrun: true },
      { id: 'timer-2', name: 'Countdown', allows_overrun: false },
    ];
  }
  async startTimer(name) { return name; }
  async stopTimer(name) { return name; }

  // ─── RICH STATUS METHODS ──────────────────────────────────────────────

  async getActiveLook() {
    return this._activeLook;
  }

  async getTimerStatus() {
    // Simulate timer countdown
    if (this._activeTimers[0]?.state === 'Running') {
      const [min, sec] = this._activeTimers[0].time.split(':').map(Number);
      const totalSec = Math.max(0, min * 60 + sec - 3); // 3s poll tick
      this._activeTimers[0].time = `${String(Math.floor(totalSec / 60)).padStart(2, '0')}:${String(totalSec % 60).padStart(2, '0')}`;
    }
    return [...this._activeTimers];
  }

  async getAudienceScreenStatus() {
    return { ...this._screenStatus };
  }

  async getPlaylistFocused() {
    return this._playlistFocused ? { ...this._playlistFocused } : null;
  }

  async getLibraries() {
    return [
      {
        id: 'lib-1', name: 'Songs',
        presentations: [
          { id: 'pres-1', name: 'Amazing Grace' },
          { id: 'pres-2', name: 'How Great Is Our God' },
          { id: 'pres-3', name: '10,000 Reasons' },
        ],
      },
      {
        id: 'lib-2', name: 'Liturgy',
        presentations: [
          { id: 'pres-4', name: 'Call to Worship' },
          { id: 'pres-5', name: 'Benediction' },
        ],
      },
    ];
  }

  async getThumbnail(presentationUUID, slideIndex) {
    // Return a tiny 1x1 transparent PNG as base64
    return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';
  }

  async setAudienceScreens(on) {
    this._screenStatus.audience = !!on;
    return on ? 'Audience screens ON' : 'Audience screens OFF';
  }

  // ─── HELPERS ─────────────────────────────────────────────────────────

  setRunning(running) {
    this.running = !!running;
  }

  setPresentation(name, slideTotal = 12) {
    const nextName = String(name || '').trim();
    if (nextName) this._presentationName = nextName;
    const total = Number(slideTotal);
    if (Number.isFinite(total) && total > 0) {
      this._slideTotal = Math.floor(total);
      if (this._slideIndex >= this._slideTotal) this._slideIndex = this._slideTotal - 1;
    }
    this._emitPresentationChanged();
    this._emitSlideChanged();
  }

  setSlide(index) {
    const i = Number(index);
    if (!Number.isFinite(i)) return;
    this._slideIndex = Math.max(0, Math.min(Math.max(0, this._slideTotal - 1), Math.floor(i)));
    this._emitSlideChanged();
  }

  _emitSlideChanged() {
    this.emit('slideChanged', {
      action: 'slideChanged',
      presentationName: this._presentationName,
      slideIndex: this._slideIndex,
      slideCount: this._slideTotal,
      acn: 'fv',
      txt: `${this._slideIndex + 1}/${this._slideTotal}`,
    });
  }

  _emitPresentationChanged() {
    this.emit('presentationChanged', {
      action: 'presentationChanged',
      presentationName: this._presentationName,
      slideCount: this._slideTotal,
    });
  }

  toStatus() {
    return {
      connected: this.connected,
      running: this.running,
      version: this._version,
      currentSlide: this._presentationName,
      presentationUUID: this._presentationUUID,
      slideIndex: this._slideIndex,
      slideTotal: this._slideTotal,
      slideNotes: 'Speaker notes for this slide — remind congregation about upcoming potluck.',
      activeLook: this._activeLook,
      timers: this._activeTimers,
      screens: this._screenStatus,
      playlistFocused: this._playlistFocused,
      triggerMode: this.triggerMode,
      backup: null,
    };
  }

  getSnapshot() {
    return {
      connected: this.connected,
      running: this.running,
      presentationName: this._presentationName,
      slideIndex: this._slideIndex,
      slideTotal: this._slideTotal,
      playlistCount: this._playlist.length,
    };
  }
}

module.exports = { FakeProPresenter };
