/**
 * Weekly Digest — Monday morning summary for Andrew
 */

const fs = require('fs');
const path = require('path');

class WeeklyDigest {
  constructor(db) {
    this.db = db;
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
  }

  addEvent(churchId, eventType, details = '') {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      'INSERT INTO service_events (church_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)'
    ).run(churchId, now, eventType, typeof details === 'string' ? details : JSON.stringify(details));
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

    return lines.join('\n');
  }

  async saveDigest() {
    const digest = await this.generateDigest();
    const dateStr = new Date().toISOString().slice(0, 10);
    const filePath = path.join(this.digestDir, `${dateStr}.md`);
    fs.writeFileSync(filePath, digest, 'utf8');
    console.log(`[WeeklyDigest] Saved to ${filePath}`);
    return { digest, filePath };
  }

  getLatestDigest() {
    const files = fs.readdirSync(this.digestDir).filter(f => f.endsWith('.md')).sort().reverse();
    if (!files.length) return null;
    const filePath = path.join(this.digestDir, files[0]);
    return { date: files[0].replace('.md', ''), digest: fs.readFileSync(filePath, 'utf8') };
  }

  startWeeklyTimer() {
    // Check every hour if it's Monday 8am
    setInterval(async () => {
      const now = new Date();
      if (now.getDay() === 1 && now.getHours() === 8 && now.getMinutes() < 5) {
        console.log('[WeeklyDigest] Monday 8am — generating digest');
        try { await this.saveDigest(); } catch (e) { console.error('[WeeklyDigest] Error:', e.message); }
      }
    }, 5 * 60 * 1000); // check every 5 min
  }
}

module.exports = { WeeklyDigest };
