/**
 * Allen & Heath dLive / Avantis wire-level tests (protocol tables: dLive MIDI over
 * TCP V2.0, Avantis TCP/IP Protocol V1.10). A fake transport records every byte;
 * it answers the Avantis name-request liveness probe and dLive Get requests from
 * a tiny state so the driver's verify paths run.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { AvantisMixer, _internals } = require('../src/mixers/avantis');

for (const k of ['log', 'info', 'warn']) console[k] = (...a) => process.stderr.write(a.join(' ') + '\n');

const HDR = [0xF0, 0x00, 0x00, 0x1A, 0x50, 0x10, 0x01, 0x00];

function makeMixer(model = 'Avantis', opts = {}) {
  const mixer = new AvantisMixer({ host: '192.168.1.10', model, ...opts });
  const sent = [];
  const st = { mutes: {}, lv: {} };
  const tcp = {
    online: true,
    send(bytes) {
      const b = Array.from(bytes);
      sent.push(b);
      // Track sets (full status bytes are always sent by the driver).
      for (let i = 0; i + 2 < b.length; i++) {
        if ((b[i] & 0xF0) === 0x90 && b[i + 2] !== 0) st.mutes[`${b[i] & 0x0F}:${b[i + 1]}`] = b[i + 2] >= 0x40;
      }
      if ((b[0] & 0xF0) === 0xB0 && b[1] === 0x63 && b[4] === 0x62 && b[7] === 0x06) st.lv[`${b[0] & 0x0F}:${b[2]}:${b[5]}`] = b[8];
      if (b[0] === 0xF0) {
        const ch = b[8], cmd = b[9];
        const reply = (m) => setImmediate(() => mixer._handleIncoming(Uint8Array.from(m)));
        if (cmd === 0x01) reply([...HDR, ch, 0x02, b[10], 0x46, 0x4F, 0xF7]);
        if (cmd === 0x05 && b[10] === 0x09) reply([0x90 | ch, b[11], st.mutes[`${ch}:${b[11]}`] ? 0x7F : 0x3F]);
        if (cmd === 0x05 && b[10] === 0x0B) reply([0xB0 | ch, 0x63, b[12], 0xB0 | ch, 0x62, b[11], 0xB0 | ch, 0x06, st.lv[`${ch}:${b[12]}:${b[11]}`] ?? 0x6B]);
      }
      return true;
    },
    on() {}, disconnect() {},
  };
  mixer._tcp = tcp;
  mixer._online = true;
  const sets = () => sent.filter((b) => b[0] !== 0xF0);
  return { mixer, sent, sets };
}
const last = (a) => a[a.length - 1];

describe('A&H level law (X32 position law ↔ LV table)', () => {
  it('matches the protocol table: 0 dB = 6B, +10 = 7F, −10 = 57, −40 = 1B, −inf = 00', () => {
    assert.equal(_internals.normalToLv(0.75), 0x6B);
    assert.equal(_internals.normalToLv(1), 0x7F);
    assert.equal(_internals.normalToLv(0.5), 0x57);
    assert.equal(_internals.normalToLv(0), 0);
    assert.equal(_internals.lvToNormal(0x6B), 0.75);
    assert.equal(_internals.lvToNormal(0), 0);
  });
  it('dLive HPF formula: 20 Hz = 00, 100 Hz = 20', () => {
    assert.equal(_internals.hzToHpf(20), 0);
    assert.equal(_internals.hzToHpf(100), 0x20);
  });
});

describe('wire bytes (default base MIDI channel 12 → 0x0B)', () => {
  it('input fader = 9-byte NRPN on N (BB 63 CH BB 62 17 BB 06 LV)', async () => {
    const { mixer, sets } = makeMixer();
    await mixer.setFader(3, 0.75);
    assert.deepEqual(last(sets()), [0xBB, 0x63, 0x02, 0xBB, 0x62, 0x17, 0xBB, 0x06, 0x6B]);
  });
  it('mute ON = vel 7F then vel 00; mute OFF = vel 3F then vel 00 (never a bare 00)', async () => {
    const { mixer, sets } = makeMixer();
    await mixer.muteChannel(1);
    assert.deepEqual(last(sets()), [0x9B, 0x00, 0x7F, 0x9B, 0x00, 0x00]);
    await mixer.unmuteChannel(1);
    assert.deepEqual(last(sets()), [0x9B, 0x00, 0x3F, 0x9B, 0x00, 0x00]);
  });
  it('master = Main 1 = N+4 note 30 (not Mix/Aux 1 on N+2)', async () => {
    const { mixer, sets } = makeMixer();
    await mixer.muteMaster();
    assert.deepEqual(last(sets()), [0x9F, 0x30, 0x7F, 0x9F, 0x30, 0x00]);
  });
  it('DCA n = N+4 note 35+n; Avantis mute group n = 45+n; dLive mute group n = 4D+n', async () => {
    const { mixer, sets } = makeMixer();
    await mixer.muteDca(1);
    assert.deepEqual(last(sets()).slice(0, 3), [0x9F, 0x36, 0x7F]);
    await mixer.activateMuteGroup(1);
    assert.deepEqual(last(sets()).slice(0, 3), [0x9F, 0x46, 0x7F]);
    const d = makeMixer('dLive');
    await d.mixer.activateMuteGroup(1);
    assert.deepEqual(last(d.sets()).slice(0, 3), [0x9F, 0x4E, 0x7F]);
  });
  it('base MIDI channel from the booth setting (midiChannel, 0-based) is used', async () => {
    const { mixer, sets } = makeMixer('Avantis', { midiChannel: 0 });
    await mixer.muteChannel(1);
    assert.equal(last(sets())[0], 0x90);
    await mixer.setDcaFader(1, 0.75);
    assert.deepEqual(last(sets()), [0xB4, 0x63, 0x36, 0xB4, 0x62, 0x17, 0xB4, 0x06, 0x6B]);
  });
  it('name SysEx carries the real MIDI channel (0N = N), not the type offset', async () => {
    const { mixer, sent } = makeMixer();
    await mixer.setChannelName(2, 'FO');
    const set = sent.find((b) => b[0] === 0xF0 && b[9] === 0x03);
    assert.deepEqual(set, [...HDR, 0x0B, 0x03, 0x01, 0x46, 0x4F, 0xF7]);
  });
  it('scene 130 = BN 00 01, CN 01 on the base channel', async () => {
    const { mixer, sets } = makeMixer();
    await mixer.recallScene(130);
    assert.deepEqual(sets().find((b) => (b[0] & 0xF0) === 0xB0 && b[1] === 0x00), [0xBB, 0x00, 0x01, 0xCB, 0x01]);
  });
});

describe('incoming state', () => {
  it('velocity 00 ("note off") never flips a mute to unmuted', () => {
    const { mixer } = makeMixer();
    mixer._handleIncoming(Uint8Array.from([0x9F, 0x30, 0x7F]));
    mixer._handleIncoming(Uint8Array.from([0x9F, 0x30, 0x00]));
    assert.equal(mixer._state.mutes['main:0'], true);
    mixer._handleIncoming(Uint8Array.from([0x9F, 0x30, 0x3F]));
    assert.equal(mixer._state.mutes['main:0'], false);
  });
  it('N+4 notes map to main / dca / mute group keys', () => {
    const { mixer } = makeMixer('dLive');
    mixer._handleIncoming(Uint8Array.from([0x9F, 0x37, 0x7F]));
    mixer._handleIncoming(Uint8Array.from([0x9F, 0x4F, 0x7F]));
    assert.equal(mixer._state.mutes['dca:1'], true);
    assert.equal(mixer._state.mutes['muteGroup:1'], true);
  });
  it('getStatus: unknown master mute/fader are null, not false/0', async () => {
    const { mixer } = makeMixer();
    const s = await mixer.getStatus();
    assert.equal(s.online, true);
    assert.equal(s.mainMuted, null);
    assert.equal(s.mainFader, null);
  });
});
