/**
 * Rundown Engine — CRUD + active rundown state tracking.
 *
 * Allows churches to create step-by-step rundowns that volunteers
 * can follow during services. Each step (cue) can trigger device commands
 * via the existing command pipeline.
 *
 * Query-client mode keeps a hot in-memory cache so the existing callsites can
 * stay synchronous while we migrate persistence off raw better-sqlite3 access.
 */

const { v4: uuidv4 } = require('uuid');
const { createQueryClient } = require('./db');

const SQLITE_FALLBACK_CONFIG = {
  driver: 'sqlite',
  isSqlite: true,
  isPostgres: false,
  databaseUrl: '',
};

class RundownEngine {
  constructor(dbOrClient) {
    this.db = dbOrClient && typeof dbOrClient.prepare === 'function' ? dbOrClient : null;
    this.client = this._resolveClient(dbOrClient);
    this._rundownCache = new Map();
    this._activeRundownCache = new Map(); // churchId -> active row
    this._pendingWrites = new Set();

    if (this.db) {
      this._ensureTableSync();
      this.ready = Promise.resolve();
    } else {
      this.ready = this._init();
    }
  }

  _resolveClient(dbOrClient) {
    if (!dbOrClient) return null;
    if (typeof dbOrClient.query === 'function' && typeof dbOrClient.exec === 'function') {
      return dbOrClient;
    }

    return createQueryClient({
      config: SQLITE_FALLBACK_CONFIG,
      sqliteDb: dbOrClient,
    });
  }

  _requireClient() {
    if (!this.client && !this.db) throw new Error('[RundownEngine] Database client is not configured.');
    return this.client;
  }

  async _init() {
    await this._ensureTable();
    await this._loadCache();
  }

  async flushWrites() {
    await this.ready;
    const pending = [...this._pendingWrites];
    if (!pending.length) return;
    const results = await Promise.all(pending);
    const failure = results.find((result) => !result?.ok);
    if (failure) throw failure.error;
  }

  _queueWrite(promise) {
    const tracked = Promise.resolve(promise)
      .then(() => ({ ok: true }))
      .catch((error) => {
        console.error('[RundownEngine] Persist write failed:', error.message);
        return { ok: false, error };
      })
      .finally(() => {
        this._pendingWrites.delete(tracked);
      });

    this._pendingWrites.add(tracked);
    return tracked;
  }

  _isDuplicateColumnError(error) {
    return /duplicate column|already exists/i.test(String(error?.message || ''));
  }

  _normalizeRundownRow(row = {}) {
    return {
      id: row.id,
      church_id: row.church_id || row.churchId || null,
      name: row.name || '',
      steps_json: row.steps_json || row.stepsJson || '[]',
      is_template: Number(row.is_template ?? row.isTemplate ?? 0),
      created_at: row.created_at || row.createdAt || null,
      updated_at: row.updated_at || row.updatedAt || null,
      service_day: row.service_day ?? row.serviceDay ?? null,
      auto_activate: Number(row.auto_activate ?? row.autoActivate ?? 0),
      instance_name: row.instance_name ?? row.instanceName ?? null,
      room_id: row.room_id ?? row.roomId ?? null,
    };
  }

  _normalizeActiveRow(row = {}) {
    return {
      church_id: row.church_id || row.churchId || null,
      rundown_id: row.rundown_id || row.rundownId || null,
      current_step: Number(row.current_step ?? row.currentStep ?? 0),
      state: row.state || 'running',
      started_at: row.started_at || row.startedAt || null,
      service_start_at: row.service_start_at || row.serviceStartAt || null,
      last_cue_fired_at: row.last_cue_fired_at || row.lastCueFiredAt || null,
      cues_fired: row.cues_fired || row.cuesFired || '[]',
      instance_name: row.instance_name ?? row.instanceName ?? null,
      room_id: row.room_id ?? row.roomId ?? null,
    };
  }

  _parseSteps(stepsJson) {
    try { return JSON.parse(stepsJson || '[]'); } catch { return []; }
  }

