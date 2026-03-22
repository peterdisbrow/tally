/**
 * ATEM Command Handler Tests
 *
 * Tests the command handlers exported from src/commands/atem.js.
 * All tests use a mock agent — no ATEM hardware, no network, no timers.
 *
 * Coverage:
 *   - Core switching: cut, auto, setProgram, setPreview
 *   - Recording/streaming: startRecording, stopRecording, startStreaming, stopStreaming
 *   - Transition: setTransitionStyle, setTransitionRate, fadeToBlack
 *   - Aux buses: setAux
 *   - Labels: setInputLabel
 *   - Macros: runMacro, stopMacro
 *   - DSK: setDskOnAir
 *   - Input validation: validateAtemInput (tested through handlers)
 *   - FakeAtem mode: argument-order swap
 *   - Error paths: missing required params, unsupported operations
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const handlers = require('../src/commands/atem');

// ─── Mock agent factory ───────────────────────────────────────────────────────
//
// Creates a lightweight stand-in for ChurchAVAgent.
// `calls` records every ATEM method call as [methodName, ...args].
// `atemCommand` simply executes the passed function synchronously.

function createAgent({ fakeAtem = false, inputLabels = null, atemOverrides = {} } = {}) {
  const calls = [];

  const atem = {
    changeProgramInput:    async (a, b)    => { calls.push(['changeProgramInput', a, b]); },
    changePreviewInput:    async (a, b)    => { calls.push(['changePreviewInput', a, b]); },
    cut:                   async (me)      => { calls.push(['cut', me]); },
    autoTransition:        async (me)      => { calls.push(['autoTransition', me]); },
    startRecording:        async ()        => { calls.push(['startRecording']); },
    stopRecording:         async ()        => { calls.push(['stopRecording']); },
    startStreaming:        async ()        => { calls.push(['startStreaming']); },
    stopStreaming:         async ()        => { calls.push(['stopStreaming']); },
    fadeToBlack:           async (me)      => { calls.push(['fadeToBlack', me]); },
    setInputSettings:      async (a, b)    => { calls.push(['setInputSettings', a, b]); },
    macroRun:              async (idx)     => { calls.push(['macroRun', idx]); },
    macroStop:             async ()        => { calls.push(['macroStop']); },
    setAuxSource:          async (a, b)    => { calls.push(['setAuxSource', a, b]); },
    setTransitionStyle:    async (a, b)    => { calls.push(['setTransitionStyle', a, b]); },
    setMixTransitionSettings: async (a, b) => { calls.push(['setMixTransitionSettings', a, b]); },
    setTransitionRate:     async (me, r)   => { calls.push(['setTransitionRate', me, r]); },
    setDownstreamKeyOnAir: async (onAir, k) => { calls.push(['setDownstreamKeyOnAir', onAir, k]); },
    ...atemOverrides,
  };

  return {
    atem,
    _fakeAtemMode: fakeAtem,
    status: {
      atem: inputLabels ? { inputLabels } : {},
    },
    async atemCommand(fn) { return fn(); },
    calls,
  };
}

// ─── atem.cut ─────────────────────────────────────────────────────────────────

test('atem.cut without input executes cut on ME 0', async () => {
  const agent = createAgent();
  const result = await handlers['atem.cut'](agent, {});
  assert.equal(result, 'Cut executed');
  assert.deepStrictEqual(agent.calls[0], ['cut', 0]);
});

test('atem.cut with input calls changeProgramInput(input, me)', async () => {
  const agent = createAgent();
  const result = await handlers['atem.cut'](agent, { input: 1 });
  assert.equal(result, 'Cut to input 1');
  assert.deepStrictEqual(agent.calls[0], ['changeProgramInput', 1, 0]);
});

test('atem.cut with input and ME uses correct ME', async () => {
  const agent = createAgent();
  await handlers['atem.cut'](agent, { input: 2, me: 1 });
  assert.deepStrictEqual(agent.calls[0], ['changeProgramInput', 2, 1]);
});

test('atem.cut FakeAtem mode swaps arguments', async () => {
  // Real ATEM: changeProgramInput(input, me)
  // FakeAtem:  changeProgramInput(me, input)
  const agent = createAgent({ fakeAtem: true });
  await handlers['atem.cut'](agent, { input: 3, me: 0 });
  assert.deepStrictEqual(agent.calls[0], ['changeProgramInput', 0, 3]);
});

test('atem.cut ME defaults to 0 when not provided', async () => {
  const agent = createAgent();
  await handlers['atem.cut'](agent, { input: 5 });
  assert.deepStrictEqual(agent.calls[0], ['changeProgramInput', 5, 0]);
});

test('atem.cut allows input >= 1000 (special sources) even with labels present', async () => {
  const agent = createAgent({ inputLabels: { 1: 'Camera 1', 2: 'Camera 2' } });
  const result = await handlers['atem.cut'](agent, { input: 1000 });
  assert.equal(result, 'Cut to input 1000');
});

test('atem.cut rejects non-existent input when labels are known', async () => {
  const agent = createAgent({ inputLabels: { 1: 'Cam 1', 2: 'Cam 2' } });
  await assert.rejects(
    () => handlers['atem.cut'](agent, { input: 5 }),
    /Camera 5 doesn't exist/
  );
});

test('atem.cut allows valid input when labels are known', async () => {
  const agent = createAgent({ inputLabels: { 1: 'Cam 1', 2: 'Cam 2' } });
  const result = await handlers['atem.cut'](agent, { input: 2 });
  assert.equal(result, 'Cut to input 2');
});

test('atem.cut error message lists available inputs', async () => {
  const agent = createAgent({ inputLabels: { 1: 'Cam 1', 2: 'Cam 2' } });
  await assert.rejects(
    () => handlers['atem.cut'](agent, { input: 4 }),
    (err) => {
      assert.match(err.message, /Available inputs: 1, 2/);
      return true;
    }
  );
});

// ─── atem.auto ────────────────────────────────────────────────────────────────

test('atem.auto executes auto transition on ME 0', async () => {
  const agent = createAgent();
  const result = await handlers['atem.auto'](agent, {});
  assert.equal(result, 'Auto transition executed');
  assert.deepStrictEqual(agent.calls[0], ['autoTransition', 0]);
});

test('atem.auto uses specified ME', async () => {
  const agent = createAgent();
  await handlers['atem.auto'](agent, { me: 1 });
  assert.deepStrictEqual(agent.calls[0], ['autoTransition', 1]);
});

// ─── atem.setProgram ──────────────────────────────────────────────────────────

test('atem.setProgram calls changeProgramInput(input, me)', async () => {
  const agent = createAgent();
  const result = await handlers['atem.setProgram'](agent, { input: 2 });
  assert.equal(result, 'Program input set to 2');
  assert.deepStrictEqual(agent.calls[0], ['changeProgramInput', 2, 0]);
});

test('atem.setProgram FakeAtem mode swaps arguments', async () => {
  const agent = createAgent({ fakeAtem: true });
  await handlers['atem.setProgram'](agent, { input: 3, me: 0 });
  assert.deepStrictEqual(agent.calls[0], ['changeProgramInput', 0, 3]);
});

test('atem.setProgram rejects missing input', async () => {
  const agent = createAgent();
  await assert.rejects(
    () => handlers['atem.setProgram'](agent, {}),
    /input must be an integer/
  );
});

test('atem.setProgram rejects non-integer input', async () => {
  const agent = createAgent();
  await assert.rejects(
    () => handlers['atem.setProgram'](agent, { input: 'cam1' }),
    /input must be an integer/
  );
});

// ─── atem.setPreview ──────────────────────────────────────────────────────────

test('atem.setPreview calls changePreviewInput(input, me)', async () => {
  const agent = createAgent();
  const result = await handlers['atem.setPreview'](agent, { input: 3 });
  assert.equal(result, 'Preview input set to 3');
  assert.deepStrictEqual(agent.calls[0], ['changePreviewInput', 3, 0]);
});

test('atem.setPreview FakeAtem mode swaps arguments', async () => {
  const agent = createAgent({ fakeAtem: true });
  await handlers['atem.setPreview'](agent, { input: 4, me: 0 });
  assert.deepStrictEqual(agent.calls[0], ['changePreviewInput', 0, 4]);
});

test('atem.setPreview rejects missing input', async () => {
  const agent = createAgent();
  await assert.rejects(
    () => handlers['atem.setPreview'](agent, {}),
    /input must be an integer/
  );
});

// ─── atem.startRecording / atem.stopRecording ─────────────────────────────────

test('atem.startRecording calls atem.startRecording()', async () => {
  const agent = createAgent();
  const result = await handlers['atem.startRecording'](agent, {});
  assert.equal(result, 'Recording started');
  assert.deepStrictEqual(agent.calls[0], ['startRecording']);
});

test('atem.startRecording falls back to setRecordingAction({ action: 1 })', async () => {
  const agent = createAgent({ atemOverrides: { startRecording: undefined } });
  agent.atem.setRecordingAction = async (p) => { agent.calls.push(['setRecordingAction', p]); };
  const result = await handlers['atem.startRecording'](agent, {});
  assert.equal(result, 'Recording started');
  assert.deepStrictEqual(agent.calls[0], ['setRecordingAction', { action: 1 }]);
});

test('atem.startRecording throws when neither method is available', async () => {
  const agent = createAgent({ atemOverrides: { startRecording: undefined } });
  await assert.rejects(
    () => handlers['atem.startRecording'](agent, {}),
    /recording start is not supported/
  );
});

test('atem.stopRecording calls atem.stopRecording()', async () => {
  const agent = createAgent();
  const result = await handlers['atem.stopRecording'](agent, {});
  assert.equal(result, 'Recording stopped');
  assert.deepStrictEqual(agent.calls[0], ['stopRecording']);
});

test('atem.stopRecording falls back to setRecordingAction({ action: 0 })', async () => {
  const agent = createAgent({ atemOverrides: { stopRecording: undefined } });
  agent.atem.setRecordingAction = async (p) => { agent.calls.push(['setRecordingAction', p]); };
  await handlers['atem.stopRecording'](agent, {});
  assert.deepStrictEqual(agent.calls[0], ['setRecordingAction', { action: 0 }]);
});

test('atem.stopRecording throws when neither method is available', async () => {
  const agent = createAgent({ atemOverrides: { stopRecording: undefined } });
  await assert.rejects(
    () => handlers['atem.stopRecording'](agent, {}),
    /recording stop is not supported/
  );
});

// ─── atem.startStreaming / atem.stopStreaming ──────────────────────────────────

test('atem.startStreaming calls atem.startStreaming()', async () => {
  const agent = createAgent();
  const result = await handlers['atem.startStreaming'](agent, {});
  assert.equal(result, 'Streaming started');
  assert.deepStrictEqual(agent.calls[0], ['startStreaming']);
});

test('atem.startStreaming throws when not supported', async () => {
  const agent = createAgent({ atemOverrides: { startStreaming: undefined } });
  await assert.rejects(
    () => handlers['atem.startStreaming'](agent, {}),
    /streaming start is not supported/
  );
});

test('atem.stopStreaming calls atem.stopStreaming()', async () => {
  const agent = createAgent();
  const result = await handlers['atem.stopStreaming'](agent, {});
  assert.equal(result, 'Streaming stopped');
  assert.deepStrictEqual(agent.calls[0], ['stopStreaming']);
});

test('atem.stopStreaming throws when not supported', async () => {
  const agent = createAgent({ atemOverrides: { stopStreaming: undefined } });
  await assert.rejects(
    () => handlers['atem.stopStreaming'](agent, {}),
    /streaming stop is not supported/
  );
});

// ─── atem.fadeToBlack ─────────────────────────────────────────────────────────

test('atem.fadeToBlack calls fadeToBlack on ME 0', async () => {
  const agent = createAgent();
  const result = await handlers['atem.fadeToBlack'](agent, {});
  assert.equal(result, 'Fade to black toggled');
  assert.deepStrictEqual(agent.calls[0], ['fadeToBlack', 0]);
});

test('atem.fadeToBlack uses specified ME', async () => {
  const agent = createAgent();
  await handlers['atem.fadeToBlack'](agent, { me: 1 });
  assert.deepStrictEqual(agent.calls[0], ['fadeToBlack', 1]);
});

test('atem.fadeToBlack falls back to setFadeToBlackState', async () => {
  const agent = createAgent({ atemOverrides: { fadeToBlack: undefined } });
  agent.atem.setFadeToBlackState = async (me, opts) => { agent.calls.push(['setFadeToBlackState', me, opts]); };
  await handlers['atem.fadeToBlack'](agent, { me: 0 });
  assert.equal(agent.calls[0][0], 'setFadeToBlackState');
  assert.equal(agent.calls[0][1], 0); // me
  assert.ok(typeof agent.calls[0][2] === 'object'); // opts
});

test('atem.fadeToBlack throws when not supported', async () => {
  const agent = createAgent({
    atemOverrides: { fadeToBlack: undefined },
  });
  await assert.rejects(
    () => handlers['atem.fadeToBlack'](agent, {}),
    /fade-to-black is not supported/
  );
});

// ─── atem.setInputLabel ───────────────────────────────────────────────────────

test('atem.setInputLabel returns confirmation string', async () => {
  const agent = createAgent();
  const result = await handlers['atem.setInputLabel'](agent, { input: 1, longName: 'Pulpit Cam' });
  assert.equal(result, 'Input 1 labeled "Pulpit Cam"');
});

test('atem.setInputLabel calls setInputSettings with longName and shortName', async () => {
  const agent = createAgent();
  await handlers['atem.setInputLabel'](agent, { input: 1, longName: 'Pulpit Cam', shortName: 'PULP' });
  assert.equal(agent.calls[0][0], 'setInputSettings');
  // Normal ATEM: setInputSettings({ longName, shortName }, input)
  assert.deepStrictEqual(agent.calls[0][1], { longName: 'Pulpit Cam', shortName: 'PULP' });
  assert.equal(agent.calls[0][2], 1);
});

test('atem.setInputLabel auto-generates shortName from first 4 chars of longName', async () => {
  const agent = createAgent();
  await handlers['atem.setInputLabel'](agent, { input: 2, longName: 'Camera 1' });
  const settings = agent.calls[0][1];
  assert.equal(settings.shortName, 'CAME');
});

test('atem.setInputLabel uses provided shortName over auto-generated', async () => {
  const agent = createAgent();
  await handlers['atem.setInputLabel'](agent, { input: 3, longName: 'Wide Shot', shortName: 'WIDE' });
  const settings = agent.calls[0][1];
  assert.equal(settings.shortName, 'WIDE');
});

test('atem.setInputLabel throws when longName is missing', async () => {
  const agent = createAgent();
  await assert.rejects(
    () => handlers['atem.setInputLabel'](agent, { input: 1 }),
    /longName is required/
  );
});

test('atem.setInputLabel throws when input is missing', async () => {
  const agent = createAgent();
  await assert.rejects(
    () => handlers['atem.setInputLabel'](agent, { longName: 'Camera 1' }),
    /input must be an integer/
  );
});

// ─── atem.runMacro ────────────────────────────────────────────────────────────

test('atem.runMacro calls macroRun with specified index', async () => {
  const agent = createAgent();
  const result = await handlers['atem.runMacro'](agent, { macroIndex: 5 });
  assert.equal(result, 'Macro 5 started');
  assert.deepStrictEqual(agent.calls[0], ['macroRun', 5]);
});

test('atem.runMacro defaults to index 0', async () => {
  const agent = createAgent();
  const result = await handlers['atem.runMacro'](agent, {});
  assert.equal(result, 'Macro 0 started');
  assert.deepStrictEqual(agent.calls[0], ['macroRun', 0]);
});

test('atem.runMacro accepts "index" as alias for macroIndex', async () => {
  const agent = createAgent();
  await handlers['atem.runMacro'](agent, { index: 3 });
  assert.deepStrictEqual(agent.calls[0], ['macroRun', 3]);
});

test('atem.runMacro falls back to atem.runMacro() when macroRun is absent', async () => {
  const agent = createAgent({ atemOverrides: { macroRun: undefined } });
  agent.atem.runMacro = async (idx) => { agent.calls.push(['runMacro', idx]); };
  await handlers['atem.runMacro'](agent, { macroIndex: 2 });
  assert.deepStrictEqual(agent.calls[0], ['runMacro', 2]);
});

test('atem.runMacro throws when neither method exists', async () => {
  const agent = createAgent({ atemOverrides: { macroRun: undefined } });
  await assert.rejects(
    () => handlers['atem.runMacro'](agent, { macroIndex: 0 }),
    /macro run is not supported/
  );
});

// ─── atem.stopMacro ───────────────────────────────────────────────────────────

test('atem.stopMacro calls macroStop()', async () => {
  const agent = createAgent();
  const result = await handlers['atem.stopMacro'](agent, {});
  assert.equal(result, 'Macro stopped');
  assert.deepStrictEqual(agent.calls[0], ['macroStop']);
});

test('atem.stopMacro falls back to atem.stopMacro() when macroStop absent', async () => {
  const agent = createAgent({ atemOverrides: { macroStop: undefined } });
  agent.atem.stopMacro = async () => { agent.calls.push(['stopMacro']); };
  await handlers['atem.stopMacro'](agent, {});
  assert.deepStrictEqual(agent.calls[0], ['stopMacro']);
});

test('atem.stopMacro throws when neither method exists', async () => {
  const agent = createAgent({ atemOverrides: { macroStop: undefined } });
  await assert.rejects(
    () => handlers['atem.stopMacro'](agent, {}),
    /macro stop is not supported/
  );
});

// ─── atem.setAux ──────────────────────────────────────────────────────────────

test('atem.setAux converts 1-based aux to 0-based bus for real ATEM', async () => {
  const agent = createAgent();
  const result = await handlers['atem.setAux'](agent, { input: 1, aux: 1 });
  assert.equal(result, 'Aux 1 set to input 1');
  // Normal ATEM: setAuxSource(source, busZeroBased)
  assert.deepStrictEqual(agent.calls[0], ['setAuxSource', 1, 0]);
});

test('atem.setAux converts aux 2 to bus index 1', async () => {
  const agent = createAgent();
  await handlers['atem.setAux'](agent, { input: 2, aux: 2 });
  assert.deepStrictEqual(agent.calls[0], ['setAuxSource', 2, 1]);
});

test('atem.setAux FakeAtem does not convert bus index (stays 1-based)', async () => {
  // FakeAtem API: setAuxSource(aux1Based, source) — no conversion
  const agent = createAgent({ fakeAtem: true });
  await handlers['atem.setAux'](agent, { input: 1, aux: 1 });
  assert.deepStrictEqual(agent.calls[0], ['setAuxSource', 1, 1]);
});

test('atem.setAux accepts "bus" as alias for aux', async () => {
  const agent = createAgent();
  await handlers['atem.setAux'](agent, { input: 3, bus: 2 });
  assert.deepStrictEqual(agent.calls[0], ['setAuxSource', 3, 1]);
});

test('atem.setAux rejects missing input', async () => {
  const agent = createAgent();
  await assert.rejects(
    () => handlers['atem.setAux'](agent, { aux: 1 }),
    /input must be an integer/
  );
});

// ─── atem.setTransitionStyle ──────────────────────────────────────────────────

test('atem.setTransitionStyle sets mix style (code 0)', async () => {
  const agent = createAgent();
  const result = await handlers['atem.setTransitionStyle'](agent, { style: 'mix' });
  assert.equal(result, 'Transition style set to mix');
  // Normal ATEM: setTransitionStyle({ nextStyle: code }, me)
  assert.equal(agent.calls[0][0], 'setTransitionStyle');
  assert.deepStrictEqual(agent.calls[0][1], { nextStyle: 0 });
  assert.equal(agent.calls[0][2], 0); // me
});

test('atem.setTransitionStyle sets dip style (code 1)', async () => {
  const agent = createAgent();
  await handlers['atem.setTransitionStyle'](agent, { style: 'dip' });
  assert.deepStrictEqual(agent.calls[0][1], { nextStyle: 1 });
});

test('atem.setTransitionStyle sets wipe style (code 2)', async () => {
  const agent = createAgent();
  await handlers['atem.setTransitionStyle'](agent, { style: 'wipe' });
  assert.deepStrictEqual(agent.calls[0][1], { nextStyle: 2 });
});

test('atem.setTransitionStyle sets dve style (code 3)', async () => {
  const agent = createAgent();
  await handlers['atem.setTransitionStyle'](agent, { style: 'dve' });
  assert.deepStrictEqual(agent.calls[0][1], { nextStyle: 3 });
});

test('atem.setTransitionStyle sets stinger style (code 4)', async () => {
  const agent = createAgent();
  const result = await handlers['atem.setTransitionStyle'](agent, { style: 'stinger' });
  assert.equal(result, 'Transition style set to stinger');
  assert.deepStrictEqual(agent.calls[0][1], { nextStyle: 4 });
});

test('atem.setTransitionStyle "sting" alias normalizes to stinger', async () => {
  const agent = createAgent();
  const result = await handlers['atem.setTransitionStyle'](agent, { style: 'sting' });
  assert.equal(result, 'Transition style set to stinger');
  assert.deepStrictEqual(agent.calls[0][1], { nextStyle: 4 });
});

test('atem.setTransitionStyle is case-insensitive', async () => {
  const agent = createAgent();
  await handlers['atem.setTransitionStyle'](agent, { style: 'MIX' });
  assert.deepStrictEqual(agent.calls[0][1], { nextStyle: 0 });
});

test('atem.setTransitionStyle FakeAtem passes (me, name) instead of ({nextStyle}, me)', async () => {
  const agent = createAgent({ fakeAtem: true });
  await handlers['atem.setTransitionStyle'](agent, { style: 'mix', me: 0 });
  assert.deepStrictEqual(agent.calls[0], ['setTransitionStyle', 0, 'mix']);
});

test('atem.setTransitionStyle rejects unknown style', async () => {
  const agent = createAgent();
  await assert.rejects(
    () => handlers['atem.setTransitionStyle'](agent, { style: 'disco' }),
    /transition style must be one of/
  );
});

test('atem.setTransitionStyle rejects empty style', async () => {
  const agent = createAgent();
  await assert.rejects(
    () => handlers['atem.setTransitionStyle'](agent, { style: '' }),
    /transition style must be one of/
  );
});

// ─── atem.setTransitionRate ───────────────────────────────────────────────────

test('atem.setTransitionRate calls setMixTransitionSettings on real ATEM', async () => {
  const agent = createAgent();
  const result = await handlers['atem.setTransitionRate'](agent, { rate: 25 });
  assert.equal(result, 'Transition rate set to 25');
  assert.equal(agent.calls[0][0], 'setMixTransitionSettings');
  assert.deepStrictEqual(agent.calls[0][1], { rate: 25 });
  assert.equal(agent.calls[0][2], 0); // me
});

test('atem.setTransitionRate FakeAtem calls setTransitionRate(me, rate)', async () => {
  const agent = createAgent({ fakeAtem: true });
  await handlers['atem.setTransitionRate'](agent, { rate: 30, me: 0 });
  assert.deepStrictEqual(agent.calls[0], ['setTransitionRate', 0, 30]);
});

test('atem.setTransitionRate uses setMixTransitionSettings even in FakeAtem when no setTransitionRate', async () => {
  const agent = createAgent({ fakeAtem: true, atemOverrides: { setTransitionRate: undefined } });
  await handlers['atem.setTransitionRate'](agent, { rate: 20 });
  assert.equal(agent.calls[0][0], 'setMixTransitionSettings');
});

test('atem.setTransitionRate rejects missing rate', async () => {
  const agent = createAgent();
  await assert.rejects(
    () => handlers['atem.setTransitionRate'](agent, {}),
    /rate must be an integer/
  );
});

// ─── atem.setDskOnAir ─────────────────────────────────────────────────────────

test('atem.setDskOnAir puts DSK 1 on-air by default', async () => {
  const agent = createAgent();
  const result = await handlers['atem.setDskOnAir'](agent, {});
  assert.equal(result, 'DSK 1 on-air');
  assert.deepStrictEqual(agent.calls[0], ['setDownstreamKeyOnAir', true, 0]);
});

test('atem.setDskOnAir can set DSK off-air', async () => {
  const agent = createAgent();
  const result = await handlers['atem.setDskOnAir'](agent, { onAir: false });
  assert.equal(result, 'DSK 1 off-air');
  assert.deepStrictEqual(agent.calls[0], ['setDownstreamKeyOnAir', false, 0]);
});

test('atem.setDskOnAir uses keyer 1 (DSK 2)', async () => {
  const agent = createAgent();
  const result = await handlers['atem.setDskOnAir'](agent, { keyer: 1 });
  assert.equal(result, 'DSK 2 on-air');
  assert.deepStrictEqual(agent.calls[0], ['setDownstreamKeyOnAir', true, 1]);
});

test('atem.setDskOnAir accepts "key" as alias for keyer', async () => {
  const agent = createAgent();
  await handlers['atem.setDskOnAir'](agent, { key: 1, onAir: false });
  assert.deepStrictEqual(agent.calls[0], ['setDownstreamKeyOnAir', false, 1]);
});

// ─── validateAtemInput edge cases (via atem.cut) ──────────────────────────────

test('validateAtemInput: passes when no inputLabels on agent', async () => {
  const agent = createAgent(); // no labels
  const result = await handlers['atem.cut'](agent, { input: 99 });
  assert.equal(result, 'Cut to input 99');
});

test('validateAtemInput: passes when inputLabels is empty object', async () => {
  const agent = createAgent({ inputLabels: {} });
  // No inputs in range 1-40, so validation is skipped
  const result = await handlers['atem.cut'](agent, { input: 5 });
  assert.equal(result, 'Cut to input 5');
});

test('validateAtemInput: inputs outside 1-40 range are ignored in labels', async () => {
  // Labels only contain high IDs (media players) — camera inputs not constrained
  const agent = createAgent({ inputLabels: { 1000: 'Media Player 1', 2000: 'SuperSource' } });
  // knownIds in 1-40 range is empty → validation skipped
  const result = await handlers['atem.cut'](agent, { input: 3 });
  assert.equal(result, 'Cut to input 3');
});

test('validateAtemInput: input null skips validation entirely', async () => {
  const agent = createAgent({ inputLabels: { 1: 'Cam 1' } });
  // No input param → cut ME only, no validation
  const result = await handlers['atem.cut'](agent, {});
  assert.equal(result, 'Cut executed');
  assert.equal(agent.calls.length, 1);
});
