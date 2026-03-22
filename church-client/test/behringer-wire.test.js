/**
 * Behringer X32/M32 Wire-Level Tests
 *
 * Verifies that OSC messages sent to the X32/M32 produce the correct wire bytes.
 * Two layers of coverage:
 *   1. encodeMessage() unit tests — exact byte patterns for known messages
 *   2. BehringerMixer driver tests — driver calls OSC with the right address + args
 *
 * Together they prove: high-level command → correct UDP payload.
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { encodeMessage, decodeMessage } = require('../src/osc');
const { BehringerMixer }               = require('../src/mixers/behringer');
const {
  hpfFreqToFloat, eqFreqToFloat, eqGainToFloat, eqQToFloat,
  compThreshToFloat, compRatioToIndex, compAttackToFloat, compReleaseToFloat,
  gateThreshToFloat, panToFloat, trimGainToFloat, headampGainToFloat,
  normalizeColor, normalizeIcon,
  COMP_RATIOS,
} = require('../src/mixers/x32-osc-map');

// ─── HELPERS ───────────────────────────────────────────────────────────────────

/** Create a mock OSC client that records all send() calls. */
function makeMockOsc() {
  const sent = [];
  return {
    sent,
    send(address, args = []) { sent.push({ address, args: [...(args || [])] }); },
    async query() { return null; },
    close() {},
    subscribe() { return () => {}; },
  };
}

/** Create a BehringerMixer with the OSC layer pre-mocked (no real UDP). */
function makeMixer(model = 'X32') {
  const mixer  = new BehringerMixer({ host: '192.168.1.1', model });
  const mockOsc = makeMockOsc();
  mixer._osc   = mockOsc;
  return { mixer, sent: mockOsc.sent };
}

/** Last item from an array. */
const last = (arr) => arr[arr.length - 1];

// ─── SECTION 1: encodeMessage() wire bytes ─────────────────────────────────────

test('encodeMessage: address padded to 4-byte boundary', () => {
  // '/ch/01/mix/on' = 13 chars + null = 14 bytes → pad to 16
  const buf = encodeMessage('/ch/01/mix/on', [{ type: 'i', value: 0 }]);
  // First 16 bytes = address
  assert.equal(buf[0],  0x2f, '/');
  assert.equal(buf[1],  0x63, 'c');
  assert.equal(buf[2],  0x68, 'h');
  assert.equal(buf[3],  0x2f, '/');
  assert.equal(buf[4],  0x30, '0');
  assert.equal(buf[5],  0x31, '1');
  assert.equal(buf[13], 0x00, 'null terminator');
  assert.equal(buf[14], 0x00, 'padding byte 1');
  assert.equal(buf[15], 0x00, 'padding byte 2');
});

test('encodeMessage: type tag string starts at correct offset', () => {
  const buf = encodeMessage('/ch/01/mix/on', [{ type: 'i', value: 0 }]);
  // address = 16 bytes, type tag starts at offset 16
  assert.equal(buf[16], 0x2c, 'comma');
  assert.equal(buf[17], 0x69, 'i');
  assert.equal(buf[18], 0x00, 'null');
  assert.equal(buf[19], 0x00, 'padding');
});

test('encodeMessage: Int32 big-endian argument correct', () => {
  const buf = encodeMessage('/ch/01/mix/on', [{ type: 'i', value: 0 }]);
  // Int32 starts at offset 20
  assert.equal(buf[20], 0x00);
  assert.equal(buf[21], 0x00);
  assert.equal(buf[22], 0x00);
  assert.equal(buf[23], 0x00);
  assert.equal(buf.length, 24);
});

test('encodeMessage: mute value 1 encodes as 0x00000001', () => {
  const buf = encodeMessage('/ch/01/mix/on', [{ type: 'i', value: 1 }]);
  assert.equal(buf[20], 0x00);
  assert.equal(buf[21], 0x00);
  assert.equal(buf[22], 0x00);
  assert.equal(buf[23], 0x01);
});

