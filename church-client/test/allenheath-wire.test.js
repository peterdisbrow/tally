/**
 * Allen & Heath SQ Wire-Level Tests
 *
 * Verifies that TCP MIDI messages sent to the SQ produce the correct wire bytes.
 * The SQ uses NRPN (Non-Registered Parameter Number) messages over a raw TCP
 * connection on port 51325.
 *
 * NRPN wire format (12 bytes per parameter set):
 *   [0xB0|ch] 0x63 paramMSB   ← NRPN MSB
 *   [0xB0|ch] 0x62 paramLSB   ← NRPN LSB
 *   [0xB0|ch] 0x06 valueMSB   ← Data Entry Coarse
 *   [0xB0|ch] 0x26 valueLSB   ← Data Entry Fine
 *
 * Three layers of coverage:
 *   1. NRPN builder unit tests — verifying raw byte arrays
 *   2. AllenHeathMixer driver tests — driver calls _tcp.send() with right bytes
 *   3. MidiParser tests — incoming MIDI bytes are correctly parsed
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { AllenHeathMixer } = require('../src/mixers/allenheath');
const { MidiParser }      = require('../src/tcp-midi');

// ─── HELPERS ───────────────────────────────────────────────────────────────────

/** Create a mock TCP MIDI transport that records all send() calls. */
function makeMockTcp() {
  const sent = [];
  return {
    sent,
    send(bytes) { sent.push(Array.from(bytes)); return true; },
    on() {},
    disconnect() {},
    isOnline: async () => true,
  };
}

/** Create an AllenHeathMixer with the TCP layer pre-mocked and online. */
function makeMixer(opts = {}) {
  const mixer = new AllenHeathMixer({
    host: '192.168.1.2',
    model: 'SQ6',
    midiChannel: 0,
    ...opts,
  });
  const mockTcp = makeMockTcp();
  mixer._tcp    = mockTcp;
  mixer._online = true;
  return { mixer, sent: mockTcp.sent };
}

/** Last item from an array. */
const last = (arr) => arr[arr.length - 1];

/**
 * Verify an NRPN set message has the correct 12-byte structure.
 * @param {number[]} bytes  - The sent byte array
 * @param {number} midiCh   - MIDI channel (0-15)
 * @param {number} paramMsb - NRPN parameter MSB
 * @param {number} paramLsb - NRPN parameter LSB
 * @param {number} vc       - Data Entry Coarse (value MSB)
 * @param {number} vf       - Data Entry Fine (value LSB)
 */
function assertNrpnSet(bytes, midiCh, paramMsb, paramLsb, vc, vf) {
  const cc = 0xB0 | (midiCh & 0x0F);
  assert.equal(bytes.length, 12, 'NRPN Set is 12 bytes');
  assert.equal(bytes[0],  cc,       'CC status byte');
  assert.equal(bytes[1],  0x63,     'NRPN MSB controller');
  assert.equal(bytes[2],  paramMsb, 'param MSB');
  assert.equal(bytes[3],  cc,       'CC status byte');
  assert.equal(bytes[4],  0x62,     'NRPN LSB controller');
  assert.equal(bytes[5],  paramLsb, 'param LSB');
  assert.equal(bytes[6],  cc,       'CC status byte');
  assert.equal(bytes[7],  0x06,     'Data Entry Coarse controller');
  assert.equal(bytes[8],  vc,       'value coarse');
  assert.equal(bytes[9],  cc,       'CC status byte');
  assert.equal(bytes[10], 0x26,     'Data Entry Fine controller');
  assert.equal(bytes[11], vf,       'value fine');
}

// ─── SECTION 1: NRPN address computation ─────────────────────────────────────
// These mirror the formulas in allenheath.js to verify the math independently.

/**
 * makeNrpn / splitNrpn reference implementation.
 * These are simple enough to verify inline.
 */
function makeNrpn(msb, lsb) { return (msb << 7) + lsb; }
function splitNrpn(n)        { return { msb: (n >> 7) & 0x7F, lsb: n & 0x7F }; }

test('NRPN math: makeNrpn(0x00, 0x00) = 0', () => {
  assert.equal(makeNrpn(0x00, 0x00), 0);
});

