const { EventEmitter } = require('events');

const BLANK_JPEG_BASE64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBUQEBAVFQ8VFRUVFRUVFRUVFRUVFhUWFhUVFRUYHSggGBolGxUVITEhJSkrLi4uFx8zODMsNygtLisBCgoKDg0OGxAQGi0fICUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/xAAbAAEAAgMBAQAAAAAAAAAAAAAABQYBAwQCB//EADkQAAEDAgQDBQYFBQAAAAAAAAEAAgMEEQUSITFBBhMiUWFxgZGhFCMyQrHB0fAUI1Lh8RUzYnL/xAAYAQEBAQEBAAAAAAAAAAAAAAAAAgEDBP/EAB8RAQEBAAIDAQAAAAAAAAAAAAABEQIhAxIxQRMUIf/aAAwDAQACEQMRAD8A9SEREBERAREQEREBERAREQEREBERA//2Q==';

class FakeOBS extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.url = 'mock://obs';

    this._tickTimer = null;
    this._streaming = false;
    this._recording = false;
    this._streamBytes = 0;
    this._totalFrames = 0;
    this._droppedFrames = 0;

    this._fps = 30;
    this._cpuUsage = 18;
    this._congestion = 0.02;
    this._manualBitrateKbps = null;

    this._scene = 'Program';
    this._scenes = ['Program', 'IMAG', 'Slides', 'PreService'];

    this._streamServiceType = 'rtmp_custom';
    this._streamServiceSettings = {
      server: 'rtmp://mock-relay/live',
      key: 'mock-stream-key',
      use_auth: false,
      bitsPerSecond: 4_500_000,
      bitrate: '4500',
    };

    this._mockGraphic = {
      title: 'Tally Mock OBS',
      subtitle: 'Static Graphic Feed',
      accent: '#4ade80',
      bgA: '#07110d',
      bgB: '#0d1e17',
    };
    this._mockStreamFps = 2;
    this._mockStreamClients = 0;
    this._mockStreamBytesOut = 0;
  }

  async connect(url = 'mock://obs') {
    if (this.connected) return;
    this.connected = true;
    this.url = url;
    this._startTicker();
    this.emit('ConnectionOpened');
  }

  async disconnect() {
    if (!this.connected) return;
    this.connected = false;
    this._stopTicker();
    this.emit('ConnectionClosed');
  }

  _startTicker() {
    this._stopTicker();
    this._tickTimer = setInterval(() => {
      if (!this._streaming) return;

      const targetKbps = this._manualBitrateKbps != null
        ? this._manualBitrateKbps
        : Math.max(64, Math.round((Number(this._streamServiceSettings.bitsPerSecond) || 4_500_000) / 1000));

      const effectiveKbps = Math.max(0, Math.round(targetKbps * (1 - this._congestion)));
      const bytesPerSecond = Math.round((effectiveKbps * 1000) / 8);
      this._streamBytes += bytesPerSecond;

      this._totalFrames += Math.max(1, Math.round(this._fps));
      if (this._congestion > 0.35) {
        this._droppedFrames += Math.round(this._fps * (this._congestion / 10));
      }
    }, 1000);
  }

  _stopTicker() {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
  }

  async call(method, payload = {}) {
    switch (method) {
      case 'StartStream':
        this._setStreaming(true);
        return { outputActive: true };

      case 'StopStream':
        this._setStreaming(false);
        return { outputActive: false };

      case 'StartRecord':
        this._setRecording(true);
        return { outputActive: true };

      case 'StopRecord':
        this._setRecording(false);
        return { outputActive: false };

      case 'SetCurrentProgramScene': {
        const sceneName = String(payload.sceneName || '').trim();
        if (!sceneName) throw new Error('sceneName is required');
        this.setScene(sceneName);
        return {};
      }

      case 'GetCurrentProgramScene':
        return { currentProgramSceneName: this._scene };

      case 'GetSceneList':
        return {
          currentProgramSceneName: this._scene,
          scenes: this._scenes.map((sceneName, sceneIndex) => ({ sceneName, sceneIndex })),
        };

      case 'GetSourceScreenshot':
        return { imageData: `data:image/jpeg;base64,${BLANK_JPEG_BASE64}` };

      case 'GetStats':
        return {
          activeFps: this._fps,
          cpuUsage: this._cpuUsage,
          outputCongestion: this._congestion,
          outputSkippedFrames: this._droppedFrames,
          outputTotalFrames: this._totalFrames,
        };

      case 'GetStreamStatus':
        return {
          outputActive: this._streaming,
          outputBytes: this._streamBytes,
          outputSkippedFrames: this._droppedFrames,
        };

      case 'GetRecordStatus':
        return { outputActive: this._recording };

      case 'GetVideoSettings':
        return {
          baseWidth: 1920,
          baseHeight: 1080,
          outputWidth: 1920,
          outputHeight: 1080,
          fpsNumerator: 30000,
          fpsDenominator: 1000,
        };

      case 'GetVersion':
        return {
          obsVersion: '30.2.0-mock',
          obsWebSocketVersion: '5.1.0',
          rpcVersion: 1,
          availableRequests: [
            'GetVersion',
            'GetStats',
            'GetStreamStatus',
            'GetRecordStatus',
            'GetCurrentProgramScene',
            'SetCurrentProgramScene',
            'GetSceneList',
            'GetSourceScreenshot',
            'StartStream',
            'StopStream',
            'StartRecord',
            'StopRecord',
            'GetStreamServiceSettings',
            'SetStreamServiceSettings',
            'GetVideoSettings',
          ],
          supportedImageFormats: ['jpg', 'jpeg', 'png'],
          platform: process.platform,
          platformDescription: `MockLab (${process.platform})`,
        };

      case 'SetStreamServiceSettings': {
        const settings = payload.streamServiceSettings || {};
        this._streamServiceType = payload.streamServiceType || this._streamServiceType;
        this._streamServiceSettings = {
          ...this._streamServiceSettings,
          ...settings,
        };

        if (this._streamServiceSettings.bitsPerSecond === undefined && this._streamServiceSettings.bitrate !== undefined) {
          const kbps = Number(this._streamServiceSettings.bitrate) || 4500;
          this._streamServiceSettings.bitsPerSecond = kbps * 1000;
        }
        if (this._streamServiceSettings.bitrate === undefined && this._streamServiceSettings.bitsPerSecond !== undefined) {
          this._streamServiceSettings.bitrate = String(Math.round(Number(this._streamServiceSettings.bitsPerSecond) / 1000));
        }

        return { status: 'ok' };
      }

      case 'GetStreamServiceSettings':
        return {
          streamServiceType: this._streamServiceType,
          streamServiceSettings: { ...this._streamServiceSettings },
        };

      default:
        throw new Error(`Fake OBS does not implement method: ${method}`);
    }
  }

  _setStreaming(active) {
    const next = !!active;
    if (this._streaming === next) return;
    this._streaming = next;
    if (!this._streaming) {
      this._streamBytes = 0;
      this._totalFrames = 0;
      this._droppedFrames = 0;
      this._mockStreamBytesOut = 0;
    }
    this.emit('StreamStateChanged', { outputActive: this._streaming });
  }

  _setRecording(active) {
    const next = !!active;
    if (this._recording === next) return;
    this._recording = next;
    this.emit('RecordStateChanged', { outputActive: this._recording });
  }

  setStreamActive(active) {
    this._setStreaming(active);
  }

  setRecordingActive(active) {
    this._setRecording(active);
  }

  setScene(sceneName) {
    const scene = String(sceneName || '').trim();
    if (!scene) return;
    const changed = this._scene !== scene;
    this._scene = scene;
    if (!this._scenes.includes(scene)) this._scenes.push(scene);
    if (changed) {
      this.emit('CurrentProgramSceneChanged', { sceneName: this._scene });
    }
  }

  setEncoderHealth({ fps, cpuUsage, congestion, bitrateKbps } = {}) {
    if (fps !== undefined) this._fps = Math.max(1, Math.min(120, Number(fps) || this._fps));
    if (cpuUsage !== undefined) this._cpuUsage = Math.max(0, Math.min(100, Number(cpuUsage) || this._cpuUsage));
    if (congestion !== undefined) this._congestion = Math.max(0, Math.min(1, Number(congestion) || 0));
    if (bitrateKbps !== undefined) this._manualBitrateKbps = Math.max(64, Number(bitrateKbps) || 4500);
  }

  clearEncoderOverride() {
    this._manualBitrateKbps = null;
  }

  setMockGraphic({ title, subtitle, fps } = {}) {
    if (title !== undefined) {
      const clean = String(title || '').trim();
      this._mockGraphic.title = clean ? clean.slice(0, 80) : 'Tally Mock OBS';
    }
    if (subtitle !== undefined) {
      const clean = String(subtitle || '').trim();
      this._mockGraphic.subtitle = clean ? clean.slice(0, 100) : 'Static Graphic Feed';
    }
    if (fps !== undefined) {
      const n = Number(fps);
      if (Number.isFinite(n)) this._mockStreamFps = Math.max(1, Math.min(10, Math.round(n)));
    }
  }

  getMockGraphicSvg() {
    const esc = (value) => String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    const streamState = this._streaming ? 'LIVE' : 'OFFLINE';
    const recState = this._recording ? 'REC' : 'NO REC';
    const scene = esc(this._scene);
    const now = new Date().toLocaleTimeString();

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${esc(this._mockGraphic.bgA)}"/>
      <stop offset="100%" stop-color="${esc(this._mockGraphic.bgB)}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="1280" height="720" fill="url(#bg)"/>
  <rect x="40" y="40" width="1200" height="640" rx="24" fill="rgba(0,0,0,0.24)" stroke="rgba(255,255,255,0.18)"/>
  <text x="88" y="150" font-family="Avenir Next, Segoe UI, sans-serif" font-size="68" fill="#e8fff2" font-weight="700">${esc(this._mockGraphic.title)}</text>
  <text x="88" y="205" font-family="Avenir Next, Segoe UI, sans-serif" font-size="34" fill="#b9d7c8">${esc(this._mockGraphic.subtitle)}</text>
  <rect x="88" y="255" width="1104" height="2" fill="${esc(this._mockGraphic.accent)}" opacity="0.7"/>
  <text x="88" y="340" font-family="Menlo, monospace" font-size="34" fill="#d3efe2">SCENE: ${scene}</text>
  <text x="88" y="392" font-family="Menlo, monospace" font-size="30" fill="#d3efe2">STREAM: ${streamState}  |  RECORD: ${recState}</text>
  <text x="88" y="444" font-family="Menlo, monospace" font-size="30" fill="#d3efe2">FPS: ${this._fps}  |  CPU: ${this._cpuUsage.toFixed(1)}%  |  CONGESTION: ${(this._congestion * 100).toFixed(1)}%</text>
  <text x="88" y="640" font-family="Menlo, monospace" font-size="24" fill="#c5dfd0">${esc(now)} • ${esc(this.url)}</text>
  <circle cx="1160" cy="104" r="20" fill="${this._streaming ? '#ef4444' : '#334155'}"/>
  <text x="1192" y="112" font-family="Menlo, monospace" font-size="22" fill="#e2f7ea">${streamState}</text>
</svg>`;
  }

  getMockJpegBuffer() {
    return Buffer.from(BLANK_JPEG_BASE64, 'base64');
  }

  getMockStreamFps() {
    return this._mockStreamFps;
  }

  addMockStreamClient() {
    this._mockStreamClients += 1;
  }

  removeMockStreamClient() {
    this._mockStreamClients = Math.max(0, this._mockStreamClients - 1);
  }

  addMockStreamBytes(count) {
    this._mockStreamBytesOut += Math.max(0, Number(count) || 0);
  }

  getSnapshot() {
    return {
      connected: this.connected,
      url: this.url,
      streaming: this._streaming,
      recording: this._recording,
      scene: this._scene,
      scenes: [...this._scenes],
      streamBytes: this._streamBytes,
      encoder: {
        fps: this._fps,
        cpuUsage: this._cpuUsage,
        congestion: this._congestion,
        manualBitrateKbps: this._manualBitrateKbps,
      },
      streamService: {
        type: this._streamServiceType,
        settings: { ...this._streamServiceSettings },
      },
      mockOutput: {
        streamPath: '/api/obs/mock-stream.mjpg',
        graphicPath: '/api/obs/mock-graphic.svg',
        fps: this._mockStreamFps,
        clients: this._mockStreamClients,
        bytesOut: this._mockStreamBytesOut,
        title: this._mockGraphic.title,
        subtitle: this._mockGraphic.subtitle,
      },
    };
  }
}

module.exports = { FakeOBS };
