/**
 * AutoPilot — Light AI automation engine
 *
 * Allows churches to define trigger→action rules that fire automatically
 * during service windows. Think IFTTT for church production:
 *   "When worship slides start → switch to cam 1"
 *   "10 minutes into service → start recording"
 *
 * Trigger types:
 *   - propresenter_slide_change: When a slide or presentation matches a pattern
 *   - schedule_timer: N minutes into the service window
 *   - equipment_state_match: When equipment state matches a condition
 *
 * Safety:
 *   - Rules disabled by default, must be explicitly enabled
 *   - Only fires during active service windows
 *   - Each rule fires max once per session (dedup)
 *   - Pause/resume per church via API or Telegram
 *   - All auto-executed commands logged with source: 'autopilot'
 */

const { v4: uuidv4 } = require('uuid');

const TRIGGER_TYPES = ['propresenter_slide_change', 'schedule_timer', 'equipment_state_match'];

class AutoPilot {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {object} opts
   * @param {object} opts.scheduleEngine - ScheduleEngine instance (for service window checks)
   * @param {object} opts.sessionRecap   - SessionRecap instance (for session IDs)
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.scheduleEngine = opts.scheduleEngine || null;
    this.sessionRecap = opts.sessionRecap || null;
    this._ensureSchema();

    // Per-church pause state (churchId → boolean)
    this._paused = new Map();

    // Dedup: Track which rules have fired this session (sessionId → Set<ruleId>)
    this._firedThisSession = new Map();

