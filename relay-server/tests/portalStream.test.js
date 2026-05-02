/**
 * Tests for the portal SSE snapshot helpers.
 *
 * These cover the bug where SSE clients that subscribed *after* a church's
 * agent had already established its bridges only saw delta frames going
 * forward and were stuck with whatever partial state existed at subscribe
 * time. The fix: every subscribe must emit a fresh full snapshot pulled from
 * the post-merge observed state, and a periodic heartbeat re-emits a full
 * snapshot so any client that missed a delta self-heals.
 */

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  buildPortalSnapshot,
  sendPortalSnapshotToClient,
  broadcastPortalSnapshot,
  broadcastAllPortalSnapshots,
  startPortalSnapshotHeartbeat,
} = require('../src/portalStream');

// ─── Test fakes ───────────────────────────────────────────────────────────────

function makeFakeRes() {
  const writes = [];
  return {
    writes,
    write(chunk) {
      writes.push(chunk);
      return true;
    },
    parsedFrames() {
      return writes
        .filter((w) => w.startsWith('data: '))
        .map((w) => JSON.parse(w.slice('data: '.length).trimEnd()));
    },
  };
}

function makeChurch({ churchId = 'church-1', connected = true, instances = {} } = {}) {
  const instanceStatus = {};
  const roomInstanceMap = {};
  for (const [inst, def] of Object.entries(instances)) {
    instanceStatus[inst] = { ...def.status };
    if (def.roomId) roomInstanceMap[def.roomId] = inst;
  }
  const primary = Object.keys(instanceStatus).sort()[0];
  return {
    churchId,
    name: 'Test Church',
    connected,
    status: primary ? { ...instanceStatus[primary] } : {},
    instanceStatus,
    roomInstanceMap,
    lastSeen: '2026-05-02T17:00:00.000Z',
  };
}

// `runtime` simulates the in-process state owned by websocketRouter:
// instanceStatus is rebuilt on each status_update, and getObservedChurch
// returns the post-merge view at call time (same contract as runtimeMirror).
function makeRuntime() {
  const churches = new Map();
  const portalSseClients = new Map();
  function getObservedChurch(churchId) {
    return churches.get(churchId) || null;
  }
  function setChurch(church) {
    churches.set(church.churchId, church);
  }
  function applyInstanceStatus(churchId, instance, statusPatch, roomId = null) {
    const existing = churches.get(churchId) || makeChurch({ churchId, connected: true });
    existing.instanceStatus = existing.instanceStatus || {};
    existing.instanceStatus[instance] = { ...(existing.instanceStatus[instance] || {}), ...statusPatch };
    if (roomId) {
      existing.roomInstanceMap = existing.roomInstanceMap || {};
      existing.roomInstanceMap[roomId] = instance;
    }
    const primary = Object.keys(existing.instanceStatus).sort()[0];
    existing.status = { ...existing.instanceStatus[primary] };
    existing.connected = true;
    existing.lastSeen = '2026-05-02T17:00:01.000Z';
    churches.set(churchId, existing);
  }
  function subscribe(churchId, res) {
    if (!portalSseClients.has(churchId)) portalSseClients.set(churchId, new Set());
    portalSseClients.get(churchId).add(res);
  }
  return { churches, portalSseClients, getObservedChurch, setChurch, applyInstanceStatus, subscribe };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildPortalSnapshot', () => {
  it('emits a status_snapshot frame containing every instance and the merged status', () => {
    const church = makeChurch({
      instances: {
        primary:  { roomId: 'room-main',  status: { atem: { connected: true, programInput: 1 }, obs:  { connected: true, streaming: true } } },
        sanctuary:{ roomId: 'room-sanc',  status: { atem: { connected: true, programInput: 3 }, obs:  { connected: true, streaming: false } } },
      },
    });

    const frame = buildPortalSnapshot(church);

    expect(frame.type).toBe('status_snapshot');
    expect(frame.connected).toBe(true);
    expect(Object.keys(frame.instanceStatus).sort()).toEqual(['primary', 'sanctuary']);
    expect(frame.instanceStatus.primary.atem.programInput).toBe(1);
    expect(frame.instanceStatus.sanctuary.obs.streaming).toBe(false);
    expect(frame.roomInstanceMap['room-main']).toBe('primary');
    expect(frame.roomInstanceMap['room-sanc']).toBe('sanctuary');
    // The merged `status` field reflects the primary (alphabetically first) instance
    expect(frame.status.atem.programInput).toBe(1);
  });

  it('returns an empty-but-shaped frame when the church is unknown', () => {
    const frame = buildPortalSnapshot(null);
    expect(frame).toEqual({
      type: 'status_snapshot',
      connected: false,
      status: {},
      instanceStatus: {},
      roomInstanceMap: {},
      lastSeen: null,
    });
  });
});

