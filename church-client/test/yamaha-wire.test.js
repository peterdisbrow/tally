/**
 * Yamaha CL/QL/TF Mixer Driver Tests
 *
 * Covers the YamahaMixer facade, YamahaCLQL (OSC), and YamahaTF (TCP MIDI) drivers.
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { YamahaMixer } = require('../src/mixers/yamaha');

// ─── HELPERS ───────────────────────────────────────────────────────────────────

/** Create a mock OSC client that records send() calls. */
function makeMockOsc() {
  const sent = [];
  return {
    sent,
    send(address, args = []) { sent.push({ address, args: [...(args || [])] }); },
    async query() { return null; },
    close() {},
  };
}

/** Create a YamahaMixer (CL model) with the OSC layer pre-mocked. */
function makeCLMixer() {
  const mixer = new YamahaMixer({ host: '192.168.1.1', model: 'CL' });
  const mockOsc = makeMockOsc();
  mixer._impl._osc = mockOsc;
  return { mixer, impl: mixer._impl, sent: mockOsc.sent, mockOsc };
}

/** Create a YamahaMixer (TF model) with the socket layer pre-mocked. */
function makeTFMixer() {
  const mixer = new YamahaMixer({ host: '192.168.1.1', model: 'TF' });
  const written = [];
  mixer._impl._socket = {
    destroyed: false,
    write(buf) { written.push(Buffer.from(buf)); },
    destroy() { this.destroyed = true; },
  };
  return { mixer, impl: mixer._impl, written };
}

const last = (arr) => arr[arr.length - 1];

// ─── SECTION 1: YamahaMixer facade — model routing ──────────────────────────

test('YamahaMixer defaults to CL model', () => {
  const mixer = new YamahaMixer({ host: '10.0.0.1' });
  assert.equal(mixer.model, 'CL');
});

test('YamahaMixer with model=TF uses TF implementation', () => {
  const mixer = new YamahaMixer({ host: '10.0.0.1', model: 'TF' });
  assert.equal(mixer.model, 'TF');
  // TF impl has _socket property, not _osc
  assert.equal(mixer._impl._socket, null);
});

test('YamahaMixer with model=QL uses CL/QL implementation', () => {
  const mixer = new YamahaMixer({ host: '10.0.0.1', model: 'QL' });
  assert.equal(mixer.model, 'QL');
});

test('YamahaMixer with custom port for TF', () => {
  const mixer = new YamahaMixer({ host: '10.0.0.1', model: 'TF', port: 50000 });
  assert.equal(mixer._impl.port, 50000);
});

test('YamahaMixer with custom port for CL', () => {
  const mixer = new YamahaMixer({ host: '10.0.0.1', model: 'CL', port: 9999 });
  assert.equal(mixer._impl.port, 9999);
});

test('YamahaMixer default port for TF is 49280', () => {
  const mixer = new YamahaMixer({ host: '10.0.0.1', model: 'TF' });
  assert.equal(mixer._impl.port, 49280);
});

test('YamahaMixer default port for CL is 8765', () => {
  const mixer = new YamahaMixer({ host: '10.0.0.1', model: 'CL' });
  assert.equal(mixer._impl.port, 8765);
});

// ─── SECTION 2: YamahaCLQL — muteChannel / unmuteChannel / setFader ─────────

test('CL/QL muteChannel sends correct OSC', async () => {
  const { mixer, sent } = makeCLMixer();
  await mixer.muteChannel(3);
  assert.equal(last(sent).address, '/ymhss/ch/3/to_st/on');
  assert.equal(last(sent).args[0].value, 0);
});

test('CL/QL unmuteChannel sends correct OSC', async () => {
  const { mixer, sent } = makeCLMixer();
  await mixer.unmuteChannel(5);
  assert.equal(last(sent).address, '/ymhss/ch/5/to_st/on');
  assert.equal(last(sent).args[0].value, 1);
});

test('CL/QL setFader sends correct OSC with clamped value', async () => {
  const { mixer, sent } = makeCLMixer();
  await mixer.setFader(1, 0.5);
  assert.equal(last(sent).address, '/ymhss/fader/1');
  assert.equal(last(sent).args[0].type, 'f');
  assert.ok(Math.abs(last(sent).args[0].value - 0.5) < 0.0001);
});

