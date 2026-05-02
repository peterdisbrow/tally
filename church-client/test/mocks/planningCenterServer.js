/**
 * Mock Planning Center Online (PCO) Services API server.
 *
 * Default mock port: 8083 (HTTP — real PCO is HTTPS at
 * api.planningcenteronline.com/services/v2). Speaks the PCO Services v2
 * JSON:API surface that relay-server/src/planningCenter.js exercises:
 *
 *   POST /oauth/token              → exchange auth code / refresh token
 *   POST /oauth/revoke             → revoke
 *   GET  /services/v2/service_types
 *   GET  /services/v2/service_types/:id/plans
 *   GET  /services/v2/plans/:id/items
 *   GET  /services/v2/plans/:id/team_members
 *   GET  /services/v2/plans/:id/plan_times
 *   GET  /services/v2/plans/:id/notes
 *
 * **Important caveat:** PCO's API base URL is hardcoded in
 * relay-server/src/planningCenter.js as `PC_API_BASE` — there's currently no
 * env-var override. So this mock is useful for:
 *   1. Manual API exploration during development (`curl http://127.0.0.1:8083/...`)
 *   2. Future integration tests, AFTER PlanningCenter gets a configurable
 *      base URL (one-line constructor change).
 * Until then, code that imports the PlanningCenter class will still hit
 * production PCO. The mock is wired into the launcher so it's discoverable
 * and ready when that change lands.
 *
 * OAuth flow: this mock accepts ANY auth code / refresh token and returns a
 * canned access token. Tests that need a specific token can override via
 * the control API.
 *
 * Tests can manipulate the mock via the control API:
 *   POST /action { action: "setAccessToken", args: { token, expiresIn } }
 *   POST /action { action: "setServiceTypes", args: [...] }
 *   POST /action { action: "setPlans", args: { serviceTypeId, plans: [...] } }
 *   POST /action { action: "setPlanItems", args: { planId, items: [...] } }
 */

'use strict';

const http = require('node:http');
const { createControlServer } = require('./_lib/control');

function isoNow(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

const DEFAULTS = {
  accessToken: 'mock-access-token-1234',
  refreshToken: 'mock-refresh-token-5678',
  expiresInSec: 7200,
  serviceTypes: [
    { id: 'st-1', type: 'ServiceType', attributes: { name: 'Sunday Morning' } },
    { id: 'st-2', type: 'ServiceType', attributes: { name: 'Wednesday Night' } },
  ],
  plansByServiceType: {
    'st-1': [
      { id: 'plan-100', type: 'Plan', attributes: { title: 'Easter Sunday', sort_date: isoNow(7 * 86400000), dates: 'Apr 5, 2026' } },
      { id: 'plan-101', type: 'Plan', attributes: { title: 'Apr 12 Service', sort_date: isoNow(14 * 86400000), dates: 'Apr 12, 2026' } },
    ],
  },
  itemsByPlan: {
    'plan-100': [
      { id: 'i-1', type: 'Item', attributes: { title: 'Welcome', length: 180, sequence: 1, item_type: 'header' } },
      { id: 'i-2', type: 'Item', attributes: { title: 'Worship: Goodness of God', length: 320, sequence: 2, item_type: 'song' } },
      { id: 'i-3', type: 'Item', attributes: { title: 'Sermon: Resurrection Hope', length: 1800, sequence: 3, item_type: 'header' } },
    ],
  },
  teamMembersByPlan: { 'plan-100': [
    { id: 'tm-1', type: 'PlanPerson', attributes: { name: 'Andrew', team_position_name: 'Tech Director' } },
  ] },
  planTimesByPlan: { 'plan-100': [
    { id: 'pt-1', type: 'PlanTime', attributes: { name: '10:00 AM Service', starts_at: isoNow(7 * 86400000) } },
  ] },
  notesByPlan: { 'plan-100': [] },
  callLog: [],
};

function jsonApiCollection(data) {
  return JSON.stringify({ data, meta: { total_count: data.length, count: data.length } });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(body));
  });
}

async function start({ port = 8083, controlPort = 0 } = {}) {
  const state = JSON.parse(JSON.stringify(DEFAULTS));

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = new URL(req.url || '/', 'http://x');
    const path = url.pathname;
    state.callLog.push({ method: req.method, path, ts: Date.now() });

    // OAuth — token exchange / refresh. Always succeeds.
    if (req.method === 'POST' && path === '/oauth/token') {
      await readBody(req);
      res.end(JSON.stringify({
        access_token: state.accessToken,
        refresh_token: state.refreshToken,
        token_type: 'Bearer',
        expires_in: state.expiresInSec,
        created_at: Math.floor(Date.now() / 1000),
      }));
      return;
    }
    if (req.method === 'POST' && path === '/oauth/revoke') {
      await readBody(req);
      res.statusCode = 200;
      res.end(JSON.stringify({}));
      return;
    }

    // Services v2 — JSON:API endpoints
    if (req.method === 'GET' && path === '/services/v2/service_types') {
      res.end(jsonApiCollection(state.serviceTypes));
      return;
    }
    let m = path.match(/^\/services\/v2\/service_types\/([^/]+)\/plans$/);
    if (m && req.method === 'GET') {
      const stId = m[1];
      res.end(jsonApiCollection(state.plansByServiceType[stId] || []));
      return;
    }
    m = path.match(/^\/services\/v2\/plans\/([^/]+)\/items$/);
    if (m && req.method === 'GET') {
      res.end(jsonApiCollection(state.itemsByPlan[m[1]] || []));
      return;
    }
    m = path.match(/^\/services\/v2\/plans\/([^/]+)\/team_members$/);
    if (m && req.method === 'GET') {
      res.end(jsonApiCollection(state.teamMembersByPlan[m[1]] || []));
      return;
    }
    m = path.match(/^\/services\/v2\/plans\/([^/]+)\/plan_times$/);
    if (m && req.method === 'GET') {
      res.end(jsonApiCollection(state.planTimesByPlan[m[1]] || []));
      return;
    }
    m = path.match(/^\/services\/v2\/plans\/([^/]+)\/notes$/);
    if (m && req.method === 'GET') {
      res.end(jsonApiCollection(state.notesByPlan[m[1]] || []));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ errors: [{ status: '404', title: 'Not found', detail: path }] }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;

  const control = await createControlServer({
    device: 'planning-center',
    port: controlPort,
    state,
    initialState: DEFAULTS,
    actions: {
      setAccessToken: ({ token, expiresIn }) => {
        if (token !== undefined) state.accessToken = token;
        if (expiresIn !== undefined) state.expiresInSec = Number(expiresIn);
      },
      setServiceTypes: (types) => { if (Array.isArray(types)) state.serviceTypes = types; },
      setPlans: ({ serviceTypeId, plans }) => {
        if (Array.isArray(plans)) state.plansByServiceType[serviceTypeId] = plans;
      },
      setPlanItems: ({ planId, items }) => {
        if (Array.isArray(items)) state.itemsByPlan[planId] = items;
      },
    },
  });

  return {
    device: 'planning-center',
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
  start({ port: Number(process.env.PORT) || 8083, controlPort: Number(process.env.CONTROL_PORT) || 0 })
    .then((s) => console.log(`[mock-planning-center] device=${s.url}  control=${s.control.url}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
