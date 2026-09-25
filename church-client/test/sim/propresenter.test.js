/**
 * SIM PASS — ProPresenter 7 / 21.x over the official /v1 REST API.
 * Stateful PP mock built from Renewed Vision's OpenAPI spec: GET triggers → 204,
 * unknown ids / wrong paths → 404, state really changes and can be read back,
 * "offline" resets connections, "hang" never answers, "not-pp" is another web
 * server on the port. Direct driver → real agent → REAL relay.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const ppMock = require('../mocks/propresenterServer');
const { startAgent } = require('../helpers/agentHarness');
const { startRelayLoop, relayAvailable } = require('../helpers/relayLoop');

const SRC = process.env.TALLY_PP_SRC || path.join(__dirname, '..', '..', 'src');
const { ProPresenter } = require(path.join(SRC, 'propresenter.js'));
const commands = require(path.join(SRC, 'commands', 'propresenter.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const k of ['log', 'info', 'warn']) console[k] = (...a) => process.stderr.write(a.join(' ') + '\n');

const mocks = [];
async function mk(opts = {}) { const m = await ppMock.start({ port: 0, ...opts }); mocks.push(m); return m; }
const pps = [];
function mkPP(mock, extra = {}) { const p = new ProPresenter({ host: '127.0.0.1', port: mock.port, ...extra }); pps.push(p); return p; }
test.afterEach(() => { while (pps.length) { try { pps.pop().disconnect(); } catch { /* */ } } });
test.after(async () => { for (const m of mocks) { try { await m.stop(); } catch { /* */ } } });

test('running = ProPresenter answered /version — not "any HTTP answer"; offline/hang/other web server are not running', { timeout: 30000 }, async () => {
  const m = await mk();
  const pp = mkPP(m);
  assert.equal(await pp.isRunning(), true);
  assert.match(await pp.getVersion(), /ProPresenter 7/);
  m.setMode('not-pp');
  assert.equal(await pp.isRunning(), false, 'a 404 page on port 1025 is not ProPresenter');
  m.setMode('offline');
  assert.equal(await pp.isRunning(), false);
  m.setMode('hang');
  assert.equal(await pp.isRunning(), false);
  m.setMode('ok');
  assert.equal(await pp.isRunning(), true);
});

test('next / previous / go-to are confirmed by reading slide_index back; end of presentation and bad cue are errors', { timeout: 20000 }, async () => {
  const m = await mk();
  const pp = mkPP(m);
  m.operatorShow('pres-worship', 3);
  const n = await pp.nextSlide();
  assert.equal(n.index, 4);
  assert.equal(m.state.slideIndex, 4);
  const p = await pp.previousSlide();
  assert.equal(p.index, 3);
  const g = await pp.goToSlide(11);
  assert.equal(g.index, 11);
  await assert.rejects(pp.nextSlide(), /did not change.*end of presentation/i);
  await assert.rejects(pp.goToSlide(40), /refused.*slide 41.*not found/i);
  await assert.rejects(pp.goToSlide(-1), /invalid slide/i);
  assert.equal(m.state.slideIndex, 11);
});

test('ProPresenter that answers 204 but does nothing (ignore-triggers) → every verified command FAILS', { timeout: 30000 }, async () => {
  const m = await mk({ breakMode: 'ignore-triggers' });
  m.operatorShow('pres-worship', 0);
  const pp = mkPP(m);
  await assert.rejects(pp.nextSlide(), /did not change/i);
  await assert.rejects(pp.goToSlide(5), /reports slide 1/i);
  await assert.rejects(pp.setLook('Stream Only'), /reports "Default"/i);
  await assert.rejects(pp.startTimer('Service Countdown'), /reports it Stopped/i);
  await assert.rejects(pp.clearSlide(), /still shows: slide/i);
  await assert.rejects(pp.setAudienceScreens(false), /reports on/i);
  await assert.rejects(pp.triggerMessage('Parking'), /does not report it as showing/i);
  await assert.rejects(pp.triggerPresentation('Sermon'), /not on screen/i);
  await assert.rejects(pp.triggerProp('Lower Third'), /not showing/i);
  await assert.rejects(pp.captureStart(), /reports inactive/i);
});

