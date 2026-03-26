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

const TRIGGER_TYPES = ['propresenter_slide_change', 'schedule_timer', 'equipment_state_match', 'alert_condition'];

// Max rules per billing tier
const MAX_RULES_PER_TIER = { connect: 0, plus: 5, pro: 10, managed: 25, enterprise: 25, event: 0 };

// ─── PRE-BUILT RULE TEMPLATES ──────────────────────────────────────────────
// One-click templates that churches can activate without building rules from scratch.
// Each template maps to a specific trigger→action pair with sensible defaults.

const RULE_TEMPLATES = [
  {
    id: 'auto_start_recording',
    name: 'Auto-Start Recording',
    description: 'When stream starts, automatically start recording',
    trigger: { type: 'equipment_state_match', config: { conditions: { 'obs.streaming': true } } },
    action: [{ command: 'obs.startRecording', params: {} }],
    conditions: {},
    tier: 'plus',
    category: 'recording',
  },
  {
    id: 'auto_stop_recording',
    name: 'Auto-Stop Recording',
    description: 'When stream stops, stop recording after 30s delay',
    trigger: { type: 'equipment_state_match', config: { conditions: { 'obs.streaming': false } } },
    action: [{ command: 'obs.stopRecording', params: { delaySeconds: 30 } }],
    conditions: {},
    tier: 'plus',
    category: 'recording',
  },
  {
    id: 'silence_alert_escalation',
    name: 'Silence Alert Escalation',
    description: 'If audio silence >2min, mute stream audio and alert TD',
    trigger: { type: 'equipment_state_match', config: { conditions: { 'audio.silenceDurationSec': 120 } } },
    action: [
      { command: 'audio.muteStream', params: {} },
      { command: 'notify.alertTD', params: { message: 'Audio silence detected (>2 min). Stream audio muted.' } },
    ],
    conditions: {},
    tier: 'pro',
    category: 'audio',
  },
  {
    id: 'camera_failover',
    name: 'Camera Failover',
    description: 'If primary camera input lost, switch to backup camera',
    trigger: { type: 'equipment_state_match', config: { conditions: { 'camera.primary.signal': false } } },
    action: [{ command: 'atem.switchInput', params: { input: 'backup' } }],
    conditions: {},
    tier: 'pro',
    category: 'video',
  },
  {
    id: 'auto_fade_to_black',
    name: 'Auto Fade to Black',
    description: 'When service window ends, fade to black after 5min grace period',
    trigger: { type: 'schedule_timer', config: { minutesAfterWindowEnd: 5 } },
    action: [{ command: 'atem.fadeToBlack', params: {} }],
    conditions: {},
    tier: 'plus',
    category: 'video',
  },
  {
    id: 'pre_service_camera_check',
    name: 'Pre-Service Camera Check',
    description: '15min before service, cycle through all camera inputs',
    trigger: { type: 'schedule_timer', config: { minutesBeforeService: 15 } },
    action: [{ command: 'camera.cycleInputs', params: { dwellSeconds: 5 } }],
    conditions: {},
    tier: 'pro',
    category: 'video',
  },
  {
    id: 'low_bitrate_recovery',
    name: 'Low Bitrate Recovery',
    description: 'If bitrate drops below threshold, restart encoder',
    trigger: { type: 'equipment_state_match', config: { conditions: { 'encoder.bitrateLow': true } } },
    action: [{ command: 'encoder.restart', params: {} }],
    conditions: {},
    tier: 'enterprise',
    category: 'streaming',
  },
  {
    id: 'propresenter_follow',
    name: 'ProPresenter Follow',
    description: 'When ProPresenter advances to specific slide, trigger camera switch',
    trigger: { type: 'propresenter_slide_change', config: { presentationPattern: '', slideIndex: 0 } },
    action: [{ command: 'atem.switchInput', params: { input: 1 } }],
    conditions: {},
    tier: 'pro',
    category: 'integration',
  },
  {
    id: 'alert_stream_restart',
    name: 'Auto-Restart Stream on Drop',
    description: 'When stream_stopped alert fires, automatically restart the stream',
    trigger: { type: 'alert_condition', config: { alertType: 'stream_stopped', minSeverity: 'warning' } },
    action: [{ command: 'encoder.startStream', params: {} }],
    conditions: {},
    tier: 'plus',
    category: 'recovery',
  },
  {
    id: 'alert_audio_silence_notify',
    name: 'Audio Silence Escalation',
    description: 'When audio silence is detected for 2+ minutes, alert TD and mute stream audio',
    trigger: { type: 'alert_condition', config: { alertType: 'audio_silence', minSeverity: 'critical' } },
    action: [{ command: 'notify.alertTD', params: { message: 'Audio silence detected — check mixer and mic connections' } }],
    conditions: {},
    tier: 'plus',
    category: 'recovery',
  },
  {
    id: 'alert_encoder_reconnect',
    name: 'Encoder Offline Recovery',
    description: 'When encoder disconnects, attempt to reconnect and alert TD',
    trigger: { type: 'alert_condition', config: { alertType: 'encoder_disconnected', minSeverity: 'warning' } },
    action: [
      { command: 'notify.alertTD', params: { message: 'Encoder went offline — attempting reconnect' } },
      { command: 'encoder.startStream', params: {} },
    ],
    conditions: {},
    tier: 'plus',
    category: 'recovery',
  },
  {
    id: 'alert_atem_failover',
    name: 'ATEM Disconnect Failover',
    description: 'When ATEM disconnects during service, switch to safe source via Companion',
    trigger: { type: 'alert_condition', config: { alertType: 'atem_disconnected', minSeverity: 'critical' } },
    action: [
      { command: 'companion.pressNamed', params: { name: 'Safe Source' } },
      { command: 'notify.alertTD', params: { message: 'ATEM disconnected — switched to safe source' } },
    ],
    conditions: {},
    tier: 'pro',
    category: 'recovery',
  },
];