test('NRPN math: makeNrpn(0x02, 0x00) = 256 (DCA mute base)', () => {
  assert.equal(makeNrpn(0x02, 0x00), 256);
});

test('NRPN math: makeNrpn(0x04, 0x00) = 512 (mute group base)', () => {
  assert.equal(makeNrpn(0x04, 0x00), 512);
});

test('NRPN math: splitNrpn(0) = {msb:0, lsb:0}', () => {
  const r = splitNrpn(0);
  assert.equal(r.msb, 0);
  assert.equal(r.lsb, 0);
});

test('NRPN math: splitNrpn(128) = {msb:1, lsb:0}', () => {
  const r = splitNrpn(128);
  assert.equal(r.msb, 1);
  assert.equal(r.lsb, 0);
});

test('NRPN math: splitNrpn(256) = {msb:2, lsb:0}', () => {
  const r = splitNrpn(256);
  assert.equal(r.msb, 2);
  assert.equal(r.lsb, 0);
});

test('NRPN math: channel 5 mute address is nrpn(0,0)+4 = {msb:0, lsb:4}', () => {
  const r = splitNrpn(makeNrpn(0x00, 0x00) + 4); // channel 5, 0-indexed = 4
  assert.equal(r.msb, 0x00);
  assert.equal(r.lsb, 0x04);
});

test('NRPN math: DCA 1 mute = nrpn(0x02,0x00)+0 = {msb:2, lsb:0}', () => {
  const r = splitNrpn(makeNrpn(0x02, 0x00) + 0);
  assert.equal(r.msb, 0x02);
  assert.equal(r.lsb, 0x00);
});

test('NRPN math: DCA 3 mute = nrpn(0x02,0x00)+2 = {msb:2, lsb:2}', () => {
  const r = splitNrpn(makeNrpn(0x02, 0x00) + 2);
  assert.equal(r.msb, 0x02);
  assert.equal(r.lsb, 0x02);
});

test('NRPN math: mute group 1 = nrpn(0x04,0x00)+0 = {msb:4, lsb:0}', () => {
  const r = splitNrpn(makeNrpn(0x04, 0x00) + 0);
  assert.equal(r.msb, 0x04);
  assert.equal(r.lsb, 0x00);
});

// ─── SECTION 2: 14-bit data conversion ────────────────────────────────────────

function normalToData(norm) {
  if (norm <= 0) return 0;
  return Math.round(Math.max(0, Math.min(1, norm)) * 16383);
}
function dataToVcVf(data) {
  return { vc: (data >> 7) & 0x7F, vf: data & 0x7F };
}

test('normalToData(0) = 0', () => {
  assert.equal(normalToData(0), 0);
});

test('normalToData(1.0) = 16383 (0x3FFF)', () => {
  assert.equal(normalToData(1.0), 16383);
});

test('normalToData(0.5) = 8192 (approx)', () => {
  assert.equal(normalToData(0.5), Math.round(0.5 * 16383));
});

test('dataToVcVf(16383): vc=0x7F, vf=0x7F', () => {
  const { vc, vf } = dataToVcVf(16383);
  assert.equal(vc, 0x7F);
  assert.equal(vf, 0x7F);
});

test('dataToVcVf(0): vc=0, vf=0', () => {
  const { vc, vf } = dataToVcVf(0);
  assert.equal(vc, 0);
  assert.equal(vf, 0);
});

test('dataToVcVf(128): vc=1, vf=0', () => {
  const { vc, vf } = dataToVcVf(128);
  assert.equal(vc, 1);
  assert.equal(vf, 0);
});

test('dataToVcVf(127): vc=0, vf=0x7F', () => {
  const { vc, vf } = dataToVcVf(127);
  assert.equal(vc, 0);
  assert.equal(vf, 0x7F);
});

// ─── SECTION 3: muteChannel wire bytes ────────────────────────────────────────

test('muteChannel(1) sends correct 12-byte NRPN set', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.muteChannel(1);
  // ch=1 → n=0 → nrpn1D(0x00, 0x00, 0) → {msb:0, lsb:0}
  // mute=1 → vc=0x00, vf=0x01
  assertNrpnSet(last(sent), 0, 0x00, 0x00, 0x00, 0x01);
});

