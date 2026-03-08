/**
 * Rundown Engine — CRUD + active rundown state tracking.
 *
 * Allows churches to create step-by-step rundowns that volunteers
 * can follow during services. Each step can trigger device commands
 * (e.g., ATEM switch, recording start) via the existing command pipeline.
 *
 * Tables:
 *   rundowns         — template storage (name, steps JSON, church_id)
 *   active_rundowns  — per-church active rundown state (current step)
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS active_rundowns (
        church_id TEXT PRIMARY KEY,
        rundown_id TEXT NOT NULL,
        current_step INTEGER DEFAULT 0,
        started_at TEXT NOT NULL,
        FOREIGN KEY (rundown_id) REFERENCES rundowns(id)
      )
    `);
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_rundowns_church ON rundowns(church_id)'); } catch {}
  }

  // ─── CRUD ────────────────────────────────────────────────────────────────────

  createRundown(churchId, name, steps = []) {
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO rundowns (id, church_id, name, steps_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, churchId, name, JSON.stringify(steps), now, now);
    return { id, church_id: churchId, name, steps, created_at: now, updated_at: now };
  }

  getRundowns(churchId) {
    const rows = this.db.prepare(
      'SELECT * FROM rundowns WHERE church_id = ? ORDER BY updated_at DESC'
    ).all(churchId);
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

  activateRundown(churchId, rundownId) {
    const rundown = this.getRundown(rundownId);
    if (!rundown) return null;
    if (rundown.church_id !== churchId) return null;
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT OR REPLACE INTO active_rundowns (church_id, rundown_id, current_step, started_at) VALUES (?, ?, 0, ?)'
    ).run(churchId, rundownId, now);
    return { churchId, rundownId, currentStep: 0, startedAt: now, rundown };
  }

  advanceStep(churchId) {
    const active = this.getActiveRundown(churchId);
    if (!active) return null;
    const nextStep = active.currentStep + 1;
    const steps = active.rundown.steps || [];
    if (nextStep >= steps.length) return null; // already at last step
    this.db.prepare('UPDATE active_rundowns SET current_step = ? WHERE church_id = ?').run(nextStep, churchId);
    return { ...active, currentStep: nextStep };
  }

  goToStep(churchId, stepIndex) {
    const active = this.getActiveRundown(churchId);
    if (!active) return null;
    const steps = active.rundown.steps || [];
    if (stepIndex < 0 || stepIndex >= steps.length) return null;
    this.db.prepare('UPDATE active_rundowns SET current_step = ? WHERE church_id = ?').run(stepIndex, churchId);
    return { ...active, currentStep: stepIndex };
  }

  getCurrentStep(churchId) {
    const active = this.getActiveRundown(churchId);
    if (!active) return null;
    const steps = active.rundown.steps || [];
    return {
      stepIndex: active.currentStep,
      step: steps[active.currentStep] || null,
      totalSteps: steps.length,
      rundownName: active.rundown.name,
    };
  }

  getActiveRundown(churchId) {
    const row = this.db.prepare('SELECT * FROM active_rundowns WHERE church_id = ?').get(churchId);
    if (!row) return null;
    const rundown = this.getRundown(row.rundown_id);
    if (!rundown) {
      // Orphaned active rundown — clean up
      this.db.prepare('DELETE FROM active_rundowns WHERE church_id = ?').run(churchId);
      return null;
    }
    return {
      churchId: row.church_id,
      rundownId: row.rundown_id,
      currentStep: row.current_step,
      startedAt: row.started_at,
      rundown,
    };
  }

  deactivateRundown(churchId) {
    this.db.prepare('DELETE FROM active_rundowns WHERE church_id = ?').run(churchId);
    return { deactivated: true };
  }
}

module.exports = { RundownEngine };
