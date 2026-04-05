/**
 * aiRateLimiter.js
 * Centralized AI rate limiting across three pipeline categories:
 *   1. Haiku command parsing (per-hour, existing + incident bypass)
 *   2. Sonnet diagnostic conversations (monthly per-church per-tier)
 *   3. Incident summaries (NEVER limited — template fallback logging only)
 *
 * Core principle: Active incidents (CONFIRMED_OUTAGE / FAILOVER_ACTIVE)
 * bypass ALL limits. Category 3 is never limited regardless of plan or state.
 */

const { createQueryClient } = require('./db');

const SQLITE_FALLBACK_CONFIG = {
  driver: 'sqlite',
  isSqlite: true,
  isPostgres: false,
  databaseUrl: '',
};

class AiRateLimiter {
  /** @type {Record<string, number>} Monthly Sonnet diagnostic limits by billing tier */
  static DIAGNOSTIC_LIMITS = {
    connect: 20,
    plus: 100,
    pro: 300,
    managed: Infinity,  // Enterprise — unlimited
    event: 10,
    default: 20,
  };

  /**
   * @param {{ db: import('better-sqlite3').Database, signalFailover?: object }} opts
   */
  constructor({ db, signalFailover } = {}) {
    this.db = db && typeof db.prepare === 'function' ? db : null;
    this.client = this._resolveClient(db);
    this.signalFailover = signalFailover || null;
    this._logAiUsage = null;
    if (this.db) {
      this._ensureTablesSync();
      this.ready = Promise.resolve();
    } else {
      this.ready = this._init();
    }
  }

