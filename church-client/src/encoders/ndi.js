/**
 * NDI Decoder Adapter
 *
 * Receive/monitoring only. This adapter probes a configured NDI source using
 * ffprobe + libndi_newtek and reports connectivity + basic video metadata.
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
        fps: null,
        details: 'NDI source name not configured',
        width: null,
        height: null,
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
      '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate,codec_name',
      '-of', 'json',
      '-read_intervals', '%+1',
    ];

    const result = await runCommand('ffprobe', args, this.timeoutMs);

    let probe;
    if (result.error && result.error.code === 'ENOENT') {
      probe = {
        connected: false,
        live: false,
        fps: null,
        details: 'ffprobe not installed (required for NDI monitoring)',
        width: null,
        height: null,
      };
    } else if (result.timedOut) {
      probe = {
        connected: false,
        live: false,
        fps: null,
        details: `NDI probe timed out for "${this.source}"`,
        width: null,
        height: null,
      };
    } else if (!result.ok) {
      const errText = `${result.stderr || ''} ${result.stdout || ''}`.toLowerCase();
      const pluginMissing = errText.includes('unknown input format') || errText.includes('libndi_newtek');
      probe = {
        connected: false,
        live: false,
        fps: null,
        details: pluginMissing
          ? 'ffprobe lacks libndi_newtek support'
          : `NDI source "${this.source}" not reachable`,
        width: null,
        height: null,
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
      const res = width && height ? `${width}x${height}` : null;
      const fpsText = Number.isFinite(fps) ? `${fps} fps` : null;

      probe = {
        connected: true,
        live: true,
        fps: Number.isFinite(fps) ? fps : null,
        details: `${this.label} (${this.source})${res ? ` · ${res}` : ''}${fpsText ? ` @ ${fpsText}` : ''}`,
        width,
        height,
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
      bitrateKbps: null,
      fps: probe.fps,
      cpuUsage: null,
      recording: false,
      details: probe.details,
    };
  }
}

module.exports = { NdiEncoder };