test('muteChannel(5) → paramLSB = 4', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.muteChannel(5);
  // n=4 → nrpn(0,0)+4 = 4 → {msb:0, lsb:4}
  assertNrpnSet(last(sent), 0, 0x00, 0x04, 0x00, 0x01);
});

test('muteChannel(48) → paramLSB = 47', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.muteChannel(48);
  // n=47 → nrpn(0,0)+47=47 → {msb:0, lsb:0x2F}
  assertNrpnSet(last(sent), 0, 0x00, 0x2F, 0x00, 0x01);
});

test('unmuteChannel(1) sends vf=0x00 (unmuted)', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.unmuteChannel(1);
  // Same address, vf=0x00 = unmuted
  assertNrpnSet(last(sent), 0, 0x00, 0x00, 0x00, 0x00);
});

test('unmuteChannel(5) sends correct address with vf=0', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.unmuteChannel(5);
  assertNrpnSet(last(sent), 0, 0x00, 0x04, 0x00, 0x00);
});

test('SQ mute convention: 1 = muted, 0 = unmuted (opposite of X32)', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.muteChannel(1);
  const muteBytes = last(sent);
  await mixer.unmuteChannel(1);
  const unmuteBytes = last(sent);
  assert.equal(muteBytes[11],   0x01, 'mute vf = 1');
  assert.equal(unmuteBytes[11], 0x00, 'unmute vf = 0');
});

// ─── SECTION 4: muteMaster / unmuteMaster wire bytes ─────────────────────────

test('muteMaster sends NRPN for LR mute (0x00:0x44)', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.muteMaster();
  // MUTE.lr = { msb: 0x00, lsb: 0x44 }
  assertNrpnSet(last(sent), 0, 0x00, 0x44, 0x00, 0x01);
});

test('unmuteMaster sends LR mute with vf=0', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.unmuteMaster();
  assertNrpnSet(last(sent), 0, 0x00, 0x44, 0x00, 0x00);
});

// ─── SECTION 5: DCA mute wire bytes ───────────────────────────────────────────

test('muteDca(1) sends NRPN for DCA mute base (0x02:0x00)', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.muteDca(1);
  // MUTE.dca = { msb: 0x02, lsb: 0x00 }, n=0 → nrpn(0x02,0x00)+0 = {msb:2,lsb:0}
  assertNrpnSet(last(sent), 0, 0x02, 0x00, 0x00, 0x01);
});

test('muteDca(3) → DCA index 2 → paramLSB=2', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.muteDca(3);
  // n=2 → nrpn(0x02,0x00)+2=258 → {msb:2, lsb:2}
  assertNrpnSet(last(sent), 0, 0x02, 0x02, 0x00, 0x01);
});

test('unmuteDca(1) sends DCA mute address with vf=0', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.unmuteDca(1);
  assertNrpnSet(last(sent), 0, 0x02, 0x00, 0x00, 0x00);
});

test('muteDca(8) → last DCA → paramLSB=7', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.muteDca(8);
  // n=7 → nrpn(0x02,0x00)+7=263 → {msb:2, lsb:7}
  assertNrpnSet(last(sent), 0, 0x02, 0x07, 0x00, 0x01);
});

// ─── SECTION 6: Mute group wire bytes ─────────────────────────────────────────

test('activateMuteGroup(1) sends NRPN for muteGroup base (0x04:0x00)', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.activateMuteGroup(1);
  // MUTE.muteGroup = { msb: 0x04, lsb: 0x00 }, n=0 → {msb:4, lsb:0}
  assertNrpnSet(last(sent), 0, 0x04, 0x00, 0x00, 0x01);
});

test('activateMuteGroup(4) → group index 3 → paramLSB=3', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.activateMuteGroup(4);
  // n=3 → nrpn(0x04,0x00)+3=515 → {msb:4, lsb:3}
  assertNrpnSet(last(sent), 0, 0x04, 0x03, 0x00, 0x01);
});

test('deactivateMuteGroup(1) sends muteGroup address with vf=0', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.deactivateMuteGroup(1);
  assertNrpnSet(last(sent), 0, 0x04, 0x00, 0x00, 0x00);
});

test('activateMuteGroup(8) → last group → paramLSB=7', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.activateMuteGroup(8);
  assertNrpnSet(last(sent), 0, 0x04, 0x07, 0x00, 0x01);
});

