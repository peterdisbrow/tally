/**
 * Allen & Heath Avantis Wire-Level Tests
 *
 * Verifies that TCP MIDI messages sent to the Avantis/dLive produce the
 * correct wire bytes and that incoming MIDI updates live state correctly.
 *
 * Avantis NRPN wire format (7 bytes with running status):
 *   [0xB0|ch] 0x63 <channel>   ← CC99 = NRPN MSB (channel number)
 *              0x62 <param>    ← CC98 = NRPN LSB (parameter ID)
 *              0x06 <value>    ← CC6  = Data Entry MSB (7-bit value)
 *
 * Mute wire format (3 bytes, Note On):
 *   [0x90|ch] <note> <velocity>
 *   velocity ≥ 0x40 = muted, velocity < 0x40 = unmuted
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { AvantisMixer } = require('../src/mixers/avantis');

// ─── HELPERS ─────────────────────────────────────────────────────────────────

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

/** Create an AvantisMixer with TCP mocked and online, using default base channel 0x0B (ch 12). */
function makeMixer(opts = {}) {
  const mixer = new AvantisMixer({ host: '192.168.1.10', baseMidiChannel: 0x0B, ...opts });
  const mockTcp = makeMockTcp();
  mixer._tcp    = mockTcp;
  mixer._online = true;
  return { mixer, sent: mockTcp.sent };
}

const last = (arr) => arr[arr.length - 1];

// Base MIDI channel 0x0B = 11
// Input channel offset  0 → MIDI ch 0x0B = 11 → status 0xBB (CC) / 0x9B (Note On)
// MIX channel offset    2 → MIDI ch 0x0D = 13 → status 0xBD (CC) / 0x9D (Note On)
// DCA channel offset    4 → MIDI ch 0x0F = 15 → status 0xBF (CC) / 0x9F (Note On)

// ─── SECTION 1: buildNrpn wire bytes ─────────────────────────────────────────

describe('Avantis buildNrpn — wire bytes', () => {
  it('setFader(ch=1) sends 7-byte NRPN with CC99/CC98/CC6', async () => {
    const { mixer, sent } = makeMixer();
    await mixer.setFader(1, 1.0); // channel 0 (0-indexed), max level
    const msg = last(sent);
    // 7 bytes: status, CC99, ch, CC98, param, CC6, value
    assert.equal(msg.length, 7, 'NRPN is 7 bytes with running status');
    assert.equal(msg[0], 0xBB, 'CC status byte for MIDI ch 11 (input)');
    assert.equal(msg[1], 0x63, 'CC99 = NRPN MSB');
    assert.equal(msg[2], 0x00, 'channel index 0');
    assert.equal(msg[3], 0x62, 'CC98 = NRPN LSB');
    assert.equal(msg[4], 0x17, 'NRPN.FADER = 0x17');
    assert.equal(msg[5], 0x06, 'CC6 = Data Entry MSB');
    assert.equal(msg[6], 0x7F, 'max level = 127');
  });

  it('setFader(ch=1, 0.0) sends value 0', async () => {
    const { mixer, sent } = makeMixer();
    await mixer.setFader(1, 0.0);
    const msg = last(sent);
    assert.equal(msg[6], 0x00, '-inf fader = 0');
  });

  it('setFader uses the input MIDI channel (base + 0)', async () => {
    const { mixer, sent } = makeMixer({ baseMidiChannel: 0x00 });
    await mixer.setFader(1, 0.5);
    const msg = last(sent);
    assert.equal(msg[0], 0xB0, 'CC status for MIDI ch 0 (base=0, input offset=0)');
  });

  it('setDcaFader uses DCA MIDI channel (base + 4)', async () => {
    const { mixer, sent } = makeMixer({ baseMidiChannel: 0x00 });
    await mixer.setDcaFader(1, 0.5);
    const msg = last(sent);
    assert.equal(msg[0], 0xB4, 'CC status for MIDI ch 4 (base=0, DCA offset=4)');
  });

  it('channel index is 0-based in wire message (ch=3 → index=2)', async () => {
    const { mixer, sent } = makeMixer();
    await mixer.setFader(3, 0.5);
    const msg = last(sent);
    assert.equal(msg[2], 0x02, 'channel 3 (1-based) → index 2 (0-based)');
  });
});

// ─── SECTION 2: mute control — Note On wire bytes ────────────────────────────

