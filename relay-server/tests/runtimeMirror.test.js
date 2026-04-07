import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createRuntimeMirror } = require('../src/runtimeMirror');

function makeLocalChurch(overrides = {}) {
  return {
    churchId: 'church-1',
    name: 'Grace Church',
    sockets: new Map(),
    ws: null,
    status: {},
    instanceStatus: {},
    roomInstanceMap: {},
    lastSeen: null,
    lastHeartbeat: null,
    church_type: 'recurring',
    reseller_id: null,
    audio_via_atem: 0,
    ...overrides,
  };
}

describe('runtimeMirror', () => {
  it('uses remote connected state when the local instance has no live socket', () => {
    const churches = new Map([
      ['church-1', makeLocalChurch({ status: { connected: false } })],
    ]);
    const mirror = createRuntimeMirror({
      churches,
      runtimeCoordinator: { enabled: true, instanceId: 'local-1' },
      wsOpen: 1,
    });

    mirror.applyEvent({
      type: 'church_status',
      instanceId: 'remote-2',
      timestamp: '2026-04-05T20:00:00.000Z',
      payload: {
        church: {
          churchId: 'church-1',
          name: 'Grace Church',
          connected: true,
          status: { atem: { connected: true } },
          lastSeen: '2026-04-05T20:00:00.000Z',
          lastHeartbeat: 1234,
          instanceStatus: { sanctuary: { atem: { connected: true } } },
          roomInstanceMap: { roomA: 'sanctuary' },
          instances: ['sanctuary'],
        },
      },
    });

    const observed = mirror.getObservedChurch('church-1');
    expect(observed.connected).toBe(true);
    expect(observed.instances).toEqual(['sanctuary']);
    expect(observed.roomInstanceMap).toEqual({ roomA: 'sanctuary' });
    expect(observed.status).toMatchObject({ atem: { connected: true } });
  });

  it('keeps local connected state authoritative when this instance still has a live socket', () => {
    const churches = new Map([
      ['church-1', makeLocalChurch({
        sockets: new Map([['local-room', { readyState: 1 }]]),
        status: { local: true },
        instanceStatus: { 'local-room': { local: true } },
        roomInstanceMap: { roomA: 'local-room' },
      })],
    ]);
    const mirror = createRuntimeMirror({
      churches,
      runtimeCoordinator: { enabled: true, instanceId: 'local-1' },
      wsOpen: 1,
    });

    mirror.applyEvent({
      type: 'church_status',
      instanceId: 'remote-2',
      timestamp: '2026-04-05T20:00:00.000Z',
      payload: {
        church: {
          churchId: 'church-1',
          name: 'Grace Church',
          connected: true,
          status: { remote: true },
          lastSeen: '2026-04-05T20:00:00.000Z',
          instanceStatus: { remote: { remote: true } },
          roomInstanceMap: { roomB: 'remote' },
          instances: ['remote'],
        },
      },
    });

    const observed = mirror.getObservedChurch('church-1');
    expect(observed.connected).toBe(true);
    expect(observed.status).toEqual({ local: true });
    expect(new Set(observed.instances)).toEqual(new Set(['local-room', 'remote']));
    expect(observed.roomInstanceMap).toEqual({ roomA: 'local-room' });
  });

  it('ignores events published by the same runtime instance', () => {
    const churches = new Map();
    const mirror = createRuntimeMirror({
      churches,
      runtimeCoordinator: { enabled: true, instanceId: 'local-1' },
      wsOpen: 1,
    });

    const applied = mirror.applyEvent({
      type: 'church_connected',
      instanceId: 'local-1',
      payload: {
        church: {
          churchId: 'church-1',
          name: 'Grace Church',
          connected: true,
        },
      },
    });

    expect(applied).toBeNull();
    expect(mirror.listObservedChurches()).toEqual([]);
  });

  it('aggregates the same church across multiple relay instances', () => {
    const mirror = createRuntimeMirror({
      churches: new Map(),
      runtimeCoordinator: { enabled: true, instanceId: 'local-1' },
      wsOpen: 1,
    });

    mirror.applyEvent({
      type: 'church_status',
      instanceId: 'remote-a',
      timestamp: '2026-04-05T20:00:00.000Z',
      payload: {
        church: {
          churchId: 'church-1',
          name: 'Grace Church',
          connected: true,
          status: { site: 'A' },
          instanceStatus: { sanctuary: { site: 'A' } },
          roomInstanceMap: { roomA: 'sanctuary' },
          instances: ['sanctuary'],
        },
      },
    });
    mirror.applyEvent({
      type: 'church_status',
      instanceId: 'remote-b',
      timestamp: '2026-04-05T20:00:01.000Z',
      payload: {
        church: {
          churchId: 'church-1',
          name: 'Grace Church',
          connected: true,
          status: { site: 'B' },
          instanceStatus: { chapel: { site: 'B' } },
          roomInstanceMap: { roomB: 'chapel' },
          instances: ['chapel'],
        },
      },
    });

    const observed = mirror.getObservedChurch('church-1');
    expect(observed.connected).toBe(true);
    expect(new Set(observed.instances)).toEqual(new Set(['sanctuary', 'chapel']));
    expect(observed.instanceStatus).toMatchObject({
      sanctuary: { site: 'A' },
      chapel: { site: 'B' },
    });
    expect(observed.roomInstanceMap).toMatchObject({
      roomA: 'sanctuary',
      roomB: 'chapel',
    });
  });
});
