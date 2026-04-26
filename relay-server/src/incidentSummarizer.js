/**
 * Incident Summarizer — Proactive plain-English summaries for state machine events.
 *
 * Generates AI or template summaries on every failover state transition and
 * routes them to the appropriate notification tier:
 *   Critical: Telegram push + portal chat + timeline
 *   Warning:  Portal chat + timeline
 *   Info:     Timeline log only
 *   Recovery: Portal chat + timeline
 *
 * ASYNC CONTRACT: All summary generation is fire-and-forget.
 * This module NEVER blocks the incident response pipeline.
 */

const TIERS = {
  CRITICAL: 'critical',
  WARNING: 'warning',
  INFO: 'info',
  RECOVERY: 'recovery',
};

const { createQueryClient } = require('./db');

const SQLITE_FALLBACK_CONFIG = {
  driver: 'sqlite',
  isSqlite: true,
  isPostgres: false,
  databaseUrl: '',
};

const SONNET_MODEL = 'claude-sonnet-4-6';
const AI_TIMEOUT_MS = 8000;  // Strict: 8s max (not the 25s diagnostic timeout)
const MAX_SUMMARY_TOKENS = 200;
const NARRATIVE_TIMEOUT_MS = 15000;
const MAX_NARRATIVE_TOKENS = 400;

// ─── Template fallback messages (used when AI unavailable or for Info tier) ──

const TEMPLATES = {
  'HEALTHY→SUSPECTED_BLACK': (name, _trigger) =>
    `Possible stream issue detected at ${name}. Monitoring encoder bitrate to confirm.`,
  'HEALTHY→ATEM_LOST': (name) =>
    `ATEM connection lost at ${name}. Encoder still streaming — check booth network.`,
  'SUSPECTED_BLACK→CONFIRMED_OUTAGE': (name) =>
    `Stream outage confirmed at ${name}. Auto-failover will engage unless acknowledged within 30 seconds.`,
  'ATEM_LOST→CONFIRMED_OUTAGE': (name) =>
    `Stream outage confirmed at ${name}. Both ATEM and encoder signals lost.`,
  'HEALTHY→CONFIRMED_OUTAGE': (name) =>
    `Stream outage confirmed at ${name} — simultaneous loss of ATEM and encoder.`,
  'CONFIRMED_OUTAGE→FAILOVER_ACTIVE': (name) =>
    `Automatic failover executed at ${name}. Stream switched to backup source.`,
  'SUSPECTED_BLACK→HEALTHY': (name) =>
    `False alarm at ${name} — encoder recovered within confirmation window.`,
  'ATEM_LOST→HEALTHY': (name) =>
    `ATEM connection restored at ${name}. Network issue resolved.`,
  'FAILOVER_ACTIVE→HEALTHY': (name) =>
    `Recovery complete at ${name}. Stream back on primary source.`,
  'CONFIRMED_OUTAGE→HEALTHY': (name) =>
    `Outage resolved at ${name}. Stream recovered.`,
};


class IncidentSummarizer {
  /**
   * @param {object} opts
   * @param {object} opts.db — better-sqlite3 handle
   * @param {Map} opts.churches — live church map
   * @param {object} opts.chatEngine — ChatEngine instance
   * @param {object} opts.alertEngine — AlertEngine instance (for sendTelegramMessage)
   * @param {object} opts.weeklyDigest — WeeklyDigest instance (for addEvent / timeline)
   * @param {object} opts.sessionRecap — SessionRecap instance
   * @param {object} opts.signalFailover — SignalFailover instance
   */
  constructor({ db, churches, chatEngine, alertEngine, weeklyDigest, sessionRecap, signalFailover }) {
    this.db = db && typeof db.prepare === 'function' ? db : null;
    this.client = this._resolveClient(db);
    this.churches = churches;
    this.chatEngine = chatEngine;
    this.alertEngine = alertEngine;
    this.weeklyDigest = weeklyDigest;
    this.sessionRecap = sessionRecap;
    this.signalFailover = signalFailover;
    this._logAiUsage = null;

    if (this.db) {
      this._ensureTablesSync();
      this.ready = Promise.resolve();
    } else {
      this.ready = this._init();
    }
  }

