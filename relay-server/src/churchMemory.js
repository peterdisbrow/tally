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

const { createQueryClient } = require('./db');

const MAX_MEMORIES_PER_CHURCH = 30;
const MAX_SUMMARY_CHARS = 800;
const CONFIDENCE_DECAY_PER_WEEK = 15;
const ARCHIVE_THRESHOLD = 10;

const SQLITE_FALLBACK_CONFIG = {
  driver: 'sqlite',
  isSqlite: true,
  isPostgres: false,
  databaseUrl: '',
};

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function applyTextBudget(text, maxChars = 600) {
  return text.length > maxChars ? text.slice(0, maxChars - 3) + '...' : text;
}

function toRecentInsights(rows) {
  return rows.map((row) => {
    const details = parseJson(row.details || '{}', {});
    delete details._matchKey;
    return {
      summary: row.summary,
      category: row.category,
      confidence: row.confidence,
      lastSeen: row.last_seen,
      observationCount: row.observation_count,
      details,
    };
  });
}

function formatPreServiceContext(rows) {
  if (!rows.length) return '';

  const lines = [];
  for (const row of rows) {
    let prefix = '';
    if (row.category === 'equipment_quirk') prefix = '[QUIRK] ';
    else if (row.category === 'recurring_issue') prefix = '[RECURRING] ';
    else if (row.category === 'fix_outcome') {
      const details = parseJson(row.details || '{}', {});
      prefix = details.success === false ? '[PAST FAILURE] ' : '[FIX] ';
    } else if (row.category === 'user_note') {
      prefix = '[NOTE] ';
    }
    lines.push(`- ${prefix}${row.summary}`);
  }

  return applyTextBudget(`Pre-service watch list:\n${lines.join('\n')}`);
}

function formatSessionContext(rows) {
  if (!rows.length) return '';

  const lines = [];
  for (const row of rows) {
    const details = parseJson(row.details || '{}', {});
    if (row.category === 'fix_outcome' && details.success) {
      lines.push(`- Known fix: ${row.summary}`);
    } else if (row.category === 'fix_outcome' && details.success === false) {
      lines.push(`- Unresolved: ${row.summary}`);
    } else if (row.category === 'recurring_issue') {
      const rec = details.recommendation ? ` (tip: ${details.recommendation})` : '';
      lines.push(`- Pattern: ${row.summary}${rec}`);
    } else if (row.category === 'reliability_trend') {
      lines.push(`- Trend: ${row.summary}`);
    } else if (row.category === 'equipment_quirk') {
      lines.push(`- Quirk: ${row.summary}`);
    } else {
      lines.push(`- ${row.summary}`);
    }
  }

  return applyTextBudget(`Session history:\n${lines.join('\n')}`);
}

function formatOnboardingContext(rows) {
  if (!rows.length) return '';

  const lines = [];
  for (const row of rows) {
    if (row.category === 'user_note') {
      lines.push(`- Preference: ${row.summary}`);
    } else if (row.category === 'equipment_quirk') {
      lines.push(`- Equipment note: ${row.summary}`);
    } else if (row.category === 'reliability_trend') {
      lines.push(`- ${row.summary}`);
    } else if (row.category === 'fix_outcome') {
      lines.push(`- Past experience: ${row.summary}`);
    }
  }

  return applyTextBudget(`Church history:\n${lines.join('\n')}`);
}

class ChurchMemory {
  /**
   * @param {import('better-sqlite3').Database|object} dbOrClient
   * @param {object} [options]
   * @param {object} [options.config]
   */
  constructor(dbOrClient, options = {}) {
    this.db = dbOrClient && typeof dbOrClient.prepare === 'function' ? dbOrClient : null;
    this.client = this._resolveClient(dbOrClient, options);

    if (this.db) {
      this._ensureSchemaSync();
      this.ready = Promise.resolve();
    } else {
      this.ready = this._init();
    }
  }

  _resolveClient(dbOrClient, options = {}) {
    if (!dbOrClient) return null;
    if (typeof dbOrClient.query === 'function' && typeof dbOrClient.exec === 'function') {
      return dbOrClient;
    }

    return createQueryClient({
      config: options.config || SQLITE_FALLBACK_CONFIG,
      sqliteDb: dbOrClient,
    });
  }

  _requireClient() {
    if (!this.client) throw new Error('[ChurchMemory] Database client is not configured.');
    return this.client;
  }

  async _init() {
    await this._ensureSchema();
  }

  _ensureSchemaSync() {
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

    try {
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_memory_church ON church_memory(church_id, active, confidence DESC)');
    } catch { /* already exists */ }
  }