  _parseCuesFired(cuesFired) {
    try { return JSON.parse(cuesFired || '[]'); } catch { return []; }
  }

  _toPublicRundown(row) {
    if (!row) return null;
    return {
      ...row,
      steps: this._parseSteps(row.steps_json),
    };
  }

  _toPublicActive(row, rundown) {
    if (!row || !rundown) return null;
    return {
      churchId: row.church_id,
      rundownId: row.rundown_id,
      currentStep: row.current_step,
      startedAt: row.started_at,
      instanceName: row.instance_name || null,
      rundown,
    };
  }

  _toPublicActiveFull(row, rundown) {
    if (!row || !rundown) return null;
    return {
      churchId: row.church_id,
      rundownId: row.rundown_id,
      currentStep: row.current_step,
      state: row.state || 'running',
      startedAt: row.started_at,
      serviceStartAt: row.service_start_at || row.started_at,
      lastCueFiredAt: row.last_cue_fired_at || null,
      cuesFired: this._parseCuesFired(row.cues_fired),
      instanceName: row.instance_name || null,
      rundown,
    };
  }

  _matchesScopedRundown(row, { instanceName, roomId } = {}) {
    if (instanceName) {
      return row.instance_name === instanceName || row.instance_name == null;
    }
    if (roomId) {
      return row.room_id === roomId || row.room_id == null;
    }
    return true;
  }

  _getCachedRundownRows(churchId, scope = {}) {
    return [...this._rundownCache.values()]
      .filter((row) => row.church_id === churchId)
      .filter((row) => this._matchesScopedRundown(row, scope))
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  }

  _getCachedActiveRow(churchId, instanceName) {
    const row = this._activeRundownCache.get(churchId);
    if (!row) return null;
    if (instanceName) {
      if (row.instance_name === instanceName) return row;
      if (row.instance_name == null) return row;
      return null;
    }
    return row;
  }

  _setCachedRundown(row) {
    const normalized = this._normalizeRundownRow(row);
    if (normalized.id) this._rundownCache.set(normalized.id, normalized);
    return normalized;
  }

  _setCachedActive(row) {
    const normalized = this._normalizeActiveRow(row);
    if (normalized.church_id) this._activeRundownCache.set(normalized.church_id, normalized);
    return normalized;
  }

  _clearCachedActive(churchId, instanceName) {
    const row = this._activeRundownCache.get(churchId);
    if (!row) return false;
    if (instanceName && row.instance_name !== instanceName) return false;
    this._activeRundownCache.delete(churchId);
    return true;
  }

  _removeOrphanedActive(churchId, rundownId) {
    const row = this._activeRundownCache.get(churchId);
    if (!row || row.rundown_id !== rundownId) return;
    this._activeRundownCache.delete(churchId);
    this._queueWrite(
      this._requireClient().run(
        'DELETE FROM active_rundowns WHERE church_id = ? AND rundown_id = ?',
        [churchId, rundownId]
      )
    );
  }

  async _loadCache() {
    const client = this._requireClient();
    const [rundowns, activeRows] = await Promise.all([
      client.query('SELECT * FROM rundowns'),
      client.query('SELECT * FROM active_rundowns'),
    ]);

    this._rundownCache.clear();
    this._activeRundownCache.clear();

    for (const row of rundowns) this._setCachedRundown(row);
    for (const row of activeRows) this._setCachedActive(row);
  }

