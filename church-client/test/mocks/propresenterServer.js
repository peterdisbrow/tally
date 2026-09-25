/**
 * Stateful ProPresenter 7 / 21.x mock — the official /v1 REST API (openapi.propresenter.com).
 *
 * Paths, methods and shapes follow the published OpenAPI spec: triggers are GET and
 * answer 204; unknown paths / wrong methods / unknown ids answer 404 (like PP).
 * State changes are real: triggering slide N moves slide_index, looks change
 * /v1/look/current, timers change /v1/timers/current, clears change /v1/status/layers,
 * audience/stage screens are booleans you can PUT and GET back.
 *
 * It says no:
 *   - unknown ids / out-of-range cue index → 404
 *   - next on the last slide does not move (PP stops at the end)
 *   - setMode('offline') → connections are reset; setMode('hang') → accepted, never answered
 *   - setMode('not-pp') → a different web server on the port (every path 404)
 * Mutation modes (PP_MOCK_BREAK or start({ breakMode })):
 *   ignore-triggers  every trigger / PUT answers 204 but changes nothing
 *   http-500         every trigger / PUT answers 500
 */
'use strict';

const http = require('node:http');
const { createControlServer } = require('./_lib/control');

const id = (uuid, name, index) => ({ uuid, name, index });
function makePres(uuid, name, index, groups) {
  return { id: id(uuid, name, index), groups: groups.map(([g, n]) => ({ name: g, color: null, slides: Array.from({ length: n }, (_, i) => ({ enabled: true, notes: `${g} note ${i + 1}`, text: `${name} — ${g} ${i + 1}`, label: '' })) })), has_timeline: false };
}
function initialState() {
  const pres = [
    makePres('pres-welcome', 'Welcome', 0, [['Intro', 3]]),
    makePres('pres-worship', 'Worship Set', 1, [['Verse 1', 4], ['Chorus', 4], ['Verse 2', 4]]),
    makePres('pres-sermon', 'Sermon', 2, [['Points', 8]]),
    makePres('pres-announce', 'Announcements Loop', 3, [['Slides', 5]]),
  ];
  return {
    version: { name: 'Sanctuary PP', platform: 'mac', os_version: '14.5', host_description: 'ProPresenter 7.16.2', api_version: 'v1' },
    presentations: Object.fromEntries(pres.map((p) => [p.id.uuid, p])),
    libraries: [{ id: id('lib-default', 'Default', 0), items: ['pres-welcome', 'pres-worship', 'pres-sermon', 'pres-announce'] }],
    playlists: [{ id: id('pl-sunday', 'Sunday Service', 0), type: 'playlist', items: ['pres-welcome', 'pres-worship', 'pres-sermon'] }],
    focused: 'pres-worship',
    active: null,              // uuid of the presentation on screen
    slideIndex: null,          // cue index on screen
    playlistFocused: { playlist: 'pl-sunday', item: 1 },
    looks: [{ id: id('look-default', 'Default', 0), screens: [] }, { id: id('look-stream', 'Stream Only', 1), screens: [] }],
    currentLook: 'look-default',
    timers: [
      { id: id('timer-countdown', 'Service Countdown', 0), allows_overrun: false, countdown: { duration: 300 }, state: 'stopped', time: '00:05:00' },
      { id: id('timer-sermon', 'Sermon', 1), allows_overrun: true, countdown: { duration: 1800 }, state: 'stopped', time: '00:30:00' },
    ],
    messages: [{ id: id('msg-parking', 'Parking', 0), message: 'Car {plate} please move', tokens: [], theme: {}, visible_on_network: true, is_active: false }],
    props: [{ id: id('prop-lower', 'Lower Third', 0), is_active: false }, { id: id('prop-logo', 'Logo Bug', 1), is_active: false }],
    macros: [{ id: id('macro-walkin', 'Walk In', 0), color: {} }],
    groups: [{ id: id('grp-chorus', 'Chorus', 0), color: {} }, { id: id('grp-bridge', 'Bridge', 1), color: {} }],
    stageScreens: [id('ss-left', 'Stage Left', 0), id('ss-right', 'Stage Right', 1)],
    stageLayouts: [{ id: id('sl-current-next', 'Current/Next', 0) }, { id: id('sl-lyrics', 'Lyrics Only', 1) }],
    stageLayoutMap: { 'ss-left': 'sl-current-next', 'ss-right': 'sl-current-next' },
    audienceScreens: true,
    stageScreensOn: true,
    layers: { video_input: false, media: false, slide: false, announcements: false, props: false, messages: false, audio: false },
    transport: {
      presentation: { is_playing: false, uuid: 'media-walkin', name: 'Walk-in Loop', artist: null, audio_only: false, duration: 120, time: 0 },
      announcement: null,
      audio: null,
    },
    capture: { status: 'inactive', capture_time: '00:00:00', status_description: '' },
    videoInputs: [id('vi-cam1', 'Camera 1', 0)],
    audioPlaylists: [{ id: id('ap-walkin', 'Walk-in Music', 0), type: 'playlist', items: ['Song A', 'Song B'] }],
    mediaPlaylists: [{ id: id('mp-bumpers', 'Bumpers', 0), type: 'playlist', items: ['Bumper 1'] }],
    lastMacro: null,
    triggerLog: [],
    requests: 0,
  };
}