  async _ensureSchema() {
    const client = this._requireClient();
    const idType = client.driver === 'postgres' ? 'BIGSERIAL' : 'INTEGER';
    const autoIncrement = client.driver === 'postgres' ? '' : ' AUTOINCREMENT';

    await client.exec(`
      CREATE TABLE IF NOT EXISTS church_memory (
        id ${idType} PRIMARY KEY${autoIncrement},
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

    try {
      await client.exec('CREATE INDEX IF NOT EXISTS idx_memory_church ON church_memory(church_id, active, confidence DESC)');
    } catch { /* already exists */ }
  }

  // ─── CORE UPSERT ────────────────────────────────────────────────────────────

  /**
   * Find an existing memory that matches the given key fields.
   * @param {string} churchId
   * @param {string} category
   * @param {string} matchKey  Category-specific key for dedup (e.g., alert_type for fix_outcome)
   * @returns {object|null|Promise<object|null>}
   */
  _findExisting(churchId, category, matchKey) {
    if (this.db) return this._findExistingSync(churchId, category, matchKey);
    return this._findExistingAsync(churchId, category, matchKey);
  }

  _findExistingSync(churchId, category, matchKey) {
    const rows = this.db.prepare(
      'SELECT * FROM church_memory WHERE church_id = ? AND category = ? AND active = 1'
    ).all(churchId, category);

    for (const row of rows) {
      const details = parseJson(row.details || '{}', {});
      if (details._matchKey === matchKey) return row;
    }
    return null;
  }

  async _findExistingAsync(churchId, category, matchKey) {
    await this.ready;
    const rows = await this._requireClient().query(
      'SELECT * FROM church_memory WHERE church_id = ? AND category = ? AND active = 1',
      [churchId, category]
    );

    for (const row of rows) {
      const details = parseJson(row.details || '{}', {});
      if (details._matchKey === matchKey) return row;
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
   * @returns {boolean|Promise<boolean>} true if a new memory was created
   */
  _upsertMemory(churchId, category, matchKey, summary, details, source) {
    if (this.db) return this._upsertMemorySync(churchId, category, matchKey, summary, details, source);
    return this._upsertMemoryAsync(churchId, category, matchKey, summary, details, source);
  }

  _upsertMemorySync(churchId, category, matchKey, summary, details, source) {
    const now = new Date().toISOString();
    const nextDetails = { ...details, _matchKey: matchKey };

    const existing = this._findExistingSync(churchId, category, matchKey);
    if (existing) {
      const newCount = existing.observation_count + 1;
      const newConfidence = Math.min(100, existing.confidence + 5);
      this.db.prepare(`
        UPDATE church_memory SET
          summary = ?, details = ?, confidence = ?,
          observation_count = ?, last_seen = ?, source = ?
        WHERE id = ?
      `).run(summary, JSON.stringify(nextDetails), newConfidence, newCount, now, source, existing.id);
      return false;
    }

    this.db.prepare(`
      INSERT INTO church_memory (church_id, category, summary, details, confidence, observation_count, first_seen, last_seen, source, active)
      VALUES (?, ?, ?, ?, 50, 1, ?, ?, ?, 1)
    `).run(churchId, category, summary, JSON.stringify(nextDetails), now, now, source);
    return true;
  }

  async _upsertMemoryAsync(churchId, category, matchKey, summary, details, source) {
    await this.ready;
    const client = this._requireClient();
    const now = new Date().toISOString();
    const nextDetails = { ...details, _matchKey: matchKey };

    const existing = await this._findExistingAsync(churchId, category, matchKey);
    if (existing) {
      const newCount = existing.observation_count + 1;
      const newConfidence = Math.min(100, existing.confidence + 5);
      await client.run(`
        UPDATE church_memory SET
          summary = ?, details = ?, confidence = ?,
          observation_count = ?, last_seen = ?, source = ?
        WHERE id = ?
      `, [summary, JSON.stringify(nextDetails), newConfidence, newCount, now, source, existing.id]);
      return false;
    }

    await client.run(`
      INSERT INTO church_memory (church_id, category, summary, details, confidence, observation_count, first_seen, last_seen, source, active)
      VALUES (?, ?, ?, ?, 50, 1, ?, ?, ?, 1)
    `, [churchId, category, summary, JSON.stringify(nextDetails), now, now, source]);
    return true;
  }

  // ─── WRITE: USER NOTES ──────────────────────────────────────────────────────

  saveUserNote(churchId, note, senderName = 'TD') {
    if (this.db) return this._saveUserNoteSync(churchId, note, senderName);
    return this._saveUserNoteAsync(churchId, note, senderName);
  }

  _saveUserNoteSync(churchId, note, senderName = 'TD') {
    try {
      const matchKey = `note:${note.slice(0, 50).toLowerCase().replace(/\s+/g, '_')}`;
      const now = new Date().toISOString();
      const details = { _matchKey: matchKey, fullNote: note, setBy: senderName };

      const existing = this._findExistingSync(churchId, 'user_note', matchKey);
      if (existing) {
        this.db.prepare(`
          UPDATE church_memory SET
            summary = ?, details = ?, confidence = ?, last_seen = ?
          WHERE id = ?
        `).run(note.slice(0, 120), JSON.stringify(details), Math.min(100, existing.confidence + 5), now, existing.id);
      } else {
        this.db.prepare(`
          INSERT INTO church_memory (church_id, category, summary, details, confidence, observation_count, first_seen, last_seen, source, active)
          VALUES (?, ?, ?, ?, 80, 1, ?, ?, ?, 1)
        `).run(churchId, 'user_note', note.slice(0, 120), JSON.stringify(details), now, now, 'user_note');
      }

      this._rebuildSummarySync(churchId);
    } catch (e) {
      console.error('[ChurchMemory] User note error:', e.message);
    }
  }

  async _saveUserNoteAsync(churchId, note, senderName = 'TD') {
    try {
      await this.ready;
      const client = this._requireClient();
      const matchKey = `note:${note.slice(0, 50).toLowerCase().replace(/\s+/g, '_')}`;
      const now = new Date().toISOString();
      const details = { _matchKey: matchKey, fullNote: note, setBy: senderName };

      const existing = await this._findExistingAsync(churchId, 'user_note', matchKey);
      if (existing) {
        await client.run(`
          UPDATE church_memory SET
            summary = ?, details = ?, confidence = ?, last_seen = ?
          WHERE id = ?
        `, [note.slice(0, 120), JSON.stringify(details), Math.min(100, existing.confidence + 5), now, existing.id]);
      } else {
        await client.run(`
          INSERT INTO church_memory (church_id, category, summary, details, confidence, observation_count, first_seen, last_seen, source, active)
          VALUES (?, ?, ?, ?, 80, 1, ?, ?, ?, 1)
        `, [churchId, 'user_note', note.slice(0, 120), JSON.stringify(details), now, now, 'user_note']);
      }

      await this._rebuildSummaryAsync(churchId);
    } catch (e) {
      console.error('[ChurchMemory] User note error:', e.message);
    }
  }

  getUserNotes(churchId) {
    if (this.db) {
      return this.db.prepare(
        `SELECT * FROM church_memory WHERE church_id = ? AND category = 'user_note' AND active = 1 ORDER BY last_seen DESC`
      ).all(churchId);
    }

    return this._getUserNotesAsync(churchId);
  }

  async _getUserNotesAsync(churchId) {
    try {
      await this.ready;
      return this._requireClient().query(
        `SELECT * FROM church_memory WHERE church_id = ? AND category = 'user_note' AND active = 1 ORDER BY last_seen DESC`,
        [churchId]
      );
    } catch {
      return [];
    }
  }

  archiveMemory(churchId, memoryId) {
    if (this.db) return this._archiveMemorySync(churchId, memoryId);
    return this._archiveMemoryAsync(churchId, memoryId);
  }

  _archiveMemorySync(churchId, memoryId) {
    try {
      const result = this.db.prepare(
        'UPDATE church_memory SET active = 0 WHERE id = ? AND church_id = ? AND active = 1'
      ).run(memoryId, churchId);
      if (result.changes > 0) {
        this._rebuildSummarySync(churchId);
        return true;
      }
      return false;
    } catch (e) {
      console.error(`[ChurchMemory] Archive memory error for ${churchId}:`, e.message);
      return false;
    }
  }

  async _archiveMemoryAsync(churchId, memoryId) {
    try {
      await this.ready;
      const result = await this._requireClient().run(
        'UPDATE church_memory SET active = 0 WHERE id = ? AND church_id = ? AND active = 1',
        [memoryId, churchId]
      );
      if (result.changes > 0) {
        await this._rebuildSummaryAsync(churchId);
        return true;
      }
      return false;
    } catch (e) {
      console.error(`[ChurchMemory] Archive memory error for ${churchId}:`, e.message);
      return false;
    }
  }

  // ─── WRITE: POST-SERVICE ────────────────────────────────────────────────────

  writePostServiceMemories(churchId, session) {
    if (this.db) return this._writePostServiceMemoriesSync(churchId, session);
    return this._writePostServiceMemoriesAsync(churchId, session);
  }

  _writePostServiceMemoriesSync(churchId, session) {
    try {
      const events = this.db.prepare(
        'SELECT * FROM service_events WHERE session_id = ? ORDER BY timestamp ASC'
      ).all(session.sessionId);

      if (!events.length) return;

      const autoRecovered = events.filter((event) => event.auto_resolved);
      for (const event of autoRecovered) {
        const matchKey = `fix:${event.event_type}`;
        const successRate = this._computeFixSuccessRateSync(churchId, event.event_type);
        this._upsertMemorySync(
          churchId,
          'fix_outcome',
          matchKey,
          `Auto-recovery works ${successRate}% for ${event.event_type.replace(/_/g, ' ')}`,
          { alertType: event.event_type, success: true, successRate },
          'post_service'
        );
      }

      const escalated = events.filter((event) => !event.resolved && !event.auto_resolved);
      for (const event of escalated) {
        const matchKey = `fail:${event.event_type}`;
        this._upsertMemorySync(
          churchId,
          'fix_outcome',
          matchKey,
          `${event.event_type.replace(/_/g, ' ')} required manual intervention`,
          { alertType: event.event_type, success: false },
          'post_service'
        );
      }

      const recentSessions = this.db.prepare(
        "SELECT id FROM service_sessions WHERE church_id = ? AND (session_type IS NULL OR session_type != 'test') ORDER BY started_at DESC LIMIT 5"
      ).all(churchId).map((row) => row.id);

      if (recentSessions.length >= 3) {
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
          this._upsertMemorySync(
            churchId,
            'equipment_quirk',
            matchKey,
            `${tc.event_type.replace(/_/g, ' ')} occurs in ${tc.session_count}/5 recent services`,
            { eventType: tc.event_type, sessionCount: tc.session_count, outOf: recentSessions.length },
            'post_service'
          );
        }
      }

      this._rebuildSummarySync(churchId);
    } catch (e) {
      console.error(`[ChurchMemory] Post-service write error for ${churchId}:`, e.message);
    }
  }

  async _writePostServiceMemoriesAsync(churchId, session) {
    try {
      await this.ready;
      const client = this._requireClient();
      const events = await client.query(
        'SELECT * FROM service_events WHERE session_id = ? ORDER BY timestamp ASC',
        [session.sessionId]
      );

      if (!events.length) return;

      const autoRecovered = events.filter((event) => event.auto_resolved);
      for (const event of autoRecovered) {
        const matchKey = `fix:${event.event_type}`;
        const successRate = await this._computeFixSuccessRateAsync(churchId, event.event_type);
        await this._upsertMemoryAsync(
          churchId,
          'fix_outcome',
          matchKey,
          `Auto-recovery works ${successRate}% for ${event.event_type.replace(/_/g, ' ')}`,
          { alertType: event.event_type, success: true, successRate },
          'post_service'
        );
      }

      const escalated = events.filter((event) => !event.resolved && !event.auto_resolved);
      for (const event of escalated) {
        const matchKey = `fail:${event.event_type}`;
        await this._upsertMemoryAsync(
          churchId,
          'fix_outcome',
          matchKey,
          `${event.event_type.replace(/_/g, ' ')} required manual intervention`,
          { alertType: event.event_type, success: false },
          'post_service'
        );
      }

      const recentSessions = (await client.query(
        "SELECT id FROM service_sessions WHERE church_id = ? AND (session_type IS NULL OR session_type != 'test') ORDER BY started_at DESC LIMIT 5",
        [churchId]
      )).map((row) => row.id);

      if (recentSessions.length >= 3) {
        const placeholders = recentSessions.map(() => '?').join(',');
        const typeCounts = await client.query(`
          SELECT event_type, COUNT(DISTINCT session_id) as session_count
          FROM service_events
          WHERE session_id IN (${placeholders})
          GROUP BY event_type
          HAVING session_count >= 3
        `, recentSessions);

        for (const tc of typeCounts) {
          const matchKey = `quirk:${tc.event_type}`;
          await this._upsertMemoryAsync(
            churchId,
            'equipment_quirk',
            matchKey,
            `${tc.event_type.replace(/_/g, ' ')} occurs in ${tc.session_count}/5 recent services`,
            { eventType: tc.event_type, sessionCount: tc.session_count, outOf: recentSessions.length },
            'post_service'
          );
        }
      }

      await this._rebuildSummaryAsync(churchId);
    } catch (e) {
      console.error(`[ChurchMemory] Post-service write error for ${churchId}:`, e.message);
    }
  }

  _computeFixSuccessRate(churchId, eventType) {
    if (this.db) return this._computeFixSuccessRateSync(churchId, eventType);
    return this._computeFixSuccessRateAsync(churchId, eventType);
  }

  _computeFixSuccessRateSync(churchId, eventType) {
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

  async _computeFixSuccessRateAsync(churchId, eventType) {
    await this.ready;
    const row = await this._requireClient().queryOne(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN auto_resolved = 1 THEN 1 ELSE 0 END) as auto_fixed
      FROM service_events
      WHERE church_id = ? AND event_type = ?
    `, [churchId, eventType]);

    if (!row || !Number(row.total)) return 0;
    return Math.round((Number(row.auto_fixed || 0) / Number(row.total)) * 100);
  }