  /** Wire in the AI usage logger from server.js */
  setAiUsageLogger(fn) { this._logAiUsage = fn; }

  // ─── Schema ──────────────────────────────────────────────────────────────────

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
    if (!this.client) throw new Error('[IncidentSummarizer] Database client is not configured.');
    return this.client;
  }

  async _init() {
    await this._ensureTables();
  }

  _incidentSummariesTableSql() {
    if (this.client?.driver === 'postgres') {
      return `
        CREATE TABLE IF NOT EXISTS incident_summaries (
          id BIGSERIAL PRIMARY KEY,
          church_id TEXT NOT NULL,
          session_id TEXT,
          created_at TEXT NOT NULL,
          tier TEXT NOT NULL,
          trigger_transition TEXT,
          trigger_reason TEXT,
          summary TEXT NOT NULL,
          model_used TEXT,
          latency_ms INTEGER,
          delivered_to TEXT
        )
      `;
    }

    return `
      CREATE TABLE IF NOT EXISTS incident_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        church_id TEXT NOT NULL,
        session_id TEXT,
        created_at TEXT NOT NULL,
        tier TEXT NOT NULL,
        trigger_transition TEXT,
        trigger_reason TEXT,
        summary TEXT NOT NULL,
        model_used TEXT,
        latency_ms INTEGER,
        delivered_to TEXT
      )
    `;
  }

  _ensureTablesSync() {
    this.db.exec(this._incidentSummariesTableSql());

    // Add summary_tiers column to churches if missing
    try {
      this.db.prepare('SELECT summary_tiers FROM churches LIMIT 1').get();
    } catch {
      try { this.db.exec("ALTER TABLE churches ADD COLUMN summary_tiers TEXT DEFAULT '{}'"); } catch (err) { /* already exists */ console.debug("[incidentSummarizer] intentional swallow:", err); }
    }
  }

  async _ensureTables() {
    const client = this._requireClient();
    await client.exec(this._incidentSummariesTableSql());

    try {
      await client.queryOne('SELECT summary_tiers FROM churches LIMIT 1');
    } catch {
      try {
        await client.exec("ALTER TABLE churches ADD COLUMN summary_tiers TEXT DEFAULT '{}'");
      } catch (err) { /* already exists */ console.debug("[incidentSummarizer] intentional swallow:", err); }
    }
  }

  // ─── Tier Classification ─────────────────────────────────────────────────────

  /**
   * Map a state transition to a notification tier.
   * @param {string} from — previous state
   * @param {string} to — new state
   * @returns {string} tier constant
   */
  _classifyTransition(from, to) {
    // Self-transitions are always info (no actual state change)
    if (from === to) return TIERS.INFO;
    if (to === 'CONFIRMED_OUTAGE') return TIERS.CRITICAL;
    if (to === 'FAILOVER_ACTIVE') return TIERS.CRITICAL;
    if (to === 'ATEM_LOST') return TIERS.WARNING;
    if (to === 'HEALTHY' && from !== 'HEALTHY') return TIERS.RECOVERY;
    return TIERS.INFO;
  }

  // ─── Model Selection ─────────────────────────────────────────────────────────

  /**
   * Select which AI model to use (or 'none' for template-only).
   * @param {string} tier
   * @returns {'sonnet'|'none'}
   */
  _selectModel(tier) {
    switch (tier) {
      case TIERS.CRITICAL:  return 'sonnet';
      case TIERS.WARNING:   return 'sonnet';
      case TIERS.RECOVERY:  return 'sonnet';
      case TIERS.INFO:      return 'none';
      default:              return 'none';
    }
  }

  // ─── Per-Church Notification Config ──────────────────────────────────────────

  static TIER_DEFAULTS = {
    critical: { telegram: true, chat: true, timeline: true },
    warning:  { telegram: false, chat: true, timeline: true },
    info:     { telegram: false, chat: false, timeline: true },
    recovery: { telegram: false, chat: true, timeline: true },
  };

  _getChurchTierConfig(churchId) {
    if (!this.db) {
      return this._getChurchTierConfigAsync(churchId);
    }

    try {
      const row = this.db.prepare('SELECT summary_tiers FROM churches WHERE churchId = ?').get(churchId);
      if (!row?.summary_tiers || row.summary_tiers === '{}') return { ...IncidentSummarizer.TIER_DEFAULTS };
      const parsed = JSON.parse(row.summary_tiers);
      // Merge with defaults so missing tiers get defaults
      return {
        ...IncidentSummarizer.TIER_DEFAULTS,
        ...Object.fromEntries(
          Object.entries(parsed).map(([k, v]) => [k, { ...IncidentSummarizer.TIER_DEFAULTS[k], ...v }])
        ),
      };
    } catch {
      return { ...IncidentSummarizer.TIER_DEFAULTS };
    }
  }

  async _getChurchTierConfigAsync(churchId) {
    try {
      const row = await this._requireClient().queryOne('SELECT summary_tiers FROM churches WHERE churchId = ?', [churchId]);
      if (!row?.summary_tiers || row.summary_tiers === '{}') return { ...IncidentSummarizer.TIER_DEFAULTS };
      const parsed = JSON.parse(row.summary_tiers);
      return {
        ...IncidentSummarizer.TIER_DEFAULTS,
        ...Object.fromEntries(
          Object.entries(parsed).map(([k, v]) => [k, { ...IncidentSummarizer.TIER_DEFAULTS[k], ...v }])
        ),
      };
    } catch {
      return { ...IncidentSummarizer.TIER_DEFAULTS };
    }
  }

  // ─── Main Transition Handler (fire-and-forget entry point) ───────────────────

  /**
   * Handle a failover state transition. ALWAYS fire-and-forget.
   * Registered via signalFailover.onTransition().
   */
  async handleTransition(churchId, from, to, trigger, stateSnapshot) {
    try {
      const tier = this._classifyTransition(from, to);
      const tierConfig = await Promise.resolve(this._getChurchTierConfig(churchId));
      const destinations = tierConfig[tier] || { timeline: true };

      const church = this.churches.get(churchId);
      const churchName = church?.name || churchId;
      const sessionId = this.sessionRecap?.getActiveSessionId(churchId) || null;

      // Pick model based on tier
      const model = this._selectModel(tier);
      let summary;
      let modelUsed;
      let latencyMs = 0;

      if (model === 'none') {
        summary = this._templateSummary(from, to, trigger, churchName, stateSnapshot);
        modelUsed = 'template';
      } else {
        const startMs = Date.now();
        try {
          summary = await this._generateAISummary(churchId, from, to, trigger, stateSnapshot, churchName);
          latencyMs = Date.now() - startMs;
          modelUsed = 'sonnet';
        } catch (err) {
          console.error(`[IncidentSummarizer] AI summary failed, using template:`, err.message);
          summary = this._templateSummary(from, to, trigger, churchName, stateSnapshot);
          modelUsed = 'template';
          latencyMs = Date.now() - startMs;
          // Log template fallback event for tracking
          if (this._aiRateLimiter) {
            this._aiRateLimiter.logEvent(churchId, 'incident_summary', 'template_fallback', err.message);
          }
        }
      }

      // Track which channels we delivered to
      const deliveredTo = [];

      // Route to destinations
      if (destinations.timeline) {
        this._writeToTimeline(churchId, tier, from, to, summary, sessionId);
        deliveredTo.push('timeline');
      }
      if (destinations.chat) {
        this._postToChat(churchId, summary);
        deliveredTo.push('chat');
      }
      if (destinations.telegram) {
        await this._sendTelegramPush(churchId, summary, tier);
        deliveredTo.push('telegram');
      }

      // Persist the summary
      await this._persistSummary(churchId, sessionId, tier, `${from}→${to}`, trigger, summary, modelUsed, latencyMs, deliveredTo);

    } catch (err) {
      // Absolute outer catch — this function must NEVER throw
      console.error(`[IncidentSummarizer] handleTransition error for ${churchId}:`, err.message);
    }
  }

  // ─── AI Summary Generation ───────────────────────────────────────────────────

  async _generateAISummary(churchId, from, to, trigger, stateSnapshot, churchName) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('No ANTHROPIC_API_KEY');

    // Build lean context (NOT the full diagnostic context)
    const context = this._buildSummaryContext(churchId, stateSnapshot);

    const { buildBackgroundPrompt } = require('./tally-engineer');
    const systemContent = buildBackgroundPrompt('incident_summary');

    const prompt = `${systemContent}

Church: ${churchName}
State transition: ${from} → ${to}
Trigger: ${trigger.replace(/_/g, ' ')}
${context}

Write the summary now:`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: SONNET_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: MAX_SUMMARY_TOKENS,
      }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`API ${resp.status}: ${errBody.slice(0, 100)}`);
    }

    const data = await resp.json();
    const text = data?.content?.[0]?.text;
    if (!text) throw new Error('Empty AI response');

    // Log AI usage for cost tracking
    if (this._logAiUsage && data.usage) {
      this._logAiUsage({
        churchId,
        feature: 'incident_summary',
        model: SONNET_MODEL,
        inputTokens: data.usage.input_tokens || 0,
        outputTokens: data.usage.output_tokens || 0,
        latencyMs: null, // logged by caller
        intent: 'summary',
      });
    }

    return text.trim();
  }

  /**
   * Build lean context for AI summary — device status + recent state log.
   * Intentionally NOT using buildDiagnosticContext (too heavy for a summary).
   */
  _buildSummaryContext(churchId, stateSnapshot) {
    const parts = [];

    // Device status snapshot from the live church object
    const church = this.churches.get(churchId);
    if (church?.status) {
      const s = church.status;
      const devices = [];
      if (s.obs) devices.push(`OBS: ${s.obs.connected ? 'connected' : 'disconnected'}${s.obs.streaming ? ', streaming' : ''}`);
      if (s.atem !== undefined) {
        const atemConnected = typeof s.atem === 'object' ? s.atem.connected : !!s.atem;
        devices.push(`ATEM: ${atemConnected ? 'connected' : 'disconnected'}`);
      }
      if (s.encoder) devices.push(`Encoder: ${s.encoder.bitrateKbps || 0} kbps`);
      if (devices.length) parts.push(`Current devices: ${devices.join('; ')}`);
    }

    // Outage duration
    if (stateSnapshot?.outageStartedAt) {
      const elapsed = Math.round((Date.now() - stateSnapshot.outageStartedAt) / 1000);
      parts.push(`Outage duration: ${elapsed}s`);
    }

    // Recent state transitions
    if (stateSnapshot?.stateLog?.length) {
      const recent = stateSnapshot.stateLog.slice(-5).map(e =>
        `${e.from}→${e.to} (${e.trigger})`
      ).join(', ');
      parts.push(`Recent transitions: ${recent}`);
    }

    return parts.length ? parts.join('\n') : '';
  }

  // ─── Template Fallbacks ──────────────────────────────────────────────────────

  _templateSummary(from, to, trigger, churchName, stateSnapshot) {
    const key = `${from}→${to}`;
    const templateFn = TEMPLATES[key];
    if (templateFn) return templateFn(churchName, trigger);

    // Generic fallback for any unmatched transition
    const elapsed = stateSnapshot?.outageStartedAt
      ? Math.round((Date.now() - stateSnapshot.outageStartedAt) / 1000)
      : null;
    const durationStr = elapsed ? ` (${elapsed}s into incident)` : '';
    return `${churchName}: State changed from ${from.replace(/_/g, ' ')} to ${to.replace(/_/g, ' ')}${durationStr}. Trigger: ${trigger.replace(/_/g, ' ')}.`;
  }

  // ─── Delivery Channels ──────────────────────────────────────────────────────

  _writeToTimeline(churchId, tier, from, to, summary, sessionId) {
    try {
      Promise.resolve(this.weeklyDigest.addEvent(
        churchId,
        `incident_summary_${tier}`,
        `[${from}→${to}] ${summary}`,
        sessionId
      )).catch((e) => {
        console.error(`[IncidentSummarizer] Timeline write error:`, e.message);
      });
    } catch (e) {
      console.error(`[IncidentSummarizer] Timeline write error:`, e.message);
    }
  }

  _postToChat(churchId, summary) {
    try {
      Promise.resolve(this.chatEngine.saveMessage({
        churchId,
        senderName: 'Tally',
        senderRole: 'system',
        source: 'system',
        message: summary,
      })).then((saved) => {
        this.chatEngine.broadcastChat(saved);
      }).catch((e) => {
        console.error(`[IncidentSummarizer] Chat post error:`, e.message);
      });
    } catch (e) {
      console.error(`[IncidentSummarizer] Chat post error:`, e.message);
    }
  }

  async _sendTelegramPush(churchId, summary, tier) {
    try {
      const church = await this._getChurchRow(churchId);
      if (!church) return;

      const botToken = church.alert_bot_token || process.env.ALERT_BOT_TOKEN;
      const tdChatId = church.td_telegram_chat_id;
      if (!botToken || !tdChatId) return;

      const icon = tier === TIERS.CRITICAL ? '🔴' : tier === TIERS.RECOVERY ? '✅' : '⚠️';
      const msg = `${icon} *Tally Summary*\n${summary}`;
      await this.alertEngine.sendTelegramMessage(tdChatId, botToken, msg);
    } catch (e) {
      console.error(`[IncidentSummarizer] Telegram push error:`, e.message);
    }
  }

  // ─── Persistence ─────────────────────────────────────────────────────────────

  async _getChurchRow(churchId) {
    if (this.db) {
      return this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId);
    }
    return this._requireClient().queryOne('SELECT * FROM churches WHERE churchId = ?', [churchId]);
  }

  async _persistSummary(churchId, sessionId, tier, transition, trigger, summary, modelUsed, latencyMs, deliveredTo) {
    try {
      if (this.db) {
        this.db.prepare(`
        INSERT INTO incident_summaries (church_id, session_id, created_at, tier, trigger_transition, trigger_reason, summary, model_used, latency_ms, delivered_to)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
          churchId, sessionId, new Date().toISOString(),
          tier, transition, trigger, summary,
          modelUsed, latencyMs, JSON.stringify(deliveredTo)
        );
      } else {
        await this._requireClient().run(`
          INSERT INTO incident_summaries (church_id, session_id, created_at, tier, trigger_transition, trigger_reason, summary, model_used, latency_ms, delivered_to)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          churchId,
          sessionId,
          new Date().toISOString(),
          tier,
          transition,
          trigger,
          summary,
          modelUsed,
          latencyMs,
          JSON.stringify(deliveredTo),
        ]);
      }
    } catch (e) {
      console.error(`[IncidentSummarizer] Persist error:`, e.message);
    }
  }

  // ─── Post-Service Narrative ──────────────────────────────────────────────────

  /**
   * Generate a post-service narrative. Called from scheduleEngine window close.
   * Uses Sonnet with session context. Returns null for clean sessions.
   *
   * @param {string} churchId
   * @param {object} sessionData — from sessionRecap.endSession()
   * @returns {Promise<string|null>}
   */
  async generatePostServiceNarrative(churchId, sessionData) {
    try {
      if (!sessionData) return null;

      // Skip clean sessions — no narrative needed
      const alertCount = (sessionData.alertCount || 0) + (sessionData.autoRecovered || 0);
      if (alertCount === 0) return null;

      const church = await this._getChurchRow(churchId);
      const churchName = church?.name || churchId;
      const sessionId = sessionData.sessionId || sessionData.id;

      // Get all incident summaries for this session
      const summaries = await this._getSessionSummaries(churchId, sessionId);

      // Try AI narrative
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        if (this._aiRateLimiter) this._aiRateLimiter.logEvent(churchId, 'incident_summary', 'template_fallback', 'no_api_key');
        return this._templatePostServiceNarrative(churchName, sessionData, summaries);
      }

      const prompt = `You are Tally, an AI livestream monitoring system for churches. Write a brief post-service incident narrative (3-5 sentences) summarizing what happened during this church service. Focus on: what went wrong, how it was handled (auto-recovery vs manual intervention), and the outcome. Plain English, no jargon, no markdown formatting.

Church: ${churchName}
Session duration: ${sessionData.durationMinutes || '?'} minutes
Grade: ${sessionData.grade || 'N/A'}
Alerts: ${sessionData.alertCount || 0} total (${sessionData.autoRecovered || 0} auto-recovered, ${sessionData.escalated || 0} escalated)

${summaries.length ? `Incident summaries during service:\n${summaries.map(s => `  [${s.tier}] ${s.summary}`).join('\n')}` : 'No incident summaries generated.'}

Write the post-service narrative:`;

      const startMs = Date.now();
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: SONNET_MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: MAX_NARRATIVE_TOKENS,
        }),
        signal: AbortSignal.timeout(NARRATIVE_TIMEOUT_MS),
      });

      const latencyMs = Date.now() - startMs;

      if (!resp.ok) {
        if (this._aiRateLimiter) this._aiRateLimiter.logEvent(churchId, 'incident_summary', 'template_fallback', `api_error_${resp.status}`);
        return this._templatePostServiceNarrative(churchName, sessionData, summaries);
      }

      const data = await resp.json();
      const narrative = data?.content?.[0]?.text?.trim();
      if (!narrative) {
        if (this._aiRateLimiter) this._aiRateLimiter.logEvent(churchId, 'incident_summary', 'template_fallback', 'empty_response');
        return this._templatePostServiceNarrative(churchName, sessionData, summaries);
      }

      // Log AI usage
      if (this._logAiUsage && data.usage) {
        this._logAiUsage({
          churchId,
          feature: 'post_service_narrative',
          model: SONNET_MODEL,
          inputTokens: data.usage.input_tokens || 0,
          outputTokens: data.usage.output_tokens || 0,
          latencyMs,
          intent: 'summary',
        });
      }

      // Persist
      await this._persistSummary(churchId, sessionId, 'post_service', 'session_end', 'session_ended',
        narrative, 'sonnet', latencyMs, ['timeline', 'chat']);

      return narrative;
    } catch (err) {
      console.error(`[IncidentSummarizer] Post-service narrative error for ${churchId}:`, err.message);
      return null;
    }
  }

  async _getSessionSummaries(churchId, sessionId) {
    try {
      if (!sessionId) return [];
      if (this.db) {
        return this.db.prepare(
          'SELECT tier, summary, model_used, created_at FROM incident_summaries WHERE church_id = ? AND session_id = ? ORDER BY created_at ASC'
        ).all(churchId, sessionId);
      }
      return this._requireClient().query(
        'SELECT tier, summary, model_used, created_at FROM incident_summaries WHERE church_id = ? AND session_id = ? ORDER BY created_at ASC',
        [churchId, sessionId]
      );
    } catch {
      return [];
    }
  }

  _templatePostServiceNarrative(churchName, sessionData, summaries) {
    const alertCount = sessionData.alertCount || 0;
    const autoRecovered = sessionData.autoRecovered || 0;
    const escalated = sessionData.escalated || 0;
    const grade = sessionData.grade || 'N/A';
    const duration = sessionData.durationMinutes || '?';

    let narrative = `Service at ${churchName} ran for ${duration} minutes with a grade of ${grade}. `;
    narrative += `There were ${alertCount} alert(s) during the service`;
    if (autoRecovered > 0) narrative += ` — ${autoRecovered} resolved automatically`;
    if (escalated > 0) narrative += ` and ${escalated} required manual intervention`;
    narrative += '.';

    if (summaries.length > 0) {
      const criticals = summaries.filter(s => s.tier === 'critical');
      if (criticals.length > 0) {
        narrative += ` Key incidents: ${criticals.map(s => s.summary).join(' ')}`;
      }
    }

    return narrative;
  }
}


module.exports = { IncidentSummarizer, TIERS, TEMPLATES };
