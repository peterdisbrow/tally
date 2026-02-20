const { EventEmitter } = require('events');

class FakeProPresenter extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.running = true;

    this._presentationName = 'Sunday Service';
    this._slideIndex = 0;
    this._slideTotal = 12;

    this._playlist = [
      { name: 'Pre-Service Loop', type: 'presentation' },
      { name: 'Welcome', type: 'presentation' },
      { name: 'Worship Set', type: 'presentation' },
      { name: 'Message Slides', type: 'presentation' },
      { name: 'Announcements', type: 'presentation' },
    ];
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

  async getCurrentSlide() {
    if (!this.running) return null;
    return {
      presentationName: this._presentationName,
      slideIndex: this._slideIndex,
      slideTotal: this._slideTotal,
      slideNotes: '',
    };
  }

  async nextSlide() {
    this._slideIndex = Math.min(this._slideIndex + 1, Math.max(0, this._slideTotal - 1));
    this.emit('slideChanged');
    return true;
  }

  async previousSlide() {
    this._slideIndex = Math.max(0, this._slideIndex - 1);
    this.emit('slideChanged');
    return true;
  }

  async goToSlide(index) {
    const i = Math.max(0, Math.min(Math.max(0, this._slideTotal - 1), Number(index) || 0));
    this._slideIndex = i;
    this.emit('slideChanged');
    return true;
  }

  async getPlaylist() {
    return [...this._playlist];
  }

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
    this.emit('slideChanged');
  }

  setSlide(index) {
    const i = Number(index);
    if (!Number.isFinite(i)) return;
    this._slideIndex = Math.max(0, Math.min(Math.max(0, this._slideTotal - 1), Math.floor(i)));
    this.emit('slideChanged');
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