  // ─── WRITE: WEEKLY DIGEST ──────────────────────────────────────────────────

  writeWeeklyMemories(churchId, patterns, reliability) {
    if (this.db) return this._writeWeeklyMemoriesSync(churchId, patterns, reliability);
    return this._writeWeeklyMemoriesAsync(churchId, patterns, reliability);
  }

  _writeWeeklyMemoriesSync(churchId, patterns, reliability) {
    try {
      for (const pattern of patterns) {
        const patternBase = (pattern.pattern || '').replace(/\s*\(\d+x\)\s*$/, '').replace(/\s+/g, '_');
        const matchKey = `recurring:${patternBase}`;
        this._upsertMemorySync(
          churchId,
          'recurring_issue',
          matchKey,
          `${(pattern.pattern || '').replace(/\s*\(\d+x\)\s*$/, '')} ${pattern.frequency}x/week${pattern.timeWindow ? ` around ${pattern.timeWindow}` : ''}`,
          { eventType: patternBase, frequency: pattern.frequency, timeWindow: pattern.timeWindow, recommendation: pattern.recommendation },
          'weekly_digest'
        );
      }

      if (reliability !== null) {
        const existing = this._findExistingSync(churchId, 'reliability_trend', 'overall');
        let previousReliability = null;
        if (existing) previousReliability = parseJson(existing.details || '{}', {}).current ?? null;

        const trend = previousReliability !== null
          ? (reliability > previousReliability ? 'improving' : reliability < previousReliability ? 'degrading' : 'stable')
          : 'new';

        this._upsertMemorySync(
          churchId,
          'reliability_trend',
          'overall',
          `Reliability ${reliability}% uptime${previousReliability !== null ? ` (${trend} from ${previousReliability}%)` : ''}`,
          { current: reliability, previous: previousReliability, trend },
          'weekly_digest'
        );
      }

      this.consolidate(churchId);
      this._rebuildSummarySync(churchId);
    } catch (e) {
      console.error(`[ChurchMemory] Weekly write error for ${churchId}:`, e.message);
    }
  }