  _ensureTableSync() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rundowns (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        name TEXT NOT NULL,
        steps_json TEXT NOT NULL DEFAULT '[]',
        is_template INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    const rundownCols = {
      service_day: 'INTEGER',
      auto_activate: 'INTEGER DEFAULT 0',
    };
    for (const [col, def] of Object.entries(rundownCols)) {
      try { this.db.prepare(`SELECT ${col} FROM rundowns LIMIT 1`).get(); }
      catch { this.db.exec(`ALTER TABLE rundowns ADD COLUMN ${col} ${def}`); }
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS active_rundowns (
        church_id TEXT PRIMARY KEY,
        rundown_id TEXT NOT NULL,
        current_step INTEGER DEFAULT 0,
        started_at TEXT NOT NULL,
        FOREIGN KEY (rundown_id) REFERENCES rundowns(id)
      )
    `);

    const activeCols = {
      state: "TEXT DEFAULT 'running'",
      service_start_at: 'TEXT',
      last_cue_fired_at: 'TEXT',
      cues_fired: "TEXT DEFAULT '[]'",
    };
    for (const [col, def] of Object.entries(activeCols)) {
      try { this.db.prepare(`SELECT ${col} FROM active_rundowns LIMIT 1`).get(); }
      catch { this.db.exec(`ALTER TABLE active_rundowns ADD COLUMN ${col} ${def}`); }
    }

    const roomCols = { instance_name: 'TEXT', room_id: 'TEXT' };
    for (const [col, def] of Object.entries(roomCols)) {
      try { this.db.prepare(`SELECT ${col} FROM rundowns LIMIT 1`).get(); }
      catch { try { this.db.exec(`ALTER TABLE rundowns ADD COLUMN ${col} ${def}`); } catch (err) { /* already exists */ console.debug("[rundownEngine] intentional swallow:", err); } }
      try { this.db.prepare(`SELECT ${col} FROM active_rundowns LIMIT 1`).get(); }
      catch { try { this.db.exec(`ALTER TABLE active_rundowns ADD COLUMN ${col} ${def}`); } catch (err) { /* already exists */ console.debug("[rundownEngine] intentional swallow:", err); } }
    }

    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_rundowns_church ON rundowns(church_id)'); } catch (err) { /* index may already exist */ console.debug('[rundownEngine migrations] create idx_rundowns_church:', err?.message); }
  }

  async _ensureTable() {
    const client = this._requireClient();
    await client.exec(`
      CREATE TABLE IF NOT EXISTS rundowns (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        name TEXT NOT NULL,
        steps_json TEXT NOT NULL DEFAULT '[]',
        is_template INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    for (const [col, def] of Object.entries({ service_day: 'INTEGER', auto_activate: 'INTEGER DEFAULT 0' })) {
      try {
        await client.queryOne(`SELECT ${col} FROM rundowns LIMIT 1`);
      } catch {
        try { await client.exec(`ALTER TABLE rundowns ADD COLUMN ${col} ${def}`); }
        catch (error) { if (!this._isDuplicateColumnError(error)) throw error; }
      }
    }

    await client.exec(`
      CREATE TABLE IF NOT EXISTS active_rundowns (
        church_id TEXT PRIMARY KEY,
        rundown_id TEXT NOT NULL,
        current_step INTEGER DEFAULT 0,
        started_at TEXT NOT NULL,
        FOREIGN KEY (rundown_id) REFERENCES rundowns(id)
      )
    `);

    for (const [col, def] of Object.entries({
      state: "TEXT DEFAULT 'running'",
      service_start_at: 'TEXT',
      last_cue_fired_at: 'TEXT',
      cues_fired: "TEXT DEFAULT '[]'",
    })) {
      try {
        await client.queryOne(`SELECT ${col} FROM active_rundowns LIMIT 1`);
      } catch {
        try { await client.exec(`ALTER TABLE active_rundowns ADD COLUMN ${col} ${def}`); }
        catch (error) { if (!this._isDuplicateColumnError(error)) throw error; }
      }
    }

    for (const [col, def] of Object.entries({ instance_name: 'TEXT', room_id: 'TEXT' })) {
      try {
        await client.queryOne(`SELECT ${col} FROM rundowns LIMIT 1`);
      } catch {
        try { await client.exec(`ALTER TABLE rundowns ADD COLUMN ${col} ${def}`); }
        catch (error) { if (!this._isDuplicateColumnError(error)) throw error; }
      }

      try {
        await client.queryOne(`SELECT ${col} FROM active_rundowns LIMIT 1`);
      } catch {
        try { await client.exec(`ALTER TABLE active_rundowns ADD COLUMN ${col} ${def}`); }
        catch (error) { if (!this._isDuplicateColumnError(error)) throw error; }
      }
    }

    try { await client.exec('CREATE INDEX IF NOT EXISTS idx_rundowns_church ON rundowns(church_id)'); } catch (err) { /* index may already exist */ console.debug('[rundownEngine migrations pg] create idx_rundowns_church:', err?.message); }
  }

  // ─── CRUD ──────────────────────────────────────────────────────────────────

  createRundown(churchId, name, steps = [], { instanceName, roomId } = {}) {
    const id = uuidv4();
    const now = new Date().toISOString();
    const row = this._setCachedRundown({
      id,
      church_id: churchId,
      name,
      steps_json: JSON.stringify(steps),
      is_template: 0,
      created_at: now,
      updated_at: now,
      service_day: null,
      auto_activate: 0,
      instance_name: instanceName || null,
      room_id: roomId || null,
    });

    if (this.db) {
      this.db.prepare(
        'INSERT INTO rundowns (id, church_id, name, steps_json, created_at, updated_at, instance_name, room_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(id, churchId, name, row.steps_json, now, now, instanceName || null, roomId || null);
    } else {
      this._queueWrite(
        this._requireClient().run(
          'INSERT INTO rundowns (id, church_id, name, steps_json, created_at, updated_at, instance_name, room_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [id, churchId, name, row.steps_json, now, now, instanceName || null, roomId || null]
        )
      );
    }

    return this._toPublicRundown(row);
  }

  getRundowns(churchId, scope = {}) {
    if (this.db) {
      let rows;
      if (scope.instanceName) {
        rows = this.db.prepare(
          'SELECT * FROM rundowns WHERE church_id = ? AND (instance_name = ? OR instance_name IS NULL) ORDER BY updated_at DESC'
        ).all(churchId, scope.instanceName);
      } else if (scope.roomId) {
        rows = this.db.prepare(
          'SELECT * FROM rundowns WHERE church_id = ? AND (room_id = ? OR room_id IS NULL) ORDER BY updated_at DESC'
        ).all(churchId, scope.roomId);
      } else {
        rows = this.db.prepare('SELECT * FROM rundowns WHERE church_id = ? ORDER BY updated_at DESC').all(churchId);
      }
      return rows.map((row) => this._toPublicRundown(this._normalizeRundownRow(row)));
    }

    return this._getCachedRundownRows(churchId, scope).map((row) => this._toPublicRundown(row));
  }

  getRundown(id) {
    if (this.db) {
      const row = this.db.prepare('SELECT * FROM rundowns WHERE id = ?').get(id);
      return row ? this._toPublicRundown(this._normalizeRundownRow(row)) : null;
    }
    return this._toPublicRundown(this._rundownCache.get(id) || null);
  }

  updateRundown(id, { name, steps }) {
    const existing = this.db
      ? this.getRundown(id)
      : this._toPublicRundown(this._rundownCache.get(id) || null);
    if (!existing) return null;
    if (name === undefined && steps === undefined) return null;

    const now = new Date().toISOString();
    const next = this._setCachedRundown({
      ...existing,
      name: name !== undefined ? name : existing.name,
      steps_json: steps !== undefined ? JSON.stringify(steps) : existing.steps_json,
      updated_at: now,
    });

    if (this.db) {
      const sets = [];
      const vals = [];
      if (name !== undefined) { sets.push('name = ?'); vals.push(name); }
      if (steps !== undefined) { sets.push('steps_json = ?'); vals.push(next.steps_json); }
      sets.push('updated_at = ?');
      vals.push(now, id);
      this.db.prepare(`UPDATE rundowns SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    } else {
      const sets = [];
      const vals = [];
      if (name !== undefined) { sets.push('name = ?'); vals.push(next.name); }
      if (steps !== undefined) { sets.push('steps_json = ?'); vals.push(next.steps_json); }
      sets.push('updated_at = ?');
      vals.push(now, id);
      this._queueWrite(this._requireClient().run(`UPDATE rundowns SET ${sets.join(', ')} WHERE id = ?`, vals));
    }

    return this._toPublicRundown(next);
  }

  setSchedulerConfig(id, { serviceDay, autoActivate }) {
    const existing = this.db
      ? this.getRundown(id)
      : this._toPublicRundown(this._rundownCache.get(id) || null);
    if (!existing) return null;

    const updates = {};
    if (serviceDay !== undefined) updates.service_day = serviceDay;
    if (autoActivate !== undefined) updates.auto_activate = autoActivate ? 1 : 0;
    if (!Object.keys(updates).length) return this._toPublicRundown(this._normalizeRundownRow(existing));

    const next = this._setCachedRundown({
      ...existing,
      ...updates,
    });

    const sets = [];
    const vals = [];
    if (serviceDay !== undefined) { sets.push('service_day = ?'); vals.push(serviceDay); }
    if (autoActivate !== undefined) { sets.push('auto_activate = ?'); vals.push(autoActivate ? 1 : 0); }
    vals.push(id);

    if (this.db) {
      this.db.prepare(`UPDATE rundowns SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    } else {
      this._queueWrite(this._requireClient().run(`UPDATE rundowns SET ${sets.join(', ')} WHERE id = ?`, vals));
    }

    return this._toPublicRundown(next);
  }

  deleteRundown(id) {
    const existing = this.db ? this.getRundown(id) : this._toPublicRundown(this._rundownCache.get(id) || null);
    if (!existing) return { deleted: true };

    this._rundownCache.delete(id);
    this._removeOrphanedActive(existing.church_id, id);

    if (this.db) {
      this.db.prepare('DELETE FROM active_rundowns WHERE rundown_id = ?').run(id);
      this.db.prepare('DELETE FROM rundowns WHERE id = ?').run(id);
    } else {
      this._queueWrite(this._requireClient().run('DELETE FROM active_rundowns WHERE rundown_id = ?', [id]));
      this._queueWrite(this._requireClient().run('DELETE FROM rundowns WHERE id = ?', [id]));
    }
    return { deleted: true };
  }

  // ─── ACTIVE STATE ──────────────────────────────────────────────────────────

  activateRundown(churchId, rundownId, instanceName) {
    const rundown = this.getRundown(rundownId);
    if (!rundown || rundown.church_id !== churchId) return null;
    const now = new Date().toISOString();
    const row = this._setCachedActive({
      church_id: churchId,
      rundown_id: rundownId,
      current_step: 0,
      state: 'running',
      started_at: now,
      service_start_at: now,
      last_cue_fired_at: null,
      cues_fired: '[]',
      instance_name: instanceName || null,
      room_id: rundown.room_id || null,
    });

    if (this.db) {
      if (instanceName) {
        this.db.prepare('DELETE FROM active_rundowns WHERE church_id = ? AND instance_name = ?').run(churchId, instanceName);
      }
      this.db.prepare(
        'INSERT OR REPLACE INTO active_rundowns (church_id, rundown_id, current_step, started_at, instance_name, room_id) VALUES (?, ?, 0, ?, ?, ?)'
      ).run(churchId, rundownId, now, instanceName || null, rundown.room_id || null);
    } else {
      if (instanceName) {
        this._queueWrite(this._requireClient().run(
          'DELETE FROM active_rundowns WHERE church_id = ? AND instance_name = ?',
          [churchId, instanceName]
        ));
      }
      this._queueWrite(this._requireClient().run(
        'INSERT INTO active_rundowns (church_id, rundown_id, current_step, started_at, state, service_start_at, last_cue_fired_at, cues_fired, instance_name, room_id) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (church_id) DO UPDATE SET rundown_id = excluded.rundown_id, current_step = excluded.current_step, started_at = excluded.started_at, state = excluded.state, service_start_at = excluded.service_start_at, last_cue_fired_at = excluded.last_cue_fired_at, cues_fired = excluded.cues_fired, instance_name = excluded.instance_name, room_id = excluded.room_id',
        [churchId, rundownId, now, 'running', now, null, '[]', instanceName || null, rundown.room_id || null]
      ));
    }

    return this._toPublicActive(row, rundown);
  }

  advanceStep(churchId, instanceName) {
    const active = this.getActiveRundown(churchId, instanceName);
    if (!active) return null;
    const nextStep = active.currentStep + 1;
    const steps = active.rundown.steps || [];
    if (nextStep >= steps.length) return null;
    this.updateActiveState(churchId, { currentStep: nextStep }, instanceName);
    return { ...active, currentStep: nextStep };
  }

  goToStep(churchId, stepIndex, instanceName) {
    const active = this.getActiveRundown(churchId, instanceName);
    if (!active) return null;
    const steps = active.rundown.steps || [];
    if (stepIndex < 0 || stepIndex >= steps.length) return null;
    this.updateActiveState(churchId, { currentStep: stepIndex }, instanceName);
    return { ...active, currentStep: stepIndex };
  }

  getCurrentStep(churchId, instanceName) {
    const active = this.getActiveRundown(churchId, instanceName);
    if (!active) return null;
    const steps = active.rundown.steps || [];
    return {
      stepIndex: active.currentStep,
      step: steps[active.currentStep] || null,
      totalSteps: steps.length,
      rundownName: active.rundown.name,
    };
  }

  getActiveRundown(churchId, instanceName) {
    if (this.db) {
      let row;
      if (instanceName) {
        row = this.db.prepare('SELECT * FROM active_rundowns WHERE church_id = ? AND instance_name = ?').get(churchId, instanceName);
      }
      if (!row) {
        row = this.db.prepare('SELECT * FROM active_rundowns WHERE church_id = ? AND (instance_name IS NULL OR instance_name = ?)').get(churchId, instanceName || '');
      }
      if (!row) {
        row = this.db.prepare('SELECT * FROM active_rundowns WHERE church_id = ?').get(churchId);
      }
      if (!row) return null;
      const rundown = this.getRundown(row.rundown_id);
      if (!rundown) {
        this.db.prepare('DELETE FROM active_rundowns WHERE church_id = ? AND rundown_id = ?').run(churchId, row.rundown_id);
        return null;
      }
      return this._toPublicActive(this._normalizeActiveRow(row), rundown);
    }

    const row = this._getCachedActiveRow(churchId, instanceName);
    if (!row) return null;
    const rundown = this._toPublicRundown(this._rundownCache.get(row.rundown_id) || null);
    if (!rundown) {
      this._clearCachedActive(churchId, row.instance_name || null);
      this._queueWrite(this._requireClient().run('DELETE FROM active_rundowns WHERE church_id = ? AND rundown_id = ?', [churchId, row.rundown_id]));
      return null;
    }
    return this._toPublicActive(row, rundown);
  }

  getActive(churchId, instanceName) {
    const active = this.getActiveRundown(churchId, instanceName);
    if (!active) return null;
    return {
      ...active,
      items: active.rundown?.steps || [],
    };
  }

  listActiveChurchIds(instanceName) {
    const rows = [...this._activeRundownCache.values()]
      .filter((row) => {
        if (!instanceName) return true;
        return row.instance_name === instanceName || row.instance_name == null;
      })
      .map((row) => row.church_id)
      .filter(Boolean);

    return [...new Set(rows)];
  }

  deactivateRundown(churchId, instanceName) {
    const removed = this._clearCachedActive(churchId, instanceName);

    if (this.db) {
      if (instanceName) {
        this.db.prepare('DELETE FROM active_rundowns WHERE church_id = ? AND instance_name = ?').run(churchId, instanceName);
      } else {
        this.db.prepare('DELETE FROM active_rundowns WHERE church_id = ?').run(churchId);
      }
    } else if (removed || !instanceName) {
      if (instanceName) {
        this._queueWrite(this._requireClient().run(
          'DELETE FROM active_rundowns WHERE church_id = ? AND instance_name = ?',
          [churchId, instanceName]
        ));
      } else {
        this._queueWrite(this._requireClient().run('DELETE FROM active_rundowns WHERE church_id = ?', [churchId]));
      }
    }

    return { deactivated: true };
  }

  // ─── SCHEDULER HELPERS ─────────────────────────────────────────────────────

  getAutoActivateRundown(churchId, dayOfWeek, instanceName) {
    if (this.db) {
      let row;
      if (instanceName) {
        row = this.db.prepare(
          'SELECT * FROM rundowns WHERE church_id = ? AND auto_activate = 1 AND (service_day IS NULL OR service_day = ?) AND (instance_name = ? OR instance_name IS NULL) LIMIT 1'
        ).get(churchId, dayOfWeek, instanceName);
      } else {
        row = this.db.prepare(
          'SELECT * FROM rundowns WHERE church_id = ? AND auto_activate = 1 AND (service_day IS NULL OR service_day = ?) LIMIT 1'
        ).get(churchId, dayOfWeek);
      }
      return row ? this._toPublicRundown(this._normalizeRundownRow(row)) : null;
    }

    const row = this._getCachedRundownRows(churchId, { instanceName }).find((candidate) =>
      candidate.auto_activate === 1 && (candidate.service_day == null || candidate.service_day === dayOfWeek)
    );
    return this._toPublicRundown(row || null);
  }

  activateRundownForScheduler(churchId, rundownId, serviceStartAt, instanceName) {
    const rundown = this.getRundown(rundownId);
    if (!rundown || rundown.church_id !== churchId) return null;

    const now = new Date().toISOString();
    const row = this._setCachedActive({
      church_id: churchId,
      rundown_id: rundownId,
      current_step: 0,
      state: 'running',
      started_at: now,
      service_start_at: serviceStartAt || now,
      last_cue_fired_at: null,
      cues_fired: '[]',
      instance_name: instanceName || null,
      room_id: rundown.room_id || null,
    });

    if (this.db) {
      if (instanceName) {
        this.db.prepare('DELETE FROM active_rundowns WHERE church_id = ? AND instance_name = ?').run(churchId, instanceName);
      }
      this.db.prepare(`
        INSERT OR REPLACE INTO active_rundowns
          (church_id, rundown_id, current_step, state, started_at, service_start_at, last_cue_fired_at, cues_fired, instance_name, room_id)
        VALUES (?, ?, 0, 'running', ?, ?, NULL, '[]', ?, ?)
      `).run(churchId, rundownId, now, serviceStartAt || now, instanceName || null, rundown.room_id || null);
    } else {
      if (instanceName) {
        this._queueWrite(this._requireClient().run(
          'DELETE FROM active_rundowns WHERE church_id = ? AND instance_name = ?',
          [churchId, instanceName]
        ));
      }
      this._queueWrite(this._requireClient().run(
        `INSERT INTO active_rundowns
          (church_id, rundown_id, current_step, state, started_at, service_start_at, last_cue_fired_at, cues_fired, instance_name, room_id)
         VALUES (?, ?, 0, 'running', ?, ?, NULL, '[]', ?, ?)
         ON CONFLICT (church_id) DO UPDATE SET
           rundown_id = excluded.rundown_id,
           current_step = excluded.current_step,
           state = excluded.state,
           started_at = excluded.started_at,
           service_start_at = excluded.service_start_at,
           last_cue_fired_at = excluded.last_cue_fired_at,
           cues_fired = excluded.cues_fired,
           instance_name = excluded.instance_name,
           room_id = excluded.room_id`,
        [churchId, rundownId, now, serviceStartAt || now, instanceName || null, rundown.room_id || null]
      ));
    }

    return {
      churchId,
      rundownId,
      currentStep: 0,
      state: 'running',
      startedAt: now,
      serviceStartAt: serviceStartAt || now,
      rundown,
      instanceName: instanceName || null,
    };
  }

  getActiveRundownFull(churchId, instanceName) {
    if (this.db) {
      let row;
      if (instanceName) {
        row = this.db.prepare('SELECT * FROM active_rundowns WHERE church_id = ? AND instance_name = ?').get(churchId, instanceName);
      }
      if (!row) {
        row = this.db.prepare('SELECT * FROM active_rundowns WHERE church_id = ?').get(churchId);
      }
      if (!row) return null;
      const rundown = this.getRundown(row.rundown_id);
      if (!rundown) {
        this.db.prepare('DELETE FROM active_rundowns WHERE church_id = ? AND rundown_id = ?').run(churchId, row.rundown_id);
        return null;
      }
      return this._toPublicActiveFull(this._normalizeActiveRow(row), rundown);
    }

    const row = this._getCachedActiveRow(churchId, instanceName);
    if (!row) return null;
    const rundown = this._toPublicRundown(this._rundownCache.get(row.rundown_id) || null);
    if (!rundown) {
      this._clearCachedActive(churchId, row.instance_name || null);
      this._queueWrite(this._requireClient().run('DELETE FROM active_rundowns WHERE church_id = ? AND rundown_id = ?', [churchId, row.rundown_id]));
      return null;
    }
    return this._toPublicActiveFull(row, rundown);
  }

  updateActiveState(churchId, updates, instanceName) {
    const row = this._getCachedActiveRow(churchId, instanceName);
    if (!row && !this.db) return;

    if (this.db) {
      const sets = [];
      const vals = [];
      if (updates.currentStep !== undefined) { sets.push('current_step = ?'); vals.push(updates.currentStep); }
      if (updates.state !== undefined) { sets.push('state = ?'); vals.push(updates.state); }
      if (updates.lastCueFiredAt !== undefined) { sets.push('last_cue_fired_at = ?'); vals.push(updates.lastCueFiredAt); }
      if (updates.cuesFired !== undefined) { sets.push('cues_fired = ?'); vals.push(JSON.stringify(updates.cuesFired)); }
      if (!sets.length) return;
      vals.push(churchId);
      if (instanceName) {
        vals.push(instanceName);
        this.db.prepare(`UPDATE active_rundowns SET ${sets.join(', ')} WHERE church_id = ? AND instance_name = ?`).run(...vals);
      } else {
        this.db.prepare(`UPDATE active_rundowns SET ${sets.join(', ')} WHERE church_id = ?`).run(...vals);
      }
      return;
    }

    const next = this._setCachedActive({
      ...row,
      current_step: updates.currentStep !== undefined ? updates.currentStep : row.current_step,
      state: updates.state !== undefined ? updates.state : row.state,
      last_cue_fired_at: updates.lastCueFiredAt !== undefined ? updates.lastCueFiredAt : row.last_cue_fired_at,
      cues_fired: updates.cuesFired !== undefined ? JSON.stringify(updates.cuesFired) : row.cues_fired,
    });

    const sets = [];
    const vals = [];
    if (updates.currentStep !== undefined) { sets.push('current_step = ?'); vals.push(next.current_step); }
    if (updates.state !== undefined) { sets.push('state = ?'); vals.push(next.state); }
    if (updates.lastCueFiredAt !== undefined) { sets.push('last_cue_fired_at = ?'); vals.push(next.last_cue_fired_at); }
    if (updates.cuesFired !== undefined) { sets.push('cues_fired = ?'); vals.push(next.cues_fired); }
    if (!sets.length) return;
    vals.push(churchId);
    if (instanceName) {
      vals.push(instanceName);
      this._queueWrite(this._requireClient().run(
        `UPDATE active_rundowns SET ${sets.join(', ')} WHERE church_id = ? AND instance_name = ?`,
        vals
      ));
    } else {
      this._queueWrite(this._requireClient().run(
        `UPDATE active_rundowns SET ${sets.join(', ')} WHERE church_id = ?`,
        vals
      ));
    }
  }
}

module.exports = { RundownEngine };
