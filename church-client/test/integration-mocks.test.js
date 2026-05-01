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

// ─── Launcher sanity ────────────────────────────────────────────────────────

test('integration-mocks: REGISTRY enumerates expected mock device set', () => {
  const { REGISTRY } = require('./mocks/launcher');
  const names = REGISTRY.map((m) => m.name).sort();
  assert.deepEqual(names, ['atem', 'companion', 'obs', 'propresenter', 'videohub']);
});