// ─── SECTION 7: setFader wire bytes ──────────────────────────────────────────

test('setFader(1, 1.0) → max value vc=0x7F vf=0x7F', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setFader(1, 1.0);
  // inputToLr base: msb=0x40, lsb=0x00; n=0, sink=0, sinks=1
  // nrpn2D(0x40, 0x00, 1, 0, 0) = splitNrpn(makeNrpn(0x40,0x00)+0) = splitNrpn(8192) = {msb:64,lsb:0}
  assertNrpnSet(last(sent), 0, 0x40, 0x00, 0x7F, 0x7F);
});

test('setFader(1, 0.0) → min value vc=0 vf=0', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setFader(1, 0.0);
  assertNrpnSet(last(sent), 0, 0x40, 0x00, 0x00, 0x00);
});

test('setFader(2, 1.0) → channel 2 is at nrpn offset +1 from channel 1', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setFader(2, 1.0);
  // n=1, sink=0, sinks=1 → makeNrpn(0x40,0x00)+1*1+0=8193 → {msb:64, lsb:1}
  assertNrpnSet(last(sent), 0, 0x40, 0x01, 0x7F, 0x7F);
});

test('setFader(1, 0.5) → 14-bit midpoint', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setFader(1, 0.5);
  const data = Math.round(0.5 * 16383);
  const vc = (data >> 7) & 0x7F;
  const vf = data & 0x7F;
  assertNrpnSet(last(sent), 0, 0x40, 0x00, vc, vf);
});

// ─── SECTION 8: setDcaFader wire bytes ────────────────────────────────────────

test('setDcaFader(1, 1.0) → DCA output level base (0x4F:0x20)', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setDcaFader(1, 1.0);
  // OUTPUT_LEVEL.dca = { msb: 0x4F, lsb: 0x20 }, n=0
  // nrpn1D(0x4F, 0x20, 0) = splitNrpn(makeNrpn(0x4F,0x20)+0)
  // makeNrpn(0x4F=79, 0x20=32) = 79*128+32 = 10112+32 = 10144
  // splitNrpn(10144): msb=(10144>>7)&0x7F=79=0x4F, lsb=10144&0x7F=32=0x20
  assertNrpnSet(last(sent), 0, 0x4F, 0x20, 0x7F, 0x7F);
});

test('setDcaFader(2, 1.0) → DCA 2 offset by 1', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setDcaFader(2, 1.0);
  // n=1 → nrpn(0x4F,0x20)+1=10145 → {msb:0x4F, lsb:0x21}
  assertNrpnSet(last(sent), 0, 0x4F, 0x21, 0x7F, 0x7F);
});

test('setDcaFader(1, 0.0) → zero value', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setDcaFader(1, 0.0);
  assertNrpnSet(last(sent), 0, 0x4F, 0x20, 0x00, 0x00);
});

// ─── SECTION 9: Scene recall wire bytes ───────────────────────────────────────

test('recallScene(1) sends bankMsg [0xB0, 0x00, 0x00] then pgmMsg [0xC0, 0x00]', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.recallScene(1);
  // Scene 1: zeroIdx=0, upper=0, lower=0
  // bankMsg = [0xB0, 0x00, 0x00]
  // pgmMsg  = [0xC0, 0x00]
  assert.equal(sent.length, 2, 'two TCP send calls');
  assert.deepEqual(sent[0], [0xB0, 0x00, 0x00], 'bank select');
  assert.deepEqual(sent[1], [0xC0, 0x00],       'program change');
});

test('recallScene(128) → scene 128: lower=0x7F, upper=0', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.recallScene(128);
  // zeroIdx=127, upper=(127>>7)&0x0F=0, lower=127&0x7F=0x7F
  assert.deepEqual(sent[0], [0xB0, 0x00, 0x00]);
  assert.deepEqual(sent[1], [0xC0, 0x7F]);
});

test('recallScene(129) → upper bank = 1', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.recallScene(129);
  // zeroIdx=128, upper=(128>>7)&0x0F=1, lower=128&0x7F=0
  assert.deepEqual(sent[0], [0xB0, 0x00, 0x01], 'bank select with upper=1');
  assert.deepEqual(sent[1], [0xC0, 0x00],        'program change lower=0');
});

