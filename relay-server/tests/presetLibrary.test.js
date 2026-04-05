'use strict';

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { PresetLibrary } from '../src/presetLibrary.js';
import { createQueryClient } from '../src/db/queryClient.js';

function makeDb() {
  return new Database(':memory:');
}

const CHURCH_ID = 'church-abc';
const OTHER_CHURCH = 'church-xyz';

describe('_ensureTable / constructor', () => {
  it('creates the presets table on construction', async () => {
    const db = makeDb();
    const lib = new PresetLibrary(db);
    await lib.ready;
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='presets'"
    ).get();
    expect(row).toBeTruthy();
    expect(row.name).toBe('presets');
  });

  it('can be instantiated twice on the same DB without error (CREATE TABLE IF NOT EXISTS)', async () => {
    const db = makeDb();
    const first = new PresetLibrary(db);
    const second = new PresetLibrary(db);
    await expect(Promise.all([first.ready, second.ready])).resolves.toBeDefined();
  });

  it('table has the correct columns', async () => {
    const db = makeDb();
    const lib = new PresetLibrary(db);
    await lib.ready;
    const cols = db.prepare('PRAGMA table_info(presets)').all().map(c => c.name);
    expect(cols).toContain('id');
    expect(cols).toContain('church_id');
    expect(cols).toContain('name');
    expect(cols).toContain('type');
    expect(cols).toContain('data');
    expect(cols).toContain('created_at');
    expect(cols).toContain('updated_at');
  });

  it('works when constructed with a query client', async () => {
    const db = makeDb();
    const queryClient = createQueryClient({
      config: { driver: 'sqlite', isSqlite: true, isPostgres: false, databaseUrl: '' },
      sqliteDb: db,
    });
    const lib = new PresetLibrary(queryClient);
    await lib.ready;

    await lib.save(CHURCH_ID, 'Query Client Preset', 'mixer_scene', { scene: 'main' });
    const preset = await lib.get(CHURCH_ID, 'Query Client Preset');

    expect(preset?.name).toBe('Query Client Preset');
  });
});

