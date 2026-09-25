/**
 * ProPresenter 7 driver — spec conformance + truthfulness.
 *
 * 1. Every HTTP request the driver makes (all commands + status reads) must
 *    match a method+path in the official ProPresenter OpenAPI spec
 *    (https://openapi.propresenter.com/swagger.json, snapshot in
 *    test/fixtures/propresenter-openapi-paths.txt).
 * 2. Commands report success only when ProPresenter's own state confirms it;
 *    refusals (HTTP error), ignored commands and an unreachable PP all throw.
 *
 * Runs against the stateful mock in test/mocks/propresenterServer.js.
 */
'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
for (const k of ['log', 'info', 'warn']) console[k] = (...a) => process.stderr.write(a.join(' ') + '\n');

const { ProPresenter } = require(process.env.TALLY_PP_SRC || '../src/propresenter');
const ppMock = require('./mocks/propresenterServer');

const SPEC = fs.readFileSync(path.join(__dirname, 'fixtures', 'propresenter-openapi-paths.txt'), 'utf8')
  .split('\n').filter(Boolean).map((l) => {
    const [methods, p] = l.trim().split(/\s+/);
    return { methods: methods.split(','), re: new RegExp('^' + p.replace(/\{[^}]+\}/g, '[^/]+') + '$'), p };
  });
const inSpec = (method, p) => p === '/version' || SPEC.some((s) => s.methods.includes(method) && s.re.test(p));

let mock; let calls = []; const realFetch = global.fetch;
before(async () => {
  mock = await ppMock.start({ port: 0, controlPort: 0 });
  global.fetch = (url, opts = {}) => {
    const u = new URL(String(url));
    calls.push({ method: (opts.method || 'GET').toUpperCase(), path: u.pathname });
    return realFetch(url, opts);
  };
});
after(async () => { global.fetch = realFetch; await mock.stop(); });
beforeEach(() => { mock.reset(); mock.setMode('ok'); calls = []; });
const pp = () => new ProPresenter({ host: '127.0.0.1', port: mock.port });

