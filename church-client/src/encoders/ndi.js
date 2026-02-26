/**
 * NDI Decoder Adapter
 *
 * Receive/monitoring only. This adapter probes a configured NDI source using
 * ffprobe + libndi_newtek and reports connectivity + rich video metadata.
 *
 * Requirements on the church machine:
 * - ffprobe in PATH
 * - ffprobe build with libndi_newtek enabled
 */

const { spawn } = require('child_process');

function parseFps(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  if (value.includes('/')) {
    const [num, den] = value.split('/').map((v) => Number(v));
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      return Number((num / den).toFixed(2));
    }
    return null;
  }
  const asNum = Number(value);
  return Number.isFinite(asNum) ? Number(asNum.toFixed(2)) : null;
}

function runCommand(command, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr, timedOut, error });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut, error: null });
    });
  });
}

class NdiEncoder {
  constructor({ host = '', label = '', timeoutMs = 5000 } = {}) {
    this.source = String(host || '').trim();
    this.label = String(label || '').trim() || 'NDI Decoder';
    this.timeoutMs = Number(timeoutMs) || 5000;
    this._connected = false;
    this._lastProbeAt = 0;
    this._lastProbe = null;
    this._cacheMs = 8000;
  }

  setSource(source = '') {
    const normalized = String(source || '').trim();
    if (normalized === this.source) return;
    this.source = normalized;
    this._lastProbe = null;
    this._lastProbeAt = 0;
  }

  getSource() {
    return this.source;
  }

  async connect() {
    const probe = await this._probe(true);
    this._connected = probe.connected;
    return this._connected;
  }

  async disconnect() {
    this._connected = false;
    return true;
  }

  async isOnline() {
    const probe = await this._probe();
    this._connected = probe.connected;
    return this._connected;
  }

  async _probe(force = false) {
    const now = Date.now();
    if (!force && this._lastProbe && (now - this._lastProbeAt) < this._cacheMs) {
      return this._lastProbe;
    }

    if (!this.source) {
      const missing = {
        connected: false,
        live: false,
        bitrateKbps: null,
        fps: null,
        details: 'NDI source name not configured',
        width: null,
        height: null,
        codec: null,
        pixelFormat: null,
        probeError: 'source_not_configured',
      };
      this._lastProbe = missing;
      this._lastProbeAt = now;
      return missing;
    }

    const args = [
      '-v', 'error',
      '-f', 'libndi_newtek',
      '-i', this.source,
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate,codec_name,pix_fmt,bit_rate',
      '-of', 'json',
      '-read_intervals', '%+1',
    ];

    const result = await runCommand('ffprobe', args, this.timeoutMs);

    let probe;
    if (result.error && result.error.code === 'ENOENT') {
      probe = {
        connected: false,
        live: false,
        bitrateKbps: null,
        fps: null,
        details: 'ffprobe not installed (required for NDI monitoring)',
        width: null,
        height: null,
        codec: null,
        pixelFormat: null,
        probeError: 'missing_ffprobe',
      };
    } else if (result.timedOut) {
      probe = {
        connected: false,
        live: false,
        bitrateKbps: null,
        fps: null,
        details: `NDI probe timed out for "${this.source}"`,
        width: null,
        height: null,
        codec: null,
        pixelFormat: null,
        probeError: 'probe_timeout',
      };
    } else if (!result.ok) {
      const errText = `${result.stderr || ''} ${result.stdout || ''}`.toLowerCase();
      const pluginMissing = errText.includes('unknown input format') || errText.includes('libndi_newtek');
      probe = {
        connected: false,
        live: false,
        bitrateKbps: null,
        fps: null,
        details: pluginMissing
          ? 'ffprobe lacks libndi_newtek support'
          : `NDI source "${this.source}" not reachable`,
        width: null,
        height: null,
        codec: null,
        pixelFormat: null,
        probeError: pluginMissing ? 'missing_ndi_plugin' : 'source_unreachable',
      };
    } else {
      let stream = null;
      try {
        const parsed = JSON.parse(result.stdout || '{}');
        stream = Array.isArray(parsed.streams) ? parsed.streams[0] : null;
      } catch {
        stream = null;
      }

      const width = stream && Number.isFinite(Number(stream.width)) ? Number(stream.width) : null;
      const height = stream && Number.isFinite(Number(stream.height)) ? Number(stream.height) : null;
      const fps = parseFps(stream?.avg_frame_rate || stream?.r_frame_rate || '');
      const bitrateKbps = stream && Number.isFinite(Number(stream.bit_rate))
        ? Math.round(Number(stream.bit_rate) / 1000)
        : null;
      const codec = stream && typeof stream.codec_name === 'string' ? stream.codec_name : null;
      const pixelFormat = stream && typeof stream.pix_fmt === 'string' ? stream.pix_fmt : null;
      const res = width && height ? `${width}x${height}` : null;
      const fpsText = Number.isFinite(fps) ? `${fps} fps` : null;
      const bitrateText = Number.isFinite(bitrateKbps) ? `${bitrateKbps} kbps` : null;

      probe = {
        connected: true,
        live: true,
        bitrateKbps: Number.isFinite(bitrateKbps) ? bitrateKbps : null,
        fps: Number.isFinite(fps) ? fps : null,
        details: `${this.label} (${this.source})${res ? ` · ${res}` : ''}${fpsText ? ` @ ${fpsText}` : ''}${bitrateText ? ` · ${bitrateText}` : ''}`,
        width,
        height,
        codec,
        pixelFormat,
        probeError: null,
      };
    }

    this._lastProbe = probe;
    this._lastProbeAt = now;
    return probe;
  }

  async getStatus() {
    const probe = await this._probe();
    this._connected = probe.connected;
    return {
      type: 'ndi',
      connected: probe.connected,
      live: probe.live,
      bitrateKbps: probe.bitrateKbps ?? null,
      fps: probe.fps,
      cpuUsage: null,
      recording: false,
      details: probe.details,
      ndiSource: this.source || null,
      width: probe.width ?? null,
      height: probe.height ?? null,
      codec: probe.codec ?? null,
      pixelFormat: probe.pixelFormat ?? null,
      probeError: probe.probeError ?? null,
    };
  }
}

module.exports = { NdiEncoder };
