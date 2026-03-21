/**
 * Session Recap — Tracks service sessions and sends post-service recap
 * to the TD and Andrew after every service window closes.
 */

const { v4: uuidv4 } = require('uuid');

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

class SessionRecap {
  /**
   * @param {import('better-sqlite3').Database} db
   */
  constructor(db) {
    this.db = db;
    this.activeSessions = new Map(); // churchId → session object
    this._botToken = null;
    this._andrewChatId = null;
    this._ensureTable();
  }

  /**
   * Configure Telegram notification credentials.
   * Call this after construction (e.g. from server.js).
   */
  setNotificationConfig(botToken, andrewChatId) {
    this._botToken = botToken;
    this._andrewChatId = andrewChatId;
  }

  /** Attach lifecycle emails engine for first-service email */
  setLifecycleEmails(engine) {
    this.lifecycleEmails = engine;
  }

  /** Attach post-service report generator */
  setPostServiceReport(engine) {
    this.postServiceReport = engine;
  }

  _ensureTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS service_sessions (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        duration_minutes INTEGER,
        stream_ran INTEGER DEFAULT 0,
        stream_runtime_minutes INTEGER DEFAULT 0,
        recording_confirmed INTEGER DEFAULT 0,
        alert_count INTEGER DEFAULT 0,
        auto_recovered_count INTEGER DEFAULT 0,
        escalated_count INTEGER DEFAULT 0,
        audio_silence_count INTEGER DEFAULT 0,
        peak_viewers INTEGER,
        td_name TEXT,
        grade TEXT,
        notes TEXT
      )
    `);
  }

  /**
   * Get the active session ID for a church (used by alertEngine and weeklyDigest for timeline linking).
   * @param {string} churchId
   * @returns {string|null} The session ID or null if no active session
   */
  getActiveSessionId(churchId) {
    const session = this.activeSessions.get(churchId);
    return session?.sessionId || null;
  }

  /**
   * Recover sessions that were active when the server last shut down.
   * Called once during startup. Re-hydrates the in-memory activeSessions map
   * from DB rows with no `ended_at`.
   */
  recoverActiveSessions() {
    try {
      const rows = this.db.prepare(
        'SELECT * FROM service_sessions WHERE ended_at IS NULL'
      ).all();
      for (const row of rows) {
        // Only recover sessions started within the last 6 hours (stale ones are abandoned)
        const startedAt = new Date(row.started_at);
        if (Date.now() - startedAt.getTime() > 6 * 60 * 60 * 1000) {
          // Mark stale session as ended
          this.db.prepare('UPDATE service_sessions SET ended_at = ?, grade = ? WHERE id = ?')
            .run(new Date().toISOString(), '⚠️ Interrupted (server restart)', row.id);
          console.log(`[SessionRecap] Marked stale session ${row.id} as interrupted`);
          continue;
        }
        this.activeSessions.set(row.church_id, {
          sessionId: row.id,
          churchId: row.church_id,
          startedAt,
          tdName: row.td_name,
          alertTypes: {},
          alertCount: row.alert_count || 0,
          autoRecovered: row.auto_recovered_count || 0,
          escalated: row.escalated_count || 0,
          audioSilenceCount: row.audio_silence_count || 0,
          peakViewers: row.peak_viewers || null,
          streamStartedAt: row.stream_ran ? new Date() : null,
          streamTotalMinutes: row.stream_runtime_minutes || 0,
          streaming: !!row.stream_ran,
          recordingConfirmed: !!row.recording_confirmed,
        });
        console.log(`[SessionRecap] Recovered active session for ${row.church_id} (started ${startedAt.toISOString()})`);
      }
      if (rows.length) console.log(`[SessionRecap] Recovered ${this.activeSessions.size} active session(s)`);
    } catch (e) {
      console.error('[SessionRecap] Session recovery error:', e.message);
    }
  }

  // ─── SESSION LIFECYCLE ───────────────────────────────────────────────────────

  /**
   * Start a new session for a church.
   * Called by scheduleEngine onWindowOpen callback.
   * @param {string} churchId
   * @param {string|null} tdName  Name of the on-call TD
   */
  startSession(churchId, tdName) {
    if (this.activeSessions.has(churchId)) {
      console.warn(`[SessionRecap] Session already active for ${churchId} — ending it first`);
      this.endSession(churchId).catch(e => console.error('[SessionRecap] endSession on start error:', e.message));
    }

    const sessionId = uuidv4();
    const startedAt = new Date();

    this.db.prepare(
      'INSERT INTO service_sessions (id, church_id, started_at, td_name) VALUES (?, ?, ?, ?)'
    ).run(sessionId, churchId, startedAt.toISOString(), tdName || null);

    this.activeSessions.set(churchId, {
      sessionId,
      churchId,
      startedAt,
      tdName: tdName || null,
      alertTypes: {},         // alertType → count
      alertCount: 0,
      autoRecovered: 0,
      escalated: 0,
      audioSilenceCount: 0,
      peakViewers: null,
      streamStartedAt: null,  // Date when current streaming segment started
      streamTotalMinutes: 0,  // Accumulated runtime
      streaming: false,
      recordingConfirmed: false,
    });

    console.log(`[SessionRecap] Session started — church ${churchId} (TD: ${tdName || 'unknown'})`);
  }

  /**
   * Finalize a session: compute grade, persist stats, send recap.
   * Called by scheduleEngine onWindowClose callback.
   * @param {string} churchId
   * @returns {Promise<object|null>}
   */
  async endSession(churchId) {
    const session = this.activeSessions.get(churchId);
    if (!session) {
      console.warn(`[SessionRecap] No active session for church ${churchId}`);
      return null;
    }

    this.activeSessions.delete(churchId);

    const endedAt = new Date();
    const durationMinutes = Math.round((endedAt - session.startedAt) / 60000);

    // Finalize stream runtime if still streaming at window close
    if (session.streaming && session.streamStartedAt) {
      const runtimeMs = endedAt - session.streamStartedAt;
      session.streamTotalMinutes += Math.round(runtimeMs / 60000);
    }

    const grade = this.gradeSession(session);

    this.db.prepare(`
      UPDATE service_sessions SET
        ended_at = ?,
        duration_minutes = ?,
        stream_runtime_minutes = ?,
        grade = ?
      WHERE id = ?
    `).run(endedAt.toISOString(), durationMinutes, session.streamTotalMinutes, grade, session.sessionId);

    const finalSession = { ...session, durationMinutes, endedAt, grade };

    // Send recap via Telegram
    let church = null;
    try {
      church = this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId);
      if (church) {
        await this._sendRecap(church, finalSession);
      }
    } catch (e) {
      console.error(`[SessionRecap] Failed to send recap for ${churchId}:`, e.message);
    }

    // Send recap email to leadership recipients
    try {
      if (this.lifecycleEmails && church && church.leadership_emails) {
        const emails = church.leadership_emails.split(',').map(e => e.trim()).filter(e => e && e.includes('@'));
        for (const email of emails) {
          this.lifecycleEmails.sendSessionRecapEmail(church, finalSession, email).catch(err => {
            console.error(`[SessionRecap] Leadership email error for ${email}:`, err.message);
          });
        }
      }
    } catch (e) {
      console.error(`[SessionRecap] Leadership email error for ${churchId}:`, e.message);
    }

    // Send first-service email if this is the first completed session
    try {
      if (this.lifecycleEmails && church) {
        const sessionCount = this.db.prepare('SELECT COUNT(*) as cnt FROM service_sessions WHERE church_id = ? AND ended_at IS NOT NULL').get(churchId);
        if (sessionCount?.cnt === 1) {
          this.lifecycleEmails.sendFirstServiceCompleted(church, finalSession).catch(e => console.error('[SessionRecap] First service email failed:', e.message));
        }
      }
    } catch (e) {
      console.error(`[SessionRecap] First-service email error for ${churchId}:`, e.message);
    }

    // Generate post-service AI report (non-blocking)
    try {
      if (this.postServiceReport && church) {
        this.postServiceReport.generate(church, finalSession).catch(e =>
          console.error(`[SessionRecap] Post-service report error for ${churchId}:`, e.message)
        );
      }
    } catch (e) {
      console.error(`[SessionRecap] Post-service report error for ${churchId}:`, e.message);
    }

    // Write post-service memories (non-blocking, don't fail the session)
    try {
      if (this.churchMemory) {
        this.churchMemory.writePostServiceMemories(churchId, finalSession);
      }
    } catch (e) {
      console.error(`[SessionRecap] Memory write error for ${churchId}:`, e.message);
    }

    console.log(`[SessionRecap] Session ended — church ${churchId} (${durationMinutes} min, grade: ${grade})`);
    return finalSession;
  }

  // ─── EVENT RECORDING ─────────────────────────────────────────────────────────

  /**
   * Record an alert for the active session.
   * Called from server.js alert handling block (after auto-recovery determination).
   * @param {string} churchId
   * @param {string} alertType
   * @param {boolean} autoRecovered  Was this auto-fixed?
   * @param {boolean} escalated      Was this escalated to Andrew?
   */
  recordAlert(churchId, alertType, autoRecovered = false, escalated = false) {
    const session = this.activeSessions.get(churchId);
    if (!session) return;

    session.alertCount++;
    session.alertTypes[alertType] = (session.alertTypes[alertType] || 0) + 1;
    if (autoRecovered) session.autoRecovered++;
    if (escalated) session.escalated++;

    this.db.prepare(`
      UPDATE service_sessions SET
        alert_count = ?,
        auto_recovered_count = ?,
        escalated_count = ?
      WHERE id = ?
    `).run(session.alertCount, session.autoRecovered, session.escalated, session.sessionId);
  }

  /**
   * Record an audio silence detection.
   * @param {string} churchId
   */
  recordAudioSilence(churchId) {
    const session = this.activeSessions.get(churchId);
    if (!session) return;

    session.audioSilenceCount++;
    this.db.prepare('UPDATE service_sessions SET audio_silence_count = ? WHERE id = ?')
      .run(session.audioSilenceCount, session.sessionId);
  }

  /**
   * Record stream state change (start / stop).
   * Called on status_update from church client.
   * @param {string} churchId
   * @param {boolean} streaming
   */
  recordStreamStatus(churchId, streaming) {
    const session = this.activeSessions.get(churchId);
    if (!session) return;

    const wasStreaming = session.streaming;
    session.streaming = streaming;

    if (streaming && !wasStreaming) {
      // Stream started
      session.streamStartedAt = new Date();
      this.db.prepare('UPDATE service_sessions SET stream_ran = 1 WHERE id = ?').run(session.sessionId);
    } else if (!streaming && wasStreaming && session.streamStartedAt) {
      // Stream stopped — accumulate runtime
      const runtimeMs = Date.now() - session.streamStartedAt.getTime();
      session.streamTotalMinutes += Math.round(runtimeMs / 60000);
      session.streamStartedAt = null;
      this.db.prepare('UPDATE service_sessions SET stream_runtime_minutes = ? WHERE id = ?')
        .run(session.streamTotalMinutes, session.sessionId);
    }
  }

  /**
   * Update peak viewer count (keeps highest value seen).
   * @param {string} churchId
   * @param {number} count
   */
  recordPeakViewers(churchId, count) {
    const session = this.activeSessions.get(churchId);
    if (!session || typeof count !== 'number') return;

    if (session.peakViewers === null || count > session.peakViewers) {
      session.peakViewers = count;
      this.db.prepare('UPDATE service_sessions SET peak_viewers = ? WHERE id = ?')
        .run(count, session.sessionId);
    }
  }

  /**
   * Mark recording as confirmed for this session.
   * @param {string} churchId
   */
  recordRecordingConfirmed(churchId) {
    const session = this.activeSessions.get(churchId);
    if (!session || session.recordingConfirmed) return;

    session.recordingConfirmed = true;
    this.db.prepare('UPDATE service_sessions SET recording_confirmed = 1 WHERE id = ?')
      .run(session.sessionId);
  }

  // ─── GRADING ─────────────────────────────────────────────────────────────────

  /**
   * Compute session grade.
   * @param {object} session
   * @returns {'🟢 Clean'|'🟡 Minor issues (auto-resolved)'|'🔴 Required intervention'}
   */
  gradeSession(session) {
    if (session.escalated > 0) return '🔴 Required intervention';
    // Any unresolved (non-auto-recovered) alerts
    const unresolved = session.alertCount - session.autoRecovered;
    if (unresolved > 0) return '🔴 Required intervention';
    if (session.alertCount > 0 || session.audioSilenceCount > 0) return '🟡 Minor issues (auto-resolved)';
    return '🟢 Clean';
  }

  // ─── FORMATTING ──────────────────────────────────────────────────────────────

  /**
   * Build the recap message string.
   * @param {object} church  DB row
   * @param {object} session  Finalized session object
   * @returns {string}
   */
  formatRecap(church, session) {
    const startDate = session.startedAt instanceof Date ? session.startedAt : new Date(session.startedAt);
    const dayName = DAYS[startDate.getDay()];
    const timeStr = startDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

    const hours = Math.floor(session.durationMinutes / 60);
    const mins = session.durationMinutes % 60;
    const durationStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

    // Check if church has streaming configured (stream key or encoder config)
    const hasStreamConfig = !!(church.stream_key || church.encoder_ip || church.rtmp_url || church.stream_platform);
    let streamLine;
    if (session.streamTotalMinutes > 0) {
      streamLine = `✅ Ran ${session.streamTotalMinutes} min`;
    } else if (!hasStreamConfig) {
      streamLine = 'Not configured';
    } else {
      streamLine = '❌ Did not stream';
    }

    const recordingLine = session.recordingConfirmed ? '✅ Confirmed' : '⚠️ Not confirmed';

    const alertLine = session.alertCount === 0
      ? '✅ None'
      : `${session.alertCount} (${session.autoRecovered} auto-resolved, ${session.escalated} escalated)`;

    const audioLine = session.audioSilenceCount === 0
      ? '✅ Clean'
      : `⚠️ ${session.audioSilenceCount} silence event${session.audioSilenceCount !== 1 ? 's' : ''} detected`;

    let viewersLine = 'N/A';
    if (session.peakViewers !== null && session.peakViewers !== undefined) {
      viewersLine = `📊 Peak ${session.peakViewers}`;
      // Add platform breakdown if viewer_snapshots are available
      try {
        const snap = this.db.prepare(`
          SELECT MAX(youtube) AS yt, MAX(facebook) AS fb, MAX(vimeo) AS vim
          FROM viewer_snapshots
          WHERE session_id = ?
        `).get(session.sessionId);
        if (snap) {
          const parts = [];
          if (snap.yt != null) parts.push(`YT: ${snap.yt}`);
          if (snap.fb != null) parts.push(`FB: ${snap.fb}`);
          if (snap.vim != null) parts.push(`Vim: ${snap.vim}`);
          if (parts.length) viewersLine += ` (${parts.join(', ')})`;
        }
      } catch { /* viewer_snapshots table may not exist */ }
    }

    const tdLine = session.tdName ? `TD: ${session.tdName}` : null;

    const grade = session.grade || this.gradeSession(session);

    const lines = [
      `📋 *Tally Engineer — Service Recap*`,
      `*${church.name}*`,
      `${dayName} ${timeStr} · ${durationStr}`,
      '',
      `Stream: ${streamLine}`,
      `Recording: ${recordingLine}`,
      `Alerts: ${alertLine}`,
      `Audio: ${audioLine}`,
      `Viewers: ${viewersLine}`,
      tdLine,
      `Grade: ${grade}`,
    ].filter(l => l !== null && l !== undefined);

    // ── Incident Timeline ──────────────────────────────────────────────────
    const timeline = this._buildTimeline(session);
    if (timeline.length > 0) {
      lines.push('');
      lines.push('*Timeline:*');
      for (const entry of timeline) {
        lines.push(entry);
      }
    }

    // ── Summary notes ──────────────────────────────────────────────────────
    if (session.alertCount === 0 && session.audioSilenceCount === 0) {
      lines.push('');
      lines.push('Smooth service — no issues detected. 🎉');
    } else {
      lines.push('');
      lines.push(`Auto-fixed: ${session.autoRecovered} issue${session.autoRecovered !== 1 ? 's' : ''}`);
      lines.push(`Manual intervention: ${session.escalated}`);
    }

    return lines.join('\n');
  }

  /**
   * Build an incident timeline from service_events for this session.
   * @param {object} session
   * @returns {string[]} Formatted timeline entries
   */
  _buildTimeline(session) {
    const sessionId = session.sessionId;
    if (!sessionId) return [];

    try {
      const events = this.db.prepare(
        'SELECT * FROM service_events WHERE session_id = ? ORDER BY timestamp ASC'
      ).all(sessionId);

      if (!events.length) return [];

      return events.map(e => {
        const t = new Date(e.timestamp);
        const time = t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        const type = (e.event_type || '').replace(/_/g, ' ');
        const detail = e.details ? ` — ${typeof e.details === 'string' ? (e.details.length > 60 ? e.details.slice(0, 60) + '...' : e.details) : ''}` : '';

        if (e.auto_resolved) {
          return `${time}  🤖 ${type}${detail} (auto-fixed)`;
        } else if (e.resolved) {
          return `${time}  ✅ ${type}${detail} (resolved)`;
        } else {
          return `${time}  ⚠️ ${type}${detail}`;
        }
      });
    } catch (e) {
      console.error('[SessionRecap] Timeline build error:', e.message);
      return [];
    }
  }

  // ─── TELEGRAM ────────────────────────────────────────────────────────────────

  async _sendRecap(church, session) {
    const botToken = church.alert_bot_token || this._botToken;
    if (!botToken) {
      console.warn(`[SessionRecap] No bot token for ${church.name} — recap not sent`);
      return;
    }

    let text = this.formatRecap(church, session);

    // Append AI recommendations for Pro+ tier churches
    const tier = church.billing_tier || 'connect';
    if (['pro_plus', 'enterprise'].includes(tier) && (session.alertCount > 0 || session.audioSilenceCount > 0)) {
      try {
        const recommendations = await this._generateRecommendations(church, session);
        if (recommendations) {
          text += '\n\n*Top 3 Actions to Reduce Risk:*\n' + recommendations;
        }
      } catch (e) {
        console.error(`[SessionRecap] AI recommendation error:`, e.message);
      }
    }

    // Send to TD
    const tdChatId = church.td_telegram_chat_id;
    if (tdChatId) {
      await this._sendTelegram(tdChatId, botToken, text);
    }

    // Send to Andrew (if different from TD)
    if (this._andrewChatId && this._andrewChatId !== tdChatId) {
      await this._sendTelegram(this._andrewChatId, botToken, text);
    }
  }

  /**
   * Generate AI-powered improvement recommendations based on session data.
   * Uses Anthropic Haiku for fast, cost-effective generation.
   * @param {object} church  DB row
   * @param {object} session  Finalized session object
   * @returns {Promise<string|null>}  Formatted recommendations or null
   */
  async _generateRecommendations(church, session) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;

    let engineerProfile = {};
    try { engineerProfile = JSON.parse(church.engineer_profile || '{}'); } catch {}

    const timeline = this._buildTimeline(session);

    const prompt = `You are Tally Engineer, an AI livestream technician assistant. Given this service session data, suggest exactly 3 specific, actionable steps this church should take to reduce future risk. Be concise (1 line each, max 15 words). Focus on their specific issues, not generic advice. Number them 1-3.

Session data:
- Duration: ${session.durationMinutes} min
- Grade: ${session.grade}
- Alerts: ${session.alertCount} (${session.autoRecovered} auto-recovered, ${session.escalated} escalated)
- Audio silence events: ${session.audioSilenceCount}
- Stream runtime: ${session.streamTotalMinutes} min
- Alert types: ${JSON.stringify(session.alertTypes)}
- Timeline: ${timeline.join('; ')}

Church profile:
- Name: ${church.name}
- Stream platform: ${engineerProfile.streamPlatform || 'unknown'}
- Expected viewers: ${engineerProfile.expectedViewers || 'unknown'}
- Operator level: ${engineerProfile.operatorLevel || 'unknown'}${this.churchMemory ? `\n\n${this.churchMemory.getRecapContext(church.churchId)}` : ''}`;

    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 256,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!resp.ok) return null;
      const data = await resp.json();
      const text = data.content?.[0]?.text;
      return text || null;
    } catch (e) {
      console.error('[SessionRecap] Anthropic call failed:', e.message);
      return null;
    }
  }

  /**
   * Escape special characters for Telegram MarkdownV2.
   * Must escape: _ * [ ] ( ) ~ ` > # + - = | { } . !
   */
  _escapeTelegramMd(text) {
    return text.replace(/([_*\[\]()~`>#+=|{}.!\\-])/g, '\\$1');
  }

  async _sendTelegram(chatId, botToken, text) {
    try {
      // Convert our Markdown (bold = *text*) to MarkdownV2 (*text* stays but specials escaped)
      // Split text on intentional bold markers, escape the non-bold parts
      const parts = text.split(/(\*[^*]+\*)/g);
      const escaped = parts.map(part => {
        if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
          // Keep intentional bold, but escape the inner content
          const inner = part.slice(1, -1);
          return '*' + this._escapeTelegramMd(inner) + '*';
        }
        return this._escapeTelegramMd(part);
      }).join('');

      const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: escaped, parse_mode: 'MarkdownV2' }),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        const body = await resp.text();
        console.error(`[SessionRecap] Telegram send failed: ${resp.status} ${body}`);
        // Fallback: send without formatting if MarkdownV2 fails
        if (resp.status === 400) {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text }),
            signal: AbortSignal.timeout(5000),
          });
        }
      }
    } catch (e) {
      console.error(`[SessionRecap] Telegram error: ${e.message}`);
    }
  }

  // ─── QUERY HELPERS ────────────────────────────────────────────────────────────

  getActiveSession(churchId) {
    const session = this.activeSessions.get(churchId);
    if (!session) return null;
    // Return a serializable snapshot
    return {
      sessionId: session.sessionId,
      churchId: session.churchId,
      startedAt: session.startedAt.toISOString(),
      tdName: session.tdName,
      alertCount: session.alertCount,
      autoRecovered: session.autoRecovered,
      escalated: session.escalated,
      audioSilenceCount: session.audioSilenceCount,
      peakViewers: session.peakViewers,
      streaming: session.streaming,
      streamTotalMinutes: session.streamTotalMinutes,
      recordingConfirmed: session.recordingConfirmed,
    };
  }

  getAllActiveSessions() {
    return Array.from(this.activeSessions.keys()).map(id => this.getActiveSession(id));
  }

  // ─── AI INSIGHTS ────────────────────────────────────────────────────────────

  /**
   * Tier constants for insight gating.
   * Basic (all tiers): performanceHighlights, areasForImprovement
   * Pro+ (pro_plus, enterprise): incidentTimeline, comparisonToAverage, tdResponseAnalysis, equipmentReliability
   */
  static BASIC_TIERS = ['connect', 'pro', 'pro_plus', 'enterprise'];
  static PRO_PLUS_TIERS = ['pro_plus', 'enterprise'];

  /**
   * Check if a tier qualifies for detailed (Pro+) insights.
   * @param {string} tier
   * @returns {boolean}
   */
  _isProPlus(tier) {
    return SessionRecap.PRO_PLUS_TIERS.includes(tier || 'connect');
  }

  /**
   * Generate detailed post-session insights.
   * Returns tier-gated results: basic tiers get highlights + improvements only;
   * Pro+ tiers get the full analysis.
   *
   * @param {object} sessionData  Finalized session object (from endSession)
   * @param {string} [tier='connect']  Church billing tier
   * @returns {object} Insight object
   */
  generateDetailedInsights(sessionData, tier = 'connect') {
    const highlights = this._generatePerformanceHighlights(sessionData);
    const improvements = this._generateAreasForImprovement(sessionData);

    const result = {
      performanceHighlights: highlights,
      areasForImprovement: improvements,
    };

    if (this._isProPlus(tier)) {
      result.incidentTimeline = this._generateIncidentTimeline(sessionData);
      result.comparisonToAverage = this._generateComparisonToAverage(sessionData);
      result.tdResponseAnalysis = this._generateTdResponseAnalysis(sessionData);
      result.equipmentReliability = this._generateEquipmentReliability(sessionData);
    }

    return result;
  }

  /**
   * Generate positive callouts for a session.
   * @param {object} session
   * @returns {string[]}
   */
  _generatePerformanceHighlights(session) {
    const highlights = [];

    if (session.audioSilenceCount === 0) {
      highlights.push('Zero audio issues');
    }

    if (session.alertCount === 0) {
      highlights.push('No alerts triggered');
    }

    if (session.streamTotalMinutes > 0 && session.durationMinutes > 0) {
      const uptimePercent = Math.min(100, Math.round((session.streamTotalMinutes / session.durationMinutes) * 100));
      if (uptimePercent >= 99) {
        highlights.push('100% stream uptime');
      } else if (uptimePercent >= 90) {
        highlights.push(`${uptimePercent}% stream uptime`);
      }
    }

    if (session.recordingConfirmed) {
      highlights.push('Recording confirmed');
    }

    if (session.alertCount > 0 && session.autoRecovered === session.alertCount && session.escalated === 0) {
      highlights.push('All alerts auto-resolved');
    }

    if (session.peakViewers !== null && session.peakViewers !== undefined && session.peakViewers > 0) {
      highlights.push(`Peak viewers: ${session.peakViewers}`);
    }

    if (session.escalated === 0 && session.alertCount > 0) {
      highlights.push('Zero escalations');
    }

    return highlights;
  }

  /**
   * Generate specific, actionable improvement items.
   * @param {object} session
   * @returns {string[]}
   */
  _generateAreasForImprovement(session) {
    const items = [];

    if (session.audioSilenceCount > 0) {
      items.push(`${session.audioSilenceCount} audio silence event${session.audioSilenceCount !== 1 ? 's' : ''} detected — check mic placement and input levels`);
    }

    if (!session.recordingConfirmed) {
      items.push('Recording was not confirmed — enable auto-record or add a pre-service checklist item');
    }

    if (session.streamTotalMinutes === 0 && session.durationMinutes > 0) {
      items.push('Stream did not run — verify encoder and stream key configuration');
    } else if (session.streamTotalMinutes > 0 && session.durationMinutes > 0) {
      const uptimePercent = Math.round((session.streamTotalMinutes / session.durationMinutes) * 100);
      if (uptimePercent < 90) {
        items.push(`Stream was only up ${uptimePercent}% of the session — investigate disconnections`);
      }
    }

    if (session.escalated > 0) {
      items.push(`${session.escalated} alert${session.escalated !== 1 ? 's' : ''} required manual intervention — review auto-recovery settings`);
    }

    const alertTypes = session.alertTypes || {};
    for (const [type, count] of Object.entries(alertTypes)) {
      if (count >= 3) {
        items.push(`Recurring alert: "${type.replace(/_/g, ' ')}" fired ${count} times — investigate root cause`);
      }
    }

    // Check for unused cameras if device stats exist
    if (session.deviceStats) {
      for (const [device, stats] of Object.entries(session.deviceStats)) {
        if (stats.uptimeMinutes === 0) {
          items.push(`${device} was unused — consider repositioning or removing`);
        }
      }
    }

    return items;
  }

  /**
   * Generate chronological incident timeline with duration and resolution method.
   * Pro+ only.
   * @param {object} session
   * @returns {Array<{time: string, eventType: string, duration: number|null, resolution: string}>}
   */
  _generateIncidentTimeline(session) {
    const sessionId = session.sessionId;
    if (!sessionId) return [];

    try {
      const events = this.db.prepare(
        'SELECT * FROM service_events WHERE session_id = ? ORDER BY timestamp ASC'
      ).all(sessionId);

      return events.map(e => {
        const time = new Date(e.timestamp);
        let durationMinutes = null;
        let resolution = 'unresolved';

        if (e.resolved && e.resolved_at) {
          const resolvedAt = new Date(e.resolved_at);
          durationMinutes = Math.round((resolvedAt - time) / 60000);
          resolution = e.auto_resolved ? 'auto' : 'manual';
        } else if (e.auto_resolved) {
          resolution = 'auto';
          durationMinutes = 0;
        }

        return {
          time: time.toISOString(),
          eventType: e.event_type,
          details: e.details || null,
          duration: durationMinutes,
          resolution,
        };
      });
    } catch (e) {
      console.error('[SessionRecap] Incident timeline error:', e.message);
      return [];
    }
  }

  /**
   * Compare this session to the church's historical average.
   * Pro+ only.
   * @param {object} session
   * @returns {object} Per-metric comparison: { metric: { value, average, verdict } }
   */
  _generateComparisonToAverage(session) {
    const churchId = session.churchId;
    if (!churchId) return {};

    try {
      const avgRow = this.db.prepare(`
        SELECT
          AVG(alert_count) as avg_alerts,
          AVG(auto_recovered_count) as avg_auto_recovered,
          AVG(escalated_count) as avg_escalated,
          AVG(audio_silence_count) as avg_silence,
          AVG(stream_runtime_minutes) as avg_stream_runtime,
          AVG(duration_minutes) as avg_duration,
          COUNT(*) as session_count
        FROM service_sessions
        WHERE church_id = ? AND ended_at IS NOT NULL
      `).get(churchId);

      if (!avgRow || avgRow.session_count < 2) {
        return { _note: 'Not enough historical sessions for comparison' };
      }

      const compare = (label, current, average, lowerIsBetter = true) => {
        const avg = Math.round(average * 10) / 10;
        let verdict = 'same';
        if (lowerIsBetter) {
          if (current < avg) verdict = 'better';
          else if (current > avg) verdict = 'worse';
        } else {
          if (current > avg) verdict = 'better';
          else if (current < avg) verdict = 'worse';
        }
        return { value: current, average: avg, verdict };
      };

      return {
        alerts: compare('Alerts', session.alertCount, avgRow.avg_alerts, true),
        escalations: compare('Escalations', session.escalated, avgRow.avg_escalated, true),
        audioSilence: compare('Audio silence', session.audioSilenceCount, avgRow.avg_silence, true),
        streamRuntime: compare('Stream runtime', session.streamTotalMinutes, avgRow.avg_stream_runtime, false),
      };
    } catch (e) {
      console.error('[SessionRecap] Comparison error:', e.message);
      return {};
    }
  }

  /**
   * Analyse TD response times to alerts during the session.
   * Pro+ only.
   * @param {object} session
   * @returns {object} { averageResponseMinutes, fastest, slowest, totalAcknowledged }
   */
  _generateTdResponseAnalysis(session) {
    const sessionId = session.sessionId;
    if (!sessionId) return { averageResponseMinutes: null, fastest: null, slowest: null, totalAcknowledged: 0 };

    try {
      const alerts = this.db.prepare(
        'SELECT created_at, acknowledged_at FROM alerts WHERE session_id = ? AND acknowledged_at IS NOT NULL'
      ).all(sessionId);

      if (!alerts.length) {
        return { averageResponseMinutes: null, fastest: null, slowest: null, totalAcknowledged: 0 };
      }

      const responseTimes = alerts.map(a => {
        const created = new Date(a.created_at);
        const acked = new Date(a.acknowledged_at);
        return Math.round((acked - created) / 60000 * 10) / 10; // 1 decimal place
      });

      const avg = Math.round((responseTimes.reduce((s, v) => s + v, 0) / responseTimes.length) * 10) / 10;
      const fastest = Math.min(...responseTimes);
      const slowest = Math.max(...responseTimes);

      return {
        averageResponseMinutes: avg,
        fastest,
        slowest,
        totalAcknowledged: alerts.length,
      };
    } catch (e) {
      console.error('[SessionRecap] TD response analysis error:', e.message);
      return { averageResponseMinutes: null, fastest: null, slowest: null, totalAcknowledged: 0 };
    }
  }

  /**
   * Calculate per-device uptime during the session, ranked best to worst.
   * Pro+ only. Uses service_events to identify device-specific issues.
   * @param {object} session
   * @returns {Array<{device: string, uptimePercent: number, issueCount: number}>}
   */
  _generateEquipmentReliability(session) {
    const sessionId = session.sessionId;
    if (!sessionId || !session.durationMinutes) return [];

    try {
      const events = this.db.prepare(
        'SELECT * FROM service_events WHERE session_id = ? ORDER BY timestamp ASC'
      ).all(sessionId);

      if (!events.length) return [];

      // Group events by device (inferred from event_type)
      const deviceMap = new Map(); // device → { downtimeMinutes, issueCount }

      for (const e of events) {
        const device = this._inferDevice(e.event_type, e.details);
        if (!device) continue;

        if (!deviceMap.has(device)) {
          deviceMap.set(device, { downtimeMinutes: 0, issueCount: 0 });
        }

        const entry = deviceMap.get(device);
        entry.issueCount++;

        if (e.resolved && e.resolved_at) {
          const start = new Date(e.timestamp);
          const end = new Date(e.resolved_at);
          entry.downtimeMinutes += Math.round((end - start) / 60000);
        } else if (!e.resolved) {
          // Unresolved — assume 5 min downtime per unresolved event
          entry.downtimeMinutes += 5;
        }
      }

      const totalMinutes = session.durationMinutes;
      const result = [];

      for (const [device, stats] of deviceMap) {
        const uptimePercent = Math.max(0, Math.round(((totalMinutes - stats.downtimeMinutes) / totalMinutes) * 100));
        result.push({
          device,
          uptimePercent,
          issueCount: stats.issueCount,
        });
      }

      // Sort: worst uptime first (most problematic devices first)
      result.sort((a, b) => a.uptimePercent - b.uptimePercent);
      return result;
    } catch (e) {
      console.error('[SessionRecap] Equipment reliability error:', e.message);
      return [];
    }
  }

  /**
   * Infer device name from event type and details.
   * @param {string} eventType
   * @param {string} details
   * @returns {string|null}
   */
  _inferDevice(eventType, details) {
    const type = (eventType || '').toLowerCase();
    const det = (details || '').toLowerCase();

    if (type.includes('atem')) return 'ATEM Switcher';
    if (type.includes('camera') || type.includes('cam')) {
      // Try to extract camera number from details
      const camMatch = det.match(/camera\s*(\d+)/i) || type.match(/cam(?:era)?\s*(\d+)/i);
      return camMatch ? `Camera ${camMatch[1]}` : 'Camera';
    }
    if (type.includes('audio') || type.includes('silence')) return 'Audio System';
    if (type.includes('stream')) return 'Stream Encoder';
    if (type.includes('recording') || type.includes('rec')) return 'Recording System';
    if (type.includes('network') || type.includes('disconnect')) return 'Network';
    if (type.includes('cpu') || type.includes('gpu')) return 'Encoding Hardware';

    return null;
  }

  // ─── WEEKLY SUMMARY ─────────────────────────────────────────────────────────

  /**
   * Generate aggregate insights across multiple sessions (Pro+ only).
   * @param {Array<object>} sessions  Array of finalized session objects
   * @param {string} [tier='connect']  Church billing tier
   * @returns {object|null}  Weekly summary or null if not Pro+
   */
  generateWeeklySummaryInsights(sessions, tier = 'connect') {
    if (!this._isProPlus(tier)) return null;
    if (!sessions || sessions.length === 0) return { _note: 'No sessions this week' };

    return {
      trendingMetrics: this._computeTrendingMetrics(sessions),
      recurringIssues: this._computeRecurringIssues(sessions),
      bestWorstSession: this._computeBestWorstSession(sessions),
      volunteerPatterns: this._computeVolunteerPatterns(sessions),
    };
  }

  /**
   * Compute trending metrics (improving or declining) across sessions.
   * @param {Array<object>} sessions  Ordered chronologically
   * @returns {Array<{metric: string, trend: string, values: number[]}>}
   */
  _computeTrendingMetrics(sessions) {
    if (sessions.length < 2) return [];

    const metrics = [
      { key: 'alertCount', label: 'Alerts', lowerIsBetter: true },
      { key: 'escalated', label: 'Escalations', lowerIsBetter: true },
      { key: 'audioSilenceCount', label: 'Audio silence events', lowerIsBetter: true },
      { key: 'streamTotalMinutes', label: 'Stream runtime', lowerIsBetter: false },
    ];

    const results = [];

    for (const m of metrics) {
      const values = sessions.map(s => s[m.key] ?? 0);
      // Simple linear trend: compare first half average to second half average
      const mid = Math.floor(values.length / 2);
      const firstHalf = values.slice(0, mid);
      const secondHalf = values.slice(mid);
      const firstAvg = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length;
      const secondAvg = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length;

      let trend = 'stable';
      const diff = secondAvg - firstAvg;
      const threshold = Math.max(0.5, firstAvg * 0.2); // 20% change or 0.5 absolute

      if (Math.abs(diff) > threshold) {
        if (m.lowerIsBetter) {
          trend = diff < 0 ? 'improving' : 'declining';
        } else {
          trend = diff > 0 ? 'improving' : 'declining';
        }
      }

      results.push({ metric: m.label, trend, values });
    }

    return results;
  }

  /**
   * Identify recurring issues — alert types appearing in >50% of sessions.
   * @param {Array<object>} sessions
   * @returns {Array<{alertType: string, frequency: number, sessionCount: number}>}
   */
  _computeRecurringIssues(sessions) {
    if (sessions.length === 0) return [];

    const typeCounts = {}; // alertType → number of sessions it appeared in

    for (const s of sessions) {
      const types = s.alertTypes || {};
      for (const type of Object.keys(types)) {
        typeCounts[type] = (typeCounts[type] || 0) + 1;
      }
    }

    const threshold = sessions.length / 2;
    const recurring = [];

    for (const [type, count] of Object.entries(typeCounts)) {
      if (count > threshold) {
        recurring.push({
          alertType: type,
          frequency: Math.round((count / sessions.length) * 100),
          sessionCount: count,
        });
      }
    }

    // Sort by frequency descending
    recurring.sort((a, b) => b.frequency - a.frequency);
    return recurring;
  }

  /**
   * Identify the best and worst session of the week.
   * @param {Array<object>} sessions
   * @returns {{best: object|null, worst: object|null}}
   */
  _computeBestWorstSession(sessions) {
    if (sessions.length === 0) return { best: null, worst: null };

    // Score each session: lower is better
    const scored = sessions.map(s => {
      const score = (s.alertCount || 0) * 2
        + (s.escalated || 0) * 5
        + (s.audioSilenceCount || 0) * 1
        + (s.recordingConfirmed ? 0 : 3)
        + (s.streamTotalMinutes > 0 ? 0 : 10);
      return { session: s, score };
    });

    scored.sort((a, b) => a.score - b.score);

    const best = scored[0];
    const worst = scored[scored.length - 1];

    const summarize = (entry) => ({
      sessionId: entry.session.sessionId,
      grade: entry.session.grade || this.gradeSession(entry.session),
      alertCount: entry.session.alertCount,
      escalated: entry.session.escalated,
      tdName: entry.session.tdName,
      score: entry.score,
    });

    return {
      best: summarize(best),
      worst: scored.length > 1 ? summarize(worst) : null,
    };
  }

  /**
   * Analyse volunteer (TD) performance patterns across sessions.
   * @param {Array<object>} sessions
   * @returns {Array<{tdName: string, sessionsWorked: number, avgAlerts: number, avgEscalations: number, cleanRate: number}>}
   */
  _computeVolunteerPatterns(sessions) {
    const tdMap = new Map(); // tdName → { sessions[], totalAlerts, totalEscalated, cleanCount }

    for (const s of sessions) {
      const name = s.tdName || 'Unknown';
      if (!tdMap.has(name)) {
        tdMap.set(name, { sessionsWorked: 0, totalAlerts: 0, totalEscalated: 0, cleanCount: 0 });
      }
      const entry = tdMap.get(name);
      entry.sessionsWorked++;
      entry.totalAlerts += s.alertCount || 0;
      entry.totalEscalated += s.escalated || 0;

      const grade = s.grade || this.gradeSession(s);
      if (grade.includes('Clean')) entry.cleanCount++;
    }

    const results = [];
    for (const [name, data] of tdMap) {
      results.push({
        tdName: name,
        sessionsWorked: data.sessionsWorked,
        avgAlerts: Math.round((data.totalAlerts / data.sessionsWorked) * 10) / 10,
        avgEscalations: Math.round((data.totalEscalated / data.sessionsWorked) * 10) / 10,
        cleanRate: Math.round((data.cleanCount / data.sessionsWorked) * 100),
      });
    }

    // Sort by clean rate descending
    results.sort((a, b) => b.cleanRate - a.cleanRate);
    return results;
  }
}

module.exports = { SessionRecap };