test('CL/QL setFader clamps above 1', async () => {
  const { mixer, sent } = makeCLMixer();
  await mixer.setFader(1, 2.0);
  assert.equal(last(sent).args[0].value, 1.0);
});

test('CL/QL setFader clamps below 0', async () => {
  const { mixer, sent } = makeCLMixer();
  await mixer.setFader(1, -1.0);
  assert.equal(last(sent).args[0].value, 0.0);
});

test('CL/QL muteMaster sends fader/0 with value 0', async () => {
  const { mixer, sent } = makeCLMixer();
  await mixer.muteMaster();
  assert.equal(last(sent).address, '/ymhss/fader/0');
  assert.equal(last(sent).args[0].value, 0);
});

test('CL/QL unmuteMaster sends fader/0 with value 0.75', async () => {
  const { mixer, sent } = makeCLMixer();
  await mixer.unmuteMaster();
  assert.equal(last(sent).address, '/ymhss/fader/0');
  assert.equal(last(sent).args[0].value, 0.75);
});

test('CL/QL recallScene sends scene/recall', async () => {
  const { mixer, sent } = makeCLMixer();
  await mixer.recallScene(10);
  assert.equal(last(sent).address, '/ymhss/scene/recall');
  assert.equal(last(sent).args[0].value, 10);
});

// ─── SECTION 3: YamahaCLQL — error guards ────────────────────────────────────

test('CL/QL muteChannel throws when not connected', async () => {
  const mixer = new YamahaMixer({ host: '10.0.0.1', model: 'CL' });
  await assert.rejects(() => mixer.muteChannel(1), /not connected/);
});

test('CL/QL unmuteChannel throws when not connected', async () => {
  const mixer = new YamahaMixer({ host: '10.0.0.1', model: 'CL' });
  await assert.rejects(() => mixer.unmuteChannel(1), /not connected/);
});

test('CL/QL setFader throws when not connected', async () => {
  const mixer = new YamahaMixer({ host: '10.0.0.1', model: 'CL' });
  await assert.rejects(() => mixer.setFader(1, 0.5), /not connected/);
});

test('CL/QL muteMaster throws when not connected', async () => {
  const mixer = new YamahaMixer({ host: '10.0.0.1', model: 'CL' });
  await assert.rejects(() => mixer.muteMaster(), /not connected/);
});

test('CL/QL unmuteMaster throws when not connected', async () => {
  const mixer = new YamahaMixer({ host: '10.0.0.1', model: 'CL' });
  await assert.rejects(() => mixer.unmuteMaster(), /not connected/);
});

test('CL/QL recallScene throws when not connected', async () => {
  const mixer = new YamahaMixer({ host: '10.0.0.1', model: 'CL' });
  await assert.rejects(() => mixer.recallScene(1), /not connected/);
});

test('CL/QL getChannelStatus throws when not connected', async () => {
  const mixer = new YamahaMixer({ host: '10.0.0.1', model: 'CL' });
  await assert.rejects(() => mixer.getChannelStatus(1), /not connected/);
});

// ─── SECTION 4: YamahaCLQL — getChannelStatus ───────────────────────────────

test('CL/QL getChannelStatus returns fader and mute values', async () => {
  const { mixer, impl } = makeCLMixer();
  impl._osc.query = async (addr) => {
    if (addr.includes('fader')) return { args: [{ value: 0.8 }] };
    if (addr.includes('to_st/on')) return { args: [{ value: 0 }] };
    return null;
  };
  const status = await mixer.getChannelStatus(2);
  assert.equal(status.fader, 0.8);
  assert.equal(status.muted, true);
});

test('CL/QL getChannelStatus with null responses uses defaults', async () => {
  const { mixer, impl } = makeCLMixer();
  impl._osc.query = async () => null;
  const status = await mixer.getChannelStatus(1);
  assert.equal(status.fader, 0);
  assert.equal(status.muted, false);
});

test('CL/QL getChannelStatus catch path returns defaults', async () => {
  const { mixer, impl } = makeCLMixer();
  // Force the outer try to catch by making both queries reject
  const origQuery = impl._osc.query;
  impl._osc.query = async () => { throw new Error('fail'); };
  const status = await mixer.getChannelStatus(1);
  assert.equal(status.fader, 0);
  assert.equal(status.muted, false);
});

