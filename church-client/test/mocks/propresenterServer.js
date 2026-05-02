/**
 * Mock ProPresenter 7 / 21.x HTTP server.
 *
 * Implements the subset of /v1/* endpoints that
 * church-client/src/propresenter.js exercises:
 *   GET  /version                                       → { version }
 *   GET  /v1/status/slide                               → liveness probe
 *   GET  /v1/presentation/active                        → current slide
 *   GET  /v1/playlists                                  → playlist tree
 *   GET  /v1/looks/current                              → active look
 *   GET  /v1/timers/current                             → timer list
 *   GET  /v1/transport/presentation/current             → video countdown
 *   GET  /v1/status/screens                             → screen state
 *   POST /v1/trigger/(next|previous)                    → playlist trigger
 *   POST /v1/presentation/focused/(next|previous|N)/trigger → presentation trigger
 *
 * Tests can manipulate the mock via the control API:
 *   POST /action { action: "advanceSlide" }
 *   POST /action { action: "setSlide", args: { presentationName, slideIndex, slideTotal, slideNotes } }
 *   POST /action { action: "setTimer", args: { id, name, time, state } }
 *   POST /action { action: "setVideoCountdown", args: { name, duration, time, isPlaying } }
 */

'use strict';

const http = require('node:http');
const { createControlServer } = require('./_lib/control');

const DEFAULTS = {
  version: '7.13',
  slide: {
    presentationName: 'Sample Presentation',
    presentationUUID: '00000000-0000-0000-0000-000000000001',
    slideIndex: 0,
    slideTotal: 12,
    slideNotes: '',
  },
  playlists: [
    { name: 'Sunday Service', type: 'playlist', items: [
      { name: 'Welcome', type: 'presentation' },
      { name: 'Worship Set', type: 'presentation' },
      { name: 'Sermon', type: 'presentation' },
    ] },
  ],
  look: { id: 'look-1', name: 'Default' },
  timers: [],
  videoCountdown: null, // null when nothing playing
  screens: { audience: 'Sunday Service', stage: 'Stage Display' },
  triggerLog: [],
};

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(body));
  });
}

async function start({ port = 1025, controlPort = 0 } = {}) {
  const state = JSON.parse(JSON.stringify(DEFAULTS));

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const url = (req.url || '/').split('?')[0];

    // ── Liveness + version
    if (req.method === 'GET' && url === '/v1/status/slide') {
      res.end(JSON.stringify({ slideIndex: state.slide.slideIndex, presentationName: state.slide.presentationName }));
      return;
    }
    if (req.method === 'GET' && url === '/version') {
      res.end(JSON.stringify({ version: state.version }));
      return;
    }

    // ── Read endpoints
    if (req.method === 'GET' && url === '/v1/presentation/active') {
      res.end(JSON.stringify({
        presentation: { name: state.slide.presentationName, uuid: state.slide.presentationUUID },
        slideIndex: state.slide.slideIndex,
        slideCount: state.slide.slideTotal,
        notes: state.slide.slideNotes,
      }));
      return;
    }
    if (req.method === 'GET' && url === '/v1/playlists') {
      res.end(JSON.stringify({ playlists: state.playlists }));
      return;
    }
    if (req.method === 'GET' && url === '/v1/looks/current') {
      res.end(JSON.stringify({ id: { uuid: state.look.id, name: state.look.name } }));
      return;
    }
    if (req.method === 'GET' && url === '/v1/timers/current') {
      res.end(JSON.stringify({ timers: state.timers }));
      return;
    }
    if (req.method === 'GET' && url === '/v1/transport/presentation/current') {
      res.end(JSON.stringify(state.videoCountdown || {}));
      return;
    }
    if (req.method === 'GET' && url === '/v1/status/screens') {
      res.end(JSON.stringify(state.screens));
      return;
    }

    // ── Write endpoints (triggers — body usually empty; just log + advance).
    // Note: church-client/src/propresenter.js _fire() calls fetch() without an
    // explicit method, so triggers actually arrive as GET requests. Accept
    // either method to stay tolerant of both PP firmware behaviors.
    if (req.method === 'POST' || req.method === 'GET') {
      // Playlist mode
      if (url === '/v1/trigger/next') {
        await readBody(req);
        state.slide.slideIndex = (state.slide.slideIndex + 1) % Math.max(state.slide.slideTotal, 1);
        state.triggerLog.push({ kind: 'next', mode: 'playlist', ts: Date.now() });
        res.statusCode = 204;
        res.end();
        return;
      }
      if (url === '/v1/trigger/previous') {
        await readBody(req);
        state.slide.slideIndex = Math.max(0, state.slide.slideIndex - 1);
        state.triggerLog.push({ kind: 'previous', mode: 'playlist', ts: Date.now() });
        res.statusCode = 204;
        res.end();
        return;
      }
      // Presentation mode
      let m = url.match(/^\/v1\/presentation\/focused\/(next|previous)\/trigger$/);
      if (m) {
        await readBody(req);
        if (m[1] === 'next') state.slide.slideIndex = (state.slide.slideIndex + 1) % Math.max(state.slide.slideTotal, 1);
        else state.slide.slideIndex = Math.max(0, state.slide.slideIndex - 1);
        state.triggerLog.push({ kind: m[1], mode: 'presentation', ts: Date.now() });
        res.statusCode = 204;
        res.end();
        return;
      }
      m = url.match(/^\/v1\/presentation\/focused\/(\d+)\/trigger$/);
      if (m) {
        await readBody(req);
        state.slide.slideIndex = Math.min(Number(m[1]), Math.max(0, state.slide.slideTotal - 1));
        state.triggerLog.push({ kind: 'goto', index: Number(m[1]), mode: 'presentation', ts: Date.now() });
        res.statusCode = 204;
        res.end();
        return;
      }
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actualPort = server.address().port;

  const control = await createControlServer({
    device: 'propresenter',
    port: controlPort,
    state,
    initialState: DEFAULTS,
    actions: {
      advanceSlide: () => {
        state.slide.slideIndex = (state.slide.slideIndex + 1) % Math.max(state.slide.slideTotal, 1);
      },
      setSlide: ({ presentationName, presentationUUID, slideIndex, slideTotal, slideNotes }) => {
        if (presentationName !== undefined) state.slide.presentationName = presentationName;
        if (presentationUUID !== undefined) state.slide.presentationUUID = presentationUUID;
        if (slideIndex !== undefined) state.slide.slideIndex = slideIndex;
        if (slideTotal !== undefined) state.slide.slideTotal = slideTotal;
        if (slideNotes !== undefined) state.slide.slideNotes = slideNotes;
      },
      setTimer: ({ id, name, time = '00:00', state: timerState = 'Running' }) => {
        const idx = state.timers.findIndex((t) => t.id?.uuid === id || t.id === id);
        const timer = { id: { uuid: id, name }, name, time, state: timerState };
        if (idx >= 0) state.timers[idx] = timer;
        else state.timers.push(timer);
      },
      setVideoCountdown: (vc) => { state.videoCountdown = vc || null; },
      setVersion: ({ version }) => { state.version = version; },
    },
  });

  return {
    device: 'propresenter',
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
  start({ port: Number(process.env.PORT) || 1025, controlPort: Number(process.env.CONTROL_PORT) || 0 })
    .then((s) => console.log(`[mock-propresenter] device=${s.url}  control=${s.control.url}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