test('ProPresenter errors (HTTP 500) are refusals, not "done"', { timeout: 15000 }, async () => {
  const m = await mk({ breakMode: 'http-500' });
  m.operatorShow('pres-worship', 0);
  const pp = mkPP(m);
  await assert.rejects(pp.nextSlide(), /refused next slide \(HTTP 500\)/i);
  await assert.rejects(pp.setLook('Stream Only'), /refused look "Stream Only" \(HTTP 500\)/i);
  await assert.rejects(pp.triggerMacro('Walk In'), /refused macro "Walk In" \(HTTP 500\)/i);
});

test('looks, timers, messages, props: the spec paths; state read back; unknown names are errors', { timeout: 20000 }, async () => {
  const m = await mk();
  const pp = mkPP(m);
  assert.equal(await pp.setLook('stream only'), 'Stream Only');
  assert.equal(m.state.currentLook, 'look-stream');
  assert.deepEqual(await pp.getActiveLook(), { id: 'look-stream', name: 'Stream Only' });
  await assert.rejects(pp.setLook('Nope'), /Look "Nope" not found.*Available: Default, Stream Only/);
  await pp.startTimer('Service Countdown');
  const ts = await pp.getTimerStatus();
  assert.equal(ts.find((t) => t.name === 'Service Countdown').state, 'Running', 'PP reports lowercase "running"');
  await pp.stopTimer('Service Countdown');
  await assert.rejects(pp.startTimer('Nope'), /Timer "Nope" not found/);
  assert.equal(await pp.triggerMessage('parking', [{ name: 'plate', text: { text: 'ABC' } }]), 'Parking');
  assert.equal(m.state.messages[0].is_active, true);
  assert.equal(await pp.toggleStageMessage('Parking'), 'Message "Parking" hidden');
  assert.equal(m.state.messages[0].is_active, false);
  assert.equal(await pp.triggerProp('Lower Third'), 'Lower Third');
  assert.equal(m.state.props[0].is_active, true);
  await pp.toggleProp('Lower Third');
  assert.equal(m.state.props[0].is_active, false);
  assert.equal(await pp.createTimer('Offering', { countdownDuration: 120 }), 'Offering');
  assert.ok(m.state.timers.some((t) => t.id.name === 'Offering'));
  await pp.incrementTimer('Sermon', 60);
  assert.equal(m.state.timers.find((t) => t.id.name === 'Sermon').time, '00:31:00');
  await pp.setTimerValue('Sermon', { duration: 1200 });
  assert.equal(m.state.timers.find((t) => t.id.name === 'Sermon').countdown.duration, 1200);
});

test('clear layers are confirmed through /v1/status/layers; screens are real booleans read back', { timeout: 20000 }, async () => {
  const m = await mk();
  const pp = mkPP(m);
  m.operatorShow('pres-sermon', 2);
  await pp.triggerMessage('Parking');
  await pp.triggerProp('Logo Bug');
  await pp.clearAll();
  assert.deepEqual([m.state.layers.slide, m.state.layers.messages, m.state.layers.props], [false, false, false]);
  assert.equal(m.state.active, null);
  assert.equal(await pp.setAudienceScreens(false), 'Audience screens OFF');
  assert.equal(m.state.audienceScreens, false);
  assert.deepEqual(await pp.getAudienceScreenStatus(), { audience: false, stage: true });
  assert.equal(await pp.toggleAudienceScreens(), 'Audience screens ON');
  assert.equal(await pp.toggleStageScreens(), 'Stage screens OFF');
  assert.equal(m.state.stageScreensOn, false);
});

