/**
 * Tests for OSC codec functions (encodeMessage / decodeMessage) and OSCClient.
 * Pure encode/decode functions are exercised without any network I/O.
 * OSCClient tests that create sockets explicitly call client.close() in cleanup.
 */
const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { OSCClient, encodeMessage, decodeMessage } = require('../src/osc');

// ─── encodeMessage / decodeMessage round-trip ────────────────────────────────

describe('encodeMessage + decodeMessage round-trip', () => {
  it('encodes and decodes a message with no arguments', () => {
    const buf = encodeMessage('/test/addr');
    const msg = decodeMessage(buf);
    assert.equal(msg.address, '/test/addr');
    assert.deepEqual(msg.args, []);
  });

  it('round-trips an integer argument', () => {
    const buf = encodeMessage('/ch/01/fader', [{ type: 'i', value: 42 }]);
    const msg = decodeMessage(buf);
    assert.equal(msg.address, '/ch/01/fader');
    assert.equal(msg.args.length, 1);
    assert.equal(msg.args[0].type, 'i');
    assert.equal(msg.args[0].value, 42);
  });

  it('round-trips a negative integer', () => {
    const buf = encodeMessage('/test', [{ type: 'i', value: -100 }]);
    const msg = decodeMessage(buf);
    assert.equal(msg.args[0].value, -100);
  });

  it('round-trips a float argument', () => {
    const buf = encodeMessage('/ch/fader', [{ type: 'f', value: 0.75 }]);
    const msg = decodeMessage(buf);
    assert.equal(msg.args[0].type, 'f');
    // Float32 has limited precision — check approximate equality
    assert.ok(Math.abs(msg.args[0].value - 0.75) < 0.001);
  });

  it('round-trips a string argument', () => {
    const buf = encodeMessage('/label', [{ type: 's', value: 'Vocals' }]);
    const msg = decodeMessage(buf);
    assert.equal(msg.args[0].type, 's');
    assert.equal(msg.args[0].value, 'Vocals');
  });

  it('round-trips an empty string argument', () => {
    const buf = encodeMessage('/label', [{ type: 's', value: '' }]);
    const msg = decodeMessage(buf);
    assert.equal(msg.args[0].value, '');
  });

  it('round-trips boolean true (T) — no data bytes', () => {
    const buf = encodeMessage('/toggle', [{ type: 'T' }]);
    const msg = decodeMessage(buf);
    assert.equal(msg.args[0].type, 'T');
    assert.equal(msg.args[0].value, true);
  });

  it('round-trips boolean false (F) — no data bytes', () => {
    const buf = encodeMessage('/toggle', [{ type: 'F' }]);
    const msg = decodeMessage(buf);
    assert.equal(msg.args[0].type, 'F');
    assert.equal(msg.args[0].value, false);
  });

  it('round-trips multiple mixed arguments', () => {
    const args = [
      { type: 'i', value: 1 },
      { type: 'f', value: 0.5 },
      { type: 's', value: 'hello' },
      { type: 'T' },
    ];
    const buf = encodeMessage('/multi', args);
    const msg = decodeMessage(buf);
    assert.equal(msg.args.length, 4);
    assert.equal(msg.args[0].value, 1);
    assert.ok(Math.abs(msg.args[1].value - 0.5) < 0.001);
    assert.equal(msg.args[2].value, 'hello');
    assert.equal(msg.args[3].value, true);
  });

  it('round-trips address that requires 4-byte padding', () => {
    // '/a' is 2 chars + null = 3 bytes → padded to 4
    const buf = encodeMessage('/a', [{ type: 'i', value: 7 }]);
    const msg = decodeMessage(buf);
    assert.equal(msg.address, '/a');
    assert.equal(msg.args[0].value, 7);
  });

  it('round-trips address that is already on a 4-byte boundary', () => {
    // '/abc' is 4 chars + null = 5 bytes → padded to 8
    const buf = encodeMessage('/abc', [{ type: 'i', value: 3 }]);
    const msg = decodeMessage(buf);
    assert.equal(msg.address, '/abc');
  });

  it('round-trips a long string argument (over 12 chars)', () => {
    const longStr = 'A very long channel label for testing';
    const buf = encodeMessage('/ch/name', [{ type: 's', value: longStr }]);
    const msg = decodeMessage(buf);
    assert.equal(msg.args[0].value, longStr);
  });

  it('encodes unknown type without crashing, decode skips it', () => {
    // Encode with an unknown type (the encoder skips it, creating no data)
    const buf = encodeMessage('/test', [{ type: 'x', value: 99 }]);
    const msg = decodeMessage(buf);
    // The type tag 'x' is in the tag string but no data — decoder skips unknown
    assert.equal(msg.address, '/test');
    assert.equal(msg.args.length, 0);
  });

  it('decodes N (null) and I (Infinity) type tags', () => {
    // Build a message manually with N and I type tags (encode doesn't support them, decode does)
    // We can append them by wrapping encodeMessage output or by crafting a buffer
    // Use encode for an empty message and then verify decode handles N/I in the type string
    // Build manually: address, type tag ',NI', no data bytes
    const addrStr = '/special';
    const addrBytes = Buffer.from(addrStr + '\0', 'utf8');
    // pad to 4-byte boundary
    const addrPadded = Buffer.concat([addrBytes, Buffer.alloc(4 - (addrBytes.length % 4) || 4)]);
    const tagStr = ',NI';
    const tagBytes = Buffer.from(tagStr + '\0', 'utf8');
    const tagPad = 4 - (tagBytes.length % 4) || 4;
    const tagPadded = Buffer.concat([tagBytes, Buffer.alloc(tagPad)]);
    const buf = Buffer.concat([addrPadded, tagPadded]);
    const msg = decodeMessage(buf);
    assert.equal(msg.address, '/special');
    assert.equal(msg.args.length, 2);
    assert.equal(msg.args[0].type, 'N');
    assert.equal(msg.args[0].value, null);
    assert.equal(msg.args[1].type, 'I');
    assert.equal(msg.args[1].value, Infinity);
  });
});

