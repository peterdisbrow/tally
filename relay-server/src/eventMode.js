/**
 * Event Mode — Time-limited monitoring for one-time productions
 * (weddings, conferences, Easter, etc.)
 *
 * Creates a church record with church_type = 'event' and an expiry timestamp.
 * The entire event window is treated as one long service window.
 */

const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

class EventMode {
  constructor(db) {
    this.db = db;
    this._ensureColumns();
  }

  _ensureColumns() {
    const columns = [
      ['church_type',      "TEXT DEFAULT 'recurring'"],
      ['event_expires_at', 'TEXT'],
      ['event_label',      'TEXT'],
    ];
    for (const [col, def] of columns) {
      try {
        this.db.prepare(`SELECT ${col} FROM churches LIMIT 1`).get();
      } catch {
        this.db.exec(`ALTER TABLE churches ADD COLUMN ${col} ${def}`);
      }
    }
  }

  // ── Create ──────────────────────────────────────────────────────────────────

  /**
   * Create a new event church.
   * @param {object} opts
   * @param {string}  opts.name             - Display name for the event
   * @param {string}  [opts.eventLabel]     - Short label (e.g. "Easter 2026")
   * @param {number}  [opts.durationHours]  - Monitoring window in hours (default 72)
   * @param {string}  [opts.tdName]         - Technical Director name
   * @param {number|string} [opts.tdTelegramChatId] - TD's Telegram chat ID
   * @param {string}  [opts.contactEmail]   - Contact email
   * @returns {{ churchId, token, expiresAt, name }}
   */
  createEvent({ name, eventLabel, durationHours = 72, tdName, tdTelegramChatId, contactEmail }) {
    const JWT_SECRET  = process.env.JWT_SECRET || 'dev-jwt-secret-change-me';
    const churchId    = uuidv4();
    const now         = new Date();
    const expiresAt   = new Date(now.getTime() + durationHours * 60 * 60 * 1000).toISOString();
    const registeredAt = now.toISOString();

    // Token valid for the full event duration
    const token           = jwt.sign({ churchId, name }, JWT_SECRET, { expiresIn: `${Math.ceil(durationHours)}h` });
    const registrationCode = crypto.randomBytes(3).toString('hex').toUpperCase();

    // Base church insert (matches stmtInsert columns already in server.js)
    this.db.prepare(
      'INSERT INTO churches (churchId, name, email, token, registeredAt) VALUES (?, ?, ?, ?, ?)'
    ).run(churchId, name, contactEmail || '', token, registeredAt);

    // Event-specific fields
    this.db.prepare(
      'UPDATE churches SET church_type = ?, event_expires_at = ?, event_label = ? WHERE churchId = ?'
    ).run('event', expiresAt, eventLabel || name, churchId);

    // TD contact fields (columns added by alertEngine — safe try/catch)
    if (tdName) {
      try { this.db.prepare('UPDATE churches SET td_name = ? WHERE churchId = ?').run(tdName, churchId); } catch {}
    }
    if (tdTelegramChatId) {
      try { this.db.prepare('UPDATE churches SET td_telegram_chat_id = ? WHERE churchId = ?').run(String(tdTelegramChatId), churchId); } catch {}
    }

    // Registration code for Telegram self-registration (column added by TallyBot)
    try { this.db.prepare('UPDATE churches SET registration_code = ? WHERE churchId = ?').run(registrationCode, churchId); } catch {}

    console.log(`[EventMode] Created event: "${name}" (${churchId}) expires ${expiresAt}`);
    return { churchId, token, expiresAt, name };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Whether an event church is past its expiry time.
   * @param {object} church - DB or in-memory church row
   */
  isEventExpired(church) {
    if (!church.event_expires_at) return false;
    return new Date(church.event_expires_at) <= new Date();
  }

  /**
   * Human-readable time remaining, e.g. "14h 32m".
   * @param {object} church
   * @returns {string}
   */
  getTimeRemaining(church) {
    if (!church.event_expires_at) return 'unknown';
    const msLeft = new Date(church.event_expires_at) - Date.now();
    if (msLeft <= 0) return 'expired';
    const totalMinutes = Math.floor(msLeft / 60000);
    const hours   = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  // ── Expiry ──────────────────────────────────────────────────────────────────

  /**
   * Expire a single event church: disconnect WS, notify TD, clear expiry in DB.
   * @param {object} church       - DB church row (with td_telegram_chat_id etc.)
   * @param {object} [tallyBot]   - TallyBot instance (optional)
   * @param {Map}    [churchesMap] - In-memory churches Map (optional, for WS close)
   */
  async expireEvent(church, tallyBot, churchesMap) {
    try {
      console.log(`[EventMode] Expiring: "${church.name}" (${church.churchId})`);

      // Close any active WebSocket
      if (churchesMap) {
        const runtime = churchesMap.get(church.churchId);
        if (runtime && runtime.ws && runtime.ws.readyState === 1 /* OPEN */) {
          try { runtime.ws.close(1000, 'Event monitoring window ended'); } catch {}
        }
      }

      // Send Telegram notification to TD
      const tdChatId  = church.td_telegram_chat_id;
      const botToken  = process.env.TALLY_BOT_TOKEN || process.env.ALERT_BOT_TOKEN;
      const label     = church.event_label && church.event_label !== church.name
        ? ` (${church.event_label})`
        : '';
      const msg = `🎬 *Event monitoring ended*\n\nYour event *${church.name}*${label} monitoring window has ended.\n\nThank you for using Tally\\! Contact your administrator if you need to extend monitoring.`;

      if (tdChatId && botToken) {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: tdChatId, text: msg, parse_mode: 'Markdown' }),
        }).catch(e => console.error('[EventMode] Telegram notify failed:', e.message));
      } else if (tallyBot && tdChatId) {
        await tallyBot.sendMessage(String(tdChatId), msg, { parse_mode: 'Markdown' })
          .catch(e => console.error('[EventMode] tallyBot.sendMessage failed:', e.message));
      }

      // Null out event_expires_at — prevents re-expiry on next cycle
      this.db.prepare('UPDATE churches SET event_expires_at = NULL WHERE churchId = ?')
        .run(church.churchId);

    } catch (e) {
      console.error(`[EventMode] expireEvent error for ${church.churchId}:`, e.message);
    }
  }

  /**
   * Check for expired events and expire them.
   * Called every 10 min by start() and can be called directly from server.js interval.
   * @param {object} [tallyBot]    - TallyBot instance
   * @param {Map}    [churchesMap] - In-memory churches Map
   */
  async checkExpiry(tallyBot, churchesMap) {
    try {
      const expired = this.db.prepare(
        `SELECT * FROM churches
         WHERE church_type = 'event'
           AND event_expires_at IS NOT NULL
           AND event_expires_at <= ?`
      ).all(new Date().toISOString());

      for (const church of expired) {
        await this.expireEvent(church, tallyBot, churchesMap);
      }
    } catch (e) {
      console.error('[EventMode] checkExpiry error:', e.message);
    }
  }

  /**
   * Start the recurring 10-minute expiry check.
   * @param {object} tallyBot    - TallyBot instance (may be null)
   * @param {Map}    churchesMap - In-memory churches Map
   */
  start(tallyBot, churchesMap) {
    setInterval(() => this.checkExpiry(tallyBot, churchesMap), 10 * 60 * 1000);
    console.log('[EventMode] Expiry check started (every 10 min)');
  }
}

module.exports = { EventMode };
