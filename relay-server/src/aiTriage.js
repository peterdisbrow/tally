/**
 * AI Triage Engine — Intelligent event scoring, time-context detection,
 * session history mining, and mode-based resolution for church AV support.
 *
 * Three modes per church:
 *   - full_auto:      Detect → Score → Auto-fix (reconnect, restart)
 *   - recommend_only:  Detect → Score → Create ticket with recommendation (default)
 *   - monitor_only:    Detect → Score → Log silently
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const { createLogger } = require('./logger');
const log = createLogger('AITriage');

// ─── TIME CONTEXT ────────────────────────────────────────────────────────────

const TIME_CONTEXT = {
  PRE_SERVICE:  'pre_service',
  IN_SERVICE:   'in_service',
  OFF_HOURS:    'off_hours',
};

const AI_MODES = {
  FULL_AUTO:      'full_auto',
  RECOMMEND_ONLY: 'recommend_only',
  MONITOR_ONLY:   'monitor_only',
};

// ─── SEVERITY SCORING WEIGHTS ────────────────────────────────────────────────

/** Base severity scores by alert classification */
const BASE_SEVERITY_SCORES = {
  EMERGENCY: 100,
  CRITICAL:   80,
  WARNING:    40,
  INFO:       10,
};

/** Time-context multipliers — pre-service is highest because TDs need fast resolution */
const TIME_MULTIPLIERS = {
  [TIME_CONTEXT.PRE_SERVICE]: 1.5,
  [TIME_CONTEXT.IN_SERVICE]:  1.3,
  [TIME_CONTEXT.OFF_HOURS]:   0.4,
};

/** Device count impact — more devices down = worse */
const DEVICE_COUNT_BONUSES = [
  { min: 1, max: 1, bonus: 0 },
  { min: 2, max: 2, bonus: 15 },
  { min: 3, max: 4, bonus: 30 },
  { min: 5, max: Infinity, bonus: 50 },
];

/** Reconnection pattern penalties — rapid reconnects indicate instability */
const RECONNECT_PATTERN_SCORES = {
  stable:         0,   // No recent reconnects
  occasional:     5,   // 1-2 reconnects in last 30 min
  frequent:      20,   // 3-5 reconnects
  flapping:      40,   // 6+ reconnects — something is fundamentally wrong
};

/** Alert type specific weights — some alerts are inherently more severe */
const ALERT_TYPE_WEIGHTS = {
  'stream_stopped':            15,
  'atem_disconnected':         12,
  'multiple_systems_down':     25,
  'recording_failed':          10,
  'audio_muted':               10,
  'failover_executed':         20,
  'failover_command_failed':   20,
  'no_td_response':            15,
  'encoder_stream_stopped':    12,
  'atem_stream_stopped':       12,
  'vmix_stream_stopped':       12,
};

// ─── SYMPTOM FINGERPRINTS (for resolution matching) ─────────────────────────

/**
 * Safe remediation commands that can run in full_auto mode.
 * Maps alert types to the command + description.
 */
const SAFE_REMEDIATIONS = {
  'stream_stopped':         { command: 'recovery.restartStream',    description: 'Restart stream', params: {} },
  'atem_stream_stopped':    { command: 'recovery.restartStream',    description: 'Restart ATEM stream', params: { source: 'atem' } },
  'vmix_stream_stopped':    { command: 'recovery.restartStream',    description: 'Restart vMix stream', params: { source: 'vmix' } },
  'encoder_stream_stopped': { command: 'recovery.restartStream',    description: 'Restart encoder stream', params: { source: 'encoder' } },
  'recording_not_started':  { command: 'recovery.restartRecording', description: 'Start recording', params: {} },
  'audio_silence':          { command: 'recovery.resetAudio',       description: 'Reset audio routing', params: {} },
};

// ─── HUMAN-READABLE LABELS ──────────────────────────────────────────────────