// Tier hierarchy for template access gating
const TIER_HIERARCHY = { plus: 1, pro: 2, enterprise: 3 };

// Max total rule fires per service session before auto-pause
const MAX_FIRES_PER_SESSION = 50;

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
    this.billing = opts.billing || null;
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
        fire_count INTEGER DEFAULT 0,
        template_id TEXT
      )
    `);

    // Persisted per-session dedup so relay restarts don't re-fire rules in
    // the same service session (in-memory _firedThisSession is supplemented
    // by this table on every _hasFiredThisSession lookup).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS autopilot_session_fires (
        session_id TEXT NOT NULL,
        rule_id    TEXT NOT NULL,
        church_id  TEXT NOT NULL,
        fired_at   TEXT NOT NULL,
        PRIMARY KEY (session_id, rule_id)
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

    // Enforce per-tier rule limits
    if (this.billing) {
      const church = this.db.prepare('SELECT billing_tier FROM churches WHERE churchId = ?').get(churchId);
      const tier = church?.billing_tier || 'connect';
      const maxRules = MAX_RULES_PER_TIER[tier] ?? 0;
      const currentCount = this.db.prepare('SELECT COUNT(*) as cnt FROM automation_rules WHERE church_id = ?').get(churchId).cnt;
      if (currentCount >= maxRules) {
        const err = new Error(`Rule limit reached (${maxRules} rules for ${tier} plan). Upgrade to add more rules.`);
        err.code = 'RULE_LIMIT_REACHED';
        err.currentTier = tier;
        err.ruleLimit = maxRules;
        throw err;
      }
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

  // ─── TEMPLATE MANAGEMENT ──────────────────────────────────────────────────

  /**
   * Get all templates available for a given billing tier.
   * Higher tiers include all lower-tier templates.
   * @param {string} tier - 'plus', 'pro', or 'enterprise'
   * @returns {Array} templates available at that tier
   */
  getTemplates(tier) {
    const tierLevel = TIER_HIERARCHY[tier] || 0;
    return RULE_TEMPLATES.filter(t => (TIER_HIERARCHY[t.tier] || 0) <= tierLevel);
  }

  /**
   * Activate a pre-built template for a church, creating an enabled rule from it.
   * @param {string} churchId
   * @param {string} templateId - ID of the template to activate
   * @param {object} customParams - Optional overrides (e.g. custom trigger config, action params)
   * @returns {object} the created rule
   */
  activateTemplate(churchId, templateId, customParams = {}) {
    const template = RULE_TEMPLATES.find(t => t.id === templateId);
    if (!template) {
      throw new Error(`Template not found: ${templateId}`);
    }

    // Check if already activated
    const existing = this.db.prepare(
      'SELECT id FROM automation_rules WHERE church_id = ? AND template_id = ?'
    ).get(churchId, templateId);
    if (existing) {
      throw new Error(`Template "${templateId}" is already active for this church`);
    }

    // Tier gating: check church has access
    if (this.billing) {
      const church = this.db.prepare('SELECT billing_tier FROM churches WHERE churchId = ?').get(churchId);
      const churchTier = church?.billing_tier || 'connect';
      const churchLevel = TIER_HIERARCHY[churchTier] || 0;
      const requiredLevel = TIER_HIERARCHY[template.tier] || 0;
      if (churchLevel < requiredLevel) {
        throw new Error(`Template "${template.name}" requires ${template.tier} tier or higher. Current tier: ${churchTier}`);
      }
    }

    // Merge custom params into template defaults
    const triggerConfig = customParams.triggerConfig
      ? { ...template.trigger.config, ...customParams.triggerConfig }
      : { ...template.trigger.config };

    const actions = customParams.actions
      ? customParams.actions
      : template.action.map(a => ({
          command: a.command,
          params: customParams.actionParams ? { ...a.params, ...customParams.actionParams } : { ...a.params },
        }));

    const id = uuidv4();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO automation_rules (id, church_id, name, trigger_type, trigger_config, actions, enabled, created_at, updated_at, template_id)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      id, churchId, template.name, template.trigger.type,
      JSON.stringify(triggerConfig), JSON.stringify(actions),
      now, now, templateId
    );

    return {
      id,
      templateId,
      name: template.name,
      triggerType: template.trigger.type,
      enabled: true,
    };
  }

  /**
   * Deactivate a template-based rule for a church.
   * @param {string} churchId
   * @param {string} templateId
   * @returns {boolean} true if a rule was removed
   */
  deactivateTemplate(churchId, templateId) {
    const result = this.db.prepare(
      'DELETE FROM automation_rules WHERE church_id = ? AND template_id = ?'
    ).run(churchId, templateId);
    return result.changes > 0;
  }

  /**
   * Get which templates are currently active for a church.
   * @param {string} churchId
   * @returns {Array} active template records with template metadata
   */
  getActiveTemplates(churchId) {
    const rows = this.db.prepare(
      'SELECT * FROM automation_rules WHERE church_id = ? AND template_id IS NOT NULL ORDER BY created_at ASC'
    ).all(churchId);
    return rows.map(r => {
      const template = RULE_TEMPLATES.find(t => t.id === r.template_id);
      return {
        ruleId: r.id,
        templateId: r.template_id,
        name: r.name,
        description: template?.description || '',
        category: template?.category || '',
        tier: template?.tier || '',
        enabled: !!r.enabled,
        triggerConfig: JSON.parse(r.trigger_config || '{}'),
        actions: JSON.parse(r.actions || '[]'),
        createdAt: r.created_at,
      };
    });
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
    if (!this._checkBilling(churchId)) return;

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
    if (!this._checkBilling(churchId)) return;

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
    if (!this._checkBilling(churchId)) return;

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
   * Called when an alert fires. Evaluates alert_condition rules.
   * @param {string} churchId
   * @param {{ alertType: string, severity: string, message: string }} alertData
   */
  async onAlert(churchId, alertData) {
    if (this.isPaused(churchId)) return;
    if (!this._isInServiceWindow(churchId)) return;
    if (!this._checkBilling(churchId)) return;

    const rules = this._getActiveRules(churchId, 'alert_condition');
    for (const rule of rules) {
      if (this._hasFiredThisSession(churchId, rule.id)) continue;

      const config = rule.trigger_config;
      let match = false;

      // Match by alert type pattern
      if (config.alertType) {
        const pattern = String(config.alertType).toLowerCase();
        const actual = String(alertData.alertType || '').toLowerCase();
        match = actual === pattern || actual.includes(pattern);
      }

      // Optionally filter by minimum severity
      if (match && config.minSeverity) {
        const severityOrder = { info: 0, warning: 1, critical: 2, emergency: 3 };
        const alertSev = severityOrder[String(alertData.severity || 'info').toLowerCase()] || 0;
        const minSev = severityOrder[String(config.minSeverity).toLowerCase()] || 0;
        if (alertSev < minSev) match = false;
      }

      // Optionally require sustained duration (alert must persist for N seconds)
      // This is checked by the caller — if durationSec is set, the alert engine
      // should only call onAlert after the duration threshold is met.

      if (match) {
        await this._fireRule(churchId, rule, {
          trigger: 'alert_condition',
          alertType: alertData.alertType,
          severity: alertData.severity,
          message: alertData.message,
        });
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
      // Also clear the persisted dedup rows so that rules can fire again
      // in the new session (e.g. next week's service).
      try {
        this.db.prepare('DELETE FROM autopilot_session_fires WHERE session_id = ?').run(sessionId);
      } catch { /* non-fatal */ }
    }
  }

  // ─── INTERNAL ─────────────────────────────────────────────────────────────

  /** Check if church's billing tier allows autopilot. */
  _checkBilling(churchId) {
    if (!this.billing) return true; // no billing system = allow all
    const church = this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId);
    if (!church) return false;
    return this.billing.checkAccess(church, 'autopilot').allowed;
  }

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

    // Fast path: in-memory cache (avoids DB hit on every evaluation)
    const fired = this._firedThisSession.get(sessionId);
    if (fired?.has(ruleId)) return true;

    // Slow path: check persisted table so relay restarts don't re-fire rules
    // in an already-running service session.
    try {
      const row = this.db.prepare(
        'SELECT 1 FROM autopilot_session_fires WHERE session_id = ? AND rule_id = ? LIMIT 1'
      ).get(sessionId, ruleId);
      if (row) {
        // Warm the in-memory cache so subsequent checks stay fast
        if (!this._firedThisSession.has(sessionId)) {
          this._firedThisSession.set(sessionId, new Set());
        }
        this._firedThisSession.get(sessionId).add(ruleId);
        return true;
      }
    } catch {
      // DB error — fall through and allow the rule to fire (fail open)
    }
    return false;
  }

  _markFiredThisSession(churchId, ruleId) {
    const sessionId = this.sessionRecap?.getActiveSessionId(churchId);
    if (!sessionId) return;

    // Update in-memory cache
    if (!this._firedThisSession.has(sessionId)) {
      this._firedThisSession.set(sessionId, new Set());
    }
    this._firedThisSession.get(sessionId).add(ruleId);

    // Persist to DB so the dedup survives relay restarts mid-service
    try {
      this.db.prepare(
        'INSERT OR IGNORE INTO autopilot_session_fires (session_id, rule_id, church_id, fired_at) VALUES (?, ?, ?, ?)'
      ).run(sessionId, ruleId, churchId, new Date().toISOString());
    } catch {
      // Non-fatal — in-memory cache still prevents double-fires within the same process
    }
  }

  async _fireRule(churchId, rule, triggerContext) {
    // Check per-session fire cap to prevent runaway automation
    const sessionId = this.sessionRecap?.getActiveSessionId(churchId);
    if (sessionId) {
      const firedSet = this._firedThisSession.get(sessionId);
      if (firedSet && firedSet.size >= MAX_FIRES_PER_SESSION) {
        console.warn(`[AutoPilot] Session fire cap reached (${MAX_FIRES_PER_SESSION}) for church ${churchId} — pausing autopilot`);
        this.pause(churchId);
        this.logCommand(churchId, 'autopilot.auto_paused', { reason: 'session_fire_cap', limit: MAX_FIRES_PER_SESSION }, 'system');
        return;
      }
    }

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

  /**
   * Dry-run a rule against synthetic telemetry. No commands are executed.
   * @param {string} ruleId
   * @param {object} overrides - Optional: { slideData, minutesIntoService, state }
   * @returns {object} { wouldFire, reason, actions, simulatedTrigger, ruleName }
   */
  testRule(ruleId, overrides = {}) {
    const rule = this.getRule(ruleId);
    if (!rule) throw new Error('Rule not found');

    const triggerType = rule.trigger_type;
    const config = rule.trigger_config || {};
    let wouldFire, reason, simulatedTrigger;

    if (triggerType === 'propresenter_slide_change') {
      const slideData = overrides.slideData || {
        presentationName: config.presentationPattern || 'Sermon',
        slideIndex: config.slideIndex !== undefined ? config.slideIndex : 1,
        slideCount: 20,
      };
      let match = false;
      if (config.presentationPattern) {
        const pattern = String(config.presentationPattern).toLowerCase();
        match = String(slideData.presentationName || '').toLowerCase().includes(pattern);
      } else if (config.slideIndex !== undefined) {
        match = slideData.slideIndex === config.slideIndex;
      } else {
        match = true;
      }
      wouldFire = match;
      reason = match
        ? `Slide "${slideData.presentationName}" (index ${slideData.slideIndex}) matches trigger.`
        : `Slide "${slideData.presentationName}" (index ${slideData.slideIndex}) does not match trigger.`;
      simulatedTrigger = { type: 'propresenter_slide_change', slideData };

    } else if (triggerType === 'schedule_timer') {
      const triggerMinute = parseInt(config.minutesIntoService) || 0;
      const simMinutes = overrides.minutesIntoService !== undefined ? overrides.minutesIntoService : triggerMinute;
      wouldFire = simMinutes >= triggerMinute;
      reason = wouldFire
        ? `At ${simMinutes} min into service window (trigger at ${triggerMinute} min): rule fires.`
        : `At ${simMinutes} min into service window (trigger at ${triggerMinute} min): rule not yet due.`;
      simulatedTrigger = { type: 'schedule_timer', minutesIntoService: simMinutes };

    } else if (triggerType === 'equipment_state_match') {
      const conditions = config.conditions || {};
      // Auto-fill state with matching values so the dry-run defaults to "would fire"
      const state = { ...overrides.state };
      if (!overrides.state) {
        for (const [key, expected] of Object.entries(conditions)) {
          const parts = key.split('.');
          let obj = state;
          for (let i = 0; i < parts.length - 1; i++) {
            if (!obj[parts[i]] || typeof obj[parts[i]] !== 'object') obj[parts[i]] = {};
            obj = obj[parts[i]];
          }
          if (obj[parts[parts.length - 1]] === undefined) obj[parts[parts.length - 1]] = expected;
        }
      }
      const mismatches = [];
      for (const [key, expected] of Object.entries(conditions)) {
        const actual = this._getNestedValue(state, key);
        if (actual !== expected) mismatches.push(`${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
      wouldFire = mismatches.length === 0 && Object.keys(conditions).length > 0;
      reason = wouldFire
        ? `All ${Object.keys(conditions).length} condition(s) match: rule fires.`
        : mismatches.length
          ? `Condition mismatch — ${mismatches.join('; ')}`
          : 'No conditions configured — rule would not fire.';
      simulatedTrigger = { type: 'equipment_state_match', state };

    } else {
      wouldFire = false;
      reason = `Unknown trigger type: ${triggerType}`;
      simulatedTrigger = { type: triggerType };
    }

    return {
      ruleId: rule.id,
      ruleName: rule.name,
      triggerType,
      wouldFire,
      reason,
      actions: rule.actions,
      simulatedTrigger,
      note: 'Dry run — no commands were executed.',
    };
  }

  _getNestedValue(obj, path) {
    return path.split('.').reduce((o, k) => o?.[k], obj);
  }
}

module.exports = { AutoPilot, TRIGGER_TYPES, RULE_TEMPLATES };
