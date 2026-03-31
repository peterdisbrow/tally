/**
 * Rundown Engine — CRUD + active rundown state tracking.
 *
 * Allows churches to create step-by-step rundowns that volunteers
 * can follow during services. Each step (cue) can trigger device commands
 * (e.g., ATEM switch, recording start) via the existing command pipeline.
 *
 * Tables:
 *   rundowns         — template storage (name, steps/cues JSON, church_id)
 *   active_rundowns  — per-church active rundown state (current cue, state, fired history)
 */

const { v4: uuidv4 } = require('uuid');

class RundownEngine {
  constructor(db) {
    this.db = db;
    this._ensureTable();
  }

  _ensureTable() {
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

    // Migrate: add scheduler columns to rundowns table
    const rundownCols = {
      service_day: 'INTEGER',
      auto_activate: 'INTEGER DEFAULT 0',
    };
    for (const [col, def] of Object.entries(rundownCols)) {
      try { this.db.prepare(`SELECT ${col} FROM rundowns LIMIT 1`).get(); }
      catch { this.db.exec(`ALTER TABLE rundowns ADD COLUMN ${col} ${def}`); }
    }

    // Evolved active_rundowns table with scheduler state columns
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS active_rundowns (
        church_id TEXT PRIMARY KEY,
        rundown_id TEXT NOT NULL,
        current_step INTEGER DEFAULT 0,
        started_at TEXT NOT NULL,
        FOREIGN KEY (rundown_id) REFERENCES rundowns(id)
      )
    `);

    // Migrate: add scheduler columns to active_rundowns table
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

    // Migration: add room scoping columns to rundowns and active_rundowns
    const rundownRoomCols = { instance_name: 'TEXT', room_id: 'TEXT' };
    for (const [col, def] of Object.entries(rundownRoomCols)) {
      try { this.db.prepare(`SELECT ${col} FROM rundowns LIMIT 1`).get(); }
      catch { try { this.db.exec(`ALTER TABLE rundowns ADD COLUMN ${col} ${def}`); } catch { /* already exists */ } }
      try { this.db.prepare(`SELECT ${col} FROM active_rundowns LIMIT 1`).get(); }
      catch { try { this.db.exec(`ALTER TABLE active_rundowns ADD COLUMN ${col} ${def}`); } catch { /* already exists */ } }
    }

    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_rundowns_church ON rundowns(church_id)'); } catch {}
  }

  // ─── CRUD ────────────────────────────────────────────────────────────────────

  createRundown(churchId, name, steps = [], { instanceName, roomId } = {}) {
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO rundowns (id, church_id, name, steps_json, created_at, updated_at, instance_name, room_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, churchId, name, JSON.stringify(steps), now, now, instanceName || null, roomId || null);
    return { id, church_id: churchId, name, steps, created_at: now, updated_at: now, instance_name: instanceName || null, room_id: roomId || null };
  }

  getRundowns(churchId, { instanceName, roomId } = {}) {
    let rows;
    if (instanceName) {
      rows = this.db.prepare(
        'SELECT * FROM rundowns WHERE church_id = ? AND (instance_name = ? OR instance_name IS NULL) ORDER BY updated_at DESC'
      ).all(churchId, instanceName);
    } else if (roomId) {
      rows = this.db.prepare(
        'SELECT * FROM rundowns WHERE church_id = ? AND (room_id = ? OR room_id IS NULL) ORDER BY updated_at DESC'
      ).all(churchId, roomId);
    } else {
      rows = this.db.prepare(
        'SELECT * FROM rundowns WHERE church_id = ? ORDER BY updated_at DESC'
      ).all(churchId);
    }
    return rows.map(r => ({ ...r, steps: JSON.parse(r.steps_json || '[]') }));
  }

  getRundown(id) {
    const row = this.db.prepare('SELECT * FROM rundowns WHERE id = ?').get(id);
    if (!row) return null;
    return { ...row, steps: JSON.parse(row.steps_json || '[]') };
  }

  updateRundown(id, { name, steps }) {
    const now = new Date().toISOString();
    const sets = [];
    const vals = [];
    if (name !== undefined) { sets.push('name = ?'); vals.push(name); }
    if (steps !== undefined) { sets.push('steps_json = ?'); vals.push(JSON.stringify(steps)); }
    if (sets.length === 0) return null;
    sets.push('updated_at = ?');
    vals.push(now);
    vals.push(id);
    this.db.prepare(`UPDATE rundowns SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return this.getRundown(id);
  }