  setAiUsageLogger(fn) { this._logAiUsage = fn; }

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
    if (!this.client) throw new Error('[AiRateLimiter] Database client is not configured.');
    return this.client;
  }

  async _init() {
    await this._ensureTables();
  }

  // ─── DB Setup ──────────────────────────────────────────────────────────────

  _ensureTablesSync() {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_diagnostic_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        church_id TEXT NOT NULL,
        month TEXT NOT NULL,
        usage_count INTEGER DEFAULT 0,
        limit_hits INTEGER DEFAULT 0,
        bypasses INTEGER DEFAULT 0,
        UNIQUE(church_id, month)
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_rate_limit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        church_id TEXT NOT NULL,
        category TEXT NOT NULL,
        event_type TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_diag_usage_church_month ON ai_diagnostic_usage(church_id, month)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_rate_events_church ON ai_rate_limit_events(church_id, created_at DESC)');
  }

  async _ensureTables() {
    const client = this._requireClient();
    const idType = client.driver === 'postgres' ? 'BIGSERIAL' : 'INTEGER';
    const autoIncrement = client.driver === 'postgres' ? '' : ' AUTOINCREMENT';

    await client.exec(`
      CREATE TABLE IF NOT EXISTS ai_diagnostic_usage (
        id ${idType} PRIMARY KEY${autoIncrement},
        church_id TEXT NOT NULL,
        month TEXT NOT NULL,
        usage_count INTEGER DEFAULT 0,
        limit_hits INTEGER DEFAULT 0,
        bypasses INTEGER DEFAULT 0,
        UNIQUE(church_id, month)
      )
    `);
    await client.exec(`
      CREATE TABLE IF NOT EXISTS ai_rate_limit_events (
        id ${idType} PRIMARY KEY${autoIncrement},
        church_id TEXT NOT NULL,
        category TEXT NOT NULL,
        event_type TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
      )
    `);
    await client.exec('CREATE INDEX IF NOT EXISTS idx_diag_usage_church_month ON ai_diagnostic_usage(church_id, month)');
    await client.exec('CREATE INDEX IF NOT EXISTS idx_rate_events_church ON ai_rate_limit_events(church_id, created_at DESC)');
  }

  // ─── Active Incident Bypass ────────────────────────────────────────────────

  /**
   * Check if a church currently has an active incident (State 4 or 5).
   * During active incidents ALL AI rate limits are bypassed.
   */
  isActiveIncident(churchId) {
    if (!this.signalFailover) return false;
    try {
      const s = this.signalFailover.getState(churchId);
      return s?.state === 'CONFIRMED_OUTAGE' || s?.state === 'FAILOVER_ACTIVE';
    } catch {
      return false;
    }
  }

  // ─── Category 2: Sonnet Diagnostic Limits (Monthly) ────────────────────────

  /**
   * Check and increment monthly diagnostic usage for a church.
   * @param {string} churchId
   * @param {string} tier — billing tier (connect, plus, pro, managed, event)
   * @returns {{ allowed: boolean, bypassed?: boolean, usage?: number, limit?: number, resetDate?: string, warning80?: boolean }}
   */
  checkDiagnosticLimit(churchId, tier) {
    if (this.db) return this._checkDiagnosticLimitSync(churchId, tier);
    return this._checkDiagnosticLimitAsync(churchId, tier);
  }

  _checkDiagnosticLimitSync(churchId, tier) {
    const limit = AiRateLimiter.DIAGNOSTIC_LIMITS[tier] || AiRateLimiter.DIAGNOSTIC_LIMITS.default;

    // Active incident bypass — never block during crises
    if (this.isActiveIncident(churchId)) {
      this._logBypass(churchId, 'diagnostic');
      return { allowed: true, bypassed: true, usage: 0, limit, resetDate: this._getResetDate() };
    }

    // Enterprise — unlimited
    if (limit === Infinity) {
      return { allowed: true, usage: 0, limit: Infinity, resetDate: this._getResetDate() };
    }

    const month = this._getCurrentMonth();
    const usage = this._getMonthlyUsage(churchId, month);

    if (usage >= limit) {
      this._logLimitHit(churchId, 'diagnostic', usage, limit);
      return { allowed: false, usage, limit, resetDate: this._getResetDate() };
    }

    // Increment usage atomically
    this._incrementUsage(churchId, month);
    const newUsage = usage + 1;

    // 80% warning: fire once when crossing threshold
    const prevRatio = usage / limit;
    const newRatio = newUsage / limit;
    if (newRatio >= 0.8 && prevRatio < 0.8) {
      this.logEvent(churchId, 'diagnostic', 'warning_80pct', `${newUsage}/${limit}`);
      return { allowed: true, warning80: true, usage: newUsage, limit, resetDate: this._getResetDate() };
    }

    return { allowed: true, usage: newUsage, limit, resetDate: this._getResetDate() };
  }

  async _checkDiagnosticLimitAsync(churchId, tier) {
    await this.ready;
    const limit = AiRateLimiter.DIAGNOSTIC_LIMITS[tier] || AiRateLimiter.DIAGNOSTIC_LIMITS.default;

    if (this.isActiveIncident(churchId)) {
      await this._logBypassAsync(churchId, 'diagnostic');
      return { allowed: true, bypassed: true, usage: 0, limit, resetDate: this._getResetDate() };
    }

    if (limit === Infinity) {
      return { allowed: true, usage: 0, limit: Infinity, resetDate: this._getResetDate() };
    }

    const month = this._getCurrentMonth();
    const usage = await this._getMonthlyUsageAsync(churchId, month);

    if (usage >= limit) {
      await this._logLimitHitAsync(churchId, 'diagnostic', usage, limit);
      return { allowed: false, usage, limit, resetDate: this._getResetDate() };
    }

    await this._incrementUsageAsync(churchId, month);
    const newUsage = usage + 1;

    const prevRatio = usage / limit;
    const newRatio = newUsage / limit;
    if (newRatio >= 0.8 && prevRatio < 0.8) {
      await this.logEvent(churchId, 'diagnostic', 'warning_80pct', `${newUsage}/${limit}`);
      return { allowed: true, warning80: true, usage: newUsage, limit, resetDate: this._getResetDate() };
    }

    return { allowed: true, usage: newUsage, limit, resetDate: this._getResetDate() };
  }

  // ─── Category 1: Haiku Command Limits (Incident Bypass Only) ───────────────

  /**
   * Check if a church has an active incident for Haiku command bypass.
   * The actual per-hour limit is handled by ai-parser.js checkAiRateLimit(),
   * which calls the bypass hook set via setIncidentBypassCheck().
   */
  checkCommandLimit(churchId) {
    if (!this.db) return this._checkCommandLimitAsync(churchId);
    return this._checkCommandLimitSync(churchId);
  }

  _checkCommandLimitSync(churchId) {
    if (this.isActiveIncident(churchId)) {
      this._logBypass(churchId, 'command');
      return { allowed: true, bypassed: true };
    }
    return { allowed: true, bypassed: false };
  }

  async _checkCommandLimitAsync(churchId) {
    await this.ready;
    if (this.isActiveIncident(churchId)) {
      await this._logBypassAsync(churchId, 'command');
      return { allowed: true, bypassed: true };
    }
    return { allowed: true, bypassed: false };
  }

  // ─── Portal Dashboard Stats ────────────────────────────────────────────────

  /**
   * Get AI usage stats for the portal billing page.
   * @param {string} churchId
   * @param {string} tier
   * @returns {{ diagnosticUsage: number, diagnosticLimit: number, diagnosticResetDate: string }}
   */
  getUsageStats(churchId, tier) {
    if (this.db) return this._getUsageStatsSync(churchId, tier);
    return this._getUsageStatsAsync(churchId, tier);
  }

  _getUsageStatsSync(churchId, tier) {
    const limit = AiRateLimiter.DIAGNOSTIC_LIMITS[tier] || AiRateLimiter.DIAGNOSTIC_LIMITS.default;
    const month = this._getCurrentMonth();
    const usage = this._getMonthlyUsage(churchId, month);

    return {
      diagnosticUsage: usage,
      diagnosticLimit: limit === Infinity ? Infinity : limit,
      diagnosticResetDate: this._getResetDate(),
    };
  }

  async _getUsageStatsAsync(churchId, tier) {
    await this.ready;
    const limit = AiRateLimiter.DIAGNOSTIC_LIMITS[tier] || AiRateLimiter.DIAGNOSTIC_LIMITS.default;
    const month = this._getCurrentMonth();
    const usage = await this._getMonthlyUsageAsync(churchId, month);

    return {
      diagnosticUsage: usage,
      diagnosticLimit: limit === Infinity ? Infinity : limit,
      diagnosticResetDate: this._getResetDate(),
    };
  }

  // ─── Event Logging ─────────────────────────────────────────────────────────

  /**
   * Log a rate-limit event. Fire-and-forget — never throws.
   * @param {string} churchId
   * @param {string} category — 'command' | 'diagnostic' | 'incident_summary'
   * @param {string} eventType — 'limit_hit' | 'bypass' | 'warning_80pct' | 'template_fallback' | 'api_failure_fallback'
   * @param {string} [detail]
   */
  logEvent(churchId, category, eventType, detail) {
    if (this.db) return this._logEventSync(churchId, category, eventType, detail);
    return this._logEventAsync(churchId, category, eventType, detail);
  }

  _logEventSync(churchId, category, eventType, detail) {
    try {
      if (!this.db) return;
      this.db.prepare(
        'INSERT INTO ai_rate_limit_events (church_id, category, event_type, detail, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(churchId, category, eventType, detail || null, new Date().toISOString());
    } catch (e) {
      console.error(`[AiRateLimiter] Failed to log event:`, e.message);
    }
  }

  async _logEventAsync(churchId, category, eventType, detail) {
    try {
      await this.ready;
      await this._requireClient().run(
        'INSERT INTO ai_rate_limit_events (church_id, category, event_type, detail, created_at) VALUES (?, ?, ?, ?, ?)',
        [churchId, category, eventType, detail || null, new Date().toISOString()]
      );
    } catch (e) {
      console.error('[AiRateLimiter] Failed to log event:', e.message);
    }
  }

  // ─── Internal Helpers ──────────────────────────────────────────────────────

  _getCurrentMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  _getResetDate() {
    const d = new Date();
    const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    return `${months[next.getMonth()]} 1`;
  }

  _getMonthlyUsage(churchId, month) {
    if (!this.db) return 0;
    try {
      const row = this.db.prepare(
        'SELECT usage_count FROM ai_diagnostic_usage WHERE church_id = ? AND month = ?'
      ).get(churchId, month);
      return row?.usage_count || 0;
    } catch {
      return 0;
    }
  }

  async _getMonthlyUsageAsync(churchId, month) {
    try {
      await this.ready;
      const row = await this._requireClient().queryOne(
        'SELECT usage_count FROM ai_diagnostic_usage WHERE church_id = ? AND month = ?',
        [churchId, month]
      );
      return row?.usage_count || 0;
    } catch {
      return 0;
    }
  }

  _incrementUsage(churchId, month) {
    if (!this.db) return;
    try {
      this.db.prepare(`
        INSERT INTO ai_diagnostic_usage (church_id, month, usage_count)
        VALUES (?, ?, 1)
        ON CONFLICT(church_id, month) DO UPDATE SET usage_count = usage_count + 1
      `).run(churchId, month);
    } catch (e) {
      console.error(`[AiRateLimiter] Failed to increment usage:`, e.message);
    }
  }

  async _incrementUsageAsync(churchId, month) {
    try {
      await this.ready;
      await this._requireClient().run(
        `INSERT INTO ai_diagnostic_usage (church_id, month, usage_count)
         VALUES (?, ?, 1)
         ON CONFLICT(church_id, month) DO UPDATE SET usage_count = usage_count + 1`,
        [churchId, month]
      );
    } catch (e) {
      console.error('[AiRateLimiter] Failed to increment usage:', e.message);
    }
  }

  _logBypass(churchId, category) {
    this.logEvent(churchId, category, 'bypass', 'active_incident');
    // Also increment bypass counter in usage table
    if (!this.db) return;
    const month = this._getCurrentMonth();
    try {
      this.db.prepare(`
        INSERT INTO ai_diagnostic_usage (church_id, month, usage_count, bypasses)
        VALUES (?, ?, 0, 1)
        ON CONFLICT(church_id, month) DO UPDATE SET bypasses = bypasses + 1
      `).run(churchId, month);
    } catch (e) {
      console.error(`[AiRateLimiter] Failed to log bypass:`, e.message);
    }
  }

  async _logBypassAsync(churchId, category) {
    await this.logEvent(churchId, category, 'bypass', 'active_incident');
    const month = this._getCurrentMonth();
    try {
      await this.ready;
      await this._requireClient().run(
        `INSERT INTO ai_diagnostic_usage (church_id, month, usage_count, bypasses)
         VALUES (?, ?, 0, 1)
         ON CONFLICT(church_id, month) DO UPDATE SET bypasses = bypasses + 1`,
        [churchId, month]
      );
    } catch (e) {
      console.error('[AiRateLimiter] Failed to log bypass:', e.message);
    }
  }

  _logLimitHit(churchId, category, usage, limit) {
    this.logEvent(churchId, category, 'limit_hit', `${usage}/${limit}`);
    // Increment limit_hits counter
    if (!this.db) return;
    const month = this._getCurrentMonth();
    try {
      this.db.prepare(`
        INSERT INTO ai_diagnostic_usage (church_id, month, usage_count, limit_hits)
        VALUES (?, ?, 0, 1)
        ON CONFLICT(church_id, month) DO UPDATE SET limit_hits = limit_hits + 1
      `).run(churchId, month);
    } catch (e) {
      console.error(`[AiRateLimiter] Failed to log limit hit:`, e.message);
    }
  }

  async _logLimitHitAsync(churchId, category, usage, limit) {
    await this.logEvent(churchId, category, 'limit_hit', `${usage}/${limit}`);
    const month = this._getCurrentMonth();
    try {
      await this.ready;
      await this._requireClient().run(
        `INSERT INTO ai_diagnostic_usage (church_id, month, usage_count, limit_hits)
         VALUES (?, ?, 0, 1)
         ON CONFLICT(church_id, month) DO UPDATE SET limit_hits = limit_hits + 1`,
        [churchId, month]
      );
    } catch (e) {
      console.error('[AiRateLimiter] Failed to log limit hit:', e.message);
    }
  }
}

module.exports = { AiRateLimiter };