    // Command executor — set by server.js after construction
    this._executeCommand = null;
  }

  /**
   * Set the command executor function.
   * Called as: executeCommand(churchId, command, params, source)
   */
  setCommandExecutor(fn) {
    this._executeCommand = fn;
  }

  _ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS command_log (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        session_id TEXT,
        timestamp TEXT NOT NULL,
        command TEXT NOT NULL,
        params TEXT DEFAULT '{}',
        source TEXT NOT NULL DEFAULT 'manual',
        result TEXT,
        equipment_state TEXT
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS automation_rules (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        name TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        trigger_config TEXT NOT NULL DEFAULT '{}',
        actions TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_fired_at TEXT,
        fire_count INTEGER DEFAULT 0
      )
    `);
  }

  // ─── COMMAND LOGGING ──────────────────────────────────────────────────────

  /**
   * Log a command execution (from any source: manual, telegram, autopilot).
   */
  logCommand(churchId, command, params = {}, source = 'manual', result = null, equipmentState = null) {
    const id = uuidv4();
    const sessionId = this.sessionRecap?.getActiveSessionId(churchId) || null;
    this.db.prepare(`
      INSERT INTO command_log (id, church_id, session_id, timestamp, command, params, source, result, equipment_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, churchId, sessionId,
      new Date().toISOString(), command,
      JSON.stringify(params), source,
      result ? String(result).substring(0, 500) : null,
      equipmentState ? JSON.stringify(equipmentState) : null
    );
    return id;
  }

  /**
   * Get command log for a church (paginated).
   */
  getCommandLog(churchId, limit = 50, offset = 0) {
    return this.db.prepare(
      'SELECT * FROM command_log WHERE church_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?'
    ).all(churchId, limit, offset);
  }

  // ─── RULE MANAGEMENT (CRUD) ───────────────────────────────────────────────

  createRule(churchId, { name, triggerType, triggerConfig, actions }) {
    if (!TRIGGER_TYPES.includes(triggerType)) {
      throw new Error(`Invalid trigger type: ${triggerType}. Must be one of: ${TRIGGER_TYPES.join(', ')}`);
    }
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO automation_rules (id, church_id, name, trigger_type, trigger_config, actions, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, churchId, name, triggerType, JSON.stringify(triggerConfig || {}), JSON.stringify(actions || []), now, now);
    return { id, name, triggerType, enabled: false };
  }

  updateRule(ruleId, updates) {
    const rule = this.db.prepare('SELECT * FROM automation_rules WHERE id = ?').get(ruleId);
    if (!rule) throw new Error('Rule not found');

    const fields = [];
    const values = [];

    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
    if (updates.triggerType !== undefined) {
      if (!TRIGGER_TYPES.includes(updates.triggerType)) throw new Error(`Invalid trigger type: ${updates.triggerType}`);
      fields.push('trigger_type = ?'); values.push(updates.triggerType);
    }
    if (updates.triggerConfig !== undefined) { fields.push('trigger_config = ?'); values.push(JSON.stringify(updates.triggerConfig)); }
    if (updates.actions !== undefined) { fields.push('actions = ?'); values.push(JSON.stringify(updates.actions)); }
    if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled ? 1 : 0); }

    if (fields.length === 0) return rule;

    fields.push('updated_at = ?'); values.push(new Date().toISOString());
    values.push(ruleId);

    this.db.prepare(`UPDATE automation_rules SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.db.prepare('SELECT * FROM automation_rules WHERE id = ?').get(ruleId);
  }

  deleteRule(ruleId) {
    const result = this.db.prepare('DELETE FROM automation_rules WHERE id = ?').run(ruleId);
    return result.changes > 0;
  }

  getRules(churchId) {
    const rules = this.db.prepare(
      'SELECT * FROM automation_rules WHERE church_id = ? ORDER BY created_at ASC'
    ).all(churchId);
    return rules.map(r => ({
      ...r,
      trigger_config: JSON.parse(r.trigger_config || '{}'),
      actions: JSON.parse(r.actions || '[]'),
      enabled: !!r.enabled,
    }));
  }

  getRule(ruleId) {
    const r = this.db.prepare('SELECT * FROM automation_rules WHERE id = ?').get(ruleId);
    if (!r) return null;
    return {
      ...r,
      trigger_config: JSON.parse(r.trigger_config || '{}'),
      actions: JSON.parse(r.actions || '[]'),
      enabled: !!r.enabled,
    };
  }

  // ─── PAUSE/RESUME ─────────────────────────────────────────────────────────

  pause(churchId) {
    this._paused.set(churchId, true);
    console.log(`[AutoPilot] Paused for church ${churchId}`);
  }

  resume(churchId) {
    this._paused.delete(churchId);
    console.log(`[AutoPilot] Resumed for church ${churchId}`);
  }

  isPaused(churchId) {
    return this._paused.get(churchId) === true;
  }

  // ─── TRIGGER EVALUATION ───────────────────────────────────────────────────

  /**
   * Called when a ProPresenter slide changes. Evaluates all matching rules.
   * @param {string} churchId
   * @param {object} slideData - { presentationName, slideIndex, slideCount, ... }
   */
  async onSlideChange(churchId, slideData) {
    if (this.isPaused(churchId)) return;
    if (!this._isInServiceWindow(churchId)) return;

    const rules = this._getActiveRules(churchId, 'propresenter_slide_change');
    for (const rule of rules) {
      if (this._hasFiredThisSession(churchId, rule.id)) continue;

      const config = rule.trigger_config;
      let match = false;

      // Match on presentation name (case-insensitive substring)
      if (config.presentationPattern) {
        const pattern = String(config.presentationPattern).toLowerCase();
        const name = String(slideData.presentationName || '').toLowerCase();
        match = name.includes(pattern);
      }

      // Match on slide index
      if (config.slideIndex !== undefined && !match) {
        match = slideData.slideIndex === config.slideIndex;
      }

      // Match on any slide change (no filter)
      if (!config.presentationPattern && config.slideIndex === undefined) {
        match = true;
      }

      if (match) {
        await this._fireRule(churchId, rule, { trigger: 'slide_change', slideData });
      }
    }
  }

  /**
   * Called periodically during service windows to check schedule_timer triggers.
   * @param {string} churchId
   * @param {number} minutesIntoWindow - How many minutes since the service window opened
   */
  async onScheduleTick(churchId, minutesIntoWindow) {
    if (this.isPaused(churchId)) return;
    if (!this._isInServiceWindow(churchId)) return;

    const rules = this._getActiveRules(churchId, 'schedule_timer');
    for (const rule of rules) {
      if (this._hasFiredThisSession(churchId, rule.id)) continue;

      const config = rule.trigger_config;
      const triggerMinute = parseInt(config.minutesIntoService) || 0;

      if (minutesIntoWindow >= triggerMinute) {
        await this._fireRule(churchId, rule, { trigger: 'schedule_timer', minutesIntoWindow });
      }
    }
  }

  /**
   * Called when equipment state changes (e.g., OBS starts streaming, ATEM connects).
   * @param {string} churchId
   * @param {object} state - Current equipment state
   */
  async onEquipmentStateChange(churchId, state) {
    if (this.isPaused(churchId)) return;
    if (!this._isInServiceWindow(churchId)) return;

    const rules = this._getActiveRules(churchId, 'equipment_state_match');
    for (const rule of rules) {
      if (this._hasFiredThisSession(churchId, rule.id)) continue;

      const config = rule.trigger_config;
      let match = true;

      // Check all conditions in the config
      for (const [key, expected] of Object.entries(config.conditions || {})) {
        const actual = this._getNestedValue(state, key);
        if (actual !== expected) { match = false; break; }
      }

      if (match && Object.keys(config.conditions || {}).length > 0) {
        await this._fireRule(churchId, rule, { trigger: 'equipment_state_match', state });
      }
    }
  }

  /**
   * Reset session dedup state. Called when a new session starts.
   */
  resetSession(churchId) {
    const sessionId = this.sessionRecap?.getActiveSessionId(churchId);
    if (sessionId) {
      this._firedThisSession.delete(sessionId);
    }
  }

  // ─── INTERNAL ─────────────────────────────────────────────────────────────

  _isInServiceWindow(churchId) {
    if (!this.scheduleEngine) return true; // No schedule engine = allow
    return this.scheduleEngine.isServiceWindow(churchId);
  }

  _getActiveRules(churchId, triggerType) {
    const rules = this.db.prepare(
      'SELECT * FROM automation_rules WHERE church_id = ? AND trigger_type = ? AND enabled = 1'
    ).all(churchId, triggerType);
    return rules.map(r => ({
      ...r,
      trigger_config: JSON.parse(r.trigger_config || '{}'),
      actions: JSON.parse(r.actions || '[]'),
    }));
  }

  _hasFiredThisSession(churchId, ruleId) {
    const sessionId = this.sessionRecap?.getActiveSessionId(churchId);
    if (!sessionId) return false;
    const fired = this._firedThisSession.get(sessionId);
    return fired?.has(ruleId) || false;
  }

  _markFiredThisSession(churchId, ruleId) {
    const sessionId = this.sessionRecap?.getActiveSessionId(churchId);
    if (!sessionId) return;
    if (!this._firedThisSession.has(sessionId)) {
      this._firedThisSession.set(sessionId, new Set());
    }
    this._firedThisSession.get(sessionId).add(ruleId);
  }

  async _fireRule(churchId, rule, triggerContext) {
    console.log(`[AutoPilot] Firing rule "${rule.name}" for church ${churchId}`);

    // Mark as fired this session (dedup)
    this._markFiredThisSession(churchId, rule.id);

    // Update rule stats
    this.db.prepare(
      'UPDATE automation_rules SET last_fired_at = ?, fire_count = fire_count + 1 WHERE id = ?'
    ).run(new Date().toISOString(), rule.id);

    // Execute each action in the rule
    for (const action of rule.actions) {
      try {
        if (this._executeCommand) {
          const result = await this._executeCommand(churchId, action.command, action.params || {}, 'autopilot');
          this.logCommand(churchId, action.command, action.params || {}, 'autopilot', result);
        } else {
          console.warn(`[AutoPilot] No command executor configured — cannot execute ${action.command}`);
        }
      } catch (e) {
        console.error(`[AutoPilot] Action "${action.command}" failed for rule "${rule.name}":`, e.message);
        this.logCommand(churchId, action.command, action.params || {}, 'autopilot', `ERROR: ${e.message}`);
      }
    }
  }

  _getNestedValue(obj, path) {
    return path.split('.').reduce((o, k) => o?.[k], obj);
  }
}

module.exports = { AutoPilot, TRIGGER_TYPES };