  async _writeWeeklyMemoriesAsync(churchId, patterns, reliability) {
    try {
      await this.ready;
      for (const pattern of patterns) {
        const patternBase = (pattern.pattern || '').replace(/\s*\(\d+x\)\s*$/, '').replace(/\s+/g, '_');
        const matchKey = `recurring:${patternBase}`;
        await this._upsertMemoryAsync(
          churchId,
          'recurring_issue',
          matchKey,
          `${(pattern.pattern || '').replace(/\s*\(\d+x\)\s*$/, '')} ${pattern.frequency}x/week${pattern.timeWindow ? ` around ${pattern.timeWindow}` : ''}`,
          { eventType: patternBase, frequency: pattern.frequency, timeWindow: pattern.timeWindow, recommendation: pattern.recommendation },
          'weekly_digest'
        );
      }

      if (reliability !== null) {
        const existing = await this._findExistingAsync(churchId, 'reliability_trend', 'overall');
        let previousReliability = null;
        if (existing) previousReliability = parseJson(existing.details || '{}', {}).current ?? null;

        const trend = previousReliability !== null
          ? (reliability > previousReliability ? 'improving' : reliability < previousReliability ? 'degrading' : 'stable')
          : 'new';

        await this._upsertMemoryAsync(
          churchId,
          'reliability_trend',
          'overall',
          `Reliability ${reliability}% uptime${previousReliability !== null ? ` (${trend} from ${previousReliability}%)` : ''}`,
          { current: reliability, previous: previousReliability, trend },
          'weekly_digest'
        );
      }

      await this._consolidateAsync(churchId);
      await this._rebuildSummaryAsync(churchId);
    } catch (e) {
      console.error(`[ChurchMemory] Weekly write error for ${churchId}:`, e.message);
    }
  }