// ─── SECTION 5: YamahaCLQL — getStatus ──────────────────────────────────────

test('CL/QL getStatus when not connected returns offline', async () => {
  const mixer = new YamahaMixer({ host: '10.0.0.1', model: 'CL' });
  const status = await mixer.getStatus();
  assert.equal(status.online, false);
  assert.equal(status.model, 'Yamaha CL/QL');
});

test('CL/QL getStatus with successful query', async () => {
  const { mixer, impl } = makeCLMixer();
  impl._osc.query = async () => ({ args: [{ value: 'online' }] });
  const status = await mixer.getStatus();
  assert.equal(status.online, true);
  assert.equal(status.model, 'Yamaha CL/QL');
});

test('CL/QL getStatus with null query response', async () => {
  const { mixer, impl } = makeCLMixer();
  impl._osc.query = async () => null;
  const status = await mixer.getStatus();
  assert.equal(status.online, false);
});

test('CL/QL getStatus catch branch returns offline', async () => {
  const { mixer, impl } = makeCLMixer();
  impl._osc.query = async () => { throw new Error('fail'); };
  const status = await mixer.getStatus();
  assert.equal(status.online, false);
});

// ─── SECTION 6: YamahaCLQL — isOnline ────────────────────────────────────────

test('CL/QL isOnline returns false when not connected', async () => {
  const mixer = new YamahaMixer({ host: '10.0.0.1', model: 'CL' });
  assert.equal(await mixer.isOnline(), false);
});

test('CL/QL isOnline returns true on success', async () => {
  const { mixer, impl } = makeCLMixer();
  impl._osc.query = async () => ({ args: [] });
  assert.equal(await mixer.isOnline(), true);
});

test('CL/QL isOnline returns false on failure', async () => {
  const { mixer, impl } = makeCLMixer();
  impl._osc.query = async () => { throw new Error('timeout'); };
  assert.equal(await mixer.isOnline(), false);
});

// ─── SECTION 7: YamahaCLQL — disconnect ──────────────────────────────────────

test('CL/QL disconnect clears osc', async () => {
  const { mixer, impl } = makeCLMixer();
  await mixer.disconnect();
  assert.equal(impl._osc, null);
  assert.equal(impl._online, false);
});

test('CL/QL disconnect when already disconnected', async () => {
  const mixer = new YamahaMixer({ host: '10.0.0.1', model: 'CL' });
  await mixer.disconnect(); // should not throw
});

// ─── SECTION 8: YamahaCLQL — clearSolos (no-op) ─────────────────────────────

test('CL/QL clearSolos does not throw', async () => {
  const { mixer } = makeCLMixer();
  await mixer.clearSolos(); // no-op, should not throw
});

// ─── SECTION 9: YamahaCLQL — stub methods ────────────────────────────────────

test('CL/QL setChannelName warns but does not throw', async () => {
  const { mixer } = makeCLMixer();
  const orig = console.warn;
  const warns = [];
  console.warn = (...a) => warns.push(a.join(' '));
  await mixer.setChannelName(1, 'Test');
  console.warn = orig;
  assert.ok(warns.length > 0);
});

test('CL/QL setHpf warns but does not throw', async () => {
  const { mixer } = makeCLMixer();
  const orig = console.warn;
  console.warn = () => {};
  await mixer.setHpf(1, {});
  console.warn = orig;
});

test('CL/QL setEq warns but does not throw', async () => {
  const { mixer } = makeCLMixer();
  const orig = console.warn;
  console.warn = () => {};
  await mixer.setEq(1, {});
  console.warn = orig;
});

test('CL/QL setCompressor warns but does not throw', async () => {
  const { mixer } = makeCLMixer();
  const orig = console.warn;
  console.warn = () => {};
  await mixer.setCompressor(1, {});
  console.warn = orig;
});

test('CL/QL setGate warns but does not throw', async () => {
  const { mixer } = makeCLMixer();
  const orig = console.warn;
  console.warn = () => {};
  await mixer.setGate(1, {});
  console.warn = orig;
});

test('CL/QL saveScene warns but does not throw', async () => {
  const { mixer } = makeCLMixer();
  const orig = console.warn;
  console.warn = () => {};
  await mixer.saveScene(1, 'Test');
  console.warn = orig;
});

