/**
 * SIM PASS — OBS. Real church-client agent process ↔ protocol-faithful OBS mock.
 * connect · live state · control action · auth failure · device drop · recover.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const obsMock = require('../mocks/obsServer');
const { startAgent, freePort } = require('../helpers/agentHarness');

const ctl = (mock, action, args = {}) => fetch(`${mock.control.url}/action`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, args }),
}).then((r) => r.json());

test('OBS: connects with password, reports version + live stream state, runs a control action', { timeout: 60000 }, async (t) => {
  const mock = await obsMock.start({ port: 0, password: 'booth-pw' });
  const agent = await startAgent({ obsUrl: mock.url, obsPassword: 'booth-pw' });
  t.after(async () => { await agent.stop(); await mock.stop(); });

  const c = await agent.waitFor((s) => s.obs.connected === true && s.obs.websocketVersion === '5.4.0', 15000, 'obs connected + version');
  // The "connected" change must be pushed to the relay promptly, not only on
  // the next 3 s periodic tick (regression: debounce dropped the update).
  const firstConnected = agent.frames.find((f) => f.status.obs?.connected === true);
  const pushLag = firstConnected.t - mock.state.lastIdentifiedAt;
  assert.ok(pushLag < 1000, `connected pushed ${pushLag}ms after OBS accepted identify (want < 1000ms)`);
  assert.equal(c.status.obs.version, '30.0.0');
  assert.equal(c.status.obs.configured, true);

  await ctl(mock, 'setStreaming', { active: true });
  const live = await agent.waitFor((s) => s.obs.streaming === true, 5000, 'streaming via event');
  assert.ok(live.ms < 5000);

  const r = await agent.command('obs.setScene', { scene: 'Scene 3' });
  assert.ok(!r.error, `setScene error: ${r.error}`);
  assert.equal(mock.state.programScene, 'Scene 3');

  const bad = await agent.command('obs.setScene', { scene: 'No Such Scene' });
  assert.ok(bad.error, 'unknown scene must surface an error, not a fake success');
  assert.equal(mock.state.programScene, 'Scene 3');
});

test('OBS: wrong password never reports connected, and says why', { timeout: 60000 }, async (t) => {
  const mock = await obsMock.start({ port: 0, password: 'right' });
  const agent = await startAgent({ obsUrl: mock.url, obsPassword: 'wrong' });
  t.after(async () => { await agent.stop(); await mock.stop(); });

  // Wait until the agent has tried (and failed) auth at least twice.
  const t0 = Date.now();
  while (mock.state.authFailures < 2 && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 200));
  assert.ok(mock.state.authFailures >= 1, 'agent attempted auth');
  await new Promise((r) => setTimeout(r, 500));
  const lied = agent.frames.filter((f) => f.status.obs?.connected === true);
  assert.equal(lied.length, 0, `status claimed OBS connected ${lied.length}x during failed auth`);
  const s = agent.latest();
  assert.equal(s.obs.connected, false);
  assert.match(String(s.obs.error || ''), /auth|password/i, 'status must explain the auth failure');
});

test('OBS: crash → honest disconnect ≤ 2 s; restart on same port → recovers ≤ 12 s', { timeout: 90000 }, async (t) => {
  const port = await freePort();
  let mock = await obsMock.start({ port });
  const agent = await startAgent({ obsUrl: `ws://127.0.0.1:${port}` });
  t.after(async () => { await agent.stop(); await mock.stop().catch(() => {}); });

  await agent.waitFor((s) => s.obs.connected === true, 15000, 'initial connect');
  await mock.stop(); // process gone (sockets terminated, listener closed)
  const d = await agent.waitFor((s) => s.obs.connected === false, 5000, 'disconnect');
  assert.ok(d.ms <= 2000, `disconnect took ${d.ms}ms`);

  await new Promise((r) => setTimeout(r, 3000));
  mock = await obsMock.start({ port });
  const up = await agent.waitFor((s) => s.obs.connected === true, 30000, 'recover');
  assert.ok(up.ms <= 12000, `recovery took ${up.ms}ms`);
  assert.equal(agent.latest().obs.error || null, null, 'error cleared after recovery');
});

test('OBS: operator quits OBS (ExitStarted + close 1001) → disconnect, no stale streaming flag', { timeout: 60000 }, async (t) => {
  const mock = await obsMock.start({ port: 0 });
  const agent = await startAgent({ obsUrl: mock.url });
  t.after(async () => { await agent.stop(); await mock.stop(); });
  await agent.waitFor((s) => s.obs.connected === true, 15000, 'connect');
  await ctl(mock, 'setStreaming', { active: true });
  await agent.waitFor((s) => s.obs.streaming === true, 5000, 'streaming');
  await ctl(mock, 'quit');
  const d = await agent.waitFor((s) => s.obs.connected === false, 5000, 'disconnect after quit');
  assert.equal(d.status.obs.streaming, false, 'must not keep claiming "streaming" once OBS is gone');
});

test('OBS started AFTER Tally → agent keeps retrying and connects', { timeout: 60000 }, async (t) => {
  const port = await freePort();
  const agent = await startAgent({ obsUrl: `ws://127.0.0.1:${port}` });
  let mock = null;
  t.after(async () => { await agent.stop(); if (mock) await mock.stop(); });
  await agent.waitFor((s) => s.obs && s.obs.connected === false, 15000, 'agent up, obs down');
  await new Promise((r) => setTimeout(r, 2000));
  mock = await obsMock.start({ port });
  await agent.waitFor((s) => s.obs.connected === true, 25000, 'late OBS connect');
});

test('OBS already LIVE + RECORDING before Tally connects → reported on connect, not 15 s later / never', { timeout: 60000 }, async (t) => {
  const mock = await obsMock.start({ port: 0 });
  await ctl(mock, 'setStreaming', { active: true });
  await ctl(mock, 'setRecording', { active: true });
  const agent = await startAgent({ obsUrl: mock.url });
  t.after(async () => { await agent.stop(); await mock.stop(); });
  await agent.waitFor((s) => s.obs.connected === true, 15000, 'connect');
  const t0 = Date.now();
  const s = await agent.waitFor((st) => st.obs.streaming === true && st.obs.recording === true, 4000, 'live+rec on connect');
  assert.ok(Date.now() - t0 < 4000);
  assert.equal(s.status.obs.connected, true);
});

test('OBS without password configured, OBS requires one → honest "needs password" and never connected', { timeout: 60000 }, async (t) => {
  const mock = await obsMock.start({ port: 0, password: 'secret' });
  const agent = await startAgent({ obsUrl: mock.url });
  t.after(async () => { await agent.stop(); await mock.stop(); });
  await agent.waitFor((s) => /password/i.test(String(s.obs.error || '')), 15000, 'needs-password reason');
  assert.equal(agent.frames.filter((f) => f.status.obs?.connected === true).length, 0);
});

test('OBS scenes: list + current program scene reach status (booth scene switcher), follow operator changes in OBS', { timeout: 60000 }, async (t) => {
  const mock = await obsMock.start({ port: 0 });
  const agent = await startAgent({ obsUrl: mock.url });
  t.after(async () => { await agent.stop(); await mock.stop(); });
  const c = await agent.waitFor((s) => s.obs.connected === true && Array.isArray(s.obs.scenes) && s.obs.scenes.length === 3, 15000, 'scene list');
  assert.deepEqual(c.status.obs.scenes, ['Scene 1', 'Scene 2', 'Scene 3'], 'top-down order like the OBS UI');
  assert.equal(c.status.obs.currentScene, 'Scene 1');
  // Operator switches scene in OBS itself → event → status
  await ctl(mock, 'setProgramScene', { scene: 'Scene 2' });
  await agent.waitFor((s) => s.obs.currentScene === 'Scene 2', 3000, 'follow operator scene change');
  // Tally command → OBS state → event → status
  const r = await agent.command('obs.setScene', { scene: 'Scene 3' });
  assert.ok(!r.error, r.error);
  await agent.waitFor((s) => s.obs.currentScene === 'Scene 3', 3000, 'follow Tally scene change');
  // Unplug → current scene unknown
  await ctl(mock, 'crash');
  const d = await agent.waitFor((s) => s.obs.connected === false, 3000, 'drop');
  assert.equal(d.status.obs.currentScene, null);
});

// ── Product config shape: exactly what the Equipment UI saves for "OBS Studio"
// (encoder.type='obs' → EncoderBridge shares the agent's OBS socket and owns
// status.encoder, which the booth UI ORs with status.obs).
function productObsConfig(port, password = '') {
  return {
    obsUrl: `ws://127.0.0.1:${port}`,
    ...(password ? { obsPassword: password } : {}),
    encoder: { type: 'obs', host: '127.0.0.1', port, password: password || undefined, label: '', statusUrl: '', source: '' },
  };
}

test('OBS (Equipment-UI config): drop → BOTH obs and encoder report disconnected ≤ 2 s (no fake "connected")', { timeout: 90000 }, async (t) => {
  const port = await freePort();
  let mock = await obsMock.start({ port, password: 'pw' });
  const agent = await startAgent(productObsConfig(port, 'pw'));
  t.after(async () => { await agent.stop(); await mock.stop().catch(() => {}); });
  await agent.waitFor((s) => s.obs.connected === true && s.encoder?.connected === true, 20000, 'obs+encoder connected');
  await ctl(mock, 'setStreaming', { active: true });
  await agent.waitFor((s) => s.obs.streaming === true && s.encoder.live === true, 6000, 'encoder.live follows OBS');
  await mock.stop();
  const d = await agent.waitFor((s) => s.obs.connected === false && s.encoder.connected === false, 5000, 'both disconnected');
  assert.ok(d.ms <= 2000, `took ${d.ms}ms`);
  assert.equal(d.status.encoder.live, false, 'no stale LIVE after OBS is gone');
  // and it stays honest (no later poll resurrects it)
  await new Promise((r) => setTimeout(r, 4000));
  assert.equal(agent.latest().encoder.connected, false);
  mock = await obsMock.start({ port, password: 'pw' });
  await agent.waitFor((s) => s.obs.connected === true && s.encoder.connected === true, 15000, 'both recover');
});

test('OBS (Equipment-UI config) started AFTER Tally: encoder connects and LIVE follows OBS streaming', { timeout: 90000 }, async (t) => {
  const port = await freePort();
  const agent = await startAgent(productObsConfig(port));
  let mock = null;
  t.after(async () => { await agent.stop(); if (mock) await mock.stop(); });
  await agent.waitFor((s) => s.obs && s.obs.connected === false, 15000, 'agent up, OBS down');
  mock = await obsMock.start({ port });
  await agent.waitFor((s) => s.obs.connected === true && s.encoder?.connected === true, 25000, 'encoder connected after late OBS');
  await ctl(mock, 'setStreaming', { active: true });
  await agent.waitFor((s) => s.encoder.live === true, 6000, 'encoder.live true while OBS streams');
});

test('OBS down 45 s (operator restarting a crashed OBS) → Tally reconnects ≤ 11 s after OBS is back (backoff capped for LAN)', { timeout: 120000 }, async (t) => {
  const port = await freePort();
  let mock = await obsMock.start({ port });
  const agent = await startAgent({ obsUrl: `ws://127.0.0.1:${port}` });
  t.after(async () => { await agent.stop(); await mock.stop().catch(() => {}); });
  await agent.waitFor((s) => s.obs.connected === true, 15000, 'connect');
  await mock.stop();
  await agent.waitFor((s) => s.obs.connected === false, 5000, 'drop');
  await new Promise((r) => setTimeout(r, 45000));
  mock = await obsMock.start({ port });
  const up = await agent.waitFor((s) => s.obs.connected === true, 70000, 'reconnect after long outage');
  assert.ok(up.ms <= 11000, `reconnected ${up.ms}ms after OBS came back (want ≤ 11000)`);
});