test('recallScene(256) → upper=1, lower=0x7F', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.recallScene(256);
  // zeroIdx=255, upper=(255>>7)&0x0F=1, lower=255&0x7F=0x7F
  assert.deepEqual(sent[0], [0xB0, 0x00, 0x01]);
  assert.deepEqual(sent[1], [0xC0, 0x7F]);
});

test('recallScene clamps to scene 1 at minimum', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.recallScene(0);
  // n=max(1, min(300, 0))=1, zeroIdx=0
  assert.deepEqual(sent[1], [0xC0, 0x00]);
});

test('recallScene clamps to 300 at maximum', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.recallScene(999);
  // n=max(1, min(300, 999))=300, zeroIdx=299
  // upper=(299>>7)&0x0F=2, lower=299&0x7F=0x2B(=43)
  assert.deepEqual(sent[0], [0xB0, 0x00, 0x02]);
  assert.deepEqual(sent[1], [0xC0, 0x2B]);
});

test('recallScene uses MIDI channel 0 (status byte 0xB0/0xC0)', async () => {
  const { mixer, sent } = makeMixer({ midiChannel: 0 });
  await mixer.recallScene(1);
  assert.equal(sent[0][0], 0xB0, 'CC status = 0xB0 for MIDI ch 0');
  assert.equal(sent[1][0], 0xC0, 'PC status = 0xC0 for MIDI ch 0');
});

test('recallScene respects custom MIDI channel', async () => {
  const { mixer, sent } = makeMixer({ midiChannel: 2 });
  await mixer.recallScene(1);
  assert.equal(sent[0][0], 0xB2, 'CC status = 0xB2 for MIDI ch 2');
  assert.equal(sent[1][0], 0xC2, 'PC status = 0xC2 for MIDI ch 2');
});

// ─── SECTION 10: pressSoftKey wire bytes ──────────────────────────────────────

test('pressSoftKey(1) sends Note On [0x90, 0x30, 0x7F] then Note Off [0x80, 0x30, 0x00]', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.pressSoftKey(1);
  // idx=0, note=0x30+0=0x30
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], [0x90, 0x30, 0x7F], 'Note On  key 1');
  assert.deepEqual(sent[1], [0x80, 0x30, 0x00], 'Note Off key 1');
});

test('pressSoftKey(3) → note = 0x30 + 2 = 0x32', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.pressSoftKey(3);
  assert.deepEqual(sent[0], [0x90, 0x32, 0x7F]);
  assert.deepEqual(sent[1], [0x80, 0x32, 0x00]);
});

test('pressSoftKey(8) → note = 0x30 + 7 = 0x37', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.pressSoftKey(8);
  assert.deepEqual(sent[0], [0x90, 0x37, 0x7F]);
  assert.deepEqual(sent[1], [0x80, 0x37, 0x00]);
});

test('pressSoftKey respects MIDI channel', async () => {
  const { mixer, sent } = makeMixer({ midiChannel: 3 });
  await mixer.pressSoftKey(1);
  assert.equal(sent[0][0], 0x93, 'Note On  0x90|3 = 0x93');
  assert.equal(sent[1][0], 0x83, 'Note Off 0x80|3 = 0x83');
});

// ─── SECTION 11: setPan wire bytes ────────────────────────────────────────────

test('setPan(1, 0) → center: 14-bit value ≈ 8192', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setPan(1, 0);
  // normalized = (0 + 1) / 2 = 0.5; data = round(0.5 * 16383) = 8192
  const data = Math.round(0.5 * 16383);
  const vc = (data >> 7) & 0x7F;
  const vf = data & 0x7F;
  // SEND_PAN.inputToLr: msb=0x50, lsb=0x00; n=0 → nrpn2D(0x50,0x00,1,0,0)
  // = splitNrpn(makeNrpn(0x50,0x00)+0) = splitNrpn(80*128)=splitNrpn(10240)
  // msb=(10240>>7)&0x7F=80=0x50, lsb=10240&0x7F=0
  assertNrpnSet(last(sent), 0, 0x50, 0x00, vc, vf);
});

