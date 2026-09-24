/**
 * Auto-rejoin last room after crash / kill -9 / clean quit (Andrew, Sep 24 2026).
 * Reverses the crash-case intent of 30f33d5 while keeping its safety: the
 * saved room is re-validated with the relay and bound to the signed-in church.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const rr = require('../src/room-rejoin');

const rec = (o = {}) => ({ roomId: 'r1', roomName: 'Sanctuary', churchId: 'c1', cleanExit: false, ...o });
const rooms = (ids) => ({ success: true, rooms: ids.map((id) => ({ id, name: id === 'r1' ? 'Sanctuary' : id })) });

test('decideRejoin: no record → none (picker, no message)', () => {
  assert.equal(rr.decideRejoin({ record: undefined, tokenChurchId: 'c1', roomsResult: rooms(['r1']) }).action, 'none');
});
test('decideRejoin: saved room still exists → rejoin', () => {
  const d = rr.decideRejoin({ record: rec(), tokenChurchId: 'c1', roomsResult: rooms(['r1', 'r2']) });
  assert.equal(d.action, 'rejoin'); assert.equal(d.roomId, 'r1'); assert.equal(d.clearRecord, false);
});
test('decideRejoin: room deleted → picker with plain message naming the room, record cleared', () => {
  const d = rr.decideRejoin({ record: rec(), tokenChurchId: 'c1', roomsResult: rooms(['r2']) });
  assert.equal(d.action, 'picker'); assert.equal(d.reason, 'room-gone'); assert.equal(d.clearRecord, true);
  assert.match(d.message, /Sanctuary/); assert.match(d.message, /no longer available/);
});
test('decideRejoin: different church signed in → picker, record cleared (never cross-account)', () => {
  const d = rr.decideRejoin({ record: rec(), tokenChurchId: 'c2', roomsResult: rooms(['r1']) });
  assert.equal(d.action, 'picker'); assert.equal(d.clearRecord, true);
});
test('decideRejoin: access revoked (403) → picker with message; 401 → sign-in', () => {
  const d403 = rr.decideRejoin({ record: rec(), tokenChurchId: 'c1', roomsResult: { success: false, status: 403 } });
  assert.equal(d403.action, 'picker'); assert.equal(d403.clearRecord, true); assert.match(d403.message, /no longer has access/);
  const d401 = rr.decideRejoin({ record: rec(), tokenChurchId: 'c1', roomsResult: { success: false, status: 401 } });
  assert.equal(d401.action, 'signin');
});
test('decideRejoin: expired token → sign-in (no fake connected state)', () => {
  assert.equal(rr.decideRejoin({ record: rec(), tokenChurchId: 'c1', tokenExpired: true, roomsResult: null }).action, 'signin');
});
test('decideRejoin: relay unreachable → rejoin-local, record kept', () => {
  const d = rr.decideRejoin({ record: rec(), tokenChurchId: 'c1', roomsResult: { success: false, network: true } });
  assert.equal(d.action, 'rejoin-local'); assert.equal(d.clearRecord, false);
  assert.equal(rr.decideRejoin({ record: rec(), tokenChurchId: 'c1', roomsResult: { success: false, status: 503 } }).action, 'rejoin-local');
});
test('decideAssignOutcome maps 404/403/401', () => {
  assert.equal(rr.decideAssignOutcome({ success: true }).ok, true);
  assert.equal(rr.decideAssignOutcome({ success: false, status: 404 }, 'X').reason, 'room-gone');
  assert.equal(rr.decideAssignOutcome({ success: false, status: 403 }, 'X').action, 'picker');
  assert.equal(rr.decideAssignOutcome({ success: false, status: 401 }, 'X').action, 'signin');
});
test('tokenExpired / buildRejoinRecord', () => {
  const tok = (exp) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64')}.s`;
  assert.equal(rr.tokenExpired(tok(1), 5000), true);
  assert.equal(rr.tokenExpired(tok(9999999999), 5000), false);
  const r = rr.buildRejoinRecord({ roomId: 'r1', roomName: 'S', churchId: 'c1', now: 0 });
  assert.deepEqual(r, { roomId: 'r1', roomName: 'S', churchId: 'c1', savedAt: '1970-01-01T00:00:00.000Z', cleanExit: false });
  assert.equal(rr.buildRejoinRecord({ roomId: '' }), null);
});

// ── Run the real main.js rejoin block against a fake relay + config store ──
function loadRejoinBlock(overrides = {}) {
  const m = SRC('main.js');
  const start = m.indexOf('let _rejoinValidateTimer = null;');
  const endMarker = "ipcMain.handle('leave-room'";
  const endIdx = m.indexOf('});', m.indexOf(endMarker)) + 3;
  assert.ok(start > 0 && endIdx > start, 'rejoin block present in main.js');
  const handlers = {};
  let store = { token: 't', roomName: 'Sanctuary', atemIp: '10.0.0.9', ...overrides.config };
  const calls = { startAgent: 0, stopAgent: 0, sent: [], assign: [] };
  const ctx = {
    console, setTimeout: () => 0, clearTimeout: () => {}, Date,
    ipcMain: { handle: (n, fn) => { handlers[n] = fn; } },
    loadConfig: () => JSON.parse(JSON.stringify(store)),
    saveConfig: (patch) => { store = Object.fromEntries(Object.entries({ ...store, ...patch }).filter(([, v]) => v !== undefined)); },
    decodeChurchIdFromToken: () => overrides.churchId || 'c1',
    fetchRooms: async () => overrides.rooms || rooms(['r1']),
    assignRoom: async (id) => { calls.assign.push(id); return overrides.assign || { success: true, roomId: id, roomName: 'Sanctuary' }; },
    fetchEquipmentFromRelay: async () => ('equipment' in overrides ? overrides.equipment : { atemIp: '127.0.0.1' }),
    switchRoomConfig: () => {},
    stopAgent: () => { calls.stopAgent++; },
    startAgent: () => { calls.startAgent++; },
    appendAppLog: () => {},
    mainWindow: { webContents: { send: (ch, d) => calls.sent.push([ch, d]) } },
    configManager: { ROOM_EQUIPMENT_KEYS: ['atemIp'] },
    roomRejoin: rr,
    agentStatus: {}, agentCrashCount: 0,
  };
  vm.runInNewContext(m.slice(start, endIdx), ctx);
  return { handlers, calls, store: () => store, ctx };
}

test('main auto-rejoin: after kill -9 (record, cleanExit=false) rejoins same room, starts agent, reports crash', async () => {
  const h = loadRejoinBlock({ config: { rejoinRoom: rec() } });
  const r = await h.handlers['auto-rejoin-room']();
  assert.equal(r.action, 'rejoined'); assert.equal(r.roomId, 'r1'); assert.equal(r.cleanExit, false);
  assert.deepEqual(h.calls.assign, ['r1'], 'room assigned (validated) before starting');
  assert.equal(h.calls.startAgent, 1);
  assert.equal(h.store().roomId, 'r1');
  assert.equal(h.store().atemIp, '127.0.0.1', 'server-authoritative equipment for this room');
  assert.equal(h.store().rejoinRoom.cleanExit, false, 'new session marked not-yet-clean');
});
test('main auto-rejoin: clean quit record also rejoins (cleanExit reported)', async () => {
  const h = loadRejoinBlock({ config: { rejoinRoom: rec({ cleanExit: true }) } });
  const r = await h.handlers['auto-rejoin-room']();
  assert.equal(r.action, 'rejoined'); assert.equal(r.cleanExit, true);
});
test('main auto-rejoin: deleted room → picker message, record cleared, agent NOT started', async () => {
  const h = loadRejoinBlock({ config: { rejoinRoom: rec() }, rooms: rooms([]) });
  const r = await h.handlers['auto-rejoin-room']();
  assert.equal(r.action, 'picker'); assert.match(r.message, /Sanctuary/);
  assert.equal(h.calls.startAgent, 0); assert.equal(h.store().rejoinRoom, undefined);
  const again = await h.handlers['auto-rejoin-room']();
  assert.equal(again.action, 'none', 'no loop: next launch is a plain picker');
});
test('main auto-rejoin: assign 404 race → picker, no agent, record cleared', async () => {
  const h = loadRejoinBlock({ config: { rejoinRoom: rec() }, assign: { success: false, status: 404 } });
  const r = await h.handlers['auto-rejoin-room']();
  assert.equal(r.action, 'picker'); assert.equal(h.calls.startAgent, 0); assert.equal(h.store().rejoinRoom, undefined);
  assert.ok(!h.store().roomId, 'room assignment dropped');
});
test('main auto-rejoin: relay unreachable → local rejoin with on-disk equipment, record kept', async () => {
  const h = loadRejoinBlock({ config: { rejoinRoom: rec() }, rooms: { success: false, network: true } });
  const r = await h.handlers['auto-rejoin-room']();
  assert.equal(r.action, 'rejoined-local'); assert.equal(h.calls.startAgent, 1);
  assert.equal(h.store().roomId, 'r1'); assert.equal(h.store().atemIp, '10.0.0.9');
  assert.ok(h.store().rejoinRoom);
});
test('main leave-room clears the record (deliberate leave → picker next launch)', async () => {
  const h = loadRejoinBlock({ config: { rejoinRoom: rec() } });
  await h.handlers['leave-room']();
  assert.equal(h.store().rejoinRoom, undefined);
  assert.equal((await h.handlers['auto-rejoin-room']()).action, 'none');
});

test('main wiring: joins remember, before-quit keeps record as cleanExit, deletion/sign-out clear', () => {
  const m = SRC('main.js');
  const assignH = m.slice(m.indexOf("ipcMain.handle('assign-room'"), m.indexOf("ipcMain.handle('full-room-switch'"));
  assert.match(assignH, /rememberRoomForRejoin\(result\.roomId, result\.roomName\)/);
  const frs = m.slice(m.indexOf("ipcMain.handle('full-room-switch'"), m.indexOf("ipcMain.handle('switch-room'"));
  assert.match(frs, /rememberRoomForRejoin\(assignResult\.roomId, assignResult\.roomName\)/);
  const bq = m.slice(m.indexOf("app.on('before-quit'"));
  assert.match(bq, /rejoinRoom = \{ \.\.\.cfg\.rejoinRoom, cleanExit: true \}/);
  assert.match(m, /leaveRoomAndNotify\('room-deleted'/);
  assert.match(m.slice(m.indexOf('function performSignOut'), m.indexOf('function performSignOut') + 300), /resetConfig\(\)/);
  const wl = m.slice(m.indexOf('ALLOWED_CONFIG_KEYS'), m.indexOf(']);', m.indexOf('ALLOWED_CONFIG_KEYS')));
  assert.doesNotMatch(wl, /rejoinRoom/, 'renderer cannot forge a rejoin record');
});

test('renderer wiring: launch auto-rejoins, Change Room leaves, picker shows notice', () => {
  const r = SRC('renderer.js');
  assert.match(r, /rejoin = await api\.autoRejoinRoom\(\)/);
  assert.doesNotMatch(r, /Always show room selector on fresh launch/);
  const cr = r.slice(r.indexOf('async function changeRoom()'), r.indexOf('async function changeRoom()') + 400);
  assert.match(cr, /api\.leaveRoom\(\)/);
  assert.match(r, /async function showRoomSelector\(churchName, notice\)/);
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'src', 'locales'))) {
    const j = JSON.parse(SRC(path.join('locales', f)));
    for (const k of ['title', 'titleLocal', 'afterCrash', 'afterQuit', 'local', 'confirmed']) assert.ok(j.rejoin?.[k], `${f} rejoin.${k}`);
  }
});

test('main auto-rejoin: relay returns no equipment (or fetch blip) → keeps the on-disk ATEM IP for this room', async () => {
  const h = loadRejoinBlock({ config: { rejoinRoom: rec() }, equipment: null });
  const r = await h.handlers['auto-rejoin-room']();
  assert.equal(r.action, 'rejoined');
  assert.equal(h.store().atemIp, '10.0.0.9');
});