test('encodeMessage: Float32 BE for 0.75 (unity fader)', () => {
  // 0.75 IEEE-754 = 0x3F400000
  const buf = encodeMessage('/ch/01/mix/fader', [{ type: 'f', value: 0.75 }]);
  // '/ch/01/mix/fader' = 16 chars + null = 17 bytes → pad to 20
  assert.equal(buf.length, 20 + 4 + 4, 'total message length');
  // float at offset 24
  assert.equal(buf[24], 0x3F, 'float byte 0 (sign+exp)');
  assert.equal(buf[25], 0x40, 'float byte 1 (mantissa high)');
  assert.equal(buf[26], 0x00, 'float byte 2');
  assert.equal(buf[27], 0x00, 'float byte 3');
});

test('encodeMessage: Float32 BE for 0.0', () => {
  const buf = encodeMessage('/ch/01/mix/fader', [{ type: 'f', value: 0.0 }]);
  assert.equal(buf[24], 0x00);
  assert.equal(buf[25], 0x00);
  assert.equal(buf[26], 0x00);
  assert.equal(buf[27], 0x00);
});

test('encodeMessage: Float32 BE for 1.0', () => {
  // 1.0 IEEE-754 = 0x3F800000
  const buf = encodeMessage('/ch/01/mix/fader', [{ type: 'f', value: 1.0 }]);
  assert.equal(buf[24], 0x3F);
  assert.equal(buf[25], 0x80);
  assert.equal(buf[26], 0x00);
  assert.equal(buf[27], 0x00);
});

test('encodeMessage: no-arg message (clearSolos)', () => {
  // '/-action/clearsolo' = 18 chars + null = 19 → pad to 20
  const buf = encodeMessage('/-action/clearsolo', []);
  assert.equal(buf.length, 24, '20 addr + 4 typetag');
  // type tag is just ','
  assert.equal(buf[20], 0x2c, 'comma');
  assert.equal(buf[21], 0x00, 'null');
  assert.equal(buf[22], 0x00, 'pad');
  assert.equal(buf[23], 0x00, 'pad');
});

test('encodeMessage: scene recall integer', () => {
  const buf = encodeMessage('/scene/recall', [{ type: 'i', value: 5 }]);
  // '/scene/recall' = 13 chars + null = 14 → pad 16
  assert.equal(buf.length, 24);
  assert.equal(buf[20], 0x00);
  assert.equal(buf[21], 0x00);
  assert.equal(buf[22], 0x00);
  assert.equal(buf[23], 0x05);
});

test('encodeMessage: string argument for channel name', () => {
  const buf = encodeMessage('/ch/01/config/name', [{ type: 's', value: 'Kick' }]);
  // Decode and verify round-trip
  const decoded = decodeMessage(buf);
  assert.equal(decoded.address, '/ch/01/config/name');
  assert.equal(decoded.args[0].type, 's');
  assert.equal(decoded.args[0].value, 'Kick');
});

test('decodeMessage: round-trips integer messages', () => {
  const msg = encodeMessage('/ch/05/mix/on', [{ type: 'i', value: 0 }]);
  const decoded = decodeMessage(msg);
  assert.equal(decoded.address, '/ch/05/mix/on');
  assert.equal(decoded.args[0].type, 'i');
  assert.equal(decoded.args[0].value, 0);
});

test('decodeMessage: round-trips float messages', () => {
  const val = 0.5;
  const msg = encodeMessage('/ch/03/mix/fader', [{ type: 'f', value: val }]);
  const decoded = decodeMessage(msg);
  assert.equal(decoded.address, '/ch/03/mix/fader');
  assert.ok(Math.abs(decoded.args[0].value - val) < 0.00001);
});

