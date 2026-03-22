const test = require('node:test');
const assert = require('node:assert/strict');

const { commandHandlers } = require('../src/commands');

// Creates a mock connected HyperDeck with all methods
function makeDeck(overrides = {}) {
  return {
    connected: true,
    play: async () => {},
    stop: async () => {},
    record: async () => {},
    nextClip: async () => {},
    prevClip: async () => {},
    refreshStatus: async () => ({
      connected: true, name: 'TestDeck', model: 'HyperDeck Studio HD Plus',
      protocolVersion: '1.12', transport: 'stopped', recording: false,
      clipId: null, slotId: null,
    }),
    _sendAndWait: async () => {},
    ...overrides,
  };
}

// Agent using direct HyperDeck connection(s)
function directAgent(decks) {
  return { hyperdecks: decks };
}

// Agent that falls back to ATEM
function atemAgent(atemMethods = {}) {
  return {
    hyperdecks: null,
    atemCommand: async (fn) => fn(),
    atem: atemMethods,
  };
}

// ─── Registration ─────────────────────────────────────────────────────────────

test('all HyperDeck commands are registered', () => {
  const expected = [
    'hyperdeck.play', 'hyperdeck.stop', 'hyperdeck.record', 'hyperdeck.stopRecord',
    'hyperdeck.nextClip', 'hyperdeck.prevClip', 'hyperdeck.status',
    'hyperdeck.selectSlot', 'hyperdeck.setPlaySpeed',
    'hyperdeck.goToClip', 'hyperdeck.goToTimecode', 'hyperdeck.jog',
  ];
  for (const name of expected) {
    assert.ok(commandHandlers[name], `${name} should be registered`);
  }
});

// ─── Direct path ──────────────────────────────────────────────────────────────

test('hyperdeck.play via direct connection calls deck.play()', async () => {
  let played = false;
  const agent = directAgent([makeDeck({ play: async () => { played = true; } })]);
  const result = await commandHandlers['hyperdeck.play'](agent, {});
  assert.ok(played, 'deck.play() should have been called');
  assert.equal(result, 'HyperDeck 1 playing');
});

test('hyperdeck.stop via direct connection calls deck.stop()', async () => {
  let stopped = false;
  const agent = directAgent([makeDeck({ stop: async () => { stopped = true; } })]);
  const result = await commandHandlers['hyperdeck.stop'](agent, {});
  assert.ok(stopped);
  assert.equal(result, 'HyperDeck 1 stopped');
});

test('hyperdeck.record via direct connection calls deck.record()', async () => {
  let recorded = false;
  const agent = directAgent([makeDeck({ record: async () => { recorded = true; } })]);
  const result = await commandHandlers['hyperdeck.record'](agent, {});
  assert.ok(recorded);
  assert.equal(result, 'HyperDeck 1 recording');
});

test('hyperdeck.stopRecord calls deck.stop() and returns "recording stopped"', async () => {
  let stopped = false;
  const agent = directAgent([makeDeck({ stop: async () => { stopped = true; } })]);
  const result = await commandHandlers['hyperdeck.stopRecord'](agent, {});
  assert.ok(stopped);
  assert.equal(result, 'HyperDeck 1 recording stopped');
});

test('hyperdeck.nextClip calls deck.nextClip()', async () => {
  let called = false;
  const agent = directAgent([makeDeck({ nextClip: async () => { called = true; } })]);
  const result = await commandHandlers['hyperdeck.nextClip'](agent, {});
  assert.ok(called);
  assert.equal(result, 'HyperDeck 1 next clip');
});

test('hyperdeck.prevClip calls deck.prevClip()', async () => {
  let called = false;
  const agent = directAgent([makeDeck({ prevClip: async () => { called = true; } })]);
  const result = await commandHandlers['hyperdeck.prevClip'](agent, {});
  assert.ok(called);
  assert.equal(result, 'HyperDeck 1 previous clip');
});

// ─── ATEM fallback path ───────────────────────────────────────────────────────

test('hyperdeck.play falls back to ATEM when hyperdecks is null', async () => {
  let atemIndex = -1;
  const agent = atemAgent({ setHyperDeckPlay: async (i) => { atemIndex = i; } });
  const result = await commandHandlers['hyperdeck.play'](agent, {});
  assert.equal(atemIndex, 0, 'should call ATEM method with index 0');
  assert.equal(result, 'HyperDeck 1 playing');
});

test('hyperdeck.stop falls back to ATEM', async () => {
  let called = false;
  const agent = atemAgent({ setHyperDeckStop: async () => { called = true; } });
  await commandHandlers['hyperdeck.stop'](agent, {});
  assert.ok(called);
});

test('hyperdeck.record falls back to ATEM', async () => {
  let called = false;
  const agent = atemAgent({ setHyperDeckRecord: async () => { called = true; } });
  await commandHandlers['hyperdeck.record'](agent, {});
  assert.ok(called);
});

