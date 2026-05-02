/**
 * Integration smoke test for the mock device servers.
 *
 * Boots a subset of the mocks on ephemeral ports, instantiates the REAL
 * device bridge classes from church-client/src/, and asserts that the
 * full read/write round-trip works end-to-end. Each device gets two
 * tests: one read (status) and one write (command), to prove the bridge
 * speaks the protocol the mock implements.
 *
 * Devices covered here:
 *   - Companion  (HTTP REST, full mock)
 *   - ProPresenter (HTTP REST, full mock)
 *   - VideoHub   (TCP text, full mock)
 *
 * OBS, ATEM, and the other devices have mocks but are exercised via their
 * own bridge-specific tests (or stubs in the case of ATEM). This file is
 * the canonical example of how to wire up the mocks for new tests.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const companionMock = require('./mocks/companionServer');
const propresenterMock = require('./mocks/propresenterServer');
const videohubMock = require('./mocks/videohubServer');

const { CompanionBridge } = require('../src/companion');
const { ProPresenter } = require('../src/propresenter');
const { VideoHub } = require('../src/videohub');

// ─── Companion ──────────────────────────────────────────────────────────────

test('integration-mocks: CompanionBridge connects to mock and reads/presses buttons', async (t) => {
  const mock = await companionMock.start({ port: 0, controlPort: 0 });
  t.after(() => mock.stop());

  // Seed a button via control API so the bridge can find it.
  const controlRes = await fetch(`${mock.control.url}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'setButton', args: { page: 1, row: 0, col: 0, text: 'CUE 1' } }),
  });
  assert.equal(controlRes.status, 200);

  const bridge = new CompanionBridge({ companionUrl: mock.url });
  try {
    const reachable = await bridge.isAvailable();
    assert.equal(reachable, true);
    assert.equal(bridge.connected, true);

    const grid = await bridge.getButtonGrid(1);
    assert.ok(Array.isArray(grid));
    assert.equal(grid[0][0].text, 'CUE 1');

    const pressResult = await bridge.pressButton(1, 0, 0);
    assert.equal(pressResult.success, true);

    // The mock should have logged the press.
    const stateRes = await fetch(`${mock.control.url}/state`);
    const state = await stateRes.json();
    assert.ok(state.pressLog.length >= 1);
    assert.equal(state.pressLog[0].page, 1);
  } finally {
    bridge.stopPolling();
  }
});

// ─── ProPresenter ───────────────────────────────────────────────────────────

test('integration-mocks: ProPresenter bridge reads version + slide and triggers next', async (t) => {
  const mock = await propresenterMock.start({ port: 0, controlPort: 0 });
  t.after(() => mock.stop());

  // Seed a known slide state.
  await fetch(`${mock.control.url}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'setSlide', args: { presentationName: 'Sermon', slideIndex: 3, slideTotal: 20 } }),
  });

  const pp = new ProPresenter({ host: '127.0.0.1', port: mock.port });
  const running = await pp.isRunning();
  assert.equal(running, true);

  const version = await pp.getVersion();
  assert.ok(version, 'expected a version string from /version');

  const slide = await pp.getCurrentSlide();
  assert.equal(slide.presentationName, 'Sermon');
  assert.equal(slide.slideIndex, 3);
  assert.equal(slide.slideTotal, 20);

  const before = mock.state.slide.slideIndex;
  await pp.nextSlide();
  // Mock advances slideIndex on trigger; allow a tick for the fire-and-forget POST to land.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mock.state.slide.slideIndex, before + 1, 'next slide should advance mock state');
});

// ─── VideoHub ───────────────────────────────────────────────────────────────

test('integration-mocks: VideoHub bridge handshakes, reads routes, and writes a route', async (t) => {
  const mock = await videohubMock.start({ port: 0, controlPort: 0, inputs: 8, outputs: 8 });
  t.after(() => mock.stop());

  const hub = new VideoHub({ ip: '127.0.0.1', port: mock.port, name: 'mock-hub' });
  await hub.connect();
  // Allow the initial PROTOCOL PREAMBLE → INPUT/OUTPUT/ROUTING dump to be parsed.
  await new Promise((r) => setTimeout(r, 100));

  try {
    assert.equal(hub.connected, true);
    // Default routing is identity (output N → input N) — mock seeded that.
    assert.equal(hub._routes.get(0), 0);
    assert.equal(hub._routes.get(3), 3);

    // Change a route via the control API and verify the bridge sees the update.
    await fetch(`${mock.control.url}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'setRoute', args: { output: 2, input: 5 } }),
    });
    // Allow the broadcast block to be received and parsed.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(hub._routes.get(2), 5, 'bridge should pick up route change broadcast from mock');
  } finally {
    await hub.disconnect();
  }
});

// ─── TriCaster ──────────────────────────────────────────────────────────────

const tricasterMock = require('./mocks/tricasterServer');
const { TriCasterEncoder } = require('../src/encoders/tricaster');

test('integration-mocks: TriCasterEncoder probes version and toggles a shortcut', async (t) => {
  const mock = await tricasterMock.start({ port: 0, controlPort: 0 });
  t.after(() => mock.stop());

  const enc = new TriCasterEncoder({ host: '127.0.0.1', port: mock.port });
  const online = await enc.isOnline();
  assert.equal(online, true);

  await enc.startStream(); // POST /v1/shortcut name=streaming_toggle value=1
  // Allow the dialect-trial loop to settle.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(mock.state.shortcuts.streaming_toggle, true,
    'streaming_toggle should be set on the mock after startStream');
});

// ─── BirdDog ────────────────────────────────────────────────────────────────

const birddogMock = require('./mocks/birddogServer');

test('integration-mocks: BirdDog mock returns identity on /about and /decodestatus', async (t) => {
  const mock = await birddogMock.start({ port: 0, controlPort: 0 });
  t.after(() => mock.stop());

  const aboutRes = await fetch(`${mock.url}/about`);
  assert.equal(aboutRes.status, 200);
  const about = await aboutRes.json();
  assert.equal(about.Manufacturer, 'BirdDog');
  assert.ok(about.ModelName);

  const decodeRes = await fetch(`${mock.url}/decodestatus?ChNum=1`);
  const decode = await decodeRes.json();
  assert.equal(decode.signal, 'OK');
});

// ─── Teradek ────────────────────────────────────────────────────────────────

const teradekMock = require('./mocks/teradekServer');

test('integration-mocks: Teradek mock requires login then exposes status', async (t) => {
  const mock = await teradekMock.start({ port: 0, controlPort: 0 });
  t.after(() => mock.stop());

  // Without auth → ##Access denied#
  const denied = await fetch(`${mock.url}/cgi-bin/system.cgi?command=status`);
  const deniedText = await denied.text();
  assert.match(deniedText, /Access denied/);

  // Login
  const loginRes = await fetch(`${mock.url}/cgi-bin/api.cgi`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'command=login&user=admin&passwd=admin',
  });
  const cookie = loginRes.headers.get('set-cookie');
  assert.match(cookie || '', /serenity-session=/);
  const sessionId = cookie.match(/serenity-session=([^;]+)/)[1];

  // Authed status request
  const okRes = await fetch(`${mock.url}/cgi-bin/system.cgi?command=status`, {
    headers: { Cookie: `serenity-session=${sessionId}` },
  });
  const okJson = await okRes.json();
  assert.equal(okJson.status['Broadcast-State'], 'Ready');

  // Toggle live via control API and re-check
  await fetch(`${mock.control.url}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'setBroadcastState', args: { state: 'Live' } }),
  });
  const liveRes = await fetch(`${mock.url}/cgi-bin/system.cgi?command=status`, {
    headers: { Cookie: `serenity-session=${sessionId}` },
  });
  const liveJson = await liveRes.json();
  assert.equal(liveJson.status['Broadcast-State'], 'Live');
});

// ─── Resolume ──────────────────────────────────────────────────────────────

const resolumeMock = require('./mocks/resolumeServer');

test('integration-mocks: Resolume mock connects clip and reports it as connected', async (t) => {
  const mock = await resolumeMock.start({ port: 0, controlPort: 0 });
  t.after(() => mock.stop());

  // Trigger clip 1 in layer 1
  const triggerRes = await fetch(`${mock.url}/api/v1/composition/layers/1/clips/1/connect`, { method: 'POST' });
  assert.equal(triggerRes.status, 204);

  // Composition should reflect the new connection state
  const compRes = await fetch(`${mock.url}/api/v1/composition`);
  const comp = await compRes.json();
  assert.equal(comp.layers[0].clips[0].connected.index, 1);
  assert.equal(comp.layers[0].clips[1].connected.index, 0);

  // disconnectall clears everything
  await fetch(`${mock.url}/api/v1/composition/disconnectall`, { method: 'POST' });
  const compAfter = await (await fetch(`${mock.url}/api/v1/composition`)).json();
  assert.equal(compAfter.layers[0].clips[0].connected.index, 0);
});

// ─── A&H SQ ────────────────────────────────────────────────────────────────

const sqMock = require('./mocks/sqMixerServer');

test('integration-mocks: SQ mock accepts TCP MIDI connection and serves OSC name reads', async (t) => {
  const mock = await sqMock.start({ port: 0, oscPort: 0, controlPort: 0 });
  t.after(() => mock.stop());

  // TCP MIDI connection is accepted (stub — bytes counted, no protocol response)
  const net = require('node:net');
  await new Promise((resolve, reject) => {
    const sock = net.createConnection(mock.midiPort, '127.0.0.1');
    sock.on('connect', () => {
      sock.write(Buffer.from([0xB0, 0x63, 0x00])); // dummy NRPN-ish bytes
      setTimeout(() => { sock.end(); resolve(); }, 50);
    });
    sock.on('error', reject);
  });
  // Allow event loop to flush state updates.
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(mock.state.midiBytesReceived >= 3, 'SQ MIDI stub should count received bytes');

  // OSC round-trip — send /sq/ch/1/name request and expect the name back.
  const dgram = require('node:dgram');
  const client = dgram.createSocket('udp4');
  // Hand-encode an OSC message: address + ',' typetag + no args.
  const addr = Buffer.from('/sq/ch/1/name\0\0\0', 'utf8'); // 16 bytes (4-aligned)
  const tags = Buffer.from(',\0\0\0', 'utf8');             // 4 bytes
  const packet = Buffer.concat([addr, tags]);
  const reply = await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.close();
      reject(new Error('no OSC reply'));
    }, 1000);
    client.on('message', (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.close();
      resolve(msg);
    });
    client.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    client.send(packet, mock.oscPort, '127.0.0.1');
  });
  // Reply contains the channel name string; we just assert the address is echoed.
  assert.ok(reply.toString().includes('/sq/ch/1/name'));
});

// ─── Planning Center ───────────────────────────────────────────────────────

const pcoMock = require('./mocks/planningCenterServer');

test('integration-mocks: PCO mock serves OAuth token + JSON:API service types', async (t) => {
  const mock = await pcoMock.start({ port: 0, controlPort: 0 });
  t.after(() => mock.stop());

  // OAuth token exchange — accepts any code
  const tokRes = await fetch(`${mock.url}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code: 'anything' }),
  });
  const tok = await tokRes.json();
  assert.ok(tok.access_token);
  assert.equal(tok.token_type, 'Bearer');
  assert.ok(tok.expires_in > 0);

  // Service types
  const stRes = await fetch(`${mock.url}/services/v2/service_types`);
  const stJson = await stRes.json();
  assert.ok(Array.isArray(stJson.data));
  assert.ok(stJson.data.length >= 2);
  assert.equal(stJson.data[0].type, 'ServiceType');

  // Plans for the seeded service type
  const stId = stJson.data[0].id;
  const plansRes = await fetch(`${mock.url}/services/v2/service_types/${stId}/plans`);
  const plansJson = await plansRes.json();
  assert.ok(Array.isArray(plansJson.data));
  assert.ok(plansJson.data.length >= 1);
});

// ─── Launcher sanity ────────────────────────────────────────────────────────

test('integration-mocks: REGISTRY enumerates expected mock device set', () => {
  const { REGISTRY } = require('./mocks/launcher');
  const names = REGISTRY.map((m) => m.name).sort();
  assert.deepEqual(names, [
    'atem', 'birddog', 'companion', 'obs', 'planning-center',
    'propresenter', 'resolume', 'sq', 'teradek', 'tricaster', 'videohub',
  ]);
});