describe('Avantis mute — Note On wire bytes', () => {
  it('muteChannel(1) sends Note On with velocity 0x7F on input channel', async () => {
    const { mixer, sent } = makeMixer();
    await mixer.muteChannel(1);
    const msg = last(sent);
    assert.equal(msg.length, 3);
    assert.equal(msg[0], 0x9B, 'Note On status for MIDI ch 11 (input)');
    assert.equal(msg[1], 0x00, 'note = channel index 0');
    assert.equal(msg[2], 0x7F, 'velocity ≥ 64 = mute');
  });

  it('unmuteChannel(1) sends Note On with velocity 0x00', async () => {
    const { mixer, sent } = makeMixer();
    await mixer.unmuteChannel(1);
    const msg = last(sent);
    assert.equal(msg[2], 0x00, 'velocity 0 = unmute');
  });

  it('muteMaster() sends Note On on MIX channel (base + 2), note 0', async () => {
    const { mixer, sent } = makeMixer();
    await mixer.muteMaster();
    const msg = last(sent);
    assert.equal(msg.length, 3);
    assert.equal(msg[0], 0x9D, 'Note On for MIDI ch 13 (base=11, MIX offset=2)');
    assert.equal(msg[1], 0x00, 'note 0 = master LR');
    assert.equal(msg[2], 0x7F, 'muted');
  });

  it('unmuteMaster() sends velocity 0x00 on MIX channel', async () => {
    const { mixer, sent } = makeMixer();
    await mixer.unmuteMaster();
    const msg = last(sent);
    assert.equal(msg[0], 0x9D, 'MIX channel');
    assert.equal(msg[2], 0x00, 'unmuted');
  });

  it('muteDca(1) sends Note On on DCA channel (base + 4)', async () => {
    const { mixer, sent } = makeMixer();
    await mixer.muteDca(1);
    const msg = last(sent);
    assert.equal(msg[0], 0x9F, 'Note On for MIDI ch 15 (base=11, DCA offset=4)');
    assert.equal(msg[1], 0x00, 'DCA index 0');
    assert.equal(msg[2], 0x7F, 'muted');
  });
});

// ─── SECTION 3: bidirectional state update (_handleIncoming) ─────────────────

describe('Avantis _handleIncoming — state tracking', () => {
  it('Note On on MIX channel sets mutes["mix:0"] = true when vel >= 0x40', () => {
    const { mixer } = makeMixer();
    // MIDI ch 13 (base=11, MIX offset=2) = 0x9D, note 0, velocity 0x7F
    mixer._handleIncoming(Buffer.from([0x9D, 0x00, 0x7F]));
    assert.equal(mixer._state.mutes['mix:0'], true);
  });

  it('Note On on MIX channel sets mutes["mix:0"] = false when vel < 0x40', () => {
    const { mixer } = makeMixer();
    mixer._state.mutes['mix:0'] = true; // preset muted
    mixer._handleIncoming(Buffer.from([0x9D, 0x00, 0x00]));
    assert.equal(mixer._state.mutes['mix:0'], false);
  });

  it('Note On on input channel sets mutes["input:N"]', () => {
    const { mixer } = makeMixer();
    // MIDI ch 11 (base=11, input offset=0) = 0x9B, note 5 (ch 6), vel 0x7F
    mixer._handleIncoming(Buffer.from([0x9B, 0x05, 0x7F]));
    assert.equal(mixer._state.mutes['input:5'], true);
  });

  it('CC NRPN sequence on MIX channel updates faders["mix:N"]', () => {
    const { mixer } = makeMixer();
    // Send CC99 (param MSB = channel 0), CC98 (param LSB = FADER=0x17), CC6 (value = 107)
    // MIDI ch 13 = 0xBD
    mixer._handleIncoming(Buffer.from([0xBD, 0x63, 0x00])); // CC99: channel 0
    mixer._handleIncoming(Buffer.from([0xBD, 0x62, 0x17])); // CC98: FADER
    mixer._handleIncoming(Buffer.from([0xBD, 0x06, 0x6B])); // CC6: 107 (0dB)
    assert.equal(mixer._state.faders['mix:0'], 107);
  });
});

// ─── SECTION 4: getStatus() — regression for 'mix:0' key lookup bug ──────────
// Bug: getStatus() used to read '_state.mutes["input:main"]' which is never
// populated. muteMaster() triggers Note On on the MIX MIDI channel, which
// _handleIncoming stores under 'mix:0'. getStatus() must read that key.

describe('Avantis getStatus() — mix:0 key regression', () => {
  it('returns mainMuted=false when no mute state has been received', async () => {
    const { mixer } = makeMixer();
    const status = await mixer.getStatus();
    assert.equal(status.mainMuted, false);
  });

  it('returns mainMuted=true after muteMaster echo is processed via _handleIncoming', async () => {
    const { mixer } = makeMixer();
    // Simulate the echo-back from the console after muteMaster()
    // MIX channel = base(11) + 2 = 13 → 0x9D, note 0, velocity 0x7F
    mixer._handleIncoming(Buffer.from([0x9D, 0x00, 0x7F]));
    const status = await mixer.getStatus();
    assert.equal(status.mainMuted, true, 'getStatus() must read _state.mutes["mix:0"]');
  });

  it('returns mainMuted=false after unmuteMaster echo is processed', async () => {
    const { mixer } = makeMixer();
    mixer._state.mutes['mix:0'] = true;
    mixer._handleIncoming(Buffer.from([0x9D, 0x00, 0x00]));
    const status = await mixer.getStatus();
    assert.equal(status.mainMuted, false);
  });

  it('returns mainFader from _state.faders["mix:0"]', async () => {
    const { mixer } = makeMixer();
    mixer._state.faders['mix:0'] = 107; // 0 dB
    const status = await mixer.getStatus();
    // normalToMidiLevel roundtrip: 107/127 ≈ 0.843
    assert.ok(status.mainFader > 0.8 && status.mainFader <= 1.0,
      `mainFader ${status.mainFader} should reflect faders["mix:0"]=107`);
  });

  it('returns online=true from mocked tcp.isOnline()', async () => {
    const { mixer } = makeMixer();
    const status = await mixer.getStatus();
    assert.equal(status.online, true);
  });
});
