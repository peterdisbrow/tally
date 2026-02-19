/**
 * Preset Library — Equipment recall presets stored in SQLite
 * Supports mixer scenes, ATEM macros, OBS scenes, vMix presets,
 * Resolume columns, and named bundles (multi-step).
 */

const { v4: uuidv4 } = require('uuid');

class PresetLibrary {
  constructor(db) {
    this.db = db;
    this._ensureTable();
  }

  _ensureTable() {
    this.db.exec(`
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

  /**
   * Upsert a preset.
   * @param {string} churchId
   * @param {string} name
   * @param {string} type  mixer_scene | atem_macro | obs_scene | vmix_preset | resolume_column | named_bundle
   * @param {object} data  Type-specific data object
   * @returns {string} preset id
   */
  save(churchId, name, type, data) {
    const now = new Date().toISOString();
    const dataStr = typeof data === 'string' ? data : JSON.stringify(data);
    const existing = this.db.prepare(
      'SELECT id FROM presets WHERE church_id = ? AND name = ?'
    ).get(churchId, name);

    if (existing) {
      this.db.prepare(
        'UPDATE presets SET type = ?, data = ?, updated_at = ? WHERE church_id = ? AND name = ?'
      ).run(type, dataStr, now, churchId, name);
      return existing.id;
    } else {
      const id = uuidv4();
      this.db.prepare(
        'INSERT INTO presets (id, church_id, name, type, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(id, churchId, name, type, dataStr, now, now);
      return id;
    }
  }

  /**
   * Get a preset by name.
   * @returns {object|null}
   */
  get(churchId, name) {
    const row = this.db.prepare(
      'SELECT * FROM presets WHERE church_id = ? AND name = ?'
    ).get(churchId, name);
    if (!row) return null;
    try { return { ...row, data: JSON.parse(row.data) }; } catch { return row; }
  }

  /**
   * List all presets for a church, sorted by name.
   * @returns {object[]}
   */
  list(churchId) {
    const rows = this.db.prepare(
      'SELECT * FROM presets WHERE church_id = ? ORDER BY name ASC'
    ).all(churchId);
    return rows.map(r => {
      try { return { ...r, data: JSON.parse(r.data) }; } catch { return r; }
    });
  }

  /**
   * Delete a preset by name.
   * @returns {boolean} true if deleted
   */
  delete(churchId, name) {
    const result = this.db.prepare(
      'DELETE FROM presets WHERE church_id = ? AND name = ?'
    ).run(churchId, name);
    return result.changes > 0;
  }

  /**
   * Recall a preset: look it up and dispatch the appropriate device command(s).
   * @param {string} churchId
   * @param {string} name
   * @param {Function} sendCommand  async (command, params) => result
   * @returns {object} the preset that was recalled
   */
  async recall(churchId, name, sendCommand) {
    const preset = this.get(churchId, name);
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