test('every request the driver makes is a real ProPresenter API endpoint (method + path)', async () => {
  const p = pp();
  mock.operatorShow('pres-worship', 2);
  const ops = [
    () => p.isRunning(), () => p.getVersion(), () => p.getCurrentSlide(), () => p.nextSlide(), () => p.previousSlide(),
    () => p.goToSlide(5), () => p.getPlaylist(), () => p.getActiveLook(), () => p.getTimerStatus(), () => p.getVideoCountdown(),
    () => p.getAudienceScreenStatus(), () => p.getPlaylistFocused(), () => p.getLibraries(),
    () => p.getMessages(), () => p.triggerMessage('Parking'), () => p.toggleStageMessage('Parking'), () => p.clearMessages(),
    () => p.getLooks(), () => p.setLook('Stream Only'),
    () => p.getTimers(), () => p.startTimer('Sermon'), () => p.stopTimer('Sermon'), () => p.resetTimer('Sermon'),
    () => p.createTimer('Walk-in', { countdownDuration: 60 }), () => p.incrementTimer('Sermon', 30),
    () => p.setTimerValue('Sermon', { duration: 600 }),
    () => p.triggerPresentation('Sermon'), () => p.triggerPlaylistItem('Sunday Service', 2),
    () => p.triggerLibraryCue('lib-default', 'pres-welcome', 1),
    () => p.getProps(), () => p.triggerProp('Lower Third'), () => p.toggleProp('Lower Third'), () => p.clearProps(),
    () => p.getGroups(), () => p.triggerPresentation('Worship Set'), () => p.triggerGroup('Chorus'), () => p.getMacros(), () => p.triggerMacro('Walk In'),
    () => p.nextAnnouncement(), () => p.previousAnnouncement(), () => p.getAnnouncementStatus(), () => p.clearAnnouncements(),
    () => p.getStageLayouts(), () => p.setStageLayout('Lyrics Only', 1),
    () => p.setAudienceScreens(false), () => p.toggleAudienceScreens(), () => p.toggleStageScreens(),
    () => p.triggerVideoInput('Camera 1'),
    () => p.getAudioPlaylists(), () => p.activeAudioPlaylistTrigger('next'), () => p.focusedAudioPlaylistTrigger('previous'),
    () => p.audioPlaylistFocus('Walk-in Music'), () => p.audioPlaylistTrigger('Walk-in Music'),
    () => p.getMediaPlaylists(), () => p.activeMediaPlaylistTrigger('next'), () => p.focusedMediaPlaylistTrigger('next'),
    () => p.mediaPlaylistFocus('Bumpers'), () => p.mediaPlaylistTrigger('Bumpers'),
    () => p.transportPlay(), () => p.transportPause(), () => p.transportSkipForward('presentation', 5),
    () => p.transportSkipBackward('presentation', 5), () => p.transportGoToTime('presentation', 30), () => p.transportGoToEnd(),
    () => p.timelinePlay(), () => p.timelinePause(), () => p.timelineRewind(),
    () => p.captureStart(), () => p.captureStop(), () => p.clearMedia(), () => p.clearAudio(), () => p.clearSlide(), () => p.clearAll(),
  ];
  const errors = [];
  for (const [i, op] of ops.entries()) { try { await op(); } catch (e) { errors.push(`op#${i}: ${e.message}`); } }
  const bad = [...new Set(calls.filter((c) => !inSpec(c.method, c.path)).map((c) => `${c.method} ${c.path}`))];
  assert.deepEqual(bad, [], `requests not in the ProPresenter API spec:\n  ${bad.join('\n  ')}`);
  assert.ok(calls.length > 100, `expected the ops to hit the API (got ${calls.length} requests)`);
  // Every op above is valid for the mock's show: all must be accepted and confirmed.
  assert.deepEqual(errors, [], `ops that failed against a healthy ProPresenter:\n  ${errors.join('\n  ')}`);
});

test('isRunning: only a real ProPresenter /version counts; a 404 web server or nothing does not', async () => {
  const p = pp();
  assert.equal(await p.isRunning(), true);
  mock.setMode('not-pp');
  assert.equal(await p.isRunning(), false);
  mock.setMode('offline');
  assert.equal(await p.isRunning(), false);
});

test('slides: next/previous/goToSlide resolve with the read-back position; bad index refused locally', async () => {
  const p = pp();
  mock.operatorShow('pres-sermon', 2);
  assert.equal((await p.nextSlide()).index, 3);
  assert.equal((await p.previousSlide()).index, 2);
  assert.equal((await p.goToSlide(6)).index, 6);
  assert.equal(mock.state.slideIndex, 6);
  await assert.rejects(p.goToSlide(-1), /Invalid slide/);
  await assert.rejects(p.goToSlide(99), /refused/);            // PP 404s a cue past the end
});

test('group not in the focused presentation → PP 404 → refused (not "triggered")', async () => {
  const p = pp();
  mock.operatorShow('pres-sermon', 0);                          // Sermon has no "Chorus"
  await assert.rejects(p.triggerGroup('Chorus'), /refused group "Chorus" \(not found in ProPresenter\)/);
  await assert.rejects(p.triggerGroup('Nope'), /Group "Nope" not found.*Available: Chorus, Bridge/);
});

test('next on the last slide is reported as not moving (no false "Next slide")', async () => {
  const p = pp();
  mock.operatorShow('pres-welcome', 2);                         // last of 3
  await assert.rejects(p.nextSlide(), /did not change.*slide 3 of "Welcome"/);
});

test('refusal: PP answering HTTP 500 → command throws "refused"', async () => {
  const m = await ppMock.start({ port: 0, controlPort: 0, breakMode: 'http-500' });
  try {
    const p = new ProPresenter({ host: '127.0.0.1', port: m.port });
    m.operatorShow('pres-sermon', 1);
    await assert.rejects(p.nextSlide(), /refused next slide \(HTTP 500\)/);
    await assert.rejects(p.setLook('Stream Only'), /refused/);
    await assert.rejects(p.setAudienceScreens(false), /refused/);
  } finally { await m.stop(); }
});