// ─── SECTION 10: YamahaCLQL — setFullChannelStrip ───────────────────────────

test('CL/QL setFullChannelStrip applies fader and mute=true', async () => {
  const { mixer, sent } = makeCLMixer();
  const orig = console.warn;
  console.warn = () => {};
  await mixer.setFullChannelStrip(1, { fader: 0.5, mute: true });
  console.warn = orig;
  assert.ok(sent.some(m => m.address.includes('fader')));
  assert.ok(sent.some(m => m.address.includes('to_st/on') && m.args[0].value === 0));
});

test('CL/QL setFullChannelStrip applies mute=false (unmute)', async () => {
  const { mixer, sent } = makeCLMixer();
  const orig = console.warn;
  console.warn = () => {};
  await mixer.setFullChannelStrip(1, { mute: false });
  console.warn = orig;
  assert.ok(sent.some(m => m.address.includes('to_st/on') && m.args[0].value === 1));
});

test('CL/QL setFullChannelStrip with no fader/mute sends nothing', async () => {
  const { mixer, sent } = makeCLMixer();
  const orig = console.warn;
  console.warn = () => {};
  await mixer.setFullChannelStrip(1, {});
  console.warn = orig;
  assert.equal(sent.length, 0);
});

// ─── SECTION 11: YamahaTF — muteChannel / unmuteChannel ────────────────────

test('TF muteChannel sends correct MIDI bytes', async () => {
  const { mixer, written } = makeTFMixer();
  const orig = console.warn;
  console.warn = () => {};
  await mixer.muteChannel(1);
  console.warn = orig;
  assert.equal(written.length, 1);
  assert.equal(written[0][0], 0x90); // Note On
  assert.equal(written[0][1], 0);    // ch 1 -> note 0
  assert.equal(written[0][2], 127);
});

test('TF unmuteChannel sends correct MIDI bytes', async () => {
  const { mixer, written } = makeTFMixer();
  const orig = console.warn;
  console.warn = () => {};
  await mixer.unmuteChannel(5);
  console.warn = orig;
  assert.equal(written[0][0], 0x80); // Note Off
  assert.equal(written[0][1], 4);    // ch 5 -> note 4
  assert.equal(written[0][2], 0);
});

test('TF recallScene sends Program Change MIDI', async () => {
  const { mixer, written } = makeTFMixer();
  await mixer.recallScene(3);
  assert.equal(written[0][0], 0xC0); // Program Change
  assert.equal(written[0][1], 2);    // scene 3 -> value 2 (1-indexed to 0-indexed)
});

// ─── SECTION 12: YamahaTF — _sendMidi edge cases ───────────────────────────

test('TF _sendMidi does nothing when socket is null', () => {
  const mixer = new YamahaMixer({ host: '10.0.0.1', model: 'TF' });
  mixer._impl._socket = null;
  mixer._impl._sendMidi([0x90, 0, 127]); // should not throw
});

test('TF _sendMidi does nothing when socket is destroyed', () => {
  const mixer = new YamahaMixer({ host: '10.0.0.1', model: 'TF' });
  mixer._impl._socket = { destroyed: true, write() {} };
  mixer._impl._sendMidi([0x90, 0, 127]); // should not throw
});

test('TF _sendMidi handles write error gracefully', () => {
  const mixer = new YamahaMixer({ host: '10.0.0.1', model: 'TF' });
  mixer._impl._socket = {
    destroyed: false,
    write() { throw new Error('broken pipe'); },
  };
  mixer._impl._sendMidi([0x90, 0, 127]); // should not throw
});

// ─── SECTION 13: YamahaTF — stub methods ────────────────────────────────────

test('TF getChannelStatus returns defaults with warning', async () => {
  const { mixer } = makeTFMixer();
  const orig = console.warn;
  console.warn = () => {};
  const status = await mixer.getChannelStatus(1);
  console.warn = orig;
  assert.equal(status.fader, 0);
  assert.equal(status.muted, false);
});

test('TF setFader warns but does not throw', async () => {
  const { mixer } = makeTFMixer();
  const orig = console.warn;
  console.warn = () => {};
  await mixer.setFader(1, 0.5);
  console.warn = orig;
});