/** Convert raw alert_type codes into friendly, human-readable descriptions. */
function _friendlyAlertType(alertType) {
  const map = {
    'stream_stopped':          'Stream stopped',
    'atem_disconnected':       'ATEM switcher disconnected',
    'multiple_systems_down':   'Multiple systems went down',
    'recording_failed':        'Recording failed to start',
    'recording_not_started':   'Recording not started',
    'audio_muted':             'Audio is muted',
    'audio_silence':           'No audio signal detected',
    'failover_executed':       'Backup system activated',
    'failover_command_failed': 'Backup system failed to activate',
    'no_td_response':          'No response from tech director',
    'encoder_stream_stopped':  'Encoder stream stopped',
    'atem_stream_stopped':     'ATEM stream stopped',
    'vmix_stream_stopped':     'vMix stream stopped',
    'obs_disconnected':        'OBS disconnected',
    'encoder_disconnected':    'Encoder disconnected',
    'vmix_disconnected':       'vMix disconnected',
    'connection_lost':         'Device connection lost',
  };
  return map[alertType] || alertType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** Convert triage severity codes into user-friendly labels. */
function _friendlySeverity(severity) {
  const map = {
    'critical': 'Critical',
    'high':     'High',
    'medium':   'Moderate',
    'low':      'Low',
    'info':     'Informational',
  };
  return map[severity] || severity;
}

/** Convert time_context codes into user-friendly phrases. */
function _friendlyTimeContext(context) {
  const map = {
    'pre_service': 'Before service — your team is setting up',
    'in_service':  'During service — you\'re live',
    'off_hours':   'Outside of service hours',
  };
  return map[context] || context.replace(/_/g, ' ');
}

/** Convert reconnect_pattern codes into user-friendly descriptions. */
function _friendlyReconnectPattern(pattern) {
  const map = {
    'stable':     'stable',
    'occasional': 'Reconnected once or twice recently — worth keeping an eye on',
    'frequent':   'Reconnecting frequently — the connection seems unstable',
    'flapping':   'Connection is very unstable — dropping and reconnecting repeatedly',
  };
  return map[pattern] || pattern;
}

// ─── AI TRIAGE ENGINE CLASS ──────────────────────────────────────────────────

class AITriageEngine {
  /**
   * @param {object} db - better-sqlite3 database instance
   * @param {object} scheduleEngine - ScheduleEngine instance
   * @param {object} options
   * @param {Map} options.churches - runtime churches Map
   * @param {object} options.autoRecovery - AutoRecovery instance (for full_auto dispatch)
   * @param {function} options.broadcastToSSE - SSE broadcast function
   * @param {function} options.createTicket - function to create support tickets
   */
  constructor(db, scheduleEngine, options = {}) {
    this.db = db;
    this.scheduleEngine = scheduleEngine;
    this.churches = options.churches || new Map();
    this.autoRecovery = options.autoRecovery || null;
    this.broadcastToSSE = options.broadcastToSSE || (() => {});
    this.createTicket = options.createTicket || null;

    // In-memory reconnection tracking: churchId → { timestamps: [], instanceCounts: Map }
    this._reconnectTracker = new Map();
    this._sessionRecap = null;

    this._ensureTables();
  }

  /** Attach SessionRecap so getTimeContext can detect active streaming sessions. */
  setSessionRecap(sessionRecap) {
    this._sessionRecap = sessionRecap;
  }

  // ─── DATABASE SETUP ──────────────────────────────────────────────────────

  _ensureTables() {
    // AI triage events — every scored event
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_triage_events (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        room_id TEXT,
        alert_type TEXT NOT NULL,
        original_severity TEXT NOT NULL,
        triage_score INTEGER NOT NULL,
        triage_severity TEXT NOT NULL,
        time_context TEXT NOT NULL,
        device_count INTEGER DEFAULT 1,
        reconnect_pattern TEXT DEFAULT 'stable',
        details TEXT DEFAULT '{}',
        resolution_id TEXT,
        created_at TEXT NOT NULL
      )
    `);
    try { this.db.prepare('SELECT church_id FROM ai_triage_events LIMIT 1').get(); }
    catch { /* table just created */ }

    // Create index for fast church+time queries
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_triage_church_time ON ai_triage_events (church_id, created_at)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_triage_severity ON ai_triage_events (triage_severity, created_at)`);

    // AI resolutions — what was tried, did it work
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_resolutions (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        event_id TEXT,
        symptom_fingerprint TEXT NOT NULL,
        action_taken TEXT NOT NULL,
        action_command TEXT,
        success INTEGER NOT NULL,
        duration_ms INTEGER,
        notes TEXT DEFAULT '',
        created_at TEXT NOT NULL
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_resolutions_church ON ai_resolutions (church_id, created_at)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_ai_resolutions_fingerprint ON ai_resolutions (symptom_fingerprint)`);

    // Church AI settings — mode, thresholds, custom windows
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS church_ai_settings (
        church_id TEXT PRIMARY KEY,
        ai_mode TEXT NOT NULL DEFAULT 'recommend_only',
        sensitivity_threshold INTEGER DEFAULT 50,
        pre_service_window_minutes INTEGER DEFAULT 60,
        post_service_buffer_minutes INTEGER DEFAULT 15,
        custom_settings TEXT DEFAULT '{}',
        updated_at TEXT NOT NULL,
        updated_by TEXT
      )
    `);
  }

  // ─── SETTINGS ────────────────────────────────────────────────────────────

  /**
   * Get AI settings for a church, returning defaults if not configured.
   */
  getChurchSettings(churchId) {
    const row = this.db.prepare('SELECT * FROM church_ai_settings WHERE church_id = ?').get(churchId);
    if (row) {
      try { row.custom_settings = JSON.parse(row.custom_settings); } catch { row.custom_settings = {}; }
      return row;
    }
    return {
      church_id: churchId,
      ai_mode: AI_MODES.RECOMMEND_ONLY,
      sensitivity_threshold: 50,
      pre_service_window_minutes: 60,
      post_service_buffer_minutes: 15,
      custom_settings: {},
      updated_at: null,
      updated_by: null,
    };
  }

  /**
   * Update AI settings for a church.
   */
  updateChurchSettings(churchId, settings, updatedBy = null) {
    const now = new Date().toISOString();
    const mode = settings.ai_mode || AI_MODES.RECOMMEND_ONLY;
    if (!Object.values(AI_MODES).includes(mode)) {
      throw new Error(`Invalid AI mode: ${mode}`);
    }

    const sensitivity = Math.max(0, Math.min(100, parseInt(settings.sensitivity_threshold, 10) || 50));
    const preWindow = Math.max(10, Math.min(120, parseInt(settings.pre_service_window_minutes, 10) || 60));
    const postBuffer = Math.max(0, Math.min(60, parseInt(settings.post_service_buffer_minutes, 10) || 15));
    const customSettings = JSON.stringify(settings.custom_settings || {});

    this.db.prepare(`
      INSERT INTO church_ai_settings (church_id, ai_mode, sensitivity_threshold, pre_service_window_minutes,
        post_service_buffer_minutes, custom_settings, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(church_id) DO UPDATE SET
        ai_mode = excluded.ai_mode,
        sensitivity_threshold = excluded.sensitivity_threshold,
        pre_service_window_minutes = excluded.pre_service_window_minutes,
        post_service_buffer_minutes = excluded.post_service_buffer_minutes,
        custom_settings = excluded.custom_settings,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `).run(churchId, mode, sensitivity, preWindow, postBuffer, customSettings, now, updatedBy);

    log.info('AI settings updated', { event: 'ai_settings_updated', churchId, mode });
    return this.getChurchSettings(churchId);
  }

  // ─── TIME CONTEXT DETECTION ──────────────────────────────────────────────

  /**
   * Determine the time context for a church right now.
   * Uses schedule + configurable pre-service window.
   *
   * Returns: { context: 'pre_service'|'in_service'|'off_hours', details: {...} }
   */
  getTimeContext(churchId) {
    const settings = this.getChurchSettings(churchId);
    const preWindowMin = settings.pre_service_window_minutes || 60;
    const postBufferMin = settings.post_service_buffer_minutes || 15;

    // Event churches — always treat as in-service
    try {
      const row = this.db.prepare('SELECT church_type, event_expires_at FROM churches WHERE churchId = ?').get(churchId);
      if (row && row.church_type === 'event') {
        if (!row.event_expires_at || new Date(row.event_expires_at) > new Date()) {
          return { context: TIME_CONTEXT.IN_SERVICE, details: { reason: 'event_mode' } };
        }
      }
    } catch { /* column may not exist */ }

    const schedule = this.scheduleEngine.getSchedule(churchId);
    if (!schedule.length) {
      // Active streaming session (auto-created on stream-live) → treat as in-service
      if (this._hasActiveStreamingSession(churchId)) {
        return { context: TIME_CONTEXT.IN_SERVICE, details: { reason: 'live_stream_active' } };
      }
      // No schedule — use session history to infer
      const inferred = this._inferTimeContextFromHistory(churchId);
      return inferred || { context: TIME_CONTEXT.OFF_HOURS, details: { reason: 'no_schedule' } };
    }

    const tz = this._getTimezone(churchId);
    const { day, minutesNow } = this._getLocalDayMinutes(tz);

    for (const s of schedule) {
      if (s.day !== day) continue;
      const start = s.startHour * 60 + (s.startMin || 0);
      const end = start + (s.durationHours || 2) * 60;

      // Pre-service: [start - preWindowMin, start)
      // Guard: if pre-window goes negative (early morning service), skip — handled by cross-midnight logic
      if (start - preWindowMin >= 0 && minutesNow >= start - preWindowMin && minutesNow < start) {
        const minutesUntilService = start - minutesNow;
        return {
          context: TIME_CONTEXT.PRE_SERVICE,
          details: { reason: 'scheduled', minutesUntilService, serviceStart: `${s.startHour}:${String(s.startMin || 0).padStart(2, '0')}` },
        };
      }

      // In-service: [start, end + postBufferMin]
      if (minutesNow >= start && minutesNow <= end + postBufferMin) {
        const minutesIntoService = minutesNow - start;
        const totalDuration = (s.durationHours || 2) * 60;
        return {
          context: TIME_CONTEXT.IN_SERVICE,
          details: { reason: 'scheduled', minutesIntoService, totalDuration },
        };
      }
    }

    // Check if pre-service window crosses midnight (e.g., service at 00:30, preWindow=60)
    const yesterday = (day + 6) % 7; // previous day
    for (const s of schedule) {
      if (s.day !== yesterday) continue;
      const start = s.startHour * 60 + (s.startMin || 0);
      const end = start + (s.durationHours || 2) * 60;
      // Service ended today? Post-buffer might still apply
      if (end > 24 * 60) {
        const adjustedEnd = end - 24 * 60;
        if (minutesNow <= adjustedEnd + postBufferMin) {
          return {
            context: TIME_CONTEXT.IN_SERVICE,
            details: { reason: 'overnight_service', minutesIntoService: minutesNow + (24 * 60 - start) },
          };
        }
      }
    }

    // Also check tomorrow for pre-service crossing midnight
    const tomorrow = (day + 1) % 7;
    for (const s of schedule) {
      if (s.day !== tomorrow) continue;
      const start = s.startHour * 60 + (s.startMin || 0);
      const minutesUntilMidnight = 24 * 60 - minutesNow;
      const totalMinutesUntil = minutesUntilMidnight + start;
      if (totalMinutesUntil <= preWindowMin) {
        return {
          context: TIME_CONTEXT.PRE_SERVICE,
          details: { reason: 'pre_service_crosses_midnight', minutesUntilService: totalMinutesUntil },
        };
      }
    }

    // Outside scheduled windows but stream is live → still in-service
    if (this._hasActiveStreamingSession(churchId)) {
      return { context: TIME_CONTEXT.IN_SERVICE, details: { reason: 'live_stream_active' } };
    }

    return { context: TIME_CONTEXT.OFF_HOURS, details: { reason: 'outside_schedule' } };
  }

  /**
   * Check whether the church has an active session with a live stream.
   * Uses the attached SessionRecap to inspect in-memory session state.
   */
  _hasActiveStreamingSession(churchId) {
    if (!this._sessionRecap) return false;
    const entries = this._sessionRecap._getSessionEntriesForChurch(churchId);
    return entries.some(e => e.session.streaming);
  }

  /**
   * Mine session history to infer time context when no schedule is set.
   * If a church typically has sessions at this day/time, treat it as in-service.
   */
  _inferTimeContextFromHistory(churchId) {
    try {
      const sessions = this.db.prepare(`
        SELECT started_at, ended_at FROM service_sessions
        WHERE church_id = ? AND started_at IS NOT NULL
        ORDER BY started_at DESC LIMIT 20
      `).all(churchId);

      if (sessions.length < 3) return null; // not enough data

      const tz = this._getTimezone(churchId);
      const { day, minutesNow } = this._getLocalDayMinutes(tz);

      // Count how many sessions started on this day of week within ±60 min of now
      let matchCount = 0;
      for (const sess of sessions) {
        const dt = new Date(sess.started_at);
        const sessDayMin = this._getLocalDayMinutes(tz, dt);
        if (sessDayMin.day === day && Math.abs(sessDayMin.minutesNow - minutesNow) <= 60) {
          matchCount++;
        }
      }

      // If 2+ sessions matched this time slot, consider it a likely service time
      if (matchCount >= 2) {
        return {
          context: TIME_CONTEXT.IN_SERVICE,
          details: { reason: 'inferred_from_history', matchingSessions: matchCount },
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  // ─── TRIAGE SCORING ──────────────────────────────────────────────────────

  /**
   * Score an incoming event. This is the core triage function.
   *
   * @param {string} churchId
   * @param {string} alertType - e.g. 'stream_stopped', 'atem_disconnected'
   * @param {string} originalSeverity - from AlertEngine classification
   * @param {object} context - additional context (message, status, etc.)
   * @returns {object} scored event with triage_score, triage_severity, time_context, etc.
   */
  scoreEvent(churchId, alertType, originalSeverity, context = {}) {
    const timeCtx = this.getTimeContext(churchId);
    const deviceCount = this._countAffectedDevices(churchId, alertType, context);
    const reconnectPattern = this._getReconnectPattern(churchId);
    const churchHistory = this._getChurchHistoryFactor(churchId);

    // Base score from original severity
    let score = BASE_SEVERITY_SCORES[originalSeverity] || 40;

    // Apply time multiplier
    score *= TIME_MULTIPLIERS[timeCtx.context] || 1.0;

    // Add device count bonus
    for (const bracket of DEVICE_COUNT_BONUSES) {
      if (deviceCount >= bracket.min && deviceCount <= bracket.max) {
        score += bracket.bonus;
        break;
      }
    }

    // Add reconnection pattern score
    score += RECONNECT_PATTERN_SCORES[reconnectPattern] || 0;

    // Add alert-type-specific weight
    score += ALERT_TYPE_WEIGHTS[alertType] || 0;

    // Church history factor — churches with frequent issues get slight bump
    score += churchHistory;

    // Apply sensitivity threshold from settings
    const settings = this.getChurchSettings(churchId);
    const sensitivityMultiplier = settings.sensitivity_threshold / 50; // 50 = neutral
    score = Math.round(score * sensitivityMultiplier);

    // Clamp to 0-150 range
    score = Math.max(0, Math.min(150, score));

    // Derive triage severity from score
    const triageSeverity = this._scoreToSeverity(score);

    return {
      triage_score: score,
      triage_severity: triageSeverity,
      time_context: timeCtx.context,
      time_details: timeCtx.details,
      device_count: deviceCount,
      reconnect_pattern: reconnectPattern,
      church_history_factor: churchHistory,
      original_severity: originalSeverity,
    };
  }

  /**
   * Convert numeric score to severity label.
   */
  _scoreToSeverity(score) {
    if (score >= 100) return 'critical';
    if (score >= 70)  return 'high';
    if (score >= 40)  return 'medium';
    if (score >= 20)  return 'low';
    return 'info';
  }

  /**
   * Count how many devices are currently affected for this church.
   */
  _countAffectedDevices(churchId, alertType, context) {
    // If the alert itself tells us about multiple systems
    if (alertType === 'multiple_systems_down') return 5;

    const church = this.churches.get(churchId);
    if (!church?.status) return 1;

    let count = 0;
    const status = church.status;
    // Count disconnected devices from live status
    if (status.atem?.connected === false) count++;
    if (status.obs?.connected === false) count++;
    if (status.encoder?.connected === false) count++;
    if (status.hyperdeck?.connected === false) count++;
    if (status.mixer?.connected === false) count++;
    if (status.vmix?.connected === false) count++;

    return Math.max(1, count);
  }

  /**
   * Track and analyze reconnection patterns for a church.
   */
  _getReconnectPattern(churchId) {
    const tracker = this._reconnectTracker.get(churchId);
    if (!tracker) return 'stable';

    const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
    const recentReconnects = tracker.timestamps.filter(t => t > thirtyMinAgo);

    if (recentReconnects.length >= 6) return 'flapping';
    if (recentReconnects.length >= 3) return 'frequent';
    if (recentReconnects.length >= 1) return 'occasional';
    return 'stable';
  }

  /**
   * Record a reconnection event for pattern tracking.
   */
  recordReconnection(churchId) {
    let tracker = this._reconnectTracker.get(churchId);
    if (!tracker) {
      tracker = { timestamps: [] };
      this._reconnectTracker.set(churchId, tracker);
    }
    tracker.timestamps.push(Date.now());
    // Keep only last hour of data
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    tracker.timestamps = tracker.timestamps.filter(t => t > oneHourAgo);

    // Periodic sweep: remove stale entries every 100 reconnections
    if (this._reconnectTracker.size > 100) {
      for (const [key, entry] of this._reconnectTracker.entries()) {
        const recent = entry.timestamps.filter(t => t > oneHourAgo);
        if (recent.length === 0) {
          this._reconnectTracker.delete(key);
        } else {
          entry.timestamps = recent;
        }
      }
    }
  }

  /**
   * Get a history-based scoring factor for the church.
   * Churches with many recent issues get a small bonus to prioritize attention.
   */
  _getChurchHistoryFactor(churchId) {
    try {
      const row = this.db.prepare(`
        SELECT COUNT(*) as cnt FROM ai_triage_events
        WHERE church_id = ? AND created_at > datetime('now', '-7 days')
          AND triage_severity IN ('critical', 'high')
      `).get(churchId);
      const count = row?.cnt || 0;
      if (count >= 10) return 10;
      if (count >= 5) return 5;
      return 0;
    } catch {
      return 0;
    }
  }

  // ─── MAIN TRIAGE PIPELINE ────────────────────────────────────────────────

  /**
   * Process an incoming alert through the full triage pipeline.
   * This is the primary entry point called from the alert flow in server.js.
   *
   * @param {string} churchId
   * @param {string} alertType
   * @param {string} originalSeverity - from AlertEngine classification
   * @param {object} context - { message, status, roomId, instanceName, ... }
   * @returns {object} { eventId, triageResult, action, resolution? }
   */
  async processAlert(churchId, alertType, originalSeverity, context = {}) {
    const settings = this.getChurchSettings(churchId);
    const scored = this.scoreEvent(churchId, alertType, originalSeverity, context);

    // Store the triage event
    const eventId = uuidv4();
    const now = new Date().toISOString();
    const safeContext = context || {};
    const details = JSON.stringify({
      message: safeContext.message,
      time_details: scored.time_details,
      church_history_factor: scored.church_history_factor,
      original_context: safeContext,
    });

    this.db.prepare(`
      INSERT INTO ai_triage_events (id, church_id, room_id, alert_type, original_severity,
        triage_score, triage_severity, time_context, device_count, reconnect_pattern, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId, churchId, safeContext.roomId || null, alertType, originalSeverity,
      scored.triage_score, scored.triage_severity, scored.time_context,
      scored.device_count, scored.reconnect_pattern, details, now,
    );

    // Broadcast to SSE for real-time dashboard
    this.broadcastToSSE({
      type: 'ai_triage_event',
      eventId,
      churchId,
      alertType,
      triageScore: scored.triage_score,
      triageSeverity: scored.triage_severity,
      timeContext: scored.time_context,
      deviceCount: scored.device_count,
      createdAt: now,
    });

    // Determine action based on mode
    let action = 'logged';
    let resolution = null;

    switch (settings.ai_mode) {
      case AI_MODES.FULL_AUTO:
        resolution = await this._executeFullAuto(churchId, eventId, alertType, scored, context);
        action = resolution ? 'auto_resolved' : 'escalated';
        break;

      case AI_MODES.RECOMMEND_ONLY:
        await this._createRecommendation(churchId, eventId, alertType, scored, context);
        action = 'recommendation_created';
        break;

      case AI_MODES.MONITOR_ONLY:
        action = 'monitored';
        break;
    }

    log.info('Triage processed', {
      event: 'triage_processed',
      churchId,
      alertType,
      score: scored.triage_score,
      severity: scored.triage_severity,
      timeContext: scored.time_context,
      mode: settings.ai_mode,
      action,
    });

    return {
      eventId,
      triageResult: scored,
      action,
      resolution,
      mode: settings.ai_mode,
    };
  }

  // ─── MODE-SPECIFIC ACTIONS ───────────────────────────────────────────────

  /**
   * Full Auto mode: attempt safe remediation.
   */
  async _executeFullAuto(churchId, eventId, alertType, scored, context) {
    const remediation = SAFE_REMEDIATIONS[alertType];
    if (!remediation) {
      // No safe auto-fix — still log as recommendation
      await this._createRecommendation(churchId, eventId, alertType, scored, context);
      return null;
    }

    const startTime = Date.now();
    const resolutionId = uuidv4();
    const fingerprint = `${alertType}::${scored.time_context}`;

    // Check resolution history — if this exact fix has failed 3+ times recently, don't retry
    const recentFailures = this._getRecentResolutionFailures(churchId, fingerprint);
    if (recentFailures >= 3) {
      this._logResolution(resolutionId, churchId, eventId, fingerprint,
        'skipped_repeated_failures', remediation.command, false, 0,
        `Skipped: ${recentFailures} recent failures for same symptom`);
      await this._createRecommendation(churchId, eventId, alertType, scored, context);
      return null;
    }

    // Dispatch the recovery command
    try {
      const church = this.churches.get(churchId);
      if (!church || !this.autoRecovery) {
        this._logResolution(resolutionId, churchId, eventId, fingerprint,
          remediation.description, remediation.command, false, Date.now() - startTime,
          'Church not connected or autoRecovery not available');
        return null;
      }

      const result = await this.autoRecovery.attempt(church, alertType, church.status);
      const success = result.attempted && result.success;
      const duration = Date.now() - startTime;

      this._logResolution(resolutionId, churchId, eventId, fingerprint,
        remediation.description, remediation.command, success, duration,
        result.reason || '');

      // Link resolution to triage event
      this.db.prepare('UPDATE ai_triage_events SET resolution_id = ? WHERE id = ?')
        .run(resolutionId, eventId);

      if (success) {
        this.broadcastToSSE({
          type: 'ai_triage_resolution',
          eventId,
          churchId,
          resolutionId,
          success: true,
          action: remediation.description,
          durationMs: duration,
        });
      }

      return { resolutionId, success, command: remediation.command, duration };
    } catch (err) {
      this._logResolution(resolutionId, churchId, eventId, fingerprint,
        remediation.description, remediation.command, false, Date.now() - startTime,
        `Error: ${err.message}`);
      return null;
    }
  }

  /**
   * Recommend Only mode: create a ticket with the recommended action.
   */
  async _createRecommendation(churchId, eventId, alertType, scored, context) {
    if (!this.createTicket) return;

    // Only create tickets for medium+ severity
    if (scored.triage_score < 40) return;

    const remediation = SAFE_REMEDIATIONS[alertType];
    const friendlyAlert = _friendlyAlertType(alertType);
    const friendlySeverity = _friendlySeverity(scored.triage_severity);
    const friendlyContext = _friendlyTimeContext(scored.time_context);
    const friendlyReconnect = _friendlyReconnectPattern(scored.reconnect_pattern);

    const recommendation = remediation
      ? `Suggested fix: ${remediation.description}`
      : `This may need a hands-on look — check the ${alertType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} equipment.`;

    const deviceNote = scored.device_count > 1
      ? `${scored.device_count} devices are affected.`
      : 'One device is affected.';

    try {
      await this.createTicket({
        churchId,
        title: `${friendlyAlert} — ${friendlySeverity} priority`,
        description: [
          `We detected a ${friendlyAlert.toLowerCase()} issue (${friendlySeverity} priority).`,
          `Timing: ${friendlyContext}.`,
          deviceNote,
          friendlyReconnect !== 'stable' ? `Connection stability: ${friendlyReconnect}.` : '',
          '',
          recommendation,
          '',
          context.message || '',
        ].filter(Boolean).join('\n'),
        severity: scored.triage_severity === 'critical' ? 'P1' : scored.triage_severity === 'high' ? 'P2' : 'P3',
        issueCategory: this._alertTypeToCategory(alertType),
        aiTriageEventId: eventId,
      });
    } catch (err) {
      log.error('Failed to create recommendation ticket', {
        event: 'recommendation_ticket_failed', churchId, error: err.message,
      });
    }
  }

  _alertTypeToCategory(alertType) {
    if (alertType.includes('stream')) return 'stream_down';
    if (alertType.includes('audio')) return 'no_audio_stream';
    if (alertType.includes('atem')) return 'atem_connectivity';
    if (alertType.includes('recording')) return 'recording_issue';
    return 'other';
  }

  // ─── RESOLUTION LOGGING ──────────────────────────────────────────────────

  _logResolution(id, churchId, eventId, fingerprint, action, command, success, durationMs, notes = '') {
    this.db.prepare(`
      INSERT INTO ai_resolutions (id, church_id, event_id, symptom_fingerprint, action_taken,
        action_command, success, duration_ms, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, churchId, eventId, fingerprint, action, command || null,
      success ? 1 : 0, durationMs, notes, new Date().toISOString());
  }

  _getRecentResolutionFailures(churchId, fingerprint) {
    try {
      const row = this.db.prepare(`
        SELECT COUNT(*) as cnt FROM ai_resolutions
        WHERE church_id = ? AND symptom_fingerprint = ? AND success = 0
          AND created_at > datetime('now', '-1 hour')
      `).get(churchId, fingerprint);
      return row?.cnt || 0;
    } catch {
      return 0;
    }
  }

  // ─── QUERY / STATS ──────────────────────────────────────────────────────

  /**
   * Get recent triage events, optionally filtered by church.
   */
  getRecentEvents({ churchId, limit = 50, offset = 0, severity, timeContext } = {}) {
    let sql = 'SELECT * FROM ai_triage_events WHERE 1=1';
    const params = [];

    if (churchId) { sql += ' AND church_id = ?'; params.push(churchId); }
    if (severity) { sql += ' AND triage_severity = ?'; params.push(severity); }
    if (timeContext) { sql += ' AND time_context = ?'; params.push(timeContext); }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params);
    for (const row of rows) {
      try { row.details = JSON.parse(row.details); } catch { row.details = {}; }
    }
    return rows;
  }

  /**
   * Get triage statistics for the dashboard.
   */
  getStats({ churchId, days = 7 } = {}) {
    // Sanitize days to prevent SQL injection — must be a positive integer
    const safeDays = Math.max(1, Math.min(365, Math.floor(Number(days)) || 7));
    const daysModifier = `-${safeDays} days`;
    const churchFilter = churchId ? 'AND church_id = ?' : '';
    const params = churchId ? [churchId] : [];

    // Total events
    const totalRow = this.db.prepare(`
      SELECT COUNT(*) as total FROM ai_triage_events
      WHERE created_at > datetime('now', ?) ${churchFilter}
    `).get(daysModifier, ...params);

    // Severity distribution
    const severityDist = this.db.prepare(`
      SELECT triage_severity, COUNT(*) as count FROM ai_triage_events
      WHERE created_at > datetime('now', ?) ${churchFilter}
      GROUP BY triage_severity ORDER BY count DESC
    `).all(daysModifier, ...params);

    // Time context distribution
    const timeCtxDist = this.db.prepare(`
      SELECT time_context, COUNT(*) as count FROM ai_triage_events
      WHERE created_at > datetime('now', ?) ${churchFilter}
      GROUP BY time_context ORDER BY count DESC
    `).all(daysModifier, ...params);

    // Resolution success rate
    const resolutionRow = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes
      FROM ai_resolutions
      WHERE created_at > datetime('now', ?) ${churchFilter}
    `).get(daysModifier, ...params);

    // Top alert types
    const topAlerts = this.db.prepare(`
      SELECT alert_type, COUNT(*) as count, ROUND(AVG(triage_score), 1) as avg_score
      FROM ai_triage_events
      WHERE created_at > datetime('now', ?) ${churchFilter}
      GROUP BY alert_type ORDER BY count DESC LIMIT 10
    `).all(daysModifier, ...params);

    // Events per day (for trend chart)
    const dailyTrend = this.db.prepare(`
      SELECT DATE(created_at) as day, COUNT(*) as count,
        SUM(CASE WHEN triage_severity = 'critical' THEN 1 ELSE 0 END) as critical,
        SUM(CASE WHEN triage_severity = 'high' THEN 1 ELSE 0 END) as high,
        SUM(CASE WHEN triage_severity = 'medium' THEN 1 ELSE 0 END) as medium,
        SUM(CASE WHEN triage_severity = 'low' THEN 1 ELSE 0 END) as low
      FROM ai_triage_events
      WHERE created_at > datetime('now', ?) ${churchFilter}
      GROUP BY DATE(created_at) ORDER BY day ASC
    `).all(daysModifier, ...params);

    // Average score by time context
    const avgByContext = this.db.prepare(`
      SELECT time_context, ROUND(AVG(triage_score), 1) as avg_score, COUNT(*) as count
      FROM ai_triage_events
      WHERE created_at > datetime('now', ?) ${churchFilter}
      GROUP BY time_context
    `).all(daysModifier, ...params);

    return {
      total_events: totalRow?.total || 0,
      severity_distribution: severityDist,
      time_context_distribution: timeCtxDist,
      resolution_rate: resolutionRow?.total
        ? Math.round((resolutionRow.successes / resolutionRow.total) * 100)
        : 0,
      resolution_total: resolutionRow?.total || 0,
      resolution_successes: resolutionRow?.successes || 0,
      top_alert_types: topAlerts,
      daily_trend: dailyTrend,
      avg_score_by_context: avgByContext,
    };
  }

  /**
   * Get all church AI mode settings (for admin overview).
   */
  getAllChurchModes() {
    const rows = this.db.prepare(`
      SELECT cas.church_id, cas.ai_mode, cas.sensitivity_threshold, cas.updated_at,
             c.name as church_name
      FROM church_ai_settings cas
      LEFT JOIN churches c ON c.churchId = cas.church_id
      ORDER BY cas.updated_at DESC
    `).all();
    return rows;
  }

  /**
   * Get service window visualization data for a church.
   */
  getServiceWindows(churchId) {
    const schedule = this.scheduleEngine.getSchedule(churchId);
    const settings = this.getChurchSettings(churchId);
    const preWindow = settings.pre_service_window_minutes || 60;
    const postBuffer = settings.post_service_buffer_minutes || 15;
    const tz = this._getTimezone(churchId);

    const windows = schedule.map(s => {
      const startMin = s.startHour * 60 + (s.startMin || 0);
      const endMin = startMin + (s.durationHours || 2) * 60;
      return {
        day: s.day,
        dayName: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][s.day],
        preServiceStart: Math.max(0, startMin - preWindow),
        serviceStart: startMin,
        serviceEnd: endMin,
        postBufferEnd: endMin + postBuffer,
        startFormatted: `${String(s.startHour).padStart(2, '0')}:${String(s.startMin || 0).padStart(2, '0')}`,
        endFormatted: this._minutesToTime(endMin),
      };
    });

    const currentContext = this.getTimeContext(churchId);

    return { windows, currentContext, timezone: tz, preWindowMinutes: preWindow, postBufferMinutes: postBuffer };
  }

  // ─── UTILITY ─────────────────────────────────────────────────────────────

  _getTimezone(churchId) {
    try {
      const row = this.db.prepare('SELECT timezone FROM churches WHERE churchId = ?').get(churchId);
      return row?.timezone || '';
    } catch { return ''; }
  }

  _getLocalDayMinutes(tz, date) {
    const now = date || new Date();
    if (!tz) {
      return { day: now.getDay(), minutesNow: now.getHours() * 60 + now.getMinutes() };
    }
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(now);

      const weekdayNames = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      const weekday = parts.find(p => p.type === 'weekday')?.value;
      const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10) % 24;
      const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);

      return { day: weekdayNames[weekday] ?? now.getDay(), minutesNow: hour * 60 + minute };
    } catch {
      return { day: now.getDay(), minutesNow: now.getHours() * 60 + now.getMinutes() };
    }
  }

  _minutesToTime(minutes) {
    const h = Math.floor(minutes / 60) % 24;
    const m = minutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  /**
   * Cleanup old triage events (call periodically).
   */
  cleanup(retainDays = 90) {
    const safeRetain = Math.max(1, Math.min(365, Math.floor(Number(retainDays)) || 90));
    const modifier = `-${safeRetain} days`;
    try {
      const result = this.db.prepare(
        `DELETE FROM ai_triage_events WHERE created_at < datetime('now', ?)`
      ).run(modifier);
      if (result.changes > 0) {
        log.info('Triage cleanup', { event: 'triage_cleanup', deleted: result.changes });
      }
      this.db.prepare(
        `DELETE FROM ai_resolutions WHERE created_at < datetime('now', ?)`
      ).run(modifier);
    } catch (err) {
      log.error('Triage cleanup failed', { event: 'triage_cleanup_error', error: err.message });
    }
  }
}

module.exports = {
  AITriageEngine,
  TIME_CONTEXT,
  AI_MODES,
  BASE_SEVERITY_SCORES,
  TIME_MULTIPLIERS,
  DEVICE_COUNT_BONUSES,
  RECONNECT_PATTERN_SCORES,
  ALERT_TYPE_WEIGHTS,
  SAFE_REMEDIATIONS,
  _friendlyAlertType,
  _friendlySeverity,
  _friendlyTimeContext,
  _friendlyReconnectPattern,
};