describe('sendPortalSnapshotToClient', () => {
  it('writes the SSE-framed snapshot for the current observed church', () => {
    const runtime = makeRuntime();
    runtime.setChurch(makeChurch({
      instances: { primary: { roomId: 'room-main', status: { atem: { connected: true } } } },
    }));
    const res = makeFakeRes();

    sendPortalSnapshotToClient(res, 'church-1', runtime.getObservedChurch);

    expect(res.writes).toHaveLength(1);
    expect(res.writes[0].startsWith('data: ')).toBe(true);
    expect(res.writes[0].endsWith('\n\n')).toBe(true);
    const frame = res.parsedFrames()[0];
    expect(frame.type).toBe('status_snapshot');
    expect(frame.instanceStatus.primary.atem.connected).toBe(true);
  });

  it('regression: a client that subscribes after all bridges are up still receives a full snapshot containing every bridge', async () => {
    // Reproduces the production bug: agent reconnects, instanceStatus gets
    // rebuilt incrementally, an SSE client subscribes only after the bridge
    // state is fully established. With the old code that client would have
    // gotten whatever was in the cached snapshot at agent-reconnect time and
    // then only deltas after — leaving stale/blank bridges. With the fix the
    // subscribe-time snapshot is pulled fresh from getObservedChurch.

    const runtime = makeRuntime();

    // Simulate an agent reconnect that publishes its bridges one at a time
    runtime.applyInstanceStatus('church-1', 'primary', {
      atem:    { connected: true, programInput: 2 },
      obs:     { connected: true, streaming: false },
      vmix:    { connected: false },
      youtube: { connected: true, broadcastId: 'yt-123' },
    }, 'room-main');
    runtime.applyInstanceStatus('church-1', 'sanctuary', {
      atem:    { connected: true, programInput: 5 },
      obs:     { connected: true, streaming: true },
    }, 'room-sanc');

    // Wait the requested 2s — sped up so the test stays fast. The only thing
    // that matters is that the subscribe happens after the state is settled.
    await new Promise((r) => setTimeout(r, 20));

    const res = makeFakeRes();
    sendPortalSnapshotToClient(res, 'church-1', runtime.getObservedChurch);

    const frames = res.parsedFrames();
    expect(frames).toHaveLength(1);
    const [frame] = frames;
    expect(frame.type).toBe('status_snapshot');
    expect(frame.connected).toBe(true);

    // Both bridges must be present — this is the assertion that fails under
    // the bug: only the most-recent instance would appear, with a partial
    // bridge set.
    expect(Object.keys(frame.instanceStatus).sort()).toEqual(['primary', 'sanctuary']);
    expect(frame.instanceStatus.primary.atem.programInput).toBe(2);
    expect(frame.instanceStatus.primary.obs.streaming).toBe(false);
    expect(frame.instanceStatus.primary.vmix.connected).toBe(false);
    expect(frame.instanceStatus.primary.youtube.broadcastId).toBe('yt-123');
    expect(frame.instanceStatus.sanctuary.atem.programInput).toBe(5);
    expect(frame.instanceStatus.sanctuary.obs.streaming).toBe(true);
    expect(frame.roomInstanceMap['room-main']).toBe('primary');
    expect(frame.roomInstanceMap['room-sanc']).toBe('sanctuary');
  });

  it('returns false (and does not throw) when getObservedChurch is missing', () => {
    const res = makeFakeRes();
    expect(sendPortalSnapshotToClient(res, 'church-1', null)).toBe(false);
    expect(res.writes).toHaveLength(0);
  });

  it('swallows write errors from a dead client', () => {
    const runtime = makeRuntime();
    runtime.setChurch(makeChurch());
    const dead = { write: () => { throw new Error('EPIPE'); } };
    expect(() => sendPortalSnapshotToClient(dead, 'church-1', runtime.getObservedChurch)).not.toThrow();
  });
});