test('TF muteMaster warns but does not throw', async () => {
  const { mixer } = makeTFMixer();
  const orig = console.warn;
  console.warn = () => {};
  await mixer.muteMaster();
  console.warn = orig;
});

test('TF unmuteMaster warns but does not throw', async () => {
  const { mixer } = makeTFMixer();
  const orig = console.warn;
  console.warn = () => {};
  await mixer.unmuteMaster();
  console.warn = orig;
});

test('TF clearSolos does not throw', async () => {
  const { mixer } = makeTFMixer();
  await mixer.clearSolos();
});

test('TF setChannelName warns but does not throw', async () => {
  const { mixer } = makeTFMixer();
  const orig = console.warn;
  console.warn = () => {};
  await mixer.setChannelName(1, 'Test');
  console.warn = orig;
});

test('TF setHpf warns but does not throw', async () => {
  const { mixer } = makeTFMixer();
  const orig = console.warn;
  console.warn = () => {};
  await mixer.setHpf(1, {});
  console.warn = orig;
});

test('TF setEq warns but does not throw', async () => {
  const { mixer } = makeTFMixer();
  const orig = console.warn;
  console.warn = () => {};
  await mixer.setEq(1, {});
  console.warn = orig;
});

test('TF setCompressor warns but does not throw', async () => {
  const { mixer } = makeTFMixer();
  const orig = console.warn;
  console.warn = () => {};
  await mixer.setCompressor(1, {});
  console.warn = orig;
});

test('TF setGate warns but does not throw', async () => {
  const { mixer } = makeTFMixer();
  const orig = console.warn;
  console.warn = () => {};
  await mixer.setGate(1, {});
  console.warn = orig;
});

test('TF setFullChannelStrip warns but does not throw', async () => {
  const { mixer } = makeTFMixer();
  const orig = console.warn;
  console.warn = () => {};
  await mixer.setFullChannelStrip(1, { fader: 0.5 });
  console.warn = orig;
});

test('TF saveScene warns but does not throw', async () => {
  const { mixer } = makeTFMixer();
  const orig = console.warn;
  console.warn = () => {};
  await mixer.saveScene(1, 'Test');
  console.warn = orig;
});

// ─── SECTION 14: YamahaTF — disconnect ──────────────────────────────────────

test('TF disconnect destroys socket', async () => {
  const { mixer, impl } = makeTFMixer();
  await mixer.disconnect();
  assert.equal(impl._socket, null);
  assert.equal(impl._online, false);
});

test('TF disconnect when already disconnected', async () => {
  const mixer = new YamahaMixer({ host: '10.0.0.1', model: 'TF' });
  await mixer.disconnect(); // should not throw
});

// ─── SECTION 15: YamahaMixer facade — DCA/mute group stubs ─────────────────

test('YamahaMixer muteDca warns but does not throw', async () => {
  const { mixer } = makeCLMixer();
  const orig = console.warn;
  const warns = [];
  console.warn = (...a) => warns.push(a.join(' '));
  await mixer.muteDca(1);
  console.warn = orig;
  assert.ok(warns.some(w => w.includes('Yamaha')));
});

test('YamahaMixer unmuteDca warns but does not throw', async () => {
  const { mixer } = makeCLMixer();
  const orig = console.warn;
  console.warn = () => {};
  await mixer.unmuteDca(1);
  console.warn = orig;
});

test('YamahaMixer setDcaFader warns but does not throw', async () => {
  const { mixer } = makeCLMixer();
  const orig = console.warn;
  console.warn = () => {};
  await mixer.setDcaFader(1, 0.5);
  console.warn = orig;
});

test('YamahaMixer activateMuteGroup warns but does not throw', async () => {
  const { mixer } = makeCLMixer();
  const orig = console.warn;
  console.warn = () => {};
  await mixer.activateMuteGroup(1);
  console.warn = orig;
});

test('YamahaMixer deactivateMuteGroup warns but does not throw', async () => {
  const { mixer } = makeCLMixer();
  const orig = console.warn;
  console.warn = () => {};
  await mixer.deactivateMuteGroup(1);
  console.warn = orig;
});

test('YamahaMixer pressSoftKey warns but does not throw', async () => {
  const { mixer } = makeCLMixer();
  const orig = console.warn;
  console.warn = () => {};
  await mixer.pressSoftKey(1);
  console.warn = orig;
});
