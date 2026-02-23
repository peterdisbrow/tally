/**
 * AJA HELO Encoder Adapter
 *
 * AJA HELO / HELO Plus — standalone H.264 streaming & recording encoder.
 * REST API: GET/POST http://IP/config?action=get|set&paramid=eParamID_*&value=*
 * Auth: optional via POST /authenticator/login (session cookie).
 *
 * Ref: https://gitlab.aja.com/pub/rest_api — HELO commands
 */

const http = require('http');

// ── AJA REST param IDs ──────────────────────────────────────────────────────
const P = {
  // Control
  CMD:               'eParamID_ReplicatorCommand',    // 1=Rec 2=StopRec 3=Stream 4=StopStream

  // Status (read-only)
  STREAM_STATE:      'eParamID_ReplicatorStreamState',  // 0=Uninit 1=Idle 2=Streaming 3=FailIdle 4=FailStream 5=Shutdown
  RECORD_STATE:      'eParamID_ReplicatorRecordState',  // 0=Uninit 1=Idle 2=Recording 3=FailIdle 4=FailRec 5=Shutdown
  STREAM_DURATION:   'eParamID_StreamingDuration',
  RECORD_DURATION:   'eParamID_RecordingDuration',
  TEMPERATURE:       'eParamID_Temperature',
  MEDIA_AVAILABLE:   'eParamID_CurrentMediaAvailable',  // % remaining

  // Input
  VIDEO_IN:          'eParamID_VideoInSelect',       // 0=SDI 1=HDMI 2=TestPattern
  AUDIO_IN:          'eParamID_AudioInSelect',       // 0=SDI 1=HDMI 2=Analog 4=None
  AUDIO_LEVEL:       'eParamID_AnalogAudioInputLevel', // 0=0dB 1=+6dB 2=+12dB
  AUDIO_DELAY:       'eParamID_DelayAudioMs',        // 0-300
  AV_MUTE:           'eParamID_AVMute',              // 0=Unmute 1=Mute

  // Profiles
  STREAM_PROFILE:    'eParamID_StreamingProfileSel',  // 0-9
  REC_PROFILE:       'eParamID_RecordingProfileSel',  // 0-9

  // Recording destination
  REC_DEST:          'eParamID_RecordingDestination',  // 0=SD 1=USB 2=SMB 3=NFS
  SEC_REC_DEST:      'eParamID_SecondaryRecordingDestination',  // 0=SD 1=USB 4=None
  FILENAME_PREFIX:   'eParamID_FilenamePrefix',

  // Scheduler
  SCHED_ENABLED:     'eParamID_SchedulerEnabled',     // 0=Off 1=On
  SCHED_ACTIVITY:    'eParamID_SchedulerActivity',    // 1=RecOnly 2=StreamOnly 3=Both
  SCHED_CURRENT:     'eParamID_SchedulerCurrentEvent',
  SCHED_NEXT:        'eParamID_SchedulerNextEvent',

  // Auth
  AUTH:              'eParamID_Authentication',        // 0=Off 1=Login

  // Presets
  PRESET_RECALL:     'eParamID_RegisterRecall',       // 1-20
};