test('hyperdeck.nextClip falls back to ATEM', async () => {
  let called = false;
  const agent = atemAgent({ setHyperDeckNextClip: async () => { called = true; } });
  await commandHandlers['hyperdeck.nextClip'](agent, {});
  assert.ok(called);
});

test('hyperdeck.prevClip falls back to ATEM', async () => {
  let called = false;
  const agent = atemAgent({ setHyperDeckPrevClip: async () => { called = true; } });
  await commandHandlers['hyperdeck.prevClip'](agent, {});
  assert.ok(called);
});

test('ATEM fallback throws when ATEM method is not available', async () => {
  const agent = atemAgent({}); // no setHyperDeckPlay
  await assert.rejects(
    () => commandHandlers['hyperdeck.play'](agent, {}),
    /HyperDeck control is not available/
  );
});

// ─── Direct throws → ATEM fallback ───────────────────────────────────────────

test('hyperdeck.play falls back to ATEM when direct deck throws', async () => {
  let atemCalled = false;
  const agent = {
    hyperdecks: [makeDeck({ play: async () => { throw new Error('TCP disconnected'); } })],
    atemCommand: async (fn) => fn(),
    atem: { setHyperDeckPlay: async () => { atemCalled = true; } },
  };
  await commandHandlers['hyperdeck.play'](agent, {});
  assert.ok(atemCalled, 'should fall back to ATEM after direct failure');
});

// ─── Connect-before-play when not connected ───────────────────────────────────

test('hyperdeck.play calls connect() first when deck is disconnected', async () => {
  let connectCalled = false;
  let playCalled = false;
  const deck = {
    connected: false,
    connect: async () => { connectCalled = true; deck.connected = true; },
    play: async () => { playCalled = true; },
  };
  const agent = { hyperdecks: [deck] };
  await commandHandlers['hyperdeck.play'](agent, {});
  assert.ok(connectCalled, 'connect() should have been called');
  assert.ok(playCalled, 'play() should have been called after connect');
});

test('hyperdeck.play falls back to ATEM when deck has no connect() and is not connected', async () => {
  let atemCalled = false;
  const agent = {
    hyperdecks: [{ connected: false /* no connect method */ }],
    atemCommand: async (fn) => fn(),
    atem: { setHyperDeckPlay: async () => { atemCalled = true; } },
  };
  await commandHandlers['hyperdeck.play'](agent, {});
  assert.ok(atemCalled);
});

// ─── Index resolution (1-based parameter → 0-based array) ────────────────────

test('hyperdeck.play with hyperdeck=2 uses second deck', async () => {
  let deck2played = false;
  const agent = directAgent([
    makeDeck({ play: async () => {} }),
    makeDeck({ play: async () => { deck2played = true; } }),
  ]);
  const result = await commandHandlers['hyperdeck.play'](agent, { hyperdeck: 2 });
  assert.ok(deck2played, 'second deck should be used for hyperdeck=2');
  assert.equal(result, 'HyperDeck 2 playing');
});

test('hyperdeck.play with index=0 uses first deck (0 treated as invalid → slot 0)', async () => {
  let deck1played = false;
  const agent = directAgent([makeDeck({ play: async () => { deck1played = true; } })]);
  await commandHandlers['hyperdeck.play'](agent, { hyperdeck: 0 });
  assert.ok(deck1played);
});

// ─── hyperdeck.status ─────────────────────────────────────────────────────────

test('hyperdeck.status throws when no deck at index', async () => {
  const agent = { hyperdecks: [] };
  await assert.rejects(
    () => commandHandlers['hyperdeck.status'](agent, {}),
    /not configured/
  );
});

test('hyperdeck.status shows offline message when deck not connected', async () => {
  const agent = directAgent([makeDeck({
    refreshStatus: async () => ({ connected: false, name: 'HyperDeck 1' }),
  })]);
  const result = await commandHandlers['hyperdeck.status'](agent, {});
  assert.ok(result.includes('Offline'));
  assert.ok(result.includes('not responding'));
});

test('hyperdeck.status shows connected status with model, transport, clip, slot', async () => {
  const agent = directAgent([makeDeck({
    refreshStatus: async () => ({
      connected: true, name: 'Studio', model: 'HyperDeck Studio HD Plus',
      protocolVersion: '1.12', transport: 'record', recording: true,
      clipId: 7, slotId: 1,
    }),
  })]);
  const result = await commandHandlers['hyperdeck.status'](agent, {});
  assert.ok(result.includes('✅'));
  assert.ok(result.includes('Studio HD Plus'));
  assert.ok(result.includes('Recording: Active'));
  assert.ok(result.includes('Clip: 7'));
  assert.ok(result.includes('Slot: 1'));
});

test('hyperdeck.status omits clip/slot lines when null', async () => {
  const agent = directAgent([makeDeck({
    refreshStatus: async () => ({
      connected: true, name: 'HD', model: 'HyperDeck Studio Mini',
      transport: 'stopped', recording: false, clipId: null, slotId: null,
    }),
  })]);
  const result = await commandHandlers['hyperdeck.status'](agent, {});
  assert.ok(!result.includes('Clip:'), 'should omit Clip line when null');
  assert.ok(!result.includes('Slot:'), 'should omit Slot line when null');
});

