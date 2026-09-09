/**
 * Calm empty-state copy for admin Monitor / Sunday strip.
 */
import { describe, it, expect } from 'vitest';
import {
  fleetEmptyState,
  hlsIdleState,
  ZERO_CONNECTED_NOTE,
} from '../admin/src/monitorEmptyCopy.js';

describe('fleetEmptyState', () => {
  it('does not say Waiting for data when the SSE is still connecting', () => {
    const empty = fleetEmptyState({ sseConnected: false, churchCount: 0 });
    expect(empty.title).toMatch(/Connecting to live feed/i);
    expect(empty.body).toMatch(/not a broken player/i);
    expect(empty.title).not.toMatch(/Waiting for data/i);
  });

  it('is honest when SSE is live and no booths are connected', () => {
    const empty = fleetEmptyState({ sseConnected: true, churchCount: 0 });
    expect(empty.title).toBe('No booths online');
    expect(empty.body).toMatch(/HLS preview stays dark/i);
  });

  it('explains Online-only with a fully offline fleet', () => {
    const empty = fleetEmptyState({
      sseConnected: true,
      churchCount: 3,
      onlineCount: 0,
      showOnlyOnline: true,
    });
    expect(empty.title).toBe('No booths online');
    expect(empty.body).toMatch(/Uncheck Online only/i);
  });

  it('uses matching copy when a search misses', () => {
    const empty = fleetEmptyState({
      sseConnected: true,
      churchCount: 3,
      onlineCount: 1,
      filter: 'zzz',
    });
    expect(empty.title).toBe('No matching churches');
  });
});

describe('hlsIdleState', () => {
  it('does not look like a broken player when the booth is offline', () => {
    const idle = hlsIdleState({ boothConnected: false });
    expect(idle.badge).toBe('No ingest');
    expect(idle.body).toMatch(/not a broken player/i);
  });

  it('says idle when the booth is up but not pushing RTMP', () => {
    const idle = hlsIdleState({ boothConnected: true });
    expect(idle.badge).toBe('Idle');
    expect(idle.body).toMatch(/not pushing video/i);
  });
});

describe('ZERO_CONNECTED_NOTE', () => {
  it('tells operators the fleet is dark, not broken', () => {
    expect(ZERO_CONNECTED_NOTE).toMatch(/No booths connected/);
    expect(ZERO_CONNECTED_NOTE).toMatch(/Tally Connect/);
  });
});
