/**
 * Preset Library — Equipment recall presets stored in the shared DB runtime
 * Supports mixer scenes, ATEM macros, OBS scenes, vMix presets,
 * Resolume columns, and named bundles (multi-step).
 */

const { v4: uuidv4 } = require('uuid');
const { createQueryClient } = require('./db');

class PresetLibrary {
  constructor(dbOrClient, options = {}) {
    this.client = this._resolveClient(dbOrClient, options);
    this.ready = this._init();
  }

  _resolveClient(dbOrClient, options) {
    if (dbOrClient && typeof dbOrClient.query === 'function' && typeof dbOrClient.exec === 'function') {
      return dbOrClient;
    }

    return createQueryClient({
      config: options.config || {
        driver: 'sqlite',
        isSqlite: true,
        isPostgres: false,
        databaseUrl: '',
      },
      sqliteDb: dbOrClient,
    });
  }

  async _init() {
    await this._ensureTable();
  }

  async _ensureTable() {
    await this.client.exec(`
      CREATE TABLE IF NOT EXISTS presets (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(church_id, name)
      )
    `);
  }

  _parsePresetRow(row) {
    if (!row) return null;
    try {
      return { ...row, data: JSON.parse(row.data) };
    } catch {
      return row;
    }
  }

  /**
   * Upsert a preset.
   * @param {string} churchId
   * @param {string} name
   * @param {string} type  mixer_scene | atem_macro | obs_scene | vmix_preset | resolume_column | named_bundle
   * @param {object} data  Type-specific data object
   * @returns {Promise<string>} preset id
   */
  async save(churchId, name, type, data) {
    await this.ready;
    const now = new Date().toISOString();
    const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
    const existing = await this.client.queryOne(
      'SELECT id FROM presets WHERE church_id = ? AND name = ?',
      [churchId, name]
    );

    if (existing) {
      await this.client.run(
        'UPDATE presets SET type = ?, data = ?, updated_at = ? WHERE church_id = ? AND name = ?',
        [type, dataStr, now, churchId, name]
      );
      return existing.id;
    }

    const id = uuidv4();
    await this.client.run(
      'INSERT INTO presets (id, church_id, name, type, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, churchId, name, type, dataStr, now, now]
    );
    return id;
  }

  /**
   * Get a preset by name.
   * @returns {Promise<object|null>}
   */
  async get(churchId, name) {
    await this.ready;
    const row = await this.client.queryOne(
      'SELECT * FROM presets WHERE church_id = ? AND name = ?',
      [churchId, name]
    );
    return this._parsePresetRow(row);
  }

  async getByName(churchId, name) {
    return this.get(churchId, name);
  }

  /**
   * List all presets for a church, sorted by name.
   * @returns {Promise<object[]>}
   */
  async list(churchId) {
    await this.ready;
    const rows = await this.client.query(
      'SELECT * FROM presets WHERE church_id = ? ORDER BY name ASC',
      [churchId]
    );
    return rows.map((row) => this._parsePresetRow(row));
  }

  /**
   * Delete a preset by name.
   * @returns {Promise<boolean>} true if deleted
   */
  async delete(churchId, name) {
    await this.ready;
    const result = await this.client.run(
      'DELETE FROM presets WHERE church_id = ? AND name = ?',
      [churchId, name]
    );
    return result.changes > 0;
  }

  /**
   * Recall a preset: look it up and dispatch the appropriate device command(s).
   * @param {string} churchId
   * @param {string} name
   * @param {Function} sendCommand  async (command, params) => result
   * @returns {Promise<object>} the preset that was recalled
   */
  async recall(churchId, name, sendCommand) {
    const preset = await this.get(churchId, name);
    if (!preset) throw new Error(`Preset "${name}" not found`);
    await this._executePresetStep({ type: preset.type, data: preset.data }, sendCommand);
    return preset;
  }

  /**
   * Execute a single preset step (or a full preset for top-level call).
   * For named_bundle steps, each element in data.steps is { type, ...stepData }.
   */
  async _executePresetStep(step, sendCommand) {
    const { type, data } = step;

    switch (type) {
      case 'mixer_scene':
        await sendCommand('mixer.recallScene', { scene: data.scene });
        break;

      case 'atem_macro':
        await sendCommand('atem.runMacro', { macroIndex: data.macroIndex });
        break;

      case 'obs_scene':
        await sendCommand('obs.setScene', { scene: data.sceneName });
        break;

      case 'vmix_preset':
        if (data.functionName) {
          await sendCommand('vmix.function', { function: data.functionName, input: data.inputName });
        } else {
          await sendCommand('vmix.setProgram', { input: data.inputName });
        }
        break;

      case 'resolume_column':
        await sendCommand('resolume.triggerColumn', {
          column: data.columnIndex,
          name: data.columnName,
        });
        break;

      case 'named_bundle':
        for (const s of (data.steps || [])) {
          // Each bundle step: { type, ...stepData } — pass step data as the `data` sub-object
          await this._executePresetStep({ type: s.type, data: s }, sendCommand);
          await new Promise(r => setTimeout(r, 500));
        }
        break;

      default:
        throw new Error(`Unknown preset type: ${type}`);
    }
  }
}

module.exports = { PresetLibrary };