  // ─── WRITE: COMMAND FEEDBACK ───────────────────────────────────────────────

  recordCommandOutcome(churchId, command, success, alertContext = 'user_request') {
    if (this.db) return this._recordCommandOutcomeSync(churchId, command, success, alertContext);
    return this._recordCommandOutcomeAsync(churchId, command, success, alertContext);
  }

  _recordCommandOutcomeSync(churchId, command, success, alertContext = 'user_request') {
    try {
      const matchKey = `cmd:${command}:${alertContext}`;
      const label = command.replace(/\./g, ' ');
      const summary = success
        ? `${label} works for ${alertContext.replace(/_/g, ' ')}`
        : `${label} failed for ${alertContext.replace(/_/g, ' ')}`;

      const isNew = this._upsertMemorySync(
        churchId,
        'fix_outcome',
        matchKey,
        summary,
        { command, success, alertContext },
        'command_feedback'
      );

      if (isNew) this._rebuildSummarySync(churchId);
    } catch (e) {
      console.error(`[ChurchMemory] Command outcome error:`, e.message);
    }
  }

  async _recordCommandOutcomeAsync(churchId, command, success, alertContext = 'user_request') {
    try {
      await this.ready;
      const matchKey = `cmd:${command}:${alertContext}`;
      const label = command.replace(/\./g, ' ');
      const summary = success
        ? `${label} works for ${alertContext.replace(/_/g, ' ')}`
        : `${label} failed for ${alertContext.replace(/_/g, ' ')}`;

      const isNew = await this._upsertMemoryAsync(
        churchId,
        'fix_outcome',
        matchKey,
        summary,
        { command, success, alertContext },
        'command_feedback'
      );

      if (isNew) await this._rebuildSummaryAsync(churchId);
    } catch (e) {
      console.error(`[ChurchMemory] Command outcome error:`, e.message);
    }
  }

  // ─── READ: PARSER CONTEXT ─────────────────────────────────────────────────

  getParserContext(churchId) {
    if (this.db) {
      try {
        const row = this.db.prepare('SELECT memory_summary FROM churches WHERE churchId = ?').get(churchId);
        return row?.memory_summary || '';
      } catch {
        return '';
      }
    }

    return this._getParserContextAsync(churchId);
  }

  async _getParserContextAsync(churchId) {
    try {
      await this.ready;
      const row = await this._requireClient().queryOne(
        'SELECT memory_summary FROM churches WHERE churchId = ?',
        [churchId]
      );
      return row?.memory_summary || '';
    } catch {
      return '';
    }
  }

  // ─── READ: RECAP CONTEXT ──────────────────────────────────────────────────

  getRecapContext(churchId) {
    if (this.db) {
      try {
        const rows = this.db.prepare(`
          SELECT summary, details FROM church_memory
          WHERE church_id = ? AND active = 1 AND category IN ('recurring_issue', 'reliability_trend')
          ORDER BY confidence DESC, last_seen DESC
          LIMIT 5
        `).all(churchId);
        if (!rows.length) return '';
        return applyTextBudget(`Known patterns:\n${rows.map((row) => `- ${row.summary}`).join('\n')}`);
      } catch {
        return '';
      }
    }

    return this._getRecapContextAsync(churchId);
  }

  async _getRecapContextAsync(churchId) {
    try {
      await this.ready;
      const rows = await this._requireClient().query(`
        SELECT summary, details FROM church_memory
        WHERE church_id = ? AND active = 1 AND category IN ('recurring_issue', 'reliability_trend')
        ORDER BY confidence DESC, last_seen DESC
        LIMIT 5
      `, [churchId]);
      if (!rows.length) return '';
      return applyTextBudget(`Known patterns:\n${rows.map((row) => `- ${row.summary}`).join('\n')}`);
    } catch {
      return '';
    }
  }

  // ─── READ: PRE-SERVICE BRIEFING ───────────────────────────────────────────

