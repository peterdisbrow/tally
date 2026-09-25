/**
 * Mock Bitfocus Companion — mirrors the HTTP API of a real Companion 5.0.6 as observed
 * in the lab (tally-linux/wip/companion/REAL-COMPANION-5.0.6-FINDINGS.md):
 *
 *   GET  /api/variable/internal/time_hms/value        200 text "HH:MM:SS"
 *   GET  /api/variable/internal/b_text_P_R_C/value    label ("" when unlabelled) | 404 no button
 *   GET  /api/variable/internal/b_step_P_R_C/value, b_active_P_R_C
 *   GET  /api/variable/<label>/<name>/value           module variable | 404
 *   POST /api/location/P/R/C/press                    200 "ok" | 204 empty slot (nothing happens)
 *   GET  /api/location/...                            404 (no GET for buttons in Companion)
 *   GET  /api/custom-variable/<n>/value               value | 404 "Not found"
 *   POST /api/custom-variable/<n>/value?value=X       200 "ok" | 404 variable doesn't exist
 *        (a JSON body with no ?value= stores the raw body — exactly what real Companion does)
 *   GET  /api/connections                             [{id,label,moduleId,enabled,status:{category,level,message}|null}]
 *   GET  /                                            web UI HTML
 *
 * Stateful: presses run the button's action (e.g. set a custom variable), so a test can
 * check the effect. Modes (setMode): 'ok' | 'offline' (connections reset) | 'hang'
 * (accepted, never answered) | 'api-disabled' (403 on every /api route, like the
 * Settings → Protocols → HTTP switch) | 'v4' (no /api/connections → 404) |
 * 'not-companion' (another web server on the port: every path 404).
 */

'use strict';

const http = require('node:http');
const { createControlServer } = require('./_lib/control');

const DEFAULTS = {
  // "page/row/col" → { text, action?: { setCustom: [name, value] } }
  buttons: {
    '1/0/0': { text: 'Walk In' },
    '1/0/1': { text: 'Service Start' },
    '1/0/2': { text: 'Dante: Sunday' },
    '1/0/3': { text: 'Dante: Sunday Late' },
    '1/1/0': { text: '' },                           // a button with no label
  },
  customVariables: { tally_service_ready: '' },
  connections: [
    { id: 'c1', label: 'atem', moduleId: 'bmd-atem', enabled: true, status: { category: 'good', level: 'ok', message: null } },
  ],
  variables: { 'atem:pgm1_input': 'Camera 1' },    // "label:name" → string
  pressLog: [],
  requests: 0,
};

function hms(d = new Date()) { return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':'); }

function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); });
}