test('presentations, playlists, groups, stage layouts, video input, transport, capture — spec paths + read-back', { timeout: 30000 }, async () => {
  const m = await mk();
  const pp = mkPP(m);
  assert.equal(await pp.triggerPresentation('sermon'), 'Sermon');
  assert.equal(m.state.active, 'pres-sermon');
  await assert.rejects(pp.triggerPresentation('Christmas'), /not found in any ProPresenter library/);
  assert.equal(await pp.triggerPlaylistItem('Sunday Service', 2), 'Sunday Service');
  assert.deepEqual(m.state.playlistFocused, { playlist: 'pl-sunday', item: 2 });
  await assert.rejects(pp.triggerPlaylistItem('Sunday Service', 9), /refused playlist "Sunday Service" item 9/);
  m.operatorShow('pres-worship', 0);
  assert.equal(await pp.triggerGroup('Chorus'), 'Chorus');
  assert.equal(m.state.slideIndex, 4, 'Chorus starts at cue 5 of Worship Set');
  await assert.rejects(pp.triggerGroup('Bridge'), /refused group "Bridge"/, 'Worship Set has no Bridge');
  assert.equal(await pp.setStageLayout('Lyrics Only', 1), 'Lyrics Only');
  assert.equal(m.state.stageLayoutMap['ss-right'], 'sl-lyrics');
  await assert.rejects(pp.setStageLayout('Lyrics Only', 5), /Stage screen 5 not found/);
  await pp.triggerVideoInput('Camera 1');
  assert.equal(m.state.layers.video_input, true);
  await pp.transportPlay('presentation');
  assert.equal(m.state.transport.presentation.is_playing, true);
  await pp.transportGoToTime('presentation', 30);
  assert.equal(m.state.transport.presentation.time, 30);
  await pp.transportPause();
  assert.equal(m.state.transport.presentation.is_playing, false);
  await assert.rejects(pp.transportPlay('audio'), /nothing loaded|refused/i, 'no audio loaded → not "playing"');
  await assert.rejects(pp.transportPlay('video'), /Invalid transport layer/);
  await pp.captureStart();
  assert.equal(m.state.capture.status, 'active');
  await pp.captureStop();
  await pp.audioPlaylistTrigger('Walk-in Music');
  assert.equal(m.state.layers.audio, true);
  await pp.activeMediaPlaylistTrigger('next');
  await assert.rejects(pp.activeMediaPlaylistTrigger('sideways'), /Invalid action/);
});

test('status never shows stale slide data: cleared → nothing on screen; offline → null; poll sees offline and hang', { timeout: 40000 }, async () => {
  const m = await mk();
  const pp = mkPP(m);
  m.operatorShow('pres-sermon', 5);
  await pp.connect();
  const s = await pp.getCurrentSlide();
  assert.deepEqual([s.presentationName, s.slideIndex, s.slideTotal], ['Sermon', 5, 8]);
  m.operatorClear();
  const c = await pp.getCurrentSlide();
  assert.equal(c.onScreen, false);
  assert.equal(c.slideIndex, null);
  let t0 = Date.now();
  m.setMode('offline');
  while (pp.connected && Date.now() - t0 < 10000) await sleep(100);
  assert.equal(pp.connected, false, 'poll noticed PP went away');
  assert.ok(Date.now() - t0 <= 7000, `offline noticed after ${Date.now() - t0}ms`);
  assert.equal(await pp.getCurrentSlide(), null);
  assert.equal(pp.toStatus().currentSlide, null);
  assert.equal(pp.toStatus().slideIndex, null);
  m.setMode('ok');
  pp.disconnect();
  await pp.connect();
  assert.equal(pp.connected, true);
  t0 = Date.now();
  m.setMode('hang');
  while (pp.connected && Date.now() - t0 < 12000) await sleep(100);
  assert.equal(pp.connected, false, 'poll noticed PP hung');
  assert.ok(Date.now() - t0 <= 9000, `hang noticed after ${Date.now() - t0}ms`);
  m.setMode('not-pp');
  pp.disconnect();
  await pp.connect();
  assert.equal(pp.connected, false, 'another web server on the port never counts as connected');
});

