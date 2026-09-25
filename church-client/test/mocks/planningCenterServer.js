/**
 * Mock Planning Center Online (PCO) — Services v2 JSON:API + OAuth.
 *
 * Mirrors the real API as documented at
 * api.planningcenteronline.com/docs/apps/services/versions/2018-11-01 (checked 25 Sep 2026):
 *   - Every Services v2 resource is nested under /services/v2/service_types/:st/plans/:plan/...
 *   - Auth: HTTP Basic (Personal Access Token app_id:secret) or Bearer (OAuth). Anything else → 401.
 *   - JSON:API errors: { errors: [{ status, title, detail, source? }] }.
 *   - Plan.sort_date is the org's LOCAL wall time wrongly suffixed with "Z" (PCO confirmed this in
 *     planningcenter/developers#1198); PlanTime.starts_at is real UTC.
 *   - POST .../plans/:id/notes needs relationships.plan_note_category (required, must exist in
 *     the service type) — category_name is read-only; without it real PCO answers
 *     422 "must exist" (developers#961).
 *   - PlanPerson status is updated via PATCH /services/v2/people/:person/plan_people/:id
 *     (not under plans/:id/team_members).
 *   - Pagination: per_page (max 100, default 25) + offset; links.next when more.
 *   - Rate limit: 429 with Retry-After (seconds).
 *
 * Point the relay at it with PCO_API_ORIGIN=http://127.0.0.1:<port> (lab only).
 *
 * Control API (POST /action { action, args }):
 *   setMode { mode: ok|down|hang }         — down = 503, hang = never answers
 *   revoke {}                              — every credential now gets 401
 *   setWriteAllowed { allowed }            — false → 403 on writes (read-only PCO user)
 *   rateLimit { count, retryAfter }        — next <count> requests get 429
 *   setOrgTimezone { tz }                 — IANA zone for the future/past filters
 *   setPlans { serviceTypeId, plans }      — plans: [{ id, title, sortDate, times?, items?, team? }]
 *   deletePlan { planId }
 *   setNoteCategories { serviceTypeId, categories: [{ id, name }] }
 *   setCredentials { appId, secret, bearer }
 */
'use strict';

const http = require('node:http');
const { createControlServer } = require('./_lib/control');

// Wall-clock "local" time formatted with the fake Z, like PCO's sort_date.
function wallZ(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00Z`;
}
// Wall clock "now" in the org's timezone (null → host local), formatted like sort_date.
function orgNowZ(tz) {
  if (!tz) return wallZ(new Date());
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`;
}
function nextSundayAt(hour, min = 0, weeksAhead = 0) {
  const d = new Date();
  d.setHours(hour, min, 0, 0);
  const add = (7 - d.getDay()) % 7 || 7;
  d.setDate(d.getDate() + add + weeksAhead * 7);
  return d;
}

function defaults() {
  const s1 = nextSundayAt(9, 0);
  const s2 = nextSundayAt(11, 0);
  return {
    mode: 'ok',
    orgTimezone: null, // null = host local; PCO filters future/past on the org's wall clock
    revoked: false,
    writeAllowed: true,
    rateLimitLeft: 0,
    retryAfter: 1,
    credentials: { appId: 'lab-app-id', secret: 'lab-secret', bearer: 'mock-access-token-1234' },
    org: { name: 'Lab Church (mock PCO)' },
    serviceTypes: [
      { id: '1001', name: 'Sunday Morning' },
      { id: '1002', name: 'Wednesday Night' },
    ],
    noteCategories: {
      1001: [{ id: '501', name: 'Production' }, { id: '502', name: 'Pastor' }],
      1002: [{ id: '601', name: 'General' }],
    },
    plans: {
      1001: [
        {
          id: '9001', title: 'Sunday 9:00', sortDate: wallZ(s1),
          times: [{ id: '71', name: '9:00 AM', time_type: 'service', starts_at: s1.toISOString() }],
          items: [
            { id: '81', title: 'Welcome', item_type: 'item', sequence: 1, length: 180 },
            { id: '82', title: 'Goodness of God', item_type: 'song', sequence: 2, length: 320 },
            { id: '83', title: 'Sermon', item_type: 'item', sequence: 3, length: 1800 },
          ],
          team: [
            { id: '91', person_id: '3001', name: 'Andrew Disbrow', team_position_name: 'Technical Director', status: 'U' },
            { id: '92', person_id: '3002', name: 'Alice Cooper', team_position_name: 'Camera 1', status: 'U' },
          ],
        },
        {
          id: '9002', title: 'Sunday 11:00', sortDate: wallZ(s2),
          times: [{ id: '72', name: '11:00 AM', time_type: 'service', starts_at: s2.toISOString() }],
          items: [], team: [],
        },
      ],
      1002: [],
    },
    notes: {},
    callLog: [],
  };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}