async function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); });
}

async function start({ port = 1025, controlPort = 0, breakMode } = {}) {
  let state = initialState();
  const initial = JSON.parse(JSON.stringify(state));
  let mode = 'ok';
  let bm = breakMode ?? process.env.PP_MOCK_BREAK ?? '';
  const sockets = new Set();

  const countOf = (uuid) => (state.presentations[uuid]?.groups || []).reduce((a, g) => a + g.slides.length, 0);
  const showCue = (uuid, index) => {
    state.active = uuid; state.focused = uuid; state.slideIndex = index; state.layers.slide = true;
  };

  function route(method, url, body, q) {
    const S = state;
    const J = (v) => ({ code: 200, json: v });
    const NF = { code: 404, json: null };
    const OK = { code: 204 };
    const findPres = (u) => S.presentations[u];
    const findById = (arr, u) => arr.find((x) => (x.id?.uuid || x.uuid) === u || String(x.id?.index ?? x.index) === u);
    const write = (fn) => {           // state-changing request honouring the break modes
      if (bm === 'http-500') return { code: 500, json: { error: 'internal' } };
      S.triggerLog.push(`${method} ${url}`);
      if (bm === 'ignore-triggers') return OK;
      const r = fn();
      return r || OK;
    };
    let m;
    if (method === 'GET' && url === '/version') return J(S.version);

    // ── status
    if (method === 'GET' && url === '/v1/presentation/slide_index') {
      return J({ presentation_index: S.active ? { index: S.slideIndex, presentation_id: findPres(S.active).id } : null });
    }
    if (method === 'GET' && url === '/v1/status/slide') {
      const p = findPres(S.active); const slides = p ? p.groups.flatMap((g) => g.slides) : [];
      const cur = slides[S.slideIndex]; const nxt = slides[(S.slideIndex ?? -1) + 1];
      return J({ current: cur ? { text: cur.text, notes: cur.notes, uuid: `${S.active}-${S.slideIndex}` } : { text: '', notes: '', uuid: '' }, next: nxt ? { text: nxt.text, notes: nxt.notes, uuid: `${S.active}-${S.slideIndex + 1}` } : { text: '', notes: '', uuid: '' } });
    }
    if (method === 'GET' && url === '/v1/presentation/active') return S.active ? J({ presentation: findPres(S.active) }) : J({ presentation: null });
    if (method === 'GET' && url === '/v1/presentation/focused') return J(findPres(S.focused).id);
    if (method === 'GET' && (m = /^\/v1\/presentation\/([^/]+)$/.exec(url)) && findPres(m[1])) return J({ presentation: findPres(m[1]) });
    if (method === 'GET' && url === '/v1/status/layers') return J({ ...S.layers });
    if (url === '/v1/status/audience_screens') {
      if (method === 'GET') return J(S.audienceScreens);
      if (method === 'PUT') { let v; try { v = JSON.parse(body); } catch { return { code: 400 }; } if (typeof v !== 'boolean') return { code: 400 }; return write(() => { S.audienceScreens = v; }); }
    }
    if (url === '/v1/status/stage_screens') {
      if (method === 'GET') return J(S.stageScreensOn);
      if (method === 'PUT') { let v; try { v = JSON.parse(body); } catch { return { code: 400 }; } if (typeof v !== 'boolean') return { code: 400 }; return write(() => { S.stageScreensOn = v; }); }
    }
    if (method === 'GET' && url === '/v1/status/screens') return J([{ id: id('scr-aud', 'Audience', 0), size: { width: 1920, height: 1080 }, screen_type: 'audience' }, { id: id('scr-stage', 'Stage', 1), size: { width: 1920, height: 1080 }, screen_type: 'stage' }]);

    // ── slide triggers
    if (method === 'GET' && (m = /^\/v1\/presentation\/(focused|active|[^/]+)\/(next|previous|\d+)\/trigger$/.exec(url))) {
      const target = m[1] === 'focused' ? S.focused : m[1] === 'active' ? S.active : m[1];
      if (!findPres(target)) return NF;
      const n = countOf(target);
      if (/^\d+$/.test(m[2])) { const i = Number(m[2]); if (i >= n) return NF; return write(() => showCue(target, i)); }
      return write(() => {
        const cur = S.active === target ? S.slideIndex : -1;
        if (m[2] === 'next') showCue(target, Math.min(n - 1, cur + 1));
        else showCue(target, Math.max(0, cur - 1));
      });
    }
    if (method === 'GET' && (m = /^\/v1\/presentation\/(focused|active|[^/]+)\/trigger$/.exec(url))) {
      const target = m[1] === 'focused' ? S.focused : m[1] === 'active' ? S.active : m[1];
      if (!findPres(target)) return NF;
      return write(() => showCue(target, 0));
    }
    if (method === 'GET' && (m = /^\/v1\/presentation\/(focused|active|[^/]+)\/group\/([^/]+)\/trigger$/.exec(url))) {
      const target = m[1] === 'focused' ? S.focused : m[1] === 'active' ? S.active : m[1];
      const p = findPres(target); const g = findById(S.groups, decodeURIComponent(m[2]));
      if (!p || !g) return NF;
      let idx = 0; let found = -1;
      for (const gr of p.groups) { if (gr.name === g.id.name) { found = idx; break; } idx += gr.slides.length; }
      if (found < 0) return NF;
      return write(() => showCue(target, found));
    }
    if (method === 'GET' && (m = /^\/v1\/trigger\/(next|previous)$/.exec(url))) {
      return write(() => {
        const pl = S.playlists.find((p) => p.id.uuid === S.playlistFocused.playlist);
        const target = S.active || S.focused; const n = countOf(target); const cur = S.active ? S.slideIndex : -1;
        if (m[1] === 'next') {
          if (cur + 1 < n) showCue(target, cur + 1);
          else if (pl && S.playlistFocused.item + 1 < pl.items.length) { S.playlistFocused.item += 1; showCue(pl.items[S.playlistFocused.item], 0); }
        } else if (cur > 0) showCue(target, cur - 1);
      });
    }

    // ── libraries / playlists
    if (method === 'GET' && url === '/v1/libraries') return J(S.libraries.map((l) => ({ id: l.id })));
    if (method === 'GET' && (m = /^\/v1\/library\/([^/]+)$/.exec(url))) {
      const l = findById(S.libraries, decodeURIComponent(m[1])); if (!l) return NF;
      return J({ updateType: 'all', items: l.items.map((u) => findPres(u).id) });
    }
    if (method === 'GET' && (m = /^\/v1\/library\/([^/]+)\/([^/]+)(?:\/(\d+))?\/trigger$/.exec(url))) {
      const l = findById(S.libraries, decodeURIComponent(m[1])); const u = decodeURIComponent(m[2]);
      if (!l || !l.items.includes(u)) return NF;
      const i = Number(m[3] || 0); if (i >= countOf(u)) return NF;
      return write(() => showCue(u, i));
    }
    if (method === 'GET' && url === '/v1/playlists') return J(S.playlists.map((p) => ({ id: p.id, type: p.type })));
    if (method === 'GET' && url === '/v1/playlist/focused') {
      const pl = S.playlists.find((p) => p.id.uuid === S.playlistFocused.playlist);
      return J({ playlist: pl.id, item: { ...findPres(pl.items[S.playlistFocused.item]).id, index: S.playlistFocused.item } });
    }
    if (method === 'GET' && (m = /^\/v1\/playlist\/([^/]+)$/.exec(url)) && !['focused', 'active'].includes(m[1])) {
      const pl = findById(S.playlists, decodeURIComponent(m[1])); if (!pl) return NF;
      return J({ id: pl.id, items: pl.items.map((u, i) => ({ id: { ...findPres(u).id, index: i }, type: 'presentation' })) });
    }
    if (method === 'GET' && (m = /^\/v1\/playlist\/([^/]+)\/(\d+)\/trigger$/.exec(url))) {
      const pl = findById(S.playlists, decodeURIComponent(m[1])); if (!pl) return NF;
      const i = Number(m[2]); if (i >= pl.items.length) return NF;
      return write(() => { S.playlistFocused = { playlist: pl.id.uuid, item: i }; showCue(pl.items[i], 0); });
    }

    // ── looks
    if (method === 'GET' && url === '/v1/looks') return J(S.looks);
    if (url === '/v1/look/current') {
      if (method === 'GET') return J(findById(S.looks, S.currentLook));
      if (method === 'PUT') { let v; try { v = JSON.parse(body); } catch { return { code: 400 }; } const l = findById(S.looks, v?.id?.uuid); if (!l) return { code: 400 }; return write(() => { S.currentLook = l.id.uuid; }); }
    }
    if (method === 'GET' && (m = /^\/v1\/look\/([^/]+)\/trigger$/.exec(url))) {
      const l = findById(S.looks, decodeURIComponent(m[1])); if (!l) return NF;
      return write(() => { S.currentLook = l.id.uuid; });
    }

    // ── timers
    if (method === 'GET' && url === '/v1/timers') return J(S.timers.map(({ state: _s, time: _t, ...t }) => t));
    if (method === 'POST' && url === '/v1/timers') {
      let v; try { v = JSON.parse(body); } catch { return { code: 400 }; }
      if (!v || typeof v.name !== 'string' || !v.name) return { code: 400 };
      if (bm === 'http-500') return { code: 500 };
      const t = { id: id(`timer-${S.timers.length + 1}`, v.name, S.timers.length), allows_overrun: !!v.allows_overrun, ...(v.countdown ? { countdown: v.countdown } : {}), state: 'stopped', time: '00:00:00' };
      if (bm !== 'ignore-triggers') S.timers.push(t);
      const { state: _s, time: _t, ...pub } = t; return J(pub);
    }
    if (method === 'GET' && url === '/v1/timers/current') return J(S.timers.map((t) => ({ id: t.id, time: t.time, state: t.state })));
    if ((m = /^\/v1\/timer\/([^/]+)$/.exec(url)) && m[1] !== 'system_time' && m[1] !== 'video_countdown') {
      const t = findById(S.timers, decodeURIComponent(m[1])); if (!t) return NF;
      if (method === 'GET') { const { state: _s, time: _t, ...pub } = t; return J(pub); }
      if (method === 'PUT') {
        let v; try { v = JSON.parse(body); } catch { return { code: 400 }; }
        if (!v || typeof v.allows_overrun !== 'boolean') return { code: 400 };
        const r = write(() => { t.allows_overrun = v.allows_overrun; if (v.countdown) t.countdown = v.countdown; if (v.id?.name) t.id.name = v.id.name; });
        if (r.code !== 204) return r; const { state: _s, time: _t, ...pub } = t; return J(pub);
      }
    }
    if (method === 'GET' && (m = /^\/v1\/timer\/([^/]+)\/(start|stop|reset)$/.exec(url))) {
      const t = findById(S.timers, decodeURIComponent(m[1])); if (!t) return NF;
      return write(() => { if (m[2] === 'start') t.state = 'running'; else if (m[2] === 'stop') t.state = 'stopped'; else { t.state = 'stopped'; t.time = t.countdown ? fmt(t.countdown.duration) : '00:00:00'; } });
    }
    if (method === 'GET' && (m = /^\/v1\/timer\/([^/]+)\/increment\/(-?\d+)$/.exec(url))) {
      const t = findById(S.timers, decodeURIComponent(m[1])); if (!t) return NF;
      return write(() => { t.time = fmt(parse(t.time) + Number(m[2])); });
    }
    if (method === 'GET' && url === '/v1/timer/video_countdown') return J(S.transport.presentation ? fmt(Math.max(0, S.transport.presentation.duration - S.transport.presentation.time)) : '00:00:00');

    // ── messages
    if (method === 'GET' && url === '/v1/messages') return J(S.messages);
    if (method === 'POST' && (m = /^\/v1\/message\/([^/]+)\/trigger$/.exec(url))) {
      const msg = findById(S.messages, decodeURIComponent(m[1])); if (!msg) return NF;
      if (body) { try { if (!Array.isArray(JSON.parse(body))) return { code: 400 }; } catch { return { code: 400 }; } }
      return write(() => { msg.is_active = true; S.layers.messages = true; });
    }
    if (method === 'GET' && (m = /^\/v1\/message\/([^/]+)\/clear$/.exec(url))) {
      const msg = findById(S.messages, decodeURIComponent(m[1])); if (!msg) return NF;
      return write(() => { msg.is_active = false; S.layers.messages = S.messages.some((x) => x.is_active); });
    }

    // ── clear
    if (method === 'GET' && (m = /^\/v1\/clear\/layer\/([a-z_]+)$/.exec(url))) {
      if (!(m[1] in S.layers)) return NF;
      return write(() => {
        S.layers[m[1]] = false;
        if (m[1] === 'slide') { S.active = null; S.slideIndex = null; }
        if (m[1] === 'messages') S.messages.forEach((x) => { x.is_active = false; });
        if (m[1] === 'props') S.props.forEach((x) => { x.is_active = false; });
        if (m[1] === 'media' && S.transport.presentation) S.transport.presentation.is_playing = false;
      });
    }

    // ── props / macros / groups
    if (method === 'GET' && url === '/v1/props') return J(S.props);
    if (method === 'GET' && (m = /^\/v1\/prop\/([^/]+)\/(trigger|clear)$/.exec(url))) {
      const p = findById(S.props, decodeURIComponent(m[1])); if (!p) return NF;
      return write(() => { p.is_active = m[2] === 'trigger'; S.layers.props = S.props.some((x) => x.is_active); });
    }
    if (method === 'GET' && url === '/v1/macros') return J(S.macros);
    if (method === 'GET' && (m = /^\/v1\/macro\/([^/]+)\/trigger$/.exec(url))) {
      const mc = findById(S.macros, decodeURIComponent(m[1])); if (!mc) return NF;
      return write(() => { S.lastMacro = mc.id.uuid; });
    }
    if (method === 'GET' && url === '/v1/groups') return J(S.groups);

    // ── announcements
    if (method === 'GET' && url === '/v1/announcement/active') return J({ announcement: S.layers.announcements ? findPres('pres-announce') : null });
    if (method === 'GET' && url === '/v1/announcement/slide_index') return J({ announcement_index: S.layers.announcements ? { index: S.annIndex || 0, presentation_id: findPres('pres-announce').id } : null });
    if (method === 'GET' && (m = /^\/v1\/announcement\/active\/(next|previous)\/trigger$/.exec(url))) {
      return write(() => { S.layers.announcements = true; S.annIndex = Math.max(0, Math.min(4, (S.annIndex || 0) + (m[1] === 'next' ? 1 : -1))); });
    }

    // ── stage
    if (method === 'GET' && url === '/v1/stage/screens') return J(S.stageScreens);
    if (method === 'GET' && url === '/v1/stage/layouts') return J(S.stageLayouts);
    if (method === 'GET' && (m = /^\/v1\/stage\/screen\/([^/]+)\/layout$/.exec(url))) {
      const sc = findById(S.stageScreens, decodeURIComponent(m[1])); if (!sc) return NF;
      return J(findById(S.stageLayouts, S.stageLayoutMap[sc.uuid]).id);
    }
    if (method === 'GET' && (m = /^\/v1\/stage\/screen\/([^/]+)\/layout\/([^/]+)$/.exec(url))) {
      const sc = findById(S.stageScreens, decodeURIComponent(m[1])); const l = findById(S.stageLayouts, decodeURIComponent(m[2]));
      if (!sc || !l) return NF;
      return write(() => { S.stageLayoutMap[sc.uuid] = l.id.uuid; });
    }

    // ── transport / timeline / capture / video inputs
    if ((m = /^\/v1\/transport\/(presentation|announcement|audio)\/(play|pause|go_to_end|current|time|skip_forward\/\d+|skip_backward\/\d+)$/.exec(url))) {
      const t = S.transport[m[1]];
      if (m[2] === 'current' && method === 'GET') { if (!t) return NF; const { time: _t, ...pub } = t; return J(pub); }
      if (m[2] === 'time' && method === 'GET') return t ? J(t.time) : NF;
      if (m[2] === 'time' && method === 'PUT') { const v = Number(body); if (!t || !Number.isFinite(v)) return { code: 400 }; return write(() => { t.time = Math.max(0, Math.min(t.duration, v)); }); }
      if (method !== 'GET' || !t) return NF;
      return write(() => {
        if (m[2] === 'play') { t.is_playing = true; S.layers.media = true; } else if (m[2] === 'pause') t.is_playing = false;
        else if (m[2] === 'go_to_end') t.time = t.duration;
        else { const [op, s] = m[2].split('/'); t.time = Math.max(0, Math.min(t.duration, t.time + (op === 'skip_forward' ? 1 : -1) * Number(s))); }
      });
    }
    if (method === 'GET' && (m = /^\/v1\/presentation\/(active|focused)\/timeline\/(play|pause|rewind)$/.exec(url))) {
      if (m[1] === 'active' && !S.active) return NF;
      return write(() => { S.timeline = m[2]; });
    }
    if (method === 'GET' && url === '/v1/capture/status') return J(S.capture);
    if (method === 'GET' && (m = /^\/v1\/capture\/(start|stop)$/.exec(url))) return write(() => { S.capture.status = m[1] === 'start' ? 'active' : 'inactive'; });
    if (method === 'GET' && url === '/v1/video_inputs') return J(S.videoInputs);
    if (method === 'GET' && (m = /^\/v1\/video_inputs\/([^/]+)\/trigger$/.exec(url))) {
      const v = findById(S.videoInputs, decodeURIComponent(m[1])); if (!v) return NF;
      return write(() => { S.layers.video_input = true; });
    }

    // ── audio / media playlists
    for (const kind of ['audio', 'media']) {
      const lists = kind === 'audio' ? S.audioPlaylists : S.mediaPlaylists;
      if (method === 'GET' && url === `/v1/${kind}/playlists`) return J(lists.map((p) => ({ id: p.id, type: p.type })));
      const re = new RegExp(`^/v1/${kind}/playlist/([^/]+)/(focus|trigger|next/trigger|previous/trigger)$`);
      if (method === 'GET' && (m = re.exec(url))) {
        const key = decodeURIComponent(m[1]);
        const p = ['active', 'focused'].includes(key) ? lists[0] : findById(lists, key);
        if (!p) return NF;
        return write(() => { if (m[2] !== 'focus') S.layers[kind === 'audio' ? 'audio' : 'media'] = true; S[`${kind}Focused`] = p.id.uuid; });
      }
    }
    return NF;
  }

  const server = http.createServer(async (req, res) => {
    state.requests++;
    if (mode === 'hang') return;                  // accepted, never answered
    if (mode === 'offline') { req.socket.destroy(); return; }
    const [url, qs] = (req.url || '/').split('?');
    const body = await readBody(req);
    if (mode === 'not-pp') { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<h1>Not Found</h1>'); return; }
    const r = route(req.method, url, body, new URLSearchParams(qs || ''));
    if (r.code === 204) { res.writeHead(204); res.end(); return; }
    res.writeHead(r.code, { 'content-type': 'application/json' });
    res.end(r.json === undefined || r.json === null ? (r.code === 200 ? 'null' : '') : JSON.stringify(r.json));
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); if (mode === 'offline') s.destroy(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const actualPort = server.address().port;

  const api = {
    /** Switch break mode at runtime ('' | 'ignore-triggers' | 'http-500'). */
    setBreak: (b) => { bm = b || ''; },
    setMode: (m2) => { mode = m2; if (m2 === 'offline') for (const s of sockets) s.destroy(); },
    get mode() { return mode; },
    /** Operator clicks a cue in PP (not through the API). */
    operatorShow: (uuid, index) => showCue(uuid, index),
    operatorClear: () => { state.active = null; state.slideIndex = null; state.layers.slide = false; },
    operatorSetLook: (uuid) => { state.currentLook = uuid; },
    operatorTimer: (uuid, st, time) => { const t = state.timers.find((x) => x.id.uuid === uuid); t.state = st; if (time) t.time = time; },
    operatorAudience: (on) => { state.audienceScreens = !!on; },
    reset: () => { const f = initialState(); for (const k of Object.keys(state)) delete state[k]; Object.assign(state, f); },  // in place: the control server holds this reference
  };
  const control = await createControlServer({
    device: 'propresenter', port: controlPort, state, initialState: initial,
    actions: {
      setMode: ({ mode: m2 }) => api.setMode(m2),
      setBreak: ({ mode: b }) => api.setBreak(b),
      operatorShow: ({ uuid, index }) => api.operatorShow(uuid, index),
      operatorClear: () => api.operatorClear(),
    },
  });
  return {
    device: 'propresenter', port: actualPort, url: `http://127.0.0.1:${actualPort}`, get breakMode() { return bm; }, control,
    get state() { return state; }, ...api,
    stop: async () => { for (const s of sockets) s.destroy(); await new Promise((r) => server.close(() => r())); await control.stop(); },
  };
}

function fmt(sec) { const s = Math.max(0, Math.round(sec)); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
function parse(t) { const [h, m, s] = String(t).split(':').map(Number); return (h || 0) * 3600 + (m || 0) * 60 + (s || 0); }

module.exports = { start };

if (require.main === module) {
  start({ port: Number(process.env.PORT) || 1025, controlPort: Number(process.env.CONTROL_PORT) || 0 })
    .then((s) => console.log(`[mock-propresenter] http=${s.url}  control=${s.control.url}${s.breakMode ? '  break=' + s.breakMode : ''}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
