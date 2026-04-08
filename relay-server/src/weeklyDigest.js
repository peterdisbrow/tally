/**
 * Weekly Digest — Monday morning summary for the admin team
 */

const fs = require('fs');
const path = require('path');
const { createQueryClient } = require('./db');

const SQLITE_FALLBACK_CONFIG = {
  driver: 'sqlite',
  isSqlite: true,
  isPostgres: false,
  databaseUrl: '',
};

function isDuplicateColumnError(error) {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('duplicate column name') || message.includes('already exists');
}

class WeeklyDigest {
  constructor(dbOrClient, options = {}) {
    this.db = dbOrClient && typeof dbOrClient.prepare === 'function' ? dbOrClient : null;
    this.client = this._resolveClient(dbOrClient, options);
    this._lastDigestDate = null;
    this.digestDir = path.join(__dirname, '..', 'data', 'digests');
    if (!fs.existsSync(this.digestDir)) fs.mkdirSync(this.digestDir, { recursive: true });
    if (this.db) {
      this._ensureTableSync();
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
    if (!this.client) throw new Error('[WeeklyDigest] Database client is not configured.');
    return this.client;
  }

  async _init() {
    await this._ensureTable();
  }

  _ensureTableSync() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS service_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        church_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        details TEXT DEFAULT '',
        resolved INTEGER DEFAULT 0,
        resolved_at TEXT,
        auto_resolved INTEGER DEFAULT 0
      )
    `);

    // Migration: add session_id column for timeline linking
    try { this.db.prepare('SELECT session_id FROM service_events LIMIT 1').get(); }
    catch { this.db.exec('ALTER TABLE service_events ADD COLUMN session_id TEXT'); }

    // Migration: add instance_name column for per-room event tracking
    try { this.db.prepare('SELECT instance_name FROM service_events LIMIT 1').get(); }
    catch { this.db.exec('ALTER TABLE service_events ADD COLUMN instance_name TEXT'); }

    // Migration: add room_id column for per-room event tracking
    try { this.db.prepare('SELECT room_id FROM service_events LIMIT 1').get(); }
    catch { this.db.exec('ALTER TABLE service_events ADD COLUMN room_id TEXT'); }
  }

  async _ensureTable() {
    const client = this._requireClient();
    const idType = client.driver === 'postgres' ? 'BIGSERIAL' : 'INTEGER';
    const autoIncrement = client.driver === 'postgres' ? '' : ' AUTOINCREMENT';

    await client.exec(`
      CREATE TABLE IF NOT EXISTS service_events (
        id ${idType} PRIMARY KEY${autoIncrement},
        church_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        details TEXT DEFAULT '',
        resolved INTEGER DEFAULT 0,
        resolved_at TEXT,
        auto_resolved INTEGER DEFAULT 0
      )
    `);

    try {
      await client.queryOne('SELECT session_id FROM service_events LIMIT 1');
    } catch {
      try {
        await client.exec('ALTER TABLE service_events ADD COLUMN session_id TEXT');
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error;
      }
    }

    try {
      await client.queryOne('SELECT instance_name FROM service_events LIMIT 1');
    } catch {
      try {
        await client.exec('ALTER TABLE service_events ADD COLUMN instance_name TEXT');
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error;
      }
    }

    try {
      await client.queryOne('SELECT room_id FROM service_events LIMIT 1');
    } catch {
      try {
        await client.exec('ALTER TABLE service_events ADD COLUMN room_id TEXT');
      } catch (error) {
        if (!isDuplicateColumnError(error)) throw error;
      }
    }
  }

  addEvent(churchId, eventType, details = '', sessionId = null, { instanceName, roomId } = {}) {
    if (this.db) return this._addEventSync(churchId, eventType, details, sessionId, { instanceName, roomId });
    return this._addEventAsync(churchId, eventType, details, sessionId, { instanceName, roomId });
  }

  _addEventSync(churchId, eventType, details = '', sessionId = null, { instanceName, roomId } = {}) {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      'INSERT INTO service_events (church_id, timestamp, event_type, details, session_id, instance_name, room_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(churchId, now, eventType, typeof details === 'string' ? details : JSON.stringify(details), sessionId, instanceName || null, roomId || null);
    return result.lastInsertRowid;
  }

  async _addEventAsync(churchId, eventType, details = '', sessionId = null, { instanceName, roomId } = {}) {
    await this.ready;
    const client = this._requireClient();
    const now = new Date().toISOString();
    const detailValue = typeof details === 'string' ? details : JSON.stringify(details);

    if (client.driver === 'postgres') {
      const row = await client.queryOne(
        'INSERT INTO service_events (church_id, timestamp, event_type, details, session_id, instance_name, room_id) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
        [churchId, now, eventType, detailValue, sessionId, instanceName || null, roomId || null]
      );
      return row?.id ?? null;
    }

    const result = await client.run(
      'INSERT INTO service_events (church_id, timestamp, event_type, details, session_id, instance_name, room_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [churchId, now, eventType, detailValue, sessionId, instanceName || null, roomId || null]
    );
    return result.lastInsertRowid ?? null;
  }

  resolveEvent(eventId, autoResolved = false) {
    if (this.db) return this._resolveEventSync(eventId, autoResolved);
    return this._resolveEventAsync(eventId, autoResolved);
  }

  _resolveEventSync(eventId, autoResolved = false) {
    this.db.prepare(
      'UPDATE service_events SET resolved = 1, resolved_at = ?, auto_resolved = ? WHERE id = ?'
    ).run(new Date().toISOString(), autoResolved ? 1 : 0, eventId);
  }

  async _resolveEventAsync(eventId, autoResolved = false) {
    await this.ready;
    await this._requireClient().run(
      'UPDATE service_events SET resolved = 1, resolved_at = ?, auto_resolved = ? WHERE id = ?',
      [new Date().toISOString(), autoResolved ? 1 : 0, eventId]
    );
  }

  async _all(sql, params = []) {
    if (this.db) return this.db.prepare(sql).all(...params);
    await this.ready;
    return this._requireClient().query(sql, params);
  }

  async _one(sql, params = []) {
    if (this.db) return this.db.prepare(sql).get(...params) || null;
    await this.ready;
    return this._requireClient().queryOne(sql, params);
  }

  async generateDigest() {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const weekStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    const events = await this._all(
      'SELECT * FROM service_events WHERE timestamp >= ? ORDER BY timestamp ASC',
      [weekAgo.toISOString()]
    );

    const churches = await this._all('SELECT churchId AS "churchId", name FROM churches');
    const churchMap = new Map(churches.map(c => [c.churchId, c.name]));

    // Group events by church
    const byChurch = new Map();
    for (const e of events) {
      if (!byChurch.has(e.church_id)) byChurch.set(e.church_id, []);
      byChurch.get(e.church_id).push(e);
    }

    const criticalEvents = events.filter(e => ['stream_stopped', 'atem_disconnected', 'recording_failed', 'multiple_systems_down'].includes(e.event_type));
    const autoResolved = events.filter(e => e.auto_resolved);
    const manualInterventions = criticalEvents.filter(e => e.resolved && !e.auto_resolved);

    const lines = [
      `# Tally Weekly Report — Week of ${weekStr}`,
      '',
      '## Summary',
      `- ${churches.length} churches registered`,
      `- ${events.length} events this week`,
      `- ${criticalEvents.length} critical alert${criticalEvents.length !== 1 ? 's' : ''}${autoResolved.length ? ` (${autoResolved.length} auto-resolved)` : ''}`,
      `- ${manualInterventions.length} manual intervention${manualInterventions.length !== 1 ? 's' : ''} required`,
      '',
      '## Church-by-Church',
    ];

    for (const [churchId, name] of churchMap) {
      const churchEvents = byChurch.get(churchId) || [];
      lines.push(`### ${name}`);
      if (!churchEvents.length) {
        lines.push('✅ No events this week');
      } else {
        // Sub-group by room/instance if multi-room events exist
        const byRoom = new Map();
        for (const e of churchEvents) {
          const roomKey = e.instance_name || '(default)';
          if (!byRoom.has(roomKey)) byRoom.set(roomKey, []);
          byRoom.get(roomKey).push(e);
        }

        const hasMultipleRooms = byRoom.size > 1 || (byRoom.size === 1 && !byRoom.has('(default)'));
        for (const [roomKey, roomEvents] of byRoom) {
          if (hasMultipleRooms) lines.push(`**Room: ${roomKey}**`);
          for (const e of roomEvents) {
            const t = new Date(e.timestamp).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
            const icon = e.resolved ? (e.auto_resolved ? '🤖' : '✅') : '⚠️';
            const resolveNote = e.resolved
              ? (e.auto_resolved ? ' — auto-recovered' : ' — manually resolved')
              : ' — UNRESOLVED';
            lines.push(`${icon} ${e.event_type.replace(/_/g, ' ')} ${t}${resolveNote}`);
          }
        }
      }
      lines.push('');
    }

    const unresolved = events.filter(e => !e.resolved && criticalEvents.includes(e));
    lines.push('## Issues Requiring Attention');
    if (unresolved.length === 0) {
      lines.push('- None');
    } else {
      for (const e of unresolved) {
        lines.push(`- ${churchMap.get(e.church_id) || e.church_id}: ${e.event_type} (${e.timestamp})`);
      }
    }

    // ── Per-church coaching (patterns + reliability) ─────────────────────
    lines.push('');
    lines.push('## Engineer Notes');

    for (const [churchId, name] of churchMap) {
      const churchEvents = byChurch.get(churchId) || [];
      if (!churchEvents.length) continue;

      lines.push(`### ${name}`);

      // Pattern detection
      const patterns = this.detectPatterns(churchId, churchEvents);
      if (patterns.length) {
        lines.push('**Recurring Patterns:**');
        for (const p of patterns) {
          lines.push(`- ${p.pattern} (${p.frequency}x this week, ${p.timeWindow})`);
          if (p.recommendation) lines.push(`  → ${p.recommendation}`);
        }
      }

      // Reliability score
      const reliability = await this._computeReliability(churchId, churchEvents);
      if (reliability !== null) {
        lines.push(`**Reliability:** ${reliability}% uptime this week`);
      }

      // Auto-recovery summary
      const churchAutoResolved = churchEvents.filter(e => e.auto_resolved);
      if (churchAutoResolved.length > 0) {
        lines.push(`**Auto-recovered:** ${churchAutoResolved.length} issue${churchAutoResolved.length !== 1 ? 's' : ''} fixed without TD intervention`);
      }

      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Detect recurring patterns in events for a church.
   * Groups by event type and time-of-day to find repeating issues.
   * @param {string} churchId
   * @param {object[]} events
   * @returns {Array<{ pattern: string, frequency: number, timeWindow: string, recommendation: string }>}
   */
  detectPatterns(churchId, events) {
    const patterns = [];

    // Group events by type
    const byType = new Map();
    for (const e of events) {
      if (!byType.has(e.event_type)) byType.set(e.event_type, []);
      byType.get(e.event_type).push(e);
    }

    for (const [type, typeEvents] of byType) {
      if (typeEvents.length < 2) continue;

      const typeName = type.replace(/_/g, ' ');

      // Check for time-of-day clustering (30-min windows)
      const timeSlots = new Map(); // "HH:30" → count
      for (const e of typeEvents) {
        const t = new Date(e.timestamp);
        const slotHour = t.getHours();
        const slotMin = t.getMinutes() < 30 ? '00' : '30';
        const key = `${slotHour}:${slotMin}`;
        timeSlots.set(key, (timeSlots.get(key) || 0) + 1);
      }

      // Find the most common time slot
      let maxSlot = null, maxCount = 0;
      for (const [slot, count] of timeSlots) {
        if (count > maxCount) { maxSlot = slot; maxCount = count; }
      }

      const timeWindow = maxCount >= 2
        ? `usually around ${this._formatSlotTime(maxSlot)}`
        : 'varied times';

      const recommendation = this._getPatternRecommendation(type, typeEvents);

      patterns.push({
        pattern: `${typeName} (${typeEvents.length}x)`,
        frequency: typeEvents.length,
        timeWindow,
        recommendation,
      });
    }

    // Sort by frequency descending
    patterns.sort((a, b) => b.frequency - a.frequency);
    return patterns.slice(0, 3); // Top 3
  }

  /**
   * Compute uptime reliability percentage for a church this week.
   * Based on session data: total service time - incident downtime.
   * @param {string} churchId
   * @param {object[]} events
   * @returns {number|null}
   */
  _computeReliability(churchId, events, instanceName) {
    if (this.db) return this._computeReliabilitySync(churchId, events, instanceName);
    return this._computeReliabilityAsync(churchId, events, instanceName);
  }

  _computeReliabilitySync(churchId, events, instanceName) {
    try {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      let sessions;
      if (instanceName) {
        sessions = this.db.prepare(
          'SELECT * FROM service_sessions WHERE church_id = ? AND started_at >= ? AND (instance_name = ? OR instance_name IS NULL) AND (session_type IS NULL OR session_type != ?) ORDER BY started_at ASC'
        ).all(churchId, weekAgo.toISOString(), instanceName, 'test');
      } else {
        sessions = this.db.prepare(
          'SELECT * FROM service_sessions WHERE church_id = ? AND started_at >= ? AND (session_type IS NULL OR session_type != ?) ORDER BY started_at ASC'
        ).all(churchId, weekAgo.toISOString(), 'test');
      }

      if (!sessions.length) return null;

      const totalMinutes = sessions.reduce((sum, s) => sum + (s.duration_minutes || 0), 0);
      if (totalMinutes === 0) return null;

      // Count unresolved event minutes (estimate 5 min per unresolved critical event)
      const unresolvedCritical = events.filter(e =>
        !e.resolved && ['stream_stopped', 'atem_disconnected', 'recording_failed', 'multiple_systems_down'].includes(e.event_type)
      );
      const downtimeMinutes = unresolvedCritical.length * 5;

      const reliability = Math.max(0, Math.round(((totalMinutes - downtimeMinutes) / totalMinutes) * 1000) / 10);
      return reliability;
    } catch { return null; }
  }

  async _computeReliabilityAsync(churchId, events, instanceName) {
    try {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      let sessions;
      if (instanceName) {
        sessions = await this._all(
          'SELECT * FROM service_sessions WHERE church_id = ? AND started_at >= ? AND (instance_name = ? OR instance_name IS NULL) AND (session_type IS NULL OR session_type != ?) ORDER BY started_at ASC',
          [churchId, weekAgo.toISOString(), instanceName, 'test']
        );
      } else {
        sessions = await this._all(
          'SELECT * FROM service_sessions WHERE church_id = ? AND started_at >= ? AND (session_type IS NULL OR session_type != ?) ORDER BY started_at ASC',
          [churchId, weekAgo.toISOString(), 'test']
        );
      }

      if (!sessions.length) return null;

      const totalMinutes = sessions.reduce((sum, s) => sum + (s.duration_minutes || 0), 0);
      if (totalMinutes === 0) return null;

      const unresolvedCritical = events.filter(e =>
        !e.resolved && ['stream_stopped', 'atem_disconnected', 'recording_failed', 'multiple_systems_down'].includes(e.event_type)
      );
      const downtimeMinutes = unresolvedCritical.length * 5;

      return Math.max(0, Math.round(((totalMinutes - downtimeMinutes) / totalMinutes) * 1000) / 10);
    } catch {
      return null;
    }
  }

  _formatSlotTime(slot) {
    if (!slot) return '';
    const [h, m] = slot.split(':').map(Number);
    const ampm = h < 12 ? 'AM' : 'PM';
    const h12 = h === 0 ? 12 : (h > 12 ? h - 12 : h);
    return `${h12}:${m === 0 ? '00' : '30'} ${ampm}`;
  }

  _getPatternRecommendation(eventType, events) {
    const RECOMMENDATIONS = {
      'audio_silence': 'Consider a dedicated stream mix (aux send) so FOH muting doesn\'t affect the stream',
      'stream_stopped': 'Test a backup cellular connection or switch to wired internet',
      'atem_disconnected': 'Check network cabling to ATEM — consider a dedicated switch',
      'recording_failed': 'Check storage space on recording drive before each service',
      'fps_low': 'Lower OBS encoding settings or reduce source count',
      'bitrate_low': 'Run a bandwidth test — consider upgrading internet plan',
      'obs_disconnected': 'Update OBS and WebSocket plugin to latest versions',
      'recording_not_started': 'Enable auto-start recording in Tally settings',
      'cpu_high': 'Reduce OBS sources or upgrade encoding hardware',
    };
    return RECOMMENDATIONS[eventType] || null;
  }

  async saveDigest() {
    const digest = await this.generateDigest();
    const dateStr = new Date().toISOString().slice(0, 10);
    const filePath = path.join(this.digestDir, `${dateStr}.md`);
    fs.writeFileSync(filePath, digest, 'utf8');
    console.log(`[WeeklyDigest] Saved to ${filePath}`);
    return { digest, filePath };
  }

  /**
   * Generate and send per-church digest excerpts to TDs via Telegram.
   * Gated to Pro+ tier churches only.
   */
  async sendChurchDigests() {
    const botToken = this._botToken;
    if (!botToken) return;

    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const weekStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    const churches = await this._all(
      `SELECT churchId AS "churchId", name, billing_tier
       FROM churches
       WHERE billing_tier IN ('plus', 'pro', 'managed')`
    );

    for (const church of churches) {
      try {
        const events = await this._all(
          'SELECT * FROM service_events WHERE church_id = ? AND timestamp >= ? ORDER BY timestamp ASC',
          [church.churchId, weekAgo.toISOString()]
        );

        const patterns = this.detectPatterns(church.churchId, events);
        const reliability = await this._computeReliability(church.churchId, events);
        const autoResolved = events.filter(e => e.auto_resolved).length;

        // Write weekly memories + consolidate stale data
        if (this.churchMemory) {
          try {
            await this.churchMemory.writeWeeklyMemories(church.churchId, patterns, reliability);
          } catch (e) {
            console.error(`[WeeklyDigest] Memory write error for ${church.name}:`, e.message);
          }
        }

        // Build per-church digest
        const lines = [
          `📊 *Tally Engineer — Weekly Notes*`,
          `*${church.name}* · Week of ${weekStr}`,
          '',
        ];

        if (patterns.length) {
          lines.push('*Recurring Patterns:*');
          for (const p of patterns) {
            lines.push(`• ${p.pattern} — ${p.timeWindow}`);
            if (p.recommendation) lines.push(`  → ${p.recommendation}`);
          }
          lines.push('');
        }

        if (reliability !== null) {
          lines.push(`Reliability: ${reliability}% uptime`);
        }
        if (autoResolved > 0) {
          lines.push(`Auto-recovered: ${autoResolved} issue${autoResolved !== 1 ? 's' : ''}`);
        }
        if (events.length === 0) {
          lines.push('✅ Clean week — no events detected');
        }

        const text = lines.join('\n');

        // Send to TDs via Telegram
        const tds = await this._all(
          'SELECT telegram_chat_id FROM church_tds WHERE church_id = ? AND active = 1',
          [church.churchId]
        );

        for (const td of tds) {
          if (!td.telegram_chat_id) continue;
          await this._sendTelegram(td.telegram_chat_id, botToken, text);
        }

        // Send digest email to leadership recipients
        if (this.lifecycleEmails) {
          const fullChurch = await this._one('SELECT * FROM churches WHERE churchId = ?', [church.churchId]);
          if (fullChurch && fullChurch.leadership_emails) {
            const leaderEmails = fullChurch.leadership_emails.split(',').map(e => e.trim()).filter(e => e && e.includes('@'));
            const sessionCountRow = await this._one(
              'SELECT COUNT(*) as cnt FROM service_sessions WHERE church_id = ? AND started_at >= ? AND (session_type IS NULL OR session_type != ?)',
              [church.churchId, weekAgo.toISOString(), 'test']
            );
            const sessionCount = sessionCountRow?.cnt || 0;
            // Top alert type
            const typeCounts = {};
            for (const ev of events) {
              typeCounts[ev.event_type] = (typeCounts[ev.event_type] || 0) + 1;
            }
            let topAlertType = null;
            let topAlertCount = 0;
            for (const [type, count] of Object.entries(typeCounts)) {
              if (count > topAlertCount) { topAlertType = type; topAlertCount = count; }
            }

            const digestData = {
              reliability,
              patterns,
              totalEvents: events.length,
              autoRecovered: autoResolved,
              sessionCount,
              topAlertType: topAlertType ? topAlertType.replace(/_/g, ' ') : null,
              topAlertCount,
            };
            for (const leaderEmail of leaderEmails) {
              this.lifecycleEmails.sendWeeklyDigestEmail(fullChurch, digestData, leaderEmail).catch(err => {
                console.error(`[WeeklyDigest] Leadership email error for ${leaderEmail}:`, err.message);
              });
            }
          }
        }
      } catch (e) {
        console.error(`[WeeklyDigest] Church digest error for ${church.name}:`, e.message);
      }
    }
  }

  async _sendTelegram(chatId, botToken, text) {
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      console.error(`[WeeklyDigest] Telegram error: ${e.message}`);
    }
  }

  getLatestDigest() {
    const files = fs.readdirSync(this.digestDir).filter(f => f.endsWith('.md')).sort().reverse();
    if (!files.length) return null;
    const filePath = path.join(this.digestDir, files[0]);
    return { date: files[0].replace('.md', ''), digest: fs.readFileSync(filePath, 'utf8') };
  }

  /**
   * Get per-church digest data for portal display.
   * @param {string} churchId
   * @returns {object}
   */
  async getChurchDigest(churchId, instanceName) {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    let events;
    if (instanceName) {
      events = await this._all(
        'SELECT * FROM service_events WHERE church_id = ? AND timestamp >= ? AND (instance_name = ? OR instance_name IS NULL) ORDER BY timestamp ASC',
        [churchId, weekAgo.toISOString(), instanceName]
      );
    } else {
      events = await this._all(
        'SELECT * FROM service_events WHERE church_id = ? AND timestamp >= ? ORDER BY timestamp ASC',
        [churchId, weekAgo.toISOString()]
      );
    }

    const patterns = this.detectPatterns(churchId, events);
    const reliability = await this._computeReliability(churchId, events, instanceName);
    const autoResolved = events.filter(e => e.auto_resolved).length;
    const totalEvents = events.length;

    let sessions = [];
    try {
      if (instanceName) {
        sessions = await this._all(
          'SELECT grade, duration_minutes FROM service_sessions WHERE church_id = ? AND started_at >= ? AND (instance_name = ? OR instance_name IS NULL) AND (session_type IS NULL OR session_type != ?)',
          [churchId, weekAgo.toISOString(), instanceName, 'test']
        );
      } else {
        sessions = await this._all(
          'SELECT grade, duration_minutes FROM service_sessions WHERE church_id = ? AND started_at >= ? AND (session_type IS NULL OR session_type != ?)',
          [churchId, weekAgo.toISOString(), 'test']
        );
      }
    } catch {}

    return {
      weekOf: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      totalEvents,
      autoResolved,
      patterns,
      reliability,
      sessions: sessions.length,
      grades: sessions.map(s => s.grade).filter(Boolean),
    };
  }

  /**
   * Set Telegram bot token for sending digests.
   * @param {string} botToken
   */
  setNotificationConfig(botToken) {
    this._botToken = botToken;
  }

  /** Attach lifecycle emails engine for leadership digest emails */
  setLifecycleEmails(engine) {
    this.lifecycleEmails = engine;
  }

  startWeeklyTimer() {
    if (this._weeklyTimer) clearInterval(this._weeklyTimer);
    // Check every 5 min if it's Monday 8am
    this._weeklyTimer = setInterval(async () => {
      const now = new Date();
      if (now.getDay() === 1 && now.getHours() === 8 && now.getMinutes() < 5) {
        const todayStr = now.toISOString().slice(0, 10);
        if (this._lastDigestDate === todayStr) return;
        this._lastDigestDate = todayStr;
        console.log('[WeeklyDigest] Monday 8am — generating digest');
        try {
          await this.saveDigest();
          await this.sendChurchDigests();
        } catch (e) { console.error('[WeeklyDigest] Error:', e); }
      }
    }, 5 * 60 * 1000);
  }
}

module.exports = { WeeklyDigest };
