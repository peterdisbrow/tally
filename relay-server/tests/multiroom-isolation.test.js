/**
 * Multi-room isolation tests for the relay's WebSocket layer.
 *
 * Covers four scenarios that aren't exercised by the existing single-room
 * suites:
 *
 *   1. Status isolation     — two rooms send conflicting status_update frames;
 *                             neither bleeds into the other's instanceStatus
 *                             or controller broadcasts.
 *   2. Per-room commands    — a controller dispatches a command targeting room
 *                             A's instance; only A's socket receives it.
 *   3. Portal snapshot      — buildPortalSnapshot returns full per-instance
 *                             segmentation so the portal can pick the right
 *                             room. /api/church/me filters when ?roomId= is
 *                             specified (covered by churchPortal tests; here
 *                             we just guard the shared helper).
 *   5. Close-handler race   — when room A's socket gets replaced and the old
 *                             one's 'close' event fires AFTER the new socket
 *                             is in place, room B's instanceStatus, room map,
 *                             and deltaTracker snapshot must be untouched.
 *
 * The tests run against the REAL createWebSocketHandlers factory and a real
 * ws server, mirroring the pattern in websocket-routing.test.js.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import http from 'http';

const require = createRequire(import.meta.url);
const { WebSocketServer, WebSocket } = require('ws');
const jwt = require('jsonwebtoken');
const { createWebSocketHandlers } = require('../src/websocketRouter');
const { createDeltaTracker } = require('../src/deltaUpdates');
const { buildPortalSnapshot } = require('../src/portalStream');

const JWT_SECRET    = 'test-multiroom-secret';
const ADMIN_API_KEY = 'test-admin-key-multiroom';

// ─── Helpers (parallel the patterns in websocket-routing.test.js) ─────────────

function makeChurchEntry(id, name) {
  return {
    churchId: id,
    name,
    ws: null,
    sockets: new Map(),
    status: {},
    instanceStatus: {},
    roomInstanceMap: {},
    lastSeen: null,
    lastHeartbeat: null,
    disconnectedAt: null,
    _offlineAlertSent: false,
  };
}

function signToken(churchId) {
  return jwt.sign({ churchId }, JWT_SECRET, { expiresIn: '1h' });
}

/**
 * Build a real http+ws server wired to the real routing factory.
 * Captures portal/SSE broadcasts so tests can assert on them.
 */
async function buildTestServer(overrides = {}) {
  const churches    = new Map();
  const controllers = new Set();
  const portalBroadcasts = []; // { churchId, data }
  const sseBroadcasts    = []; // raw events
  const deltaTracker = createDeltaTracker();

  const handlers = createWebSocketHandlers({
    churches,
    controllers,
    jwt,
    jwtSecret: JWT_SECRET,
    wsOpen: WebSocket.OPEN,
    adminApiKey: ADMIN_API_KEY,
    wsPingIntervalMs: 0,
    deltaTracker,
    broadcastToPortal: (churchId, data) => portalBroadcasts.push({ churchId, data }),
    broadcastToSSE: (data) => sseBroadcasts.push(data),
    ...overrides,
  });

  const httpServer = http.createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const role = url.pathname.replace(/^\//, '');
    if (role === 'church') handlers.handleChurchConnection(ws, url, req.socket.remoteAddress || '127.0.0.1');
    else if (role === 'controller') handlers.handleControllerConnection(ws, url, req);
    else ws.close(1008, 'Unknown role');
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.removeListener('error', reject);
      const { port } = httpServer.address();
      resolve({
        url: `ws://127.0.0.1:${port}`,
        churches,
        controllers,
        handlers,
        deltaTracker,
        portalBroadcasts,
        sseBroadcasts,
        close: () => new Promise((res) => {
          for (const ws of wss.clients) ws.terminate();
          wss.close(() => httpServer.close(res));
        }),
      });
    });
  });
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const q = { pending: [], waiters: [] };
    ws._q = q;
    ws.on('message', (data) => {
      if (q.waiters.length > 0) q.waiters.shift()(data);
      else q.pending.push(data);
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('close', (code, reason) => {
      reject(new Error(`WS closed before open — code ${code} reason "${reason}"`));
    });
  });
}