describe('save() — insert', () => {
  let db;
  let lib;

  beforeEach(async () => {
    db = makeDb();
    lib = new PresetLibrary(db);
    await lib.ready;
  });

  it('saves a new preset and returns a UUID string', async () => {
    const id = await lib.save(CHURCH_ID, 'Sunday Morning', 'mixer_scene', { scene: 'scene1' });
    expect(typeof id).toBe('string');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('saved preset is retrievable via get()', async () => {
    await lib.save(CHURCH_ID, 'Sunday Morning', 'mixer_scene', { scene: 'scene1' });
    const preset = await lib.get(CHURCH_ID, 'Sunday Morning');
    expect(preset).not.toBeNull();
    expect(preset.name).toBe('Sunday Morning');
    expect(preset.church_id).toBe(CHURCH_ID);
    expect(preset.type).toBe('mixer_scene');
  });

  it('JSON data is stored and parsed back correctly as an object', async () => {
    const data = { scene: 'main-worship', channel: 3 };
    await lib.save(CHURCH_ID, 'Worship', 'mixer_scene', data);
    const preset = await lib.get(CHURCH_ID, 'Worship');
    expect(preset.data).toEqual(data);
    expect(typeof preset.data).toBe('object');
  });

  it('string data is stored as-is (no double-stringify)', async () => {
    await lib.save(CHURCH_ID, 'StringPreset', 'mixer_scene', '{"scene":"raw"}');
    const raw = db.prepare('SELECT data FROM presets WHERE name = ?').get('StringPreset');
    expect(raw.data).toBe('{"scene":"raw"}');
  });

  it('created_at and updated_at are set on insert', async () => {
    await lib.save(CHURCH_ID, 'TimedPreset', 'obs_scene', { sceneName: 'Wide' });
    const preset = await lib.get(CHURCH_ID, 'TimedPreset');
    expect(preset.created_at).toBeTruthy();
    expect(preset.updated_at).toBeTruthy();
    expect(Number.isNaN(new Date(preset.created_at).getTime())).toBe(false);
    expect(Number.isNaN(new Date(preset.updated_at).getTime())).toBe(false);
  });

  it('each new preset gets a unique UUID', async () => {
    const id1 = await lib.save(CHURCH_ID, 'Preset A', 'mixer_scene', { scene: 'a' });
    const id2 = await lib.save(CHURCH_ID, 'Preset B', 'mixer_scene', { scene: 'b' });
    expect(id1).not.toBe(id2);
  });
});

describe('save() — update (upsert)', () => {
  let db;
  let lib;

  beforeEach(async () => {
    db = makeDb();
    lib = new PresetLibrary(db);
    await lib.ready;
  });

  it('updating same churchId+name returns the same id', async () => {
    const id1 = await lib.save(CHURCH_ID, 'MyPreset', 'mixer_scene', { scene: 'v1' });
    const id2 = await lib.save(CHURCH_ID, 'MyPreset', 'mixer_scene', { scene: 'v2' });
    expect(id2).toBe(id1);
  });

  it('updated data is reflected in get()', async () => {
    await lib.save(CHURCH_ID, 'MyPreset', 'mixer_scene', { scene: 'v1' });
    await lib.save(CHURCH_ID, 'MyPreset', 'obs_scene', { sceneName: 'NewScene' });
    const preset = await lib.get(CHURCH_ID, 'MyPreset');
    expect(preset.type).toBe('obs_scene');
    expect(preset.data).toEqual({ sceneName: 'NewScene' });
  });

  it('updated_at changes on update (is different from created_at)', async () => {
    await lib.save(CHURCH_ID, 'TimingTest', 'mixer_scene', { scene: 'v1' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await lib.save(CHURCH_ID, 'TimingTest', 'mixer_scene', { scene: 'v2' });
    const preset = await lib.get(CHURCH_ID, 'TimingTest');
    expect(new Date(preset.updated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(preset.created_at).getTime()
    );
  });

  it('only one row exists after multiple upserts of same name', async () => {
    await lib.save(CHURCH_ID, 'UniquePreset', 'mixer_scene', { scene: 'a' });
    await lib.save(CHURCH_ID, 'UniquePreset', 'mixer_scene', { scene: 'b' });
    await lib.save(CHURCH_ID, 'UniquePreset', 'mixer_scene', { scene: 'c' });
    const count = db.prepare('SELECT COUNT(*) as c FROM presets WHERE church_id = ? AND name = ?')
      .get(CHURCH_ID, 'UniquePreset');
    expect(count.c).toBe(1);
  });
});

describe('get()', () => {
  let db;
  let lib;

  beforeEach(async () => {
    db = makeDb();
    lib = new PresetLibrary(db);
    await lib.ready;
  });

  it('returns null for a non-existent preset', async () => {
    const result = await lib.get(CHURCH_ID, 'DoesNotExist');
    expect(result).toBeNull();
  });

  it('returns the preset with data parsed as an object (not a string)', async () => {
    await lib.save(CHURCH_ID, 'TestPreset', 'atem_macro', { macroIndex: 5 });
    const preset = await lib.get(CHURCH_ID, 'TestPreset');
    expect(preset).not.toBeNull();
    expect(typeof preset.data).toBe('object');
    expect(preset.data.macroIndex).toBe(5);
  });

  it('returns preset for correct churchId+name', async () => {
    await lib.save(CHURCH_ID, 'MyPreset', 'mixer_scene', { scene: 'main' });
    const preset = await lib.get(CHURCH_ID, 'MyPreset');
    expect(preset).not.toBeNull();
    expect(preset.name).toBe('MyPreset');
  });

  it('returns null for wrong churchId', async () => {
    await lib.save(CHURCH_ID, 'MyPreset', 'mixer_scene', { scene: 'main' });
    const result = await lib.get('wrong-church', 'MyPreset');
    expect(result).toBeNull();
  });

  it('returns null for wrong name', async () => {
    await lib.save(CHURCH_ID, 'MyPreset', 'mixer_scene', { scene: 'main' });
    const result = await lib.get(CHURCH_ID, 'WrongName');
    expect(result).toBeNull();
  });

  it('getByName delegates to the shared lookup', async () => {
    await lib.save(CHURCH_ID, 'MyPreset', 'mixer_scene', { scene: 'main' });
    const result = await lib.getByName(CHURCH_ID, 'MyPreset');
    expect(result?.name).toBe('MyPreset');
  });
});

describe('list()', () => {
  let db;
  let lib;

  beforeEach(async () => {
    db = makeDb();
    lib = new PresetLibrary(db);
    await lib.ready;
  });

  it('returns empty array when no presets exist', async () => {
    const result = await lib.list(CHURCH_ID);
    expect(result).toEqual([]);
  });

  it('returns all presets for the given churchId', async () => {
    await lib.save(CHURCH_ID, 'Alpha', 'mixer_scene', { scene: 'a' });
    await lib.save(CHURCH_ID, 'Beta', 'obs_scene', { sceneName: 'b' });
    const result = await lib.list(CHURCH_ID);
    expect(result).toHaveLength(2);
  });

  it('does not return presets belonging to another churchId', async () => {
    await lib.save(CHURCH_ID, 'MyPreset', 'mixer_scene', { scene: 'a' });
    await lib.save(OTHER_CHURCH, 'OtherPreset', 'mixer_scene', { scene: 'b' });

    const result = await lib.list(CHURCH_ID);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('MyPreset');
  });

  it('returns presets sorted by name alphabetically', async () => {
    await lib.save(CHURCH_ID, 'Zulu', 'mixer_scene', { scene: 'z' });
    await lib.save(CHURCH_ID, 'Alpha', 'mixer_scene', { scene: 'a' });
    await lib.save(CHURCH_ID, 'Mike', 'mixer_scene', { scene: 'm' });

    const result = await lib.list(CHURCH_ID);
    const names = result.map((preset) => preset.name);
    expect(names).toEqual(['Alpha', 'Mike', 'Zulu']);
  });

  it('all returned presets have data parsed as objects', async () => {
    await lib.save(CHURCH_ID, 'PresetA', 'mixer_scene', { scene: 'a', level: 1 });
    await lib.save(CHURCH_ID, 'PresetB', 'atem_macro', { macroIndex: 2 });

    const result = await lib.list(CHURCH_ID);
    for (const preset of result) {
      expect(typeof preset.data).toBe('object');
    }
  });
});

describe('delete()', () => {
  let db;
  let lib;

  beforeEach(async () => {
    db = makeDb();
    lib = new PresetLibrary(db);
    await lib.ready;
  });

  it('returns true when preset exists and is deleted', async () => {
    await lib.save(CHURCH_ID, 'ToDelete', 'mixer_scene', { scene: 'a' });
    const result = await lib.delete(CHURCH_ID, 'ToDelete');
    expect(result).toBe(true);
  });

  it('returns false when preset does not exist', async () => {
    const result = await lib.delete(CHURCH_ID, 'NonExistent');
    expect(result).toBe(false);
  });

  it('deleted preset is no longer retrievable via get()', async () => {
    await lib.save(CHURCH_ID, 'ToDelete', 'mixer_scene', { scene: 'a' });
    await lib.delete(CHURCH_ID, 'ToDelete');
    expect(await lib.get(CHURCH_ID, 'ToDelete')).toBeNull();
  });

  it('deleting from wrong churchId returns false and leaves preset intact', async () => {
    await lib.save(CHURCH_ID, 'SafePreset', 'mixer_scene', { scene: 'a' });
    const result = await lib.delete(OTHER_CHURCH, 'SafePreset');
    expect(result).toBe(false);
    expect(await lib.get(CHURCH_ID, 'SafePreset')).not.toBeNull();
  });

  it('returns false when called twice (second time preset is gone)', async () => {
    await lib.save(CHURCH_ID, 'DoubleDelete', 'mixer_scene', { scene: 'a' });
    await lib.delete(CHURCH_ID, 'DoubleDelete');
    const second = await lib.delete(CHURCH_ID, 'DoubleDelete');
    expect(second).toBe(false);
  });
});

describe('recall()', () => {
  let db;
  let lib;

  beforeEach(async () => {
    db = makeDb();
    lib = new PresetLibrary(db);
    await lib.ready;
  });

  it('throws "Preset \\"X\\" not found" when preset is missing', async () => {
    const sendCommand = async () => {};
    await expect(lib.recall(CHURCH_ID, 'Missing', sendCommand))
      .rejects.toThrow('Preset "Missing" not found');
  });

  it('returns the preset object on success', async () => {
    await lib.save(CHURCH_ID, 'RecallMe', 'mixer_scene', { scene: 'main' });
    const sendCommand = async () => {};
    const result = await lib.recall(CHURCH_ID, 'RecallMe', sendCommand);
    expect(result).not.toBeNull();
    expect(result.name).toBe('RecallMe');
  });

  it('calls sendCommand with correct args for mixer_scene', async () => {
    await lib.save(CHURCH_ID, 'MixerPreset', 'mixer_scene', { scene: 'scene1' });
    const calls = [];
    const sendCommand = async (cmd, params) => { calls.push({ cmd, params }); };
    await lib.recall(CHURCH_ID, 'MixerPreset', sendCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('mixer.recallScene');
    expect(calls[0].params).toEqual({ scene: 'scene1' });
  });
});

describe('_executePresetStep() — all preset types', () => {
  let db;
  let lib;

  beforeEach(async () => {
    db = makeDb();
    lib = new PresetLibrary(db);
    await lib.ready;
  });

  it('mixer_scene — calls mixer.recallScene with { scene }', async () => {
    await lib.save(CHURCH_ID, 'MixerScene', 'mixer_scene', { scene: 'scene1' });
    const calls = [];
    const sendCommand = async (cmd, params) => { calls.push({ cmd, params }); };
    await lib.recall(CHURCH_ID, 'MixerScene', sendCommand);
    expect(calls[0].cmd).toBe('mixer.recallScene');
    expect(calls[0].params).toEqual({ scene: 'scene1' });
  });

  it('atem_macro — calls atem.runMacro with { macroIndex }', async () => {
    await lib.save(CHURCH_ID, 'AtemMacro', 'atem_macro', { macroIndex: 3 });
    const calls = [];
    const sendCommand = async (cmd, params) => { calls.push({ cmd, params }); };
    await lib.recall(CHURCH_ID, 'AtemMacro', sendCommand);
    expect(calls[0].cmd).toBe('atem.runMacro');
    expect(calls[0].params).toEqual({ macroIndex: 3 });
  });

  it('obs_scene — calls obs.setScene with { scene: data.sceneName }', async () => {
    await lib.save(CHURCH_ID, 'ObsScene', 'obs_scene', { sceneName: 'Wide' });
    const calls = [];
    const sendCommand = async (cmd, params) => { calls.push({ cmd, params }); };
    await lib.recall(CHURCH_ID, 'ObsScene', sendCommand);
    expect(calls[0].cmd).toBe('obs.setScene');
    expect(calls[0].params).toEqual({ scene: 'Wide' });
  });

  it('vmix_preset with functionName — calls vmix.function with { function, input }', async () => {
    await lib.save(CHURCH_ID, 'VmixFn', 'vmix_preset', { functionName: 'Cut', inputName: 'Input 1' });
    const calls = [];
    const sendCommand = async (cmd, params) => { calls.push({ cmd, params }); };
    await lib.recall(CHURCH_ID, 'VmixFn', sendCommand);
    expect(calls[0].cmd).toBe('vmix.function');
    expect(calls[0].params).toEqual({ function: 'Cut', input: 'Input 1' });
  });

  it('vmix_preset without functionName — calls vmix.setProgram with { input }', async () => {
    await lib.save(CHURCH_ID, 'VmixPgm', 'vmix_preset', { inputName: 'Input 2' });
    const calls = [];
    const sendCommand = async (cmd, params) => { calls.push({ cmd, params }); };
    await lib.recall(CHURCH_ID, 'VmixPgm', sendCommand);
    expect(calls[0].cmd).toBe('vmix.setProgram');
    expect(calls[0].params).toEqual({ input: 'Input 2' });
  });

  it('resolume_column — calls resolume.triggerColumn with { column, name }', async () => {
    await lib.save(CHURCH_ID, 'ResolumeCol', 'resolume_column', { columnIndex: 2, columnName: 'Worship' });
    const calls = [];
    const sendCommand = async (cmd, params) => { calls.push({ cmd, params }); };
    await lib.recall(CHURCH_ID, 'ResolumeCol', sendCommand);
    expect(calls[0].cmd).toBe('resolume.triggerColumn');
    expect(calls[0].params).toEqual({ column: 2, name: 'Worship' });
  });

  it('unknown type — throws "Unknown preset type: foo"', async () => {
    await expect(
      lib._executePresetStep({ type: 'foo', data: {} }, async () => {})
    ).rejects.toThrow('Unknown preset type: foo');
  });

  it('named_bundle — executes all steps in sequence', { timeout: 5000 }, async () => {
    const bundleData = {
      steps: [
        { type: 'mixer_scene', scene: 'scene1' },
        { type: 'obs_scene', sceneName: 'Wide' },
      ],
    };
    await lib.save(CHURCH_ID, 'MyBundle', 'named_bundle', bundleData);

    const calls = [];
    const sendCommand = async (cmd, params) => { calls.push({ cmd, params }); };
    await lib.recall(CHURCH_ID, 'MyBundle', sendCommand);

    expect(calls).toHaveLength(2);
    expect(calls[0].cmd).toBe('mixer.recallScene');
    expect(calls[0].params).toEqual({ scene: 'scene1' });
    expect(calls[1].cmd).toBe('obs.setScene');
    expect(calls[1].params).toEqual({ scene: 'Wide' });
  });

  it('named_bundle with empty steps array — no sendCommand calls', async () => {
    await lib.save(CHURCH_ID, 'EmptyBundle', 'named_bundle', { steps: [] });
    const calls = [];
    const sendCommand = async (cmd, params) => { calls.push({ cmd, params }); };
    await lib.recall(CHURCH_ID, 'EmptyBundle', sendCommand);
    expect(calls).toHaveLength(0);
  });

  it('named_bundle preserves step order', { timeout: 10000 }, async () => {
    const bundleData = {
      steps: [
        { type: 'atem_macro', macroIndex: 1 },
        { type: 'mixer_scene', scene: 'worship' },
        { type: 'obs_scene', sceneName: 'Sermon' },
      ],
    };
    await lib.save(CHURCH_ID, 'OrderedBundle', 'named_bundle', bundleData);

    const order = [];
    const sendCommand = async (cmd) => { order.push(cmd); };
    await lib.recall(CHURCH_ID, 'OrderedBundle', sendCommand);

    expect(order).toEqual(['atem.runMacro', 'mixer.recallScene', 'obs.setScene']);
  });
});