test('ignored: PP accepts but nothing changes → command throws "accepted … but"', async () => {
  const m = await ppMock.start({ port: 0, controlPort: 0, breakMode: 'ignore-triggers' });
  try {
    const p = new ProPresenter({ host: '127.0.0.1', port: m.port });
    m.operatorShow('pres-worship', 1);
    await assert.rejects(p.goToSlide(4), /accepted slide 5 but reports slide 2/);
    await assert.rejects(p.setLook('Stream Only'), /accepted look "Stream Only" but reports "Default"/);
    await assert.rejects(p.startTimer('Sermon'), /accepted start for timer "Sermon" but reports it Stopped/);
    await assert.rejects(p.triggerGroup('Chorus'), /accepted group "Chorus" but/);
    await assert.rejects(p.captureStart(), /accepted capture start but reports inactive/);
  } finally { await m.stop(); }
});

test('offline: every command throws "not reachable"; status reads return null/empty, never stale', async () => {
  const p = pp();
  mock.operatorShow('pres-sermon', 1);
  p.connected = true;
  await p.getCurrentSlide();
  assert.equal(p.toStatus().currentSlide, 'Sermon');
  p.connected = false;                                          // poll declared it offline
  const s0 = p.toStatus();
  assert.equal(s0.currentSlide, null, 'no stale presentation while disconnected');
  assert.equal(s0.slideIndex, null);
  assert.equal(s0.screens, null);
  mock.setMode('offline');
  await assert.rejects(p.nextSlide(), /not reachable/);
  await assert.rejects(p.setAudienceScreens(true), /not reachable/);
  assert.equal(await p.getAudienceScreenStatus(), null);
  assert.deepEqual(await p.getLooks(), []);
  p.connected = false;
  assert.equal(await p.getCurrentSlide(), null);
  const st = p.toStatus();
  assert.equal(st.connected, false);
  assert.equal(st.currentSlide ?? null, null);
});

test('timer states from PP are lowercase ("running", "overrunning") and are understood', async () => {
  const p = pp();
  mock.operatorTimer('timer-sermon', 'running', '00:29:59');
  let t = (await p.getTimerStatus()).find((x) => x.id === 'timer-sermon');
  assert.equal(t.state, 'Running');
  mock.operatorTimer('timer-sermon', 'overrunning', '00:00:05');
  t = (await p.getTimerStatus()).find((x) => x.id === 'timer-sermon');
  assert.equal(t.state, 'Overrun');
});

test('audience/stage status comes from the boolean status endpoints', async () => {
  const p = pp();
  mock.operatorAudience(false);
  assert.deepEqual(await p.getAudienceScreenStatus(), { audience: false, stage: true });
  assert.equal(await p.setAudienceScreens(true), 'Audience screens ON');
  assert.equal(mock.state.audienceScreens, true);
});

test('backup mirror: primary success still reported, backup failure recorded (not swallowed)', async () => {
  const b = await ppMock.start({ port: 0, controlPort: 0 });
  try {
    const p = new ProPresenter({ host: '127.0.0.1', port: mock.port, backupHost: '127.0.0.1', backupPort: b.port });
    mock.operatorShow('pres-sermon', 1); b.operatorShow('pres-sermon', 1);
    await p.nextSlide();
    assert.deepEqual(p.lastMirror, { ok: true });
    assert.equal(b.state.slideIndex, 2, 'backup followed');
    b.setMode('offline');
    await p.nextSlide();
    assert.equal(mock.state.slideIndex, 3);
    assert.equal(p.lastMirror.ok, false);
    assert.match(p.lastMirror.error, /backup.*not reachable/);
  } finally { await b.stop(); }
});