function jerr(res, status, title, detail, extra = {}) {
  send(res, status, { errors: [{ status: String(status), title, detail, ...extra }] });
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => resolve(b));
  });
}
function paginate(url, all, base) {
  const per = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page')) || 25));
  const off = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const data = all.slice(off, off + per);
  const links = { self: `${base}${url.pathname}${url.search}` };
  if (off + per < all.length) {
    const n = new URL(links.self);
    n.searchParams.set('offset', String(off + per));
    n.searchParams.set('per_page', String(per));
    links.next = n.toString();
  }
  return { data, included: [], meta: { total_count: all.length, count: data.length }, links };
}

async function start({ port = 8083, controlPort = 0 } = {}) {
  const state = defaults();
  let base = '';

  const planOf = (st, id) => (state.plans[st] || []).find((p) => p.id === id);
  const planRes = (st, p) => ({
    type: 'Plan', id: p.id,
    attributes: { title: p.title, sort_date: p.sortDate, dates: p.sortDate.slice(0, 10), updated_at: p.updatedAt || '2026-09-01T00:00:00Z', items_count: (p.items || []).length },
    relationships: { service_type: { data: { type: 'ServiceType', id: st } } },
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', base);
    const path = url.pathname;
    const body = req.method === 'GET' ? '' : await readBody(req);
    state.callLog.push({ method: req.method, path: `${path}${url.search}`, body: body || undefined, ts: Date.now() });
    if (state.callLog.length > 200) state.callLog.shift();

    if (state.mode === 'hang') return; // never answer
    if (state.mode === 'down') return jerr(res, 503, 'Service Unavailable', 'Planning Center is temporarily unavailable');

    // OAuth
    if (req.method === 'POST' && path === '/oauth/token') {
      if (state.revoked) return send(res, 401, { error: 'invalid_grant', error_description: 'The provided authorization grant is invalid, expired, revoked' });
      return send(res, 200, { access_token: state.credentials.bearer, refresh_token: 'mock-refresh-token-5678', token_type: 'Bearer', expires_in: 7200, created_at: Math.floor(Date.now() / 1000) });
    }
    if (req.method === 'POST' && path === '/oauth/revoke') return send(res, 200, {});

    // Auth
    const auth = req.headers.authorization || '';
    const basicOk = auth === `Basic ${Buffer.from(`${state.credentials.appId}:${state.credentials.secret}`).toString('base64')}`;
    const bearerOk = auth === `Bearer ${state.credentials.bearer}`;
    if (state.revoked || !(basicOk || bearerOk)) {
      return jerr(res, 401, 'Unauthorized', 'The access token is invalid, expired, or revoked');
    }
    if (state.rateLimitLeft > 0) {
      state.rateLimitLeft -= 1;
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(state.retryAfter) });
      return res.end(JSON.stringify({ errors: [{ status: '429', title: 'Too Many Requests', detail: `Rate limit exceeded. Try again in ${state.retryAfter} seconds` }] }));
    }

    if (req.method === 'GET' && path === '/people/v2/me') {
      return send(res, 200, { data: { type: 'Person', id: '3001', attributes: { name: 'Andrew Disbrow' } }, meta: { parent: { id: '1', type: 'Organization' } } });
    }
    if (req.method === 'GET' && path === '/services/v2') {
      return send(res, 200, { data: { type: 'Organization', id: '1', attributes: { name: state.org.name } } });
    }

    let m;
    if (req.method === 'GET' && path === '/services/v2/service_types') {
      const all = state.serviceTypes.map((s) => ({ type: 'ServiceType', id: s.id, attributes: { name: s.name, frequency: 'Weekly' } }));
      return send(res, 200, paginate(url, all, base));
    }
    if ((m = path.match(/^\/services\/v2\/service_types\/([^/]+)$/)) && req.method === 'GET') {
      const s = state.serviceTypes.find((x) => x.id === m[1]);
      if (!s) return jerr(res, 404, 'Not Found', 'The resource you requested could not be found');
      return send(res, 200, { data: { type: 'ServiceType', id: s.id, attributes: { name: s.name } } });
    }
    if ((m = path.match(/^\/services\/v2\/service_types\/([^/]+)\/plan_note_categories$/)) && req.method === 'GET') {
      const all = (state.noteCategories[m[1]] || []).map((c, i) => ({ type: 'PlanNoteCategory', id: c.id, attributes: { name: c.name, sequence: i } }));
      return send(res, 200, paginate(url, all, base));
    }
    if ((m = path.match(/^\/services\/v2\/service_types\/([^/]+)\/plans$/)) && req.method === 'GET') {
      if (!state.serviceTypes.find((x) => x.id === m[1])) return jerr(res, 404, 'Not Found', 'The resource you requested could not be found');
      let all = [...(state.plans[m[1]] || [])];
      const filter = url.searchParams.get('filter');
      const nowWall = orgNowZ(state.orgTimezone);
      if (filter === 'future') all = all.filter((p) => p.sortDate >= nowWall);
      if (filter === 'past') all = all.filter((p) => p.sortDate < nowWall);
      const order = url.searchParams.get('order') || 'sort_date';
      all.sort((a, b) => (order.startsWith('-') ? b.sortDate.localeCompare(a.sortDate) : a.sortDate.localeCompare(b.sortDate)));
      return send(res, 200, paginate(url, all.map((p) => planRes(m[1], p)), base));
    }
    if ((m = path.match(/^\/services\/v2\/service_types\/([^/]+)\/plans\/([^/]+)(?:\/([a-z_]+))?(?:\/([^/]+))?$/))) {
      const [, st, pid, sub, subId] = m;
      const p = planOf(st, pid);
      if (!p) return jerr(res, 404, 'Not Found', 'The resource you requested could not be found');
      if (!sub && req.method === 'GET') return send(res, 200, { data: planRes(st, p) });
      if (sub === 'items' && req.method === 'GET' && !subId) {
        return send(res, 200, paginate(url, (p.items || []).map((it) => ({ type: 'Item', id: it.id, attributes: { title: it.title, item_type: it.item_type, sequence: it.sequence, length: it.length, service_position: 'during' }, relationships: {} })), base));
      }
      if (sub === 'team_members' && req.method === 'GET' && !subId) {
        return send(res, 200, paginate(url, (p.team || []).map((t) => ({ type: 'PlanPerson', id: t.id, attributes: { name: t.name, team_position_name: t.team_position_name, status: t.status }, relationships: { person: { data: { type: 'Person', id: t.person_id } } } })), base));
      }
      if (sub === 'plan_times' && req.method === 'GET' && !subId) {
        return send(res, 200, paginate(url, (p.times || []).map((t) => ({ type: 'PlanTime', id: t.id, attributes: { name: t.name, time_type: t.time_type, starts_at: t.starts_at, ends_at: t.ends_at || null } })), base));
      }
      if (sub === 'notes' && !subId) {
        state.notes[pid] = state.notes[pid] || [];
        if (req.method === 'GET') return send(res, 200, paginate(url, state.notes[pid], base));
        if (req.method === 'POST') {
          if (!state.writeAllowed) return jerr(res, 403, 'Forbidden', 'You do not have permission to create this resource');
          let doc;
          try { doc = JSON.parse(body); } catch { return jerr(res, 400, 'Bad Request', 'Invalid JSON'); }
          const content = doc?.data?.attributes?.content;
          const catId = doc?.data?.relationships?.plan_note_category?.data?.id;
          const cat = (state.noteCategories[st] || []).find((c) => String(c.id) === String(catId));
          if (!cat) return jerr(res, 422, 'Validation Error', 'must exist', { source: { parameter: 'category' }, meta: { resource: 'PlanNote' } });
          const note = { type: 'PlanNote', id: String(7000 + state.callLog.length), attributes: { content, category_name: cat.name } };
          state.notes[pid].push(note);
          return send(res, 201, { data: note });
        }
      }
      // Anything else under a plan (e.g. PATCH team_members/:id) is not a real route.
      return jerr(res, 404, 'Not Found', 'The resource you requested could not be found');
    }
    if ((m = path.match(/^\/services\/v2\/people\/([^/]+)\/plan_people\/([^/]+)$/)) && req.method === 'PATCH') {
      if (!state.writeAllowed) return jerr(res, 403, 'Forbidden', 'You do not have permission to update this resource');
      const [, personId, ppId] = m;
      let t = null;
      for (const list of Object.values(state.plans)) for (const p of list) for (const x of p.team || []) if (x.id === ppId && x.person_id === personId) t = x;
      if (!t) return jerr(res, 404, 'Not Found', 'The resource you requested could not be found');
      let doc;
      try { doc = JSON.parse(body); } catch { return jerr(res, 400, 'Bad Request', 'Invalid JSON'); }
      const st = doc?.data?.attributes?.status;
      if (!['C', 'U', 'D', 'Confirmed', 'Unconfirmed', 'Declined'].includes(st)) return jerr(res, 422, 'Validation Error', 'status is not included in the list');
      t.status = st[0];
      return send(res, 200, { data: { type: 'PlanPerson', id: t.id, attributes: { name: t.name, status: t.status } } });
    }
    return jerr(res, 404, 'Not Found', 'The resource you requested could not be found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;
  base = `http://127.0.0.1:${actualPort}`;

  const api = {
    setMode: ({ mode }) => { state.mode = mode || 'ok'; },
    revoke: () => { state.revoked = true; },
    unrevoke: () => { state.revoked = false; },
    setWriteAllowed: ({ allowed }) => { state.writeAllowed = allowed !== false; },
    rateLimit: ({ count = 1, retryAfter = 1 }) => { state.rateLimitLeft = Number(count); state.retryAfter = Number(retryAfter); },
    setPlans: ({ serviceTypeId, plans }) => { state.plans[serviceTypeId] = plans; },
    setOrgTimezone: ({ tz }) => { state.orgTimezone = tz || null; },
    deletePlan: ({ planId }) => { for (const k of Object.keys(state.plans)) state.plans[k] = state.plans[k].filter((p) => p.id !== planId); },
    setNoteCategories: ({ serviceTypeId, categories }) => { state.noteCategories[serviceTypeId] = categories; },
    setCredentials: (c) => { Object.assign(state.credentials, c); },
    reset: () => { const f = defaults(); for (const k of Object.keys(state)) delete state[k]; Object.assign(state, f); },
  };
  const control = await createControlServer({ device: 'planning-center', port: controlPort, state, initialState: defaults(), actions: api });

  return {
    device: 'planning-center',
    port: actualPort,
    url: base,
    control,
    state,
    ...api,
    wallZ,
    nextSundayAt,
    stop: async () => {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
      await control.stop();
    },
  };
}

module.exports = { start, wallZ, nextSundayAt };

if (require.main === module) {
  start({ port: Number(process.env.PORT) || 8083, controlPort: Number(process.env.CONTROL_PORT) || 0 })
    .then((s) => console.log(`[mock-planning-center] device=${s.url}  control=${s.control.url}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
