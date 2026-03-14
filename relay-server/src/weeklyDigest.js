/**
 * Weekly Digest — Monday morning summary for Andrew
 */

const fs = require('fs');
const path = require('path');

class WeeklyDigest {
  constructor(db) {
    this.db = db;
    this._lastDigestDate = null;
    this._ensureTable();
    this.digestDir = path.join(__dirname, '..', 'data', 'digests');
    if (!fs.existsSync(this.digestDir)) fs.mkdirSync(this.digestDir, { recursive: true });
  }

  _ensureTable() {
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
  }

  addEvent(churchId, eventType, details = '', sessionId = null) {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      'INSERT INTO service_events (church_id, timestamp, event_type, details, session_id) VALUES (?, ?, ?, ?, ?)'
    ).run(churchId, now, eventType, typeof details === 'string' ? details : JSON.stringify(details), sessionId);
    return result.lastInsertRowid;
  }

  resolveEvent(eventId, autoResolved = false) {
    this.db.prepare(
      'UPDATE service_events SET resolved = 1, resolved_at = ?, auto_resolved = ? WHERE id = ?'
    ).run(new Date().toISOString(), autoResolved ? 1 : 0, eventId);
  }

  async generateDigest() {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const weekStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    const events = this.db.prepare(
      'SELECT * FROM service_events WHERE timestamp >= ? ORDER BY timestamp ASC'
    ).all(weekAgo.toISOString());

    const churches = this.db.prepare('SELECT churchId, name FROM churches').all();
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
        for (const e of churchEvents) {
          const t = new Date(e.timestamp).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
          const icon = e.resolved ? (e.auto_resolved ? '🤖' : '✅') : '⚠️';
          const resolveNote = e.resolved
            ? (e.auto_resolved ? ' — auto-recovered' : ' — manually resolved')
            : ' — UNRESOLVED';
          lines.push(`${icon} ${e.event_type.replace(/_/g, ' ')} ${t}${resolveNote}`);
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
      const reliability = this._computeReliability(churchId, churchEvents);
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
  _computeReliability(churchId, events) {
    try {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const sessions = this.db.prepare(
        'SELECT * FROM service_sessions WHERE church_id = ? AND started_at >= ? ORDER BY started_at ASC'
      ).all(churchId, weekAgo.toISOString());

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

    const churches = this.db.prepare(
      "SELECT churchId, name, billing_tier FROM churches WHERE billing_tier IN ('pro_plus', 'enterprise')"
    ).all();

    for (const church of churches) {
      try {
        const events = this.db.prepare(
          'SELECT * FROM service_events WHERE church_id = ? AND timestamp >= ? ORDER BY timestamp ASC'
        ).all(church.churchId, weekAgo.toISOString());

        const patterns = this.detectPatterns(church.churchId, events);
        const reliability = this._computeReliability(church.churchId, events);
        const autoResolved = events.filter(e => e.auto_resolved).length;

        // Write weekly memories + consolidate stale data
        if (this.churchMemory) {
          try {
            this.churchMemory.writeWeeklyMemories(church.churchId, patterns, reliability);
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
        const tds = this.db.prepare(
          'SELECT telegram_chat_id FROM church_tds WHERE church_id = ? AND active = 1'
        ).all(church.churchId);

        for (const td of tds) {
          if (!td.telegram_chat_id) continue;
          await this._sendTelegram(td.telegram_chat_id, botToken, text);
        }

        // Send digest email to leadership recipients
        if (this.lifecycleEmails) {
          const fullChurch = this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(church.churchId);
          if (fullChurch && fullChurch.leadership_emails) {
            const leaderEmails = fullChurch.leadership_emails.split(',').map(e => e.trim()).filter(e => e && e.includes('@'));
            const sessionCount = this.db.prepare(
              'SELECT COUNT(*) as cnt FROM service_sessions WHERE church_id = ? AND started_at >= ?'
            ).get(church.churchId, weekAgo.toISOString())?.cnt || 0;
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
  getChurchDigest(churchId) {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const events = this.db.prepare(
      'SELECT * FROM service_events WHERE church_id = ? AND timestamp >= ? ORDER BY timestamp ASC'
    ).all(churchId, weekAgo.toISOString());

    const patterns = this.detectPatterns(churchId, events);
    const reliability = this._computeReliability(churchId, events);
    const autoResolved = events.filter(e => e.auto_resolved).length;
    const totalEvents = events.length;

    let sessions = [];
    try {
      sessions = this.db.prepare(
        'SELECT grade, duration_minutes FROM service_sessions WHERE church_id = ? AND started_at >= ?'
      ).all(churchId, weekAgo.toISOString());
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
    // Check every 5 min if it's Monday 8am
    setInterval(async () => {
      const now = new Date();
      if (now.getDay() === 1 && now.getHours() === 8 && now.getMinutes() < 5) {
        const todayStr = now.toISOString().slice(0, 10);
        if (this._lastDigestDate === todayStr) return;
        this._lastDigestDate = todayStr;
        console.log('[WeeklyDigest] Monday 8am — generating digest');
        try {
          await this.saveDigest();
          await this.sendChurchDigests();
        } catch (e) { console.error('[WeeklyDigest] Error:', e.message); }
      }
    }, 5 * 60 * 1000);
  }
}

module.exports = { WeeklyDigest };