test('backup PP: mirror is awaited; a backup that does not follow is reported in the command result', { timeout: 20000 }, async () => {
  const main = await mk();
  const backup = await mk();
  main.operatorShow('pres-worship', 1);
  backup.operatorShow('pres-worship', 1);
  const pp = mkPP(main, { backupHost: '127.0.0.1', backupPort: backup.port });
  const agent = { proPresenter: pp };
  const r1 = await commands['propresenter.next'](agent, {});
  assert.match(r1, /^Next slide — now slide 3 of "Worship Set"$/);
  assert.equal(backup.state.slideIndex, 2, 'backup followed');
  backup.setMode('offline');
  const r2 = await commands['propresenter.next'](agent, {});
  assert.match(r2, /now slide 4[\s\S]*Backup ProPresenter did not follow: ProPresenter \(backup\) is not reachable/);
  assert.equal(main.state.slideIndex, 3);
  const r3 = await commands['propresenter.goToSlide'](agent, { index: 0 }).catch((e) => e.message);
  assert.match(r3, /Invalid slide/);
});

// ── Real agent ────────────────────────────────────────────────────────────────
test('agent: operator changes slide → status within 4 s; PP quits → offline and slide info cleared ≤ 8 s', { timeout: 60000 }, async (t) => {
  const m = await mk();
  m.operatorShow('pres-welcome', 0);
  const agent = await startAgent({ proPresenter: { host: '127.0.0.1', port: m.port } });
  t.after(() => agent.stop());
  await agent.waitFor((st) => st.proPresenter?.connected === true && st.proPresenter?.currentSlide === 'Welcome', 20000, 'pp connected');
  const t0 = Date.now();
  m.operatorShow('pres-sermon', 4);
  await agent.waitFor((st) => st.proPresenter?.currentSlide === 'Sermon' && st.proPresenter?.slideIndex === 4 && st.proPresenter?.slideTotal === 8, 8000, 'slide visible');
  assert.ok(Date.now() - t0 <= 4000, `slide seen after ${Date.now() - t0}ms`);
  const t1 = Date.now();
  m.setMode('offline');
  await agent.waitFor((st) => st.proPresenter?.connected === false && !st.proPresenter?.currentSlide, 12000, 'pp offline + cleared');
  assert.ok(Date.now() - t1 <= 8000, `offline after ${Date.now() - t1}ms`);
});

// ── Remote engineer via the REAL relay ───────────────────────────────────────
const skipRelay = relayAvailable() ? false : 'relay-server deps not installed';

test('remote: engineer drives ProPresenter through the relay; confirmed results, refusals and offline are truthful', { timeout: 90000, skip: skipRelay }, async (t) => {
  const m = await mk();
  m.operatorShow('pres-worship', 0);
  const loop = await startRelayLoop({ proPresenter: { host: '127.0.0.1', port: m.port } });
  t.after(() => loop.stop());
  await loop.waitForRelay((st, conn) => conn && st.proPresenter?.connected === true, 20000, 'relay sees PP');
  const r1 = await loop.controllerCommand('propresenter.next', {});
  assert.equal(r1.error, null, JSON.stringify(r1));
  assert.match(String(r1.result), /now slide 2/);
  assert.equal(m.state.slideIndex, 1);
  const r2 = await loop.controllerCommand('propresenter.goToSlide', { index: 99 });
  assert.ok(r2.error, `slide 99 must fail: ${JSON.stringify(r2)}`);
  const r3 = await loop.controllerCommand('propresenter.setLook', { name: 'Nope' });
  assert.match(String(r3.error), /not found/);
  const r4 = await loop.controllerCommand('propresenter.setLook', { name: 'Stream Only' });
  assert.equal(r4.error, null, JSON.stringify(r4));
  assert.equal(m.state.currentLook, 'look-stream');
  const h = await loop.httpCommand('propresenter.clearSlide', {}, { wait: true });
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.equal(m.state.layers.slide, false);
  m.setMode('offline');
  await loop.waitForRelay((st) => st.proPresenter?.connected === false, 12000, 'relay sees PP offline');
  const r5 = await loop.controllerCommand('propresenter.next', {});
  assert.match(String(r5.error), /not reachable/);
  m.setMode('ok');
  await loop.waitForRelay((st) => st.proPresenter?.connected === true, 30000, 'relay sees PP back');
});