async function start({ port = 18000, controlPort = 0, mode: initialMode = 'ok' } = {}) {
  const state = JSON.parse(JSON.stringify(DEFAULTS));
  let mode = initialMode;
  const sockets = new Set();

  function send(res, code, body = '', type = 'text/html; charset=utf-8') {
    if (code === 204) { res.writeHead(204); res.end(); return; }
    res.writeHead(code, { 'content-type': type });
    res.end(body);
  }

  function press(page, row, col) {
    const b = state.buttons[`${page}/${row}/${col}`];
    if (!b) return false;
    state.pressLog.push({ page, row, col, text: b.text, ts: Date.now() });
    if (state.pressLog.length > 50) state.pressLog.shift();
    b.step = ((b.step || 1) % (b.steps || 1)) + 1;
    if (b.action && Array.isArray(b.action.setCustom)) {
      const [n, v] = b.action.setCustom;
      if (n in state.customVariables) state.customVariables[n] = String(v);
    }
    return true;
  }

  const server = http.createServer(async (req, res) => {
    state.requests++;
    if (mode === 'hang') return;
    if (mode === 'offline') { req.socket.destroy(); return; }
    const [path, qs] = (req.url || '/').split('?');
    const q = new URLSearchParams(qs || '');
    const body = await readBody(req);
    if (mode === 'not-companion') return send(res, 404, '<h1>Not Found</h1>');
    if (!path.startsWith('/api/')) return send(res, 200, '<!doctype html><title>Bitfocus Companion</title>');
    if (mode === 'api-disabled') return send(res, 403, 'Forbidden');

    let m;
    if (req.method === 'GET' && path === '/api/connections') {
      if (mode === 'v4') return send(res, 404, '');
      return send(res, 200, JSON.stringify(state.connections.map((c) => ({ ...c }))), 'application/json; charset=utf-8');
    }
    if ((m = path.match(/^\/api\/location\/(\d+)\/(\d+)\/(\d+)\/press$/)) && req.method === 'POST') {
      return press(+m[1], +m[2], +m[3]) ? send(res, 200, 'ok') : send(res, 204);
    }
    if ((m = path.match(/^\/api\/custom-variable\/([^/]+)\/value$/))) {
      const name = decodeURIComponent(m[1]);
      if (!(name in state.customVariables)) return send(res, 404, 'Not found');
      if (req.method === 'GET') return send(res, 200, state.customVariables[name]);
      if (req.method === 'POST') {
        state.customVariables[name] = q.has('value') ? q.get('value') : body;   // real Companion: raw body if no ?value=
        return send(res, 200, 'ok');
      }
    }
    if ((m = path.match(/^\/api\/variable\/([^/]+)\/([^/]+)\/value$/)) && req.method === 'GET') {
      const label = decodeURIComponent(m[1]);
      const name = decodeURIComponent(m[2]);
      if (label === 'internal') {
        if (name === 'time_hms') return send(res, 200, hms());
        const bm = name.match(/^b_(text|step|active)_(\d+)_(\d+)_(\d+)$/);
        if (bm) {
          const b = state.buttons[`${bm[2]}/${bm[3]}/${bm[4]}`];
          if (!b) return send(res, 404, 'Not found');
          return send(res, 200, bm[1] === 'text' ? String(b.text ?? '') : bm[1] === 'step' ? String(b.step || 1) : 'false');
        }
        return send(res, 404, 'Not found');
      }
      const v = state.variables[`${label}:${name}`];
      return v === undefined ? send(res, 404, 'Not found') : send(res, 200, String(v));
    }
    return send(res, 404, '');
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); if (mode === 'offline') s.destroy(); });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const actualPort = server.address().port;

  const api = {
    setMode: (m2) => { mode = m2 || 'ok'; if (mode === 'offline') for (const s of sockets) s.destroy(); },
    get mode() { return mode; },
    setButton: ({ page, row, col, text = '', action = null }) => { state.buttons[`${page}/${row}/${col}`] = { text, ...(action ? { action } : {}) }; },
    removeButton: ({ page, row, col }) => { delete state.buttons[`${page}/${row}/${col}`]; },
    setVariable: ({ connection, name, value }) => { state.variables[`${connection}:${name}`] = String(value); },
    createCustomVariable: ({ name, value = '' }) => { state.customVariables[name] = String(value); },
    deleteCustomVariable: ({ name }) => { delete state.customVariables[name]; },
    setConnections: (list) => { if (Array.isArray(list)) state.connections = list; },
    setConnectionStatus: ({ label, category, level = null, message = null, enabled }) => {
      const c = state.connections.find((x) => x.label === label || x.id === label);
      if (!c) throw new Error(`no connection ${label}`);
      c.status = category === null ? null : { category, level, message };
      if (enabled !== undefined) c.enabled = !!enabled;
    },
    operatorPress: ({ page, row, col }) => press(page, row, col),
    reset: () => { const f = JSON.parse(JSON.stringify(DEFAULTS)); for (const k of Object.keys(state)) delete state[k]; Object.assign(state, f); mode = 'ok'; },
  };

  const control = await createControlServer({
    device: 'companion', port: controlPort, state, initialState: DEFAULTS,
    actions: {
      setMode: ({ mode: m2 }) => api.setMode(m2),
      setButton: (a) => api.setButton(a),
      removeButton: (a) => api.removeButton(a),
      setVariable: (a) => api.setVariable(a),
      createCustomVariable: (a) => api.createCustomVariable(a),
      deleteCustomVariable: (a) => api.deleteCustomVariable(a),
      setConnections: (a) => api.setConnections(a),
      setConnectionStatus: (a) => api.setConnectionStatus(a),
      operatorPress: (a) => api.operatorPress(a),
      reset: () => api.reset(),
    },
  });

  return {
    device: 'companion', port: actualPort, url: `http://127.0.0.1:${actualPort}`, control,
    get state() { return state; }, ...api,
    stop: async () => { for (const s of sockets) s.destroy(); await new Promise((r) => server.close(() => r())); await control.stop(); },
  };
}

module.exports = { start, DEFAULTS };

if (require.main === module) {
  // Never default to 8000: that is Companion's own default port (a real Companion may be running there).
  start({ port: Number(process.env.PORT) || 18000, controlPort: Number(process.env.CONTROL_PORT) || 0 })
    .then((s) => console.log(`[mock-companion] device=${s.url}  control=${s.control.url}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