  getPreServiceBriefing(churchId) {
    if (this.db) {
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

    return this._getPreServiceBriefingAsync(churchId);
  }

  async _getPreServiceBriefingAsync(churchId) {
    try {
      await this.ready;
      const client = this._requireClient();
      const [userNotes, recurringIssues, equipmentQuirks, reliabilityTrend] = await Promise.all([
        client.query(
          `SELECT summary FROM church_memory WHERE church_id = ? AND category = 'user_note' AND active = 1 ORDER BY confidence DESC LIMIT 5`,
          [churchId]
        ),
        client.query(
          `SELECT summary, details FROM church_memory WHERE church_id = ? AND category = 'recurring_issue' AND active = 1 ORDER BY confidence DESC LIMIT 3`,
          [churchId]
        ),
        client.query(
          `SELECT summary FROM church_memory WHERE church_id = ? AND category = 'equipment_quirk' AND active = 1 ORDER BY confidence DESC LIMIT 3`,
          [churchId]
        ),
        client.queryOne(
          `SELECT summary, details FROM church_memory WHERE church_id = ? AND category = 'reliability_trend' AND active = 1 LIMIT 1`,
          [churchId]
        ),
      ]);

      return { userNotes, recurringIssues, equipmentQuirks, reliabilityTrend: reliabilityTrend || null };
    } catch (e) {
      console.error(`[ChurchMemory] Briefing query error for ${churchId}:`, e.message);
      return { userNotes: [], recurringIssues: [], equipmentQuirks: [], reliabilityTrend: null };
    }
  }

  // ─── READ: TIMED WARNINGS ─────────────────────────────────────────────────

  getTimedWarnings(churchId) {
    if (this.db) {
      try {
        const rows = this.db.prepare(
          `SELECT summary, details FROM church_memory
           WHERE church_id = ? AND category = 'recurring_issue' AND active = 1 AND confidence >= 30`
        ).all(churchId);
        return this._buildTimedWarnings(rows, churchId);
      } catch (e) {
        console.error(`[ChurchMemory] Timed warnings error for ${churchId}:`, e.message);
        return [];
      }
    }

    return this._getTimedWarningsAsync(churchId);
  }

  async _getTimedWarningsAsync(churchId) {
    try {
      await this.ready;
      const rows = await this._requireClient().query(
        `SELECT summary, details FROM church_memory
         WHERE church_id = ? AND category = 'recurring_issue' AND active = 1 AND confidence >= 30`,
        [churchId]
      );
      return this._buildTimedWarnings(rows, churchId);
    } catch (e) {
      console.error(`[ChurchMemory] Timed warnings error for ${churchId}:`, e.message);
      return [];
    }
  }

  _buildTimedWarnings(rows) {
    const warnings = [];
    for (const row of rows) {
      const details = parseJson(row.details || '{}', {});
      const timeWindow = details.timeWindow;
      if (!timeWindow || timeWindow === 'varied times') continue;

      const match = String(timeWindow).match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (!match) continue;

      let hours = parseInt(match[1], 10);
      const minutes = parseInt(match[2], 10);
      if (match[3].toUpperCase() === 'PM' && hours < 12) hours += 12;
      if (match[3].toUpperCase() === 'AM' && hours === 12) hours = 0;

      warnings.push({
        summary: row.summary,
        eventType: details.eventType || '',
        windowMinuteOfDay: hours * 60 + minutes,
      });
    }
    return warnings;
  }

  // ─── CONSOLIDATION ────────────────────────────────────────────────────────

  consolidate(churchId) {
    if (this.db) return this._consolidateSync(churchId);
    return this._consolidateAsync(churchId);
  }

  _consolidateSync(churchId) {
    const now = new Date();
    const fourWeeksAgo = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000).toISOString();
    const stale = this.db.prepare(`
      SELECT id, confidence, last_seen, category FROM church_memory
      WHERE church_id = ? AND active = 1 AND last_seen < ?
    `).all(churchId, fourWeeksAgo);

    for (const memory of stale) {
      const weeksSinceLastSeen = Math.floor((now - new Date(memory.last_seen)) / (7 * 24 * 60 * 60 * 1000));
      const weeksOverThreshold = weeksSinceLastSeen - 4;
      const decayRate = memory.category === 'user_note' ? CONFIDENCE_DECAY_PER_WEEK * 0.5 : CONFIDENCE_DECAY_PER_WEEK;
      const decay = weeksOverThreshold * decayRate;
      const newConfidence = Math.max(0, memory.confidence - decay);

      if (newConfidence < ARCHIVE_THRESHOLD) {
        this.db.prepare('UPDATE church_memory SET active = 0, confidence = ? WHERE id = ?').run(newConfidence, memory.id);
      } else {
        this.db.prepare('UPDATE church_memory SET confidence = ? WHERE id = ?').run(newConfidence, memory.id);
      }
    }

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

  async _consolidateAsync(churchId) {
    await this.ready;
    const client = this._requireClient();
    const now = new Date();
    const fourWeeksAgo = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000).toISOString();
    const stale = await client.query(`
      SELECT id, confidence, last_seen, category FROM church_memory
      WHERE church_id = ? AND active = 1 AND last_seen < ?
    `, [churchId, fourWeeksAgo]);

    for (const memory of stale) {
      const weeksSinceLastSeen = Math.floor((now - new Date(memory.last_seen)) / (7 * 24 * 60 * 60 * 1000));
      const weeksOverThreshold = weeksSinceLastSeen - 4;
      const decayRate = memory.category === 'user_note' ? CONFIDENCE_DECAY_PER_WEEK * 0.5 : CONFIDENCE_DECAY_PER_WEEK;
      const decay = weeksOverThreshold * decayRate;
      const newConfidence = Math.max(0, memory.confidence - decay);

      if (newConfidence < ARCHIVE_THRESHOLD) {
        await client.run('UPDATE church_memory SET active = 0, confidence = ? WHERE id = ?', [newConfidence, memory.id]);
      } else {
        await client.run('UPDATE church_memory SET confidence = ? WHERE id = ?', [newConfidence, memory.id]);
      }
    }

    const activeCountRow = await client.queryOne(
      'SELECT COUNT(*) as cnt FROM church_memory WHERE church_id = ? AND active = 1',
      [churchId]
    );
    const activeCount = Number(activeCountRow?.cnt || 0);

    if (activeCount > MAX_MEMORIES_PER_CHURCH) {
      const toArchive = activeCount - MAX_MEMORIES_PER_CHURCH;
      await client.run(`
        UPDATE church_memory SET active = 0
        WHERE id IN (
          SELECT id FROM church_memory
          WHERE church_id = ? AND active = 1
          ORDER BY confidence ASC, last_seen ASC
          LIMIT ?
        )
      `, [churchId, toArchive]);
    }
  }

