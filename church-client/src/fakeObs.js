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
        this._scene = sceneName;
        if (!this._scenes.includes(sceneName)) this._scenes.push(sceneName);
        return {};
      }

      case 'GetCurrentProgramScene':
        return { currentProgramSceneName: this._scene };

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
    this._scene = scene;
    if (!this._scenes.includes(scene)) this._scenes.push(scene);
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
    };
  }
}

module.exports = { FakeOBS };