test('encodeMessage: multiple arguments encode correctly', () => {
  const buf = encodeMessage('/test', [
    { type: 'i', value: 42 },
    { type: 'f', value: 0.5 },
  ]);
  const decoded = decodeMessage(buf);
  assert.equal(decoded.args.length, 2);
  assert.equal(decoded.args[0].value, 42);
  assert.ok(Math.abs(decoded.args[1].value - 0.5) < 0.00001);
});

// ─── SECTION 2: BehringerMixer sends correct OSC addresses ────────────────────

test('muteChannel sends /ch/NN/mix/on with value 0', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.muteChannel(1);
  assert.equal(last(sent).address, '/ch/01/mix/on');
  assert.equal(last(sent).args[0].type, 'i');
  assert.equal(last(sent).args[0].value, 0);
});

test('muteChannel pads channel number correctly (ch 5 → /ch/05/)', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.muteChannel(5);
  assert.equal(last(sent).address, '/ch/05/mix/on');
  assert.equal(last(sent).args[0].value, 0);
});

test('muteChannel: channel 32 → /ch/32/mix/on', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.muteChannel(32);
  assert.equal(last(sent).address, '/ch/32/mix/on');
});

test('unmuteChannel sends /ch/NN/mix/on with value 1', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.unmuteChannel(1);
  assert.equal(last(sent).address, '/ch/01/mix/on');
  assert.equal(last(sent).args[0].value, 1);
});

test('unmuteChannel: mute=1 is active/unmuted (X32 convention)', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.unmuteChannel(7);
  assert.equal(last(sent).address, '/ch/07/mix/on');
  assert.equal(last(sent).args[0].value, 1, 'X32: 1 = active (not muted)');
});

test('muteMaster sends /main/st/mix/on with value 0', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.muteMaster();
  assert.equal(last(sent).address, '/main/st/mix/on');
  assert.equal(last(sent).args[0].value, 0);
});

test('unmuteMaster sends /main/st/mix/on with value 1', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.unmuteMaster();
  assert.equal(last(sent).address, '/main/st/mix/on');
  assert.equal(last(sent).args[0].value, 1);
});

// ─── SECTION 3: Fader wire bytes ──────────────────────────────────────────────

test('setFader sends /ch/NN/mix/fader with float type', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setFader(1, 0.75);
  assert.equal(last(sent).address, '/ch/01/mix/fader');
  assert.equal(last(sent).args[0].type, 'f');
  assert.ok(Math.abs(last(sent).args[0].value - 0.75) < 0.00001);
});

test('setFader encodes 0.75 as IEEE-754 0x3F400000', () => {
  const buf = encodeMessage('/ch/01/mix/fader', [{ type: 'f', value: 0.75 }]);
  // Float at offset 24
  assert.equal(buf[24], 0x3F);
  assert.equal(buf[25], 0x40);
  assert.equal(buf[26], 0x00);
  assert.equal(buf[27], 0x00);
});

test('setFader clamps value above 1.0', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setFader(1, 1.5);
  assert.equal(last(sent).args[0].value, 1.0);
});

test('setFader clamps value below 0.0', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setFader(1, -0.5);
  assert.equal(last(sent).args[0].value, 0.0);
});

test('setFader(1, 0.5) encodes to correct channel address', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setFader(3, 0.5);
  assert.equal(last(sent).address, '/ch/03/mix/fader');
});

// ─── SECTION 4: Scene recall wire bytes ───────────────────────────────────────

test('recallScene sends /scene/recall with integer', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.recallScene(5);
  assert.equal(last(sent).address, '/scene/recall');
  assert.equal(last(sent).args[0].type, 'i');
  assert.equal(last(sent).args[0].value, 5);
});

test('recallScene(1) encodes correct wire bytes', () => {
  const buf = encodeMessage('/scene/recall', [{ type: 'i', value: 1 }]);
  const decoded = decodeMessage(buf);
  assert.equal(decoded.address, '/scene/recall');
  assert.equal(decoded.args[0].value, 1);
});