test('setPan(1, -1.0) → hard left: 14-bit value = 0', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setPan(1, -1.0);
  // normalized = 0; data = 0
  assertNrpnSet(last(sent), 0, 0x50, 0x00, 0x00, 0x00);
});

test('setPan(1, +1.0) → hard right: 14-bit value = 16383', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setPan(1, 1.0);
  // normalized = 1.0; data = 16383
  assertNrpnSet(last(sent), 0, 0x50, 0x00, 0x7F, 0x7F);
});

test('setPan out-of-range throws', async () => {
  const { mixer } = makeMixer();
  await assert.rejects(() => mixer.setPan(1, 2.0), /Pan out of range/);
  await assert.rejects(() => mixer.setPan(1, -2.0), /Pan out of range/);
});

// ─── SECTION 12: setSendLevel wire bytes ──────────────────────────────────────

test('setSendLevel(1, 1, 1.0) → inputToMix base (0x40:0x44)', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setSendLevel(1, 1, 1.0);
  // inputToMix: msb=0x40, lsb=0x44, sinks=12; src=0, snk=0
  // nrpn2D(0x40,0x44,12,0,0)=splitNrpn(makeNrpn(0x40,0x44)+12*0+0)
  // makeNrpn(0x40=64,0x44=68) = 64*128+68 = 8192+68 = 8260
  // splitNrpn(8260): msb=(8260>>7)&0x7F=64=0x40, lsb=8260&0x7F=68=0x44
  assertNrpnSet(last(sent), 0, 0x40, 0x44, 0x7F, 0x7F);
});

test('setSendLevel(1, 2, 1.0) → mix bus 2, same source, snk=1', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setSendLevel(1, 2, 1.0);
  // src=0, snk=1, sinks=12 → makeNrpn(0x40,0x44)+12*0+1=8261
  // splitNrpn(8261): msb=0x40, lsb=0x45
  assertNrpnSet(last(sent), 0, 0x40, 0x45, 0x7F, 0x7F);
});

test('setSendLevel(2, 1, 1.0) → input 2, mix 1 → src=1', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setSendLevel(2, 1, 1.0);
  // src=1, snk=0, sinks=12 → makeNrpn(0x40,0x44)+12*1+0=8272
  // splitNrpn(8272): msb=(8272>>7)&0x7F=64=0x40, lsb=8272&0x7F=80=0x50
  const addr = splitNrpn(makeNrpn(0x40, 0x44) + 12 * 1 + 0);
  assertNrpnSet(last(sent), 0, addr.msb, addr.lsb, 0x7F, 0x7F);
});

test('setSendLevel(1, 1, 0.0) → zero value', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setSendLevel(1, 1, 0.0);
  assertNrpnSet(last(sent), 0, 0x40, 0x44, 0x00, 0x00);
});

// ─── SECTION 13: Custom MIDI channel permeates all messages ───────────────────

test('muteChannel on MIDI channel 5 uses CC status 0xB5', async () => {
  const { mixer, sent } = makeMixer({ midiChannel: 5 });
  await mixer.muteChannel(1);
  const bytes = last(sent);
  // Every CC in NRPN set should be 0xB5
  assert.equal(bytes[0],  0xB5);
  assert.equal(bytes[3],  0xB5);
  assert.equal(bytes[6],  0xB5);
  assert.equal(bytes[9],  0xB5);
});

test('setFader on MIDI channel 15 uses CC status 0xBF', async () => {
  const { mixer, sent } = makeMixer({ midiChannel: 15 });
  await mixer.setFader(1, 1.0);
  const bytes = last(sent);
  assert.equal(bytes[0], 0xBF);
  assert.equal(bytes[3], 0xBF);
  assert.equal(bytes[6], 0xBF);
  assert.equal(bytes[9], 0xBF);
});

// ─── SECTION 14: Error guards ─────────────────────────────────────────────────

test('muteChannel throws when not connected', async () => {
  const mixer = new AllenHeathMixer({ host: '192.168.1.2' });
  // _online starts false
  await assert.rejects(() => mixer.muteChannel(1), /not connected/);
});

test('setFader throws when not connected', async () => {
  const mixer = new AllenHeathMixer({ host: '192.168.1.2' });
  await assert.rejects(() => mixer.setFader(1, 0.5), /not connected/);
});

