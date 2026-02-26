/**
 * TriCaster Encoder Adapter
 *
 * Uses TriCaster's HTTP shortcut surface (where available) for status polling
 * and stream/record control. Some installations expose only the control TCP
 * port; in that case this adapter reports connectivity but may not support
 * transport actions.
 */

function toBool(value) {
  if (value === true || value === false) return value;
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (['1', 'true', 'on', 'yes', 'live', 'active', 'recording', 'streaming'].includes(raw)) return true;
  if (['0', 'false', 'off', 'no', 'idle', 'inactive', 'stopped'].includes(raw)) return false;
  return null;
}

function parseShortcutState(payload) {
  const text = String(payload || '');
  if (!text.trim()) return null;

  let bool = null;

  // XML-ish forms: value="1", state="true", etc.
  const xmlValue = text.match(/\b(?:value|state|enabled)\s*=\s*["']([^"']+)["']/i);
  if (xmlValue) bool = toBool(xmlValue[1]);

  // JSON-ish forms
  if (bool == null) {
    try {
      const parsed = JSON.parse(text);
      bool = toBool(
        parsed?.value
        ?? parsed?.state
        ?? parsed?.enabled
        ?? parsed?.current_state
      );
    } catch {
      // fall through
    }
  }

  // Plain text fallback
  if (bool == null) {
    const kv = text.match(/(?:value|state|enabled)\s*[:=]\s*([A-Za-z0-9_-]+)/i);
    if (kv) bool = toBool(kv[1]);
  }
  if (bool == null) bool = toBool(text);

  return bool;
}

function parseVersionText(payload) {
  const text = String(payload || '');
  if (!text.trim()) return '';
  try {
    const data = JSON.parse(text);
    return String(
      data?.version
      || data?.softwareVersion
      || data?.build
      || data?.release
      || ''
    ).trim();
  } catch {
    const tag = text.match(/<(?:\w+:)?version[^>]*>([^<]+)</i);
    if (tag) return String(tag[1] || '').trim();
    const flat = text.match(/\b(?:version|softwareVersion|build)\b\s*[:=]\s*([^\r\n<]+)/i);
    return flat ? String(flat[1] || '').trim() : '';
  }
}

class TriCasterEncoder {
  constructor({ host, port = 5951, password = '', label = '' } = {}) {
    this.host = String(host || '').trim();
    this.port = Number(port) || 5951;
    this.password = String(password || '');
    this.label = String(label || '').trim() || 'TriCaster';

    this._connected = false;
    this._streaming = false;
    this._recording = false;
    this._version = '';
    this._lastPollAt = 0;
    this._pollCacheMs = 6000;
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

  async _request(method, path, body = null, contentType = 'text/xml') {
    if (!this.host) return { ok: false, status: 0, raw: '', data: null };
    const url = `${this._baseUrl()}${path}`;
    try {
      const resp = await fetch(url, {
        method,
        headers: this._headers(body != null ? { 'Content-Type': contentType } : {}),
        body,
        signal: AbortSignal.timeout(4500),
      });
      const raw = await resp.text().catch(() => '');
      let data = null;
      try { data = JSON.parse(raw); } catch { data = null; }
      return { ok: resp.ok, status: resp.status, raw, data };
    } catch {
      return { ok: false, status: 0, raw: '', data: null };
    }
  }

  async _requestShortcutState(name) {
    const res = await this._request('GET', `/v1/shortcut?name=${encodeURIComponent(name)}`);
    if (!res.ok) return null;
    return parseShortcutState(res.raw);
  }

  async _refreshState(force = false) {
    const now = Date.now();
    if (!force && (now - this._lastPollAt) < this._pollCacheMs) return;
    this._lastPollAt = now;

    const [streaming, recording] = await Promise.all([
      this._requestShortcutState('streaming_toggle'),
      this._requestShortcutState('record_toggle'),
    ]);
    if (streaming != null) this._streaming = streaming;
    if (recording != null) this._recording = recording;
  }

  async _loadVersion() {
    const candidates = [
      '/v1/version',
      '/v1/dictionary?key=version',
      '/v1/dictionary?key=software_version',
      '/v1/dictionary?key=session_name',
    ];
    for (const path of candidates) {
      const res = await this._request('GET', path);
      if (!res.ok) continue;
      const parsed = parseVersionText(res.raw);
      if (parsed) {
        this._version = parsed;
        return;
      }
    }
  }

  async _postShortcut(name, value = null) {
    const payloads = value == null
      ? [`<shortcut name="${name}" />`]
      : [
          `<shortcut name="${name}" value="${value ? 1 : 0}" />`,
          `<shortcut name="${name}"><entry key="value" value="${value ? 1 : 0}" /></shortcut>`,
        ];

    for (const payload of payloads) {
      const res = await this._request('POST', '/v1/shortcut', payload, 'text/xml');
      if (res.ok) return true;
    }
    throw new Error(`TriCaster shortcut "${name}" failed`);
  }

  async connect() {
    const online = await this.isOnline();
    if (!online) return false;
    await this._loadVersion();
    await this._refreshState(true);
    return true;
  }

  async disconnect() {
    this._connected = false;
    return true;
  }

  async isOnline() {
    if (!this.host) {
      this._connected = false;
      return false;
    }

    const probes = [
      () => this._request('GET', '/v1/version'),
      () => this._request('GET', '/v1/shortcut?name=record_toggle'),
      () => this._request('GET', '/'),
    ];

    for (const probe of probes) {
      const res = await probe();
      if (res.ok) {
        this._connected = true;
        return true;
      }
      // Some TriCaster installs return 401/403 for API calls when auth is enabled.
      if (res.status === 401 || res.status === 403) {
        this._connected = true;
        return true;
      }
    }

    this._connected = false;
    return false;
  }

  async getStatus() {
    const connected = await this.isOnline();
    if (connected) await this._refreshState();

    let details = this.label;
    if (this._version) details += ` v${this._version}`;
    if (connected) {
      details += ` · ${this._streaming ? 'Streaming' : 'Off-air'}`;
      if (this._recording) details += ' · Recording';
    }

    return {
      type: 'tricaster',
      connected,
      live: connected ? !!this._streaming : false,
      bitrateKbps: null,
      fps: null,
      cpuUsage: null,
      recording: connected ? !!this._recording : false,
      details,
      version: this._version || null,
    };
  }

  async startStream() {
    await this._postShortcut('streaming_toggle', true);
    this._streaming = true;
    return true;
  }

  async stopStream() {
    await this._postShortcut('streaming_toggle', false);
    this._streaming = false;
    return true;
  }

  async startRecord() {
    await this._postShortcut('record_toggle', true);
    this._recording = true;
    return true;
  }

  async stopRecord() {
    await this._postShortcut('record_toggle', false);
    this._recording = false;
    return true;
  }
}

module.exports = { TriCasterEncoder };