test('recallScene encodes scene 0 correctly', () => {
  const buf = encodeMessage('/scene/recall', [{ type: 'i', value: 0 }]);
  // Int32BE(0) = all zeros
  assert.equal(buf[20], 0x00);
  assert.equal(buf[21], 0x00);
  assert.equal(buf[22], 0x00);
  assert.equal(buf[23], 0x00);
});

test('recallScene encodes scene 99 correctly', () => {
  const buf = encodeMessage('/scene/recall', [{ type: 'i', value: 99 }]);
  // Int32BE(99) = 0x00000063
  assert.equal(buf[23], 0x63);
  assert.equal(buf[22], 0x00);
});

// ─── SECTION 5: clearSolos wire bytes ─────────────────────────────────────────

test('clearSolos sends /-action/clearsolo', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.clearSolos();
  assert.equal(last(sent).address, '/-action/clearsolo');
  assert.deepEqual(last(sent).args, []);
});

test('clearSolos message has no argument bytes', () => {
  const buf = encodeMessage('/-action/clearsolo', []);
  // '/-action/clearsolo' = 18 chars + null = 19 → pad 20
  // ',' + null = 2 → pad 4
  // Total = 24 bytes, no args
  assert.equal(buf.length, 24);
});

// ─── SECTION 6: Channel name wire bytes ───────────────────────────────────────

test('setChannelName sends /ch/NN/config/name with string type', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setChannelName(1, 'Kick');
  assert.equal(last(sent).address, '/ch/01/config/name');
  assert.equal(last(sent).args[0].type, 's');
  assert.equal(last(sent).args[0].value, 'Kick');
});

test('setChannelName truncates to 12 characters', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setChannelName(1, 'TooLongChannelName');
  assert.equal(last(sent).args[0].value, 'TooLongChann');
  assert.equal(last(sent).args[0].value.length, 12);
});

test('setChannelName uses correct channel padding', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setChannelName(12, 'Piano');
  assert.equal(last(sent).address, '/ch/12/config/name');
});

// ─── SECTION 7: HPF wire bytes ─────────────────────────────────────────────────

test('setHpf sends /ch/NN/preamp/hpon enable and /ch/NN/preamp/hpf frequency', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setHpf(1, { enabled: true, frequency: 80 });
  // Two messages sent
  const hponMsg = sent.find(m => m.address === '/ch/01/preamp/hpon');
  const hpfMsg  = sent.find(m => m.address === '/ch/01/preamp/hpf');
  assert.ok(hponMsg, 'hpon message sent');
  assert.ok(hpfMsg,  'hpf message sent');
  assert.equal(hponMsg.args[0].value, 1, 'enabled = 1');
  assert.equal(hpfMsg.args[0].type, 'f', 'frequency is float');
});

test('setHpf disabled sends hpon=0', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setHpf(3, { enabled: false, frequency: 80 });
  const hponMsg = sent.find(m => m.address === '/ch/03/preamp/hpon');
  assert.equal(hponMsg.args[0].value, 0);
});

test('setHpf frequency 80 Hz encodes correct float', () => {
  // hpfFreqToFloat(80) = log(80/20) / log(400/20) = log(4) / log(20) ≈ 0.4641
  const expected = hpfFreqToFloat(80);
  assert.ok(expected > 0.4 && expected < 0.5, `80 Hz HPF float ≈ ${expected}`);
  // Verify it round-trips through IEEE-754 without error
  const buf = encodeMessage('/ch/01/preamp/hpf', [{ type: 'f', value: expected }]);
  const decoded = decodeMessage(buf);
  assert.ok(Math.abs(decoded.args[0].value - expected) < 0.0001);
});

// ─── SECTION 8: EQ wire bytes ──────────────────────────────────────────────────

test('setEq sends eq/on message', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setEq(1, { enabled: true, bands: [] });
  const eqOn = sent.find(m => m.address === '/ch/01/eq/on');
  assert.ok(eqOn, 'eq/on sent');
  assert.equal(eqOn.args[0].value, 1);
});