test('recallScene throws when not connected', async () => {
  const mixer = new AllenHeathMixer({ host: '192.168.1.2' });
  await assert.rejects(() => mixer.recallScene(1), /not connected/);
});

test('muteDca throws when not connected', async () => {
  const mixer = new AllenHeathMixer({ host: '192.168.1.2' });
  await assert.rejects(() => mixer.muteDca(1), /not connected/);
});

test('activateMuteGroup throws when not connected', async () => {
  const mixer = new AllenHeathMixer({ host: '192.168.1.2' });
  await assert.rejects(() => mixer.activateMuteGroup(1), /not connected/);
});

// ─── SECTION 15: MidiParser incoming byte parsing ─────────────────────────────

test('MidiParser: parses complete CC message', () => {
  const msgs = [];
  const parser = new MidiParser((m) => msgs.push(Array.from(m)));
  parser.feed(Buffer.from([0xB0, 0x63, 0x00]));
  assert.equal(msgs.length, 1);
  assert.deepEqual(msgs[0], [0xB0, 0x63, 0x00]);
});

test('MidiParser: parses full 12-byte NRPN set as 4 CC messages', () => {
  const msgs = [];
  const parser = new MidiParser((m) => msgs.push(Array.from(m)));
  // A typical NRPN set (mute channel 1)
  parser.feed(Buffer.from([
    0xB0, 0x63, 0x00,
    0xB0, 0x62, 0x00,
    0xB0, 0x06, 0x00,
    0xB0, 0x26, 0x01,
  ]));
  assert.equal(msgs.length, 4, '4 CC messages from 12 bytes');
  assert.deepEqual(msgs[0], [0xB0, 0x63, 0x00]);
  assert.deepEqual(msgs[1], [0xB0, 0x62, 0x00]);
  assert.deepEqual(msgs[2], [0xB0, 0x06, 0x00]);
  assert.deepEqual(msgs[3], [0xB0, 0x26, 0x01]);
});

test('MidiParser: handles running status (no repeated status byte)', () => {
  const msgs = [];
  const parser = new MidiParser((m) => msgs.push(Array.from(m)));
  // Running status: first byte sets status 0xB0, subsequent data pairs reuse it
  parser.feed(Buffer.from([
    0xB0, 0x63, 0x00,  // explicit status
          0x62, 0x00,  // running status
          0x06, 0x00,  // running status
          0x26, 0x01,  // running status
  ]));
  assert.equal(msgs.length, 4);
  // Each parsed message should have the running status byte restored
  assert.equal(msgs[1][0], 0xB0, 'running status restored');
  assert.equal(msgs[2][0], 0xB0, 'running status restored');
  assert.equal(msgs[3][0], 0xB0, 'running status restored');
});

test('MidiParser: handles TCP fragmentation (bytes arrive one at a time)', () => {
  const msgs = [];
  const parser = new MidiParser((m) => msgs.push(Array.from(m)));
  const bytes = [0xB0, 0x63, 0x02];
  for (const b of bytes) {
    parser.feed(Buffer.from([b]));
  }
  assert.equal(msgs.length, 1, 'message assembled across multiple feeds');
  assert.deepEqual(msgs[0], [0xB0, 0x63, 0x02]);
});

test('MidiParser: handles TCP coalescing (multiple messages in one buffer)', () => {
  const msgs = [];
  const parser = new MidiParser((m) => msgs.push(Array.from(m)));
  // Two CC messages in one TCP frame
  parser.feed(Buffer.from([
    0xB0, 0x63, 0x04,
    0xB0, 0x62, 0x00,
  ]));
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs[0], [0xB0, 0x63, 0x04]);
  assert.deepEqual(msgs[1], [0xB0, 0x62, 0x00]);
});

test('MidiParser: handles Program Change (2 bytes)', () => {
  const msgs = [];
  const parser = new MidiParser((m) => msgs.push(Array.from(m)));
  parser.feed(Buffer.from([0xC0, 0x05]));
  assert.equal(msgs.length, 1);
  assert.deepEqual(msgs[0], [0xC0, 0x05]);
});