  // ─── SUMMARY REBUILD ──────────────────────────────────────────────────────

  _rebuildSummary(churchId) {
    if (this.db) return this._rebuildSummarySync(churchId);
    return this._rebuildSummaryAsync(churchId);
  }

  _rebuildSummarySync(churchId) {
    try {
      const rows = this.db.prepare(`
        SELECT summary FROM church_memory
        WHERE church_id = ? AND active = 1
        ORDER BY CASE WHEN category = 'user_note' THEN 0 ELSE 1 END, confidence DESC, last_seen DESC
        LIMIT 8
      `).all(churchId);

      const text = this._compileSummary(rows);
      this.db.prepare('UPDATE churches SET memory_summary = ? WHERE churchId = ?').run(text, churchId);
    } catch (e) {
      console.error(`[ChurchMemory] Summary rebuild error for ${churchId}:`, e.message);
    }
  }

  async _rebuildSummaryAsync(churchId) {
    try {
      await this.ready;
      const rows = await this._requireClient().query(`
        SELECT summary FROM church_memory
        WHERE church_id = ? AND active = 1
        ORDER BY CASE WHEN category = 'user_note' THEN 0 ELSE 1 END, confidence DESC, last_seen DESC
        LIMIT 8
      `, [churchId]);

      const text = this._compileSummary(rows);
      await this._requireClient().run('UPDATE churches SET memory_summary = ? WHERE churchId = ?', [text, churchId]);
    } catch (e) {
      console.error(`[ChurchMemory] Summary rebuild error for ${churchId}:`, e.message);
    }
  }

  _compileSummary(rows) {
    if (!rows.length) return '';

    const sentences = rows.map((row) => row.summary);
    let text = `[Memory: ${sentences.join('. ')}.]`;

    if (text.length > MAX_SUMMARY_CHARS) {
      while (sentences.length > 1 && text.length > MAX_SUMMARY_CHARS) {
        sentences.pop();
        text = `[Memory: ${sentences.join('. ')}.]`;
      }
      if (text.length > MAX_SUMMARY_CHARS) {
        text = text.slice(0, MAX_SUMMARY_CHARS - 1) + ']';
      }
    }

    return text;
  }

  // ─── READ: PRE-SERVICE CONTEXT ──────────────────────────────────────────

  getPreServiceContext(churchId) {
    if (this.db) {
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
        return formatPreServiceContext(rows);
      } catch (e) {
        console.error(`[ChurchMemory] Pre-service context error for ${churchId}:`, e.message);
        return '';
      }
    }