test('setEq disabled sends eq/on=0', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setEq(2, { enabled: false, bands: [] });
  const eqOn = sent.find(m => m.address === '/ch/02/eq/on');
  assert.equal(eqOn.args[0].value, 0);
});

test('setEq band type sends /ch/NN/eq/N/type as integer', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setEq(1, {
    enabled: true,
    bands: [{ band: 1, type: 2, frequency: 1000, gain: 3, q: 1.0 }],
  });
  const typeMsg = sent.find(m => m.address === '/ch/01/eq/1/type');
  assert.ok(typeMsg, 'eq band type message sent');
  assert.equal(typeMsg.args[0].type, 'i');
  assert.equal(typeMsg.args[0].value, 2, 'PEQ type = 2');
});

test('setEq band frequency sends float', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setEq(1, {
    enabled: true,
    bands: [{ band: 2, frequency: 1000 }],
  });
  const freqMsg = sent.find(m => m.address === '/ch/01/eq/2/f');
  assert.ok(freqMsg, 'eq freq message sent');
  assert.equal(freqMsg.args[0].type, 'f');
  const expected = eqFreqToFloat(1000);
  assert.ok(Math.abs(freqMsg.args[0].value - expected) < 0.0001);
});

test('setEq band gain sends float 0dB = 0.5', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setEq(1, {
    enabled: true,
    bands: [{ band: 1, gain: 0 }],
  });
  const gainMsg = sent.find(m => m.address === '/ch/01/eq/1/g');
  assert.ok(gainMsg);
  assert.ok(Math.abs(gainMsg.args[0].value - 0.5) < 0.0001, '0dB gain = 0.5');
});

// ─── SECTION 9: Compressor wire bytes ─────────────────────────────────────────

test('setCompressor sends dyn/on and dyn/mode messages', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setCompressor(1, { enabled: true });
  const dynOn = sent.find(m => m.address === '/ch/01/dyn/on');
  const dynMode = sent.find(m => m.address === '/ch/01/dyn/mode');
  assert.ok(dynOn);
  assert.equal(dynOn.args[0].value, 1);
  assert.ok(dynMode);
  assert.equal(dynMode.args[0].value, 0, 'COMP mode = 0');
});

test('setCompressor threshold sends correct float (-30dB)', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setCompressor(1, { threshold: -30 });
  const thrMsg = sent.find(m => m.address === '/ch/01/dyn/thr');
  assert.ok(thrMsg);
  const expected = compThreshToFloat(-30); // (-30 + 60) / 60 = 0.5
  assert.ok(Math.abs(thrMsg.args[0].value - expected) < 0.0001);
  assert.ok(Math.abs(thrMsg.args[0].value - 0.5) < 0.0001, '-30dB threshold = 0.5');
});

test('setCompressor ratio snaps to nearest preset', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setCompressor(1, { ratio: 4 });
  const ratioMsg = sent.find(m => m.address === '/ch/01/dyn/ratio');
  assert.ok(ratioMsg);
  assert.equal(ratioMsg.args[0].type, 'i');
  const expectedIdx = compRatioToIndex(4); // index 7 → ratio 4
  assert.equal(ratioMsg.args[0].value, expectedIdx);
  assert.equal(COMP_RATIOS[expectedIdx], 4);
});

test('setCompressor attack sends correct float (60ms)', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setCompressor(1, { attack: 60 });
  const attackMsg = sent.find(m => m.address === '/ch/01/dyn/attack');
  assert.ok(attackMsg);
  assert.ok(Math.abs(attackMsg.args[0].value - 0.5) < 0.0001, '60ms attack = 0.5');
});

// ─── SECTION 10: Gate wire bytes ──────────────────────────────────────────────

test('setGate sends gate/on message', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setGate(1, { enabled: true });
  const gateOn = sent.find(m => m.address === '/ch/01/gate/on');
  assert.ok(gateOn);
  assert.equal(gateOn.args[0].value, 1);
});