describe('broadcastPortalSnapshot', () => {
  it('sends one fresh snapshot to every subscriber for that church', () => {
    const runtime = makeRuntime();
    runtime.setChurch(makeChurch({
      instances: { primary: { roomId: 'room-main', status: { atem: { connected: true } } } },
    }));
    const res1 = makeFakeRes();
    const res2 = makeFakeRes();
    runtime.subscribe('church-1', res1);
    runtime.subscribe('church-1', res2);

    const sent = broadcastPortalSnapshot('church-1', {
      portalSseClients: runtime.portalSseClients,
      getObservedChurch: runtime.getObservedChurch,
    });

    expect(sent).toBe(2);
    expect(res1.parsedFrames()[0].instanceStatus.primary.atem.connected).toBe(true);
    expect(res2.parsedFrames()[0].instanceStatus.primary.atem.connected).toBe(true);
  });

  it('returns 0 when no clients are subscribed', () => {
    const runtime = makeRuntime();
    runtime.setChurch(makeChurch());
    const sent = broadcastPortalSnapshot('church-1', {
      portalSseClients: runtime.portalSseClients,
      getObservedChurch: runtime.getObservedChurch,
    });
    expect(sent).toBe(0);
  });
});

describe('broadcastAllPortalSnapshots', () => {
  it('sends per-church snapshots to every subscribed church', () => {
    const runtime = makeRuntime();
    runtime.setChurch(makeChurch({ churchId: 'church-1', instances: { primary: { status: { atem: { connected: true, programInput: 1 } } } } }));
    runtime.setChurch(makeChurch({ churchId: 'church-2', instances: { primary: { status: { atem: { connected: true, programInput: 9 } } } } }));
    const a = makeFakeRes();
    const b = makeFakeRes();
    runtime.subscribe('church-1', a);
    runtime.subscribe('church-2', b);

    const sent = broadcastAllPortalSnapshots({
      portalSseClients: runtime.portalSseClients,
      getObservedChurch: runtime.getObservedChurch,
    });

    expect(sent).toBe(2);
    expect(a.parsedFrames()[0].instanceStatus.primary.atem.programInput).toBe(1);
    expect(b.parsedFrames()[0].instanceStatus.primary.atem.programInput).toBe(9);
  });
});

describe('startPortalSnapshotHeartbeat', () => {
  it('periodically broadcasts a fresh snapshot to all subscribers', () => {
    vi.useFakeTimers();
    try {
      const runtime = makeRuntime();
      runtime.setChurch(makeChurch({ instances: { primary: { status: { atem: { connected: true, programInput: 1 } } } } }));
      const res = makeFakeRes();
      runtime.subscribe('church-1', res);

      const handle = startPortalSnapshotHeartbeat({
        portalSseClients: runtime.portalSseClients,
        getObservedChurch: runtime.getObservedChurch,
        intervalMs: 1000,
      });

      // First tick — agent state is unchanged
      vi.advanceTimersByTime(1000);
      expect(res.parsedFrames()).toHaveLength(1);
      expect(res.parsedFrames()[0].instanceStatus.primary.atem.programInput).toBe(1);

      // State shifts (e.g. a delta the client somehow missed) — heartbeat
      // must reflect the new merged value.
      runtime.applyInstanceStatus('church-1', 'primary', { atem: { connected: true, programInput: 7 } });

      vi.advanceTimersByTime(1000);
      const frames = res.parsedFrames();
      expect(frames).toHaveLength(2);
      expect(frames[1].instanceStatus.primary.atem.programInput).toBe(7);

      clearInterval(handle);
    } finally {
      vi.useRealTimers();
    }
  });
});