  deleteRundown(id) {
    // Deactivate if this rundown is active anywhere
    this.db.prepare('DELETE FROM active_rundowns WHERE rundown_id = ?').run(id);
    this.db.prepare('DELETE FROM rundowns WHERE id = ?').run(id);
    return { deleted: true };
  }

  // ─── ACTIVE STATE ────────────────────────────────────────────────────────────

  activateRundown(churchId, rundownId, instanceName) {
    const rundown = this.getRundown(rundownId);
    if (!rundown) return null;
    if (rundown.church_id !== churchId) return null;
    const now = new Date().toISOString();
    // For multi-room: deactivate any existing rundown for this church+instance first
    if (instanceName) {
      this.db.prepare('DELETE FROM active_rundowns WHERE church_id = ? AND instance_name = ?').run(churchId, instanceName);
    }
    this.db.prepare(
      'INSERT OR REPLACE INTO active_rundowns (church_id, rundown_id, current_step, started_at, instance_name, room_id) VALUES (?, ?, 0, ?, ?, ?)'
    ).run(churchId, rundownId, now, instanceName || null, rundown.room_id || null);
    return { churchId, rundownId, currentStep: 0, startedAt: now, rundown, instanceName: instanceName || null };
  }

  advanceStep(churchId, instanceName) {
    const active = this.getActiveRundown(churchId, instanceName);
    if (!active) return null;
    const nextStep = active.currentStep + 1;
    const steps = active.rundown.steps || [];
    if (nextStep >= steps.length) return null; // already at last step
    if (instanceName) {
      this.db.prepare('UPDATE active_rundowns SET current_step = ? WHERE church_id = ? AND instance_name = ?').run(nextStep, churchId, instanceName);
    } else {
      this.db.prepare('UPDATE active_rundowns SET current_step = ? WHERE church_id = ? AND instance_name IS NULL').run(nextStep, churchId);
    }
    return { ...active, currentStep: nextStep };
  }

  goToStep(churchId, stepIndex, instanceName) {
    const active = this.getActiveRundown(churchId, instanceName);
    if (!active) return null;
    const steps = active.rundown.steps || [];
    if (stepIndex < 0 || stepIndex >= steps.length) return null;
    if (instanceName) {
      this.db.prepare('UPDATE active_rundowns SET current_step = ? WHERE church_id = ? AND instance_name = ?').run(stepIndex, churchId, instanceName);
    } else {
      this.db.prepare('UPDATE active_rundowns SET current_step = ? WHERE church_id = ? AND instance_name IS NULL').run(stepIndex, churchId);
    }
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
    let row;
    if (instanceName) {
      row = this.db.prepare('SELECT * FROM active_rundowns WHERE church_id = ? AND instance_name = ?').get(churchId, instanceName);
    }
    // Fallback: try church-level (no instance) for backward compat
    if (!row) {
      row = this.db.prepare('SELECT * FROM active_rundowns WHERE church_id = ? AND (instance_name IS NULL OR instance_name = ?)').get(churchId, instanceName || '');
    }
    if (!row) {
      row = this.db.prepare('SELECT * FROM active_rundowns WHERE church_id = ?').get(churchId);
    }
    if (!row) return null;
    const rundown = this.getRundown(row.rundown_id);
    if (!rundown) {
      // Orphaned active rundown — clean up
      this.db.prepare('DELETE FROM active_rundowns WHERE church_id = ? AND rundown_id = ?').run(churchId, row.rundown_id);
      return null;
    }
    return {
      churchId: row.church_id,
      rundownId: row.rundown_id,
      currentStep: row.current_step,
      startedAt: row.started_at,
      instanceName: row.instance_name || null,
      rundown,
    };
  }

