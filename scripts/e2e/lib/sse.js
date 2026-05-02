/**
 * Bearer-authed SSE consumer for /api/church/app/status/stream.
 *
 * The relay pushes status deltas over SSE — much lower-latency than polling
 * /api/church/app/me on a 1s tick and avoids race conditions where the
 * scenario advances before the relay has actually received the agent's
 * status_update WebSocket frame.
 *
 * Usage:
 *   const sse = new StatusStream({ url, token });
 *   await sse.connect();
 *   const final = await sse.waitFor((status) => status.proPresenter?.currentSlide?.slideIndex === 5, { timeoutMs: 5000 });
 *   sse.close();
 *
 * The stream keeps the latest known status in `sse.latest`. waitFor() resolves
 * as soon as the predicate returns truthy on any incoming frame OR if the
 * predicate already passes against the current latest snapshot.
 */

'use strict';

class StatusStream {
  constructor({ url, token, log }) {
    this.url = url;
    this.token = token;
    this.log = log;
    this.controller = null;
    this.latest = null;
    this._waiters = []; // { predicate, resolve, reject, deadline }
    this._closed = false;
  }

  async connect({ timeoutMs = 10_000 } = {}) {
    this.controller = new AbortController();
    const fetchUrl = `${this.url}/api/church/app/status/stream`;
    const res = await fetch(fetchUrl, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' },
      signal: this.controller.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`[sse] connect failed: HTTP ${res.status}`);
    }

    // Pump the SSE body in the background. SSE frames are separated by blank
    // lines; each frame may have multiple `data:` lines we concat per spec.
    (async () => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      try {
        while (!this._closed) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let blank;
          while ((blank = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, blank);
            buf = buf.slice(blank + 2);
            const dataLines = frame.split('\n').filter((l) => l.startsWith('data:'));
            if (!dataLines.length) continue;
            const payload = dataLines.map((l) => l.slice(5).trimStart()).join('\n');
            try {
              const obj = JSON.parse(payload);
              this._onFrame(obj);
            } catch { /* non-JSON keepalive — ignore */ }
          }
        }
      } catch (err) {
        if (!this._closed) this.log?.debug('[sse] stream error:', err.message);
      }
    })();

    // Wait for the FIRST status frame so the caller can rely on `latest`
    // being populated before issuing scenario actions.
    return this.waitFor(() => this.latest != null, { timeoutMs })
      .catch((e) => { throw new Error(`[sse] no initial status frame within ${timeoutMs}ms: ${e.message}`); });
  }

  _onFrame(obj) {
    // The relay's SSE may push either a full status snapshot (initial) or
    // typed event objects. We're interested in anything that looks like a
    // status payload — accept both shapes.
    let status = null;
    if (obj?.type === 'status' && obj.status) status = obj.status;
    else if (obj?.status && typeof obj.status === 'object') status = obj.status;
    else if (obj && obj.atem !== undefined || obj?.proPresenter !== undefined || obj?.encoder !== undefined) status = obj;
    if (!status) return;

    // Merge into latest (delta-friendly). Replace nested device blocks
    // wholesale rather than deep-merging so the test sees clean per-device
    // state without stale fields.
    this.latest = { ...(this.latest || {}), ...status };

    const stillWaiting = [];
    for (const w of this._waiters) {
      try {
        if (w.predicate(this.latest)) { w.resolve(this.latest); continue; }
      } catch (err) { w.reject(err); continue; }
      stillWaiting.push(w);
    }
    this._waiters = stillWaiting;
  }

  waitFor(predicate, { timeoutMs = 5_000 } = {}) {
    // Fast path: predicate already passes.
    if (this.latest) {
      try { if (predicate(this.latest)) return Promise.resolve(this.latest); }
      catch (err) { return Promise.reject(err); }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters = this._waiters.filter((w) => w !== entry);
        reject(new Error(`[sse] waitFor timed out after ${timeoutMs}ms (latest=${JSON.stringify(this.latest)?.slice(0, 200)})`));
      }, timeoutMs);
      const entry = { predicate, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } };
      this._waiters.push(entry);
    });
  }

  close() {
    this._closed = true;
    try { this.controller?.abort(); } catch { /* ignore */ }
    for (const w of this._waiters) w.reject(new Error('[sse] stream closed'));
    this._waiters = [];
  }
}

module.exports = { StatusStream };
