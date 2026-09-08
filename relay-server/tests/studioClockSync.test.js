/**
 * Studio Clock wall-time offset + invalid-token close helpers.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  applyServerTimestamp,
  wallNow,
  isInvalidTokenClose,
} = require('../public/tools/studio-clock-sync.js');

describe('studioClockSync', () => {
  it('falls back to local Date when no server stamp is available', () => {
    const now = 1_700_000_000_000;
    expect(wallNow({ hasOffset: false, offsetMs: 9999 }, now).getTime()).toBe(now);
    expect(wallNow(null, now).getTime()).toBe(now);
  });

  it('applies half-RTT offset from a server_timestamp probe', () => {
    const syncT0 = 1_000_000;
    const receivedAt = 1_000_080; // 80ms RTT
    const serverTs = 5_000_000;
    const sync = applyServerTimestamp(null, serverTs, receivedAt, syncT0);

    expect(sync.hasOffset).toBe(true);
    // estimated server now = 5_000_000 + 40
    expect(sync.offsetMs).toBe(5_000_000 + 40 - 1_000_080);
    expect(wallNow(sync, receivedAt).getTime()).toBe(5_000_040);
  });

  it('ignores stale RTTs above 2s and still applies receive-time offset', () => {
    const syncT0 = 1_000_000;
    const receivedAt = 1_000_000 + 8_000;
    const serverTs = 2_000_000;
    const sync = applyServerTimestamp(null, serverTs, receivedAt, syncT0);

    expect(sync.hasOffset).toBe(true);
    expect(sync.offsetMs).toBe(serverTs - receivedAt);
    expect(wallNow(sync, receivedAt).getTime()).toBe(serverTs);
  });

  it('keeps the previous sync when server_timestamp is missing', () => {
    const prev = { offsetMs: 12, hasOffset: true, driftMs: 4 };
    expect(applyServerTimestamp(prev, undefined, Date.now(), 0)).toEqual(prev);
    expect(applyServerTimestamp(prev, 'nope', Date.now(), 0)).toEqual(prev);
  });

  it('treats policy-violation closes as an expired/invalid share token', () => {
    expect(isInvalidTokenClose(1008, 'invalid share token')).toBe(true);
    expect(isInvalidTokenClose(1008, 'token required')).toBe(true);
    expect(isInvalidTokenClose(1008, '')).toBe(true);
    expect(isInvalidTokenClose(1000, 'invalid share token')).toBe(true);
    expect(isInvalidTokenClose(1006, 'Connection lost')).toBe(false);
    expect(isInvalidTokenClose(1011, 'internal error')).toBe(false);
  });
});