test('hyperdeck.status converts camelCase transport to spaced label', async () => {
  const agent = directAgent([makeDeck({
    refreshStatus: async () => ({
      connected: true, name: 'HD', model: 'Mini', transport: 'fastForward',
      recording: false, clipId: null, slotId: null,
    }),
  })]);
  const result = await commandHandlers['hyperdeck.status'](agent, {});
  assert.ok(result.includes('Fast Forward') || result.includes('fast Forward'));
});

// ─── Direct-only commands (use _sendAndWait) ──────────────────────────────────

test('hyperdeck.selectSlot throws when deck not connected', async () => {
  const agent = { hyperdecks: [{ connected: false }] };
  await assert.rejects(
    () => commandHandlers['hyperdeck.selectSlot'](agent, { slot: 1 }),
    /not connected/
  );
});

test('hyperdeck.selectSlot sends "slot select: slot id: N" command', async () => {
  const cmds = [];
  const agent = directAgent([makeDeck({
    _sendAndWait: async (cmd) => { cmds.push(cmd); },
  })]);
  const result = await commandHandlers['hyperdeck.selectSlot'](agent, { slot: 2 });
  assert.equal(cmds[0], 'slot select: slot id: 2');
  assert.ok(result.includes('slot 2 selected'));
});

test('hyperdeck.setPlaySpeed throws when deck not connected', async () => {
  const agent = { hyperdecks: [{ connected: false }] };
  await assert.rejects(
    () => commandHandlers['hyperdeck.setPlaySpeed'](agent, { speed: 150 }),
    /not connected/
  );
});

test('hyperdeck.setPlaySpeed sends "play: speed: N" command', async () => {
  const cmds = [];
  const agent = directAgent([makeDeck({
    _sendAndWait: async (cmd) => { cmds.push(cmd); },
  })]);
  const result = await commandHandlers['hyperdeck.setPlaySpeed'](agent, { speed: 150 });
  assert.equal(cmds[0], 'play: speed: 150');
  assert.ok(result.includes('150% speed'));
});

test('hyperdeck.setPlaySpeed defaults to 100% when speed not specified', async () => {
  const cmds = [];
  const agent = directAgent([makeDeck({
    _sendAndWait: async (cmd) => { cmds.push(cmd); },
  })]);
  await commandHandlers['hyperdeck.setPlaySpeed'](agent, {});
  assert.equal(cmds[0], 'play: speed: 100');
});

test('hyperdeck.goToClip throws when deck not connected', async () => {
  const agent = { hyperdecks: [] };
  await assert.rejects(
    () => commandHandlers['hyperdeck.goToClip'](agent, { clip: 3 }),
    /not connected/
  );
});

test('hyperdeck.goToClip sends "goto: clip id: N" command', async () => {
  const cmds = [];
  const agent = directAgent([makeDeck({
    _sendAndWait: async (cmd) => { cmds.push(cmd); },
  })]);
  const result = await commandHandlers['hyperdeck.goToClip'](agent, { clip: 5 });
  assert.equal(cmds[0], 'goto: clip id: 5');
  assert.ok(result.includes('clip 5'));
});

test('hyperdeck.goToTimecode sends "goto: timecode: TC" command', async () => {
  const cmds = [];
  const agent = directAgent([makeDeck({
    _sendAndWait: async (cmd) => { cmds.push(cmd); },
  })]);
  const result = await commandHandlers['hyperdeck.goToTimecode'](agent, { timecode: '01:23:45:00' });
  assert.equal(cmds[0], 'goto: timecode: 01:23:45:00');
  assert.ok(result.includes('01:23:45:00'));
});

test('hyperdeck.goToTimecode defaults to 00:00:00:00 when not specified', async () => {
  const cmds = [];
  const agent = directAgent([makeDeck({
    _sendAndWait: async (cmd) => { cmds.push(cmd); },
  })]);
  await commandHandlers['hyperdeck.goToTimecode'](agent, {});
  assert.equal(cmds[0], 'goto: timecode: 00:00:00:00');
});

test('hyperdeck.jog sends "jog: timecode: TC" command', async () => {
  const cmds = [];
  const agent = directAgent([makeDeck({
    _sendAndWait: async (cmd) => { cmds.push(cmd); },
  })]);
  const result = await commandHandlers['hyperdeck.jog'](agent, { timecode: '00:00:02:00' });
  assert.equal(cmds[0], 'jog: timecode: 00:00:02:00');
  assert.ok(result.includes('jogged'));
});

test('hyperdeck.jog defaults to 00:00:01:00 (1 second) when not specified', async () => {
  const cmds = [];
  const agent = directAgent([makeDeck({
    _sendAndWait: async (cmd) => { cmds.push(cmd); },
  })]);
  await commandHandlers['hyperdeck.jog'](agent, {});
  assert.equal(cmds[0], 'jog: timecode: 00:00:01:00');
});
