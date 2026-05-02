/**
 * Mock TriCaster HTTP server (default port 5951).
 *
 * Implements the subset of /v1/* endpoints that
 * church-client/src/encoders/tricaster.js exercises:
 *   GET  /v1/version
 *   GET  /v1/dictionary?key=version|software_version|session_name
 *   GET  /v1/shortcut?name=<name>            → return state of named shortcut
 *   POST /v1/shortcut                        → set shortcut state (XML/JSON/form)
 *   POST /v1/shortcut?name=<name>&value=N    → set via query string
 *   POST /shortcut?name=<name>               → legacy path (older firmware)
 *
 * Tolerates all 6 dialect variants the church-client tries (XML attribute,
 * XML nested entry, query string, form-encoded, state attribute, JSON).
 *
 * Tests can manipulate the mock via the control API:
 *   POST /action { action: "setShortcut", args: { name, value } }
 *   POST /action { action: "setVersion", args: { version: "8.2.230718" } }
 */

'use strict';

const http = require('node:http');
const { createControlServer } = require('./_lib/control');

const DEFAULTS = {
  version: '8.2.230718',
  shortcuts: {
    streaming_toggle: false,
    record_toggle: false,
    main_program_input_a: 'Input 1',
  },
  shortcutLog: [],
};

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(body));
  });
}

function parseShortcutWrite(body, contentType, urlSearch) {
  // Returns { name, value }. Tries every dialect the church-client may emit.
  const ct = String(contentType || '').toLowerCase();

  // Query-string variant
  if (urlSearch && urlSearch.has('name')) {
    return { name: urlSearch.get('name'), value: urlSearch.get('value') };
  }

  // JSON
  if (ct.includes('json')) {
    try { const j = JSON.parse(body); return { name: j.name, value: j.value }; } catch { /* fall through */ }
  }

  // Form-encoded
  if (ct.includes('x-www-form-urlencoded')) {
    const p = new URLSearchParams(body);
    return { name: p.get('name'), value: p.get('value') };
  }

  // XML — attribute (value=, state=) or nested <entry value="...">
  const attrM = body.match(/<shortcut\s+name="([^"]+)"\s+(?:value|state)="([^"]+)"/i);
  if (attrM) return { name: attrM[1], value: attrM[2] };
  const nestedM = body.match(/<shortcut\s+name="([^"]+)"[^>]*>[\s\S]*?<entry\s+key="value"\s+value="([^"]+)"/i);
  if (nestedM) return { name: nestedM[1], value: nestedM[2] };
  // Toggle without value
  const toggleM = body.match(/<shortcut\s+name="([^"]+)"\s*\/?>/i);
  if (toggleM) return { name: toggleM[1], value: null };

  return { name: null, value: null };
}

function coerceBool(value) {
  if (value === null || value === undefined) return null;
  const v = String(value).toLowerCase();
  if (v === '1' || v === 'true' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'off') return false;
  return value;
}

async function start({ port = 5951, controlPort = 0 } = {}) {
  const state = JSON.parse(JSON.stringify(DEFAULTS));

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/xml');
    const url = new URL(req.url || '/', `http://x`);
    const path = url.pathname;

    // GET /v1/version
    if (req.method === 'GET' && path === '/v1/version') {
      res.end(`<info><version>${state.version}</version></info>`);
      return;
    }
    // GET /v1/dictionary?key=...
    if (req.method === 'GET' && path === '/v1/dictionary') {
      const key = url.searchParams.get('key');
      const value = key === 'session_name' ? 'mock-session'
                  : key === 'software_version' ? state.version
                  : state.version;
      res.end(`<dictionary key="${key || ''}">${value}</dictionary>`);
      return;
    }
    // GET /v1/shortcut?name=...
    if (req.method === 'GET' && path === '/v1/shortcut') {
      const name = url.searchParams.get('name');
      const cur = state.shortcuts[name];
      const v = typeof cur === 'boolean' ? (cur ? 1 : 0) : (cur ?? '');
      res.end(`<shortcut name="${name || ''}" value="${v}" />`);
      return;
    }
    // POST /v1/shortcut OR POST /shortcut OR POST /v1/shortcut?...
    if (req.method === 'POST' && (path === '/v1/shortcut' || path === '/shortcut')) {
      const body = await readBody(req);
      const { name, value } = parseShortcutWrite(body, req.headers['content-type'], url.searchParams);
      if (name) {
        const coerced = coerceBool(value);
        state.shortcuts[name] = coerced;
        state.shortcutLog.push({ name, value: coerced, ts: Date.now() });
      }
      res.statusCode = 200;
      res.end('');
      return;
    }

    res.statusCode = 404;
    res.end(`<error>not found: ${path}</error>`);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;

  const control = await createControlServer({
    device: 'tricaster',
    port: controlPort,
    state,
    initialState: DEFAULTS,
    actions: {
      setShortcut: ({ name, value }) => { state.shortcuts[name] = value; },
      setVersion: ({ version }) => { state.version = version; },
    },
  });

  return {
    device: 'tricaster',
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    control,
    state,
    stop: async () => {
      await new Promise((r) => server.close(() => r()));
      await control.stop();
    },
  };
}

module.exports = { start };

if (require.main === module) {
  start({ port: Number(process.env.PORT) || 5951, controlPort: Number(process.env.CONTROL_PORT) || 0 })
    .then((s) => console.log(`[mock-tricaster] device=${s.url}  control=${s.control.url}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