// ─── decodeMessage error handling ─────────────────────────────────────────────

describe('decodeMessage — error handling', () => {
  it('returns { address: empty, args: [] } for empty buffer (no exception thrown)', () => {
    // Empty buffer decodes to empty address with no args — does not throw
    const result = decodeMessage(Buffer.alloc(0));
    assert.ok(result !== null);
    assert.equal(result.address, '');
    assert.deepEqual(result.args, []);
  });

  it('returns null when buffer has integer type tag but insufficient data bytes', () => {
    // Build a buffer with address '/x', type tag ',i', but no 4 data bytes for the int
    // This will cause readInt32BE to throw, caught as null
    const addrBytes = Buffer.from('/x\0\0', 'utf8');     // 4 bytes
    const tagBytes = Buffer.from(',i\0\0', 'utf8');       // 4 bytes
    // Deliberately omit the 4-byte integer data → readInt32BE throws
    const buf = Buffer.concat([addrBytes, tagBytes]);     // only 8 bytes, missing int data
    const result = decodeMessage(buf);
    assert.equal(result, null);
  });

  it('returns { address, args: [] } when type tag string does not start with comma', () => {
    // Build a message without the leading comma in type string
    const addrBytes = Buffer.from('/test\0\0\0', 'utf8'); // 8 bytes
    const tagBytes = Buffer.from('XY\0\0', 'utf8');       // 4 bytes, no leading comma
    const buf = Buffer.concat([addrBytes, tagBytes]);
    const result = decodeMessage(buf);
    assert.equal(result.address, '/test');
    assert.deepEqual(result.args, []);
  });
});

// ─── encodeMessage edge cases ─────────────────────────────────────────────────