class AjaEncoder {
  constructor({ host, port = 80, password = '' } = {}) {
    this.host = host;
    this.port = port;
    this.password = password;
    this._connected = false;
    this._cookie = '';
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────

  _request(method, path, postBody = null) {
    return new Promise((resolve) => {
      const opts = {
        hostname: this.host, port: this.port, path, method,
        timeout: 5000,
        headers: {},
      };
      if (this._cookie) opts.headers.Cookie = this._cookie;
      if (postBody) {
        opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        opts.headers['Content-Length'] = Buffer.byteLength(postBody);
      }

      const req = http.request(opts, (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => {
          // Capture session cookie
          const sc = res.headers['set-cookie'];
          if (sc) {
            const m = (Array.isArray(sc) ? sc.join('; ') : sc).match(/serenity-session=([^;]+)/);
            if (m) this._cookie = `serenity-session=${m[1]}`;
          }
          try { resolve({ ok: res.statusCode < 400, data: JSON.parse(body), raw: body }); }
          catch { resolve({ ok: res.statusCode < 400, data: null, raw: body }); }
        });
      });
      req.on('error', () => resolve({ ok: false, data: null, raw: '' }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, data: null, raw: '' }); });
      if (postBody) req.write(postBody);
      req.end();
    });
  }

  async _login() {
    if (!this.password) return true;
    const body = `password_provided=${encodeURIComponent(this.password)}`;
    const res = await this._request('POST', '/authenticator/login', body);
    return res.ok && !res.raw.includes('Invalid password');
  }

  async _getParam(paramId) {
    const res = await this._request('GET', `/config?action=get&paramid=${paramId}`);
    if (!res.ok && this.password) {
      await this._login();
      return this._request('GET', `/config?action=get&paramid=${paramId}`);
    }
    return res;
  }

  async _setParam(paramId, value) {
    const res = await this._request('GET', `/config?action=set&paramid=${paramId}&value=${encodeURIComponent(value)}`);
    if (!res.ok && this.password) {
      await this._login();
      return this._request('GET', `/config?action=set&paramid=${paramId}&value=${encodeURIComponent(value)}`);
    }
    return res;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async connect() {
    if (this.password) await this._login();
    return this.isOnline();
  }

  async disconnect() { this._connected = false; this._cookie = ''; return true; }

  async isOnline() {
    const res = await this._getParam(P.STREAM_STATE);
    this._connected = res.ok;
    return res.ok;
  }

  // ── Status ────────────────────────────────────────────────────────────────

  async getStatus() {
    const [streamRes, recRes, tempRes, mediaRes] = await Promise.all([
      this._getParam(P.STREAM_STATE),
      this._getParam(P.RECORD_STATE),
      this._getParam(P.TEMPERATURE),
      this._getParam(P.MEDIA_AVAILABLE),
    ]);

    this._connected = streamRes.ok;
    const streamVal  = parseInt(streamRes.data?.value) || 0;
    const recVal     = parseInt(recRes.data?.value) || 0;
    const tempC      = tempRes.data?.value || null;
    const mediaPct   = mediaRes.data?.value || null;

    const live      = streamVal === 2;  // eRRSStreaming
    const recording = recVal === 2;     // eRRSRecording
    const failing   = streamVal >= 3 || recVal >= 3;

    let details = 'AJA HELO';
    if (live) details += ' — Streaming';
    if (recording) details += ' — Recording';
    if (failing) details += ' (⚠ Error)';
    if (tempC) details += ` · ${tempC}°C`;
    if (mediaPct) details += ` · ${mediaPct}% storage`;

    return {
      type: 'aja',
      connected: streamRes.ok,
      live,
      bitrateKbps: null,  // AJA API doesn't expose runtime bitrate
      fps: null,
      cpuUsage: null,
      recording,
      details,
    };
  }

  // ── Stream / Record control ───────────────────────────────────────────────

  async startStream()  { return this._setParam(P.CMD, 3); }
  async stopStream()   { return this._setParam(P.CMD, 4); }
  async startRecord()  { return this._setParam(P.CMD, 1); }
  async stopRecord()   { return this._setParam(P.CMD, 2); }

  // ── Configuration ─────────────────────────────────────────────────────────

  async setVideoInput(src)   { return this._setParam(P.VIDEO_IN, src); }     // 0=SDI 1=HDMI 2=Test
  async setAudioInput(src)   { return this._setParam(P.AUDIO_IN, src); }     // 0=SDI 1=HDMI 2=Analog 4=None
  async setStreamProfile(n)  { return this._setParam(P.STREAM_PROFILE, n); } // 0-9
  async setRecordProfile(n)  { return this._setParam(P.REC_PROFILE, n); }    // 0-9
  async setMute(mute)        { return this._setParam(P.AV_MUTE, mute ? 1 : 0); }
  async recallPreset(n)      { return this._setParam(P.PRESET_RECALL, n); }  // 1-20
}

module.exports = { AjaEncoder };