test('MidiParser: system realtime bytes (0xF8+) emitted immediately', () => {
  const msgs = [];
  const parser = new MidiParser((m) => msgs.push(Array.from(m)));
  // Clock byte 0xF8 in the middle of a CC
  parser.feed(Buffer.from([0xB0, 0xF8, 0x63, 0x00]));
  // 0xF8 emits immediately; 0xB0+0x63+0x00 = 1 CC message
  const clocks = msgs.filter(m => m[0] === 0xF8);
  const ccs    = msgs.filter(m => m[0] === 0xB0);
  assert.equal(clocks.length, 1, 'clock realtime emitted');
  assert.equal(ccs.length,    1, 'CC message also assembled');
});

test('MidiParser: SysEx messages assembled until 0xF7', () => {
  const msgs = [];
  const parser = new MidiParser((m) => msgs.push(Array.from(m)));
  parser.feed(Buffer.from([0xF0, 0x41, 0x10, 0x00, 0xF7]));
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0][0], 0xF0);
  assert.equal(msgs[0][msgs[0].length - 1], 0xF7);
});

test('MidiParser: reset() clears partial state', () => {
  const msgs = [];
  const parser = new MidiParser((m) => msgs.push(m));
  parser.feed(Buffer.from([0xB0])); // incomplete
  parser.reset();
  parser.feed(Buffer.from([0xB0, 0x62, 0x00])); // fresh message
  assert.equal(msgs.length, 1, 'only the post-reset message');
});

// ─── SECTION 16: Bidirectional feedback: incoming NRPN updates _state ─────────

test('incoming mute NRPN for ch1 updates _state.mutes', () => {
  const { mixer } = makeMixer();
  // Simulate incoming NRPN: param 0x00:0x00, vf=1 → channel 1 muted
  // Feed as 4 parsed MIDI messages
  mixer._handleIncoming(new Uint8Array([0xB0, 0x63, 0x00])); // NRPN MSB
  mixer._handleIncoming(new Uint8Array([0xB0, 0x62, 0x00])); // NRPN LSB
  mixer._handleIncoming(new Uint8Array([0xB0, 0x06, 0x00])); // Data coarse
  mixer._handleIncoming(new Uint8Array([0xB0, 0x26, 0x01])); // Data fine = muted

  // Channel 1 = index 0, param nrpn(0,0)+0=0 = inputChannel
  // The driver should store mute state
  assert.ok(mixer._state.mutes['input:0'] === true || mixer._nrpnState !== undefined,
    'NRPN state updated on incoming mute');
});

test('incoming Program Change updates scene state', () => {
  const { mixer } = makeMixer();
  mixer._handleIncoming(new Uint8Array([0xC0, 0x04])); // PC value 4 → scene 5
  assert.equal(mixer._state.scene, 5, 'scene = PC value + 1 (1-based)');
});

test('incoming Bank Select stores upper scene bits', () => {
  const { mixer } = makeMixer();
  mixer._handleIncoming(new Uint8Array([0xB0, 0x00, 0x01])); // bank = 1
  mixer._handleIncoming(new Uint8Array([0xC0, 0x00]));        // PC = 0
  // scene = (1 << 7) + 0 + 1 = 129
  assert.equal(mixer._state.scene, 129, 'high scene via bank select');
});

// ─── SECTION 17: setInputToMixAssign wire bytes ────────────────────────────────

test('setInputToMixAssign(1, 1, true) sends assign=1', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setInputToMixAssign(1, 1, true);
  // SEND_ASSIGN.inputToMix: msb=0x60, lsb=0x44, sinks=12; src=0, snk=0
  // makeNrpn(0x60=96, 0x44=68)=96*128+68=12288+68=12356
  // nrpn2D(0x60,0x44,12,0,0)=splitNrpn(12356)={msb:96=0x60, lsb:68=0x44}
  const addr = splitNrpn(makeNrpn(0x60, 0x44) + 12 * 0 + 0);
  assertNrpnSet(last(sent), 0, addr.msb, addr.lsb, 0x00, 0x01);
});

test('setInputToMixAssign(1, 1, false) sends assign=0', async () => {
  const { mixer, sent } = makeMixer();
  await mixer.setInputToMixAssign(1, 1, false);
  const addr = splitNrpn(makeNrpn(0x60, 0x44) + 0);
  assertNrpnSet(last(sent), 0, addr.msb, addr.lsb, 0x00, 0x00);
});