test('setGate threshold -40dB encodes correct float', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setGate(1, { threshold: -40 });
  const thrMsg = sent.find(m => m.address === '/ch/01/gate/thr');
  assert.ok(thrMsg);
  const expected = gateThreshToFloat(-40); // (-40 + 80) / 80 = 0.5
  assert.ok(Math.abs(thrMsg.args[0].value - 0.5) < 0.0001, '-40dB gate thr = 0.5');
});

test('setGate mode sends integer', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setGate(1, { mode: 3 }); // GATE mode
  const modeMsg = sent.find(m => m.address === '/ch/01/gate/mode');
  assert.ok(modeMsg);
  assert.equal(modeMsg.args[0].type, 'i');
  assert.equal(modeMsg.args[0].value, 3);
});

// ─── SECTION 11: Pan wire bytes ────────────────────────────────────────────────

test('setPan(ch, 0) sends 0.5 (center) to /ch/NN/mix/pan', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setPan(1, 0);
  assert.equal(last(sent).address, '/ch/01/mix/pan');
  assert.ok(Math.abs(last(sent).args[0].value - 0.5) < 0.0001, 'center pan = 0.5');
});

test('setPan(ch, -1.0) sends 0.0 (hard left)', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setPan(1, -1.0);
  assert.ok(Math.abs(last(sent).args[0].value - 0.0) < 0.0001);
});

test('setPan(ch, +1.0) sends 1.0 (hard right)', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setPan(1, 1.0);
  assert.ok(Math.abs(last(sent).args[0].value - 1.0) < 0.0001);
});

test('setPan out-of-range throws', async () => {
  const { mixer } = makeMixer();
  await assert.rejects(() => mixer.setPan(1, 2.0), /Pan out of range/);
  await assert.rejects(() => mixer.setPan(1, -2.0), /Pan out of range/);
});

// ─── SECTION 12: Bus send / assign wire bytes ─────────────────────────────────

test('setSendLevel sends /ch/NN/mix/BB/level with float', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setSendLevel(1, 3, 0.75);
  assert.equal(last(sent).address, '/ch/01/mix/03/level');
  assert.equal(last(sent).args[0].type, 'f');
  assert.ok(Math.abs(last(sent).args[0].value - 0.75) < 0.00001);
});

test('setSendLevel bus pads to 2 digits', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setSendLevel(5, 1, 0.5);
  assert.equal(last(sent).address, '/ch/05/mix/01/level');
});

test('setSendLevel out-of-range bus throws', async () => {
  const { mixer } = makeMixer();
  await assert.rejects(() => mixer.setSendLevel(1, 0, 0.5), /Bus out of range/);
  await assert.rejects(() => mixer.setSendLevel(1, 17, 0.5), /Bus out of range/);
});

test('assignToBus sends /ch/NN/mix/BB/on with integer', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.assignToBus(2, 4, true);
  assert.equal(last(sent).address, '/ch/02/mix/04/on');
  assert.equal(last(sent).args[0].value, 1);
});

test('assignToBus disabled sends 0', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.assignToBus(2, 4, false);
  assert.equal(last(sent).args[0].value, 0);
});

// ─── SECTION 13: DCA bitmask wire bytes ───────────────────────────────────────

test('assignToDca queries /ch/NN/grp/dca then sends updated bitmask', async () => {
  const { mixer, sent } = makeMixer();
  // Mock OSC query to return current bitmask = 0 (no DCAs assigned)
  mixer._osc.query = async () => ({ args: [{ value: 0 }] });
  await mixer.assignToDca(1, 1, true); // assign to DCA 1
  const msg = last(sent);
  assert.equal(msg.address, '/ch/01/grp/dca');
  assert.equal(msg.args[0].value, 1, 'bit 0 set for DCA 1');
});

