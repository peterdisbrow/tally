/**
 * Tests for src/tcp-midi.js — MidiParser and TcpMidi (non-network behaviors).
 *
 * MidiParser is fully exercised with in-process buffer feeds.
 * TcpMidi tests cover constructor state, send(), and disconnect() without
 * opening any real TCP connections.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { TcpMidi, MidiParser } = require('../src/tcp-midi');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function collectMessages(parser) {
  const msgs = [];
  // Re-wrap the parser's callback — for tests we always create a fresh parser
  // so we just return the msgs array that the constructor callback pushes into.
  return msgs;
}

function makeParser() {
  const msgs = [];
  const parser = new MidiParser((msg) => msgs.push(Array.from(msg)));
  return { parser, msgs };
}

function feed(parser, bytes) {
  parser.feed(Buffer.from(bytes));
}

// ─── MidiParser — Note On ─────────────────────────────────────────────────────

describe('MidiParser — Note On (0x90)', () => {
  it('emits a single note-on message from a 3-byte feed', () => {
    const { parser, msgs } = makeParser();
    feed(parser, [0x91, 60, 100]);
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0], [0x91, 60, 100]);
  });

  it('status byte is 0x91 (channel 2)', () => {
    const { parser, msgs } = makeParser();
    feed(parser, [0x91, 64, 80]);
    assert.equal(msgs[0][0], 0x91);
  });

  it('note-on with velocity 0 is still emitted', () => {
    const { parser, msgs } = makeParser();
    feed(parser, [0x90, 60, 0]);
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0], [0x90, 60, 0]);
  });
});

// ─── MidiParser — Note Off (0x80) ─────────────────────────────────────────────

describe('MidiParser — Note Off (0x80)', () => {
  it('emits a 3-byte note-off message', () => {
    const { parser, msgs } = makeParser();
    feed(parser, [0x80, 60, 64]);
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0], [0x80, 60, 64]);
  });

  it('note-off on channel 3 (0x82)', () => {
    const { parser, msgs } = makeParser();
    feed(parser, [0x82, 48, 0]);
    assert.deepEqual(msgs[0], [0x82, 48, 0]);
  });
});

// ─── MidiParser — Control Change (0xB0) ───────────────────────────────────────

describe('MidiParser — Control Change (0xB0)', () => {
  it('emits a 3-byte control change message', () => {
    const { parser, msgs } = makeParser();
    feed(parser, [0xB0, 7, 100]);
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0], [0xB0, 7, 100]);
  });

  it('CC with controller 11 (expression)', () => {
    const { parser, msgs } = makeParser();
    feed(parser, [0xB0, 11, 64]);
    assert.deepEqual(msgs[0], [0xB0, 11, 64]);
  });
});

// ─── MidiParser — Program Change (0xC0) ───────────────────────────────────────

describe('MidiParser — Program Change (0xC0)', () => {
  it('emits a 2-byte program change (1 data byte)', () => {
    const { parser, msgs } = makeParser();
    feed(parser, [0xC0, 5]);
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0], [0xC0, 5]);
  });

  it('program change on channel 4 (0xC3)', () => {
    const { parser, msgs } = makeParser();
    feed(parser, [0xC3, 42]);
    assert.deepEqual(msgs[0], [0xC3, 42]);
  });
});

// ─── MidiParser — Channel Pressure (0xD0) ─────────────────────────────────────

describe('MidiParser — Channel Pressure (0xD0)', () => {
  it('emits a 2-byte channel pressure (1 data byte)', () => {
    const { parser, msgs } = makeParser();
    feed(parser, [0xD0, 75]);
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0], [0xD0, 75]);
  });

  it('channel pressure value 0', () => {
    const { parser, msgs } = makeParser();
    feed(parser, [0xD0, 0]);
    assert.deepEqual(msgs[0], [0xD0, 0]);
  });
});

// ─── MidiParser — Pitch Bend (0xE0) ───────────────────────────────────────────

describe('MidiParser — Pitch Bend (0xE0)', () => {
  it('emits a 3-byte pitch bend message', () => {
    const { parser, msgs } = makeParser();
    feed(parser, [0xE0, 0x00, 0x40]);
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0], [0xE0, 0x00, 0x40]);
  });

  it('pitch bend max up', () => {
    const { parser, msgs } = makeParser();
    feed(parser, [0xE0, 0x7F, 0x7F]);
    assert.deepEqual(msgs[0], [0xE0, 0x7F, 0x7F]);
  });
});

// ─── MidiParser — Running Status ──────────────────────────────────────────────

describe('MidiParser — running status', () => {
  it('reuses last status byte for subsequent data bytes', () => {
    const { parser, msgs } = makeParser();
    // First message with status
    feed(parser, [0x90, 60, 100]);
    // Second message — data bytes only, no repeated status
    feed(parser, [64, 80]);
    assert.equal(msgs.length, 2);
    assert.deepEqual(msgs[0], [0x90, 60, 100]);
    assert.deepEqual(msgs[1], [0x90, 64, 80]);
  });

  it('running status survives multiple messages in a row', () => {
    const { parser, msgs } = makeParser();
    feed(parser, [0x90, 60, 100, 62, 90, 64, 70]);
    assert.equal(msgs.length, 3);
    assert.deepEqual(msgs[0], [0x90, 60, 100]);
    assert.deepEqual(msgs[1], [0x90, 62, 90]);
    assert.deepEqual(msgs[2], [0x90, 64, 70]);
  });

  it('new status byte resets running status', () => {
    const { parser, msgs } = makeParser();
    feed(parser, [0x90, 60, 100]);
    feed(parser, [0x80, 60, 0]);
    assert.equal(msgs.length, 2);
    assert.deepEqual(msgs[1], [0x80, 60, 0]);
  });

  it('running status works for control change (2 data bytes)', () => {
    const { parser, msgs } = makeParser();
    feed(parser, [0xB0, 7, 100]);
    feed(parser, [7, 0]);
    assert.equal(msgs.length, 2);
    assert.deepEqual(msgs[1], [0xB0, 7, 0]);
  });
});

// ─── MidiParser — System Realtime (0xF8) ──────────────────────────────────────

describe('MidiParser — System Realtime (0xF8)', () => {
  it('emits a single-byte realtime message immediately', () => {
    const { parser, msgs } = makeParser();
    feed(parser, [0xF8]);
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0], [0xF8]);
  });

  it('does not disturb running status mid-message', () => {
    const { parser, msgs } = makeParser();
    // Start a note-on, inject clock tick, finish note-on data
    feed(parser, [0x90, 60]);  // status + first data byte
    feed(parser, [0xF8]);       // real-time clock — should not affect running status
    feed(parser, [100]);        // second data byte for note-on
    // Expect: clock tick, then complete note-on
    assert.equal(msgs.length, 2);
    assert.deepEqual(msgs[0], [0xF8]);
    assert.deepEqual(msgs[1], [0x90, 60, 100]);
  });

  it('emits 0xFA (start) and 0xFC (stop) as single-byte messages', () => {
    const { parser, msgs } = makeParser();
    feed(parser, [0xFA, 0xFC]);
    assert.equal(msgs.length, 2);
    assert.deepEqual(msgs[0], [0xFA]);
    assert.deepEqual(msgs[1], [0xFC]);
  });
});

// ─── MidiParser — SysEx (0xF0 ... 0xF7) ──────────────────────────────────────

describe('MidiParser — SysEx', () => {
  it('emits complete sysex on 0xF7 terminator', () => {
    const { parser, msgs } = makeParser();
    feed(parser, [0xF0, 0x41, 0x10, 0x00, 0xF7]);
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0], [0xF0, 0x41, 0x10, 0x00, 0xF7]);
  });

  it('does not emit until 0xF7 is received', () => {
    const { parser, msgs } = makeParser();
    feed(parser, [0xF0, 0x41, 0x10]);
    assert.equal(msgs.length, 0);
    feed(parser, [0x00, 0xF7]);
    assert.equal(msgs.length, 1);
  });

  it('minimal sysex with only start and end bytes', () => {
    const { parser, msgs } = makeParser();
    feed(parser, [0xF0, 0xF7]);
    assert.deepEqual(msgs[0], [0xF0, 0xF7]);
  });

  it('sysex followed by normal message both emitted', () => {
    const { parser, msgs } = makeParser();
    feed(parser, [0xF0, 0x01, 0xF7, 0x90, 60, 100]);
    assert.equal(msgs.length, 2);
    assert.deepEqual(msgs[0], [0xF0, 0x01, 0xF7]);
    assert.deepEqual(msgs[1], [0x90, 60, 100]);
  });
});

// ─── MidiParser — Multi-message buffer ────────────────────────────────────────

describe('MidiParser — multi-message buffer', () => {
  it('parses multiple different messages in one feed call', () => {
    const { parser, msgs } = makeParser();
    // note-on + CC + program change all in one buffer
    feed(parser, [0x90, 60, 100, 0xB0, 7, 64, 0xC0, 3]);
    assert.equal(msgs.length, 3);
    assert.deepEqual(msgs[0], [0x90, 60, 100]);
    assert.deepEqual(msgs[1], [0xB0, 7, 64]);
    assert.deepEqual(msgs[2], [0xC0, 3]);
  });

  it('handles 5 note-on messages in a single buffer', () => {
    const { parser, msgs } = makeParser();
    const buf = [];
    for (let i = 0; i < 5; i++) buf.push(0x90, 60 + i, 100);
    feed(parser, buf);
    assert.equal(msgs.length, 5);
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(msgs[i], [0x90, 60 + i, 100]);
    }
  });
});

// ─── MidiParser — reset() ─────────────────────────────────────────────────────

describe('MidiParser — reset()', () => {
  it('clears _runningStatus to 0 after reset', () => {
    const { parser } = makeParser();
    feed(parser, [0x90, 60, 100]); // establish running status
    assert.equal(parser._runningStatus, 0x90);
    parser.reset();
    assert.equal(parser._runningStatus, 0);
  });

  it('clears _buf to empty array after reset', () => {
    const { parser } = makeParser();
    feed(parser, [0x90, 60]); // partial — puts bytes in _buf
    assert.equal(parser._buf.length, 2);
    parser.reset();
    assert.equal(parser._buf.length, 0);
  });

  it('clears _inSysEx flag after reset', () => {
    const { parser } = makeParser();
    feed(parser, [0xF0, 0x41]); // sysex started but not ended
    assert.equal(parser._inSysEx, true);
    parser.reset();
    assert.equal(parser._inSysEx, false);
  });

  it('clears _sysExBuf after reset', () => {
    const { parser } = makeParser();
    feed(parser, [0xF0, 0x41, 0x10]);
    assert.ok(parser._sysExBuf.length > 0);
    parser.reset();
    assert.equal(parser._sysExBuf.length, 0);
  });

  it('allows fresh messages after reset', () => {
    const { parser, msgs } = makeParser();
    feed(parser, [0x90, 60, 100]);
    parser.reset();
    feed(parser, [0x80, 48, 64]);
    assert.equal(msgs.length, 2);
    assert.deepEqual(msgs[1], [0x80, 48, 64]);
  });
});

// ─── MidiParser — chunked delivery ────────────────────────────────────────────

describe('MidiParser — messages arriving in chunks', () => {
  it('assembles a note-on split across two feed() calls', () => {
    const { parser, msgs } = makeParser();
    feed(parser, [0x90, 60]);   // status + first data byte
    assert.equal(msgs.length, 0);
    feed(parser, [100]);        // second data byte completes the message
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0], [0x90, 60, 100]);
  });

  it('assembles a sysex split across three feed() calls', () => {
    const { parser, msgs } = makeParser();
    feed(parser, [0xF0]);
    feed(parser, [0x41, 0x10]);
    feed(parser, [0x00, 0xF7]);
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0], [0xF0, 0x41, 0x10, 0x00, 0xF7]);
  });

  it('assembles program change split: status in one chunk, data in next', () => {
    const { parser, msgs } = makeParser();
    feed(parser, [0xC0]);
    assert.equal(msgs.length, 0);
    feed(parser, [7]);
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0], [0xC0, 7]);
  });
});

// ─── TcpMidi — constructor ────────────────────────────────────────────────────

describe('TcpMidi — constructor', () => {
  it('stores host and port', () => {
    const t = new TcpMidi({ host: '192.168.1.10', port: 51325 });
    assert.equal(t.host, '192.168.1.10');
    assert.equal(t.port, 51325);
  });

  it('stores autoReconnect=true by default', () => {
    const t = new TcpMidi({ host: '10.0.0.1', port: 9000 });
    assert.equal(t.autoReconnect, true);
  });

  it('stores autoReconnect=false when specified', () => {
    const t = new TcpMidi({ host: '10.0.0.1', port: 9000, autoReconnect: false });
    assert.equal(t.autoReconnect, false);
  });

  it('starts with _online=false', () => {
    const t = new TcpMidi({ host: '10.0.0.1', port: 9000 });
    assert.equal(t._online, false);
  });

  it('online getter returns false initially', () => {
    const t = new TcpMidi({ host: '10.0.0.1', port: 9000 });
    assert.equal(t.online, false);
  });

  it('starts with _socket=null', () => {
    const t = new TcpMidi({ host: '10.0.0.1', port: 9000 });
    assert.equal(t._socket, null);
  });

  it('starts with _reconnectTimer=null', () => {
    const t = new TcpMidi({ host: '10.0.0.1', port: 9000 });
    assert.equal(t._reconnectTimer, null);
  });

  it('starts with _intentionalClose=false', () => {
    const t = new TcpMidi({ host: '10.0.0.1', port: 9000 });
    assert.equal(t._intentionalClose, false);
  });

  it('is an EventEmitter (has on/emit)', () => {
    const t = new TcpMidi({ host: '10.0.0.1', port: 9000 });
    assert.equal(typeof t.on, 'function');
    assert.equal(typeof t.emit, 'function');
  });
});

// ─── TcpMidi — send() ─────────────────────────────────────────────────────────

describe('TcpMidi.send() — no socket', () => {
  it('returns false when _socket is null', () => {
    const t = new TcpMidi({ host: '10.0.0.1', port: 9000 });
    // _socket is null by default
    const result = t.send([0x90, 60, 100]);
    assert.equal(result, false);
  });

  it('returns false when socket is destroyed', () => {
    const t = new TcpMidi({ host: '10.0.0.1', port: 9000 });
    // Inject a fake destroyed socket
    t._socket = { destroyed: true, write: () => { throw new Error('should not write'); } };
    const result = t.send([0x90, 60, 100]);
    assert.equal(result, false);
  });

  it('returns true when socket is alive and write succeeds', () => {
    const t = new TcpMidi({ host: '10.0.0.1', port: 9000 });
    const written = [];
    t._socket = {
      destroyed: false,
      write: (buf) => { written.push(buf); return true; },
    };
    const result = t.send([0x90, 60, 100]);
    assert.equal(result, true);
    assert.equal(written.length, 1);
  });

  it('returns false when socket.write throws', () => {
    const t = new TcpMidi({ host: '10.0.0.1', port: 9000 });
    t._socket = {
      destroyed: false,
      write: () => { throw new Error('write error'); },
    };
    const result = t.send([0x90, 60, 100]);
    assert.equal(result, false);
  });
});

// ─── TcpMidi — disconnect() ───────────────────────────────────────────────────

describe('TcpMidi.disconnect()', () => {
  it('sets _intentionalClose=true', () => {
    const t = new TcpMidi({ host: '10.0.0.1', port: 9000 });
    t.disconnect();
    assert.equal(t._intentionalClose, true);
  });

  it('sets _online=false after call', () => {
    const t = new TcpMidi({ host: '10.0.0.1', port: 9000 });
    t._online = true; // pretend we were online
    t.disconnect();
    assert.equal(t._online, false);
  });

  it('clears _reconnectTimer', () => {
    const t = new TcpMidi({ host: '10.0.0.1', port: 9000 });
    // Install a fake timer
    t._reconnectTimer = setTimeout(() => {}, 60000);
    t.disconnect();
    assert.equal(t._reconnectTimer, null);
  });

  it('destroys and nulls _socket when present', () => {
    const t = new TcpMidi({ host: '10.0.0.1', port: 9000 });
    let destroyed = false;
    t._socket = {
      destroyed: false,
      destroy: () => { destroyed = true; },
    };
    t.disconnect();
    assert.equal(destroyed, true);
    assert.equal(t._socket, null);
  });

  it('does not throw when socket is already null', () => {
    const t = new TcpMidi({ host: '10.0.0.1', port: 9000 });
    assert.doesNotThrow(() => t.disconnect());
  });

  it('online getter returns false after disconnect', () => {
    const t = new TcpMidi({ host: '10.0.0.1', port: 9000 });
    t._online = true;
    t.disconnect();
    assert.equal(t.online, false);
  });
});