  deactivateRundown(churchId, instanceName) {
    if (instanceName) {
      this.db.prepare('DELETE FROM active_rundowns WHERE church_id = ? AND instance_name = ?').run(churchId, instanceName);
    } else {
      this.db.prepare('DELETE FROM active_rundowns WHERE church_id = ?').run(churchId);
    }
    return { deactivated: true };
  }

  // ─── SCHEDULER HELPERS ──────────────────────────────────────────────────────

  /**
   * Find a rundown set to auto-activate for this church on a given day of week.
   * @param {string} churchId
   * @param {number} dayOfWeek 0=Sun, 6=Sat
   * @returns {object|null}
   */
  getAutoActivateRundown(churchId, dayOfWeek, instanceName) {
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
    if (!row) return null;
    return { ...row, steps: JSON.parse(row.steps_json || '[]') };
  }

  /**
   * Activate a rundown with full scheduler state tracking.
   */
  activateRundownForScheduler(churchId, rundownId, serviceStartAt, instanceName) {
    const rundown = this.getRundown(rundownId);
    if (!rundown) return null;
    if (rundown.church_id !== churchId) return null;
    const now = new Date().toISOString();
    // Deactivate existing for this church+instance
    if (instanceName) {
      this.db.prepare('DELETE FROM active_rundowns WHERE church_id = ? AND instance_name = ?').run(churchId, instanceName);
    }
    this.db.prepare(`
      INSERT OR REPLACE INTO active_rundowns
        (church_id, rundown_id, current_step, state, started_at, service_start_at, last_cue_fired_at, cues_fired, instance_name, room_id)
      VALUES (?, ?, 0, 'running', ?, ?, NULL, '[]', ?, ?)
    `).run(churchId, rundownId, now, serviceStartAt || now, instanceName || null, rundown.room_id || null);
    return { churchId, rundownId, currentStep: 0, state: 'running', startedAt: now, serviceStartAt: serviceStartAt || now, rundown, instanceName: instanceName || null };
  }

  /**
   * Get full active rundown state (including scheduler fields).
   */
  getActiveRundownFull(churchId, instanceName) {
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
    return {
      churchId: row.church_id,
      rundownId: row.rundown_id,
      currentStep: row.current_step,
      state: row.state || 'running',
      startedAt: row.started_at,
      serviceStartAt: row.service_start_at || row.started_at,
      lastCueFiredAt: row.last_cue_fired_at || null,
      cuesFired: JSON.parse(row.cues_fired || '[]'),
      instanceName: row.instance_name || null,
      rundown,
    };
  }

  /**
   * Update scheduler-specific state fields on the active rundown.
   */
  updateActiveState(churchId, updates, instanceName) {
    const sets = [];
    const vals = [];
    if (updates.currentStep !== undefined) { sets.push('current_step = ?'); vals.push(updates.currentStep); }
    if (updates.state !== undefined) { sets.push('state = ?'); vals.push(updates.state); }
    if (updates.lastCueFiredAt !== undefined) { sets.push('last_cue_fired_at = ?'); vals.push(updates.lastCueFiredAt); }
    if (updates.cuesFired !== undefined) { sets.push('cues_fired = ?'); vals.push(JSON.stringify(updates.cuesFired)); }
    if (sets.length === 0) return;
    vals.push(churchId);
    if (instanceName) {
      vals.push(instanceName);
      this.db.prepare(`UPDATE active_rundowns SET ${sets.join(', ')} WHERE church_id = ? AND instance_name = ?`).run(...vals);
    } else {
      this.db.prepare(`UPDATE active_rundowns SET ${sets.join(', ')} WHERE church_id = ?`).run(...vals);
    }
  }
}

module.exports = { RundownEngine };