test('assignToDca DCA 3 sets bit 2 (value 4)', async () => {
  const { mixer, sent } = makeMixer();
  mixer._osc.query = async () => ({ args: [{ value: 0 }] });
  await mixer.assignToDca(1, 3, true);
  const msg = last(sent);
  assert.equal(msg.args[0].value, 4, '1 << (3-1) = 4');
});

test('assignToDca preserve existing bits', async () => {
  const { mixer, sent } = makeMixer();
  // Channel already in DCA 1 (bit 0 = 1)
  mixer._osc.query = async () => ({ args: [{ value: 1 }] });
  await mixer.assignToDca(1, 2, true); // add DCA 2
  const msg = last(sent);
  assert.equal(msg.args[0].value, 3, 'bit 0 + bit 1 = 3');
});

test('assignToDca unassign clears bit', async () => {
  const { mixer, sent } = makeMixer();
  // In DCA 1 and 2
  mixer._osc.query = async () => ({ args: [{ value: 3 }] });
  await mixer.assignToDca(1, 1, false);
  const msg = last(sent);
  assert.equal(msg.args[0].value, 2, 'bit 1 remains after clearing bit 0');
});

test('assignToDca out-of-range throws', async () => {
  const { mixer } = makeMixer();
  await assert.rejects(() => mixer.assignToDca(1, 0, true), /DCA out of range/);
  await assert.rejects(() => mixer.assignToDca(1, 9, true), /DCA out of range/);
});

// ─── SECTION 14: Preamp / phantom wire bytes ──────────────────────────────────

test('setPreampGain sends /ch/NN/preamp/trim with float (0dB = 0.5)', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setPreampGain(1, 0);
  assert.equal(last(sent).address, '/ch/01/preamp/trim');
  assert.ok(Math.abs(last(sent).args[0].value - 0.5) < 0.0001);
});

test('setPreampGain -18dB → float 0.0', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setPreampGain(1, -18);
  assert.ok(Math.abs(last(sent).args[0].value - 0.0) < 0.0001);
});

test('setPreampGain +18dB → float 1.0', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setPreampGain(1, 18);
  assert.ok(Math.abs(last(sent).args[0].value - 1.0) < 0.0001);
});

test('setPreampGain out-of-range throws', async () => {
  const { mixer } = makeMixer();
  await assert.rejects(() => mixer.setPreampGain(1, 20), /out of range/);
  await assert.rejects(() => mixer.setPreampGain(1, -20), /out of range/);
});

test('setPhantom sends /headamp/NNN/phantom with integer', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setPhantom(1, true);
  assert.equal(last(sent).address, '/headamp/000/phantom');
  assert.equal(last(sent).args[0].value, 1);
});

test('setPhantom ch 1 → headamp 000, ch 32 → headamp 031', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setPhantom(32, true);
  assert.equal(last(sent).address, '/headamp/031/phantom');
});

test('setPhantom false sends 0', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setPhantom(1, false);
  assert.equal(last(sent).args[0].value, 0);
});

// ─── SECTION 15: Color / Icon scribble strip ─────────────────────────────────

test('setChannelColor sends /ch/NN/config/color with integer', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setChannelColor(1, 'red');
  assert.equal(last(sent).address, '/ch/01/config/color');
  assert.equal(last(sent).args[0].type, 'i');
  assert.equal(last(sent).args[0].value, normalizeColor('red'));
});

test('setChannelColor by number', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setChannelColor(1, 3);
  assert.equal(last(sent).args[0].value, 3);
});

test('setChannelIcon sends /ch/NN/config/icon with integer', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setChannelIcon(1, 'mic');
  assert.equal(last(sent).address, '/ch/01/config/icon');
  assert.equal(last(sent).args[0].type, 'i');
  assert.equal(last(sent).args[0].value, normalizeIcon('mic'));
});

// ─── SECTION 16: no-op stubs for unimplemented X32 features ──────────────────

