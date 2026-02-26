/**
 * BirdDog Encoder/Decoder Adapter
 *
 * Uses BirdDog's web API (default port 8080) for device identity and combines
 * that with NDI source monitoring for live signal status.
 */

const { NdiEncoder } = require('./ndi');

function parseMaybeJson(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

function normalizeText(value) {
  return String(value || '').trim();
}

function pickFirst(obj = {}, keys = []) {
  for (const key of keys) {
    const val = obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
    const out = normalizeText(val);
    if (out) return out;
  }
  return '';
}

function parseKV(raw) {
  const out = {};
  const text = String(raw || '');
  if (!text.trim()) return out;

  text.split(/[\r\n&]+/).forEach((line) => {
    const entry = line.trim();
    if (!entry) return;
    const idx = entry.indexOf('=');
    if (idx > 0) {
      const key = entry.slice(0, idx).trim();
      const value = entry.slice(idx + 1).trim();
      if (key) out[key] = value;
      return;
    }
    const cidx = entry.indexOf(':');
    if (cidx > 0) {
      const key = entry.slice(0, cidx).trim();
      const value = entry.slice(cidx + 1).trim();
      if (key) out[key] = value;
    }
  });
  return out;
}

class BirdDogEncoder {
  constructor({ host, port = 8080, password = '', label = '', source = '' } = {}) {
    this.host = String(host || '').trim();
    this.port = Number(port) || 8080;
    this.password = String(password || '').trim();
    this.label = String(label || '').trim() || 'BirdDog';
    this.source = String(source || '').trim();

    this._connected = false;
    this._model = '';
    this._firmware = '';
    this._lastIdentityAt = 0;
    this._identityCacheMs = 30_000;

    this._ndi = new NdiEncoder({
      host: this.source,
      label: this.label,
    });
  }

  _baseUrl() {
    const protocol = this.port === 443 ? 'https' : 'http';
    return `${protocol}://${this.host}:${this.port}`;
  }

  _headers(extra = {}) {
    const headers = { ...extra };
    if (this.password) {
      const basic = Buffer.from(`admin:${this.password}`).toString('base64');
      headers.Authorization = `Basic ${basic}`;
    }
    return headers;
  }

  async _request(path) {
    if (!this.host) return { ok: false, status: 0, raw: '', data: null };
    try {
      const resp = await fetch(`${this._baseUrl()}${path}`, {
        method: 'GET',
        headers: this._headers(),
        signal: AbortSignal.timeout(4500),
      });
      const raw = await resp.text().catch(() => '');
      return {
        ok: resp.ok,
        status: resp.status,
        raw,
        data: parseMaybeJson(raw),
      };
    } catch {
      return { ok: false, status: 0, raw: '', data: null };
    }
  }

  async _probeIdentity(force = false) {
    const now = Date.now();
    if (!force && (now - this._lastIdentityAt) < this._identityCacheMs) return;
    this._lastIdentityAt = now;

    const endpoints = ['/about', '/version', '/List'];
    for (const endpoint of endpoints) {
      const res = await this._request(endpoint);
      if (!res.ok && res.status !== 401 && res.status !== 403) continue;

      const data = res.data || parseKV(res.raw);
      const bodyText = String(res.raw || '').toLowerCase();
      const looksBirdDog = bodyText.includes('birddog')
        || Object.keys(data || {}).some((k) => String(k).toLowerCase().includes('fw') || String(k).toLowerCase().includes('bird'));
      if (!looksBirdDog && !res.ok) continue;

      this._connected = true;
      this._model = pickFirst(data, ['model', 'product', 'productName', 'device', 'DeviceName']) || this._model;
      this._firmware = pickFirst(data, ['firmware', 'fwversion', 'softwareVersion', 'version']) || this._firmware;
      return;
    }

    this._connected = false;
  }

  async _probeDecodeStatus() {
    const res = await this._request('/decodestatus?ChNum=1');
    if (!res.ok) return {};
    const data = res.data || parseKV(res.raw);
    const source = pickFirst(data, ['source', 'Source', 'sourceName', 'SourceName', 'Ch1Source', 'ch1_source']);
    const status = pickFirst(data, ['status', 'Status', 'state', 'State']);
    return { source, status };
  }

  async connect() {
    const online = await this.isOnline();
    if (online) {
      await this._probeIdentity(true);
      if (this.source) this._ndi.setSource(this.source);
    }
    return online;
  }

  async disconnect() {
    this._connected = false;
    await this._ndi.disconnect();
    return true;
  }

  async isOnline() {
    await this._probeIdentity();
    return this._connected;
  }

  async getStatus() {
    const connected = await this.isOnline();
    const decode = connected ? await this._probeDecodeStatus() : {};

    const ndiSource = normalizeText(this.source || decode.source);
    if (ndiSource && !this.source) this.source = ndiSource;
    if (ndiSource) this._ndi.setSource(ndiSource);

    const ndiStatus = ndiSource
      ? await this._ndi.getStatus()
      : null;

    const modelText = this._model ? ` ${this._model}` : '';
    const fwText = this._firmware ? ` v${this._firmware}` : '';
    const ndiText = ndiSource ? ` · NDI: ${ndiSource}` : ' · NDI source not set';
    const details = `${this.label}${modelText}${fwText}${ndiText}`;

    return {
      type: 'birddog',
      connected,
      live: !!(ndiStatus?.live),
      bitrateKbps: ndiStatus?.bitrateKbps ?? null,
      fps: ndiStatus?.fps ?? null,
      cpuUsage: null,
      recording: false,
      details,
      model: this._model || null,
      firmwareVersion: this._firmware || null,
      ndiSource: ndiSource || null,
      width: ndiStatus?.width ?? null,
      height: ndiStatus?.height ?? null,
      codec: ndiStatus?.codec ?? null,
      probeError: ndiStatus?.probeError ?? null,
      decoderStatus: decode.status || null,
    };
  }
}

module.exports = { BirdDogEncoder };