describe('encodeMessage — edge cases', () => {
  it('produces a Buffer', () => {
    const buf = encodeMessage('/test');
    assert.ok(Buffer.isBuffer(buf));
  });

  it('length is always a multiple of 4', () => {
    const cases = ['/a', '/ab', '/abc', '/abcd', '/abcde', '/ch/01/mix/fader'];
    for (const addr of cases) {
      const buf = encodeMessage(addr);
      assert.equal(buf.length % 4, 0, `${addr}: buffer length ${buf.length} is not multiple of 4`);
    }
  });

  it('handles null value in string arg gracefully', () => {
    const buf = encodeMessage('/test', [{ type: 's', value: null }]);
    const msg = decodeMessage(buf);
    assert.equal(msg.args[0].value, '');
  });

  it('rounds float value for integer type', () => {
    const buf = encodeMessage('/ch', [{ type: 'i', value: 3.7 }]);
    const msg = decodeMessage(buf);
    assert.equal(msg.args[0].value, 4); // Math.round(3.7) = 4
  });
});

// ─── OSCClient — socket-free operations ──────────────────────────────────────

describe('OSCClient.close() on fresh instance', () => {
  it('does not throw when no socket has been created', () => {
    const client = new OSCClient({ host: '127.0.0.1', port: 8000 });
    assert.doesNotThrow(() => client.close());
  });

  it('resets internal state on close', () => {
    const client = new OSCClient({ host: '127.0.0.1', port: 8000 });
    client.close();
    assert.equal(client._socket, null);
    assert.equal(client._bound, false);
    assert.deepEqual(client._subscriptions, []);
  });
});

describe('OSCClient.subscribe() and unsubscribe', () => {
  let client;
  afterEach(() => {
    // Always close to release any dgram socket created by _ensureSocket
    if (client) {
      client.close();
      client = null;
    }
  });

  it('subscribe returns an unsubscribe function', () => {
    client = new OSCClient({ host: '127.0.0.1', port: 9000 });
    const unsub = client.subscribe('/ch', () => {});
    assert.equal(typeof unsub, 'function');
    client.close(); // clean up socket created by subscribe → _ensureSocket
  });

  it('unsubscribe removes the subscription', () => {
    client = new OSCClient({ host: '127.0.0.1', port: 9001 });
    const handler = () => {};
    const unsub = client.subscribe('/test', handler);
    assert.equal(client._subscriptions.length, 1);
    unsub();
    assert.equal(client._subscriptions.length, 0);
  });

  it('multiple subscriptions to same prefix are independent', () => {
    client = new OSCClient({ host: '127.0.0.1', port: 9002 });
    const unsub1 = client.subscribe('/ch', () => {});
    const unsub2 = client.subscribe('/ch', () => {});
    assert.equal(client._subscriptions.length, 2);
    unsub1();
    assert.equal(client._subscriptions.length, 1);
    unsub2();
    assert.equal(client._subscriptions.length, 0);
  });

  it('calling unsubscribe twice is safe (second call is a no-op)', () => {
    client = new OSCClient({ host: '127.0.0.1', port: 9003 });
    const unsub = client.subscribe('/test', () => {});
    unsub();
    assert.doesNotThrow(() => unsub());
    assert.equal(client._subscriptions.length, 0);
  });
});

// ─── OSCClient constructor ─────────────────────────────────────────────────────

describe('OSCClient constructor', () => {
  it('stores host, port, receivePort', () => {
    const client = new OSCClient({ host: '10.0.0.1', port: 8765, receivePort: 9000 });
    assert.equal(client.host, '10.0.0.1');
    assert.equal(client.port, 8765);
    assert.equal(client.receivePort, 9000);
    // No socket created until first operation
    assert.equal(client._socket, null);
    assert.equal(client._bound, false);
  });

  it('defaults receivePort to null when not specified', () => {
    const client = new OSCClient({ host: '10.0.0.1', port: 8765 });
    assert.equal(client.receivePort, null);
  });
});