    return this._getPreServiceContextAsync(churchId);
  }

  async _getPreServiceContextAsync(churchId) {
    try {
      await this.ready;
      const rows = await this._requireClient().query(`
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
      `, [churchId]);
      return formatPreServiceContext(rows);
    } catch (e) {
      console.error(`[ChurchMemory] Pre-service context error for ${churchId}:`, e.message);
      return '';
    }
  }

  // ─── READ: SESSION CONTEXT ────────────────────────────────────────────────

  getSessionContext(churchId) {
    if (this.db) {
      try {
        const rows = this.db.prepare(`
          SELECT summary, category, confidence, details FROM church_memory
          WHERE church_id = ? AND active = 1
            AND category IN ('recurring_issue', 'fix_outcome', 'reliability_trend', 'equipment_quirk')
          ORDER BY confidence DESC, last_seen DESC
          LIMIT 8
        `).all(churchId);
        return formatSessionContext(rows);
      } catch (e) {
        console.error(`[ChurchMemory] Session context error for ${churchId}:`, e.message);
        return '';
      }
    }

    return this._getSessionContextAsync(churchId);
  }

  async _getSessionContextAsync(churchId) {
    try {
      await this.ready;
      const rows = await this._requireClient().query(`
        SELECT summary, category, confidence, details FROM church_memory
        WHERE church_id = ? AND active = 1
          AND category IN ('recurring_issue', 'fix_outcome', 'reliability_trend', 'equipment_quirk')
        ORDER BY confidence DESC, last_seen DESC
        LIMIT 8
      `, [churchId]);
      return formatSessionContext(rows);
    } catch (e) {
      console.error(`[ChurchMemory] Session context error for ${churchId}:`, e.message);
      return '';
    }
  }

  // ─── READ: ONBOARDING CONTEXT ─────────────────────────────────────────────

  getOnboardingContext(churchId) {
    if (this.db) {
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
        return formatOnboardingContext(rows);
      } catch (e) {
        console.error(`[ChurchMemory] Onboarding context error for ${churchId}:`, e.message);
        return '';
      }
    }

    return this._getOnboardingContextAsync(churchId);
  }

  async _getOnboardingContextAsync(churchId) {
    try {
      await this.ready;
      const rows = await this._requireClient().query(`
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
      `, [churchId]);
      return formatOnboardingContext(rows);
    } catch (e) {
      console.error(`[ChurchMemory] Onboarding context error for ${churchId}:`, e.message);
      return '';
    }
  }

  // ─── WRITE: INCIDENT LEARNING ─────────────────────────────────────────────

  recordIncidentLearning(churchId, incident) {
    if (this.db) return this._recordIncidentLearningSync(churchId, incident);
    return this._recordIncidentLearningAsync(churchId, incident);
  }

  _recordIncidentLearningSync(churchId, incident) {
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

      const isNew = this._upsertMemorySync(
        churchId,
        incident.resolution ? 'fix_outcome' : 'equipment_quirk',
        matchKey,
        summary,
        details,
        'incident_learning'
      );

      this._rebuildSummarySync(churchId);
      return isNew;
    } catch (e) {
      console.error(`[ChurchMemory] Incident learning error for ${churchId}:`, e.message);
      return false;
    }
  }

  async _recordIncidentLearningAsync(churchId, incident) {
    try {
      await this.ready;
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

      const isNew = await this._upsertMemoryAsync(
        churchId,
        incident.resolution ? 'fix_outcome' : 'equipment_quirk',
        matchKey,
        summary,
        details,
        'incident_learning'
      );

      await this._rebuildSummaryAsync(churchId);
      return isNew;
    } catch (e) {
      console.error(`[ChurchMemory] Incident learning error for ${churchId}:`, e.message);
      return false;
    }
  }

  // ─── READ: RECENT INSIGHTS ────────────────────────────────────────────────

  getRecentInsights(churchId, limit = 5) {
    if (this.db) {
      try {
        const rows = this.db.prepare(`
          SELECT summary, category, confidence, last_seen, observation_count, details
          FROM church_memory
          WHERE church_id = ? AND active = 1
          ORDER BY confidence DESC, last_seen DESC
          LIMIT ?
        `).all(churchId, limit);
        return toRecentInsights(rows);
      } catch (e) {
        console.error(`[ChurchMemory] Recent insights error for ${churchId}:`, e.message);
        return [];
      }
    }

    return this._getRecentInsightsAsync(churchId, limit);
  }

  async _getRecentInsightsAsync(churchId, limit = 5) {
    try {
      await this.ready;
      const rows = await this._requireClient().query(`
        SELECT summary, category, confidence, last_seen, observation_count, details
        FROM church_memory
        WHERE church_id = ? AND active = 1
        ORDER BY confidence DESC, last_seen DESC
        LIMIT ?
      `, [churchId, limit]);
      return toRecentInsights(rows);
    } catch (e) {
      console.error(`[ChurchMemory] Recent insights error for ${churchId}:`, e.message);
      return [];
    }
  }

  // ─── ADMIN / DEBUG ────────────────────────────────────────────────────────

  getAll(churchId, { activeOnly = true } = {}) {
    if (this.db) {
      const where = activeOnly ? 'AND active = 1' : '';
      return this.db.prepare(
        `SELECT * FROM church_memory WHERE church_id = ? ${where} ORDER BY confidence DESC, last_seen DESC`
      ).all(churchId);
    }

    return this._getAllAsync(churchId, { activeOnly });
  }

  async _getAllAsync(churchId, { activeOnly = true } = {}) {
    try {
      await this.ready;
      const where = activeOnly ? 'AND active = 1' : '';
      return this._requireClient().query(
        `SELECT * FROM church_memory WHERE church_id = ? ${where} ORDER BY confidence DESC, last_seen DESC`,
        [churchId]
      );
    } catch {
      return [];
    }
  }

  getStats() {
    if (this.db) {
      return this.db.prepare(`
        SELECT
          COUNT(*) as total_memories,
          COUNT(DISTINCT church_id) as churches_with_memory,
          SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) as active_memories,
          SUM(CASE WHEN active = 0 THEN 1 ELSE 0 END) as archived_memories
        FROM church_memory
      `).get();
    }

    return this._getStatsAsync();
  }

  async _getStatsAsync() {
    try {
      await this.ready;
      return this._requireClient().queryOne(`
        SELECT
          COUNT(*) as total_memories,
          COUNT(DISTINCT church_id) as churches_with_memory,
          SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) as active_memories,
          SUM(CASE WHEN active = 0 THEN 1 ELSE 0 END) as archived_memories
        FROM church_memory
      `, []);
    } catch {
      return {
        total_memories: 0,
        churches_with_memory: 0,
        active_memories: 0,
        archived_memories: 0,
      };
    }
  }
}

module.exports = { ChurchMemory };