function nextMessage(ws, timeoutMs = 2000) {
  const q = ws._q;
  if (q?.pending.length > 0) return Promise.resolve(JSON.parse(q.pending.shift().toString()));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (q) {
        const i = q.waiters.indexOf(waiter);
        if (i !== -1) q.waiters.splice(i, 1);
      }
      reject(new Error('nextMessage timeout'));
    }, timeoutMs);
    function waiter(data) {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    }
    if (q) q.waiters.push(waiter);
    else ws.once('message', waiter);
  });
}

function send(ws, obj) { ws.send(JSON.stringify(obj)); }

function closeWs(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once('close', resolve);
    ws.close();
  });
}

/** Drain anything currently buffered, returning the parsed array. */
function drainPending(ws) {
  const q = ws._q;
  if (!q) return [];
  return q.pending.splice(0).map(d => JSON.parse(d.toString()));
}

/** Wait until predicate(latest msgs) is true or timeout. */
async function waitFor(checkFn, timeoutMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (checkFn()) return true;
    await new Promise(r => setTimeout(r, 10));
  }
  return false;
}

/**
 * Connect a "church agent" for a specific room. The instance name uses the
 * `Sanctuary::room_id` convention the desktop app emits.
 */
async function connectAgent(serverUrl, churchId, roomLabel, roomId) {
  const token = signToken(churchId);
  const ws = await connect(`${serverUrl}/church?token=${token}&instance=${encodeURIComponent(roomLabel)}&room_id=${encodeURIComponent(roomId)}`);
  // Consume the "connected" ack
  const ack = await nextMessage(ws);
  return { ws, ack };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('Multi-room isolation — two rooms under one church', () => {
  let server;

  beforeEach(async () => {
    server = await buildTestServer({
      // Allow Pro tier for the seeded church (default infinite is fine).
      checkPaidAccess: () => ({ allowed: true, tier: 'pro', maxRooms: 5 }),
      // Always validate roomId for these tests so roomInstanceMap gets populated.
      validateRoomId: () => true,
    });
    server.churches.set('church-1', makeChurchEntry('church-1', 'Grace Church'));
  });

  afterEach(async () => {
    await server.close();
  });

  // ── Item 1: status updates from each room stay isolated ─────────────────────

  describe('1. Status isolation across simultaneous rooms', () => {
    it("status_update in room A does NOT bleed into room B's instanceStatus", async () => {
      const sanctuary = await connectAgent(server.url, 'church-1', 'Sanctuary', 'room-sanctuary');
      const youth     = await connectAgent(server.url, 'church-1', 'Youth',     'room-youth');

      // Sanctuary reports an ATEM that's connected with a specific program input
      send(sanctuary.ws, {
        type: 'status_update',
        status: {
          system: { roomId: 'room-sanctuary' },
          atem: { connected: true, programInput: 1 },
        },
      });

      // Youth reports OBS streaming with no ATEM
      send(youth.ws, {
        type: 'status_update',
        status: {
          system: { roomId: 'room-youth' },
          obs: { connected: true, streaming: true },
        },
      });

      // Wait for both updates to be processed by the server
      await waitFor(() => {
        const c = server.churches.get('church-1');
        return c.instanceStatus['Sanctuary::room-sanctuary']?.atem?.programInput === 1
            && c.instanceStatus['Youth::room-youth']?.obs?.streaming === true;
      });

      const church = server.churches.get('church-1');

      // Sanctuary's instance has ATEM, no OBS
      const sanctStatus = church.instanceStatus['Sanctuary::room-sanctuary'];
      expect(sanctStatus.atem?.programInput).toBe(1);
      expect(sanctStatus.obs).toBeUndefined();

      // Youth's instance has OBS, no ATEM
      const youthStatus = church.instanceStatus['Youth::room-youth'];
      expect(youthStatus.obs?.streaming).toBe(true);
      expect(youthStatus.atem).toBeUndefined();

      // roomInstanceMap is populated for both rooms
      expect(church.roomInstanceMap['room-sanctuary']).toBe('Sanctuary::room-sanctuary');
      expect(church.roomInstanceMap['room-youth']).toBe('Youth::room-youth');

      await closeWs(sanctuary.ws);
      await closeWs(youth.ws);
    });

    it('controller status_update events tag each broadcast with the originating instance', async () => {
      const ctrl = await connect(`${server.url}/controller?apikey=${ADMIN_API_KEY}`);
      await nextMessage(ctrl); // church_list

      const sanctuary = await connectAgent(server.url, 'church-1', 'Sanctuary', 'room-sanctuary');
      await nextMessage(ctrl); // church_connected (sanctuary)

      const youth = await connectAgent(server.url, 'church-1', 'Youth', 'room-youth');
      await nextMessage(ctrl); // church_connected (youth)

      send(sanctuary.ws, {
        type: 'status_update',
        status: {
          system: { roomId: 'room-sanctuary' },
          atem: { connected: true, programInput: 3 },
        },
      });
      const sanctEvent = await nextMessage(ctrl);
      expect(sanctEvent.type).toBe('status_update');
      expect(sanctEvent.instance).toBe('Sanctuary::room-sanctuary');
      expect(sanctEvent.instanceStatus['Sanctuary::room-sanctuary']?.atem?.programInput).toBe(3);

      send(youth.ws, {
        type: 'status_update',
        status: {
          system: { roomId: 'room-youth' },
          obs: { connected: true, streaming: true },
        },
      });
      const youthEvent = await nextMessage(ctrl);
      expect(youthEvent.type).toBe('status_update');
      expect(youthEvent.instance).toBe('Youth::room-youth');
      expect(youthEvent.instanceStatus['Youth::room-youth']?.obs?.streaming).toBe(true);

      // The status_update for room A doesn't include room B's bridges in the
      // primary `status` field for room A's broadcast, BUT instanceStatus is
      // the union view (so the portal can render both rooms).
      // The key isolation assertion: room A's update doesn't leak room B fields
      // into instanceStatus[A].
      expect(sanctEvent.instanceStatus['Sanctuary::room-sanctuary']?.obs).toBeUndefined();
      expect(youthEvent.instanceStatus['Youth::room-youth']?.atem).toBeUndefined();

      await closeWs(sanctuary.ws);
      await closeWs(youth.ws);
      await closeWs(ctrl);
    });

    it('SSE broadcasts include per-instance status segmentation', async () => {
      const sanctuary = await connectAgent(server.url, 'church-1', 'Sanctuary', 'room-sanctuary');
      const youth     = await connectAgent(server.url, 'church-1', 'Youth',     'room-youth');

      // Reset broadcasts to ignore church_connected events
      const baseLen = server.sseBroadcasts.length;

      send(sanctuary.ws, {
        type: 'status_update',
        status: { system: { roomId: 'room-sanctuary' }, atem: { connected: true } },
      });
      send(youth.ws, {
        type: 'status_update',
        status: { system: { roomId: 'room-youth' }, obs: { connected: true } },
      });

      await waitFor(() => server.sseBroadcasts.length >= baseLen + 2);

      const newBroadcasts = server.sseBroadcasts.slice(baseLen);
      const statusEvents = newBroadcasts.filter(e => e.type === 'status_update');
      expect(statusEvents.length).toBeGreaterThanOrEqual(2);

      const fromSanct = statusEvents.find(e => e.instance === 'Sanctuary::room-sanctuary');
      const fromYouth = statusEvents.find(e => e.instance === 'Youth::room-youth');
      expect(fromSanct).toBeDefined();
      expect(fromYouth).toBeDefined();

      // Each event keeps its own instance status keyed by the sender
      expect(fromSanct.instanceStatus['Sanctuary::room-sanctuary']?.atem?.connected).toBe(true);
      expect(fromYouth.instanceStatus['Youth::room-youth']?.obs?.connected).toBe(true);

      await closeWs(sanctuary.ws);
      await closeWs(youth.ws);
    });
  });

  // ── Item 2: room-scoped commands target only the right instance ────────────

  describe('2. Per-room commands', () => {
    it("controller command with instance=A is delivered ONLY to room A's socket", async () => {
      const sanctuary = await connectAgent(server.url, 'church-1', 'Sanctuary', 'room-sanctuary');
      const youth     = await connectAgent(server.url, 'church-1', 'Youth',     'room-youth');

      const ctrl = await connect(`${server.url}/controller?apikey=${ADMIN_API_KEY}`);
      await nextMessage(ctrl); // church_list

      // Drain anything buffered on the agent sockets so we start clean.
      drainPending(sanctuary.ws);
      drainPending(youth.ws);

      // Controller targets room A specifically via `instance` field
      send(ctrl, {
        type: 'command',
        churchId: 'church-1',
        instance: 'Sanctuary::room-sanctuary',
        command: 'atem.cut',
        params: {},
      });

      const sanctMsg = await nextMessage(sanctuary.ws);
      expect(sanctMsg.type).toBe('command');
      expect(sanctMsg.command).toBe('atem.cut');

      // Youth must receive nothing within a generous window
      const silence = await Promise.race([
        nextMessage(youth.ws, 300).catch(() => 'silence'),
        new Promise(r => setTimeout(() => r('silence'), 250)),
      ]);
      expect(silence).toBe('silence');

      await closeWs(sanctuary.ws);
      await closeWs(youth.ws);
      await closeWs(ctrl);
    });

    it('command with no instance broadcasts to BOTH rooms', async () => {
      const sanctuary = await connectAgent(server.url, 'church-1', 'Sanctuary', 'room-sanctuary');
      const youth     = await connectAgent(server.url, 'church-1', 'Youth',     'room-youth');

      const ctrl = await connect(`${server.url}/controller?apikey=${ADMIN_API_KEY}`);
      await nextMessage(ctrl);
      drainPending(sanctuary.ws);
      drainPending(youth.ws);

      send(ctrl, {
        type: 'command',
        churchId: 'church-1',
        command: 'system.refresh',
        params: {},
      });

      const [sanctMsg, youthMsg] = await Promise.all([
        nextMessage(sanctuary.ws),
        nextMessage(youth.ws),
      ]);
      expect(sanctMsg.command).toBe('system.refresh');
      expect(youthMsg.command).toBe('system.refresh');

      await closeWs(sanctuary.ws);
      await closeWs(youth.ws);
      await closeWs(ctrl);
    });
  });

  // ── Item 3: buildPortalSnapshot segments per room ──────────────────────────

  describe('3. Portal snapshot per room', () => {
    it('buildPortalSnapshot returns instanceStatus + roomInstanceMap so portal can segment', async () => {
      const sanctuary = await connectAgent(server.url, 'church-1', 'Sanctuary', 'room-sanctuary');
      const youth     = await connectAgent(server.url, 'church-1', 'Youth',     'room-youth');

      send(sanctuary.ws, {
        type: 'status_update',
        status: { system: { roomId: 'room-sanctuary' }, atem: { connected: true, programInput: 5 } },
      });
      send(youth.ws, {
        type: 'status_update',
        status: { system: { roomId: 'room-youth' }, obs: { connected: true, streaming: true } },
      });

      await waitFor(() => {
        const c = server.churches.get('church-1');
        return c.instanceStatus['Sanctuary::room-sanctuary']?.atem
            && c.instanceStatus['Youth::room-youth']?.obs;
      });

      // Build a snapshot from the runtime as the portal would
      const observed = {
        ...server.churches.get('church-1'),
        connected: true,
      };
      const snap = buildPortalSnapshot(observed);

      expect(snap.type).toBe('status_snapshot');
      expect(snap.connected).toBe(true);

      // instanceStatus contains BOTH rooms keyed independently
      expect(snap.instanceStatus['Sanctuary::room-sanctuary']?.atem?.programInput).toBe(5);
      expect(snap.instanceStatus['Youth::room-youth']?.obs?.streaming).toBe(true);

      // No bleed: sanctuary key has no obs, youth key has no atem
      expect(snap.instanceStatus['Sanctuary::room-sanctuary']?.obs).toBeUndefined();
      expect(snap.instanceStatus['Youth::room-youth']?.atem).toBeUndefined();

      // roomInstanceMap maps each roomId to its instance name
      expect(snap.roomInstanceMap['room-sanctuary']).toBe('Sanctuary::room-sanctuary');
      expect(snap.roomInstanceMap['room-youth']).toBe('Youth::room-youth');

      await closeWs(sanctuary.ws);
      await closeWs(youth.ws);
    });

    it('buildPortalSnapshot emits empty maps for a runtime with no rooms', () => {
      const empty = { connected: false, status: {}, instanceStatus: {}, roomInstanceMap: {}, lastSeen: null };
      const snap = buildPortalSnapshot(empty);
      expect(snap.instanceStatus).toEqual({});
      expect(snap.roomInstanceMap).toEqual({});
      expect(snap.connected).toBe(false);
    });

    it('per-room portal broadcasts arrive with instance + instanceStatus tagged', async () => {
      const sanctuary = await connectAgent(server.url, 'church-1', 'Sanctuary', 'room-sanctuary');
      const youth     = await connectAgent(server.url, 'church-1', 'Youth',     'room-youth');

      const baseLen = server.portalBroadcasts.length;

      send(sanctuary.ws, {
        type: 'status_update',
        status: { system: { roomId: 'room-sanctuary' }, atem: { connected: true } },
      });
      send(youth.ws, {
        type: 'status_update',
        status: { system: { roomId: 'room-youth' }, obs: { connected: true } },
      });

      await waitFor(() => server.portalBroadcasts.length >= baseLen + 2);

      const newer = server.portalBroadcasts.slice(baseLen).filter(b => b.data.type === 'status_update');
      const fromSanct = newer.find(b => b.data.instance === 'Sanctuary::room-sanctuary');
      const fromYouth = newer.find(b => b.data.instance === 'Youth::room-youth');

      expect(fromSanct?.churchId).toBe('church-1');
      expect(fromSanct.data.instanceStatus['Sanctuary::room-sanctuary']?.atem?.connected).toBe(true);
      expect(fromYouth?.churchId).toBe('church-1');
      expect(fromYouth.data.instanceStatus['Youth::room-youth']?.obs?.connected).toBe(true);

      // The roomInstanceMap travels with every broadcast so a portal client
      // that joined late can still resolve room → instance without a refetch.
      expect(fromSanct.data.roomInstanceMap['room-sanctuary']).toBe('Sanctuary::room-sanctuary');
      expect(fromYouth.data.roomInstanceMap['room-youth']).toBe('Youth::room-youth');

      await closeWs(sanctuary.ws);
      await closeWs(youth.ws);
    });
  });

  // ── Item 5: PR #67 race fix — concurrent rooms during a reconnect ───────────

  describe('5. Close-handler race fix preserves the OTHER room', () => {
    it("when room A's socket is replaced, room B's instanceStatus + roomInstanceMap survive", async () => {
      const sanctuary = await connectAgent(server.url, 'church-1', 'Sanctuary', 'room-sanctuary');
      const youth     = await connectAgent(server.url, 'church-1', 'Youth',     'room-youth');

      // Populate state for both rooms
      send(sanctuary.ws, {
        type: 'status_update',
        status: { system: { roomId: 'room-sanctuary' }, atem: { connected: true } },
      });
      send(youth.ws, {
        type: 'status_update',
        status: { system: { roomId: 'room-youth' }, obs: { connected: true, streaming: true } },
      });

      await waitFor(() => {
        const c = server.churches.get('church-1');
        return c.instanceStatus['Sanctuary::room-sanctuary']?.atem?.connected
            && c.instanceStatus['Youth::room-youth']?.obs?.streaming;
      });

      // Now reconnect the SANCTUARY socket — same room_id and instance label.
      // The server's handler closes the old socket and installs the new one.
      const sanctReplacement = await connectAgent(server.url, 'church-1', 'Sanctuary', 'room-sanctuary');

      // Wait for the old sanctuary socket's 'close' handler to fire on the
      // server side. After PR #67, it must NOT delete instanceStatus or
      // roomInstanceMap because the slot is now owned by the replacement.
      await new Promise(r => setTimeout(r, 80));

      const church = server.churches.get('church-1');

      // Room B (Youth) is completely untouched
      expect(church.instanceStatus['Youth::room-youth']?.obs?.streaming).toBe(true);
      expect(church.roomInstanceMap['room-youth']).toBe('Youth::room-youth');

      // Room A's data is preserved across the swap (the new socket hasn't
      // sent any status_update yet — without the PR #67 fix it would be wiped)
      expect(church.instanceStatus['Sanctuary::room-sanctuary']?.atem?.connected).toBe(true);
      expect(church.roomInstanceMap['room-sanctuary']).toBe('Sanctuary::room-sanctuary');

      // The deltaTracker snapshot for room B must still exist — without the
      // PR #67 fix the old room A close would've called clearSnapshot for
      // its OWN key, which never affects room B; but to be safe, verify it.
      const trackerSnaps = server.deltaTracker._snapshots;
      expect(trackerSnaps.has('church-1::Youth::room-youth')).toBe(true);

      await closeWs(sanctReplacement.ws);
      await closeWs(youth.ws);
    });

    it("legitimate disconnect of room A leaves room B's state intact", async () => {
      const sanctuary = await connectAgent(server.url, 'church-1', 'Sanctuary', 'room-sanctuary');
      const youth     = await connectAgent(server.url, 'church-1', 'Youth',     'room-youth');

      send(sanctuary.ws, {
        type: 'status_update',
        status: { system: { roomId: 'room-sanctuary' }, atem: { connected: true } },
      });
      send(youth.ws, {
        type: 'status_update',
        status: { system: { roomId: 'room-youth' }, obs: { connected: true } },
      });

      await waitFor(() => {
        const c = server.churches.get('church-1');
        return c.instanceStatus['Sanctuary::room-sanctuary']
            && c.instanceStatus['Youth::room-youth'];
      });

      // Hard close the sanctuary socket WITHOUT a replacement
      await closeWs(sanctuary.ws);
      await new Promise(r => setTimeout(r, 80));

      const church = server.churches.get('church-1');

      // Sanctuary's per-instance state is gone (real disconnect — clean up
      // is correct here)
      expect(church.instanceStatus['Sanctuary::room-sanctuary']).toBeUndefined();
      expect(church.roomInstanceMap['room-sanctuary']).toBeUndefined();

      // Youth's state is fully preserved
      expect(church.instanceStatus['Youth::room-youth']?.obs?.connected).toBe(true);
      expect(church.roomInstanceMap['room-youth']).toBe('Youth::room-youth');

      // church.status falls back to the remaining instance (Youth) — this is
      // important so the legacy /controller "status" field doesn't go blank.
      expect(church.status?.obs?.connected).toBe(true);

      await closeWs(youth.ws);
    });

    it("emits instance_disconnected (room-scoped) when room A drops with room B still online", async () => {
      const sanctuary = await connectAgent(server.url, 'church-1', 'Sanctuary', 'room-sanctuary');
      const youth     = await connectAgent(server.url, 'church-1', 'Youth',     'room-youth');

      send(sanctuary.ws, {
        type: 'status_update',
        status: { system: { roomId: 'room-sanctuary' }, atem: { connected: true } },
      });
      send(youth.ws, {
        type: 'status_update',
        status: { system: { roomId: 'room-youth' }, obs: { connected: true } },
      });

      await waitFor(() => server.churches.get('church-1').roomInstanceMap['room-sanctuary']);

      const baseline = server.sseBroadcasts.length;

      await closeWs(sanctuary.ws);
      await waitFor(() => server.sseBroadcasts.slice(baseline).some(e => e.type === 'instance_disconnected'));

      const newer = server.sseBroadcasts.slice(baseline);
      const instanceDc = newer.find(e => e.type === 'instance_disconnected');
      expect(instanceDc).toBeDefined();
      expect(instanceDc.instance).toBe('Sanctuary::room-sanctuary');
      expect(instanceDc.roomIds).toContain('room-sanctuary');
      // Room B must still appear in remainingInstances count
      expect(instanceDc.remainingInstances).toBe(1);

      // Critically, this should NOT be a full church_disconnected — the church
      // is still partly online via Youth.
      const fullDc = newer.find(e => e.type === 'church_disconnected');
      expect(fullDc).toBeUndefined();

      await closeWs(youth.ws);
    });
  });

  // ── Bonus: room limit enforcement (catches a regression in `maxRooms`) ─────

  describe('Room limits enforced per tier', () => {
    it('rejects a third instance when the tier allows only 2 rooms', async () => {
      const limited = await buildTestServer({
        checkPaidAccess: () => ({ allowed: true, tier: 'plus', maxRooms: 2 }),
        validateRoomId: () => true,
      });
      limited.churches.set('church-1', makeChurchEntry('church-1', 'Grace Church'));

      const a = await connectAgent(limited.url, 'church-1', 'Sanctuary', 'room-a');
      const b = await connectAgent(limited.url, 'church-1', 'Youth',     'room-b');
      expect(a.ws.readyState).toBe(WebSocket.OPEN);
      expect(b.ws.readyState).toBe(WebSocket.OPEN);

      // Third room should be rejected with `room_limit:2`
      const token = signToken('church-1');
      const url = `${limited.url}/church?token=${token}&instance=Choir&room_id=room-c`;
      const ws = new WebSocket(url);
      const closeInfo = await new Promise((resolve) => {
        ws.once('close', (code, reason) => resolve({ code, reason: reason?.toString() || '' }));
        ws.once('error', () => {});
      });
      expect(closeInfo.code).toBe(1008);
      expect(closeInfo.reason).toBe('room_limit:2');

      await closeWs(a.ws);
      await closeWs(b.ws);
      await limited.close();
    });
  });
});