test('muteDca logs warning and does not throw', async () => {
  const { mixer } = makeMixer();
  // Stub console.warn to suppress noise
  const orig = console.warn;
  const warns = [];
  console.warn = (...a) => warns.push(a.join(' '));
  await mixer.muteDca(1);
  console.warn = orig;
  assert.ok(warns.some(w => w.includes('X32')), 'should warn about X32 limitation');
});

test('activateMuteGroup logs warning and does not throw', async () => {
  const { mixer } = makeMixer();
  const orig = console.warn;
  const warns = [];
  console.warn = (...a) => warns.push(a.join(' '));
  await mixer.activateMuteGroup(1);
  console.warn = orig;
  assert.ok(warns.some(w => w.includes('X32')));
});

test('pressSoftKey logs warning and does not throw', async () => {
  const { mixer } = makeMixer();
  const orig = console.warn;
  const warns = [];
  console.warn = (...a) => warns.push(a.join(' '));
  await mixer.pressSoftKey(1);
  console.warn = orig;
  assert.ok(warns.some(w => w.includes('X32')));
});

// ─── SECTION 17: Error guard — no OSC connection ─────────────────────────────

test('muteChannel throws when _osc is null', async () => {
  const mixer = new BehringerMixer({ host: '192.168.1.1' });
  await assert.rejects(() => mixer.muteChannel(1), /not connected/);
});

test('setFader throws when _osc is null', async () => {
  const mixer = new BehringerMixer({ host: '192.168.1.1' });
  await assert.rejects(() => mixer.setFader(1, 0.5), /not connected/);
});

test('recallScene throws when _osc is null', async () => {
  const mixer = new BehringerMixer({ host: '192.168.1.1' });
  await assert.rejects(() => mixer.recallScene(1), /not connected/);
});

// ─── SECTION 18: Wire bytes for headamp gain ──────────────────────────────────

test('setHeadampGain sends /headamp/NNN/gain with float', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setHeadampGain(1, 24);
  assert.equal(last(sent).address, '/headamp/000/gain');
  assert.equal(last(sent).args[0].type, 'f');
  const expected = headampGainToFloat(24); // (24 + 12) / 72 = 0.5
  assert.ok(Math.abs(last(sent).args[0].value - 0.5) < 0.0001);
});

test('setHeadampGain ch 16 → headamp 015', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setHeadampGain(16, 0);
  assert.equal(last(sent).address, '/headamp/015/gain');
});

test('setHeadampGain out-of-range throws', async () => {
  const { mixer } = makeMixer();
  await assert.rejects(() => mixer.setHeadampGain(1, 70), /out of range/);
  await assert.rejects(() => mixer.setHeadampGain(1, -20), /out of range/);
});

// ─── SECTION 19: OSC encode/decode roundtrip stress ──────────────────────────

test('encodeMessage round-trips large integer values', () => {
  for (const n of [0, 1, 127, 255, 32767, 2147483647]) {
    const buf = encodeMessage('/test', [{ type: 'i', value: n }]);
    const decoded = decodeMessage(buf);
    assert.equal(decoded.args[0].value, n, `round-trip failed for ${n}`);
  }
});

test('encodeMessage round-trips representative floats', () => {
  for (const f of [0.0, 0.25, 0.5, 0.75, 1.0]) {
    const buf = encodeMessage('/test', [{ type: 'f', value: f }]);
    const decoded = decodeMessage(buf);
    assert.ok(Math.abs(decoded.args[0].value - f) < 0.00001, `round-trip failed for ${f}`);
  }
});

test('encodeMessage handles empty string argument', () => {
  const buf = encodeMessage('/ch/01/config/name', [{ type: 's', value: '' }]);
  const decoded = decodeMessage(buf);
  assert.equal(decoded.args[0].value, '');
});

test('encodeMessage handles special characters in strings', () => {
  const buf = encodeMessage('/test', [{ type: 's', value: 'Kick DR' }]);
  const decoded = decodeMessage(buf);
  assert.equal(decoded.args[0].value, 'Kick DR');
});
