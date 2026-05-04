/**
 * Tests for the relay health monitor: debounced /health probe that decides
 * whether the desktop app should flip into local-fallback mode.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRelayHealthMonitor,
  healthUrlFromRelay,
  parseLocalStatusPortLine,
} = require('../src/relayHealthMonitor');

// ─── healthUrlFromRelay ──────────────────────────────────────────────────────

test('healthUrlFromRelay maps wss:// to https:// /health', () => {
  assert.equal(healthUrlFromRelay('wss://api.tallyconnect.app'), 'https://api.tallyconnect.app/health');
});

test('healthUrlFromRelay maps ws:// to http:// /health', () => {
  assert.equal(healthUrlFromRelay('ws://localhost:3000'), 'http://localhost:3000/health');
});

test('healthUrlFromRelay leaves https unchanged', () => {
  assert.equal(healthUrlFromRelay('https://api.tallyconnect.app/'), 'https://api.tallyconnect.app/health');
});

test('healthUrlFromRelay defaults bare hosts to https', () => {
  assert.equal(healthUrlFromRelay('example.com'), 'https://example.com/health');
});

test('healthUrlFromRelay returns null for empty input', () => {
  assert.equal(healthUrlFromRelay(''), null);
  assert.equal(healthUrlFromRelay(null), null);
  assert.equal(healthUrlFromRelay(undefined), null);
});

// ─── parseLocalStatusPortLine ────────────────────────────────────────────────

test('parseLocalStatusPortLine extracts a port from the marker', () => {
  assert.equal(parseLocalStatusPortLine('[LOCAL_STATUS_PORT] 38001'), 38001);
});

test('parseLocalStatusPortLine ignores other log lines', () => {
  assert.equal(parseLocalStatusPortLine('Connected to relay server'), null);
  assert.equal(parseLocalStatusPortLine(''), null);
  assert.equal(parseLocalStatusPortLine('[STATUS_JSON] {"foo":1}'), null);
});

test('parseLocalStatusPortLine rejects out-of-range ports', () => {
  assert.equal(parseLocalStatusPortLine('[LOCAL_STATUS_PORT] 0'), null);
  assert.equal(parseLocalStatusPortLine('[LOCAL_STATUS_PORT] 99999'), null);
});

// ─── debounce behavior ──────────────────────────────────────────────────────

function makeMonitor({ responses, failureThreshold = 3, onChange = () => {}, onPoll = () => {} }) {
  let i = 0;
  const calls = [];
  const monitor = createRelayHealthMonitor({
    getRelayUrl: () => 'wss://example.com',
    onChange,
    onPoll,
    intervalMs: 1, // doesn't matter — we call pollNow manually
    timeoutMs: 1,
    failureThreshold,
    fetchHealth: async (url) => {
      calls.push(url);
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return r;
    },
  });
  return { monitor, calls };
}

test('starts optimistic — first failure does not flip to offline', async () => {
  const changes = [];
  const { monitor } = makeMonitor({
    responses: [{ ok: false }],
    onChange: (s) => changes.push(s),
  });
  await monitor.pollNow();
  assert.deepEqual(changes, [], 'no transition after a single failure');
  assert.equal(monitor.getState().online, true);
  assert.equal(monitor.getState().consecutiveFailures, 1);
});

test('flips offline only after failureThreshold consecutive misses', async () => {
  const changes = [];
  const { monitor } = makeMonitor({
    responses: [{ ok: false }, { ok: false }, { ok: false }, { ok: false }],
    failureThreshold: 3,
    onChange: (s) => changes.push(s),
  });
  await monitor.pollNow();
  await monitor.pollNow();
  assert.equal(changes.length, 0, 'still online after 2 misses');
  await monitor.pollNow();
  assert.equal(changes.length, 1, 'flipped offline on 3rd consecutive miss');
  assert.equal(changes[0].online, false);
  // A 4th miss should NOT emit another change.
  await monitor.pollNow();
  assert.equal(changes.length, 1, 'no extra event while staying offline');
});

test('flips back online on first success', async () => {
  const changes = [];
  const { monitor } = makeMonitor({
    responses: [{ ok: false }, { ok: false }, { ok: false }, { ok: true }],
    failureThreshold: 3,
    onChange: (s) => changes.push(s),
  });
  await monitor.pollNow();
  await monitor.pollNow();
  await monitor.pollNow(); // → offline
  await monitor.pollNow(); // → online (single success is enough)
  assert.equal(changes.length, 2);
  assert.equal(changes[0].online, false);
  assert.equal(changes[1].online, true);
  assert.ok(changes[1].lastSeen instanceof Date);
});

test('a single success between failures resets the failure streak', async () => {
  const changes = [];
  const { monitor } = makeMonitor({
    responses: [
      { ok: false }, // 1
      { ok: false }, // 2
      { ok: true },  // resets streak
      { ok: false }, // 1 again
      { ok: false }, // 2
    ],
    failureThreshold: 3,
    onChange: (s) => changes.push(s),
  });
  for (let n = 0; n < 5; n++) await monitor.pollNow();
  assert.deepEqual(changes, [], 'never flipped offline because the streak was broken');
  assert.equal(monitor.getState().consecutiveFailures, 2);
});

test('onPoll fires for every poll, regardless of transition', async () => {
  const polls = [];
  const { monitor } = makeMonitor({
    responses: [{ ok: true }, { ok: false }, { ok: true }],
    onPoll: (s) => polls.push(s.online),
  });
  await monitor.pollNow();
  await monitor.pollNow();
  await monitor.pollNow();
  assert.equal(polls.length, 3);
});

test('throws if required callbacks are missing', () => {
  assert.throws(() => createRelayHealthMonitor({ onChange: () => {} }), /getRelayUrl/);
  assert.throws(() => createRelayHealthMonitor({ getRelayUrl: () => '' }), /onChange/);
});
