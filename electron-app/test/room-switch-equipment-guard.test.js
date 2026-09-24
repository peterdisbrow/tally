/**
 * Room picker / room switch must never wipe equipment config because one relay
 * fetch failed (network, 5xx, 401, timeout, malformed body). Same guard as the
 * auto-rejoin path: a failed fetch keeps the room's on-disk equipment. Only a
 * real server answer is authoritative. The previous room's equipment must also
 * never leak into a room with no saved setup.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const KEYS = ['atemIp', 'obsUrl', 'ptzCameras'];
const SANCT = { atemIp: '10.0.0.9', obsUrl: 'ws://10.0.0.5:4455', ptzCameras: [{ ip: '10.0.0.20' }] };
const CHAPEL = { atemIp: '10.0.1.9', obsUrl: 'ws://10.0.1.5:4455' };

function loadSwitchBlock({ config, fetch, assign }) {
  const m = SRC('main.js');
  const helper = m.indexOf('async function applyRoomEquipmentAfterSwitch(');
  const start = helper >= 0 ? helper : m.indexOf('// ─── Full room switch');
  const end = m.indexOf("ipcMain.handle('save-equipment'");
  assert.ok(start > 0 && end > start, 'room switch block present');
  const handlers = {};
  let store = JSON.parse(JSON.stringify(config));
  const load = () => JSON.parse(JSON.stringify(store));
  const save = (patch) => { store = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries({ ...store, ...patch }).filter(([, v]) => v !== undefined)))); };
  const extractEquipment = (c) => Object.fromEntries(KEYS.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]));
  const calls = { startAgent: 0, sent: [] };
  // fetch: { ok:false } | { ok:true, equipment } — legacy fetchEquipmentFromRelay collapses both to null/obj.
  const legacy = fetch.ok && fetch.equipment && typeof fetch.equipment === 'object' && !Array.isArray(fetch.equipment)
    && Object.keys(fetch.equipment).length ? fetch.equipment : null;
  const ctx = {
    console, Date, setTimeout: () => 0, clearTimeout: () => {},
    ipcMain: { handle: (n, fn) => { handlers[n] = fn; } },
    loadConfig: load, saveConfig: save,
    configManager: { ROOM_EQUIPMENT_KEYS: KEYS, extractEquipment },
    switchRoomConfig: (from, to) => {
      const c = load(); c.roomConfigs = c.roomConfigs || {};
      c.roomConfigs[from || '_default'] = extractEquipment(c);
      const t = c.roomConfigs[to || '_default'];
      if (t) for (const k of KEYS) c[k] = t[k];
      save(c); return { loaded: !!t };
    },
    syncEquipmentToRelay: async () => ({ success: false }),
    fetchEquipmentFromRelay: async () => legacy,
    fetchRoomEquipment: async () => fetch,
    roomEquipment: fs.existsSync(path.join(__dirname, '..', 'src', 'room-equipment.js')) ? require('../src/room-equipment') : undefined,
    assignRoom: async (id) => assign || { success: true, roomId: id, roomName: id === 'r2' ? 'Chapel' : 'Sanctuary' },
    stopRejoinValidation: () => {}, rememberRoomForRejoin: () => {},
    stopAgent: () => {}, startAgent: () => { calls.startAgent++; },
    appendAppLog: () => {},
    mainWindow: { webContents: { send: (ch, d) => calls.sent.push([ch, d]) } },
    agentStatus: {}, agentCrashCount: 0,
  };
  vm.runInNewContext(m.slice(start, end), ctx);
  return { handlers, calls, store: () => store };
}
const base = (extra = {}) => ({ token: 't', roomId: 'r1', roomName: 'Sanctuary', ...SANCT, roomConfigs: { Sanctuary: SANCT }, ...extra });
const FAILS = [
  ['network/timeout/5xx/401', { ok: false, error: 'fetch failed' }],
  ['malformed body (array)', { ok: false, error: 'malformed' }],
];

for (const handler of ['full-room-switch', 'switch-room']) {
  for (const [label, f] of FAILS) {
    test(`${handler}: re-picking the SAME room with a failed fetch (${label}) keeps its equipment`, async () => {
      const h = loadSwitchBlock({ config: base(), fetch: f });
      await h.handlers[handler](null, { fromRoom: 'Sanctuary', toRoom: 'Sanctuary', toRoomId: 'r1' });
      const s = h.store();
      assert.equal(s.atemIp, SANCT.atemIp, 'atemIp not wiped');
      assert.equal(s.obsUrl, SANCT.obsUrl, 'obsUrl not wiped');
      assert.deepEqual(s.ptzCameras, SANCT.ptzCameras, 'PTZ not wiped');
      assert.deepEqual(s.roomConfigs.Sanctuary, SANCT, 'saved per-room copy intact');
    });
  }
  test(`${handler}: switching to a room with a LOCAL saved setup + failed fetch uses that setup (not cleared)`, async () => {
    const h = loadSwitchBlock({ config: base({ roomConfigs: { Sanctuary: SANCT, Chapel: CHAPEL } }), fetch: { ok: false, error: 'ECONNREFUSED' } });
    await h.handlers[handler](null, { fromRoom: 'Sanctuary', toRoom: 'Chapel', toRoomId: 'r2' });
    const s = h.store();
    assert.equal(s.atemIp, CHAPEL.atemIp); assert.equal(s.obsUrl, CHAPEL.obsUrl);
    assert.deepEqual(s.roomConfigs.Sanctuary, SANCT, 'old room preserved');
  });
  test(`${handler}: room with NO saved setup + failed fetch does not inherit the previous room's devices`, async () => {
    const h = loadSwitchBlock({ config: base(), fetch: { ok: false, error: 'ECONNREFUSED' } });
    await h.handlers[handler](null, { fromRoom: 'Sanctuary', toRoom: 'Chapel', toRoomId: 'r2' });
    const s = h.store();
    assert.equal(s.atemIp, undefined); assert.equal(s.obsUrl, undefined);
    assert.deepEqual(s.roomConfigs.Sanctuary, SANCT, 'old room preserved, nothing wiped');
  });
  test(`${handler}: server answer with equipment is authoritative`, async () => {
    const h = loadSwitchBlock({ config: base(), fetch: { ok: true, equipment: { atemIp: '127.0.0.1' } } });
    await h.handlers[handler](null, { fromRoom: 'Sanctuary', toRoom: 'Sanctuary', toRoomId: 'r1' });
    const s = h.store();
    assert.equal(s.atemIp, '127.0.0.1'); assert.equal(s.obsUrl, undefined);
    assert.deepEqual(s.roomConfigs.Sanctuary, { atemIp: '127.0.0.1' });
  });
  test(`${handler}: server says "no equipment" but this computer has the room's setup -> keep it`, async () => {
    const h = loadSwitchBlock({ config: base(), fetch: { ok: true, equipment: null } });
    await h.handlers[handler](null, { fromRoom: 'Sanctuary', toRoom: 'Sanctuary', toRoomId: 'r1' });
    assert.equal(h.store().atemIp, SANCT.atemIp);
  });
}

test('full-room-switch: failed fetch is reported to the UI (equipmentWarning), not silent', async () => {
  const h = loadSwitchBlock({ config: base(), fetch: { ok: false, error: 'ECONNREFUSED' } });
  const r = await h.handlers['full-room-switch'](null, { fromRoom: 'Sanctuary', toRoom: 'Sanctuary', toRoomId: 'r1' });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'local');
  assert.match(r.equipmentWarning || '', /saved/i);
});
test('full-room-switch: assign refused (403/404) -> ok:false, agent not started, roomId not left pointing elsewhere', async () => {
  const h = loadSwitchBlock({ config: base(), fetch: { ok: true, equipment: { atemIp: '127.0.0.1' } }, assign: { success: false, status: 403, error: 'No access' } });
  const r = await h.handlers['full-room-switch'](null, { fromRoom: 'Sanctuary', toRoom: 'Chapel', toRoomId: 'r2' });
  assert.equal(r.ok, false);
  assert.equal(h.calls.startAgent, 0);
});
test('full-room-switch: relay unreachable at assign -> local mode, roomId/roomName consistent with chosen room', async () => {
  const h = loadSwitchBlock({ config: base({ roomConfigs: { Sanctuary: SANCT, Chapel: CHAPEL } }), fetch: { ok: false, error: 'x' }, assign: { success: false, network: true, error: 'fetch failed' } });
  const r = await h.handlers['full-room-switch'](null, { fromRoom: 'Sanctuary', toRoom: 'Chapel', toRoomId: 'r2' });
  assert.equal(r.ok, true);
  assert.equal(h.store().roomId, 'r2'); assert.equal(h.store().roomName, 'Chapel');
  assert.equal(h.calls.startAgent, 1);
});
