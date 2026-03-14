'use strict';

/**
 * churchMemory.js
 * Persistent, compact memory system for per-church AI context enrichment.
 *
 * Memories are distilled observations — not raw logs.
 * Each AI call site reads a different slice within a strict token budget.
 *
 * Architecture: "write-time compilation" — on each write, the top memories
 * are compiled into a cached summary string on the churches table.
 * The command parser reads this cached string with zero extra queries.
 */

const MAX_MEMORIES_PER_CHURCH = 30;
const MAX_SUMMARY_CHARS = 800;
const CONFIDENCE_DECAY_PER_WEEK = 15;
const ARCHIVE_THRESHOLD = 10;

class ChurchMemory {
  /**
   * @param {import('better-sqlite3').Database} db
   */
  constructor(db) {
    this.db = db;
    this._ensureSchema();
  }

  _ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS church_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        church_id TEXT NOT NULL,
        category TEXT NOT NULL,
        summary TEXT NOT NULL,
        details TEXT DEFAULT '{}',
        confidence INTEGER DEFAULT 50,
        observation_count INTEGER DEFAULT 1,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        source TEXT NOT NULL,
        active INTEGER DEFAULT 1
      )
    `);

    // Create index if not exists
    try {
      this.db.exec(`CREATE INDEX idx_memory_church ON church_memory(church_id, active, confidence DESC)`);
    } catch { /* already exists */ }
  }

  // ─── CORE UPSERT ────────────────────────────────────────────────────────────

  /**
   * Find an existing memory that matches the given key fields.
   * @param {string} churchId
   * @param {string} category
   * @param {string} matchKey  Category-specific key for dedup (e.g., alert_type for fix_outcome)
   * @returns {object|null}
   */
  _findExisting(churchId, category, matchKey) {
    // For fix_outcome: matchKey = command or alert_type
    // For recurring_issue: matchKey = event_type
    // For equipment_quirk: matchKey = device+trigger
    // For reliability_trend: matchKey = 'overall'
    const rows = this.db.prepare(
      `SELECT * FROM church_memory WHERE church_id = ? AND category = ? AND active = 1`
    ).all(churchId, category);

    for (const row of rows) {
      try {
        const details = JSON.parse(row.details || '{}');
        if (details._matchKey === matchKey) return row;
      } catch { /* skip malformed */ }
    }
    return null;
  }

  /**
   * Insert or update a memory observation.
   * If a matching memory exists, merges data. Otherwise creates new.
   * @param {string} churchId
   * @param {string} category
   * @param {string} matchKey
   * @param {string} summary  Human-readable sentence, max ~100 chars
   * @param {object} details  Category-specific JSON
   * @param {string} source   post_service | weekly_digest | command_feedback
   * @returns {boolean} true if a new memory was created
   */
  _upsertMemory(churchId, category, matchKey, summary, details, source) {
    const now = new Date().toISOString();
    details._matchKey = matchKey;

    const existing = this._findExisting(churchId, category, matchKey);

    if (existing) {
      // Merge: bump count, confidence, update summary + details
      const newCount = existing.observation_count + 1;
      const newConfidence = Math.min(100, existing.confidence + 5);
      this.db.prepare(`
        UPDATE church_memory SET
          summary = ?, details = ?, confidence = ?,
          observation_count = ?, last_seen = ?, source = ?
        WHERE id = ?
      `).run(summary, JSON.stringify(details), newConfidence, newCount, now, source, existing.id);
      return false; // no new row
    }

    // New memory
    this.db.prepare(`
      INSERT INTO church_memory (church_id, category, summary, details, confidence, observation_count, first_seen, last_seen, source, active)
      VALUES (?, ?, ?, ?, 50, 1, ?, ?, ?, 1)
    `).run(churchId, category, summary, JSON.stringify(details), now, now, source);
    return true; // new row created
  }

  // ─── WRITE: USER NOTES ──────────────────────────────────────────────────────

  /**
   * Save a TD-provided note as a persistent memory.
   * "Remember the pastor likes a tight shot during prayer"
   * @param {string} churchId
   * @param {string} note  Free-text note from the TD
   * @param {string} [senderName='TD']
   */
  saveUserNote(churchId, note, senderName = 'TD') {
    try {
      const matchKey = `note:${note.slice(0, 50).toLowerCase().replace(/\s+/g, '_')}`;
      const now = new Date().toISOString();
      const details = { _matchKey: matchKey, fullNote: note, setBy: senderName };

      const existing = this._findExisting(churchId, 'user_note', matchKey);

      if (existing) {
        // Update existing note
        this.db.prepare(`
          UPDATE church_memory SET
            summary = ?, details = ?, confidence = ?, last_seen = ?
          WHERE id = ?
        `).run(note.slice(0, 120), JSON.stringify(details), Math.min(100, existing.confidence + 5), now, existing.id);
      } else {
        // New note — starts at confidence 80 (higher than auto-detected memories)
        this.db.prepare(`
          INSERT INTO church_memory (church_id, category, summary, details, confidence, observation_count, first_seen, last_seen, source, active)
          VALUES (?, ?, ?, ?, 80, 1, ?, ?, ?, 1)
        `).run(churchId, 'user_note', note.slice(0, 120), JSON.stringify(details), now, now, 'user_note');
      }

      this._rebuildSummary(churchId);
    } catch (e) {
      console.error(`[ChurchMemory] User note error:`, e.message);
    }
  }

  /**
   * Get all active user notes for a church.
   * @param {string} churchId
   * @returns {object[]}
   */
  getUserNotes(churchId) {
    return this.db.prepare(
      `SELECT * FROM church_memory WHERE church_id = ? AND category = 'user_note' AND active = 1 ORDER BY last_seen DESC`
    ).all(churchId);
  }

  // ─── WRITE: POST-SERVICE ────────────────────────────────────────────────────

  /**
   * Analyze a completed session and write/update memories.
   * Called from sessionRecap.endSession() after grading.
   * @param {string} churchId
   * @param {object} session  Finalized session from SessionRecap
   */
  writePostServiceMemories(churchId, session) {
    try {
      // Get events for this session
      const events = this.db.prepare(
        'SELECT * FROM service_events WHERE session_id = ? ORDER BY timestamp ASC'
      ).all(session.sessionId);

      if (!events.length) return;

      // Record fix outcomes for auto-recovered events
      const autoRecovered = events.filter(e => e.auto_resolved);
      for (const event of autoRecovered) {
        const matchKey = `fix:${event.event_type}`;
        const successRate = this._computeFixSuccessRate(churchId, event.event_type);
        this._upsertMemory(
          churchId,
          'fix_outcome',
          matchKey,
          `Auto-recovery works ${successRate}% for ${event.event_type.replace(/_/g, ' ')}`,
          { alertType: event.event_type, success: true, successRate },
          'post_service'
        );
      }

      // Record escalated (unresolved) events as failed fixes
      const escalated = events.filter(e => !e.resolved && !e.auto_resolved);
      for (const event of escalated) {
        const matchKey = `fail:${event.event_type}`;
        this._upsertMemory(
          churchId,
          'fix_outcome',
          matchKey,
          `${event.event_type.replace(/_/g, ' ')} required manual intervention`,
          { alertType: event.event_type, success: false },
          'post_service'
        );
      }

      // Detect equipment quirks: if same event type occurred in 3+ of last 5 sessions
      const recentSessions = this.db.prepare(
        'SELECT id FROM service_sessions WHERE church_id = ? ORDER BY started_at DESC LIMIT 5'
      ).all(churchId).map(r => r.id);

      if (recentSessions.length >= 3) {
        // Count event types across recent sessions
        const placeholders = recentSessions.map(() => '?').join(',');
        const typeCounts = this.db.prepare(`
          SELECT event_type, COUNT(DISTINCT session_id) as session_count
          FROM service_events
          WHERE session_id IN (${placeholders})
          GROUP BY event_type
          HAVING session_count >= 3
        `).all(...recentSessions);

        for (const tc of typeCounts) {
          const matchKey = `quirk:${tc.event_type}`;
          this._upsertMemory(
            churchId,
            'equipment_quirk',
            matchKey,
            `${tc.event_type.replace(/_/g, ' ')} occurs in ${tc.session_count}/5 recent services`,
            { eventType: tc.event_type, sessionCount: tc.session_count, outOf: recentSessions.length },
            'post_service'
          );
        }
      }

      this._rebuildSummary(churchId);
    } catch (e) {
      console.error(`[ChurchMemory] Post-service write error for ${churchId}:`, e.message);
    }
  }

  /**
   * Compute auto-recovery success rate for a given event type at a church.
   */
  _computeFixSuccessRate(churchId, eventType) {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN auto_resolved = 1 THEN 1 ELSE 0 END) as auto_fixed
      FROM service_events
      WHERE church_id = ? AND event_type = ?
    `).get(churchId, eventType);

    if (!row || !row.total) return 0;
    return Math.round((row.auto_fixed / row.total) * 100);
  }

  // ─── WRITE: WEEKLY DIGEST ──────────────────────────────────────────────────

  /**
   * Consolidate weekly patterns into memories.
   * Called from weeklyDigest weekly timer after digest generation.
   * @param {string} churchId
   * @param {Array} patterns  Output of detectPatterns()
   * @param {number|null} reliability  Computed reliability percentage
   */
  writeWeeklyMemories(churchId, patterns, reliability) {
    try {
      // Upsert recurring issue memories from patterns
      for (const p of patterns) {
        // Strip count suffix like " (3x)" from pattern string before using as match key
        const patternBase = (p.pattern || '').replace(/\s*\(\d+x\)\s*$/, '').replace(/\s+/g, '_');
        const matchKey = `recurring:${patternBase}`;
        this._upsertMemory(
          churchId,
          'recurring_issue',
          matchKey,
          `${(p.pattern || '').replace(/\s*\(\d+x\)\s*$/, '')} ${p.frequency}x/week${p.timeWindow ? ` around ${p.timeWindow}` : ''}`,
          { eventType: patternBase, frequency: p.frequency, timeWindow: p.timeWindow, recommendation: p.recommendation },
          'weekly_digest'
        );
      }

      // Upsert reliability trend
      if (reliability !== null) {
        // Get previous reliability from existing memory
        const existing = this._findExisting(churchId, 'reliability_trend', 'overall');
        let previousReliability = null;
        if (existing) {
          try {
            previousReliability = JSON.parse(existing.details || '{}').current;
          } catch {}
        }

        const trend = previousReliability !== null
          ? (reliability > previousReliability ? 'improving' : reliability < previousReliability ? 'degrading' : 'stable')
          : 'new';

        this._upsertMemory(
          churchId,
          'reliability_trend',
          'overall',
          `Reliability ${reliability}% uptime${previousReliability !== null ? ` (${trend} from ${previousReliability}%)` : ''}`,
          { current: reliability, previous: previousReliability, trend },
          'weekly_digest'
        );
      }

      // Decay stale memories and run consolidation
      this.consolidate(churchId);
      this._rebuildSummary(churchId);
    } catch (e) {
      console.error(`[ChurchMemory] Weekly write error for ${churchId}:`, e.message);
    }
  }

  // ─── WRITE: COMMAND FEEDBACK ───────────────────────────────────────────────

  /**
   * Record that an AI-generated command succeeded or failed.
   * @param {string} churchId
   * @param {string} command  e.g., 'obs.startStream'
   * @param {boolean} success
   * @param {string} alertContext  What triggered this (alert_type or 'user_request')
   */
  recordCommandOutcome(churchId, command, success, alertContext = 'user_request') {
    try {
      const matchKey = `cmd:${command}:${alertContext}`;
      const label = command.replace(/\./g, ' ');
      const summary = success
        ? `${label} works for ${alertContext.replace(/_/g, ' ')}`
        : `${label} failed for ${alertContext.replace(/_/g, ' ')}`;

      const isNew = this._upsertMemory(
        churchId,
        'fix_outcome',
        matchKey,
        summary,
        { command, success, alertContext },
        'command_feedback'
      );

      // Only rebuild summary if a new memory was created (avoid churn during services)
      if (isNew) this._rebuildSummary(churchId);
    } catch (e) {
      console.error(`[ChurchMemory] Command outcome error:`, e.message);
    }
  }

  // ─── READ: PARSER CONTEXT ─────────────────────────────────────────────────

  /**
   * Get compact memory context for the command parser.
   * Reads pre-compiled summary from churches table — zero extra queries.
   * @param {string} churchId
   * @returns {string}  Formatted text, max ~200 tokens
   */
  getParserContext(churchId) {
    try {
      const row = this.db.prepare('SELECT memory_summary FROM churches WHERE churchId = ?').get(churchId);
      return row?.memory_summary || '';
    } catch {
      return '';
    }
  }

  // ─── READ: RECAP CONTEXT ──────────────────────────────────────────────────

  /**
   * Get memory context for post-service coaching recommendations.
   * Queries recurring issues + reliability trends so AI avoids repeating stale advice.
   * @param {string} churchId
   * @returns {string}  Formatted text, max ~150 tokens
   */
  getRecapContext(churchId) {
    try {
      const rows = this.db.prepare(`
        SELECT summary, details FROM church_memory
        WHERE church_id = ? AND active = 1 AND category IN ('recurring_issue', 'reliability_trend')
        ORDER BY confidence DESC, last_seen DESC
        LIMIT 5
      `).all(churchId);

      if (!rows.length) return '';

      const lines = rows.map(r => `- ${r.summary}`);
      const text = `Known patterns:\n${lines.join('\n')}`;

      // Enforce 600 char budget (~150 tokens)
      return text.length > 600 ? text.slice(0, 597) + '...' : text;
    } catch {
      return '';
    }
  }

  // ─── READ: PRE-SERVICE BRIEFING ─────────────────────────────────────────

  /**
   * Get structured data for a pre-service intelligence briefing.
   * Zero AI calls — just database queries.
   * @param {string} churchId
   * @returns {{ userNotes: object[], recurringIssues: object[], equipmentQuirks: object[], reliabilityTrend: object|null }}
   */
  getPreServiceBriefing(churchId) {
    try {
      const userNotes = this.db.prepare(
        `SELECT summary FROM church_memory WHERE church_id = ? AND category = 'user_note' AND active = 1 ORDER BY confidence DESC LIMIT 5`
      ).all(churchId);
      const recurringIssues = this.db.prepare(
        `SELECT summary, details FROM church_memory WHERE church_id = ? AND category = 'recurring_issue' AND active = 1 ORDER BY confidence DESC LIMIT 3`
      ).all(churchId);
      const equipmentQuirks = this.db.prepare(
        `SELECT summary FROM church_memory WHERE church_id = ? AND category = 'equipment_quirk' AND active = 1 ORDER BY confidence DESC LIMIT 3`
      ).all(churchId);
      const reliabilityTrend = this.db.prepare(
        `SELECT summary, details FROM church_memory WHERE church_id = ? AND category = 'reliability_trend' AND active = 1 LIMIT 1`
      ).get(churchId) || null;
      return { userNotes, recurringIssues, equipmentQuirks, reliabilityTrend };
    } catch (e) {
      console.error(`[ChurchMemory] Briefing query error for ${churchId}:`, e.message);
      return { userNotes: [], recurringIssues: [], equipmentQuirks: [], reliabilityTrend: null };
    }
  }

  // ─── READ: TIMED WARNINGS ─────────────────────────────────────────────────

  /**
   * Get recurring issues that have a known time-of-day pattern.
   * Used for proactive warnings during a live service.
   * @param {string} churchId
   * @returns {Array<{ summary: string, eventType: string, windowMinuteOfDay: number }>}
   */
  getTimedWarnings(churchId) {
    try {
      const rows = this.db.prepare(
        `SELECT summary, details FROM church_memory
         WHERE church_id = ? AND category = 'recurring_issue' AND active = 1 AND confidence >= 30`
      ).all(churchId);

      const warnings = [];
      for (const row of rows) {
        try {
          const details = JSON.parse(row.details || '{}');
          const tw = details.timeWindow;
          if (!tw || tw === 'varied times') continue;
          const match = tw.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
          if (!match) continue;
          let h = parseInt(match[1]);
          const m = parseInt(match[2]);
          if (match[3].toUpperCase() === 'PM' && h < 12) h += 12;
          if (match[3].toUpperCase() === 'AM' && h === 12) h = 0;
          warnings.push({
            summary: row.summary,
            eventType: details.eventType || '',
            windowMinuteOfDay: h * 60 + m,
          });
        } catch { /* skip malformed */ }
      }
      return warnings;
    } catch (e) {
      console.error(`[ChurchMemory] Timed warnings error for ${churchId}:`, e.message);
      return [];
    }
  }

  // ─── CONSOLIDATION ────────────────────────────────────────────────────────

  /**
   * Weekly consolidation: decay stale memories, archive low-confidence, enforce cap.
   * @param {string} churchId
   */
  consolidate(churchId) {
    const now = new Date();

    // 1. Decay confidence on memories not seen in 4+ weeks
    //    User notes decay at half speed (explicit user intent should persist longer)
    const fourWeeksAgo = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000).toISOString();
    const stale = this.db.prepare(`
      SELECT id, confidence, last_seen, category FROM church_memory
      WHERE church_id = ? AND active = 1 AND last_seen < ?
    `).all(churchId, fourWeeksAgo);

    for (const mem of stale) {
      const weeksSinceLastSeen = Math.floor((now - new Date(mem.last_seen)) / (7 * 24 * 60 * 60 * 1000));
      const weeksOverThreshold = weeksSinceLastSeen - 4;
      const decayRate = mem.category === 'user_note' ? CONFIDENCE_DECAY_PER_WEEK * 0.5 : CONFIDENCE_DECAY_PER_WEEK;
      const decay = weeksOverThreshold * decayRate;
      const newConfidence = Math.max(0, mem.confidence - decay);

      if (newConfidence < ARCHIVE_THRESHOLD) {
        this.db.prepare('UPDATE church_memory SET active = 0, confidence = ? WHERE id = ?').run(newConfidence, mem.id);
      } else {
        this.db.prepare('UPDATE church_memory SET confidence = ? WHERE id = ?').run(newConfidence, mem.id);
      }
    }

    // 2. Enforce per-church cap
    const activeCount = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM church_memory WHERE church_id = ? AND active = 1'
    ).get(churchId)?.cnt || 0;

    if (activeCount > MAX_MEMORIES_PER_CHURCH) {
      const toArchive = activeCount - MAX_MEMORIES_PER_CHURCH;
      this.db.prepare(`
        UPDATE church_memory SET active = 0
        WHERE id IN (
          SELECT id FROM church_memory
          WHERE church_id = ? AND active = 1
          ORDER BY confidence ASC, last_seen ASC
          LIMIT ?
        )
      `).run(churchId, toArchive);
    }
  }

  // ─── SUMMARY REBUILD ──────────────────────────────────────────────────────

  /**
   * Recompile the cached memory summary from the top memories.
   * Written to churches.memory_summary for fast reads by the parser.
   * @param {string} churchId
   */
  _rebuildSummary(churchId) {
    try {
      const rows = this.db.prepare(`
        SELECT summary FROM church_memory
        WHERE church_id = ? AND active = 1
        ORDER BY CASE WHEN category = 'user_note' THEN 0 ELSE 1 END, confidence DESC, last_seen DESC
        LIMIT 8
      `).all(churchId);

      if (!rows.length) {
        this.db.prepare('UPDATE churches SET memory_summary = ? WHERE churchId = ?').run('', churchId);
        return;
      }

      // Build compact summary string
      const sentences = rows.map(r => r.summary);
      let text = '[Memory: ' + sentences.join('. ') + '.]';

      // Enforce character budget
      if (text.length > MAX_SUMMARY_CHARS) {
        // Progressively drop last sentences until it fits
        while (sentences.length > 1 && text.length > MAX_SUMMARY_CHARS) {
          sentences.pop();
          text = '[Memory: ' + sentences.join('. ') + '.]';
        }
        if (text.length > MAX_SUMMARY_CHARS) {
          text = text.slice(0, MAX_SUMMARY_CHARS - 1) + ']';
        }
      }

      this.db.prepare('UPDATE churches SET memory_summary = ? WHERE churchId = ?').run(text, churchId);
    } catch (e) {
      console.error(`[ChurchMemory] Summary rebuild error for ${churchId}:`, e.message);
    }
  }

  // ─── READ: PRE-SERVICE CONTEXT ──────────────────────────────────────────

  /**
   * Get memory context tailored for pre-service checks.
   * Returns known issues, past failures, and equipment quirks so the
   * pre-service check can call out areas that need extra attention.
   * E.g., "OBS crashed twice last month — check OBS extra carefully"
   * @param {string} churchId
   * @returns {string}  Formatted text, max ~600 chars (~150 tokens)
   */
  getPreServiceContext(churchId) {
    try {
      const rows = this.db.prepare(`
        SELECT summary, category, confidence, details FROM church_memory
        WHERE church_id = ? AND active = 1
          AND category IN ('equipment_quirk', 'fix_outcome', 'recurring_issue', 'user_note')
        ORDER BY
          CASE category
            WHEN 'equipment_quirk' THEN 0
            WHEN 'recurring_issue' THEN 1
            WHEN 'fix_outcome' THEN 2
            WHEN 'user_note' THEN 3
          END,
          confidence DESC, last_seen DESC
        LIMIT 8
      `).all(churchId);

      if (!rows.length) return '';

      const lines = [];
      for (const r of rows) {
        let prefix = '';
        if (r.category === 'equipment_quirk') prefix = '[QUIRK] ';
        else if (r.category === 'recurring_issue') prefix = '[RECURRING] ';
        else if (r.category === 'fix_outcome') {
          try {
            const d = JSON.parse(r.details || '{}');
            prefix = d.success === false ? '[PAST FAILURE] ' : '[FIX] ';
          } catch { prefix = '[FIX] '; }
        } else if (r.category === 'user_note') prefix = '[NOTE] ';
        lines.push(`- ${prefix}${r.summary}`);
      }

      const text = `Pre-service watch list:\n${lines.join('\n')}`;
      return text.length > 600 ? text.slice(0, 597) + '...' : text;
    } catch (e) {
      console.error(`[ChurchMemory] Pre-service context error for ${churchId}:`, e.message);
      return '';
    }
  }

  // ─── READ: SESSION CONTEXT ────────────────────────────────────────────────

  /**
   * Get memory context for session recap enrichment.
   * Returns recurring patterns, known workarounds, and reliability trends
   * so post-service AI recommendations can reference historical context.
   * @param {string} churchId
   * @returns {string}  Formatted text, max ~600 chars (~150 tokens)
   */
  getSessionContext(churchId) {
    try {
      const rows = this.db.prepare(`
        SELECT summary, category, confidence, details FROM church_memory
        WHERE church_id = ? AND active = 1
          AND category IN ('recurring_issue', 'fix_outcome', 'reliability_trend', 'equipment_quirk')
        ORDER BY confidence DESC, last_seen DESC
        LIMIT 8
      `).all(churchId);

      if (!rows.length) return '';

      const lines = [];
      for (const r of rows) {
        try {
          const d = JSON.parse(r.details || '{}');
          if (r.category === 'fix_outcome' && d.success) {
            lines.push(`- Known fix: ${r.summary}`);
          } else if (r.category === 'fix_outcome' && d.success === false) {
            lines.push(`- Unresolved: ${r.summary}`);
          } else if (r.category === 'recurring_issue') {
            const rec = d.recommendation ? ` (tip: ${d.recommendation})` : '';
            lines.push(`- Pattern: ${r.summary}${rec}`);
          } else if (r.category === 'reliability_trend') {
            lines.push(`- Trend: ${r.summary}`);
          } else if (r.category === 'equipment_quirk') {
            lines.push(`- Quirk: ${r.summary}`);
          } else {
            lines.push(`- ${r.summary}`);
          }
        } catch {
          lines.push(`- ${r.summary}`);
        }
      }

      const text = `Session history:\n${lines.join('\n')}`;
      return text.length > 600 ? text.slice(0, 597) + '...' : text;
    } catch (e) {
      console.error(`[ChurchMemory] Session context error for ${churchId}:`, e.message);
      return '';
    }
  }

  // ─── READ: ONBOARDING CONTEXT ─────────────────────────────────────────────

  /**
   * Get memory context for onboarding conversations.
   * Returns equipment preferences, past configurations, and user notes
   * so the onboarding AI can reference what the church has used before.
   * Useful when a church re-onboards or a new TD takes over.
   * @param {string} churchId
   * @returns {string}  Formatted text, max ~600 chars (~150 tokens)
   */
  getOnboardingContext(churchId) {
    try {
      const rows = this.db.prepare(`
        SELECT summary, category, confidence, details FROM church_memory
        WHERE church_id = ? AND active = 1
          AND category IN ('user_note', 'equipment_quirk', 'fix_outcome', 'reliability_trend')
        ORDER BY
          CASE category
            WHEN 'user_note' THEN 0
            WHEN 'equipment_quirk' THEN 1
            WHEN 'reliability_trend' THEN 2
            WHEN 'fix_outcome' THEN 3
          END,
          confidence DESC, last_seen DESC
        LIMIT 6
      `).all(churchId);

      if (!rows.length) return '';

      const lines = [];
      for (const r of rows) {
        if (r.category === 'user_note') {
          lines.push(`- Preference: ${r.summary}`);
        } else if (r.category === 'equipment_quirk') {
          lines.push(`- Equipment note: ${r.summary}`);
        } else if (r.category === 'reliability_trend') {
          lines.push(`- ${r.summary}`);
        } else if (r.category === 'fix_outcome') {
          lines.push(`- Past experience: ${r.summary}`);
        }
      }

      const text = `Church history:\n${lines.join('\n')}`;
      return text.length > 600 ? text.slice(0, 597) + '...' : text;
    } catch (e) {
      console.error(`[ChurchMemory] Onboarding context error for ${churchId}:`, e.message);
      return '';
    }
  }

  // ─── WRITE: INCIDENT LEARNING ─────────────────────────────────────────────

  /**
   * Store a new memory from an incident.
   * E.g., "ATEM needed power cycle after firmware update"
   * Can be called from alertEngine, manual TD reports, or post-service analysis.
   * @param {string} churchId
   * @param {object} incident
   * @param {string} incident.type  Event type (e.g., 'atem_connection_lost', 'obs_crash')
   * @param {string} incident.summary  Human-readable description of the learning
   * @param {string} [incident.resolution]  What fixed it
   * @param {string} [incident.device]  Device involved (e.g., 'ATEM', 'OBS')
   * @param {object} [incident.metadata]  Additional structured data
   * @returns {boolean}  true if a new memory was created
   */
  recordIncidentLearning(churchId, incident) {
    try {
      if (!incident || !incident.type || !incident.summary) {
        console.warn('[ChurchMemory] recordIncidentLearning: missing type or summary');
        return false;
      }

      const matchKey = `incident:${incident.type}:${(incident.device || 'unknown').toLowerCase()}`;
      const summary = incident.summary.slice(0, 120);
      const details = {
        eventType: incident.type,
        device: incident.device || null,
        resolution: incident.resolution || null,
        ...incident.metadata,
      };

      const isNew = this._upsertMemory(
        churchId,
        incident.resolution ? 'fix_outcome' : 'equipment_quirk',
        matchKey,
        summary,
        details,
        'incident_learning'
      );

      this._rebuildSummary(churchId);
      return isNew;
    } catch (e) {
      console.error(`[ChurchMemory] Incident learning error for ${churchId}:`, e.message);
      return false;
    }
  }

  // ─── READ: RECENT INSIGHTS ────────────────────────────────────────────────

  /**
   * Get the most relevant active memories sorted by confidence.
   * A general-purpose accessor for any system that needs top memories.
   * @param {string} churchId
   * @param {number} [limit=5]  Maximum number of memories to return
   * @returns {Array<{ summary: string, category: string, confidence: number, lastSeen: string, observationCount: number, details: object }>}
   */
  getRecentInsights(churchId, limit = 5) {
    try {
      const rows = this.db.prepare(`
        SELECT summary, category, confidence, last_seen, observation_count, details
        FROM church_memory
        WHERE church_id = ? AND active = 1
        ORDER BY confidence DESC, last_seen DESC
        LIMIT ?
      `).all(churchId, limit);

      return rows.map(r => {
        let parsedDetails = {};
        try { parsedDetails = JSON.parse(r.details || '{}'); } catch {}
        // Remove internal _matchKey from public API
        delete parsedDetails._matchKey;
        return {
          summary: r.summary,
          category: r.category,
          confidence: r.confidence,
          lastSeen: r.last_seen,
          observationCount: r.observation_count,
          details: parsedDetails,
        };
      });
    } catch (e) {
      console.error(`[ChurchMemory] Recent insights error for ${churchId}:`, e.message);
      return [];
    }
  }

  // ─── ADMIN / DEBUG ────────────────────────────────────────────────────────

  /**
   * List all memories for a church.
   * @param {string} churchId
   * @param {object} opts
   * @returns {object[]}
   */
  getAll(churchId, { activeOnly = true } = {}) {
    const where = activeOnly ? 'AND active = 1' : '';
    return this.db.prepare(
      `SELECT * FROM church_memory WHERE church_id = ? ${where} ORDER BY confidence DESC, last_seen DESC`
    ).all(churchId);
  }

  /**
   * Get summary stats.
   */
  getStats() {
    return this.db.prepare(`
      SELECT
        COUNT(*) as total_memories,
        COUNT(DISTINCT church_id) as churches_with_memory,
        SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) as active_memories,
        SUM(CASE WHEN active = 0 THEN 1 ELSE 0 END) as archived_memories
      FROM church_memory
    `).get();
  }
}

module.exports = { ChurchMemory };
